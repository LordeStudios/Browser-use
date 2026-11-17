import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

function harness(pointerVisualizer) {
  const nativeEvents = [];
  const tab = {
    id: 'tab-selected',
    title: 'Pointer fixture',
    webContents: {
      sendInputEvent: (event) => nativeEvents.push(event),
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      // Mouse delivery rides the CDP Input pipeline (page-CSS coordinates);
      // the stub records the dispatched CDP events into the same stream the
      // assertions read.
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (_method, event) => nativeEvents.push(event)
      }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    pointerVisualizer
  });
  return { controller, nativeEvents, tab };
}

test('click results are JSON-safe and never serialize as [Circular]', async () => {
  const sharedPointer = { sequence: 9, completed: true, status: 'painted' };
  const { controller } = harness({
    move: () => sharedPointer,
    press: () => sharedPointer,
    release: () => sharedPointer
  });
  controller.hitTest = async () => ({ hit: true, tag: 'canvas', isCanvas: true });
  const result = await controller.clickAt('tab-selected', { x: 30, y: 40 }, 'serialize-check');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('[Circular]'), 'the model-facing click result has no circular projection');
  assert.equal(result.pointer.sequence, 9);
  assert.equal(result.hit.isCanvas, true);
});

test('tray-hidden selected tab dispatches CDP input without a visible pointer prerequisite', async () => {
  const { controller, nativeEvents } = harness({
    move: () => ({ ignored: true, reason: 'tab-not-visible' }),
    press: () => ({ ignored: true, reason: 'tab-not-visible' }),
  });
  controller.isTabPaintable = () => false;
  const cdp = [];
  controller.debuggerLeaseManager = {
    send: async (tabId, _purpose, _method, params) => cdp.push({ tabId, params }),
    sendBatch: async (tabId, _purpose, batch) => { for (const entry of batch) cdp.push({ tabId, params: entry.params }); },
  };
  controller.hitTest = async () => ({ hit: true, tag: 'canvas', isCanvas: true });

  const clicked = await controller.clickAt('tab-selected', { x: 25, y: 20 }, 'hidden-host');

  assert.equal(clicked.input, 'cdp-background');
  assert.equal(clicked.hit?.isCanvas, true, 'background clicks carry the post-click hit test');
  assert.deepEqual(nativeEvents, []);
  assert.deepEqual(cdp.map((entry) => entry.params.type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.ok(cdp.every((entry) => entry.tabId === 'tab-selected'));
  assert.equal(controller.heldInputState('hidden-host'), null);
});

test('native press waits for visual arrival and starts click feedback at that coordinate', async () => {
  let resolveArrival;
  let resolvePaint;
  const calls = [];
  const pointerVisualizer = {
    move: (tabId, point, options) => {
      calls.push(['move', tabId, point, options]);
      return new Promise((resolve) => { resolveArrival = resolve; });
    },
    press: (tabId, point, button) => {
      calls.push(['press', tabId, point, button]);
      return new Promise((resolve) => { resolvePaint = resolve; });
    }
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.mouseDown('tab-selected', { x: 140, y: 180 }, 'session-a');
  assert.deepEqual(nativeEvents, [], 'native input must not lead a moving visual pointer');
  assert.deepEqual(calls, [['move', 'tab-selected', { x: 140, y: 180 }, { waitForArrival: true, operationId: 1 }]]);

  resolveArrival({ sequence: 7, completed: true });
  await Promise.resolve();
  assert.deepEqual(nativeEvents, [], 'native input must also wait until click feedback has reached a paint opportunity');
  assert.deepEqual(calls[1], ['press', 'tab-selected', { x: 140, y: 180 }, 'left']);
  resolvePaint({ sequence: 8, completed: true, status: 'painted' });
  const outcome = await pending;

  assert.deepEqual(nativeEvents, [{ type: 'mousePressed', x: 140, y: 180, button: 'left', buttons: 1, clickCount: 1 }]);
  assert.deepEqual(outcome.pointer, { sequence: 7, completed: true });
});

test('a superseded click cannot reclaim the pointer or press after a newer move', async () => {
  const arrivals = [];
  const pointerCalls = [];
  const pointerVisualizer = {
    move: (tabId, point) => {
      pointerCalls.push(['move', tabId, point]);
      return new Promise((resolve) => arrivals.push(resolve));
    },
    press: (...args) => pointerCalls.push(['press', ...args])
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const staleClick = controller.clickAt('tab-selected', { x: 80, y: 420 }, 'session-a');
  const winningMove = controller.mouseMove('tab-selected', { x: 500, y: 120 });
  arrivals[0]({ sequence: 1, interrupted: true, supersededBy: 2 });
  arrivals[1]({ sequence: 2, completed: true });

  const [clickResult, moveResult] = await Promise.all([staleClick, winningMove]);
  assert.equal(clickResult.input, 'interrupted');
  assert.equal(moveResult.input, 'cdp');
  assert.deepEqual(pointerCalls, [
    ['move', 'tab-selected', { x: 80, y: 420 }],
    ['move', 'tab-selected', { x: 500, y: 120 }]
  ]);
  assert.deepEqual(nativeEvents, [{ type: 'mouseMoved', x: 500, y: 120, buttons: 0 }]);
});

test('a timed-out visual arrival still delivers the press through the direct route', async () => {
  // The cursor animation is DECORATION, not a gate. A timed-out arrival with a
  // still-current operation must not eat the press: the model computed the
  // coordinates, so the press goes out through the direct CDP route and the
  // release pairing keeps the click whole. (A SUPERSEDED operation still fails
  // closed — see the session-cancellation test below.)
  const pointerCalls = [];
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 3, timedOut: true }),
    press: (...args) => pointerCalls.push(args)
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const result = await controller.mouseDown('tab-selected', { x: 200, y: 220 }, 'session-a');

  assert.equal(result.pointer?.deliveryFallback, true, 'the reply names the delivery fallback');
  assert.deepEqual(nativeEvents, [{ type: 'mousePressed', x: 200, y: 220, button: 'left', buttons: 1, clickCount: 1 }], 'the press is delivered directly');
  assert.deepEqual(pointerCalls, [], 'the visual press is skipped — only the direct route ran');
  assert.notEqual(controller.heldInputState('session-a'), null, 'the hold is tracked so the release pairs');
});

test('a click whose every visual stage times out still commits and reports the truth', async () => {
  // clickAt sequences on DELIVERY truth: fallback-delivered stages commit, so
  // the release must pair (a press left unpaired holds the page) and the reply
  // must say committed — with the visual failure as informational context only.
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 1, timedOut: true }),
    press: () => { throw new Error('visual press must be skipped when the visual move cannot proceed'); }
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.hitTest = async () => ({ hit: true, tag: 'canvas', isCanvas: true });

  const result = await controller.clickAt('tab-selected', { x: 200, y: 220 }, 'session-a');

  assert.equal(result.input, 'mouse', 'a fully delivered click must not read as interrupted');
  assert.equal(result.pointer.committed, true);
  assert.equal(result.pointer.visualInterrupted, true);
  assert.equal(result.pointer.interrupted, undefined);
  assert.deepEqual(nativeEvents, [
    { type: 'mouseMoved', x: 200, y: 220, buttons: 0 },
    { type: 'mousePressed', x: 200, y: 220, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 200, y: 220, button: 'left', buttons: 0, clickCount: 1 }
  ], 'press and release must pair even when the cursor visual never arrived');
});

