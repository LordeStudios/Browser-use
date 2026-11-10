// Deterministic harness plumbing tests for the browser_wait fix. These
// validate the executor, not model quality: model decisions here are scripted.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent, ACTIONS, MAX_BROWSER_WAIT_MS } = require('../desktop/agent/desktopChatAgent.cjs');

function createController({ loadingMs = 0 } = {}) {
  const calls = [];
  const startedAt = Date.now();
  return {
    calls,
    navigationState(tabId) {
      calls.push(['navigationState', tabId]);
      return { tabId, url: 'https://example.test/', loading: Date.now() - startedAt < loadingMs };
    },
    async domSnapshot(tabId) {
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
}

function decision(call) {
  return { toolCalls: [call] };
}

async function runAgent({ controller, responses, settings = {} }) {
  const provider = {
    async complete() {
      const response = responses.shift();
      if (!response) throw new Error('No scripted model response remains');
      return response;
    }
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    getControlMode: () => 'browser',
    getComputerTools: () => null,
    emit: () => {},
    createProvider: () => provider
  });
  const run = await agent.start({ task: 'Fixture wait task', settings: { controlMode: 'browser', approvalMode: 'unattended', ...settings } });
  return run;
}

test('first wait honors the exact requested ms', async () => {
  const controller = createController();
  const startedAt = Date.now();
  const run = await runAgent({
    controller,
    responses: [decision({ name: 'browser_wait', input: { ms: 40 } }), { done: { summary: 'Waited once.', success: true, verified: true } }]
  });
  const waitRecord = run.history.find(entry => entry.tool === 'browser_wait');
  assert.ok(waitRecord, 'the wait executed');
  assert.equal(waitRecord.output.result.requestedMs, 40);
  assert.equal(waitRecord.output.result.consecutiveWaits, 1);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 400, `first wait must not inflate to the old 500ms floor (took ${elapsed}ms)`);
});

