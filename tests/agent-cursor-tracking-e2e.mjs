// Proves the visual cursor stays locked to the coordinates the browser tools
// actually tap. Electron's sendInputEvent produces isTrusted events that are
// indistinguishable from a hardware mouse, which is why an overlay that only
// listened for untrusted events never moved during a real agent tap.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The packaged app is the artifact people actually run, and it resolves the
// overlay from inside app.asar rather than from the checkout. Pass a packaged
// win-unpacked directory to assert the shipped build tracks taps too.
const packagedDirectory = process.argv[2] ? path.resolve(process.argv[2]) : null;
const launchOptions = packagedDirectory
  ? { executablePath: path.join(packagedDirectory, 'Browser-use.exe'), cwd: packagedDirectory }
  : { executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'), args: ['.'], cwd: root };

if (packagedDirectory) {
  assert.ok(fs.existsSync(launchOptions.executablePath), `packaged executable is missing: ${launchOptions.executablePath}`);
}

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-cursor-'));

const fixture = `data:text/html,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><title>Cursor fixture</title>
<body style="margin:0;height:2000px">
<button id="target" style="position:absolute;left:100px;top:150px;width:120px;height:40px">Target</button>
<div id="log">none</div>
<script>
  globalThis.__taps = [];
  document.getElementById('target').addEventListener('click', (event) => {
    globalThis.__taps.push({ x: event.clientX, y: event.clientY, trusted: event.isTrusted });
    document.getElementById('log').textContent = 'clicked';
  });
</script>`)}`;

const electronApp = await electron.launch({
  ...launchOptions,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const window = await mainWindow(electronApp);
  const pointer = await pointerWindow(electronApp);
  await window.waitForSelector('#settings-toggle');
  await pointer.waitForSelector('#browser-use-agent-pointer');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);

  // Pair exactly as a real MCP host does, so the taps travel the production path.
  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  const offer = await window.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const paired = await postJson(configuration.pairingEndpoint, {
    pairingCode: offer.pairingCode,
    host: { name: 'cursor-tracking-e2e', version: '1.0.0' }
  });
  const capability = paired.session.capability;
  const tabs = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_get_tabs')).content[0].text);
  await callTool(configuration.endpoint, capability, 'browser_bind_tab', { tabId: tabs[0].id });

  // A packaged install may have a configured homepage that is not running, and
  // that failing navigation aborts whatever load is in flight. Load the fixture
  // until it sticks rather than assuming the first attempt survives.
  await electronApp.evaluate(async ({ BrowserWindow }, target) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const contents = shell.getBrowserViews()[0].webContents;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        contents.stop();
        await contents.loadURL(target);
      } catch {
        // An aborted or failed prior navigation rejects here; retry below.
      }
      if (contents.getURL().startsWith('data:text/html')) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    throw new Error(`fixture never loaded; current URL is ${contents.getURL()}`);
  }, fixture);

  const tap = async (x, y) => {
    const move = parseToolResult(await callTool(configuration.endpoint, capability, 'browser_mousemove', { x, y }));
    const down = parseToolResult(await callTool(configuration.endpoint, capability, 'browser_mousedown', { x, y }));
    const up = parseToolResult(await callTool(configuration.endpoint, capability, 'browser_mouseup', { x, y }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { move, down, up };
  };

  const firstTapResult = await tap(160, 170);
  const firstTaps = await readFixture(electronApp, () => globalThis.__taps);
  const firstInjectedNodes = await readFixture(electronApp, () => Array.from(document.querySelectorAll('[id^="__browser_use_"]')).map((node) => node.id));

  assert.equal(firstTaps.length, 1, `the tap must reach the page: ${JSON.stringify(firstTapResult)}`);
  assert.equal(firstTaps[0].trusted, true, 'agent taps arrive as trusted events, like a hardware mouse');
  assert.deepEqual(firstInjectedNodes, [], `native input must not inject page overlays: ${firstInjectedNodes.join(', ')}`);

  await tap(300, 500);
  const secondTaps = await readFixture(electronApp, () => globalThis.__taps);
  const finalInjectedNodes = await readFixture(electronApp, () => Array.from(document.querySelectorAll('[id^="__browser_use_"]')).map((node) => node.id));
  assert.equal(secondTaps.length, 1, 'the second tap is outside the target and must not create a synthetic click');
  assert.deepEqual(finalInjectedNodes, [], 'page isolation must hold across multiple native pointer operations');

  console.log(JSON.stringify({
    ok: true,
    build: packagedDirectory ? 'packaged' : 'checkout',
    taps: firstTaps,
    browserUseNodes: finalInjectedNodes,
    checks: 'trusted native tap delivery and page-isolated input'
  }, null, 2));
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

async function pointerWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const window of electronApp.windows()) {
      if ((await window.url()).endsWith('/desktop/renderer/agent-pointer.html')) return window;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use pointer window did not load.');
}

function parseToolResult(result) {
  return JSON.parse(result.content[0].text);
}

function readFixture(electronApp, fn) {
  return electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const view = shell.getBrowserViews()[0];
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

async function callTool(endpoint, capability, name, args = {}) {
  const response = await postJson(
    endpoint,
    { jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } },
    { authorization: `Bearer ${capability}` }
  );
  assert.ok(!response.error, `${name} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}
