// FRAME AWARENESS: a page that renders inside a same-origin iframe must not read
// as an empty shell. The element collector is document-scoped by construction, so
// before this the snapshot reported the outer chrome and nothing else — which is
// what made one TikTok inbox read cost 10 blind probes over 6m55s.
//
// These tests pin the two properties that make the frame report useful rather
// than decorative: the offset is in TOP-document pixels (so a coordinate read
// inside the frame is directly clickable), and the path identifies the frame for
// a later call.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

const SOURCE = require('node:fs').readFileSync(
  new URL('../desktop/mcp/browserViewController.cjs', import.meta.url), 'utf8'
);

// The two page evaluations are told apart by markers unique to each script.
const isCollector = (script) => script.includes('INTERACTIVE_SELECTOR');
const isFrameOverview = (script) => script.includes('MAX_FRAMES');

function makeController(overview) {
  const calls = [];
  const tab = {
    id: 'tab-1',
    title: 'Frames',
    webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://app.test/',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async (script) => {
        calls.push(script);
        if (isCollector(script)) {
          return { url: 'https://app.test/', title: 'Frames', viewport: { width: 900, height: 700, scrollX: 0, scrollY: 0 }, elements: [{ index: 0, tag: 'button', name: 'Save', selector: '#save', rect: { x: 1, y: 2, w: 3, h: 4 }, center: { x: 2, y: 4 } }], truncated: false };
        }
        if (isFrameOverview(script)) {
          if (overview instanceof Error) throw overview;
          return overview;
        }
        throw new Error(`unexpected script: ${script.slice(0, 80)}`);
      }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => true
  });
  return { controller, calls };
}

test('the snapshot reports same-origin frames with their text', async () => {
  const { controller } = makeController({
    text: 'Business Suite | TikTok',
    frames: [{
      path: [0],
      src: '/messages?scene=business',
      crossOrigin: false,
      offset: { x: 0, y: 120 },
      size: { w: 784, h: 574 },
      viewport: { w: 784, h: 574 },
      text: 'Cottiny\nThanks\n11/15/2026'
    }]
  });
  const snapshot = await controller.domSnapshot('tab-1', { maxElements: 5 });

  assert.equal(snapshot.text, 'Business Suite | TikTok');
  assert.equal(snapshot.frames.length, 1, 'the frame must survive into the snapshot payload');
  const frame = snapshot.frames[0];
  assert.equal(frame.path[0], 0);
  assert.equal(frame.crossOrigin, false);
  // The offset is what makes a coordinate measured inside the frame clickable.
  assert.deepEqual(frame.offset, { x: 0, y: 120 });
  assert.match(frame.text, /Cottiny/);
  // Elements from the top document are still collected exactly as before.
  assert.equal(snapshot.elements.length, 1);
});

test('a page with no frames does not carry an empty frames array', async () => {
  const { controller } = makeController({ text: 'plain page', frames: [] });
  const snapshot = await controller.domSnapshot('tab-1', { maxElements: 5 });
  assert.equal(snapshot.text, 'plain page');
  assert.equal(snapshot.frames, undefined, 'an empty frames list is noise on the majority of pages');
});

test('a frame report that throws never fails the snapshot', async () => {
  const { controller } = makeController(new Error('frame walk blew up'));
  const snapshot = await controller.domSnapshot('tab-1', { maxElements: 5 });
  assert.equal(snapshot.elements.length, 1, 'element collection is the contract; frames are an aid');
  assert.equal(snapshot.frames, undefined);
});

test('a plain string return still sets the text excerpt', async () => {
  // Older/alternate evaluators may answer with bare text; that must not be lost.
  const { controller } = makeController('just text');
  const snapshot = await controller.domSnapshot('tab-1', { maxElements: 5 });
  assert.equal(snapshot.text, 'just text');
});

test('the generated script walks iframes, offsets by the border inset, and marks cross-origin frames', () => {
  const start = SOURCE.indexOf('function buildFrameOverviewScript');
  assert.ok(start > 0, 'buildFrameOverviewScript must exist');

  const body = SOURCE.slice(start, start + 4_000);
  assert.match(body, /querySelectorAll\('iframe,frame'\)/, 'both iframe and frame elements must be walked');
  assert.match(body, /clientLeft/, 'the content origin sits inside the frame border');
  assert.match(body, /clientTop/, 'the content origin sits inside the frame border');
  assert.match(body, /crossOrigin: true/, 'an unreadable frame must be reported as opaque, not as empty');
  assert.match(body, /contentDocument/, 'same-origin frames are entered through contentDocument');
  assert.match(body, /MAX_DEPTH/, 'frame recursion must be bounded');
  assert.match(body, /MAX_FRAMES/, 'the number of frames must be bounded');
  // A frame that throws while being walked must not abort the whole report.
  assert.match(body, /one bad frame never fails the report/);
});

