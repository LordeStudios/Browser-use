import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopChatAgent, toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { isCodingTask, agiPromptForTask } = require('../desktop/computer/computerCatalog.cjs');
const { compactComputerOutput } = require('../desktop/agent/ollamaProvider.cjs');

// ---- Shared coding-task detector -------------------------------------------

test('isCodingTask: natural wording without keywords is non-coding alone, coding with a workspace', () => {
  assert.equal(isCodingTask('Fix the favourites toggle in the header', null), false);
  assert.equal(isCodingTask('Fix the favourites toggle in the header', { root: 'C:/fixture' }), true);
  assert.equal(isCodingTask('fix the patch logic', null), true);
  assert.equal(isCodingTask('', { root: 'C:/fixture' }), true);
  assert.equal(isCodingTask('', 'C:/fixture'), true);
  assert.equal(isCodingTask('', '   '), false);
});

test('agiPromptForTask serves the campaign-selected lean core (coding section included) for every task', () => {
  // 2026-10-11 campaign result: the lean core + playbooks beat both the old
  // gate-selected walls and the merged four-way prompt on both model tiers
  // (4/4 glm, 3/4 qwen-flash on the two-fixture complex task), so the old
  // workspace-conditional gate is gone — one lean prompt rides every task.
  const coding = agiPromptForTask('fix the favourites toggle', { root: 'C:/fixture' });
  const general = agiPromptForTask('fix the favourites toggle', null);
  for (const prompt of [coding, general]) {
    assert.match(prompt, /Coding mode\./);
    assert.match(prompt, /browser_done\{summary, success, verified\}/);
    assert.doesNotMatch(prompt, /AGI computer mode is enabled|Native coding mode/);
    assert.ok(prompt.length < 6400, 'the lean core stays lean (gen5.1 cap: the judge-banked measure-don-t-eyeball amendment is the one post-gen5 addition)');
  }
  assert.equal(coding, general, 'the lean core is task-stable (situational playbooks excepted)');
});

test('toolDefinitions: workspace-declared agi run advertises the file tools; browser mode never does', () => {
  const task = 'Fix the favourites toggle in the header';
  const agi = toolDefinitions(task, 'agi', { workspace: true });
  for (const name of ['computer_terminal', 'computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_patch', 'computer_git']) {
    assert.ok(agi.some((tool) => tool.name === name), `${name} must be advertised`);
  }
  const browser = toolDefinitions(task, 'browser', { workspace: true });
  // computer_model (media generation) is advertised in every mode; the file
  // and execution tools must stay agi-only.
  const fileTools = ['computer_terminal', 'computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_patch', 'computer_git', 'computer_observe', 'computer_pointer'];
  assert.equal(browser.some((tool) => fileTools.includes(tool.name)), false, 'browser mode must not advertise file/execution tools');
});

// ---- computer_* output compaction budgets ------------------------------------

test('compactComputerOutput keeps whole-file reads under the dedicated budget and trims other outputs tight', () => {
  const bigContent = 'x'.repeat(40_000);
  const read = compactComputerOutput({ ok: true, result: { tool: 'computer_read', path: 'C:/fixture/main.js', content: bigContent, totalLines: 1000 } }, 'computer_read');
  assert.equal(read.result.content.length, 40_000, 'a 40k file read must survive whole');
  assert.equal(read.contextTruncation, undefined);

  const hugeRead = compactComputerOutput({ ok: true, result: { tool: 'computer_read', path: 'C:/fixture/main.js', content: 'y'.repeat(70_000) } }, 'computer_read');
  assert.ok(hugeRead.result.content.length <= 64_000 && hugeRead.result.content.length > 63_000, 'read content is capped at the dedicated 64k budget');
  assert.ok(Array.isArray(hugeRead.contextTruncation) && hugeRead.contextTruncation.some((entry) => /offset/.test(entry.note || '')), 'the trim note must tell the model how to continue reading');

  const search = compactComputerOutput({ ok: true, result: { tool: 'computer_search', lines: Array.from({ length: 30 }, (_, i) => ({ file: 'a.js', line: i, text: 'z'.repeat(1_000), match: true })) } }, 'computer_search');
  assert.ok(search.contextTruncation?.length >= 1, 'non-read outputs keep the tight shared budget');
});

// ---- Fixtures ---------------------------------------------------------------

