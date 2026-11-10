import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

// The 2026-10-31 run: the user sent a direct instruction while the agent was
// working and it was ignored, and the agent then made twenty patches to one
// HTML file, the last twelve of them one line each.
//
//   1. The composer HELD the mid-run message in a local queue that was only
//      flushed when the run reached a terminal status. The agent has had live
//      steering for a long time; the composer never used it.
//   2. Nothing told the model to apply a decided change as one patch, so it
//      settled into a read-patch-read-patch rhythm of one-line edits.
//
// These tests cover the agent side of both. The renderer side (the composer
// must call agentSteer, not queue) and the native-window side are covered by
// the e2e files.

function buildAgent(script, options = {}) {
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const requests = [];
  const desktop = {
    headlessUnavailable: false,
    observe: async () => ({ ok: true, screenshot: 'shot' }),
    execute: async (name, input) => {
      if (name === 'computer_patch') {
        return { applied: true, files: [{ path: String(input?.path || ''), action: 'update', addedLines: Number(input?.addedLines) || 1, removedLines: 1 }] };
      }
      return { ok: true };
    },
    releaseOwner: async () => {}
  };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi',
    getComputerTools: () => desktop,
    emit: () => {},
    createProvider: () => ({ complete: async (request) => { requests.push(request); return script(request, agent, requests.length); } })
  });
  return { agent, requests, desktop };
}

test('a message sent while the agent is working reaches the model at the next decision', async () => {
  const { agent, requests } = buildAgent((request, self, turn) => {
    if (turn === 1) {
      // The user types mid-run. The composer must route this to steer().
      self.steer({ runId: self.run.id, text: 'or order' });
      return { actions: [{ name: 'browser_observe', input: {} }] };
    }
    return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
  });
  const run = await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
  ]);
  assert.ok(run, 'the run must finish');
  assert.ok(requests.length >= 2, 'the agent must have taken a second decision');
  const second = requests[1];
  const history = JSON.stringify(second.messages || []);
  assert.ok(history.includes('or order'), 'the steered message must reach the model:\n' + history.slice(0, 600));
  // And it must arrive framed as an ADDITION: the running work continues.
  assert.ok(/ADDITION|extends the running work/i.test(history), 'the steered message must be framed as an addition to the running work');
});

test('the steered message is delivered, not just queued', async () => {
  const events = [];
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const desktop = { headlessUnavailable: false, observe: async () => ({ ok: true, screenshot: 'shot' }), execute: async () => ({ ok: true }), releaseOwner: async () => {} };
  let turn = 0;
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => desktop,
    emit: (event) => events.push(event),
    createProvider: () => ({ complete: async () => {
      turn += 1;
      if (turn === 1) { agent.steer({ runId: agent.run.id, text: 'or order' }); return { actions: [{ name: 'browser_observe', input: {} }] }; }
      return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
    } }) });
  await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(resolve, 20_000))
  ]);
  assert.ok(events.some((event) => event.type === 'user.message.queued'), 'the message must be reported as queued');
  assert.ok(events.some((event) => event.type === 'user.message.delivered'), 'and then as DELIVERED to the running task');
});

test('patching one file a line at a time is called out once, and the model is told to patch in one stroke', async () => {
  const { agent, requests } = buildAgent((request, self, turn) => {
    if (turn <= 3) return { actions: [{ name: 'computer_patch', input: { path: 'C:/tmp/homepage.html', patch: '*** Begin Patch' } }] };
    return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
  });
  const run = await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
  ]);
  assert.ok(run, 'the run must finish');
  const notices = requests.flatMap((request) => request.harnessNotices || []);
  const cadence = notices.find((notice) => /PATCH CADENCE/.test(String(notice)));
  assert.ok(cadence, 'the harness must notice the one-line patch rhythm:\n' + JSON.stringify(notices).slice(0, 600));
  assert.match(String(cadence), /ONE patch/i, 'the notice must tell the model to apply the change in one patch');
  assert.match(String(cadence), /homepage\.html/, 'the notice must name the file being patched a line at a time');
});

// ── PAGE FRESHNESS ─────────────────────────────────────────────────────────
// On 2026-10-31 the agent patched the page file three more times and then
// took a screenshot WITHOUT reloading. The frame showed the page as it was
// before those patches, and the harness accepted it as evidence — so the
// model claimed "the icons render" about a page whose icons had stopped
// rendering.

const PAGE_URL = 'file:///C:/work/app/homepage.html';