test('a batched wait returns early once navigation settles', async () => {
  // The realistic early-exit case: navigate and wait in ONE decision. Navigate
  // returns at main-frame commit while the page still loads; the wait must
  // return as soon as loading settles instead of sleeping its full ms.
  const startedAt = Date.now();
  const controller = {
    calls: [],
    navigationState(tabId) {
      return { tabId, url: 'https://example.test/', loading: Date.now() < navigationLoadsUntil };
    },
    async domSnapshot(tabId) {
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async navigate(tabId, url) {
      controller.calls.push(['navigate', url]);
      // The slow page loads for 900ms after this commit.
      navigationLoadsUntil = Date.now() + 900;
      return { tabId, url, loading: true };
    },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
  let navigationLoadsUntil = startedAt;
  const run = await runAgent({
    controller,
    responses: [
      { toolCalls: [{ name: 'browser_navigate', input: { url: 'https://example.test/slow' } }, { name: 'browser_wait', input: { ms: 10_000 } }] },
      { done: { summary: 'Navigation settled.', success: true, verified: true } }
    ]
  });
  const waitRecord = run.history.find(entry => entry.tool === 'browser_wait');
  assert.ok(waitRecord, 'the wait executed');
  assert.ok(waitRecord.output.ok, 'the wait succeeded');
  assert.equal(waitRecord.output.result.settled, true);
  assert.ok(waitRecord.output.result.waitedMs < 9_000, `the wait must not outlive a settled page (took ${waitRecord.output.result.waitedMs}ms)`);
});;

test('a repeated short wait is still escalated, and requestedMs stays truthful', async () => {
  const controller = createController();
  const run = await runAgent({
    controller,
    responses: [
      decision({ name: 'browser_wait', input: { ms: 20 } }),
      decision({ name: 'browser_wait', input: { ms: 20 } }),
      { done: { summary: 'Waited twice.', success: true, verified: true } }
    ]
  });
  const waits = run.history.filter(entry => entry.tool === 'browser_wait');
  assert.equal(waits.length, 2);
  assert.equal(waits[0].output.result.consecutiveWaits, 1);
  assert.ok(Math.abs(waits[0].output.result.waitedMs - 20) <= 40, `first wait sleeps what the model asked (${waits[0].output.result.waitedMs}ms)`);
  assert.equal(waits[1].output.result.consecutiveWaits, 2);
  assert.ok(waits[1].output.result.waitedMs >= 500, 'the second consecutive wait is escalated to the 500ms floor');
  assert.equal(waits[1].output.result.requestedMs, 20, 'requestedMs reports what the model asked, not the clamp');
});

test('a wait that ends with the page still loading reports stillLoading', async () => {
  const controller = createController({ loadingMs: 60_000 });
  const run = await runAgent({
    controller,
    responses: [decision({ name: 'browser_wait', input: { ms: 30 } }), { done: { summary: 'The page is still loading after the wait.', success: true, verified: true } }]
  });
  const waitRecord = run.history.find(entry => entry.tool === 'browser_wait');
  assert.equal(waitRecord.output.result.stillLoading, true);
  assert.match(String(waitRecord.output.result.note || ''), /still loading/i);
});

test('pure-wait decisions are counted as wait turns, not decisions', async () => {
  // Waits are patience, not decision burn: they count against waitTurns, and
  // only the final done decision is counted as a model decision.
  const controller = createController();
  const run = await runAgent({
    controller,
    responses: [
      decision({ name: 'browser_wait', input: { ms: 15 } }),
      decision({ name: 'browser_wait', input: { ms: 15 } }),
      { done: { summary: 'The awaited job finished.', success: true, verified: true } }
    ]
  });
  assert.equal(run.result.reason, undefined);
  assert.equal(run.result.success, true);
  assert.equal(run.waitTurns, 2, 'both waits were recorded as wait turns');
  assert.equal(run.decisionCount, 1, 'only the done decision was counted as a decision');
});

test('browser_wait is bounded by the 15-minute cap and the invalid-value error says so', async () => {
  // A model-chosen duration up to 15 minutes is accepted (the run would
  // genuinely sleep that long, so the long path is covered by the contract
  // value, not a real 15-minute sleep in tests).
  assert.equal(MAX_BROWSER_WAIT_MS, 900_000);
  const controller = createController();
  const run = await runAgent({
    controller,
    responses: [
      decision({ name: 'browser_wait', input: { ms: 0 } }),
      { done: { summary: 'Explained the cap.', success: true, verified: true } }
    ]
  });
  const waitRecord = run.history.find(entry => entry.tool === 'browser_wait');
  assert.equal(waitRecord.output.ok, false, 'invalid values are rejected honestly');
  assert.match(waitRecord.output.error, /900000/, 'the rejection states the real 15-minute cap');
});

test('steering accepts a plan edit, rewrites the live plan and delivers the notice', async () => {
  const controller = createController();
  const resolvers = [];
  const provider = { complete: () => new Promise((resolve) => resolvers.push(resolve)) };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    getControlMode: () => 'browser',
    getComputerTools: () => null,
    emit: () => {},
    createProvider: () => provider
  });
  const runPromise = agent.start({ task: 'Plan edit fixture', settings: { controlMode: 'browser', approvalMode: 'unattended' } });
  const deadline = Date.now() + 5_000;
  while (resolvers.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(resolvers.length, 'the first decision is pending');
  const runId = agent.run.id;
  const steerResult = agent.steer({ runId, plan: [{ text: 'Done step', status: 'done' }, { text: 'Removed step', status: 'skipped' }] });
  assert.equal(steerResult.status, 'queued');
  assert.equal(agent.run.plan.length, 2);
  assert.equal(agent.run.plan[0].status, 'done');
  assert.equal(agent.run.plan[1].status, 'skipped');
  // The first (done) decision is discarded because steering arrived; the run
  // delivers the plan notice at the model boundary and re-decides.
  resolvers[0]({ done: { summary: 'Premature completion.', success: true, verified: true } });
  const secondDeadline = Date.now() + 5_000;
  while (resolvers.length < 2 && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(resolvers.length >= 2, 'the run re-decided after delivering the plan edit');
  resolvers[1]({ done: { summary: 'Finished under the edited plan.', success: true, verified: true } });
  const finished = await runPromise;
  assert.equal(finished.result.success, true);
  assert.equal(finished.plan.length, 2, 'the edited plan survives to the end of the run');
  const notice = finished.messages.find((message) => String(message.content).includes('edited the working plan'));
  assert.ok(notice, 'the plan-edit notice reached the model as a delivered message');
  assert.match(notice.content, /\[done\] Done step/);
  assert.match(notice.content, /\[skipped\] Removed step/);
});

test('steering accepts a goals edit, rewrites the live goals and delivers the notice', async () => {
  const controller = createController();
  const resolvers = [];
  const provider = { complete: () => new Promise((resolve) => resolvers.push(resolve)) };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    getControlMode: () => 'browser',
    getComputerTools: () => null,
    emit: () => {},
    createProvider: () => provider
  });
  const runPromise = agent.start({ task: 'Goal edit fixture', settings: { controlMode: 'browser', approvalMode: 'unattended' } });
  const deadline = Date.now() + 5_000;
  while (resolvers.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(resolvers.length, 'the first decision is pending');
  const steerResult = agent.steer({ runId: agent.run.id, goals: [{ text: 'Reached goal', status: 'done' }, { text: 'Dropped goal', status: 'skipped' }] });
  assert.equal(steerResult.status, 'queued');
  assert.equal(agent.run.goals.length, 2);
  assert.equal(agent.run.goals[0].status, 'done');
  assert.equal(agent.run.goals[1].status, 'skipped');
  resolvers[0]({ done: { summary: 'Premature completion.', success: true, verified: true } });
  const secondDeadline = Date.now() + 5_000;
  while (resolvers.length < 2 && Date.now() < secondDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(resolvers.length >= 2, 'the run re-decided after delivering the goals edit');
  resolvers[1]({ done: { summary: 'Finished under the edited goals.', success: true, verified: true } });
  const finished = await runPromise;
  assert.equal(finished.result.success, true);
  assert.equal(finished.goals.length, 2, 'the edited goals survive to the end of the run');
  const notice = finished.messages.find((message) => String(message.content).includes('edited the goals'));
  assert.ok(notice, 'the goals-edit notice reached the model as a delivered message');
  assert.match(notice.content, /\[done\] Reached goal/);
  assert.match(notice.content, /\[skipped\] Dropped goal/);
});

test('new tool registration is consistent across the surfaces', () => {
  for (const name of ['browser_search', 'browser_fetch', 'schedule_task', 'task_spawn']) {
    assert.equal(ACTIONS[name]?.risk, 'read', `${name} is registered as a read-risk chat tool`);
  }
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  assert.equal(typeof BrowserViewController.prototype.search, 'function');
  assert.equal(typeof BrowserViewController.prototype.fetchPage, 'function');
});
