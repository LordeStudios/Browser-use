'use strict';

const net = require('node:net');
const { execFile, spawn } = require('node:child_process');
const { TERMINAL_CONTRACT_VERSION, isStaleCredentialKey } = require('./terminalSession.cjs');

const CONNECT_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 5_000;
const START_RETRIES = 30;
const REGISTRY_READ_TIMEOUT_MS = 5_000;
const REGISTRY_READ_CACHE_MS = 60_000;

// Reads the CURRENT user + machine environment from the registry. Values come
// back already expanded, and the call is one PowerShell round trip per cache
// window — this is what makes a `setx`-updated system-wide key reach terminal
// shells even when every inheriting process (npm, Electron, the broker) still
// holds the old value. Non-Windows (or a failed read) resolves to an empty
// object: the push then carries inherited values minus credentials, which is
// still safer than the stale-snapshot status quo.
let registryCache = { at: 0, env: null };
function readRegistryEnvironment() {
  if (process.platform !== 'win32') return Promise.resolve({});
  if (registryCache.env && Date.now() - registryCache.at < REGISTRY_READ_CACHE_MS) return Promise.resolve(registryCache.env);
  return new Promise((resolve) => {
    const script = "[Environment]::GetEnvironmentVariables('Machine') | ConvertTo-Json -Compress; [Environment]::GetEnvironmentVariables('User') | ConvertTo-Json -Compress";
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: REGISTRY_READ_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      // The script emits exactly two JSON documents in order: machine scope,
      // then user scope. Parse them separately so mergeRegistryScopes can
      // concatenate path-like variables instead of losing one scope.
      const scopes = { machine: {}, user: {} };
      const order = ['machine', 'user'];
      let scopeIndex = 0;
      if (!error && stdout) {
        // One JSON document per line (a variable value can never contain a
        // newline, so line splitting is safe). PowerShell 5.1 emits a bare
        // object for single-entry hashtables and PS 7 an array — accept both.
        for (const line of stdout.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (scopeIndex >= order.length) break;
          try {
            const parsed = JSON.parse(trimmed);
            const entries = Array.isArray(parsed) ? parsed : [parsed];
            const target = scopes[order[scopeIndex]];
            scopeIndex += 1;
            for (const entry of entries) {
              if (entry && typeof entry === 'object') {
                for (const [key, value] of Object.entries(entry)) {
                  if (typeof key === 'string' && key && typeof value === 'string') target[key] = value;
                }
              }
            }
          } catch { /* one malformed line must not kill the push */ }
        }
      }
      registryCache = { at: Date.now(), env: mergeRegistryScopes(scopes.machine, scopes.user) };
      resolve(registryCache.env);
    });
  });
}

