'use strict';

// A deliberately small local IPC host for terminal sessions. Electron can quit
// while this Node-mode process keeps the PTY and its bounded scrollback alive;
// a later Desktop process authenticates and adopts the same session.

const net = require('node:net');
const { TerminalManager, TERMINAL_CONTRACT_VERSION } = require('./terminalSession.cjs');

const [pipePath, secret] = process.argv.slice(2);
if (!pipePath || !secret) throw new Error('Terminal broker requires a pipe path and secret.');

const clients = new Set();
const history = new Map();
// The reported contract version lives in terminalSession.cjs so the client and
// this broker can never drift apart on when an outdated broker must be
// replaced.
const CONTRACT_VERSION = TERMINAL_CONTRACT_VERSION;
// The broker outlives the Desktop app, so its own process.env can be days old.
// Every connecting Desktop pushes its current environment (setEnv) and NEW
// sessions merge it over the broker's snapshot — a fixed API key or updated
// system config reaches reset and brand-new terminals without waiting for the
// broker to die.
let clientEnvironment = null;
const MAX_HISTORY_CHARS = 500_000;
const idleTimeout = Number(process.env.BROWSER_USE_TERMINAL_BROKER_IDLE_MS || 60_000);
let idleTimer = null;
const terminalManager = new TerminalManager({
  onData: (id, data, sessionStatus) => {
    const previous = history.get(id) || '';
    history.set(id, `${previous}${data}`.slice(-MAX_HISTORY_CHARS));
    broadcast({ event: 'data', id, data, status: status(id) || sessionStatus });
  },
  onExit: (id, exitCode, sessionStatus) => {
    // Keep the bounded history and exited session as a tombstone until explicit
    // close or recovery, so reconnecting clients cannot mistake disappearance
    // for successful completion.
    broadcast({ event: 'exit', id, exitCode, status: status(id) || sessionStatus });
    scheduleIdleShutdown();
  }
});

function scheduleIdleShutdown() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (clients.size || terminalManager.list().length || !Number.isFinite(idleTimeout) || idleTimeout <= 0) return;
  idleTimer = setTimeout(() => process.exit(0), idleTimeout);
}

function send(socket, message) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function broadcast(message) {
  for (const socket of clients) send(socket, message);
}

function status(id) {
  const snapshot = terminalManager.snapshot(id);
  return snapshot ? { ...snapshot, history: history.get(snapshot.id) || '' } : null;
}

async function dispatch(method, args = {}) {
  switch (method) {
    case 'state':
      return { contractVersion: CONTRACT_VERSION, sessions: terminalManager.list().map((session) => status(session.id)), backend: terminalManager.backendInfo() };
    case 'setEnv': {
      // A shallow object of string values only — anything else is refused so a
      // malformed push cannot poison every future session.
      const env = args?.env;
      if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('setEnv requires an environment object.');
      const clean = {};
      for (const [key, value] of Object.entries(env)) {
        if (typeof key === 'string' && key && typeof value === 'string') clean[key] = value;
      }
      clientEnvironment = clean;
      return true;
    }
    case 'create':
      // The freshly pushed client environment wins over the broker's snapshot.
      return status(terminalManager.create({ ...args, env: { ...(clientEnvironment || {}), ...(args?.env || {}) } }).id);
    case 'snapshot':
      return status(args.id);
    case 'write': {
      const session = terminalManager.get(args.id);
      if (!session) return { accepted: false, status: null };
      const accepted = terminalManager.write(args.id, args.data);
      return { accepted, submitted: false, status: status(args.id) };
    }
    case 'send': {
      const before = status(args.id);
      if (!before) return { accepted: false, submitted: false, status: null };
      const outcome = terminalManager.submit(args.id, args.text);
      if (!outcome?.accepted) return { accepted: false, submitted: false, status: status(args.id) };
      const timeoutMs = Math.min(60_000, Math.max(0, Number(args.timeoutMs) || 5_000));
      const expected = String(args.expected || '');
      const initialHistory = history.get(String(args.id)) || '';
      const deadline = Date.now() + timeoutMs;
      let current = status(args.id);
      while (Date.now() < deadline) {
        const text = history.get(String(args.id)) || '';
        current = status(args.id);
        if (!current || ['exited', 'error'].includes(current.phase)) break;
        // An expected literal is the confirmation the caller asked for: any
        // output bump (e.g. ConPTY init sequences that land after create) must
        // not end the wait early, or the acknowledgement lies about submission.
        if (expected && text.includes(expected)) break;
        if (!expected && current.outputRevision > before.outputRevision) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const text = history.get(String(args.id)) || '';
      current = status(args.id);
      return {
        accepted: true,
        submitted: true,
        inputRevision: current?.inputRevision ?? before.inputRevision,
        outputRevision: current?.outputRevision ?? before.outputRevision,
        outputObserved: Boolean(current && current.outputRevision > before.outputRevision),
        matched: expected ? text.includes(expected) : false,
        historyDelta: text.slice(initialHistory.length).slice(-64_000),
        timedOut: Boolean(current && current.outputRevision <= before.outputRevision && !['exited', 'error'].includes(current.phase) && !(expected && text.includes(expected))),
        phase: current?.phase || 'error',
        exitCode: current?.exitCode ?? null,
        error: current?.error || null,
        status: current
      };
    }
    case 'recover':
      return terminalManager.recover(args.id);
    case 'paste':
      return terminalManager.paste(args.id, args.text);
    case 'resize':
      return terminalManager.resize(args.id, args.cols, args.rows);
    case 'setDimensions': {
      const updated = terminalManager.setDimensions(args.id, args.cols, args.rows);
      return updated ? status(updated.id) : null;
    }
    case 'dispose': {
      const disposed = terminalManager.dispose(args.id);
      if (disposed) history.delete(String(args.id));
      return disposed;
    }
    case 'shutdown':
      terminalManager.disposeAll();
      // Reply before terminating so the caller can distinguish a deliberate
      // explicit shutdown from an unexpected broker loss.
      setTimeout(() => process.exit(0), 0);
      return true;
    default:
      throw new Error('Unknown terminal broker method.');
  }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let authenticated = false;
  let buffered = '';
  socket.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { socket.destroy(); return; }
      if (!authenticated) {
        if (message?.type !== 'authenticate' || message.secret !== secret) { socket.destroy(); return; }
        authenticated = true;
        clients.add(socket);
        clearTimeout(idleTimer);
        idleTimer = null;
        send(socket, { event: 'state', ...(awaitState()) });
        continue;
      }
      if (!Number.isInteger(message?.id) || typeof message.method !== 'string') continue;
      Promise.resolve(dispatch(message.method, message.args)).then(
        (result) => send(socket, { id: message.id, ok: true, result }),
        (error) => send(socket, { id: message.id, ok: false, error: error?.message || 'Terminal broker request failed.' })
      );
    }
  });
  socket.on('close', () => { clients.delete(socket); scheduleIdleShutdown(); });
  socket.on('error', () => { clients.delete(socket); scheduleIdleShutdown(); });
});

function awaitState() {
  return { contractVersion: CONTRACT_VERSION, sessions: terminalManager.list().map((session) => status(session.id)), backend: terminalManager.backendInfo() };
}

server.listen(pipePath, scheduleIdleShutdown);
