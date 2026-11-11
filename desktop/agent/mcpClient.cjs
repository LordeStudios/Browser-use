'use strict';

// GEN9 — MCP CLIENT side (desktop/skills_mcp_plan.md).
//
// The app already IS an MCP server (desktop/mcp/localMcpServer.cjs). This
// module is the missing client half: the desktop app and the CLI calling
// EXTERNAL MCP servers — stdio (spawn + newline-delimited JSON-RPC 2.0) or
// streamable HTTP (POST JSON-RPC, JSON or SSE reply) — discovering their tools
// via tools/list and exposing them to the agent as namespaced tools
// mcp__<server>__<tool> with the server's input schemas.
//
// Config scopes (shared by BOTH surfaces):
//   user:  ~/.browser-use-cli/mcp.json
//   repo:  <repo>/.browser-use/mcp.json   (a server name here overrides user)
//
// Reconnect policy: an unexpected transport failure retries with backoff
// 1s,2s,4s... capped at 60s, INDEFINITELY while the server stays enabled
// (owner directive: recovery is never terminated). close() stops it.
//
// Zero dependencies — JSON-RPC 2.0 is a plain protocol.

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', PROTOCOL_VERSION]);
const CLIENT_INFO = { name: 'browser-use', version: 'gen9' };
const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const HANAKE_TIMEOUT_MS = 15000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_CAP_MS = 60000;
const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

let nextRequestId = 1;
function requestId() { return nextRequestId += 1; }

function jsonRpcRequest(id, method, params) {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) };
}

function jsonRpcErrorResult(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

// Newline-delimited JSON-RPC over a spawned child's stdin/stdout (the stdio
// transport shape every MCP server implements). Notifications and responses
// are demultiplexed by id; stderr is captured (bounded tail) for diagnostics.
class StdioTransport {
  constructor({ command, args = [], env = null, cwd = null, spawnFn = spawn, log = null } = {}) {
    if (!command) throw new Error('stdio transport requires a command');
    this.command = String(command);
    this.args = (Array.isArray(args) ? args : []).map(String);
    this.env = env && typeof env === 'object' ? { ...env } : null;
    this.cwd = cwd || null;
    this.spawnFn = spawnFn;
    this.log = log;
    this.child = null;
    this.buffer = '';
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.onNotification = null;
    this.onClose = null;
    this.stderrTail = '';
    this.closedByUs = false;
  }

  start() {
    this.closedByUs = false;
    this.child = this.spawnFn(this.command, this.args, {
      cwd: this.cwd || undefined,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => {
      this.stderrTail = (this.stderrTail + chunk).slice(-2000);
    });
    this.child.on('error', error => this.failAll(error));
    this.child.on('exit', (code) => {
      const error = this.closedByUs
        ? null
        : new Error(`MCP server "${this.command}" exited (code ${code}). stderr: ${this.stderrTail.trim().slice(-300) || 'none'}`);
      if (error) this.failAll(error);
      if (this.onClose) try { this.onClose(error); } catch { /* listener errors never crash the client */ }
    });
    return this;
  }

  onData(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; } // non-JSON noise is dropped, never fatal
      if (message && message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        clearTimeout(entry.timer);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
        else entry.resolve(message.result);
      } else if (message && message.method && this.onNotification) {
        try { this.onNotification(message); } catch { /* listener errors never crash the client */ }
      }
    }
  }

  failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  send(message) {
    if (!this.child || !this.child.stdin.writable) throw new Error('stdio transport is not running');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    this.closedByUs = true;
    try { this.child?.stdin?.end(); } catch { /* already gone */ }
    try { this.child?.kill(); } catch { /* already gone */ }
    this.failAll(new Error('stdio transport closed'));
  }
}

// Streamable HTTP transport: POST JSON-RPC to the URL; the reply is either a
// JSON body or an SSE stream carrying the response frame.
class HttpTransport {
  constructor({ url, headers = {}, fetchImpl = globalThis.fetch, log = null } = {}) {
    if (!url) throw new Error('http transport requires a url');
    this.url = String(url);
    this.headers = { ...headers };
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.sessionId = null;
    this.onNotification = null;
    this.onClose = null;
    this.closedByUs = false;
  }

  start() { return this; } // HTTP is stateless per POST (session id rides headers)

