// cli/tui/guiServer.mjs
//
// Minimal HTTP server that serves the browser-use desktop renderer.
// Used by the /browser CLI command to launch the GUI in a browser tab.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import * as guiBackend from './guiBackend.mjs';
import { WEB_SHELL_JS } from './webShell.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RENDERER_DIR = path.resolve(__dirname, '../../desktop/renderer');
// The page references ../assets/... (Electron loadFile resolves it into the
// sibling desktop/assets dir). Over plain HTTP that becomes /assets/... —
// serve it explicitly instead of letting it fall through to index.html.
const ASSETS_DIR = path.resolve(RENDERER_DIR, '../assets');
const DEFAULT_PORT = 4200;

// Loopback control bridge inside the running desktop app (desktop/webBridge.cjs).
// The web GUI proxies /ipc and /events here so chat, settings, history, and
// every other feature work against the SAME backend the desktop app uses.
const BRIDGE_PORTS = [4210, 4211, 4212, 4213, 4214, 4215, 4216, 4217, 4218, 4219];
let _bridgeBase = null;
let _bridgeCheckedAt = 0;

async function bridgeBaseUrl() {
  const now = Date.now();
  if (_bridgeBase && now - _bridgeCheckedAt < 10000) return _bridgeBase;
  _bridgeCheckedAt = now;
  for (const port of BRIDGE_PORTS) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 500);
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        _bridgeBase = `http://127.0.0.1:${port}`;
        return _bridgeBase;
      }
    } catch { /* try next port */ }
  }
  _bridgeBase = null;
  return null;
}

/** @type {http.Server|null} */
let _server = null;
/** @type {number} */
let _port = DEFAULT_PORT;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    // Inject the web-only shell (tab preview, etc.) into the page. The
    // desktop app never loads files through this server, so Electron is
    // untouched.
    if (String(filePath).toLowerCase().endsWith('.html')) {
      let html = String(data);
      if (!html.includes('/web-shell.js')) {
        html = html.replace(/<\/body>/i, '<script src="/web-shell.js"></script></body>');
      }
      res.writeHead(200, { 'Content-Type': getContentType(filePath), 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }
    res.writeHead(200, { 'Content-Type': getContentType(filePath) });
    res.end(data);
  });
}

// curl.exe fallback transport: Node's fetch (undici) can hit connect timeouts on
// some hosts (e.g. Cloudflare-fronted providers) where curl.exe connects fine.
function curlFetch(target, headers, cb) {
  const curlPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe')
    : 'curl';
  const args = ['-sS', '--max-time', '25', '-L', '-w', '\n__CURL_STATUS__:%{http_code}'];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  args.push(target);
  execFile(curlPath, args, { maxBuffer: 20 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
    const out = String(stdout || '');
    const m = out.match(/\n__CURL_STATUS__:(\d{3})\s*$/);
    if (m) {
      cb(null, { status: parseInt(m[1], 10), body: out.slice(0, m.index) });
    } else {
      cb(err || new Error('curl produced no status'));
    }
  });
}

// Model-catalog proxy: fetches provider /models endpoints server-side so the
// browser preview can list real models even when the provider sends no CORS
// headers. Usage: GET /__models-proxy?target=<url>[&key=<bearer>]
function handleModelsProxy(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const target = params.get('target');
  const key = params.get('key') || '';
  const headers = { Accept: 'application/json' };
  if (key) headers['Authorization'] = 'Bearer ' + key;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
  if (!target || !/^https?:\/\//i.test(target)) {
    res.writeHead(400, cors);
    res.end(JSON.stringify({ error: 'missing or invalid target' }));
    return;
  }
  let responded = false;
  const respond = (status, body) => {
    if (responded || res.headersSent) return;
    responded = true;
    try {
      res.writeHead(status, cors);
      res.end(body);
    } catch {
      try { res.end(); } catch { /* socket already gone */ }
    }
  };
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    fetch(target, { headers, signal: ac.signal })
      .then(async (r) => {
        clearTimeout(timer);
        respond(r.status, await r.text());
      })
      .catch(() => {
        clearTimeout(timer);
        // Node fetch failed (connect timeout / TLS) — try curl.exe before giving up.
        curlFetch(target, headers, (err, out) => {
          if (err) respond(502, JSON.stringify({ error: String((err && err.message) || err) }));
          else respond(out.status, out.body);
        });
      })
      .catch(() => respond(502, JSON.stringify({ error: 'proxy failure' })));
  } catch (err) {
    respond(500, JSON.stringify({ error: String((err && err.message) || err) }));
  }
}

