'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const MUTATING_ACTIONS = new Set(['write', 'append', 'edit', 'mkdir', 'copy', 'move', 'delete']);
const DESTRUCTIVE_ACTIONS = new Set(['delete', 'move']);

function runGit(cwd, args, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024, timeout, windowsHide: true }, (error, stdout) => {
      if (error) { reject(error); return; }
      resolve(stdout);
    });
  });
}

async function existingAncestor(target) {
  let current = path.resolve(target);
  try {
    const stat = await fs.promises.lstat(current);
    if (!stat.isDirectory()) current = path.dirname(current);
  } catch {
    current = path.dirname(current);
  }
  while (true) {
    try { if ((await fs.promises.stat(current)).isDirectory()) return current; } catch {}
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function gitRootFor(target) {
  const cwd = await existingAncestor(target);
  if (!cwd) return null;
  try { return path.resolve(String(await runGit(cwd, ['rev-parse', '--show-toplevel'])).trim()); }
  catch { return null; }
}

function parsePorcelainV2(buffer) {
  const dirty = new Set();
  const records = buffer.toString('utf8').split('\0');
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith('? ') || record.startsWith('! ')) { dirty.add(record.slice(2)); continue; }
    const fields = record.split(' ');
    if (record.startsWith('1 ')) dirty.add(fields.slice(8).join(' '));
    else if (record.startsWith('2 ')) { dirty.add(fields.slice(9).join(' ')); index += 1; }
    else if (record.startsWith('u ')) dirty.add(fields.slice(10).join(' '));
  }
  return dirty;
}

async function workspaceStatus(root) {
  try { return parsePorcelainV2(await runGit(root, ['status', '--porcelain=v2', '-z', '--untracked-files=all'])); }
  catch { return new Set(); }
}

async function contentHash(target) {
  try {
    const stat = await fs.promises.lstat(target);
    if (stat.isSymbolicLink()) return `symlink:${await fs.promises.readlink(target)}`;
    if (stat.isDirectory()) return 'directory';
    if (!stat.isFile()) return `other:${stat.mode}`;
    return crypto.createHash('sha256').update(await fs.promises.readFile(target)).digest('hex');
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    throw error;
  }
}

// Windows can hand out 8.3 short names (ADMINI~1) from os.tmpdir() while git
// reports the expanded path, and case can differ between callers. Both sides
// must be canonicalized through the filesystem before path.relative, or every
// cross-source comparison collapses to a "../" prefix and the guard silently
// skips the very paths it exists to protect. For a not-yet-existing target the
// deepest existing ancestor is canonicalized and the remainder re-joined.
function normalizePath(target) {
  let current = path.resolve(target);
  const remainder = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try { return path.join(fs.realpathSync.native(current), ...remainder); } catch {}
    const parent = path.dirname(current);
    if (parent === current) break;
    remainder.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(target);
}

function relativePath(root, target) {
  return path.relative(normalizePath(root), normalizePath(target)).replaceAll('\\', '/');
}

function relatedDirtyPath(dirty, relative) {
  const prefix = relative.endsWith('/') ? relative : `${relative}/`;
  for (const item of dirty) if (item === relative || item.startsWith(prefix) || relative.startsWith(`${item}/`)) return item;
  return null;
}

class WorkspaceChangeGuard {
  constructor() {
    this.baselines = new Map();
    this.reads = new Map();
    this.agentChanges = new Map();
  }

  key(owner, root) { return `${owner}\0${root}`; }

  async baseline(owner, root) {
    const key = this.key(owner, root);
    if (this.baselines.has(key)) return this.baselines.get(key);
    const dirty = await workspaceStatus(root);
    const hashes = new Map();
    for (const relative of dirty) hashes.set(relative, await contentHash(path.join(root, relative)));
    const baseline = { root, dirty, hashes, capturedAt: Date.now() };
    this.baselines.set(key, baseline);
    this.agentChanges.set(key, new Map());
    return baseline;
  }

  async noteRead(owner, target) {
    const root = await gitRootFor(target);
    if (!root) return null;
    await this.baseline(owner, root);
    const key = this.key(owner, root);
    const relative = relativePath(root, target);
    const hash = await contentHash(target);
    if (!this.reads.has(key)) this.reads.set(key, new Map());
    this.reads.get(key).set(relative, hash);
    return { root, relative, hash };
  }

