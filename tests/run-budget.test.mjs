import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseTaskDeadlineMs, normalizeRunBudgetMs, deadlineAtForTurn, remainingRunMs, MAX_DEADLINE_MS } = require('../desktop/agent/runBudget.cjs');

test('parses unambiguous task deadline phrases', () => {
  assert.equal(parseTaskDeadlineMs('answer within 30 seconds'), 30_000);
  assert.equal(parseTaskDeadlineMs('finish under 2 minutes'), 120_000);
  assert.equal(parseTaskDeadlineMs('do it in 1 hour'), 3_600_000);
  assert.equal(parseTaskDeadlineMs('within 5 secs'), 5_000);
  assert.equal(parseTaskDeadlineMs('under 10 mins'), 600_000);
});

test('returns null when no deadline phrase is present', () => {
  assert.equal(parseTaskDeadlineMs('just do the thing'), null);
  assert.equal(parseTaskDeadlineMs('Keep going after exhaustion'), null);
  assert.equal(parseTaskDeadlineMs(''), null);
  assert.equal(parseTaskDeadlineMs(null), null);
});

test('normalizeRunBudgetMs accepts valid values and rejects invalid', () => {
  assert.equal(normalizeRunBudgetMs(5_000), 5_000);
  assert.equal(normalizeRunBudgetMs(0), null);
  assert.equal(normalizeRunBudgetMs(-100), null);
  assert.equal(normalizeRunBudgetMs(NaN), null);
  assert.equal(normalizeRunBudgetMs(undefined), null);
  assert.equal(normalizeRunBudgetMs(MAX_DEADLINE_MS + 1), MAX_DEADLINE_MS);
});

test('deadlineAtForTurn: fresh turn computes from task phrase', () => {
  const deadline = deadlineAtForTurn({ task: 'answer within 30 seconds', turnStartedAt: 1000 });
  assert.equal(deadline, 31_000);
});

test('deadlineAtForTurn: explicit settings override task phrase', () => {
  const deadline = deadlineAtForTurn({ task: 'answer within 30 seconds', explicitMs: 5_000, turnStartedAt: 1000 });
  assert.equal(deadline, 6_000);
});

test('deadlineAtForTurn: sameTurn preserves previous deadline', () => {
  const deadline = deadlineAtForTurn({ task: 'new text', turnStartedAt: 5000, previousDeadlineAt: 31_000, sameTurn: true });
  assert.equal(deadline, 31_000);
});

test('deadlineAtForTurn: null when no budget source exists', () => {
  const deadline = deadlineAtForTurn({ task: 'just do it', turnStartedAt: 1000 });
  assert.equal(deadline, null);
});

test('remainingRunMs: null for unlimited, 0 for expired, positive for active', () => {
  assert.equal(remainingRunMs({ deadlineAt: null }), null);
  assert.equal(remainingRunMs({}), null);
  assert.equal(remainingRunMs({ deadlineAt: Date.now() - 100 }), 0);
  const future = Date.now() + 30_000;
  const remaining = remainingRunMs({ deadlineAt: future });
  assert.ok(remaining > 29_000 && remaining <= 30_000, `remaining should be ~30s but was ${remaining}`);
});
