// Conversation naming: the AI names a chat as it evolves, and the history tab
// prints that name. These tests pin the two halves of that promise — a name is
// re-proposed as the work progresses (not only at the first message), and a
// failed naming call can never disturb the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { maybeGenerateConversationTitle } = require('../desktop/agent/agentInternals.cjs');

function fakeAgent({ title = 'First Name', fail = false, api = null } = {}) {
  const calls = [];
  const published = [];
  const checkpoints = [];
  const agent = {
    calls,
    published,
    checkpoints,
    titleApi: api || (async (request) => {
      calls.push(request);
      if (fail) throw new Error('title provider unreachable');
      return typeof title === 'function' ? title(calls.length) : title;
    }),
    publish: (type, run, payload) => published.push({ type, payload }),
    onCheckpoint: (snapshot) => checkpoints.push(snapshot)
  };
  return agent;
}

function fakeRun({ title = 'Opening Guess', user = 'open the pricing page' } = {}) {
  return {
    id: 'run-1',
    title,
    task: user,
    // A real run always carries its tool history; the checkpoint serializer
    // spreads it, so a run without one is not a realistic stand-in.
    history: [],
    messages: [
      { role: 'user', content: user, at: Date.now() },
      { role: 'assistant', content: 'I compared the three plans and the middle one is cheapest.', at: Date.now() }
    ]
  };
}

test('a run is named from its opening turn and the name is persisted immediately', async () => {
  const agent = fakeAgent({ title: 'Pricing Page Review' });
  const run = fakeRun();
  await maybeGenerateConversationTitle(agent, run);
  assert.equal(run.title, 'Pricing Page Review');
  assert.equal(agent.published.filter((event) => event.type === 'run.title').length, 1);
  assert.ok(agent.checkpoints.length >= 1, 'the name must survive the run ending here');
  assert.equal(agent.checkpoints.at(-1).title, 'Pricing Page Review');
});

test('a second turn with the same user text does not re-ask', async () => {
  const agent = fakeAgent();
  const run = fakeRun();
  await maybeGenerateConversationTitle(agent, run);
  const afterFirst = agent.calls.length;
  run.titleGeneratedAt = 0; // defeat the throttle: this test is about the guard
  await maybeGenerateConversationTitle(agent, run);
  assert.equal(agent.calls.length, afterFirst, 'nothing new to name means no provider call');
});

test('a mid-run refresh renames the chat from what the work revealed', async () => {
  const agent = fakeAgent({ title: (call) => (call === 1 ? 'Pricing Page Review' : 'Cheapest Plan Comparison') });
  const run = fakeRun();
  await maybeGenerateConversationTitle(agent, run);
  assert.equal(run.title, 'Pricing Page Review');
  // Mid-run there is no new user turn — the trigger is new evidence, so the
  // "same user text" guard must not veto it.
  run.titleGeneratedAt = 0;
  await maybeGenerateConversationTitle(agent, run, { inRun: true });
  assert.equal(run.title, 'Cheapest Plan Comparison', 'the name must follow the work, not freeze at the opening guess');
  assert.equal(agent.published.filter((event) => event.type === 'run.title').at(-1).payload.title, 'Cheapest Plan Comparison');
});

test('the mid-run refresh still respects the throttle', async () => {
  const agent = fakeAgent({ title: (call) => `Name ${call}` });
  const run = fakeRun();
  await maybeGenerateConversationTitle(agent, run);
  const afterFirst = agent.calls.length;
  await maybeGenerateConversationTitle(agent, run, { inRun: true });
  assert.equal(agent.calls.length, afterFirst, 'a 30s throttle keeps renaming from becoming a per-step provider call');
});

test('a naming failure is swallowed and leaves the current name intact', async () => {
  const agent = fakeAgent({ fail: true });
  const run = fakeRun({ title: 'Keep This Name' });
  await assert.doesNotReject(() => maybeGenerateConversationTitle(agent, run, { force: true }));
  assert.equal(run.title, 'Keep This Name');
  assert.equal(agent.published.length, 0);
  assert.equal(run.titleInFlight, false, 'a failure must not wedge the in-flight flag');
});

test('model wrappers around the name are stripped before it reaches a tab', async () => {
  const wrapped = fakeAgent({ title: '**Title:** "Compare Pricing Plans"' });
  const run = fakeRun();
  await maybeGenerateConversationTitle(wrapped, run);
  assert.equal(run.title, 'Compare Pricing Plans', 'a markdown/bold wrapper must not be printed');

  const quoted = fakeAgent({ title: '  “Creator Follower Audit.”  ' });
  const second = fakeRun();
  await maybeGenerateConversationTitle(quoted, second);
  assert.equal(second.title, 'Creator Follower Audit');
});
