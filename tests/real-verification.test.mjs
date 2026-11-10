// The real-verification gate: verified:true is PROSE until the run PRODUCES
// proof. The field run (2026-10-29) wrote "Verifying Go installation" in its
// thinking, never ran a verification command, then submitted browser_done
// with verified:true and a success summary — nothing in the tool history
// proved anything. The gates around it demand "a fresh observation, probe
// numbers, or a real test result" but never check that the agent actually
// MADE one. This gate requires an evidence-producing tool call in the run's
// history since the last mutation, and it is BOUNDED (two bounces, then
// accept) so it can never deadlock a run.
//
// Two deliberate carve-outs, both covered below:
//   * a BROWSER turn is verified by the harness's own fresh observation (the
//     loop re-observes the page before every decision) — a desktop frame says
//     nothing about a file's content, so a NATIVE turn must produce a real
//     evidence call;
//   * a turn that ran no tool at all has no change to re-verify — the
//     claim-citation gates own that class.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

const GATE_MESSAGE = /verified:true requires a real verification tool call after your last change/i;

function makeHarness(decisions, task = 'Open the tray application and check that it stays running') {
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
  let turn = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => {
      const decision = decisions[Math.min(turn, decisions.length - 1)];
      turn += 1;
      return decision;
    } })
  });
  return { agent, backend, start: () => agent.start({ task, settings: { approvalMode: 'unattended', controlMode: 'agi' } }) };
}

const gateBounces = (run) => (run.history || [])
  .filter((entry) => entry.tool === 'browser_done' && entry.output?.ok === false && GATE_MESSAGE.test(String(entry.output?.error || '')));
// Owner policy (2026-11-02): verification never blocks a genuine run, so a
// gate's concern is recorded on the ACCEPTED result as a note and an unbacked
// "verified" claim is downgraded to verified:false — no bounce, no error.
const gateNotes = (run) => (run.history || [])
  .filter((entry) => entry.tool === 'browser_done' && GATE_MESSAGE.test(String(entry.output?.verificationNote || '')));

test('verified:true with NO evidence-producing tool call is downgraded, not bounced', async () => {
  // The live bug shape: the run's history was ["computer_write","browser_done"]
  // — a change, then a verified:true claim with nothing that proves it.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-real-verification-'));
  const h = makeHarness([
    { actions: [{ name: 'computer_write', input: { path: path.join(dir, 'install.txt'), content: 'go1.27 installed' } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'The tray application is installed and running.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    assert.equal(run.status, 'completed', 'verification must never block a genuine run');
    assert.equal(run.result.verified, false, 'an unbacked verified:true must not survive as verified');
    assert.equal(run.result.verifiedDowngraded, true, 'the result says the claim was corrected');
    assert.equal(gateBounces(run).length, 0, 'no bounce and no error is shown to the user');
    const notes = gateNotes(run);
    assert.ok(notes.length >= 1, `the concern must still be recorded, got ${JSON.stringify((run.history || []).map((e) => ({ tool: e.tool, ok: e.output?.ok, note: String(e.output?.verificationNote || '').slice(0, 90) })))}`);
    assert.match(String(notes[0].output.verificationNote), /no evidence-producing tool call since the last mutation/i, 'the note must say the history shows no evidence');
    assert.match(String(notes[0].output.verificationNote), /or set verified:false/i, 'the note must offer the honest exit');
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a turn that ran no tool at all is left to the claim-citation gates', async () => {
  // The gate owns "you changed something and then claimed you verified it".
  // A turn with no tool call has no change to re-verify — the claim gates
  // (unbacked_claim, screenshot_claim_unverified) own the "cited evidence
  // that does not exist" class there.
  const h = makeHarness([
    { actions: [{ name: 'browser_done', input: { summary: 'Go 1.27 is installed and the installer was verified.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    assert.equal(gateBounces(run).length, 0, 'no tool call in the turn means no change to re-verify');
  } finally { await h.backend.close(); }
});

test('verified:true after a successful computer_terminal execute IS accepted', async () => {
  const h = makeHarness([
    { actions: [{ name: 'computer_terminal', input: { action: 'execute', command: 'echo verify-evidence-ok' } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'The tray application is installed and running.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    const terminal = (run.history || []).find((entry) => entry.tool === 'computer_terminal');
    assert.ok(terminal, 'the verification command really ran');
    assert.equal(terminal.output?.ok, true, `the command succeeded: ${JSON.stringify(terminal.output?.error || terminal.output?.result?.exitCode)}`);
    assert.equal(gateBounces(run).length, 0, 'a real verification call must not be bounced');
    assert.equal(run.result?.verified, true, `the done was accepted: ${JSON.stringify(run.result || {})}`);
  } finally { await h.backend.close(); }
});

test('verified:false is NOT bounced by the real-verification gate', async () => {
  const h = makeHarness([
    { actions: [{ name: 'browser_done', input: { summary: 'The tray application was launched.', success: true, verified: false } }] }
  ]);
  try {
    const run = await h.start();
    assert.equal(gateBounces(run).length, 0, 'an unverified honest report needs no evidence call');
    assert.equal(run.result?.verified, false, 'the done was accepted as an honest unverified report');
    assert.equal(run.result?.success, true);
  } finally { await h.backend.close(); }
});

test('evidence produced BEFORE the last mutation does not count as verification', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-real-verification-'));
  const h = makeHarness([
    { actions: [{ name: 'computer_terminal', input: { action: 'execute', command: 'echo earlier-evidence' } }] },
    { actions: [{ name: 'computer_write', input: { path: path.join(dir, 'out.txt'), content: 'changed' } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'The tray application is installed and running.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    // The claim is still corrected — a pre-change call is not verification —
    // but the run closes instead of bouncing (owner policy, 2026-11-02).
    assert.equal(run.status, 'completed', 'verification must never block a genuine run');
    assert.equal(run.result.verified, false, 'a pre-change verification call does not back a post-change claim');
    assert.equal(gateBounces(run).length, 0, 'no bounce and no error is shown to the user');
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a fresh browser observation counts as verification evidence', async () => {
  const h = makeHarness([
    { actions: [{ name: 'browser_observe', input: {} }] },
    { actions: [{ name: 'browser_done', input: { summary: 'The tray application is installed and running.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    assert.equal(gateBounces(run).length, 0, 'a fresh observation is real evidence');
    assert.equal(run.result?.verified, true, `the done was accepted: ${JSON.stringify(run.result || {})}`);
  } finally { await h.backend.close(); }
});
