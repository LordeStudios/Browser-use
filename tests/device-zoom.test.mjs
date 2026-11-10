// Acceptance for DEVICE CANVAS ZOOM (Ctrl+Scroll on the emulated device view),
// driven the way a paired MCP host drives it: pair, bind a tab, enter a device
// profile, then zoom the device canvas and prove three load-bearing claims:
//
//   1. Zoom changes the DISPLAY scale only — the native surface grows/shrinks
//      with the zoom factor while the page's layout viewport (device CSS px)
//      is byte-identical at every zoom level (browser_execute viewport report).
//   2. The agent's coordinate mapping is correct at every zoom level — a tap
//      dispatched at a known device coordinate lands on the same element with
//      the same clientX regardless of the visual zoom.
//   3. Zoom bounds clamp (0.5..3), reset on device-mode change to the target
//      profile's own persisted value, persist per profile to settings, and the
//      zoom indicator badge appears on zoom change and fades out after 2s.
//
// The real Ctrl+Scroll gesture path (OS-level wheel interception) is verified
// live with real pointer input; this suite drives the same emulator state
// through the programmatic set-device-zoom IPC (window.browserUseDesktop
// .setDeviceZoom), which is the exact state change the wheel handler applies.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-device-zoom-'));

const fixture = `data:text/html,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device zoom fixture</title>
<body style="margin:0;height:400vh;background:linear-gradient(#fff,#bbb);font:16px system-ui">
<button id="target" style="position:absolute;left:20px;top:120px;width:200px;height:80px">Tap me</button>
<div id="out" style="position:absolute;top:220px;left:20px">idle</div>
<script>
  globalThis.__events = [];
  const record = (event) => {
    globalThis.__events.push({
      type: event.type,
      pointerType: event.pointerType || null,
      x: event.clientX ?? (event.touches && event.touches[0] ? Math.round(event.touches[0].clientX) : null)
    });
  };
  for (const type of ['touchstart','touchend','pointerdown','click']) {
    window.addEventListener(type, record, { capture: true, passive: true });
  }
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('out').textContent = 'target-activated';
  });
</script>`)}`;

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

const checks = [];
function record(name, detail) {
  checks.push({ name, ...detail });
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  let window = null;
  {
    const deadline = Date.now() + 30_000;
    while (!window && Date.now() < deadline) {
      window = electronApp.windows().find((candidate) => candidate.url().endsWith('/desktop/renderer/index.html')) || null;
      if (!window) await delay(100);
    }
  }
  assert.ok(window, 'the desktop chrome window must appear');
  await window.waitForSelector('#settings-toggle');
  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  {
    const deadline = Date.now() + 30_000;
    while (!configuration.endpoint && Date.now() < deadline) {
      await delay(300);
      Object.assign(configuration, await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration()));
    }
  }
  assert.ok(configuration.endpoint, 'the desktop MCP endpoint must come up');

  const offer = await window.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const paired = await postJson(configuration.pairingEndpoint, { pairingCode: offer.pairingCode, host: { name: 'device-zoom-e2e', version: '1.0.0' } });
  const capability = paired.session.capability;
  const endpoint = configuration.endpoint;
  const call = (name, args) => callTool(endpoint, capability, name, args);

  const tabs = JSON.parse((await call('browser_get_tabs')).content[0].text);
  const tabId = tabs[0].id;
  await call('browser_bind_tab', { tabId });

  await loadFixture(electronApp, fixture);
  await delay(600);

  const metrics = async () => window.evaluate(() => window.browserUseDesktop.viewportMetrics());

  // setDeviceZoom (preload) resolves to the emulator state through the
  // browser-use:set-device-zoom IPC handler — the same state change the
  // Ctrl+Scroll wheel handler applies.
  // ---- 1. Entering a device profile starts at 100% zoom.
  const mobileState = JSON.parse((await call('browser_set_device_mode', { profileId: 'pixel-8', orientation: 'portrait' })).content[0].text);
  assert.equal(mobileState.mode, 'mobile');
  assert.equal(mobileState.zoom, 1, 'a freshly entered device profile must start at 100% zoom');
  const baseMetrics = await metrics();
  const fitScale = Math.min(1, baseMetrics.stage.width / 412, baseMetrics.stage.height / 915);
  assert.equal(baseMetrics.bounds.width, Math.floor(412 * fitScale), 'the unzoomed surface must be the fitted device width');
  record('baseline', { zoom: mobileState.zoom, bounds: baseMetrics.bounds, fitScale });

  // ---- 2. Zooming in scales the DISPLAY, not the layout viewport.
  await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(1.5));
  await waitForBounds(metrics, () => Math.floor(412 * fitScale * 1.5));
  const zoomedMetrics = await metrics();
  assert.equal(zoomedMetrics.device.zoom, 1.5, 'device state must report the zoom factor');
  assert.equal(zoomedMetrics.bounds.width, Math.floor(412 * fitScale * 1.5), `the native surface must be the display scale times the device width, got ${zoomedMetrics.bounds.width}`);
  assert.equal(zoomedMetrics.bounds.height, Math.floor(915 * fitScale * 1.5), 'the native surface must be the display scale times the device height');
  const pageReportZoomed = await readFixture(electronApp, () => ({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio }));
  assert.equal(pageReportZoomed.width, 412, 'the page layout viewport must be unchanged while zoomed');
  assert.equal(pageReportZoomed.dpr, 2.625, 'the emulated DPR must be unchanged while zoomed');

  // ---- 3. The agent's browser_execute viewport report is identical across
  // zoom levels (the agent mis-reads nothing when the owner zooms).
  const executeReport = async () => JSON.parse((await call('browser_execute', { script: 'return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio, scrollY: window.scrollY };' })).content[0].text).result;
  const reportAt150 = await executeReport();
  assert.deepEqual(reportAt150, { w: 412, h: 915, dpr: 2.625, scrollY: 0 }, `browser_execute must report the unzoomed viewport, got ${JSON.stringify(reportAt150)}`);
  record('viewport-report-identical', { report: reportAt150 });

  // ---- 4. Coordinate-correctness proof: a tap at a known device coordinate
  // lands on the same element, at the same client position, at every zoom.
  for (const zoom of [1, 1.5, 2.5]) {
    await window.evaluate((value) => window.browserUseDesktop.setDeviceZoom(value), zoom);
    await waitForBounds(metrics, () => Math.floor(412 * fitScale * zoom));
    await readFixture(electronApp, () => { document.getElementById('out').textContent = 'idle'; globalThis.__events = []; return true; });
    await call('browser_gesture', { gesture: 'tap', x: 120, y: 160 });
    const out = await waitForFixture(electronApp, () => document.getElementById('out').textContent, (value) => value === 'target-activated');
    assert.equal(out, 'target-activated', `the tap at device (120,160) must activate the target at zoom ${zoom}`);
    const events = await readFixture(electronApp, () => globalThis.__events || []);
    const touch = events.find((event) => event.type === 'touchstart');
    assert.ok(touch, `a touchstart must be recorded at zoom ${zoom}`);
    assert.equal(touch.x, 120, `the contact must land at device x=120 at zoom ${zoom}, got ${touch.x}`);
    const pointerEvents = events.filter((event) => event.pointerType);
    assert.ok(pointerEvents.length > 0 && pointerEvents.every((event) => event.pointerType === 'touch'), `every pointer event must be touch at zoom ${zoom}`);
    record(`tap-lands@${zoom}`, { out, contactX: touch.x });
  }

  // ---- 5. Bounds clamp at 50% and 300%.
  const high = await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(9));
  assert.equal(high.zoom, 3, 'zoom must clamp at 300%');
  await waitForBounds(metrics, () => Math.floor(412 * fitScale * 3));
  const low = await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(0.05));
  assert.equal(low.zoom, 0.5, 'zoom must clamp at 50%');
  await waitForBounds(metrics, () => Math.floor(412 * fitScale * 0.5));
  record('clamped', { high: high.zoom, low: low.zoom });

  // ---- 6. Device-mode change resets zoom to the target profile's value;
  // the previous profile keeps its own persisted zoom.
  await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(2));
  await waitForBounds(metrics, () => Math.floor(412 * fitScale * 2));
  const tabletState = JSON.parse((await call('browser_set_device_mode', { profileId: 'ipad-pro-11', orientation: 'portrait' })).content[0].text);
  assert.equal(tabletState.zoom, 1, 'a different profile must not inherit the previous profile zoom');
  const backState = JSON.parse((await call('browser_set_device_mode', { profileId: 'pixel-8', orientation: 'portrait' })).content[0].text);
  assert.equal(backState.zoom, 2, 'returning to the profile must restore its persisted zoom');
  record('reset-on-mode-change', { tablet: tabletState.zoom, backToPixel: backState.zoom });

  // ---- 7. Zoom persists per profile into settings (debounced write).
  await delay(1200);
  const settingsOnDisk = JSON.parse(fs.readFileSync(path.join(appDataDirectory, 'browser-use-settings.json'), 'utf8'));
  assert.equal(settingsOnDisk.deviceZoomByProfile['pixel-8'], 2, `the zoom must persist per profile, got ${JSON.stringify(settingsOnDisk.deviceZoomByProfile)}`);
  assert.ok(!('ipad-pro-11' in settingsOnDisk.deviceZoomByProfile) || settingsOnDisk.deviceZoomByProfile['ipad-pro-11'] !== 2, 'the tablet profile must keep its own zoom');
  record('persisted', { deviceZoomByProfile: settingsOnDisk.deviceZoomByProfile });

  // ---- 8. The zoom indicator badge shows on zoom change and fades away.
  await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(1.75));
  const badgeShown = await waitForBadge(electronApp, (view) => view.attached && view.bounds.width > 0);
  assert.ok(badgeShown, 'the zoom badge must attach with a nonzero surface while zooming');
  assert.equal(badgeShown.bounds.width, 92, 'the badge must be its design size while visible');
  const badgeHidden = await waitForBadge(electronApp, (view) => !view.attached || view.bounds.width === 0, 5000);
  assert.ok(badgeHidden, 'the zoom badge must detach (0x0) after its 2s fade');
  record('badge', { shown: badgeShown.bounds, hidden: badgeHidden });

  // ---- 9. Leaving device mode clears the zoom; zooming a desktop tab refuses.
  await call('browser_set_device_mode', { profileId: 'desktop' });
  const restored = JSON.parse((await call('browser_device_state')).content[0].text);
  assert.equal(restored.mode, 'desktop');
  assert.equal(restored.zoom, 1, 'a desktop tab must report 100% zoom');
  const refused = await window.evaluate(() => window.browserUseDesktop.setDeviceZoom(2).catch((error) => String(error?.message || error)));
  assert.match(String(refused), /mobile or tablet profile/i, 'zoom must refuse without an active device profile');
  record('desktop-refusal', { refused: String(refused).slice(0, 120) });

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await electronApp.close();
  await delay(250);
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

// ---- helpers (the tab view selection must tolerate the letterbox/badge views)

function pageViewSource() {
  return `
    (win) => {
      const views = win.getBrowserViews().slice().reverse();
      const isChromeUrl = (url) => url.includes('browser-use-letterbox') || url.includes('browser-use-zoom-badge') || url.endsWith('/overlay.html');
      return views.find((view) => { const url = String(view.webContents.getURL()); return url !== '' && !isChromeUrl(url); })
        || views.find((view) => !isChromeUrl(String(view.webContents.getURL())))
        || views[0];
    }
  `;
}

async function loadFixture(app, url) {
  await app.evaluate(async ({ BrowserWindow }, { target, finder }) => {
    const win = BrowserWindow.getAllWindows().find((w) => String(w.webContents.getURL()).endsWith('/desktop/renderer/index.html')) || BrowserWindow.getAllWindows()[0];
    const view = eval(finder)(win);
    await view.webContents.loadURL(target);
  }, { target: url, finder: pageViewSource() });
}

function readFixture(app, fn) {
  return app.evaluate(async ({ BrowserWindow }, { source, finder }) => {
    const win = BrowserWindow.getAllWindows().find((w) => String(w.webContents.getURL()).endsWith('/desktop/renderer/index.html')) || BrowserWindow.getAllWindows()[0];
    const view = eval(finder)(win);
    return view.webContents.executeJavaScript(`(${source})()`, true);
  }, { source: fn.toString(), finder: pageViewSource() });
}

async function waitForFixture(app, fn, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let value = await readFixture(app, fn);
  while (Date.now() < deadline && !predicate(value)) {
    await delay(100);
    value = await readFixture(app, fn);
  }
  return value;
}

// The zoom badge is a chrome BrowserView (data: URL browser-use-zoom-badge).
function badgeProbeSource() {
  return `
    (win) => {
      const view = win.getBrowserViews().find((candidate) => String(candidate.webContents.getURL()).includes('browser-use-zoom-badge'));
      if (!view) return { attached: false, bounds: null };
      return { attached: true, bounds: view.getBounds() };
    }
  `;
}

async function waitForBadge(app, predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let value = null;
  while (Date.now() < deadline) {
    value = await app.evaluate(async ({ BrowserWindow }, { source }) => {
      const win = BrowserWindow.getAllWindows().find((w) => String(w.webContents.getURL()).endsWith('/desktop/renderer/index.html')) || BrowserWindow.getAllWindows()[0];
      return eval(source)(win);
    }, { source: badgeProbeSource() });
    if (predicate(value)) return value;
    await delay(100);
  }
  return value;
}

async function waitForBounds(metrics, expectedWidth, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let current = await metrics();
  while (Date.now() < deadline && current.bounds?.width !== expectedWidth()) {
    await delay(100);
    current = await metrics();
  }
  return current;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  assert.equal(response.status, 200, `POST ${url} failed: ${text}`);
  return JSON.parse(text);
}

async function rpc(endpoint, capability, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${capability}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params })
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { status: response.status, body, error: body?.error, result: body?.result };
}

async function callTool(endpoint, capability, name, args = {}) {
  const response = await rpc(endpoint, capability, 'tools/call', { name, arguments: args });
  assert.ok(!response.error, `${name} failed: ${JSON.stringify(response.error || response.body)}`);
  return response.result;
}
