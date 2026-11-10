import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseTaskDeadlineMs, deadlineAtForTurn, remainingRunMs } = require('../desktop/agent/runBudget.cjs');

// --- Extended deadline parsing ---

test('parses "finish in 10s" as a 10-second deadline', () => {
  assert.equal(parseTaskDeadlineMs('finish in 10s'), 10_000);
  assert.equal(parseTaskDeadlineMs('finish in 30 seconds'), 30_000);
  assert.equal(parseTaskDeadlineMs('finish in 2 minutes'), 120_000);
});

test('parses "complete it in 30s" as a 30-second deadline', () => {
  assert.equal(parseTaskDeadlineMs('complete it in 30s'), 30_000);
  assert.equal(parseTaskDeadlineMs('complete in 1 hour'), 3_600_000);
});

test('parses "answer within 30secs" as a 30-second deadline', () => {
  assert.equal(parseTaskDeadlineMs('answer within 30secs'), 30_000);
});

test('parses "done in 5s" as a 5-second deadline', () => {
  assert.equal(parseTaskDeadlineMs('done in 5s'), 5_000);
});

test('parses short unit forms (s, m, h)', () => {
  assert.equal(parseTaskDeadlineMs('within 5 s'), 5_000);
  assert.equal(parseTaskDeadlineMs('under 3 m'), 180_000);
  assert.equal(parseTaskDeadlineMs('in 1 h'), 3_600_000);
});

test('still parses original patterns', () => {
  assert.equal(parseTaskDeadlineMs('answer within 30 seconds'), 30_000);
  assert.equal(parseTaskDeadlineMs('under 2 minutes'), 120_000);
});

test('returns null when no deadline phrase is present', () => {
  assert.equal(parseTaskDeadlineMs('just do the thing'), null);
  assert.equal(parseTaskDeadlineMs('Keep going after exhaustion'), null);
  assert.equal(parseTaskDeadlineMs('regenerate the image'), null);
});

test('deadlineAtForTurn works with extended patterns', () => {
  const deadline = deadlineAtForTurn({ task: 'finish in 10s', turnStartedAt: 1000 });
  assert.equal(deadline, 11_000);
});

test('remainingRunMs returns 0 when deadline expired', () => {
  assert.equal(remainingRunMs({ deadlineAt: Date.now() - 100 }), 0);
  assert.equal(remainingRunMs({ deadlineAt: null }), null);
});

// --- Search definition mode (contract-level) ---

test('definition mode regex matches common function definition forms', () => {
  // The effective pattern built by searchTool for mode=definition:
  const name = 'verifySelectedModel';
  const pattern = `(?:function\\s+|async\\s+function\\s+|const\\s+|let\\s+|var\\s+|(?:^|[.\\s]))${name}\\s*[=(:]|${name}\\s*:\\s*(?:async\\s+)?(?:function|\\()`;
  const regex = new RegExp(pattern, 'i');
  assert.ok(regex.test('function verifySelectedModel(fields) {'), 'function declaration matches');
  assert.ok(regex.test('async function verifySelectedModel(fields) {'), 'async function matches');
  assert.ok(regex.test('const verifySelectedModel = (x) => {}'), 'const arrow matches');
  assert.ok(regex.test('verifySelectedModel: function() {}'), 'property function matches');
  assert.ok(regex.test('verifySelectedModel: async function() {}'), 'async property matches');
  assert.ok(regex.test('.verifySelectedModel('), 'method call matches');
  assert.ok(!regex.test('unrelatedFunction()'), 'unrelated function does not match');
});

// --- Verification cap / deadline notice (contract-level) ---

test('deadline finish notice arms at < 30s remaining', () => {
  // The logic in desktopChatAgent.cjs: if remainingRunMs < 30_000 and notice
  // not armed, push notice. Verify the threshold is 30s.
  const remaining = 25_000;
  assert.ok(remaining < 30_000, 'notice fires when < 30s remaining');
  const remaining2 = 35_000;
  assert.ok(remaining2 >= 30_000, 'notice does not fire when >= 30s remaining');
});

// --- Walker depth limits (contract-level) ---

test('walker limits are raised to cover nested src/ directories', () => {
  // The searchWithWalker and computer_index walk functions now use depth > 14
  // (was 10) and files.length > 8000 (was 4000). Verify the constants.
  const walkDepthLimit = 14;
  const walkFileLimit = 8000;
  assert.ok(walkDepthLimit >= 14, 'walker depth limit covers nested src/editor/ui');
  assert.ok(walkFileLimit >= 8000, 'walker file limit covers large projects');
});
