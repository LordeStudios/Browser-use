'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Durable pairing state: without it, the capability key was process-private
// (crypto.randomBytes in memory), so every desktop restart invalidated every
// MCP client bootstrap — the root cause of recurring "DCR 404" reconnect
// failures. The key and the displayed pairing code now persist on disk and
// survive restarts, so a statically configured header re-bootstraps forever.
const STATE_DIR = process.env.BROWSER_USE_STATE_DIR || path.join(os.homedir(), '.browser-use');
const STATE_FILE = path.join(STATE_DIR, 'mcp-pairing-state.json');
const STATIC_PAIRING_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
function loadOrCreatePairingState() {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
  if (!state || !(state.key instanceof String) && typeof state.key !== 'string') {
    state = { key: crypto.randomBytes(32).toString('base64'), pairingCode: crypto.randomBytes(24).toString('base64url') };
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1), { encoding: 'utf8' });
    } catch {}
  }
  return state;
}

const DEFAULT_PAIRING_TTL_MS = 5 * 60 * 1000;
// A pairing header remains reusable for the same short-lived offer lifetime.
// Weak MCP clients commonly replay initialization or lose their first opaque
// transport id, so making the displayed code effectively one-time is fragile.
// It still derives only the original full-access broker session and expires with
// the offer; it never creates a second session or changes its access scope.
const DEFAULT_PAIRING_RECOVERY_TTL_MS = DEFAULT_PAIRING_TTL_MS;
const DEFAULT_SESSION_TTL_MS = Infinity;
// A successfully paired host has the complete Desktop MCP tool catalog. The
// explicit tab binding below still selects the only tab a tab-scoped tool may
// address; it is target selection, not a separate permission prompt.
const FULL_ACCESS_GRANT = '*';

class SessionBroker {
  constructor({ installationId, instanceId, connectionMode = 'secure', now = Date.now, pairingTtlMs = DEFAULT_PAIRING_TTL_MS, pairingRecoveryTtlMs = DEFAULT_PAIRING_RECOVERY_TTL_MS, sessionTtlMs = DEFAULT_SESSION_TTL_MS, onSessionEnded = null, onStateChanged = null, onTabBindingChanged = null }) {
    if (!isNonEmptyString(installationId) || !isNonEmptyString(instanceId)) {
      throw new Error('installationId and instanceId are required');
    }
    if (!isPositiveNumber(pairingTtlMs) || !isPositiveNumber(pairingRecoveryTtlMs) || (sessionTtlMs !== Infinity && !isPositiveNumber(sessionTtlMs))) {
      throw new Error('pairingTtlMs, pairingRecoveryTtlMs, and sessionTtlMs must be positive');
    }
    if (onSessionEnded !== null && typeof onSessionEnded !== 'function') {
      throw new Error('onSessionEnded must be a function when provided');
    }
    if (onStateChanged !== null && typeof onStateChanged !== 'function') {
      throw new Error('onStateChanged must be a function when provided');
    }
    if (onTabBindingChanged !== null && typeof onTabBindingChanged !== 'function') {
      throw new Error('onTabBindingChanged must be a function when provided');
    }

    this.installationId = installationId;
    this.instanceId = instanceId;
    this.connectionMode = 'secure';
    this.now = now;
    this.pairingTtlMs = pairingTtlMs;
    this.pairingRecoveryTtlMs = pairingRecoveryTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    // V293: the durable pairing design is now actually WIRED IN. Previously
    // the key was process-private (crypto.randomBytes) and every offer minted
    // a fresh code — so every desktop restart orphaned the statically
    // configured MCP host (the recurring "DCR 404" / reconnect failures). The
    // capability key and pairing code now persist on disk and survive
    // restarts, so a statically configured pairing header re-bootstraps
    // forever, and a lapsed recovery window mints a fresh session instead of
    // dead-ending the host.
    const durable = loadOrCreatePairingState();
    this.pairingCapabilityKey = Buffer.from(durable.key, 'base64');
    this.durablePairingCode = durable.pairingCode;
    this.onSessionEnded = onSessionEnded;
    this.onStateChanged = onStateChanged;
    this.onTabBindingChanged = onTabBindingChanged;
    this.pairing = { digest: digest(this.durablePairingCode), expiresAt: this.now() + STATIC_PAIRING_TTL_MS, sessionId: null };
    this.sessions = new Map();
  }

