// Conversation lifecycle: an ordinary message is a conversation, not an
// automation task. The f11 incident ("hello" trapped behind an unfinished
// automation plan and its completion protocol) is reproduced here.
//
//   A. conversational independence — "hello" is answered without browser_done,
//      and the old plan stays intact without blocking the reply
//   B. explicit interruption — "ignore everything and answer hello" supersedes
//      the active task, schedules nothing more for it, and preserves resumable
//      state
//   C. run isolation — one run's plan/evidence/result never contaminates another
//   D. terminal-state enforcement — the accepted terminal result ends provider
//      scheduling exactly once

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 1, tag: 'button', name: 'Control' }] } };

function harness(complete) {
  const contexts = [];
  const controller = {
    navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {}
  };
  const backend = {
    observe: async () => ({ windows: [], foregroundWindowId: null }),
    execute: async () => ({ content: 'same evidence' }),
    releaseOwner: async () => {}, releaseInput: async () => {}
  };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {},
    createProvider: () => ({ complete: async (context) => { contexts.push(context); return complete(context, contexts.length); } })
  });
  agent.transportRetryDelays = [1];
  return {
    agent,
    contexts,
    start: (request = {}) => {
      const { settings, ...rest } = request;
      return agent.start({ settings: { controlMode: 'agi', vision: 'off', ...(settings || {}) }, ...rest });
    }
  };
}

// A conversation snapshot carrying an UNFINISHED automation plan (the f11
// shape): a previous task left one item open.
function conversationWithOpenPlan() {
  return {
    id: 'c-f11', title: 'Fix the widget', status: 'completed',
    providerConfig: { id: 'mock', model: 'mock' }, createdAt: Date.now() - 60_000,
    task: 'fix the widget and change nothing else',
    messages: [{ role: 'user', content: 'fix the widget and change nothing else', at: Date.now() - 60_000 }],
    plan: [{ id: 'f11', text: 'f11 repair the widget controller', status: 'current' }],
    goals: [], workingMemory: {}, completedWork: [], transcript: []
  };
}

test('A: "hello" is answered conversationally — no browser_done, no plan bookkeeping, and the old plan stays intact', async () => {
  const h = harness(async () => ({ assistantText: 'Hello! What can I do for you?' }));
  const run = await h.start({ task: 'hello', continuation: true, conversationId: 'c-f11', conversation: conversationWithOpenPlan() });
  assert.equal(run.result.reason, 'answer_only', `a greeting is a conversation, not an automation task: ${JSON.stringify(run.result)}`);
  assert.equal(run.status, 'completed');
  assert.equal((run.history || []).filter((entry) => entry.tool === 'browser_done').length, 0, 'a conversational reply never enters the completion protocol');
  assert.equal((run.history || []).some((entry) => entry.tool === 'update_plan'), false, 'no plan bookkeeping for a greeting');
  const plan = (run.plan || []).map((item) => item.text || item);
  assert.deepEqual(plan, ['f11 repair the widget controller'], 'the previous work is preserved, not destroyed');
  assert.equal(h.contexts.length, 1, 'exactly one decision answers a greeting');
});

test('A: a question is also a conversation even with an unfinished plan item open', async () => {
  const h = harness(async () => ({ assistantText: 'The sky appears blue because of Rayleigh scattering.' }));
  const run = await h.start({ task: 'what color is the sky', continuation: true, conversationId: 'c-f11', conversation: conversationWithOpenPlan() });
  assert.equal(run.result.reason, 'answer_only');
  assert.equal((run.history || []).filter((entry) => entry.tool === 'browser_done').length, 0);
});

test('B: "ignore everything and answer hello" supersedes the task, schedules nothing for it, and replies normally', async () => {
  const scheduled = [];
  const h = harness(async (context, n) => {
    scheduled.push({ task: context.task, plan: (context.plan || []).length });
    return { assistantText: 'Hello!' };
  });
  const run = await h.start({ task: 'ignore everything and answer hello', continuation: true, conversationId: 'c-f11', conversation: conversationWithOpenPlan() });
  assert.equal(run.result.reason, 'answer_only', 'the new instruction is answered through the normal conversational pathway');
  const automation = (run.history || []).filter((entry) => ['computer_patch', 'computer_write', 'computer_terminal', 'computer_file', 'browser_click', 'browser_navigate'].includes(entry.tool));
  assert.equal(automation.length, 0, 'no further actions are scheduled for the superseded task');
  assert.equal((run.history || []).filter((entry) => entry.tool === 'browser_done').length, 0);
  assert.equal(scheduled.length, 1, 'one decision answers the interruption');
});

