import crypto from 'node:crypto';

const DEFAULT_SESSION_TTL_MS = Infinity;
const MAX_SESSIONS = 64;

// Session records are metadata only, mirroring the Studio McpSession Durable
// Object: many MCP sessions observe one persistent browser runtime owned by the
// daemon. Dropping a session never touches the browser.
export class SessionStore {
  constructor({ ttlMs = DEFAULT_SESSION_TTL_MS, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.sessions = new Map();
  }

  create(clientInfo = null) {
    this.prune();
    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastSeenAt - b.lastSeenAt)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    const session = {
      id: `sess-${crypto.randomUUID()}`,
      clientInfo: clientInfo && typeof clientInfo === 'object'
        ? { name: String(clientInfo.name || '').slice(0, 80), version: String(clientInfo.version || '').slice(0, 40) }
        : null,
      createdAt: this.now(),
      lastSeenAt: this.now(),
      initialized: true
    };
    this.sessions.set(session.id, session);
    return session;
  }

  touch(id) {
    this.prune();
    const session = typeof id === 'string' ? this.sessions.get(id) : undefined;
    if (!session) return null;
    session.lastSeenAt = this.now();
    return session;
  }

  close(id) {
    return this.sessions.delete(id);
  }

  prune() {
    if (!Number.isFinite(this.ttlMs) || this.ttlMs <= 0) return;
    const cutoff = this.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastSeenAt <= cutoff) this.sessions.delete(id);
    }
  }

  status() {
    this.prune();
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      clientInfo: session.clientInfo,
      createdAt: session.createdAt,
      lastSeenAt: session.lastSeenAt
    }));
  }
}

export { DEFAULT_SESSION_TTL_MS, MAX_SESSIONS };
