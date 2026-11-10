// Acceptance for the docked terminal, driven through the real UI: open it from
// the toolbar, run a command in the shell, resize the dock, and use the
// Screenshot and Select actions.
//
// The layout claim matters as much as the shell one. A terminal that renders
// but does not shrink the browsing surface would cover the page it is meant to
// sit beneath, so the native view bounds are asserted alongside the output.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-terminal-'));

const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Terminal fixture</title>
<body style="margin:0;font:16px system-ui">
<button id="pick-me" data-testid="pick-target" style="position:absolute;left:40px;top:100px;width:220px;height:70px">Pick me</button>
</body>`)}`;

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

const checks = [];
try {
  const window = await mainWindow(electronApp);
  await window.waitForSelector('#terminal-toggle');
  await electronApp.evaluate(async ({ BrowserWindow }, target) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    await shell.getBrowserViews()[0].webContents.loadURL(target);
  }, fixture);

  const boundsBefore = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;

  // ---- 1. The toolbar button opens the dock.
  await window.click('#terminal-toggle');
  await window.waitForSelector('#terminal-panel:not([hidden])');
  await window.waitForFunction(() => document.querySelector('#terminal-surface .xterm-screen') !== null, null, { timeout: 20_000 });
  const layout = await window.evaluate(() => window.browserUseDesktop.terminalLayout());
  assert.equal(layout.docked, true, 'the terminal must report itself docked');
  assert.ok(layout.height >= 120, `the dock needs a usable height, got ${layout.height}`);
  checks.push({ name: 'open', height: layout.height });

  // ---- 2. The dock shrinks the browsing surface instead of covering it.
  const boundsAfter = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.ok(boundsAfter.height < boundsBefore.height, `the page must give up height to the terminal: ${boundsBefore.height} -> ${boundsAfter.height}`);
  assert.ok(boundsBefore.height - boundsAfter.height >= layout.height - 8, 'the surface must shrink by the height of the dock');
  checks.push({ name: 'layout', before: boundsBefore.height, after: boundsAfter.height, dock: layout.height });

  // ---- 3. The backend declares itself rather than failing silently.
  const backend = await window.evaluate(() => window.browserUseDesktop.terminalBackend());
  assert.ok(['pty', 'piped'].includes(backend.backend), 'the terminal must declare which backend it obtained');
  checks.push({ name: 'backend', backend: backend.backend, ptyAvailable: backend.ptyAvailable });

  // ---- 4. A real command runs and its output reaches the rendered buffer.
  await window.click('#terminal-surface');
  await window.keyboard.type('Write-Output BROWSERUSE_E2E_MARKER');
  await window.keyboard.press('Enter');
  // Typing echoes the marker immediately, so waiting for its mere presence
  // would return before the command had run. The output line is a second
  // occurrence, which is what distinguishes "the shell ran it" from "the
  // characters appeared".
  await window.waitForFunction(
    () => (document.querySelector('#terminal-surface')?.innerText?.split('BROWSERUSE_E2E_MARKER').length - 1) >= 2,
    null,
    { timeout: 30_000 }
  );
  const buffer = await window.evaluate(() => document.querySelector('#terminal-surface').innerText);
  const occurrences = buffer.split('BROWSERUSE_E2E_MARKER').length - 1;
  assert.ok(occurrences >= 2, `the shell must echo the command and print its output, saw ${occurrences} occurrence(s)`);
  // A PTY promises an interactive shell, so it must have drawn its own prompt.
  // The piped fallback makes no such promise, so this is asserted only when the
  // PTY backend was actually obtained.
  if (backend.backend === 'pty') {
    assert.match(buffer, /PS .*>/, 'a PTY-backed terminal must render the shell\'s own interactive prompt');
  }
  checks.push({ name: 'command', occurrences, prompt: backend.backend === 'pty' });

  // ---- 4b. Shell and xterm right-clicks suppress the browser default and
  // request the native Desktop context menu. Replace only the menu popup IPC
  // handler so the native test menu cannot steal subsequent Playwright input.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__browserUseContextMenuRequests = [];
    ipcMain.removeHandler('browser-use:show-context-menu');
    ipcMain.handle('browser-use:show-context-menu', (_event, request) => {
      globalThis.__browserUseContextMenuRequests.push(request);
      return true;
    });
  });
  const contextDefaults = await window.evaluate(() => {
    const shellEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const terminalEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    const shellAllowed = document.querySelector('#address').dispatchEvent(shellEvent);
    const terminalAllowed = document.querySelector('#terminal-surface').dispatchEvent(terminalEvent);
    return {
      shellAllowed,
      terminalAllowed,
      bridge: typeof window.browserUseDesktop.showContextMenu
    };
  });
  assert.deepEqual(contextDefaults, { shellAllowed: false, terminalAllowed: false, bridge: 'function' });
  await window.waitForTimeout(100);
  const contextRequests = await electronApp.evaluate(() => globalThis.__browserUseContextMenuRequests);
  assert.equal(contextRequests.length, 2, 'shell and terminal right-clicks must both request a native menu');
  assert.deepEqual(contextRequests.map((request) => request.kind), ['shell', 'terminal']);
  assert.equal(contextRequests[0].editable, true, 'the address field must expose Paste through the shell menu');
  assert.ok(contextRequests[1].terminalId, 'the terminal menu must target its active shell session');
  checks.push({ name: 'context-menu', kinds: contextRequests.map((request) => request.kind) });

  // ---- 5. Detaching changes only the xterm presentation. The same main-owned
  // shell must retain its ID and PowerShell state in the detached window, then
  // survive a re-dock without a replacement process.
  const sessionBeforeDetach = (await window.evaluate(() => window.browserUseDesktop.terminalLayout())).activeSession;
  assert.ok(sessionBeforeDetach?.id, 'a docked terminal must publish its active session identity');
  await window.click('#terminal-surface');
  await window.keyboard.type('$browserUseTransfer = "BROWSERUSE_TRANSFER_STATE"');
  await window.keyboard.press('Enter');
  await window.waitForFunction(
    () => document.querySelector('#terminal-surface')?.innerText?.includes('BROWSERUSE_TRANSFER_STATE'),
    null,
    { timeout: 30_000 }
  );
  await window.click('#terminal-detach');
  await window.waitForFunction(() => window.browserUseDesktop.terminalLayout().then((layout) => !layout.docked && layout.detached));
  const detached = await detachedTerminalWindow(electronApp);
  await detached.waitForFunction(() => document.querySelector('#terminal-surface .xterm-screen') !== null, null, { timeout: 20_000 });
  const sessionDetached = (await window.evaluate(() => window.browserUseDesktop.terminalLayout())).activeSession;
  assert.equal(sessionDetached?.id, sessionBeforeDetach.id, 'detaching must preserve the same main-owned session ID');
  const detachedBounds = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.equal(detachedBounds.height, boundsBefore.height, 'detaching must restore page height after collapsing the dock');
  await detached.click('#terminal-surface');
  await detached.keyboard.type('Write-Output $browserUseTransfer');
  await detached.keyboard.press('Enter');
  await detached.waitForFunction(
    () => (document.querySelector('#terminal-surface')?.innerText?.split('BROWSERUSE_TRANSFER_STATE').length - 1) >= 2,
    null,
    { timeout: 30_000 }
  );
  await window.click('#terminal-toggle');
  await window.waitForFunction(() => window.browserUseDesktop.terminalLayout().then((layout) => layout.docked && !layout.detached));
  await window.waitForFunction(() => document.querySelector('#terminal-surface .xterm-screen') !== null, null, { timeout: 20_000 });
  const sessionRedocked = (await window.evaluate(() => window.browserUseDesktop.terminalLayout())).activeSession;
  assert.equal(sessionRedocked?.id, sessionBeforeDetach.id, 're-docking must adopt the original shell rather than create a replacement');
  await window.click('#terminal-surface');
  await window.keyboard.type('Write-Output $browserUseTransfer');
  await window.keyboard.press('Enter');
  await window.waitForFunction(
    () => (document.querySelector('#terminal-surface')?.innerText?.split('BROWSERUSE_TRANSFER_STATE').length - 1) >= 2,
    null,
    { timeout: 30_000 }
  );
  checks.push({ name: 'transfer', sessionId: sessionBeforeDetach.id });

  // ---- 6. Screenshot writes a real PNG and puts its path on the clipboard.
  await window.click('#terminal-screenshot');
  await window.waitForFunction(
    () => /Screenshot (saved|failed)/.test(document.querySelector('#terminal-surface')?.innerText || ''),
    null,
    { timeout: 20_000 }
  );
  const screenshotBuffer = await window.evaluate(() => document.querySelector('#terminal-surface')?.innerText || '');
  assert.match(screenshotBuffer, /Screenshot saved/, `the terminal screenshot action failed: ${screenshotBuffer.slice(-600)}`);
  const clipboardText = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  assert.match(clipboardText, /\.png$/, `the clipboard must hold the screenshot path, got ${clipboardText}`);
  assert.ok(fs.existsSync(clipboardText), `the screenshot file must exist at ${clipboardText}`);
  const pngHeader = fs.readFileSync(clipboardText).subarray(0, 8);
  // A path that exists but points at a truncated or empty file would still pass
  // an existence check, so the magic bytes are verified.
  assert.deepEqual([...pngHeader], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the saved file must be a real PNG');
  assert.ok(fs.statSync(clipboardText).size > 1000, 'the screenshot must have real content');
  checks.push({ name: 'screenshot', bytes: fs.statSync(clipboardText).size });

  // ---- 6. Select picks a DOM element and inserts its selector at the prompt.
  // page.evaluate awaits returned promises by design. Store the pending IPC
  // promise in the page instead of returning it, otherwise this line deadlocks
  // waiting for a human selection before the test can send the click below.
  await window.evaluate(() => {
    window.__browserUsePickResult = window.browserUseDesktop.pickElement();
    return true;
  });
  await window.waitForTimeout(700);
  // The picker has already been injected above. Drive its capture listeners
  // from the fixture document so this test proves selector extraction without
  // depending on Playwright's Electron transport racing an in-flight IPC call.
  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = shell.getBrowserViews()[0];
    await view.webContents.executeJavaScript(`(() => {
      const target = document.querySelector('#pick-me');
      for (const type of ['mousemove', 'mousedown', 'mouseup']) {
        target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 150, clientY: 135 }));
      }
    })()`, true);
  });
  const picked = await window.evaluate(async () => window.__browserUsePickResult);
  assert.equal(picked.picked, true, `the picker must resolve with a selection, got ${JSON.stringify(picked)}`);
  assert.equal(picked.element.tag, 'button', `the picker must identify the element under the pointer, got ${picked.element.tag}`);
  // A stable id is preferred over a positional path (the picker uses a test id
  // when no id is available).
  assert.equal(picked.element.selector, '#pick-me', `the selector should prefer the stable id, got ${picked.element.selector}`);
  checks.push({ name: 'select', selector: picked.element.selector, tag: picked.element.tag });

  // ---- 7. Resizing the dock re-lays out the browsing surface.
  const resized = await window.evaluate(() => window.browserUseDesktop.setTerminalHeight(360));
  assert.equal(resized.height, 360, `the requested height must apply, got ${resized.height}`);
  const boundsResized = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.ok(boundsResized.height < boundsAfter.height, 'growing the terminal must shrink the page further');
  checks.push({ name: 'resize', height: resized.height, pageHeight: boundsResized.height });

  // ---- 8. Height is clamped so the dock cannot swallow the window.
  const clamped = await window.evaluate(() => window.browserUseDesktop.setTerminalHeight(99999));
  assert.ok(clamped.height < clamped.maxHeight + 1, 'an absurd height must be clamped');
  assert.ok(clamped.height > 0, 'the clamped height must remain usable');
  const boundsClamped = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.ok(boundsClamped.height > 0, 'the page must keep a visible surface no matter the terminal height');
  checks.push({ name: 'clamp', requested: 99999, applied: clamped.height, pageHeight: boundsClamped.height });

  // ---- 9. Closing restores the full browsing surface.
  await window.evaluate(() => window.browserUseDesktop.setTerminalHeight(260));
  await window.click('#terminal-close');
  await window.waitForFunction(() => document.querySelector('#terminal-panel')?.hidden === true);
  const boundsRestored = (await window.evaluate(() => window.browserUseDesktop.viewportMetrics())).bounds;
  assert.equal(boundsRestored.height, boundsBefore.height, 'closing the terminal must return the height it took');
  checks.push({ name: 'close', restored: boundsRestored.height });

  console.log(JSON.stringify({ ok: true, checks }, null, 2));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

async function detachedTerminalWindow(electronApp) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/terminal.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Detached terminal window did not load within 20 seconds.');
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
