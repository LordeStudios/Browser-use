// GEN9 — MCP client (desktop/agent/mcpClient.cjs).
// Covers: a tiny stdio MCP test-server fixture — connect/initialize handshake,
// tools/list discovery, a tools/call round-trip, ping; the http transport
// against a minimal streamable-HTTP server; config persistence (user + repo
// scopes, repo overrides by name, enable/disable, auth headers, remove);
// namespacing mcp__<server>__<tool>; registry connectAll/status/stopAll.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  StdioTransport,
  HttpTransport,
  McpClientConnection,
  McpConfigStore,
  McpRegistry,
  namespacedToolName,
  parseNamespacedToolName,
  sanitizeServerName,
  normalizeServerConfig,
  mergeConfigs,
  PROTOCOL_VERSION
} = require('../desktop/agent/mcpClient.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(HERE, 'fixtures', 'mini-mcp-server.cjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function fixtureConfig() {
  return { command: process.execPath, args: [FIXTURE_SERVER] };
}

test('stdio transport: initialize handshake, tools/list discovery, tools/call round-trip, ping', async () => {
  const transport = new StdioTransport({ ...fixtureConfig(), spawnFn: spawn }).start();
  try {
    const initialized = await new Promise((resolve, reject) => {
      transport.pending.set(1, { resolve, reject, timer: null });
      transport.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test' } } });
    });
    assert.equal(initialized.serverInfo.name, 'mini-mcp');
    transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = await new Promise((resolve, reject) => {
      transport.pending.set(2, { resolve, reject, timer: null });
      transport.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    });
    assert.deepEqual(tools.tools.map(tool => tool.name), ['echo', 'add']);

    const echoed = await new Promise((resolve, reject) => {
      transport.pending.set(3, { resolve, reject, timer: null });
      transport.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'round trip' } } });
    });
    assert.equal(echoed.content[0].text, 'echo: round trip');
    assert.equal(echoed.isError, false);

    const pong = await new Promise((resolve, reject) => {
      transport.pending.set(4, { resolve, reject, timer: null });
      transport.send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    });
    assert.deepEqual(pong, {});
  } finally {
    transport.close();
  }
});

test('connection: connect() runs the handshake and discovers tools; callTool round-trips', async () => {
  const connection = new McpClientConnection({ name: 'mini', config: fixtureConfig(), spawnFn: spawn });
  try {
    const status = await connection.connect();
    assert.equal(status.state, 'ready');
    assert.equal(status.toolCount, 2);
    assert.equal(status.handshakeMs >= 0, true);
    const result = await connection.callTool('add', { a: 19, b: 23 });
    assert.equal(result.content[0].text, '42');
  } finally {
    connection.stop();
  }
});

