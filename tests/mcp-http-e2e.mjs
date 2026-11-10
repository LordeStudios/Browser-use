// Real-browser acceptance for the session-based HTTP MCP daemon + GPT bridge.
// Proves the Studio-style contract: one persistent browser runtime, sessions
// keyed by Mcp-Session-Id that survive client reconnects, bearer-token auth,
// and a ChatGPT GPT Action surface over the same registry.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const MCP_PORT = 8791;
const GPT_KEY = 'test-gpt-key-0123456789abcdef';

const daemon = spawn('node', ['src/index.js', '--mcp-http', '--mcp-port', String(MCP_PORT), '--gpt-key', GPT_KEY, '--no-native-pointer'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe']
});
let daemonOut = '';
let daemonErr = '';
daemon.stdout.on('data', (chunk) => { daemonOut += chunk.toString(); });
daemon.stderr.on('data', (chunk) => { daemonErr += chunk.toString(); });

const base = `http://127.0.0.1:${MCP_PORT}`;

async function waitForDaemon(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) {
      throw new Error(`Daemon exited early (${daemon.exitCode}): ${daemonErr || daemonOut}`);
    }
    try {
      const response = await fetch(`${base}/mcp`, { method: 'GET' });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Daemon did not start listening: ${daemonErr || daemonOut}`);
}

async function issueToken(key = 'e2e-connection-key') {
  const response = await fetch(`${base}/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  const body = await response.json();
  assert.equal(response.status, 200, `token endpoint failed: ${JSON.stringify(body)}`);
  assert.ok(body.token, 'token endpoint returned no token');
  return body.token;
}

async function rpc(token, sessionId, payload) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: text ? JSON.parse(text) : null
  };
}

try {
  await waitForDaemon();

  // 1. Auth is enforced.
  const unauthorized = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' })
  });
  assert.equal(unauthorized.status, 401, 'POST /mcp without bearer token must be rejected');

  const token = await issueToken();

  // 2. initialize opens a session and returns Mcp-Session-Id.
  const initialize = await rpc(token, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'mcp-http-e2e', version: '1' } }
  });
  assert.equal(initialize.body.result.serverInfo.name, 'browser-use');
  assert.ok(initialize.sessionId?.startsWith('sess-'), 'initialize must return an Mcp-Session-Id header');
  const sessionA = initialize.sessionId;

  // 3. Unknown session ids are rejected with the re-initialize contract.
  const unknownSession = await rpc(token, 'sess-does-not-exist', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(unknownSession.body.error.code, -32001, 'unknown session must fail with -32001');

  // 4. tools/list returns full schemas inside the session.
  const toolList = await rpc(token, sessionA, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
  assert.equal(toolList.sessionId, sessionA, 'responses must echo the session id');
  const typeSelectorTool = toolList.body.result.tools.find((tool) => tool.name === 'browser_type_selector');
  assert.deepEqual(typeSelectorTool.inputSchema.required, ['selector', 'text']);

  // 5. tools/call drives the one shared live browser.
  const marker = `mcp-session-e2e-${Date.now()}`;
  const html = `data:text/html,${encodeURIComponent(`<title>${marker}</title><main>persistent session fixture</main>`)}`;
  const navigate = await rpc(token, sessionA, {
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url: html } }
  });
  assert.equal(Boolean(navigate.body.result.isError), false, `navigate failed: ${JSON.stringify(navigate.body)}`);

  // 6. A SECOND client (new initialize) sees the same live browser state —
  // this is the session-persistence upgrade: no relaunch, no state loss.
  const tokenB = await issueToken('second-client-key');
  const initializeB = await rpc(tokenB, null, {
    jsonrpc: '2.0', id: 5, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'second-client', version: '1' } }
  });
  const sessionB = initializeB.sessionId;
  assert.ok(sessionB && sessionB !== sessionA, 'second client must get its own session id');
  const stateB = await rpc(tokenB, sessionB, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'browser_get_state', arguments: {} }
  });
  const statePayload = JSON.parse(stateB.body.result.content[0].text);
  assert.ok(
    JSON.stringify(statePayload).includes(marker),
    `second session must observe the first session's live page; got: ${JSON.stringify(statePayload.result?.info || statePayload).slice(0, 300)}`
  );

  // 7. DELETE closes only the session record; the browser survives.
  const closeA = await fetch(`${base}/mcp`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': sessionA }
  });
  assert.equal((await closeA.json()).closed, true, 'DELETE must close session A');
  const closedCall = await rpc(token, sessionA, { jsonrpc: '2.0', id: 7, method: 'ping' });
  assert.equal(closedCall.body.error.code, -32001, 'closed session must be unknown');
  const stillAlive = await rpc(tokenB, sessionB, { jsonrpc: '2.0', id: 8, method: 'ping' });
  assert.deepEqual(stillAlive.body.result, {}, 'session B must survive closing session A');

  // 8. GPT Action bridge: key enforcement, OpenAPI from the registry, tool call.
  const gptUnauthorized = await fetch(`${base}/gpt/tools`);
  assert.equal(gptUnauthorized.status, 401, 'GPT bridge must require X-API-Key');
  const openapi = await (await fetch(`${base}/gpt/openapi.json`, { headers: { 'X-API-Key': GPT_KEY } })).json();
  assert.equal(openapi.openapi, '3.1.0');
  assert.ok(openapi.paths['/gpt/call/browser_get_state'], 'OpenAPI must expose browser_get_state');
  assert.equal(openapi.components.securitySchemes.ApiKeyAuth.name, 'X-API-Key');
  const gptCall = await fetch(`${base}/gpt/call/browser_get_state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': GPT_KEY },
    body: '{}'
  });
  const gptBody = await gptCall.json();
  assert.equal(gptBody.ok, true, `GPT call failed: ${JSON.stringify(gptBody)}`);
  assert.ok(gptBody.result.text.includes(marker), 'GPT bridge must observe the same persistent browser session');

  console.log(JSON.stringify({
    ok: true,
    sessions: { a: sessionA, b: sessionB },
    tools: toolList.body.result.tools.length,
    gptPaths: Object.keys(openapi.paths).length
  }, null, 2));
} finally {
  // Windows cannot deliver SIGTERM handlers to a child; kill the entire tree so
  // the launched Chromium never lingers after the test.
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/T', '/F', '/PID', String(daemon.pid)], { stdio: 'ignore' });
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
  } else {
    daemon.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (daemon.exitCode === null) daemon.kill('SIGKILL');
  }
}
