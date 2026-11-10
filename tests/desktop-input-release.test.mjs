import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

function createHarness({ destroyed = false } = {}) {
  const events = [];
  const tab = {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      sendInputEvent: (event) => events.push(event),
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (_method, event) => events.push(event)
      },
      insertText: (text) => events.push({ type: 'insertText', text }),
      isDestroyed: () => destroyed,
      getURL: () => 'https://example.com/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value
  });
  return { controller, events, tab };
}

test('held mouse buttons and keys are released for the ending session only', async () => {
  const { controller, events } = createHarness();

  await controller.mouseDown('tab-1', { x: 12, y: 24, button: 'left' }, 'session-a');
  await controller.key('tab-1', { key: 'Shift', action: 'down' }, 'session-a');
  await controller.mouseDown('tab-1', { x: 40, y: 50, button: 'right' }, 'session-b');

  assert.deepEqual(controller.heldInputState('session-a'), { tabId: 'tab-1', buttons: ['left'], keys: ['Shift'] });
  assert.deepEqual(controller.heldInputState('session-b'), { tabId: 'tab-1', buttons: ['right'], keys: [] });

  events.length = 0;
  const released = controller.releaseSessionInput('session-a');

  assert.equal(released.released, true);
  assert.deepEqual(released.buttons, ['left']);
  assert.deepEqual(released.keys, ['Shift']);
  assert.deepEqual(events, [
    { type: 'mouseUp', x: 0, y: 0, button: 'left', clickCount: 1 },
    { type: 'keyUp', keyCode: 'Shift' }
  ]);
  assert.equal(controller.heldInputState('session-a'), null);
  assert.deepEqual(controller.heldInputState('session-b'), { tabId: 'tab-1', buttons: ['right'], keys: [] });
});

test('balanced input leaves nothing held and release stays idempotent', async () => {
  const { controller, events } = createHarness();

  await controller.mouseDown('tab-1', { x: 5, y: 5 }, 'session-a');
  await controller.mouseUp('tab-1', { x: 5, y: 5 }, 'session-a');
  await controller.key('tab-1', { key: 'a', action: 'press' }, 'session-a');
  assert.equal(controller.heldInputState('session-a'), null);

  events.length = 0;
  assert.deepEqual(controller.releaseSessionInput('session-a'), { released: false, buttons: [], keys: [] });
  assert.deepEqual(controller.releaseSessionInput('unknown-session'), { released: false, buttons: [], keys: [] });
  assert.deepEqual(events, []);
});

test('release tolerates a destroyed tab and still clears tracked state', () => {
  const { controller, events } = createHarness({ destroyed: true });

  controller.mouseDown('tab-1', { x: 1, y: 2 }, 'session-a');
  events.length = 0;

  const released = controller.releaseSessionInput('session-a');
  assert.deepEqual(released.buttons, ['left']);
  assert.deepEqual(events, []);
  assert.equal(controller.heldInputState('session-a'), null);
});

test('closing a tab or shutting down releases every holder of that tab', () => {
  const { controller, events } = createHarness();

  controller.mouseDown('tab-1', { x: 3, y: 4, button: 'left' }, 'session-a');
  controller.key('tab-1', { key: 'Control', action: 'down' }, 'session-b');

  events.length = 0;
  const releasedByTab = controller.releaseTabInput('tab-1');
  assert.equal(releasedByTab.length, 2);
  assert.equal(events.filter((event) => event.type === 'mouseUp').length, 1);
  assert.equal(events.filter((event) => event.type === 'keyUp').length, 1);
  assert.deepEqual(controller.releaseAllInput(), []);

  controller.mouseDown('tab-1', { x: 3, y: 4 }, 'session-c');
  assert.equal(controller.releaseAllInput().length, 1);
  assert.equal(controller.heldInputState('session-c'), null);
});

