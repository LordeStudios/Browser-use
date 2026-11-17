'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { listDeviceProfiles } = require('../../src/browser/deviceProfiles.cjs');
const { COMPUTER_TOOLS, isComputerTool, normalizeComputerInput } = require('../computer/computerCatalog.cjs');

const MAX_BODY_BYTES = 128 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
// server.requestTimeout only bounds reading the request, never the handler, so
// tool execution needs its own ceiling below the host's patience.
const TOOL_TIMEOUT_MS = 10_000;
// browser_wait exists so a caller can sit out a long job in ONE call instead of
// polling. Its own ceiling therefore has to sit above the longest wait it
// allows, or every long wait would be killed by the deadline that is supposed
// to protect the transport.
const MAX_WAIT_MS = 900_000;
const MAX_REQUESTS_PER_MINUTE = 120;
const MCP_SESSION_HEADER = 'mcp-session-id';
const PAIRING_CODE_HEADER = 'x-browser-use-pairing-code';
// Read from package metadata so the advertised server version cannot drift from
// the version stamped onto the installer and portable artifacts.
const SERVER_VERSION = require('../../package.json').version;

class LocalMcpServer {
  constructor({ broker, controller, agent = null, getComputerTools = null, getControlMode = () => 'browser', workspaceProvider = null, gptKey, host = '127.0.0.1', port = 0 }) {
    this.broker = broker;
    this.controller = controller;
    this.agent = agent;
    this.getComputerTools = getComputerTools;
    this.getControlMode = getControlMode;
    this.workspaceProvider = workspaceProvider;
    this.gptKey = String(gptKey || '');
    this.host = host;
    this.port = port;
    this.server = null;
    this.requestWindows = new Map();
    // A transport session is deliberately distinct from SessionBroker's visible
    // session id. Browser-use shows broker sessions to the person for status and
    // revocation, so exposing that id as Mcp-Session-Id would turn UI metadata
    // into a bearer credential.
    this.mcpSessions = new Map();
    this.mcpSessionByBrokerSession = new Map();
    // Open Streamable-HTTP notification streams (GET /mcp). A client that holds
    // one can be told the tool catalog changed; without it a client can only
    // discover new tools by reconnecting, and tools/listChanged is a lie.
    this.toolStreams = new Set();
    this.toolCatalogFingerprint = null;
  }

