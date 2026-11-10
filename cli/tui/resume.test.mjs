// cli/tui/resume.test.mjs — node --test cli/tui/resume.test.mjs
//
// Clickable /history resume: the runHistory line model (clickable keys), the
// /history -> runHistory push shape, and agent-cli's --resume flag contract
// (validation errors before any browser boot).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { entryToLines } from './historyView.mjs';
import { createTuiStore, pushHistory } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_CLI = path.join(HERE, '..', 'agent-cli.mjs');

test('runHistory entries render clickable per-run keys + the resume hint', () => {
  const lines = entryToLines({
    id: 'rh1',
    kind: 'runHistory',
    runs: [
      { name: 'run-2026-10-14-120510', status: 'completed', elapsed: '8.2s', model: 'z-ai/glm-5.3-flash' },
      { name: 'run-2026-10-14-115316', status: 'failed', elapsed: '18.4s', model: '' }
    ],
    tips: 'click a row to resume'
  }, 120, {});
  const keys = lines.map((line) => line.key);
  assert.ok(keys.some((key) => /^run-history#run-2026-10-14-120510#/.test(key)), 'each run row carries run-history#<name># for the frame-anchor map');
  assert.ok(keys.some((key) => /^run-history#run-2026-10-14-115316#/.test(key)));
  const text = lines.map((line) => (line.segments || []).map((s) => s.text).join('')).join('\n');
  assert.match(text, /click to resume/);
  assert.match(text, /completed · 8\.2s/);
});

test('/history pushes the clickable runHistory kind into the store', () => {
  const store = createTuiStore();
  pushHistory(store, {
    kind: 'runHistory',
    runs: [{ name: 'run-x', status: 'completed', elapsed: '1.0s', model: '' }],
    tips: 'click a row (or /resume <name>)'
  });
  const entry = store.get().history.at(-1);
  assert.equal(entry.kind, 'runHistory');
  assert.equal(entry.runs[0].name, 'run-x');
  assert.match(entry.tips, /\/resume/);
});

test('agent-cli --resume refuses a dir without final-state.json (before any boot)', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-empty-'));
  let stderr = '';
  try {
    execFileSync(process.execPath, [AGENT_CLI, '--task', 'x', '--resume', empty], {
      cwd: path.join(HERE, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.fail('expected a non-zero exit');
  } catch (error) {
    stderr = String(error.stderr || '') + String(error.stdout || '');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
  assert.match(stderr, /no final-state\.json/);
});
