import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AgentPointerOverlay, POINTER_READY_TIMEOUT_MS } = require('../desktop/pointer/agentPointerOverlay.cjs');

class FakeWebContents extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
  }
  isDestroyed() { return false; }
  send(channel, command) { this.sent.push({ channel, command }); }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.webContents = new FakeWebContents();
    this.destroyed = false;
    this.visible = false;
    this.bounds = { x: 0, y: 0, width: 1, height: 1 };
  }

  setMenuBarVisibility() {}
  setIgnoreMouseEvents() {}
  isDestroyed() { return this.destroyed; }
  isVisible() { return this.visible; }
  hide() { this.visible = false; }
  showInactive() { this.visible = true; }
  getBounds() { return this.bounds; }
  setBounds(bounds) { this.bounds = bounds; }
  loadFile() { return new Promise(() => {}); }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

class ReadyFakeWindow extends FakeWindow {
  loadFile() {
    queueMicrotask(() => this.webContents.emit('did-finish-load'));
    return Promise.resolve();
  }
}

test('a renderer load that never settles cannot release late pointer input', async () => {
  const ipcMain = new EventEmitter();
  const parentWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
  };
  const overlay = new AgentPointerOverlay({
    BrowserWindow: FakeWindow,
    ipcMain,
    parentWindow,
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => ({ x: 0, y: 78, width: 900, height: 622 })
  });
  overlay.setSelectedTab('tab-a');
  const sequenceBeforeMove = overlay.sequence;

  const startedAt = Date.now();
  const pendingMove = overlay.move('tab-a', { x: 120, y: 160 });
  await Promise.resolve();
  const stalledWindow = overlay.window;
  const result = await pendingMove;
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.ignored, true);
  assert.equal(result.reason, 'pointer-unavailable');
  assert.ok(elapsedMs >= POINTER_READY_TIMEOUT_MS - 80, `readiness returned too early: ${elapsedMs}ms`);
  assert.ok(elapsedMs < POINTER_READY_TIMEOUT_MS + 500, `readiness was not bounded: ${elapsedMs}ms`);
  assert.equal(overlay.sequence, sequenceBeforeMove, 'a timed-out readiness wait must never queue a command that can execute later');
  assert.equal(stalledWindow.isVisible(), false, 'a readiness timeout must hide the unusable child surface');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.notEqual(overlay.window, stalledWindow, 'a readiness timeout must replace the child instead of reusing a permanently stuck renderer');
  overlay.dispose();
});

test('an active pointer hides and recovers when its renderer stops acknowledging', async () => {
  const ipcMain = new EventEmitter();
  const parentWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
  };
  const overlay = new AgentPointerOverlay({
    BrowserWindow: ReadyFakeWindow,
    ipcMain,
    parentWindow,
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => ({ x: 0, y: 78, width: 900, height: 622 })
  });
  overlay.setSelectedTab('tab-a');

  // A single unconfirmed frame is a hitch, not a dead renderer: hiding on the
  // first timeout makes the cursor flicker off on a slow frame. Three strikes
  // is the policy that keeps the pointer honest without flickering.
  const first = await overlay.move('tab-a', { x: 300, y: 240 });
  assert.equal(first.timedOut, true);
  assert.equal(overlay.window.isVisible(), true, 'one unconfirmed frame must not hide the pointer');
  const second = await overlay.move('tab-a', { x: 310, y: 250 });
  assert.equal(second.timedOut, true);
  assert.equal(overlay.window.isVisible(), true, 'two unconfirmed frames still leave the pointer on screen');
  const third = await overlay.move('tab-a', { x: 320, y: 260 });
  assert.equal(third.timedOut, true);
  assert.equal(overlay.window.isVisible(), false, 'a renderer that cannot confirm movement must not leave a frozen pointer frame visible');
  assert.equal(overlay.surfaceAvailable, false);

  // The next action must rebuild the surface instead of staying dark forever.
  const recovered = await overlay.move('tab-a', { x: 330, y: 270 });
  assert.equal(overlay.window.isVisible(), true, 'a later action must bring a fresh pointer surface back');
  assert.ok(recovered, 'the recovering move must answer');
  overlay.dispose();
});

test('an unresponsive child hides immediately and is replaced without waiting for another action', async () => {
  const ipcMain = new EventEmitter();
  const parentWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
  };
  const overlay = new AgentPointerOverlay({
    BrowserWindow: ReadyFakeWindow,
    ipcMain,
    parentWindow,
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => ({ x: 0, y: 78, width: 900, height: 622 })
  });
  overlay.setSelectedTab('tab-a');
  assert.equal(await overlay.waitUntilReady(), true);
  overlay.syncBounds();
  const unresponsiveWindow = overlay.window;
  assert.equal(unresponsiveWindow.isVisible(), true);

  unresponsiveWindow.emit('unresponsive');
  assert.equal(unresponsiveWindow.isVisible(), false, 'an unresponsive renderer must not leave its last frame visible');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.notEqual(overlay.window, unresponsiveWindow);
  assert.equal(await overlay.waitUntilReady(), true, 'the replacement renderer becomes usable without another failure cycle');
  overlay.dispose();
});

