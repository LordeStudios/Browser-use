import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parsePatch, applyPatch } = require('../desktop/computer/applyPatch.cjs');
const { validateComputerInput, normalizeComputerInput, COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

test('the computer-mode section is a real string — an unescaped quote once made it NaN ("string - string"), silently stripping every computer-mode instruction', () => {
  const { assembleSystemPrompt, attachCreativePlaybooks } = require('../desktop/agent/desktopChatAgent.cjs');
  const { toolDefinitions } = require('../desktop/agent/agentInternals.cjs');
  function fakeRun() { return { settings: { controlMode: 'agi', effort: 'standard', effortMode: 'standard', approvalMode: 'unattended' }, effortTier: 'standard', instructionsFileText: '', systemFileText: null }; }
  const section = assembleSystemPrompt(fakeRun(), null);
  assert.equal(typeof section, 'string', 'the assembled prompt must be a string; NaN means a quoting bug in a section literal');
  // Sparsity contract (reference-harness parity): the sectioned core stays
  // under 2,000 chars while still carrying the real guidance blocks.
  assert.ok(section.length >= 1500 && section.length <= 2000, `the prompt carries real guidance and stays sparse (got ${section.length})`);
  // Tool names are schema-surface facts: assert them against the catalog.
  const catalogNames = toolDefinitions('patch work', 'agi', { workspace: true }).map((tool) => tool.name);
  assert.ok(catalogNames.includes('computer_patch'), 'computer_patch is advertised');
  assert.ok(catalogNames.includes('computer_git'), 'computer_git is advertised');
  assert.match(section, /computer_patch/);
});

test('the modeling playbook carries the Procedura-derived modeling craft (plan-first, anti-blocky, typed entry, mirror twins)', () => {
  const { MODELING_PLAYBOOK } = require('../desktop/agent/prompt/sections.cjs');
  assert.equal(typeof MODELING_PLAYBOOK, 'string');
  assert.match(MODELING_PLAYBOOK, /PLAN the whole object FIRST/i, 'plan-first decomposition (Procedura plan_system.md)');
  assert.match(MODELING_PLAYBOOK, /relative size/i, 'parts carry relative proportions, not drag-landed dimensions');
  assert.match(MODELING_PLAYBOOK, /default primitives.*is a failure/i, 'the anti-blocky mandate (scad_part_system.md)');
  assert.match(MODELING_PLAYBOOK, /typed\/keyboard entry/i, 'typed dimensions over drag-proportioning');
  assert.match(MODELING_PLAYBOOK, /mirror/i, 'model one side and instance/mirror the twin');
  assert.match(MODELING_PLAYBOOK, /screenshot ONCE per completed part/i, 'milestone screenshots, not per click');
  assert.doesNotMatch(MODELING_PLAYBOOK, /NaN/);
});

test('the catalog exposes computer_patch with path required and live ops support', () => {
  const tool = COMPUTER_TOOLS.find((entry) => entry.name === 'computer_patch');
  assert.ok(tool, 'computer_patch is in the tool catalog');
  assert.deepEqual(tool.inputSchema.required, ['path', 'patch']);
  assert.throws(() => validateComputerInput('computer_patch', { path: 'C:/proj/main.dart', ops: [{ op: 'append', lines: ['x'] }] }), /requires patch|Invalid/i);
  assert.doesNotThrow(() => validateComputerInput('computer_patch', { path: 'C:/proj/main.dart', patch: '*** Begin Patch\n*** End Patch' }));
  assert.throws(() => validateComputerInput('computer_patch', { path: 'C:/x' }), /requires patch|Invalid/i);
  const live = COMPUTER_TOOLS.find((entry) => entry.name === 'computer_patch_live');
  assert.deepEqual(live.inputSchema.required, ['path', 'ops']);
});

test('per-line append ops apply in order and emit a live accumulating diff', () => {
  const { applyLineOps } = require('../desktop/computer/applyPatch.cjs');
  const original = 'a\nb\nc';
  const result = applyLineOps(original, [
    { op: 'append', lines: ['d', 'e'] },
    { op: 'replace', line: 2, text: 'B' },
    { op: 'insert', line: 1, lines: ['top'] },
    { op: 'delete', line: 5 }
  ], 'f.txt');
  assert.equal(result.content, 'top\na\nB\nc\ne');
  assert.equal(result.addedLines, 4);
  assert.equal(result.removedLines, 2);
  assert.equal(result.errors.length, 0);
  const kinds = result.diff[0].lines.map((line) => `${line.kind}:${line.text}`);
  assert.deepEqual(kinds, ['add:d', 'add:e', 'del:b', 'add:B', 'add:top', 'del:d']);
});

test('a bad line number fails only that op and reports the range', () => {
  const { applyLineOps } = require('../desktop/computer/applyPatch.cjs');
  const result = applyLineOps('a\nb', [
    { op: 'delete', line: 99 },
    { op: 'append', lines: ['c'] }
  ], 'f.txt');
  assert.equal(result.content, 'a\nb\nc', 'the valid op still lands');
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].message, /out of range/);
  assert.equal(result.addedLines, 1);
});

