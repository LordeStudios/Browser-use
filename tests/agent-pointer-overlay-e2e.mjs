import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-pointer-overlay-'));
const evidenceDirectory = path.join(root, 'output', 'playwright');
const packagedDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
const launchOptions = packagedDirectory
  ? { executablePath: path.join(packagedDirectory, 'Browser-use.exe'), cwd: packagedDirectory }
  : { executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: ['.'], cwd: root };

if (packagedDirectory) {
  assert.ok(fs.existsSync(launchOptions.executablePath), `packaged executable is missing: ${launchOptions.executablePath}`);
}

const fixture = `data:text/html,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<title>Agent pointer fixture</title>
<body style="margin:0;height:1600px;background:#f5f7fb">
  <button id="target" style="position:absolute;left:100px;top:150px;width:120px;height:40px">Target</button>
  <script>
    globalThis.__pointerClicks = [];
    globalThis.__pointerDowns = [];
    globalThis.__pointerMoves = [];
    window.addEventListener('mousemove', (event) => {
      globalThis.__pointerMoves.push({ x: event.clientX, y: event.clientY, at: Date.now(), trusted: event.isTrusted });
    });
    document.getElementById('target').addEventListener('mousedown', (event) => {
      globalThis.__pointerDowns.push({ x: event.clientX, y: event.clientY, at: Date.now(), trusted: event.isTrusted });
    });
    document.getElementById('target').addEventListener('click', (event) => {
      globalThis.__pointerClicks.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted });
    });
  </script>
</body>`)}`;

const electronApp = await electron.launch({
  ...launchOptions,
  args: [...(launchOptions.args || []), `--user-data-dir=${appDataDirectory}`],
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const shell = await appWindow(electronApp, '/desktop/renderer/index.html');
  let pointer = await appWindow(electronApp, '/desktop/renderer/agent-pointer.html');
  console.log('pointer-e2e: windows ready');
  await shell.waitForSelector('#settings-toggle');
  await pointer.waitForSelector('#browser-use-agent-pointer');

  const initial = await pointerSnapshot(pointer);
  assert.equal(initial.opacity, 0, 'the permanently mounted pointer starts transparent');
  assert.ok(initial.instanceId, 'the pointer node has a stable lifetime identity');

  const configuration = await shell.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  const offer = await shell.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const paired = await postJson(configuration.pairingEndpoint, {
    pairingCode: offer.pairingCode,
    host: { name: 'agent-pointer-overlay-e2e', version: '1.0.0' }
  });
  const capability = paired.session.capability;
  const tabs = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_get_tabs')).content[0].text);
  await callTool(configuration.endpoint, capability, 'browser_bind_tab', { tabId: tabs[0].id });
  await loadFixture(electronApp, fixture);
  const initialGeometry = await pointerGeometry(electronApp);
  assertPointerGeometry(initialGeometry, 'initial viewport');
  console.log('pointer-e2e: paired fixture ready');

  await pointer.evaluate(() => {
    const original = window.setTimeout;
    const scheduled = [];
    window.__agentPointerOriginalSetTimeout = original;
    window.__agentPointerScheduledTimers = scheduled;
    window.setTimeout = (callback, delay, ...args) => {
      scheduled.push(Number(delay));
      return original.call(window, callback, Number(delay) === 60_000 ? 25 : delay, ...args);
    };
  });
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 30, y: 40 });
  const firstPlacement = await pointerSnapshot(pointer);
  assert.equal(firstPlacement.opacity, 1, 'activity makes the pointer fully opaque');
  assertPoint(firstPlacement, { x: 30, y: 40 }, 'first placement');
  console.log('pointer-e2e: first placement ready');

  const fadeSamples = [];
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    fadeSamples.push({ at: Date.now(), opacity: sample.opacity, visible: sample.visible });
    return sample.opacity <= 0.001;
  }, 1_500, () => `pointer did not fade after the accelerated one-minute idle contract probe: ${JSON.stringify(fadeSamples)}`);
  const faded = await pointerSnapshot(pointer);
  const idleTimerDelays = await pointer.evaluate(() => window.__agentPointerScheduledTimers || []);
  console.log('pointer-e2e: first fade ready');
  assert.ok(idleTimerDelays.includes(60_000), `pointer must retain the final action for one minute: ${JSON.stringify(idleTimerDelays)}`);
  assert.equal(faded.instanceId, initial.instanceId, 'fading must not replace the pointer node');
  await pointer.evaluate(() => {
    window.setTimeout = window.__agentPointerOriginalSetTimeout;
    delete window.__agentPointerOriginalSetTimeout;
    delete window.__agentPointerScheduledTimers;
  });

  const longMove = callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 620, y: 420 });
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    return sample.targetX === 620 && sample.targetY === 420 && sample.opacity === 1;
  }, 1_000, 'long movement never reached the pointer renderer');
  const samples = [];
  for (let index = 0; index < 8; index += 1) {
    await delay(35);
    samples.push(await pointerSnapshot(pointer));
  }
  const longMoveResult = parseToolResult(await longMove);
  assert.equal(longMoveResult.input, 'electron-native', `long movement was interrupted: ${JSON.stringify(longMoveResult)}`);
  assert.equal(longMoveResult.pointer?.completed, true, `long movement did not receive a settled visual ACK: ${JSON.stringify(longMoveResult)}`);
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    return Math.abs(sample.x - 620) <= 1 && Math.abs(sample.y - 420) <= 1;
  }, 500, 'long movement ACK preceded its exact rendered destination');
  const settled = await pointerSnapshot(pointer);
  const nativeMoves = await readSelectedPage(electronApp, () => globalThis.__pointerMoves);
  const finalNativeMove = nativeMoves.at(-1);
  assert.ok(samples.every((sample) => sample.opacity === 1), 'the pointer stays fully visible throughout active movement');
  assert.ok(new Set(samples.map((sample) => `${Math.round(sample.x)},${Math.round(sample.y)}`)).size >= 4,
    `a long move must paint multiple distinct frames: ${JSON.stringify(samples.map(({ x, y }) => ({ x, y })))}`);
  assert.ok(monotonic(samples.map((sample) => sample.x)), 'movement toward the destination must not jump backwards');
  assertPoint(settled, { x: 620, y: 420 }, 'long move destination');
  assert.deepEqual({ x: finalNativeMove.x, y: finalNativeMove.y, trusted: finalNativeMove.trusted }, { x: 620, y: 420, trusted: true });
  assert.ok(settled.paintConfirmedAt <= finalNativeMove.at,
    `native movement must not lead the pointer's painted destination: ${JSON.stringify({ settled, finalNativeMove })}`);
  console.log('pointer-e2e: long move ready');

  const supersededMove = callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 70, y: 500 });
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    return sample.targetX === 70 && sample.targetY === 500;
  }, 1_000, 'superseded movement never reached the pointer renderer');
  await delay(65);
  const interruptedAt = await pointerSnapshot(pointer);
  const winningMove = callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 460, y: 90 });
  await Promise.all([supersededMove, winningMove]);
  const afterInterrupt = await pointerSnapshot(pointer);
  assert.equal(afterInterrupt.sequence > interruptedAt.sequence, true, 'a replacement move must own a newer motion sequence');
  assertPoint(afterInterrupt, { x: 460, y: 90 }, 'interrupted move destination');
  await delay(400);
  assertPoint(await pointerSnapshot(pointer), { x: 460, y: 90 }, 'stale motion must not return after its old deadline');
  console.log('pointer-e2e: interruption ready');

  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 160, y: 170 });
  const beforeClick = await pointerSnapshot(pointer);
  await callTool(configuration.endpoint, capability, 'browser_mousedown', { x: 160, y: 170 });
  const duringClick = await pointerSnapshot(pointer);
  assert.ok(duringClick.tipAnimations + duringClick.contactAnimations > 0, 'click feedback must animate beyond its painted acknowledgement');
  await callTool(configuration.endpoint, capability, 'browser_mouseup', { x: 160, y: 170 });
  const clicks = await readSelectedPage(electronApp, () => globalThis.__pointerClicks);
  const downs = await readSelectedPage(electronApp, () => globalThis.__pointerDowns);
  assert.equal(clicks.length, 1, 'the native click reaches the real page exactly once');
  assert.equal(clicks[0].trusted, true, 'the page receives a trusted native click');
  assert.deepEqual({ x: clicks[0].x, y: clicks[0].y }, { x: 160, y: 170 });
  assert.equal(duringClick.clickCount, beforeClick.clickCount + 1, 'one down edge starts exactly one click animation');
  assert.deepEqual({ x: duringClick.clickX, y: duringClick.clickY }, { x: 160, y: 170 }, 'click feedback originates at the pointer tip');
  assertPoint(duringClick, { x: 160, y: 170 }, 'pointer at click');
  assert.equal(downs.length, 1, 'the page receives exactly one native mouse-down');
  assert.equal(downs[0].trusted, true, 'the page mouse-down is trusted');
  assert.ok(duringClick.clickStartedAt <= downs[0].at, `click feedback must begin before native mouse-down: ${JSON.stringify({ duringClick, down: downs[0] })}`);
  assert.ok(duringClick.paintConfirmedAt <= downs[0].at, `native mouse-down must follow painted click feedback: ${JSON.stringify({ duringClick, down: downs[0] })}`);
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  await pointer.screenshot({ path: path.join(evidenceDirectory, 'agent-pointer-click.png'), omitBackground: true });
  console.log('pointer-e2e: screenshot ready');
  await shell.locator('#settings-toggle').click();
  await shell.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
  await waitFor(async () => {
    const snapshot = await pointerSnapshot(pointer);
    return snapshot.opacity === 0 && snapshot.tipAnimations === 0 && snapshot.contactAnimations === 0;
  }, 1_000, 'opening an app overlay did not hide and clear click feedback');
  await shell.locator('[data-close="settings"]').click();
  await shell.waitForFunction(() => document.querySelector('#settings-panel').hidden);
  console.log('pointer-e2e: click ready');

  const pointerIdentity = await pointerRendererIdentity(electronApp);
  await readSelectedPage(electronApp, () => {
    document.documentElement.innerHTML = '<head><title>Replaced</title></head><body><main>Page DOM replaced</main></body>';
    return true;
  });
  await loadFixture(electronApp, `data:text/html,${encodeURIComponent('<!doctype html><title>Second document</title><main>Second document</main>')}`);
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 280, y: 210 });
  const afterNavigation = await pointerSnapshot(pointer);
  assert.equal(afterNavigation.instanceId, initial.instanceId, 'navigation must not recreate the mounted pointer node');
  assert.equal(await pointerRendererIdentity(electronApp), pointerIdentity, 'navigation must not recreate the pointer renderer');
  assertPoint(afterNavigation, { x: 280, y: 210 }, 'post-navigation movement');
  const injectedNodes = await readSelectedPage(electronApp, () => Array.from(document.querySelectorAll('[id^="__browser_use_"]')).map((node) => node.id));
  assert.deepEqual(injectedNodes, [], 'pointer visualization must never mutate the controlled page');
  console.log('pointer-e2e: navigation ready');

  const hiddenMove = callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 650, y: 400 });
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    return sample.targetX === 650 && sample.targetY === 400;
  }, 1_000, 'modal-interruption movement never reached the pointer renderer');
  await delay(35);
  await shell.locator('#settings-toggle').click();
  await shell.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
  const hiddenMoveResult = parseToolResult(await hiddenMove);
  assert.equal(hiddenMoveResult.input, 'interrupted', 'covering the page must cancel pending pointer input instead of dispatching invisibly');
  assert.equal((await pointerSnapshot(pointer)).opacity, 0, 'covering the page hides the app pointer');
  await shell.locator('[data-close="settings"]').click();
  await shell.waitForFunction(() => document.querySelector('#settings-panel').hidden);
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 300, y: 230 });
  assertPoint(await pointerSnapshot(pointer), { x: 300, y: 230 }, 'movement after closing modal overlay');

  const beforeDrawer = await pointerGeometry(electronApp);
  const oldRightEdge = Math.max(40, beforeDrawer.actual.width - 30);
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: oldRightEdge, y: 230 });
  assertPoint(await pointerSnapshot(pointer), { x: oldRightEdge, y: 230 }, 'pointer parked near old right edge');
  const shrinkDestination = { x: 800, y: 230 };
  const shrinkingMove = callTool(configuration.endpoint, capability, 'browser_mousemove', shrinkDestination);
  await waitFor(async () => {
    const snapshot = await pointerSnapshot(pointer);
    return snapshot.targetX === shrinkDestination.x && snapshot.targetY === shrinkDestination.y && snapshot.x > shrinkDestination.x + 80;
  }, 1_000, 'viewport-shrink movement never began from the old far edge');
  // Invoke the real drawer handler immediately so the viewport changes while
  // the pointer is still outside the new, narrower surface.
  await shell.evaluate(() => document.getElementById('agent-toggle').click());
  await shell.waitForFunction(() => !document.querySelector('#agent-panel').hidden);
  await waitFor(async () => {
    const geometry = await pointerGeometry(electronApp);
    return geometry.actual.width === geometry.expected.width && geometry.actual.width < beforeDrawer.actual.width;
  }, 1_500, 'pointer surface did not track the resized page viewport after opening AI chat');
  const drawerGeometry = await pointerGeometry(electronApp);
  assertPointerGeometry(drawerGeometry, 'AI drawer viewport');
  const clampedAfterDrawer = await pointerSnapshot(pointer);
  assert.ok(clampedAfterDrawer.x <= drawerGeometry.actual.width - 23,
    `mid-motion viewport shrink must keep the pointer visibly inside the new surface: ${JSON.stringify({ clampedAfterDrawer, drawerGeometry })}`);
  assert.equal(clampedAfterDrawer.opacity, 1, 'viewport shrink must not lose an active pointer');
  const shrinkingMoveResult = parseToolResult(await shrinkingMove);
  assert.equal(shrinkingMoveResult.input, 'electron-native', `a destination that fits the resized viewport must complete: ${JSON.stringify(shrinkingMoveResult)}`);
  assertPoint(await pointerSnapshot(pointer), shrinkDestination, 'resized-viewport movement destination');
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 220, y: 190 });
  assertPoint(await pointerSnapshot(pointer), { x: 220, y: 190 }, 'movement in AI drawer viewport');
  await shell.locator('[data-close="agent"]').click();
  await shell.waitForFunction(() => document.querySelector('#agent-panel').hidden);
  await waitFor(async () => {
    const geometry = await pointerGeometry(electronApp);
    return geometry.actual.width === geometry.expected.width && geometry.actual.width === beforeDrawer.actual.width;
  }, 1_500, 'pointer surface did not restore its full page viewport after closing AI chat');

  const minimizedMove = callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 610, y: 360 });
  await waitFor(async () => {
    const sample = await pointerSnapshot(pointer);
    return sample.targetX === 610 && sample.targetY === 360;
  }, 1_000, 'minimize-interruption movement never reached the pointer renderer');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'))?.minimize();
  });
  assert.equal(parseToolResult(await minimizedMove).input, 'interrupted', 'minimizing must cancel pending visible pointer input');
  await waitFor(async () => !(await pointerGeometry(electronApp)).pointerVisible, 1_000, 'pointer child stayed visible while the app was minimized');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const shellWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    shellWindow?.restore();
    shellWindow?.show();
  });
  await waitFor(async () => {
    const geometry = await pointerGeometry(electronApp);
    return geometry.pointerVisible && geometry.actual.width === geometry.expected.width;
  }, 2_000, 'pointer child did not recover with the restored app');
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 340, y: 250 });
  assertPoint(await pointerSnapshot(pointer), { x: 340, y: 250 }, 'movement after app restore');

  await delay(1_200);
  const retainedAfterNavigation = await pointerSnapshot(pointer);
  assert.equal(retainedAfterNavigation.opacity, 1, 'the pointer must remain visible for the configured one-minute idle hold');
  assert.equal(retainedAfterNavigation.instanceId, initial.instanceId, 'idle hold keeps the same mounted node');

  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 390, y: 290 });
  assert.equal((await pointerSnapshot(pointer)).opacity, 1, 'pointer is visibly active before the forced crash');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const pointerWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/agent-pointer.html'));
    if (!pointerWindow) throw new Error('Agent pointer window is unavailable');
    globalThis.__pointerCrashEvidence = { oldContentsId: pointerWindow.webContents.id, received: false, hidden: false, destroyed: false };
    // Observe the failed instance after the production handler hides it. Polling
    // whichever child currently exists can miss the hide and inspect its already
    // recovered replacement instead.
    pointerWindow.webContents.once('render-process-gone', () => {
      globalThis.__pointerCrashEvidence.received = true;
      globalThis.__pointerCrashEvidence.hidden = pointerWindow.isDestroyed() || !pointerWindow.isVisible();
    });
    pointerWindow.once('closed', () => { globalThis.__pointerCrashEvidence.destroyed = true; });
    setTimeout(() => {
      if (!pointerWindow.isDestroyed() && !pointerWindow.webContents.isDestroyed()) pointerWindow.webContents.forcefullyCrashRenderer();
    }, 25);
  });
  await waitFor(async () => (await electronApp.evaluate(() => globalThis.__pointerCrashEvidence)).received, 5_000, 'forced pointer crash never emitted render-process-gone');
  const crashEvidence = await electronApp.evaluate(() => globalThis.__pointerCrashEvidence);
  assert.equal(crashEvidence.hidden, true, 'crashed pointer renderer must hide its own stale frame immediately');
  await waitFor(async () => {
    try {
      pointer = await appWindow(electronApp, '/desktop/renderer/agent-pointer.html');
      await pointer.waitForSelector('#browser-use-agent-pointer', { timeout: 100 });
      return Boolean((await pointerSnapshot(pointer))?.instanceId);
    } catch {
      return false;
    }
  }, 5_000, 'pointer renderer did not recover after a forced renderer crash');
  assert.equal(await electronApp.evaluate(() => globalThis.__pointerCrashEvidence.destroyed), true, 'failed pointer window must be destroyed');
  assert.notEqual(await pointerRendererIdentity(electronApp), crashEvidence.oldContentsId, 'recovery must replace the crashed renderer');
  await callTool(configuration.endpoint, capability, 'browser_mousemove', { x: 330, y: 260 });
  const afterRendererRecovery = await pointerSnapshot(pointer);
  assertPoint(afterRendererRecovery, { x: 330, y: 260 }, 'post-crash pointer movement');
  assert.equal(afterRendererRecovery.opacity, 1, 'the first action after renderer recovery immediately reactivates the pointer');
  console.log('pointer-e2e: renderer recovery ready');

  await readSelectedPage(electronApp, () => {
    globalThis.__pointerResizeUps = [];
    window.addEventListener('mouseup', (event) => globalThis.__pointerResizeUps.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted }));
    return true;
  });
  await callTool(configuration.endpoint, capability, 'browser_mousedown', { x: 330, y: 260 });
  assert.equal((await pointerSnapshot(pointer)).pressed, true, 'viewport-resize fixture begins with a visibly held pointer');
  await shell.evaluate(() => document.getElementById('agent-toggle').click());
  await shell.waitForFunction(() => !document.querySelector('#agent-panel').hidden);
  await waitFor(async () => (await pointerSnapshot(pointer)).pressed === false, 1_000, 'viewport resize left native and visual pressed state divergent');
  assert.deepEqual(await readSelectedPage(electronApp, () => globalThis.__pointerResizeUps), [{ x: 0, y: 0, trusted: true }],
    'resizing a held pointer surface must explicitly release the page button once');
  await shell.locator('[data-close="agent"]').click();
  await shell.waitForFunction(() => document.querySelector('#agent-panel').hidden);
  const lateResizeUp = parseToolResult(await callTool(configuration.endpoint, capability, 'browser_mouseup', { x: 330, y: 260 }));
  assert.equal(lateResizeUp.releasedByCleanup, true, 'the planned up after resize must consume the cleanup release');
  assert.deepEqual(await readSelectedPage(electronApp, () => globalThis.__pointerResizeUps), [{ x: 0, y: 0, trusted: true }],
    'the late planned up must not dispatch a second native release');

  const selectedUrlBeforeMinimize = await readSelectedPage(electronApp, () => location.href);
  await readSelectedPage(electronApp, () => {
    globalThis.__pointerMinimizeUps = [];
    window.addEventListener('mouseup', (event) => globalThis.__pointerMinimizeUps.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted }));
    return true;
  });
  await callTool(configuration.endpoint, capability, 'browser_mousedown', { x: 330, y: 260 });
  assert.equal((await pointerSnapshot(pointer)).pressed, true, 'minimize fixture begins with a visibly held pointer');
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'))?.minimize();
  });
  await waitFor(async () => !(await pointerGeometry(electronApp)).pointerVisible, 1_000,
    'held pointer child stayed visible while the selected app surface was minimized');
  await waitFor(async () => {
    try { return (await readPageByUrl(electronApp, selectedUrlBeforeMinimize, () => globalThis.__pointerMinimizeUps)).length === 1; } catch { return false; }
  }, 2_000, 'selected hidden page did not receive its CDP cleanup release');
  assert.deepEqual(await readPageByUrl(electronApp, selectedUrlBeforeMinimize, () => globalThis.__pointerMinimizeUps),
    [{ x: 0, y: 0, trusted: true }], 'minimize cleanup must deliver exactly one trusted release while the selected surface is hidden');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const shellWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    shellWindow?.restore();
    shellWindow?.show();
  });
  await waitFor(async () => (await pointerGeometry(electronApp)).pointerVisible, 2_000,
    'pointer child did not recover after the held-input minimize fixture');
  const lateMinimizeUp = parseToolResult(await callTool(configuration.endpoint, capability, 'browser_mouseup', { x: 330, y: 260 }));
  assert.equal(lateMinimizeUp.releasedByCleanup, true, 'the planned up after minimize must consume the committed cleanup release');
  assert.deepEqual(await readPageByUrl(electronApp, selectedUrlBeforeMinimize, () => globalThis.__pointerMinimizeUps),
    [{ x: 0, y: 0, trusted: true }], 'the planned late up after minimize must not dispatch a duplicate release');

  await readSelectedPage(electronApp, () => {
    globalThis.__pointerCleanupUps = [];
    window.addEventListener('mouseup', (event) => globalThis.__pointerCleanupUps.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted }));
    return true;
  });
  await callTool(configuration.endpoint, capability, 'browser_mousedown', { x: 330, y: 260 });
  assert.equal((await pointerSnapshot(pointer)).pressed, true, 'standalone mouse-down must visibly press the pointer');
  assert.equal(await shell.evaluate((sessionId) => window.browserUseDesktop.revokeMcpSession(sessionId), paired.session.id), true);
  await waitFor(async () => (await pointerSnapshot(pointer)).pressed === false, 1_000, 'session cleanup left the mounted pointer visually pressed');
  const cleanupUps = await readSelectedPage(electronApp, () => globalThis.__pointerCleanupUps);
  assert.deepEqual(cleanupUps, [{ x: 0, y: 0, trusted: true }], 'session cleanup must send exactly one trusted native release edge');

  const backgroundFixture = `data:text/html,${encodeURIComponent(`<!doctype html><title>Background release fixture</title><script>
    globalThis.__backgroundUps = [];
    window.addEventListener('mouseup', (event) => globalThis.__backgroundUps.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted }));
  </script>`)}`;
  const backgroundTab = await shell.evaluate(() => window.browserUseDesktop.newTab('https://example.com/'));
  await loadFixture(electronApp, backgroundFixture);
  await waitFor(async () => {
    try { return Array.isArray(await readPageByUrl(electronApp, backgroundFixture, () => globalThis.__backgroundUps)); } catch { return false; }
  }, 3_000, 'background release fixture did not load');
  await shell.evaluate((tabId) => window.browserUseDesktop.selectTab(tabId), tabs[0].id);

  const backgroundOffer = await shell.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const backgroundPairing = await postJson(configuration.pairingEndpoint, {
    pairingCode: backgroundOffer.pairingCode,
    host: { name: 'agent-pointer-background-release-e2e', version: '1.0.0' }
  });
  await callTool(configuration.endpoint, backgroundPairing.session.capability, 'browser_bind_tab', { tabId: backgroundTab.id });
  await callTool(configuration.endpoint, backgroundPairing.session.capability, 'browser_mousedown', { x: 40, y: 40 });
  assert.equal(await shell.evaluate((sessionId) => window.browserUseDesktop.revokeMcpSession(sessionId), backgroundPairing.session.id), true);
  await waitFor(async () => (await readPageByUrl(electronApp, backgroundFixture, () => globalThis.__backgroundUps)).length === 1,
    2_000, 'background CDP press did not receive its cleanup release');
  await delay(100);
  const backgroundUps = await readPageByUrl(electronApp, backgroundFixture, () => globalThis.__backgroundUps);
  assert.deepEqual(backgroundUps, [{ x: 0, y: 0, trusted: true }], 'background cleanup must deliver exactly one release through the bound tab');
  await shell.evaluate((tabId) => window.browserUseDesktop.closeTab(tabId), backgroundTab.id);

  const secondOffer = await shell.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const secondPairing = await postJson(configuration.pairingEndpoint, {
    pairingCode: secondOffer.pairingCode,
    host: { name: 'agent-pointer-cancellation-e2e', version: '1.0.0' }
  });
  await callTool(configuration.endpoint, secondPairing.session.capability, 'browser_bind_tab', { tabId: tabs[0].id });
  await callTool(configuration.endpoint, secondPairing.session.capability, 'browser_mousemove', { x: 330, y: 260 });

  const cancelledMove = callTool(configuration.endpoint, secondPairing.session.capability, 'browser_mousemove', { x: 650, y: 430 });
  await waitFor(async () => {
    const snapshot = await pointerSnapshot(pointer);
    return snapshot.targetX === 650 && snapshot.targetY === 430 && snapshot.x < 620;
  }, 1_000, 'session-cancellation movement never began');
  await delay(40);
  const sampledBeforeCancel = await pointerSnapshot(pointer);
  assert.equal(await shell.evaluate((sessionId) => window.browserUseDesktop.revokeMcpSession(sessionId), secondPairing.session.id), true);
  const cancelledMoveResult = parseToolResult(await cancelledMove);
  assert.equal(cancelledMoveResult.input, 'interrupted', 'revoking the real MCP session must fail the pending move closed');
  const stoppedAfterCancel = await pointerSnapshot(pointer);
  assert.ok(Math.abs(stoppedAfterCancel.x - stoppedAfterCancel.targetX) <= 0.5 && Math.abs(stoppedAfterCancel.y - stoppedAfterCancel.targetY) <= 0.5,
    `cancellation must freeze the mounted pointer at its sampled current point: ${JSON.stringify({ sampledBeforeCancel, stoppedAfterCancel })}`);
  await delay(420);
  const stableAfterCancel = await pointerSnapshot(pointer);
  assertPoint(stableAfterCancel, { x: stoppedAfterCancel.x, y: stoppedAfterCancel.y }, 'cancelled pointer must not finish the abandoned target later');
  console.log('pointer-e2e: session cancellation ready');

  console.log(JSON.stringify({
    ok: true,
    build: packagedDirectory ? 'packaged' : 'checkout',
    initial,
    movementFrames: samples.map(({ x, y }) => ({ x: Math.round(x), y: Math.round(y) })),
    interruptedAt: { x: interruptedAt.x, y: interruptedAt.y, sequence: interruptedAt.sequence },
    click: clicks[0],
    pointerIdentity,
    recoveredPointerIdentity: await pointerRendererIdentity(electronApp),
    cancelledAt: { x: stoppedAfterCancel.x, y: stoppedAfterCancel.y },
    backgroundRelease: backgroundUps[0],
    injectedNodes,
    evidence: path.join(evidenceDirectory, 'agent-pointer-click.png')
  }, null, 2));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

