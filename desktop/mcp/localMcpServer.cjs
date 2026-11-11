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
    if (request.method !== 'POST') return sendJson(response, 405, { error: 'Only POST is supported' });
    try {
      return this.handleMcp(await readJson(request), request, response);
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
    return true;
  }

  async dispatch(message, capability) {
    if (message.method === 'initialize') {
      return {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'browser-use-desktop', version: SERVER_VERSION },
        instructions: 'Use the short-lived X-Browser-Use-Pairing-Code header only to bootstrap or recover a connection. Retain the returned Mcp-Session-Id on later MCP requests. Pairing enables every Desktop MCP tool immediately; bind a tab before using tab-scoped tools.'
      };
    }
    if (message.method === 'notifications/initialized' || message.method === 'ping') {
      this.broker.authenticate(capability);
      return {};
    }
    if (message.method === 'tools/list') {
      this.broker.authenticate(capability);
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
      if (this.getControlMode() !== 'agi' || !this.getComputerTools) throw new Error('Computer tools require AGI mode in Browser-use Settings.');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000);
      let output;
      try {
        output = await callWithDeadline(() => this.getComputerTools().execute(name, args, `mcp:${session.id}`, { signal: controller.signal }), 26_000, name);
      } finally { clearTimeout(timer); }
      if (name === 'computer_screenshot' && output?.data) {
        const { data, ...metadata } = output;
        return { content: [{ type: 'text', text: JSON.stringify(metadata) }, { type: 'image', data, mimeType: output.mimeType }], isError: false };
      }
      return toolResult(output, output?.state === 'failed');
    }
    if (typeof name !== 'string') throw methodNotFound('A tool name is required');
    if (name.startsWith('browser_agent_')) return this.callAgentTool(name, args, capability);
    if (name === 'browser_bind_tab') {
      this.broker.authorize(capability, 'browser_get_tabs');
      const tab = this.controller.getTab(args.tabId);
      const session = this.broker.bindTab(capability, tab.id);
      return toolResult(session);
    }

    const tool = TOOL_HANDLERS[name];
    if (!tool) throw methodNotFound('Unknown MCP tool');
    const session = this.broker.authorize(capability, name);
    const boundTabId = session.tabId;
    if (!boundTabId && tool.requiresTab) {
      throw new Error('Bind a desktop tab before calling this tool');
    }
    // A tool that never settles would hold this HTTP request open forever, leaking
    // a connection and consuming the caller's rate-limit budget. Every tool is
    // therefore bounded, so a stuck native surface surfaces as an error.
    const output = await callWithDeadline(
      () => tool.run(this.controller, boundTabId, args, session.id),
      tool.timeoutMs || TOOL_TIMEOUT_MS,
      name
    );
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
  browser_search: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId, args) => controller.search(tabId, args) },
  browser_fetch: { requiresTab: false, timeoutMs: 20_000, run: (controller, _tabId, args) => controller.fetchPage(args) },
  browser_mousemove: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.mouseMove(tabId, args, { sessionId }) },
  browser_mousedown: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.mouseDown(tabId, args, sessionId) },
  browser_mouseup: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.mouseUp(tabId, args, sessionId) },
  browser_drag: { requiresTab: true, timeoutMs: 15_000, run: (controller, tabId, args, sessionId) => controller.drag(tabId, args, sessionId) },
  browser_scroll: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.scroll(tabId, args, sessionId) },
  browser_key: { requiresTab: true, run: (controller, tabId, args, sessionId) => controller.key(tabId, args, sessionId) },
  browser_type: { requiresTab: true, run: (controller, tabId, args) => controller.type(tabId, args) },
  browser_device_profiles: { requiresTab: false, run: () => listDeviceProfiles() },
  browser_device_state: { requiresTab: true, run: (controller, tabId) => controller.deviceState(tabId) },
  // Switching profiles reloads the page so feature detection re-runs, which can
  // outlast the default tool ceiling on a slow document.
  browser_set_device_mode: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId, args) => controller.setDeviceMode(tabId, args) },
  browser_rotate_device: { requiresTab: true, timeoutMs: 20_000, run: (controller, tabId) => controller.rotateDevice(tabId) },
  // A gesture is time-based by nature: a long press or a slow swipe is meant to
  // take most of a second, so it gets more room than an instantaneous call.
  browser_gesture: { requiresTab: true, timeoutMs: 30_000, run: (controller, tabId, args) => controller.gesture(tabId, args) }
};

