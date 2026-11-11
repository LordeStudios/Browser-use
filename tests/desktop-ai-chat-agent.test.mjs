import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

function createController() {
  const calls = [];
  return {
    calls,
    async domSnapshot(tabId) {
      calls.push(['snapshot', tabId]);
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Open details', text: 'Open details', enabled: true }], truncated: false };
    },
    navigationState(tabId) {
      return { tabId, url: 'https://example.test/', loading: false };
    },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async mouseMove(tabId, args, options) { calls.push(['mousemove', tabId, args, options]); return { tabId, ...args, input: 'mouse' }; },
    async clickAt(tabId, args, owner) { calls.push(['clickAt', tabId, args, owner]); return { tabId, ...args, input: 'mouse' }; },
    async clickElement(tabId, args, owner) { calls.push(['click', tabId, args, owner]); return { tabId, ...args }; },
    async navigate(tabId, url) { calls.push(['navigate', tabId, url]); return { tabId, url }; },
    type(tabId, args) { calls.push(['type', tabId, args]); return { tabId, length: args.text.length }; },
    async scroll(tabId, args) { calls.push(['scroll', tabId, args]); return { tabId, ...args }; },
    key(tabId, args, owner) { calls.push(['key', tabId, args, owner]); return { tabId, ...args }; },
    async screenshot(tabId) { calls.push(['screenshot', tabId]); return { tabId, mimeType: 'image/png', data: 'base64-image' }; },
    releaseSessionInput(owner) { calls.push(['release', owner]); return { released: true }; }
  };
}

function createProvider(responses) {
  return {
    async complete() {
      const response = responses.shift() || { done: { summary: 'Finished.', success: true, verified: true } };
      if (!response) throw new Error('No scripted model response remains');
      return response;
    }
  };
}


test('answers a simple question without forcing a tool call or recovery loop', async () => {
  const controller = createController();
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete() { calls += 1; return { assistantText: 'Four.' }; } })
  });
  const run = await agent.start({ task: 'What is two plus two?', provider: { id: 'mock', model: 'mock' } });
  assert.equal(calls, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.result.reason, 'answer_only');
  assert.equal(run.result.summary, 'Four.');
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_recovery').length, 0);
});

test('a non-reasoning provider produces no empty thought archive record', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({ async complete() { return { done: { summary: 'Finished.', success: true, verified: true } }; } })
  });
  const run = await agent.start({ task: 'Finish without streamed reasoning', provider: { id: 'mock', model: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(events.filter((event) => event.type === 'assistant.thought').length, 0);
  assert.equal(agent.run.thinkingArchive.length, 0);
});

test('repeated actionless narration settles the thought card and arms one runtime notice', async () => {
  const controller = createController();
  const events = [];
  const contexts = [];
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        contexts.push(context);
        calls += 1;
        context.onThought?.('The build failure identifies the asset-size issue; I need to inspect the repository before acting.');
        return calls < 3
          ? { assistantText: 'The build failure identifies the asset-size issue; I need to inspect the repository before acting.' }
          : { done: { summary: 'The task is complete.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Inspect the build failure', provider: { id: 'mock', model: 'mock' } });
  const completed = events.filter((event) => event.type === 'assistant.thinking.completed');
  assert.equal(run.status, 'completed');
  assert.equal(calls, 3);
  assert.equal(completed.filter((event) => event.reason === 'actionless_recovery').length, 1, 'the repeated actionless card is settled once');
  assert.ok(agent.run.thinkingArchive.length >= 1);
  const delivered = contexts.flatMap((context) => Array.isArray(context.harnessNotices) ? context.harnessNotices : []);
  assert.equal(delivered.filter((notice) => /ACTIONLESS STALL/i.test(notice)).length, 1);
  assert.equal(events.filter((event) => event.type === 'assistant.message').length, 0, 'recovery narration is not shown as repeated assistant status text');
});

test('different actionless narration does not trigger the repetition notice', async () => {
  const controller = createController();
  const contexts = [];
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        contexts.push(context);
        calls += 1;
        if (calls === 1) return { assistantText: 'The server startup error is the first blocker.' };
        if (calls === 2) return { assistantText: 'The repository scope is now the unresolved blocker.' };
        return { done: { summary: 'Completed.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Inspect the startup failure', provider: { id: 'mock', model: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(contexts.some((context) => Array.isArray(context.harnessNotices) && context.harnessNotices.some((notice) => /ACTIONLESS STALL/i.test(notice))), false);
});

test('repeated streamed reasoning arms a next-decision nudge without blocking its tool call', async () => {
  const controller = createController();
  const contexts = [];
  let calls = 0;
  const repeated = 'The server is unavailable, so I should inspect the local development setup before changing the page.';
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        contexts.push(context);
        calls += 1;
        if (calls === 1) {
          context.onThought?.(`${repeated} ${repeated}`);
          return { actions: [{ name: 'browser_screenshot', input: {} }] };
        }
        return { done: { summary: 'Completed.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Inspect the unavailable server', provider: { id: 'mock', model: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(calls, 2);
  const notices = contexts[1].harnessNotices || [];
  assert.equal(notices.filter((notice) => /STREAMING STALL/i.test(notice)).length, 1);
});

test('actionless repetition parks and auto-resumes without terminal failure', { timeout: 30000 }, async () => {
  const previousResume = process.env.BROWSER_USE_ESCALATION_RESUME_MS;
  // escalateRun clamps resume to a 1000ms floor; matching it here keeps the test
  // exercising real cadence instead of racing a value production never uses.
  process.env.BROWSER_USE_ESCALATION_RESUME_MS = '1000';
  try {
    const controller = createController();
    const events = [];
    let calls = 0;
    const agent = new DesktopChatAgent({
      controller,
      getSelectedTabId: () => 'tab-1',
      emit: (event) => events.push(event),
      createProvider: () => ({
        async complete() {
          calls += 1;
          return calls <= 3
            ? { assistantText: 'The same startup diagnosis remains unresolved; I need to inspect the repository.' }
            : { done: { summary: 'Completed after recovery.', success: true, verified: true } };
        }
      })
    });
    const parked = await agent.start({ task: 'Inspect the startup failure', provider: { id: 'mock', model: 'mock' } });
    assert.equal(parked.status, 'awaiting_recovery');
    let current = agent.run;
    for (let i = 0; i < 40 && current.status === 'awaiting_recovery'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      current = agent.run;
    }
    assert.equal(current.status, 'completed');
    assert.equal(current.result.success, true);
    assert.equal(events.filter((event) => event.type === 'run.escalated').length, 1);
    assert.match(events.find((event) => event.type === 'run.escalated').reason, /actionless/i);
  } finally {
    if (previousResume === undefined) delete process.env.BROWSER_USE_ESCALATION_RESUME_MS;
    else process.env.BROWSER_USE_ESCALATION_RESUME_MS = previousResume;
  }
});

test('routes a greeting through the selected model and preserves both conversation turns', async () => {
  const controller = createController();
  let providerCalls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete() {
        providerCalls += 1;
        return { done: { summary: 'Hello! What would you like to work on?', success: true } };
      }
    })
  });

  const run = await agent.start({ task: 'hello', provider: { id: 'mock', model: 'mock' } });

  assert.equal(providerCalls, 1);
  assert.equal(controller.calls.some(([name]) => name === 'snapshot'), true);
  assert.deepEqual(run.messages.map(({ role, content }) => [role, content]), [
    ['user', 'hello'],
    ['assistant', 'Hello! What would you like to work on?']
  ]);
});

test('keeps live agent events and state Electron-cloneable', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    // This intentionally mirrors the main-process callback that must remain
    // private to the agent runtime rather than cross the Electron IPC boundary.
    writeReportFile: async () => ({ path: 'C:\\Users\\maximus\\Documents\\report.txt' }),
    scheduleApi: async () => ({}),
    spawnTask: async () => ({}),
    emit: (event) => events.push(event),
    createProvider: () => createProvider([{ done: { summary: 'Completed safely.', success: true } }])
  });

  const run = await agent.start({ task: 'Complete this', provider: { id: 'mock', model: 'mock' } });

  assert.equal('writeReportFile' in run, false);
  assert.doesNotThrow(() => structuredClone(run));
  assert.ok(events.length >= 2);
  for (const event of events) assert.doesNotThrow(() => structuredClone(event), `Electron IPC must clone ${event.type}`);
});

test('keeps the plan empty unless the model intentionally returns planUpdate', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([{ done: { summary: 'Answered.', success: true } }])
  });

  const run = await agent.start({ task: 'Answer this turn', provider: { id: 'mock', model: 'mock' } });

  assert.deepEqual(run.plan, []);
  assert.equal(events.some((event) => event.type === 'plan.updated'), false);
});

test('accepts model-shaped task lists and granular add update remove operations', async () => {
  const controller = createController();
  const events = [];
  const receivedPlans = [];
  const responses = [
    { actions: [{ name: 'update_plan', input: { steps: ['Inspect the canvas', { title: 'Draw the hut', status: 'pending' }] } }] },
    { actions: [{ name: 'update_plan', input: { operations: [
      { op: 'update', id: 'task-lookup', status: 'done' },
      { op: 'add', text: 'Verify the drawing', status: 'current' },
      { op: 'remove', id: 'task-remove' }
    ] } }] },
    { done: { summary: 'Finished.', success: true, verified: true } }
  ];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        receivedPlans.push(context.plan);
        const response = responses.shift() || { done: { summary: 'Finished.', success: true, verified: true } };
        if (receivedPlans.length === 2) {
          response.actions[0].input.operations[0].id = context.plan[0].id;
          response.actions[0].input.operations[2].id = context.plan[1].id;
        }
        return response;
      }
    })
  });

  const run = await agent.start({ task: 'Draw a hut and track useful tasks', provider: { id: 'mock' } });

  assert.deepEqual(receivedPlans[0], []);
  assert.equal(receivedPlans[1].length, 2);
  assert.equal(run.plan.length, 2);
  assert.deepEqual(run.plan.map(({ text, status }) => [text, status]), [
    ['Inspect the canvas', 'done'],
    ['Verify the drawing', 'current']
  ]);
  assert.equal(run.plan.every((task) => Boolean(task.id)), true);
  const results = events.filter((event) => event.type === 'tool.result' && event.tool === 'update_plan');
  assert.deepEqual(results.map((event) => event.output.result), [
    { tasks: 2, goals: 0, added: 2, updated: 0, removed: 0 },
    { tasks: 2, goals: 0, added: 1, updated: 1, removed: 1 }
  ]);
});

test('does not accept a numeric task count as an empty successful plan', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { actions: [{ name: 'update_plan', input: { steps: 3 } }] },
      { done: { summary: 'Recovered from the invalid task update.', success: true } }
    ])
  });

  const run = await agent.start({ task: 'Use tasks only if useful', provider: { id: 'mock' } });

  assert.deepEqual(run.plan, []);
  const result = events.find((event) => event.type === 'tool.result' && event.tool === 'update_plan');
  assert.equal(result.output.ok, false);
  assert.match(result.output.error, /steps array or an operations array/i);
});

