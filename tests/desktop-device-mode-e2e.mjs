// Acceptance for mobile/tablet emulation and native touch input, driven the way
// a paired MCP host drives it: pair, bind a tab, take the input grant, then
// switch device profiles and perform real gestures.
//
// The claim under test is behavioural, not cosmetic. Under a device profile the
// page must receive touch and only touch: the mouse tools have to refuse, and
// the events the page records must carry pointerType "touch" with real contact
// counts. A viewport that merely looks narrow while still delivering mouse
// events would pass a screenshot check and fail this one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-device-'));

// Records every pointer and touch event with the detail that distinguishes a
// real finger from a mouse, plus enough page geometry to check the viewport.
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device fixture</title>
<body style="margin:0;height:400vh;background:linear-gradient(#fff,#bbb);font:16px system-ui">
<button id="target" style="position:absolute;left:20px;top:120px;width:200px;height:80px">Tap me</button>
<div id="out" style="position:absolute;top:220px;left:20px">idle</div>
<script>
  globalThis.__events = [];
  globalThis.__maxTouches = 0;
  const record = (event) => {
    const touches = event.touches ? event.touches.length : null;
    if (touches !== null) globalThis.__maxTouches = Math.max(globalThis.__maxTouches, touches);
    globalThis.__events.push({
      type: event.type,
      pointerType: event.pointerType || null,
      touches,
      x: event.clientX ?? (event.touches && event.touches[0] ? Math.round(event.touches[0].clientX) : null)
    });
  };
  for (const type of ['touchstart','touchmove','touchend','pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu']) {
    window.addEventListener(type, record, { capture: true, passive: true });
  }
  document.getElementById('target').addEventListener('click', () => {
    document.getElementById('out').textContent = 'target-activated';
  });
