// Locks in the startup crop fix. Windows settles a window's content size shortly
// after launch and emits no event for it, so a view laid out once against the
// pre-settle size keeps stale bounds and paints past the bottom edge. The existing
// interaction suite cannot catch this because it polls until bounds agree with the
// window, and both are wrong together during the settle. This asserts the PAGE
// viewport matches the native view shortly after launch, in both window states.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'desktop-release', 'win-unpacked');
const packagedExecutable = path.join(packageRoot, 'Browser-use.exe');
const usePackaged = fs.existsSync(packagedExecutable) && process.env.PROBE_DEV !== '1';
const executablePath = usePackaged ? packagedExecutable : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const target = process.env.PROBE_URL || 'https://example.com';
// The settle happens within the first second; allow margin without hiding a real crop.
const SETTLE_BUDGET_MS = 3_000;

async function launch({ maximized }) {
  const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-crop-e2e-'));
  const electronApp = await electron.launch({
    executablePath,
    // APPDATA alone does not bypass Electron's process-level single-instance
    // lock. Give the probe its own profile so it tests a fresh launch even
    // while a developer has Browser-use open locally.
    ...(usePackaged
      ? { args: [`--user-data-dir=${appDataDirectory}`], cwd: packageRoot }
      : { args: ['.', `--user-data-dir=${appDataDirectory}`], cwd: root }),
    env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_START_URL: target, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
  });
  const window = await mainRendererWindow(electronApp);
  await window.waitForSelector('#settings-toggle');
  if (maximized) await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'))?.maximize();
  });
  return { electronApp, window, appDataDirectory };
}

async function mainRendererWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main renderer did not load within 30 seconds.');
}

function pageViewport(electronApp) {
  return electronApp.evaluate(({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    if (!shell) return null;
    const hostId = shell.webContents.id;
    const view = webContents.getAllWebContents().find((contents) => contents.id !== hostId && !contents.getURL().startsWith('devtools:') && !contents.getURL().startsWith('file:'));
    return view && !view.isDestroyed() ? view.executeJavaScript('({ innerWidth, innerHeight })') : null;
  });
}

// The page filling its view is the property a person actually sees; comparing the
// main process against itself would pass even while the page is cropped.
async function assertPageFillsView(electronApp, window, context) {
  const deadline = Date.now() + SETTLE_BUDGET_MS;
  let last = null;
  while (Date.now() < deadline) {
    const metrics = await window.evaluate(() => window.browserUseDesktop.viewportMetrics());
    const page = await pageViewport(electronApp);
    if (metrics?.bounds && page) {
      last = {
        viewMinusPageHeight: metrics.bounds.height - page.innerHeight,
        viewMinusPageWidth: metrics.bounds.width - page.innerWidth,
        bounds: metrics.bounds,
        expected: metrics.expected,
        page
      };
      const aligned = last.viewMinusPageHeight === 0 && last.viewMinusPageWidth === 0;
      const boundsCorrect = ['x', 'y', 'width', 'height'].every((key) => metrics.bounds[key] === metrics.expected[key]);
      if (aligned && boundsCorrect) return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  assert.fail(`${context}: the page never filled its view within ${SETTLE_BUDGET_MS}ms — ${JSON.stringify(last)}`);
}

const results = [];

for (const maximized of [false, true]) {
  const label = maximized ? 'maximized' : 'windowed';
  const { electronApp, window, appDataDirectory } = await launch({ maximized });
  try {
    results.push({ state: label, phase: 'startup', ...(await assertPageFillsView(electronApp, window, `${label} startup`)) });

    // A drawer cycle must not be the only thing that repairs the surface.
    await window.locator('#settings-toggle').click();
    await window.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
    await window.locator('[data-close="settings"]').click();
    await window.waitForFunction(() => document.querySelector('#settings-panel').hidden);
    results.push({ state: label, phase: 'after-drawer-cycle', ...(await assertPageFillsView(electronApp, window, `${label} after drawer cycle`)) });

    await electronApp.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'))?.setContentSize(size.width, size.height);
    }, { width: 1180, height: 840 });
    results.push({ state: label, phase: 'after-resize', ...(await assertPageFillsView(electronApp, window, `${label} after resize`)) });
  } finally {
    await electronApp.close();
    fs.rmSync(appDataDirectory, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: usePackaged ? 'packaged' : 'dev',
  url: target,
  checks: results.map((entry) => `${entry.state}/${entry.phase}: view-page drift ${entry.viewMinusPageHeight}x${entry.viewMinusPageWidth}`)
}));
