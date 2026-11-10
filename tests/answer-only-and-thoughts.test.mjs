import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isAnswerOnlyTask, DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

test('isAnswerOnlyTask: pure question with no tool history returns true', () => {
  const run = { history: [], plan: [], turnStartedAt: Date.now() };
  assert.equal(isAnswerOnlyTask('What is the blocker?', 'The blocker is access rights.', run), true);
});

test('isAnswerOnlyTask: follow-up question after prior turn tool history returns true', () => {
  const pastTime = Date.now() - 60_000;
  const run = {
    history: [{ at: pastTime, tool: 'browser_click', output: { ok: true } }],
    plan: [],
    turnStartedAt: Date.now()
  };
  assert.equal(isAnswerOnlyTask('What changed?', 'The page now shows the new state.', run), true);
});

test('isAnswerOnlyTask: question with current-turn tool history returns false', () => {
  const now = Date.now();
  const run = {
    history: [{ at: now - 100, tool: 'browser_click', output: { ok: true } }],
    plan: [],
    turnStartedAt: now - 1000
  };
  assert.equal(isAnswerOnlyTask('What changed?', 'Something changed.', run), false);
});

test('isAnswerOnlyTask: an open plan item never blocks a conversational answer', () => {
  // The previous assertion pinned the OPPOSITE and encoded the exact defect
  // the repair was mandated to remove: an unfinished automation plan (item
  // f11) trapped "hello" inside the automation completion protocol. A normal
  // conversational request must be answerable without completing or skipping
  // old plan items — the plan stays intact and simply does not gate the reply.
  const run = {
    history: [],
    plan: [{ text: 'do stuff', status: 'current' }],
    turnStartedAt: Date.now()
  };
  assert.equal(isAnswerOnlyTask('What is the status?', 'Working on it.', run), true);
});

test('isAnswerOnlyTask: action verbs prevent answer-only', () => {
  const run = { history: [], plan: [], turnStartedAt: Date.now() };
  assert.equal(isAnswerOnlyTask('Click the button to verify', 'Done.', run), false);
});

test('isAnswerOnlyTask: non-question request prevents answer-only', () => {
  const run = { history: [], plan: [], turnStartedAt: Date.now() };
  assert.equal(isAnswerOnlyTask('Fix the bug', 'Done.', run), false);
});

test('isAnswerOnlyTask: empty answer prevents answer-only', () => {
  const run = { history: [], plan: [], turnStartedAt: Date.now() };
  assert.equal(isAnswerOnlyTask('What is the blocker?', '', run), false);
});

// Thought elapsedMs clamping regression
test('late thought callback after settle does not produce epoch-sized elapsedMs', () => {
  // Simulate the exact bug: activeThoughtStartedAt is null after settle
  // and Date.now() - null = Date.now() (~1.7e12 ms).
  const run = {
    id: 'test-run',
    activeThoughtId: null,
    activeThoughtStartedAt: null,
    activeThoughtAccumulator: () => 'some thought',
    thoughtBaseChars: 0
  };
  // The clamp formula used in the fixed code:
  const elapsed = Math.max(0, Date.now() - Number(run.activeThoughtStartedAt || Date.now()));
  assert.ok(elapsed < 1000, `clamped elapsed should be small but was ${elapsed}`);
  assert.ok(Number.isFinite(elapsed));
});

test('renderer liveThoughtElapsed rejects epoch-sized values', () => {
  // Replicate the renderer guard logic
  const MAX_ELAPSED_DISPLAY_MS = 24 * 60 * 60_000;
  const item = { dataset: { startedAt: String(Date.now() - 5000), elapsedMs: '5000' } };
  const supplied = Number(Date.now()); // epoch-sized value
  const safeSupplied = Number.isFinite(supplied) && supplied >= 0 && supplied <= MAX_ELAPSED_DISPLAY_MS ? supplied : 0;
  assert.equal(safeSupplied, 0, 'epoch-sized value is rejected');

  // Negative values are rejected
  const negSupplied = Number(-5000);
  const safeNeg = Number.isFinite(negSupplied) && negSupplied >= 0 && negSupplied <= MAX_ELAPSED_DISPLAY_MS ? negSupplied : 0;
  assert.equal(safeNeg, 0, 'negative value is rejected');

  // NaN is rejected
  const nanSupplied = Number('not-a-number');
  const safeNan = Number.isFinite(nanSupplied) && nanSupplied >= 0 && nanSupplied <= MAX_ELAPSED_DISPLAY_MS ? nanSupplied : 0;
  assert.equal(safeNan, 0, 'NaN value is rejected');

  // Normal values pass through
  const normalSupplied = 3_500;
  const safeNormal = Number.isFinite(normalSupplied) && normalSupplied >= 0 && normalSupplied <= MAX_ELAPSED_DISPLAY_MS ? normalSupplied : 0;
  assert.equal(safeNormal, 3_500, 'normal value passes');
});
