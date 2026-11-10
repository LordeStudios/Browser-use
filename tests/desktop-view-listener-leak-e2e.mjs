// Regression: the shell re-attaches BrowserViews to force native z-order, and
// Electron parks a permanent 'closed' listener on the window for every attach.
// The churn used to grow mainWindow's listener list without bound, tripping
// Node's max-listeners warning ("11 closed listeners added to [BrowserWindow]")
// after ten drawer toggles. The window must now carry exactly one listener
// per ATTACHED view, no matter how many times a view is attached and detached.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-view-leak-'));
const stderrChunks = [];
const app = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.', `--user-data-dir=${profile}`],
  cwd: root,
  env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0' },
  timeout: 45_000
});
app.process().stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

async function pageFor(suffix) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const page = app.context().pages().find((candidate) => candidate.url().endsWith(suffix));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Missing renderer ${suffix}`);
}

// The window's listener budget: one 'closed' listener per attached view,
// plus Electron's own window-close handler and the shell's own handler.
async function listenerBudget() {
  return app.evaluate(({ BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    if (!main) return { excess: -1, listeners: -1, views: -1 };
    const views = main.getBrowserViews().length;
    const listeners = main.listenerCount('closed');
    return { excess: listeners - views, listeners, views };
  });
}

// The overlay must stay the topmost native view: it owns the drawer chrome
// and the device frame, so a view that lands above it swallows page input.
const topmostView = () => app.evaluate(({ BrowserWindow }) => {
  const main = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
  const views = main.getBrowserViews();
  return views.length ? views[views.length - 1].webContents.getURL().split('/').pop() : '';
});

try {
  const shell = await pageFor('/desktop/renderer/index.html');
  await shell.waitForFunction(() => document.documentElement.dataset.browserUseRendererReady === 'true');

  const baseline = await listenerBudget();
  assert.ok(baseline.listeners > 0, 'the main window must be observable');
  assert.ok(baseline.excess <= 3, `the window must not carry more listeners than attached views plus its own (${JSON.stringify(baseline)})`);

  // Each cycle attaches and detaches the overlay BrowserView.
  for (let cycle = 0; cycle < 25; cycle += 1) {
    await shell.evaluate(() => window.browserUseDesktop.setActiveDrawer('settings'));
    await shell.evaluate(() => window.browserUseDesktop.setActiveDrawer(null));
  }
  const afterDrawers = await listenerBudget();
  assert.equal(
    afterDrawers.excess,
    baseline.excess,
    `drawer churn must not add 'closed' listeners to the window (${JSON.stringify(baseline)} -> ${JSON.stringify(afterDrawers)})`
  );

  // Tab open/close attaches and detaches a tab BrowserView.
  for (let cycle = 0; cycle < 6; cycle += 1) {
    const id = await shell.evaluate(() => window.browserUseDesktop.newTab('about:blank').then((tab) => tab.id));
    await shell.evaluate((tabId) => window.browserUseDesktop.closeTab(tabId), id);
  }
  const afterTabs = await listenerBudget();
  assert.equal(
    afterTabs.excess,
    baseline.excess,
    `tab churn must not add 'closed' listeners to the window (${JSON.stringify(baseline)} -> ${JSON.stringify(afterTabs)})`
  );

  // The overlay must remain the topmost native view while it is open, both
  // after a tab attaches above it and after the window is resized.
  await shell.evaluate(() => window.browserUseDesktop.setActiveDrawer('settings'));
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await topmostView(), 'overlay.html', 'the overlay must own the top native slot');

  await shell.evaluate(() => window.browserUseDesktop.newTab('about:blank'));
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(await topmostView(), 'overlay.html', 'a new tab must not cover the overlay');
  const afterTabAttach = await listenerBudget();
  assert.equal(afterTabAttach.excess, baseline.excess, 'attaching a tab above the overlay must not add listeners');

  for (const [width, height] of [[1180, 840], [1320, 900], [1000, 700]]) {
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'))
        .setContentSize(size[0], size[1]);
    }, [width, height]);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(await topmostView(), 'overlay.html', 'a window resize must not drop the overlay below the page');
  const afterResize = await listenerBudget();
  assert.equal(afterResize.excess, baseline.excess, 'a window resize must not add listeners');

  const stderr = stderrChunks.join('');
  assert.doesNotMatch(stderr, /MaxListenersExceededWarning/, 'the shell must not trip the max-listeners warning');

  console.log(JSON.stringify({
    ok: true,
    checks: [
      'drawer churn keeps the window listener count flat',
      'tab churn keeps the window listener count flat',
      'the overlay stays the topmost native view',
      'no max-listeners warning'
    ],
    baseline,
    afterDrawers,
    afterTabs,
    afterResize
  }));
} finally {
  await app.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
}
