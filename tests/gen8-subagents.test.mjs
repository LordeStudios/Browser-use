// tests/gen8-subagents.test.mjs
//
// node --test tests/gen8-subagents.test.mjs
//
// Gen-8 subagent support:
//   A. task_spawn works in the CLI — cli/cliSubagents.cjs runs nested child
//      agents behind an Electron-free AgentPool (mock/override factory), the
//      main DesktopChatAgent dispatches task_spawn through run.spawnTask
//      (the defect: agent-cli passed spawnTask: null -> "Background agent
//      runs are not available in this session."), findings deliver back to
//      the parent, saturation refuses spawns.
//   B. TUI subagent cards: the roster renders below the main run card, click
//      switches the live pane to that subagent's stream, Escape / clicking
//      the main card switches back (unit-level: the store IS the pane state).
//   C. the spawning task text renders as the subagent view's FIRST entry
//      (both the trace contract and the rendered pane).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { createRequire } from 'node:module';
import { createTuiStore } from '../cli/tui/store.mjs';
import { App } from '../cli/tui/App.mjs';
import { createCommandRegistry, makeCompleter } from '../cli/tui/registry.mjs';

const require = createRequire(import.meta.url);
const { createCliSubagentRuntime } = require('../cli/cliSubagents.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const h = React.createElement;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gen8-${label}-`));
}

// A fake child agent (the createAgent override path) whose start() resolves
// like DesktopChatAgent's terminal snapshot and streams events through the
// runtime-provided emit.
function fakeChild(id, { holdMs = 0, summary = 'child findings here', status = 'completed' } = {}) {
  const state = { id, status: 'starting' };
  let released = false;
  let cancelled = false;
  let release = () => { released = true; };
  const gate = holdMs ? new Promise((resolve) => { release = resolve; }) : null;
  return {
    id,
    requests: [],
    state: () => ({ ...state }),
    async start(request) {
      this.requests.push(request);
      state.status = 'running';
      if (gate) await gate;
      if (cancelled) return { id, status: 'cancelled' };
      state.status = status;
      return { id, status, result: { summary } };
    },
    cancel(runId) { cancelled = true; state.status = 'cancelled'; release(); return true; },
    releaseNow() { release(); },
    receiveAgentMessage() { return { delivered: false, reason: 'session-not-live' }; }
  };
}

