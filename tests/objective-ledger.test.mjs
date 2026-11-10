import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ProviderTurnLedger, renderTaskLadder, clockPrefix, TASK_LADDER_RULE } = require('../desktop/agent/providerTurnLedger.cjs');
const {
  advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective,
  settleObjectiveLedgerOnTerminal, activeObjectiveEntry
} = require('../desktop/agent/desktopChatAgent.cjs');
const { ChatHistoryStore } = require('../desktop/store/chatHistoryStore.cjs');

// ── (a) task → Q&A → task: EVERY differing turn is a boundary ───────────────

const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 81, tag: 'button', name: 'Unique current control' }] } };
function harness(complete) {
  let calls = 0;
  const controller = { navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute: async () => ({ content: 'same evidence' }), releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent };
}

test('task → Q&A → task marks every boundary and keeps the pinned objective on the newest message', async () => {
  const T1 = 'restart the bridge service';
  const T2 = 'what color is the sky';
  const T3 = 'explain the plan for full cross-device access';
  const contexts = [];
  const { agent } = harness((ctx) => {
    // Capture the wire EXACTLY as the model saw it at decision time.
    contexts.push({ task: ctx.task, wire: ctx.turnLedger.wireMessages().map(m => String(m.content)) });
    const n = contexts.length;
    if (n === 1) return { done: { summary: 'Bridge service restarted and handshake confirmed.', success: true, verified: true } };
    if (n === 2) return { done: { summary: 'The sky appears blue today.', success: true, verified: false } };
    return { done: { summary: 'Cross-device plan drafted around one socket relay.', success: true, verified: true } };
  });
  const settings = { controlMode: 'agi', vision: 'off' };
  const run1 = await agent.start({ task: T1, settings });
  const run2 = await agent.start({ task: T2, settings, continuation: true, conversation: run1 });
  const run3 = await agent.start({ task: T3, settings, continuation: true, conversation: run2 });

  // The Q&A turn is a boundary too (old code required previous?.task AND left
  // restored-from-store snapshots without one, starving both boundaries).
  assert.equal(run2.newTurn, true, 'the turn after a completed task is a boundary');
  assert.equal(run3.newTurn, true, 'the turn after a pure Q&A turn is still a boundary');

  // The pinned objective EXTENDS on both turns now (owner directive
  // 2026-10-15: cue-less follow-ups are additions — the pin carries the
  // earlier task text plus each ADDITION, never a silent swap).
  const pin2 = JSON.parse(contexts[1].wire[0]).task;
  assert.match(pin2, /restart the bridge service/);
  assert.match(pin2, /ADDITION: what color is the sky/);
  const pin3 = JSON.parse(contexts[2].wire[0]).task;
  assert.match(pin3, /restart the bridge service/);
  assert.match(pin3, /ADDITION: explain the plan for full cross-device access/);

  // Turn notices are present on both new turns — as ADDITIONS (no explicit
  // replace cue in either follow-up).
  assert.ok(run2.messages.some(m => m.source === 'runtime' && m.content.includes('USER ADDITION')), 'addition notice after task turn');
  assert.ok(run3.messages.some(m => m.source === 'runtime' && m.content.includes('USER ADDITION')), 'addition notice after Q&A turn');

  // The task ladder rides EVERY decision wire: turn 3 sees the first task
  // DONE (verified), the answered-but-unverified Q&A turn closed ABANDONED at
  // its own terminal (an unverified task is not done work — the pre-existing
  // convention, now applied at the terminal instead of the next boundary),
  // and ONLY the newest task ACTIVE.
  const ladder3 = JSON.parse(contexts[2].wire[0]).taskLadder || '';
  assert.match(ladder3, new RegExp(`DONE "${T1}" \\(verified\\)`));
  assert.match(ladder3, /ABANDONED/);
  assert.match(ladder3, new RegExp(`ACTIVE "${T3}"`));
  assert.doesNotMatch(ladder3, new RegExp(`ACTIVE "${T2}"`));
  assert.match(ladder3, /The ACTIVE task is your only objective/);

  // Verified completion closed the newest entry with its summary.
  const doneEntry = run3.objectiveLedger.find(entry => entry.task === T3);
  assert.equal(doneEntry.status, 'done');
  assert.equal(doneEntry.verified, true);
  assert.match(doneEntry.outcomeSummary, /socket relay/);

  // A stale snapshot WITHOUT a task (legacy checkpoint blob) still classifies
  // the turn as a boundary, so the objective pointer can never go stale again
  // — the notice fires (as an ADDITION: the follow-up carries no replace cue).
  const legacy = { ...run2, task: undefined, messages: run2.messages };
  const run4 = await agent.start({ task: 'one more follow-up question', settings, continuation: true, conversation: legacy });
  assert.equal(run4.newTurn, true);
  assert.ok(run4.messages.some(m => m.source === 'runtime' && m.content.includes('USER ADDITION')));
});