async function appWindow(electronApp, pathname) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    for (const window of electronApp.windows()) {
      if ((await window.url()).replace(/\\/g, '/').endsWith(pathname)) return window;
    }
    await delay(50);
  }
  throw new Error(`Browser-use window did not load: ${pathname}`);
}

async function pointerSnapshot(pointer) {
  return pointer.evaluate(() => {
    const node = document.getElementById('browser-use-agent-pointer');
    if (!node) return null;
    return {
      instanceId: node.dataset.instanceId || '',
      opacity: Number.parseFloat(getComputedStyle(node).opacity),
      x: Number(node.dataset.currentX),
      y: Number(node.dataset.currentY),
      targetX: Number(node.dataset.targetX),
      targetY: Number(node.dataset.targetY),
      sequence: Number(node.dataset.sequence || 0),
      clickCount: Number(node.dataset.clickCount || 0),
      clickX: Number(node.dataset.clickX),
      clickY: Number(node.dataset.clickY),
      visible: node.dataset.visible,
      clickStartedAt: Number(node.dataset.clickStartedAt || 0),
      paintConfirmedAt: Number(node.dataset.paintConfirmedAt || 0),
      pressed: node.dataset.pressed === 'true',
      tipAnimations: document.getElementById('browser-use-agent-pointer-tip').getAnimations().length,
      contactAnimations: document.getElementById('browser-use-agent-contact').getAnimations().length
    };
  });
}