function createMinimalController() {
  const calls = [];
  return {
    calls,
    async domSnapshot(tabId) {
      calls.push(['snapshot', tabId]);
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Go', text: 'Go', enabled: true }], truncated: false };
    },
    navigationState(tabId) { return { tabId, url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async mouseMove(tabId, args, options) { calls.push(['mousemove', tabId, args, options]); return { tabId, ...args }; },
    async clickElement(tabId, args, owner) { calls.push(['click', tabId, args, owner]); return { tabId, ...args }; },
    async navigate(tabId, url) { calls.push(['navigate', tabId, url]); return { tabId, url }; },
    type(tabId, args) { calls.push(['type', tabId, args]); return { tabId, ...args }; },
    async scroll(tabId, args) { calls.push(['scroll', tabId, args]); return { tabId, ...args }; },
    key(tabId, args, owner) { calls.push(['key', tabId, args, owner]); return { tabId, ...args }; },
    async screenshot(tabId) { calls.push(['screenshot', tabId]); return { tabId, mimeType: 'image/png', data: 'base64-image' }; },
    releaseSessionInput(owner) { calls.push(['release', owner]); return { released: true }; }
  };
}

// ------------------------------------------------------------ A: runtime ---

test('gen8 A: spawnTask runs a nested child agent, task-first trace, findings delivered', async () => {
  const dir = tmpDir('runtime');
  const mainTrace = [];
  const children = [];
  const parentMessages = [];
  const fakeParent = {
    state: () => ({ id: 'main-run-1', status: 'running' }),
    receiveAgentMessage(message) { parentMessages.push(message); return { delivered: true }; }
  };
  const runtime = createCliSubagentRuntime({
    getAgent: () => fakeParent,
    controller: createMinimalController(),
    outDir: dir,
    emitMain: (event) => mainTrace.push(event),
    openSubagentTab: async () => ({ id: `tab-${children.length + 1}` }),
    closeTab: async () => {},
    createProvider: () => ({}),
    createAgent: ({ tabId }) => {
      const child = fakeChild(`child-${children.length + 1}`);
      child.tabId = tabId;
      children.push(child);
      return child;
    }
  });

  const result = await runtime.spawnTask({ task: 'collect the numbers', label: 'worker' }, { id: 'main-run-1', provider: { id: 'mock', model: 'mock', baseUrl: 'x', apiKey: 'k' } });
  assert.equal(result.queued, true);
  assert.equal(result.alias, 'john', 'the first alias comes from the desktop name pool');
  await tick(80); // let the pool dispatch + settle

  // The child ran as a REAL start() with the task text verbatim.
  assert.equal(children.length, 1);
  assert.equal(children[0].requests[0].task, 'collect the numbers');
  assert.equal(children[0].requests[0].agentIdentity, 'john');

  // FEATURE C (CLI): the child's trace FIRST line is the spawning task text.
  const traceLines = fs.readFileSync(result.tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(traceLines[0].type, 'harness.subagent.task');
  assert.equal(traceLines[0].task, 'collect the numbers');
  assert.equal(traceLines[0].alias, 'john');

  // Lifecycle mirrored into the main trace for the TUI.
  const spawned = mainTrace.find((e) => e.type === 'harness.subagent.spawned');
  const finished = mainTrace.find((e) => e.type === 'harness.subagent.finished');
  assert.ok(spawned, 'spawned event reached the main trace');
  assert.equal(spawned.task, 'collect the numbers');
  assert.ok(finished, 'finished event reached the main trace');
  assert.equal(finished.status, 'completed');
  assert.equal(finished.summary, 'child findings here');

  // Findings delivered back into the spawning conversation.
  const delivered = parentMessages.find((m) => m.fromLabel === 'subagent john');
  assert.ok(delivered, 'findings reached the parent through receiveAgentMessage');
  assert.match(delivered.text, /Subagent john — completed/);
  assert.match(delivered.text, /Findings:/);

  // The roster (subagent_list) is compact and honest.
  const roster = runtime.subagentApi.list();
  assert.equal(roster.subagents.length, 1);
  assert.equal(roster.subagents[0].alias, 'john');
  assert.equal(roster.subagents[0].status, 'completed');

  // subagent_close on an unknown alias refuses honestly.
  const badClose = await runtime.subagentApi.close('nobody');
  assert.equal(badClose.closed, false);
});

test('gen8 A: pool saturation refuses spawns with the desktop-shaped payload', async () => {
  const dir = tmpDir('saturate');
  const children = [];
  const runtime = createCliSubagentRuntime({
    outDir: dir,
    emitMain: () => {},
    openSubagentTab: async () => ({ id: `tab-${children.length + 1}` }),
    closeTab: async () => {},
    createProvider: () => ({}),
    cap: 1,
    createAgent: () => {
      const child = fakeChild(`child-${children.length + 1}`, { holdMs: 5000 });
      children.push(child);
      return child;
    }
  });
  const first = await runtime.spawnTask({ task: 'hold the slot' }, { id: 'p' });
  assert.equal(first.queued, true);
  await tick(60); // dispatch claims the single slot
  // The saturation check runs BEFORE the queue push, so the refusal fires
  // when spawns pile up BEHIND a busy slot (same semantics as the desktop's
  // spawnBackgroundTask): spawn #2 queues, spawn #3 is refused.
  const secondPromise = runtime.spawnTask({ task: 'queues behind the slot' }, { id: 'p' });
  const third = await runtime.spawnTask({ task: 'should refuse' }, { id: 'p' });
  const second = await secondPromise;
  assert.equal(second.queued, true, 'spawn #2 waits in the queue');
  assert.equal(third.queued, false);
  assert.equal(third.refused, true);
  assert.equal(third.reason, 'pool-saturated');
  assert.match(third.note, /Spawn REFUSED/);
  await runtime.cancelAll('test cleanup');
  assert.equal(runtime.activeCount(), 0);
  assert.equal(children[0].state().status, 'cancelled', 'cancelAll releases the held child');
});

test('gen8 A: DEFECT REPRODUCTION — spawnTask: null fails task_spawn with the exact observed error', async () => {
  // The pre-fix CLI state (cli/agent-cli.mjs passed spawnTask: null): the
  // model's task_spawn call fails non-recoverably with this exact message —
  // captured here as the defect's ground truth before the fix test below.
  let reproCalls = 0;
  const agent = new DesktopChatAgent({
    controller: createMinimalController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete() {
        reproCalls += 1;
        if (reproCalls === 1) {
          return { toolCalls: [{ name: 'task_spawn', input: { task: 'collect the numbers' } }] };
        }
        return { done: { summary: 'Gave up on spawning.', success: true } };
      }
    }),
    spawnTask: null
  });
  const run = await agent.start({ task: 'coordinate the work', provider: { id: 'mock', model: 'mock' } });
  const entry = run.history.find((e) => e.tool === 'task_spawn');
  assert.ok(entry, 'the failed task_spawn call is recorded in history');
  assert.equal(entry.output?.ok, false);
  assert.equal(entry.output?.error, 'Background agent runs are not available in this session.');
});

test('gen8 A: the MAIN DesktopChatAgent executes task_spawn through the wired runtime (defect A integration)', async () => {
  const dir = tmpDir('dispatch');
  const children = [];
  const runtime = createCliSubagentRuntime({
    outDir: dir,
    emitMain: () => {},
    openSubagentTab: async () => ({ id: `tab-${children.length + 1}` }),
    closeTab: async () => {},
    createProvider: () => ({}),
    createAgent: () => {
      const child = fakeChild(`child-${children.length + 1}`, { summary: 'worker finished its share' });
      children.push(child);
      return child;
    }
  });
  let providerCalls = 0;
  const agent = new DesktopChatAgent({
    controller: createMinimalController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete() {
        providerCalls += 1;
        if (providerCalls === 1) {
          return { toolCalls: [{ name: 'task_spawn', input: { task: 'collect the numbers', label: 'worker' } }] };
        }
        return { done: { summary: 'Spawned the worker.', success: true, verified: true } };
      }
    }),
    // THE DEFECT-A FIX under test: agent-cli now wires the runtime (it used
    // to pass spawnTask: null -> "Background agent runs are not available").
    spawnTask: runtime.spawnTask,
    subagentApi: runtime.subagentApi,
    messageApi: runtime.messageApi
  });
  const run = await agent.start({ task: 'coordinate the work', provider: { id: 'mock', model: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(children.length, 1, 'the task_spawn tool call produced a child agent run');
  assert.equal(children[0].requests[0].task, 'collect the numbers');
  const spawnToolEntry = run.history.find((entry) => entry.tool === 'task_spawn');
  assert.ok(spawnToolEntry, 'task_spawn recorded in the run history');
  assert.equal(spawnToolEntry.output?.ok, true);
  assert.equal(spawnToolEntry.output?.result?.alias, 'john');
});

// ------------------------------------------------------------ B+C: TUI ----

function fullFixtureController({ viewport = { rows: 24, cols: 80 } } = {}) {
  const registry = createCommandRegistry();
  for (const name of ['cancel', 'clear', 'help']) {
    registry.register({ name, args: '', description: `the ${name} command`, handler: async () => {} });
  }
  const store = createTuiStore({
    session: { model: 'z-ai/glm-5.3-flash', providerId: 'xkiro', cwd: 'F:/somewhere/dir', maxSeconds: 0, outRoot: 'F:/somewhere/cli-runs' },
    history: [],
    run: null,
    subagents: [],
    activeSubagent: null
  });
  const controller = {
    store,
    registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    screenMode: 'full',
    interactive: true,
    getViewport: () => viewport,
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    // The real controller's contract: Escape returns from a subagent pane
    // FIRST, cancel only on the main pane.
    onEscape: () => {
      if (store.get().activeSubagent) {
        store.set((state) => ({ ...state, activeSubagent: null }));
        return;
      }
    },
    selectSubagentPane: (alias) => store.set((state) => ({ ...state, activeSubagent: String(alias) })),
    selectMainPane: () => store.set((state) => ({ ...state, activeSubagent: null })),
    handleSubmit: () => {}
  };
  return { controller, store };
}

function seedRunAndSubagent(store) {
  store.set((state) => ({
    ...state,
    run: {
      name: 'run-test',
      outDir: 'F:/somewhere/cli-runs/run-test',
      task: 'main task text',
      startedAt: Date.now(),
      phase: null,
      inFlight: null,
      thinking: null,
      lastTool: null,
      lastError: null,
      tools: []
    },
    subagents: [{
      alias: 'john',
      label: 'subagent john',
      task: 'collect the numbers',
      status: 'running',
      tracePath: 'F:/somewhere/subagents/01-john/trace.jsonl',
      startedAt: Date.now(),
      finishedAt: null,
      summary: null,
      tail: { inFlight: null, thinking: null, lastError: null, lastTool: null, tools: [{ tool: 'browser_click', ok: true, durationMs: 12, ts: 1 }] }
    }],
    activeSubagent: null
  }));
}

test('gen8 B: the subagent card renders below the main run card with status and click hint', async () => {
  const { controller } = fullFixtureController();
  seedRunAndSubagent(controller.store);
  const app = render(h(App, { controller }));
  try {
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ run run-test/, 'the main run card is present');
    assert.match(frame, /▸ subagent john — running — click to view/, 'the subagent roster row renders');
  } finally {
    cleanup();
  }
});

test('gen8 B: clicking the subagent card switches the live pane; clicking the main card switches back', async () => {
  const { controller } = fullFixtureController();
  seedRunAndSubagent(controller.store);
  const app = render(h(App, { controller }));
  try {
    // Frame layout at 24 rows: header 3 + history 13 + run card 5 + roster 1
    // + prompt 1 + footer 1. The roster row is 1-based terminal row 22.
    app.stdin.write('\x1b[<0;10;22M'); // left press on the subagent roster row
    await tick(60);
    let frame = app.lastFrame() || '';
    assert.match(frame, /▸ subagent john/, 'the pane switched to the subagent card');
    assert.match(frame, /collect the numbers/, 'FEATURE C: the task text is the pane first entry');
    assert.match(frame, /viewing \(esc for main run\)/, 'the roster row reflects the active pane');
    assert.doesNotMatch(frame, /▸ run run-test/, 'the main run header is replaced while viewing');

    app.stdin.write('\x1b[<0;10;17M'); // click inside the main run card region
    await tick(60);
    frame = app.lastFrame() || '';
    assert.match(frame, /▸ run run-test/, 'clicking the main card region switches back');
    assert.match(frame, /▸ subagent john — running — click to view/, 'the roster is back to click-to-view');
  } finally {
    cleanup();
  }
});

test('gen8 B: Escape returns from the subagent pane to the main run (and only then cancels)', async () => {
  const { controller } = fullFixtureController();
  seedRunAndSubagent(controller.store);
  controller.store.set((state) => ({ ...state, activeSubagent: 'john' }));
  const app = render(h(App, { controller }));
  try {
    assert.match(app.lastFrame() || '', /▸ subagent john/, 'starts on the subagent pane');
    app.stdin.write('\x1b'); // Escape
    await tick(60);
    assert.match(app.lastFrame() || '', /▸ run run-test/, 'Escape switched back to the main run card');
    assert.equal(controller.store.get().activeSubagent, null);
  } finally {
    cleanup();
  }
});

test('gen8 B: inline tier lists subagents under the live card (display-only)', async () => {
  const registry = createCommandRegistry();
  registry.register({ name: 'help', args: '', description: 'help', handler: async () => {} });
  const store = createTuiStore({
    session: { model: 'm', providerId: 'xkiro', maxSeconds: 0, outRoot: 'F:/o' },
    history: [],
    run: { name: 'run-i', task: 't', startedAt: Date.now(), tools: [] },
    subagents: [{
      alias: 'mary', label: 'subagent mary', task: 'scan the docs', status: 'completed',
      startedAt: Date.now(), finishedAt: Date.now(), summary: null,
      tail: { inFlight: null, thinking: null, lastError: null, lastTool: null, tools: [] }
    }],
    activeSubagent: null
  });
  const controller = {
    store, registry, completer: makeCompleter(registry), version: '0.3.6-test',
    screenMode: 'inline', interactive: false, getLineHistory: () => [],
    answerAsk: () => {}, onCtrlC: () => {}, handleSubmit: () => {}
  };
  const app = render(h(App, { controller }));
  try {
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ subagent mary — completed/, 'the inline roster renders with status');
  } finally {
    cleanup();
  }
});

test('gen8 C: the pane shows the subagent task text BEFORE any tool activity', async () => {
  const { controller } = fullFixtureController();
  seedRunAndSubagent(controller.store);
  controller.store.set((state) => ({ ...state, activeSubagent: 'john' }));
  const app = render(h(App, { controller }));
  try {
    const frame = app.lastFrame() || '';
    const taskIndex = frame.indexOf('collect the numbers');
    const toolIndex = frame.indexOf('browser_click');
    assert.ok(taskIndex !== -1, 'the task text renders');
    assert.ok(toolIndex !== -1, 'the subagent tool line renders');
    assert.ok(taskIndex < toolIndex, 'FEATURE C: the task text comes FIRST, before tool lines');
  } finally {
    cleanup();
  }
});
