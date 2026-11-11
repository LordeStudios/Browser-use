import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ProviderTurnLedger } = require('../desktop/agent/providerTurnLedger.cjs');

test('ledger keeps ordered assistant calls and bounded results', () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 4, maxBytes: 50000 });
  const context = { task: 'Inspect fixture', messages: [{ role: 'user', content: 'Inspect fixture' }], history: [] };
  ledger.begin(context);
  const parsed = ledger.accept({ actions: [{ name: 'browser_click', input: { element: 4 } }] }, { choices: [{ message: { content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'browser_click', arguments: '{"element":4}' } }] } }] }, 'openai');
  assert.equal(parsed.actions[0].callId, 'call-1');
  ledger.begin({ ...context, history: [{ callId: 'call-1', output: { ok: true, result: { changed: true } } }] });
  const wire = ledger.wireMessages({ format: 'openai' });
  assert.deepEqual(JSON.parse(wire[0].content), { contextType: 'original_objective', task: 'Inspect fixture' });
  assert.equal(wire[2].role, 'assistant');
  assert.equal(wire[2].tool_calls[0].id, 'call-1');
  assert.equal(wire[3].role, 'tool');
  assert.equal(wire[3].tool_call_id, 'call-1');
  assert.match(wire[3].content, /changed/);
});

test('ledger uses an explicit truthful stub when a call result was not executed', () => {
  const ledger = new ProviderTurnLedger();
  const context = { task: 'Inspect', messages: [], history: [] };
  ledger.begin(context);
  ledger.accept({ actions: [{ name: 'browser_query', input: { text: 'button' }, callId: 'call-skipped' }] }, {}, 'json');
  ledger.begin({ ...context, history: [] });
  assert.match(JSON.stringify(ledger.wireMessages({ format: 'json' })), /was not executed/);
});

test('ledger truncates large results with a digest and keeps replay bounded', () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 4, maxBytes: 50000 });
  const context = { task: 'Inspect', messages: [], history: [] };
  ledger.begin(context);
  ledger.accept({ actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/fixture' }, callId: 'call-large' }] }, {}, 'json');
  ledger.begin({ ...context, history: [{ callId: 'call-large', output: { ok: true, content: 'x'.repeat(100000) } }] });
  const wire = JSON.stringify(ledger.wireMessages({ format: 'json' }));
  assert.ok(wire.length < 50000);
  assert.match(wire, /sha256/);
  assert.match(wire, /truncated/);
});

test('a failed or truncated summary never stops the run; turns are retained and bounded', async () => {
  const metrics = {};
  // The slim transcript no longer self-saturates, so force drives the
  // compaction paths this test owns; the budget is real (30k) so a
  // successful summary can actually land in phase two.
  const ledger = new ProviderTurnLedger({ maxTurns: 3, contextTokens: 30_000, maxBytes: 50000 });
  const context = { task: 'Objective survives failure', messages: [], observation: { dom: { elements: [] } }, plan: [], goals: [], recovery: null };
  // Result content is the wire-pressure vector (requests no longer replay):
  // each result carries a few KB so the slim transcript crosses the threshold.
  const bulky = (i) => [{ callId: 'c' + i, output: { ok: true, result: { index: i, payload: 'r'.repeat(3_000) } } }];
  ledger.begin(context);
  for (let i = 0; i < 5; i++) {
    ledger.accept({ actions: [{ name: 'browser_click', input: { element: i }, callId: 'c' + i }] }, { choices: [{ message: { content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'browser_click', arguments: JSON.stringify({ element: i }) } }] } }] }, 'openai');
    ledger.begin({ ...context, history: bulky(i) });
  }
  // Simulated provider truncation: the summary side-query throws.
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true, metrics, summarize: async () => { throw new Error('Compaction output was truncated.'); } });
  assert.equal(ledger.turns.length, 3, 'oldest groups trimmed to maxTurns, recent groups kept');
  assert.equal(metrics.compactionFailures, 1);
  assert.match(metrics.compactionFailureReason, /truncated/);
  // The wire still carries complete call/result groups and the original task.
  const wire = JSON.stringify(ledger.wireMessages({ format: 'openai' }));
  assert.match(wire, /Objective survives failure/);
  assert.match(wire, /tool_call_id/);
  // A later successful compaction still works after a failure: exceed maxTurns
  // again so the pre-check does not skip compacting.
  for (let i = 5; i < 8; i++) {
    ledger.accept({ actions: [{ name: 'browser_click', input: { element: i }, callId: 'c' + i }] }, { choices: [{ message: { content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'browser_click', arguments: JSON.stringify({ element: i }) } }] } }] }, 'openai');
    ledger.begin({ ...context, history: [{ callId: 'c' + i, output: { ok: true, result: { index: i } } }] });
  }
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true, metrics, summarize: async () => ({ facts: ['recovered'], completed: [], openQuestions: [], constraints: [], nextActions: [] }) });
  assert.equal(ledger.summary.facts[0], 'recovered');
});