function pointerGeometry(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const shell = windows.find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const pointerWindow = windows.find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/agent-pointer.html'));
    const pageView = shell?.getBrowserViews().find((view) => !view.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/overlay.html'));
    const content = shell?.getContentBounds();
    const view = pageView?.getBounds();
    const expected = content && view ? {
      x: content.x + view.x,
      y: content.y + view.y,
      width: view.width,
      height: view.height
    } : null;
    return {
      expected,
      actual: pointerWindow && !pointerWindow.isDestroyed() ? pointerWindow.getBounds() : null,
      pointerVisible: Boolean(pointerWindow && !pointerWindow.isDestroyed() && pointerWindow.isVisible()),
      pointerFocused: Boolean(pointerWindow && BrowserWindow.getFocusedWindow() === pointerWindow)
    };
  });
}

function assertPointerGeometry(geometry, label) {
  assert.ok(geometry.expected && geometry.actual, `${label}: pointer and page bounds must exist`);
  assert.deepEqual(geometry.actual, geometry.expected, `${label}: pointer child bounds must map 1:1 to the page BrowserView in screen DIPs`);
  assert.equal(geometry.pointerFocused, false, `${label}: the input-transparent pointer child must never own focus`);
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function assertPoint(actual, expected, label) {
  assert.ok(Math.abs(actual.x - expected.x) <= 1 && Math.abs(actual.y - expected.y) <= 1,
    `${label} must settle at (${expected.x}, ${expected.y}), got (${actual.x}, ${actual.y})`);
}

function monotonic(values) {
  return values.every((value, index) => index === 0 || value + 0.75 >= values[index - 1]);
}

async function loadFixture(electronApp, url) {
  await electronApp.evaluate(async ({ BrowserWindow }, target) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const page = shell?.getBrowserViews().find((view) => !view.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/overlay.html'));
    if (!page) throw new Error('Selected page BrowserView is unavailable');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        page.webContents.stop();
        await page.webContents.loadURL(target);
      } catch {
        // A configured homepage can still own an aborting navigation during a
        // cold start. Retry only until this exact fixture is committed.
      }
      if (page.webContents.getURL() === target) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`Fixture never committed; current URL is ${page.webContents.getURL()}`);
  }, url);
}

async function readSelectedPage(electronApp, fn) {
  return electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const page = shell?.getBrowserViews().find((view) => !view.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/overlay.html'));
    if (!page) throw new Error('Selected page BrowserView is unavailable');
    return page.webContents.executeJavaScript(`(${source})()`);
  }, fn.toString());
}

async function readPageByUrl(electronApp, url, fn) {
  return electronApp.evaluate(async ({ webContents }, payload) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL() === payload.url);
    if (!page) throw new Error(`WebContents is unavailable for ${payload.url}`);
    return page.executeJavaScript(`(${payload.source})()`);
  }, { url, source: fn.toString() });
}

function pointerRendererIdentity(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const pointerWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/agent-pointer.html'));
    return pointerWindow?.webContents.id || 0;
  });
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(typeof message === 'function' ? message() : message);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function callTool(endpoint, capability, name, args = {}) {
  const response = await postJson(
    endpoint,
    { jsonrpc: '2.0', id: `${Date.now()}-${Math.random()}`, method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${capability}` }
  );
  assert.ok(!response.error, `${name} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}