// Proxy an invoke to the standalone GUI backend first (pure Node, no
// Electron), then to the desktop app's loopback bridge when it happens to be
// running (shared session accelerator), else report offline.
// Usage: POST /ipc {channel:'browser-use:...', args:[...]}
async function handleIpcProxy(req, res) {
  const cors = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const respond = (status, body) => {
    if (res.headersSent) return;
    try { res.writeHead(status, cors); res.end(JSON.stringify(body)); } catch { /* gone */ }
  };
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= 32 * 1024 * 1024) chunks.push(c); });
  req.on('end', async () => {
    let parsed;
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch {
      return respond(400, { ok: false, error: 'invalid JSON body' });
    }
    const channel = String(parsed.channel || '');
    if (!channel.startsWith('browser-use:')) return respond(400, { ok: false, error: 'channel must start with browser-use:' });
    // 1. Standalone backend (the GUI's own runtime).
    try {
      const local = await guiBackend.handle(channel, parsed.args);
      if (local && local.handled) {
        if (local.error) return respond(200, { ok: false, error: local.error });
        return respond(200, { ok: true, result: local.result === undefined ? null : local.result });
      }
    } catch (err) {
      return respond(200, { ok: false, error: 'gui backend failure: ' + String((err && err.message) || err) });
    }
    // 2. Desktop app bridge (optional accelerator — shares its live session).
    const base = await bridgeBaseUrl();
    if (!base) {
      return respond(503, { ok: false, error: 'backend offline — the standalone runtime could not serve ' + channel + ' and no desktop app is running' });
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 120000);
      const upstream = await fetch(base + '/ipc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
        signal: ac.signal,
      });
      clearTimeout(timer);
      const text = await upstream.text();
      if (res.headersSent) return;
      res.writeHead(upstream.status, cors);
      res.end(text);
    } catch (err) {
      respond(502, { ok: false, error: 'bridge call failed: ' + String((err && err.message) || err) });
    }
  });
  req.on('error', () => respond(500, { ok: false, error: 'request stream error' }));
}

// SSE stream for the web GUI: merges the standalone backend's event bus with
// the desktop app's mirrored renderer events (when the desktop app runs).
async function handleEventsProxy(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  let closed = false;
  req.on('close', () => { closed = true; });
  const write = (frame) => {
    if (closed) return;
    try { res.write(frame); } catch { closed = true; }
  };

  // 1. Standalone backend events (always).
  // UNNAMED frames: `event:`-prefixed SSE events are dispatched only to
  // addEventListener(type) listeners — EventSource.onmessage (what the
  // renderer bridge and web shell use) never sees them. Data-only frames
  // arrive as messages; the payload carries the channel.
  const offBackend = guiBackend.onEvent(({ channel, payload }) => {
    try { write(`data: ${JSON.stringify({ channel, payload })}\n\n`); } catch { /* drop */ }
  });

  // 2. Desktop bridge events (optional accelerator; retry while offline).
  let upstreamController = null;
  const connectUpstream = async () => {
    while (!closed) {
      const base = await bridgeBaseUrl();
      if (!base) { await new Promise((r) => setTimeout(r, 3000)); continue; }
      try {
        upstreamController = new AbortController();
        const upstream = await fetch(base + '/events', { signal: upstreamController.signal });
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        for (; ;) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true });
          // Pass through native SSE frames untouched (they are already framed).
          write(text.startsWith(':') ? text : text);
        }
      } catch { /* upstream gone — retry below */ }
      if (!closed) await new Promise((r) => setTimeout(r, 3000));
    }
  };
  connectUpstream().catch(() => { });

  const keepAlive = setInterval(() => write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    offBackend();
    try { upstreamController?.abort(); } catch { /* gone */ }
  });
}