test('our own paintability preparation cannot cancel the operation it prepares', async () => {
  // ensureTabPaintable re-lays-out the BrowserView and the pointer overlay
  // reports that as a surface invalidation. That cancellation exists for
  // FOREIGN layout changes: while clickAt's own preparation runs, the minted
  // operation must survive, or the press dies and the page only ever sees a
  // stray release (the chess "clicks once then replans forever" chain).
  let paintable = false;
  let preparationCalls = 0;
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 1, completed: true, status: 'settled' }),
    press: () => Promise.resolve({ sequence: 2, completed: true, status: 'painted' })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.isTabPaintable = () => paintable;
  controller.ensureTabPaintable = (tabId) => {
    preparationCalls += 1;
    controller.releaseTabPointerButtons(tabId, 'pointer-surface-invalidated');
    paintable = true;
    return true;
  };
  controller.hitTest = async () => ({ hit: true, tag: 'button' });

  const result = await controller.clickAt('tab-selected', { x: 90, y: 80 }, 'session-a');

  assert.equal(preparationCalls, 1);
  assert.equal(result.input, 'mouse', 'the click must complete even though the layout pass fired during preparation');
  assert.equal(result.pointer.committed, true);
  assert.deepEqual(nativeEvents, [
    { type: 'mouseMoved', x: 90, y: 80, buttons: 0 },
    { type: 'mousePressed', x: 90, y: 80, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 90, y: 80, button: 'left', buttons: 0, clickCount: 1 }
  ]);
});

test('session cancellation during visual travel prevents a late held press', async () => {
  let resolveArrival;
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; }),
    press: () => Promise.resolve({ sequence: 2, completed: true, status: 'painted' })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.mouseDown('tab-selected', { x: 240, y: 260 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 1, completed: true });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('session cancellation during a move prevents late visual completion from dispatching native input', async () => {
  let resolveArrival;
  const cancellations = [];
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; }),
    cancelMotion: (tabId, operationId, reason) => cancellations.push({ tabId, operationId, reason })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.mouseMove('tab-selected', { x: 260, y: 190 }, { sessionId: 'session-a' });
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 1, completed: true, status: 'settled' });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
  assert.deepEqual(cancellations, [{ tabId: 'tab-selected', operationId: 1, reason: 'session-input-released' }],
    'session cancellation must stop the exact visual operation immediately');
});

