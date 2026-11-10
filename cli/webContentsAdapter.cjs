'use strict';

// cli/webContentsAdapter.cjs
//
// Backs one Electron-shaped tab object `{ id, webContents }` with one headless
// Chrome page over CDP (chrome-remote-interface), so that
// desktop/mcp/browserViewController.cjs drives a REAL headless browser with
// zero Electron at CLI runtime.
//
// SUPPORTED WebContents SURFACE (everything the controller and its helpers
// touch — verified against browserViewController.cjs; anything else throws):
//   getURL() / getTitle() / isLoading() / isDestroyed() / stop()
//   loadURL(url) -> Promise (resolves on Page.loadEventFired, bounded)
//   navigationHistory.canGoBack() / canGoForward()  (sync, from a CDP
//     navigation-history cache refreshed on every main-frame commit)
//   navigationHistory.goBack() / goForward() -> Promise
//   on / once / removeListener / removeAllListeners / listenerCount / emit
//     - 'did-start-navigation'      (event, url, isInPlace, isMainFrame)
//     - 'did-navigate'              (event, url, httpResponseCode, statusText, isMainFrame)
//     - 'did-navigate-in-page'      (event, url, isMainFrame)
//     - 'did-fail-load'             (event, errorCode, errorDescription, validatedUrl, isMainFrame)
//   sendInputEvent(event) — mouse (mouseMove/mouseDown/mouseUp/mouseWheel) and
//     key (keyDown/keyUp/char/rawKeyDown) -> CDP Input.dispatch*
//   insertText(text) -> CDP Input.insertText (fire-and-forget, like Electron's void)
//   executeJavaScript(code, userGesture) -> Promise (Runtime.evaluate,
//     awaitPromise+returnByValue; throws on exceptionDetails)
//   capturePage() -> Promise<{ toPNG(): Buffer }> via Page.captureScreenshot
//   debugger.attach('1.3') / isAttached() / sendCommand(method, params) /
//     detach() — raw CDP passthrough on the SAME client (this is what the
//     controller's withDebugger() fallback uses when no lease manager exists)
//
// Also exports the headless Chrome launcher used by agent-cli.mjs.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { execSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const CDP = require('chrome-remote-interface');

const LOAD_WAIT_MS = 30_000;

async function freePort(start) {
  for (let port = start; port < start + 40; port += 1) {
    const free = await new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`No free port found at or above ${start}.`);
}

