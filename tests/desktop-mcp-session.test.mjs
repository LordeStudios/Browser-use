import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

const NOW = 1_700_000_000_000;

function createBroker(overrides = {}) {
  return new SessionBroker({
    installationId: 'installation-test',
    instanceId: 'instance-test',
    now: () => NOW,
    pairingTtlMs: 60_000,
    sessionTtlMs: 120_000,
    ...overrides
  });
}

function createPairedSession(broker, hostName = 'test-host') {
  const offer = broker.createPairingOffer();
  return broker.pair({ pairingCode: offer.pairingCode, host: { name: hostName } });
}

test('a durable pairing offer recovers one session across connection retries without serializing secrets', () => {
  const broker = createBroker();
  const offer = broker.createPairingOffer();

  assert.equal(offer.instanceId, 'instance-test');
  assert.ok(offer.pairingCode);
  // V293: the offer is durable — a statically configured header re-bootstraps forever.
  assert.deepEqual(broker.status().pairing, {
    active: true,
    recoverable: false,
    expiresAt: NOW + 10 * 365 * 24 * 60 * 60 * 1000
  });

  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test-host', version: '1.0.0' } });
  assert.ok(session.capability);
  assert.equal(session.host.name, 'test-host');
  const recovered = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host', version: '0.1.0' } });
  assert.equal(recovered.id, session.id, 'a retry must recover the existing session');
  assert.equal(recovered.capability, session.capability, 'a retry must recover the same bearer capability');
  assert.deepEqual(recovered.host, session.host, 'a retry must not rewrite the originally paired host metadata');
  assert.equal(broker.status().sessions.length, 1, 'a retry must not create a second session');
  assert.equal(JSON.stringify(broker.status()).includes(offer.pairingCode), false);
  assert.equal(JSON.stringify(broker.status()).includes(session.capability), false);
});

test('the durable pairing code keeps working after the recovery window lapses', () => {
  let now = NOW;
  const broker = new SessionBroker({
    installationId: 'default-lifetime-test',
    instanceId: 'default-lifetime-instance',
    now: () => now
  });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'weak-host' } });

  now += (5 * 60_000) - 1;
  const retry = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'weak-host-retry' } });
  assert.equal(retry.id, session.id, 'retrying within the recovery window preserves the original session');

  // V293: past the recovery window the durable code mints a FRESH session
  // instead of dead-ending the statically configured host. The capability is
  // derived deterministically from the durable credential — it is the same
  // static credential; the session behind it is what gets replaced.
  now += 2;
  const late = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'late-host' } });
  assert.notEqual(late.id, session.id);
  assert.equal(late.capability, session.capability, 'the durable credential is stable across sessions');
});

test('a lapsed recovery window re-pairs a statically configured host instead of failing it', () => {
  let now = NOW;
  const broker = createBroker({
    now: () => now,
    pairingTtlMs: 5 * 60_000,
    pairingRecoveryTtlMs: 1_000
  });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'weak-host' } });

  now += 1_001;
  const recovered = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host' } });
  assert.notEqual(recovered.id, session.id, 'a lapsed recovery window mints a fresh session');
  assert.equal(broker.authenticate(session.capability).id, session.id, 'the existing session remains valid after recovery closes');
});

test('cancelled offers fail closed while the durable code survives expiry and revocation', () => {
  let now = NOW;
  const broker = createBroker({ now: () => now });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test-host' } });

  // V293: the durable code outlives any display lifetime — within the
  // recovery window the same session is recovered; past it, a fresh one.
  now += 60_001;
  const recovered = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host' } });
  assert.equal(recovered.id, session.id, 'recovery window still active — same session returns');
  now += 300_001;
  const afterRecovery = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host' } });
  assert.notEqual(afterRecovery.id, session.id, 'a fresh session is minted from the durable code');

  // A cancelled offer fails closed until a new offer is created.
  broker.createPairingOffer();
  assert.equal(broker.cancelPairingOffer(), true);
  assert.throws(() => broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host' } }), /invalid or expired/i);

  // Revoking a session terminates it; the durable code re-pairs a fresh one.
  broker.createPairingOffer();
  const revocable = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'revocable-host' } });
  broker.revoke(revocable.id);
  const rePaired = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'retry-host' } });
  assert.notEqual(rePaired.id, revocable.id, 'revocation never resurrects the revoked session — a fresh one is minted');
});

test('sessions are instance-bound, expire, and can be revoked', () => {
  const broker = createBroker();
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test-host' } });

  assert.equal(broker.authenticate(session.capability).id, session.id);
  assert.throws(() => broker.authenticate('wrong-capability'), /unauthorized/i);
  assert.equal(broker.revoke(session.id), true);
  assert.throws(() => broker.authenticate(session.capability), /unauthorized/i);
});

test('a paired session has unrestricted MCP tool access immediately', () => {
  const broker = createBroker();
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test-host' } });

  assert.equal(session.fullAccess, true);
  assert.deepEqual(session.grants, ['*']);
  for (const toolName of [
    'browser_click_element',
    'browser_key',
    'browser_type',
    'browser_navigate',
    'browser_execute',
    'browser_set_device_mode',
    'browser_gesture',
    'browser_agent_start',
    'browser_agent_approve',
    'browser_agent_cancel'
  ]) {
    assert.equal(broker.authorize(session.capability, toolName).id, session.id, `${toolName} must be available immediately after pairing`);
  }
  assert.equal(broker.authorize(session.capability, 'browser_future_tool').id, session.id, 'new MCP tools must not need a new permission-list update');
});

