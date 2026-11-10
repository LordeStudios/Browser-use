// Drives the desktop app the way a paired MCP host does: pair, bind one tab,
// then send Electron input events to the bound BrowserView immediately and
// confirm the page actually received them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-paired-input-'));
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Input fixture</title>
<body style="margin:0">
<input id="field" style="position:absolute;left:0;top:0;width:400px;height:60px;font-size:20px">
<div id="log" style="position:absolute;top:80px">none</div>
<div style="height:3000px"></div>
<script>
  const log = document.getElementById('log');
  globalThis.__wheelEvents = [];
  document.getElementById('field').addEventListener('mousedown', () => { log.textContent = 'mousedown'; });
  window.addEventListener('keydown', (event) => { log.textContent = 'keydown:' + event.key; });
  window.addEventListener('wheel', (event) => { globalThis.__wheelEvents.push({ x: event.clientX, y: event.clientY, defaultPrevented: event.defaultPrevented }); }, { passive: true });
</script>`)}`;

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.'],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const window = await mainWindow(electronApp);
  await window.waitForSelector('#settings-toggle');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);
  await window.locator('#settings-toggle').click();
  await window.locator('#settings-panel').waitFor({ state: 'visible' });
  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());

  const offer = await window.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const bootstrap = await rpcResponse(configuration.endpoint, { pairingCode: offer.pairingCode }, 'initialize', {
    protocolVersion: '2024-11-05', clientInfo: { name: 'weak-mcp-input-e2e', version: '0.1' }
  });
  assert.equal(bootstrap.status, 200, `bootstrap initialize failed: ${JSON.stringify(bootstrap.body)}`);
  assert.match(bootstrap.sessionId || '', /^mcp-/, 'bootstrap must return an opaque Mcp-Session-Id');
  assert.equal(JSON.stringify(bootstrap.body).includes('capability'), false, 'weak hosts must not need a dynamic bearer handoff');
  const transport = { sessionId: bootstrap.sessionId };
  const retriedBootstrap = await rpcResponse(configuration.endpoint, { pairingCode: offer.pairingCode }, 'initialize', {
    protocolVersion: '2024-11-05', clientInfo: { name: 'weak-mcp-input-e2e', version: '0.1' }
  });
  assert.equal(retriedBootstrap.sessionId, transport.sessionId, 'replayed weak-host setup must recover the same MCP transport session');
  const initialized = await rpcResponse(configuration.endpoint, transport, 'notifications/initialized', {});
  assert.equal(initialized.status, 202);
  assert.equal(initialized.sessionId, transport.sessionId);

  // This session was created by an HTTP MCP request, not a renderer IPC call.
  // It must still render in the open Settings drawer as an unrestricted session.
  await window.waitForFunction((hostName) => document.querySelector('#mcp-sessions')?.textContent?.includes(hostName), 'weak-mcp-input-e2e');
  const pairedSession = (await window.evaluate(() => window.browserUseDesktop.mcpSessions()))
    .find((session) => session.host?.name === 'weak-mcp-input-e2e');
  assert.ok(pairedSession, 'the bootstrap host must appear in the local session list');
  assert.equal(pairedSession.fullAccess, true, 'a normal paired host must receive unrestricted MCP access');
  await window.waitForFunction(() => {
    const sessions = document.querySelector('#mcp-sessions');
    return sessions?.textContent?.includes('Full MCP access') && !sessions.querySelector('input[data-grant], input[data-input-grant]');
  });

  const tabs = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_get_tabs')).content[0].text);
  const tabId = tabs[0].id;
  await callTool(configuration.endpoint, transport, 'browser_bind_tab', { tabId });
  await window.locator('#settings-panel [data-close="settings"]').click();
  await window.locator('#settings-panel').waitFor({ state: 'hidden' });

  await electronApp.evaluate(async ({ BrowserWindow }, target) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = shell?.getBrowserViews()[0];
    if (!view) throw new Error('Browser-use page view is unavailable.');
    await view.webContents.loadURL(target);
  }, fixture);

  const executeResult = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_execute', {
    script: "document.body.dataset.mcpAccess = 'unrestricted'; return { unrestricted: document.body.dataset.mcpAccess === 'unrestricted' };"
  })).content[0].text);
  assert.deepEqual(executeResult.result, { unrestricted: true }, 'page commands must work immediately after pairing');

  const snapshot = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_dom_snapshot', { interactiveOnly: false })).content[0].text);
  const field = snapshot.elements.find((element) => element.id === 'field');
  assert.ok(field, `the input must be available for an immediate indexed click: ${JSON.stringify(snapshot.elements).slice(0, 400)}`);
  await callTool(configuration.endpoint, transport, 'browser_click_element', { index: field.index });
  assert.equal(await readFixture(electronApp, () => document.getElementById('log').textContent), 'mousedown', 'indexed click must work immediately after pairing');

  const mouseDownResult = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_mousedown', { x: 40, y: 20 })).content[0].text);
  const mouseUpResult = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_mouseup', { x: 40, y: 20 })).content[0].text);
  assert.equal(await readFixture(electronApp, () => document.getElementById('log').textContent), 'mousedown',
    `the bound tab must receive the click: ${JSON.stringify({ mouseDownResult, mouseUpResult })}`);

  await callTool(configuration.endpoint, transport, 'browser_type', { text: 'hello desktop' });
  assert.equal(await readFixture(electronApp, () => document.getElementById('field').value), 'hello desktop', 'insertText must reach the focused element');

  const dimensions = await readFixture(electronApp, () => ({ innerHeight: window.innerHeight, scrollHeight: document.documentElement.scrollHeight, bodyHeight: document.body.scrollHeight }));
  assert.ok(dimensions.scrollHeight > dimensions.innerHeight, `fixture must be scrollable: ${JSON.stringify(dimensions)}`);
  await readFixture(electronApp, () => window.scrollTo(0, 0));
  const scrollResult = JSON.parse((await callTool(configuration.endpoint, transport, 'browser_scroll', { deltaY: 300, x: 400, y: 300 })).content[0].text);
  await new Promise((resolve) => setTimeout(resolve, 750));
  const scrollState = await readFixture(electronApp, () => ({ scrollY: window.scrollY, wheelEvents: globalThis.__wheelEvents }));
  assert.ok(scrollState.scrollY > 0, `native wheel must advance the page, got ${JSON.stringify({ scrollState, scrollResult })}`);
  assert.ok(scrollState.wheelEvents.length > 0, 'page must receive the native wheel event');
  assert.ok(scrollResult.origin.x > 0 && scrollResult.origin.y > 0, `wheel origin must not default to page corner: ${JSON.stringify(scrollResult.origin)}`);

  // Holding a key then revoking must drop authorization AND deliver the matching
  // key-up, so no modifier stays stuck down in the page.
  await readFixture(electronApp, () => {
    globalThis.__observedKeyUps = [];
    window.addEventListener('keyup', (event) => globalThis.__observedKeyUps.push(event.key));
    return true;
  });
  await callTool(configuration.endpoint, transport, 'browser_key', { key: 'Shift', action: 'down' });
  assert.deepEqual(await readFixture(electronApp, () => globalThis.__observedKeyUps), [], 'holding Shift must not emit a key-up yet');

  await window.evaluate((sessionId) => window.browserUseDesktop.revokeMcpSession(sessionId), pairedSession.id);
  const revoked = await rpc(configuration.endpoint, transport, 'tools/call', { name: 'browser_key', arguments: { key: 'a' } });
  assert.equal(revoked.error.code, -32001, 'a revoked capability must no longer be authorized');

  const observedKeyUps = await readFixture(electronApp, () => globalThis.__observedKeyUps);
  assert.ok(observedKeyUps.includes('Shift'), `revoking must release the held modifier; page observed ${JSON.stringify(observedKeyUps)}`);

  console.log(JSON.stringify({ ok: true, tabId, observedKeyUps, scrollState, checks: 'header bootstrap, retry recovery, opaque MCP session, explicit bind, unrestricted page command, indexed click, mouse, key, text, native wheel scroll, revoke, modifier release' }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}

async function mainWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const window of electronApp.windows()) {
      if ((await window.url()).endsWith('/desktop/renderer/index.html')) return window;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main window did not load.');
}

