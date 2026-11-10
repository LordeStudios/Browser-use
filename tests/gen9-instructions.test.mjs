// GEN9 — instruction files (desktop/agent/instructionLoader.cjs).
// Covers: lorde.md > AGENTS.md > CLAUDE.md precedence, the pinned-root > cwd
// fallback, the 8KB content cap with largest-first truncation + in-band
// notice, the block format, the task-prepend helper, notebook user-rules
// seeding rows, and pin integration through the REAL workspacePin module
// (pinnedRepo -> loader).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  INSTRUCTION_FILES,
  DEFAULT_CAP,
  findInstructionFile,
  loadInstructionFiles,
  instructionBlockForTask,
  notebookUserRules
} = require('../desktop/agent/instructionLoader.cjs');
const { registerRepo, pinnedRepo } = require('../desktop/agent/workspacePin.cjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, name, content) {
  fs.writeFileSync(path.join(root, name), content, 'utf8');
}

test('precedence: lorde.md beats AGENTS.md beats CLAUDE.md within one root', () => {
  const repo = tmpDir('bu-inst-repo1-');
  write(repo, 'lorde.md', 'lorde conventions');
  write(repo, 'AGENTS.md', 'agents conventions');
  write(repo, 'CLAUDE.md', 'claude conventions');
  const loaded = loadInstructionFiles({ repoRoot: repo });
  assert.equal(loaded.files.length, 1);
  assert.equal(loaded.files[0].name, 'lorde.md');
  assert.match(loaded.block, /lorde conventions/);
  assert.doesNotMatch(loaded.block, /agents conventions/);

  fs.unlinkSync(path.join(repo, 'lorde.md'));
  const withoutLorde = loadInstructionFiles({ repoRoot: repo });
  assert.equal(withoutLorde.files[0].name, 'AGENTS.md');
  assert.match(withoutLorde.block, /agents conventions/);

  fs.unlinkSync(path.join(repo, 'AGENTS.md'));
  assert.equal(loadInstructionFiles({ repoRoot: repo }).files[0].name, 'CLAUDE.md');
  assert.deepEqual(INSTRUCTION_FILES, ['lorde.md', 'AGENTS.md', 'CLAUDE.md']);
});

test('cwd fallback applies only when the pinned repo root has no instruction file', () => {
  const repo = tmpDir('bu-inst-repo2-');
  const cwd = tmpDir('bu-inst-cwd2-');
  write(cwd, 'AGENTS.md', 'cwd fallback conventions');
  // Repo root empty -> cwd's file is used.
  const fallback = loadInstructionFiles({ repoRoot: repo, cwd });
  assert.equal(fallback.files[0].root, cwd);
  assert.match(fallback.block, /cwd fallback conventions/);
  // Repo root has one -> the cwd file is ignored entirely.
  write(repo, 'lorde.md', 'repo conventions win');
  const pinned = loadInstructionFiles({ repoRoot: repo, cwd });
  assert.equal(pinned.files.length, 1);
  assert.equal(pinned.files[0].root, repo);
  assert.doesNotMatch(pinned.block, /cwd fallback/);
  // Identical roots (repo == cwd) load one file, not two.
  const same = loadInstructionFiles({ repoRoot: cwd, cwd });
  assert.equal(same.files.length, 1);
});

test('nothing found returns null; findInstructionFile honors root order', () => {
  const repo = tmpDir('bu-inst-repo3-');
  assert.equal(loadInstructionFiles({ repoRoot: repo }), null);
  assert.equal(findInstructionFile(repo, fs), null);
  assert.equal(findInstructionFile('', fs), null);
  write(repo, 'CLAUDE.md', 'x');
  assert.equal(path.basename(findInstructionFile(repo, fs)), 'CLAUDE.md');
});

