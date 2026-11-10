import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { dispatchRealtimeInput } from '../browser/input.js';
import { BrowserSession } from '../session/browserSession.js';
import { InputScheduler } from './inputScheduler.js';
import { FrameStreamer } from './frameStreamer.js';

const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_INPUTS_PER_SECOND = 120;

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function sendJson(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function parseMessage(raw) {
  if (Buffer.byteLength(raw) > MAX_MESSAGE_BYTES) throw new Error('Realtime message exceeds maximum size');
  const message = JSON.parse(raw);
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') throw new Error('Realtime message requires a type');
  return message;
}

export class RealtimeServer {
  constructor({ httpServer, pairing, browser, eventBus, path = '/realtime/v1' } = {}) {
    if (!httpServer || !pairing || !browser) throw new Error('Realtime server requires HTTP server, pairing service, and browser');
    this.httpServer = httpServer;
    this.pairing = pairing;
    this.browser = browser;
    this.eventBus = eventBus;
    this.path = path;
    this.webSocketServer = new WebSocketServer({ noServer: true });
    this.sessions = new Map();
    this.connectionsBySession = new Map();
    this.upgrade = this.upgrade.bind(this);
    this.handleRevocation = this.handleRevocation.bind(this);
    this.httpServer.on('upgrade', this.upgrade);
    this.pairing.on('session.revoked', this.handleRevocation);
    this.webSocketServer.on('connection', (socket) => this.connect(socket));
  }

  upgrade(request, socket, head) {
    const url = new URL(request.url || '/', 'http://localhost');
    if (url.pathname !== this.path) return;
    if (!isLoopback(request.socket.remoteAddress)) return socket.destroy();
    this.webSocketServer.handleUpgrade(request, socket, head, (websocket) => this.webSocketServer.emit('connection', websocket, request));
  }

  connect(socket) {
    const connection = { connectionId: crypto.randomUUID(), socket, authenticated: false, inputTimes: [] };
    socket.on('message', (raw) => this.handleMessage(connection, raw).catch((error) => sendJson(socket, { type: 'error', error: error.message })));
    socket.on('close', () => this.closeConnection(connection));
    sendJson(socket, { type: 'session.hello', protocolVersion: 1 });
  }

  async handleMessage(connection, raw) {
    const message = parseMessage(raw);
    if (!connection.authenticated) {
      if (message.type !== 'session.authenticate') throw new Error('Authenticate before sending realtime messages');
      return this.authenticate(connection, message);
    }
    if (message.type === 'session.release') return this.closeConnection(connection);
    if (message.type === 'stream.requestKeyframe') return connection.streamer?.restart();
    if (!message.type.startsWith('input.')) throw new Error(`Unsupported realtime message type: ${message.type}`);

    this.pairing.authenticate(connection.capability);
    this.consumeInputAllowance(connection);
    connection.scheduler.enqueue(message);
    await connection.scheduler.drain();
    sendJson(connection.socket, { type: 'input.ack', sequence: message.sequence, appliedAt: Date.now(), inputState: connection.session.inputState() });
  }

  async authenticate(connection, message) {
    const role = message.role === 'observer' ? 'observer' : 'controller';
    const authorized = role === 'controller'
      ? this.pairing.authorizeAny(message.capability, { capabilities: ['input.pointer', 'input.keyboard'], target: message.target })
      : this.pairing.authorize(message.capability, { capability: 'view.frames', target: message.target });
    const session = this.getSession(authorized);
    const activeTarget = [...this.sessions.values()].find((candidate) => (this.connectionsBySession.get(candidate.id)?.size || 0) > 0 && candidate.target.cdpTargetId !== session.target.cdpTargetId);
    if (activeTarget) throw new Error('A different paired target is already active; release it before controlling another tab');
    if (role === 'controller') session.claimController(connection.connectionId);

    await this.selectTarget(session.target);
    connection.authenticated = true;
    connection.capability = message.capability;
    connection.session = session;
    connection.role = role;
    connection.scheduler = new InputScheduler({ dispatch: async (event) => this.dispatchInput(connection, event) });
    this.addConnection(connection);
    connection.streamer = this.createStreamer(connection);
    await connection.streamer.start();
    this.eventBus?.emitEvent('realtime.session.ready', { sessionId: session.id, role });
    sendJson(connection.socket, { type: 'session.ready', sessionId: session.id, role, target: session.target, capabilities: [...session.capabilities] });
  }

  getSession(record) {
    let session = this.sessions.get(record.id);
    if (!session) {
      session = new BrowserSession({ id: record.id, target: record.target, capabilities: record.capabilities });
      this.sessions.set(record.id, session);
    }
    return session;
  }

  addConnection(connection) {
    const connections = this.connectionsBySession.get(connection.session.id) || new Set();
    connections.add(connection);
    this.connectionsBySession.set(connection.session.id, connections);
  }

  removeConnection(connection) {
    const connections = this.connectionsBySession.get(connection.session?.id);
    connections?.delete(connection);
    if (connections?.size === 0) this.connectionsBySession.delete(connection.session.id);
  }

  createStreamer(connection) {
    return new FrameStreamer({
      browser: this.browser,
      sessionId: connection.session.id,
      targetId: connection.session.target.cdpTargetId,
      onFrame: async (payload) => {
        if (connection.socket.readyState === 1) connection.socket.send(payload, { binary: true });
      },
      onError: (error) => this.eventBus?.emitEvent('realtime.frame.error', { sessionId: connection.session.id, error: error.message })
    });
  }

  async selectTarget(target) {
    await this.browser.selectTab(target.cdpTargetId);
    if (this.browser.target?.id !== target.cdpTargetId) throw new Error('Paired target is unavailable');
  }

  consumeInputAllowance(connection) {
    const now = Date.now();
    connection.inputTimes = connection.inputTimes.filter((time) => time > now - 1_000);
    if (connection.inputTimes.length >= MAX_INPUTS_PER_SECOND) throw new Error('Input rate limit exceeded');
    connection.inputTimes.push(now);
  }

  async dispatchInput(connection, event) {
    const capability = event.type === 'input.key' || event.type === 'input.text' ? 'input.keyboard' : 'input.pointer';
    this.pairing.authorize(connection.capability, { capability, target: connection.session.target });
    if (this.browser.target?.id !== connection.session.target.cdpTargetId) {
      await this.selectTarget(connection.session.target);
    }
    const result = await dispatchRealtimeInput({ browser: this.browser }, event);
    if (event.type === 'input.key') connection.session.recordKey(event.key, event.action === 'down');
    if (event.type === 'input.pointer') {
      connection.session.recordPointer(event.x, event.y);
      if (event.action === 'down' || event.action === 'up') connection.session.recordButton(event.button || 'left', event.action === 'down');
    }
    return result;
  }

  async handleRevocation({ sessionId, reason }) {
    const connections = [...(this.connectionsBySession.get(sessionId) || [])];
    await Promise.all(connections.map(async (connection) => {
      sendJson(connection.socket, { type: 'session.revoked', reason });
      connection.socket.close(4001, 'Session revoked');
      await this.closeConnection(connection);
    }));
  }

  async closeConnection(connection) {
    if (!connection.authenticated || connection.closing) return;
    connection.closing = true;
    connection.authenticated = false;
    await connection.streamer?.stop();
    const pointer = connection.session.pointer || { x: 0, y: 0 };
    const released = connection.session.releaseInput();
    if (this.browser.target?.id !== connection.session.target.cdpTargetId) {
      await this.selectTarget(connection.session.target).catch(() => {});
    }
    for (const key of released.keys) await dispatchRealtimeInput({ browser: this.browser }, { type: 'input.key', action: 'up', key }).catch(() => {});
    for (const button of released.buttons) await dispatchRealtimeInput({ browser: this.browser }, { type: 'input.pointer', action: 'up', button, ...pointer }).catch(() => {});
    if (connection.session.controllerId === connection.connectionId) connection.session.controllerId = null;
    this.removeConnection(connection);
    this.eventBus?.emitEvent('realtime.session.closed', { sessionId: connection.session.id, role: connection.role });
  }

  async close() {
    this.httpServer.off('upgrade', this.upgrade);
    this.pairing.off('session.revoked', this.handleRevocation);
    for (const client of this.webSocketServer.clients) client.close();
    await new Promise((resolve) => this.webSocketServer.close(resolve));
  }
}