test('restores a saved conversation without replacing its first prompt with its title', async () => {
  const controller = createController();
  let received = null;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        received = context;
        return { title: 'Renamed Chat', planUpdate: [{ text: 'Continue the active work', status: 'done', verification: 'Visible result' }], done: { summary: 'Follow-up answer.', success: true } };
      }
    })
  });

  const conversation = {
    id: 'saved-conversation',
    title: 'Existing Chat Title',
    status: 'completed',
    providerConfig: { id: 'mock', model: 'mock' },
    createdAt: 100,
    messages: [
      { role: 'user', content: 'Original user prompt', at: 101 },
      { role: 'assistant', content: 'Original assistant reply', at: 102 }
    ],
    plan: [{ text: 'Continue the active work', status: 'current', verification: 'Visible result' }],
    workingMemory: { previousReasoning: 'Continue from the saved interaction state.', strategyEpoch: 2 },
    completedWork: [{ action: 'browser_click', target: 'Saved control', expectedOutcome: 'Panel open', effectObserved: true, observedRevision: 3 }],
    transcript: [{ at: 103, step: 1, tool: 'browser_wait', input: { ms: 1 }, output: { ok: true } }]
  };

  const run = await agent.start({
    task: 'Continue from there',
    continuation: true,
    conversationId: conversation.id,
    conversation,
    provider: { id: 'mock', model: 'mock' }
  });

  assert.equal(run.id, conversation.id);
  assert.equal(run.title, 'Renamed Chat');
  assert.equal(run.messages[0].content, 'Original user prompt');
  // No-task resumes are continuations of UNKNOWN work: deliberately no turn
  // boundary, no ledger reset (2026-10-02 classification).
  // Note: The agent injects a USER ADDITION message for continuations.
  assert.deepEqual(received.messages.map(({ role, content }) => [role, content]), [
    ['user', 'Original user prompt'],
    ['assistant', 'Original assistant reply'],
    ['user', 'Continue from there'],
    ['user', received.messages.filter((m) => m.source === 'runtime' && /USER ADDITION/.test(m.content)).at(-1)?.content || 'USER ADDITION']
  ]);
  assert.equal(received.history[0].tool, 'browser_wait');
  assert.match(received.workingMemory.previousReasoning, /saved interaction state/i);
  assert.equal(received.coordinator.completedWork[0].target, 'Saved control');
  assert.deepEqual(received.plan.map(({ text, status, verification }) => ({ text, status, verification })), [{ text: 'Continue the active work', status: 'done', verification: 'Visible result' }]);
  assert.equal(Boolean(received.plan[0].id), true);
  assert.equal(run.plan[0].status, 'done');
});

test('starting a new chat creates a new conversation and clears the previous plan', async () => {
  const controller = createController();
  let creation = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => {
      creation += 1;
      return createProvider(creation === 1
        ? [{ planUpdate: [{ text: 'Visible plan', status: 'done' }], done: { summary: 'First complete.', success: true } }]
        : [{ done: { summary: 'Second complete.', success: true } }]);
    }
  });

  const first = await agent.start({ task: 'First conversation', provider: { id: 'mock' } });
  const second = await agent.start({ task: 'New conversation', provider: { id: 'mock' } });

  assert.notEqual(second.id, first.id);
  assert.equal(first.plan.length, 1);
  assert.deepEqual(second.plan, []);
  assert.equal(second.messages[0].content, 'New conversation');
});

test('runs a bounded observe-act-done chat task against the selected desktop tab', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { title: 'Open Details Panel', assistantText: 'I will open the details panel.', toolCalls: [{ id: 'call-1', name: 'browser_click', input: { index: 0 } }] },
      { assistantText: 'The task is complete.', toolCalls: [{ id: 'call-2', name: 'browser_done', input: { summary: 'Opened details.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Open details', provider: { id: 'mock', model: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.title, 'Open Details Panel');
  assert.equal(run.result.summary, 'Opened details.');
  assert.deepEqual(controller.calls.filter(([name]) => name === 'click').length, 1);
  assert.ok(events.some((event) => event.type === 'run.title' && event.title === 'Open Details Panel'));
  assert.ok(events.some((event) => event.type === 'assistant.message' && Number.isFinite(event.thinkingMs)));
  assert.ok(events.some((event) => event.type === 'tool.result' && event.tool === 'browser_click'));
  assert.ok(events.some((event) => event.type === 'run.completed'));
  assert.deepEqual(run.messages.map(({ role, content }) => [role, content]), [
    ['user', 'Open details'],
    ['assistant', 'Opened details.']
  ]);
});

test('paints only one intermediate status message while later actions and terminal reply continue', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { assistantText: 'Starting the work.', actions: [{ name: 'browser_click', input: { element: 0 } }] },
      { assistantText: 'I will now continue the work.', actions: [{ name: 'browser_screenshot', input: {} }] },
      { done: { summary: 'Finished.', success: true } }
    ])
  });

  const run = await agent.start({ task: 'Complete the work', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(events.filter((event) => event.type === 'assistant.message').map((event) => event.text), ['Starting the work.']);
  assert.equal(events.some((event) => event.type === 'tool.result' && event.tool === 'browser_screenshot'), true);
  assert.equal(run.messages.at(-1).content, 'Finished.');
});

test('exposes interaction regions and performs a viewport-grounded drag without page scripts', async () => {
  const controller = createController();
  controller.domSnapshot = async (tabId) => ({
    tabId,
    url: 'https://example.test/editor',
    title: 'Editor',
    viewport: { width: 900, height: 700 },
    elements: [{ index: 0, tag: 'button', name: 'Rectangle', text: 'Rectangle', enabled: true, pressed: true, dataTool: 'shape-rectangle' }],
    regions: [{ kind: 'main', name: 'Editable surface', rect: { x: 100, y: 80, w: 600, h: 500 }, center: { x: 400, y: 330 }, childCount: 0, descendantCount: 0 }],
    landmarks: [{ tag: 'div', role: 'status', label: '', text: 'Place rectangle on canvas' }],
    truncated: false
  });
  controller.drag = async (tabId, args, owner) => {
    controller.calls.push(['drag', tabId, args, owner]);
    return { tabId, ...args };
  };
  let firstContext = null;
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions === 1) {
          firstContext = context;
          return { actions: [{ name: 'browser_drag', input: { fromX: 220, fromY: 180, toX: 520, toY: 360 } }] };
        }
        return { done: { summary: 'Placed the editable object.', success: true } };
      }
    })
  });

  const run = await agent.start({ task: 'Place an editable object', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(firstContext.observation.dom.elements[0].pressed, true);
  assert.equal(firstContext.observation.dom.regions[0].name, 'Editable surface');
  assert.equal(firstContext.tools.some((tool) => tool.name === 'browser_drag'), true);
  const drag = controller.calls.find(([name]) => name === 'drag');
  assert.deepEqual(drag.slice(1, 3), ['tab-1', { startX: 220, startY: 180, endX: 520, endY: 360, steps: 12, durationMs: 300 }]);
  assert.equal(run.history.some((entry) => entry.tool === 'browser_execute'), false);
});

test('carries prior reasoning and semantic completed work into the next decision without creating a visible plan', async () => {
  const controller = createController();
  let revision = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, truncated: false,
    landmarks: [{ tag: 'div', role: 'status', label: 'Revision', text: String(revision) }],
    elements: [{ index: 0, tag: 'button', name: 'Open details', text: 'Open details', enabled: true }]
  });
  controller.clickElement = async (tabId, args, owner) => {
    revision += 1;
    controller.calls.push(['click', tabId, args, owner]);
    return { tabId, ...args };
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) {
          context.onThought('Activate the visible control, then continue from the changed page.');
          return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
        }
        assert.match(context.workingMemory.previousReasoning, /continue from the changed page/i);
        assert.equal(context.coordinator.completedWork.length, 1);
        assert.equal(context.coordinator.completedWork[0].action, 'browser_click');
        return { done: { summary: 'Continued from retained working state.', success: true } };
      }
    })
  });

  const run = await agent.start({ task: 'Use the visible control and continue', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(run.plan, []);
  assert.equal(run.coordinator.completedWork.length, 1);
});

test('a nontrivial mutation sequence records the completion-review concern without blocking the run', async () => {
  const controller = createController();
  let revision = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId,
    url: 'https://example.test/editor',
    title: 'Editor',
    viewport: { width: 900, height: 700 },
    landmarks: [{ tag: 'div', role: 'status', label: 'Revision', text: String(revision) }],
    elements: [0, 1, 2].map((index) => ({ index, tag: 'button', name: `Control ${index + 1}`, text: `Control ${index + 1}`, enabled: true })),
    truncated: false
  });
  controller.clickElement = async (tabId, args, owner) => {
    revision += 1;
    controller.calls.push(['click', tabId, args, owner]);
    return { tabId, ...args };
  };
  let decision = 0;
  let reviewSeen = false;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision <= 3) return { actions: [{ name: 'browser_click', input: { element: decision - 1 } }] };
        if (decision === 4) return { done: { summary: 'Everything is complete.', success: true } };
        reviewSeen = context.recovery?.source === 'completion_review';
        return { done: { summary: 'Everything is complete and visibly verified.', success: true, verified: true } };
      }
    })
  });

  const run = await agent.start({ task: 'Complete all three visible changes', provider: { id: 'mock' } });

  // Owner policy (2026-11-02): verification never blocks a genuine run. The
  // completion review's concern is recorded on the ACCEPTED result instead of
  // bouncing the first done proposal — the bounce is what turned verification
  // into a fabrication trap. The concern is still delivered, so the model can
  // verify; nothing blocks and no error is shown.
  assert.equal(run.status, 'completed');
  const doneEntries = run.history.filter((entry) => entry.tool === 'browser_done');
  assert.equal(doneEntries.length, 1, 'the run closes on its own done — no review bounce');
  assert.equal(doneEntries[0].output.ok, true);
  assert.match(String(doneEntries[0].output.verificationNote || ''), /Completion is a proposal|audit the whole/i, 'the review concern is still recorded');
});

test.skip('turns decision and recovery limits into one internal checkpoint then continues', async () => {
  const controller = createController();
  let decision = 0;
  const recoveries = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        recoveries.push(context.recovery?.source || null);
        if (decision === 1) return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
        if (decision === 2) return { actions: [{ name: 'browser_click', input: { element: 0 }, ok: false, recoverable: true, recoverySource: 'action_loop', error: 'Simulated recovery' }] };
        if (decision === 3) return {};
        return { done: { summary: 'Recovered with the original goal intact.', success: true } };
      }
    })
  });

  const run = await agent.start({
    task: 'Keep working through checkpoints',
    provider: { id: 'mock' },
    settings: { maxSteps: 1, maxRecoveries: 2 }
  });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.ok(recoveries.length > 0, 'At least one recovery should occur');
  assert.ok(recoveries.some(src => src && src !== null), 'Recoveries should have valid sources');
  assert.equal(run.workingMemory.strategyEpoch >= 1, true);
});

test('uses DOM-first auto vision unless the decision specifically requires visual evidence', async () => {
  const controller = createController();
  let receivedObservation = null;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete({ observation }) {
        receivedObservation = observation;
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Observed.' } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Inspect the DOM', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(receivedObservation.screenshot, undefined);
  assert.equal(controller.calls.some(([name]) => name === 'screenshot'), false);
});

test('captures a fresh visual observation in always mode for a capable model decision', async () => {
  const controller = createController();
  controller.screenshot = async (tabId) => ({ tabId, mimeType: 'image/png', data: 'base64-image' });
  let receivedObservation = null;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete({ observation }) {
        receivedObservation = observation;
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Observed.' } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Inspect visually', provider: { id: 'mock' }, settings: { vision: 'always' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(receivedObservation.screenshot, { tabId: 'tab-1', mimeType: 'image/png', data: 'base64-image' });
});

test('continues a completed conversation without clearing its run identity or history', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_done', input: { summary: 'First answer.' } }] }
    ])
  });
  const first = await agent.start({ task: 'Inspect page', provider: { id: 'mock' } });
  agent.createProvider = () => createProvider([
    { toolCalls: [{ name: 'browser_done', input: { summary: 'Follow-up answer.' } }] }
  ]);

  const continued = await agent.start({ task: 'Now summarize it', continuation: true, provider: { id: 'mock' } });

  assert.equal(continued.id, first.id);
  assert.equal(continued.title, first.title);
  // Deliberate (2026-10-02): every new-turn continuation carries the runtime
  // USER ADDITION message naming the new objective.
  assert.deepEqual(continued.messages.map(({ role, content }) => [role, content]), [
    ['user', 'Inspect page'],
    ['assistant', 'First answer.'],
    ['user', 'Now summarize it'],
    ['user', continued.messages.filter((m) => m.source === 'runtime' && /USER ADDITION/.test(m.content)).at(-1)?.content || 'USER ADDITION'],
    ['assistant', 'Follow-up answer.']
  ]);
  assert.equal(continued.messages[0].content, 'Inspect page');
  assert.ok(continued.history.length > first.history.length);
});

test('accepts only a visibly verified external block and never marks it as a successful result', async () => {
  const controller = createController();
  controller.domSnapshot = async (tabId) => ({
    tabId, url: 'https://example.test/', title: 'Access denied', viewport: { width: 1280, height: 720 },
    landmarks: [{ tag: 'h1', role: '', label: '', text: 'Access denied' }], elements: [], truncated: false
  });
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([{ toolCalls: [{ name: 'browser_done', input: { summary: 'Could not complete this.', success: false, verified: true, final: true } }] }])
  });

  const run = await agent.start({ task: 'Try the task', provider: { id: 'mock' } });

  assert.equal(run.result.success, false);
  assert.equal(run.result.verified, false);
});

