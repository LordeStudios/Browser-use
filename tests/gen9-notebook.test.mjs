// GEN9 PERSISTENT NOTEBOOK — unit suite.
// Feature: durable per-run session state (user rules, working repos,
// credentials, commands, project facts, requirements, write trail) that
// survives compaction, raw eviction, restart, and continuation. Grounded in
// the gen9 defect catalog (F:\harness-lab\gen9\defect-catalog.md): D1 working
// repo forgotten, D2 src-vs-dist re-derived 4x, D4 "file already contains...",
// D5 silent requirement drop, D8 raw eviction past maxTurns.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseNotebook, mergeNotebookText, notebookIndex, notebookWireContext,
  seedNotebookText, createRunNotebook, appendUserLine, FULL_WIRE_BYTES
} = require('../desktop/agent/runNotebook.cjs');
const { ProviderTurnLedger } = require('../desktop/agent/providerTurnLedger.cjs');
const { DesktopChatAgent, executeAction } = require('../desktop/agent/desktopChatAgent.cjs');
const { registerRepo, parseRepoSection, renderRepoMapWire } = require('../desktop/agent/workspacePin.cjs');

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gen9-nb-${label}-`));
}

// ── 1. Creation at run start (seed) ──────────────────────────────────────────
test('notebook seeds at run start: pinned repo, numbered requirements as OPEN, section skeleton', () => {
  const dir = tempDir('seed');
  const file = path.join(dir, 'notebook.md');
  const repoMap = [];
  registerRepo(repoMap, 'E:\\repos\\uganda-art-pulse-v2', { pinned: true, source: 'task' });
  const notebook = createRunNotebook({
    filePath: file,
    task: 'Fix the admin page A1) fix artworks grid A2) fix supplies rows A3) fix user cards',
    workspace: { root: 'E:\\repos\\uganda-art-pulse-v2' },
    repoMap
  });
  const seed = notebook.ensureSeeded();
  assert.equal(seed.seeded, true);
  const text = fs.readFileSync(file, 'utf8');
  // N1: the working repo pin is on disk, in the %description% %path% format.
  assert.match(text, /## WORKING REPOS/);
  assert.match(text, /%uganda-art-pulse-v2% %E:\\repos\\uganda-art-pulse-v2% pinned/);
  // N7: numbered requirements land as an OPEN checklist.
  assert.match(text, /- \[OPEN\] fix artworks grid/);
  assert.match(text, /- \[OPEN\] fix supplies rows/);
  assert.match(text, /- \[OPEN\] fix user cards/);
  // The tool-contract card (N5/N6) is seeded.
  assert.match(text, /computer_patch/);
  // User sections exist and are empty at seed.
  assert.match(text, /## USER RULES/);
  assert.match(text, /## CREDENTIALS & KEYS/);
  assert.match(text, /## COMMANDS/);
  assert.match(text, /## NOTES/);
  // Seeding again does NOT rewrite (user edits win).
  fs.writeFileSync(file, text.replace('## NOTES', '## NOTES\n- user note'));
  const again = notebook.ensureSeeded();
  assert.equal(again.seeded, false);
  assert.match(fs.readFileSync(file, 'utf8'), /user note/);
});

// ── 2. Disk persistence across a simulated restart + rehydration ─────────────
test('notebook persists across a simulated restart; repo map rehydrates from disk', () => {
  const dir = tempDir('restart');
  const file = path.join(dir, 'notebook.md');
  const repoMap = [];
  registerRepo(repoMap, 'E:\\repos\\demo-v2', { pinned: true, source: 'task' });
  const first = createRunNotebook({ filePath: file, task: 'task one', workspace: { root: 'E:\\repos\\demo-v2' }, repoMap });
  first.ensureSeeded();
  first.append('PROJECT FACTS', 'build: node build.mjs -> dist/; wrangler dev :8787 serves dist/, NOT src/');
  first.append('WRITE TRAIL', 'src/css/style.css — computer_patch applied');

  // "Restart": a brand-new handle over the same file (no in-memory state).
  const second = createRunNotebook({ filePath: file, task: 'task one', workspace: { root: 'E:\\repos\\demo-v2' } });
  const text = second.read();
  assert.match(text, /serves dist\/, NOT src\//);
  assert.match(text, /src\/css\/style\.css — computer_patch applied/);
  // N1/N2: the repo map rehydrates from the notebook mirror.
  const hydrated = second.repoMapFromDisk();
  assert.equal(hydrated.length, 1);
  assert.equal(hydrated[0].root, 'E:\\repos\\demo-v2');
  assert.equal(hydrated[0].pinned, true);
  // A non-absolute root is not a repo row.
  assert.equal(parseRepoSection('- %x% %relative% referenced').length, 0);
});

// ── 3. Compaction + raw-eviction exemption (the pinned wire head) ────────────
test('notebook and workspace pin survive forced compaction AND the raw-evict fail-open path', async () => {
  const ledger = new ProviderTurnLedger({ maxTurns: 4 });
  ledger.setWorkspacePin(renderRepoMapWire({ workspace: { root: 'E:\\repos\\demo-v2' }, repoMap: [{ root: 'E:\\repos\\demo-v2', name: 'demo-v2', pinned: true }] }));
  ledger.setNotebookText('RUN NOTEBOOK:\n## WORKING REPOS\n- %demo-v2% %E:\\repos\\demo-v2% pinned');
  // Fill past maxTurns with tiny turns.
  for (let i = 0; i < 8; i += 1) {
    ledger.begin({ task: 't', messages: [`msg ${i}`] });
    ledger.accept({ assistantText: 'ok', actions: [{ name: 'browser_wait', input: { ms: 1 }, callId: `c${i}` }] }, {}, 'openai');
    ledger.record({ callId: `c${i}`, output: { ok: true } });
    ledger.settle([]);
  }
  // Force a real compaction with a working summarizer.
  const stats = await ledger.compact({ current: {}, force: true, summarize: async () => ({ facts: ['f'], completed: [], openQuestions: [], constraints: [], nextActions: [] }) });
  assert.equal(stats.compacted, true);
  const head = JSON.parse(ledger.wireMessages()[0].content);
  assert.match(head.notebook, /%demo-v2%/);
  assert.match(head.workspacePin, /WORKING REPO \(pinned\): E:\\repos\\demo-v2/);

  // The RAW-EVICT path (no summarizer — D8's silent loss): over maxBytes with
  // a huge turn, failOpen evicts turns without summarizing, and the pinned
  // head must still carry the pin + notebook.
  const ledger2 = new ProviderTurnLedger({ maxBytes: 2_000 });
  ledger2.setWorkspacePin('WORKING REPO (pinned): E:\\repos\\demo-v2');
  ledger2.setNotebookText('RUN NOTEBOOK: pinned session state');
  ledger2.begin({ task: 't', messages: ['x'.repeat(5_000)] });
  ledger2.accept({ assistantText: 'ok', actions: [] }, {}, 'openai');
  ledger2.settle([]);
  const evictStats = await ledger2.compact({ current: {}, force: true, summarize: null });
  assert.equal(evictStats.compacted, false);
  const head2 = JSON.parse(ledger2.wireMessages()[0].content);
  assert.match(head2.workspacePin, /demo-v2/);
  assert.match(head2.notebook, /pinned session state/);
});

// ── 4. User-edit merge without clobbering agent entries ──────────────────────
test('user Save merges: user sections verbatim, agent entries kept, additions kept, unknown sections preserved', () => {
  const current = [
    '# RUN NOTEBOOK',
    '## PROJECT FACTS',
    '- build: node build.mjs -> dist/; server serves dist/ NOT src/',
    '## WRITE TRAIL',
    '- a.css — patch applied',
    '## USER RULES',
    '- always take screenshots first',
    '## NOTES',
    '- hello'
  ].join('\n');
  const edited = [
    '# RUN NOTEBOOK',
    '## PROJECT FACTS',
    '- wrangler dev serves the dist build',
    '## USER RULES',
    '- always take screenshots first',
    '- never restart the dev server without asking',
    '## NOTES',
    '',  // user cleared their notes — user sections take the edit verbatim
    '## MY OWN SECTION',
    '- kept verbatim'
  ].join('\n');
  const { text, changed } = mergeNotebookText(current, edited);
  // USER sections: the user's edited content wins verbatim (incl. deletion).
  const parsed = parseNotebook(text);
  const rules = parsed.sections.find(s => s.title === 'USER RULES');
  assert.deepEqual(rules.lines.filter(l => l.trim()), ['- always take screenshots first', '- never restart the dev server without asking']);
  const notes = parsed.sections.find(s => s.title === 'NOTES');
  assert.equal(notes.lines.some(l => l.includes('hello')), false);
  // AGENT sections: on-disk entries are never clobbered…
  const facts = parsed.sections.find(s => s.title === 'PROJECT FACTS');
  assert.ok(facts.lines.some(l => l.includes('server serves dist/ NOT src/')));
  // …but lines the user ADDED there are preserved.
  assert.ok(facts.lines.some(l => l.includes('wrangler dev serves the dist build')));
  // Unknown (user-created) sections pass through verbatim.
  const own = parsed.sections.find(s => s.title === 'MY OWN SECTION');
  assert.deepEqual(own.lines, ['- kept verbatim']);
  // WRITE TRAIL untouched by the edit.
  const trail = parsed.sections.find(s => s.title === 'WRITE TRAIL');
  assert.ok(trail.lines.some(l => l.includes('a.css — patch applied')));
  assert.equal(changed, true);
  // An agent-owned section the editor deleted is RESTORED from disk.
  const editedMissingTrail = edited.replace('## USER RULES', '## WRITE TRAIL\n## USER RULES');
  // (the edited text above lacks PROJECT FACTS' agent line only as an addition; deletion case:)
  const { text: restored } = mergeNotebookText(current, '## USER RULES\n- x\n## PROJECT FACTS\n');
  assert.ok(parseNotebook(restored).sections.find(s => s.title === 'WRITE TRAIL').lines.some(l => l.includes('a.css')));
});

// ── 5. /notebook command wiring (agent slash) + appendUserLine (CLI) ─────────
test('/notebook slash publishes notebook.open and /notebook <text> appends; CLI appendUserLine matches', async () => {
  const dir = tempDir('slash');
  const file = path.join(dir, 'notebook.md');
  const notebook = createRunNotebook({ filePath: file, task: 't', workspace: { root: 'E:\\repos\\demo-v2' } });
  notebook.ensureSeeded();
  const events = [];
  const run = {
    id: 'run-1', status: 'running', task: 't', history: [], messages: [],
    eventRevision: 0, objectiveLedger: [], repoMap: [], workspace: { root: 'E:\\repos\\demo-v2' },
    notebook, turnLedger: new ProviderTurnLedger({})
  };
  const agent = new DesktopChatAgent({ controller: {}, getSelectedTabId: () => 't', getControlMode: () => 'agi', emit() {}, createProvider() { throw new Error('not used'); } });
  const originalPublish = agent.publish.bind(agent);
  agent.publish = (type, r, payload) => { events.push({ type, payload }); return originalPublish(type, r, payload); };
  const opened = await agent.handleSlashCommand(run, '/notebook');
  assert.equal(opened.status, 'notebook-open');
  assert.equal(opened.path, file);
  assert.ok(events.some(event => event.type === 'notebook.open' && event.payload.path === file));
  const appended = await agent.handleSlashCommand(run, '/notebook remember the repo is demo-v2');
  assert.equal(appended.status, 'notebook-appended');
  assert.match(notebook.read(), /remember the repo is demo-v2/);
  assert.ok(run.messages.some(message => message.role === 'assistant' && /Noted in the notebook/.test(message.content)));
  // The notebook lands on the wire after the append (syncNotebook ran).
  assert.match(run.turnLedger.notebookWire, /remember the repo is demo-v2/);
  // The standalone CLI helper behaves the same.
  const file2 = path.join(dir, 'notebook-cli.md');
  const result = appendUserLine(file2, 'cli line');
  assert.equal(result.ok, true);
  const cliText = fs.readFileSync(file2, 'utf8');
  assert.match(cliText, /## NOTES/);
  assert.match(cliText, /cli line/);
});

// ── 6. The notebook TOOL (executeAction): read + update, user-section routing ─
test('notebook tool: op=read returns content, op=update appends, user-owned sections route to NOTES', async () => {
  const dir = tempDir('tool');
  const file = path.join(dir, 'notebook.md');
  const notebook = createRunNotebook({ filePath: file, task: 't', workspace: { root: 'E:\\repos\\demo-v2' } });
  notebook.ensureSeeded();
  const run = { notebook, repoMap: [], workspace: { root: 'E:\\repos\\demo-v2' }, task: 't', messages: [], loopState: { consecutiveWaits: 0, lastWaitedMs: 0 } };
  const read = await executeAction(null, run, { name: 'notebook', input: { op: 'read' } });
  assert.equal(read.ok, true);
  assert.match(read.result.content, /## WORKING REPOS/);
  assert.equal(read.result.path, file);
  const sectionRead = await executeAction(null, run, { name: 'notebook', input: { op: 'read', section: 'PROJECT FACTS' } });
  assert.equal(sectionRead.ok, true);
  assert.match(sectionRead.result.content, /record build\/serve pipeline facts/);
  const missing = await executeAction(null, run, { name: 'notebook', input: { op: 'read', section: 'NOPE' } });
  assert.equal(missing.ok, false);
  // Agent append to an agent-owned section.
  const update = await executeAction(null, run, { name: 'notebook', input: { op: 'update', section: 'PROJECT FACTS', text: 'serve dist/' } });
  assert.equal(update.ok, true);
  assert.match(notebook.readSection('PROJECT FACTS'), /serve dist\//);
  // A model update to a USER-owned section is routed to NOTES (never clobbers).
  const guarded = await executeAction(null, run, { name: 'notebook', input: { op: 'update', section: 'USER RULES', text: 'model-suggested rule' } });
  assert.equal(guarded.ok, true);
  assert.match(guarded.result.note, /user-owned/);
  assert.match(notebook.readSection('NOTES'), /model-suggested rule/);
  assert.doesNotMatch(notebook.readSection('USER RULES'), /model-suggested rule/);
  const badOp = await executeAction(null, run, { name: 'notebook', input: { op: 'delete' } });
  assert.equal(badOp.ok, false);
});

// ── 7. Wire-context decision: full ride <= 4KB, index above ──────────────────
test('wire context: full notebook rides while small, compact index past the 4KB budget', () => {
  const small = seedNotebookText({ task: 't', workspace: { root: 'E:\\r' } });
  const smallWire = notebookWireContext(small, 'x.md');
  assert.match(smallWire, /RUN NOTEBOOK/);
  assert.match(smallWire, /## WORKING REPOS/);
  assert.ok(Buffer.byteLength(smallWire, 'utf8') > 200);
  // Grow past the budget: the index form appears, the body does not.
  const big = `${small}\n${'## DECISIONS\n' + Array.from({ length: 120 }, (_, i) => `- [10:00] decision ${i} ${'x'.repeat(60)}`).join('\n')}`;
  assert.ok(Buffer.byteLength(big, 'utf8') > FULL_WIRE_BYTES);
  const bigWire = notebookWireContext(big, 'x.md');
  assert.match(bigWire, /NOTEBOOK INDEX/);
  assert.doesNotMatch(bigWire, /decision 118/);
  assert.match(bigWire, /read sections on demand/);
  const index = notebookIndex(big, 'x.md');
  assert.ok(index.split('\n').length <= 21); // header + <= 20 lines
  // Empty notebook yields no wire block at all.
  assert.equal(notebookWireContext('   ', 'x.md'), null);
});

// ── 8. End-to-end: a real run start pins the notebook on the first decision ──
test('agent run start: notebook created in notebookDir, pinned wire carries it, state() exposes the path', async () => {
  const dir = tempDir('run');
  const notebookDir = path.join(dir, 'notebooks');
  const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 81, tag: 'button', name: 'Unique current control' }] } };
  const contexts = [];
  const controller = { navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute: async () => ({ content: 'evidence' }), releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, notebookDir, createProvider: () => ({ complete: ctx => { contexts.push(ctx); return { done: { summary: 'Done once.', success: true, verified: true } }; } }) });
  // A REAL workspace directory (the desktop app passes request.workspace the
  // same way — main.cjs resolveWorkspaceContract).
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gen9-ws-'));
  const repoName = path.basename(workspace);
  const task = `Fix the admin page A1) fix artworks grid A2) fix supplies rows ${workspace}`;
  await agent.start({ task, workspace: { root: workspace }, settings: { controlMode: 'agi' } });
  const run = agent.run;
  assert.equal(run.status, 'completed');
  assert.ok(run.notebookPath.startsWith(notebookDir));
  assert.ok(fs.existsSync(run.notebookPath));
  // The FIRST decision already saw the pinned notebook + repo pin.
  const wire0 = contexts[0].turnLedger.wireMessages().map(m => String(m.content)).join('\n');
  const head0 = JSON.parse(contexts[0].turnLedger.wireMessages()[0].content);
  assert.match(wire0, /RUN NOTEBOOK/);
  assert.ok(head0.notebook.includes(workspace));
  assert.ok(head0.workspacePin.includes(`WORKING REPO (pinned): ${workspace}`));
  // Requirements seeded as OPEN on disk.
  const onDisk = fs.readFileSync(run.notebookPath, 'utf8');
  assert.match(onDisk, /- \[OPEN\] fix artworks grid/);
  assert.ok(onDisk.includes(`%${repoName}% %${workspace}% pinned`));
  // serializeRun: the path travels, the notebook INSTANCE does not (IPC-safe).
  const state = agent.state();
  assert.equal(state.notebookPath, run.notebookPath);
  assert.equal(state.notebook, undefined);
  assert.ok(typeof state.notebookIndex === 'string' && state.notebookIndex.includes('## WORKING REPOS'));
  // browser_done captured a DECISIONS entry (auto-capture, N-lifecycle).
  assert.match(fs.readFileSync(run.notebookPath, 'utf8'), /DONE \(verified\): Done once\./);
});

// ── 9. Continuation re-opens the SAME file (restart survival, run-level) ─────
test('continuation restores the notebook from snapshot notebookPath and re-pins the wire', async () => {
  const dir = tempDir('continue');
  const notebookDir = path.join(dir, 'notebooks');
  const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 81, tag: 'button', name: 'Unique current control' }] } };
  const controller = { navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute: async () => ({ content: 'evidence' }), releaseOwner: async () => {}, releaseInput: async () => {} };
  const contexts = [];
  const makeAgent = () => new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, notebookDir, createProvider: () => ({ complete: ctx => { contexts.push(ctx); return { done: { summary: 'Turn done.', success: true, verified: true } }; } }) });
  const agent = makeAgent();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gen9-ws2-'));
  await agent.start({ task: 'first turn', workspace: { root: workspace }, settings: { controlMode: 'agi' } });
  const firstPath = agent.run.notebookPath;
  const snapshot = agent.state();
  assert.equal(snapshot.notebookPath, firstPath);
  // Simulate a restart: a fresh agent instance continues the SAME conversation
  // from the serialized snapshot (the desktop continuation path).
  const second = makeAgent();
  await second.start({ task: 'second turn', continuation: true, conversation: snapshot, workspace: { root: workspace }, settings: { controlMode: 'agi' } });
  assert.equal(second.run.notebookPath, firstPath);
  // The first turn's DECISIONS entry survived on disk into the continuation.
  assert.match(second.run.notebook.read(), /DONE \(verified\): Turn done\./);
  // The pinned wire of the continuation carries the notebook again.
  const wire = contexts.at(-1).turnLedger.wireMessages().map(m => String(m.content)).join('\n');
  assert.match(wire, /RUN NOTEBOOK/);
  assert.ok(wire.includes(path.basename(workspace)));
});
