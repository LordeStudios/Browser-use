// Full Electron acceptance: the visible app exits, the broker keeps the shell
// running, and a fresh Electron process restores the same scrollback.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { TerminalBrokerClient } = require('../desktop/terminal/terminalBrokerClient.cjs');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-terminal-persist-'));
const environment = {
  ...process.env,
  APPDATA: appDataDirectory,
  LOCALAPPDATA: appDataDirectory,
  BROWSER_USE_DESKTOP_MCP_PORT: '0',
  BROWSER_USE_TERMINAL_BROKER_IDLE_MS: '250'
};

let first;
let second;
try {
  first = await launch();
  let window = await mainWindow(first);
  await openTerminal(window);
  const active = await activeTerminal(window);
  assert.ok(active?.id, 'the visible terminal must bind a live broker session');
  await window.evaluate((id) => window.browserUseDesktop.terminalWrite(id, 'Write-Output BROWSERUSE_PERSISTED_TERMINAL\r'), active.id);
  await window.waitForFunction(
    () => document.querySelector('#terminal-surface')?.innerText?.includes('BROWSERUSE_PERSISTED_TERMINAL'),
    null,
    { timeout: 30_000 }
  );
  // The broker is intentionally a detached Electron-in-Node-mode child. The
  // Playwright convenience close waits on that detached child even though the
  // real Desktop process has exited, so request the real app quit directly.
  void first.evaluate(({ app }) => { app.quit(); return true; }).catch(() => {});
  first = null;
  await new Promise((resolve) => setTimeout(resolve, 500));

  second = await launch();
  window = await mainWindow(second);
  await openTerminal(window);
  await window.waitForFunction(
    () => document.querySelector('#terminal-surface')?.innerText?.includes('BROWSERUSE_PERSISTED_TERMINAL'),
    null,
    { timeout: 30_000 }
  );
  const recovered = await window.evaluate(() => document.querySelector('#terminal-surface')?.innerText || '');
  assert.match(recovered, /BROWSERUSE_PERSISTED_TERMINAL/, 'reopened Desktop must restore broker scrollback');
  await window.evaluate(async () => {
    const active = await window.browserUseDesktop.terminalActiveSession({ cols: 100, rows: 30 });
    if (active?.id) await window.browserUseDesktop.terminalDispose(active.id);
  });
  await shutdownBroker();
  console.log(JSON.stringify({ ok: true, restored: true }, null, 2));
} finally {
  await second?.close().catch(() => {});
  if (first) void first.evaluate(({ app }) => { app.quit(); return true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  // Chromium can retain a transient Windows profile-file handle after the app
  // and broker have both stopped. It is outside the product assertion, so do
  // not turn a successful persistence proof into a false test failure.
  try { fs.rmSync(appDataDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
}

function launch() {
  return electron.launch({ executablePath: electronExecutable, args: ['.', `--user-data-dir=${appDataDirectory}`], cwd: root, env: environment });
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

async function openTerminal(window) {
  await window.waitForSelector('#terminal-toggle');
  await window.click('#terminal-toggle');
  await window.waitForSelector('#terminal-panel:not([hidden])');
  await window.waitForSelector('#terminal-surface .xterm-screen', { timeout: 20_000 });
}

async function activeTerminal(window) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const session = await window.evaluate(() => window.browserUseDesktop.terminalLayout().then((layout) => layout.activeSession));
    if (session?.id) return session;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function shutdownBroker() {
  const installationId = fs.readFileSync(path.join(appDataDirectory, 'installation-id'), 'utf8').trim();
  const profile = crypto.createHash('sha256').update(installationId).digest('hex').slice(0, 32);
  const secret = fs.readFileSync(path.join(appDataDirectory, 'terminal-broker-secret'), 'utf8').trim();
  const pipePath = process.platform === 'win32'
    ? `\\\\.\\pipe\\browser-use-terminal-${profile}`
    : path.join(appDataDirectory, `terminal-${profile}.sock`);
  const client = new TerminalBrokerClient({
    pipePath,
    secret,
    brokerPath: path.join(root, 'desktop', 'terminal', 'terminalBroker.cjs'),
    executablePath: process.execPath,
    onData: () => {},
    onExit: () => {}
  });
  try {
    await client.connect();
    await client.shutdown();
  } finally {
    client.disconnect();
  }
}
