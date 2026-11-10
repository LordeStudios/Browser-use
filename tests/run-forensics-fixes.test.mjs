// run-forensics-fixes.test.mjs — node --test tests/run-forensics-fixes.test.mjs
//
// Targeted fixes from the 3-way independent audit of run sssa.txt
// (2026-10-15): ownership-guard permanent lockout, harness telemetry leaking
// into page console, computer_read image-bytes context bloat, the visual-
// claim fabrication gate, and the wire's evidence naming (DOM capture is
// never a screenshot — owner directive).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { WorkspaceChangeGuard } = require('../desktop/computer/workspaceChangeGuard.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
const { unbackedActionClaims } = require('../desktop/agent/desktopAgentCoordinator.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');
const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');

async function gitFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-forensics-'));
  await exec('git', ['init'], { cwd: root });
  await exec('git', ['config', 'user.email', 'f@example.test'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Forensics'], { cwd: root });
  const file = path.join(root, 'style.css');
  await fs.writeFile(file, '.card { color: red; }\n');
  await exec('git', ['add', '.'], { cwd: root });
  await exec('git', ['commit', '-m', 'base'], { cwd: root });
  return { root, file };
}

// AUDIT FINDING 1 (all 3 critics): after ANY external/terminal edit, the
// ownership guard locked the path PERMANENTLY — noteRead never refreshes
// agentChanges and the throw had no rescue — so every later patch died and
// the agent fell back to raw shell edits. The rescue now mirrors the
// pre-existing branch's own logic: a fresh re-read + exact edit, or an
// explicit expectedHash acknowledgment.
test('guard: a fresh re-read rescues changedAfterAgent for exact edits', async () => {
  const { file } = await gitFixture();
  const guard = new WorkspaceChangeGuard();
  const mutation = async (owner, input, write) => {
    const context = await guard.beforeMutation(owner, input);
    if (write) await write();
    await guard.afterMutation(context, input);
    return context;
  };
  try {
    // The real flow: read -> beforeMutation -> the edit lands -> afterMutation
    // (records the agent's own post-write hash in agentChanges).
    await guard.noteRead('chat:one', file);
    await mutation('chat:one', { action: 'edit', path: file }, () => fs.writeFile(file, '.card { color: blue; }\n'));
    // An external/terminal edit lands AFTER the agent's write...
    await exec('powershell', ['-NoProfile', '-Command', `(Get-Content '${file.replace(/'/g, "''")}') -replace 'blue', 'green' | Set-Content '${file.replace(/'/g, "''")}'`]);
    // ...the OLD code threw here forever (no re-read yet — still protected).
    await assert.rejects(mutation('chat:one', { action: 'edit', path: file }), /changed after the agent baseline\/read/);
    // The agent RE-READS the current content, then makes an exact edit —
    // that must be allowed (it demonstrably incorporated the change).
    await guard.noteRead('chat:one', file);
    const rescued = await mutation('chat:one', { action: 'edit', path: file });
    assert.ok(rescued, 'freshExactEdit after re-read rescues the stale agentChanges hash');
  } finally { await fs.rm(path.dirname(file), { recursive: true, force: true }); }
});

test('guard: explicit expectedHash acknowledgment rescues changedAfterAgent', async () => {
  const { file } = await gitFixture();
  const guard = new WorkspaceChangeGuard();
  const mutation = async (owner, input, write) => {
    const context = await guard.beforeMutation(owner, input);
    if (write) await write();
    await guard.afterMutation(context, input);
    return context;
  };
  try {
    await guard.noteRead('chat:one', file);
    await mutation('chat:one', { action: 'edit', path: file }, () => fs.writeFile(file, '.card { color: blue; }\n'));
    await fs.writeFile(file, '.card { color: green; }\n'); // external change
    // Current hash from a CLEAN second guard (the agent's own read state is
    // stale — that is the whole point of the acknowledgment escape).
    const currentHash = (await new WorkspaceChangeGuard().noteRead('chat:probe', file)).hash;
    const ok = await mutation('chat:one', { action: 'edit', path: file, acknowledgeExistingChanges: true, expectedHash: currentHash });
    assert.ok(ok, 'acknowledged current bytes rescue the stale hash without a fresh agent read');
  } finally { await fs.rm(path.dirname(file), { recursive: true, force: true }); }
});

// AUDIT FINDING 2 (critics B+C): the tabId-less `|| !entry.tabId` fallback
// let the harness's own entries ([Timing]/[System One] telemetry) ride the
// page console view — ~50% noise burying real page errors.
test('page console/network return ONLY the named tab — harness telemetry excluded', () => {
  const entries = [
    { kind: 'console', level: 'info', message: 'page log', tabId: 'tab-1' },
    { kind: 'error', level: 'error', message: 'real page error', tabId: 'tab-1' },
    { kind: 'network', level: 'error', message: 'net::ERR', tabId: 'tab-1' },
    { kind: 'agent', level: 'info', message: '[Timing] render 12ms' },
    { kind: 'computer', level: 'error', message: '[System One] unavailable' },
    { kind: 'console', level: 'info', message: 'other tab', tabId: 'tab-2' }
  ];
  const controller = new BrowserViewController({ getTabs: () => [], getSelectedTabId: () => 'tab-1', getConsoleEntries: () => entries, normalizeUrl: (u) => u });
  const consoleEntries = controller.consoleEntries('tab-1');
  // This tab's page entries ride (console/error/network); the harness's own
  // tabId-less entries and other tabs' entries never do.
  assert.deepEqual(consoleEntries.map((e) => e.message), ['page log', 'real page error', 'net::ERR']);
  const networkEntries = controller.networkEntries('tab-1');
  assert.deepEqual(networkEntries.map((e) => e.message), ['net::ERR']);
});

// AUDIT FINDING 3 (critics A+B): one run spent 4 reads × 1.47MB on a PNG the
// model cannot visually decode — image bytes are refused with routing
// guidance; genuine asset work opts back in with bytesOnly.
test('computer_read refuses image bytes by default and honors bytesOnly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-imgread-'));
  const png = path.join(dir, 'reference.png');
  await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]));
  const backend = new ComputerTools({
    nativeRequest: async () => { throw new Error('not used'); },
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  try {
    const refused = await backend.readTool({ path: png, encoding: 'base64' }, () => {}, 'owner');
    assert.equal(refused.kind, 'image');
    assert.equal(refused.content, undefined, 'no base64 bytes ride the context');
    assert.match(refused.note, /browser_screenshot/);
    assert.match(refused.note, /bytesOnly/);
    const raw = await backend.readTool({ path: png, encoding: 'base64', bytesOnly: true }, () => {}, 'owner');
    assert.equal(raw.encoding, 'base64');
    assert.ok(raw.content.length > 0, 'asset work still gets the bytes');
    const note = path.join(dir, 'note.txt');
    await fs.writeFile(note, 'hello');
    const text = await backend.readTool({ path: note, encoding: 'base64', bytesOnly: false }, () => {}, 'owner');
    assert.equal(text.encoding, 'base64', 'non-image binaries are untouched');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// AUDIT FINDING 4 (all 3 critics): 4-5 unevidenced verified:true dones. The
// marker list missed "now visible", "appears", "looks", "verified visually",
// and even matched classes accepted a frame that PREDATED the last edit.
test('visual-state claims need a capture that postdates the last content change', () => {
  const none = { history: [], visualEvidence: null, visualLedger: [] };
  // The audited fabricated claims — every one must bounce.
  for (const summary of [
    'Aurora wave now visible on the hero. Icons updated. Verified.',
    'The icon chips appear top-left as requested. Verified.',
    'The cards look premium now — verified visually.'
  ]) {
    assert.ok(unbackedActionClaims(summary, none).length > 0, `bounces: ${summary.slice(0, 40)}`);
  }
  // A capture AFTER the last content action backs the claim.
  const fresh = { history: [{ tool: 'computer_patch', output: { ok: true } }, { tool: 'browser_screenshot', output: { ok: true } }], visualEvidence: null, visualLedger: [] };
  assert.equal(unbackedActionClaims('The wave texture is visible on the stat cards now.', fresh).length, 0);
  // A capture BEFORE the last content action does not.
  const stale = { history: [{ tool: 'browser_screenshot', output: { ok: true } }, { tool: 'computer_patch', output: { ok: true } }], visualEvidence: null, visualLedger: [] };
  assert.ok(unbackedActionClaims('The wave texture is visible on the stat cards now.', stale).length > 0);
  // In-band observation captures (the visual ledger) count as fresh too.
  const ledger = { history: [{ tool: 'computer_patch', output: { ok: true } }], visualEvidence: null, visualLedger: [{ source: 'auto', historyLength: 2 }] };
  assert.equal(unbackedActionClaims('The wave texture is visible on the stat cards now.', ledger).length, 0);
});

// OWNER DIRECTIVE (2026-10-15): a DOM capture must never be called a
// screenshot — the evidence kind rides the wire, and the observe tool says so.
test('the wire names the evidence kind; the observe tool forbids the screenshot label', () => {
  const domOnly = boundedRequestContext({ task: 'x', observation: { navigation: { url: 'u', loading: false }, dom: { elements: [] } } });
  assert.match(domOnly.observation.evidenceKind, /dom-capture/);
  assert.match(domOnly.observation.evidenceKind, /NOT a screenshot/);
  const withPixels = boundedRequestContext({ task: 'x', observation: { navigation: { url: 'u', loading: false }, dom: { elements: [] }, screenshot: { tabId: 't', mimeType: 'image/png', source: 'capturePage' } } });
  assert.match(withPixels.observation.evidenceKind, /screenshot — real rendered pixels/);

  const defs = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  assert.match(String(defs.get('browser_observe')?.description || ''), /NEVER call it a screenshot/);
});
