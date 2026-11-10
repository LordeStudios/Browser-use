import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';

// Real OS popup + pixel-coordinate contract. No simulated model or artwork.
const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-native-window-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_START_URL: 'about:blank' };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${profile}`], cwd: root, env, timeout: 40_000 });
  const result = await app.evaluate(async ({ BrowserWindow, Menu, screen }, root) => {
    const require = process.mainModule.require.bind(process.mainModule);
    const { ComputerTools } = require(root + '/desktop/computer/computerTools.cjs');
    const { DesktopCapture } = require(root + '/desktop/computer/desktopCapture.cjs');
    const backend = new ComputerTools({ capture: new DesktopCapture(require('electron')) });
    const window = new BrowserWindow({ title: 'Native menu regression', x: 80, y: 80, width: 560, height: 400, alwaysOnTop: true });
    await window.loadURL('data:text/html,<title>Native menu regression</title><h1>Native menu test</h1>');
    window.show(); window.focus();
    const owner = 'native-menu-regression';
    const desktop = await backend.observe(owner);
    const target = desktop.windows.find(w => w.title === 'Native menu regression');
    if (!target) throw Error('Fixture missing');
    try { await backend.execute('computer_window', { action: 'focus', windowId: target.id }, owner); }
    catch { await backend.execute('computer_pointer', { action: 'click', x: target.bounds.x + 150, y: target.bounds.y + 12 }, owner); }
    const chosen = [];
    const menu = Menu.buildFromTemplate([{ label: 'Choose visible item', click: () => chosen.push('selected') }]);
    try {
      const screenshot = await backend.execute('computer_screenshot', {}, owner);
      menu.popup({ window, x: 60, y: 80 });
      await new Promise(resolve => setTimeout(resolve, 180));
      const state = await backend.observe(owner);
      const content = window.getContentBounds();
      const point = screen.dipToScreenPoint({ x: content.x + 130, y: content.y + 95 });
      const ffi = require(root + '/node_modules/koffi'), user32 = ffi.load('user32.dll');
      const pointType = ffi.struct('MenuTestPoint', { x: 'int32_t', y: 'int32_t' });
      const hit = user32.func('uintptr_t __stdcall WindowFromPoint(MenuTestPoint point)')(point);
      const buffer = Buffer.alloc(128);
      const length = user32.func('int __stdcall GetClassNameW(uintptr_t, void*, int)')(hit, buffer, 64);
      const menuInfo = { className: buffer.toString('utf16le', 0, length*2), 
        owner: String(user32.func('uintptr_t __stdcall GetWindow(uintptr_t, uint32_t)')(hit, 4)),
        rootOwner: String(user32.func('uintptr_t __stdcall GetAncestor(uintptr_t, uint32_t)')(hit, 3)) };
      // Verify the click point really falls on the known app surface, not an
      // unrelated window, before relying on the test's coordinate math.
      const surfaceRect = Buffer.alloc(16);
      user32.func('bool __stdcall GetWindowRect(uintptr_t, void*)')(hit, surfaceRect);
      menuInfo.bounds = { x: surfaceRect.readInt32LE(0), y: surfaceRect.readInt32LE(4), width: surfaceRect.readInt32LE(8)-surfaceRect.readInt32LE(0), height: surfaceRect.readInt32LE(12)-surfaceRect.readInt32LE(4) };
      menuInfo.expectedPoint = point; menuInfo.contentBounds = content;
      let error = null;
      const surfacePoint = screen.dipToScreenPoint({ x: content.x + 40, y: content.y + 150 });
      // The open menu captures the pointer, so the item click must come
      // first; any dispatched click outside the menu dismisses it.
      let plain = null;
      try { await backend.execute('computer_pointer', { action: 'click', ...point, windowId: target.id }, owner); }
      catch (e) { error = e.message; }
      await new Promise(resolve => setTimeout(resolve, 150));
      try { await backend.execute('computer_pointer', { action: 'click', ...surfacePoint, windowId: target.id }, owner); } catch (e) { plain = e.message; }
      await new Promise(resolve => setTimeout(resolve, 100));
      return { error, plain, chosen, menuInfo, screenshotScale: [screenshot.scaleX, screenshot.scaleY], screenshotSize: [screenshot.width, screenshot.height],
        target: target.id, foreground: state.foregroundWindowId, nativeMenus: state.windows.filter(w => w.className === '#32768') };
    } finally { menu.closePopup(window); window.destroy(); await backend.close(); }
  }, root);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.error, null, 'The target app native menu must not be mistaken for another app');
  assert.equal(result.plain, null, 'An unrelated in-app surface must still be targetable after its owned popup is dismissed');
  assert.deepEqual(result.chosen, ['selected']);
  assert.deepEqual(result.screenshotScale, [1, 1], 'Default image and physical input must share a pixel frame');
  console.log('PASS native popup click and default screenshot coordinate frame');
} finally { if (app) await app.close().catch(() => {}); console.log(`Evidence profile: ${profile}`); }
