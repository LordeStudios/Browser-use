// Compaction must not destroy the evidence the agent already gathered.
//
// Before the fix: the file-read/search record lived only inside the
// conversation turns that compaction EVICTED. The summary carried only what
// the summarizer chose to write down, so after a compaction the agent no
// longer knew which files it had read and re-read them (one run logged 32
// "Unchanged since your earlier read" notices).
//
// The contract proved here:
//   1. the compaction summary INPUT carries the evidence array, and the
//      summary that comes back still carries it (even from a lossy
//      summarizer that drops it);
//   2. a restored ledger exposes that evidence to the model on the wire.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProviderTurnLedger, SUMMARY_PROMPT, EVIDENCE_RULE, EVIDENCE_LIMIT } = require('../desktop/agent/providerTurnLedger.cjs');

const context = { task: 'Read the fixtures and report', messages: [], plan: [], goals: [], recovery: null };

// One turn that reads a file (or searches), exactly as the harness records
// it: a computer_read result carries path, line range and content hash.
function readTurn(ledger, path, { from = 1, to = 40, marker = '' } = {}) {
  ledger.begin(context);
  const parsed = ledger.accept({ actions: [{ name: 'computer_read', input: { path } }] }, {}, 'json');
  const callId = parsed.actions[0].callId;
  ledger.begin({ ...context, history: [{ callId, output: { ok: true, tool: 'computer_read', path,
    fromLine: from, toLine: to, totalLines: to, lines: to - from + 1,
    content: `${marker}\n${'x'.repeat(200)}` } }] });
  return callId;
}

function searchTurn(ledger, pattern, matches) {
  ledger.begin(context);
  const parsed = ledger.accept({ actions: [{ name: 'computer_search', input: { path: 'C:/repo', pattern } }] }, {}, 'json');
  const callId = parsed.actions[0].callId;
  ledger.begin({ ...context, history: [{ callId, output: { ok: true, tool: 'computer_search', root: 'C:/repo', pattern, outputMode: 'content', matches } }] });
  return callId;
}

test('the compaction summary input carries the file-read and search evidence', async () => {
  let summaryInput = null;
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 10_000_000 });
  readTurn(ledger, 'C:/repo/alpha.js', { from: 1, to: 40, marker: 'ALPHA_MARKER' });
  readTurn(ledger, 'C:/repo/beta.js', { from: 10, to: 55, marker: 'BETA_MARKER' });
  searchTurn(ledger, 'parseConfig', 7);
  readTurn(ledger, 'C:/repo/gamma.js', { from: 1, to: 20, marker: 'GAMMA_MARKER' });
  readTurn(ledger, 'C:/repo/delta.js', { from: 3, to: 9, marker: 'DELTA_MARKER' });

  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true,
    summarize: async (prompt, input) => { summaryInput = input; return { facts: ['read four files'], completed: [], openQuestions: [], constraints: [], nextActions: [] }; } });

  assert.ok(summaryInput, 'the summarizer must actually run');
  assert.ok(Array.isArray(summaryInput.evidence), 'the summary input carries an evidence array');
  const paths = summaryInput.evidence.filter(entry => entry.tool === 'computer_read').map(entry => entry.path);
  assert.deepEqual(paths.sort(), ['C:/repo/alpha.js', 'C:/repo/beta.js', 'C:/repo/delta.js', 'C:/repo/gamma.js']);
  // A read entry names the tool, the path and the exact line range that was
  // read — the agent must be able to tell which part of a file it holds.
  const alpha = summaryInput.evidence.find(entry => entry.path === 'C:/repo/alpha.js');
  assert.equal(alpha.tool, 'computer_read');
  assert.equal(alpha.from, 1);
  assert.equal(alpha.to, 40);
  // A search entry names the pattern and the match count.
  const search = summaryInput.evidence.find(entry => entry.tool === 'computer_search');
  assert.equal(search.pattern, 'parseConfig');
  assert.equal(search.matches, 7);
});

