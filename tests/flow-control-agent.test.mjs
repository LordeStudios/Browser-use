import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obs = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Name field' }] } };

// Mirrors the enforcement-gen2 harness: scripted provider + fake computer backend.
function harness(complete, execute) {
  let calls = 0;
  const controller = { navigationState: () => obs.navigation, domSnapshot: () => obs.dom, consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend, emit() {}, createProvider: () => ({ complete: (ctx) => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, start: (extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off' }, ...extra }) };
}

const readResult = (path, from, to, content = 'same file body', hash = 'h1') => ({ ok: true, tool: 'computer_read', path, totalLines: 400, fromLine: from, toLine: to, lines: to - from + 1, content, workspace: { hash } });

const notices = (seen) => seen.flatMap((entry) => (Array.isArray(entry) ? entry : []));

test('a multi-part task gets one plan notice and is still free to act without update_plan', async () => {
  const seen = [];
  const executed = [];
  const h = harness((ctx, n) => {
    seen.push(ctx.harnessNotices || null);
    if (n === 1) return { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js' } }] };
    return final;
  }, async (name) => { if (name !== 'computer_window') executed.push(name); return name === 'computer_window' ? { windows: [] } : readResult('C:/repo/a.js', 1, 20); });
  const run = await h.start({ task: 'Read a.js and then summarize it' });
  assert.equal(run.result.success, true);
  assert.deepEqual(executed, ['computer_read'], 'the model acted with no plan');
  assert.equal(run.plan.length, 0, 'the harness never fabricates a plan');
  const planNotices = notices(seen).filter((line) => /multi-part task/.test(line) && /update_plan/.test(line));
  assert.equal(planNotices.length, 1, 'exactly one startup plan notice');
});

test('a single-step task gets no plan notice', async () => {
  const seen = [];
  const h = harness((ctx) => { seen.push(ctx.harnessNotices || null); return final; }, async () => readResult('C:/repo/a.js', 1, 5));
  await h.start({ task: 'Inspect fixture' });
  assert.equal(notices(seen).some((line) => /update_plan/.test(line)), false);
});

test('"enough evidence" with no action arms a next-decision notice and the call is never blocked', async () => {
  const seen = [];
  const h = harness((ctx, n) => {
    seen.push(ctx.harnessNotices || null);
    if (n === 1) return { assistantText: 'The evidence is sufficient and the cause is clear, but let me think about it more.' };
    return final;
  }, async () => readResult('C:/repo/a.js', 1, 5));
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(notices(seen.slice(1)).some((line) => /evidence is sufficient/i.test(line) && /update_plan/.test(line) && /smallest grounded/.test(line)), 'the exits are named in the next decision');
});

test('thinking-as-plan on a multi-part task is told that a thought-list is not a plan', async () => {
  const seen = [];
  const h = harness((ctx, n) => {
    seen.push(ctx.harnessNotices || null);
    if (n === 1) return { assistantText: 'First I will inspect the file, then I will patch the bug, finally I will run the tests to verify.' };
    return final;
  }, async () => readResult('C:/repo/a.js', 1, 5));
  const run = await h.start({ task: 'Inspect the file and then fix the bug' });
  assert.equal(run.result.success, true);
  assert.ok(notices(seen.slice(1)).some((line) => /does not create a plan/i.test(line) || /not a harness-owned plan/i.test(line)));
  assert.equal(run.plan.length, 0, 'narration is never promoted to a plan');
});

test('varied offsets over unchanged content run, then advise, then bounce exactly once', async () => {
  const seen = [];
  const executed = [];
  let turn = 0;
  const h = harness((ctx) => {
    seen.push(ctx.harnessNotices || null);
    turn += 1;
    if (turn <= 8) return { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js', offset: 1 + turn * 2, limit: 40 } }] };
    return final;
  }, async (name, input) => {
    // The agent also probes computer_window on its own; only count the reads under test.
    if (name !== 'computer_read') return { windows: [] };
    executed.push(input.offset);
    return readResult('C:/repo/a.js', input.offset, input.offset + 39);
  });
  const run = await h.start({ task: 'Inspect a.js' });
  assert.equal(run.result.success, true);
  assert.equal(executed.length, 8, 'every varied read still executed — nothing was rejected');
  assert.ok(notices(seen).some((line) => /little new or relevant evidence/.test(line)), 'an advisory precedes the bounce');
  const bounces = run.history.filter((entry) => entry.tool === 'agent_advisory' && entry.input?.source === 'evidence_repetition');
  assert.equal(bounces.length, 1, 'one bounded bounce for the evidence epoch');
});

test('an edit opens a new evidence epoch so the post-edit re-read is fresh and resets the streak', async () => {
  let turn = 0;
  const h = harness(() => {
    turn += 1;
    if (turn <= 3) return { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js', offset: 1, limit: 40 } }] };
    if (turn === 4) return { actions: [{ name: 'computer_patch', input: { path: 'C:/repo/a.js', patch: '*** Begin Patch\n*** Update File: C:/repo/a.js\n@@\n-a\n+b\n*** End Patch' } }] };
    if (turn === 5) return { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js', offset: 1, limit: 40 } }] };
    return final;
  }, async (name, input) => (name === 'computer_patch'
    ? { applied: true, files: [{ path: 'C:/repo/a.js', changed: true }] }
    : readResult('C:/repo/a.js', 1, 40)));
  const run = await h.start({ task: 'Inspect a.js' });
  assert.equal(run.result.success, true);
  assert.ok(run.flowControl.evidenceEpoch >= 2, 'the edit opened a new epoch');
  assert.equal(run.flowControl.lowYieldStreak, 0, 'the post-edit re-read counted as fresh evidence');
  assert.equal(run.history.filter((entry) => entry.input?.source === 'evidence_repetition').length, 0, 'no bounce for a legitimate re-read');
});

test('normal-size thinking stays silent; elevated and heavy thinking escalate the notice', async () => {
  const run = async (thought) => {
    const seen = [];
    const h = harness((ctx, n) => {
      seen.push(ctx.harnessNotices || null);
      if (n === 1) { if (thought) ctx.onThought(thought); return { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js' } }] }; }
      return final;
    }, async () => readResult('C:/repo/a.js', 1, 5));
    await h.start({});
    return notices(seen);
  };
  assert.equal((await run('short reasoning about the next read')).length, 0, 'normal thinking is never interrupted or advised');
  const elevated = await run('r'.repeat(5_000));
  assert.ok(elevated.some((line) => /keep thinking only if/i.test(line)) && !elevated.some((line) => /very large thinking budget/.test(line)));
  const heavy = await run('r'.repeat(17_000));
  assert.ok(heavy.some((line) => /very large thinking budget/.test(line)), 'the heavy tier is distinct');
});

test('flow notices survive the 300-char provider bound and ride through boundedRequestContext', () => {
  const { NOTICE_TEXT, thinkingBudgetNotice } = require('../desktop/agent/flowControlState.cjs');
  const lines = [NOTICE_TEXT.evidenceClaim, NOTICE_TEXT.planNarration, NOTICE_TEXT.lowYield, thinkingBudgetNotice(2)];
  const context = boundedRequestContext({ task: 't', harnessNotices: lines });
  assert.equal(context.harnessNotices.length, 4);
  context.harnessNotices.forEach((line, i) => assert.equal(line, lines[i], `notice ${i} was not clipped`));
});

test('flow state is checkpointed with the run and an old snapshot without it restores cleanly', async () => {
  const h = harness((ctx, n) => (n === 1 ? { actions: [{ name: 'computer_read', input: { path: 'C:/repo/a.js' } }] } : final), async () => readResult('C:/repo/a.js', 1, 5));
  const run = await h.start({});
  assert.ok(run.flowControl && Array.isArray(run.flowControl.evidence));
  assert.ok(run.flowControl.decisionNumber >= 1);
  const { createFlowControlState } = require('../desktop/agent/flowControlState.cjs');
  assert.equal(createFlowControlState(undefined).phase, 'inspect');
  const serialized = JSON.parse(JSON.stringify({ ...run.flowControl }));
  assert.equal(createFlowControlState(serialized).evidenceEpoch, run.flowControl.evidenceEpoch);
});