  async start() {
    if (this.server) return this.status();
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.requestTimeout = REQUEST_TIMEOUT_MS;
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('error', onError);
        // An occupied fixed port is a handled startup condition, not an
        // unhandled Electron promise rejection. Clean the partially-created
        // server so a settings retry can start a fresh listener later.
        const failedServer = this.server;
        this.server = null;
        failedServer?.close(() => {});
        if (error?.code === 'EADDRINUSE') {
          const wrapped = new Error(`Browser-use MCP port ${this.port} is already in use. Close the other Browser-use instance or configure a different BROWSER_USE_DESKTOP_MCP_PORT.`);
          wrapped.code = 'MCP_PORT_IN_USE';
          wrapped.port = this.port;
          wrapped.cause = error;
          reject(wrapped);
          return;
        }
        reject(error);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server?.off('error', onError);
        resolve();
      });
    });
    return this.status();
  }

  async stop() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.requestWindows.clear();
    this.mcpSessions.clear();
    this.mcpSessionByBrokerSession.clear();
    // An open notification stream would otherwise keep the listener alive and
    // leave the client waiting on a socket that will never deliver again.
    for (const stream of [...this.toolStreams]) {
      try { stream.end(); } catch { /* the client may already be gone */ }
    }
    this.toolStreams.clear();
    this.toolCatalogFingerprint = null;
    await new Promise((resolve) => server.close(resolve));
  }

  status() {
    const address = this.server?.address();
    const baseUrl = address && typeof address === 'object' ? `http://${this.host}:${address.port}` : null;
    return {
      listening: Boolean(baseUrl),
      endpoint: baseUrl ? `${baseUrl}/mcp` : null,
      pairingEndpoint: baseUrl ? `${baseUrl}/pair` : null,
      authenticationEndpoint: baseUrl ? `${baseUrl}/mcp/authenticate` : null,
      gptEnabled: Boolean(baseUrl && this.gptKey),
      gptOpenApiEndpoint: baseUrl && this.gptKey ? `${baseUrl}/gpt/openapi.json` : null,
      gptToolsEndpoint: baseUrl && this.gptKey ? `${baseUrl}/gpt/tools` : null
    };
  }

  async handle(request, response) {
    setSecurityHeaders(response);
    if (!isLoopback(request.socket.remoteAddress) || !this.consumeRequest(request.socket.remoteAddress)) {
      return sendJson(response, 429, { error: 'Request limit exceeded' });
    }
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/gpt')) return this.handleGpt(url, request, response);
    if (url.pathname === '/mcp/authenticate') {
      if (request.method !== 'GET') return sendJson(response, 405, { error: 'Only GET is supported' });
      const offer = this.broker.createPairingOffer();
      return sendJson(response, 200, { 'X-Browser-Use-Pairing-Code': offer.pairingCode });
    }
    if (!['/mcp', '/pair'].includes(url.pathname)) return sendJson(response, 404, { error: 'Not found' });
    if (url.pathname === '/pair') {
      if (request.method !== 'POST') return sendJson(response, 405, { error: 'Only POST is supported' });
      try {
        return this.handlePair(await readJson(request), response);
      } catch (error) {
        return sendJson(response, error.code === 'UNAUTHORIZED' ? 401 : 400, { error: error.message || 'Invalid request' });
      }
    }
    if (request.method === 'DELETE') return this.handleMcpDelete(request, response);
    // Streamable HTTP: GET /mcp opens the server->client notification stream.
    // A client that keeps it open is told when the tool catalog changes, which
    // is the only way it can learn about a tool added by an upgrade.
    if (request.method === 'GET') return this.handleMcpStream(request, response);
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Only POST is supported' });
    try {
      const body = await readJson(request);
      // JSON-RPC batching: one HTTP request may carry N independent calls, so a
      // client is never forced into one transport round trip per tool.
      if (Array.isArray(body)) return this.handleMcpBatch(body, request, response);
      return this.handleMcp(body, request, response);
    } catch (error) {
      return sendJson(response, 400, { error: error.message || 'Invalid request' });
    }
  }

  async handleGpt(url, request, response) {
    if (!this.gptKey) return sendJson(response, 503, { ok: false, error: 'ChatGPT Action bridge is disabled.' });
    const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const protocol = forwardedProtocol === 'https' ? 'https' : 'http';
    const forwardedHost = String(request.headers['x-forwarded-host'] || '').split(',')[0].trim();
    const host = forwardedHost || request.headers.host || `${this.host}:${this.server.address().port}`;
    const baseUrl = `${protocol}://${host}`;
    // The bootstrap schema must be public so ChatGPT can discover the declared
    // X-API-Key security scheme before credentials are configured. Tool calls
    // and the tool catalog remain authenticated.
    if (request.method === 'GET' && url.pathname === '/gpt/openapi.json') {
      return sendJson(response, 200, buildGptOpenApiSchema(baseUrl));
    }
    if (!safeKeyEqual(request.headers['x-api-key'], this.gptKey)) {
      return sendJson(response, 401, { ok: false, error: 'Missing or invalid X-API-Key header.' });
    }
    if (request.method === 'GET' && url.pathname === '/gpt/tools') {
      return sendJson(response, 200, { ok: true, tools: toolDefinitions().map((tool) => tool.name) });
    }
    if (request.method === 'POST' && url.pathname.startsWith('/gpt/call/')) {
      const toolName = decodeURIComponent(url.pathname.slice('/gpt/call/'.length));
      const tool = TOOL_HANDLERS[toolName];
      if (!tool || toolName === 'browser_bind_tab') return sendJson(response, 403, { ok: false, error: 'Tool not exposed through the GPT Action bridge.' });
      try {
        const args = await readJson(request);
        const tabId = tool.requiresTab ? this.controller.selectedTabId() : null;
        const output = await tool.run(this.controller, tabId, args || {});
        return sendJson(response, 200, formatGptOutput(output, tool.isError?.(output)));
      } catch (error) {
        return sendJson(response, 502, { ok: false, error: String(error.message || error).slice(0, 300) });
      }
    }
    return sendJson(response, 404, { ok: false, error: 'Endpoint not found.' });
  }

  handlePair(body, response) {
    // New clients use the header bootstrap, which never serializes the broker
    // capability. Preserve the legacy bearer exchange only for its first use;
    // after a normal header bootstrap, a replayed pairing code must not mint a
    // permanent capability for a different loopback process.
    if (this.broker.status().pairing?.recoverable) {
      return sendJson(response, 409, {
        error: 'A paired MCP session already exists. Reuse its Mcp-Session-Id or initialize with the pairing header while that pairing code remains active.'
      });
    }
    const session = this.broker.pair({
      pairingCode: body?.pairingCode,
      host: { name: body?.host?.name, version: body?.host?.version }
    });
    const mcpSession = this.createMcpSession(session);
    return sendJson(response, 200, {
      instanceId: this.broker.instanceId,
      session: { ...session, capability: session.capability },
      mcpSessionId: mcpSession.id
    });
  }

  async handleMcp(message, request, response) {
    if (!isJsonRpcRequest(message)) return sendJson(response, 400, jsonRpcError(null, -32600, 'Invalid JSON-RPC request'));
    const id = message.id;
    let connection = null;
    try {
      connection = this.resolveMcpConnection(message, request);
      const result = await this.dispatch(message, connection.capability);
      if (id === undefined) {
        if (connection.id) response.setHeader('Mcp-Session-Id', connection.id);
        response.statusCode = 202;
        return response.end();
      }
      return sendJson(response, 200, { jsonrpc: '2.0', id, result }, mcpSessionHeaders(connection.id));
    } catch (error) {
      const code = error.code === 'MCP_SESSION' || error.code === 'UNAUTHORIZED' ? -32001 : -32000;
      const status = error.code === 'MCP_SESSION' ? 200 : error.code === 'UNAUTHORIZED' ? 401 : 400;
      return sendJson(response, status, jsonRpcError(id ?? null, code, error.message || 'Request failed'), mcpSessionHeaders(connection?.id));
    }
  }

  // JSON-RPC 2.0 batching (MCP 2024-11-05 and 2025-03-26). One HTTP request may
  // carry N independent tool calls, so a client is not forced into one transport
  // round trip per call. initialize stays alone: it establishes the session every
  // later message in the batch depends on. Replies keep request order, and a
  // single failing call never cancels its siblings.
  async handleMcpBatch(messages, request, response) {
    if (!messages.length) return sendJson(response, 400, jsonRpcError(null, -32600, 'Invalid JSON-RPC batch: empty array'));
    if (messages.some((message) => message?.method === 'initialize')) {
      return sendJson(response, 400, jsonRpcError(null, -32600, 'Invalid JSON-RPC batch: initialize must be sent on its own'));
    }
    if (messages.some((message) => !isJsonRpcRequest(message))) {
      return sendJson(response, 400, jsonRpcError(null, -32600, 'Invalid JSON-RPC request in batch'));
    }
    let connection = null;
    try {
      connection = this.resolveMcpConnection(messages[0], request);
    } catch (error) {
      const code = error.code === 'MCP_SESSION' || error.code === 'UNAUTHORIZED' ? -32001 : -32000;
      const status = error.code === 'MCP_SESSION' ? 200 : error.code === 'UNAUTHORIZED' ? 401 : 400;
      return sendJson(response, status, jsonRpcError(null, code, error.message || 'Request failed'), mcpSessionHeaders(connection?.id));
    }
    const replies = [];
    for (const message of messages) {
      if (message.id === undefined) {
        // A notification never produces a reply, even when it fails.
        try { await this.dispatch(message, connection.capability); } catch { /* notifications are fire-and-forget */ }
        continue;
      }
      try {
        replies.push({ jsonrpc: '2.0', id: message.id, result: await this.dispatch(message, connection.capability) });
      } catch (error) {
        const code = error.code === 'MCP_SESSION' || error.code === 'UNAUTHORIZED' ? -32001 : -32000;
        replies.push(jsonRpcError(message.id, code, error.message || 'Request failed'));
      }
    }
    if (!replies.length) {
      if (connection.id) response.setHeader('Mcp-Session-Id', connection.id);
      response.statusCode = 202;
      return response.end();
    }
    return sendJson(response, 200, replies, mcpSessionHeaders(connection.id));
  }

  handleMcpDelete(request, response) {
    const id = headerString(request, MCP_SESSION_HEADER);
    const session = this.mcpSessions.get(id);
    if (!session) return sendJson(response, 200, { ok: true, closed: false });
    try {
      this.broker.authenticate(session.capability);
    } catch {
      this.deleteMcpSession(id);
      return sendJson(response, 200, { ok: true, closed: false });
    }
    this.deleteMcpSession(id);
    return sendJson(response, 200, { ok: true, closed: true });
  }

  // GET /mcp — the Streamable HTTP server->client notification stream.
  // initialize advertises tools.listChanged, so the server owes the client a
  // channel to receive that notification. Without this endpoint the flag would
  // promise a refresh the server can never deliver, and a tool added by an
  // upgrade (browser_sequence) would stay invisible to every connected client
  // until it reconnected for some unrelated reason.
  handleMcpStream(request, response) {
    const id = headerString(request, MCP_SESSION_HEADER);
    const session = id ? this.mcpSessions.get(id) : null;
    if (!session) {
      return sendJson(response, 401, { error: 'An Mcp-Session-Id is required to open the notification stream.' });
    }
    try {
      this.broker.authenticate(session.capability);
    } catch {
      this.deleteMcpSession(id);
      return sendJson(response, 401, { error: 'This MCP session is no longer authorized.' });
    }
    session.lastSeenAt = Date.now();
    // Override the JSON defaults from setSecurityHeaders: this response is an
    // event stream that stays open, so it must not be closed or buffered.
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('Mcp-Session-Id', session.id);
    response.statusCode = 200;
    // The stream is idle by design between notifications, so the socket's
    // inactivity timeout must not tear it down.
    response.setTimeout?.(0);
    // A comment line flushes headers so the client knows the stream is live
    // without the server having to invent an event.
    response.write(': connected\n\n');
    this.toolStreams.add(response);
    const close = () => { this.toolStreams.delete(response); };
    request.on('close', close);
    request.on('error', close);
    response.on('error', close);
    // Announce the CURRENT catalog immediately. A client that reconnects after
    // an upgrade is holding a stale tool index, and this is the one moment it
    // is guaranteed to be listening.
    this.writeToolListChanged(response);
    return undefined;
  }

  writeToolListChanged(response) {
    try {
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
      return true;
    } catch {
      this.toolStreams.delete(response);
      return false;
    }
  }

  notifyToolListChanged() {
    for (const stream of [...this.toolStreams]) this.writeToolListChanged(stream);
  }

  // A stable identity for the advertised catalog. The catalog is static per
  // build, so a change here means the set of tools a client was told about is
  // out of date (for example computer tools appearing when AGI mode is enabled).
  currentToolCatalogFingerprint() {
    const names = [...toolDefinitions(), ...(this.getComputerTools ? COMPUTER_TOOLS : [])]
      .map((tool) => tool.name)
      .sort();
    return `${names.length}:${crypto.createHash('sha1').update(names.join(',')).digest('hex').slice(0, 16)}`;
  }

  // Called on every tools/list: if the catalog moved since the last time any
  // client asked, tell every open stream so none of them keeps a stale index.
  syncToolCatalogFingerprint() {
    const fingerprint = this.currentToolCatalogFingerprint();
    const previous = this.toolCatalogFingerprint;
    this.toolCatalogFingerprint = fingerprint;
    if (previous !== null && previous !== fingerprint && this.toolStreams.size) {
      this.notifyToolListChanged();
    }
    return fingerprint;
  }

  resolveMcpConnection(message, request) {
    const existingId = headerString(request, MCP_SESSION_HEADER);
    const pairingCode = headerString(request, PAIRING_CODE_HEADER);
    if (existingId) {
      const existing = this.mcpSessions.get(existingId);
      if (existing) {
        try {
          this.broker.authenticate(existing.capability);
          existing.lastSeenAt = Date.now();
          return existing;
        } catch {
          this.deleteMcpSession(existingId);
        }
      }
      // Weak clients often retain both their static bootstrap header and a
      // stale transport id. Prefer the valid live transport, but when it is
      // gone let the bounded pairing recovery path rebuild it in this request.
      if (!pairingCode) throw unknownMcpSession();
    }

    if (pairingCode) {
      const brokerSession = this.broker.pair({
        pairingCode,
        host: hostFromInitialize(message?.params?.clientInfo)
      });
      return this.createMcpSession(brokerSession);
    }

    const capability = bearerCapability(request);
    if (!capability) {
      throw unauthorized('MCP initialization requires an Mcp-Session-Id, pairing header, or Bearer capability.');
    }
    const brokerSession = this.broker.authenticate(capability);
    return this.createMcpSession({ ...brokerSession, capability });
  }

  createMcpSession(brokerSession) {
    const brokerSessionId = String(brokerSession?.id || '');
    const capability = String(brokerSession?.capability || '');
    if (!brokerSessionId || !capability) throw new Error('A paired Browser-use session is required to open an MCP transport session.');
    const existingId = this.mcpSessionByBrokerSession.get(brokerSessionId);
    const existing = existingId ? this.mcpSessions.get(existingId) : null;
    if (existing) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const session = { id: `mcp-${crypto.randomUUID()}`, brokerSessionId, capability, createdAt: Date.now(), lastSeenAt: Date.now() };
    this.mcpSessions.set(session.id, session);
    this.mcpSessionByBrokerSession.set(brokerSessionId, session.id);
    return session;
  }

  forgetBrokerSession(brokerSessionId) {
    const id = this.mcpSessionByBrokerSession.get(String(brokerSessionId || ''));
    if (id) this.deleteMcpSession(id);
  }

  deleteMcpSession(id) {
    const session = this.mcpSessions.get(id);
    if (!session) return false;
    this.mcpSessions.delete(id);
    if (this.mcpSessionByBrokerSession.get(session.brokerSessionId) === id) this.mcpSessionByBrokerSession.delete(session.brokerSessionId);
    // Release the DevTools channel this transport session pinned on bind, or the
    // tab stays pinned forever after the client disconnects.
    try {
      const brokerSession = this.broker.authenticate(session.capability);
      if (brokerSession?.tabId) this.controller?.unpinDebugger?.(brokerSession.tabId, `mcp:${brokerSession.id}`);
    } catch { /* the broker session may already be revoked */ }
    return true;
  }

  async dispatch(message, capability) {
    if (message.method === 'initialize') {
      return {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'browser-use-desktop', version: SERVER_VERSION },
        instructions: 'Use the short-lived X-Browser-Use-Pairing-Code header only to bootstrap or recover a connection. Retain the returned Mcp-Session-Id on later MCP requests. Pairing enables every Desktop MCP tool immediately; bind a tab before using tab-scoped tools. BATCHING IS SUPPORTED AND EXPECTED - do not spend one round trip per step. browser_sequence runs an ordered list of browser steps in ONE call and returns one result per step. browser_fill_form fills many controls in ONE call. computer_fs_batch runs many filesystem operations in ONE call. This server also accepts a JSON-RPC batch array, so independent calls can share one HTTP request. Batch every step whose arguments are already known; keep a step separate only when its arguments depend on an unseen result such as a fresh snapshot or screenshot.'
      };
    }
    if (message.method === 'notifications/initialized' || message.method === 'ping') {
      this.broker.authenticate(capability);
      return {};
    }
    if (message.method === 'tools/list') {
      this.broker.authenticate(capability);
      this.syncToolCatalogFingerprint();
      return { tools: [...toolDefinitions(), ...(this.getComputerTools ? COMPUTER_TOOLS : [])] };
    }
    if (message.method === 'tools/call') return this.callTool(message.params, capability);
    throw methodNotFound();
  }

  async callTool(params, capability) {
    const name = params?.name;
    const rawArgs = params?.arguments || {};
    // Normalize the MCP boundary as well as the local executor. This keeps
    // compatibility metadata (for example display_text from an older client)
    // from reaching strict computer handlers, including custom backends used by
    // integrations and tests.
    const args = isComputerTool(name) ? normalizeComputerInput(name, rawArgs) : rawArgs;
    if (isComputerTool(name)) {
      const session = this.broker.authorize(capability, name);
      if (this.getControlMode() !== 'agi' || !this.getComputerTools) {
        // AGI mode being off is a normal, recoverable product state the person
        // can fix in Settings, not a broken protocol exchange.
        return toolFailure('Computer tools require AGI mode in Browser-use Settings.', name);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      let output;
      try {
        output = await callWithDeadline(() => this.getComputerTools().execute(name, args, `mcp:${session.id}`, { signal: controller.signal }), 26_000, name);
      } catch (error) {
        if (isProtocolError(error)) throw error;
        return toolFailure(error, name);
      } finally { clearTimeout(timer); }
      if (name === 'computer_screenshot' && output?.data) {
        const { data, ...metadata } = output;
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data, mimeType: output.mimeType }], isError: false };
      }
      return toolResult(output, output?.state === 'failed');
    }
    if (typeof name !== 'string') throw methodNotFound('A tool name is required');
    if (name.startsWith('browser_agent_')) {
      try {
        return await this.callAgentTool(name, args, capability);
      } catch (error) {
        if (isProtocolError(error)) throw error;
        return toolFailure(error, name);
      }
    }
    if (name === 'browser_bind_tab') {
      this.broker.authorize(capability, 'browser_get_tabs');
      const tab = this.controller.getTab(args.tabId);
      const session = this.broker.bindTab(capability, tab.id);
      // Pin the bound tab's DevTools channel for the life of this session. An
      // unpinned lease attaches and detaches around EVERY command, which is both
      // churn on every call and a race between a still-pending command and a
      // later detach. The desktop agent already pins its bound tab for exactly
      // this reason; MCP sessions were the ones paying for it.
      try { this.controller.pinDebugger?.(tab.id, `mcp:${session.id}`); } catch { /* latency optimization only */ }
      // A bound tab must also be the tab the shell is SHOWING. Chromium drops
      // pointer input for a renderer it considers hidden, so binding a background
      // tab would hand back a tab that every click, hover and scroll silently
      // misses. Selecting it is what a human does before driving a tab.
      try { this.controller.selectTab?.(tab.id); } catch { /* the shell may be mid-teardown */ }
      return toolResult(session);
    }

    const tool = TOOL_HANDLERS[name];
    if (!tool) throw methodNotFound('Unknown MCP tool');
    const session = this.broker.authorize(capability, name);
    const boundTabId = session.tabId;
    // Arguments are checked BEFORE the tab gate. A caller with malformed
    // arguments must be told about the arguments even when no tab is bound,
    // otherwise it binds a tab, retries, and only then learns the real problem.
    if (typeof tool.validate === 'function') {
      try {
        tool.validate(args);
      } catch (error) {
        if (isProtocolError(error)) throw error;
        return toolFailure(error, name);
      }
    }
    if (!boundTabId && tool.requiresTab) {
      // "Bind a tab first" is a usage state the caller resolves with another
      // tool, so it belongs in the result, not in a transport failure.
      return toolFailure('Bind a desktop tab before calling this tool', name);
    }
    // A tool that never settles would hold this HTTP request open forever, leaking
    // a connection and consuming the caller's rate-limit budget. Every tool is
    // therefore bounded, so a stuck native surface surfaces as an error.
    let output;
    try {
      output = await callWithDeadline(
        () => tool.run(this.controller, boundTabId, args, session.id),
        tool.timeoutMs || TOOL_TIMEOUT_MS,
        name
      );
    } catch (error) {
      if (isProtocolError(error)) throw error;
      return toolFailure(error, name);
    }
    return toolResult(output, tool.isError?.(output));
  }

  async callAgentTool(name, args, capability) {
    if (!this.agent) throw new Error('The Browser-use desktop agent is unavailable.');
    const session = this.broker.authorize(capability, name);
    if (!session.tabId && name === 'browser_agent_start') throw new Error('Bind a desktop tab before starting a Browser-use agent task.');
    if (name === 'browser_agent_start') {
      const task = String(args.task || '').trim();
      if (!task) throw new Error('Browser-use agent task is required.');
      const run = await this.agent.start({
        task,
        workspace: typeof this.workspaceProvider === 'function' ? this.workspaceProvider() : null,
        tabId: session.tabId,
        provider: {
          id: String(args.provider || 'ollama').trim() || 'ollama',
          connectionId: String(args.connectionId || '').trim() || undefined,
          model: String(args.model || '').trim() || undefined,
          baseUrl: String(args.baseUrl || '').trim() || undefined
        },
        settings: {
          ...(args.settings && typeof args.settings === 'object' ? args.settings : {}),
          // An MCP caller may explicitly choose browser or computer control for
          // this task. Do not overwrite that choice with the app-wide mode;
          // doing so sent browser chess runs into the native desktop path.
          controlMode: args.settings?.controlMode === 'browser' || args.settings?.controlMode === 'agi'
            ? args.settings.controlMode
            : this.getControlMode()
        },
        computerOwner: `mcp:${session.id}`,
        controlModeResolver: () => { try { this.broker.authenticate(capability); return this.getControlMode(); } catch { return 'browser'; } }
      });
      return toolResult(run);
    }
    if (name === 'browser_agent_status') return toolResult(this.agent.state());
    if (name === 'browser_agent_approve') return toolResult(this.agent.approve({ runId: args.runId, approvalId: args.approvalId, decision: args.decision }));
    if (name === 'browser_agent_cancel') return toolResult(this.agent.cancel(args.runId));
    throw methodNotFound('Unknown Browser-use agent tool');
  }

  consumeRequest(address) {
    const now = Date.now();
    const current = this.requestWindows.get(address) || [];
    const recent = current.filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= MAX_REQUESTS_PER_MINUTE) return false;
    recent.push(now);
    this.requestWindows.set(address, recent);
    return true;
  }
}