test('routes input through the requested background tab without stealing selected-tab focus', async () => {
  const events = [];
  let focused = false;
  const background = {
    id: 'tab-background',
    title: 'Background',
    webContents: {
      sendInputEvent: (event) => events.push(['background-electron', event]),
      debugger: {
        isAttached: () => false,
        attach: () => events.push(['background-attach']),
        detach: () => events.push(['background-detach']),
        sendCommand: async (method, event) => events.push(['background-cdp', method, event])
      },
      insertText: (text) => events.push(['background-text', text]),
      focus: () => { focused = true; },
      isDestroyed: () => false,
      getURL: () => 'https://background.example/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const selected = {
    id: 'tab-selected',
    title: 'Selected',
    webContents: {
      sendInputEvent: (event) => events.push(['selected-electron', event]),
      debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => {} },
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://selected.example/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [selected, background],
    getSelectedTabId: () => selected.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value
  });

  await controller.mouseMove(background.id, { x: 12, y: 24 });
  await controller.mouseDown(background.id, { x: 12, y: 24 }, 'session-a');
  await controller.mouseUp(background.id, { x: 12, y: 24 }, 'session-a');
  await controller.key(background.id, { key: 'a' }, 'session-a');
  await controller.type(background.id, { text: 'background text' });

  assert.equal(focused, false, 'background input must not call webContents.focus');
  assert.equal(events.filter(([target]) => target === 'selected-electron').length, 0, 'selected tab must not receive background input');
  assert.ok(events.some(([target, method, event]) => target === 'background-cdp' && method === 'Input.dispatchMouseEvent' && event.type === 'mousePressed'));
  assert.ok(events.some(([target, method]) => target === 'background-cdp' && method === 'Input.dispatchKeyEvent'));
  assert.ok(events.some(([target, method]) => target === 'background-cdp' && method === 'Input.insertText'));
});

test('pointer actions use native input without executing page JavaScript', async () => {
  const { controller, tab, events } = createHarness();
  const scripts = [];
  tab.webContents.executeJavaScript = (script) => {
    scripts.push(script);
    return Promise.resolve();
  };

  controller.mouseMove('tab-1', { x: 12, y: 24 });
  controller.mouseDown('tab-1', { x: 30, y: 40 }, 'session-a');
  controller.mouseUp('tab-1', { x: 50, y: 60 }, 'session-a');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(scripts.length, 0, 'input must not inject or execute code in the page');
  assert.deepEqual(events, [
    { type: 'mouseMove', x: 12, y: 24 },
    { type: 'mouseDown', x: 30, y: 40, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 50, y: 60, button: 'left', clickCount: 1 }
  ]);
});

test('selected native input reattaches one transiently detached BrowserView before dispatch', () => {
  const { events, tab } = createHarness();
  let paintable = false;
  let recoveryCalls = 0;
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => paintable,
    ensureTabPaintable: (tabId) => {
      recoveryCalls += 1;
      assert.equal(tabId, tab.id);
      paintable = true;
      return true;
    }
  });

  controller.mouseMove(tab.id, { x: 18, y: 26 });

  assert.equal(recoveryCalls, 1);
  assert.deepEqual(events, [{ type: 'mouseMove', x: 18, y: 26 }]);
});

test('selected input uses same-tab CDP when shell reattachment cannot restore the native view', async () => {
  const { tab, events } = createHarness();
  let recoveryCalls = 0;
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => false,
    ensureTabPaintable: () => { recoveryCalls += 1; return false; }
  });

  const outcome = await controller.mouseMove(tab.id, { x: 18, y: 26 });

  assert.equal(recoveryCalls, 1);
  assert.deepEqual(outcome, { tabId: tab.id, input: 'cdp-background' });
  assert.deepEqual(events, [{ type: 'mouseMoved', x: 18, y: 26 }]);
});