test('computer call labels are accepted as metadata and never reach execution', async () => {
  let nativeInput;
  const backend = new ComputerTools({
    nativeRequest: async (_name, input) => { nativeInput = input; return { observed: true }; },
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  try {
    const normalized = normalizeComputerInput('computer_read', { path: 'C:/x.txt', display_text: 'Reading x.txt' });
    assert.equal(normalized.display_text, undefined, 'transport metadata is removed before dispatch');
    assert.doesNotThrow(() => validateComputerInput('computer_read', { path: 'C:/x.txt', display_text: 'Reading x.txt' }));
    await backend.execute('computer_observe', { display_text: 'Inspecting desktop' }, 'owner');
    assert.equal(nativeInput.display_text, undefined, 'native handlers receive only execution arguments');
  } finally { await backend.close(); }
});

test('provider normalization strips display_text from computer calls but leaves other tools untouched', () => {
  const { normalizeToolCalls } = require('../desktop/agent/desktopChatAgent.cjs');
  const [read, fs, search, page] = normalizeToolCalls([
    { name: 'computer_read', input: { path: 'C:/x.txt', display_text: 'Reading x.txt' } },
    { name: 'computer_fs', input: { action: 'list', path: 'C:/x', displayText: 'Listing x' } },
    { name: 'computer_search', input: { pattern: 'fn main', path: 'C:/x', display_text: 'Searching' } },
    { name: 'browser_navigate', input: { url: 'https://example.test', display_text: 'keep for non-computer tools' } }
  ], 5);
  assert.deepEqual(read.input, { path: 'C:/x.txt' });
  assert.deepEqual(fs.input, { action: 'list', path: 'C:/x' });
  assert.deepEqual(search.input, { pattern: 'fn main', path: 'C:/x' });
  assert.equal(page.input.display_text, 'keep for non-computer tools', 'only computer_* strictness is relaxed here');
});

test('a malformed computer call surfaces as a classified, self-describing recoverable error', async () => {
  const { executeAction } = require('../desktop/agent/desktopChatAgent.cjs');
  const backend = new ComputerTools({
    nativeRequest: async () => { throw new Error('not used'); },
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  const run = {
    tabId: 't',
    computerOwner: 'owner-1',
    observationDomain: 'browser',
    settings: { controlMode: 'agi' },
    loopState: { consecutiveWaits: 0, lastWaitedMs: 0 },
    abortController: new AbortController(),
    getControlMode: () => 'agi',
    getComputerTools: () => backend
  };
  try {
    const output = await executeAction({ listTabs: () => [{ id: 't' }] }, run, { name: 'computer_read', input: { path: 'C:/x.txt', unexpected_field: 'x' } });
    assert.equal(output.ok, false);
    assert.equal(output.recoverable, true);
    assert.equal(output.recoverySource, 'invalid_tool_input');
    assert.equal(output.result.field, 'computer_read.unexpected_field');
    assert.equal(output.result.reason, 'unknown_field');
    assert.ok(output.result.allowedFields.includes('path'), 'the result names the fields the tool does accept');
    assert.match(output.error, /do not retry the same arguments/i);
  } finally { await backend.close(); }
});

test('unknown computer fields report the field and allowed schema instead of a blind invalid error', () => {
  assert.throws(
    () => validateComputerInput('computer_read', { path: 'C:/x.txt', display_text_typo: 'read' }),
    (error) => error?.code === 'INVALID_TOOL_INPUT'
      && /Unknown computer_read\.display_text_typo/.test(error.message)
      && /Allowed fields:/.test(error.message)
  );
});

test('computeLineDiff numbers dels in the old file and adds in the new file', () => {
  const { computeLineDiff } = require('../desktop/computer/applyPatch.cjs');
  const old = 'one\ntwo\nthree\nfour';
  const updated = 'one\ntwo (edited)\ntwo and a half\nthree\nfour';
  const diff = computeLineDiff(old, updated);
  assert.equal(diff.addedLines, 2);
  assert.equal(diff.removedLines, 1);
  assert.equal(diff.truncated, false);
  const lines = diff.chunks[0].lines;
  assert.deepEqual(lines.filter((line) => line.kind !== 'ctx'), [
    { kind: 'del', oldLine: 2, newLine: null, text: 'two' },
    { kind: 'add', oldLine: null, newLine: 2, text: 'two (edited)' },
    { kind: 'add', oldLine: null, newLine: 3, text: 'two and a half' }
  ]);
  // Trailing context sits at DIFFERENT numbers per file once the middle shifts.
  const shifted = computeLineDiff('a\nx\ny\nkeep', 'a\nz1\nz2\nz3\nkeep');
  const keep = shifted.chunks[0].lines.at(-1);
  assert.equal(keep.kind, 'ctx');
  assert.equal(keep.oldLine, 4);
  assert.equal(keep.newLine, 5);
  // Identical content produces no diff.
  assert.deepEqual(computeLineDiff('same', 'same').chunks, []);
});

test('computer_file write and edit return the IDE-style diff and numbered read grounds patch anchors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-diff-'));
  const target = path.join(dir, 'page.html');
  const guardLog = [];
  const backend = new ComputerTools({
    nativeRequest: async () => { throw new Error('not used'); },
    capture: null,
    workspaceGuard: {
      beforeMutation: async (owner, input) => { guardLog.push(['before', input.action]); return { key: 'k', root: dir, records: [] }; },
      afterMutation: async () => ({ root: dir, changed: ['page.html'] }),
      noteRead: async () => null
    }
  });
  // Write (new file): diff marks every line as an add.
  const written = await backend.execute('computer_file', { action: 'write', path: target, content: '<h1>a</h1>\n<p>b</p>\n' }, 'owner-1');
  assert.equal(written.files.length, 1);
  assert.equal(written.files[0].action, 'add');
  assert.equal(written.files[0].addedLines, 2);
  // Edit: diff shows the replaced line with old and new numbers.
  const edited = await backend.execute('computer_file', { action: 'edit', path: target, oldText: '<h1>a</h1>', newText: '<h1>title</h1>' }, 'owner-1');
  assert.equal(edited.files[0].action, 'update');
  const del = edited.files[0].diff[0].lines.find((line) => line.kind === 'del');
  const add = edited.files[0].diff[0].lines.find((line) => line.kind === 'add');
  assert.equal(del.oldLine, 1);
  assert.equal(add.newLine, 1);
  assert.equal(del.newLine, null);
  assert.equal(add.oldLine, null);
  // Numbered read: global 1-based line numbers for exact patch anchors.
  const read = await backend.execute('computer_file', { action: 'read', path: target, numbered: true }, 'owner-1');
  assert.equal(read.numbered, true);
  assert.match(read.content, /^\s*1\| <h1>title<\/h1>/);
  assert.match(read.content, /^\s*2\| <p>b<\/p>/m);
  // Binary-safe: base64 writes do not pretend to diff text.
  const png = await backend.execute('computer_file', { action: 'write', path: path.join(dir, 'blob.bin'), content: Buffer.from([0, 1, 2, 0]).toString('base64'), encoding: 'base64', overwrite: true }, 'owner-1');
  assert.equal(png.files, undefined);
});

test('update hunks apply with exact old/new line numbers for the IDE-style diff', () => {
  const original = ['line one', 'line two', 'line three', 'line four'];
  const written = [];
  const result = applyPatch({
    patch: [
      '*** Begin Patch',
      '*** Update File: src/main.txt',
      '@@ line one',
      '-line two',
      '+line two (edited)',
      '+line two and a half',
      ' line three',
      '*** End Patch'
    ].join('\n'),
    read: () => original.join('\n'),
    write: (_path, content) => written.push(content)
  });
  assert.equal(result.applied, true);
  assert.equal(written.length, 1);
  assert.deepEqual(written[0].split('\n'), ['line one', 'line two (edited)', 'line two and a half', 'line three', 'line four']);
  const [file] = result.files;
  assert.equal(file.action, 'update');
  assert.equal(file.addedLines, 2);
  assert.equal(file.removedLines, 1);
  const lines = file.diff[0].lines;
  assert.deepEqual(lines, [
    { kind: 'ctx', oldLine: 1, newLine: 1, text: 'line one' }, // the @@ anchor renders as leading context
    { kind: 'del', oldLine: 2, newLine: null, text: 'line two' },
    { kind: 'add', oldLine: null, newLine: 2, text: 'line two (edited)' },
    { kind: 'add', oldLine: null, newLine: 3, text: 'line two and a half' },
    { kind: 'ctx', oldLine: 3, newLine: 4, text: 'line three' }
  ]);
});

test('multi-hunk patches track shifted line numbers across hunks', () => {
  const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const result = applyPatch({
    patch: [
      '*** Begin Patch',
      '*** Update File: f.txt',
      '@@ a',
      '-b',
      '+B',
      '-c',
      '@@ e',
      '-f',
      '+F1',
      '+F2',
      '*** End Patch'
    ].join('\n'),
    read: () => original.join('\n'),
    write: () => {}
  });
  const [file] = result.files;
  const first = file.diff[0].lines;
  const second = file.diff[1].lines;
  assert.deepEqual(first.find((line) => line.kind === 'del' && line.text === 'b'), { kind: 'del', oldLine: 2, newLine: null, text: 'b' });
  assert.deepEqual(first.find((line) => line.kind === 'del' && line.text === 'c'), { kind: 'del', oldLine: 3, newLine: null, text: 'c' });
  assert.deepEqual(second.find((line) => line.kind === 'del' && line.text === 'f'), { kind: 'del', oldLine: 6, newLine: null, text: 'f' }, 'the second hunk counts original line numbers, not shifted ones');
  assert.deepEqual(second.find((line) => line.kind === 'add' && line.text === 'F2'), { kind: 'add', oldLine: null, newLine: 6, text: 'F2' });
});

test('a repeated anchor (Codex style) edits the anchor line itself', () => {
  // The most common model-written form: "@@ def run():" + "-def run():".
  // The anchor is BOTH the locator and the removed line.
  const files = new Map([['f.py', 'def run():\n    pass\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: f.py\n@@ def run():\n-def run():\n+def run():\n+    return 42\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('f.py'), 'def run():\n    return 42\n    pass\n');
});

test('repeated context matches successive occurrences, not the first one forever', () => {  const original = ['x', 'same', 'x', 'same'];
  const result = applyPatch({
    patch: '*** Begin Patch\n*** Update File: f.txt\n@@ x\n-same\n+first\n@@ x\n-same\n+second\n*** End Patch',
    read: () => original.join('\n'),
    write: () => {}
  });
  assert.deepEqual(result.files[0].diff[0].lines.find((line) => line.kind === 'add' && line.text === 'first'), { kind: 'add', oldLine: null, newLine: 2, text: 'first' });
  assert.deepEqual(result.files[0].diff[1].lines.find((line) => line.kind === 'add' && line.text === 'second'), { kind: 'add', oldLine: null, newLine: 4, text: 'second' });
});

test('add and delete file sections work end to end', () => {
  const files = new Map([['existing.txt', 'hello\nworld']]);
  const result = applyPatch({
    patch: '*** Begin Patch\n*** Add File: new.txt\n+created\n*** Delete File: existing.txt\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => { if (content === null) files.delete(p); else files.set(p, content); }
  });
  assert.equal(result.files[0].action, 'add');
  assert.deepEqual(result.files[0].diff[0].lines, [{ kind: 'add', oldLine: null, newLine: 1, text: 'created' }]);
  assert.equal(result.files[1].action, 'delete');
  assert.equal(files.has('existing.txt'), false);
  assert.equal(files.get('new.txt'), 'created');
});

test('context mismatch produces an honest error naming the hunk and line', () => {
  assert.throws(() => applyPatch({
    patch: '*** Begin Patch\n*** Update File: f.txt\n@@\n-wrong content\n*** End Patch',
    read: () => 'actual content\n',
    write: () => { throw new Error('must not write'); }
  }), /pattern not found|removed-line mismatch|context.*not found/i);
});

test('the executor applies a patch through the workspace ownership guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-exec-'));
  const target = path.join(dir, 'main.py');
  fs.writeFileSync(target, 'def run():\n    pass\n');
  const calls = [];
  const backend = new ComputerTools({
    nativeRequest: async (name, input, owner) => { calls.push(name); return { dispatched: true }; },
    capture: null,
    workspaceGuard: {
      beforeMutation: async () => ({ key: 'k', root: dir, records: [] }),
      afterMutation: async () => ({ root: dir, changed: ['main.py'] }),
      noteRead: async () => null
    }
  });
  const result = await backend.execute('computer_patch', {
    path: target,
    patch: `*** Begin Patch\n*** Update File: ${target}\n-def run():\n-    pass\n+def run():\n+    return 42\n*** End Patch`
  }, 'owner-1');
  assert.equal(result.applied, true);
  const [file] = result.files;
  assert.equal(file.addedLines, 2);
  assert.equal(file.removedLines, 2);
  assert.equal(fs.readFileSync(target, 'utf8'), 'def run():\n    return 42\n');
  const line = file.diff[0].lines.find((entry) => entry.kind === 'add' && entry.text === '    return 42');
  assert.equal(line.newLine, 2, 'the diff carries the new-file line number for the renderer');
});

test('computer_patch normalizes optional nulls and rejects an empty patch body', () => {
  const normalized = normalizeComputerInput('computer_patch', { path: 'C:/x.txt', patch: '*** Begin Patch\n*** End Patch', expectedHash: null });
  assert.equal(normalized.expectedHash, undefined);
  assert.doesNotThrow(() => validateComputerInput('computer_patch', { path: 'C:/x.txt', patch: '' }));
  assert.throws(() => applyPatch({ patch: '', read: () => null, write: () => {} }), /empty/i);
});

test('the inspection value unwraps the executor result so the diff view never falls back to raw JSON', () => {
  const { inspectionValue } = require('../desktop/agent/desktopChatAgent.cjs');
  // The executor wraps results as { ok, result: { applied, files } } — the
  // exact shape a live run produced on 2026-09-21, which rendered as raw JSON
  // because the old code looked for value.files at the top level.
  const wrapped = {
    ok: true,
    result: {
      applied: true,
      files: [{ path: 'C:/x/index.html', action: 'update', addedLines: 1, removedLines: 1, diff: [{ oldStart: 3, newStart: 3, lines: [{ kind: 'ctx', oldLine: 3, newLine: 3, text: 'a' }, { kind: 'del', oldLine: 4, newLine: null, text: 'b' }, { kind: 'add', oldLine: null, newLine: 4, text: 'B' }] }] }]
    },
    progress: true
  };
  const view = inspectionValue('computer_patch', wrapped);
  assert.ok(Array.isArray(view.files) && view.files.length === 1, 'files are hoisted to the top level for the renderer');
  assert.equal(view.applied, true);
  assert.equal(view.files[0].diff[0].lines.length, 3);
  // The bare { applied, files } shape keeps working too.
  const bare = inspectionValue('computer_patch', { applied: true, files: [{ path: 'p', action: 'update', diff: [{ oldStart: 1, newStart: 1, lines: [] }] }] });
  assert.equal(bare.files.length, 1);
  // Non-patch shapes are untouched.
  const other = inspectionValue('computer_file', { ok: true, result: { changed: true } });
  assert.equal(other.ok, true);
});


test('task-scoped AGI guidance is task-stable: the modeling playbook attaches only by OBSERVATION (2026-10-11 campaign)', () => {
  // DSH REWRITE: the winning design survives intact — ONE static sectioned
  // core with no task-text routing (the assembler takes no task parameter).
  // The 3D/modeling playbook attaches ONLY when the live desktop shows a
  // modeling app, never by task words.
  const { assembleSystemPrompt, attachCreativePlaybooks } = require('../desktop/agent/desktopChatAgent.cjs');
  const { toolDefinitions } = require('../desktop/agent/agentInternals.cjs');
  function fakeRun() { return { settings: { controlMode: 'agi', effort: 'standard', effortMode: 'standard', approvalMode: 'unattended' }, effortTier: 'standard', instructionsFileText: '', systemFileText: null }; }
  const ordinary = assembleSystemPrompt(fakeRun(), null);
  const modeling = assembleSystemPrompt(fakeRun(), null);
  assert.equal(ordinary, modeling, 'one task-stable core, no task-text routing');
  assert.doesNotMatch(ordinary, /PLAN the whole object FIRST/i);
  // Observation-attached playbook: a Blender window in the live desktop brings
  // the modeling contract into the computer-mode section.
  // The modeling contract attaches by live observation to the TOOL SCHEMA
  // (computer_pointer), not the system prompt: the prompt stays sparse and the
  // guidance arrives with the tool that needs it.
  const catalog = toolDefinitions('model a cube', 'agi', { workspace: true });
  const withBlender = attachCreativePlaybooks(catalog, { desktop: { windows: [{ id: 'w1', title: 'Blender - untitled.blend' }], foregroundWindowId: 'w1' } });
  const pointer = withBlender.find((tool) => tool.name === 'computer_pointer');
  assert.ok(pointer, 'computer_pointer is advertised in agi mode');
  assert.match(String(pointer.description), /PLAN the whole object FIRST/i, 'the modeling contract attaches to the pointer schema by live observation');
  const withoutBlender = attachCreativePlaybooks(toolDefinitions('model a cube', 'agi', { workspace: true }), null);
  assert.doesNotMatch(String(withoutBlender.find((tool) => tool.name === 'computer_pointer').description), /PLAN the whole object FIRST/i, 'no playbook without a modeling app');
  assert.ok(Buffer.byteLength(ordinary, 'utf8') <= 2000, 'the sectioned core stays sparse');
});

// ---------------------------------------------------------------------------
// Regression: CRLF/LF fidelity, trailing-newline edges, atomic multi-file
// application (the "patch application reliably handles LF and CRLF files" and
// "deterministic and atomic where possible" acceptance criteria).
// ---------------------------------------------------------------------------

test('a CRLF file keeps its CRLF line endings when patched (the patch must not rewrite the whole file)', () => {
  const files = new Map([['crlf.txt', 'one\r\ntwo\r\nthree\r\n']]);
  applyPatch({
    // The patch itself is written with CRLF separators, like a Windows author.
    patch: '*** Begin Patch\r\n*** Update File: crlf.txt\r\n@@\r\n one\r\n-two\r\n+2\r\n three\r\n*** End Patch\r\n',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('crlf.txt'), 'one\r\n2\r\nthree\r\n', 'CRLF in, CRLF out');
});

test('an LF file keeps its LF line endings when patched', () => {
  const files = new Map([['lf.txt', 'one\ntwo\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: lf.txt\n@@\n-two\n+2\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('lf.txt'), 'one\n2\n');
});

test('a mixed-separator patch matches CRLF file content because both sides normalize to LF', () => {
  const files = new Map([['mixed.txt', 'alpha\r\nbeta\r\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: mixed.txt\n@@\n-beta\n+BETA\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('mixed.txt'), 'alpha\r\nBETA\r\n');
});

test('blank context lines and a trailing newline survive a patch', () => {
  const files = new Map([['blank.txt', 'a\n\nb\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: blank.txt\n@@\n a\n\n-b\n+B\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('blank.txt'), 'a\n\nB\n');
});

test('a file with no trailing newline keeps its exact ending, and a hunk anchored on the last line still applies', () => {
  const files = new Map([['tail.txt', 'first\nlast']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: tail.txt\n@@\n-last\n+last\n+extra\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('tail.txt'), 'first\nlast\nextra');
});

test('unicode content matches exactly and round-trips unharmed', () => {
  const files = new Map([['u.txt', 'héllo — 世界\nkeep 🎯\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: u.txt\n@@\n-héllo — 世界\n+hello — 世界\n keep 🎯\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('u.txt'), 'hello — 世界\nkeep 🎯\n');
});

test('an insertion and a deletion in one hunk both land with correct old/new line numbers', () => {
  const files = new Map([['ins.txt', 'a\nb\nc\n']]);
  const result = applyPatch({
    patch: '*** Begin Patch\n*** Update File: ins.txt\n@@\n a\n-b\n+B\n+C\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('ins.txt'), 'a\nB\nC\nc\n');
  const [del, add1, add2] = result.files[0].diff[0].lines.filter((line) => line.kind !== 'ctx');
  assert.deepEqual(del, { kind: 'del', oldLine: 2, newLine: null, text: 'b' });
  assert.deepEqual(add1, { kind: 'add', oldLine: null, newLine: 2, text: 'B' });
  assert.deepEqual(add2, { kind: 'add', oldLine: null, newLine: 3, text: 'C' });
});

test('a multi-file patch is atomic: a failure in the second file leaves the first file untouched', () => {
  const files = new Map([['first.txt', 'one\n'], ['second.txt', 'two\n']]);
  assert.throws(() => applyPatch({
    patch: '*** Begin Patch\n*** Update File: first.txt\n-one\n+ONE\n*** Update File: second.txt\n-not there\n+X\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  }), /pattern not found|context lines were not found|removed-line mismatch/i);
  assert.equal(files.get('first.txt'), 'one\n', 'the successful hunk must not have been written');
  assert.equal(files.get('second.txt'), 'two\n');
});

test('a multi-file patch writes every file once when all hunks match', () => {
  const files = new Map([['first.txt', 'one\n'], ['second.txt', 'two\n']]);
  const result = applyPatch({
    patch: '*** Begin Patch\n*** Update File: first.txt\n-one\n+ONE\n*** Update File: second.txt\n-two\n+TWO\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('first.txt'), 'ONE\n');
  assert.equal(files.get('second.txt'), 'TWO\n');
  assert.equal(result.files.length, 2);
});

test('two sections for the same file in one patch chain sequentially (the second sees the first result)', () => {
  const files = new Map([['same.txt', 'a\nb\nc\n']]);
  applyPatch({
    patch: '*** Begin Patch\n*** Update File: same.txt\n-a\n+A\n*** Update File: same.txt\n-c\n+C\n*** End Patch',
    read: (p) => files.get(p) ?? null,
    write: (p, content) => files.set(p, content)
  });
  assert.equal(files.get('same.txt'), 'A\nb\nC\n');
});

test('a file that changed since it was read is reported as a context mismatch, never as an applied patch', () => {
  const files = new Map([['stale.txt', 'original\n']]);
  assert.throws(() => applyPatch({
    patch: '*** Begin Patch\n*** Update File: stale.txt\n@@\n-gone\n+x\n*** End Patch',
    read: () => 'changed underneath\n',
    write: (p, content) => files.set(p, content)
  }), /Correct the patch context|Read the file again/);
  assert.equal(files.get('stale.txt'), 'original\n', 'nothing may be written on a stale-context failure');
});

test('patch failures carry an outcome so recovery is targeted instead of restarting the investigation', () => {
  // context_mismatch: the source moved under the patch -> reread that section only.
  try {
    applyPatch({
      patch: '*** Begin Patch\n*** Update File: f.txt\n@@\n-gone\n+x\n*** End Patch',
      read: () => 'different content\n',
      write: () => { throw new Error('must not write'); }
    });
    assert.fail('expected a failure');
  } catch (error) {
    assert.equal(error.patchOutcome, 'context_mismatch');
  }
  // not_executed: the patch body was never applicable -> reconcile and execute it.
  try {
    applyPatch({ patch: '*** Begin Patch\n*** End Patch', read: () => null, write: () => {} });
    assert.fail('expected a failure');
  } catch (error) {
    assert.equal(error.patchOutcome, 'not_executed');
    assert.match(String(error.message), /no file sections/);
  }
});

test('the executor reports the outcome on a rejected patch and "executed" on a landed one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-outcome-'));
  const target = path.join(dir, 'main.py');
  fs.writeFileSync(target, 'def run():\n    pass\n');
  const backend = new ComputerTools({
    nativeRequest: async () => ({ dispatched: true }),
    capture: null,
    workspaceGuard: {
      beforeMutation: async () => ({ key: 'k', root: dir, records: [] }),
      afterMutation: async () => ({ root: dir, changed: ['main.py'] }),
      noteRead: async () => null
    }
  });
  const rejected = await backend.execute('computer_patch', {
    path: target,
    patch: '*** Begin Patch\n*** Update File: ' + target + '\n@@\n-not there\n+x\n*** End Patch'
  }, 'owner-1');
  assert.equal(rejected.state, 'failed');
  assert.equal(rejected.outcome, 'context_mismatch', 'the recovery procedure depends on the outcome');
  assert.match(String(rejected.error), /Correct the patch context|Read the file again/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'def run():\n    pass\n', 'a rejected patch changed nothing');
  const landed = await backend.execute('computer_patch', {
    path: target,
    patch: '*** Begin Patch\n*** Update File: ' + target + '\n@@\n-    pass\n+    return 42\n*** End Patch'
  }, 'owner-1');
  assert.equal(landed.applied, true);
  assert.equal(landed.outcome, 'executed');
  assert.equal(fs.readFileSync(target, 'utf8'), 'def run():\n    return 42\n');
});
