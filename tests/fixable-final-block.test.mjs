import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

// Fixable-problem gate: final:true is ONLY for external blocks the agent
// cannot resolve. A code bug, build error, or startup crash is FIXABLE —
// the agent must fix it, not end the run (run.txt 2026-10-29, 3x "Agent run
// failed" with final:true reporting diagnosed code issues).

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
  return { agent, backend, start: () => agent.start({ task: 'Fix the tray launch issue', settings: { approvalMode: 'unattended', controlMode: 'agi' } }) };
}

test('final:true with a fixable code problem is rejected, not accepted as a block', async () => {
  const h = makeHarness([
    { summary: 'The source code explains the immediate close: tray mode relaunches itself elevated, then refuses to stay alive if startup fails.', success: false, verified: true, final: true },
    { summary: 'The tray stays running after launch.', success: true, verified: true }
  ]);
  try {
    const run = await h.start();
    const bounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.error && /final:true is reserved/i.test(e.output.error));
    assert.ok(bounces.length >= 1, `expected fixable-problem bounce, got history: ${JSON.stringify((run.history||[]).map(e=>({t:e.tool,ok:e.output?.ok})))}`);
    assert.match(String(bounces[0].output.error), /Fix it with computer_patch/i, 'the error must demand the agent fix it');
  } finally { await h.backend.close(); }
});

test('final:true with "exits with code 2" is rejected as fixable', async () => {
  const h = makeHarness([
    { summary: 'Running the executable directly exits with code 2.', success: false, verified: true, final: true },
    { summary: 'The tray stays running after launch.', success: true, verified: true }
  ]);
  try {
    const run = await h.start();
    const bounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.error && /final:true is reserved/i.test(e.output.error));
    assert.ok(bounces.length >= 1, 'expected fixable-problem bounce for exit-code error');
  } finally { await h.backend.close(); }
});

test('final:true with a genuine external block is NOT bounced by the fixable-problem gate', async () => {
  const h = makeHarness([
    { summary: 'The user denied the admin elevation prompt, so the installer cannot proceed. No further action is possible without the user approving UAC.', success: false, verified: true, final: true },
    { summary: 'The user denied the admin elevation prompt.', success: false, verified: true, final: true }
  ]);
  try {
    const run = await h.start();
    const fixableBounces = (run.history || []).filter((e) => e.tool === 'browser_done' && e.output?.error && /final:true is reserved/i.test(e.output.error));
    assert.equal(fixableBounces.length, 0, 'a genuine external block must not hit the fixable-problem gate');
  } finally { await h.backend.close(); }
});