async function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  // Playwright's bundled Chromium first: a real Chromium binary with zero
  // system dependencies, already present wherever playwright-core is used.
  try {
    const pwRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
    if (fs.existsSync(pwRoot)) {
      const builds = fs.readdirSync(pwRoot)
        .filter((name) => /^chromium-\d+$/.test(name))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const build of builds) {
        for (const sub of [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe']]) {
          const candidate = path.join(pwRoot, build, ...sub);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  } catch { /* fall through to system browsers */ }
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Chromium-based Edge is CDP-compatible: a valid control target when
      // Chrome is not installed (same --remote-debugging-port surface).
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ];
    for (const candidate of candidates) if (candidate && fs.existsSync(candidate)) return candidate;
    try {
      const found = execSync('where chrome', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
      if (found && fs.existsSync(found)) return found;
    } catch { /* fall through */ }
    try {
      const found = execSync('where msedge', { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
      if (found && fs.existsSync(found)) return found;
    } catch { /* fall through */ }
  } else {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']) {
      try {
        const found = execSync(`which ${bin}`, { encoding: 'utf8' }).trim();
        if (found) return found;
      } catch { /* try next */ }
    }
  }
  throw new Error('No Chrome/Chromium binary found. Set CHROME_PATH or install Chrome.');
}

// Headless Chrome launch (mirrors src/browser/chromeLauncher.js flags, with
// --headless=new and a fixed window size so CDP input coordinates are sane).
// --headed switches to a visible window (BROWSER_USE_CLI_HEADED=1 also works).
async function launchHeadlessChrome({ startPort = 9333, url = 'about:blank', profileDir = null, width = 1440, height = 900, headed = false } = {}) {
  const bin = await findChrome();
  const port = await freePort(startPort);
  const profile = profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-cli-'));
  fs.mkdirSync(profile, { recursive: true });
  const args = [
    headed ? '--new-window' : '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-default-apps',
    '--disable-background-timer-throttling',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-sync',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--password-store=basic',
    '--use-mock-keychain',
    '--disable-features=IsolateOrigins,site-per-process,TranslateUI',
    url
  ];
  const stderrLog = path.join(profile, 'chrome-stderr.log');
  const stderrFd = fs.openSync(stderrLog, 'w');
  const child = spawn(bin, args, { stdio: ['ignore', 'ignore', stderrFd], detached: false });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (child.exitCode !== null) {
      let stderrTail = '';
      try { stderrTail = fs.readFileSync(stderrLog, 'utf8').slice(-2000); } catch {}
      throw new Error(`Chrome exited early (code ${child.exitCode}). stderr tail: ${stderrTail}`);
    }
    try {
      const probe = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) });
      if (probe.ok) break;
    } catch { /* not ready yet */ }
    if (Date.now() > deadline) {
      try { child.kill('SIGKILL'); } catch {}
      throw new Error(`Timed out waiting for CDP on port ${port}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { mode: headed ? 'headed' : 'headless', process: child, endpoint: `http://127.0.0.1:${port}`, port, profile, pid: child.pid, stderrLog, bin };
}

function killChromeTree(launch) {
  if (!launch?.pid) return { killed: false, reason: 'no pid' };
  try {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /T /F /PID ${launch.pid}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        try { launch.process.kill('SIGKILL'); } catch { /* already gone */ }
      }
    } else {
      try { process.kill(-launch.pid, 'SIGKILL'); } catch { try { launch.process.kill('SIGKILL'); } catch {} }
    }
  } catch (error) {
    try { launch.process.kill('SIGKILL'); } catch {}
    return { killed: true, pid: launch.pid, warning: error.message };
  }
  return { killed: true, pid: launch.pid };
}

const MOUSE_BUTTON_MASK = { left: 1, middle: 2, right: 4 };
const MODIFIER_MASK = { shift: 1, control: 2, meta: 4, alt: 8 };
const NAMED_KEY_CODES = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Backspace: ['Backspace', 8], Escape: ['Escape', 27],
  Delete: ['Delete', 46], ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39],
  ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33],
  PageDown: ['PageDown', 34], ' ': ['Space', 32], Space: ['Space', 32]
};
for (let code = 65; code <= 90; code += 1) NAMED_KEY_CODES[String.fromCharCode(code)] = [`Key${String.fromCharCode(code)}`, code];
for (let digit = 0; digit <= 9; digit += 1) NAMED_KEY_CODES[String(digit)] = [`Digit${digit}`, 48 + digit];
for (let fn = 1; fn <= 12; fn += 1) NAMED_KEY_CODES[`F${fn}`] = [`F${fn}`, 111 + fn];

function virtualKeyInfo(keyCode) {
  const key = String(keyCode ?? '');
  if (NAMED_KEY_CODES[key]) return { code: NAMED_KEY_CODES[key][0], vk: NAMED_KEY_CODES[key][1] };
  if (key.length === 1) {
    const upper = key.toUpperCase();
    if (NAMED_KEY_CODES[upper]) return { code: NAMED_KEY_CODES[upper][0], vk: NAMED_KEY_CODES[upper][1] };
    return { code: '', vk: upper.charCodeAt(0) };
  }
  return { code: '', vk: 0 };
}

function modifierBitmask(modifiers) {
  if (!Array.isArray(modifiers)) return 0;
  return modifiers.reduce((mask, name) => mask | (MODIFIER_MASK[String(name).toLowerCase()] || 0), 0);
}

function isPrintableText(key) {
  return typeof key === 'string' && key.length === 1 && key.charCodeAt(0) >= 32;
}

