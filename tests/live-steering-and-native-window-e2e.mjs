import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

// Two harness defects from the 2026-10-31 runs, checked against the REAL app.
//
// 1. The composer held a message typed while the agent was working in a
//    local queue that was only flushed when the run ENDED. A direct
//    instruction sent mid-task was therefore delivered minutes later — after
//    the agent had already done the thing the user was correcting. The agent
//    has had live steering for a long time; the composer never used it.
//
// 2. computer_keyboard sends a REAL OS key to the FOREGROUND window. The
//    harness's own window was in that inventory with no mark on it, so a model
//    that focused the harness's own pointer panel and pressed ESC to close it
//    had the app read the key as its own — and the app binds Escape to
//    "stop the active run".
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-steer-'));

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

async function mainRendererWindow(app) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const windows = app.windows();
    for (const candidate of windows) {
      const url = candidate.url();
      if (url.includes('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('the main renderer window never appeared');
}

try {
  const window = await mainRendererWindow(electronApp);
  window.setDefaultTimeout(20_000);
  await window.waitForSelector('#settings-toggle');

  // ── 1. the composer must steer the LIVE run ──────────────────────────────
  // Replace the steer IPC handler with one that records the request, so the
  // test sees exactly what the composer sent without needing a live model.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__steered = [];
    ipcMain.removeHandler('browser-use:agent-steer');
    ipcMain.handle('browser-use:agent-steer', (_event, request) => {
      globalThis.__steered.push(request);
      return { id: 'steered-1', status: 'queued', runId: request?.runId };
    });
  });

  // Tell the renderer a task is running.
  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    for (const target of BrowserWindow.getAllWindows()) target.webContents.send('browser-use:agent-event', payload);
  }, {
    type: 'run.started',
    revision: 1,
    run: { id: 'live-run-check', status: 'running', title: 'Live run check', plan: [], goals: [] }
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));

  await window.fill('#agent-task', 'or order');
  await window.press('#agent-task', 'Enter');
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const steered = await electronApp.evaluate(() => globalThis.__steered || []);
  assert.equal(steered.length, 1, `the composer must deliver the message to the running task, not queue it: ${JSON.stringify(steered)}`);
  assert.equal(steered[0].text, 'or order', 'the message must arrive as the user typed it');
  assert.equal(steered[0].runId, 'live-run-check', 'the message must name the run it belongs to');

  const queued = await window.locator('#agent-queued').isVisible().catch(() => false);
  assert.equal(queued, false, 'the message must not sit in the local queue waiting for the run to end');

  // ── 2. the native worker must refuse the harness's own window ────────────
  const native = await electronApp.evaluate(async () => {
    const { fork } = process.getBuiltinModule('node:child_process');
    const path = process.getBuiltinModule('node:path');
    const { BrowserWindow } = require('electron');
    const child = fork(path.join(process.cwd(), 'desktop', 'computer', 'nativeWorker.cjs'), [], {
      execPath: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
    });
    const call = (name, args) => new Promise((resolve, reject) => {
      const id = Math.random().toString(36).slice(2);
      const onMessage = (message) => {
        if (message.id !== id) return;
        child.off('message', onMessage);
        if (message.error) reject(new Error(message.error)); else resolve(message.result);
      };
      child.on('message', onMessage);
      child.send({ id, name, args, owner: 'e2e' });
    });
    const out = { ownWindow: null, focusError: '', keyError: '', foregroundIsOurs: null, markedOwn: null };
    try {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/desktop/renderer/index.html')) || BrowserWindow.getAllWindows()[0];
      win.focus();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const handle = win.getNativeWindowHandle().readBigUInt64LE(0).toString();
      out.ownWindow = handle;
      try { await call('computer_window', { action: 'focus', windowId: handle }); out.focusError = '(no error)'; }
      catch (error) { out.focusError = String(error.message || error); }
      try { await call('computer_keyboard', { action: 'press', key: 'ESC' }); out.keyError = '(no error)'; }
      catch (error) { out.keyError = String(error.message || error); }
      const observed = await call('computer_observe', { action: 'list' });
      const windows = observed.windows || observed;
      const listed = (Array.isArray(windows) ? windows : []).find((w) => String(w.id) === String(handle));
      out.markedOwn = listed ? listed.own === true : null;
      out.foregroundIsOurs = String(observed.foregroundWindowId) === String(handle);
    } catch (error) {
      out.focusError = `probe failed: ${error.message}`;
    } finally {
      child.kill();
    }
    return out;
  });

  assert.ok(native.ownWindow, 'the harness window handle must be found');
  assert.notEqual(native.focusError, '(no error)', 'focusing the harness\'s own window must be refused');
  assert.match(native.focusError, /harness itself/i, `the refusal must say what the window is: ${native.focusError}`);
  assert.notEqual(native.keyError, '(no error)', 'a key sent to the harness\'s own window must be refused');
  assert.match(native.keyError, /harness itself/i, `the refusal must say what the window is: ${native.keyError}`);
  assert.equal(native.markedOwn, true, 'the harness\'s own window must be marked own:true in the inventory');

  console.log('LIVE STEERING + NATIVE WINDOW GUARD E2E OK');
} finally {
  await electronApp.close().catch(() => {});
}