function readFixture(electronApp, fn) {
  return electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = shell?.getBrowserViews()[0];
    if (!view) throw new Error('Browser-use page view is unavailable.');
    return view.webContents.executeJavaScript(`(${source})()`);
  }, fn.toString());
}

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return response.json();
}

async function rpc(endpoint, connection, method, params) {
  return (await rpcResponse(endpoint, connection, method, params)).body;
}

async function rpcResponse(endpoint, connection, method, params) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...connectionHeaders(connection) },
    body: JSON.stringify({ jsonrpc: '2.0', id: method === 'notifications/initialized' ? undefined : Date.now(), method, params })
  });
  const text = await response.text();
  return { status: response.status, sessionId: response.headers.get('mcp-session-id'), body: text ? JSON.parse(text) : null };
}

function connectionHeaders(connection) {
  if (typeof connection === 'string') return { authorization: `Bearer ${connection}` };
  if (connection?.sessionId) return { 'Mcp-Session-Id': connection.sessionId };
  if (connection?.pairingCode) return { 'X-Browser-Use-Pairing-Code': connection.pairingCode };
  return {};
}

async function callTool(endpoint, connection, name, args = {}) {
  const response = await rpc(endpoint, connection, 'tools/call', { name, arguments: args });
  assert.ok(!response.error, `${name} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}
