import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-background-'));
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const soakMs = Number(process.env.BROWSER_USE_BACKGROUND_SOAK_MS || 330_000);
assert.ok(Number.isFinite(soakMs) && soakMs >= 0);
const fixture = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!doctype html><title>Background MCP fixture</title><button id="count" onclick="window.clicks++;this.textContent=window.clicks">Click</button><script>window.ticks=0;window.clicks=0;window.inputLog=[];for(const e of ['mousedown','mouseup','click','pointerdown','pointerup'])document.addEventListener(e,event=>window.inputLog.push({event:e,x:event.clientX,y:event.clientY,target:event.target.id}));setInterval(()=>window.ticks++,50);</script>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;
const env = { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_DESKTOP_TRAY: '1', BROWSER_USE_START_URL: `${fixtureUrl}/a` };
delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
    args: ['.', `--user-data-dir=${appData}`], cwd: root, env,
  });
  const deadline = Date.now() + 30_000;
  let shell;
  while (!shell && Date.now() < deadline) {
    shell = desktop.windows().find(w => w.url().endsWith('/desktop/renderer/index.html'));
    if (!shell) await delay(50);
  }
  assert.ok(shell, 'desktop chrome must launch');
  await shell.waitForSelector('#settings-toggle');
  const configuration = await shell.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  const { endpoint } = configuration;
  let sequence = 0;
  const headers = await fetch(`${endpoint}/authenticate`).then(r => r.json());
  const initialize = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method: 'initialize', params: { protocolVersion: '2024-11-05', clientInfo: { name: 'background-lifetime-e2e', version: '1' } } }),
  });
  assert.equal(initialize.status, 200);
  const sessionId = initialize.headers.get('mcp-session-id');
  assert.match(sessionId, /^mcp-/);
  const rpc = async (method, params = {}) => {
    const r = await fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(15_000),
    });
    const body = await r.json();
    assert.equal(r.status, 200);
    assert.equal(body.error, undefined, `retained MCP session must work: ${JSON.stringify(body.error)}`);
    return body.result;
  };
  const tool = async (name, args = {}) => {
    const result = await rpc('tools/call', { name, arguments: args });
    assert.notEqual(result.isError, true, `${name} failed: ${JSON.stringify(result.content).slice(0,300)}`);
    return JSON.parse(result.content[0].text);
  };
  const tabs = await tool('browser_get_tabs');
  const a = tabs[0].id;
  const b = (await shell.evaluate(url => window.browserUseDesktop.newTab(url), `${fixtureUrl}/b`)).id;
  assert.ok(b, 'second managed tab must exist');
  await tool('browser_bind_tab', { tabId: a });
  await tool('browser_bind_tab', { tabId: b });
  await rpc('tools/list');
  await tool('browser_bind_tab', { tabId: a });
  await tool('browser_execute', { script: 'return { ready: document.readyState };' });
  console.log('PASS same transport survives A -> B -> A rebind');
  await shell.evaluate(id => window.browserUseDesktop.selectTab(id), a);

  const shellState = () => desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    return { visible: w.isVisible(), minimized: w.isMinimized(), focused: w.isFocused(), destroyed: w.isDestroyed(), pid: process.pid,
      backgroundThrottling: w.getBrowserViews().map(v => v.webContents.getBackgroundThrottling()) };
  });
  const mainPid = (await shellState()).pid;
  assert.ok((await shellState()).backgroundThrottling.every(v => v === false));
  await desktop.evaluate(async ({ BrowserWindow }) => {
    const foreground = new BrowserWindow({ width: 320, height: 220, title: 'Foreground fixture' });
    await foreground.loadURL('data:text/html,<title>Foreground fixture</title>Background connection test');
    foreground.show();foreground.focus();
  });
  await delay(500);
  assert.equal((await shellState()).focused, false);
  const before = (await tool('browser_execute', { script: 'return { ticks: window.ticks };' })).result.ticks;
  await delay(600);
  const after = (await tool('browser_execute', { script: 'return { ticks: window.ticks };' })).result.ticks;
  assert.ok(after > before + 2, 'page timers must run when unfocused');
  console.log('PASS unfocused page timers and MCP calls');

  await desktop.evaluate(({ BrowserWindow, app }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    globalThis.__backgroundHideEvents = 0;
    globalThis.__backgroundWindowEvents = [];
    w.setTitle('Browser-use background verification (temporary)');
    for (const name of ['minimize', 'restore', 'show', 'hide', 'focus', 'blur']) {
      w.on(name, () => globalThis.__backgroundWindowEvents.push({ name, at: Date.now(), minimized: w.isMinimized(), visible: w.isVisible() }));
    }
    for (const name of ['activate', 'second-instance']) {
      app.on(name, () => globalThis.__backgroundWindowEvents.push({ name, at: Date.now() }));
    }
    w.on('hide', () => { globalThis.__backgroundHideEvents += 1; });
    w.minimize();
  });
  await delay(500);
  assert.equal((await shellState()).minimized, true, 'minimize must retain normal taskbar minimization');
  assert.equal(await desktop.evaluate(() => globalThis.__backgroundHideEvents), 0, 'minimize must not hide the window from the taskbar');
  const snapshot = await tool('browser_dom_snapshot');
  const button = snapshot.elements.find(el => el.id === 'count');
  assert.ok(button, 'hidden tab still has DOM evidence');
  const clicked = await tool('browser_click_element', { index: button.index });
  await delay(200);
  const clickEvidence = (await tool('browser_execute', { script: 'return { clicks: window.clicks, inputLog: window.inputLog, width: innerWidth, height: innerHeight };' })).result;
  assert.equal(clickEvidence.clicks, 1, `background native input still works: ${JSON.stringify({ clicked, clickEvidence })}`);
  assert.equal((await shellState()).minimized, true, 'MCP tools must not restore the minimized window');
  assert.equal(await desktop.evaluate(() => globalThis.__backgroundHideEvents), 0);
  console.log(`PASS normal taskbar minimization and background input; starting ${soakMs}ms no-traffic soak`);
  await delay(soakMs);
  await rpc('ping');
  const still = await tool('browser_get_tabs');
  assert.equal(still.length, 2);
  assert.equal((await shellState()).pid, mainPid);
  assert.equal((await shellState()).minimized, true, `minimized state changed during the soak: ${JSON.stringify(await desktop.evaluate(() => globalThis.__backgroundWindowEvents))}`);
  assert.equal(await desktop.evaluate(() => globalThis.__backgroundHideEvents), 0);
  console.log('PASS idle paired session survives minimized without traffic');

  await desktop.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    w.restore();
  });
  await delay(500);
  assert.equal((await shellState()).visible, true, 'ordinary restore must show the same window without an explicit show or relaunch');
  assert.equal((await shellState()).minimized, false);
  assert.equal((await shellState()).pid, mainPid);
  const restoredEvidence = (await tool('browser_execute', { script: 'return { clicks: window.clicks };' })).result;
  assert.equal(restoredEvidence.clicks, 1, 'restore must retain the live website state');
  await shell.locator('#settings-toggle').click();
  const settingsOpen = await shell.evaluate(() => window.browserUseDesktop.viewportMetrics());
  assert.equal(settingsOpen.activeDrawer, 'settings');
  await shell.screenshot({ path: path.join(root, 'scratch', 'desktop-minimize-restored.png') });
  await shell.evaluate(() => window.browserUseDesktop.closeOverlay());
  console.log('PASS taskbar restore, preserved website state, and Settings interaction');
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/desktop/renderer/index.html')).close());
  await delay(500);
  assert.equal((await shellState()).destroyed, false);
  assert.equal((await shellState()).visible, false, 'title-bar close must keep app alive in tray');
  await tool('browser_get_tabs');
  await shell.evaluate(id => window.browserUseDesktop.closeTab(id), a);
  await tool('browser_bind_tab', { tabId: b });
  assert.equal((await tool('browser_execute', { script: 'return { path: location.pathname };' })).result.path, '/b');
  console.log('PASS title-bar close and bound-tab close preserve session');

  await quitDesktop(desktop);desktop = null;
  await assert.rejects(fetch(endpoint, { signal: AbortSignal.timeout(2000) }), 'explicit app quit must stop listener');
  console.log(JSON.stringify({ ok: true, verification: 'REAL_PLAYWRIGHT_VERIFIED', soakMs, checks: ['rebind', 'blur', 'taskbar-minimize', 'restore-with-state', 'settings', 'tray', 'timers', 'native-input', 'quiet-idle', 'window-close', 'tab-close', 'quit'] }));
} finally {
  if (desktop) await quitDesktop(desktop).catch(() => {});
  await new Promise(resolve => fixture.close(resolve));
  fs.rmSync(appData, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

async function quitDesktop(instance) {
  await instance.evaluate(({ BrowserWindow }) => {
    const foreground = BrowserWindow.getAllWindows().find(w => w.getTitle() === 'Foreground fixture');
    foreground?.destroy();
  });
  await instance.close();
}
