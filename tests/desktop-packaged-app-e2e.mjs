// Smoke-tests the packaged Windows application the way a person launches it:
// the built Browser-use.exe as a desktop app, with no repository checkout, no
// ELECTRON_RUN_AS_NODE, no Playwright-driven Chrome, and no installed Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// A verification build may be written to an alternate output directory so a
// running release never locks the artifact under test. Accept either its full
// win-unpacked path or the normal desktop-release default.
const packageRoot = path.resolve(process.argv[2] || path.join(root, 'desktop-release', 'win-unpacked'));
const packagedExecutable = path.join(packageRoot, 'Browser-use.exe');

assert.ok(fs.existsSync(packagedExecutable), `Packaged executable is missing: ${packagedExecutable}`);

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-packaged-desktop-'));
const electronApp = await electron.launch({
  executablePath: packagedExecutable,
  cwd: packageRoot,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const window = await electronApp.firstWindow();
  await window.waitForSelector('#settings-toggle');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);

  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  assert.match(configuration.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/, 'the packaged app must serve its local MCP endpoint');
  assert.match(configuration.pairingEndpoint, /^http:\/\/127\.0\.0\.1:\d+\/pair$/);

  const initialize = await fetch(configuration.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } })
  }).then((response) => response.json());
  assert.equal(initialize.result.serverInfo.name, 'browser-use-desktop');
  assert.equal(initialize.result.serverInfo.version, packageInfo.version, 'the packaged MCP version must match the artifact version');

  await assertViewportFills(window, 'packaged initial layout');
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).setContentSize(1200, 860));
  await assertViewportFills(window, 'packaged app after resize');
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).maximize());
  await assertViewportFills(window, 'packaged app after maximize');

  await window.locator('#settings-toggle').click();
  await window.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
  await window.locator('[data-close="settings"]').click();
  await window.waitForFunction(() => document.querySelector('#settings-panel').hidden);
  await assertViewportFills(window, 'packaged app after closing Settings');

  console.log(JSON.stringify({ ok: true, version: packageInfo.version, executable: packagedExecutable, checks: 'window, local MCP endpoint, uncropped viewport across resize/maximize/drawer' }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

async function assertViewportFills(window, context) {
  const deadline = Date.now() + 5000;
  let metrics = await window.evaluate(() => window.browserUseDesktop.viewportMetrics());
  while (Date.now() < deadline && !boundsMatch(metrics)) {
    metrics = await window.evaluate(() => window.browserUseDesktop.viewportMetrics());
  }
  assert.ok(metrics?.attached, `${context}: the browsing view must be attached`);
  assert.deepEqual(metrics.bounds, metrics.expected, `${context}: browsing view bounds must fill the window below the chrome`);
  assert.equal(metrics.bounds.width, metrics.content.width, `${context}: the page must span the full window width`);
  assert.equal(metrics.bounds.height, metrics.content.height - metrics.chromeHeight, `${context}: the page must not be cropped at the bottom`);
}

function boundsMatch(metrics) {
  return Boolean(metrics?.bounds) && ['x', 'y', 'width', 'height'].every((key) => metrics.bounds[key] === metrics.expected[key]);
}