class WebContentsAdapter extends EventEmitter {
  // One adapter per CDP page target. `client` is a chrome-remote-interface
  // client already attached to the target.
  constructor({ id, client, host = '127.0.0.1', port = null, mainFrameId = null }) {
    super();
    this.id = id;
    this.host = host;
    this.port = port;
    this.client = client;
    this._mainFrameId = mainFrameId;
    this._url = 'about:blank';
    this._title = '';
    this._loading = false;
    this._destroyed = false;
    this._mainStatus = 0;
    this._history = { entries: [], currentIndex: 0 };
    this._consoleEntries = [];
    this._debuggerAttached = false;
    this._loadWaiters = new Set();
    this._mainDocumentRequests = new Map();
    this._closed = false;
    this._wire();
  }

  _wire() {
    const { client } = this;
    client.on('disconnect', () => { this._destroyed = true; });
    client.Page.frameRequestedNavigation((params) => {
      if (this._mainFrame(params.frameId)) this.emit('did-start-navigation', {}, params.url || this._url, false, true);
    });
    client.Page.frameStartedLoading((params) => {
      if (this._mainFrame(params.frameId)) this._loading = true;
    });
    client.Page.frameStoppedLoading((params) => {
      if (this._mainFrame(params.frameId)) this._loading = false;
    });
    client.Page.loadEventFired(() => {
      this._loading = false;
      for (const waiter of [...this._loadWaiters]) waiter.resolve();
      this._loadWaiters.clear();
      client.Runtime.evaluate({ expression: 'document.title', returnByValue: true })
        .then((title) => { if (title?.result?.value) this._title = title.result.value; })
        .catch(() => {});
    });
    client.Page.frameNavigated(async (params) => {
      const frame = params.frame;
      if (frame.parentId) return;
      this._url = frame.url || this._url;
      this._title = frame.name || this._title;
      const status = this._mainStatus;
      this._mainStatus = 0;
      // Electron's did-navigate fires at main-frame commit.
      this.emit('did-navigate', {}, this._url, status, status ? '' : '', true);
      try {
        this._history = await client.Page.getNavigationHistory();
      } catch { /* the sync accessors fall back to the last cache */ }
    });
    client.Page.navigatedWithinDocument((params) => {
      if (!this._mainFrame(params.frameId)) return;
      this._url = params.url || this._url;
      this.emit('did-navigate-in-page', {}, this._url, true);
      client.Page.getNavigationHistory().then((history) => { this._history = history; }).catch(() => {});
    });
    client.Network.requestWillBeSent((params) => {
      if (params.type === 'Document') this._mainDocumentRequests.set(params.requestId, params.request?.url || '');
      this._consoleEntries.push({ tabId: this.id, kind: 'network', phase: 'request', url: params.request?.url || '', method: params.request?.method || '', at: Date.now() });
      if (this._consoleEntries.length > 2000) this._consoleEntries.splice(0, this._consoleEntries.length - 2000);
    });
    client.Network.responseReceived((params) => {
      if (params.type === 'Document') this._mainStatus = Number(params.response?.status) || 0;
      this._consoleEntries.push({ tabId: this.id, kind: 'network', phase: 'response', url: params.response?.url || '', status: Number(params.response?.status) || 0, at: Date.now() });
    });
    client.Network.loadingFailed((params) => {
      const mainUrl = this._mainDocumentRequests.get(params.requestId);
      if (mainUrl !== undefined) {
        this._mainDocumentRequests.delete(params.requestId);
        const canceled = params.canceled || params.errorText === 'net::ERR_ABORTED';
        // Electron did-fail-load; the controller ignores code -3 (aborted).
        this.emit('did-fail-load', {}, canceled ? -3 : -2, params.errorText || 'load failed', mainUrl || this._url, true);
      }
      this._consoleEntries.push({ tabId: this.id, kind: 'network', phase: 'failed', url: '', error: params.errorText || '', at: Date.now() });
    });
    client.Runtime.consoleAPICalled((params) => {
      const text = (params.args || []).map((arg) => arg.value !== undefined ? String(arg.value) : (arg.description || arg.type || '')).join(' ');
      this._consoleEntries.push({ tabId: this.id, kind: 'console', level: params.type || 'log', text, at: Date.now() });
    });
    client.Runtime.exceptionThrown((params) => {
      const detail = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || 'exception';
      this._consoleEntries.push({ tabId: this.id, kind: 'console', level: 'error', text: detail, at: Date.now() });
    });
  }