  async send(message) {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      ...this.headers
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let response;
    try {
      response = await this.fetchImpl(this.url, { method: 'POST', headers, body: JSON.stringify(message) });
    } catch (error) {
      throw new Error(`MCP http transport failed: ${error.message}`);
    }
    const sessionHeader = response.headers?.get?.('mcp-session-id');
    if (sessionHeader) this.sessionId = sessionHeader;
    if (!response.ok) throw new Error(`MCP http transport status ${response.status}`);
    const contentType = String(response.headers?.get?.('content-type') || '');
    const text = await response.text();
    if (contentType.includes('text/event-stream')) {
      // SSE framing: take the data: payload whose id matches (or the last one).
      let result = null;
      let error = null;
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const frame = JSON.parse(line.slice(5).trim());
          if (frame.id === message.id) {
            if (frame.error) error = new Error(`MCP error ${frame.error.code}: ${frame.error.message}`);
            else result = frame.result;
          }
        } catch { /* keep-alive comments / partial frames skipped */ }
      }
      if (error) throw error;
      if (result === null) throw new Error('MCP http SSE reply carried no response frame');
      return result;
    }
    let frame;
    try { frame = JSON.parse(text); } catch {
      throw new Error('MCP http reply is neither JSON nor SSE');
    }
    if (frame.error) throw new Error(`MCP error ${frame.error.code}: ${frame.error.message}`);
    return frame.result;
  }

  close() {
    this.closedByUs = true;
    if (this.onClose) try { this.onClose(null); } catch { /* listener errors never crash the client */ }
  }
}

// ---------------------------------------------------------------------------
// Connection (handshake + discovery + calls + reconnect policy)
// ---------------------------------------------------------------------------

const STATE = { DISCONNECTED: 'disconnected', CONNECTING: 'connecting', READY: 'ready', ERROR: 'error' };

class McpClientConnection {
  constructor({ name, config, spawnFn = spawn, fetchImpl = globalThis.fetch, log = null, now = Date.now } = {}) {
    this.name = String(name || '');
    this.config = config && typeof config === 'object' ? config : {};
    this.spawnFn = spawnFn;
    this.fetchImpl = fetchImpl;
    this.log = log;
    this.now = now;
    this.state = STATE.DISCONNECTED;
    this.tools = [];
    this.serverInfo = null;
    this.lastError = null;
    this.lastConnectedAt = 0;
    this.handshakeMs = null;
    this.transport = null;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.stopped = false;
    this.connecting = null;
  }

  makeTransport() {
    if (this.config.url) {
      return new HttpTransport({ url: this.config.url, headers: this.config.headers || {}, fetchImpl: this.fetchImpl, log: this.log });
    }
    return new StdioTransport({
      command: this.config.command,
      args: this.config.args || [],
      env: this.config.env || null,
      cwd: this.config.cwd || null,
      spawnFn: this.spawnFn,
      log: this.log
    });
  }

