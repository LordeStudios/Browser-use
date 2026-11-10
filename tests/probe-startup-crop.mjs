// The reported crop repairs itself on a drawer toggle, so it lives in the startup
// window that settle-polling probes skip. This samples the PAINTED surface via
// capturePage (the compositor real size, not getBounds) from first paint onward.
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
const startMaximized = process.env.PROBE_MAXIMIZED === '1';

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-startup-probe-'));
const electronApp = await electron.launch({
  executablePath,
  ...(usePackaged ? { cwd: packageRoot } : { args: ['.'], cwd: root }),
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_START_URL: target, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

// Sample the compositor's actual painted size plus the intended bounds, with no
// settle-polling, so a stale native surface is visible instead of waited out.
function sample() {
  return electronApp.evaluate(async ({ BrowserWindow, webContents }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    if (!window) return null;
    const hostId = window.webContents.id;
    const view = webContents.getAllWebContents().find((contents) => contents.id !== hostId && !contents.getURL().startsWith('devtools:') && !contents.getURL().startsWith('file:'));
    const [contentWidth, contentHeight] = window.getContentSize();
    const views = window.getBrowserViews();
    const bounds = views.length ? views[0].getBounds() : null;
    let painted = null;
    let inner = null;
    if (view && !view.isDestroyed()) {
      try {
        const image = await view.capturePage();
        const size = image.getSize();
        painted = { width: size.width, height: size.height };
      } catch {}
      try {
        inner = await view.executeJavaScript('({ innerWidth, innerHeight })');
      } catch {}
    }
    return { content: { width: contentWidth, height: contentHeight }, bounds, painted, inner, attached: views.length > 0 };
  });
}

try {
  if (startMaximized) await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'))?.maximize();
  });
  const samples = [];
  for (let index = 0; index < 14; index += 1) {
    const record = await sample();
    if (record) {
      const chrome = 78;
      const expected = { width: record.content.width, height: record.content.height - chrome };
      const paintedDrift = record.painted ? { width: record.painted.width - expected.width, height: record.painted.height - expected.height } : null;
      const boundsDrift = record.bounds ? { width: record.bounds.width - expected.width, height: record.bounds.height - expected.height } : null;
      samples.push({ index, attached: record.attached, expected, painted: record.painted, bounds: record.bounds ? { width: record.bounds.width, height: record.bounds.height, x: record.bounds.x, y: record.bounds.y } : null, inner: record.inner, paintedDrift, boundsDrift });
    }
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  for (const entry of samples) console.log(JSON.stringify(entry));
  const paintedBad = samples.filter((s) => s.paintedDrift && (s.paintedDrift.width !== 0 || s.paintedDrift.height !== 0));
  const boundsBad = samples.filter((s) => s.boundsDrift && (s.boundsDrift.width !== 0 || s.boundsDrift.height !== 0));
  console.log(JSON.stringify({
    summary: {
      mode: usePackaged ? 'packaged' : 'dev',
      maximizedAtStart: startMaximized,
      samples: samples.length,
      paintedMismatches: paintedBad.length,
      boundsMismatches: boundsBad.length,
      worstPaintedDrift: paintedBad.length ? paintedBad.map((s) => s.paintedDrift) : null
    }
  }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}
