// Execution-recovery regressions: what happens to calls that were proposed,
// executed eagerly, clipped by a mutation boundary, or interrupted.
//
//   D. interrupted/clipped execution keeps an ACCURATE status: never "not
//      executed" about something that ran, never a silent disappearance.
//   E. eager results are recorded exactly once (and speculative pre-reads are
//      never recorded as model actions).
//   A. the actionless watchdog escalates instead of narrating forever.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ProviderTurnLedger } = require('../desktop/agent/providerTurnLedger.cjs');

const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 1, tag: 'button', name: 'Control' }] } };
function harness(complete, execute = async () => ({ content: 'same evidence' })) {
  const controller = { navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete }) });
  agent.transportRetryDelays = [1];
  return { agent, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}

test('E: an eager execution that the decision never consumed is recorded exactly once', async () => {
  const h = harness(async () => ({ done: { summary: 'Fixture inspected.', success: true, verified: false } }));
  const run = { history: [], eagerResults: new Map(), step: 1 };
  const eagerCall = { name: 'computer_read', input: { path: 'src/a.js', limit: 5 } };
  const speculativeCall = { name: 'computer_read', input: { path: 'src/b.js', limit: 200 }, _speculative: true };
  run.eagerResults.set('eager-1', { call: eagerCall, output: { ok: true, result: { content: 'eager content' } } });
  run.eagerResults.set('spec-1', { call: speculativeCall, output: { ok: true, result: { content: 'speculative content' } } });
  h.agent.drainEagerResults(run);
  const recorded = run.history.filter((entry) => entry.tool === 'computer_read');
  assert.equal(recorded.length, 1, 'the eager action is recorded once; the speculative pre-read is not a model action');
  assert.match(JSON.stringify(recorded[0].output), /eager content/);
  assert.equal(run.eagerResults.size, 0, 'drained entries cannot be recorded twice later');
});

function wirePayloads(ledger) {
  return ledger.wireMessages()
    .map((message) => { try { return JSON.parse(message.content); } catch { return null; } })
    .filter(Boolean);
}

test('E: a mutation boundary leaves the dependent call marked NOT EXECUTED, never silently dropped', async () => {
  const ledger = new ProviderTurnLedger();
  ledger.begin({ task: 'fixture' }, {});
  const parsed = ledger.accept({
    actions: [
      { name: 'computer_read', input: { path: 'a.txt' } },
      { name: 'computer_patch', input: { path: 'a.txt', patch: 'x' } },
      { name: 'computer_read', input: { path: 'a.txt' } }
    ]
  }, {}, 'openai');
  // Only the first two calls ran (the batch stopped at the file mutation).
  const history = parsed.actions.slice(0, 2).map((call, index) => ({
    callId: call.callId, tool: call.name, output: { ok: true, result: { index } }
  }));
  ledger.settle(history);
  const results = wirePayloads(ledger).flatMap((payload) => payload.actionResults || []);
  assert.equal(results.length, 3, 'every proposed call keeps a status');
  assert.equal(results[2].output.executed, false, 'the clipped call is marked not executed');
  assert.match(String(results[2].output.error || ''), /was not executed/);
  assert.equal(results[0].output.ok, true, 'the executed calls keep their real results');
});

test('D: an interrupted batch does not replay the action that already succeeded', async () => {
  const ledger = new ProviderTurnLedger();
  ledger.begin({ task: 'fixture' }, {});
  const parsed = ledger.accept({ actions: [
    { name: 'computer_write', input: { path: 'a.txt', content: 'x' } },
    { name: 'computer_write', input: { path: 'b.txt', content: 'y' } }
  ] }, {}, 'openai');
  const history = [{ callId: parsed.actions[0].callId, tool: 'computer_write', output: { ok: true, result: { changed: true } } }];
  ledger.settle(history);
  const results = wirePayloads(ledger).flatMap((payload) => payload.actionResults || []);
  assert.equal(results.length, 2, 'both proposed calls carry a status');
  assert.equal(results[0].output.result?.changed, true, 'the executed call keeps its real result');
  assert.equal(results[1].output.executed, false, 'the interrupted call is marked, not assumed');
  assert.equal(results.filter((item) => item.output.executed === false).length, 1, 'exactly one stub: the succeeded call is never stubbed');
});

test('A: actionless decisions are recovery context, and the run parks instead of narrating forever', async () => {
  let turns = 0;
  const h = harness(async () => {
    turns += 1;
    return { assistantText: 'I am still thinking about the fixture and will investigate further shortly.' };
  });
  const run = await h.start({ maxRecoveries: 40 }, { task: 'Inspect fixture' });
  assert.ok(turns > 1, 'the model was asked again');
  const advisories = (run.history || []).filter((entry) => entry.tool === 'agent_advisory');
  assert.ok(advisories.length >= 1, 'actionless turns are recorded as recovery context');
  assert.ok(run.status !== 'running', 'an actionless run never stays running forever');
  assert.ok(turns <= 40, `bounded: ${turns} decisions`);
});