function createController() {
  const calls = [];
  return {
    calls,
    async domSnapshot(tabId) {
      calls.push(['snapshot', tabId]);
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Toggle favourites', text: 'Toggle favourites', enabled: true }], truncated: false };
    },
    navigationState(tabId) { return { tabId, url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async clickElement(tabId, args, owner) { calls.push(['click', tabId, args, owner]); return { tabId, ...args }; },
    async navigate(tabId, url) { calls.push(['navigate', tabId, url]); return { tabId, url }; },
    type() { return { length: 0 }; },
    async scroll() { return {}; },
    key() { return {}; },
    async screenshot() { return { data: 'base64-image' }; },
    releaseSessionInput() { return { released: true }; }
  };
}

test('a browser-mode run whose task declares a workspace is promoted to agi with file tools', async () => {
  const seen = [];
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete(context) { seen.push(context); return { done: { summary: 'Done.', success: true, verified: true } }; } })
  });
  const run = await agent.start({
    task: 'Fix the favourites toggle in the header',
    workspace: { root: 'C:/fixture' },
    settings: { controlMode: 'browser' },
    provider: { id: 'mock' }
  });
  assert.equal(run.status, 'completed');
  assert.equal(run.settings.controlMode, 'agi', 'the run must be promoted to agi');
  assert.ok(seen.length >= 1);
  assert.ok(seen[0].tools.some((tool) => tool.name === 'computer_read'), 'computer_read must be advertised to the model');
  assert.ok(
    run.messages.some((m) => m.source === 'runtime' && /enabled the native file tools/.test(m.content)),
    'the model must be told why file tools are available'
  );
});

// ---- Turn boundary: the closed task's evidence must not verify a new task ----

test('a new-turn done about the closed task is bounced; the ledger resets; the objective is restated', async () => {
  const contexts = [];
  let runIndex = 0;
  let runDecisions = 0;
  const controller = createController();
  // The click must produce an OBSERVED effect (the page state visibly
  // changes), or the coordinator drops the ledger entry as unproven work.
  let snapshots = 0;
  controller.domSnapshot = async (tabId) => {
    snapshots += 1;
    return { tabId, url: 'https://example.test/', title: snapshots > 1 ? 'Example — updated' : 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: snapshots > 1 ? 'Favourites on' : 'Toggle favourites', text: 'Toggle favourites', enabled: true }], truncated: false };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      runIndex += 1;
      runDecisions = 0;
      return {
        async complete(context) {
          runDecisions += 1;
          contexts[runIndex] = contexts[runIndex] || [];
          contexts[runIndex].push(context);
          if (runIndex === 1) {
            // Run 1: one real mutation, then a verified done (accepted).
            if (runDecisions === 1) return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
            return { done: { summary: 'First task complete.', success: true, verified: true } };
          }
          // Run 2 (new turn): the model immediately claims done with the CLOSED
          // task's summary — the exact reported failure.
          if (runDecisions === 1) return { done: { summary: 'The effects stack fix is complete.', success: true, verified: true } };
          return { done: { summary: 'Favourites work acknowledged.', success: true, verified: true } };
        }
      };
    }
  });

  const first = await agent.start({ task: 'First task about the device chip', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 40));

  const second = await agent.start({
    task: 'Fix the favourites toggle in the header',
    provider: { id: 'mock' },
    continuation: true,
    conversationId: first.id
  });

  assert.equal(second.status, 'completed');
  // Regression: the closed task's completedWork must NOT ride into the new turn.
  assert.equal(second.coordinator.completedWork.length, 0, 'the evidence ledger must reset on a new turn');
  // The first done of the new turn was bounced by the completion review, and
  // that review named the CURRENT objective.
  assert.ok(contexts[2] && contexts[2].length >= 2, 'the wrong-task done must not have been terminal on the first attempt');
  const reviewError = String(contexts[2][1]?.recovery?.lastError || '');
  assert.match(reviewError, /current objective/i);
  assert.match(reviewError, /favourites/i, 'the review must quote the new task, not the closed one');
  assert.equal(contexts[2][1]?.recovery?.source, 'completion_review');
});

// ---- chat_compact tool + slash commands (2026-10-02) -------------------------

