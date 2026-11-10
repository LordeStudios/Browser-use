import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DebuggerLeaseManager } = require('../desktop/mcp/debuggerLeaseManager.cjs');

function fixtureTab(id, { attached = false } = {}) {
  const calls = [];
  let isAttached = attached;
  const debuggerClient = {
    isAttached: () => isAttached,
    attach: () => { calls.push('attach'); isAttached = true; },
    detach: () => { calls.push('detach'); isAttached = false; },
    sendCommand: async (method, params) => { calls.push([method, params]); return { data: 'png-data' }; }
  };
  return { id, webContents: { isDestroyed: () => false, debugger: debuggerClient }, calls };
}

test('leases one manager-owned debugger attachment for a command', async () => {
  const tab = fixtureTab('tab-1');
  const manager = new DebuggerLeaseManager({ getTabs: () => [tab] });

  const result = await manager.send('tab-1', 'screenshot', 'Page.captureScreenshot', { format: 'png' });
  assert.deepEqual(result, { data: 'png-data' });
  assert.deepEqual(tab.calls, ['attach', ['Page.captureScreenshot', { format: 'png' }], 'detach']);
});

test('batches ordered input commands under one debugger attachment', async () => {
  const tab = fixtureTab('tab-1');
  const manager = new DebuggerLeaseManager({ getTabs: () => [tab] });

  const result = await manager.sendBatch('tab-1', 'background fill', [
    { method: 'Input.dispatchKeyEvent', params: { type: 'keyDown', key: 'Control' } },
    { method: 'Input.insertText', params: { text: 'hello' } }
  ]);

  assert.equal(result.length, 2);
  assert.deepEqual(tab.calls, [
    'attach',
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control' }],
    ['Input.insertText', { text: 'hello' }],
    'detach'
  ]);
  assert.deepEqual(manager.metrics, { operations: 1, commands: 2, batches: 1, attachments: 1, detaches: 1, timeouts: 0 });
});

test('never detaches a debugger attachment it did not create', async () => {
  const tab = fixtureTab('tab-1', { attached: true });
  const manager = new DebuggerLeaseManager({ getTabs: () => [tab] });

  await manager.send('tab-1', 'background input', 'Input.insertText', { text: 'hello' });
  assert.deepEqual(tab.calls, [['Input.insertText', { text: 'hello' }]]);
});

test('a pinned device lease survives temporary commands until explicitly released', async () => {
  const tab = fixtureTab('tab-1');
  const manager = new DebuggerLeaseManager({ getTabs: () => [tab] });

  manager.pin('tab-1', 'device-emulation');
  await manager.send('tab-1', 'device emulation', 'Emulation.setTouchEmulationEnabled', { enabled: true });
  await manager.send('tab-1', 'background screenshot', 'Page.captureScreenshot', {});
  assert.equal(tab.calls.filter((call) => call === 'detach').length, 0);
  manager.unpin('tab-1', 'device-emulation');
  assert.equal(tab.calls.filter((call) => call === 'detach').length, 1);
});


test('a rejected closed-tab operation cleans its handled queue and does not block the next call', async () => {
  let tabs = [];
  const manager = new DebuggerLeaseManager({ getTabs: () => tabs });
  await assert.rejects(manager.send('tab-1', 'screenshot', 'Page.captureScreenshot', {}), /no longer available/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.queues.size, 0);

  const tab = fixtureTab('tab-1');
  tabs = [tab];
  const result = await manager.send('tab-1', 'screenshot retry', 'Page.captureScreenshot', { format: 'png' });
  assert.deepEqual(result, { data: 'png-data' });
  assert.equal(manager.queues.size, 0);
});

// ---- Hung-command regressions --------------------------------------------
// A DevTools command that never settles (a fromSurface screenshot awaiting a
// compositor frame a detached view never produces) used to hold the tab's
// serialization slot FOREVER: every later observe/input on that tab queued
// behind it silently and the agent stalled with no errors and no tool results.

function hangingTab(id) {
  const calls = [];
  let isAttached = false;
  let releaseHang = null;
  const debuggerClient = {
    isAttached: () => isAttached,
    attach: () => { calls.push('attach'); isAttached = true; },
    detach: () => { calls.push('detach'); isAttached = false; },
    sendCommand: (method, params) => {
      calls.push([method, params]);
      if (method === 'Page.captureScreenshot') return new Promise((resolve) => { releaseHang = resolve; });
      return Promise.resolve({ data: 'png-data' });
    }
  };
  return { id, webContents: { isDestroyed: () => false, debugger: debuggerClient }, calls, releaseHang: () => releaseHang?.() };
}

test('a hung command times out, releases the queue slot, and the next command proceeds', async () => {
  const tab = hangingTab('tab-1');
  const timeouts = [];
  const manager = new DebuggerLeaseManager({
    getTabs: () => [tab],
    operationTimeoutMs: 120,
    onOperationTimeout: (info) => timeouts.push(info)
  });

  await assert.rejects(
    manager.send('tab-1', 'background screenshot', 'Page.captureScreenshot', { format: 'png' }),
    (error) => error.code === 'debugger_lease_timeout'
  );
  assert.deepEqual(timeouts, [{ tabId: 'tab-1', purpose: 'background screenshot' }]);

  // The queue must have advanced: the next command runs without waiting on the
  // hung capture (it would never settle on its own here).
  const result = await manager.send('tab-1', 'background input', 'Input.insertText', { text: 'hello' });
  assert.deepEqual(result, { data: 'png-data' });
  assert.equal(manager.metrics.timeouts, 1);
});

test('a hung command settling late never detaches a newer lease channel', async () => {
  const tab = hangingTab('tab-1');
  const manager = new DebuggerLeaseManager({ getTabs: () => [tab], operationTimeoutMs: 120 });

  const hung = manager.send('tab-1', 'background screenshot', 'Page.captureScreenshot', {});
  await assert.rejects(hung, /debugger_lease_timeout|Timed out/);

  // The next operation attaches a fresh channel after the forced reset.
  const result = await manager.send('tab-1', 'background input', 'Input.insertText', { text: 'late' });
  assert.deepEqual(result, { data: 'png-data' });

  // Now the hung capture finally settles (compositor returned a frame late).
  tab.releaseHang();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  // The late settle must not have disturbed the channel: a further command
  // still succeeds without re-attaching mid-flight.
  const again = await manager.send('tab-1', 'background input', 'Input.insertText', { text: 'after-late' });
  assert.deepEqual(again, { data: 'png-data' });
  assert.equal(manager.metrics.timeouts, 1);
});