// Effective Windows environment = machine scope, then user scope on top —
// EXCEPT path-like variables, which CONCATENATE (machine first). Naive
// last-wins merging here silently dropped System32 from the terminals' PATH.
const CONCATENATED_ENV_KEYS = new Set(['PATH', 'PATHEXT', 'LIB', 'INCLUDE', 'PSModulePath']);
function mergeRegistryScopes(machine = {}, user = {}) {
  const merged = { ...machine };
  for (const [key, value] of Object.entries(user)) {
    if (CONCATENATED_ENV_KEYS.has(key.toUpperCase()) && typeof merged[key] === 'string' && merged[key]) {
      merged[key] = `${merged[key]};${value}`;
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// Pure merge used for the environment push. Registry values win for keys the
// registry actually defines; credential keys known only to an inherited shell
// are dropped (untrustworthy — that shell may predate the config change);
// everything else passes through from the inherited environment. Runtime
// session markers (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_PID, ...) never pass
// through: they describe the host process's session, and a terminal that
// inherits them makes CLIs behave as nested sessions instead of fresh ones.
const SESSION_MARKER_RE = /^CLAUDECODE$|^CLAUDE_CODE_|^CLAUDE_PID$|^CURSOR_TRACE_ID$|^VSCODE_(?:PID|IPC)_/;
function buildPushEnvironment(inherited = {}, registry = {}) {
  const env = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (typeof value !== 'string') continue;
    if (key === 'ELECTRON_RUN_AS_NODE') continue;
    if (SESSION_MARKER_RE.test(key)) continue;
    if (isStaleCredentialKey(key)) {
      if (key in registry) env[key] = registry[key];
      continue;
    }
    env[key] = key in registry ? registry[key] : value;
  }
  for (const [key, value] of Object.entries(registry)) {
    if (typeof key === 'string' && key && typeof value === 'string') env[key] = value;
  }
  return env;
}

class TerminalBrokerClient {
  constructor({ pipePath, secret, brokerPath, executablePath, onData, onExit }) {
    this.pipePath = pipePath;
    this.secret = secret;
    this.brokerPath = brokerPath;
    this.executablePath = executablePath;
    this.onData = onData;
    this.onExit = onExit;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextRequestId = 1;
    this.buffer = '';
    this.sessions = new Map();
    this.contractVersion = 0;
    this.backend = { ptyAvailable: false, backend: 'piped', error: 'Terminal broker is connecting.' };
  }

  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOrStart().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async connectOrStart() {
    const connectOnce = async () => {
      await this.openSocket();
      const state = await this.request('state');
      await this.pushEnvironment();
      return state;
    };
    let state = null;
    try { state = await connectOnce(); } catch { state = null; }
    // A broker from an older build predates the current session contract (the
    // final-merge credential strip in particular) and stays alive across app
    // restarts — its shells could never honor fresh config. Replace it once:
    // existing shells are lost, but they were stale by definition.
    if (state && Number(state.contractVersion || 0) < TERMINAL_CONTRACT_VERSION) {
      try { await this.request('shutdown'); } catch {}
      this.disconnect();
      state = null;
    }
    if (state) return;
    this.startBroker();
    let lastError;
    for (let attempt = 0; attempt < START_RETRIES; attempt += 1) {
      try {
        await delay(100);
        await connectOnce();
        return;
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error('Terminal broker did not start.');
  }

  // The broker is a long-lived detached process: its own environment is a
  // snapshot from whenever it first started, and the Desktop process env
  // inherits the shell that launched it — `setx` never updates running
  // shells, so BOTH can carry a stale credential that silently overrides the
  // current on-disk config. The push therefore rebuilds credentials from the
  // CURRENT registry (user + machine scopes, read fresh via PowerShell):
  //
  // - a credential present in the registry is pushed with its CURRENT value;
  // - a credential known only to an inherited shell is dropped entirely (the
  //   CLI falls back to its on-disk config, like a fresh system terminal);
  // - every other variable prefers the registry value when one exists and
  //   keeps the inherited value otherwise, so PATH, locales and feature
  //   flags behave exactly like a normal terminal.
  async pushEnvironment({ maxAgeMs = 0 } = {}) {
    if (maxAgeMs > 0 && this.pushedEnvironmentAt && Date.now() - this.pushedEnvironmentAt < maxAgeMs) return true;
    const registry = await readRegistryEnvironment();
    const env = buildPushEnvironment(process.env, registry);
    try {
      await this.request('setEnv', { env });
      this.pushedEnvironmentAt = Date.now();
      return true;
    } catch {
      return false;
    }
  }

  startBroker() {
    const child = spawn(this.executablePath, [this.brokerPath, this.pipePath, this.secret], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    child.unref();
  }

  openSocket() {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.pipePath);
      const timeout = setTimeout(() => finish(new Error('Timed out connecting to terminal broker.')), CONNECT_TIMEOUT_MS);
      const finish = (error) => {
        clearTimeout(timeout);
        socket.removeListener('error', finish);
        if (error) { socket.destroy(); reject(error); } else resolve();
      };
      socket.once('error', finish);
      socket.once('connect', () => {
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.receive(chunk));
        socket.on('close', () => this.disconnected());
        socket.on('error', () => {});
        this.socket = socket;
        this.write({ type: 'authenticate', secret: this.secret });
        finish();
      });
    });
  }

  receive(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.event === 'state') {
        this.contractVersion = Number(message.contractVersion || 0);
        this.backend = message.backend || this.backend;
        this.sessions = new Map((message.sessions || []).map((session) => [session.id, session]));
        continue;
      }
      if (message.event === 'data') {
        const session = message.status || this.sessions.get(message.id);
        if (session) {
          session.history = `${this.sessions.get(message.id)?.history || session.history || ''}${message.data}`.slice(-500_000);
          this.sessions.set(message.id, session);
        }
        this.onData?.(message.id, message.data, session || null);
        continue;
      }
      if (message.event === 'exit') {
        const session = message.status || this.sessions.get(message.id);
        if (session) this.sessions.set(message.id, session);
        this.onExit?.(message.id, message.exitCode, session || null);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok) {
        this.cacheResult(pending.method, pending.args, message.result);
        pending.resolve(message.result);
      } else pending.reject(new Error(message.error || 'Terminal broker request failed.'));
    }
  }

  cacheResult(method, args, result) {
    if (method === 'state' && result) {
      this.contractVersion = Number(result.contractVersion || 0);
      this.backend = result.backend || this.backend;
      this.sessions = new Map((result.sessions || []).map((session) => [session.id, session]));
      return;
    }
    if ((method === 'create' || method === 'setDimensions' || method === 'recover') && result?.id) this.sessions.set(result.id, result);
    if ((method === 'write' || method === 'send') && result?.status?.id) this.sessions.set(result.status.id, result.status);
    if (method === 'snapshot' && result?.id) this.sessions.set(result.id, result);
    if (method === 'dispose' && result) this.sessions.delete(String(args.id));
  }

  disconnected() {
    if (this.socket?.destroyed || this.socket) this.socket = null;
    for (const pending of this.pending.values()) pending.reject(new Error('Terminal broker disconnected.'));
    this.pending.clear();
  }

  write(message) {
    if (!this.socket || this.socket.destroyed) throw new Error('Terminal broker is not connected.');
    this.socket.write(`${JSON.stringify(message)}\n`);
  }

  async request(method, args = {}, requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    await this.connect();
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Terminal broker ${method} timed out.`));
      }, requestTimeoutMs);
      this.pending.set(id, {
        method, args,
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });
      try { this.write({ id, method, args }); } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  state() { return this.request('state'); }
  create(options) { return this.request('create', options); }
  writeInput(id, data) { return this.request('write', { id, data }); }
  sendInput(id, text, { expected = '', timeoutMs = 5_000 } = {}) { return this.request('send', { id, text, expected, timeoutMs }, Math.min(65_000, Math.max(6_000, timeoutMs + 1_000))); }
  recover(id) { return this.request('recover', { id }, 30_000); }
  refresh(id) { return this.request('snapshot', { id }); }
  paste(id, text) { return this.request('paste', { id, text }); }
  resize(id, cols, rows) { return this.request('resize', { id, cols, rows }); }
  setDimensions(id, cols, rows) { return this.request('setDimensions', { id, cols, rows }); }
  dispose(id) { return this.request('dispose', { id }); }
  shutdown() { return this.request('shutdown'); }
  snapshot(id) { return this.sessions.get(String(id)) || null; }
  list() { return [...this.sessions.values()]; }
  backendInfo() { return this.backend; }
  disconnect() { this.socket?.destroy(); this.socket = null; }
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

module.exports = { TerminalBrokerClient, buildPushEnvironment, readRegistryEnvironment };
