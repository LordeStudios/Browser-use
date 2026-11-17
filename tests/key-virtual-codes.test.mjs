// A key event without a virtual key code produces no DEFAULT ACTION: the page
// sees keydown, but ArrowDown never scrolls, Enter never submits and Tab never
// moves focus. The live measurement for this fork was a keydown arriving with
// key:"" and scrollY unchanged on both delivery routes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

function createHarness() {
  const native = [];
  const cdp = [];
  const tab = {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      sendInputEvent: (event) => native.push(event),
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method, params) => cdp.push({ method, params })
      },
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
    normalizeUrl: (value) => value
  });
  return { controller, native, cdp, tab };
}

test('ArrowDown carries a virtual key code on the CDP route', async () => {
  const { controller, tab, native, cdp } = createHarness();
  // Force the CDP route by making the tab read as background.
  controller.getSelectedTabId = () => 'tab-other';

  await controller.key(tab.id, { key: 'ArrowDown' }, 'session-a');

  const dispatched = cdp.filter((entry) => entry.method === 'Input.dispatchKeyEvent');
  assert.equal(dispatched.length, 2, 'a press is a down edge and an up edge');
  assert.equal(dispatched[0].params.type, 'keyDown');
  assert.equal(dispatched[0].params.key, 'ArrowDown');
  assert.equal(dispatched[0].params.code, 'ArrowDown');
  assert.equal(dispatched[0].params.windowsVirtualKeyCode, 40, '40 is VK_DOWN: without it the page cannot scroll');
  assert.equal(dispatched[0].params.nativeVirtualKeyCode, 40);
  assert.equal(dispatched[1].params.type, 'keyUp');
  assert.deepEqual(native, [], 'a background key must not fall back to sendInputEvent');
});

test('Enter carries VK_RETURN and inserts a carriage return', async () => {
  const { controller, tab, cdp } = createHarness();
  controller.getSelectedTabId = () => 'tab-other';

  await controller.key(tab.id, { key: 'Enter' }, 'session-a');

  const down = cdp.find((entry) => entry.method === 'Input.dispatchKeyEvent' && entry.params.type === 'keyDown');
  assert.equal(down.params.windowsVirtualKeyCode, 13);
  assert.equal(down.params.text, '\r');
});

test('the Electron route uses the accelerator name Electron actually accepts', async () => {
  const { controller, tab, native } = createHarness();

  await controller.key(tab.id, { key: 'ArrowDown' }, 'session-a');

  assert.deepEqual(native, [
    { type: 'keyDown', keyCode: 'Down' },
    { type: 'keyUp', keyCode: 'Down' }
  ], '"ArrowDown" is not an Electron keyCode; "Down" is');
});

test('a printable key still resolves to an Electron keyCode and a DOM code', async () => {
  const { controller, tab, cdp, native } = createHarness();
  controller.getSelectedTabId = () => 'tab-other';

  await controller.key(tab.id, { key: 'a' }, 'session-a');
  const down = cdp.find((entry) => entry.method === 'Input.dispatchKeyEvent' && entry.params.type === 'keyDown');
  assert.equal(down.params.code, 'KeyA');
  assert.equal(down.params.windowsVirtualKeyCode, 65);
  assert.equal(down.params.text, 'a');

  native.length = 0;
  controller.getSelectedTabId = () => tab.id;
  await controller.key(tab.id, { key: 'a' }, 'session-a');
  assert.equal(native[0].keyCode, 'A');
});

test('Shift keeps its established Electron keyCode during session release', () => {
  const { controller, tab, native } = createHarness();
  controller.key(tab.id, { key: 'Shift', action: 'down' }, 'session-a');
  native.length = 0;

  controller.releaseSessionInput('session-a');

  assert.deepEqual(native, [{ type: 'keyUp', keyCode: 'Shift' }]);
});

test('function keys and aliases resolve without inventing a code', async () => {
  const { controller, tab, cdp } = createHarness();
  controller.getSelectedTabId = () => 'tab-other';

  await controller.key(tab.id, { key: 'F5' }, 'session-a');
  await controller.key(tab.id, { key: 'esc' }, 'session-a');
  await controller.key(tab.id, { key: 'pgdn' }, 'session-a');

  const downs = cdp.filter((entry) => entry.method === 'Input.dispatchKeyEvent' && entry.params.type === 'keyDown');
  assert.equal(downs[0].params.windowsVirtualKeyCode, 116, 'F5 is VK_F5');
  assert.equal(downs[1].params.key, 'Escape');
  assert.equal(downs[1].params.windowsVirtualKeyCode, 27);
  assert.equal(downs[2].params.key, 'PageDown');
  assert.equal(downs[2].params.windowsVirtualKeyCode, 34);
});