test('the frame overview is bounded so one call cannot flood the context', async () => {
  const { controller, calls } = makeController({ text: 'x', frames: [] });
  await controller.domSnapshot('tab-1', { maxElements: 5 });
  const overview = calls.find(isFrameOverview);
  assert.ok(overview, 'the snapshot must ask for a frame overview');
  // Defaults are literals in the generated script; they must be present and sane.
  assert.match(overview, /const MAX_FRAMES = 8/);
  assert.match(overview, /const MAX_DEPTH = 3/);
  assert.match(overview, /const PER_FRAME_TEXT = 1200/);
  assert.match(overview, /const MAX_TEXT = 2000/);
});

// ── Frame-scoped element reads ──────────────────────────────────────────────
// Reading inside a frame is only useful if the coordinates stay clickable. A
// frame's own getBoundingClientRect is local to the frame, so the reader must
// lift every rect by the frame's offset in the top document.
function makeFrameReader(payload) {
  let script = null;
  const tab = {
    id: 'tab-1',
    title: 'Frame',
    webContents: {
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://app.test/',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async (source) => { script = source; return payload; }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => true
  });
  return { controller, tab, script: () => script };
}

test('a frame read lifts rects into top-document pixels and tags the elements', async () => {
  const { controller, tab } = makeFrameReader({
    url: 'https://app.test/',
    title: 'Frame',
    readyState: 'complete',
    viewport: { width: 784, height: 574, scrollX: 0, scrollY: 0 },
    frameOffset: { x: 0, y: 120 },
    elements: [
      { index: 0, tag: 'div', name: 'Cottiny', rect: { x: 10, y: 20, w: 100, h: 40 }, center: { x: 60, y: 40 } }
    ],
    truncated: false
  });
  const payload = await controller.readElements(tab, { framePath: [0], maxElements: 5 });
  const element = payload.elements[0];
  assert.deepEqual(element.rect, { x: 10, y: 140, w: 100, h: 40 }, 'the frame offset must be added to the rect');
  assert.deepEqual(element.center, { x: 60, y: 160 }, 'the click point must move with the rect');
  assert.deepEqual(element.framePath, [0], 'the element must remember which frame it came from');
  assert.equal(payload.frameOffset, undefined, 'the offset is an implementation detail of the read');
});

test('a frame read does not overwrite the tab viewport with the frame box', async () => {
  const { controller, tab } = makeFrameReader({
    url: 'https://app.test/', title: 'Frame', readyState: 'complete',
    viewport: { width: 784, height: 574, scrollX: 0, scrollY: 0 },
    frameOffset: { x: 0, y: 120 }, elements: [], truncated: false
  });
  await controller.readElements(tab, { framePath: [0], maxElements: 5 });
  assert.equal(controller.lastViewport.get('tab-1'), undefined, 'a frame box is not the tab viewport');
});

test('a top-document read is untouched by the frame plumbing', async () => {
  const { controller, tab } = makeFrameReader({
    url: 'https://app.test/', title: 'Top', readyState: 'complete',
    viewport: { width: 900, height: 700, scrollX: 0, scrollY: 0 },
    frameOffset: { x: 0, y: 0 },
    elements: [{ index: 0, tag: 'button', name: 'Save', rect: { x: 5, y: 6, w: 7, h: 8 }, center: { x: 8, y: 10 } }],
    truncated: false
  });
  const payload = await controller.readElements(tab, { maxElements: 5 });
  assert.deepEqual(payload.elements[0].rect, { x: 5, y: 6, w: 7, h: 8 });
  assert.equal(payload.elements[0].framePath, undefined, 'top-document elements carry no frame path');
  assert.deepEqual(controller.lastViewport.get('tab-1'), { width: 900, height: 700, scrollX: 0, scrollY: 0 });
});

test('the frame path reaches the page script that runs the read', async () => {
  const { controller, script, tab } = makeFrameReader({
    url: 'https://app.test/', title: 'Frame', readyState: 'complete',
    viewport: { width: 784, height: 574, scrollX: 0, scrollY: 0 },
    frameOffset: { x: 0, y: 120 }, elements: [], truncated: false
  });
  await controller.readElements(tab, { framePath: [0, 2], maxElements: 5 });
  const source = script();
  assert.ok(source, 'the reader must evaluate a script');
  assert.match(source, /__framePath/, 'the script must branch on the frame path');
  assert.ok(source.includes('[0,2]'), 'the nested path must be interpolated');
  assert.match(source, /contentDocument/, 'the frame must be entered through contentDocument');
  assert.match(source, /__frameOffset/, 'the script must report the offset it walked through');
});