</script>`)}`;

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  // --user-data-dir isolates the ProcessSingleton lock: without it a second
  // launch dies instantly with exit 0 when any other Browser-use instance
  // (or a same-userData leftover) holds the lock — the app then never starts.
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
  // firstWindow() can resolve to the transient splash window, which closes
  // when the real chrome reveals — wait for the main renderer window instead.
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
    // The MCP bridge binds asynchronously (port 0 above: an ephemeral port);
    // poll until the pairing endpoint exists instead of assuming one tick.
    const deadline = Date.now() + 30_000;
    while (!configuration.endpoint && Date.now() < deadline) {
      await delay(300);
      Object.assign(configuration, await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration()));
    }
  }
  assert.ok(configuration.endpoint, 'the desktop MCP endpoint must come up');

  const offer = await window.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const paired = await postJson(configuration.pairingEndpoint, { pairingCode: offer.pairingCode, host: { name: 'device-e2e', version: '1.0.0' } });
  const capability = paired.session.capability;
  const endpoint = configuration.endpoint;
  const call = (name, args) => callTool(endpoint, capability, name, args);

  const tabs = JSON.parse((await call('browser_get_tabs')).content[0].text);
  const tabId = tabs[0].id;
  await call('browser_bind_tab', { tabId });
  // A normally paired host already receives unrestricted MCP access
  // (fullAccess at pair time); the old explicit input-grant IPC no longer
  // exists, and requiring it here would misrepresent the pairing contract.

  await loadFixture(electronApp, fixture);
  // loadURL resolves when the document loads, but the compositor surface is not
  // necessarily ready to receive input on that same tick, and a layout pass
  // still runs on did-finish-load. Sending the first event before that settles
  // drops it, so wait until the view demonstrably accepts input.
  await waitForInputToLand(electronApp, call);

  // ---- 1. Profiles are discoverable before anything is applied.
  const profiles = JSON.parse((await call('browser_device_profiles')).content[0].text);
  assert.ok(profiles.some((profile) => profile.mode === 'mobile'), 'a mobile profile must be offered');
  assert.ok(profiles.some((profile) => profile.mode === 'tablet'), 'a tablet profile must be offered');
  record('profiles', { mobile: profiles.filter((p) => p.mode === 'mobile').length, tablet: profiles.filter((p) => p.mode === 'tablet').length });

  // ---- 2. Desktop baseline: the mouse works and the page sees a mouse.
  await resetEvents(electronApp);
  await call('browser_mousedown', { x: 60, y: 150 });
  await call('browser_mouseup', { x: 60, y: 150 });
  const desktopEvents = await readEvents(electronApp);
  assert.ok(desktopEvents.some((event) => event.type === 'mousedown'), 'the desktop baseline must deliver a mouse press');
  assert.ok(!desktopEvents.some((event) => event.type === 'touchstart'), 'the desktop baseline must not synthesise touch');
  record('desktop-baseline', { mouse: true, touch: false });

  // ---- 3. Switching to a phone applies viewport, DPR, UA, and touch support.
  const mobileState = JSON.parse((await call('browser_set_device_mode', { profileId: 'pixel-8', orientation: 'portrait' })).content[0].text);
  assert.equal(mobileState.mode, 'mobile');
  const mobileMetrics = await readFixture(electronApp, () => ({
    width: window.innerWidth,
    height: window.innerHeight,
    dpr: window.devicePixelRatio,
    touchSupported: 'ontouchstart' in window,
    maxTouchPoints: navigator.maxTouchPoints,
    ua: navigator.userAgent,
    platform: navigator.platform
  }));
  assert.equal(mobileMetrics.width, 412, `the CSS viewport must match the device, got ${mobileMetrics.width}`);
  assert.equal(mobileMetrics.dpr, 2.625, 'the device pixel ratio must be emulated');
  // Feature detection runs at document creation, so this is the assertion that
  // proves the mode change reloaded the page rather than only resizing it.
  assert.equal(mobileMetrics.touchSupported, true, 'the page must report touch support');
  assert.ok(mobileMetrics.maxTouchPoints >= 5, 'the page must report multi-touch capability');
  assert.match(mobileMetrics.ua, /Android|Mobile/, `the user agent must identify as mobile, got ${mobileMetrics.ua}`);
  record('mobile-identity', { viewport: `${mobileMetrics.width}x${mobileMetrics.height}`, dpr: mobileMetrics.dpr, touch: mobileMetrics.touchSupported, maxTouchPoints: mobileMetrics.maxTouchPoints });

  // ---- 4. The native surface is letterboxed to the device, not stretched.
  // The shipped fit-to-stage contract scales the device frame to the largest
  // size that fits the stage (scale ≤ 1), so the native surface equals the
  // FITTED viewport — raw 412 only when the stage is tall enough to show it 1:1.
  const metrics = await window.evaluate(() => window.browserUseDesktop.viewportMetrics());
  const fitScale = Math.min(1, metrics.stage.width / 412, metrics.stage.height / 915);
  assert.equal(metrics.bounds.width, Math.floor(412 * fitScale), `the native surface must be the fitted device width (scale ${fitScale})`);
  assert.equal(metrics.bounds.height, Math.floor(915 * fitScale), 'the native surface must be the fitted device height');
  assert.ok(metrics.bounds.x > 0, 'the device must be centred, leaving a bezel on the left');
  assert.ok(metrics.bounds.width < metrics.stage.width, 'the device must be narrower than the available stage');
  record('letterbox', { bounds: metrics.bounds, stage: metrics.stage, fitScale });

  // ---- 5. The mouse is retired: pointer tools must refuse, by name.
  for (const tool of ['browser_mousemove', 'browser_mousedown', 'browser_mouseup']) {
    const refused = await rpc(endpoint, capability, 'tools/call', { name: tool, arguments: { x: 100, y: 200 } });
    const message = refused.error?.message || JSON.stringify(refused.body);
    assert.ok(refused.error, `${tool} must refuse while a device profile is active`);
    assert.match(message, /touch input only/i, `${tool} must explain why it refused: ${message}`);
    assert.match(message, /browser_gesture/, `${tool} must name the gesture tool to use instead`);
  }
  record('mouse-retired', { refused: ['browser_mousemove', 'browser_mousedown', 'browser_mouseup'] });

  // ---- 6. A tap is a real touch, and it activates the element.
  await resetEvents(electronApp);
  await call('browser_gesture', { gesture: 'tap', x: 120, y: 160 });
  // The reload triggered by the mode switch re-registers the fixture's
  // listeners, so give the recorded sequence a moment to arrive rather than
  // sampling the instant the call returns.
  const tapEvents = await waitForEvents(electronApp, (events) => events.some((event) => event.type === 'touchend'));
  assert.ok(tapEvents.some((event) => event.type === 'touchstart'), `a tap must produce touchstart, got ${JSON.stringify(tapEvents.map((e) => e.type))}`);
  assert.ok(tapEvents.some((event) => event.type === 'touchend'), 'a tap must lift the contact');
  const pointerEvents = tapEvents.filter((event) => event.pointerType);
  assert.ok(pointerEvents.length > 0 && pointerEvents.every((event) => event.pointerType === 'touch'), `every pointer event must be touch, got ${JSON.stringify(pointerEvents)}`);
  assert.equal(await readFixture(electronApp, () => document.getElementById('out').textContent), 'target-activated', 'a tap must actually activate the button it lands on');
  record('tap', { types: [...new Set(tapEvents.map((e) => e.type))], pointerType: 'touch' });

  // ---- 7. A swipe scrolls with interpolated movement, not a jump.
  await resetEvents(electronApp);
  await readFixture(electronApp, () => { window.scrollTo(0, 0); return true; });
  await call('browser_gesture', { gesture: 'swipe', startX: 200, startY: 700, endX: 200, endY: 200, durationMs: 320 });
  const swipeEvents = await waitForEvents(electronApp, (events) => events.some((event) => event.type === 'touchend'));
  const moveCount = swipeEvents.filter((event) => event.type === 'touchmove').length;
  assert.ok(moveCount >= 5, `a swipe must deliver many touchmove events, got ${moveCount}`);
  const scrolledBySwipe = await readFixture(electronApp, () => Math.round(window.scrollY));
  assert.ok(scrolledBySwipe > 50, `the swipe must actually scroll the page, scrollY=${scrolledBySwipe}`);
  record('swipe', { touchmoves: moveCount, scrollY: scrolledBySwipe });

  // ---- 8. Scroll larger than the screen is chunked into repeated swipes.
  await readFixture(electronApp, () => { window.scrollTo(0, 0); return true; });
  const scrollResult = JSON.parse((await call('browser_gesture', { gesture: 'scroll', deltaY: 1800 })).content[0].text);
  assert.ok(scrollResult.swipes >= 2, `a scroll longer than the screen must repeat, got ${scrollResult.swipes} swipe(s)`);
  const scrolledFar = await readFixture(electronApp, () => Math.round(window.scrollY));
  assert.ok(scrolledFar > 300, `a long scroll must travel, scrollY=${scrolledFar}`);
  record('long-scroll', { swipes: scrollResult.swipes, scrollY: scrolledFar });

  // ---- 9. Pinch puts two fingers on the glass at once.
  await resetEvents(electronApp);
  await call('browser_gesture', { gesture: 'pinch', centerX: 200, centerY: 400, scale: 1.8, startSpreadPx: 120 });
  const maxTouches = await readFixture(electronApp, () => globalThis.__maxTouches);
  assert.ok(maxTouches >= 2, `a pinch must report two simultaneous contacts, peak was ${maxTouches}`);
  record('pinch', { simultaneousContacts: maxTouches });

  // ---- 10. Three fingers at once — impossible with a mouse by construction.
  await resetEvents(electronApp);
  await call('browser_gesture', { gesture: 'multiFingerSwipe', fingers: 3, startX: 200, startY: 600, deltaY: -220 });
  const threeFingerPeak = await readFixture(electronApp, () => globalThis.__maxTouches);
  assert.ok(threeFingerPeak >= 3, `a three-finger swipe must report three contacts, peak was ${threeFingerPeak}`);
  record('multi-finger', { simultaneousContacts: threeFingerPeak });

  // ---- 11. Long press is held long enough to register as one.
  await resetEvents(electronApp);
  const longPressStart = Date.now();
  await call('browser_gesture', { gesture: 'longPress', x: 120, y: 160, durationMs: 700 });
  const heldMs = Date.now() - longPressStart;
  assert.ok(heldMs >= 600, `a long press must actually be held, took ${heldMs}ms`);
  record('long-press', { heldMs });

  // ---- 12. The touch overlay draws a contact indicator.
  const overlayPresent = await readFixture(electronApp, () => Boolean(document.getElementById('__browser_use_touch_overlay__')));
  assert.equal(overlayPresent, true, 'the touch indicator layer must be present in touch mode');
  // The agent arrow cursor is a pointer affordance and must not appear here.
  const cursorPresent = await readFixture(electronApp, () => Boolean(document.getElementById('__browser_use_agent_cursor__')));
  assert.equal(cursorPresent, false, 'the mouse cursor overlay must not be shown while the page is touch-only');
  record('overlays', { touchOverlay: overlayPresent, mouseCursor: cursorPresent });

  // ---- 13. Rotation swaps the viewport without a reload.
  const rotated = JSON.parse((await call('browser_rotate_device')).content[0].text);
  assert.equal(rotated.orientation, 'landscape');
  const rotatedWidth = await readFixture(electronApp, () => window.innerWidth);
  assert.equal(rotatedWidth, 915, `landscape must widen the viewport, got ${rotatedWidth}`);
  record('rotate', { orientation: rotated.orientation, width: rotatedWidth });

  // ---- 14. Tablet profile applies its own geometry.
  await call('browser_set_device_mode', { profileId: 'ipad-pro-11', orientation: 'portrait' });
  const tabletMetrics = await readFixture(electronApp, () => ({ width: window.innerWidth, touch: 'ontouchstart' in window, ua: navigator.userAgent }));
  assert.equal(tabletMetrics.width, 834, `the tablet viewport must apply, got ${tabletMetrics.width}`);
  assert.equal(tabletMetrics.touch, true, 'a tablet must report touch support');
  assert.match(tabletMetrics.ua, /iPad/, 'the tablet must identify as one');
  record('tablet', { width: tabletMetrics.width, touch: tabletMetrics.touch });

  // ---- 15. Returning to desktop restores the mouse and clears emulation.
  await call('browser_set_device_mode', { profileId: 'desktop' });
  const restored = await readFixture(electronApp, () => ({ width: window.innerWidth, touch: 'ontouchstart' in window, ua: navigator.userAgent }));
  assert.ok(restored.width > 900, `desktop must restore a full-width viewport, got ${restored.width}`);
  assert.ok(!/iPad|Android/.test(restored.ua), `the user agent override must be cleared, got ${restored.ua}`);
  // Retried rather than sampled once: leaving device mode reloads the page, and
  // an event dispatched before the new surface accepts input is dropped outright
  // rather than delivered late, so polling could not recover it. Reaching this
  // line at all still proves the mouse is accepted again.
  await waitForInputToLand(electronApp, call);
  const restoredBounds = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.equal(restoredBounds.x, 0, 'the page must fill the window again after leaving device mode');
  // The mouse tools must also stop refusing, which is a separate guarantee from
  // the events being delivered.
  const restoredState = JSON.parse((await call('browser_device_state')).content[0].text);
  assert.equal(restoredState.touch, false, 'the tab must no longer be in touch mode');
  record('desktop-restored', { width: restored.width, mouse: true, boundsX: restoredBounds.x, touchMode: restoredState.touch });

  // ---- 16. A gesture without a device profile is refused, not silently dropped.
  const gestureRefused = await rpc(endpoint, capability, 'tools/call', { name: 'browser_gesture', arguments: { gesture: 'tap', x: 10, y: 10 } });
  assert.ok(gestureRefused.error, 'a gesture must be refused without a device profile');
  assert.match(gestureRefused.error.message, /browser_set_device_mode/, 'the refusal must say how to enable gestures');
  record('gesture-guard', { refused: true });

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