// ---- browser_sequence: N ordered steps in ONE call / ONE round trip ---------
// Every step reuses the exact handler a direct call would use, so semantics can
// never drift from the single-call tools. The win is removing N-1 model
// decisions and N-1 HTTP round trips, not changing what a step does.
const SEQUENCE_MAX_STEPS = 32;
const SEQUENCE_TOTAL_BUDGET_MS = 60_000;
const SEQUENCE_STEP_TIMEOUT_MS = 15_000;
// Steps that would mutate the session, leave the bound tab, or recurse. They are
// refused with an explanation rather than failing halfway through a chain.
const SEQUENCE_BLOCKED = new Map([
  ['browser_sequence', 'a sequence cannot contain another sequence'],
  ['browser_bind_tab', 'binding is a session operation, not a page step'],
  ['browser_close_tab', 'closing a tab mid-sequence would invalidate later steps'],
  ['browser_new_tab', 'a tab created here cannot be targeted by later steps in the same sequence'],
  ['browser_agent_start', 'agent runs are not page steps'],
  ['browser_agent_cancel', 'agent runs are not page steps'],
  ['browser_agent_approve', 'agent runs are not page steps'],
  ['browser_agent_status', 'agent runs are not page steps']
]);

function stripSequencePayload(value) {
  // A screenshot is base64. Repeating it once per step would swamp the reply,
  // so the payload is replaced by its size and the step stays reportable.
  if (value && typeof value === 'object' && typeof value.data === 'string' && value.mimeType) {
    const { data, ...rest } = value;
    return { ...rest, imageOmitted: true, imageBytes: Math.ceil((data.length * 3) / 4) };
  }
  return value;
}

