import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');

// A harness-internal telemetry probe (the native-surface window scan) must
// never be counted as an executed MODEL tool call: it is not a model action,
// it must not appear in any tool-call ledger or in the model's context, and
// it must still see the window list so it can detect an OS dialog.
const DIALOG = { id: '4242', title: 'Save As', pid: process.pid, className: '#32770', minimized: false };

const controller = {
  navigationState: () => ({ url: 'https://fixture.test', loading: false }),
  domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
  consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
};

// A backend that behaves like a tool-call ledger: every execute() call is
// recorded as an executed model tool call.
function ledgerBackend({ windows = [] } = {}) {
  const executed = [];
  const scans = [];
  return {
    executed,
    scans,
    execute: async (name, input, owner, options) => { executed.push({ name, input, nativeScan: options?.nativeScan === true }); return { changed: true }; },
    scanWindows: async (owner, options) => { scans.push({ owner, options }); return { windows: [...windows] }; },
    releaseOwner: async () => {}
  };
}

function scanRun(backend) {
  return {
    id: 'scan-test', status: 'running', history: [], messages: [],
    settings: { controlMode: 'agi' },
    getComputerTools: () => backend,
    remoteExecution: false, observationDomain: 'browser', computerOwner: 'chat:scan-test'
  };
}

function agentFor(backend, complete) {
  return new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab',
    getControlMode: () => 'agi',
    getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete })
  });
}

const notices = run => run.messages.filter(message => String(message.content || '').includes('NATIVE DIALOG OPEN'));

test('a telemetry window scan is not counted as an executed model tool call', async () => {
  const backend = ledgerBackend();
  const agent = agentFor(backend, async () => ({}));
  const run = scanRun(backend);
  await agent.deliverNativeSurfaceNotice(run);
  assert.deepEqual(backend.executed.map(call => call.name), [], 'the telemetry probe never enters the model tool-call surface');
  assert.equal(backend.executed.some(call => call.nativeScan), false);
  assert.equal(backend.scans.length, 1, 'the telemetry probe ran exactly once');
});

test('the telemetry scan still receives the window list and detects the dialog', async () => {
  const windows = [];
  const backend = ledgerBackend({ windows });
  const agent = agentFor(backend, async () => ({}));
  const run = scanRun(backend);
  // First check: the baseline of the windows that predate the run.
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(notices(run).length, 0, 'a dialog that predates the run never nags');
  // A dialog opens mid-task.
  windows.push(DIALOG);
  run.nativeSurfaceCheckAt = 0;
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(notices(run).length, 1, 'the scan saw the dialog window and told the run about it');
  assert.match(notices(run)[0].content, /Save As/);
  assert.match(notices(run)[0].content, /4242/);
  // The run switches to the desktop domain so the model can drive the dialog.
  assert.equal(run.observationDomain, 'computer');
  assert.deepEqual(backend.executed.map(call => call.name), [], 'the detection cost no model tool call');
});

test('a backend without a dedicated telemetry path still gets a flagged probe', async () => {
  // Legacy backends expose nothing but execute(): the probe still runs and is
  // still FLAGGED with nativeScan, so a backend that understands the flag can
  // exclude it from its executed-call accounting.
  const windows = [];
  const calls = [];
  const backend = { execute: async (name, input, owner, options) => { calls.push({ name, input, nativeScan: options?.nativeScan === true }); return { windows: [...windows] }; } };
  const agent = agentFor(backend, async () => ({}));
  const run = scanRun(backend);
  await agent.deliverNativeSurfaceNotice(run);
  windows.push(DIALOG);
  run.nativeSurfaceCheckAt = 0;
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'computer_window');
  assert.equal(calls[0].nativeScan, true, 'the probe is flagged as telemetry, never as a model action');
  assert.equal(notices(run).length, 1, 'the flagged probe still sees the window list');
});

test('a real model tool call is still counted while the telemetry scan is not', async () => {
  const windows = [];
  const backend = ledgerBackend({ windows });
  const contexts = [];
  let requests = 0;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'fixture-key',
    fetchImpl: async () => {
      requests += 1;
      const decision = requests === 1
        ? { actions: [{ name: 'computer_write', input: { path: 'C:/fixture.txt', content: 'test' } }] }
        : { done: { summary: 'Done', success: true, verified: true } };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(decision) } }] }), { headers: { 'content-type': 'application/json' } });
    }
  });
  const agent = agentFor(backend, async context => { contexts.push(context); return provider.complete(context); });
  const result = await agent.start({ task: 'Write the fixture', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
  assert.equal(result.status, 'completed');
  // The MODEL action is counted...
  assert.deepEqual(backend.executed.map(call => call.name), ['computer_write'], 'only the model action is an executed tool call');
  // ...and the telemetry probe is not, anywhere.
  const historyTools = result.history.map(entry => entry.tool).filter(Boolean);
  assert.equal(historyTools.includes('computer_window'), false, 'the telemetry probe never enters the run history');
  const ledgerCalls = (result.providerLedger?.turns || []).flatMap(turn => turn.calls || []);
  assert.equal(ledgerCalls.some(call => call.name === 'computer_window'), false, 'the evidence ledger never records the telemetry probe');
  assert.equal(ledgerCalls.filter(call => call.name === 'computer_write').length, 1, 'the real model tool call is still recorded');
  const wireHistory = contexts.flatMap(context => context.history || []);
  assert.equal(wireHistory.some(entry => entry.tool === 'computer_window'), false, 'the telemetry probe never enters the model context');
});

test('the real backend honors nativeScan: the probe never opens a model tool session', async () => {
  const c = new ComputerTools({
    nativeRequest: async (name) => name === 'release'
      ? {}
      : { windows: [{ id: '9', title: 'Open', pid: process.pid, className: '#32770', minimized: false }] }
  });
  try {
    const scan = await c.execute('computer_window', { action: 'list' }, 'scan-owner', { nativeScan: true });
    assert.deepEqual(scan.windows.map(window => window.id), ['9'], 'the telemetry probe still receives the window list');
    assert.equal(c.owners.size, 0, 'a telemetry probe never registers a model tool owner');
    // A REAL model tool call still registers (and therefore owns) its session.
    await c.execute('computer_observe', {}, 'model-owner');
    assert.equal(c.owners.size, 1);
    assert.equal(c.owners.has('model-owner'), true);
  } finally { await c.close(); }
});
