// turn-addition-semantics.test.mjs — node --test tests/turn-addition-semantics.test.mjs
//
// OWNER DIRECTIVE (2026-10-15): mid-run, queued, and fast-forwarded user
// messages are ADDITIONS to the running work — appended requirements or
// updates — never a change of direction. The agent keeps the existing tasks
// and plan and folds the new instruction in. Only an EXPLICIT abandon/
// replace mention flips the message to a replacement. Covered here: the
// classifier, both turn-boundary framings, both mid-run steering framings,
// and the objective-ledger semantics an addition turn gets (previous task
// stays open).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isTaskAddition, turnBoundaryNotice, steeringAdditionNotice, steeringReplacementNotice,
  advanceObjectiveLedger
} = require('../desktop/agent/desktopChatAgent.cjs');

test('classifier: plain follow-ups, refinements, and extras are ADDITIONS', () => {
  for (const text of [
    'also make the header sticky',
    'now do the same for the footer',
    'use the same style for the buttons',
    'the background color should be darker',
    'add a loading spinner while it loads',
    'wait, also export it as pdf',
    'update the version number to 2.1'
  ]) {
    assert.equal(isTaskAddition(text), true, `"${text}" must be an addition`);
  }
});

test('classifier: only explicit cancel/replace cues flip to a replacement', () => {
  for (const text of [
    'do the footer instead',
    'forget that, start over',
    'abandon the label work',
    'never mind, new task: build the login page',
    'scratch that — change of plan',
    'stop working on the header, switch to the sidebar',
    'actually scrap that and replace it with a modal'
  ]) {
    assert.equal(isTaskAddition(text), false, `"${text}" must be a replacement (explicit cue)`);
  }
  // Weak cues never flip: "actually" + an addition stays an addition.
  assert.equal(isTaskAddition('actually, also add a favicon'), true);
});

test('turn-boundary framing: ADDITION is the default and carries the plan', () => {
  const notice = turnBoundaryNotice('also add a dark-mode toggle', { addition: true });
  assert.match(notice, /USER ADDITION/);
  assert.match(notice, /NOT a change of direction/);
  assert.match(notice, /APPEND plan item/);
  assert.match(notice, /carried items and the additions/);
  assert.match(notice, /Drop prior work only if THIS message explicitly cancels it/);
  assert.doesNotMatch(notice, /Every earlier task in this conversation is CLOSED/);
});

test('turn-boundary framing: explicit replacement keeps the closed-turn contract', () => {
  const notice = turnBoundaryNotice('forget that — build the login page instead', { addition: false });
  assert.match(notice, /TURN BOUNDARY — NEW TASK/);
  assert.match(notice, /Every earlier task in this conversation is CLOSED/);
  assert.match(notice, /start empty on purpose/);
  // The cheap Q&A variant is preserved for replacement answers.
  const cheap = turnBoundaryNotice('what time is it?', { addition: false });
  assert.match(cheap, /Work exclusively on this objective/);
  assert.ok(cheap.length < 200, 'cheap informational tasks keep the short boundary line');
});

test('mid-run steering: addition framing keeps the plan; replacement framing swaps it', () => {
  const addition = steeringAdditionNotice('also validate the email field');
  assert.match(addition, /ADDITION/);
  assert.match(addition, /keep executing the existing plan/);
  assert.match(addition, /Only when THIS message explicitly cancels or replaces/);

  const replacement = steeringReplacementNotice('forget that — open the dashboard instead');
  assert.match(replacement, /explicitly replaces the previous task/);
  assert.match(replacement, /sole authoritative objective/);
  assert.match(replacement, /name what you dropped/);
});

test('objective ledger: an addition turn keeps the previous task OPEN', () => {
  // A boundary turn closes the previous objective (abandoned when the
  // previous run was unverified). An addition turn must NOT: the earlier
  // task is still being worked alongside the addition.
  const started = advanceObjectiveLedger(null, 'fix the favourites toggle', { boundary: false, at: 1000 });
  assert.equal(started.length, 1);
  // Boundary semantics (unchanged contract): unverified previous → abandoned.
  const afterBoundary = advanceObjectiveLedger(started, 'build the login page', { boundary: true, previousResult: { verified: false }, at: 2000 });
  assert.equal(afterBoundary[0].status, 'abandoned', 'explicit replacement closes the old objective');
  assert.equal(afterBoundary[1].status, 'active');
  // Addition semantics: previous entry untouched, addition opens alongside.
  const afterAddition = advanceObjectiveLedger(started, 'also add a dark-mode toggle', { boundary: false, at: 2000 });
  assert.equal(afterAddition[0].status, 'active', 'the earlier task stays open');
  assert.equal(afterAddition[1].status, 'active', 'the addition opens alongside it');
});