test('the summary written by a compaction still carries the evidence, even from a lossy summarizer', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 10_000_000 });
  readTurn(ledger, 'C:/repo/alpha.js', { marker: 'ALPHA_MARKER' });
  readTurn(ledger, 'C:/repo/beta.js', { marker: 'BETA_MARKER' });
  searchTurn(ledger, 'parseConfig', 7);
  readTurn(ledger, 'C:/repo/gamma.js', { marker: 'GAMMA_MARKER' });
  readTurn(ledger, 'C:/repo/delta.js', { marker: 'DELTA_MARKER' });

  // A summarizer that DROPS the evidence array — exactly the failure that
  // made the agent re-read files it already had.
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true,
    summarize: async () => ({ facts: ['read four files'], completed: [], openQuestions: [], constraints: [], nextActions: [] }) });

  assert.ok(Array.isArray(ledger.summary.evidence), 'the summary carries an evidence array');
  const paths = ledger.summary.evidence.filter(entry => entry.tool === 'computer_read').map(entry => entry.path);
  for (const path of ['C:/repo/alpha.js', 'C:/repo/beta.js', 'C:/repo/delta.js', 'C:/repo/gamma.js']) {
    assert.ok(paths.includes(path), `the summary must still list ${path} (got ${JSON.stringify(paths)})`);
  }
  assert.ok(ledger.summary.evidence.some(entry => entry.tool === 'computer_search' && entry.pattern === 'parseConfig'));
  // The compacted turns are gone from the wire, so the evidence list is the
  // only surviving trace that those files were read.
  const wire = JSON.stringify(ledger.wireMessages({ format: 'json' }));
  assert.ok(!wire.includes('ALPHA_MARKER'), 'the first file content was compacted away');
  assert.ok(wire.includes('C:/repo/alpha.js'), 'but the evidence list still names the file');
});

test('the summarizer prompt demands the evidence array verbatim', () => {
  assert.match(SUMMARY_PROMPT, /evidence/i);
  assert.match(SUMMARY_PROMPT, /VERBATIM/i);
  assert.match(SUMMARY_PROMPT, /do not .*omit/i);
});

test('a restored ledger exposes the evidence to the model', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 10_000_000 });
  readTurn(ledger, 'C:/repo/alpha.js', { marker: 'ALPHA_MARKER' });
  readTurn(ledger, 'C:/repo/beta.js', { marker: 'BETA_MARKER' });
  searchTurn(ledger, 'parseConfig', 7);
  readTurn(ledger, 'C:/repo/gamma.js', { marker: 'GAMMA_MARKER' });
  readTurn(ledger, 'C:/repo/delta.js', { marker: 'DELTA_MARKER' });
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true,
    summarize: async () => ({ facts: ['read four files'], completed: [], openQuestions: [], constraints: [], nextActions: [] }) });

  const restored = new ProviderTurnLedger({ snapshot: ledger.snapshot() });
  const head = JSON.parse(restored.wireMessages({ format: 'json' })[0].content);
  assert.ok(Array.isArray(head.evidence), 'the restored wire exposes the evidence to the model');
  const paths = head.evidence.filter(entry => entry.tool === 'computer_read').map(entry => entry.path);
  assert.ok(paths.includes('C:/repo/alpha.js'), 'a file read before the compaction is still known after the restore');
  assert.ok(head.evidence.some(entry => entry.tool === 'computer_search' && entry.pattern === 'parseConfig' && entry.matches === 7));
  // The model is told what the list means, so it quotes the held evidence
  // instead of re-reading the file.
  assert.equal(head.evidencePolicy, EVIDENCE_RULE);
  assert.match(head.evidencePolicy, /Do NOT re-read/i);
});

test('the evidence list is capped at 24 entries, dropping the oldest first', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 40, contextTokens: 100_000, maxBytes: 10_000_000 });
  for (let i = 0; i < 30; i++) readTurn(ledger, `C:/repo/file-${String(i).padStart(2, '0')}.js`);
  const evidence = ledger.evidence;
  assert.equal(evidence.length, EVIDENCE_LIMIT, 'the evidence list is capped');
  assert.equal(evidence.at(-1).path, 'C:/repo/file-29.js', 'the newest read survives');
  assert.ok(!evidence.some(entry => entry.path === 'C:/repo/file-00.js'), 'the oldest read is dropped first');
});

test('a re-read of the same range keeps one entry with the freshest hash', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 10_000_000 });
  readTurn(ledger, 'C:/repo/alpha.js', { from: 1, to: 40 });
  ledger.begin(context);
  const parsed = ledger.accept({ actions: [{ name: 'computer_read', input: { path: 'C:/repo/alpha.js' } }] }, {}, 'json');
  ledger.begin({ ...context, history: [{ callId: parsed.actions[0].callId, output: { ok: true, tool: 'computer_read',
    path: 'C:/repo/alpha.js', fromLine: 1, toLine: 40, hash: 'newhash', content: 'x' } }] });
  const entries = ledger.evidence.filter(entry => entry.path === 'C:/repo/alpha.js');
  assert.equal(entries.length, 1, 'one entry per file range');
  assert.equal(entries[0].hash, 'newhash', 'the freshest observation wins');
});