async function runBrowserSequence(controller, tabId, args, sessionId) {
  const steps = Array.isArray(args?.steps) ? args.steps : [];
  if (!steps.length) throw new Error('browser_sequence needs a non-empty steps array.');
  if (steps.length > SEQUENCE_MAX_STEPS) throw new Error(`browser_sequence accepts at most ${SEQUENCE_MAX_STEPS} steps per call.`);
  const stopOnError = args?.stopOnError !== false;
  const startedAt = Date.now();
  const results = [];
  let failed = 0;

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index] && typeof steps[index] === 'object' ? steps[index] : {};
    const tool = String(step.tool || '').trim();
    // `input` is the documented spelling, but a client that follows the ordinary
    // MCP convention writes `arguments`. Accepting both prevents a step from
    // silently running with an EMPTY payload — which reads as an instantly
    // "fast" sequence instead of an obvious argument error.
    const rawInput = step.input ?? step.arguments;
    const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
    const remaining = SEQUENCE_TOTAL_BUDGET_MS - (Date.now() - startedAt);
    const refusal = SEQUENCE_BLOCKED.get(tool);
    const handler = TOOL_HANDLERS[tool];

    if (remaining <= 0) {
      results.push({ index, tool, ok: false, error: `the ${SEQUENCE_TOTAL_BUDGET_MS}ms sequence budget was exhausted before this step ran` });
      failed += 1;
      if (stopOnError) break;
      continue;
    }
    if (refusal) {
      results.push({ index, tool, ok: false, error: `browser_sequence cannot run ${tool}: ${refusal}` });
      failed += 1;
      if (stopOnError) break;
      continue;
    }
    if (!handler) {
      results.push({ index, tool, ok: false, error: `unknown step tool "${tool}" - use a browser_* tool name` });
      failed += 1;
      if (stopOnError) break;
      continue;
    }

    const stepStartedAt = Date.now();
    try {
      const timeout = Math.min(handler.timeoutMs || SEQUENCE_STEP_TIMEOUT_MS, remaining);
      const value = await callWithDeadline(() => handler.run(controller, tabId, input, sessionId), timeout, tool);
      results.push({ index, tool, ok: true, durationMs: Date.now() - stepStartedAt, result: stripSequencePayload(value) });
    } catch (error) {
      failed += 1;
      results.push({ index, tool, ok: false, durationMs: Date.now() - stepStartedAt, error: error?.message || String(error) });
      if (stopOnError) break;
    }
  }

  const executed = results.length;
  const unexecuted = steps.slice(executed).map((step, offset) => ({
    index: executed + offset,
    tool: String((step && step.tool) || '').trim()
  }));
  return {
    requested: steps.length,
    executed,
    succeeded: executed - failed,
    failed,
    durationMs: Date.now() - startedAt,
    steps: results,
    ...(unexecuted.length ? { unexecuted } : {})
  };
}

