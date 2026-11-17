// Native dialog handling regressions (LORDE_NATIVE_SURFACE_AWARENESS_V365).
//
// Three failure modes this file locks down:
//   1. A browser_click on an element whose label names a file dialog ("Upload",
//      "Browse", "Choose file") used to leave the run on the browser domain,
//      where tab-bound observation literally cannot see the OS window the click
//      just opened -> the run dead-looped. The click must switch the observation
//      domain to the desktop and warn that a dialog is expected.
//   2. deliverNativeSurfaceNotice used to filter dialogs down to our own PID.
//      The permission prompts / file pickers the user actually complained about
//      belong to OTHER processes, so the filter hid exactly the dialogs that
//      dead-locked runs. ANY pid must be detected and surfaced.
//   3. The injected notice must name the tools that can actually resolve the
//      dialog (computer_observe + computer_pointer) and say the domain switched.
//
// Plus the continuation regression: run.nativeSurfaceSeen (the "already
// announced" ledger) must survive a run continuation. Without it the first
// check of the new run re-seeds the baseline from the live window list and a
// dialog that was open-but-never-announced is silently swallowed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent, expectNativeDialog } = require('../desktop/agent/desktopChatAgent.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };

const NOTICES = (run) => run.messages.filter((m) => String(m.content || '').includes('NATIVE DIALOG OPEN'));
const EXPECTED = (run) => (run.harnessNoticeLedger || []).map((entry) => String(entry.text || ''));

// ---------- dispatch harness (mirrors tests/enforcement-gen2.test.mjs) ----------

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}) {
  let calls = 0;
  const controller = {
    navigationState: () => ({ url: 'https://fixture.invalid/upload', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.invalid/upload', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {},
    ...controllerExtras
  };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: (ctx) => complete(ctx, ++calls) })
  });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}

// A minimal agent + run for driving deliverNativeSurfaceNotice directly
// (same shape as tests/telemetry-scan-not-a-tool-call.test.mjs).
function stubAgent() {
  return new DesktopChatAgent({
    controller: {
      navigationState: () => ({ url: '', loading: false }),
      domSnapshot: () => ({ url: '', title: '', viewport: {}, elements: [] }),
      consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {}
    },
    getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => ({}),
    emit() {}, createProvider: () => ({ complete: async () => ({}) })
  });
}

function stubRun(windows, { demand = true } = {}) {
  const run = {
    id: 'native-dialog-test', status: 'running', history: [], messages: [],
    settings: { controlMode: 'agi' },
    getComputerTools: () => ({ execute: async () => ({ windows }) }),
    remoteExecution: false, observationDomain: 'browser', computerOwner: null
  };
  // RE-PINNED (owner directive, 2026-11-12): a native dialog is detected
  // ONLY after the agent asked for one (open as admin, open file, save
  // file, a file picker). The detection rules below are unchanged - any
  // pid, own pid in a browser-domain run, no duplicate nudges, minimized
  // windows are not dialogs - but the detector now runs only against a
  // DEMAND. Without one it never scans, because an unrelated window on the
  // desktop is not a blocker: a live run read a background browser window
  // as "the dialog", left the task, and pressed Escape in an unrelated app.
  if (demand) expectNativeDialog(run, 'the agent asked for a native dialog');
  return run;
}

// ---------- (1a) the Upload click switches the observation domain ----------

test('browser_click on an Upload element switches the observation domain to computer and warns a dialog is expected', async () => {
  const seen = [];
  let turn = 0;
  let clicks = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => { clicks += 1; return { ok: true, index: 0 }; },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'button', name: 'Upload', text: 'Upload' }] }]])
  });
  const run = await h.start({});
  assert.equal(clicks, 1, 'the Upload element was actually clicked');
  assert.equal(run.result.success, true);
  assert.equal(run.observationDomain, 'computer', 'the observation domain switches to the desktop so the dialog is visible');
  const notice = (seen[1] || []).find((line) => /DIALOG EXPECTED/.test(line));
  assert.ok(notice, 'the click arms a DIALOG EXPECTED notice for the next decision');
  assert.match(notice, /computer_observe/, 'the notice names the observation tool');
  assert.match(notice, /computer_pointer/, 'the notice names the input tool');
  assert.match(notice, /switched to desktop/i, 'the notice says the domain switched');
  assert.ok(!(seen[0] || []).some((line) => /DIALOG EXPECTED/.test(line)), 'the notice rides the NEXT decision, not the one that clicked');
});

test('browser_click on a Browse / Choose file element also switches the observation domain', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => ({ ok: true, index: 0 }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'button', name: 'Choose file' }] }]])
  });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.equal(run.observationDomain, 'computer');
});

test('browser_click on an ordinary element keeps the run on the browser domain', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => ({ ok: true, index: 0 }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'button', name: 'Submit order' }] }]])
  });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.equal(run.observationDomain, 'browser', 'an unrelated click must not drag the run onto the desktop');
  assert.equal(EXPECTED(run).some((line) => /DIALOG EXPECTED/.test(line)), false);
});