// ── (b) ledger statuses: done / abandoned / retired ─────────────────────────

test('ledger closes the previous active entry done-if-verified else abandoned', () => {
  const first = advanceObjectiveLedger(null, 'task A', { at: 1_000 });
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'active');
  assert.equal(first[0].index, 1);

  const second = advanceObjectiveLedger(first, 'task B', { boundary: true, previousResult: { verified: true }, at: 2_000 });
  assert.equal(second[0].status, 'done');
  assert.equal(second[0].verified, true);
  assert.equal(second[0].closedAtClock, 2_000);
  assert.equal(activeObjectiveEntry(second).task, 'task B');

  const third = advanceObjectiveLedger(second, 'task C', { boundary: true, previousResult: { verified: false }, at: 3_000 });
  assert.equal(third[0].status, 'done');
  assert.equal(third[1].status, 'abandoned');
  assert.equal(activeObjectiveEntry(third).task, 'task C');
  assert.equal(third[2].index, 3);
});

test('a verified done closes its entry with the summary; a user cancellation abandons it', () => {
  const ledger = advanceObjectiveLedger(null, 'task A', { at: 1_000 });
  const doneRun = { status: 'completed', completedAt: 5_000, result: { verified: true, summary: 'Everything verified end to end.' }, objectiveLedger: ledger };
  settleObjectiveLedgerOnTerminal(doneRun);
  assert.equal(ledger[0].status, 'done');
  assert.equal(ledger[0].verified, true);
  assert.equal(ledger[0].outcomeSummary, 'Everything verified end to end.');

  const cancelLedger = advanceObjectiveLedger(null, 'task B', { at: 2_000 });
  const cancelRun = { status: 'cancelled', objectiveLedger: cancelLedger };
  settleObjectiveLedgerOnTerminal(cancelRun);
  assert.equal(cancelLedger[0].status, 'abandoned');
  assert.equal(cancelLedger[0].verified, false);
});

test('a pure Q&A turn retires its no-work entry so the ladder keeps tasks only', () => {
  const ledger = advanceObjectiveLedger(null, 'task A', { at: 1_000 });
  const withQuestion = advanceObjectiveLedger(ledger, 'what color is the sky', { boundary: true, previousResult: { verified: false }, at: 2_000 });
  assert.equal(withQuestion.length, 2);
  const retired = retireAnswerOnlyObjective(withQuestion);
  assert.equal(retired.length, 1);
  assert.equal(retired[0].task, 'task A');
  // An entry that DID work (carries an outcome summary) is never retired.
  withQuestion[1].outcomeSummary = 'real work happened';
  assert.equal(retireAnswerOnlyObjective(withQuestion).length, 2);
  closeActiveObjective(withQuestion, { status: 'done', verified: true, at: 3_000 });
  assert.equal(withQuestion[1].status, 'done');
});