// --- LORDE_GUI_ERROR_PAGES_V1 ----------------------------------------------
// Browser-level error page (no internet, DNS failure, refused connection...).
// Served from loopback so it renders even when the network is down.
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function serveErrorPage(req, res) {
  const query = new URL(req.url, 'http://127.0.0.1').searchParams;
  const target = query.get('url') || '';
  const message = query.get('message') || '';
  const code = query.get('code') || '';
  const home = query.get('home') || '/';
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>Page failed to load</title>
<style>
  :root {
    --bg: #060b0d; --card: #0f1619; --line: #20292c;
    --text: #edf2f2; --muted: #8f9a9d; --accent: #c8ff00; --red: #ff5c66;
    --font: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: var(--bg); color: var(--text); font-family: var(--font); min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .container { text-align: center; max-width: 560px; width: 100%; }
  .glyph { width: 78px; height: 78px; margin: 0 auto 22px; border-radius: 20px; background: rgba(255,92,102,.09); display: grid; place-items: center; }
  h1 { font-size: 26px; font-weight: 700; margin-bottom: 10px; }
  .sub { color: var(--muted); font-size: 15px; line-height: 1.6; margin-bottom: 28px; }
  .actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
  .btn { display: inline-flex; align-items: center; gap: 8px; border: 0; border-radius: 999px; padding: 13px 28px; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; transition: transform .15s, background .15s; }
  .btn:hover { transform: translateY(-1px); }
  .btn-primary { background: var(--accent); color: #060b0d; }
  .btn-primary:hover { background: #d8ff3d; }
  .btn-secondary { background: var(--card); color: var(--text); border: 1px solid var(--line); }
  .meta { margin-top: 26px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 14px 18px; text-align: left; font-size: 13px; line-height: 1.7; color: var(--muted); word-break: break-all; }
  .meta b { color: var(--text); font-weight: 600; }
  .meta .code { color: var(--red); }
</style>
</head>
<body>
  <div class="container">
    <div class="glyph">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="#ff5c66" stroke-width="1.8" stroke-linecap="round"><path d="M12 3a9 9 0 100 18 9 9 0 000-18z" opacity=".4"/><path d="M12 8v5"/><circle cx="12" cy="16.4" r=".4" fill="#ff5c66"/></svg>
    </div>
    <h1>This page failed to load</h1>
    <div class="sub">The browser could not reach this address. Check the internet connection or the spelling of the address, then try again.</div>
    <div class="actions">
      <button class="btn btn-primary" id="retry-btn">Try Again</button>
      <button class="btn btn-secondary" id="home-btn">Go to Home</button>
    </div>
    <div class="meta">
      <div><b>Address:</b> ${escapeHtml(target) || '<i>Unknown</i>'}</div>
      ${message ? `<div><b>Error:</b> <span class="code">${escapeHtml(message)}${code ? ' (' + escapeHtml(code) + ')' : ''}</span></div>` : ''}
    </div>
  </div>
<script>
  (function () {
    var q = new URLSearchParams(location.search);
    var target = q.get('url') || '';
    document.getElementById('retry-btn').addEventListener('click', function () {
      if (target && /^https?:\\/\\//i.test(target)) location.href = target;
      else history.back();
    });
    document.getElementById('home-btn').addEventListener('click', function () {
      location.href = q.get('home') || '/';
    });
  })();
</script>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(html);
}

function requestListener(req, res) {
  try {
    // Normalize URL — strip query string
    const urlPath = req.url.split('?')[0];
    if (urlPath === '/__models-proxy') {
      handleModelsProxy(req, res);
      return;
    }
    if (urlPath === '/ipc' && req.method === 'POST') {
      handleIpcProxy(req, res);
      return;
    }
    if (urlPath === '/events') {
      handleEventsProxy(req, res);
      return;
    }
    if (urlPath === '/__bridge-health') {
      bridgeBaseUrl().then((base) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, standalone: true, desktopBridge: base || null }));
      });
      return;
    }
    if (urlPath === '/web-shell.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' });
      res.end(WEB_SHELL_JS);
      return;
    }
    if (urlPath === '/error' || urlPath === '/error/') {
      // LORDE_GUI_ERROR_PAGES_V1 — served on loopback so it works even with
      // no internet. The backend navigates failed tabs here.
      serveErrorPage(req, res);
      return;
    }
  
    // Default to index.html
    let filePath = path.join(RENDERER_DIR, urlPath === '/' ? 'index.html' : urlPath);
    // /assets/... maps to the renderer's sibling assets dir (icons, splash).
    if (urlPath.startsWith('/assets/')) {
      const candidate = path.join(ASSETS_DIR, urlPath.slice('/assets/'.length));
      if (!candidate.startsWith(ASSETS_DIR)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      filePath = candidate;
    }

    // Security: prevent directory traversal
    if (!filePath.startsWith(RENDERER_DIR) && !filePath.startsWith(ASSETS_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        // SPA fallback ONLY for route-like URLs (no file extension). A missing
        // image/script must 404, never masquerade as HTML (that is exactly
        // how the app-title icon rendered as a broken image).
        if (path.extname(urlPath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
          return;
        }
        filePath = path.join(RENDERER_DIR, 'index.html');
      }
      serveFile(res, filePath);
    });
  } catch (err) {
    try {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    } catch { /* socket already gone */ }
  }
}