  request(method, params, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error(`MCP server "${this.name}" is not connected`));
    const message = jsonRpcRequest(requestId(), method, params);
    const timeout = new Promise((_, reject) => setTimeout(() => {
      reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms on "${this.name}"`));
    }, timeoutMs));
    if (transport.pending) {
      // stdio: frame goes on the wire now; the reply resolves the pending map.
      const call = new Promise((resolve, reject) => {
        transport.pending.set(message.id, { resolve, reject, timer: null });
        try { transport.send(message); } catch (error) {
          transport.pending.delete(message.id);
          reject(error);
        }
      });
      return Promise.race([call, timeout]).catch(error => {
        const entry = transport.pending.get(message.id);
        if (entry) { clearTimeout(entry.timer); transport.pending.delete(message.id); }
        throw error;
      });
    }
    // http: the POST round-trip IS the reply.
    return Promise.race([
      Promise.resolve().then(() => transport.send(message)),
      timeout
    ]);
  }

  async connect() {
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.state = STATE.CONNECTING;
    this.connecting = (async () => {
      try {
        const startedAt = this.now();
        const transport = this.makeTransport();
        transport.start();
        this.transport = transport;
        transport.onClose = (error) => this.onTransportClosed(error);
        const raw = await this.withTimeout(this.initialize(transport), HANAKE_TIMEOUT_MS, 'initialize handshake');
        this.serverInfo = raw?.serverInfo || null;
        const listed = await this.withTimeout(this.request('tools/list'), DEFAULT_REQUEST_TIMEOUT_MS, 'tools/list');
        this.tools = normalizeTools(listed);
        this.state = STATE.READY;
        this.lastError = null;
        this.lastConnectedAt = this.now();
        this.handshakeMs = this.now() - startedAt;
        this.reconnectAttempts = 0;
        return this.status();
      } catch (error) {
        this.state = STATE.ERROR;
        this.lastError = String(error.message || error);
        try { this.transport?.close(); } catch { /* already closed */ }
        this.transport = null;
        this.scheduleReconnect();
        throw error;
      } finally {
        this.connecting = null;
      }
    })();
    return this.connecting;
  }

  async initialize(transport) {
    const requested = String(this.config.protocolVersion || '').trim();
    const versions = [...new Set([
      ...(requested ? [requested] : []),
      ...SUPPORTED_PROTOCOL_VERSIONS
    ])];
    let lastError = null;
    for (const protocolVersion of versions) {
      try {
        const result = await this.request('initialize', { protocolVersion, capabilities: {}, clientInfo: CLIENT_INFO }, HANAKE_TIMEOUT_MS);
        this.protocolVersion = String(result?.protocolVersion || protocolVersion);
        // notifications/initialized is a notification (no id, no reply expected).
        try { transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }); } catch { /* best effort */ }
        return result;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('MCP initialize negotiation failed.');
  }

  withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
    ]);
  }

  onTransportClosed(error) {
    if (this.stopped) return;
    this.state = STATE.DISCONNECTED;
    this.transport = null;
    this.tools = [];
    if (error) this.lastError = String(error.message || error);
    this.scheduleReconnect();
  }

  // Indefinite recovery while enabled (owner directive): every unexpected
  // close retries with capped exponential backoff. Only stop() ends the loop.
  scheduleReconnect() {
    if (this.stopped || this.config.reconnect === false || this.config.enabled === false) return;
    const delay = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch(() => { /* state already recorded; next backoff scheduled */ });
    }, delay);
  }

  async refreshTools() {
    const listed = await this.request('tools/list');
    this.tools = normalizeTools(listed);
    return this.tools;
  }

  async callTool(toolName, args) {
    if (this.state !== STATE.READY) throw new Error(`MCP server "${this.name}" is not ready (${this.state})`);
    return this.request('tools/call', { name: toolName, arguments: args || {} });
  }

  async ping() {
    return this.request('ping', undefined, 10000);
  }

  status() {
    return {
      name: this.name,
      state: this.state,
      kind: this.config.url ? 'http' : 'stdio',
      toolCount: this.tools.length,
      tools: this.tools.map(tool => tool.name),
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      handshakeMs: this.handshakeMs,
      reconnectAttempts: this.reconnectAttempts,
      serverInfo: this.serverInfo
    };
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    try { this.transport?.close(); } catch { /* already closed */ }
    this.transport = null;
    this.state = STATE.DISCONNECTED;
  }
}

function normalizeTools(listed) {
  const raw = Array.isArray(listed?.tools) ? listed.tools : [];
  return raw
    .filter(tool => tool && typeof tool.name === 'string')
    .map(tool => ({
      name: String(tool.name).slice(0, 200),
      description: String(tool.description || '').slice(0, 2000),
      inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} }
    }));
}

function sanitizeServerName(name) {
  const clean = String(name || '').trim();
  if (!SERVER_NAME_RE.test(clean)) throw new Error(`server name must match ${SERVER_NAME_RE} (got "${clean.slice(0, 64)}")`);
  return clean;
}

// ---------------------------------------------------------------------------
// Config persistence (user + repo scopes, merged)
// ---------------------------------------------------------------------------

function readConfigFile(file, fsLike) {
  try {
    const parsed = JSON.parse(fsLike.readFileSync(file, 'utf8'));
    const servers = parsed?.mcpServers && typeof parsed.mcpServers === 'object' ? parsed.mcpServers : {};
    return { file, servers };
  } catch {
    return { file, servers: {} };
  }
}

function writeConfigFile(file, servers, fsLike) {
  fsLike.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  fsLike.writeFileSync(tmp, JSON.stringify({ version: 1, mcpServers: servers }, null, 2), 'utf8');
  fsLike.renameSync(tmp, file);
}

function normalizeServerConfig(config) {
  const clean = config && typeof config === 'object' ? config : {};
  const server = {};
  if (clean.url) {
    server.url = String(clean.url);
    server.headers = clean.headers && typeof clean.headers === 'object'
      ? Object.fromEntries(Object.entries(clean.headers).map(([key, value]) => [String(key), String(value)]))
      : {};
  } else if (clean.command) {
    server.command = String(clean.command);
    server.args = (Array.isArray(clean.args) ? clean.args : []).map(String);
    if (clean.env && typeof clean.env === 'object') {
      server.env = Object.fromEntries(Object.entries(clean.env).map(([key, value]) => [String(key), String(value)]));
    }
    if (clean.cwd) server.cwd = String(clean.cwd);
  } else {
    throw new Error('server config needs either { url } or { command }');
  }
  if (clean.enabled !== undefined) server.enabled = clean.enabled === true;
  if (clean.readOnlyTools && Array.isArray(clean.readOnlyTools)) server.readOnlyTools = clean.readOnlyTools.map(String);
  if (clean.reconnect !== undefined) server.reconnect = clean.reconnect !== false;
  return server;
}

// Merge rule: the repo scope OVERRIDES the user scope by server name; each
// merged row records which scope it came from.
function mergeConfigs(user, repo) {
  const merged = {};
  for (const [name, config] of Object.entries(user.servers)) {
    merged[name] = { ...config, scope: 'user' };
  }
  for (const [name, config] of Object.entries(repo.servers)) {
    merged[name] = { ...config, scope: 'repo' };
  }
  return merged;
}

class McpConfigStore {
  constructor({ userFile, repoFile = null, fs: fsLike = fs } = {}) {
    if (!userFile) throw new Error('McpConfigStore requires a userFile');
    this.userFile = userFile;
    this.repoFile = repoFile || null;
    this.fs = fsLike;
  }

  load() {
    const user = readConfigFile(this.userFile, this.fs);
    const repo = this.repoFile ? readConfigFile(this.repoFile, this.fs) : { servers: {} };
    return { user, repo, merged: mergeConfigs(user, repo) };
  }

  save(scope, servers) {
    const file = scope === 'repo' ? this.repoFile : this.userFile;
    if (!file) throw new Error(`scope "${scope}" is not available (no repo pinned)`);
    writeConfigFile(file, servers, this.fs);
  }

  addServer({ scope = 'user', name, config }) {
    const cleanName = sanitizeServerName(name);
    const clean = normalizeServerConfig(config);
    clean.enabled = clean.enabled !== false;
    const file = scope === 'repo' ? this.repoFile : this.userFile;
    if (!file) throw new Error(`scope "${scope}" is not available (no repo pinned)`);
    const current = readConfigFile(file, this.fs);
    current.servers[cleanName] = clean;
    this.save(scope, current.servers);
    return { name: cleanName, scope, config: clean };
  }

  setEnabled(name, enabled) {
    const { user, repo, merged } = this.load();
    const row = merged[name];
    if (!row) return null;
    const scope = row.scope;
    const file = scope === 'repo' ? this.repoFile : this.userFile;
    const current = scope === 'repo' ? repo : user;
    const existing = current.servers[name] || {};
    existing.enabled = enabled === true;
    current.servers[name] = existing;
    writeConfigFile(file, current.servers, this.fs);
    return { name, scope, enabled: enabled === true };
  }

  setHeader(name, header, value) {
    const { user, repo, merged } = this.load();
    const row = merged[name];
    if (!row) return null;
    const current = row.scope === 'repo' ? repo : user;
    const file = row.scope === 'repo' ? this.repoFile : this.userFile;
    const existing = current.servers[name] || {};
    if (!existing.url) throw new Error(`"${name}" is a stdio server — auth headers apply to http servers`);
    existing.headers = { ...(existing.headers || {}), [header]: value };
    current.servers[name] = existing;
    writeConfigFile(file, current.servers, this.fs);
    return { name, headers: existing.headers };
  }

  removeServer(name) {
    const { user, repo, merged } = this.load();
    const row = merged[name];
    if (!row) return false;
    const current = row.scope === 'repo' ? repo : user;
    const file = row.scope === 'repo' ? this.repoFile : this.userFile;
    delete current.servers[name];
    writeConfigFile(file, current.servers, this.fs);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Registry — the object a surface holds for its whole session
// ---------------------------------------------------------------------------

function namespacedToolName(server, tool) {
  return `mcp__${sanitizeServerName(server)}__${String(tool).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128)}`;
}

function parseNamespacedToolName(name) {
  const match = String(name || '').match(/^mcp__([A-Za-z0-9_-]{1,64})__([A-Za-z0-9_-]{1,128})$/);
  return match ? { server: match[1], tool: match[2] } : null;
}

class McpRegistry {
  constructor({ userFile, repoFile = null, spawnFn = spawn, fetchImpl = globalThis.fetch, fs: fsLike = fs, log = null, connectTimeoutMs = 20000, builtins = null } = {}) {
    this.configStore = new McpConfigStore({ userFile, repoFile, fs: fsLike });
    this.spawnFn = spawnFn;
    this.fetchImpl = fetchImpl;
    this.fs = fsLike;
    this.log = log;
    this.connectTimeoutMs = connectTimeoutMs;
    // Built-in servers (e.g. the xkiro-web MCP): synthesized by the caller —
    // never persisted, always riding the CURRENT credentials — and merged
    // under the config store (a user's own entry of the same name wins).
    this.builtins = Array.isArray(builtins) ? builtins : [];
    this.connections = new Map();
  }

  mergedConfigs() {
    const { merged } = this.configStore.load();
    for (const builtin of this.builtins) {
      if (builtin?.name && builtin?.config && !merged[builtin.name]) {
        merged[builtin.name] = { ...builtin.config, scope: 'builtin' };
      }
    }
    return merged;
  }

  // (Re)connects every enabled server. One failing server never blocks the
  // others — failures land in that server's status.
  async connectAll() {
    const merged = this.mergedConfigs();
    const results = [];
    for (const [name, config] of Object.entries(merged)) {
      if (config.enabled === false) { results.push({ name, state: 'disabled' }); continue; }
      const connection = this.connectionFor(name, config);
      try {
        await this.withConnectTimeout(connection.connect());
        results.push(connection.status());
      } catch (error) {
        results.push({ name, state: 'error', error: String(error.message || error) });
      }
    }
    return results;
  }

  withConnectTimeout(promise) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`connect timed out after ${this.connectTimeoutMs}ms`)), this.connectTimeoutMs))
    ]);
  }

  connectionFor(name, config) {
    let connection = this.connections.get(name);
    const signature = JSON.stringify([config.command || config.url, config.args || [], config.env || {}, config.cwd || null, config.headers || {}]);
    if (connection && connection.signature !== signature) {
      connection.stop();
      connection = null;
    }
    if (!connection) {
      connection = new McpClientConnection({ name, config, spawnFn: this.spawnFn, fetchImpl: this.fetchImpl, log: this.log });
      connection.signature = signature;
      this.connections.set(name, connection);
    }
    return connection;
  }

  async ensureConnected(name) {
    const merged = this.mergedConfigs();
    const config = merged[name];
    if (!config) throw new Error(`no MCP server named "${name}"`);
    if (config.enabled === false) throw new Error(`MCP server "${name}" is disabled — /mcp enable ${name}`);
    const connection = this.connectionFor(name, config);
    if (connection.state !== STATE.READY) await this.withConnectTimeout(connection.connect());
    return connection;
  }

  // Health snapshot without forcing connections for servers that are down.
  status() {
    const merged = this.mergedConfigs();
    const rows = [];
    for (const [name, config] of Object.entries(merged)) {
      const connection = this.connections.get(name);
      rows.push(connection
        ? connection.status()
        : { name, state: config.enabled === false ? 'disabled' : 'disconnected', kind: config.url ? 'http' : 'stdio', toolCount: 0, tools: [], lastError: null, reconnectAttempts: 0 });
    }
    return rows;
  }

  listTools() {
    const out = [];
    for (const [name, connection] of this.connections) {
      if (connection.state !== STATE.READY) continue;
      for (const tool of connection.tools) {
        out.push({
          name: namespacedToolName(name, tool.name),
          server: name,
          tool: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        });
      }
    }
    return out;
  }

  async call(namespacedName, args) {
    const parsed = parseNamespacedToolName(namespacedName);
    if (!parsed) throw new Error(`not a namespaced MCP tool: ${namespacedName}`);
    const connection = await this.ensureConnected(parsed.server);
    if (!connection.tools.some(tool => tool.name === parsed.tool)) {
      throw new Error(`server "${parsed.server}" has no tool "${parsed.tool}" (has: ${connection.tools.map(tool => tool.name).join(', ') || 'none'})`);
    }
    return connection.callTool(parsed.tool, args);
  }

  stopAll() {
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }
}

module.exports = {
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
  jsonRpcRequest,
  jsonRpcErrorResult,
  PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  STATE
};
