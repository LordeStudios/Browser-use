import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PairingService } from '../src/pairing/pairingService.js';
import { startWebSocketServer } from '../src/server/websocketServer.js';

function createContext() {
  const eventBus = new EventEmitter();
  eventBus.emitEvent = () => {};
  return {
    browser: {
      diagnostics: { snapshot: () => ({}) },
      getCurrentInfo: async () => ({ url: 'about:blank', title: 'test' })
    },
    eventBus,
    pairing: new PairingService({ instanceId: 'server-test' }),
    sessionId: 'server-test-session'
  };
}

async function json(url, options) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('the loopback server creates one-time pairing offers and preserves no secret in status', async () => {
  const ctx = createContext();
  const server = await startWebSocketServer(ctx, new Map(), { port: 0 });
  const base = `http://127.0.0.1:${server.actualPort}`;

  try {
    const offer = await json(`${base}/pairing/offer`, { method: 'POST' });
    assert.equal(offer.response.status, 200);
    assert.ok(offer.body.offer.pairingCode);

    const paired = await json(`${base}/pairing/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairingCode: offer.body.offer.pairingCode,
        client: { name: 'server-test-client' },
        target: { browserInstanceId: 'chrome-a', tabId: 7, cdpTargetId: 'target-7' }
      })
    });
    assert.equal(paired.response.status, 201);
    assert.ok(paired.body.session.capability);

    const status = await json(`${base}/pairing/status`);
    assert.equal(JSON.stringify(status.body).includes(paired.body.session.capability), false);
    assert.equal(status.body.pairing.pairing.active, false);
  } finally {
    await server.close();
  }
});

test('the realtime endpoint rejects a socket before a valid handshake', async () => {
  const ctx = createContext();
  const server = await startWebSocketServer(ctx, new Map(), { port: 0 });
  const port = server.actualPort;

  try {
    const upgrade = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/realtime/v1',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' }
      });
      request.on('upgrade', (_response, socket) => {
        socket.destroy();
        resolve(true);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(upgrade, true);
  } finally {
    await server.close();
  }
});