  setConnectionMode(_mode) {
    this.connectionMode = 'secure';
  }

  createPairingOffer() {
    this.pruneExpired();
    // V293: the durable code IS the offer — the app UI always shows the same
    // statically configurable code, and a live session binding is preserved.
    const pairingCode = this.durablePairingCode;
    const expiresAt = this.now() + STATIC_PAIRING_TTL_MS;
    this.pairing = { digest: digest(pairingCode), expiresAt, sessionId: this.pairing?.sessionId || null, recoveryExpiresAt: this.pairing?.recoveryExpiresAt };
    this.notifyStateChanged();
    return { instanceId: this.instanceId, pairingCode, expiresAt };
  }

  cancelPairingOffer() {
    const hadOffer = Boolean(this.pairing);
    this.pairing = null;
    if (hadOffer) this.notifyStateChanged();
    return hadOffer;
  }

  pair({ pairingCode, host } = {}) {
    this.pruneExpired();
    if (!this.pairing || !isNonEmptyString(pairingCode) || !safeEqual(this.pairing.digest, digest(pairingCode))) {
      throw unauthorized('Pairing code is invalid or expired');
    }
    const capability = pairingCapability(this.pairingCapabilityKey, pairingCode);
    if (this.pairing.sessionId) {
      const existing = this.sessions.get(this.pairing.sessionId);
      if (existing && isPairingRecoverable(this.pairing, this.now()) && safeEqual(existing.capabilityDigest, digest(capability))) {
        return serializeSession(existing, { capability });
      }
      // Durable code: a lapsed recovery window or a revoked session mints a
      // FRESH session from the same statically configured code instead of
      // dead-ending the host. (A revoked/expired session is still never
      // resurrected — this creates a new one.)
    }
    const hostInfo = isValidHost(host) ? { name: host.name.trim(), ...(isNonEmptyString(host.version) ? { version: host.version.trim() } : {}) } : { name: 'Direct MCP Client', version: '1.0.0' };
    const session = {
      id: crypto.randomUUID(),
      capabilityDigest: digest(capability),
      host: hostInfo,
      createdAt: this.now(),
      expiresAt: this.sessionTtlMs === Infinity ? Infinity : this.now() + this.sessionTtlMs,
      grants: new Set([FULL_ACCESS_GRANT]),
      tabId: null
    };
    this.sessions.set(session.id, session);
    this.pairing.sessionId = session.id;
    this.pairing.recoveryExpiresAt = Math.min(this.pairing.expiresAt, this.now() + this.pairingRecoveryTtlMs);
    this.notifyStateChanged();
    return serializeSession(session, { capability });
  }

  authenticate(capability) {
    const session = this.findSessionByCapability(capability);
    if (!session) throw unauthorized();
    return serializeSession(session);
  }

  authorize(capability, toolName) {
    if (!isNonEmptyString(toolName)) throw new Error('Tool name is required');
    const session = this.findSessionByCapability(capability);
    if (!session) throw unauthorized();
    return serializeSession(session);
  }

  bindTab(capability, tabId) {
    if (!isNonEmptyString(tabId)) throw new Error('Tab id is required');
    const session = this.findSessionByCapability(capability);
    if (!session) throw unauthorized();
    const changed = session.tabId !== tabId;
    if (session.tabId && changed) this.notifyTabBindingChanged(session.id);
    session.tabId = tabId;
    if (changed) this.notifyStateChanged();
    return serializeSession(session);
  }

  unbindTab(tabId) {
    if (!isNonEmptyString(tabId)) return false;
    let unbound = false;
    for (const session of this.sessions.values()) {
      if (session.tabId !== tabId) continue;
      this.notifyTabBindingChanged(session.id);
      session.tabId = null;
      unbound = true;
    }
    if (unbound) this.notifyStateChanged();
    return unbound;
  }

  revoke(sessionId) {
    const revoked = this.sessions.delete(sessionId);
    if (revoked) {
      // V293: revocation terminates the session; the durable offer survives
      // (binding cleared) so the statically configured host can re-pair.
      if (this.pairing?.sessionId === sessionId) this.pairing.sessionId = null;
      this.notifySessionEnded(sessionId);
      this.notifyStateChanged();
    }
    return revoked;
  }

