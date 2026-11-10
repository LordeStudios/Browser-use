import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1_000;
const DEFAULT_SESSION_TTL_MS = Infinity;
const DEFAULT_CAPABILITIES = ['input.pointer', 'input.keyboard', 'view.frames'];

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== 'object' || !isNonEmptyString(target.browserInstanceId) || !isNonEmptyString(target.cdpTargetId) || !Number.isInteger(target.tabId)) {
    throw new Error('Target requires browserInstanceId, integer tabId, and cdpTargetId');
  }
  return {
    browserInstanceId: target.browserInstanceId.trim(),
    tabId: target.tabId,
    cdpTargetId: target.cdpTargetId.trim()
  };
}

function normalizeClient(client) {
  if (!client || typeof client !== 'object' || !isNonEmptyString(client.name)) {
    throw new Error('Client metadata requires a non-empty name');
  }
  return {
    name: client.name.trim().slice(0, 80),
    ...(isNonEmptyString(client.version) ? { version: client.version.trim().slice(0, 40) } : {})
  };
}

function normalizeCapabilities(capabilities = DEFAULT_CAPABILITIES) {
  if (!Array.isArray(capabilities) || capabilities.some((capability) => !isNonEmptyString(capability))) {
    throw new Error('Capabilities must be an array of non-empty strings');
  }
  return [...new Set(capabilities.map((capability) => capability.trim()))];
}

function digest(secret) {
  return crypto.createHash('sha256').update(secret).digest();
}

function safeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function serializeSession(session, extra = {}) {
  return {
    id: session.id,
    client: { ...session.client },
    target: { ...session.target },
    capabilities: [...session.capabilities],
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ...extra
  };
}

export class PairingService extends EventEmitter {
  constructor({ instanceId, now = Date.now, pairingTtlMs = DEFAULT_PAIRING_TTL_MS, sessionTtlMs = DEFAULT_SESSION_TTL_MS } = {}) {
    super();
    if (!isNonEmptyString(instanceId)) throw new Error('instanceId is required');
    if (!isPositiveNumber(pairingTtlMs) || (sessionTtlMs !== Infinity && !isPositiveNumber(sessionTtlMs))) throw new Error('Pairing and session TTLs must be positive');
    this.instanceId = instanceId.trim();
    this.now = now;
    this.pairingTtlMs = pairingTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.offer = null;
    this.sessions = new Map();
  }

  createOffer() {
    this.prune();
    const pairingCode = randomSecret();
    const expiresAt = this.now() + this.pairingTtlMs;
    this.offer = { digest: digest(pairingCode), expiresAt };
    return { instanceId: this.instanceId, pairingCode, expiresAt };
  }

  pair({ pairingCode, client, target, capabilities } = {}) {
    this.prune();
    if (!this.offer || !isNonEmptyString(pairingCode) || !safeEqual(this.offer.digest, digest(pairingCode))) {
      throw new Error('Pairing code is invalid or already used');
    }

    this.offer = null;
    const capability = randomSecret();
    const session = {
      id: crypto.randomUUID(),
      capabilityDigest: digest(capability),
      client: normalizeClient(client),
      target: normalizeTarget(target),
      capabilities: new Set(normalizeCapabilities(capabilities)),
      createdAt: this.now(),
      expiresAt: this.now() + this.sessionTtlMs
    };
    this.sessions.set(session.id, session);
    return serializeSession(session, { capability });
  }

  authenticate(capability) {
    const session = this.findByCapability(capability);
    if (!session) throw new Error('Unauthorized session capability');
    return serializeSession(session);
  }

  authorize(capability, { capability: requestedCapability, target } = {}) {
    const session = this.findByCapability(capability);
    if (!session) throw new Error('Unauthorized session capability');
    if (!isNonEmptyString(requestedCapability) || !session.capabilities.has(requestedCapability)) {
      throw new Error(`Capability not granted: ${requestedCapability || 'unknown'}`);
    }
    const normalizedTarget = normalizeTarget(target);
    if (!sameTarget(normalizedTarget, session.target)) throw new Error('Requested target does not match the paired target');
    return serializeSession(session);
  }

  authorizeAny(capability, { capabilities, target } = {}) {
    const session = this.findByCapability(capability);
    if (!session) throw new Error('Unauthorized session capability');
    const requested = normalizeCapabilities(capabilities || []);
    if (!requested.some((name) => session.capabilities.has(name))) throw new Error('No requested capabilities are granted');
    const normalizedTarget = normalizeTarget(target);
    if (!sameTarget(normalizedTarget, session.target)) throw new Error('Requested target does not match the paired target');
    return serializeSession(session);
  }

  revoke(sessionId, reason = 'revoked') {
    const revoked = this.sessions.delete(sessionId);
    if (revoked) this.emit('session.revoked', { sessionId, reason });
    return revoked;
  }

  status() {
    this.prune();
    return {
      instanceId: this.instanceId,
      pairing: this.offer ? { active: true, expiresAt: this.offer.expiresAt } : { active: false },
      sessions: [...this.sessions.values()].map((session) => serializeSession(session))
    };
  }

  prune() {
    const now = this.now();
    if (this.offer && Number.isFinite(this.offer.expiresAt) && this.offer.expiresAt <= now) this.offer = null;
    for (const [sessionId, session] of this.sessions) {
      if (Number.isFinite(session.expiresAt) && session.expiresAt <= now) this.revoke(sessionId, 'expired');
    }
  }

  findByCapability(capability) {
    this.prune();
    if (!isNonEmptyString(capability)) return null;
    const candidate = digest(capability);
    for (const session of this.sessions.values()) {
      if (safeEqual(session.capabilityDigest, candidate)) return session;
    }
    return null;
  }
}

function sameTarget(left, right) {
  return left.browserInstanceId === right.browserInstanceId && left.tabId === right.tabId && left.cdpTargetId === right.cdpTargetId;
}

export { DEFAULT_CAPABILITIES, DEFAULT_PAIRING_TTL_MS, DEFAULT_SESSION_TTL_MS };