test('cancellation during element resolution cannot create a fresh late click', async () => {
  let resolveElement;
  const pointerCalls = [];
  const pointerVisualizer = {
    move: (...args) => pointerCalls.push(['move', ...args]),
    press: (...args) => pointerCalls.push(['press', ...args]),
    cancelMotion: (...args) => pointerCalls.push(['cancel', ...args])
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.elementRect = () => new Promise((resolve) => { resolveElement = resolve; });

  const pending = controller.clickElement('tab-selected', { index: 4 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveElement({ index: 4, center: { x: 210, y: 240 }, tag: 'input' });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
  assert.deepEqual(pointerCalls, [['cancel', 'tab-selected', 1, 'session-input-released']]);
});

test('session cancellation during scroll arrival prevents a late wheel event', async () => {
  let resolveArrival;
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.scrollEvidence = async () => ({ width: 800, height: 600, scrollX: 0, scrollY: 0 });

  const pending = controller.scroll('tab-selected', { deltaY: 180, x: 300, y: 220 }, 'session-a');
  await waitForTest(() => typeof resolveArrival === 'function');
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 1, completed: true, status: 'settled' });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
});

test('session cancellation during click travel invalidates the whole click operation', async () => {
  let resolveArrival;
  const pointerCalls = [];
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; }),
    press: (...args) => pointerCalls.push(args)
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.clickAt('tab-selected', { x: 360, y: 280 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 1, completed: true });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
  assert.deepEqual(pointerCalls, []);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('session cancellation while press feedback paints rolls back the visual press', async () => {
  let resolvePaint;
  const cancelledPresses = [];
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 1, completed: true, status: 'settled' }),
    press: () => new Promise((resolve) => { resolvePaint = resolve; }),
    cancelPress: (tabId, sequence) => cancelledPresses.push({ tabId, sequence })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.mouseDown('tab-selected', { x: 180, y: 210 }, 'session-a');
  await Promise.resolve();
  controller.releaseSessionInput('session-a');
  resolvePaint({ sequence: 2, completed: true, status: 'painted' });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(cancelledPresses, [{ tabId: 'tab-selected', sequence: 2 }]);
  assert.deepEqual(nativeEvents, []);
});

test('ending a session after standalone mouseDown clears both native and visual pressed state', async () => {
  const visualReleases = [];
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 1, completed: true, status: 'settled' }),
    press: () => Promise.resolve({ sequence: 2, completed: true, status: 'painted' }),
    release: (...args) => visualReleases.push(args)
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const down = await controller.mouseDown('tab-selected', { x: 190, y: 230 }, 'session-a');
  assert.equal(down.input, 'cdp');
  controller.releaseSessionInput('session-a');
  await waitForTest(() => nativeEvents.length === 2);

  assert.deepEqual(nativeEvents, [
    { type: 'mousePressed', x: 190, y: 230, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 190, y: 230, button: 'left', buttons: 0, clickCount: 1 }
  ]);
  assert.deepEqual(visualReleases, [['tab-selected', { x: 190, y: 230 }, 'left']]);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('invalidating a pressed pointer viewport explicitly releases the native button', async () => {
  const cdpEvents = [];
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 1, completed: true, status: 'settled' }),
    press: () => Promise.resolve({ sequence: 2, completed: true, status: 'painted' })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.debuggerLeaseManager = {
    send: async (tabId, purpose, method, params) => { cdpEvents.push({ tabId, purpose, method, params }); }
  };
  await controller.mouseDown('tab-selected', { x: 610, y: 260 }, 'session-a');

  const release = controller.releaseTabPointerButtons('tab-selected', 'pointer-viewport-resized');
  await waitForTest(() => cdpEvents.some((entry) => entry.params.type === 'mouseReleased'));
  const lateUp = await controller.mouseUp('tab-selected', { x: 320, y: 260 }, 'session-a');

  assert.equal(release.released, true);
  assert.equal(lateUp.releasedByCleanup, true);
  assert.deepEqual(nativeEvents.filter((event) => event.type === 'mouseReleased' || event.type === 'mouseUp'), []);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased']);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('background button cleanup uses the same tab-scoped CDP route and suppresses a late duplicate up', async () => {
  const cdpEvents = [];
  const nativeEvents = [];
  const makeTab = (id) => ({
    id,
    title: id,
    webContents: {
      sendInputEvent: (event) => nativeEvents.push({ id, event }),
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => `https://${id}.example/`,
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  });
  const tabs = [makeTab('tab-selected'), makeTab('tab-background')];
  const controller = new BrowserViewController({
    getTabs: () => tabs,
    getSelectedTabId: () => 'tab-selected',
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    debuggerLeaseManager: {
      send: async (tabId, purpose, method, params) => { cdpEvents.push({ tabId, purpose, method, params }); }
    }
  });

  await controller.mouseDown('tab-background', { x: 80, y: 90 }, 'session-a');
  controller.releaseSessionInput('session-a');
  await waitForTest(() => cdpEvents.some((entry) => entry.params.type === 'mouseReleased'));
  const lateUp = await controller.mouseUp('tab-background', { x: 80, y: 90 }, 'session-a');

  assert.equal(lateUp.releasedByCleanup, true);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased']);
  assert.ok(cdpEvents.every((entry) => entry.tabId === 'tab-background'));
  assert.deepEqual(nativeEvents, [], 'background cleanup must never fall back to sendInputEvent');
});