test('ledger compacts whole turn groups only after validating a structured snapshot', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 30_000, maxBytes: 50000 });
  const context = { task: 'Keep the fixture objective', messages: [], observation: { dom: { elements: [] } }, plan: [], goals: [], recovery: null };
  const bulky = (i) => [{ callId: 'c' + i, output: { ok: true, result: { changed: true, index: i, payload: 'r'.repeat(3_000) } } }];
  ledger.begin(context);
  for (let i = 0; i < 6; i++) {
    ledger.accept({ actions: [{ name: 'browser_click', input: { element: i }, callId: 'c' + i }] }, { choices: [{ message: { content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'browser_click', arguments: JSON.stringify({ element: i }) } }] } }] }, 'openai');
    ledger.begin({ ...context, history: bulky(i) });
  }
  const before = ledger.turns.length;
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true, summarize: async () => ({ facts: ['fixture remains active'], completed: ['clicked known controls'], openQuestions: [], constraints: ['preserve user work'], nextActions: ['verify final state'] }) });
  assert.ok(ledger.turns.length < before);
  assert.equal(ledger.summary.facts[0], 'fixture remains active');
  assert.equal(ledger.originalTask, 'Keep the fixture objective');
});

// ---- Poisoned-conversation repairs (2026-10-01) -----------------------------

test('the stored first-turn request never embeds the run-history blob', () => {
  const ledger = new ProviderTurnLedger();
  const history = [{ callId: 'c1', output: { ok: true, result: { content: 'x'.repeat(200_000) } } }];
  const live = ledger.begin({ task: 'Fix favourites', messages: [{ role: 'user', content: 'Fix favourites' }], history });
  // The LIVE request still carries the full history for this decision.
  assert.equal(Array.isArray(live.history), true);
  ledger.accept({ actions: [{ name: 'browser_click', input: { element: 0 } }] }, {}, 'json');
  const stored = ledger.pending.request;
  assert.equal(stored.history, undefined, 'the replayed request blob must not carry the history bomb');
  assert.equal(stored.historyOmitted, true);
  assert.equal(stored.historyEntries, history.length);
  ledger.begin({ task: 'Fix favourites', messages: [], history: [] });
  // Snapshots (checkpoints) therefore stay small across restarts.
  assert.ok(JSON.stringify(ledger.snapshot()).length < 10_000);
});

test('a restored legacy snapshot with an embedded history blob heals at load time', () => {
  const poisoned = {
    version: 1, originalTask: 'Fix favourites', summary: null, seenMessages: [], compactions: 0,
    turns: [{ id: 't1', request: { contextType: 'current_state', history: [{ callId: 'c', output: { blob: 'y'.repeat(300_000) } }] },
      text: '', metadata: {}, calls: [{ id: 'c1', name: 'browser_click', input: {} }], results: [{ id: 'c1', content: '{"ok":true}' }] }]
  };
  const ledger = new ProviderTurnLedger({ snapshot: poisoned });
  const wire = JSON.stringify(ledger.wireMessages({ format: 'json' }));
  assert.ok(wire.length < 10_000, `the wire must not replay the poison (got ${wire.length} bytes)`);
  // Contract change: prior turns no longer replay their request snapshots at
  // all, so the poison is not just healed — it never reaches the wire.
  assert.doesNotMatch(wire, /current_state/);
  assert.doesNotMatch(wire, /blob/);
});

test('failOpen evicts oldest turns by SIZE, so a poisoned ledger self-heals on the next turn', async () => {
  const metrics = {};
  // Small byte floor + summarizer that always fails (e.g. a size-gated
  // gateway rejecting the summary request): compaction cannot succeed, so
  // failOpen must bound the wire by eviction, not just by turn count.
  // Result content is the pressure vector — requests no longer replay.
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 8_000 });
  const context = { task: 'Recover by eviction', messages: [], plan: [], goals: [], recovery: null };
  ledger.begin(context);
  for (let i = 0; i < 6; i++) {
    ledger.accept({ actions: [{ name: 'computer_read', input: { path: `f${i}.js` }, callId: 'c' + i }] }, {}, 'json');
    ledger.begin({ ...context, history: [{ callId: 'c' + i, output: { ok: true, result: { content: 'z'.repeat(2_000) } } }] });
  }
  assert.equal(ledger.turns.length, 6);
  // force drives the failOpen path past the fill threshold (the slim
  // transcript no longer self-saturates).
  await ledger.compact({ current: context, system: 'short', tools: [], outputTokens: 100, force: true, metrics, summarize: async () => { throw new Error('Compaction request failed (403).'); } });
  const wireBytes = JSON.stringify(ledger.wireMessages({ format: 'json' })).length;
  assert.ok(wireBytes <= 8_000, `the wire must fit the byte floor after eviction (got ${wireBytes})`);
  assert.ok(ledger.turns.length < 6, 'the oldest poisoned turns must have been evicted');
  assert.ok((metrics.uncompactedTurnsDropped || 0) > 0);
  // The objective and the newest turn survive every eviction.
  assert.match(JSON.stringify(ledger.wireMessages({ format: 'json' })), /Recover by eviction/);
});

