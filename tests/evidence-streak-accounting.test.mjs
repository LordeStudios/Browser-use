// The "EVIDENCE SUFFICIENT" nudge tells the model it has read enough and should
// patch. Field run (2026-10-28, run.txt): it fired while the agent had read
// NOTHING, because decisions whose calls were rejected by argument validation
// still advanced the streak — and the model was told to patch a file it had not
// been able to read. These tests pin the corrected accounting.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

const NUDGE = /EVIDENCE SUFFICIENT/;

async function fixtureDir(fileCount = 12) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-evidence-streak-'));
  for (let i = 0; i < fileCount; i += 1) await fs.writeFile(path.join(dir, `f${i}.txt`), `file ${i}\n`);
  return dir;
}

function harness(decisions) {
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
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend, emit: () => {},
    createProvider: () => ({ complete: async () => {
      const decision = decisions[turn] ?? { actions: [{ name: 'browser_done', input: { summary: 'Done', success: true, verified: true } }] };
      turn += 1;
      return decision;
    } })
  });
  return { agent, backend, start: () => agent.start({ task: 'Fix the thing in the repo', settings: { approvalMode: 'unattended', controlMode: 'agi' } }) };
}

const nudges = (run) => run.messages.filter((m) => m.source === 'runtime' && NUDGE.test(m.content));

test('successful evidence-only decisions still trigger EVIDENCE SUFFICIENT at the 4th decision', async () => {
  const dir = await fixtureDir();
  const decisions = Array.from({ length: 5 }, (_, i) => ({ actions: [{ name: 'computer_read', input: { path: path.join(dir, `f${i}.txt`) } }] }));
  const h = harness(decisions);
  try {
    const run = await h.start();
    assert.equal(nudges(run).length, 1, 'four real, successful reads earn exactly one nudge');
    assert.match(nudges(run)[0].content, /4 consecutive evidence-only decisions/);
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('calls rejected by argument validation are not evidence and never trigger the nudge', async () => {
  const dir = await fixtureDir();
  // Eight decisions, every one a read with a field the schema does not allow.
  const decisions = Array.from({ length: 8 }, (_, i) => ({ actions: [{ name: 'computer_read', input: { path: path.join(dir, `f${i}.txt`), not_a_real_field: 'x' } }] }));
  const h = harness(decisions);
  try {
    const run = await h.start();
    assert.equal(nudges(run).length, 0, 'validation failures must not tell the model it has read enough');
    assert.equal(run.evidenceOnlyStreak || 0, 0, 'the streak never advanced on failed calls');
    const failed = run.history.filter((entry) => entry.tool === 'computer_read' && entry.output?.ok === false);
    assert.ok(failed.length >= 1, 'the calls really were rejected, so this test exercises the failure path');
    assert.ok(failed.every((entry) => entry.output?.error && /Unknown computer_read\.not_a_real_field/.test(entry.output.error)), 'and the model is told which field was wrong');
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a failed call between successful reads does not ADVANCE the streak', async () => {
  const dir = await fixtureDir();
  const read = (i, extra = {}) => ({ actions: [{ name: 'computer_read', input: { path: path.join(dir, `f${i}.txt`), ...extra } }] });
  // ok, ok, FAIL, ok = four decisions but only THREE successful reads. If the
  // failed call counted, the streak would hit 4 here and fire the nudge.
  const h = harness([read(0), read(1), read(2, { bogus: 1 }), read(3)]);
  try {
    const run = await h.start();
    assert.equal(nudges(run).length, 0, 'three successful reads must not be reported as four');
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a failed call between successful reads does not RESET the streak either', async () => {
  const dir = await fixtureDir();
  const read = (i, extra = {}) => ({ actions: [{ name: 'computer_read', input: { path: path.join(dir, `f${i}.txt`), ...extra } }] });
  // ok, ok, FAIL, ok, ok = four successful reads. If the failure reset the
  // streak it would end at 2 and the nudge would never fire; the 4th success
  // (decision 5) is what earns it.
  const h = harness([read(0), read(1), read(2, { bogus: 1 }), read(3), read(4)]);
  try {
    const run = await h.start();
    assert.equal(nudges(run).length, 1, 'the earlier successes still count after an intervening failure');
    assert.match(nudges(run)[0].content, /4 consecutive evidence-only decisions/);
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('computer_fs counts as evidence only for its read actions, never mkdir/copy/move/delete', async () => {
  const dir = await fixtureDir();
  const sub = (i) => path.join(dir, `new-${i}`);
  const mutating = Array.from({ length: 5 }, (_, i) => ({ actions: [{ name: 'computer_fs', input: { action: 'mkdir', path: sub(i) } }] }));
  const hMutating = harness(mutating);
  try {
    const run = await hMutating.start();
    assert.equal(nudges(run).length, 0, 'five directory creations are work, not reading');
  } finally { await hMutating.backend.close(); }

  const listing = Array.from({ length: 5 }, (_, i) => ({ actions: [{ name: 'computer_fs', input: { action: i % 2 ? 'list' : 'stat', path: i % 2 ? dir : path.join(dir, `f${i}.txt`) } }] }));
  const hListing = harness(listing);
  try {
    const run = await hListing.start();
    assert.equal(nudges(run).length, 1, 'stat/list are genuine evidence and still count');
  } finally { await hListing.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('a mutation between reads resets the streak', async () => {
  const dir = await fixtureDir();
  const read = (i) => ({ actions: [{ name: 'computer_read', input: { path: path.join(dir, `f${i}.txt`) } }] });
  const write = { actions: [{ name: 'computer_write', input: { path: path.join(dir, 'out.txt'), content: 'x' } }] };
  // 3 reads, write (reset), 3 reads: never reaches 4 in a row.
  const h = harness([read(0), read(1), read(2), write, read(3), read(4), read(5)]);
  try {
    const run = await h.start();
    assert.equal(nudges(run).length, 0);
  } finally { await h.backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});