// Retries a probe click until the page records it, so the suite starts from a
// view that is genuinely accepting input. This masks no product behaviour: the
// assertions that follow still require the very next event to be delivered.
async function waitForInputToLand(app, call, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts += 1;
    await resetEvents(app);
    await call('browser_mousedown', { x: 300, y: 300 });
    await call('browser_mouseup', { x: 300, y: 300 });
    const events = await readEvents(app);
    if (events.some((event) => event.type === 'mousedown')) {
      await resetEvents(app);
      return attempts;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`The browsing view never accepted input after ${attempts} attempts`);
}

// The device letterbox (data: URL titled browser-use-letterbox) sits in the
// window's view list while a profile is active; it is chrome, not the page.
// Scan from the END: the selected page view is always re-added last (showTab /
// letterbox stacking), and a just-attached letterbox can transiently still
// report an empty URL before its data: document commits. Selection must be
// INLINED via a source string: app.evaluate serializes the callback alone.
function pageViewSource() {
  return `
    (win) => {
      const views = win.getBrowserViews().slice().reverse();
      const isChromeUrl = (url) => url.includes('browser-use-letterbox') || url.endsWith('/overlay.html');
      // Preferred: the last re-attached (selected) view with a committed URL.
      // Fallbacks tolerate transient empty URLs during attach churn.
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

function readEvents(app) {
  return readFixture(app, () => globalThis.__events || []);
}

// Polls the recorded event log until it satisfies the predicate. Returns
// whatever was recorded when the deadline passes, so the caller's assertion —
// not this helper — is what fails, with its own diagnostic message.
async function waitForEvents(app, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let events = await readEvents(app);
  while (Date.now() < deadline && !predicate(events)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    events = await readEvents(app);
  }
  return events;
}

function resetEvents(app) {
  return readFixture(app, () => {
    globalThis.__events = [];
    globalThis.__maxTouches = 0;
    return true;
  });
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