test('compaction summary input is field-bounded, so one giant group cannot break every future compaction', async () => {
  let summaryInput = null;
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 100_000, maxBytes: 10_000_000 });
  const context = { task: 'Bound summary input', messages: [], plan: [], goals: [], recovery: null };
  ledger.begin(context);
  ledger.accept({ actions: [{ name: 'computer_read', input: { path: 'big.js' } }] }, {}, 'json');
  // Result content is the pressure vector (requests no longer replay).
  ledger.begin({ ...context, history: [{ callId: 'big', output: { ok: true, result: { content: 'q'.repeat(500_000) } } }] });
  ledger.accept({ actions: [{ name: 'browser_click', input: { element: 1 } }] }, {}, 'json');
  ledger.begin({ ...context, history: [] });
  const ok = await ledger.compact({
    current: context, system: 'short', tools: [], outputTokens: 100, force: true,
    summarize: async (prompt, input) => { summaryInput = input; return { facts: ['kept'], completed: [], openQuestions: [], constraints: [], nextActions: [] }; }
  });
  assert.notEqual(summaryInput, null, 'the summary request must actually run instead of failing on an oversized group');
  assert.ok(JSON.stringify(summaryInput).length < 200_000, 'the summary input must be bounded');
  assert.equal(ledger.turns.length, 1, 'older turns compacted away after a successful summary');
});

// ---- Compaction hysteresis: no per-decision summarizer cost (2026-10-02) ----

test('a saturated ledger summarizes once per cooldown window and stays bounded by eviction between', async () => {
  let summarizeCalls = 0;
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 30_000, maxBytes: 10_000_000 });
  const context = { task: 'Marathon conversation', messages: [], plan: [], goals: [], recovery: null };
  ledger.begin(context);
  const call = { choices: [{ message: { content: null, tool_calls: [] } }] };
  for (let round = 0; round < 10; round++) {
    ledger.accept({ actions: [{ name: 'computer_read', input: { path: `f${round}.js` }, callId: 'c' + round }] }, call, 'json');
    ledger.turns.at(-1) === undefined; // pending settles on next begin
    ledger.begin({ ...context, history: [{ callId: 'c' + round, output: { ok: true } }] });
    ledger.turns.at(-1).request = { contextType: 'current_state', payload: 'w'.repeat(9_000) };
    await ledger.compact({
      current: context, system: 'short', tools: [], outputTokens: 100,
      summarize: async () => { summarizeCalls += 1; return { facts: ['snap' + summarizeCalls], completed: [], openQuestions: [], constraints: [], nextActions: [] }; }
    });
  }
  // 10 saturated decisions: at most 3 summarizer calls (cooldown 4), never 10.
  assert.ok(summarizeCalls <= 3, `summarizer must be throttled by the cooldown (got ${summarizeCalls})`);
  // The wire stays bounded despite the skipped summaries.
  const wireBytes = JSON.stringify(ledger.wireMessages({ format: 'json' })).length;
  assert.ok(wireBytes < 10_000_000);
  // The newest summary and the objective still lead the wire.
  assert.match(JSON.stringify(ledger.wireMessages({ format: 'json' })), /Marathon conversation/);
});

// ---- Tool schemas are request-scoped, never replayed per stored turn --------
// Field run (2026-10-28): 62 tools = ~46KB of schema was stored inside EVERY
// retained turn, so a saturated run was over the compaction threshold on every
// decision (1,050 summarizer requests for 1,440 model requests).

const catalog = Array.from({ length: 62 }, (_, i) => ({ name: `tool_${i}`, description: 'd'.repeat(300), inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'x'.repeat(400) } } } }));