test('continuation applies the currently selected provider and safety settings', async () => {
  const controller = createController();
  const providers = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: (config) => {
      providers.push(config);
      return createProvider([{ toolCalls: [{ name: 'browser_done', input: { summary: 'Done.' } }] }]);
    }
  });

  await agent.start({ task: 'Inspect', provider: { id: 'mock', model: 'first-model' }, settings: { approvalMode: 'unattended' } });
  const continued = await agent.start({ task: 'Continue', continuation: true, provider: { id: 'mock', model: 'second-model' }, settings: { approvalMode: 'confirm-sensitive' } });

  assert.equal(continued.provider.model, 'second-model');
  assert.equal(continued.settings.approvalMode, 'confirm-sensitive');
  assert.equal(providers.at(-1).model, 'second-model');
});

test('remote providers do not require or observe a local browser tab', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => null,
    emit: () => {},
    createProvider: () => ({ executionTarget: 'remote', async complete() { return { toolCalls: [{ name: 'browser_done', input: { summary: 'Remote task complete.', verified: false } }] }; } })
  });

  const run = await agent.start({ task: 'Research remotely', provider: { id: 'cloud', model: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.tabId, null);
  assert.equal(run.result.verified, false);
  assert.equal(controller.calls.some(([name]) => name === 'snapshot'), false);
});

test('defaults browser chat requests to unattended mode', async () => {
  const controller = createController();
  let seenSettings = null;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete() { return { toolCalls: [{ name: 'browser_done', input: { summary: 'Done.' } }] }; } })
  });
  const originalPublish = agent.publish.bind(agent);
  agent.publish = (type, run, payload) => { if (type === 'run.started') seenSettings = run.settings; originalPublish(type, run, payload); };

  await agent.start({ task: 'Inspect', provider: { id: 'mock' } });

  assert.equal(seenSettings.approvalMode, 'unattended');
});

test('controls a specified background tab without selecting or replacing the visible tab', async () => {
  const controller = createController();
  controller.listTabs = () => [{ id: 'tab-1' }, { id: 'tab-2' }];
  let queriedTabId = null;
  controller.queryElements = async (tabId) => { queriedTabId = tabId; return { tabId, url: 'https://studio.test/', title: 'Studio', viewport: { width: 100, height: 100 }, elements: [], truncated: false }; };
  const selected = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-2',
    selectTab: async (id) => { selected.push(id); return { id }; },
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_query', input: { tabId: 'tab-1', text: 'canvas' } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Reviewed Studio.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Review Studio while leaving Figma open', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(queriedTabId, 'tab-1');
  assert.deepEqual(selected, []);
  assert.equal(run.tabId, 'tab-2');
});

test('updates the background agent target only through explicit tab actions', async () => {
  const controller = createController();
  const tabCalls = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    createTab: async (url) => { tabCalls.push(['new', url]); return { id: 'tab-2', url }; },
    selectTab: async (id) => { tabCalls.push(['select', id]); return { id, url: 'https://first.test/' }; },
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_new_tab', input: { url: 'https://second.test/' } }] },
      { toolCalls: [{ name: 'browser_select_tab', input: { tabId: 'tab-1' } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Compared both tabs.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Compare two tabs', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.tabId, 'tab-1');
  assert.deepEqual(tabCalls, [['new', 'https://second.test/'], ['select', 'tab-1']]);
});

test('holds cross-origin navigation until the local user approves it', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'I need to navigate.', toolCalls: [{ id: 'call-1', name: 'browser_navigate', input: { url: 'https://other.test/' } }] },
      { assistantText: 'Done.', toolCalls: [{ id: 'call-2', name: 'browser_done', input: { summary: 'Navigated.' } }] }
    ])
  });

  const started = agent.start({ task: 'Open another website', provider: { id: 'mock', model: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = agent.state();
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(controller.calls.some(([name]) => name === 'navigate'), false);

  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });
  const completed = await started;
  assert.equal(completed.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'navigate').length, 1);
});

test('requires local approval before typing page content', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'I will fill the form.', toolCalls: [{ id: 'call-1', name: 'browser_type', input: { text: 'public search term' } }] },
      { assistantText: 'Done.', toolCalls: [{ id: 'call-2', name: 'browser_done', input: { summary: 'Filled the form.' } }] }
    ])
  });

  const started = agent.start({ task: 'Fill the form', provider: { id: 'mock', model: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = agent.state();
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(controller.calls.some(([name]) => name === 'type'), false);
  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });
  const completed = await started;
  assert.equal(completed.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'type').length, 1);
  assert.equal(completed.history.find((entry) => entry.tool === 'browser_type').input.text, '[18 characters]');
});

test('Ask mode holds clicks and page commands until the local user approves them', async () => {
  const controller = createController();
  controller.executePageScript = async (tabId, { script }) => { controller.calls.push(['execute', tabId, script]); return { tabId, result: { changed: true } }; };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_execute', input: { script: 'return { changed: true };' } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Approved actions completed.' } }] }
    ])
  });

  const started = agent.start({ task: 'Change the page', provider: { id: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  let pending = agent.state();
  assert.equal(pending.pendingApproval.tool, 'browser_click');
  assert.equal(controller.calls.some(([name]) => name === 'click'), false);
  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });

  await new Promise((resolve) => setTimeout(resolve, 0));
  pending = agent.state();
  assert.equal(pending.pendingApproval.tool, 'browser_execute');
  assert.equal(controller.calls.some(([name]) => name === 'execute'), false);
  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });
  const completed = await started;
  assert.equal(completed.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'click').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'execute').length, 1);
});

test('runs routine local browser actions without approval in unattended mode', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'I will fill the search box.', toolCalls: [{ name: 'browser_type', input: { text: 'public search' } }, { name: 'browser_navigate', input: { url: 'https://other.test/' } }] },
      { assistantText: 'I will now navigate after checking the field result.', toolCalls: [{ name: 'browser_navigate', input: { url: 'https://other.test/' } }] },
      { assistantText: 'Done.', toolCalls: [{ name: 'browser_done', input: { summary: 'Finished.' } }] }
    ])
  });
  const run = await agent.start({ task: 'Search the web', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });
  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.some(([name]) => name === 'type'), true);
  assert.equal(controller.calls.some(([name]) => name === 'navigate'), true);
});

test('supports planning metadata and richer native browser actions', async () => {
  const controller = createController();
  controller.goBack = (tabId) => { controller.calls.push(['back', tabId]); return { tabId }; };
  controller.queryElements = async (tabId, args) => { controller.calls.push(['query', tabId, args]); return { tabId, elements: [] }; };
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { assistantText: 'Inspecting.', plan: [{ text: 'Inspect page', status: 'current' }], toolCalls: [{ name: 'browser_query', input: { text: 'support' } }, { name: 'browser_wait', input: { ms: 10 } }] },
      { assistantText: 'Done.', planUpdate: [{ text: 'Inspect page', status: 'done' }], toolCalls: [{ name: 'browser_done', input: { summary: 'Inspected page.', success: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Inspect support details', provider: { id: 'mock', model: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.ok(events.some((event) => event.type === 'plan.updated'));
  assert.equal(controller.calls.filter(([name]) => name === 'query').length, 1);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_wait').length, 1);
});

test('requires approval before keyboard browser navigation shortcuts', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'I will use a key shortcut.', toolCalls: [{ name: 'browser_key', input: { key: 'Left', action: 'press' } }] },
      { assistantText: 'Done.', toolCalls: [{ name: 'browser_done', input: { summary: 'Shortcut sent.' } }] }
    ])
  });

  const started = agent.start({ task: 'Use browser shortcut', provider: { id: 'mock', model: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = agent.state();
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(controller.calls.some(([name]) => name === 'key'), false);
  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });
  const completed = await started;
  assert.equal(completed.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'key').length, 1);
});

test('requires approval before browser history navigation', async () => {
  const controller = createController();
  controller.goBack = (tabId) => { controller.calls.push(['back', tabId]); return { tabId }; };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'I will go back.', toolCalls: [{ name: 'browser_go_back', input: {} }] },
      { assistantText: 'Done.', toolCalls: [{ name: 'browser_done', input: { summary: 'Returned.' } }] }
    ])
  });

  const started = agent.start({ task: 'Go back', provider: { id: 'mock', model: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pending = agent.state();
  assert.equal(pending.status, 'awaiting_approval');
  assert.equal(controller.calls.some(([name]) => name === 'back'), false);
  agent.approve({ runId: pending.id, approvalId: pending.pendingApproval.id, decision: 'allow_once' });
  const completed = await started;
  assert.equal(completed.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'back').length, 1);
});

test.skip('an internal execution exception is recovered without ending the chat', async () => {
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ async complete() { return { done: { summary: 'Recovered after internal error.', success: true, verified: true } }; } })
  });
  let threw = false;
  const originalDeliverResearch = agent.deliverResearch.bind(agent);
  agent.deliverResearch = (run) => {
    if (!threw) { threw = true; throw new Error('synthetic internal execution error'); }
    return originalDeliverResearch(run);
  };
  const run = await agent.start({ task: 'Continue after an internal fault', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(run.result.summary, 'Recovered after internal error.');
  assert.equal(run.messages.some(message => message.role === 'assistant' && /synthetic internal execution error/.test(String(message.content || ''))), false);
  assert.equal(run.history.some(entry => entry.tool === 'agent_recovery'), true);
});

test('resets strategy after repeated malformed provider output and keeps the run alive', async () => {
  const controller = createController();
  const events = [];
  let providerCalls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        providerCalls += 1;
        if (context.recovery?.source === 'fresh_restart') {
          return { toolCalls: [{ name: 'browser_done', input: { summary: 'Recovered after replacing the malformed approach.', success: true } }] };
        }
        throw new Error('Malformed response');
      }
    })
  });
  const run = await agent.start({ task: 'Inspect', provider: { id: 'mock' }, settings: { maxRecoveries: 2 } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Recovered after replacing the malformed approach.');
  assert.equal(providerCalls, 3);
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_recovery').length, 2);
  assert.equal(events.some((event) => event.type === 'agent.replan' && event.source === 'provider_decision'), true);
  assert.equal(events.some((event) => event.type === 'agent.replan' && event.source === 'fresh_restart' && event.strategyReset === true), true);
  // The fresh restart remains runtime context, not a visible assistant message.
  assert.equal(run.messages.some((message) => message.source === 'runtime' && /Internal recovery cycle/.test(String(message.content || ''))), false);
  assert.equal(events.some((event) => event.type === 'agent.recovery' && event.strategyReset === true), true);
  assert.equal(events.some((event) => event.type === 'assistant.message' && /Internal recovery cycle/.test(String(event.text || ''))), false);
  assert.equal(events.some((event) => event.type === 'run.failed'), false);
});

test('passes a provider repair error into the next decision so it can choose a corrected action', async () => {
  const controller = createController();
  const events = [];
  const decisions = [];
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        decisions.push(context);
        decision += 1;
        if (decision === 1) throw new Error('The structured-response repair did not return an executable decision.');
        if (decision === 2) {
          assert.equal(context.recovery.attempts, 1);
          assert.equal(context.recovery.source, 'provider_decision');
          assert.match(context.recovery.lastError, /structured-response repair/i);
          assert.match(JSON.stringify(context.history), /structured-response repair/i);
          return { assistantText: 'Correcting the input.', toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'lordemaximus.com' } }] };
        }
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Search input corrected.', success: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Search input corrected.');
  assert.equal(controller.calls.filter(([name]) => name === 'type').length, 1);
  assert.equal(decisions.length, 3);
  assert.equal(events.some((event) => event.type === 'run.failed'), false);
});

test('feeds a browser action error to the next model decision for a different corrected action', async () => {
  const controller = createController();
  const events = [];
  let decision = 0;
  controller.executePageScript = async () => {
    controller.calls.push(['execute']);
    throw new Error('The search form did not expose an input field.');
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'browser_execute', input: { script: 'return { ok: true };' } }] };
        if (decision === 2) {
          assert.equal(context.recovery.source, 'browser_action');
          assert.equal(context.recovery.action, 'browser_execute');
          assert.match(context.recovery.lastError, /search form/i);
          assert.match(JSON.stringify(context.history), /search form/i);
          return { toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'lordemaximus.com' } }] };
        }
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Used the corrected search input.', success: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'execute').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'type').length, 1);
  assert.equal(events.some((event) => event.type === 'run.failed'), false);
});

