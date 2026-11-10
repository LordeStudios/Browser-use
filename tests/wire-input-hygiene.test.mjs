import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Regressions found by capturing the exact request the model receives
// (scripts/wire-capture.mjs) after the 2026-10-30 run.txt: a one-word "hello"
// shipped desktop-control rules, a coordinator message loop re-focused windows,
// agent messages never reached the model, and the footer counted cumulatively.

const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { createOllamaProvider } = require('../desktop/agent/ollamaProvider.cjs');
const { DesktopLease, leaseHandoffNotices } = require('../desktop/agent/agentPool.cjs');
const { createCoordinatorState } = require('../desktop/agent/desktopAgentCoordinator.cjs');
const { ProviderTurnLedger } = require('../desktop/agent/providerTurnLedger.cjs');
const { countTokens, breakdownRequest } = require('../desktop/agent/wireTokenizer.cjs');

const DONE = '{"toolCalls":[{"name":"browser_done","input":{"summary":"ok","success":true,"verified":true}}]}';
const json = (body) => ({ ok: true, status: 200, statusText: 'OK', async json() { return body; }, async text() { return JSON.stringify(body); } });
const BASE = { task: 'hello', observation: {}, history: [], messages: [], plan: [], goals: [], coordinator: createCoordinatorState() };
const tool = (name) => ({ name, description: name, input: {} });

async function captureOpenAi(extra = {}) {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'm', apiKey: 'k',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return json({ choices: [{ message: { content: DONE } }] }); } });
  await provider.complete({ ...BASE, ...extra });
  return bodies[0];
}

test('computer_model alone (advertised in browser mode) does not attach the desktop/coding playbook', async () => {
  const body = await captureOpenAi({ tools: [tool('browser_navigate'), tool('computer_model')] });
  const system = body.messages[0].content;
  assert.doesNotMatch(system, /Decision protocol:/, 'a browser-mode run must not receive the AGI playbook');
  assert.doesNotMatch(system, /Coding mode\./);
});

test('real desktop tools still attach the playbook, as its own block with no glued sentence', async () => {
  const body = await captureOpenAi({ tools: [tool('browser_navigate'), tool('computer_read'), tool('computer_patch')] });
  const system = body.messages[0].content;
  assert.match(system, /Decision protocol:/);
  assert.match(system, /\n\nBrowser-use Agent Chat\. Complete the task through tool calls/);
  assert.doesNotMatch(system, /about them\.Browser-use/, 'the playbook must not be glued onto the previous sentence');
});

test('agentMessages from other sessions reach the model on every provider protocol', async () => {
  const message = { from: 'other', fromLabel: 'Other agent', text: 'the project is at E:/repo', reply: false };
  const openAi = await captureOpenAi({ agentMessages: [message] });
  const ctx = JSON.parse(openAi.messages.at(-1).content);
  assert.equal(ctx.agentMessages?.[0]?.text, 'the project is at E:/repo');
  assert.match(ctx.agentMessagesNote, /real message from another live agent/);

  const bodies = [];
  const ollama = createOllamaProvider({ model: 'x', fetchImpl: async (_u, init) => { bodies.push(JSON.parse(init.body)); return json({ message: { content: DONE } }); } });
  await ollama.complete({ ...BASE, tools: [], agentMessages: [message] });
  assert.match(bodies[0].messages.at(-1).content, /the project is at E:\/repo/);
});

test('the lease says nothing when no agent was waiting; a real hand-off notifies both sides once', () => {
  assert.deepEqual(leaseHandoffNotices('a', null), [], 'releasing an uncontested lease must not message the agent');
  const notices = leaseHandoffNotices('a', 'b');
  assert.deepEqual(notices.map((n) => n.owner), ['a', 'b']);
  assert.match(notices[0].text, /another agent that was waiting/);

  // Behavioural: an uncontested acquire/release cycle fires onRelease but yields no notices.
  const lease = new DesktopLease();
  const fired = [];
  lease.onRelease = (previous, next) => fired.push(...leaseHandoffNotices(previous, next));
  for (let i = 0; i < 12; i += 1) { lease.acquire('solo'); lease.release('solo'); }
  assert.equal(fired.length, 0, 'twelve solo focus actions produced twelve messages before this fix');
});

test('the per-turn ledger restarts on beginTurn while lifetime counters keep accumulating', () => {
  const ledger = new ProviderTurnLedger();
  ledger.observeUsage({ prompt_tokens: 1000, completion_tokens: 50 }, 4000);
  ledger.observeUsage({ prompt_tokens: 1000, completion_tokens: 50 }, 4000);
  ledger.beginTurn();
  ledger.observeUsage({ prompt_tokens: 300, completion_tokens: 10 }, 1200);
  assert.equal(ledger.turnUsage.requests, 1);
  assert.equal(ledger.turnUsage.inputTokens, 300);
  assert.equal(ledger.usage.requests, 3, 'lifetime keeps counting for calibration');
  assert.equal(ledger.usage.inputTokens, 2300);
});

test('terminal events carry per-turn usage, not the conversation-cumulative ledger', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const events = [];
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'browser', getComputerTools: () => backend,
    emit: (event) => events.push(event),
    createProvider: () => createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'm', apiKey: 'k',
      fetchImpl: async () => json({ choices: [{ message: { content: DONE } }], usage: { prompt_tokens: 1000, completion_tokens: 20 } }) }) });
  try {
    await agent.start({ task: 'first question', settings: { approvalMode: 'unattended', controlMode: 'browser' } });
    await agent.start({ task: 'second unrelated question', continuation: true, settings: { approvalMode: 'unattended', controlMode: 'browser' } });
    const completed = events.filter((event) => event.type === 'run.completed');
    assert.equal(completed.length, 2);
    const [first, second] = completed.map((event) => event.run);
    assert.ok(second.usage.requests >= 1);
    assert.ok(second.usage.requests < second.usageLifetime.requests, `turn 2 shows ${second.usage.requests} requests but lifetime is ${second.usageLifetime.requests}`);
    assert.equal(second.usage.inputTokens + first.usage.inputTokens, second.usageLifetime.inputTokens, 'turn totals add up to the lifetime total');
  } finally { await backend.close(); }
});

test('wire tokenizer matches known GPT-style counts and attributes request sections', () => {
  assert.equal(countTokens(''), 0);
  assert.equal(countTokens('hello world'), 2);
  assert.equal(countTokens('The quick brown fox jumps over the lazy dog.'), 10);
  assert.equal(countTokens('12345678'), 3);
  const report = breakdownRequest({
    messages: [{ role: 'system', content: 'Base rules. REPLY STYLE never do X.' }, { role: 'user', content: JSON.stringify({ task: 'hello', messages: [] }) }],
    tools: [{ type: 'function', function: { name: 'a', parameters: {} } }]
  }, { 'reply style': 'REPLY STYLE' });
  const labels = report.parts.map((part) => part.label);
  assert.ok(labels.includes('system: base provider prompt'));
  assert.ok(labels.includes('system: reply style'));
  assert.ok(labels.some((label) => label.startsWith('tool schemas')));
  assert.ok(labels.includes('context.task'));
  assert.equal(report.parts.reduce((sum, part) => sum + part.tokens, 0), report.totals.tokens);
});