test('stored turns never replay the tool catalog, but the live decision request still carries it', () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, maxBytes: 10_000_000 });
  const context = { task: 'Schemas are request-scoped', messages: [], plan: [], goals: [], recovery: null, tools: catalog };
  const live = ledger.begin(context);
  assert.equal(live.tools.length, catalog.length, 'the current decision still receives the full catalog');
  for (let i = 0; i < 5; i++) {
    ledger.accept({ actions: [{ name: 'computer_read', input: { path: `f${i}.js` }, callId: `c${i}` }] }, {}, 'json');
    ledger.begin({ ...context, history: [{ callId: `c${i}`, output: { ok: true } }] });
  }
  assert.equal(ledger.turns.length, 5);
  assert.ok(ledger.turns.every(turn => turn.request.tools === undefined), 'no stored turn carries tool schemas');
  assert.ok(ledger.turns.every(turn => turn.request.toolsOmitted === catalog.length), 'the count survives as a diagnostic');
  const wire = JSON.stringify(ledger.wireMessages({ format: 'json' }));
  assert.ok(!wire.includes('tool_61'), 'the replayed wire contains no schema text');
  assert.ok(wire.length < 20_000, `the replayed wire stays small (got ${wire.length})`);
});

test('a checkpoint written before the fix heals at load, so it cannot re-trigger per-decision compaction', () => {
  const legacy = {
    version: 1, originalTask: 'Legacy checkpoint', summary: null, seenMessages: [], compactions: 0,
    turns: Array.from({ length: 3 }, (_, i) => ({
      id: `t${i}`, request: { contextType: 'current_state', tools: catalog }, text: '', metadata: {},
      calls: [{ id: `c${i}`, name: 'computer_read', input: {} }], results: [{ id: `c${i}`, content: '{"ok":true}' }]
    }))
  };
  const ledger = new ProviderTurnLedger({ snapshot: legacy });
  assert.ok(ledger.turns.every(turn => turn.request.tools === undefined));
  assert.ok(JSON.stringify(ledger.wireMessages({ format: 'json' })).length < 20_000);
});

test('a run whose catalog is large no longer compacts on every decision', async () => {
  let summarizeCalls = 0;
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 60_000, maxBytes: 10_000_000 });
  const context = { task: 'Large catalog run', messages: [], plan: [], goals: [], recovery: null, tools: catalog };
  ledger.begin(context);
  for (let round = 0; round < 12; round++) {
    ledger.accept({ actions: [{ name: 'computer_read', input: { path: `f${round}.js` }, callId: `c${round}` }] }, {}, 'json');
    ledger.begin({ ...context, history: [{ callId: `c${round}`, output: { ok: true } }] });
    await ledger.compact({
      current: context, system: 'short', tools: catalog, outputTokens: 100,
      summarize: async () => { summarizeCalls += 1; return { facts: ['snap'], completed: [], openQuestions: [], constraints: [], nextActions: [] }; }
    });
  }
  assert.equal(summarizeCalls, 0, `a small conversation under a large catalog must not summarize at all (got ${summarizeCalls})`);
});

// ---- forceCompact (chat_compact tool + /compact command) ---------------------

test('force compacts below the fill threshold on demand and returns stats', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 24, contextTokens: 50_000, maxBytes: 10_000_000 });
  const context = { task: 'On-demand compaction', messages: [], plan: [], goals: [], recovery: null };
  ledger.begin(context);
  for (let i = 0; i < 6; i++) {
    ledger.accept({ actions: [{ name: 'computer_read', input: { path: `f${i}.js` }, callId: 'c' + i }] }, {}, 'json');
    ledger.begin({ ...context, history: [{ callId: 'c' + i, output: { ok: true } }] });
    ledger.turns.at(-1).request = { contextType: 'current_state', payload: 'k'.repeat(2_000) };
  }
  const before = ledger.turns.length;
  let summarizeCalls = 0;
  const stats = await ledger.compact({
    current: context, system: 'compact', tools: [], outputTokens: 2_048, force: true,
    summarize: async () => { summarizeCalls += 1; return { facts: ['forced'], completed: [], openQuestions: [], constraints: [], nextActions: [] }; }
  });
  assert.equal(summarizeCalls, 1, 'force compaction summarizes even when under the fill threshold');
  assert.equal(stats.compacted, true);
  assert.ok(stats.turnsAfter < stats.turnsBefore, `older turns must be summarized away (${stats.turnsBefore} -> ${stats.turnsAfter})`);
  assert.match(JSON.stringify(ledger.wireMessages({ format: 'json' })), /On-demand compaction/, 'the objective survives a forced compaction');
  // Unforced compact below the threshold is a no-op report.
  const idle = await ledger.compact({ current: context, system: 'compact', tools: [], outputTokens: 2_048, summarize: async () => { throw new Error('must not run'); } });
  assert.equal(idle.compacted, false);
});