// ---------- (1b/1c/1d) any-PID detection + the notice text ----------

test('without a demand the detector never runs: an unrelated window is not a blocker', async () => {
  // RE-PINNED (owner directive): the window list is not even read unless the
  // agent asked for a native dialog. A live run chased a background browser
  // window as "the dialog that blocks the work" and pressed Escape in it.
  const agent = stubAgent();
  let scans = 0;
  const run = stubRun([], { demand: false });
  run.getComputerTools = () => ({ execute: async () => { scans += 1; return { windows: [{ id: '77', title: 'Open', pid: 999999, className: '#32770', minimized: false }] }; } });
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(scans, 0, 'the window list is not read without a demand');
  assert.equal(NOTICES(run).length, 0, 'no dialog is announced without a demand');
  assert.equal(run.observationDomain, 'browser', 'the run stays on the browser domain');
});

test('a dialog from ANY pid is detected and surfaced — the same-PID filter is gone on purpose', async () => {
  const agent = stubAgent();
  const FOREIGN = { id: '77', title: 'Open', pid: 999999, className: '#32770', minimized: false };
  const run = stubRun([]);
  await agent.deliverNativeSurfaceNotice(run); // baseline
  run.nativeSurfaceCheckAt = 0;
  run.getComputerTools = () => ({ execute: async () => ({ windows: [FOREIGN] }) });
  await agent.deliverNativeSurfaceNotice(run);
  const notices = NOTICES(run);
  assert.equal(notices.length, 1, 'a foreign-process dialog is exactly the case the old PID filter dead-locked on');
  const text = String(notices[0].content);
  assert.match(text, /computer_observe/, 'the notice names the observation tool');
  assert.match(text, /computer_pointer/, 'the notice names the input tool');
  assert.match(text, /switched to desktop/i, 'the notice says the observation domain switched');
  assert.equal(run.observationDomain, 'computer', 'the run switches to desktop observation to see the dialog');
  assert.equal(run.computerObservationDirty, true, 'the fresh dialog forces a fresh observation before done');
  assert.equal(run.latestObservation, null, 'the cached browser observation cannot show the dialog');
});

test('a dialog owned by our own process is also surfaced in a browser-domain run', async () => {
  const agent = stubAgent();
  const OWN = { id: '88', title: 'Save As', pid: process.pid, className: '#32770', minimized: false };
  const run = stubRun([]);
  await agent.deliverNativeSurfaceNotice(run);
  run.nativeSurfaceCheckAt = 0;
  run.getComputerTools = () => ({ execute: async () => ({ windows: [OWN] }) });
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(NOTICES(run).length, 1, 'a browser-domain run cannot see native windows at all, so ANY fresh dialog means "switch to desktop"');
  assert.match(String(NOTICES(run)[0].content), /computer_observe/);
  assert.match(String(NOTICES(run)[0].content), /computer_pointer/);
});

test('an already-noticed dialog never re-nudges, and a minimized window is never a dialog', async () => {
  const agent = stubAgent();
  const DIALOG = { id: '99', title: 'Open', pid: process.pid, className: '#32770', minimized: false };
  const run = stubRun([]);
  await agent.deliverNativeSurfaceNotice(run);
  run.nativeSurfaceCheckAt = 0;
  run.getComputerTools = () => ({ execute: async () => ({ windows: [DIALOG] }) });
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(NOTICES(run).length, 1);
  run.nativeSurfaceCheckAt = 0;
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(NOTICES(run).length, 1, 'the seen ledger prevents a duplicate nudge for the same window id');

  const minimized = stubRun([]);
  await agent.deliverNativeSurfaceNotice(minimized);
  minimized.nativeSurfaceCheckAt = 0;
  minimized.getComputerTools = () => ({ execute: async () => ({ windows: [{ ...DIALOG, id: '55', minimized: true }] }) });
  await agent.deliverNativeSurfaceNotice(minimized);
  assert.equal(NOTICES(minimized).length, 0, 'a minimized window is not an actionable dialog');
});

test('in the computer domain only foreign-pid dialogs are surfaced; our own are deliberate — but every fresh dialog still arms the done gates', async () => {
  const agent = stubAgent();
  const OWN = { id: '1', title: 'Open', pid: process.pid, className: '#32770', minimized: false };
  const run = stubRun([]);
  await agent.deliverNativeSurfaceNotice(run);
  run.nativeSurfaceCheckAt = 0;
  run.observationDomain = 'computer';
  run.getComputerTools = () => ({ execute: async () => ({ windows: [OWN] }) });
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(NOTICES(run).length, 0, 'a run already driving the desktop is mid-flow on its own dialog');
  assert.equal(run.computerObservationDirty, true, 'a fresh dialog still invalidates the cached observation');
  assert.equal(run.latestObservation, null, 'the cached observation cannot show the dialog');

  const foreignDesktop = stubRun([]);
  await agent.deliverNativeSurfaceNotice(foreignDesktop);
  foreignDesktop.nativeSurfaceCheckAt = 0;
  foreignDesktop.observationDomain = 'computer';
  foreignDesktop.getComputerTools = () => ({ execute: async () => ({ windows: [{ ...OWN, id: '9', pid: 999999 }] }) });
  await agent.deliverNativeSurfaceNotice(foreignDesktop);
  assert.equal(NOTICES(foreignDesktop).length, 1, 'a foreign popup stealing focus mid-desktop-flow is still surfaced');
  assert.match(String(NOTICES(foreignDesktop)[0].content), /computer_observe/);
  assert.match(String(NOTICES(foreignDesktop)[0].content), /computer_pointer/);
});

