// A screenshot of the whole display is poor evidence when the thing under test
// is one window among several, and it forces the caller to guess where to look.
// Cropping is only safe if the coordinate contract survives it: a click derived
// from the crop must still land on the pixel it was derived from. These tests
// pin the mapping rather than the pixels.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopCapture } = require('../desktop/computer/desktopCapture.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

function fakeImage(width, height, crops = []) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    crop: ({ x, y, width: w, height: h }) => { crops.push({ x, y, width: w, height: h }); return fakeImage(w, h); },
    toPNG: () => Buffer.from('fake-png')
  };
}

function createCapture({ imageWidth = 1400, imageHeight = 788, display = { id: '4233901261', bounds: { x: 0, y: 0, width: 1920, height: 1080 } } } = {}) {
  const crops = [];
  const capture = new DesktopCapture({
    app: {}, BrowserWindow: function () {}, desktopCapturer: {}, screen: {}, session: {},
    ipcMain: { handle() {} }, getBrowserWindow: () => null, getTab: () => null
  });
  capture.display = () => ({ ...display, primary: true, scaleFactor: 1 });
  capture.source = async () => ({ thumbnail: fakeImage(imageWidth, imageHeight, crops), display_id: display.id });
  return { capture, crops, display };
}

test('a window hanging off the display is cropped to its visible part', () => {
  const { capture, crops } = createCapture();
  const thumbnail = fakeImage(1400, 788, crops);
  const size = thumbnail.getSize();
  const scaleX = 1920 / 1400;
  const scaleY = 1080 / 788;

  // A maximised window routinely starts at -9,-9.
  const cropped = capture.cropToWindow(thumbnail, size, { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, scaleX, scaleY, {
    x: -9, y: -9, width: 1938, height: 1038
  });

  assert.deepEqual(crops[0], { x: 0, y: 0, width: 1400, height: 757 });
  assert.deepEqual(cropped.origin, { x: 0, y: 0 }, 'a clamped crop must start at the display origin');
  assert.equal(cropped.size.width, 1400);
});

test('a window inside the display maps image pixels back to its own top-left', () => {
  const { capture } = createCapture();
  const thumbnail = fakeImage(1400, 788);
  const scaleX = 1920 / 1400;
  const scaleY = 1080 / 788;

  const cropped = capture.cropToWindow(thumbnail, thumbnail.getSize(), { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }, scaleX, scaleY, {
    x: 200, y: 100, width: 600, height: 400
  });

  // origin + 0 * scale must equal the window's desktop top-left, or every
  // coordinate read off the crop would be offset by the crop.
  assert.equal(cropped.origin.x, 200);
  assert.equal(cropped.origin.y, 100);
  // And the far edge must land back on the window's far edge, within the
  // rounding of a single image pixel.
  const rightEdge = cropped.origin.x + cropped.size.width * scaleX;
  assert.ok(Math.abs(rightEdge - 800) <= 3, `crop right edge maps to ${rightEdge}, expected ~800`);
});

test('a capture without a window keeps the display contract exactly', async () => {
  const { capture } = createCapture();
  const shot = await capture.screenshot({ maxWidth: 1400 });

  assert.deepEqual(shot.origin, { x: 0, y: 0 });
  assert.equal(shot.width, 1400);
  assert.equal(shot.height, 788);
  assert.equal(shot.scaleX, 1920 / 1400);
  assert.equal(shot.scaleY, 1080 / 788);
  assert.equal(shot.window, undefined, 'a display capture must not claim to be a window capture');
});

test('a window capture reports the window and shifts the origin', async () => {
  const { capture } = createCapture();
  const shot = await capture.screenshot({
    maxWidth: 1400,
    windowBounds: { x: 200, y: 100, width: 600, height: 400 },
    windowTitle: 'Blender'
  });

  assert.equal(shot.window.title, 'Blender');
  assert.deepEqual(shot.window.bounds, { x: 200, y: 100, width: 600, height: 400 });
  assert.equal(shot.origin.x, 200);
  assert.equal(shot.origin.y, 100);
  assert.equal(shot.width, Math.round(600 / (1920 / 1400)));
  assert.equal(shot.scaleX, 1920 / 1400, 'cropping must not resample');
});

test('computer_screenshot resolves the window before capturing', async () => {
  let received = null;
  const nativeCalls = [];
  const tools = new ComputerTools({
    nativeRequest: async (name) => {
      nativeCalls.push(name);
      if (name === 'release') return {};
      return { windows: [{ id: '77', title: 'Blender 5.2.3', bounds: { x: 10, y: 20, width: 300, height: 200 } }] };
    },
    capture: {
      screenshot: async (input) => {
        received = input;
        return { mimeType: 'image/png', data: 'AAA', width: 300, height: 200, origin: { x: 10, y: 20 }, scaleX: 1, scaleY: 1 };
      },
      close: () => {}
    }
  });

  const result = await tools.execute('computer_screenshot', { windowId: '77' }, 'owner-1');
  assert.ok(nativeCalls.includes('computer_window'), 'the window bounds must come from the native window list');
  assert.deepEqual(received.windowBounds, { x: 10, y: 20, width: 300, height: 200 });
  assert.equal(received.windowTitle, 'Blender 5.2.3');
  assert.equal(result.window.id, '77');
  assert.equal(result.window.title, 'Blender 5.2.3');
  tools.close?.();
});

test('an unknown window is refused with the tool that lists them', async () => {
  const tools = new ComputerTools({
    nativeRequest: async () => ({ windows: [] }),
    capture: { screenshot: async () => { throw new Error('must not capture'); }, close: () => {} }
  });

  await assert.rejects(
    () => tools.execute('computer_screenshot', { windowId: '999' }, 'owner-1'),
    /Unknown window 999[\s\S]*computer_observe/
  );
  tools.close?.();
});