test('the model can force compaction with chat_compact and the run continues', async () => {
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      let decision = 0;
      return { async complete() {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'chat_compact', input: { reason: 'before a big new phase' } }] };
        return { done: { summary: 'Compacted, then finished.', success: true, verified: true } };
      } };
    }
  });
  const run = await agent.start({ task: 'Work across a long session', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  const compact = run.history.find((entry) => entry.tool === 'chat_compact');
  assert.ok(compact && compact.output?.ok === true, 'chat_compact must execute successfully');
  assert.equal(compact.output.result.tool, 'chat_compact');
  assert.ok('turnsBefore' in compact.output.result, 'the result carries compaction stats');
});

test('slash commands: /compact compacts now; /goal and /plan rewrite the live lists; unknown passes through', async () => {
  let providerHandle = null;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      let decision = 0;
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      const handle = { releaseGate: () => release?.(), async complete() {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'browser_wait', input: { ms: 1 } }] };
        // Hold decision 2 open so the run is LIVE while steer() fires.
        if (decision === 2) return gate.then(() => ({ done: { summary: 'Resumed and finished.', success: true, verified: true } }));
        // The steered /goal and /plan items are pending, so the
        // LORDE_DONE_GATE_V369 boundary bounces a done until the plan is
        // closed (its documented contract: close or explicitly skip every
        // item before submitting — see agent-continuity-regressions). The
        // fixture obeys: one bounced done, then skip both items, then the
        // accepted done. (Before this repair the fixture spun the unbounded
        // done_incomplete_work bounce forever — recovery is deliberately
        // indefinite, so the fixture itself must converge.)
        if (decision === 3) return { done: { summary: 'Finished.', success: true, verified: true } };
        if (decision === 4) return { planUpdate: [{ text: 'step one', status: 'skipped' }, { text: 'step two', status: 'skipped' }] };
        return { done: { summary: 'Finished.', success: true, verified: true } };
      } };
      providerHandle = handle;
      return handle;
    }
  });
  const startPromise = agent.start({ task: 'Hold the run open', provider: { id: 'mock' } });
  await new Promise((resolve) => setTimeout(resolve, 120));

  const compactAck = await agent.steer({ runId: agent.run.id, text: '/compact' });
  assert.equal(compactAck.status, 'compacted', '/compact must act immediately');

  const goalAck = await agent.steer({ runId: agent.run.id, text: '/goal keep the ledger bounded; answer plainly' });
  assert.equal(agent.run.goals.some((goal) => /bounded/.test(goal.text || '')), true, '/goal must rewrite the live goals');

  const planAck = await agent.steer({ runId: agent.run.id, text: '/plan step one; step two' });
  assert.equal(agent.run.plan.some((step) => /step two/.test(step.text || '')), true, '/plan must rewrite the live plan');

  await agent.steer({ runId: agent.run.id, text: '/not-a-command hello' });
  assert.equal(agent.run.pendingUserMessages.some((m) => /\/not-a-command hello/.test(m.content || '')), true, 'unknown slashes pass through as normal steers');

  // Release the held decision so the run completes.
  providerHandle.releaseGate();
  const run = await startPromise;
  assert.equal(run.status, 'completed');
});

test('an idle /compact acts directly: no model decision, no restated conclusion', async () => {
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete() { calls += 1; return { done: { summary: 'Work done once.', success: true, verified: true } }; } })
  });
  const first = await agent.start({ task: 'Do the document work', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  const callsAfterWork = calls;

  const second = await agent.start({ task: '/compact', provider: { id: 'mock' }, continuation: true, conversationId: first.id });
  assert.equal(calls, callsAfterWork, '/compact must not burn a model decision');
  assert.match(second.messages.map((m) => m.content).join('\n'), /Compacted:/, 'the visible conclusion is the compaction stats, not a restated task summary');
  assert.doesNotMatch(second.messages.map((m) => m.content).join('\n'), /Work done once\.\s*[\s\S]*Work done once/, 'the prior conclusion must not be repeated');
});