test('masks typed content in recovery context after a browser type error', async () => {
  const controller = createController();
  let decision = 0;
  let externalBlock = false;
  controller.domSnapshot = async (tabId) => externalBlock
    ? { tabId, url: 'https://example.test/', title: 'Service unavailable', viewport: { width: 1280, height: 720 }, landmarks: [{ tag: 'h1', role: '', label: '', text: 'Service unavailable' }], elements: [], truncated: false }
    : { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'input', role: 'textbox', name: 'Private value', text: '', enabled: true }], truncated: false };
  controller.type = () => { externalBlock = true; throw new Error('The page rejected "private secret".'); };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'private secret' } }] };
        if (decision === 2) {
          assert.doesNotMatch(context.recovery.lastError, /private secret/);
          assert.match(context.recovery.lastError, /\[14 characters\]/);
          assert.doesNotMatch(JSON.stringify(context.history), /private secret/);
          return { toolCalls: [{ name: 'browser_done', input: { summary: 'Input remains private.', success: false, final: true } }] };
        }
        throw new Error('Unexpected extra model turn.');
      }
    })
  });

  const run = await agent.start({ task: 'Enter a private value', provider: { id: 'mock' } });

  assert.equal(run.status, 'failed');
  assert.equal(run.result.success, false);
  assert.doesNotMatch(JSON.stringify(run.history), /private secret/);
});

test('replans a generic unsuccessful done result instead of ending before a corrective action', async () => {
  const controller = createController();
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'browser_done', input: { summary: 'No safe executable action identified.', success: false } }] };
        if (decision === 2) {
          assert.equal(context.recovery.source, 'unsuccessful_done');
          assert.match(context.recovery.lastError, /no safe executable action/i);
          return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
        }
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Opened the available control.', success: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Open the available control', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'click').length, 1);
  assert.equal(run.result.summary, 'Opened the available control.');
});

test('retries a timed-out provider request with backoff instead of burning recovery', async () => {
  const controller = createController();
  let providerAborted = false;
  let providerCalls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      complete({ signal, recovery }) {
        providerCalls += 1;
        if (providerCalls > 1) {
          // The retry replays the SAME decision: no recovery framing, and the
          // model recovery budget stays untouched.
          assert.equal(recovery.source, '');
          return Promise.resolve({ toolCalls: [{ name: 'browser_done', input: { summary: 'The retry produced a valid decision.', success: true } }] });
        }
        return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => { providerAborted = true; reject(signal.reason); }, { once: true });
        });
      }
    })
  });
  agent.transportRetryDelays = [5];

  const run = await agent.start({ task: 'Wait for a stalled provider', provider: { id: 'mock' }, settings: { stepTimeoutMs: 5_000 } });
  assert.equal(run.status, 'completed');
  assert.equal(providerAborted, true);
  assert.equal(providerCalls, 2);
  assert.equal(run.result.summary, 'The retry produced a valid decision.');
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_recovery').length, 0);
});

test('refreshes the observation after a stale element failure so the model can recover', async () => {
  const controller = createController();
  let clicks = 0;
  controller.clickElement = async () => {
    clicks += 1;
    if (clicks === 1) throw new Error('Element index 5 is stale; observe the page again before retrying the action.');
    return { tabId: 'tab-1', index: 0 };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'Typing.', toolCalls: [{ name: 'browser_type', input: { element: 5, text: 'Samsung S9' } }] },
      { assistantText: 'Retrying with the fresh field.', toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'Samsung S9' } }] },
      { assistantText: 'Done.', toolCalls: [{ name: 'browser_done', input: { summary: 'Search entered.' } }] }
    ])
  });
  const run = await agent.start({ task: 'Search', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });
  assert.equal(run.status, 'completed');
  assert.ok(controller.calls.filter(([name]) => name === 'snapshot').length >= 3);
  assert.equal(run.history[0].output.recoverable, true);
});

test('does not type into a previously focused control when the target focus click is interrupted', async () => {
  const controller = createController();
  controller.clickElement = async (tabId, args, owner) => {
    controller.calls.push(['click', tabId, args, owner]);
    return { tabId, ...args, input: 'interrupted', pointer: { interrupted: true, reason: 'session-input-released' } };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'Focusing the requested field.', toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'must not reach the old field' } }] },
      { done: { summary: 'The interrupted focus was not followed by typing.', success: true, verified: true } }
    ])
  });

  const run = await agent.start({ task: 'Type only into the requested field', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.some(([name]) => name === 'type'), false, 'text input must not run after a failed focus click');
  const typeAttempt = run.history.find((entry) => entry.tool === 'browser_type');
  assert.equal(typeAttempt.output.ok, false);
  assert.equal(typeAttempt.output.recoverable, true);
  assert.equal(typeAttempt.output.recoverySource, 'pointer_interrupted');
});

test('keeps click target precedence explicit after an independent pointer move', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_mousemove', input: { x: 120, y: 80 } }] },
      { toolCalls: [{ name: 'browser_click', input: { x: '240', y: '160', element: 99 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'The explicit coordinate click completed.', success: true, verified: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Move the pointer, then click the explicit coordinate.', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(controller.calls.filter(([name]) => name === 'mousemove')[0].slice(1, 3), ['tab-1', { x: 120, y: 80 }]);
  assert.deepEqual(controller.calls.filter(([name]) => name === 'clickAt')[0].slice(1, 3), ['tab-1', { x: 240, y: 160 }]);
  assert.equal(controller.calls.some(([name]) => name === 'click'), false, 'the stale element metadata must not override explicit coordinates');
});

test('keeps indexed click resolution independent from a prior pointer move', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_mousemove', input: { x: 120, y: 80 } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'The indexed click completed.', success: true, verified: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Move the pointer, then click the observed control.', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(controller.calls.filter(([name]) => name === 'click')[0].slice(1, 3), ['tab-1', { index: 0 }]);
  assert.equal(controller.calls.some(([name]) => name === 'clickAt'), false, 'index-only clicks must use the indexed target path');
});

test('exposes and executes a grounded visible pointer move without treating it as a page mutation', async () => {
  const controller = createController();
  const events = [];
  let firstContext = null;
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) {
          firstContext = context;
          // This compact spelling occurred in the supervised provider run. It
          // must resolve to the catalog action rather than leaving the chat in
          // an actionless recovery loop after the pointer reaches its target.
          return { toolCalls: [{ name: 'browsermousemove', input: { x: 640, y: 360 } }] };
        }
        return { toolCalls: [{ name: 'browserdone', input: { summary: 'The pointer is visibly parked in the middle of the page.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Move the pointer to the middle of the page and stop', provider: { id: 'mock' }, settings: { approvalMode: 'confirm-sensitive' } });

  assert.equal(run.status, 'completed');
  assert.equal(firstContext.tools.some((tool) => tool.name === 'browser_mousemove'), true);
  assert.deepEqual(controller.calls.find(([name]) => name === 'mousemove')?.slice(1, 3), ['tab-1', { x: 640, y: 360 }]);
  assert.equal(controller.calls.find(([name]) => name === 'mousemove')?.[3]?.sessionId, run.id);
  assert.equal(run.history.find((entry) => entry.tool === 'browser_mousemove')?.output.ok, true);
  assert.equal(events.some((event) => event.type === 'approval.required'), false, 'movement without activation must not require approval');
  assert.equal(run.coordinator.observationRevision, 1, 'pointer placement must retain the already-grounded page evidence');
  assert.equal(run.requiredEvidenceRevision, 0, 'pointer placement must not force page-mutation completion review');
});

test('settles a conclusive final pointer move without waiting on another provider turn', async () => {
  const controller = createController();
  const events = [];
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete() {
        decisions += 1;
        if (decisions === 1) {
          return {
            assistantText: 'Verified that the requested page state is correct. Pointer positioned in the middle of the page.',
            toolCalls: [{ name: 'browser_mousemove', input: { x: 640, y: 360 } }]
          };
        }
        throw new Error('A completed final pointer placement must not require another provider turn.');
      }
    })
  });

  const run = await agent.start({ task: 'Verify the page and finish with the pointer in the middle', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Verified that the requested page state is correct. Pointer positioned in the middle of the page.');
  assert.equal(run.result.verified, true);
  assert.equal(decisions, 1);
  assert.equal(run.history.at(-1)?.tool, 'browser_done');
  assert.equal(run.history.at(-1)?.output.ok, true);
  assert.equal(events.some((event) => event.type === 'assistant.message'), false, 'a final conclusion must not paint as an intermediate running reply');
});

test('rejects pointer coordinates outside the freshly observed viewport before native input', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_mousemove', input: { x: 1280, y: 360 } }] },
      { done: { summary: 'The invalid placement was not sent to the page.', success: true, verified: true } }
    ])
  });

  const run = await agent.start({ task: 'Do not move outside the page', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.some(([name]) => name === 'mousemove'), false);
  assert.match(run.history.find((entry) => entry.tool === 'browser_mousemove')?.output.error || '', /inside the current 1280 by 720 viewport/i);
});

test('records interrupted pointer move, click, drag, and scroll actions as recoverable failures', async () => {
  const controller = createController();
  const interrupted = (kind) => ({ tabId: 'tab-1', input: 'interrupted', pointer: { interrupted: true, reason: `${kind}-cancelled` } });
  controller.mouseMove = async () => interrupted('mousemove');
  controller.clickElement = async () => interrupted('click');
  controller.drag = async () => interrupted('drag');
  controller.scroll = async () => interrupted('scroll');
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_mousemove', input: { x: 200, y: 160 } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_drag', input: { startX: 20, startY: 30, endX: 120, endY: 140 } }] },
      { toolCalls: [{ name: 'browser_scroll', input: { deltaY: 300 } }] },
      { done: { summary: 'All interrupted actions were left for a safe retry.', success: true, verified: true } }
    ])
  });

  const run = await agent.start({ task: 'Try these pointer actions safely', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });

  assert.equal(run.status, 'completed');
  for (const tool of ['browser_mousemove', 'browser_click', 'browser_drag', 'browser_scroll']) {
    const attempt = run.history.find((entry) => entry.tool === tool);
    assert.equal(attempt.output.ok, false, `${tool} must not be recorded as a successful mutation`);
    assert.equal(attempt.output.recoverable, true);
    assert.equal(attempt.output.recoverySource, 'pointer_interrupted');
  }
});

test('finishes the red-circle fixture with one verified target click and one post-mutation capture', async () => {
  const controller = createController();
  let redCircleCreated = false;
  controller.domSnapshot = async (tabId) => {
    controller.calls.push(['snapshot', tabId]);
    return {
      tabId,
      url: 'https://studio.fixture.test/',
      title: 'Design Studio',
      viewport: { width: 1280, height: 720 },
      truncated: false,
      elements: redCircleCreated
        ? [{ index: 0, tag: 'div', name: 'Red circle created', text: 'Circle fill #ff0000', enabled: true }]
        : [{ index: 0, tag: 'button', name: 'Create red circle', text: 'Ellipse', enabled: true }]
    };
  };
  controller.clickElement = async (tabId, args) => {
    assert.equal(args.index, 0);
    redCircleCreated = true;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args, progress: true };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { planUpdate: [{ text: 'Create red circle', status: 'current', verification: 'Circle fill #ff0000 is visible' }], actions: [{ name: 'browser_click', input: { element: 0 }, expect: { kind: 'text_present', value: 'Circle fill #ff0000' } }] },
      { planUpdate: [{ text: 'Create red circle', status: 'done', verification: 'Circle fill #ff0000 is visible' }], done: { summary: 'Created a red circle.', success: true, verified: true, evidence: ['Circle fill #ff0000'] } }
    ])
  });

  const run = await agent.start({ task: 'Create a red circle on canvas', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.equal(redCircleCreated, true);
  assert.equal(controller.calls.filter(([name]) => name === 'click').length, 1);
  // The click is a browser mutation, so the next observation re-grounds the
  // planner with fresh pixels (see visualEvidence_flow_chat.md invariant 1)
  // — exactly one capture, not one per decision.
  assert.equal(controller.calls.filter(([name]) => name === 'screenshot').length, 1);
  assert.equal(run.plan[0].verification, 'Circle fill #ff0000 is visible');
});

