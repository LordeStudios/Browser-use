import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/index.js';
import { parseArgs } from '../src/config.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import { executeTool } from '../src/tools/toolExecutor.js';
import { killBrowserTree } from '../src/browser/chromeLauncher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = fs.readFileSync(path.join(__dirname, 'production-fixture.html'));

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      if (request.url === '/api/fail') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: false, error: 'Intentional fixture failure' }));
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(fixture);
    });

    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

async function runTool(ctx, registry, command, args = {}) {
  const result = await executeTool(ctx, registry, command, args);
  assert.equal(result.ok, true, `${command} failed: ${result.error}`);
  return result;
}

const fixtureServer = await startFixtureServer();
const options = {
  ...parseArgs(['--max-seconds', '45']),
  allowedRisks: ['read', 'browser-control', 'browser-edit'],
  nativePointer: false
};
const registry = createToolRegistry();
let ctx;

try {
  ctx = await createRuntime(options);
  await runTool(ctx, registry, 'browser.navigate', { url: fixtureServer.url });
  await runTool(ctx, registry, 'browser.typeSelector', { selector: '#name', text: 'Ada Lovelace' });
  await runTool(ctx, registry, 'browser.clickSelector', { selector: '#submit' });
  await runTool(ctx, registry, 'browser.wait', { ms: 250 });
  await runTool(ctx, registry, 'browser.assertText', { text: 'Submitted: Ada Lovelace' });

  const screenshot = await runTool(ctx, registry, 'browser.screenshot');
  assert.equal(fs.existsSync(screenshot.result.path), true, 'Screenshot artifact missing');

  const consoleResult = await runTool(ctx, registry, 'browser.consoleLogs');
  assert.equal(consoleResult.result.logs.some((entry) => entry.type === 'error'), true, 'Console error was not captured');

  const networkResult = await runTool(ctx, registry, 'browser.networkLogs');
  assert.equal(networkResult.result.requests.some((entry) => entry.status === 503), true, 'HTTP 503 was not captured');

  const failedResult = await runTool(ctx, registry, 'browser.failedRequests');
  assert.equal(failedResult.result.requests.some((entry) => entry.status === 503), true, 'Failed request report omitted HTTP 503');

  const actionTrace = await runTool(ctx, registry, 'browser.actionTrace');
  assert.equal(actionTrace.result.actions.some((entry) => entry.command === 'browser.clickSelector'), true, 'Action trace omitted click');

  console.log(JSON.stringify({
    ok: true,
    fixture: fixtureServer.url,
    screenshot: screenshot.result.path,
    consoleErrors: consoleResult.result.logs.filter((entry) => entry.type === 'error').length,
    failedRequests: failedResult.result.requests.length,
    actions: actionTrace.result.actions.length
  }, null, 2));
} finally {
  await ctx?.browser.close().catch(() => {});
  await killBrowserTree(ctx?.launch).catch(() => {});
  await new Promise((resolve) => fixtureServer.server.close(resolve));
}