  async beforeMutation(owner, input) {
    if (!MUTATING_ACTIONS.has(input.action)) return null;
    const root = await gitRootFor(input.path);
    if (!root) return null;
    const baseline = await this.baseline(owner, root);
    const key = this.key(owner, root);
    const currentDirty = await workspaceStatus(root);
    const changed = this.agentChanges.get(key) || new Map();
    const reads = this.reads.get(key) || new Map();
    const targets = [path.resolve(input.path)];
    if (['copy', 'move'].includes(input.action) && input.destination) targets.push(path.resolve(input.destination));
    const records = [];

    for (const target of targets) {
      const relative = relativePath(root, target);
      if (!relative || relative.startsWith('../')) continue;
      const baselineDirty = relatedDirtyPath(baseline.dirty, relative);
      const currentDirtyPath = relatedDirtyPath(currentDirty, relative);
      const currentHash = await contentHash(target);
      const lastAgentHash = changed.get(relative);
      const readHash = reads.get(relative);
      const agentChanged = lastAgentHash !== undefined;
      const preExisting = Boolean(baselineDirty);
      const concurrent = Boolean(currentDirtyPath) && !preExisting && !agentChanged;
      const changedAfterAgent = agentChanged && lastAgentHash !== currentHash;
      const changedAfterRead = readHash !== undefined && readHash !== currentHash;
      const wholeFileReplace = input.action === 'write' && currentHash !== 'missing' && input.overwrite === true;
      const destructive = DESTRUCTIVE_ACTIONS.has(input.action) || wholeFileReplace;
      const freshExactEdit = ['edit', 'append'].includes(input.action) && readHash === currentHash;
      const acknowledged = input.acknowledgeExistingChanges === true && input.expectedHash === currentHash;

      if (changedAfterAgent || changedAfterRead || concurrent) {
        // RESCUE (run-forensics 2026-10-15, corroborated by 3 audits): the old
        // unconditional throw made the lockout PERMANENT — noteRead never
        // refreshes agentChanges, so after any external/terminal edit every
        // later patch died here and the agent fell back to raw shell edits
        // with no diffs. Two grounded escapes mirror the pre-existing branch's
        // own rescue: (1) freshExactEdit — the agent re-read the CURRENT
        // content (readHash === currentHash) and targets an exact edit/append,
        // so it demonstrably incorporated the external change; (2) explicit
        // acknowledgment — expectedHash matches the current bytes.
        const rescue = freshExactEdit || acknowledged;
        if (!rescue) {
          throw new Error(`Workspace ownership conflict for ${relative}: the path changed after the agent baseline/read. Read it again and preserve the current content.`);
        }
      }
      if (preExisting && !agentChanged && !freshExactEdit && (!acknowledged || destructive && !input.expectedHash)) {
        throw new Error(`Pre-existing working-tree change protected at ${relative}. Read it and use an exact edit, or explicitly acknowledge existing changes with expectedHash=${currentHash}.`);
      }
      records.push({ target, relative, currentHash, ownership: agentChanged ? 'agentChanged' : preExisting ? 'preExisting' : concurrent ? 'concurrentlyChanged' : 'clean' });
    }
    return { key, root, baseline, records };
  }

  async summary(owner, target) {
    const root = await gitRootFor(target);
    if (!root) return null;
    const baseline = await this.baseline(owner, root);
    const current = await workspaceStatus(root);
    const changed = this.agentChanges.get(this.key(owner, root)) || new Map();
    return {
      root,
      preExistingChanges: baseline.dirty.size,
      currentChanges: current.size,
      agentChangedPaths: [...changed.keys()].slice(-100)
    };
  }

  async afterMutation(context, input) {
    if (!context) return null;
    const changed = this.agentChanges.get(context.key) || new Map();
    const reads = this.reads.get(context.key);
    const affected = [...context.records];
    if (input.action === 'move' && input.destination) {
      const relative = relativePath(context.root, input.destination);
      if (!affected.some((item) => item.relative === relative)) affected.push({ target: path.resolve(input.destination), relative, ownership: 'clean' });
    }
    for (const record of affected) {
      // The agent's own mutation IS its freshest view of the file: record the
      // post-mutation hash in agentChanges AND refresh the read baseline.
      // Without the refresh, the next mutation of the same path trips
      // changedAfterRead against the agent's OWN write and forces a pointless
      // refused -> re-read -> patch cycle. A foreign change after the
      // mutation still mismatches both maps and stays protected.
      const hash = await contentHash(record.target);
      changed.set(record.relative, hash);
      if (reads) reads.set(record.relative, hash);
    }
    this.agentChanges.set(context.key, changed);
    return {
      root: context.root,
      ownership: context.records[0]?.ownership || 'clean',
      preExistingChanges: context.baseline.dirty.size,
      agentChangedPaths: [...changed.keys()].slice(-100)
    };
  }

  releaseOwner(owner) {
    const prefix = `${owner}\0`;
    for (const collection of [this.baselines, this.reads, this.agentChanges]) {
      for (const key of collection.keys()) if (key.startsWith(prefix)) collection.delete(key);
    }
  }
}

module.exports = { WorkspaceChangeGuard, gitRootFor, parsePorcelainV2, contentHash };
