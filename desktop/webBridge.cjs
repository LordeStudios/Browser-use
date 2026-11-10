// desktop/webBridge.cjs
//
// Loopback control bridge for the web GUI (cli/tui/guiServer.mjs).
//
// The browser-based GUI loads the desktop renderer, but a plain browser has
// no Electron preload: every window.browserUseDesktop.* call used to die or
// fall back to preview stubs. This module lets the web GUI invoke the SAME
// ipcMain.handle handlers the Electron renderer uses, and mirrors
// renderer-bound 'browser-use:*' events over SSE so chat streaming, state
// updates, and notifications work for real.
//
// Security: bound to 127.0.0.1 only. No bearer credential — loopback only,
// same trust boundary as the desktop app's own MCP HTTP server.

'use strict';

const http = require('node:http');

// channel -> handler captured from ipcMain.handle registrations
const invokeHandlers = new Map();
// channel -> handler captured from ipcMain.on registrations (send-style)
const onHandlers = new Map();
// live SSE responses
const sseClients = new Set();

let server = null;
let bridgePort = 0;
const PORT_CANDIDATES = [4210, 4211, 4212, 4213, 4214, 4215, 4216, 4217, 4218, 4219];
const MAX_BODY_BYTES = 32 * 1024 * 1024; // attachments/settings payloads can be large

/**
 * Capture every ipcMain.handle / ipcMain.on registration so the bridge can
 * dispatch to the exact same handlers the Electron renderer talks to.
 * Must be installed BEFORE any ipcMain.handle call (top of main.cjs).
 * @param {{ ipcMain: Electron.IpcMain }} electron
 */
function installIpcCapture({ ipcMain } = {}) {
  if (!ipcMain || ipcMain.__webBridgeCaptured) return;
  ipcMain.__webBridgeCaptured = true;
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => {
    if (typeof channel === 'string' && typeof handler === 'function') invokeHandlers.set(channel, handler);
    return origHandle(channel, handler);
  };
  const origOn = ipcMain.on.bind(ipcMain);
  ipcMain.on = (channel, handler) => {
    if (typeof channel === 'string' && typeof handler === 'function') onHandlers.set(channel, handler);
    return origOn(channel, handler);
  };
}

/**
 * Mirror a renderer-bound event to every connected web GUI SSE client.
 * @param {string} channel
 * @param {unknown} payload
 */
function broadcastEvent(channel, payload) {
  if (!sseClients.size) return;
  let frame;
  try {
    // Data-only frame: named `event:` frames never reach EventSource.onmessage.
    frame = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  } catch {
    return; // non-serializable payload — never break the native send path
  }
  for (const res of sseClients) {
    try { res.write(frame); } catch { sseClients.delete(res); }
  }
}

/**
 * Wrap a webContents.send so every 'browser-use:*' event bound for the
 * Electron renderer is also mirrored to the web GUI. Never throws.
 * @param {Electron.WebContents} contents
 */
function attachWebContents(contents) {
  if (!contents || contents.__webBridgePatched || typeof contents.send !== 'function') return;
  contents.__webBridgePatched = true;
  const origSend = contents.send.bind(contents);
  contents.send = (channel, ...args) => {
    try {
      if (
        typeof channel === 'string' &&
        channel.startsWith('browser-use:') &&
        // High-frequency media frames are useless (and huge) over SSE.
        channel !== 'browser-use:android-stream-frame'
      ) {
        broadcastEvent(channel, args[0]);
      }
    } catch { /* mirroring must never break native sends */ }
    return origSend(channel, ...args);
  };
}

// Handlers use event.sender to resolve which chat window the call came from.
// A null sender matches no chat window, so calls route to the primary
// desktopChatAgent — exactly what the web GUI wants.
const STUB_EVENT = {
  sender: null,
  senderFrame: null,
  processId: -1,
  frameId: -1,
  _webBridgeStub: true,
  reply: () => {},
};

/**
 * Invoke a captured IPC handler. Returns { ok, result } or { ok:false, error }.
 * @param {string} channel
 * @param {unknown[]} args
 */
function invoke(channel, args) {
  const handler = invokeHandlers.get(channel) || onHandlers.get(channel);
  if (!handler) return Promise.resolve({ ok: false, error: `no handler registered for ${channel}` });
  return Promise.resolve()
    .then(() => handler(STUB_EVENT, ...(Array.isArray(args) ? args : [])))
    .then((result) => ({ ok: true, result: result === undefined ? null : result }))
    .catch((err) => ({ ok: false, error: String((err && err.message) || err) }));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function json(res, status, body) {
  if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
  try {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  } catch { /* socket already gone */ }
}

function requestListener(req, res) {
  const urlPath = String(req.url || '').split('?')[0];
  if (req.method === 'GET' && urlPath === '/health') {
    json(res, 200, { ok: true, pid: process.pid, port: bridgePort, role: 'desktop-web-bridge' });
    return;
  }
  if (req.method === 'GET' && urlPath === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* drop */ }
    }, 20000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && urlPath === '/ipc') {
    readBody(req)
      .then((raw) => {
        let parsed;
        try { parsed = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid JSON body' }); }
        const channel = String(parsed.channel || '');
        if (!channel.startsWith('browser-use:')) return json(res, 400, { ok: false, error: 'channel must start with browser-use:' });
        return invoke(channel, parsed.args).then((result) => json(res, 200, result));
      })
      .catch((err) => json(res, 500, { ok: false, error: String((err && err.message) || err) }));
    return;
  }
  json(res, 404, { ok: false, error: 'not found' });
}

/**
 * Start the loopback control server. Tries 127.0.0.1:4210..4219.
 * @returns {Promise<number>} the bound port, or 0 on failure
 */
function startServer() {
  if (server) return Promise.resolve(bridgePort);
  return new Promise((resolve) => {
    const tryListen = (index) => {
      if (index >= PORT_CANDIDATES.length) return resolve(0);
      const candidate = PORT_CANDIDATES[index];
      const srv = http.createServer(requestListener);
      srv.on('error', () => tryListen(index + 1));
      srv.listen(candidate, '127.0.0.1', () => {
        server = srv;
        bridgePort = candidate;
        resolve(candidate);
      });
    };
    tryListen(0);
  });
}

function stopServer() {
  if (!server) return;
  try { server.close(); } catch { /* ignore */ }
  server = null;
  bridgePort = 0;
  for (const res of sseClients) { try { res.end(); } catch { /* gone */ } }
  sseClients.clear();
}

module.exports = {
  installIpcCapture,
  attachWebContents,
  broadcastEvent,
  startServer,
  stopServer,
  getPort: () => bridgePort,
};