test('state changes keep the desktop session list current for remote pairing', () => {
  const changes = [];
  const broker = createBroker({ onStateChanged: () => changes.push('changed') });

  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'remote-host' } });
  broker.bindTab(session.capability, 'tab-1');
  broker.revoke(session.id);

  assert.equal(changes.length, 4, 'offer, remote pairing, binding, and revoke must each refresh the visible session state');
});

test('the bridge stays paired even when callers request legacy fast mode', () => {
  const broker = createBroker({ connectionMode: 'fast' });

  assert.equal(broker.connectionMode, 'secure');
  assert.throws(() => broker.pair({ host: { name: 'unpaired-host' } }), /pairing code is invalid/i);

  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'paired-host' } });
  assert.equal(broker.authorize(session.capability, 'browser_key').id, session.id);
});

test('session termination and target changes report separate input-release lifecycles', () => {
  const ended = [];
  const targetChanges = [];
  let now = NOW;
  const broker = createBroker({
    now: () => now,
    sessionTtlMs: Infinity, // the test advances the clock past recovery; sessions must not expire underneath it
    onSessionEnded: (sessionId) => ended.push(sessionId),
    onTabBindingChanged: (sessionId) => targetChanges.push(sessionId)
  });

  const revoked = createPairedSession(broker, 'revoked-host');
  broker.revoke(revoked.id);
  assert.deepEqual(ended, [revoked.id]);
  assert.equal(broker.revoke(revoked.id), false, 'revoking twice must not report again');
  assert.deepEqual(ended, [revoked.id]);

  // V293: the durable code recovers one session within its recovery window —
  // advance past recovery to mint distinct sessions for each host.
  const first = createPairedSession(broker, 'first-host');
  now += 5 * 60_000 + 1;
  const second = createPairedSession(broker, 'second-host');
  ended.length = 0;
  assert.equal(broker.revokeAll(), 2);
  assert.deepEqual([...ended].sort(), [first.id, second.id].sort());

  now += 5 * 60_000 + 1;
  const rebound = createPairedSession(broker, 'rebinding-host');
  ended.length = 0;
  broker.bindTab(rebound.capability, 'tab-1');
  assert.deepEqual(targetChanges, [], 'the first binding holds no prior input');
  broker.bindTab(rebound.capability, 'tab-1');
  assert.deepEqual(targetChanges, [], 'rebinding the same tab keeps input intact');
  broker.bindTab(rebound.capability, 'tab-2');
  assert.deepEqual(targetChanges, [rebound.id]);
  assert.deepEqual(ended, [], 'rebinding does not terminate authentication');
  broker.unbindTab('tab-2');
  assert.deepEqual(targetChanges, [rebound.id, rebound.id]);
  assert.deepEqual(ended, [], 'closing a target does not terminate authentication');
  assert.equal(broker.authenticate(rebound.capability).tabId, null);
});

test('binding cleanup validates its callback and never blocks a target change', () => {
  assert.throws(() => createBroker({ onTabBindingChanged: true }), /onTabBindingChanged must be a function/);
  const changed = [];
  const broker = createBroker({
    onTabBindingChanged: (sessionId) => {
      changed.push(sessionId);
      throw new Error('input release failed');
    }
  });
  const session = createPairedSession(broker);
  broker.bindTab(session.capability, 'tab-1');
  assert.equal(broker.bindTab(session.capability, 'tab-2').tabId, 'tab-2');
  assert.equal(broker.unbindTab('tab-2'), true);
  assert.equal(broker.authenticate(session.capability).tabId, null);
  assert.deepEqual(changed, [session.id, session.id]);
});

test('expired sessions release their input and a failing release never blocks cleanup', () => {
  const ended = [];
  let now = NOW;
  const broker = createBroker({
    now: () => now,
    onSessionEnded: (sessionId) => {
      ended.push(sessionId);
      throw new Error('release failed');
    }
  });

  const session = createPairedSession(broker);
  now += 120_001;

  assert.deepEqual(broker.status().sessions, []);
  assert.deepEqual(ended, [session.id]);
  assert.throws(() => broker.authenticate(session.capability), /unauthorized/i);
});

test('closing a tab unbinds it so later calls fail closed instead of targeting it', () => {
  const broker = createBroker();
  const session = createPairedSession(broker);
  broker.bindTab(session.capability, 'tab-9');

  assert.equal(broker.unbindTab('tab-other'), false);
  assert.equal(broker.unbindTab('tab-9'), true);
  assert.equal(broker.authorize(session.capability, 'browser_key').tabId, null);
  assert.equal(broker.unbindTab('tab-9'), false, 'unbinding is idempotent');
  assert.equal(broker.authenticate(session.capability).id, session.id, 'the session stays paired but unbound');
});

test('session tab binding remains explicit while every tool stays available', () => {
  const broker = createBroker();
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test-host' } });

  assert.equal(broker.bindTab(session.capability, 'tab-7').tabId, 'tab-7');
  assert.equal(broker.authorize(session.capability, 'browser_get_tabs').id, session.id);
  assert.equal(broker.authorize(session.capability, 'browser_navigate').tabId, 'tab-7');
});
