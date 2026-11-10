'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Durable cross-run knowledge (desktop/knowledge/knowledgeStore_flow_chat.md).
// Everything program-specific the agent ever "knows" lives here as runtime
// data — never in code. The store is bounded, evictable, atomic, and every
// failure degrades to "no memory" instead of a failed run.

const DEFAULT_MAX_PER_KEY = 40;
const DEFAULT_MAX_TOTAL = 400;
const DEFAULT_RECALL_LIMIT = 3;
const DEFAULT_RECALL_CHARS = 1600;
const KINDS = new Set(['fact', 'recipe', 'ui-map', 'pitfall']);

function tokenize(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(token => token.length > 2));
}

function jaccard(a, b) {
  // Entries persist tokens as arrays; queries hold Sets. Normalize both.
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection += 1;
  return intersection / (setA.size + setB.size - intersection);
}

function keyOf(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'general';
}

class KnowledgeStore {
  constructor({ file, now = Date.now, maxPerKey = DEFAULT_MAX_PER_KEY, maxTotal = DEFAULT_MAX_TOTAL } = {}) {
    this.file = file;
    this.now = now;
    this.maxPerKey = maxPerKey;
    this.maxTotal = maxTotal;
    this.entries = [];
    this.loaded = false;
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    try {
      if (this.file && fs.existsSync(this.file)) {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (Array.isArray(parsed?.entries)) this.entries = parsed.entries.filter(entry => entry && typeof entry.text === 'string').slice(-this.maxTotal);
      }
    } catch {
      // A corrupt store is replaced on the next write, never fatal.
      this.entries = [];
    }
    return this;
  }

  persist() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, entries: this.entries.slice(-this.maxTotal) }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch { /* persistence is best-effort; memory stays usable */ }
  }

  record(keyText, kind, text, { source = 'execution', verified = false } = {}) {
    this.load();
    const cleanKind = KINDS.has(kind) ? kind : 'fact';
    const cleanText = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!cleanText) return null;
    const key = keyOf(keyText);
    const tokens = tokenize(cleanText);
    const existing = this.entries.find(entry => entry.key === key && jaccard(entry.tokens, tokens) >= 0.8);
    if (existing) {
      existing.hits += 1;
      existing.confidence = Math.min(1, existing.confidence + 0.15);
      existing.updatedAt = this.now();
      this.persist();
      return existing;
    }
    const entry = {
      id: crypto.randomUUID(),
      key,
      kind: cleanKind,
      text: cleanText,
      // Entry tokens carry both the finding text and the task it was learned
      // under: same-task recall then matches strongly while unrelated tasks
      // that merely share generic verbs fail the recall gate.
      tokens: [...new Set([...tokens, ...Array.from(tokenize(keyText)).slice(0, 20)])].slice(0, 60),
      confidence: verified ? 0.9 : 0.4,
      verified,
      source,
      hits: 0,
      createdAt: this.now(),
      updatedAt: this.now()
    };
    this.entries.push(entry);
    this.evict(key);
    this.persist();
    return entry;
  }

  evict(changedKey) {
    while (this.entries.length > this.maxTotal) {
      this.dropWeakest();
    }
    const perKey = this.entries.filter(entry => entry.key === changedKey);
    while (perKey.length > this.maxPerKey) {
      const weakest = perKey.reduce((low, entry) => (!low || entry.confidence < low.confidence ? entry : low), null);
      if (!weakest) break;
      this.entries = this.entries.filter(entry => entry.id !== weakest.id);
      perKey.splice(perKey.indexOf(weakest), 1);
    }
  }

  dropWeakest() {
    if (!this.entries.length) return;
    const weakest = this.entries.reduce((low, entry) => {
      const rank = entry.confidence * (entry.verified ? 1.3 : 1) + entry.updatedAt / 1e15;
      const lowRank = low.confidence * (low.verified ? 1.3 : 1) + low.updatedAt / 1e15;
      return rank < lowRank ? entry : low;
    }, this.entries[0]);
    this.entries = this.entries.filter(entry => entry.id !== weakest.id);
  }

  recall(query, { limit = DEFAULT_RECALL_LIMIT, chars = DEFAULT_RECALL_CHARS } = {}) {
    this.load();
    const queryTokens = tokenize(query);
    if (!queryTokens.size) return [];
    // Recall gate: tasks that merely share generic verbs ("open … windows app")
    // must not surface each other's notes — that is how a Calculator task's
    // research polluted a Paint task (measured live). Require a meaningful
    // fraction of the query tokens to overlap, never fewer than one (a
    // deliberate single-token lookup stays possible).
    const minOverlap = Math.max(1, Math.ceil(queryTokens.size * 0.4));
    const ranked = this.entries
      .map(entry => {
        let overlap = 0;
        for (const token of entry.tokens) if (queryTokens.has(token)) overlap += 1;
        if (overlap < minOverlap) return null;
        // Freshness quantized to hour buckets: millisecond differences must
        // not decide ranking order between same-strength entries (that made
        // recall ordering flap between runs).
        const ageHours = Math.floor((this.now() - entry.updatedAt) / 3600_000);
        const recency = 1 + Math.max(0, 1 - ageHours / (30 * 24)) * 0.2;
        return { entry, score: overlap * entry.confidence * (entry.verified ? 1.3 : 1) * recency };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const results = [];
    let used = 0;
    for (const { entry } of ranked) {
      if (used + entry.text.length > chars) break;
      results.push(entry);
      used += entry.text.length;
    }
    return results;
  }

  // Targeted cleanup for poisoned entries: prune({ source: 'research' }) drops
  // everything research ever wrote; prune({ key }) drops one topic. Returns
  // the number of removed entries.
  prune({ source, kind, key } = {}) {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => {
      if (source !== undefined && entry.source !== source) return true;
      if (kind !== undefined && entry.kind !== kind) return true;
      if (key !== undefined && entry.key !== key) return true;
      return false;
    });
    if (this.entries.length !== before) this.persist();
    return before - this.entries.length;
  }

  confirm(id) {
    this.load();
    const entry = this.entries.find(candidate => candidate.id === id);
    if (!entry) return false;
    entry.verified = true;
    entry.confidence = Math.min(1, entry.confidence + 0.3);
    entry.updatedAt = this.now();
    this.persist();
    return true;
  }

  forget(id) {
    this.load();
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.id !== id);
    if (this.entries.length !== before) this.persist();
    return this.entries.length !== before;
  }
}

module.exports = { KnowledgeStore, keyOf, tokenize, jaccard, KINDS };