test('a selected button held across surface hide is released through CDP exactly once', async () => {
  const cdpEvents = [];
  const nativeEvents = [];
  let paintable = true;
  const tab = {
    id: 'tab-selected',
    title: 'Selected hidden release fixture',
    webContents: {
      sendInputEvent: (event) => nativeEvents.push(event),
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://selected.example/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => paintable,
    debuggerLeaseManager: {
      send: async (tabId, purpose, method, params) => { cdpEvents.push({ tabId, purpose, method, params }); }
    }
  });

  await controller.mouseDown(tab.id, { x: 120, y: 140 }, 'session-a');
  paintable = false;
  const cleanup = controller.releaseTabPointerButtons(tab.id, 'pointer-surface-hidden');
  await waitForTest(() => cdpEvents.some((entry) => entry.params.type === 'mouseReleased'));
  const lateUp = await controller.mouseUp(tab.id, { x: 120, y: 140 }, 'session-a');

  assert.equal(cleanup.released, true);
  assert.equal(lateUp.releasedByCleanup, true);
  assert.deepEqual(nativeEvents, []);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased']);
  assert.ok(cdpEvents.every((entry) => entry.tabId === tab.id));
});

test('cleanup joins an ordinary asynchronous CDP mouseUp instead of releasing twice', async () => {
  for (const cleanupKind of ['session', 'surface']) {
    const cdpEvents = [];
    let resolveRelease;
    const tab = {
      id: 'tab-background',
      title: 'Pending release fixture',
      webContents: {
        sendInputEvent: () => {},
        insertText: () => {},
        isDestroyed: () => false,
        getURL: () => 'https://pending-release.example/',
        isLoading: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false }
      }
    };
    const controller = new BrowserViewController({
      getTabs: () => [tab],
      getSelectedTabId: () => 'different-selected-tab',
      getConsoleEntries: () => [],
      normalizeUrl: (value) => value,
      debuggerLeaseManager: {
        send: async (tabId, purpose, method, params) => {
          cdpEvents.push({ tabId, purpose, method, params });
          if (params.type === 'mouseReleased') await new Promise((resolve) => { resolveRelease = resolve; });
        }
      }
    });

    await controller.mouseDown(tab.id, { x: 90, y: 110 }, 'session-a');
    const pendingUp = controller.mouseUp(tab.id, { x: 90, y: 110 }, 'session-a');
    await waitForTest(() => typeof resolveRelease === 'function');
    if (cleanupKind === 'session') controller.releaseSessionInput('session-a');
    else controller.releaseTabPointerButtons(tab.id, 'pointer-surface-hidden');

    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased'],
      `${cleanupKind} cleanup must join the release already in flight`);
    resolveRelease();
    const result = await pendingUp;

    assert.equal(result.input, 'cdp');
    assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased'],
      `${cleanupKind} cleanup must leave exactly one committed release`);
    assert.equal(controller.heldInputState('session-a'), null);
  }
});