  _mainFrame(frameId) {
    // A missing frameId is treated as the main frame (older Chromium); with a
    // known main frame id only that id counts — subframe loads must not flip
    // the isLoading flag or emit main-frame navigation events.
    if (!frameId || !this._mainFrameId) return true;
    return frameId === this._mainFrameId;
  }

  getConsoleEntries() {
    return this._consoleEntries;
  }

  // --- Electron WebContents surface ---------------------------------------
  isDestroyed() { return this._destroyed; }
  getURL() { return this._url; }
  getTitle() { return this._title; }
  isLoading() { return this._loading; }

  stop() {
    this.client.Page.stopLoading().catch(() => {});
  }

  get navigationHistory() {
    const adapter = this;
    return {
      canGoBack() { return adapter._history.currentIndex > 0; },
      canGoForward() {
        return Array.isArray(adapter._history.entries)
          && adapter._history.currentIndex >= 0
          && adapter._history.currentIndex < adapter._history.entries.length - 1;
      },
      async goBack() {
        const entry = adapter._history.entries?.[adapter._history.currentIndex - 1];
        if (!entry) throw new Error('Cannot go back: no earlier navigation entry.');
        await adapter.client.Page.navigateToHistoryEntry({ entryId: entry.id });
      },
      async goForward() {
        const entry = adapter._history.entries?.[adapter._history.currentIndex + 1];
        if (!entry) throw new Error('Cannot go forward: no later navigation entry.');
        await adapter.client.Page.navigateToHistoryEntry({ entryId: entry.id });
      }
    };
  }

  async loadURL(url) {
    this._loading = true;
    this._url = url;
    const waiter = new Promise((resolve, reject) => {
      const record = {
        resolve: () => { clearTimeout(record.timer); resolve(); },
        timer: setTimeout(() => {
          this._loadWaiters.delete(record);
          resolve(); // the controller's own commit waiter owns the real deadline
        }, LOAD_WAIT_MS)
      };
      this._loadWaiters.add(record);
    });
    const result = await this.client.Page.navigate({ url });
    if (result?.errorText) {
      this._loading = false;
      throw new Error(`Navigation failed: ${result.errorText}`);
    }
    await waiter;
    return { url };
  }

  async executeJavaScript(code, userGesture) {
    if (this._destroyed) throw new Error('The bound page is gone; the tab was closed.');
    const response = await this.client.Runtime.evaluate({
      expression: String(code),
      awaitPromise: true,
      returnByValue: true,
      userGesture: userGesture !== false
    });
    if (response?.exceptionDetails) {
      const detail = String(response.exceptionDetails.exception?.description
        || response.exceptionDetails.text
        || 'The page evaluation failed.').replace(/\s+/g, ' ').slice(0, 800);
      throw new Error(detail);
    }
    return response?.result?.value;
  }