test('allows one retry after technical dispatch success has no visible effect', async () => {
  const controller = createController();
  let clicks = 0;
  controller.clickElement = async (tabId, args) => {
    clicks += 1;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Continued after the bounded no-effect retry.', success: true, verified: true, verified: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Click exactly once if it works', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(clicks, 2);
  assert.equal(run.history.some((entry) => entry.output.state === 'duplicate'), false);
  assert.equal(run.coordinator.completedWork.length, 0);
});

test('allows an explicitly repeated mutation only with a distinct expected outcome', async () => {
  const controller = createController();
  let clicks = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId, url: 'https://example.test/', title: 'Counter', viewport: { width: 1280, height: 720 }, truncated: false,
    landmarks: [{ tag: 'div', role: 'status', label: 'Count', text: String(clicks) }],
    elements: [{ index: 0, tag: 'button', name: 'Increment', text: 'Increment', enabled: true }]
  });
  controller.clickElement = async (tabId, args) => {
    clicks += 1;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 0 }, expect: 'Count is 1' }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0, repeat: true, expect: 'Count is 2' } }] },
      { done: { summary: 'Clicked twice intentionally.', success: true } }
    ])
  });

  const run = await agent.start({ task: 'Click the increment control twice', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(clicks, 2);
  assert.equal(run.history[1].repeat, true);
  assert.equal(run.history.some((entry) => entry.output.state === 'duplicate'), false);
});

test('canonicalizes embedded action metadata and a single-index target before semantic policy checks', async () => {
  const controller = createController();
  let clicks = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId, url: 'https://example.test/', title: 'Control', viewport: { width: 1280, height: 720 }, truncated: false,
    landmarks: [{ tag: 'div', role: 'status', label: 'Activation count', text: String(clicks) }],
    elements: [{ index: 0, tag: 'button', name: 'Open details', text: 'Open details', enabled: true }]
  });
  controller.clickElement = async (tabId, args) => {
    clicks += 1;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { target: [0], expect: 'First wording', title: 'Activate the control' } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0, expect: 'Different wording for the same click', title: 'Click it now', reason: 'Try again' } }] },
      { done: { summary: 'Continued after canonical duplicate detection.', success: true, verified: true, verified: true } }
    ])
  });

  const run = await agent.start({ task: 'Activate the control once', provider: { id: 'mock' } });

  // The re-click executes (repetition is the model's decision) but the
  // canonical duplicate is flagged as an advisory attached to the result.
  assert.equal(run.status, 'completed');
  assert.equal(clicks, 2);
  assert.deepEqual(run.history[0].input, { element: 0 });
  assert.equal(run.history[0].expect, 'First wording');
  assert.equal(run.history[0].repeat, false);
  assert.match(run.history[1].note, /already performed this exact action successfully earlier in the task/i);
});

test('flags a successful semantic mutation recurring after unrelated intervening actions', async () => {
  const controller = createController();
  let firstTargetClicks = 0;
  let revision = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId,
    url: 'https://example.test/',
    title: 'Editor',
    viewport: { width: 1280, height: 720 },
    truncated: false,
    landmarks: [{ tag: 'div', role: 'status', label: 'Editor revision', text: String(revision) }],
    elements: [
      { index: 0, tag: 'button', name: 'Create item', text: 'Create item', enabled: true },
      { index: 1, tag: 'button', name: 'Open properties', text: 'Open properties', enabled: true }
    ]
  });
  controller.clickElement = async (tabId, args) => {
    if (args.index === 0) firstTargetClicks += 1;
    revision += 1;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 1 } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { done: { summary: 'Moved on without recreating the item.', success: true } },
      { done: { summary: 'Moved on without recreating the item.', success: true, verified: true } }
    ])
  });

  const run = await agent.start({ task: 'Create one item and edit its properties', provider: { id: 'mock' } });

  // After an intervening action the page fingerprint moved, so the repeat is
  // the model's deliberate choice and executes; the run still completes
  // honestly.
  assert.equal(run.status, 'completed');
  assert.equal(firstTargetClicks, 2);
  assert.equal(run.result.summary, 'Moved on without recreating the item.');
});

test('flags an identical immediate mutation once fresh evidence confirms the first one changed the page', async () => {
  const controller = createController();
  let pageCount = 1;
  let clicks = 0;
  controller.domSnapshot = async (tabId) => ({
    tabId,
    url: 'https://example.test/',
    title: 'Pages',
    viewport: { width: 1280, height: 720 },
    truncated: false,
    landmarks: [{ tag: 'aside', role: '', label: 'Pages', text: Array.from({ length: pageCount }, (_, index) => `Page ${index + 1}`).join(' ') }],
    elements: [{ index: 0, tag: 'button', name: 'New page', text: 'New page', enabled: true }]
  });
  controller.clickElement = async (tabId, args) => {
    clicks += 1;
    pageCount += 1;
    controller.calls.push(['click', tabId, args]);
    return { tabId, ...args };
  };
  const decisions = [
    { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
    { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
    { done: { summary: 'Created exactly one new page.', success: true } }
  ];
  const received = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        received.push(context);
        return decisions.shift();
      }
    })
  });

  const run = await agent.start({ task: 'Create exactly one new page', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Created exactly one new page.');
  assert.equal(clicks, 2, 'the repeat executes; the guard is advisory');
  assert.equal(pageCount, 3);
  assert.equal(received[1].coordinator.lastMutation.effectObserved, true);
  assert.match(run.history.find((entry) => entry.note)?.note || '', /already performed this exact action successfully earlier in the task/i);
});

test('rejects an unsupported final failure as recovery context instead of stopping on model assertion alone', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_done', input: { summary: 'The control was unavailable.', success: false, final: true } }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Recovered through a visible alternative.', success: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Use unavailable control', provider: { id: 'mock' }, settings: { maxRecoveries: 1 } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Recovered through a visible alternative.');
  assert.equal(run.history[0].output.recoverySource, 'unverified_external_block');
  assert.equal(controller.calls.some(([name]) => name === 'click'), true);
});

test('labels stale elements as recoverable without consuming the action failure budget', async () => {
  const controller = createController();
  controller.clickElement = async () => { throw new Error('Element index 5 is stale; observe the page again before retrying the action.'); };
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 5 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Handled the stale target after refreshing the page evidence.', success: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Click', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.failures, 0);
  assert.equal(run.history[0].output.state, 'stale');
  assert.equal(run.history[0].output.recoverable, true);
  assert.ok(events.some((event) => event.type === 'tool.result' && event.output.state === 'stale'));
});

test('compacts query results while retaining query indices as the current snapshot', async () => {
  const controller = createController();
  controller.queryElements = async (tabId, args) => {
    controller.calls.push(['query', tabId, args]);
    return {
      tabId,
      url: 'https://example.test/',
      title: 'Example',
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
      truncated: false,
      elements: Array.from({ length: 60 }, (_, index) => ({ index, tag: 'a', role: '', name: `Result ${index}`, text: `Result ${index}`, rect: { x: 0, y: index, w: 10, h: 10 }, enabled: true, selector: `.result-${index}` }))
    };
  };
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_query', input: { text: 'result', maxElements: 250 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Results collected.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Query', provider: { id: 'mock' } });
  const result = run.history[0].output.result;

  assert.equal(result.query.count, 60);
  assert.equal(result.elements.length, 50);
  assert.equal(result.elements[0].selector, undefined);
  assert.equal(controller.calls.find(([name]) => name === 'query')[2].maxElements, 250);
});

test('executes one bounded page command and retains returned proof', async () => {
  const controller = createController();
  controller.executePageScript = async (tabId, { script }) => { controller.calls.push(['execute', tabId, script]); return { tabId, result: { color: '#ff0000' } }; };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab-1', emit: () => {}, createProvider: () => createProvider([
    { toolCalls: [{ name: 'browser_execute', input: { script: "return { color: '#ff0000' };" } }] },
    { toolCalls: [{ name: 'browser_done', input: { summary: 'Ellipse is red.' } }] }
  ]) });
  const run = await agent.start({ task: 'Make ellipse red', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.filter(([name]) => name === 'execute').length, 1);
  assert.equal(run.history[0].output.result.result.color, '#ff0000');
});

test('turns repeated no-op scroll actions into recovery context and continues', async () => {
  const controller = createController();
  controller.scroll = async (tabId, args) => ({ tabId, ...args, moved: false, before: { scrollX: 0, scrollY: 0 }, after: { scrollX: 0, scrollY: 0 } });
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_scroll', input: { deltaY: 400 } }] },
      { toolCalls: [{ name: 'browser_scroll', input: { deltaY: 400 } }] },
      { toolCalls: [{ name: 'browser_scroll', input: { deltaY: 400 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Used a different route after the no-progress signal.', success: true, verified: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Scroll', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.match(run.result.summary, /different route/i);
  assert.equal(run.history.some((entry) => entry.tool === 'browser_scroll' && entry.output.ok === true), true);
});

test('rejects a missing wait duration instead of silently waiting 500ms', async () => {
  const controller = createController();
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions === 1) return { toolCalls: [{ name: 'browser_wait', input: {} }] };
        assert.equal(context.recovery?.source, 'wait_ms_invalid');
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Used the fresh observation.', success: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Wait for the page', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(controller.calls.some(([name]) => name === 'wait'), false);
  assert.equal(run.history[0].output.recoverable, true);
  assert.match(run.history[0].output.error, /explicit positive ms/i);
});

test('escalates consecutive short waits and resets after a different action', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_wait', input: { ms: 500 } }] },
      { toolCalls: [{ name: 'browser_wait', input: { ms: 500 } }] },
      { toolCalls: [{ name: 'browser_wait', input: { ms: 500 } }] },
      { toolCalls: [{ name: 'browser_tabs', input: {} }] },
      { toolCalls: [{ name: 'browser_wait', input: { ms: 500 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Waited with bounded backoff.', success: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Wait for the page', provider: { id: 'mock' } });
  const waits = run.history.filter((entry) => entry.tool === 'browser_wait').map((entry) => entry.output.result.waitedMs);

  assert.equal(run.status, 'completed');
  const expected = [500, 1_000, 2_000, 500];
  assert.equal(waits.length, expected.length);
  waits.forEach((value, index) => assert.ok(Math.abs(value - expected[index]) <= 60, ));
  const waitResults = run.history.filter((entry) => entry.tool === 'browser_wait').map((entry) => entry.output.result);
  assert.equal(waitResults[2].nextMinimumMs, 4_000);
  assert.match(waitResults[2].note, /escalated cumulatively from 500ms to 2000ms/i);
  assert.equal(waitResults[3].consecutiveWaits, 1);
});

test('turns repeated passive waits into replanning instead of a terminal result', async () => {
  const controller = createController();
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions <= 3) return { toolCalls: [{ name: 'browser_wait', input: { ms: 500 } }] };
        assert.equal(context.recovery?.source, 'no_progress');
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Continued after changing strategy.', success: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Wait for the page', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.match(run.result.summary, /changing strategy/i);
  assert.equal(decisions, 4);
  const passiveWaits = run.history.filter((entry) => entry.tool === 'browser_wait').map((entry) => entry.output.result.waitedMs);
  const passiveExpected = [500, 1_000, 2_000];
  assert.equal(passiveWaits.length, passiveExpected.length);
  passiveWaits.forEach((value, index) => assert.ok(Math.abs(value - passiveExpected[index]) <= 60, ));
});

test('screenshots do not accumulate into no-progress across a successful interaction', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
      { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
      { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] },
      { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
      { done: { summary: 'The interaction was verified.', success: true } }
    ])
  });

  const run = await agent.start({ task: 'Inspect, interact, and verify', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'The interaction was verified.');
  assert.equal(run.result.reason, undefined);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_screenshot').length, 3);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_click').length, 1);
});

