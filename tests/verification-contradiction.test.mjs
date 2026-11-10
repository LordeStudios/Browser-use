import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

// Fake-verification gate: verified:true is a LIE when success:false or the
// summary says verification failed. The model must not flip verified:true
// while reporting "could not be verified" — that is the fabrication class the
// user flagged ("empty verifications", run.txt 2026-10-29).

function makeHarness(doneInputs) {
  const backend = new ComputerTools({
    nativeRequest: async () => ({}),
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => {
      const done = doneInputs[Math.min(decision, doneInputs.length - 1)];
      decision++;
      return { actions: [{ name: 'browser_done', input: done }] };
    } })
  });
  return { agent, backend, start: () => agent.start({ task: 'Build and shortcut the program', settings: { approvalMode: 'unattended', controlMode: 'agi' } }) };
}

test('verified:true with success:false is rejected as a contradiction', async () => {
  const h = makeHarness([
    { summary: 'The build is blocked and the shortcut could not be created or verified.', success: false, verified: true },
    { summary: 'The shortcut was created and the tray process is running.', success: true, verified: true }
  ]);
  try {
    const run = await h.start();
    // The contradiction gate must have bounced the first done.
    const bounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.ok === false);
    assert.ok(bounces.length >= 1, `expected at least one bounce for contradictory verified:true, got history length ${run.history?.length}`);
    assert.match(String(bounces[0]?.output?.error || ''), /contradicts/i, 'the error must name the contradiction');
  } finally { await h.backend.close(); }
});

test('verified:true with "could not be verified" in the summary is rejected', async () => {
  const h = makeHarness([
    { summary: 'The shortcut was created but the tray could not be verified.', success: true, verified: true },
    { summary: 'The shortcut was created and the tray process is running.', success: true, verified: true }
  ]);
  try {
    const run = await h.start();
    const bounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.ok === false);
    assert.ok(bounces.length >= 1, 'expected a bounce for unverifiable summary');
    assert.match(String(bounces[0]?.output?.error || ''), /contradicts/i, 'the error must name the contradiction');
  } finally { await h.backend.close(); }
});

test('verified:true with success:true and a clean summary passes the contradiction gate', async () => {
  const h = makeHarness([
    { summary: 'The shortcut was created and the tray process is running.', success: true, verified: true }
  ]);
  try {
    const run = await h.start();
    // The done should be accepted (no contradiction), though other gates may
    // still fire. We only assert the contradiction gate did NOT bounce it.
    const contradictionBounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.error && /contradicts/i.test(e.output.error));
    assert.equal(contradictionBounces.length, 0, 'a clean verified:true must not hit the contradiction gate');
  } finally { await h.backend.close(); }
});