test('scroll uses a valid native pointer and reports read-only movement evidence', async () => {
  const { controller, tab, events } = createHarness();
  const scripts = [];
  let scrollY = 0;
  tab.webContents.executeJavaScript = (script) => {
    scripts.push(script);
    if (events.some((event) => event.type === 'mouseWheel')) scrollY = 100;
    return Promise.resolve({
      url: 'https://example.com/',
      title: 'Fixture',
      viewport: { width: 800, height: 600, scrollX: 0, scrollY },
      elements: [],
      truncated: false
    });
  };

  controller.mouseMove('tab-1', { x: 80, y: 90 });
  const result = await controller.scroll('tab-1', { deltaX: 0, deltaY: 100 });

  assert.equal(scripts.length, 2, 'scroll may only inspect bounded viewport state');
  assert.deepEqual(events.at(-1), { type: 'mouseWheel', x: 80, y: 90, deltaX: 0, deltaY: 100 });
  assert.deepEqual(result.origin, { x: 80, y: 90 });
  assert.equal(result.moved, true);
});

test('scroll uses the viewport centre when no valid native pointer exists', async () => {
  const { controller, tab, events } = createHarness();
  tab.webContents.executeJavaScript = () => Promise.resolve({
    url: 'https://example.com/',
    title: 'Fixture',
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    elements: [],
    truncated: false
  });

  const result = await controller.scroll('tab-1', { deltaY: 100 });

  assert.deepEqual(events.at(-1), { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: 100 });
  assert.deepEqual(result.origin, { x: 400, y: 300 });
});

test('scroll discards a pointer outside the current viewport', async () => {
  const { controller, tab, events } = createHarness();
  tab.webContents.executeJavaScript = () => Promise.resolve({
    url: 'https://example.com/',
    title: 'Fixture',
    viewport: { width: 320, height: 240, scrollX: 0, scrollY: 0 },
    elements: [],
    truncated: false
  });
  controller.mouseMove('tab-1', { x: 800, y: 600 });

  const result = await controller.scroll('tab-1', { deltaY: 100 });

  assert.deepEqual(events.at(-1), { type: 'mouseWheel', x: 160, y: 120, deltaX: 0, deltaY: 100 });
  assert.deepEqual(result.origin, { x: 160, y: 120 });
});

test('drag interpolates native input without executing page JavaScript', async () => {
  const { controller, tab, events } = createHarness();
  const scripts = [];
  tab.webContents.executeJavaScript = (script) => {
    scripts.push(script);
    return Promise.resolve();
  };

  await controller.drag('tab-1', { startX: 10, startY: 20, endX: 30, endY: 40, steps: 3, durationMs: 15 });

  const mouseEvents = events.filter((event) => event.type.startsWith('mouse'));
  // move(start) + down(start) + move(interpolated 1) + move(interpolated 2) + move(end) + up(end)
  assert.equal(mouseEvents.length, 6);

  assert.deepEqual(mouseEvents[0], { type: 'mouseMove', x: 10, y: 20 });
  assert.deepEqual(mouseEvents[1], { type: 'mouseDown', x: 10, y: 20, button: 'left', clickCount: 1 });
  assert.deepEqual(mouseEvents[2], { type: 'mouseMove', x: 17, y: 27 });
  assert.deepEqual(mouseEvents[3], { type: 'mouseMove', x: 23, y: 33 });
  assert.deepEqual(mouseEvents[4], { type: 'mouseMove', x: 30, y: 40 });
  assert.deepEqual(mouseEvents[5], { type: 'mouseUp', x: 30, y: 40, button: 'left', clickCount: 1 });
  assert.equal(scripts.length, 0, 'drag must not inject a page overlay');
});

test('input is only ever dispatched to the requested bound tab', () => {
  const { controller } = createHarness();

  assert.throws(() => controller.mouseDown('tab-missing', { x: 1, y: 1 }, 'session-a'), /no longer available/i);
  assert.throws(() => controller.key('tab-missing', { key: 'a' }, 'session-a'), /no longer available/i);
  assert.equal(controller.heldInputState('session-a'), null);
  assert.throws(() => controller.key('tab-1', { key: 'a', action: 'hold' }, 'session-a'), /press, down, or up/i);
});
