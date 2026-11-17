import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

// The drag contract lies twice if the element form is only a description:
// the MCP schema demanded coordinates (so the "PREFERRED" element form could
// not even be called) and the controller ignored the indices it was handed.
// These tests pin the executable form: an element drag resolves the two DOM
// indices to the exact centers the browser laid out and drives the SAME
// native sequence a coordinate drag drives.
function createHarness() {
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
        sendCommand: async (_method, event) => { events.push(event); return {}; }
      },
      insertText: (text) => events.push({ type: 'insertText', text }),
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
  const elements = {
    3: { index: 3, selector: '.token', center: { x: 120, y: 240 } },
    9: { index: 9, selector: '.slot', center: { x: 640, y: 480 } }
  };
  controller.elementRect = async (_tabId, { index }) => elements[index] || null;
  return { controller, events, elements };
}

test('an element drag runs between the two exact centers', async () => {
  const { controller, events } = createHarness();

  const result = await controller.drag('tab-1', { fromElement: 3, toElement: 9, steps: 3, durationMs: 30 }, 'session-a');

  assert.equal(result.input, 'mouse', 'the drag completes');
  assert.deepEqual(
    { x: result.startX, y: result.startY },
    { x: 120, y: 240 },
    'the drag starts at the source element center'
  );
  assert.deepEqual(
    { x: result.endX, y: result.endY },
    { x: 640, y: 480 },
    'the drag ends at the destination element center'
  );

  const pressed = events.find((event) => event.type === 'mousePressed');
  assert.deepEqual(pressed, { type: 'mousePressed', x: 120, y: 240, button: 'left', buttons: 1, clickCount: 1 },
    'the press lands on the source center');
  const released = events.find((event) => event.type === 'mouseReleased');
  assert.deepEqual(released, { type: 'mouseReleased', x: 640, y: 480, button: 'left', buttons: 0, clickCount: 1 },
    'the release lands on the destination center');
});

test('every move during an element drag carries the held-button mask', async () => {
  // A move that claims no button is held never puts the page into drag mode:
  // the element never follows the pointer. The mask is the difference between
  // a drag and a hover.
  const { controller, events } = createHarness();

  await controller.drag('tab-1', { fromElement: 3, toElement: 9, steps: 4, durationMs: 40 }, 'session-a');

  const moves = events.filter((event) => event.type === 'mouseMoved');
  assert.ok(moves.length >= 4, `the drag interpolates its steps (got ${moves.length})`);
  const afterPress = moves.filter((_event, index) => index > 0);
  assert.ok(afterPress.length >= 1, 'the drag moves after the press');
  for (const move of afterPress) {
    assert.equal(move.buttons, 1, 'a move during a press must report the held button');
  }
  const last = moves.at(-1);
  assert.deepEqual({ x: last.x, y: last.y }, { x: 640, y: 480 }, 'the last move reaches the destination');
});

test('a half-specified element form is refused with an actionable error', async () => {
  const { controller } = createHarness();

  await assert.rejects(
    () => controller.drag('tab-1', { fromElement: 3, endX: 10, endY: 20 }, 'session-a'),
    /BOTH fromElement and toElement/,
    'one index alone is a broken form, not a silent coordinate drag'
  );
});

test('the MCP drag tool lets the element form be called', async () => {
  const server = fs.readFileSync(path.join(process.cwd(), 'desktop/mcp/localMcpServer.cjs'), 'utf8');
  const start = server.indexOf("toolDefinition('browser_drag'");
  assert.ok(start >= 0, 'the MCP server still defines browser_drag');
  const next = server.indexOf("toolDefinition('", start + 10);
  const block = server.slice(start, next === -1 ? server.length : next);
  assert.doesNotMatch(block, /'startX',\s*'startY',\s*'endX',\s*'endY'\s*\]\)/,
    'the schema must not demand coordinates: that made the advertised element form uncallable');
  assert.match(block, /fromElement/, 'the element form is part of the schema');
  assert.match(block, /toElement/, 'the element form is part of the schema');
});