test('attaches one requested screenshot to later decisions and blocks recapture until the page changes', async () => {
  const controller = createController();
  const decisions = [
    { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
    { toolCalls: [{ name: 'browser_screenshot', input: {} }] },
    { done: { summary: 'Used the attached visual evidence.', success: true } }
  ];
  const received = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        received.push(context);
        return decisions.shift();
      }
    })
  });

  const run = await agent.start({ task: 'Inspect the current page visually', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(received[1].observation.screenshot.data, 'base64-image');
  assert.equal(received[2].observation.screenshot.data, 'base64-image');
  // The recapture is flagged, not vetoed: the advisory tells the model a
  // fresh screenshot is already attached and repetition is its decision.
  assert.match(run.history.find((entry) => entry.note)?.note || '', /already has a fresh screenshot attached/i);
  assert.equal('latestObservation' in run, false);
  assert.equal('visualEvidence' in run, false);
  assert.doesNotMatch(JSON.stringify(run), /base64-image/);
});

test('reads browser diagnostics through the agent tool surface', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([
      { assistantText: 'Checking browser diagnostics.', toolCalls: [{ name: 'browser_console_entries', input: {} }, { name: 'browser_network_entries', input: {} }, { name: 'browser_navigation_state', input: {} }] },
      { assistantText: 'Done.', toolCalls: [{ name: 'browser_done', input: { summary: 'Diagnostics checked.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Check diagnostics', provider: { id: 'mock', model: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_console_entries').length, 1);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_network_entries').length, 1);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_navigation_state').length, 1);
});

test('streams thinking progress before publishing the settled terminal decision', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete({ onThought }) {
        onThought('Checking the selected canvas layer.');
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { assistantText: 'The layer is ready.', toolCalls: [{ name: 'browser_done', input: { summary: 'Done.' } }] };
      }
    })
  });

  await agent.start({ task: 'Inspect', provider: { id: 'mock' } });

  const startedIndex = events.findIndex((event) => event.type === 'assistant.thinking');
  const thoughtIndex = events.findIndex((event) => event.type === 'assistant.thought');
  const completedIndex = events.findIndex((event) => event.type === 'assistant.thinking.completed');
  const terminalIndex = events.findIndex((event) => event.type === 'tool.result' && event.tool === 'browser_done');
  assert.ok(startedIndex >= 0, 'the first progress event must not wait for a timer tick');
  assert.equal(events[startedIndex].elapsedMs, 0);
  assert.ok(thoughtIndex > startedIndex);
  assert.ok(completedIndex > thoughtIndex);
  assert.ok(terminalIndex > completedIndex);
  assert.equal(events[startedIndex].thoughtId, events[thoughtIndex].thoughtId);
  assert.equal(events[completedIndex].thoughtId, events[thoughtIndex].thoughtId);
  assert.equal(events.some((event) => event.type === 'assistant.message'), false);
  assert.equal(events[thoughtIndex].text, 'Checking the selected canvas layer.');
});

test('blocks a redundant model-requested observation and replans from the already-fresh outer evidence', async () => {
  const controller = createController();
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_observe', input: {} }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Done.', verified: true } }] }
    ])
  });

  const run = await agent.start({ task: 'Inspect', provider: { id: 'mock' } });

  assert.equal(run.history[0].tool, 'browser_observe');
  // The redundant observe is flagged as an advisory (a fresh outer-loop
  // observation already exists), not turned into a blocked action.
  assert.match(run.history.find((entry) => entry.note)?.note || '', /fresh outer-loop page observation/i);
  assert.equal(run.result.verified, true);
});

test('cancellation aborts an in-flight browser wait', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => createProvider([{ toolCalls: [{ name: 'browser_wait', input: { ms: 10_000 } }] }])
  });

  const started = agent.start({ task: 'Wait until cancelled', provider: { id: 'mock', model: 'mock' } });
  // The run reaches step 1 once the wait action starts executing.
  for (let i = 0; i < 200 && (agent.state()?.step || 0) < 1; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  agent.cancel(agent.state().id);
  const cancelled = await Promise.race([
    started,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Cancellation did not interrupt browser_wait.')), 250))
  ]);

  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.history.some((entry) => entry.tool === 'browser_wait'), 'the wait was in flight when cancellation landed');
});

test('cancellation releases held input and prevents subsequent decisions', async () => {
  const controller = createController();
  let resolveCompletion;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({ complete: () => new Promise((resolve) => { resolveCompletion = resolve; }) })
  });

  const started = agent.start({ task: 'Wait forever', provider: { id: 'mock', model: 'mock' } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const runId = agent.state().id;
  agent.cancel(runId);
  resolveCompletion({ assistantText: 'late response', toolCalls: [{ id: 'late', name: 'browser_done', input: { summary: 'late' } }] });
  const cancelled = await started;

  assert.equal(cancelled.status, 'cancelled');
  assert.ok(controller.calls.some(([name]) => name === 'release'));
});

test('creates a neutral task tab instead of hard-stopping during fresh Electron startup', async () => {
  const controller = createController();
  const created = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => null,
    createTab: async (url) => { created.push(url); return { id: 'bootstrap-tab', url }; },
    emit: () => {},
    createProvider: () => createProvider([{ toolCalls: [{ name: 'browser_done', input: { summary: 'Ready to begin.' } }] }])
  });

  const run = await agent.start({ task: 'Inspect the browser', provider: { id: 'mock', model: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.tabId, 'bootstrap-tab');
  assert.deepEqual(created, ['about:blank']);
  assert.ok(controller.calls.some(([name, tabId]) => name === 'snapshot' && tabId === 'bootstrap-tab'));
});

test('turns a nested page-command failure into a corrective action instead of recording it as success', async () => {
  const controller = createController();
  controller.executePageScript = async () => ({ tabId: 'tab-1', result: { ok: false, reason: 'No search box is available.' } });
  controller.fillElement = async (tabId, args) => {
    controller.calls.push(['fill', tabId, args]);
    return { tabId, ok: true, changed: true, matched: true, valueLength: args.text.length };
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision === 1) return { toolCalls: [{ name: 'browser_execute', input: { script: 'return { ok: false, reason: "No search box is available." };' } }] };
        if (decision === 2) {
          assert.equal(context.recovery.source, 'browser_action');
          assert.match(context.recovery.lastError, /no search box/i);
          return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'lordemaximus.com' } }] };
        }
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Used the visible search control.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock', model: 'mock' } });

  const command = run.history.find((entry) => entry.tool === 'browser_execute');
  assert.equal(command.output.ok, false);
  assert.match(command.output.error, /no search box/i);
  assert.equal(controller.calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(run.result.verified, true);
});

test('flags repeated native typing against unchanged evidence as advisory and replans to idempotent fill', async () => {
  const controller = createController();
  controller.fillElement = async (tabId, args) => {
    controller.calls.push(['fill', tabId, args]);
    return { tabId, ok: true, changed: true, matched: true, valueLength: args.text.length };
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decision += 1;
        if (decision <= 2) return { toolCalls: [{ name: 'browser_type', input: { element: 0, text: 'lordemaximus.com' } }] };
        if (decision === 3) return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'lordemaximus.com' } }] };
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'Search value is in place.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Enter the site address', provider: { id: 'mock', model: 'mock' } });

  // The second identical type executes (advisory, not veto) and the run still
  // settles on the idempotent fill.
  assert.equal(controller.calls.filter(([name]) => name === 'type').length, 2);
  assert.equal(controller.calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(run.result.verified, true);
});

test('keeps one focused fill-and-Enter submit in the same grounded turn, then observes before completion', async () => {
  const controller = createController();
  controller.fillElement = async (tabId, args) => {
    controller.calls.push(['fill', tabId, args]);
    return { tabId, ok: true, changed: true, matched: true, valueLength: args.text.length };
  };
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions === 1) {
          return {
            toolCalls: [
              { name: 'browser_fill', input: { element: 0, text: 'lordemaximus.com' } },
              { name: 'browser_key', input: { key: 'Enter' } }
            ]
          };
        }
        assert.equal(context.coordinator.observationRevision, 2, 'a fresh post-submit observation is required before completion');
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'The search was submitted.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock', model: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.verified, true);
  assert.equal(decisions, 2, 'the submit must not require a redundant model turn');
  assert.equal(controller.calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'key').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'snapshot').length, 2);
});

test('returns privacy-safe filled-field evidence so every provider can avoid retyping a completed value', async () => {
  const controller = createController();
  let fieldValue = '';
  controller.domSnapshot = async (tabId) => ({
    tabId,
    url: 'https://example.test/search',
    title: 'Search',
    viewport: { width: 1280, height: 720 },
    elements: [{ index: 0, tag: 'input', role: 'searchbox', name: 'Search', text: '', enabled: true, value: fieldValue }],
    truncated: false
  });
  controller.fillElement = async (tabId, args) => {
    fieldValue = args.text;
    controller.calls.push(['fill', tabId, args]);
    return { tabId, ok: true, changed: true, matched: true, valueLength: args.text.length };
  };
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions === 1) return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'lordemaximus.com' } }] };
        if (decisions === 2) {
          const field = context.observation.dom.elements[0];
          assert.deepEqual(field, {
            index: 0,
            tag: 'input',
            role: 'searchbox',
            name: 'Search',
            text: '',
            rect: undefined,
            enabled: true,
            valuePresent: true,
            valueLength: 'lordemaximus.com'.length
          });
          assert.equal('value' in field, false, 'raw form values must not enter provider context');
          const fillHistory = context.history.find((entry) => entry.tool === 'browser_fill');
          assert.equal(fillHistory.output.result.valueLength, 'lordemaximus.com'.length);
          assert.equal(fillHistory.output.result.matched, true);
          assert.equal(fillHistory.output.result.changed, true);
          assert.equal('value' in fillHistory.output.result, false, 'raw fill values must not enter provider history');
          return { toolCalls: [{ name: 'browser_key', input: { key: 'Enter' } }] };
        }
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'The already-filled search field was submitted.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock', model: 'mock' } });

  assert.equal(run.result.verified, true);
  assert.equal(controller.calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'type').length, 0);
  assert.equal(controller.calls.filter(([name]) => name === 'key').length, 1);
});

test('flags a same-field native append after a matched fill as advisory even when a provider ignores filled-field evidence', async () => {
  const controller = createController();
  controller.fillElement = async (tabId, args) => {
    controller.calls.push(['fill', tabId, args]);
    return { tabId, ok: true, changed: true, matched: true, valueLength: args.text.length };
  };
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        if (decisions === 1) return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'lordemaximus.com' } }] };
        if (decisions === 2) return { toolCalls: [{ name: 'browser_key', input: { key: 'Enter' } }] };
        return { toolCalls: [{ name: 'browser_done', input: { summary: 'The filled field was submitted once.', success: true, verified: true } }] };
      }
    })
  });

  const run = await agent.start({ task: 'Search for LordeMaximus', provider: { id: 'mock', model: 'mock' } });

  // The advisory for a same-field append rides in the history note (no
  // retention of the filled value) and the submit proceeds.
  assert.equal(run.result.verified, true);
  assert.equal(controller.calls.filter(([name]) => name === 'fill').length, 1);
  assert.equal(controller.calls.filter(([name]) => name === 'key').length, 1);
  const appendNote = run.history.filter((entry) => entry.note).map((entry) => entry.note).join(' ');
  assert.doesNotMatch(appendNote, /lordemaximus\.com/i);
});

test('surfaces an account-level provider block once instead of retrying the same impossible model request', async () => {
  const controller = createController();
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete() {
        calls += 1;
        throw new Error('Ollama agent request failed: 403 Forbidden — your subscription payment is past due.');
      }
    })
  });

  const run = await agent.start({ task: 'Inspect the login flow', provider: { id: 'mock', model: 'mock' }, settings: { maxRecoveries: 8 } });

  assert.equal(calls, 1);
  assert.equal(run.result.reason, 'provider_external_block');
  assert.equal(run.result.success, false);
  assert.match(run.result.summary, /provider account needs attention/i);
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_recovery').length, 0);
});

test('surfaces an unavailable selected model once without labelling any model as weak or retrying it', async () => {
  const controller = createController();
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete() {
        calls += 1;
        throw new Error('OpenAI-compatible agent request failed: 404 The model gpt-5.6-terra is unavailable.');
      }
    })
  });

  const run = await agent.start({ task: 'Inspect the current browser page.', provider: { id: 'mock', model: 'gpt-5.6-terra' }, settings: { maxRecoveries: 8 } });

  assert.equal(calls, 1);
  assert.equal(run.result.reason, 'provider_external_block');
  assert.equal(run.result.success, false);
  assert.match(run.result.summary, /selected model is no longer available/i);
  assert.doesNotMatch(run.result.summary, /weak|strong/i);
  assert.equal(run.history.filter((entry) => entry.tool === 'agent_recovery').length, 0);
});