test('operation-scoped cancellation resolves only its own pending movement', async () => {
  const ipcMain = new EventEmitter();
  const parentWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
  };
  const overlay = new AgentPointerOverlay({
    BrowserWindow: ReadyFakeWindow,
    ipcMain,
    parentWindow,
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => ({ x: 0, y: 78, width: 900, height: 622 })
  });
  overlay.setSelectedTab('tab-a');

  const firstMove = overlay.move('tab-a', { x: 520, y: 380 }, { operationId: 1 });
  await waitForTest(() => overlay.pending.size === 1);
  const firstCancel = overlay.cancelMotion('tab-a', 1, 'session-input-released');
  const firstResult = await firstMove;

  assert.equal(firstCancel.sent, true);
  assert.equal(firstResult.interrupted, true);
  assert.equal(firstResult.reason, 'session-input-released');
  assert.equal(overlay.window.webContents.sent.at(-1).command.type, 'cancel-motion');

  const secondMove = overlay.move('tab-a', { x: 240, y: 180 }, { operationId: 2 });
  await waitForTest(() => overlay.pending.size === 1);
  assert.equal(overlay.cancelMotion('tab-a', 1).ignored, true, 'an old session cannot cancel the newer active operation');
  assert.equal(overlay.pending.size, 1);
  overlay.cancelMotion('tab-a', 2, 'test-cleanup');
  assert.equal((await secondMove).reason, 'test-cleanup');
  overlay.dispose();
});

test('resizing after a painted standalone press requests an explicit native release', async () => {
  const ipcMain = new EventEmitter();
  let viewport = { x: 0, y: 78, width: 900, height: 622 };
  const invalidations = [];
  const parentWindow = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
  };
  const overlay = new AgentPointerOverlay({
    BrowserWindow: ReadyFakeWindow,
    ipcMain,
    parentWindow,
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => viewport,
    onPressedSurfaceInvalidated: (tabId, reason) => invalidations.push({ tabId, reason })
  });
  overlay.setSelectedTab('tab-a');

  const press = overlay.press('tab-a', { x: 700, y: 240 }, 'left', { operationId: 1 });
  await waitForTest(() => overlay.pending.size === 1);
  const [sequence] = overlay.pending.keys();
  ipcMain.emit('browser-use:agent-pointer-ack', { sender: overlay.window.webContents }, { sequence, status: 'painted' });
  assert.equal((await press).completed, true);

  viewport = { ...viewport, width: 620 };
  overlay.syncBounds();

  assert.deepEqual(invalidations, [{ tabId: 'tab-a', reason: 'pointer-viewport-resized' }]);
  assert.equal(overlay.pressedTabId, null);
  assert.equal(overlay.window.webContents.sent.at(-1).command.preserveInteraction, false);
  overlay.dispose();
});

test('a resize callback that cancels the replacement operation cannot send it afterward', async () => {
  const ipcMain = new EventEmitter();
  let viewport = { x: 0, y: 78, width: 900, height: 622 };
  let overlay;
  overlay = new AgentPointerOverlay({
    BrowserWindow: ReadyFakeWindow,
    ipcMain,
    parentWindow: {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getContentBounds: () => ({ x: 20, y: 30, width: 900, height: 700 })
    },
    htmlPath: 'agent-pointer.html',
    preloadPath: 'agent-pointer-preload.cjs',
    resolveViewport: () => viewport,
    onPressedSurfaceInvalidated: (tabId, reason) => overlay.cancelMotion(tabId, 2, reason)
  });
  overlay.setSelectedTab('tab-a');

  const press = overlay.press('tab-a', { x: 700, y: 240 }, 'left', { operationId: 1 });
  await waitForTest(() => overlay.pending.size === 1);
  const [pressSequence] = overlay.pending.keys();
  ipcMain.emit('browser-use:agent-pointer-ack', { sender: overlay.window.webContents }, { sequence: pressSequence, status: 'painted' });
  await press;

  viewport = { ...viewport, width: 620 };
  const sentBeforeMove = overlay.window.webContents.sent.length;
  const result = await overlay.move('tab-a', { x: 300, y: 200 }, { operationId: 2 });
  const commands = overlay.window.webContents.sent.slice(sentBeforeMove).map((entry) => entry.command);

  assert.equal(result.interrupted, true);
  assert.ok(commands.some((command) => command.type === 'cancel-motion' && command.operationId === 2));
  assert.equal(commands.some((command) => command.type === 'move' && command.operationId === 2), false,
    'the cancelled replacement operation must not be sent after syncBounds returns');
  overlay.dispose();
});

async function waitForTest(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for pointer overlay test state.');
}
