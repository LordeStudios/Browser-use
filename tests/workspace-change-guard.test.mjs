import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import test from 'node:test';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { WorkspaceChangeGuard } = require('../desktop/computer/workspaceChangeGuard.cjs');

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-guard-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'guard@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Guard Test'], { cwd: root });
  const file = path.join(root, 'data.txt');
  await fs.writeFile(file, 'base\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'base'], { cwd: root });
  return { root, file };
}

test('pre-existing dirty files allow fresh exact edits but block blind overwrite and delete', async () => {
  const { root, file } = await fixture();
  const guard = new WorkspaceChangeGuard();
  try {
    await fs.writeFile(file, 'user edit\n');
    const read = await guard.noteRead('chat:one', file);
    const exact = await guard.beforeMutation('chat:one', { action: 'edit', path: file });
    assert.equal(exact.records[0].ownership, 'preExisting');
    await assert.rejects(guard.beforeMutation('chat:two', { action: 'write', path: file, overwrite: true }), /Pre-existing working-tree change protected/);
    await assert.rejects(guard.beforeMutation('chat:two', { action: 'delete', path: file }), /Pre-existing working-tree change protected/);
    const acknowledged = await guard.beforeMutation('chat:two', { action: 'write', path: file, overwrite: true, acknowledgeExistingChanges: true, expectedHash: read.hash });
    assert.equal(acknowledged.records[0].ownership, 'preExisting');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('a concurrent change after read is rejected and agent paths are reported', async () => {
  const { root, file } = await fixture();
  const guard = new WorkspaceChangeGuard();
  try {
    await guard.noteRead('chat:one', file);
    await fs.writeFile(file, 'concurrent\n');
    await assert.rejects(guard.beforeMutation('chat:one', { action: 'edit', path: file }), /changed after the agent baseline\/read/);
    const created = path.join(root, 'created.txt');
    const context = await guard.beforeMutation('chat:one', { action: 'write', path: created });
    await fs.writeFile(created, 'agent\n');
    const summary = await guard.afterMutation(context, { action: 'write', path: created });
    assert.deepEqual(summary.agentChangedPaths, ['created.txt']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("the agent's own mutation refreshes its read baseline (patch -> patch needs no re-read)", async () => {
  const { root, file } = await fixture();
  const guard = new WorkspaceChangeGuard();
  try {
    await guard.noteRead('chat:one', file);
    const first = await guard.beforeMutation('chat:one', { action: 'edit', path: file });
    await fs.writeFile(file, 'agent edit\n');
    await guard.afterMutation(first, { action: 'edit', path: file });
    // The second mutation must not be refused as "changed after read" — the
    // change it would see is the agent's OWN previous mutation, already
    // recorded by afterMutation.
    const second = await guard.beforeMutation('chat:one', { action: 'edit', path: file });
    assert.equal(second.records[0].ownership, 'agentChanged');
    // A foreign change after the agent's own mutation stays protected.
    await fs.writeFile(file, 'foreign edit\n');
    await assert.rejects(guard.beforeMutation('chat:one', { action: 'edit', path: file }), /changed after the agent baseline\/read/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
