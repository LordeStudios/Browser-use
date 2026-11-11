import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createCoordinatorState, actionHash, canAttempt, recordAction } = require('../desktop/agent/desktopAgentCoordinator.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 81, tag: 'button', name: 'Unique current control' }] } };
function harness(complete, execute = async () => ({ content: 'same evidence' })) {
  let calls = 0;
  const controller = { navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}

for (const id of ['xkiro', 'anthropic']) test(`${id}: unchanged evidence retains controls in the actual next request`, async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({ providerId: id, model: 'z-ai/glm-5.3-flash', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(id === 'anthropic'
      ? { content: [{ type: 'text', text: JSON.stringify(final) }] } : { choices: [{ message: { content: JSON.stringify(final) } }] }); } });
  const args = { task: 'Inspect fixture', observation, tools: COMPUTER_TOOLS, coordinator: createCoordinatorState(), history: [] };
  await provider.complete(args);
  await provider.complete({ ...args, observationUnchanged: true });
  assert.match(JSON.stringify(bodies[1]), /Unique current control/);
  // The cached system block (array of blocks) unwraps to its text.
  const rawSystem = bodies[1].system;
  const system = Array.isArray(rawSystem) ? rawSystem.map((block) => block.text).join('') : (rawSystem || bodies[1].messages[0].content);
  assert.doesNotMatch(system, /Begin every response immediately with <think>|Immediately after <\/think>/);
});

test('Responses receives ordered follow-up messages after its initial request', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({ protocol: 'responses', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'c' + bodies.length, name: 'computer_file', arguments: '{"action":"read","path":"C:/fixture.txt"}' }] });
  } });
  const messages = [{ role: 'user', content: 'Original fixture request' }];
  const args = { task: 'Inspect fixture', observation, tools: COMPUTER_TOOLS, coordinator: createCoordinatorState(), messages, history: [] };
  await provider.complete(args);
  await provider.complete({ ...args, messages: [...messages, { role: 'user', content: 'New scope: inspect only the second file' }],
    history: [{ tool: 'computer_file', callId: 'c1', output: { ok: true, result: { content: 'actual result' } } }] });
  const state = JSON.parse(bodies[1].input.at(-1).content[0].text);
  assert.deepEqual(state.messages.map(m => m.content), ['New scope: inspect only the second file']);
  // Contract change: prior turns replay their real user messages verbatim
  // (the reference harness's transcript shape), not a JSON request snapshot.
  const first = bodies[1].input[1];
  assert.equal(first.role, 'user');
  assert.ok(String(first.content).includes('Original fixture request'), 'the earlier user turn remains in ordered history rather than being repeated in current state');
  assert.equal(bodies[1].input.find(i => i.type === 'function_call_output').call_id, 'c1');
});

test('plan-only decisions never stop a productive run (no decision budget)', async () => {
  // LORDE_RECOVERY_CEILING contract: the done gate (LORDE_DONE_GATE_V369)
  // bounces a done while plan items are open, so the final decision must close
  // the plan (replace with a skipped item) before submitting. Before the
  // recovery ceiling existed, a fixture that kept submitting done with an open
  // item cycled the same done_incomplete_work rejection forever — an infinite
  // silent hang; the ceiling now bounds it.
  const h = harness((_ctx, n) => (n <= 3
    ? { planUpdate: [{ text: 'Inspect candidate ' + n, status: 'current' }] }
    : n === 4
      ? { planUpdate: [{ text: 'All candidates inspected', status: 'skipped' }] }
      : final));
  const run = await h.start({ maxSteps: 2, maxRecoveries: 40 });
  assert.ok(h.calls() >= 4, 'the done decision followed the plan-only turns');
  assert.equal(run.result.reason, undefined);
  assert.equal(run.result.success, true);
});

test('network retry ladder does not consume a model decision', async () => {
  const h = harness((_ctx, n) => { if (n === 1) throw new Error('fetch failed'); return final; });
  const run = await h.start({});
  assert.equal(h.calls(), 2);
  assert.equal(run.decisionCount, 1);
  assert.equal(run.result.success, true);
});

test('returned malformed decisions recover internally and can finish', async () => {
  const h = harness((_context, n) => {
    if (n <= 3) throw new Error('Invalid decision format');
    return final;
  });
  const run = await h.start({ maxRecoveries: 3 });
  assert.equal(run.result.success, true);
  assert.equal(run.result.reason, undefined);
  // Recovery cycles are internal and unbounded now: there is no strategy-reset
  // counter to bump — the run simply recovered and finished.
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_advisory').length >= 1, true);
});

