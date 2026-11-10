// Reproduces the reported left/bottom crop with a real SPA rather than a static
// page: navigates the packaged app to the studio, then compares the painted page
// viewport against both the native view bounds and the measured renderer chrome.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.PROBE_URL || 'http://127.0.0.1:3001/Apps/lorde-design-studio/';
const packageRoot = path.join(root, 'desktop-release', 'win-unpacked');
const packagedExecutable = path.join(packageRoot, 'Browser-use.exe');
const usePackaged = fs.existsSync(packagedExecutable) && process.env.PROBE_DEV !== '1';
const executablePath = usePackaged ? packagedExecutable : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-studio-probe-'));
const electronApp = await electron.launch({
  executablePath,
  ...(usePackaged ? { cwd: packageRoot } : { args: ['.'], cwd: root }),
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_START_URL: target, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

const window = await electronApp.firstWindow();
await window.waitForSelector('#settings-toggle');

const viewportMetrics = () => window.evaluate(() => window.browserUseDesktop.viewportMetrics());

// The renderer chrome's real height, versus the hardcoded APP_CHROME_HEIGHT.
const measuredChrome = () => window.evaluate(() => {
  const chrome = document.querySelector('.browser-chrome');
  return chrome ? Math.round(chrome.getBoundingClientRect().height) : null;
});

function pageViewport() {
  return electronApp.evaluate(({ BrowserWindow, webContents }) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    if (!shell) return null;
    const hostId = shell.webContents.id;
    const target = webContents.getAllWebContents().find((contents) => contents.id !== hostId && !contents.getURL().startsWith('file:'));
    if (!target) return null;
    return target.executeJavaScript('({ innerWidth, innerHeight, url: location.href, scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })');
  });
}

async function report(label) {
  const deadline = Date.now() + 5000;
  const matches = (metrics) => Boolean(metrics?.bounds) && ['x', 'y', 'width', 'height'].every((key) => metrics.bounds[key] === metrics.expected[key]);
  let metrics = await viewportMetrics();
  while (Date.now() < deadline && !matches(metrics)) metrics = await viewportMetrics();
  const [page, chrome] = [await pageViewport(), await measuredChrome()];
  const record = {
    label,
    mode: usePackaged ? 'packaged' : 'dev',
    boundsMatchExpected: matches(metrics),
    bounds: metrics?.bounds ?? null,
    content: metrics?.content ?? null,
    declaredChrome: metrics?.chromeHeight ?? null,
    measuredChrome: chrome,
    chromeDrift: chrome !== null && metrics?.chromeHeight != null ? chrome - metrics.chromeHeight : null,
    page: page ? { innerWidth: page.innerWidth, innerHeight: page.innerHeight } : null,
    viewMinusPage: metrics?.bounds && page ? { height: metrics.bounds.height - page.innerHeight, width: metrics.bounds.width - page.innerWidth } : null
  };
  console.log(JSON.stringify(record));
  return record;
}

const setState = (action) => electronApp.evaluate(({ BrowserWindow }, name) => {
  const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
  if (!shell) throw new Error('Browser-use main window is unavailable.');
  shell[name]();
}, action);

try {
  const records = [];
  records.push(await report('studio-initial'));
  await setState('maximize');
  records.push(await report('studio-maximized'));
  await window.locator('#settings-toggle').click();
  await window.locator('[data-close="settings"]').click();
  records.push(await report('studio-after-drawer-cycle'));
  await setState('unmaximize');
  records.push(await report('studio-unmaximized'));

  const bad = records.filter((r) => r.viewMinusPage && (r.viewMinusPage.height !== 0 || r.viewMinusPage.width !== 0));
  const drift = records.filter((r) => r.chromeDrift !== 0 && r.chromeDrift !== null);
  console.log(JSON.stringify({ summary: { url: target, mode: usePackaged ? 'packaged' : 'dev', checked: records.length, cropped: bad.map((r) => r.label), chromeDrift: drift.map((r) => ({ label: r.label, drift: r.chromeDrift })) } }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}