function buildBrowserAgent(script) {
  const controller = {
    navigationState: () => ({ url: PAGE_URL, loading: false }),
    domSnapshot: () => ({ url: PAGE_URL, title: 'Home', viewport: { width: 900, height: 700 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {},
    navigate: async (_tabId, url) => ({ tabId: 'tab', url, loading: false }),
    screenshot: async () => ({ ok: true, data: 'base64-frame' })
  };
  const requests = [];
  const desktop = {
    headlessUnavailable: false,
    observe: async () => ({ ok: true, screenshot: 'shot' }),
    execute: async (name, input) => {
      if (name === 'computer_patch') {
        return { applied: true, files: [{ path: String(input?.path || ''), action: 'update', addedLines: 4, removedLines: 4 }] };
      }
      return { ok: true };
    },
    releaseOwner: async () => {}
  };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => desktop,
    emit: () => {},
    createProvider: () => ({ complete: async (request) => { requests.push(request); return script(request, requests.length); } }) });
  return { agent, requests, desktop };
}

test('a screenshot of a page that was not reloaded after the patch is refused', async () => {
  const { agent } = buildBrowserAgent((request, turn) => {
    if (turn === 1) return { actions: [{ name: 'browser_navigate', input: { url: PAGE_URL } }] };
    if (turn === 2) return { actions: [{ name: 'computer_patch', input: { path: 'C:/work/app/homepage.html', patch: '*** Begin Patch' } }] };
    if (turn === 3) return { actions: [{ name: 'browser_screenshot', input: {} }] };
    return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
  });
  const run = await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
  ]);
  assert.ok(run, 'the run must finish');
  const shot = (run.history || []).find((entry) => entry.tool === 'browser_screenshot');
  assert.ok(shot, 'the screenshot must be attempted');
  assert.equal(shot.output.ok, false, 'a stale frame must not be handed over as evidence');
  assert.match(String(shot.output.error || ''), /STALE VIEW/i);
  assert.match(String(shot.output.error || ''), /Reload the page first/i, 'the refusal must say how to fix it');
});

test('after a reload the screenshot is allowed through', async () => {
  const { agent } = buildBrowserAgent((request, turn) => {
    if (turn === 1) return { actions: [{ name: 'browser_navigate', input: { url: PAGE_URL } }] };
    if (turn === 2) return { actions: [{ name: 'computer_patch', input: { path: 'C:/work/app/homepage.html', patch: '*** Begin Patch' } }] };
    if (turn === 3) return { actions: [{ name: 'browser_navigate', input: { url: PAGE_URL } }] };
    if (turn === 4) return { actions: [{ name: 'browser_screenshot', input: {} }] };
    return { actions: [{ name: 'browser_done', input: { summary: 'done', success: true, verified: true } }] };
  });
  const run = await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
  ]);
  assert.ok(run, 'the run must finish');
  const shots = (run.history || []).filter((entry) => entry.tool === 'browser_screenshot');
  assert.ok(shots.length >= 1, 'the screenshot must be attempted');
  assert.equal(shots.at(-1).output.ok, true, 'a frame of a RELOADED page is usable evidence');
});

test('a screenshot taken before the change cannot back a claim about it', async () => {
  const { agent } = buildBrowserAgent((request, turn) => {
    if (turn === 1) return { actions: [{ name: 'browser_navigate', input: { url: PAGE_URL } }] };
    if (turn === 2) return { actions: [{ name: 'browser_screenshot', input: {} }] };
    if (turn === 3) return { actions: [{ name: 'computer_patch', input: { path: 'C:/work/app/homepage.html', patch: '*** Begin Patch\n*** Update File: C:/work/app/homepage.html\n+<i class="ph ph-star"></i>\n*** End Patch' } }] };
    return { actions: [{ name: 'browser_done', input: { summary: 'The screenshot confirms the icons render correctly.', success: true, verified: true } }] };
  });
  const run = await Promise.race([
    agent.start({ task: 'redesign the homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }),
    new Promise((resolve) => setTimeout(() => resolve(null), 20_000))
  ]);
  assert.ok(run, 'the run must finish');
  const done = (run.history || []).filter((entry) => entry.tool === 'browser_done');
  const rejected = done.find((entry) => entry.output?.ok === false);
  assert.ok(rejected, 'a claim backed only by a pre-change frame must be rejected');
  assert.match(String(rejected.output.error || ''), /screenshot/i);
});