function record(state, call, result) {
  const hash = actionHash(call);
  assert.equal(canAttempt(state, hash, false).allowed, true, 'reads must execute before their results are compared');
  return recordAction(state, { hash, mutates: false, call, output: { ok: true, result } });
}
const read = { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } };
test('five identical completed reads produce a result-aware loop signal', () => {
  const state = createCoordinatorState();
  for (let i = 0; i < 4; i++) assert.equal(record(state, read, { content: 'same' }), null);
  assert.match(record(state, read, { content: 'same' }), /repeated|loop/i);
});

test('alternating identical results are detected on the third full AB cycle', () => {
  const state = createCoordinatorState();
  const other = { name: 'browser_network_entries', input: {} };
  for (let i = 0; i < 5; i++) assert.equal(record(state, i % 2 ? other : read, { content: i % 2 ? 'B' : 'A' }), null);
  assert.match(record(state, other, { content: 'B' }), /alternat|loop/i);
});

test('changed results, running jobs and writes do not count as stagnant reads', () => {
  const state = createCoordinatorState();
  for (let i = 0; i < 12; i++) assert.equal(record(state, read, { content: 'version ' + i }), null);
  const job = { name: 'computer_terminal', input: { action: 'read', jobId: 'j1' } };
  for (let i = 0; i < 12; i++) assert.equal(record(state, job, { state: 'running', output: 'quiet build' }), null);
  const write = { name: 'computer_file', input: { action: 'write', path: 'C:/fixture.txt', content: 'same' } };
  for (let i = 0; i < 4; i++) assert.equal(record(state, read, { content: 'same' }), null);
  assert.equal(record(state, write, { changed: true }), null);
  assert.equal(record(state, read, { content: 'same' }), null);
});

test('different full inputs do not collide in read-loop detection', () => {
  const state = createCoordinatorState();
  for (let i = 0; i < 12; i++) assert.equal(record(state, { ...read, input: { ...read.input, path: 'C:/' + 'x'.repeat(220) + i } }, { content: 'same' }), null);
});

test('repeat signals recover internally and do not end the chat', async () => {
  const h = harness((_context, n) => n > 8 ? final : ({ actions: [read] }));
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.equal(run.result.reason, undefined);
  assert.match(JSON.stringify(run.history), /same evidence/);
});

test('explicit observation history uses the normal DOM bound', () => {
  const context = boundedRequestContext({ history: [{ tool: 'browser_observe', output: { ok: true, observation: { dom: { elements: Array.from({ length: 2000 }, (_, index) => ({ index })) } } } }] });
  assert.equal(context.history[0].output.observation.dom.elements.length, 120);
});

test('text attachment truncation does not silently replace later files with empty content', () => {
  const context = boundedRequestContext({ attachments: Array.from({ length: 5 }, (_, i) => ({ kind: 'text', name: `file-${i}`, content: String(i).repeat(120000) })) });
  assert.ok(context.attachments.every(a => a.content.length > 0));
  assert.ok(context.attachments.reduce((sum, a) => sum + a.content.length, 0) <= 120000);
  assert.ok(context.attachments.every(a => a.truncated && a.originalCharacters === 120000));
});

test('runtime notices stay out of conversation messages while remaining advisory context', () => {
  const context = boundedRequestContext({ messages: [
    { role: 'user', content: 'What is two plus two?' },
    { role: 'user', content: 'Runtime recovery notice: re-plan.', source: 'runtime' },
    { role: 'assistant', content: 'Four.' }
  ] });
  assert.deepEqual(context.messages.map(message => message.content), ['What is two plus two?', 'Four.']);
  assert.deepEqual(context.runtimeContext.map(message => message.content), ['Runtime recovery notice: re-plan.']);
});

test('bounded provider context carries the verified workspace contract', () => {
  const context = boundedRequestContext({ task: 'Inspect studio', workspace: { root: 'E:/repo', target: 'E:/repo/studios/public/Apps/lorde-design-studio', url: 'http://127.0.0.1:3001/Apps/lorde-design-studio/' } });
  assert.equal(context.workspace.root, 'E:/repo');
  assert.equal(context.workspace.target, 'E:/repo/studios/public/Apps/lorde-design-studio');
  assert.match(context.workspace.directive, /DEFAULT workspace scope/i);
  assert.match(context.workspace.directive, /not a boundary/i);
});