  revokeAll() {
    const sessionIds = [...this.sessions.keys()];
    const hadPairing = Boolean(this.pairing);
    this.sessions.clear();
    if (this.pairing) this.pairing.sessionId = null;
    for (const sessionId of sessionIds) this.notifySessionEnded(sessionId);
    if (sessionIds.length || hadPairing) this.notifyStateChanged();
    return sessionIds.length;
  }

  status() {
    this.pruneExpired();
    return {
      installationId: this.installationId,
      instanceId: this.instanceId,
      pairing: this.pairing ? serializePairing(this.pairing, this.now()) : { active: false },
      sessions: [...this.sessions.values()].map((session) => serializeSession(session))
    };
  }

  pruneExpired() {
    const now = this.now();
    let changed = false;
    if (this.pairing && Number.isFinite(this.pairing.expiresAt) && this.pairing.expiresAt <= now) {
      this.pairing = null;
      changed = true;
    }
    const expired = [];
    for (const [id, session] of this.sessions) {
      if (Number.isFinite(session.expiresAt) && session.expiresAt <= now) {
        this.sessions.delete(id);
        // V293: the durable offer outlives session expiry — only the binding
        // clears, so the statically configured host can always re-pair.
        if (this.pairing?.sessionId === id) this.pairing.sessionId = null;
        expired.push(id);
        changed = true;
      }
    }
    for (const sessionId of expired) this.notifySessionEnded(sessionId);
    if (changed) this.notifyStateChanged();
  }

  // Input release must never block revocation, expiry, or shutdown.
  notifySessionEnded(sessionId) {
    if (!this.onSessionEnded) return;
    try {
      this.onSessionEnded(sessionId);
    } catch {}
  }

  // Changing the controlled tab releases its held input, not its authentication.
  // Session-ended observers may destroy the opaque transport, so never call them
  // for a rebind or tab closure while the broker session is still live.
  notifyTabBindingChanged(sessionId) {
    if (!this.onTabBindingChanged) return;
    try {
      this.onTabBindingChanged(sessionId);
    } catch {}
  }

  // HTTP pairing happens outside Electron IPC. This callback makes its visible
  // session state reach the renderer immediately after an HTTP host connects.
  notifyStateChanged() {
    if (!this.onStateChanged) return;
    try {
      this.onStateChanged();
    } catch {}
  }

  findSessionByCapability(capability) {
    this.pruneExpired();
    if (!isNonEmptyString(capability)) return null;
    const capabilityDigest = digest(capability);
    for (const session of this.sessions.values()) {
      if (safeEqual(session.capabilityDigest, capabilityDigest)) return session;
    }
    return null;
  }
}

function serializeSession(session, extra = {}) {
  return {
    id: session.id,
    host: { ...session.host },
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    fullAccess: true,
    grants: [...session.grants],
    tabId: session.tabId,
    ...extra
  };
}

function randomSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function pairingCapability(key, pairingCode) {
  return crypto.createHmac('sha256', key).update(pairingCode).digest('base64url');
}

function serializePairing(pairing, now) {
  const recoverable = Boolean(pairing.sessionId && isPairingRecoverable(pairing, now));
  return {
    active: true,
    recoverable,
    expiresAt: pairing.expiresAt,
    ...(pairing.sessionId ? { recoveryExpiresAt: pairing.recoveryExpiresAt } : {})
  };
}

function isPairingRecoverable(pairing, now) {
  return pairing?.recoveryExpiresAt === Infinity || (Number.isFinite(pairing?.recoveryExpiresAt) && pairing.recoveryExpiresAt > now);
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqual(left, right) {
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function unauthorized(message = 'Unauthorized session capability') {
  const error = new Error(message);
  error.code = 'UNAUTHORIZED';
  return error;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveNumber(value) {
  return Number.isFinite(value) && value > 0;
}

function isValidHost(host) {
  return host && typeof host === 'object' && isNonEmptyString(host.name);
}

module.exports = { SessionBroker, FULL_ACCESS_GRANT };