test('the rendered task ladder lists entries newest last with the rule line', () => {
  assert.equal(renderTaskLadder([]), '');
  const ladder = renderTaskLadder([
    { index: 2, task: 'restart bridge', status: 'done', verified: true, startedAtClock: 1_000 },
    { index: 3, task: 'cross-device plan', status: 'active', startedAtClock: 2_000 }
  ]);
  assert.match(ladder, /^TASK LADDER: #2 .* DONE "restart bridge" \(verified\) · #3 .* ACTIVE "cross-device plan"\nThe ACTIVE task/);
  assert.ok(ladder.includes(TASK_LADDER_RULE));
  // Bounded to the newest entries and normalized against junk.
  const bounded = renderTaskLadder(Array.from({ length: 30 }, (_, i) => ({ index: i + 1, task: `task ${i}`, status: 'abandoned', startedAtClock: i })));
  assert.match(bounded, /#30/);
  assert.doesNotMatch(bounded, /#17 /);
});

// ── (c) timestamps rendered into the model-visible conversation ─────────────

test('every conversation message the model sees carries its clock-time prefix', () => {
  const at = new Date(); at.setHours(6, 28, 0, 0);
  const ledger = new ProviderTurnLedger({});
  const request = ledger.begin({ task: 't', messages: [
    { role: 'user', content: 'hello', at: at.getTime() },
    { role: 'assistant', content: 'hi there', at: at.getTime() + 60_000 }
  ] });
  assert.equal(request.messages[0].content, '[06:28] hello');
  assert.equal(request.messages[1].content, '[06:29] hi there');

  // The prefix persists into the replayed prior-turn wire context, not just
  // the current request.
  ledger.accept({ assistantText: 'ok', actions: [] }, { choices: [{ message: { content: '{}' } }] }, 'openai');
  ledger.settle([]);
  const prior = JSON.stringify(ledger.wireMessages());
  assert.match(prior, /\[06:28\] hello/);
  assert.match(prior, /\[06:29\] hi there/);
});

test('clock prefixes are deterministic per timestamp (re-staged messages stay identical)', () => {
  const at = new Date(); at.setHours(23, 5, 0, 0);
  assert.equal(clockPrefix(at.getTime()), clockPrefix(at.getTime()));
  assert.match(clockPrefix(at.getTime()), /^\[23:05\] $/);
  assert.equal(clockPrefix(undefined), '');
  assert.equal(clockPrefix(0), '');
});

test('the real provider request body carries clock-prefixed messages and the task ladder', async () => {
  const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
  const { createCoordinatorState } = require('../desktop/agent/desktopAgentCoordinator.cjs');
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({ providerId: 'xkiro', model: 'fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: JSON.stringify({ done: { summary: 'Fixture finished.', success: true, verified: true } }) } }] }); } });
  const at = new Date(); at.setHours(6, 28, 0, 0);
  const messages = [{ role: 'user', content: 'restart the bridge service', at: at.getTime() }];
  const ledger = new ProviderTurnLedger({});
  ledger.setObjectiveLedger([{ index: 1, task: 'restart the bridge service', status: 'active', startedAtClock: at.getTime() }]);
  const args = { task: 'restart the bridge service', observation, tools: [], coordinator: createCoordinatorState(), messages, history: [], turnLedger: ledger };
  await provider.complete(args);
  const body = JSON.stringify(bodies[0]);
  assert.match(body, /\[06:28\] restart the bridge service/, 'the user message reaches the wire with its clock time');
  const pinned = JSON.parse(bodies[0].messages.find(m => m.role === 'user' && String(m.content).includes('taskLadder')).content);
  assert.match(pinned.taskLadder, /TASK LADDER: #1 \d{2}:\d{2} ACTIVE "restart the bridge service"/, 'the ladder reaches the wire every decision');
  assert.ok(pinned.taskLadder.includes(TASK_LADDER_RULE));
});

// ── (d) chat history survives restarts and corrupted blobs ──────────────────

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-ledger-store-'));
  return { dir, filePath: path.join(dir, 'chat-history.json') };
}

test('history store keeps task text and the objective ledger across a simulated restart', async () => {
  const { dir, filePath } = tempStore();
  try {
    const store = new ChatHistoryStore({ filePath });
    store.checkpoint({
      id: 'run-1', title: 'Bridge session', task: 'restart the bridge service', turnStartedAt: 123,
      status: 'completed', attemptSequence: 3, eventRevision: 7,
      messages: [{ role: 'user', content: 'restart the bridge service', at: 1 }],
      objectiveLedger: [
        { index: 1, task: 'restart the bridge service', status: 'done', verified: true, startedAtClock: 1_000, closedAtClock: 2_000, outcomeSummary: 'verified' },
        { index: 2, task: 'cross-device plan', status: 'active', startedAtClock: 3_000 }
      ]
    });
    await store.flush();
    const restarted = new ChatHistoryStore({ filePath });
    const record = restarted.get('run-1');
    assert.equal(record.task, 'restart the bridge service', 'task text must survive checkpoints');
    assert.equal(record.turnStartedAt, 123);
    assert.equal(record.objectiveLedger.length, 2);
    assert.equal(record.objectiveLedger[0].status, 'done');
    assert.equal(record.objectiveLedger[1].status, 'active');
    assert.equal(record.objectiveLedger[1].task, 'cross-device plan');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt history blob is quarantined, recovered from .bak, and writing resumes', async () => {
  const { dir, filePath } = tempStore();
  try {
    const first = new ChatHistoryStore({ filePath });
    first.checkpoint({ id: 'run-1', task: 'first conversation', status: 'completed', attemptSequence: 1, eventRevision: 1,
      messages: [{ role: 'user', content: 'first conversation', at: 1 }] });
    await first.flush();
    assert.ok(fs.existsSync(`${filePath}.bak`), 'every successful write maintains a backup');

    fs.writeFileSync(filePath, '{"schemaVersion":5,"conversations":[{"id":"trunc", "mess', 'utf8');
    const errors = [];
    const recovered = new ChatHistoryStore({ filePath, onError: error => errors.push(error) });
    const records = recovered.load();
    assert.equal(records.length, 1, 'records come back from the backup');
    assert.equal(records[0].task, 'first conversation');
    assert.ok(errors.some(error => /corrupt/.test(error.message)), 'the corruption is reported, non-blocking');
    const quarantined = fs.readdirSync(dir).filter(name => name.includes('.corrupt-'));
    assert.equal(quarantined.length, 1, 'the corrupt blob is kept on disk for recovery');

    // Writes continue after corruption: the next checkpoint persists normally.
    recovered.checkpoint({ id: 'run-2', task: 'second conversation', status: 'completed', attemptSequence: 1, eventRevision: 1,
      messages: [{ role: 'user', content: 'second conversation', at: 2 }] });
    await recovered.flush();
    assert.equal(recovered.get('run-2').task, 'second conversation');
    const again = new ChatHistoryStore({ filePath });
    assert.equal(again.get('run-1').task, 'first conversation');
    assert.equal(again.get('run-2').task, 'second conversation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history is unbounded: no count cap and no age cutoff drops conversations', () => {
  const { dir, filePath } = tempStore();
  try {
    const store = new ChatHistoryStore({ filePath });
    const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 150; i += 1) {
      store.append({ id: `run-${i}`, task: `conversation ${i}`, status: 'completed', createdAt: yearAgo, updatedAt: yearAgo,
        messages: [{ role: 'user', content: `conversation ${i}`, at: yearAgo }] });
    }
    const records = store.load();
    assert.equal(records.length, 150, 'no MAX_CONVERSATIONS cap drops old conversations');
    assert.ok(records.some(record => record.id === 'run-0' && record.task === 'conversation 0'), 'the oldest, year-old conversation survives');
    const restarted = new ChatHistoryStore({ filePath });
    assert.equal(restarted.load().length, 150, 'the full set survives a restart');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
