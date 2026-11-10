import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const { quoteRequest } = require('../desktop/agent/requestQuote.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { ComputerTools } = require('../desktop/agent/../computer/computerTools.cjs');

// The real request from run.txt (2026-10-30): 1,081 characters, twelve
// instructions in plain prose, separated by pasted element ids rather than
// punctuation.
const RUN_TXT = fs.readFileSync(path.join(os.homedir(), 'Desktop', 'run.txt'), 'utf8').split('\n')[0].replace(/^You/, '');
// Substrings that really appear in that message (the user wrote "use a light
// them" and "should use real favicon/icon", so the wording is theirs).
const ASKS = ['weather standard icon', 'branding', 'from night to day', 'weather timeline', 'device timezone', 'official logos', 'no em dashes', 'space wastage', 'real posts', 'real favicon', 'light them', 'LordeStudios', 'start with creating a plan'];

test('a long request is quoted whole, not cut to its first sentence', () => {
  const quoted = quoteRequest(RUN_TXT);
  assert.equal(quoted.length, RUN_TXT.replace(/\s+/g, ' ').trim().length);
  for (const ask of ASKS) assert.ok(quoted.includes(ask), `the quote lost "${ask}"`);
});

test('an oversized request keeps its head and its tail, and says it was cut', () => {
  const big = `start here. ${'middle sentence. '.repeat(500)}LAST INSTRUCTION: fix the favicon.`;
  const cut = quoteRequest(big, 800);
  assert.ok(cut.length <= 800);
  assert.ok(cut.startsWith('start here.'), 'the head must survive');
  assert.ok(cut.endsWith('fix the favicon.'), 'the last instruction must survive — it is often the one that matters most');
  assert.match(cut, /middle omitted/, 'the cut must be visible, so the model re-reads the full task');
});

// The root cause of "skipped instructions": every place the harness restated
// the request used its own slice, so the text the model read before each
// decision carried only 11-28% of the request. Those restatements are the
// nudges, the task ladder, the notebook and the completion review.
test('every copy of the request the model reads carries every ask', async () => {
  const bodies = [];
  let turn = 0;
  const gateway = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    turn += 1;
    const call = turn <= 4
      ? { name: 'browser_observe', input: {} }
      : { name: 'browser_done', input: { summary: 'x', success: true, verified: true } };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ toolCalls: [call] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null, workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }), domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }), consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend, emit: () => {},
    createProvider: () => createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://g.invalid/v1', model: 'm', apiKey: 'k', fetchImpl: gateway }) });
  try {
    await Promise.race([agent.start({ task: RUN_TXT, settings: { approvalMode: 'unattended', controlMode: 'agi' } }), new Promise((resolve) => setTimeout(resolve, 30_000))]);
  } finally { await backend.close(); }

  const last = bodies[bodies.length - 1];
  const holders = new Map();
  const walk = (node, path) => {
    if (typeof node === 'string') {
      for (const ask of ASKS) if (node.includes(ask)) {
        if (!holders.has(path)) holders.set(path, new Set());
        holders.get(path).add(ask);
      }
      return;
    }
    if (node && typeof node === 'object') for (const [key, value] of Object.entries(node)) walk(value, path ? `${path}.${key}` : key);
  };
  (last.messages || []).forEach((message, index) => {
    const raw = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
    try { walk(JSON.parse(raw), `msg${index}`); } catch { walk(raw, `msg${index}`); }
  });
  // The nudges and the ladder are where the instruction loss showed up.
  const important = [...holders.entries()].filter(([key]) => /taskLadder|notebook|runtimeContext|recovery|task$/.test(key));
  assert.ok(important.length >= 3, `expected several restatements of the request, found ${important.length}`);
  for (const [key, asks] of important) {
    assert.equal(asks.size, ASKS.length, `the copy at ${key} carries only ${asks.size} of ${ASKS.length} asks`);
  }
});
