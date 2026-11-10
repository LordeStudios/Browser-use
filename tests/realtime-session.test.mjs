import assert from 'node:assert/strict';
import test from 'node:test';
import { PairingService } from '../src/pairing/pairingService.js';
import { BrowserSession } from '../src/session/browserSession.js';
import { InputScheduler } from '../src/realtime/inputScheduler.js';

const NOW = 1_700_000_000_000;

function createPairingService() {
  return new PairingService({
    instanceId: 'browser-instance-test',
    now: () => NOW,
    pairingTtlMs: 60_000,
    sessionTtlMs: 120_000
  });
}

test('pairing offers are single-use and capabilities never appear in status', () => {
  const pairing = createPairingService();
  const offer = pairing.createOffer();
  const session = pairing.pair({
    pairingCode: offer.pairingCode,
    client: { name: 'realtime-test-client', version: '1' },
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' }
  });

  assert.ok(session.capability);
  assert.equal(session.target.tabId, 14);
  assert.throws(() => pairing.pair({ pairingCode: offer.pairingCode, client: { name: 'second-client' } }), /invalid or already used/i);
  assert.equal(JSON.stringify(pairing.status()).includes(session.capability), false);
});

test('a session authorizes only its bound target and explicit capabilities', () => {
  const pairing = createPairingService();
  const offer = pairing.createOffer();
  const session = pairing.pair({
    pairingCode: offer.pairingCode,
    client: { name: 'controller' },
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' },
    capabilities: ['input.pointer', 'input.keyboard', 'view.frames']
  });

  const authorized = pairing.authorize(session.capability, {
    capability: 'input.pointer',
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' }
  });
  assert.equal(authorized.id, session.id);
  assert.throws(() => pairing.authorize(session.capability, {
    capability: 'navigation',
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' }
  }), /not granted/i);
  assert.throws(() => pairing.authorize(session.capability, {
    capability: 'input.pointer',
    target: { browserInstanceId: 'chrome-profile-a', tabId: 15, cdpTargetId: 'target-15' }
  }), /does not match/i);
});

test('pairing revocation emits a lifecycle event and invalidates capability use', () => {
  const pairing = createPairingService();
  const offer = pairing.createOffer();
  const session = pairing.pair({
    pairingCode: offer.pairingCode,
    client: { name: 'controller' },
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' }
  });
  const events = [];
  pairing.on('session.revoked', (event) => events.push(event));

  assert.equal(pairing.revoke(session.id), true);
  assert.deepEqual(events, [{ sessionId: session.id, reason: 'revoked' }]);
  assert.throws(() => pairing.authenticate(session.capability), /unauthorized/i);
});

test('browser session supports one controller and disconnect-safe state clearing', () => {
  const session = new BrowserSession({
    id: 'session-test',
    target: { browserInstanceId: 'chrome-profile-a', tabId: 14, cdpTargetId: 'target-14' },
    capabilities: ['input.pointer', 'input.keyboard']
  });

  session.claimController('controller-a');
  assert.throws(() => session.claimController('controller-b'), /already controlled/i);
  session.recordKey('KeyW', true);
  session.recordButton('left', true);
  assert.deepEqual(session.releaseInput(), { keys: ['KeyW'], buttons: ['left'] });
  assert.deepEqual(session.inputState(), { pressedKeys: [], pressedButtons: [], pointer: null });
});

test('input scheduler preserves edge events while replacing stale pointer motion', async () => {
  const dispatched = [];
  const scheduler = new InputScheduler({
    dispatch: async (event) => dispatched.push(event),
    maxQueueSize: 4
  });

  scheduler.enqueue({ sequence: 1, type: 'input.pointer', action: 'move', x: 1, y: 1 });
  scheduler.enqueue({ sequence: 2, type: 'input.pointer', action: 'move', x: 2, y: 2 });
  scheduler.enqueue({ sequence: 3, type: 'input.key', action: 'down', key: 'KeyW' });
  scheduler.enqueue({ sequence: 4, type: 'input.pointer', action: 'up', button: 'left', x: 2, y: 2 });
  await scheduler.drain();

  assert.deepEqual(dispatched.map((event) => event.sequence), [2, 3, 4]);
  assert.throws(() => scheduler.enqueue({ sequence: 4, type: 'input.key', action: 'up', key: 'KeyW' }), /strictly increasing/i);
});