  sendInputEvent(event) {
    if (!event || typeof event !== 'object') throw new Error('sendInputEvent requires an event object.');
    const client = this.client;
    const dispatch = (params) => client.Input.dispatchMouseEvent(params).catch(() => {});
    switch (event.type) {
      case 'mouseMove':
        dispatch({ type: 'mouseMoved', x: Number(event.x) || 0, y: Number(event.y) || 0 });
        return;
      case 'mouseDown':
        dispatch({ type: 'mousePressed', x: Number(event.x) || 0, y: Number(event.y) || 0,
          button: event.button || 'left', buttons: MOUSE_BUTTON_MASK[event.button || 'left'] || 1,
          clickCount: Number(event.clickCount) || 1 });
        return;
      case 'mouseUp':
        dispatch({ type: 'mouseReleased', x: Number(event.x) || 0, y: Number(event.y) || 0,
          button: event.button || 'left', buttons: 0,
          clickCount: Number(event.clickCount) || 1 });
        return;
      case 'mouseWheel':
        dispatch({ type: 'mouseWheel', x: Number(event.x) || 0, y: Number(event.y) || 0,
          deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0 });
        return;
      case 'keyDown':
      case 'keyUp':
      case 'char':
      case 'rawKeyDown': {
        const key = String(event.keyCode ?? '');
        const { code, vk } = virtualKeyInfo(key);
        const modifiers = modifierBitmask(event.modifiers);
        const text = isPrintableText(key) ? key : '';
        const params = { type: event.type === 'keyDown' ? (text ? 'keyDown' : 'rawKeyDown') : event.type,
          key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
        if (text && event.type !== 'keyUp') params.text = text;
        client.Input.dispatchKeyEvent(params).catch(() => {});
        return;
      }
      default:
        throw new Error(`webContents.sendInputEvent: unsupported event type "${event.type}" (supported: mouseMove, mouseDown, mouseUp, mouseWheel, keyDown, keyUp, char, rawKeyDown).`);
    }
  }

  insertText(text) {
    // Electron's insertText is void; delivery errors surface on the next
    // observation instead of throwing synchronously.
    this.client.Input.insertText({ text: String(text ?? '') }).catch(() => {});
  }

  async capturePage() {
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.client.Page.captureScreenshot({ format: 'png', captureBeyondViewport: false });
        if (!result?.data) throw new Error('Page.captureScreenshot returned no image data.');
        return { toPNG: () => Buffer.from(result.data, 'base64') };
      } catch (error) {
        attempt += 1;
        if (attempt >= 2) throw error;
        await this.client.Page.bringToFront().catch(() => {});
      }
    }
  }

  get debugger() {
    const adapter = this;
    return {
      attach() { adapter._debuggerAttached = true; },
      isAttached() { return adapter._debuggerAttached; },
      async sendCommand(method, params) {
        if (typeof method !== 'string') throw new Error('debugger.sendCommand requires a CDP method string.');
        return adapter.client.send(method, params);
      },
      detach() { adapter._debuggerAttached = false; }
    };
  }

  // --- lifecycle -----------------------------------------------------------
  async close() {
    if (this._closed) return;
    this._closed = true;
    this._destroyed = true;
    try { await this.client.close(); } catch { /* already detached */ }
  }
}

async function connectTab({ host = '127.0.0.1', port, targetId = null } = {}) {
  const root = await CDP({ host, port, target: (targets) => targets.find((t) => t.type === 'browser') || targets[0] });
  let id = targetId;
  if (!id) {
    const { targetId: created } = await root.Target.createTarget({ url: 'about:blank' });
    id = created;
  }
  const client = await CDP({ host, port, target: id });
  await Promise.all([
    client.Page.enable(),
    client.Runtime.enable(),
    client.Network.enable(),
    client.DOM.enable().catch(() => {}),
    client.Log.enable().catch(() => {})
  ]);
  await client.Page.setLifecycleEventsEnabled({ enabled: true }).catch(() => {});
  let mainFrameId = null;
  try { mainFrameId = (await client.Page.getFrameTree()).frameTree?.frame?.id || null; } catch { /* optional */ }
  const adapter = new WebContentsAdapter({ id, client, host, port, mainFrameId });
  try {
    const info = await client.Runtime.evaluate({ expression: '({ url: location.href, title: document.title })', returnByValue: true });
    adapter._url = info?.result?.value?.url || 'about:blank';
    adapter._title = info?.result?.value?.title || '';
  } catch { /* about:blank is the documented default */ }
  return { tab: { id, webContents: adapter }, adapter, root, targetId: id };
}

module.exports = { WebContentsAdapter, launchHeadlessChrome, killChromeTree, connectTab };