test('explicit out-of-workspace paths execute (default-scope workspace, no root rejection)', async () => {
  const calls = [];
  const h = harness((_context, n) => n > 3 ? final : ({ actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/old-checkout/lorde-design-studio.js' } }] }), async (name, input, owner, options) => {
    // Harness-internal native-surface telemetry is not a model action: it
    // never executes a workspace path and never counts against the contract
    // under test (only explicit model tool calls do).
    if (options?.nativeScan) return { windows: [] };
    calls.push({ name, input });
    return { ok: true, result: { content: 'executed normally' } };
  });
  const run = await h.start({ maxRecoveries: 40 }, { workspace: { root: 'C:/current-checkout', target: 'C:/current-checkout/studio' } });
  assert.equal(run.result.success, true);
  assert.equal(run.result.reason, undefined);
  // Owner directive (2026-10-11): the declared workspace is the DEFAULT scope,
  // never the ONLY allowed scope — the out-of-root read executes normally.
  assert.equal(calls.length, 3, 'every out-of-root read reached the executor');
  assert.ok(!run.history.some((entry) => entry.output?.recoverySource === 'workspace_scope'), 'no scope rejection recovery exists');
});

test('a distinct next decision can proceed after an out-of-scope action', async () => {
  let decisions = 0;
  const h = harness(() => {
    decisions += 1;
    return decisions === 1
      ? { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/old-checkout/file.txt' } }] }
      : { actions: [{ name: 'browser_done', input: { summary: 'Completed the verified scope.', success: true, verified: true } }] };
  });
  const run = await h.start({}, { workspace: { root: 'C:/current-checkout' } });
  assert.equal(run.result.success, true);
  assert.equal(run.result.reason, undefined);
  assert.equal(decisions, 2);
});

test('a workspace path in the task seeds the run contract before the first decision (portable, both separators)', async () => {
  // The fixture is a real, isolated repository: no developer's directory, and
  // the root is DERIVED (git toplevel) rather than guessed from a project name.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-ws-contract-'));
  const nested = path.join(repo, 'studios', 'public', 'Apps', 'lorde-design-studio');
  fs.mkdirSync(nested, { recursive: true });
  let repoRoot = repo;
  try {
    execFileSync('git', ['init', '-q', repo], { stdio: 'ignore' });
    repoRoot = String(execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
  } catch { /* no git available: the isolated directory itself is the root */ }
  try {
    for (const sep of ['\\', '/']) {
      const contexts = [];
      const h = harness((context) => { contexts.push(context); return final; });
      const target = nested.split(/[\\/]/).join(sep);
      const run = await h.start({}, { task: `Inspect ${target} only.` });
      assert.equal(run.result.success, true);
      assert.ok(contexts[0].workspace, `the workspace contract was seeded (separator ${sep})`);
      assert.equal(path.resolve(contexts[0].workspace.root), path.resolve(repoRoot), `derived repository root (separator ${sep})`);
      assert.equal(path.resolve(contexts[0].workspace.target), path.resolve(nested), `the declared target (separator ${sep})`);
    }
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('a path that does not exist on disk seeds no workspace instead of guessing one', async () => {
  const contexts = [];
  const h = harness((context) => { contexts.push(context); return final; });
  const run = await h.start({}, { task: `Inspect ${path.join(os.tmpdir(), 'bu-missing-checkout-' + Date.now(), 'deep', 'target')} only.` });
  assert.equal(run.result.success, true);
  assert.equal(contexts[0].workspace, null, 'an unresolvable path must not fabricate a workspace root');
});


test('file mutation ends a model batch before dependent actions execute', async () => {
  let turn = 0;
  const h = harness(() => {
    turn += 1;
    if (turn === 1) return { actions: [
      { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } },
      { name: 'computer_patch', input: { path: 'C:/fixture.txt', patch: '*** Begin Patch\n*** End Patch' } },
      { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }
    ] };
    return { actions: [{ name: 'browser_done', input: { summary: 'Patched and verified.', success: true, verified: true } }] };
  });
  const run = await h.start();
  assert.equal(run.result.success, true);
  assert.deepEqual(run.history.map(entry => entry.tool), ['computer_file', 'computer_patch', 'browser_done']);
  assert.equal(turn, 2);
});


test('fresh restart stays internal and the next decision can finish', async () => {
  const h = harness((_context, n) => n <= 2 ? (() => { throw new Error('Malformed response with no executable action'); })() : final);
  const run = await h.start({ maxRecoveries: 2 });
  assert.equal(run.result.success, true);
  // Internal recovery handled both malformed decisions without ending the chat.
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_advisory').length >= 1, true);
});