function toolDefinitions() {
  return [
    toolDefinition('browser_get_tabs', 'List Browser-use desktop tabs.'),
    toolDefinition('browser_new_tab', 'Create an isolated background tab without changing existing tabs.', { url: stringProperty('Initial URL. Defaults to about:blank.') }),
    toolDefinition('browser_close_tab', 'Close an explicitly named Browser-use tab.', { tabId: stringProperty('Tab ID to close.') }, ['tabId']),
    toolDefinition('browser_bind_tab', 'Explicitly bind this MCP session to one Browser-use desktop tab.', { tabId: stringProperty('Desktop tab ID') }),
    toolDefinition('browser_get_tab', 'Inspect the explicitly bound desktop tab.'),
    toolDefinition('browser_dom_snapshot', 'List interactive elements and their geometry for the explicitly bound desktop tab.', {
      interactiveOnly: booleanProperty('Limit the snapshot to interactive controls. Defaults to true.'),
      includeText: booleanProperty('Include bounded visible text in each element record. Defaults to true.'),
      maxElements: numberProperty('Maximum number of elements to return. Defaults to 200, max 500.')
    }),
    toolDefinition('browser_query_elements', 'Query elements by selector or text in the explicitly bound desktop tab.', {
      selector: stringProperty('Optional CSS selector to narrow the search.'),
      text: stringProperty('Optional case-insensitive text, label, or data-tool filter.'),
      interactiveOnly: booleanProperty('Limit the result to interactive controls. Defaults to true.'),
      includeText: booleanProperty('Include bounded visible text in each element record. Defaults to true.'),
      maxElements: numberProperty('Maximum number of elements to return. Defaults to 50, max 500.')
    }),
    toolDefinition('browser_execute', 'Execute one bounded asynchronous JavaScript command inside the explicitly bound page. Return a compact JSON-serializable proof object. The script has browser-page authority only; it cannot access Node, Electron, files, or other tabs.', { script: stringProperty('Async page JavaScript body. Must return proof JSON.') }, ['script']),
    toolDefinition('browser_element_rect', 'Re-read one indexed element from the current DOM snapshot and return its live geometry.', { index: numberProperty('Snapshot index from browser_dom_snapshot.') }, ['index']),
    toolDefinition('browser_click_element', 'Click an indexed element from the latest DOM snapshot in the explicitly bound desktop tab.', { index: numberProperty('Snapshot index from browser_dom_snapshot.'), button: stringProperty('left, middle, or right') }, ['index']),
    toolDefinition('browser_screenshot', 'Capture a PNG screenshot from the explicitly bound tab.'),
    toolDefinition('browser_console_entries', 'Read console entries from the explicitly bound tab.'),
    toolDefinition('browser_network_entries', 'Read network failures from the explicitly bound tab.'),
    toolDefinition('browser_navigation_state', 'Read navigation state for the explicitly bound tab.'),
    toolDefinition('browser_navigate', 'Navigate the active desktop tab.', { url: stringProperty('http(s) URL') }, ['url']),
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
    }, ['startX', 'startY', 'endX', 'endY']),
    toolDefinition('browser_scroll', 'Scroll the explicitly bound desktop tab.', { deltaX: numberProperty('Horizontal pixel delta.'), deltaY: numberProperty('Vertical pixel delta.') }),
    toolDefinition('browser_key', 'Send a key press, key down, or key up to the explicitly bound desktop tab.', { key: stringProperty('Electron key code.'), action: stringProperty('press, down, or up') }, ['key']),
    toolDefinition('browser_type', 'Insert text at the current focused element in the explicitly bound desktop tab.', { text: stringProperty('Text to insert.') }, ['text']),
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
