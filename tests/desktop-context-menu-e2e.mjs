// Acceptance: the trusted Desktop shell and its xterm terminal both replace
// the Chromium context menu with the native Desktop menu request. This stays
// deliberately focused so it does not depend on capture, selection, or
// terminal detach behaviour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-context-menu-'));

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_TERMINAL_BROKER_IDLE_MS: '250' }
});

try {
  const window = await mainWindow(electronApp);
  await window.waitForSelector('#terminal-toggle');
  await window.click('#terminal-toggle');
  await window.waitForSelector('#terminal-panel:not([hidden])');
  await window.waitForSelector('#terminal-surface .xterm-screen', { timeout: 20_000 });

  // Leave rendering intact and intercept only the native menu popup IPC. It
  // proves the browser-default was prevented and each trusted surface sends
  // the correct ownership data to the main process.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__browserUseContextMenuRequests = [];
    ipcMain.removeHandler('browser-use:show-context-menu');
    ipcMain.handle('browser-use:show-context-menu', (_event, request) => {
      globalThis.__browserUseContextMenuRequests.push(request);
      return true;
    });
  });
  const result = await window.evaluate(() => {
    const address = document.querySelector('#address');
    address.focus();
    address.setSelectionRange(0, Math.min(5, address.value.length));
    const shellAllowed = address.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    const terminalAllowed = document.querySelector('#terminal-surface').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    );
    return { shellAllowed, terminalAllowed };
  });
  assert.deepEqual(result, { shellAllowed: false, terminalAllowed: false }, 'both surfaces must suppress Chromium’s context menu');
  await window.waitForTimeout(100);
  const requests = await electronApp.evaluate(() => globalThis.__browserUseContextMenuRequests);
  assert.equal(requests.length, 2, 'both right-clicks must request a native Desktop menu');
  assert.deepEqual(requests.map((request) => request.kind), ['shell', 'terminal']);
  assert.equal(requests[0].editable, true, 'the address field must permit Paste');
  assert.ok(requests[0].selection, 'the address field selection must be Copy-able');
  assert.ok(requests[1].terminalId, 'terminal paste must remain bound to its active session');
  await window.evaluate(async () => {
    const active = await window.browserUseDesktop.terminalActiveSession({ cols: 100, rows: 30 });
    if (active?.id) await window.browserUseDesktop.terminalDispose(active.id);
  });
  console.log(JSON.stringify({ ok: true, requests }, null, 2));
} finally {
  // The terminal broker intentionally outlives Electron. Avoid Playwright's
  // process-tree close helper, which waits for that detached broker process.
  void electronApp.evaluate(({ app }) => { app.quit(); return true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  fs.rmSync(appDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function mainWindow(electronApp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Desktop main renderer did not load.');
}
