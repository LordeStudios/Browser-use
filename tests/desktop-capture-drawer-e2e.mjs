// End-to-end proof for the pairing deadlock: a host pairs from inside the Settings
// drawer, which detaches the browsing view, so its first browser_screenshot used to
// hang the HTTP request forever. This drives the real packaged app over the real
// Streamable HTTP transport and asserts the call returns a usable error promptly,
// then succeeds once the drawer closes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'desktop-release', 'win-unpacked');
const packagedExecutable = path.join(packageRoot, 'Browser-use.exe');
const usePackaged = fs.existsSync(packagedExecutable) && process.env.PROBE_DEV !== '1';
const executablePath = usePackaged ? packagedExecutable : path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-capture-e2e-'));
const electronApp = await electron.launch({
  executablePath,
  ...(usePackaged ? { cwd: packageRoot } : { args: ['.'], cwd: root }),
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_START_URL: 'https://example.com', BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

// Bounded so a regression fails the test instead of hanging the suite.
async function mainRendererWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main renderer did not load within 30 seconds.');
}

async function callTool(endpoint, capability, name, args = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${capability}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      signal: controller.signal
    });
    return { body: await response.json(), elapsed: Date.now() - started };
  } catch (error) {
    if (error.name === 'AbortError') return { timedOut: true, elapsed: Date.now() - started };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

try {
  const window = await mainRendererWindow(electronApp);
  await window.waitForSelector('#settings-toggle');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);

  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());

  // Pair exactly the way a host does: from inside the open Settings drawer.
  await window.locator('#settings-toggle').click();
  await window.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
  await window.locator('#create-pairing').click();
  await window.waitForFunction(() => document.querySelector('#mcp-command').textContent.includes('pairingCode'));
  const pairingCode = await window.evaluate(() => JSON.parse(document.querySelector('#mcp-command').textContent).pairingCode);

  const paired = await fetch(configuration.pairingEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode, host: { name: 'Capture regression host', version: '1.0.0' } })
  }).then((response) => response.json());
  const capability = paired.session.capability;

  await callTool(configuration.endpoint, capability, 'browser_bind_tab', { tabId: 'tab-1' });

  // The drawer remains above a visible BrowserView so settings can coexist with
  // the live page. A capture must be bounded and return either a usable image or
  // a clear painted-view error without holding the paired host request open.
  const drawerMetrics = await window.evaluate(() => window.browserUseDesktop.viewportMetrics());
  const blocked = await callTool(configuration.endpoint, capability, 'browser_screenshot');
  assert.ok(!blocked.timedOut, 'a screenshot with the drawer open must not hang the HTTP request');
  assert.ok(blocked.elapsed < 15_000, `the call must return promptly, took ${blocked.elapsed}ms`);
  const blockedMessage = blocked.body?.error?.message || blocked.body?.result?.content?.[0]?.text || '';
  if (!drawerMetrics.attached) assert.match(blockedMessage, /painted|drawer|timed out/i, `the error must explain the cause, got: ${blockedMessage}`);
  else assert.ok(!blocked.body?.error, `an attached view must capture while settings is open: ${JSON.stringify(blocked.body?.error)}`);

  // Closing the drawer reattaches the view, and capture must then succeed.
  await window.locator('[data-close="settings"]').click();
  await window.waitForFunction(() => document.querySelector('#settings-panel').hidden);
  await window.waitForFunction(async () => (await window.browserUseDesktop.viewportMetrics()).attached === true);

  const allowed = await callTool(configuration.endpoint, capability, 'browser_screenshot');
  assert.ok(!allowed.timedOut, 'a screenshot with the drawer closed must not hang');
  // A successful tool result reports no error at all rather than isError: false.
  assert.ok(!allowed.body?.error, `capture must not report a JSON-RPC error: ${JSON.stringify(allowed.body?.error)}`);
  assert.notEqual(allowed.body?.result?.isError, true, `capture must succeed once reattached: ${JSON.stringify(allowed.body).slice(0, 300)}`);
  const payload = JSON.parse(allowed.body.result.content[0].text);
  assert.equal(payload.mimeType, 'image/png');
  const png = Buffer.from(payload.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG', 'the payload must be a real PNG');
  assert.ok(png.length > 1000, 'the capture must contain image data');

  console.log(JSON.stringify({
    ok: true,
    mode: usePackaged ? 'packaged' : 'dev',
    drawerOpenCall: { elapsedMs: blocked.elapsed, message: blockedMessage.slice(0, 120) },
    drawerClosedCall: { elapsedMs: allowed.elapsed, bytes: png.length, dimensions: `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}` }
  }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}