const TOOL_HANDLERS = {
  browser_get_tabs: { requiresTab: false, run: (controller) => controller.listTabs() },
  browser_new_tab: { requiresTab: false, run: (controller, _tabId, args) => controller.createTab(args.url || 'about:blank') },
  browser_close_tab: { requiresTab: false, run: (controller, _tabId, args) => controller.closeTab(args.tabId) },
  browser_get_tab: { requiresTab: true, run: (controller, tabId) => controller.getTab(tabId) },
  browser_dom_snapshot: { requiresTab: true, run: (controller, tabId, args) => controller.domSnapshot(tabId, args) },
  browser_query_elements: { requiresTab: true, run: (controller, tabId, args) => controller.queryElements(tabId, args) },
  browser_execute: { requiresTab: true, timeoutMs: 15_000, run: (controller, tabId, args) => controller.executePageScript(tabId, args) },
  browser_element_rect: { requiresTab: true, run: (controller, tabId, args) => controller.elementRect(tabId, args) },
  browser_click_element: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.clickElement(tabId, args, sessionId) },
  browser_screenshot: { requiresTab: true, run: (controller, tabId) => controller.screenshot(tabId) },
  browser_console_entries: { requiresTab: true, run: (controller, tabId) => controller.consoleEntries(tabId) },
  browser_network_entries: { requiresTab: true, run: (controller, tabId) => controller.networkEntries(tabId) },
  browser_navigation_state: { requiresTab: true, run: (controller, tabId) => controller.navigationState(tabId) },
  browser_navigate: { requiresTab: true, run: (controller, tabId, args) => controller.navigate(tabId, args.url) },
  browser_go_back: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId) => controller.goBack(tabId) },
  browser_search: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId, args) => controller.search(tabId, args) },
  browser_fetch: { requiresTab: false, timeoutMs: 20_000, run: (controller, _tabId, args) => controller.fetchPage(args) },
  browser_mousemove: { requiresTab: true, validate: assertPointerArgs, run: (controller, tabId, args, sessionId) => controller.mouseMove(tabId, args, { sessionId }) },
  // One call for the whole click, like the desktop agent's own browser_click:
  // index wins, coordinates are the fallback, and clickAt attaches the hit test.
  browser_click: {
    requiresTab: true,
    validate: assertClickArgs,
    run: (controller, tabId, args, sessionId) => (Number.isInteger(args?.element) && args.element >= 0
      ? controller.clickElement(tabId, { index: args.element, button: args.button }, sessionId)
      : controller.clickAt(tabId, { x: args.x, y: args.y, button: args.button }, sessionId))
  },
  browser_mousedown: { requiresTab: true, validate: assertPointerArgs, run: (controller, tabId, args, sessionId) => controller.mouseDown(tabId, args, sessionId) },
  browser_mouseup: { requiresTab: true, validate: assertPointerArgs, run: (controller, tabId, args, sessionId) => controller.mouseUp(tabId, args, sessionId) },
  browser_drag: { requiresTab: true, timeoutMs: 15_000, validate: assertDragArgs, run: (controller, tabId, args, sessionId) => controller.drag(tabId, args, sessionId) },
  // A scroll is four DevTools round trips (two scroll-evidence reads, the wheel,
  // and a settle turn), and the wheel itself can stall well past the default
  // ceiling. At the old 10s default this tool could NEVER succeed: the debugger
  // lease aborted the wheel at 15s while the caller had already given up at 10s,
  // so every scroll reported a timeout. The deadline now sits above the lease.
  browser_scroll: { requiresTab: true, timeoutMs: 25_000, validate: assertScrollArgs, run: (controller, tabId, args, sessionId) => controller.scroll(tabId, args, sessionId) },
  browser_key: { requiresTab: true, validate: assertKeyArgs, run: (controller, tabId, args, sessionId) => controller.key(tabId, args, sessionId) },
  browser_type: { requiresTab: true, run: (controller, tabId, args) => controller.type(tabId, args) },
  // A batch of fills is still bounded by the same per-tool ceiling as any other
  // tab operation, but it covers many controls, so give it more room.
  browser_fill_form: { requiresTab: true, timeoutMs: 30_000, run: (controller, tabId, args) => controller.fillForm(tabId, args) },
  // A sequence is many steps in one call, so it carries the whole chain budget;
  // the outer deadline is a safety net above the per-step and total limits.
  browser_sequence: { requiresTab: true, timeoutMs: 90_000, run: (controller, tabId, args, sessionId) => runBrowserSequence(controller, tabId, args, sessionId) },
  browser_device_profiles: { requiresTab: false, run: () => listDeviceProfiles() },
  browser_device_state: { requiresTab: true, run: (controller, tabId) => controller.deviceState(tabId) },
  // Switching profiles reloads the page so feature detection re-runs, which can
  // outlast the default tool ceiling on a slow document.
  browser_set_device_mode: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId, args) => controller.setDeviceMode(tabId, args) },
  browser_rotate_device: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId) => controller.rotateDevice(tabId) },
  // A gesture is time-based by nature: a long press or a slow swipe is meant to
  // take most of a second, so it gets more room than an instantaneous call.
  browser_gesture: { requiresTab: true, timeoutMs: 30_000, run: (controller, tabId, args) => controller.gesture(tabId, args) },
  // ---- the surfaces the desktop agent always had and MCP did not ----------
  // These are not conveniences. Without them an MCP client that reaches an OS
  // file picker is stuck at the one step only the native agent could answer,
  // and a download it triggered has no destination it can name.
  browser_file_dialog_arm: { requiresTab: true, run: (controller, tabId) => controller.fileDialogArm(tabId) },
  browser_file_dialog_state: { requiresTab: true, run: (controller, tabId) => controller.fileDialogState(tabId) },
  browser_file_dialog_accept: {
    requiresTab: true,
    timeoutMs: 20_000,
    validate: assertFileDialogAccept,
    run: (controller, tabId, args) => controller.fileDialogAccept(tabId, { files: args.files, selector: args.selector })
  },
  browser_file_dialog_cancel: { requiresTab: true, run: (controller, tabId) => controller.fileDialogCancel(tabId) },
  browser_downloads_set_path: { requiresTab: true, run: (controller, tabId, args) => controller.downloadsSetPath(tabId, { directory: args.directory }) },
  browser_downloads_list: { requiresTab: false, run: (controller) => controller.downloadsList() },
  browser_save_file: { requiresTab: false, validate: assertSaveFileArgs, run: (controller, _tabId, args) => controller.saveFileToDisk(args) },
  // browser_extract is the READ-ALL variant of query_elements: it drops the
  // interactive filter so prose, headings and table cells come back too. The
  // agent's own extract does exactly this, and a client that only had
  // query_elements could not read a page's content at all.
  browser_extract: {
    requiresTab: true,
    run: (controller, tabId, args) => controller.queryElements(tabId, {
      selector: args.selector,
      text: args.text,
      interactiveOnly: false,
      includeText: true,
      framePath: args.framePath,
      maxElements: Math.min(Number(args.maxElements) || 100, 250)
    })
  },
  browser_wait: {
    requiresTab: true,
    // The deadline must exceed the longest wait the tool accepts.
    timeoutMs: MAX_WAIT_MS + 20_000,
    validate: assertWaitArgs,
    run: (controller, tabId, args) => waitForSettle(controller, tabId, args)
  }
};

