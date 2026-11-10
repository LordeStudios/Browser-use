// Address-bar history store: front-deduplication, per-entry delete, and
// window-based clearing (last hour / custom hours default 12 / custom days).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HistoryStore } = require('../desktop/historyStore.cjs');

function createStore(nowMs = 1_000_000_000) {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-store-'));
  let clock = nowMs;
  const store = new HistoryStore({ filePath: path.join(dir, 'history.json'), now: () => clock, maxEntries: 5 });
  store.load();
  return { store, advance: ms => { clock += ms; } };
}

test('recording moves a repeated URL to the front instead of duplicating it', () => {
  const { store } = createStore(1_000_000_000);
  store.record('https://a.test/', 'A');
  store.record('https://b.test/', 'B');
  store.record('https://a.test/', 'A revisited');
  const entries = store.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].url, 'https://a.test/');
  assert.equal(entries[0].title, 'A revisited');
  assert.equal(store.list({ query: 'b.test' }).length, 1);
  assert.equal(store.list({ query: 'nomatch' }).length, 0);
});

test('individual entries can be deleted without touching the rest', () => {
  const { store } = createStore();
  const first = store.record('https://a.test/', 'A');
  const second = store.record('https://b.test/', 'B');
  assert.equal(store.remove(first.id), 1);
  assert.deepEqual(store.list().map(entry => entry.id), [second.id]);
  assert.equal(store.remove(first.id), 0);
});

test('clearing supports hour, custom hours, and custom days windows', () => {
  const { store, advance } = createStore();
  const old = store.record('https://old.test/', 'Old');
  advance(2 * 3_600_000); // 2 hours ago
  const mid = store.record('https://mid.test/', 'Mid');
  advance(90 * 60_000); // mid is 90 minutes old, fresh is 0
  const fresh = store.record('https://fresh.test/', 'Fresh');
  // Last hour removes only the fresh entry.
  assert.equal(store.clearBefore({ hours: 1 }), 1);
  assert.deepEqual(store.list().map(entry => entry.id).sort(), [old.id, mid.id].sort());
  // Custom window (2 hours) removes the mid entry too.
  assert.equal(store.clearBefore({ hours: 2 }), 1);
  assert.deepEqual(store.list().map(entry => entry.id), [old.id]);
  // Custom days window removes everything.
  assert.equal(store.clearBefore({ days: 1 }), 1);
  assert.deepEqual(store.list(), []);
  assert.equal(store.clearBefore({ hours: 1 }), 0, 'nothing left to clear');
});

test('entries persist across reloads and the cap trims the oldest', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'history-store-'));
  const filePath = path.join(dir, 'history.json');
  const now = 1_000_000_000;
  const writer = new HistoryStore({ filePath, now: () => now, maxEntries: 5 });
  writer.load();
  for (let index = 0; index < 8; index += 1) writer.record(`https://page-${index}.test/`, `Page ${index}`);
  const reader = new HistoryStore({ filePath, now: () => now });
  const entries = reader.load();
  assert.equal(entries.length, 5, 'maxEntries caps the stored rows');
  assert.equal(entries[0].url, 'https://page-7.test/');
  assert.equal(entries.at(-1).url, 'https://page-3.test/');
});

test('about:blank is never recorded', () => {
  const { store } = createStore();
  assert.equal(store.record('about:blank', 'Blank'), null);
  assert.deepEqual(store.list(), []);
});