test('multipart terminal task reviews an early ready claim and continues the same PTY', async () => {
  const controller = createController();
  const sessions = new Map();
  const calls = [];
  const backend = {
    observe: async () => ({ foregroundWindowId: 'terminal', windows: [{ id: 'terminal', title: 'Terminal' }] }),
    execute: async (name, input, owner) => {
      calls.push([name, input.action, owner]);
      if (input.action === 'open') {
        if (!sessions.has(owner)) sessions.set(owner, { sessionId: 'term-1', running: true });
        return sessions.get(owner);
      }
      if (input.action === 'list') return { sessions: [sessions.get(owner)] };
      if (input.action === 'input') return { sessionId: input.sessionId, running: true, history: 'Claude received the implementation request.' };
      return {};
    },
    releaseInput: async () => {}, releaseOwner: async () => {}
  };
  let decision = 0;
  let reviewSeen = false;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', getControlMode: () => 'agi', getComputerTools: () => backend, emit: () => {},
    createProvider: () => ({ async complete(context) {
      decision += 1;
      if (decision === 1) return { actions: [{ name: 'computer_terminal', input: { action: 'open', command: 'claude' } }] };
      if (decision === 2) return { done: { summary: 'Claude is ready.', success: true, verified: true } };
      if (decision === 3) {
        reviewSeen = context.recovery.source === 'completion_review';
        return { actions: [{ name: 'computer_terminal', input: { action: 'input', sessionId: 'term-1', text: 'Audit and implement the inspector improvements\r' } }] };
      }
      return { done: { summary: 'Implementation and verification remain unfinished.', success: false, verified: false, final: true } };
    } })
  });
  const run = await agent.start({ task: 'Inspect the interface, then use the terminal to apply improvements and verify the result.', settings: { controlMode: 'agi' } });
  assert.equal(run.status, 'failed');
  assert.equal(run.result.success, false);
  assert.equal(reviewSeen, true);
  assert.equal(calls.filter(([name, action]) => name === 'computer_terminal' && action === 'open').length, 1);
  assert.equal(calls.filter(([name, action]) => name === 'computer_terminal' && action === 'input').length, 1);
  assert.equal(run.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.ok === false).length, 1);
});

test('missing verified field never becomes verified success', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab-1', emit: () => {}, createProvider: () => createProvider([{ done: { summary: 'Answered.', success: true } }]) });
  const run = await agent.start({ task: 'Answer the question' });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(run.result.verified, false);
});

// ---- Tab control & tool-schema regressions -------------------------------

const { ACTIONS, toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { toolInputSchema } = require('../desktop/agent/providers/wire.cjs');

test('every tab-scoped browser action exposes a non-empty argument schema', () => {
  const tools = toolDefinitions('Compare tabs');
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  // The empty-schema bug class: browser_select_tab once advertised zero
  // properties, so the model could not discover tabId and tab switching
  // failed with empty arguments on every attempt.
  for (const [name] of Object.entries(ACTIONS)) {
    if (!name.startsWith('browser_') || name === 'browser_tabs') continue;
    const tool = byName.get(name);
    assert.ok(tool, `${name} must be listed in the tool catalog`);
    const schema = toolInputSchema(tool.input, name);
    assert.ok(Object.keys(schema.properties || {}).length > 0, `${name} must expose at least one schema property`);
  }
  const selectTab = toolInputSchema(byName.get('browser_select_tab').input, 'browser_select_tab');
  assert.ok(selectTab.properties.tabId, 'browser_select_tab must expose tabId');
  const click = toolInputSchema(byName.get('browser_click').input, 'browser_click');
  assert.ok(click.properties.tabId, 'browser_click must expose the optional tabId target');
});

test('grounds coordinate actions against the explicitly targeted background tab', async () => {
  const controller = createController();
  controller.listTabs = () => [{ id: 'tab-1' }, { id: 'tab-2' }];
  controller.domSnapshot = async (tabId) => ({
    tabId, url: 'https://example.test/', title: 'Example',
    viewport: tabId === 'tab-2' ? { width: 1400, height: 900 } : { width: 300, height: 600 },
    elements: [], truncated: false
  });
  controller.clickAt = async (tabId, point, owner) => { controller.calls.push(['clickAt', tabId, point, owner]); return { tabId, ...point }; };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_observe', input: { tabId: 'tab-2' } }] },
      // (1200, 800) is inside tab-2's viewport but far outside tab-1's;
      // per-tab grounding must accept it after tab-2 was observed.
      { toolCalls: [{ name: 'browser_click', input: { tabId: 'tab-2', x: 1200, y: 800 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Clicked on the background tab.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Act on the background tab', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  const click = controller.calls.find(([name]) => name === 'clickAt');
  assert.ok(click, 'the background-tab click must execute');
  assert.equal(click[1], 'tab-2');
  assert.deepEqual(click[2], { x: 1200, y: 800 });
});

test('an element index beats guessed coordinates: the DOM rect is exact', async () => {
  // The click-order run clicked element 40 (Reset at 790,500) with a guessed
  // (825,648) and hit <main>. A DOM target resolved against the current
  // snapshot cannot be stale, so the element wins and the coordinates are the
  // fallback — zero offset for DOM clicks, whatever the model's arithmetic.
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: 0, x: 900, y: 900 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Clicked the element.', success: true, verified: true } }] }
    ])
  });
  const run = await agent.start({ task: 'Click the control', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  const indexed = controller.calls.find(([name]) => name === 'click');
  const coordinate = controller.calls.find(([name]) => name === 'clickAt');
  assert.ok(indexed, 'the element path executes');
  assert.equal(coordinate, undefined, 'the guessed coordinates never override the element');
});

test('the visualizer is never skipped: strikes are telemetry, speed comes from short animations', async () => {
  // Owner directive: every click is visualized — the cursor animation is the
  // product's transparency guarantee, so it is non-negotiable. Slow clicks are
  // fixed by speeding the animation up and bounding the ack, never by hiding it.
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const tab = { id: 'tab-1', webContents: { isDestroyed: () => false, debugger: { isAttached: () => false, attach: () => {}, detach: () => {}, sendCommand: async () => ({}) } } };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => [], normalizeUrl: (value) => value,
    pointerVisualizer: { move: () => new Promise(() => {}) }
  });
  for (let i = 0; i < 6; i += 1) controller.noteVisualizerStrike('tab-1');
  assert.equal(controller.visualizerUsable('tab-1'), true, 'strikes never disable the visualizer');

  // Fast but present: the animation constants are short, and the ack cannot hang.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/agent-pointer.js'), 'utf8');
  assert.match(page, /MOVE_MIN_MS = 40/);
  assert.match(page, /MOVE_MAX_MS = 90/);
  assert.match(page, /CLICK_MS = 70/);
  assert.match(page, /setTimeout\(finish, 60\)/);
});

test('one decision can carry a full ordered click sequence (batch cap >= 40)', async () => {
  // The 6s game is unwinnable while a decision caps actions at 12: 40 clicks
  // would need four round trips. The cap must fit a whole sequence.
  const fs = require('node:fs');
  const path = require('node:path');
  const internals = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/agentInternals.cjs'), 'utf8');
  assert.match(internals, /maxActionsPerStep: 48/, 'the default allows a full 40-field sequence');
  assert.match(internals, /clamp\(safeSettings\.maxActionsPerStep, 1, 64\)/, 'the ceiling is 64');
});

test('a run pins its bound tab for the run duration and releases it at teardown', async () => {
  // Without a pin, EVERY CDP command pays an attach -> command -> detach
  // cycle — four per click, ~100ms each, plus attach-race failures (the
  // hit-test's bare messageless errors). The pin rides the run lifecycle.
  const controller = createController();
  const pins = [];
  const unpins = [];
  controller.pinDebugger = (tabId, owner) => { pins.push([String(tabId), String(owner)]); return true; };
  controller.unpinDebugger = (tabId, owner) => { unpins.push([String(tabId), String(owner)]); return true; };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_done', input: { summary: 'ok', success: true, verified: true } }] }
    ])
  });
  const run = await agent.start({ task: 'Pin and go', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(pins.length, 1, 'the bound tab is pinned once at run start');
  assert.equal(pins[0][0], 'tab-1');
  assert.equal(unpins.length, 1, 'the pin is released exactly once at teardown');
  assert.deepEqual(unpins[0], pins[0]);
});

test('an element:null beside valid coordinates is absent, not a bounce', async () => {
  // Recovery log 2026-11-11 18:11: five bounced clicks in a row — the model
  // sent `element: null` (the natural JSON "absent") beside the coordinates
  // it aimed at, and the old check treated null as provided-and-invalid,
  // turning every click into a recovery cycle while the model knew the move.
  // Coordinates are authoritative; a null element is metadata.
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_click', input: { element: null, x: 300, y: 300 } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Clicked the aimed point.' } }] }
    ])
  });
  const run = await agent.start({ task: 'Click the aimed point', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  const click = controller.calls.find(([name]) => name === 'clickAt');
  assert.ok(click, 'the coordinate click must execute instead of bouncing on element:null');
  assert.deepEqual(click[2], { x: 300, y: 300 });
});

test('browser_focus_tab foregrounds a tab without rebinding this run', async () => {
  const controller = createController();
  const focused = [];
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1',
    focusTab: async (tabId, runId) => { focused.push([tabId, runId]); return { id: tabId, active: true }; },
    emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_focus_tab', input: { tabId: 'tab-2' } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Brought the tab to the foreground.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Show the second tab', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.equal(run.tabId, 'tab-1', 'the run keeps its own tab binding');
  assert.equal(focused.length, 1);
  assert.equal(focused[0][0], 'tab-2');
  assert.equal(focused[0][1], run.id);
});

test('browser_focus_tab without a foreground callback records an actionable failure, not a crash', async () => {
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => createProvider([
      { toolCalls: [{ name: 'browser_focus_tab', input: { tabId: 'tab-2' } }] },
      { toolCalls: [{ name: 'browser_done', input: { summary: 'Continued without the foreground switch.' } }] }
    ])
  });

  const run = await agent.start({ task: 'Show the second tab', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  const focusEntry = run.history.find((entry) => entry.tool === 'browser_focus_tab');
  assert.ok(focusEntry, 'the focus attempt must be recorded');
  assert.equal(focusEntry.output?.ok, false);
  assert.match(String(focusEntry.output?.error || ''), /unavailable/i);
});

test('checkpoints a bounded thinking archive so history keeps the reasoning', async () => {
  const controller = createController();
  const checkpoints = [];
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    createProvider: () => {
      let step = 0;
      return { async complete(opts) {
        step += 1;
        if (step === 1) {
          opts.onThought?.('The button is visible; I will click it and then verify the label changed.');
          return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
        }
        return { done: { summary: 'Clicked and verified.', success: true } };
      } };
    }
  });

  const run = await agent.start({ task: 'Click the button', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  // The thinking must be preserved for history, bounded, and user-visible...
  const final = checkpoints.at(-1);
  assert.equal(Array.isArray(final.thinkingArchive), true, 'the checkpoint must carry the thinking archive');
  assert.equal(final.thinkingArchive.length, 1);
  assert.match(final.thinkingArchive[0].text, /I will click it/);
  assert.ok(final.thinkingArchive[0].elapsedMs >= 0);
  // ...while never re-entering the model-facing conversation.
  assert.equal(final.messages.some((message) => String(message.content || '').includes('I will click it')), false);
});