function toolDefinitions() {
  return [
    toolDefinition('browser_get_tabs', 'List Browser-use desktop tabs.'),
    toolDefinition('browser_new_tab', 'Create an isolated background tab without changing existing tabs.', { url: stringProperty('Initial URL. Defaults to about:blank.') }),
    toolDefinition('browser_close_tab', 'Close an explicitly named Browser-use tab.', { tabId: stringProperty('Tab ID to close.') }, ['tabId']),
    toolDefinition('browser_bind_tab', 'Explicitly bind this MCP session to one Browser-use desktop tab.', { tabId: stringProperty('Desktop tab ID') }, ['tabId']),
    toolDefinition('browser_get_tab', 'Inspect the explicitly bound desktop tab.'),
    toolDefinition('browser_dom_snapshot', 'List interactive elements and their geometry for the explicitly bound desktop tab. Also reports same-origin iframes (path, offset, text) — frame-based apps otherwise read as an empty shell; pass framePath to read inside one.', {
      interactiveOnly: booleanProperty('Limit the snapshot to interactive controls. Defaults to true.'),
      includeText: booleanProperty('Include bounded visible text in each element record. Defaults to true.'),
      maxElements: numberProperty('Maximum number of elements to return. Defaults to 200, max 500.'),
      framePath: framePathProperty()
    }),
    toolDefinition('browser_query_elements', 'Query elements by selector or text in the explicitly bound desktop tab.', {
      selector: stringProperty('Optional CSS selector to narrow the search.'),
      text: stringProperty('Optional case-insensitive text, label, or data-tool filter.'),
      interactiveOnly: booleanProperty('Limit the result to interactive controls. Defaults to true.'),
      includeText: booleanProperty('Include bounded visible text in each element record. Defaults to true.'),
      maxElements: numberProperty('Maximum number of elements to return. Defaults to 50, max 500.'),
      framePath: framePathProperty()
    }),
    toolDefinition('browser_execute', 'Execute one bounded asynchronous JavaScript command inside the explicitly bound page. Return a compact JSON-serializable proof object. The script has browser-page authority only; it cannot access Node, Electron, files, or other tabs.', { script: stringProperty('Async page JavaScript body. Must return proof JSON.') }, ['script']),
    toolDefinition('browser_element_rect', 'Re-read one indexed element from the current DOM snapshot and return its live geometry.', { index: numberProperty('Snapshot index from browser_dom_snapshot.') }, ['index']),
    toolDefinition('browser_click_element', 'Click an indexed element from the latest DOM snapshot in the explicitly bound desktop tab.', { index: numberProperty('Snapshot index from browser_dom_snapshot.'), button: stringProperty('left, middle, or right') }, ['index']),
    toolDefinition('browser_click', 'Click in the explicitly bound tab in ONE call: pass an element index (preferred — the browser lays the element out, so it is exact) or viewport x/y for pixel targets. The reply carries a post-click hit test, so a miss is visible instead of silent.', {
      element: numberProperty('DOM index from browser_dom_snapshot. Wins over x/y when both are given.'),
      ...coordinateProperties(),
      button: stringProperty('left, middle, or right')
    }),
    toolDefinition('browser_screenshot', 'Capture a PNG screenshot from the explicitly bound tab.'),
    toolDefinition('browser_console_entries', 'Read console entries from the explicitly bound tab.'),
    toolDefinition('browser_network_entries', 'Read network failures from the explicitly bound tab.'),
    toolDefinition('browser_navigation_state', 'Read navigation state for the explicitly bound tab.'),
    toolDefinition('browser_navigate', 'Navigate the active desktop tab.', { url: stringProperty('http(s) URL') }, ['url']),
    toolDefinition('browser_go_back', 'Go back in the bound tab\'s history and return the resulting navigation state. The desktop agent has always had this; MCP did not, so a client had to guess the previous URL.'),
    toolDefinition('browser_search', 'Search the web in the explicitly bound desktop tab and return organic result titles with hrefs.', { query: stringProperty('Search keywords.'), maxResults: numberProperty('Optional 1-20 (default 8).') }, ['query']),
    toolDefinition('browser_fetch', 'Fetch an http(s) URL as bounded text without loading it in a tab; scripts and styles are stripped from HTML.', { url: stringProperty('http(s) URL'), maxLength: numberProperty('Optional maximum body characters (default 20000, cap 100000).') }, ['url']),
    toolDefinition('browser_mousemove', 'Move the pointer in the explicitly bound desktop tab.', coordinateProperties(), ['x', 'y']),
    toolDefinition('browser_mousedown', 'Press a mouse button in the explicitly bound desktop tab.', { ...coordinateProperties(), button: stringProperty('left, middle, or right') }, ['x', 'y']),
    toolDefinition('browser_mouseup', 'Release a mouse button in the explicitly bound desktop tab.', { ...coordinateProperties(), button: stringProperty('left, middle, or right') }, ['x', 'y']),
    toolDefinition('browser_drag', 'Drag in the explicitly bound desktop tab. PREFERRED: fromElement/toElement (DOM indices) — drags between their exact centers. Fallback: (startX, startY) to (endX, endY).', {
      fromElement: numberProperty('DOM index of the source element (preferred: exact center).'),
      toElement: numberProperty('DOM index of the destination element (preferred: exact center).'),
      startX: numberProperty('Drag start X coordinate (fallback when fromElement/toElement are omitted).'),
      startY: numberProperty('Drag start Y coordinate (fallback).'),
      endX: numberProperty('Drag end X coordinate (fallback).'),
      endY: numberProperty('Drag end Y coordinate (fallback).'),
      steps: numberProperty('Number of movement steps. Defaults to 10.'),
      durationMs: numberProperty('Total drag duration in milliseconds. Defaults to 300.')
    }),
    toolDefinition('browser_scroll', 'Scroll the explicitly bound desktop tab.', { deltaX: numberProperty('Horizontal pixel delta.'), deltaY: numberProperty('Vertical pixel delta.') }),
    toolDefinition('browser_key', 'Send a key press, key down, or key up to the explicitly bound desktop tab.', { key: stringProperty('Electron key code.'), action: stringProperty('press, down, or up') }, ['key']),
    toolDefinition('browser_type', 'Insert text at the current focused element in the explicitly bound desktop tab.', { text: stringProperty('Text to insert.') }, ['text']),
    toolDefinition('browser_fill_form', 'Fill several page controls in one call. Use this instead of repeated browser_type calls: one round trip instead of one per field, and each field is verified as it is written.', {
      fields: {
        type: 'array',
        description: 'Controls to fill, in order. Each entry targets an element index from the latest DOM snapshot.',
        minItems: 1,
        maxItems: 40,
        items: {
          type: 'object',
          properties: {
            index: numberProperty('Element index from the latest DOM snapshot.'),
            text: { type: 'string', description: 'Text to fill. An empty string clears the control.' }
          },
          required: ['index', 'text'],
          additionalProperties: false
        }
      }
    }, ['fields']),
    toolDefinition('browser_sequence', 'Run an ordered list of browser steps in ONE call and ONE round trip instead of one call per step. Use it whenever the next step does not depend on an unseen result: navigate, then fill, then click, then screenshot, or a whole keyboard/mouse chain. Every step runs against the live bound tab through the same handler a direct call would use, returns its own result, and a mid-chain failure reports the unexecuted tail instead of losing it. A step cannot read a previous step\'s return value: if the next argument comes from a fresh snapshot, a screenshot, or an element index taken after the previous step, make that a separate call.', {
      steps: {
        type: 'array',
        description: `Ordered steps, max ${SEQUENCE_MAX_STEPS}. They run one after another against the bound tab.`,
        minItems: 1,
        maxItems: SEQUENCE_MAX_STEPS,
        items: {
          type: 'object',
          properties: {
            tool: stringProperty('Browser tool name, for example browser_navigate, browser_fill_form, browser_click_element, browser_key, browser_scroll.'),
            input: objectProperty('Arguments for that tool, exactly as if it were called directly.')
          },
          required: ['tool'],
          additionalProperties: false
        }
      },
      stopOnError: booleanProperty('Default true: stop at the first failing step and report the unexecuted tail. false runs every step and reports each failure.')
    }, ['steps']),
    toolDefinition('browser_device_profiles', 'List the available desktop, tablet, and mobile device profiles.'),
    toolDefinition('browser_device_state', 'Read the active device profile, orientation, and emulated viewport for the bound tab.'),
    toolDefinition(
      'browser_set_device_mode',
      'Emulate a mobile or tablet device in the bound tab. Applies the device viewport, pixel ratio, and user agent, enables real touch input, and reloads the page so touch feature detection re-runs. While a mobile or tablet profile is active the page receives touch events only and the mouse tools are unavailable — drive it with browser_gesture. Pass profileId "desktop" to return to a normal pointer-driven page.',
      {
        profileId: stringProperty('Profile id from browser_device_profiles, or "desktop" to disable emulation.'),
        orientation: stringProperty('portrait or landscape. Defaults to portrait.'),
        showTouches: booleanProperty('Draw a circle at each touch contact, like Android\'s "Show taps". Defaults to true.')
      },
      ['profileId']
    ),
    toolDefinition('browser_rotate_device', 'Rotate the bound tab between portrait and landscape without reloading it.'),
    toolDefinition(
      'browser_gesture',
      'Perform a native touch gesture in the bound tab using real multi-touch contacts. Requires an active mobile or tablet profile. Gestures: tap, doubleTap, longPress, swipe, scroll, pinch, rotate, multiFingerSwipe.',
      {
        gesture: stringProperty('tap, doubleTap, longPress, swipe, scroll, pinch, rotate, or multiFingerSwipe.'),
        x: numberProperty('Contact X for tap, doubleTap, longPress, and scroll.'),
        y: numberProperty('Contact Y for tap, doubleTap, longPress, and scroll.'),
        startX: numberProperty('Swipe start X.'),
        startY: numberProperty('Swipe start Y.'),
        endX: numberProperty('Swipe end X.'),
        endY: numberProperty('Swipe end Y.'),
        deltaX: numberProperty('Horizontal distance for scroll and multiFingerSwipe. Positive scrolls content left.'),
        deltaY: numberProperty('Vertical distance for scroll and multiFingerSwipe. Positive scrolls content up.'),
        scale: numberProperty('Pinch scale. Above 1 zooms in, below 1 zooms out.'),
        degrees: numberProperty('Rotation angle in degrees for the rotate gesture.'),
        fingers: numberProperty('Contact count for multiFingerSwipe, 2 to 5. Defaults to 3.'),
        centerX: numberProperty('Centre X for pinch and rotate.'),
        centerY: numberProperty('Centre Y for pinch and rotate.'),
        durationMs: numberProperty('Gesture duration in milliseconds.'),
        momentum: booleanProperty('Release at speed so the page keeps scrolling. Defaults to true for scroll.')
      },
      ['gesture']
    ),
    // The desktop agent has always answered OS file pickers itself, written
    // files, and waited out long jobs. An MCP client could do none of the
    // three: it reached a picker and stalled, or polled in a loop.
    toolDefinition('browser_file_dialog_arm', 'Arm file-chooser interception for the bound tab. Call it BEFORE the click that opens a picker: the page then hands the chooser to this session instead of showing an OS dialog that no agent can see or drive.'),
    toolDefinition('browser_file_dialog_state', 'Report whether a file chooser is open, its mode (open/save/multi), and recent downloads for the bound tab.'),
    toolDefinition('browser_file_dialog_accept', 'Answer the open file chooser with real files. No OS dialog appears: the page receives the paths as if a human had picked them.', {
      files: {
        type: 'array',
        description: 'Absolute paths to attach. One path unless the chooser reported multiple: true in browser_file_dialog_state.',
        minItems: 1,
        items: { type: 'string', minLength: 1 }
      },
      selector: stringProperty('Optional CSS selector when the page uses a custom file control instead of a native input.')
    }, ['files']),
    toolDefinition('browser_file_dialog_cancel', 'Dismiss the open file chooser so the page takes its cancelled path instead of waiting forever.'),
    toolDefinition('browser_downloads_set_path', 'Send this tab\'s downloads to a directory instead of the OS Save-As prompt. Set it before triggering the download.', {
      directory: stringProperty('Absolute directory that should receive the downloads.')
    }, ['directory']),
    toolDefinition('browser_downloads_list', 'List downloads tracked for this session with state, bytes, and the destination path — use it to confirm a save finished instead of guessing.'),
    toolDefinition('browser_save_file', 'Write text or base64 content to an absolute path with no dialog and no page involved. Use it to persist what you already hold rather than round-tripping through a download.', {
      path: stringProperty('Absolute destination file path.'),
      text: stringProperty('UTF-8 text content. Pass this or base64, not both.'),
      base64: stringProperty('Base64 content for binary files. Pass this or text, not both.')
    }, ['path']),
    toolDefinition('browser_extract', 'Extract bounded page content from the bound tab: headings, prose, table cells and labels, not just interactive controls. This is the reading counterpart of browser_query_elements. Pass framePath to read a same-origin iframe reported by browser_dom_snapshot.', {
      selector: stringProperty('Optional CSS selector to narrow the extraction.'),
      text: stringProperty('Optional case-insensitive text filter.'),
      maxElements: numberProperty('Maximum records to return. Defaults to 100, max 250.'),
      framePath: framePathProperty()
    }),
    toolDefinition('browser_wait', 'Wait up to ms in ONE call, returning early once the page stops loading. Prefer one long wait over repeated short polls for a job whose duration you know.', {
      ms: numberProperty(`Positive milliseconds, max ${MAX_WAIT_MS} (15 minutes).`)
    }, ['ms']),
    toolDefinition('browser_agent_start', 'Start the Browser-use desktop agent on the explicitly bound tab.', {
      task: stringProperty('Task for the desktop agent.'),
      provider: stringProperty('Optional configured provider id, such as xkiro or ollama.'),
      connectionId: stringProperty('Optional saved AI connection id for the provider.'),
      model: stringProperty('Optional model name.'),
      baseUrl: stringProperty('Optional provider base URL.'),
      settings: objectProperty('Optional desktop-agent settings.')
    }, ['task']),
    toolDefinition('browser_agent_status', 'Read the current Browser-use desktop agent run state.'),
    toolDefinition('browser_agent_approve', 'Resolve an active Browser-use desktop agent approval request.', {
      runId: stringProperty('Desktop agent run ID.'),
      approvalId: stringProperty('Approval request ID.'),
      decision: stringProperty('allow_once or deny.')
    }, ['runId', 'approvalId', 'decision']),
    toolDefinition('browser_agent_cancel', 'Cancel an active Browser-use desktop agent run.', {
      runId: stringProperty('Desktop agent run ID.')
    }, ['runId'])
  ];
}

