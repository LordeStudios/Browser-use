import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGitCommand, GIT_ACTIONS } = require('../desktop/computer/gitCommands.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { validateComputerInput, computerReadOnly } = require('../desktop/computer/computerCatalog.cjs');

test('the catalog exposes computer_git with a required action and repo', () => {
  const tool = COMPUTER_TOOLS_NAME('computer_git');
  assert.ok(tool, 'computer_git is in the tool catalog');
  assert.deepEqual(tool.inputSchema.required, ['action', 'repo']);
  assert.doesNotThrow(() => validateComputerInput('computer_git', { action: 'status', repo: 'C:/repo' }));
  assert.throws(() => validateComputerInput('computer_git', { repo: 'C:/repo' }), /requires action|Invalid/i);
  // Only the three read-only actions are classified read-only.
  assert.equal(computerReadOnly('computer_git', { action: 'status' }), true);
  assert.equal(computerReadOnly('computer_git', { action: 'diff' }), true);
  assert.equal(computerReadOnly('computer_git', { action: 'log' }), true);
  assert.equal(computerReadOnly('computer_git', { action: 'commit' }), false);
});

function COMPUTER_TOOLS_NAME(name) {
  const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
  return COMPUTER_TOOLS.find((entry) => entry.name === name);
}

test('buildGitCommand produces closed argv and rejects option injection', () => {
  assert.deepEqual(buildGitCommand({ action: 'status' }), { argv: ['status', '--porcelain=v1', '-b'], readOnly: true });
  assert.deepEqual(buildGitCommand({ action: 'diff', staged: true, paths: ['src/a.js'] }).argv, ['diff', '--staged', '--', 'src/a.js']);
  assert.deepEqual(buildGitCommand({ action: 'log', limit: 5 }).argv, ['log', '--oneline', '-n', '5']);
  assert.deepEqual(buildGitCommand({ action: 'add', paths: ['a.txt', 'b.txt'] }).argv, ['add', '--', 'a.txt', 'b.txt']);
  assert.deepEqual(buildGitCommand({ action: 'commit', message: 'fix: the thing' }).argv, ['commit', '-m', 'fix: the thing']);
  assert.deepEqual(buildGitCommand({ action: 'checkout', ref: 'main', create: true }).argv, ['checkout', '-b', 'main']);
  assert.equal(buildGitCommand({ action: 'commit', message: 'x' }).readOnly, false);
  assert.equal(buildGitCommand({ action: 'branch' }).readOnly, true, 'bare branch is a list');
  assert.equal(buildGitCommand({ action: 'branch', name: 'feature' }).readOnly, false);
  // Values that could start an option are refused — the model can never
  // smuggle a flag through a path, ref, or branch name.
  assert.throws(() => buildGitCommand({ action: 'add', paths: ['--all'] }), /must be a non-empty value/);
  assert.throws(() => buildGitCommand({ action: 'checkout', ref: '-b' }), /must be a non-empty value/);
  assert.throws(() => buildGitCommand({ action: 'commit' }), /requires a message/);
  assert.throws(() => buildGitCommand({ action: 'add' }), /requires at least one path/);
  assert.throws(() => buildGitCommand({ action: 'push' }), /Unknown computer_git action/);
});

test('the executor runs real git through the ownership guard for mutations', { timeout: 30_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-tool-'));
  const guardCalls = [];
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@browser-use.local']);
  git(['config', 'user.name', 'Browser Use Test']);
  const backend = new ComputerTools({
    nativeRequest: async () => { throw new Error('not used'); },
    capture: null,
    workspaceGuard: {
      beforeMutation: async (owner, input) => { guardCalls.push(input.action); return { key: 'k', root: dir, records: [] }; },
      afterMutation: async () => ({ root: dir, changed: [] }),
      noteRead: async () => null
    }
  });
  const run = (input) => backend.execute('computer_git', { repo: dir, ...input }, 'owner-1');
  return (async () => {
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello\n');
    // status is read-only: honest output, no guard mutation.
    const status = await run({ action: 'status' });
    assert.match(status.output, /\?\? hello\.txt/);
    assert.equal(guardCalls.length, 0, 'read-only git never takes the mutation guard');
    // add + commit are guarded mutations.
    await run({ action: 'add', paths: ['hello.txt'] });
    assert.equal(guardCalls.includes('edit'), true);
    const commit = await run({ action: 'commit', message: 'add hello' });
    assert.match(commit.output, /hello/);
    const log = await run({ action: 'log', limit: 5 });
    assert.match(log.output, /add hello/);
    const branch = await run({ action: 'branch', name: 'work' });
    assert.match(branch.argv.join(' '), /branch work/);
    // A missing repo and an unknown action fail honestly.
    await assert.rejects(() => backend.execute('computer_git', { repo: path.join(dir, 'nope'), action: 'status' }, 'owner-1'), /does not exist/);
    await assert.rejects(() => backend.execute('computer_git', { repo: dir, action: 'reset', paths: [] }, 'owner-1'), /computer_git\.action: expected one of|Unknown computer_git action/);
  })();
});
