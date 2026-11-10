import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ComputerTools, compileGlob } = require('../desktop/computer/computerTools.cjs');
const { describeToolTarget } = require('../desktop/renderer/toolTarget.cjs');

// ---- brace globs in the no-ripgrep walkers (run.txt: `*.{rs,mjs,js}` -> 0 files) ----

test('compileGlob expands {a,b} alternation like ripgrep', () => {
  const rs = compileGlob('*.{rs,mjs,js}');
  assert.ok(rs.test('api.rs') && rs.test('run.mjs') && rs.test('x.js'));
  assert.equal(rs.test('readme.md'), false);
  assert.equal(compileGlob('src/**/*.{rs,toml}').test('src/x/y/lib.rs'), true);
  assert.equal(compileGlob('*.{rs,mjs,js,cs,md,html,toml,ps1}').test('main.rs'), true);
});

test('compileGlob: ** spans zero or more directories, * and ? stay inside one', () => {
  assert.equal(compileGlob('**/*.rs').test('main.rs'), true, '**/ matches zero directories');
  assert.equal(compileGlob('**/*.rs').test('crates/a/src/api.rs'), true);
  assert.equal(compileGlob('crates/**/*.rs').test('crates/a/src/api.rs'), true);
  assert.equal(compileGlob('*.rs').test('crates/api.rs'), false, '* never crosses a slash');
  assert.equal(compileGlob('a?.txt').test('ab.txt'), true);
  assert.equal(compileGlob('a?.txt').test('a/.txt'), false);
  assert.equal(compileGlob('v1.0.*').test('v1x0.txt'), false, 'dots are literal');
  assert.equal(compileGlob(null), null);
});

test('walker search honours brace globs and Windows-separator relative paths', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-glob-'));
  const c = new ComputerTools();
  c._rgChecked = false; // force the JS walker even when ripgrep is installed
  try {
    await fs.mkdir(path.join(root, 'crates', 'host', 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'crates', 'host', 'src', 'api.rs'), 'fn gpu_profiles() {}\n');
    await fs.writeFile(path.join(root, 'ui.mjs'), 'const gpu_profiles = 1;\n');
    await fs.writeFile(path.join(root, 'notes.md'), 'gpu_profiles notes\n');

    const braces = await c.execute('computer_search', { pattern: 'gpu_profiles', path: root, output: 'files', glob: '*.{rs,mjs}' }, 'test');
    assert.equal(braces.engine, 'walker');
    assert.deepEqual(braces.files.map((f) => f.relative).sort(), ['crates/host/src/api.rs', 'ui.mjs']);

    const nested = await c.execute('computer_search', { pattern: 'gpu_profiles', path: root, output: 'files', glob: 'crates/**/*.rs' }, 'test');
    assert.deepEqual(nested.files.map((f) => f.relative), ['crates/host/src/api.rs'], 'a directory glob matches the relative path on every platform');

    const found = await c.execute('computer_fs', { action: 'find', path: root, glob: '*.{rs,mjs}' }, 'test');
    assert.deepEqual(found.files.map((f) => f.relative).sort(), ['crates/host/src/api.rs', 'ui.mjs']);
  } finally { await c.close(); await fs.rm(root, { recursive: true, force: true }); }
});

// ---- hover target: short name visible, full directory in the tooltip ----

test('computer_write / computer_read name the file; the full path is carried for the hover', () => {
  const full = 'C:\\users\\london\\desktop\\tests\\run.txt';
  assert.deepEqual(describeToolTarget('computer_write', { path: full, content: 'x' }, { ok: true, result: { path: full } }), { full, name: 'run.txt', kind: 'file' });
  assert.deepEqual(describeToolTarget('computer_read', { path: full }, { ok: true, result: { path: full } }), { full, name: 'run.txt', kind: 'file' });
  assert.equal(describeToolTarget('computer_patch', { path: full, patch: '' }, null).name, 'run.txt');
});

test('folder targets show the folder name and keep the full directory', () => {
  const dir = 'C:\\users\\london\\desktop\\tests';
  const listed = describeToolTarget('computer_fs', { action: 'list', path: dir }, { ok: true, result: { path: dir, entries: [] } });
  assert.deepEqual(listed, { full: dir, name: 'tests', kind: 'folder' });
  assert.equal(describeToolTarget('computer_search', { pattern: 'x', path: dir }, { ok: true, result: { root: dir, engine: 'walker', files: [] } }).kind, 'folder');
  assert.equal(describeToolTarget('computer_search', { pattern: 'x', path: `${dir}\\run.txt` }, { ok: true, result: { root: `${dir}\\run.txt`, lines: [] } }).kind, 'file', 'a single-file search names a file');
  assert.equal(describeToolTarget('computer_index', { path: dir }, null).kind, 'folder');
  assert.equal(describeToolTarget('computer_index', { path: dir, file: `${dir}\\a.js` }, null).name, 'a.js');
});

test('trailing separators, drive roots, long-path prefixes and POSIX paths resolve cleanly', () => {
  assert.equal(describeToolTarget('computer_fs', { action: 'list', path: 'C:\\work\\tests\\' }, null).name, 'tests');
  assert.equal(describeToolTarget('computer_fs', { action: 'list', path: 'C:\\' }, null).name, 'C:\\');
  assert.equal(describeToolTarget('computer_read', { path: '\\\\?\\C:\\a\\b.txt' }, null).full, 'C:\\a\\b.txt');
  assert.deepEqual(describeToolTarget('computer_read', { path: '/home/u/run.txt' }, null), { full: '/home/u/run.txt', name: 'run.txt', kind: 'file' });
});

test('long names are shortened for the label but never for the tooltip path', () => {
  const name = `${'a'.repeat(80)}.txt`;
  const full = `C:\\d\\${name}`;
  const target = describeToolTarget('computer_read', { path: full }, null);
  assert.equal(target.full, full);
  assert.ok(target.name.length <= 48 && target.name.endsWith('…'));
});

test('tools without a usable absolute path produce no target', () => {
  assert.equal(describeToolTarget('browser_click', { path: 'C:\\a.txt' }, null), null);
  assert.equal(describeToolTarget('computer_read', { path: 'relative\\run.txt' }, null), null);
  assert.equal(describeToolTarget('computer_read', {}, null), null);
  assert.equal(describeToolTarget('computer_read', undefined, undefined), null);
});

test('a failed or path-less input falls back to the path the result echoes', () => {
  const full = 'C:\\proj\\out.log';
  assert.equal(describeToolTarget('computer_write', undefined, { ok: true, result: { path: full } }).full, full);
});

test('the renderer wires the target into the tool row and ships the helper', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const app = await fs.readFile(path.join(root, 'desktop/renderer/app.js'), 'utf8');
  const html = await fs.readFile(path.join(root, 'desktop/renderer/index.html'), 'utf8');
  assert.match(html, /<script src="toolTarget\.cjs"><\/script>\s*<script src="chatCommands\.cjs">/, 'helper loads before app.js');
  assert.match(app, /toolTargetApi\?\.describeToolTarget\(text, inspection\?\.input, options\.targetOutput \?\? inspection\?\.output\)/);
  assert.match(app, /targetLabel\.title = target\.full/, 'the full directory is the hover tooltip');
  assert.match(app, /targetOutput: event\.output/, 'live rows pass the raw tool output');
  assert.match(app, /\{ targetOutput: output \}/, 'restored conversations pass it too');
});