// Keep the GUI server alive: a single bad request must never kill the process.
process.on('uncaughtException', (err) => {
  console.error('[guiServer] uncaughtException (kept alive):', err && err.message ? err.message : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[guiServer] unhandledRejection (kept alive):', err && err.message ? err.message : err);
});

/**
 * Start the GUI HTTP server.
 * @param {number} [port] - Port to listen on (default 4200)
 * @returns {Promise<{ port: number, url: string }>}
 */
export async function startServer(port = DEFAULT_PORT) {
  if (_server) {
    return { port: _port, url: `http://localhost:${_port}` };
  }

  return new Promise((resolve, reject) => {
    _port = port;
    _server = http.createServer(requestListener);

    _server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        // Try next port
        _port = port + 1;
        _server.listen(_port, '127.0.0.1', () => {
          guiBackend.setLoopbackBase(`http://127.0.0.1:${_port}`);
          resolve({ port: _port, url: `http://localhost:${_port}` });
        });
      } else {
        reject(err);
      }
    });

    _server.listen(port, '127.0.0.1', () => {
      guiBackend.setLoopbackBase(`http://127.0.0.1:${_port}`);
      resolve({ port: _port, url: `http://localhost:${_port}` });
    });
  });
}

/**
 * Stop the GUI HTTP server.
 */
export function stopServer() {
  if (_server) {
    _server.close();
    _server = null;
  }
}

/**
 * Get the current server URL.
 * @returns {string|null}
 */
export function getServerUrl() {
  return _server ? `http://localhost:${_port}` : null;
}

/**
 * Check if the server is running.
 * @returns {boolean}
 */
export function isServerRunning() {
  return _server !== null;
}

// Allow running this module directly: `node cli/tui/guiServer.mjs`
const entryArg = String(process.argv[1] || '').replace(/\\/g, '/');
const modulePath = decodeURIComponent(new URL(import.meta.url).pathname).replace(/\\/g, '/');
if (entryArg && modulePath.toLowerCase().endsWith(entryArg.toLowerCase().replace(/^\//, ''))) {
  // Boot the standalone runtime eagerly so the first page load is instant.
  guiBackend.warmup();
  startServer().then(({ url }) => {
    console.log(`GUI server listening at ${url}`);
  }).catch((err) => {
    console.error('GUI server failed to start:', err);
    process.exit(1);
  });
}
