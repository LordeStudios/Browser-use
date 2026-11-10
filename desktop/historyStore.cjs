'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = 1;
const MAX_ENTRIES = 1000;

// Address-bar history: atomic-JSON persistence (tmp + rename, versioned
// schema) with front-deduplication — revisiting a URL moves it to the front
// with a fresh visitedAt instead of duplicating the row. Removal is
// per-entry; clearing accepts an explicit time window so the UI can offer
// last hour, custom hours (default 12) and custom days.
class HistoryStore {
  constructor({ filePath, onError = () => {}, maxEntries = MAX_ENTRIES, now = () => Date.now() }) {
    this.filePath = filePath;
    this.onError = error => onError(error);
    this.maxEntries = maxEntries;
    this.now = now;
    this.entries = [];
    this.loaded = false;
  }

  load() {
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.entries = Array.isArray(raw?.entries)
        ? raw.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.url === 'string').slice(0, this.maxEntries)
        : [];
    } catch (error) {
      if (error?.code !== 'ENOENT') this.onError(error);
      this.entries = [];
    }
    return this.list();
  }

  flush() {
    if (!this.loaded) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: SCHEMA_VERSION, entries: this.entries }, null, 1));
      fs.renameSync(tmp, this.filePath);
    } catch (error) {
      this.onError(error);
    }
  }

  list({ query = '', limit = 50 } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const matched = needle
      ? this.entries.filter(entry => entry.url.toLowerCase().includes(needle) || String(entry.title || '').toLowerCase().includes(needle))
      : this.entries;
    return matched.slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
  }

  record(url, title = '') {
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl || cleanUrl === 'about:blank') return null;
    // Front-deduplicate: the newest visit wins, older rows for the same URL
    // disappear so the dropdown never shows the same page twice.
    this.entries = this.entries.filter(entry => entry.url !== cleanUrl);
    this.entries.unshift({ id: `h-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, url: cleanUrl, title: String(title || '').slice(0, 300), visitedAt: this.now() });
    if (this.entries.length > this.maxEntries) this.entries.length = this.maxEntries;
    this.flush();
    return this.entries[0];
  }

  remove(id) {
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.id !== id);
    if (this.entries.length !== before) this.flush();
    return before - this.entries.length;
  }

  // Window is expressed backwards from now: { hours: 1 } clears the last
  // hour, { hours: 12 } the default custom window, { days: 2 } custom days.
  clearBefore({ hours = 0, days = 0 } = {}) {
    const windowMs = (Number(hours) || 0) * 3_600_000 + (Number(days) || 0) * 86_400_000;
    if (!(windowMs > 0)) return 0;
    const cutoff = this.now() - windowMs;
    const before = this.entries.length;
    this.entries = this.entries.filter(entry => entry.visitedAt < cutoff);
    const removed = before - this.entries.length;
    if (removed) this.flush();
    return removed;
  }
}

module.exports = { HistoryStore };