// ---------- (2) nativeSurfaceSeen survives a run continuation ----------

test('nativeSurfaceSeen serializes as an array and survives a continuation: noticed dialogs never re-nudge, unnoticed ones still fire', async () => {
  const W1 = { id: 'W1', title: 'Main Window', pid: 4242, className: 'AppWindow', minimized: false };
  const D1 = { id: 'D1', title: 'Open', pid: 999999, className: '#32770', minimized: false };
  const D2 = { id: 'D2', title: 'Save As', pid: 999999, className: '#32770', minimized: false };
  let windows = [W1, D1];

  const backend = {
    observe: async () => ({ windows: [], foregroundWindowId: null }),
    scanWindows: async () => ({ windows: [...windows] }),
    execute: async () => ({ changed: true }),
    releaseOwner: async () => {}, releaseInput: async () => {}
  };
  const agent = stubAgent();
  agent.getComputerTools = () => backend;
  agent.run = {
    id: 'persistence-test', task: 'Inspect fixture', status: 'running', history: [], messages: [],
    settings: { controlMode: 'agi' }, getComputerTools: () => backend,
    remoteExecution: false, observationDomain: 'browser', computerOwner: null
  };
  // RE-PINNED (owner directive): the detector runs against a DEMAND.
  expectNativeDialog(agent.run, 'the agent asked for a native dialog');

  // Baseline records W1 and D1 as "predating the run"; then D1 is announced by
  // making it fresh — the point is that both ids end up in the seen ledger.
  await agent.deliverNativeSurfaceNotice(agent.run);
  agent.run.nativeSurfaceSeen.delete('D1'); // simulate D1 arriving after the baseline
  agent.run.nativeSurfaceCheckAt = 0;
  await agent.deliverNativeSurfaceNotice(agent.run);
  assert.equal(NOTICES(agent.run).length, 1, 'the fresh dialog is announced once');
  assert.match(String(NOTICES(agent.run)[0].content), /D1/);

  // The run snapshot must carry the seen ids as a plain ARRAY: a Set survives
  // Electron's structured clone but JSON.stringify(new Set(...)) is `{}`, which
  // silently dropped the ledger on the persistence path.
  const snapshot = agent.state();
  assert.ok(Array.isArray(snapshot.nativeSurfaceSeen), 'the seen ledger serializes as an array, never a bare Set');
  assert.deepEqual([...snapshot.nativeSurfaceSeen].sort(), ['D1', 'W1']);

  // ---- Continuation on a second, fully-wired agent (own controller + provider).
  // D1 is still open (already noticed) and D2 is new, so the continuation must
  // announce D2 exactly once and never re-nudge D1.
  windows = [W1, D1, D2];
  let turn = 0;
  const controller = {
    navigationState: () => ({ url: 'https://fixture.invalid/b', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.invalid/b', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {},
    navigate: async () => ({ url: 'https://fixture.invalid/b' })
  };
  const continuedAgent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {},
    createProvider: () => ({ complete: async () => {
      turn += 1;
      return turn === 1
        ? { actions: [{ name: 'browser_navigate', input: { url: 'https://fixture.invalid/b' } }] }
        : final;
    } })
  });
  continuedAgent.transportRetryDelays = [1];
  const continued = await continuedAgent.start({
    task: 'Inspect fixture',
    continuation: true,
    conversation: { ...snapshot, settings: { controlMode: 'agi', vision: 'off' } },
    settings: { controlMode: 'agi', vision: 'off', approvalMode: 'unattended' }
  });
  assert.equal(continued.status, 'completed', 'the continuation ran to completion');
  // The transcript carries the pre-continuation D1 notice forward; what matters
  // is that the continuation itself announced only D2 and never re-nudged D1.
  const notices = continued.messages.filter((m) => String(m.content || '').includes('NATIVE DIALOG OPEN'));
  assert.equal(notices.filter((m) => /\bD1\b/.test(String(m.content))).length, 1, 'the already-noticed dialog is never re-nudged');
  assert.equal(notices.filter((m) => /\bD2\b/.test(String(m.content))).length, 1, 'exactly one fresh dialog is announced after the continuation');
  assert.equal(notices.filter((m) => /\bW1\b/.test(String(m.content))).length, 0, 'an ordinary window is never announced as a dialog');
  // The ledger keeps growing correctly across the continuation.
  assert.deepEqual([...continued.nativeSurfaceSeen].sort(), ['D1', 'D2', 'W1']);
});
