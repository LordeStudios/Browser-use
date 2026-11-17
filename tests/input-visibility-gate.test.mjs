// Chromium discards mouse and wheel input for a hidden render widget, so a
// pointer action taken while the Browser-use window is occluded lands nowhere
// while still looking successful. These tests pin the gate that prevents it:
// it must raise the window, verify the cure, and fail loudly when it cannot.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

function createHarness({ visibility = 'visible', raiseResult = true } = {}) {
  const dispatched = [];
  const tab = {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      sendInputEvent: (event) => dispatched.push(event),
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (method, params) => dispatched.push({ method, params })
      },
      insertText: () => {},
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
  const state = { visibility, raises: 0, raiseResult };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    raiseForInput: () => {
      state.raises += 1;
      if (state.raiseResult && state.visibility === 'hidden') state.visibility = 'visible';
      return state.raiseResult;
    }
  });
  // The page's own answer, without a debugger round trip.
  controller.evaluatePage = async () => state.visibility;
  return { controller, dispatched, tab, state };
}

test('a hidden renderer is raised once and the pointer event still lands', async () => {
  const { controller, dispatched, tab, state } = createHarness({ visibility: 'hidden' });

  const result = await controller.mouseMove(tab.id, { x: 12, y: 24 });

  assert.equal(state.raises, 1, 'the occluded window must be raised before dispatching');
  assert.equal(result.raisedWindow, true, 'the caller must learn that focus moved');
  assert.equal(result.input, 'cdp');
  assert.ok(dispatched.some((entry) => entry.params?.type === 'mouseMoved'), 'the move must still be dispatched');
});

test('a renderer that cannot be made visible fails fast with the real cause', async () => {
  const { controller, dispatched, tab } = createHarness({ visibility: 'hidden', raiseResult: false });

  await assert.rejects(
    () => controller.mouseMove(tab.id, { x: 12, y: 24 }),
    (error) => {
      assert.match(error.message, /visibilityState=hidden/);
      assert.match(error.message, /discards mouse and wheel input/);
      assert.match(error.message, /Bring the Browser-use window to the front/);
      return true;
    }
  );
  assert.deepEqual(dispatched, [], 'nothing may be dispatched to a renderer that cannot receive it');
});

test('an unreadable page never blocks input', async () => {
  const { controller, tab } = createHarness();
  controller.evaluatePage = async () => { throw new Error('debugger unavailable'); };

  const result = await controller.mouseMove(tab.id, { x: 5, y: 6 });

  assert.equal(result.input, 'cdp', 'an unknown visibility must not stop the dispatch');
  assert.equal(result.raisedWindow, undefined);
});

test('the verdict is memoised so a gesture pays one page round trip', async () => {
  const { controller, tab, state } = createHarness({ visibility: 'hidden' });
  let reads = 0;
  controller.evaluatePage = async () => { reads += 1; return state.visibility; };

  await controller.mouseMove(tab.id, { x: 1, y: 1 });
  // The first move reads once to find the page hidden, then once more to verify
  // the raise actually worked — that second read is the point of the gate.
  const afterFirst = reads;
  assert.ok(afterFirst <= 2, `the first move may verify the cure, took ${afterFirst} reads`);

  await controller.mouseMove(tab.id, { x: 2, y: 2 });
  await controller.mouseMove(tab.id, { x: 3, y: 3 });

  assert.equal(reads, afterFirst, 'visibility must not be re-read for every event of one gesture');
});

test('scroll reports the same diagnosis instead of blaming the wheel', async () => {
  const { controller, tab } = createHarness({ visibility: 'hidden', raiseResult: false });

  await assert.rejects(
    () => controller.scroll(tab.id, { deltaY: 120 }),
    (error) => {
      assert.match(error.message, /visibilityState=hidden/);
      return true;
    }
  );
});
