import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createFlowControlState,
  resetFlowControlForUserTurn,
  captureEvidence,
  scoreEvidenceNovelty,
  thinkingBudgetTier,
  classifyDecision,
  assessFlowControl
} = require('../desktop/agent/flowControlState.cjs');

// captureEvidence(call, output) takes the raw tool output as its 2nd argument.
const ev = (call) => captureEvidence({ name: call.name, input: call.input }, call.output);
const inEpoch = (entry, epoch = 0) => ({ ...entry, epoch });

function read(path, fromLine, toLine, content, hash = 'same') {
  return {
    name: 'computer_read',
    input: { path, offset: fromLine, limit: toLine - fromLine + 1 },
    output: { ok: true, result: { path, fromLine, toLine, lines: toLine - fromLine + 1, content, workspace: { hash } } }
  };
}

function search(pattern, files) {
  return {
    name: 'computer_search',
    input: { path: 'C:/repo', pattern, output: 'files' },
    output: { ok: true, result: { root: 'C:/repo', files, matches: files.length } }
  };
}

test('flow state bounds restored evidence and resets per-objective state', () => {
  const restored = createFlowControlState({
    evidence: Array.from({ length: 100 }, (_, i) => ({ kind: 'read', subject: `p${i}`, from: 1, to: 2 })),
    noticeLog: Array.from({ length: 100 }, (_, i) => ({ key: `n${i}`, decision: i })),
    planPromptCount: 99
  });
  assert.equal(restored.evidence.length, 64);
  assert.equal(restored.noticeLog.length, 24);
  assert.equal(restored.planPromptCount, 3);
  const next = resetFlowControlForUserTurn(restored, 'new task');
  assert.equal(next.evidence.length, 0);
  assert.equal(next.noticeLog.length, 0);
  assert.equal(next.planPromptCount, 0);
  assert.notEqual(next.evidenceEpoch, restored.evidenceEpoch);
});

test('an old checkpoint without flow state normalizes to safe defaults', () => {
  const state = createFlowControlState(undefined);
  assert.equal(state.phase, 'inspect');
  assert.deepEqual(state.evidence, []);
  assert.equal(state.bounceEpoch, -1);
});

test('file novelty distinguishes exact, shifted, continuation, and changed reads', () => {
  const ledger = [inEpoch(ev(read('C:/repo/a.js', 10, 20, 'line a\nline b')))];
  assert.equal(scoreEvidenceNovelty(ledger, inEpoch(ev(read('C:/repo/a.js', 10, 20, 'line a\nline b')))), 0, 'identical read adds nothing');
  assert.ok(scoreEvidenceNovelty(ledger, inEpoch(ev(read('C:/repo/a.js', 12, 22, 'line a\nline b')))) < 0.5, 'a shifted offset that mostly overlaps is low novelty');
  assert.ok(scoreEvidenceNovelty(ledger, inEpoch(ev(read('C:/repo/a.js', 21, 30, 'line c')))) > 0.5, 'a non-overlapping continuation is new');
  assert.equal(scoreEvidenceNovelty(ledger, inEpoch(ev(read('C:/repo/a.js', 10, 20, 'changed', 'changed-hash')))), 1, 'a changed artifact hash is new evidence');
});

test('a read in a new evidence epoch (after an edit) is always new', () => {
  const ledger = [inEpoch(ev(read('C:/repo/a.js', 10, 20, 'line a')), 0)];
  assert.equal(scoreEvidenceNovelty(ledger, inEpoch(ev(read('C:/repo/a.js', 10, 20, 'line a')), 1)), 1);
});

test('search novelty treats reworded equivalent results as low yield', () => {
  const ledger = [inEpoch(ev(search('update plan', ['C:/repo/agent.js', 'C:/repo/test.js'])))];
  assert.ok(scoreEvidenceNovelty(ledger, inEpoch(ev(search('plan update', ['C:/repo/agent.js', 'C:/repo/test.js'])))) <= 0.05);
  assert.ok(scoreEvidenceNovelty(ledger, inEpoch(ev(search('flow controller', ['C:/repo/flow.js'])))) > 0.5);
});