function booleanProperty(description) {
  return { type: 'boolean', description };
}

function toolDefinition(name, description, properties = {}, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

function stringProperty(description) {
  return { type: 'string', minLength: 1, description };
}

function objectProperty(description) {
  return { type: 'object', description, additionalProperties: true };
}

function numberProperty(description) {
  return { type: 'number', description };
}

// A same-origin iframe is a separate realm; the top-document collector cannot
// see into it. browser_dom_snapshot reports each frame's `path`, and this is how
// a caller points a later read at one of them.
function framePathProperty() {
  return {
    type: 'array',
    items: { type: 'number' },
    description: 'Frame path from browser_dom_snapshot frames[].path (e.g. [0], or [0,2] nested) to read inside that same-origin iframe instead of the top document. Coordinates still come back in top-document pixels, so results stay clickable.'
  };
}

function coordinateProperties() {
  return { x: numberProperty('Viewport X coordinate.'), y: numberProperty('Viewport Y coordinate.') };
}

function buildGptOpenApiSchema(baseUrl) {
  const paths = {};
  for (const tool of toolDefinitions().filter((item) => item.name !== 'browser_bind_tab' && !item.name.startsWith('browser_agent_'))) {
    paths[`/gpt/call/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        security: [{ ApiKeyAuth: [] }],
        requestBody: { required: true, content: { 'application/json': { schema: { ...tool.inputSchema, additionalProperties: true } } } },
        responses: { 200: { description: 'Tool result' } }
      }
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Browser-use Desktop GPT Action', version: '1.0.0', description: 'Inspect and drive the active Browser-use desktop tab through ChatGPT Actions.' },
    servers: [{ url: baseUrl }],
    components: {
      schemas: {},
      securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } }
    },
    paths
  };
}

function formatGptOutput(output, isError = false) {
  if (isError) return { ok: false, error: String(output?.error || 'Tool reported an error') };
  if (output?.mimeType === 'image/png' && output.data) {
    return { ok: true, result: { imageUrl: `data:image/png;base64,${output.data}`, tabId: output.tabId } };
  }
  return { ok: true, result: { text: JSON.stringify(output) } };
}

function safeKeyEqual(provided, expected) {
  if (!provided || !expected) return false;
  const left = crypto.createHash('sha256').update(String(provided)).digest();
  const right = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(left, right);
}

function toolResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

// Argument checks used to run only INSIDE the controller, i.e. after the
// "bind a tab" gate. A caller that sent malformed arguments and had no bound tab
// was told to bind a tab — the wrong problem to solve first, and it cost a whole
// round trip to discover the real one. These mirror the controller's own checks
// (browserViewController.assertCoordinates and friends) so the message is the
// same no matter how far the call got; the controller still enforces them, so
// this is a fast path, not the only guard.
function assertPointerArgs(args) {
  if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) throw new Error('Pointer coordinates must be finite numbers');
}

// browser_click mirrors the desktop agent's own click: an element index wins,
// coordinates are the fallback. Requiring BOTH down and up as separate MCP
// calls made a coordinate click two round trips with no shared hit evidence,
// which is the one place the MCP surface was slower than the native one.
function assertClickArgs(args) {
  const hasElement = Number.isInteger(args?.element) && args.element >= 0;
  if (hasElement) return;
  if (!Number.isFinite(args?.x) || !Number.isFinite(args?.y)) {
    throw new Error('browser_click needs either a finite element index or finite viewport x/y coordinates');
  }
}

function assertScrollArgs(args) {
  const deltaX = args?.deltaX === undefined ? 0 : args.deltaX;
  const deltaY = args?.deltaY === undefined ? 0 : args.deltaY;
  if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) throw new Error('Scroll deltas must be finite numbers');
  if ((args?.x !== undefined && !Number.isFinite(args.x)) || (args?.y !== undefined && !Number.isFinite(args.y))) {
    throw new Error('Scroll coordinates must be finite numbers');
  }
}

function assertKeyArgs(args) {
  if (typeof args?.key !== 'string' || args.key.length === 0) throw new Error('Key is required');
}

function assertDragArgs(args) {
  const hasFrom = args?.fromElement !== undefined && args.fromElement !== null && args.fromElement !== '';
  const hasTo = args?.toElement !== undefined && args.toElement !== null && args.toElement !== '';
  if (hasFrom || hasTo) {
    if (!hasFrom || !hasTo) throw new Error('browser_drag needs BOTH fromElement and toElement, or a complete (startX, startY) to (endX, endY) coordinate pair.');
    return;
  }
  if (!Number.isFinite(args?.startX) || !Number.isFinite(args?.startY)) throw new Error('Pointer coordinates must be finite numbers');
  if (!Number.isFinite(args?.endX) || !Number.isFinite(args?.endY)) throw new Error('Pointer coordinates must be finite numbers');
}

// An empty file list is not a smaller answer than one path — it is the page
// being told "you picked nothing" while still believing a human chose. Refuse
// it here so the caller cannot silently turn a file input into a no-op.
function assertFileDialogAccept(args) {
  const files = args?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('browser_file_dialog_accept needs files: a non-empty array of absolute paths.');
  }
  const bad = files.find((entry) => typeof entry !== 'string' || !entry.trim());
  if (bad !== undefined) throw new Error('browser_file_dialog_accept needs every entry in files to be a non-empty absolute path.');
}

// Writing a file is the one call here that can destroy something the user
// cannot get back, so the arguments are checked for the two ways it can go
// wrong: no destination, and no content (which would truncate the target to
// nothing) — or both encodings, where the winner would be arbitrary.
function assertSaveFileArgs(args) {
  if (typeof args?.path !== 'string' || !args.path.trim()) {
    throw new Error('browser_save_file needs an absolute destination path.');
  }
  const hasText = typeof args?.text === 'string';
  const hasBase64 = typeof args?.base64 === 'string';
  if (!hasText && !hasBase64) {
    throw new Error('browser_save_file needs text (UTF-8) or base64 (binary) content; refusing to write an empty file.');
  }
  if (hasText && hasBase64) {
    throw new Error('browser_save_file takes text OR base64, not both — the encoding must be unambiguous.');
  }
}

function assertWaitArgs(args) {
  const ms = Number(args?.ms);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`browser_wait needs a positive ms value (max ${MAX_WAIT_MS}).`);
  }
  if (ms > MAX_WAIT_MS) {
    throw new Error(`browser_wait accepts at most ${MAX_WAIT_MS}ms (15 minutes) per call; for a longer job, wait again after this one returns.`);
  }
}

// Wait out a job in ONE call, returning early the moment the page stops
// loading. Mirrors the desktop agent's own wait: while a navigation is in
// flight, poll it in short steps so the caller gets the settled state as soon
// as it exists; once the page is idle, sleep in two-second chunks so a
// cancellation or a shutdown is still noticed promptly.
async function waitForSettle(controller, tabId, args) {
  const requestedMs = Math.min(Math.round(Number(args.ms)), MAX_WAIT_MS);
  const startedAt = Date.now();
  const read = async () => { try { return await controller.navigationState(tabId); } catch { return null; } };
  const first = await read();
  if (first?.loading) {
    for (;;) {
      const navigation = await read();
      const elapsed = Date.now() - startedAt;
      if (!navigation?.loading || elapsed >= requestedMs) {
        return {
          tabId,
          requestedMs,
          waitedMs: elapsed,
          settled: Boolean(navigation && !navigation.loading),
          ...(navigation?.loading ? { stillLoading: true } : {})
        };
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(300, Math.max(0, requestedMs - elapsed))));
    }
  }
  while (Date.now() - startedAt < requestedMs) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(0, requestedMs - (Date.now() - startedAt)))));
  }
  const after = await read();
  return {
    tabId,
    requestedMs,
    waitedMs: Date.now() - startedAt,
    settled: Boolean(after && !after.loading),
    ...(after?.loading ? { stillLoading: true } : {})
  };
}

// MCP distinguishes a FAILED TOOL from a FAILED EXCHANGE. A tool that rejects
// its arguments, or reports a stale element, or times out on a stuck native
// surface, completed the protocol exchange correctly: the answer is "this call
// failed", and the client should hand that answer to the model so it can adapt.
// Returning it as a JSON-RPC error with HTTP 400 instead makes every ordinary
// recoverable state look like a broken connection, so clients retry the
// transport or drop the server rather than reading the message and moving on.
// Only protocol-level faults (unknown method, unknown session, revoked
// capability) stay JSON-RPC errors.
function toolFailure(error, toolName) {
  const message = String(error?.message || error || 'The tool call failed.');
  return toolResult({ error: message, ...(toolName ? { tool: toolName } : {}) }, true);
}

function isProtocolError(error) {
  return error?.code === 'METHOD_NOT_FOUND'
    || error?.code === 'UNAUTHORIZED'
    || error?.code === 'MCP_SESSION';
}

// Runs a tool with an upper bound. Synchronous throws propagate unchanged so
// argument validation still reports its own message rather than a timeout.
function callWithDeadline(run, timeoutMs, toolName) {
  const result = run();
  if (!result || typeof result.then !== 'function') return Promise.resolve(result);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${toolName} did not complete within ${timeoutMs}ms`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    result.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function isJsonRpcRequest(value) {
  return value && typeof value === 'object' && value.jsonrpc === '2.0' && typeof value.method === 'string';
}

function bearerCapability(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '');
  return match?.[1] || '';
}

function mcpSessionHeaders(sessionId) {
  return sessionId ? { 'Mcp-Session-Id': sessionId } : {};
}

function headerString(request, name) {
  const value = request?.headers?.[String(name || '').toLowerCase()];
  return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}

function hostFromInitialize(clientInfo) {
  if (!clientInfo || typeof clientInfo !== 'object') return { name: 'MCP host', version: '1.0.0' };
  return { name: clientInfo.name, version: clientInfo.version };
}

function unauthorized(message) {
  const error = new Error(message || 'Unauthorized session capability');
  error.code = 'UNAUTHORIZED';
  return error;
}

function unknownMcpSession() {
  const error = new Error('Unknown or expired MCP session. Send initialize with the pairing header to open or recover a session.');
  error.code = 'MCP_SESSION';
  return error;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Connection', 'close');
}

function sendJson(response, status, value, headers = {}) {
  for (const [name, headerValue] of Object.entries(headers)) response.setHeader(name, headerValue);
  response.statusCode = status;
  response.end(JSON.stringify(value));
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function methodNotFound(message = 'Method not found') {
  const error = new Error(message);
  error.code = 'METHOD_NOT_FOUND';
  return error;
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

module.exports = { LocalMcpServer, MAX_BODY_BYTES, REQUEST_TIMEOUT_MS };