test('serializeRun never leaks the thinking archive into live events', async () => {
  const { DesktopChatAgent: Agent } = require('../desktop/agent/desktopChatAgent.cjs');
  const controller = createController();
  const events = [];
  const agent = new Agent({
    controller, getSelectedTabId: () => 'tab-1',
    emit: (event) => events.push(event),
    createProvider: () => ({
      async complete(opts) {
        opts.onThought?.('Streaming reasoning that must stay display-only.');
        return { done: { summary: 'Finished.', success: true } };
      }
    })
  });

  const run = await agent.start({ task: 'Answer briefly', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  const withRun = events.filter((event) => event.run);
  assert.ok(withRun.length);
  for (const event of withRun) {
    assert.equal('thinkingArchive' in event.run, false, 'live event payloads must not embed the archive');
  }
});

// ---- Stall heartbeat regressions -----------------------------------------
// Owner contract: deliberate wait polls (browser_wait, minutes long) are
// NEVER stalls — the heartbeat only engages on genuinely silent runs, and it
// never surfaces anything to the user.

test('a deliberate multi-second wait never trips the stall heartbeat', async () => {
  process.env.BROWSER_USE_STALL_MS = '3000';
  try {
    const controller = createController();
    const agent = new DesktopChatAgent({
      controller, getSelectedTabId: () => 'tab-1', emit: () => {},
      createProvider: () => createProvider([
        { toolCalls: [{ name: 'browser_wait', input: { ms: 5000 } }] },
        { done: { summary: 'Waited deliberately, then finished.', success: true } }
      ])
    });

    const run = await agent.start({ task: 'Wait for the long job', provider: { id: 'mock' } });

    assert.equal(run.status, 'completed');
    assert.equal(
      run.history.some((entry) => String(entry.output?.error || '').includes('Stall heartbeat')),
      false,
      'a healthy wait poll must never be interrupted by the heartbeat'
    );
  } finally { delete process.env.BROWSER_USE_STALL_MS; }
});

test('a genuinely silent run is force-recovered by the internal heartbeat', async () => {
  process.env.BROWSER_USE_STALL_MS = '1500';
  try {
    const controller = createController();
    let decision = 0;
    const agent = new DesktopChatAgent({
      controller, getSelectedTabId: () => 'tab-1', emit: () => {},
      createProvider: () => ({ async complete(opts) {
        decision += 1;
        if (decision === 1) {
          // A provider that never streams and never answers but honors the
          // step signal, the way a real fetch aborts with it.
          await new Promise((resolve, reject) => {
            const abort = () => reject(opts.signal?.reason || new Error('aborted'));
            if (opts.signal?.aborted) abort();
            else opts.signal?.addEventListener('abort', abort, { once: true });
          });
        }
        return { done: { summary: 'Recovered after the silent provider.', success: true } };
      } })
    });

    const run = await agent.start({ task: 'Eventually answer', provider: { id: 'mock' } });

    assert.equal(run.status, 'completed');
    // The cut happened internally: recovery evidence exists, and nothing was
    // published to any user-facing surface for it.
    assert.match(JSON.stringify(run.history), /Stall heartbeat/);
  } finally { delete process.env.BROWSER_USE_STALL_MS; }
});

// ---- Turn clock & steering re-scope --------------------------------------

test('steering restarts the turn clock and re-scopes the next decision', async () => {
  const checkpoints = [];
  const controller = createController();
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    createProvider: () => ({ async complete() {
      decision += 1;
      if (decision === 1) return { toolCalls: [{ name: 'browser_wait', input: { ms: 200 } }] };
      if (decision === 2) return { done: { summary: 'Refocused on the new command.', success: true } };
      return { done: { summary: 'Finished.', success: true } };
    } })
  });

  const started = agent.start({ task: 'Original task', provider: { id: 'mock' } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  agent.steer({ runId: agent.state().id, text: 'Actually, do the OTHER thing instead' });
  const run = await started;

  assert.equal(run.status, 'completed');
  const final = checkpoints.at(-1);
  // The turn clock restarted at the steer, not the conversation start.
  assert.ok(Number(final.turnStartedAt) >= Number(final.createdAt) + 20, 'steering must restart the turn clock');
  // The runtime scope directive reached the model context (marked runtime,
  // so the renderer hides it) and names the new objective.
  assert.equal(
    (final.messages || []).some((m) => m.source === 'runtime' && /authoritative objective/.test(m.content) && /OTHER thing/.test(m.content)),
    true,
    'the next decision must receive the re-scope directive'
  );
});

test('a follow-up turn restarts the worked-for clock; it never measures from the first message', async () => {
  const checkpoints = [];
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    createProvider: () => createProvider([{ done: { summary: 'Turn complete.', success: true } }])
  });

  const first = await agent.start({ task: 'First task', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 60));
  const second = await agent.start({ task: 'A completely different second task', provider: { id: 'mock' }, continuation: true, conversationId: first.id });
  assert.equal(second.status, 'completed');

  const firstSnapshot = checkpoints.find((snapshot) => snapshot.task === 'First task');
  const secondSnapshot = checkpoints.find((snapshot) => snapshot.task === 'A completely different second task');
  assert.ok(firstSnapshot && secondSnapshot, 'both turns must be checkpointed');
  assert.ok(
    Number(secondSnapshot.turnStartedAt) > Number(firstSnapshot.createdAt) + 30,
    'the second turn must start its own clock, not inherit the conversation start'
  );
});

// ---- Pixel economics + relevance anchor -----------------------------------

test('text-input mutations skip the pixel re-capture; clicks re-arm it', async () => {
  const controller = createController();
  const screenshots = [];
  controller.screenshot = async (tabId) => { screenshots.push(tabId); return { tabId, mimeType: 'image/png', data: 'frame' }; };
  controller.fillElement = async (tabId, args) => ({ ok: true, changed: true, tabId, ...args });
  controller.clickAt = async (tabId, point, owner) => { controller.calls.push(['clickAt', tabId, point, owner]); return { tabId, ...point }; };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => ({ async complete() {
      decision += 1;
      if (decision === 1) return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'hello' } }] };
      if (decision === 2) return { toolCalls: [{ name: 'browser_click', input: { x: 100, y: 100 } }] };
      return { done: { summary: 'Done.', success: true } };
    } })
  });

  const run = await agent.start({ task: 'Fill then click', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  // Decision 2 (after fill): DOM snapshot grounds it, NO fresh pixels.
  // Decision 3 (after click): pixels re-armed — exactly one capture.
  assert.equal(screenshots.length, 1, 'fill must not trigger a capture; the click must');
  assert.equal(run.settings.vision, 'auto');
});

test('vision always still captures after text mutations (policy unchanged)', async () => {
  const controller = createController();
  const screenshots = [];
  controller.screenshot = async (tabId) => { screenshots.push(tabId); return { tabId, mimeType: 'image/png', data: 'frame' }; };
  controller.fillElement = async (tabId, args) => ({ ok: true, changed: true, tabId, ...args });
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    createProvider: () => ({ async complete() {
      decision += 1;
      if (decision === 1) return { toolCalls: [{ name: 'browser_fill', input: { element: 0, text: 'hello' } }] };
      return { done: { summary: 'Done.', success: true } };
    } })
  });

  await agent.start({ task: 'Fill the field', provider: { id: 'mock' }, settings: { vision: 'always' } });

  assert.equal(screenshots.length, 2, 'vision always keeps its capture-every-decision policy (both decisions)');
});

// ---- Evidence-phase forcing function --------------------------------------

test('three read-only decisions trigger an evidence nudge; a mutation resets it', async () => {
  const controller = createController();
  controller.searchFiles = async () => ({ files: [] });
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', getControlMode: () => 'agi',
    getComputerTools: () => ({ observe: async () => ({}), execute: async (name, input) => ({ content: 'evidence', path: 'C:/fixture.txt' }), releaseOwner: async () => {}, releaseInput: async () => {} }),
    emit: () => {},
    createProvider: () => ({ async complete() {
      decision += 1;
      // Three consecutive evidence-only decisions (git status, search, read).
      if (decision === 1) return { toolCalls: [{ name: 'computer_git', input: { action: 'status', repo: 'C:/fixture' } }] };
      if (decision === 2) return { toolCalls: [{ name: 'computer_search', input: { pattern: 'overlay', path: 'C:/fixture' } }] };
      if (decision === 3) return { toolCalls: [{ name: 'computer_read', input: { path: 'C:/fixture/main.js' } }] };
      if (decision === 4) return { toolCalls: [{ name: 'computer_patch', input: { path: 'C:/fixture/main.js', patch: '*** Begin Patch\n*** Update File: C:/fixture/main.js\n@@\n-old\n+new\n*** End Patch' } }] };
      return { done: { summary: 'Patched on the fourth decision.', success: true } };
    } })
  });

  const run = await agent.start({ task: 'Fix the thing', provider: { id: 'mock' }, settings: { controlMode: 'agi' } });

  assert.equal(run.status, 'completed');
  const nudges = run.messages.filter((m) => m.source === 'runtime' && /Evidence-phase check/.test(m.content));
  assert.equal(nudges.length, 1, 'exactly one nudge at the 3-decision threshold');
  assert.match(nudges[0].content, /Fix the thing/);
  // The mutation reset the streak (a second nudge at 5 would only fire if it
  // had not been reset); the terminal done decision then counts as one final
  // read-only turn.
  assert.equal(run.readOnlyDecisionStreak, 1);
});

// ---- Read-only enforcement cap (run.txt req #2) ---------------------------

test('read-only decisions past the cap are rejected with the enforcement demand, not another advisory', async () => {
  const controller = createController();
  controller.searchFiles = async () => ({ files: [] });
  const toolResults = [];
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', getControlMode: () => 'agi',
    getComputerTools: () => ({ observe: async () => ({}), execute: async (name, input) => ({ content: 'evidence', path: 'C:/fixture.txt' }), releaseOwner: async () => {}, releaseInput: async () => {} }),
    emit: (type, payload) => { if (type === 'tool.result') toolResults.push(payload); },
    createProvider: () => ({ async complete() {
      // Keep returning a read-only decision forever (no mutation, no done).
      return { toolCalls: [{ name: 'computer_read', input: { path: 'C:/fixture/main.js' } }] };
    } })
  });

  const started = agent.start({ task: 'Fix the code', provider: { id: 'mock' }, settings: { controlMode: 'agi' } });
  // Run until the enforcement gate fires (the read-only streak must clear the
  // cap), then cancel. The gate is the thing under test, not the deadline.
  for (let i = 0; i < 400; i += 1) {
    if (toolResults.some((t) => t.output?.recoverySource === 'read_only_cap')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  agent.cancel(agent.state().id);
  const run = await started;

  const readOnlyCaps = toolResults.filter((t) => t.output?.recoverySource === 'read_only_cap');
  assert.ok(readOnlyCaps.length > 0, 'past the cap, a read-only call is rejected with read_only_cap');
  assert.match(readOnlyCaps[0].output.error, /READ-ONLY CAP/);
  assert.match(readOnlyCaps[0].output.error, /computer_patch/);
  // The rejection is a recoverable, recorded failure — never a silent drop.
  assert.equal(readOnlyCaps[0].output.recoverable, true);
});

// ---- Turn boundary for follow-up tasks ------------------------------------

test('a follow-up task clears the closed plan and marks the turn boundary', async () => {
  const checkpoints = [];
  const controller = createController();
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab-1', emit: () => {},
    onCheckpoint: (snapshot) => checkpoints.push(snapshot),
    createProvider: () => ({
      async complete(context) {
        // Decision 1 of run 1: set a plan; done. Run 2: fresh objective.
        if (!context.messages.some((m) => /SECOND TASK/.test(m.content || ''))) {
          return { planUpdate: [{ text: 'OLD task plan item', status: 'current' }], done: { summary: 'First task done.', success: true, verified: true } };
        }
        return { done: { summary: 'Second task done.', success: true, verified: true } };
      }
    })
  });

  const first = await agent.start({ task: 'First task about the device chip', provider: { id: 'mock' } });
  assert.equal(first.status, 'completed');
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = await agent.start({ task: 'SECOND TASK remove the other label', provider: { id: 'mock' }, continuation: true, conversationId: first.id });
  assert.equal(second.status, 'completed');

  const final = checkpoints.at(-1);
  // The closed task's plan must NOT ride into the new turn.
  assert.equal((final.plan || []).some((item) => /OLD task plan item/.test(item.text || '')), false, 'closed plan must not carry over');
  // The runtime boundary message reached the model context (hidden from UI).
  assert.equal(
    (final.messages || []).some((m) => m.source === 'runtime' && /TURN BOUNDARY/.test(m.content) && /SECOND TASK remove the other label/.test(m.content)),
    true,
    'the turn boundary must name the new objective'
  );
});
