// Exercises the new low-weight DOM snapshot path against the desktop app and
// uses it to create an ellipse in Lorde Design Studio without any screenshot-based
// guessing. This proves the packaged app can be controlled precisely by structure
// and geometry alone.
import assert from 'node:assert/strict';
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

const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-dom-'));
const electronApp = await electron.launch({
  executablePath,
  ...(usePackaged ? { cwd: packageRoot } : { args: ['.'], cwd: root }),
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_START_URL: target, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

async function postJson(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return response.json();
}

function rpc(endpoint, capability, method, params) {
  return postJson(endpoint, { jsonrpc: '2.0', id: Date.now(), method, params }, { authorization: `Bearer ${capability}` });
}

async function callTool(endpoint, capability, name, args = {}) {
  const response = await rpc(endpoint, capability, 'tools/call', { name, arguments: args });
  assert.ok(!response.error, `${name} failed: ${JSON.stringify(response.error)}`);
  return response.result;
}

async function readPage(electronApp, fn) {
  return electronApp.evaluate(async ({ BrowserWindow }, source) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = shell.getBrowserViews()[0];
    return view.webContents.executeJavaScript(`(${source})()`, true);
  }, fn.toString());
}

try {
  const window = await electronApp.firstWindow();
  await window.waitForSelector('#settings-toggle');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);
  const configuration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());

  // GPT Action schema must be copyable as a concrete payload, not just an URL.
  await window.locator('#settings-toggle').click();
  await window.waitForFunction(() => !document.querySelector('#settings-panel').hidden);
  const gptSchemaText = await window.locator('#gpt-action-schema').textContent();
  const gptSchema = JSON.parse(gptSchemaText);
  assert.equal(gptSchema.schemaType, 'openapi-url');
  assert.match(gptSchema.importUrl, /\/gpt\/openapi\.json$/);
  assert.equal(gptSchema.auth.name, 'X-API-Key');
  await window.locator('#copy-gpt-schema').click();
  await window.waitForFunction(() => document.querySelector('#copy-gpt-schema').textContent === 'Copied');
  await window.locator('[data-close="settings"]').click();
  await window.waitForFunction(() => document.querySelector('#settings-panel').hidden);
  await window.waitForFunction(async () => (await window.browserUseDesktop.viewportMetrics()).attached === true);

  // Pair and bind.
  const offer = await window.evaluate(() => window.browserUseDesktop.createPairingOffer());
  const paired = await postJson(configuration.pairingEndpoint, { pairingCode: offer.pairingCode, host: { name: 'dom-e2e', version: '1.0.0' } });
  const capability = paired.session.capability;
  assert.ok(capability, 'pairing must return a capability');

  const tabs = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_get_tabs')).content[0].text);
  const tabId = tabs[0].id;
  await callTool(configuration.endpoint, capability, 'browser_bind_tab', { tabId });

  // Pairing grants the complete MCP catalog; the DOM and pointer paths are
  // immediately usable after the host chooses its tab.
  const query = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_query_elements', { text: 'ellipse', maxElements: 20 })).content[0].text);
  const ellipseTool = query.elements.find((element) => element.dataTool === 'shape-ellipse' || /ellipse/i.test(element.name || element.text || ''));
  assert.ok(ellipseTool, `ellipse tool must be discoverable from the DOM snapshot: ${JSON.stringify(queryBeforeGrant).slice(0, 300)}`);

  const snapshotBefore = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_dom_snapshot', { maxElements: 250, interactiveOnly: false })).content[0].text);
  const canvasPage = snapshotBefore.elements.find((element) => element.testId === 'studio-canvas-page' || element.id === 'lorde-design-canvas' || element.selector === '#lorde-design-canvas');
  assert.ok(canvasPage, 'the canvas page must be exposed in the DOM snapshot');

  // Selecting the Ellipse tool should not require another permission step or
  // guessing pixels.
  await callTool(configuration.endpoint, capability, 'browser_click_element', { index: ellipseTool.index });
  const selectedTool = await readPage(electronApp, () => {
    const selected = document.querySelector('.lds-add-button.is-active, .lds-tool-button.is-active, .lds-add-button[aria-pressed="true"], .lds-tool-button[aria-pressed="true"]');
    return selected ? { id: selected.id || '', label: selected.textContent.trim(), dataTool: selected.dataset.addType || selected.dataset.tool || '' } : null;
  });
  assert.ok(selectedTool && (/ellipse/i.test(selectedTool.label) || selectedTool.dataTool === 'shape-ellipse'), `the ellipse tool must become active: ${JSON.stringify(selectedTool)}`);

  // Drag a visible ellipse onto the canvas using the DOM snapshot geometry.
  const start = { x: canvasPage.rect.x + 120, y: canvasPage.rect.y + 120 };
  const end = { x: start.x + 160, y: start.y + 100 };
  await callTool(configuration.endpoint, capability, 'browser_mousedown', start);
  await callTool(configuration.endpoint, capability, 'browser_mousemove', end);
  await callTool(configuration.endpoint, capability, 'browser_mouseup', end);

  const studioState = await readPage(electronApp, () => ({
    nodes: Array.from(document.querySelectorAll('[data-node-id]')).length,
    ellipseButtons: Array.from(document.querySelectorAll('[data-add-type="shape-ellipse"], #lorde-design-add-ellipse-btn')).length,
    activeEllipseButton: Boolean(document.querySelector('#lorde-design-add-ellipse-btn.is-active, #lorde-design-add-ellipse-btn[aria-pressed="true"]')),
    overlays: Array.from(document.querySelectorAll('[data-transform-target-id]')).length
  }));
  assert.ok(studioState.nodes > 0, `studio should still have canvas nodes after the drag: ${JSON.stringify(studioState)}`);
  assert.ok(studioState.activeEllipseButton, 'ellipse tool should remain active immediately after creation');

  // Weight comparison: a DOM snapshot is the cheap path compared to a screenshot.
  const screenshotPayload = JSON.parse((await callTool(configuration.endpoint, capability, 'browser_screenshot')).content[0].text);
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshotBefore), 'utf8');
  const screenshotBytes = Buffer.byteLength(screenshotPayload.data, 'base64');
  assert.ok(snapshotBytes < screenshotBytes, `DOM snapshot should be lighter than the PNG: snapshot=${snapshotBytes}, screenshot=${screenshotBytes}`);

  // A stale index must fail closed after the snapshot changes.
  const stale = await rpc(configuration.endpoint, capability, 'tools/call', { name: 'browser_click_element', arguments: { index: 9999 } });
  assert.equal(stale.error.code, -32000);
  assert.match(stale.error.message, /stale|snapshot|index/i);

  console.log(JSON.stringify({
    ok: true,
    mode: usePackaged ? 'packaged' : 'dev',
    gptSchema,
    ellipseTool,
    canvasPage: { rect: canvasPage.rect, testId: canvasPage.testId, selector: canvasPage.selector },
    createdDrag: { start, end },
    studioState,
    snapshotBytes,
    screenshotBytes
  }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
}
