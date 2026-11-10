import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

// Dead-end detection: a terminal job polled 3× with zero output must trigger a
// harness notice demanding a strategy switch, not silent retry-forever.
// Field run (2026-10-29): winget install polled 4× over 10+ minutes with empty
// output, then the agent claimed "Verifying Go installation" without acting.

function makeHarness(terminalResponses) {
  const backend = new ComputerTools({
    nativeRequest: async () => ({}),
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  let pollIndex = 0;
  const originalExecute = backend.execute.bind(backend);
  backend.execute = async (name, input, owner) => {
    if (name === 'computer_terminal' && input.action === 'read') {
      const resp = terminalResponses[Math.min(pollIndex, terminalResponses.length - 1)];
      pollIndex++;
      return resp;
    }
    return originalExecute(name, input, owner);
  };
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
  const notices = [];
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => {
      decision++;
      // Decisions 1-4: poll the same running job. Decision 5: done.
      if (decision <= 4) return { actions: [{ name: 'computer_terminal', input: { action: 'read', jobId: 'job-1', waitMs: 0 } }] };
      return { actions: [{ name: 'browser_done', input: { summary: 'Done', success: true, verified: true } }] };
    } })
  });
  return { agent, backend, notices, start: () => agent.start({ task: 'Install Go and build the project', settings: { approvalMode: 'unattended', controlMode: 'agi' } }) };
}

test('terminal job stalled 3x with empty output triggers a strategy-switch notice', async () => {
  const runningEmpty = { jobId: 'job-1', state: 'running', output: '', pending: true, readNext: { action: 'read', jobId: 'job-1', offset: 0 } };
  const h = makeHarness([runningEmpty, runningEmpty, runningEmpty, runningEmpty]);
  try {
    const run = await h.start();
    const stallNotices = (run.harnessNoticeLedger || []).map((n) => n.text).filter((text) => /TERMINAL JOB STALL/i.test(text));
    assert.ok(stallNotices.length >= 1, `expected a stall notice, got: ${JSON.stringify(h.notices.slice(0, 5))}`);
    assert.match(stallNotices[0], /switch/i, 'the notice must demand a strategy switch');
    assert.match(stallNotices[0], /Verify whether the expected outcome/i, 'the notice must demand outcome verification');
  } finally { await h.backend.close(); }
});

test('terminal job timeout error triggers a different-approach notice', async () => {
  const timedOut = { jobId: 'job-1', state: 'failed', exitCode: 1, output: '', error: 'Command exceeded the maximum lifetime of 600s and was terminated.' };
  const h = makeHarness([timedOut]);
  try {
    const run = await h.start();
    const timeoutNotices = (run.harnessNoticeLedger || []).map((n) => n.text).filter((text) => /TERMINAL JOB TIMEOUT/i.test(text));
    assert.ok(timeoutNotices.length >= 1, `expected a timeout notice, got: ${JSON.stringify(h.notices.slice(0, 5))}`);
    assert.match(timeoutNotices[0], /Do not retry the same command/i, 'the notice must forbid retrying');
  } finally { await h.backend.close(); }
});

test('a job that produces output does NOT trigger the stall notice', async () => {
  const runningWithOutput = { jobId: 'job-1', state: 'running', output: 'Downloading Go 1.27.0...\n', pending: true, readNext: { action: 'read', jobId: 'job-1', offset: 22 } };
  const h = makeHarness([runningWithOutput, runningWithOutput, runningWithOutput, runningWithOutput]);
  try {
    const run = await h.start();
    const stallNotices = (run.harnessNoticeLedger || []).map((n) => n.text).filter((text) => /TERMINAL JOB STALL/i.test(text));
    assert.equal(stallNotices.length, 0, 'a job with output is not stalled');
  } finally { await h.backend.close(); }
});
