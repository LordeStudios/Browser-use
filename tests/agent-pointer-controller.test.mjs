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
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
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

  assert.deepEqual(nativeEvents, [{ type: 'mouseDown', x: 140, y: 180, button: 'left', clickCount: 1 }]);
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
  assert.equal(moveResult.input, 'electron-native');
  assert.deepEqual(pointerCalls, [
    ['move', 'tab-selected', { x: 80, y: 420 }],
    ['move', 'tab-selected', { x: 500, y: 120 }]
  ]);
  assert.deepEqual(nativeEvents, [{ type: 'mouseMove', x: 500, y: 120 }]);
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
  assert.deepEqual(nativeEvents, [{ type: 'mouseDown', x: 200, y: 220, button: 'left', clickCount: 1 }], 'the press is delivered directly');
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
    { type: 'mouseMove', x: 200, y: 220 },
    { type: 'mouseDown', x: 200, y: 220, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 200, y: 220, button: 'left', clickCount: 1 }
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
    { type: 'mouseMove', x: 90, y: 80 },
    { type: 'mouseDown', x: 90, y: 80, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 90, y: 80, button: 'left', clickCount: 1 }
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
  assert.equal(down.input, 'electron-native');
  controller.releaseSessionInput('session-a');

  assert.deepEqual(nativeEvents, [
    { type: 'mouseDown', x: 190, y: 230, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 0, y: 0, button: 'left', clickCount: 1 }
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
  assert.deepEqual(nativeEvents.filter((event) => event.type === 'mouseUp'), []);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mouseReleased']);
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
  assert.deepEqual(nativeEvents, [{ type: 'mouseDown', x: 120, y: 140, button: 'left', clickCount: 1 }]);
  assert.deepEqual(cdpEvents.map((entry) => entry.params.type), ['mouseReleased']);
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

    assert.equal(result.input, 'cdp-background');
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
    { type: 'mouseMove', x: 140, y: 180 },
    { type: 'mouseDown', x: 140, y: 180, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 140, y: 180, button: 'left', clickCount: 1 }
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
  const dragSegments = moveCalls.slice(2, -1);
  assert.equal(dragSegments.length, 4, 'the requested one-step drag must be normalized below the renderer motion ceiling');
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
  await waitForTest(() => nativeEvents.some((event) => event.type === 'mouseMove' && event.x === 155));
  const cancelledAt = Date.now();
  controller.releaseSessionInput('session-a');
  const result = await pending;

  assert.equal(result.input, 'interrupted');
  assert.ok(Date.now() - cancelledAt < 150, 'drag delay must wake promptly when its operation is cancelled');
  assert.equal(pointerMoves.some((point) => point.x === 300 && point.y === 300), false, 'cancelled drag must not issue its next stale visual target');
  assert.equal(nativeEvents.filter((event) => event.type === 'mouseUp').length, 1, 'session cleanup owns the only release edge');
  assert.deepEqual(nativeEvents.find((event) => event.type === 'mouseUp'), { type: 'mouseUp', x: 0, y: 0, button: 'left', clickCount: 1 });
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
  await waitForTest(() => nativeEvents.some((event) => event.type === 'mouseMove' && event.x === 155));
  const winningMove = await controller.mouseMove('tab-selected', { x: 500, y: 100 }, { sessionId: 'session-b' });
  const dragResult = await drag;

  assert.equal(winningMove.input, 'electron-native');
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
  assert.equal(winningResult.input, 'electron-native');
  assert.deepEqual(nativeEvents, [{ type: 'mouseMove', x: 460, y: 90 }]);
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
  assert.deepEqual(nativeEvents, [{ type: 'mouseUp', x: 320, y: 240, button: 'left', clickCount: 1 }]);
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

  assert.equal(result.input, 'electron-native');
  assert.deepEqual(nativeEvents, [{ type: 'mouseUp', x: 180, y: 190, button: 'left', clickCount: 1 }]);
  assert.equal(controller.heldInputState('session-a'), null);
});