test('captureEvidence ignores failed calls and non-consult tools', () => {
  assert.equal(captureEvidence({ name: 'computer_read', input: {} }, { ok: false }), null);
  assert.equal(captureEvidence({ name: 'computer_patch', input: {} }, { ok: true }), null);
});

test('thinking tiers stay silent for normal work and escalate by size or time', () => {
  assert.equal(thinkingBudgetTier({ chars: 1000, ms: 10_000 }), 0);
  assert.equal(thinkingBudgetTier({ chars: 5000, ms: 10_000 }), 1);
  assert.equal(thinkingBudgetTier({ chars: 1000, ms: 50_000 }), 1);
  assert.equal(thinkingBudgetTier({ chars: 17_000, ms: 10_000 }), 2);
});

test('planning narration is not a real plan and evidence claims are detected', () => {
  const classified = classifyDecision({
    taskIsMultipart: true,
    assistantText: 'First I will inspect the file, then I will patch it, finally I will run the test.'
  });
  assert.equal(classified.planningNarration, true);
  assert.equal(classified.hasPlan, false);
  for (const text of ['We have enough evidence and the cause is clear.', 'The evidence is sufficient.', 'I know what I need.']) {
    assert.equal(classifyDecision({ assistantText: text }).evidenceClaim, true, text);
  }
  assert.equal(classifyDecision({ assistantText: 'I need more evidence before patching.' }).evidenceClaim, false);
});

test('a real update_plan call is a plan; narration beside it is not flagged', () => {
  const classified = classifyDecision({
    taskIsMultipart: true,
    calls: [{ name: 'update_plan', input: { steps: ['a', 'b'] } }],
    assistantText: 'First this, then that, finally the other.'
  });
  assert.equal(classified.hasPlan, true);
  assert.equal(classified.planningNarration, false);
});

test('multipart narration without a plan emits update_plan guidance and never blocks action', () => {
  const first = assessFlowControl(createFlowControlState(), {
    taskIsMultipart: true,
    assistantText: 'First inspect, then patch, finally verify.',
    planLength: 0,
    calls: []
  });
  assert.match(first.notice?.text || '', /update_plan/);
  const second = assessFlowControl(first.state, {
    taskIsMultipart: true,
    calls: [{ name: 'computer_patch', input: { path: 'C:/repo/a.js' } }],
    mutationSucceeded: true,
    planLength: 0
  });
  assert.equal(second.assessment.hasExecutable, true);
  assert.equal(second.bounce, null);
});

test('plan guidance is bounded: it stops after the prompt cap', () => {
  let state = createFlowControlState();
  let prompts = 0;
  for (let i = 0; i < 30; i += 1) {
    const result = assessFlowControl(state, { taskIsMultipart: true, calls: [], assistantText: 'First a, then b, finally c.', planLength: 0 });
    state = result.state;
    if (result.notice && /update_plan/.test(result.notice.text)) prompts += 1;
  }
  assert.ok(prompts >= 1 && prompts <= 3, `plan prompts bounded, got ${prompts}`);
});

test('low novelty evidence arms an advisory, then exactly one bounce per evidence epoch', () => {
  let state = createFlowControlState();
  const same = read('C:/repo/a.js', 1, 10, 'same');
  const bounces = [];
  const advisories = [];
  for (let i = 0; i < 9; i += 1) {
    const result = assessFlowControl(state, {
      calls: [{ name: 'computer_read', input: same.input }],
      evidence: [ev(same)],
      planLength: 0,
      taskText: 'inspect a.js'
    });
    state = result.state;
    if (result.bounce) bounces.push(i);
    if (result.notice?.key === 'low-yield') advisories.push(i);
  }
  assert.equal(bounces.length, 1, 'one bounded bounce for the whole epoch');
  assert.ok(advisories.length >= 1, 'an advisory precedes the bounce');
  assert.ok(advisories[0] < bounces[0], 'advisory first, then the bounce');
});

