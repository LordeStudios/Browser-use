import http from 'node:http';
import { WebSocketServer } from 'ws';
import { executeTool } from '../tools/toolExecutor.js';
import { controlCenterHtml } from '../ui/controlCenter.js';
import { RealtimeServer } from '../realtime/realtimeServer.js';

const REALTIME_PATH = '/realtime/v1';

async function readJson(request, maxBytes = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

function publicPairingOffer(pairing) {
  return pairing.createOffer();
}

function realtimeStatus(ctx) {
  return { endpoint: REALTIME_PATH, pairing: ctx.pairing.status() };
}

async function handlePairingRequest(ctx, request, response) {
  if (!ctx.pairing) return false;
  if (request.url === '/pairing/offer' && request.method === 'POST') {
    sendJson(response, 200, { ok: true, offer: publicPairingOffer(ctx.pairing) });
    return true;
  }
  if (request.url === '/pairing/status' && request.method === 'GET') {
    sendJson(response, 200, { ok: true, ...realtimeStatus(ctx) });
    return true;
  }
  if (request.url === '/pairing/pair' && request.method === 'POST') {
    try {
      const payload = await readJson(request);
      const session = ctx.pairing.pair(payload);
      sendJson(response, 201, { ok: true, session });
    } catch (error) {
      sendJson(response, 401, { ok: false, error: error.message });
    }
    return true;
  }
  if (request.url?.startsWith('/pairing/revoke/') && request.method === 'POST') {
    const sessionId = decodeURIComponent(request.url.slice('/pairing/revoke/'.length));
    sendJson(response, 200, { ok: true, revoked: ctx.pairing.revoke(sessionId) });
    return true;
  }
  return false;
}

async function handleHttpRequest(ctx, request, response) {
  if (await handlePairingRequest(ctx, request, response)) return;
  if (request.url === '/' || request.url === '/ui') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(controlCenterHtml(ctx.sessionId));
    return;
  }
  if (request.url === '/state') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(await currentState(ctx)));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ ok: true, sessionId: ctx.sessionId, paths: ['/', '/state', '/events', '/commands', '/ui', '/pairing/offer', '/pairing/pair', REALTIME_PATH] }));
}

function currentState(ctx) {
  return ctx.browser.getCurrentInfo()
    .then((info) => ({ type: 'ui.state', info, diagnostics: ctx.browser.diagnostics.snapshot() }))
    .catch((error) => ({ type: 'ui.state', info: { error: error.message }, diagnostics: ctx.browser.diagnostics.snapshot() }));
}

export function startWebSocketServer(ctx, registry, { port = 8765, maxAttempts = 10 } = {}) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      handleHttpRequest(ctx, request, response).catch((error) => sendJson(response, 500, { ok: false, error: error.message }));
    });
    const wss = new WebSocketServer({ noServer: true });
    const realtime = ctx.pairing ? new RealtimeServer({ httpServer: server, pairing: ctx.pairing, browser: ctx.browser, eventBus: ctx.eventBus }) : null;
    const clients = new Set();
    server.on('upgrade', (request, socket, head) => {
      if (new URL(request.url || '/', 'http://localhost').pathname === REALTIME_PATH) return;
      wss.handleUpgrade(request, socket, head, (websocket) => {
        websocket.path = request.url;
        wss.emit('connection', websocket, request);
      });
    });
    wss.on('connection', async (websocket) => {
      clients.add(websocket);
      websocket.send(JSON.stringify(await currentState(ctx)));
      websocket.on('message', async (raw) => {
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          websocket.send(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
          return;
        }
        if (message.type === 'ui.state') {
          websocket.send(JSON.stringify(await currentState(ctx)));
          return;
        }
        if (websocket.path === '/extension') {
          ctx.eventBus.emitEvent('extension.message', message);
          websocket.send(JSON.stringify({ ok: true, type: 'extension.ack' }));
          return;
        }
        if (message.command) {
          const result = await executeTool(ctx, registry, message.command, message.args || {});
          websocket.send(JSON.stringify({ id: message.id || `cmd-${Date.now()}`, ...result }));
        }
      });
      websocket.on('close', () => clients.delete(websocket));
    });
    const onEvent = (event) => {
      const payload = JSON.stringify({ type: 'event', event });
      for (const client of clients) if (client.readyState === 1) client.send(payload);
    };
    ctx.eventBus.on('event', onEvent);
    const heartbeat = setInterval(() => ctx.eventBus.emitEvent('heartbeat', { info: 'headed runtime alive' }), 10_000);
    let attempts = 0;
    const tryListen = (candidatePort) => {
      attempts += 1;
      server.once('error', (error) => {
        if ((error.code === 'EADDRINUSE' || error.code === 'EACCES') && attempts < maxAttempts) tryListen(candidatePort + 1);
        else reject(error);
      });
      server.listen(candidatePort, '127.0.0.1', () => {
        server.removeAllListeners('error');
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : candidatePort;
        ctx.eventBus.emitEvent('server.listen', { port: actualPort, controlCenter: `http://127.0.0.1:${actualPort}/`, realtime: Boolean(realtime) });
        resolve({
          server,
          wss,
          realtime,
          actualPort,
          controlCenterUrl: `http://127.0.0.1:${actualPort}/`,
          close: async () => {
            clearInterval(heartbeat);
            ctx.eventBus.off('event', onEvent);
            await realtime?.close();
            await new Promise((done) => server.close(done));
          }
        });
      });
    };
    tryListen(port);
  });
}