test('content cap: the selected file truncates under the cap with an in-band notice; smaller files pass whole', () => {
  const repo = tmpDir('bu-inst-repo4-');
  // Precedence selects ONE file per root — here lorde.md (6000 chars) — so the
  // cap applies to the selection. A sibling smaller file under a DIFFERENT
  // root would be the fallback and is never co-loaded (asserted below).
  write(repo, 'lorde.md', 'H'.repeat(6000));
  write(repo, 'AGENTS.md', 'unused by precedence');
  const cap = 3000;
  const loaded = loadInstructionFiles({ repoRoot: repo, cap });
  assert.equal(loaded.cap, cap);
  assert.equal(loaded.files.length, 1);
  const total = loaded.files.reduce((sum, file) => sum + file.chars, 0);
  assert.ok(total <= cap, `total ${total} fits cap ${cap}`);
  const truncated = loaded.files.filter(file => file.truncated);
  assert.equal(truncated.length, 1, 'the oversized selection was cut');
  assert.equal(truncated[0].name, 'lorde.md');
  assert.ok(truncated[0].notice, 'a notice names the cut');
  assert.match(loaded.block, /…\[truncated: lorde\.md capped at \d+ of 6000 chars/);
  // A smaller selection passes through untouched (no truncation flag, no notice).
  write(repo, 'lorde.md', 'small but real');
  const uncut = loadInstructionFiles({ repoRoot: repo, cap });
  assert.equal(uncut.files[0].truncated, false);
  assert.equal(uncut.files[0].notice, null);
  assert.equal(uncut.files[0].chars, 'small but real'.length);
});

test('block format and task prepend; unchanged when no instructions', () => {
  const repo = tmpDir('bu-inst-repo5-');
  write(repo, 'AGENTS.md', 'Keep patches minimal.');
  const loaded = loadInstructionFiles({ repoRoot: repo });
  assert.match(loaded.block, /^INSTRUCTION FILES \(repo conventions — pinned context, not a user task\):/);
  assert.match(loaded.block, new RegExp(`### AGENTS\\.md \\(${repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/]AGENTS\\.md`));
  const task = 'fix the login bug';
  const combined = instructionBlockForTask(task, loaded);
  assert.ok(combined.startsWith('fix the login bug'));
  assert.ok(combined.includes('Keep patches minimal.'));
  assert.equal(instructionBlockForTask(task, null), task, 'no instructions -> task unchanged');
});

test('notebook user-rules rows: one capped row per kept file, truncation noted', () => {
  const repo = tmpDir('bu-inst-repo6-');
  const longBody = 'rule '.repeat(2000); // 10000 chars -> capped
  write(repo, 'lorde.md', longBody);
  const cap = DEFAULT_CAP;
  const loaded = loadInstructionFiles({ repoRoot: repo, cap });
  const rows = notebookUserRules(loaded);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'instructions:lorde.md');
  assert.ok(rows[0].text.includes(repo), 'the row names the source path');
  assert.ok(rows[0].text.includes('truncated'), 'the row carries the truncation notice');
  assert.ok(rows[0].text.length < longBody.length, 'the row is bounded');
  assert.deepEqual(notebookUserRules(null), []);
});

test('pin integration: pinnedRepo from the REAL workspacePin module feeds the loader', () => {
  const pinned = tmpDir('bu-inst-pinned-');
  const other = tmpDir('bu-inst-other-');
  write(pinned, 'lorde.md', 'PINNED repo conventions');
  write(other, 'lorde.md', 'OTHER repo conventions');
  // A repo map with a pin — exactly what a conversation carries after /cd.
  const repoMap = [];
  registerRepo(repoMap, other, { source: 'mentioned' });
  registerRepo(repoMap, pinned, { pinned: true, source: 'pinned' });
  const pin = pinnedRepo(repoMap);
  assert.equal(pin.root, pinned);
  const loaded = loadInstructionFiles({ repoRoot: pin.root, cwd: other });
  assert.match(loaded.block, /PINNED repo conventions/);
  assert.doesNotMatch(loaded.block, /OTHER repo conventions/);
});