test('http transport: JSON-RPC POST round-trip (initialize, tools/list, tools/call)', async () => {
  // Minimal streamable-HTTP MCP server: POST JSON-RPC -> JSON reply.
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body || '{}');
      const reply = (result) => {
        response.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'test-session-1' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      if (message.method === 'initialize') {
        reply({ protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'mini-http', version: '1.0.0' } });
      } else if (message.method === 'tools/list') {
        reply({ tools: [{ name: 'shout', description: 'Uppercase the text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
      } else if (message.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: String(message.params?.arguments?.text || '').toUpperCase() }], isError: false });
      } else {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'nope' } }));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const transport = new HttpTransport({ url: `http://127.0.0.1:${port}/mcp` }).start();
  try {
    const initialized = await transport.send({ jsonrpc: '2.0', id: 10, method: 'initialize', params: {} });
    assert.equal(initialized.serverInfo.name, 'mini-http');
    assert.equal(transport.sessionId, 'test-session-1', 'session header is retained');
    const tools = await transport.send({ jsonrpc: '2.0', id: 11, method: 'tools/list' });
    assert.equal(tools.tools[0].name, 'shout');
    const called = await transport.send({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'shout', arguments: { text: 'hello' } } });
    assert.equal(called.content[0].text, 'HELLO');
  } finally {
    transport.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('config persistence: user + repo scopes, repo overrides by name, enable/disable, auth, remove', () => {
  const home = tmpDir('bu-mcp-home-');
  const repo = tmpDir('bu-mcp-repo-');
  const userFile = path.join(home, '.browser-use-cli', 'mcp.json');
  const repoFile = path.join(repo, '.browser-use', 'mcp.json');
  const store = new McpConfigStore({ userFile, repoFile });

  store.addServer({ scope: 'user', name: 'search', config: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer one' } } });
  store.addServer({ scope: 'user', name: 'files', config: fixtureConfig() });
  // Repo scope overrides the user's 'search' by name.
  store.addServer({ scope: 'repo', name: 'search', config: { url: 'https://repo-override.example.com/mcp' } });

  let { merged } = store.load();
  assert.equal(merged.search.url, 'https://repo-override.example.com/mcp');
  assert.equal(merged.search.scope, 'repo');
  assert.equal(merged.files.scope, 'user');
  assert.equal(merged.files.enabled, true, 'servers default enabled');

  // Enable/disable writes the OWNING scope's file.
  assert.equal(store.setEnabled('files', false).enabled, false);
  ({ merged } = store.load());
  assert.equal(merged.files.enabled, false);
  const userRaw = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(userRaw.mcpServers.files.enabled, false);
  assert.equal(JSON.parse(fs.readFileSync(repoFile, 'utf8')).mcpServers.files, undefined, 'repo file untouched');

  // Auth headers only apply to http servers.
  store.setHeader('search', 'X-Api-Key', 'secret-123');
  ({ merged } = store.load());
  assert.equal(merged.search.headers['X-Api-Key'], 'secret-123');
  assert.throws(() => store.setHeader('files', 'X-Api-Key', 'x'), /stdio server/);

  // Remove deletes from the owning scope (repo), revealing the user entry.
  assert.equal(store.removeServer('search'), true);
  ({ merged } = store.load());
  assert.equal(merged.search.scope, 'user');
  assert.equal(merged.search.url, 'https://mcp.example.com/mcp');
  assert.equal(merged.files.scope, 'user');
  // Only the repo file lost the entry.
  const userRaw2 = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  assert.equal(userRaw2.mcpServers.search.url, 'https://mcp.example.com/mcp');
});

test('namespacing: mcp__<server>__<tool> build + parse, server-name sanitization', () => {
  assert.equal(namespacedToolName('search', 'web_query'), 'mcp__search__web_query');
  assert.deepEqual(parseNamespacedToolName('mcp__search__web_query'), { server: 'search', tool: 'web_query' });
  assert.equal(parseNamespacedToolName('browser_click'), null);
  assert.equal(namespacedToolName('ok-name', 'tool.name'), 'mcp__ok-name__tool_name', 'tool-name dots munge to underscores');
  assert.throws(() => namespacedToolName('my server', 'x'), /server name must match/, 'invalid server names are refused, not munged');
  assert.throws(() => sanitizeServerName('bad name!'), /server name must match/);
  assert.throws(() => normalizeServerConfig({ nope: true }), /needs either \{ url \} or \{ command \}/);
});

test('registry: connectAll discovers both transports, listTools namespaces, call round-trips, status reports', async () => {
  const home = tmpDir('bu-mcp-home2-');
  const repo = tmpDir('bu-mcp-repo2-');
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = JSON.parse(body || '{}');
      const result = message.method === 'initialize'
        ? { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'mini-http', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'shout', description: 'shout', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: String(message.params?.arguments?.text || '').toUpperCase() }], isError: false };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const store = new McpConfigStore({
    userFile: path.join(home, '.browser-use-cli', 'mcp.json'),
    repoFile: path.join(repo, '.browser-use', 'mcp.json')
  });
  store.addServer({ scope: 'user', name: 'mini-stdio', config: fixtureConfig() });
  store.addServer({ scope: 'repo', name: 'mini-http', config: { url: `http://127.0.0.1:${port}/mcp` } });
  store.addServer({ scope: 'user', name: 'broken', config: { command: process.execPath, args: ['-e', 'process.exit(3)'] } });

  const registry = new McpRegistry({
    userFile: path.join(home, '.browser-use-cli', 'mcp.json'),
    repoFile: path.join(repo, '.browser-use', 'mcp.json'),
    connectTimeoutMs: 10000
  });
  try {
    const results = await registry.connectAll();
    const byName = Object.fromEntries(results.map(row => [row.name, row]));
    assert.equal(byName['mini-stdio'].state, 'ready');
    assert.equal(byName['mini-http'].state, 'ready');
    assert.equal(byName.broken.state, 'error', 'one failing server never blocks the others');

    const tools = registry.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['mcp__mini-http__shout', 'mcp__mini-stdio__add', 'mcp__mini-stdio__echo']);
    const schema = tools.find(tool => tool.name === 'mcp__mini-stdio__echo').inputSchema;
    assert.deepEqual(schema.required, ['text'], 'the server input schema rides through');

    const called = await registry.call('mcp__mini-stdio__echo', { text: 'via registry' });
    assert.equal(called.content[0].text, 'echo: via registry');
    const shouted = await registry.call('mcp__mini-http__shout', { text: 'quiet' });
    assert.equal(shouted.content[0].text, 'QUIET');

    await assert.rejects(() => registry.call('mcp__mini-stdio__missing_tool', {}), /has no tool/);
    await assert.rejects(() => registry.call('browser_click', {}), /not a namespaced MCP tool/);

    const status = registry.status();
    const brokenRow = status.find(row => row.name === 'broken');
    assert.equal(brokenRow.state, 'error');
    assert.ok(brokenRow.lastError, 'failure reason recorded for health display');
  } finally {
    registry.stopAll();
    await new Promise(resolve => server.close(resolve));
  }
});

test('disabled servers are refused with an actionable message; unknown servers too', async () => {
  const home = tmpDir('bu-mcp-home3-');
  const userFile = path.join(home, '.browser-use-cli', 'mcp.json');
  const store = new McpConfigStore({ userFile, repoFile: null });
  store.addServer({ scope: 'user', name: 'mini', config: fixtureConfig() });
  store.setEnabled('mini', false);
  const registry = new McpRegistry({ userFile, repoFile: null, connectTimeoutMs: 10000 });
  try {
    await assert.rejects(() => registry.ensureConnected('mini'), /disabled — \/mcp enable mini/);
    await assert.rejects(() => registry.ensureConnected('ghost'), /no MCP server named/);
    const status = registry.status();
    assert.equal(status.find(row => row.name === 'mini').state, 'disabled');
  } finally {
    registry.stopAll();
  }
});
