import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// CommonJS named-export detection does not see through the
// `typeof fn === 'function' ? fn : null` guards in this module's export
// object, so require it directly.
const require = createRequire(import.meta.url);
const internals = require('../desktop/agent/agentInternals.cjs');
const { isThinTerminalReply, executeAction } = internals;
assert.equal(typeof isThinTerminalReply, 'function', 'the gate must be exported');
assert.equal(typeof executeAction, 'function', 'the done handler must be exported');

// ── The incident ────────────────────────────────────────────────────────────
// Terminal summaries observed in a real transcript: "Done", "Finished",
// "Replied", and "Acknowledged user's greeting. No specific task requested."
// Each leaves the user with nothing to read, so they assume the agent did not
// understand and re-send the message. The prompt states the contract; this is
// the mechanical backstop.

test('bare status tokens are rejected as answers', () => {
  for (const value of ['Done', 'done.', 'Finished!', 'Completed', 'Replied', 'OK', 'Noted', 'Task completed.']) {
    assert.equal(isThinTerminalReply(value), true, `${JSON.stringify(value)} must be thin`);
  }
});

test('a meta-statement about the conversation is rejected', () => {
  assert.equal(isThinTerminalReply("Acknowledged user's greeting. No specific task requested."), true);
  assert.equal(isThinTerminalReply('Noted — no specific task.'), true);
});

test('a real answer passes', () => {
  const real = 'Your last sent message on TikTok was “Thanks”, November 15 at 12:08, to Cottiny.';
  assert.equal(isThinTerminalReply(real), false);
  const short = 'The build is failing because of a missing import.';
  assert.equal(isThinTerminalReply(short), false);
});

test('an empty summary is thin', () => {
  assert.equal(isThinTerminalReply(''), true);
  assert.equal(isThinTerminalReply(null), true);
});

// ── The gate in the done handler ────────────────────────────────────────────

function fakeRun(task) {
  return {
    task,
    history: [],
    thinReplyBounced: false,
    provider: { model: 'test-model' },
    // The done handler touches the wait counter before it validates the
    // summary, so the minimal run needs the loop state it expects.
    loopState: { consecutiveWaits: 0, recentActions: [], unchangedPages: 0, noProgressActions: 0, lastFingerprint: null }
  };
}

test('a "Done" summary is bounced once with the request quoted back', async () => {
  const run = fakeRun('HI');
  const output = await executeAction(null, run, { name: 'browser_done', input: { summary: 'Done', success: true } });
  assert.equal(output.ok, false, 'the done must not be accepted');
  assert.equal(output.recoverable, true, 'the loop must retry, not fail the run');
  assert.match(output.error, /status token, not an answer/);
  assert.match(output.error, /HI/, 'the bounce must quote what the user actually asked');
  assert.equal(run.thinReplyBounced, true);
});

test('the gate bounces only once, so a stubborn model cannot loop', async () => {
  const run = fakeRun('HI');
  const first = await executeAction(null, run, { name: 'browser_done', input: { summary: 'Done', success: true } });
  assert.equal(first.ok, false);
  const second = await executeAction(null, run, { name: 'browser_done', input: { summary: 'Done', success: true } });
  assert.equal(second.ok, true, 'a second token is accepted rather than looping forever');
  assert.equal(second.summary, 'Done');
});

test('a real summary is accepted on the first try', async () => {
  const run = fakeRun('check the inbox');
  const output = await executeAction(null, run, {
    name: 'browser_done',
    input: { summary: 'The inbox has 26 conversations; the newest reply is from Cottiny on 11/15.', success: true }
  });
  assert.equal(output.ok, true);
  assert.equal(run.thinReplyBounced, false, 'no bounce should have been armed');
});

test('a failed run is not bounced for being terse', async () => {
  // success:false already reports an honest failure; demanding prose from it
  // would turn a real error into a style argument.
  const run = fakeRun('do the thing');
  const output = await executeAction(null, run, { name: 'browser_done', input: { summary: 'Done', success: false } });
  assert.equal(output.ok, true);
});