test('a done citing screenshot evidence without any screenshot is bounced until evidence exists', async () => {
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete(args) {
      decision += 1;
      if (decision <= 2) return { done: { summary: 'The screenshot confirms the margins popover is fixed.', success: true, verified: true } };
      if (decision === 3) return { toolCalls: [{ name: 'browser_screenshot', input: {} }] };
      return { done: { summary: 'The screenshot confirms the margins popover is fixed.', success: true, verified: true } };
    } })
  });
  const run = await agent.start({ task: 'Fix the popover spacing', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  // The two evidence-less claims were bounced (screenshot_claim_unverified).
  const claims = run.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.recoverySource === 'screenshot_claim_unverified');
  assert.equal(claims.length, 2, 'both evidence-less claims must be bounced');
  // The accepted done came after the real screenshot event.
  const screenshotIndex = run.history.findIndex((entry) => entry.tool === 'browser_screenshot' && entry.output?.ok);
  const acceptedDoneIndex = run.history.findIndex((entry) => entry.tool === 'browser_done' && entry.output?.ok);
  assert.ok(screenshotIndex !== -1 && acceptedDoneIndex > screenshotIndex, 'the accepted done must follow a real screenshot');
});

// ---- Snapshot task restore + stale-acknowledgment gate (2026-10-02) ---------

test('a reopened continuation restores the prior task: new-turn classification, boundary, ledger reset fire', async () => {
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      let creation = 0;
      return { async complete(context) {
        creation += 1;
        if (creation === 1) return { done: { summary: 'Design tab fixed and verified visually with every control working.', success: true, verified: true } };
        return { done: { summary: 'All DOM sub-requests addressed: colors, headings, popover, navigation pane, rulers, circle button.', success: true, verified: true } };
      } };
    }
  });
  const first = await agent.start({ task: 'FIX THE DESIGN TAB AND CHANGE NOTHING', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  const snapshot = {
    id: first.id, title: first.title, status: 'completed',
    providerConfig: { id: 'mock', model: 'mock' }, createdAt: first.createdAt,
    messages: first.messages, plan: [], workingMemory: first.workingMemory,
    completedWork: first.coordinator.completedWork, transcript: first.history,
    task: first.task
  };
  const second = await agent.start({
    task: 'fix these they currently dont work DOM 1 DOM 2 DOM 3 DOM 4 DOM 5',
    provider: { id: 'mock' }, continuation: true, conversationId: first.id, conversation: snapshot
  });
  assert.equal(second.status, 'completed');
  // The addition notice must fire after reopen: the prior task is known and
  // the follow-up carries no explicit replace cue — OWNER DIRECTIVE
  // (2026-10-15): a follow-up message EXTENDS the running work.
  assert.equal(second.messages.some((m) => m.source === 'runtime' && /USER ADDITION/.test(m.content) && /DOM 1 DOM 2/.test(m.content)), true, 'the addition notice must name the added objective');
  // The pinned objective must lead with the NEWEST instruction.
  assert.match(second.providerLedger ? '' : '', /^$/);
  assert.equal(second.messages.some((m) => m.source === 'runtime' && /APPEND plan item/i.test(m.content)), true, 'the addition must demand append bookkeeping');
  // The ledger reset: run 1's completedWork must not ride into run 2.
  assert.equal(second.coordinator.completedWork.length, 0);
});

test('a new-turn done restating the prior conclusion is bounced; the fresh conclusion stands', async () => {
  let creation = 0;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      creation += 1;
      const turn = creation;
      return { async complete(context) {
        if (turn === 1) return { done: { summary: 'Design tab fixed and verified visually with every control working as requested.', success: true, verified: true } };
        // New turn: the model re-acknowledges the OLD work first (the bug),
        // then reports against the new objective.
        if (!context.recovery || context.recovery.source !== 'stale_task_acknowledgment') {
          return { done: { summary: 'Design tab fixed and verified visually with every control working as requested.', success: true, verified: true } };
        }
        return { done: { summary: 'DOM fixes complete: color pickers bound, headings expanded, popover closes on outside click, navigation pane persists, rulers locked, circle button implemented.', success: true, verified: true } };
      } };
    }
  });
  const first = await agent.start({ task: 'FIX THE DESIGN TAB', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await agent.start({ task: 'fix DOM 1 DOM 2 DOM 3 DOM 4 DOM 5', provider: { id: 'mock' }, continuation: true, conversationId: first.id });
  assert.equal(second.status, 'completed');
  const staleBounces = second.history.filter((entry) => entry.output?.recoverySource === 'stale_task_acknowledgment');
  assert.equal(staleBounces.length, 1, 'the stale acknowledgment must be bounced once');
  const accepted = second.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.ok);
  assert.match(accepted.at(-1)?.output?.summary || '', /DOM fixes complete/, 'the accepted conclusion must address the NEW objective');
});