test('a successful edit opens a new epoch so the re-read is new and a later bounce is allowed again', () => {
  let state = createFlowControlState();
  const same = read('C:/repo/a.js', 1, 10, 'same');
  for (let i = 0; i < 7; i += 1) state = assessFlowControl(state, { calls: [{ name: 'computer_read', input: same.input }], evidence: [ev(same)], taskText: 'inspect a.js' }).state;
  const epochBefore = state.evidenceEpoch;
  const edited = assessFlowControl(state, {
    calls: [{ name: 'computer_patch', input: { path: 'C:/repo/a.js' } }],
    mutationSucceeded: true,
    touchedPaths: ['c:/repo/a.js'],
    taskText: 'inspect a.js'
  });
  assert.equal(edited.state.evidenceEpoch, epochBefore + 1);
  assert.equal(edited.state.lowYieldStreak, 0);
  const reread = assessFlowControl(edited.state, { calls: [{ name: 'computer_read', input: same.input }], evidence: [ev(same)], taskText: 'inspect a.js' });
  assert.equal(reread.assessment.newEvidence, true, 'the post-edit re-read is fresh evidence');
  assert.equal(reread.assessment.lowYield, false);
});

test('varied offsets over one file stay low-yield and cannot dodge the detector', () => {
  let state = createFlowControlState();
  let bounced = false;
  for (let i = 0; i < 12; i += 1) {
    const from = 1 + i * 2; // heavily overlapping windows over unchanged content
    const call = read('C:/repo/a.js', from, from + 40, 'same content', 'same');
    const result = assessFlowControl(state, { calls: [{ name: 'computer_read', input: call.input }], evidence: [ev(call)], taskText: 'inspect a.js' });
    state = result.state;
    bounced = bounced || Boolean(result.bounce);
  }
  assert.equal(bounced, true);
});

test('an evidence-sufficiency claim with no action receives flow guidance', () => {
  const result = assessFlowControl(createFlowControlState(), {
    calls: [],
    assistantText: 'The evidence is sufficient; I know the cause now.',
    thinkingChars: 20_000,
    thinkingMs: 60_000
  });
  assert.equal(result.notice?.key, 'evidence-claim');
  assert.match(result.notice.text, /sufficient/i);
  assert.equal(result.assessment.evidenceClaimStall, true);
});

test('an evidence claim that is followed by a real action is not flagged', () => {
  const result = assessFlowControl(createFlowControlState(), {
    calls: [{ name: 'computer_patch', input: { path: 'C:/repo/a.js' } }],
    mutationSucceeded: true,
    assistantText: 'The evidence is sufficient, patching now.'
  });
  assert.equal(result.assessment.evidenceClaimStall, false);
  assert.equal(result.notice, null);
});

test('notices honour a cooldown instead of repeating every decision', () => {
  let state = createFlowControlState();
  const keys = [];
  for (let i = 0; i < 6; i += 1) {
    const result = assessFlowControl(state, { calls: [], assistantText: 'The evidence is sufficient.', thinkingChars: 20_000 });
    state = result.state;
    keys.push(result.notice?.key || null);
  }
  assert.equal(keys[0], 'evidence-claim');
  assert.equal(keys[1], null, 'cooldown suppresses the immediate repeat');
});

test('every flow notice fits the 300-char provider cap so its closing exit is never clipped', async () => {
  const { NOTICE_MAX_CHARS, NOTICE_TEXT, thinkingBudgetNotice } = require('../desktop/agent/flowControlState.cjs');
  assert.equal(NOTICE_MAX_CHARS, 300);
  for (const [name, text] of Object.entries(NOTICE_TEXT)) {
    if (name === 'bounce') continue; // delivered as a recovery demand (600-char cap), not a harness notice
    assert.ok(text.length <= NOTICE_MAX_CHARS, `${name} is ${text.length} chars`);
  }
  for (const tier of [1, 2]) {
    const text = thinkingBudgetNotice(tier);
    assert.ok(text.length <= NOTICE_MAX_CHARS, `thinking tier ${tier} is ${text.length} chars`);
    assert.match(text, /cheapest discriminating test/);
    assert.match(text, /update_plan/);
    assert.match(text, /keep thinking only if/i);
  }
});