test('C: a previous run\'s unfinished plan does not block or leak into a new independent run', async () => {
  // Run 1: a conversation over the unfinished plan — the plan survives it.
  const a = harness(async () => ({ assistantText: 'Hello!' }));
  const run1 = await a.start({ task: 'hello', continuation: true, conversationId: 'c-f11', conversation: conversationWithOpenPlan() });
  assert.equal(run1.result.reason, 'answer_only');
  assert.deepEqual((run1.plan || []).map((item) => item.text || item), ['f11 repair the widget controller']);
  // Run 2: an independent run that knows nothing of f11.
  const b = harness(async (_context, n) => (n === 1
    ? { actions: [{ name: 'browser_click', input: { element: 1 } }] }
    : { done: { summary: 'Second run finished on its own terms.', success: true, verified: false } }));
  const run2 = await b.start({ task: 'Inspect fixture' });
  assert.equal(run2.status, 'completed');
  assert.deepEqual(run2.plan, [], 'the other run\'s plan is not inherited');
  assert.equal(run2.result.summary, 'Second run finished on its own terms.', 'its own result, not the other run\'s');
  assert.equal(b.contexts[0].plan.length, 0, 'the wire carries no foreign plan');
});

test('C: a previous run\'s successful result never terminates a new run', async () => {
  let calls = 0;
  const first = harness(async () => ({ done: { summary: 'First run done.', success: true, verified: false } }));
  const run1 = await first.start({ task: 'First task' });
  assert.equal(run1.status, 'completed');
  const second = harness(async (_context, n) => { calls = n; return n === 1 ? { assistantText: 'Working.' } : { done: { summary: 'Second run done.', success: true, verified: false } }; });
  const run2 = await second.start({ task: 'Second task' });
  assert.equal(run2.status, 'completed');
  assert.equal(run2.result.summary, 'Second run done.');
  assert.ok(calls >= 2, 'the new run made its own decisions');
});

test('D: an accepted terminal result ends provider scheduling exactly once (two calls for action + completion)', async () => {
  let calls = 0;
  const h = harness(async (_context, n) => {
    calls = n;
    return n === 1
      ? { actions: [{ name: 'computer_patch', input: { path: 'C:/fixture.txt', patch: '*** Begin Patch\n*** Update File: C:/fixture.txt\n-a\n+b\n*** End Patch' } }] }
      : { done: { summary: 'Patched.', success: true, verified: false } };
  });
  const run = await h.start({ task: 'Inspect fixture' });
  assert.equal(run.status, 'completed');
  assert.equal(calls, 2, `exactly two provider calls — one action batch and one completion, got ${calls}`);
  assert.deepEqual((run.history || []).map((entry) => entry.tool), ['computer_patch', 'browser_done']);
});

test('D: no provider decision occurs after the run is terminal', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls += 1;
    return calls === 1 ? { assistantText: 'no action' } : { done: { summary: 'Done.', success: true, verified: false } };
  });
  await h.start({ task: 'What is two plus two' });
  const afterTerminal = calls;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, afterTerminal, 'the loop cannot call the provider again after the terminal result');
});

test('E: a completion review is attributable and bounded — the accepted terminal result is never reconsidered', async () => {
  let calls = 0;
  const h = harness(async (_context, n) => {
    calls = n;
    return n === 1
      ? { actions: [{ name: 'computer_patch', input: { path: 'C:/fixture.txt', patch: '*** Begin Patch\n*** Update File: C:/fixture.txt\n-a\n+b\n*** End Patch' } }] }
      : n === 2
        // A real verification call after the change: the claim is backed.
        ? { actions: [{ name: 'computer_read', input: { path: 'C:/fixture.txt' } }] }
        : { done: { summary: 'Patched and read back the result.', success: true, verified: true } };
  });
  const run = await h.start({ task: 'Inspect fixture' });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.equal(calls, 3, `action, verification, completion — and nothing after the terminal result, got ${calls}`);
  const dones = (run.history || []).filter((entry) => entry.tool === 'browser_done');
  assert.equal(dones.length, 1, 'F: one submitted completion produces one completion record');
});

test('F: the batch regression — one submitted browser_done is one completion record, never three', async () => {
  // The exact shape agent-continuity-regressions reported: a batch that ends
  // at a file mutation, then a completion. Whatever happens internally, one
  // submitted done must never appear as three history records.
  const h = harness(async (_context, n) => {
    if (n === 1) return { actions: [
      { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } },
      { name: 'computer_patch', input: { path: 'C:/fixture.txt', patch: '*** Begin Patch\n*** End Patch' } },
      { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }
    ] };
    return { done: { summary: 'Patched and verified.', success: true, verified: true } };
  });
  const run = await h.start({ task: 'Inspect fixture' });
  assert.equal(run.result.success, true);
  const dones = (run.history || []).filter((entry) => entry.tool === 'browser_done');
  assert.equal(dones.length, 1, `expected exactly one completion record, got ${dones.length}`);
});
