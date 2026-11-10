import http from 'node:http';
import { SessionStore } from './sessionStore.js';
import { makeDaemonSecret, signMcpToken, requireMcpAuth, cleanMcpKey } from './mcpAuth.js';
import { MCP_PROTOCOL_VERSION, listToolDefinitions, readResource, callMcpTool, prompts, resources, getPrompt } from './mcpDispatch.js';
import { handleGptRequest } from './gptBridge.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS_PER_MINUTE = 300;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers
  });
  response.end(payload);
}

function readJson(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

// Streamable HTTP MCP server mirroring McpSession.handleStandardMcp in
// studios/src/worker.js: one persistent browser runtime, session records keyed
// by Mcp-Session-Id, bearer-token auth, SSE mirror stream, GPT Action bridge.
export class HttpMcpServer {
  constructor(ctx, registry, { host = '127.0.0.1', port = 8790, secret = null, sessionTtlMs, gptKey = null } = {}) {
    this.ctx = ctx;
    this.registry = registry;
    this.host = host;
    this.port = port;
    this.secret = secret || process.env.BROWSER_USE_MCP_SECRET || makeDaemonSecret();
    this.secretWasGenerated = !secret && !process.env.BROWSER_USE_MCP_SECRET;
    this.gptKey = gptKey || process.env.BROWSER_USE_GPT_KEY || null;
    this.sessions = new SessionStore(sessionTtlMs ? { ttlMs: sessionTtlMs } : {});
    this.sseClients = new Set();
    this.requestWindows = new Map();
    this.server = null;
  }

  async start() {
    if (this.server) return this.status();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        try {
          sendJson(response, 500, { error: String(error?.message || error).slice(0, 300) });
        } catch {}
      });
    });
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    const address = this.server.address();
    this.actualPort = typeof address === 'object' && address ? address.port : this.port;
    this.ctx.eventBus.emitEvent('mcp.listen', { transport: 'http', host: this.host, port: this.actualPort });
    return this.status();
  }

  async stop() {
    for (const client of [...this.sseClients]) this.removeSseClient(client);
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }

  status() {
    return {
      listening: Boolean(this.server),
      endpoint: `http://${this.host}:${this.actualPort || this.port}/mcp`,
      tokenEndpoint: `http://${this.host}:${this.actualPort || this.port}/mcp/token`,
      sseEndpoint: `http://${this.host}:${this.actualPort || this.port}/mcp/sse`,
      gptEndpoint: this.gptKey ? `http://${this.host}:${this.actualPort || this.port}/gpt/openapi.json` : null,
      sessions: this.sessions.status()
    };
  }

  consumeRequest(address) {
    const now = Date.now();
    const recent = (this.requestWindows.get(address) || []).filter((t) => t > now - 60_000);
    if (recent.length >= MAX_REQUESTS_PER_MINUTE) return false;
    recent.push(now);
    this.requestWindows.set(address, recent);
    return true;
  }

  jsonRpcError(response, id, code, message, sessionId = null, status = 200) {
    const headers = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
    sendJson(response, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, headers);
  }

  jsonRpcResult(response, id, result, sessionId) {
    const body = { jsonrpc: '2.0', id, result };
    sendJson(response, 200, body, sessionId ? { 'Mcp-Session-Id': sessionId } : {});
    this.broadcastSse('message', body);
  }

  addSseClient(response) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    });
    const client = { response };
    response.write(`event: endpoint\ndata: ${JSON.stringify({ endpoint: '/mcp' })}\n\n`);
    this.sseClients.add(client);
    response.on('close', () => this.removeSseClient(client));
    return client;
  }

  removeSseClient(client) {
    if (!client) return;
    this.sseClients.delete(client);
    try { client.response.end(); } catch {}
  }

  broadcastSse(event, data) {
    if (this.sseClients.size === 0) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.sseClients]) {
      try {
        client.response.write(payload);
      } catch {
        this.removeSseClient(client);
      }
    }
  }

  async handle(request, response) {
    const remote = request.socket.remoteAddress;
    if (this.host === '127.0.0.1' && !isLoopback(remote)) {
      return sendJson(response, 403, { error: 'Loopback connections only.' });
    }
    if (!this.consumeRequest(remote)) {
      return sendJson(response, 429, { error: 'Request limit exceeded' });
    }
    const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, X-API-Key'
      });
      return response.end();
    }

    if (url.pathname.startsWith('/gpt')) {
      return handleGptRequest(this, request, response, url);
    }

    if (url.pathname === '/mcp/token' && request.method === 'POST') {
      let payload;
      try {
        payload = await readJson(request);
      } catch (error) {
        return sendJson(response, 400, { error: error.message });
      }
      const key = cleanMcpKey(payload?.key);
      if (!key) return sendJson(response, 400, { error: 'Missing key parameter.' });
      const token = signMcpToken(key, this.secret);
      if (!token) return sendJson(response, 500, { error: 'Failed to issue token.' });
      return sendJson(response, 200, { ok: true, mode: 'jwt', token });
    }

    if (url.pathname === '/mcp/sse' && request.method === 'GET') {
      const auth = requireMcpAuth(request, this.secret);
      if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });
      this.addSseClient(response);
      return undefined;
    }

    if (url.pathname !== '/mcp') {
      if (url.pathname === '/' && request.method === 'GET') {
        return sendJson(response, 200, {
          ok: true,
          service: 'browser-use MCP relay',
          endpoints: {
            mcp: '/mcp (standard Streamable HTTP MCP; supports POST/GET/DELETE)',
            token: '/mcp/token',
            sse: '/mcp/sse',
            gpt: this.gptKey ? '/gpt/openapi.json' : null
          },
          auth: 'Standard MCP clients must send Authorization: Bearer <token>.'
        });
      }
      return sendJson(response, 404, { error: 'Endpoint not found.' });
    }

    if (request.method === 'GET') {
      return sendJson(response, 200, {
        ok: true,
        service: 'browser-use MCP relay',
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: 'browser-use', version: '0.4.0' }
      });
    }

    const auth = requireMcpAuth(request, this.secret);
    if (!auth.ok) return sendJson(response, auth.status, { error: auth.error });

    if (request.method === 'DELETE') {
      const sessionId = request.headers['mcp-session-id'];
      const closed = typeof sessionId === 'string' ? this.sessions.close(sessionId) : false;
      return sendJson(response, 200, { ok: true, closed, message: 'Session closed.' });
    }

    if (request.method !== 'POST') {
      return sendJson(response, 405, { error: 'Method not allowed. Use POST.' });
    }

    let payload;
    try {
      payload = await readJson(request);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
    return this.handleStandardMcp(request, response, payload);
  }

  async handleStandardMcp(request, response, payload) {
    if (!payload || typeof payload !== 'object' || payload.jsonrpc !== '2.0' || typeof payload.method !== 'string') {
      return this.jsonRpcError(response, payload?.id, -32600, 'Invalid Request');
    }
    const { method, id, params = {} } = payload;

    if (method === 'initialize') {
      const session = this.sessions.create(params.clientInfo);
      return this.jsonRpcResult(response, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
          logging: {}
        },
        serverInfo: { name: 'browser-use', version: '0.4.0' }
      }, session.id);
    }

    const sessionId = request.headers['mcp-session-id'];
    const session = this.sessions.touch(sessionId);
    if (!session) {
      return this.jsonRpcError(response, id, -32001, 'Unknown or expired MCP session. Send initialize to open a new session.');
    }

    if (method === 'notifications/initialized') {
      response.writeHead(202, { 'Mcp-Session-Id': session.id });
      return response.end();
    }

    if (method === 'ping') {
      return this.jsonRpcResult(response, id, {}, session.id);
    }

    if (method === 'tools/list') {
      return this.jsonRpcResult(response, id, { tools: listToolDefinitions(this.registry) }, session.id);
    }

    if (method === 'tools/call') {
      const outcome = await callMcpTool(this.ctx, this.registry, params?.name, params?.arguments || {});
      if (outcome.error) return this.jsonRpcError(response, id, outcome.error.code, outcome.error.message, session.id);
      return this.jsonRpcResult(response, id, outcome.result, session.id);
    }

    if (method === 'resources/list') {
      return this.jsonRpcResult(response, id, { resources }, session.id);
    }

    if (method === 'resources/read') {
      const uri = params?.uri || '';
      const resource = await readResource(this.ctx, uri);
      return this.jsonRpcResult(response, id, { contents: [{ uri, text: JSON.stringify(resource) }] }, session.id);
    }

    if (method === 'prompts/list') {
      return this.jsonRpcResult(response, id, { prompts }, session.id);
    }

    if (method === 'prompts/get') {
      const name = params?.name;
      const prompt = await getPrompt(name);
      if (!prompt) return this.jsonRpcError(response, id, -32602, `Unknown prompt: ${name}`, session.id);
      return this.jsonRpcResult(response, id, { description: prompt.description, messages: prompt.messages }, session.id);
    }

    return this.jsonRpcError(response, id, -32601, `Method not found: ${method}`, session.id);
  }
}

export function startHttpMcpServer(ctx, registry, options = {}) {
  const server = new HttpMcpServer(ctx, registry, options);
  return server.start().then(() => server);
}