test('a new same-button press waits for the prior asynchronous release and remains tracked', async () => {
  const cdpEvents = [];
  let resolveFirstRelease;
  let releaseCount = 0;
  const tab = {
    id: 'tab-background',
    title: 'Release ordering fixture',
    webContents: {
      sendInputEvent: () => {},
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://release-ordering.example/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => 'different-selected-tab',
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    debuggerLeaseManager: {
      send: async (tabId, purpose, method, params) => {
        cdpEvents.push({ tabId, purpose, method, params });
        if (params.type === 'mouseReleased' && releaseCount++ === 0) {
          await new Promise((resolve) => { resolveFirstRelease = resolve; });
        }
      }
    }
  });

  await controller.mouseDown(tab.id, { x: 70, y: 80 }, 'session-a');
  const oldUp = controller.mouseUp(tab.id, { x: 70, y: 80 }, 'session-a');
  await waitForTest(() => typeof resolveFirstRelease === 'function');
  const newDown = controller.mouseDown(tab.id, { x: 140, y: 160 }, 'session-a');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased'],
    'the new press must not overtake the pending release');

  resolveFirstRelease();
  await Promise.all([oldUp, newDown]);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased', 'mousePressed']);
  assert.deepEqual(controller.heldInputState('session-a'), { tabId: tab.id, buttons: ['left'], keys: [] },
    'the old release completion must not clear the newer press');

  controller.releaseSessionInput('session-a');
  await waitForTest(() => cdpEvents.filter((entry) => entry.params.type === 'mouseReleased').length === 2);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('revoking during a same-button release wait cannot resurrect the delayed press', async () => {
  const cdpEvents = [];
  let resolveRelease;
  const tab = {
    id: 'tab-background',
    title: 'Release cancellation fixture',
    webContents: {
      sendInputEvent: () => {},
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://release-cancellation.example/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => 'different-selected-tab',
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    debuggerLeaseManager: {
      send: async (tabId, purpose, method, params) => {
        cdpEvents.push({ tabId, purpose, method, params });
        if (params.type === 'mouseReleased') await new Promise((resolve) => { resolveRelease = resolve; });
      }
    }
  });

  await controller.mouseDown(tab.id, { x: 60, y: 70 }, 'session-a');
  const oldUp = controller.mouseUp(tab.id, { x: 60, y: 70 }, 'session-a');
  await waitForTest(() => typeof resolveRelease === 'function');
  const delayedDown = controller.mouseDown(tab.id, { x: 160, y: 170 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveRelease();

  await oldUp;
  const result = await delayedDown;
  assert.equal(result.input, 'interrupted');
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mousePressed', 'mouseReleased'],
    'revocation must not allow the waiting press to enter the debugger queue');
  assert.equal(controller.heldInputState('session-a'), null);
});

test('drag cancellation during initial travel cannot start a late drag', async () => {
  let resolveArrival;
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; }),
    press: () => Promise.resolve({ sequence: 2, completed: true, status: 'painted' })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.drag('tab-selected', { startX: 40, startY: 50, endX: 300, endY: 320 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 1, completed: true });
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.deepEqual(nativeEvents, []);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('a superseded visual release still reports an already committed click', async () => {
  let moveCall = 0;
  const pointerVisualizer = {
    move: () => {
      moveCall += 1;
      return Promise.resolve(moveCall === 3
        ? { sequence: 4, interrupted: true, supersededBy: 5 }
        : { sequence: moveCall, completed: true, status: 'settled' });
    },
    press: () => Promise.resolve({ sequence: 3, completed: true, status: 'painted' }),
    release: () => ({ sent: true })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const result = await controller.clickAt('tab-selected', { x: 140, y: 180 }, 'session-a');

  assert.equal(result.input, 'mouse', 'a caller must not retry a click whose down/up edges both committed');
  assert.deepEqual(nativeEvents, [
    { type: 'mouseMoved', x: 140, y: 180, buttons: 0 },
    { type: 'mousePressed', x: 140, y: 180, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 140, y: 180, button: 'left', buttons: 0, clickCount: 1 }
  ]);
  // Contract change (session 4): a committed click NEVER reports interrupted —
  // that lie made the model re-screenshot and replan after clicks that landed.
  // The superseded visual release survives only as informational visualInterrupted.
  assert.equal(result.pointer.interrupted, undefined, 'no interrupted flag may ride a committed click');
  assert.equal(result.pointer.committed, true, 'the reply marks the click as committed');
  assert.equal(result.pointer.visualInterrupted, true, 'the visual-only failure is kept as informational context');
});

test('drag steps wait for the painted pointer coordinate instead of running native input ahead', async () => {
  const moveOptions = [];
  let sequence = 0;
  const pointerVisualizer = {
    move: (tabId, point, options) => {
      moveOptions.push({ tabId, point, options });
      return Promise.resolve({ sequence: ++sequence, completed: true, status: 'settled' });
    },
    press: () => Promise.resolve({ sequence: ++sequence, completed: true, status: 'painted' }),
    release: () => ({ sent: true })
  };
  const { controller } = harness(pointerVisualizer);

  const result = await controller.drag('tab-selected', {
    startX: 20, startY: 30, endX: 200, endY: 180, steps: 3, durationMs: 90
  }, 'session-a');

  assert.equal(result.input, 'mouse');
  const dragSteps = moveOptions.slice(2, 5);
  assert.equal(dragSteps.length, 3);
  assert.ok(dragSteps.every((entry) => entry.options.waitForArrival === true), 'every native drag point must wait for visible arrival');
  assert.deepEqual(dragSteps.map((entry) => entry.options.durationMs), [30, 30, 30], 'visual step timing must preserve the requested drag duration');
});

test('a long low-step drag is divided into continuously active visual segments', async () => {
  const moveCalls = [];
  let sequence = 0;
  const pointerVisualizer = {
    move: (tabId, point, options) => {
      moveCalls.push({ at: Date.now(), tabId, point, options });
      return Promise.resolve({ sequence: ++sequence, completed: true, status: 'settled' });
    },
    press: () => Promise.resolve({ sequence: ++sequence, completed: true, status: 'painted' }),
    release: () => ({ sent: true })
  };
  const { controller } = harness(pointerVisualizer);

  const result = await controller.drag('tab-selected', {
    startX: 20, startY: 20, endX: 420, endY: 320, steps: 1, durationMs: 1_000
  }, 'session-a');

  assert.equal(result.input, 'mouse');
  // Two moves precede the drag (the approach move and the press), and the drag
  // itself ends ON the drop point, so there is no separate release move to skip.
  const dragSegments = moveCalls.slice(2);
  assert.equal(dragSegments.length, 4, 'the requested one-step drag must be normalized below the renderer motion ceiling');
  assert.deepEqual(dragSegments.at(-1).point, { x: 420, y: 320 }, 'the last segment must paint the drop point the release lands on');
  assert.ok(dragSegments.every((entry) => entry.options.durationMs === 250));
  const gaps = dragSegments.slice(1).map((entry, index) => entry.at - dragSegments[index].at);
  assert.ok(gaps.every((gap) => gap <= 340), `no segment may leave enough idle time for the pointer to fade: ${JSON.stringify(gaps)}`);
});

test('cancelling during a drag delay prevents the next stale visual step and duplicate release', async () => {
  const pointerMoves = [];
  let sequence = 0;
  const pointerVisualizer = {
    move: (tabId, point) => {
      pointerMoves.push(point);
      return Promise.resolve({ sequence: ++sequence, completed: true, status: 'settled' });
    },
    press: () => Promise.resolve({ sequence: ++sequence, completed: true, status: 'painted' }),
    release: () => ({ sent: true })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const pending = controller.drag('tab-selected', {
    startX: 10, startY: 10, endX: 300, endY: 300, steps: 2, durationMs: 1_000
  }, 'session-a');
  await waitForTest(() => nativeEvents.some((event) => event.type === 'mouseMoved' && event.x === 155));
  const cancelledAt = Date.now();
  controller.releaseSessionInput('session-a');
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.ok(Date.now() - cancelledAt < 150, 'drag delay must wake promptly when its operation is cancelled');
  assert.equal(pointerMoves.some((point) => point.x === 300 && point.y === 300), false, 'cancelled drag must not issue its next stale visual target');
  assert.equal(nativeEvents.filter((event) => event.type === 'mouseReleased').length, 1, 'session cleanup owns the only release edge');
  // The cleanup release lands where the pointer last moved (never a hardcoded
  // (0,0), which would turn the click into a <body> click).
  const lastMove = [...nativeEvents].reverse().find((event) => event.type === 'mouseMoved');
  assert.deepEqual(nativeEvents.find((event) => event.type === 'mouseReleased'), { type: 'mouseReleased', x: lastMove.x, y: lastMove.y, button: 'left', buttons: 0, clickCount: 1 });
});

test('a newer pointer action during a drag delay remains the last visual target', async () => {
  const pointerMoves = [];
  let sequence = 0;
  const pointerVisualizer = {
    move: (tabId, point) => {
      pointerMoves.push(point);
      return Promise.resolve({ sequence: ++sequence, completed: true, status: 'settled' });
    },
    press: () => Promise.resolve({ sequence: ++sequence, completed: true, status: 'painted' }),
    release: () => ({ sent: true })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const drag = controller.drag('tab-selected', {
    startX: 10, startY: 10, endX: 300, endY: 300, steps: 2, durationMs: 1_000
  }, 'session-a');
  await waitForTest(() => nativeEvents.some((event) => event.type === 'mouseMoved' && event.x === 155));
  const winningMove = await controller.mouseMove('tab-selected', { x: 500, y: 100 }, { sessionId: 'session-b' });
  const dragResult = await drag;

  assert.equal(winningMove.input, 'cdp');
  assert.equal(dragResult.input, 'interrupted');
  assert.deepEqual(pointerMoves.at(-1), { x: 500, y: 100 }, 'the paused drag must never reclaim the pointer after a newer action');
  assert.equal(pointerMoves.some((point) => point.x === 300 && point.y === 300), false);
});

async function waitForTest(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for controller test state.');
}

test('a superseded move cannot dispatch its stale final native position', async () => {
  const arrivals = [];
  const pointerVisualizer = {
    move: () => new Promise((resolve) => arrivals.push(resolve))
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);

  const stale = controller.mouseMove('tab-selected', { x: 90, y: 500 });
  const winning = controller.mouseMove('tab-selected', { x: 460, y: 90 });
  arrivals[0]({ sequence: 1, interrupted: true, supersededBy: 2 });
  arrivals[1]({ sequence: 2, completed: true });
  const [staleResult, winningResult] = await Promise.all([stale, winning]);

  assert.equal(staleResult.input, 'interrupted');
  assert.equal(winningResult.input, 'cdp');
  assert.deepEqual(nativeEvents, [{ type: 'mouseMoved', x: 460, y: 90, buttons: 0 }]);
});

test('release remains an edge event when its visual movement is superseded', async () => {
  const pointerCalls = [];
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 4, interrupted: true }),
    release: (tabId, point, button) => pointerCalls.push(['release', tabId, point, button])
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.lastPointer.set('tab-selected', { x: 320, y: 240 });
  controller.trackHeld('session-a', 'tab-selected', 'buttons', 'left');

  await controller.mouseUp('tab-selected', { x: 10, y: 20 }, 'session-a');

  assert.deepEqual(pointerCalls, [['release', 'tab-selected', { x: 320, y: 240 }, 'left']]);
  assert.deepEqual(nativeEvents, [{ type: 'mouseReleased', x: 320, y: 240, button: 'left', buttons: 0, clickCount: 1 }]);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('session cleanup during a pending visual mouseUp owns the only native release', async () => {
  let resolveArrival;
  const pointerVisualizer = {
    move: () => new Promise((resolve) => { resolveArrival = resolve; }),
    cancelMotion: () => ({ sent: true }),
    release: () => ({ sent: true })
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.trackHeld('session-a', 'tab-selected', 'buttons', 'left');

  const pending = controller.mouseUp('tab-selected', { x: 240, y: 260 }, 'session-a');
  controller.releaseSessionInput('session-a');
  resolveArrival({ sequence: 4, interrupted: true, reason: 'session-input-released' });
  const result = await pending;

  assert.equal(result.releasedByCleanup, true);
  assert.deepEqual(nativeEvents, [{ type: 'mouseUp', x: 0, y: 0, button: 'left', clickCount: 1 }]);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('a pointer renderer failure during release cannot suppress native mouseUp', async () => {
  const pointerVisualizer = {
    move: () => Promise.resolve({ sequence: 4, completed: true, status: 'settled' }),
    release: () => { throw new Error('pointer renderer disappeared'); }
  };
  const { controller, nativeEvents } = harness(pointerVisualizer);
  controller.trackHeld('session-a', 'tab-selected', 'buttons', 'left');

  const result = await controller.mouseUp('tab-selected', { x: 180, y: 190 }, 'session-a');

  assert.equal(result.input, 'cdp');
  assert.deepEqual(nativeEvents, [{ type: 'mouseReleased', x: 180, y: 190, button: 'left', buttons: 0, clickCount: 1 }]);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('a drag carries the held-button mask on its moves, so the page enters drag mode', async () => {
  // CDP requires the mask of held buttons on EVERY event. The old
  // sendInputEvent route inferred it; the CDP route does not, so a drag
  // delivered "move with no button held" and the page never started a drag.
  const { controller, nativeEvents } = harness({
    move: async () => ({ sequence: 1, completed: true }),
    press: async () => ({ sequence: 2, completed: true }),
    release: async () => ({ sequence: 3, completed: true })
  });
  await controller.drag('tab-selected', { startX: 100, startY: 100, endX: 200, endY: 200, steps: 4, durationMs: 40 }, 'session-a');
  const moves = nativeEvents.filter(event => event.type === 'mouseMoved');
  assert.ok(moves.length >= 2, 'the drag moved the pointer');
  assert.equal(moves[0].buttons, 0, 'the approach move has no button held');
  assert.ok(moves.slice(1).every(move => move.buttons === 1), 'every move during the press carries the held button');
});

test('a prior release that FAILED does not kill the next click', async () => {
  // The live chess run's "only the first click registers": click 1's release
  // was dropped by the starved debugger queue, and the pending-release gate
  // propagated that rejection out of the next press — so every later click
  // died before it pressed. The lease already orders the release command
  // ahead of the press, so a failed release must never cancel the press.
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const nativeEvents = [];
  let releaseAttempts = 0;
  const tab = {
    id: 'tab-1',
    webContents: {
      isDestroyed: () => false,
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method, params) => {
          if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
            releaseAttempts += 1;
            if (releaseAttempts <= 2) throw new Error('debugger queue dropped the release');
          }
          nativeEvents.push(params);
          return {};
        }
      }
    }
  };
  const controller = new BrowserViewController({ getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value });
  // The first click's release is genuinely lost, so that click reports failure.
  await controller.clickAt('tab-1', { x: 140, y: 180 }, 'session-a').catch(() => {});
  // The SECOND click must still press: a lost release must not cascade.
  await controller.clickAt('tab-1', { x: 220, y: 260 }, 'session-a');
  const presses = nativeEvents.filter(event => event.type === 'mousePressed');
  assert.equal(presses.length, 2, 'both clicks press even though the first release failed');
});

test('the post-input hit test resolves against the page instead of timing out at once', async () => {
  // Regression: the retry wrapper called withTimeout(promise) with no delay,
  // so its timer fired immediately and every hit test died with a messageless
  // Error (the live run's 100% hit-test failure — and the reason the model
  // never saw the board rect).
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const tab = {
    id: 'tab-1',
    webContents: {
      isDestroyed: () => false,
      executeJavaScript: async () => ({ hit: true, tag: 'cg-board', id: null, classes: '', role: null, isCanvas: false, rect: { x: 14, y: 64, width: 493, height: 493 }, textLength: 40, textTail: 'tail' })
    }
  };
  const controller = new BrowserViewController({ getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value });
  const hit = await controller.hitTest('tab-1', { x: 200, y: 300 });
  assert.equal(hit.hit, true);
  assert.equal(hit.tag, 'cg-board');
  assert.equal(hit.rect.width, 493);
});

test('a swallowed CDP click is re-sent through the native pipeline and reported', async () => {
  // The click-order game: every field reported hit:true while the page
  // received nothing. The harness must ENFORCE delivery: probe the page, and
  // when an armed probe shows no click at the point, re-send through
  // Electron's independent injection path and say which channel landed.
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const nativeClicks = [];
  let nativeDelivered = [];
  const tab = {
    id: 'tab-1',
    webContents: {
      isDestroyed: () => false,
      sendInputEvent: (event) => {
        if (event.type === 'mouseUp') nativeDelivered.push({ x: event.x, y: event.y, at: Date.now(), tag: 'button' });
      },
      debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
      executeJavaScript: async () => ({
        hit: true, tag: 'button', id: null, classes: 'field', role: null, isCanvas: false,
        rect: { x: 0, y: 0, width: 10, height: 10 }, textLength: 10, textTail: 'tail',
        pageClicks: nativeDelivered.slice(-2),
        lastDown: nativeDelivered.length ? nativeDelivered.at(-1) : null,
        lastUp: nativeDelivered.length ? nativeDelivered.at(-1) : null
      })
    }
  };
  const controller = new BrowserViewController({ getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value });

  // First click arms the probe (no evidence yet, so no retry and no verdict).
  const first = await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  assert.equal(first.delivered, undefined, 'the first click on a tab reports no delivery verdict');

  // Second click: the page still shows nothing, so the native pipeline runs.
  const second = await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  assert.equal(second.delivery, 'electron-retry', 'the click was re-sent through the native pipeline');
  assert.equal(second.delivered, true, 'the retried click reached the page');
  assert.ok(nativeClicks.length === 0, 'no stray native bookkeeping');
  assert.equal(nativeDelivered.length, 1, 'exactly one native click was injected');
});

test('a click the page received is reported as delivered over CDP, with no retry', async () => {
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const sent = [];
  const tab = {
    id: 'tab-1',
    webContents: {
      isDestroyed: () => false,
      sendInputEvent: (event) => sent.push(event),
      debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}) },
      executeJavaScript: async () => ({
        hit: true, tag: 'button', id: null, classes: 'field', role: null, isCanvas: false,
        rect: { x: 0, y: 0, width: 10, height: 10 }, textLength: 10, textTail: 'tail',
        pageClicks: [{ x: 40, y: 60, at: Date.now(), tag: 'button' }],
        lastDown: { x: 40, y: 60, at: Date.now(), tag: 'button' },
        lastUp: { x: 40, y: 60, at: Date.now(), tag: 'button' }
      })
    }
  };
  const controller = new BrowserViewController({ getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value });
  await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  const result = await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  assert.equal(result.delivery, 'cdp');
  assert.equal(result.delivered, true);
  assert.equal(sent.length, 0, 'a delivered click never touches the native pipeline');
});

test('once CDP is learned swallowed, later clicks use the native channel directly', async () => {
  // ~1.2s per click came from paying a dead CDP dispatch + probe + retry on
  // every click. The channel is learned per tab: after one successful native
  // retry, the native pipeline IS the click path.
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const nativeDelivered = [];
  let cdpDispatches = 0;
  const tab = {
    id: 'tab-1',
    webContents: {
      isDestroyed: () => false,
      sendInputEvent: (event) => { if (event.type === 'mouseUp') nativeDelivered.push({ x: event.x, y: event.y, at: Date.now(), tag: 'button' }); },
      debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => { cdpDispatches += 1; return {}; } },
      executeJavaScript: async () => ({
        hit: true, tag: 'button', id: null, classes: 'field', role: null, isCanvas: false,
        rect: { x: 0, y: 0, width: 10, height: 10 }, textLength: 10, textTail: 'tail',
        pageClicks: nativeDelivered.slice(-2),
        lastDown: nativeDelivered.length ? nativeDelivered.at(-1) : null,
        lastUp: nativeDelivered.length ? nativeDelivered.at(-1) : null
      })
    }
  };
  const controller = new BrowserViewController({ getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value });
  await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  await controller.clickAt('tab-1', { x: 40, y: 60 }, 'session-a');
  assert.equal(controller.deliveryChannel.get('tab-1'), 'native', 'the working channel is remembered');
  const cdpAfterLearning = cdpDispatches;
  const third = await controller.clickAt('tab-1', { x: 80, y: 90 }, 'session-a');
  assert.equal(third.delivery, 'native');
  assert.equal(third.delivered, true);
  assert.equal(cdpDispatches, cdpAfterLearning, 'a learned-native tab never pays for a dead CDP dispatch again');
});

test('the overlay never hangs on paint frames and never hides on a single ack timeout', () => {
  // The ack-timeout cycle: one missed ack hid the overlay window, and a hidden
  // window can never paint - so every later command timed out too (the live
  // 1.2s/click). The page now acks within a bounded fallback, and the overlay
  // only recycles after THREE consecutive timeouts.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/agent-pointer.js'), 'utf8');
  assert.match(page, /setTimeout\(finish, 60\)/, 'the ack has a bounded rAF fallback');
  const overlay = fs.readFileSync(path.join(process.cwd(), 'desktop/pointer/agentPointerOverlay.cjs'), 'utf8');
  assert.match(overlay, /POINTER_ACK_TIMEOUT_MS = 250/, 'the ack window is short');
  // Occlusion freezes the cursor: an occluded window produces no frames, so the
  // overlay must own the topmost layer (the live "remains on the first click").
  // App-scoped: NEVER a global topmost window (the cursor escaped onto other
  // applications), but always raised above the app's own surface.
  assert.ok(!/\.setAlwaysOnTop\(/.test(overlay), 'the overlay never becomes a global topmost window');
  assert.match(overlay, /pointerWindow\.moveTop\(\)/, 're-raised on every geometry sync');
  // A cleanup release must land where the pointer is, never at (0,0): a (0,0)
  // release turns the click into a <body> click and the control never fires.
  const controller = fs.readFileSync(path.join(process.cwd(), 'desktop/mcp/browserViewController.cjs'), 'utf8');
  const cleanupStart = controller.indexOf('  dispatchCleanupMouseUp(tabId, button, webContents, originalRoute, forceCdp = false) {');
  const cleanup = controller.slice(cleanupStart, cleanupStart + 1_400);
  assert.match(cleanup, /this\.lastPointer\.get\(tabId\)/, 'the cleanup release uses the last pointer position');
  assert.ok(!/x: 0, y: 0, button/.test(cleanup), 'no hardcoded (0,0) release');
  assert.match(overlay, /this\.ackTimeouts < 3/, 'one timeout is a strike, not a hide');
  assert.match(overlay, /this\.ackTimeouts = 0;\r?\n    clearTimeout\(pending\.timer\)/, 'a good ack resets the strikes');
});
