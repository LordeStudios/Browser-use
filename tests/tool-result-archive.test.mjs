import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { archiveToolResult, inspectionValue } = require('../desktop/agent/desktopChatAgent.cjs');
const { AgentResultStore } = require('../desktop/agent/agentResultStore.cjs');

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-result-store-'));
  const store = new AgentResultStore(dir, `test-${Date.now()}-${Math.random()}`);
  return { dir, store };
}

test('large tool output becomes a durable resultId envelope instead of an unrecoverable preview', () => {
  const { dir, store } = makeStore();
  try {
    const output = { ok: true, action: 'diff', output: 'x'.repeat(24_000), authorization: 'Bearer secret-token-value' };
    const compact = archiveToolResult({ resultStore: store }, output);
    assert.equal(compact.ok, true);
    assert.equal(compact.truncated, true);
    assert.match(compact.resultId, /^[a-f0-9]{64}$/);
    assert.equal(compact.originalBytes > 24_000, true);
    assert.match(compact.nextAction, /read_agent_result/);
    const first = store.read({ resultId: compact.resultId, offset: 0, limit: 16_000 });
    assert.equal(first.content.includes('secret-token-value'), false, 'stored result is sanitized before archiving');
    assert.equal(first.nextOffset > 0, true);
    const view = inspectionValue('computer_git', compact);
    assert.equal(view.resultId, compact.resultId, 'inspection preserves the retrieval pointer');
    assert.equal(view.truncated, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('small tool output stays inline and no-store overflow is honest', () => {
  const small = { ok: true, result: { changed: true, path: 'src/a.js' } };
  assert.deepEqual(archiveToolResult({ resultStore: null }, small), small);
  const large = archiveToolResult({ resultStore: null }, { ok: true, output: 'y'.repeat(24_000) });
  assert.equal(large.truncated, true);
  assert.equal(large.resultId, undefined);
  assert.match(large.notice, /not archived|not available/i);
});

test('AgentResultStore pages the archived output without rerunning the original tool', () => {
  const { dir, store } = makeStore();
  try {
    const compact = archiveToolResult({ resultStore: store }, { ok: true, output: 'z'.repeat(42_000) });
    const chunks = [];
    let offset = 0;
    do {
      const page = store.read({ resultId: compact.resultId, offset, limit: 12_000 });
      chunks.push(page.content);
      offset = page.nextOffset ?? null;
    } while (offset !== null);
    const joined = chunks.join('');
    assert.match(joined, /zzzz/);
    assert.equal(joined.length > 42_000, true, 'the archived JSON wrapper and payload are fully paged');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI composition wires a result store instead of leaving it null', () => {
  const cli = fs.readFileSync(path.join(process.cwd(), 'cli/agent-cli.mjs'), 'utf8');
  assert.match(cli, /createResultStore: \(conversationId\) => new AgentResultStore/);
  const catalog = fs.readFileSync(path.join(process.cwd(), 'desktop/computer/computerCatalog.cjs'), 'utf8');
  assert.match(catalog, /returned resultId with read_agent_result|returned resultId/);
});
