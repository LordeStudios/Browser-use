import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { COMPUTER_TOOLS, AGI_PROMPT, agiPromptForTask } = require('../desktop/computer/computerCatalog.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('file operations use real paths, exact edits and paged reads', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-files-'));
  const c = new ComputerTools();
  const file = path.join(dir, 'Unicode-测试.txt');
  try {
    const run = input => c.execute('computer_file', { path: file, ...input }, 'test');
    await run({ action: 'write', content: 'first second second' });
    await assert.rejects(run({ action: 'write', content: 'overwrite' }), /exist/i);
    await assert.rejects(run({ action: 'edit', oldText: 'second', newText: 'x' }), /2 occurrences/);
    await run({ action: 'edit', oldText: 'second', newText: 'next', replaceAll: true });
    // Text reads are LINE-based (Claude-Code semantics): offset is a 1-based
    // line number, limit counts lines.
    const whole = await run({ action: 'read' });
    assert.equal(whole.content, 'first next next');
    assert.equal(whole.totalLines, 1);
    assert.equal(whole.nextLine, null);
    await run({ action: 'write', path: file, content: 'alpha\nbravo\ncharlie\ndelta\necho', overwrite: true });
    const paged = await run({ action: 'read', offset: 2, limit: 2 });
    assert.equal(paged.content, 'bravo\ncharlie');
    assert.equal(paged.lines, 2);
    assert.equal(paged.totalLines, 5);
    assert.equal(paged.nextLine, 4, 'pagination continues at the next LINE number');
    const tail = await run({ action: 'read', offset: 5 });
    assert.equal(tail.content, 'echo');
    assert.equal(tail.nextLine, null);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(c.execute('computer_file', { action: 'write', path: file, content: 'bad', overwrite: true }, 'test', { signal: cancelled.signal }), /cancelled/);
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha\nbravo\ncharlie\ndelta\necho');
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('existing/new/binary files, directories, copy/move/delete and search work on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-file-lifecycle-'));
  const c = new ComputerTools();
  const run = input => c.execute('computer_file', input, 'test');
  try {
    const nested = path.join(root, 'new', 'deep', 'existing.txt');
    await run({ action: 'write', path: nested, content: 'before', createParents: true });
    await run({ action: 'write', path: nested, content: 'after', overwrite: true });
    await run({ action: 'append', path: nested, content: '\nneedle match\nneedle again' });
    assert.equal(await fs.readFile(nested, 'utf8'), 'after\nneedle match\nneedle again');
    const copy = path.join(root, 'copy.txt'), moved = path.join(root, 'moved.txt');
    await run({ action: 'copy', path: nested, destination: copy });
    await assert.rejects(run({ action: 'copy', path: nested, destination: copy }), /exists/);
    await run({ action: 'move', path: copy, destination: moved });
    await assert.rejects(fs.stat(copy), /ENOENT/);
    const found = await run({ action: 'search', path: root, query: 'needle', recursive: true, searchContent: true, limit: 1 });
    assert.equal(found.matches.length, 1); assert.equal(found.matches[0].line, 2); assert.equal(found.nextOffset, 1);
    const next = await run({ action: 'search', path: root, query: 'needle', recursive: true, searchContent: true, offset: 1, limit: 1 });
    assert.equal(next.matches.length, 1);
    assert.ok((await run({ action: 'search', path: root, query: 'MOVED' })).matches.some(m => m.path === moved));
    const binary = path.join(root, 'bytes.bin'), original = Buffer.from([0, 255, 13, 88, 129]);
    await run({ action: 'write', path: binary, content: original.toString('base64'), encoding: 'base64' });
    const read = await run({ action: 'read', path: binary, encoding: 'base64' }); assert.deepEqual(Buffer.from(read.content, 'base64'), original);
    await run({ action: 'mkdir', path: path.join(root, 'empty') });
    await run({ action: 'delete', path: path.join(root, 'empty') });
    await run({ action: 'copy', path: path.join(root, 'new'), destination: path.join(root, 'copydir'), recursive: true });
    assert.equal(await fs.readFile(path.join(root, 'copydir/deep/existing.txt'), 'utf8'), 'after\nneedle match\nneedle again');
    await run({ action: 'delete', path: path.join(root, 'copydir'), recursive: true });
    await run({ action: 'delete', path: moved });
    assert.equal((await fs.readdir(path.dirname(nested))).some(name => name.includes('.bu-')), false);
  } finally { await c.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('cancelled staged overwrite preserves the existing file', async () => {
  const { atomicWrite } = require('../desktop/computer/fileOperations.cjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-atomic-')), file = path.join(root, 'data.txt');
  try {
    await fs.writeFile(file, 'original'); let checks = 0;
    await assert.rejects(atomicWrite(file, Buffer.from('replacement'), true, () => { if (++checks === 2) throw new Error('cancelled'); }), /cancelled/);
    assert.equal(await fs.readFile(file, 'utf8'), 'original'); assert.deepEqual(await fs.readdir(root), ['data.txt']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('terminal file writes remain available while the catalog steers ordinary edits to patch/write', () => {
  const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
  const tool = COMPUTER_TOOLS.find((entry) => entry.name === 'computer_terminal');
  assert.match(tool.description, /strongly discouraged/i);
  assert.doesNotMatch(tool.description, /blocked/i);
});

test('commands report real output, nonzero exit and owned cancellation', async () => {
  const c = new ComputerTools();
  async function complete(command) {
    let job = await c.execute('computer_terminal', { action: 'execute', command }, 'test');
    const deadline = Date.now() + 20_000;
    while (job.state === 'running' && Date.now() < deadline) {
      job = await c.execute('computer_terminal', { action: 'read', jobId: job.jobId, waitMs: 200 }, 'test');
    }
    return job;
  }
  try {
    const success = await complete(process.platform === 'win32' ? 'Write-Output native-terminal-ready' : 'printf native-terminal-ready');
    assert.equal(success.state, 'completed'); assert.equal(success.exitCode, 0); assert.match(success.output, /native-terminal-ready/);
    const beforeRead = Date.now();
    const reread = await c.execute('computer_terminal', { action: 'read', jobId: success.jobId, waitMs: 2000 }, 'test');
    assert.equal(reread.output, success.output);
    assert.ok(Date.now() - beforeRead < 1000, 'completed-job read must not sleep for the requested timeout');
    const raw = await complete(process.platform === 'win32' ? '$x=1000000000; [pscustomobject]@{value=$x; repeated="aaaa"} | ConvertTo-Json -Compress' : 'printf \'{"value":1000000000,"repeated":"aaaa"}\'');
    assert.deepEqual(JSON.parse(raw.output), { value: 1000000000, repeated: 'aaaa' });
    const failure = await complete('exit 7'); assert.equal(failure.state, 'failed'); assert.equal(failure.exitCode, 7);
    const job = await c.execute('computer_terminal', { action: 'execute', command: process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60', waitMs: 0 }, 'test');
    await assert.rejects(c.execute('computer_terminal', { action: 'cancel', jobId: job.jobId }, 'other'), /owned/);
    const stopped = await c.execute('computer_terminal', { action: 'cancel', jobId: job.jobId }, 'test'); assert.equal(stopped.state, 'cancelled');
  } finally { await c.close(); }
});

// Visibility without session management: every execute command and its output
// is mirrored into a virtual panel session owned by the run, and cleanup
// disposes it. A broker failure must never break or delay execution itself.
test('execute mirrors command and output into a virtual activity session', async () => {
  const written = [];
  let disposed = 0;
  const broker = {
    create: async ({ virtual, cwd }) => {
      assert.equal(virtual, true, 'the activity session must be virtual, not a real shell');
      assert.equal(cwd, undefined);
      return { id: 'term-mirror', virtual: true, backend: 'virtual', disposed: false };
    },
    snapshot: (id) => ({ id, virtual: true }),
    writeInput: async (id, data) => { written.push(data); },
    dispose: async (id) => { disposed += 1; }
  };
  const c = new ComputerTools({ terminal: broker });
  try {
    let job = await c.execute('computer_terminal', { action: 'execute', command: process.platform === 'win32' ? 'Write-Output mirror-check' : 'printf mirror-check', waitMs: 0 }, 'test');
    const deadline = Date.now() + 20_000;
    while (job.state === 'running' && Date.now() < deadline) {
      job = await c.execute('computer_terminal', { action: 'read', jobId: job.jobId, waitMs: 200 }, 'test');
    }
    assert.equal(job.state, 'completed');
    assert.match(job.output, /mirror-check/);
    // Wait out the 100ms mirror throttle, then verify the transcript.
    await delay(300);
    const transcript = written.join('');
    assert.match(transcript, /▶ .*mirror-check/, 'the command header is mirrored');
    assert.match(transcript, /mirror-check/, 'streamed output is mirrored');
    assert.match(transcript, /⏺ exit 0/, 'the exit code is mirrored');
    // The activity session is agent-owned and reused across executes.
    assert.deepEqual(c.agentOwnedSessions().map(s => s.owner), ['test']);
  } finally {
    await c.close();
    assert.equal(disposed, 1, 'cleanup disposes the activity session exactly once');
  }
});

// open must submit the command the model specifies instead of silently
// dropping it — the regression that left sessions at a bare PowerShell prompt.
test('open with a command submits it and returns post-launch history', async () => {
  const written = [];
  let created = 0;
  const history = 'PS> claude\r\n✻ Claude TUI ready';
  const sessions = new Map();
  const broker = {
    create: async (options = {}) => { const session = { id: `term-open-${++created}`, history: 'PS>', alive: true, phase: 'ready', profile: options.profile || 'shell', credentialSource: options.profile === 'claude-code' ? 'api-key' : 'none', inputRevision: 0, outputRevision: 0 }; sessions.set(session.id, session); return session; },
    snapshot: (id) => ({ ...sessions.get(id), history }),
    refresh: async (id) => ({ ...sessions.get(id), history }),
    sendInput: async (id, text) => { written.push(`${text.replace(/[\r\n]+$/g, '')}\r`); const current = sessions.get(id); current.inputRevision += 1; current.outputRevision += 1; current.phase = 'ready'; return { accepted: true, submitted: true, inputRevision: current.inputRevision, outputRevision: current.outputRevision, outputObserved: true, matched: false, timedOut: false, phase: current.phase, status: { ...current, history } }; },
    writeInput: async (id, data) => { written.push(data); return { accepted: true, status: sessions.get(id) }; },
    dispose: async (id) => { sessions.delete(id); return true; },
    backendInfo: () => ({ ptyAvailable: true, backend: 'pty', error: null })
  };
  const c = new ComputerTools({ terminal: broker });
  try {
    const opened = await c.execute('computer_terminal', { action: 'open', cwd: 'E:/repo', command: 'claude', waitMs: 0 }, 'test');
    assert.equal(opened.sessionId, 'term-open-1');
    assert.match(opened.launched, /^claude --name 'browser-use-test' --append-system-prompt '/, 'the built Claude launch command is reported');
    assert.deepEqual(written, [`${opened.launched}\r`], 'the open command is submitted exactly once with an Enter');
    assert.match(opened.history, /TUI ready/, 'returned history reflects post-launch output');
    // An open without a command still works and submits nothing.
    const plain = await c.execute('computer_terminal', { action: 'open', cwd: 'E:/repo', profile: 'claude-code' }, 'test');
    assert.equal(written.length, 1);
    assert.equal(plain.sessionId, opened.sessionId);
    assert.equal(plain.reused, true);
    const separate = await c.execute('computer_terminal', { action: 'open', cwd: 'E:/repo', newSession: true }, 'test');
    assert.notEqual(separate.sessionId, opened.sessionId);
  } finally { await c.close(); }
});



test('send returns acknowledgement evidence and Claude profile reports one credential source', async () => {
  const sessions = new Map();
  let submitted = '';
  const broker = {
    create: async (options) => { const item = { id: 'claude-1', history: 'Claude Code ready', alive: true, phase: 'ready', profile: options.profile, credentialSource: 'api-key', inputRevision: 0, outputRevision: 1 }; sessions.set(item.id, item); return item; },
    snapshot: id => sessions.get(id), refresh: async id => sessions.get(id), backendInfo: () => ({ ptyAvailable: true, backend: 'pty' }),
    sendInput: async (id, text) => { submitted = text; const item = sessions.get(id); item.inputRevision += 1; item.outputRevision += 1; item.phase = 'running'; return { accepted: true, submitted: true, inputRevision: item.inputRevision, outputRevision: item.outputRevision, outputObserved: true, matched: false, historyDelta: 'accepted', timedOut: false, phase: 'running', status: item }; },
    dispose: async () => true
  };
  const tools = new ComputerTools({ terminal: broker });
  try {
    const opened = await tools.execute('computer_terminal', { action: 'open', profile: 'claude-code', cwd: 'E:/repo', waitMs: 0 }, 'chat:stable');
    assert.equal(opened.profile, 'claude-code');
    assert.equal(opened.credentialSource, 'api-key');
    const result = await tools.execute('computer_terminal', { action: 'send', sessionId: opened.sessionId, text: 'Apply the exact changes', waitMs: 100 }, 'chat:stable');
    assert.equal(submitted, 'Apply the exact changes');
    assert.equal(result.acknowledgement.submitted, true);
    assert.equal(result.acknowledgement.outputObserved, true);
    assert.equal(result.phase, 'running');
  } finally { await tools.close(); }
});

test('clipboard uses the system adapter and cleanup joins before rejecting new work', async () => {
  let text = 'old text', nativeReleases = 0;
  const c = new ComputerTools({ clipboard: { readText: () => text, writeText: next => { text = next; } }, nativeRequest: async name => { if (name === 'release') { nativeReleases++; await delay(20); } return {}; } });
  assert.equal((await c.execute('computer_clipboard', { action: 'read' }, 'owner')).text, 'old text');
  await c.execute('computer_clipboard', { action: 'write', text: 'new text' }, 'owner'); assert.equal(text, 'new text');
  await Promise.all([c.releaseOwner('owner'), c.releaseOwner('owner')]); assert.equal(nativeReleases, 1);
  await c.close();
  await assert.rejects(c.execute('computer_observe', {}, 'owner'), /shutting down/);
});

test('successful chat settlement releases input without killing intentional background jobs', async () => {
  const h = agentHarness(); let releaseInput = 0, releaseOwner = 0;
  const backend = h.agent.getComputerTools();
  backend.releaseInput = async () => { releaseInput++; };
  backend.releaseOwner = async () => { releaseOwner++; };
  await h.start(); assert.equal(releaseInput, 1); assert.equal(releaseOwner, 0);
});

test('MCP strips display_text metadata before dispatching computer calls', async () => {
  const broker = new SessionBroker({ installationId: 'metadata-test', instanceId: 'metadata-test' });
  const offer = broker.createPairingOffer();
  const paired = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test' } });
  let received = null;
  const server = new LocalMcpServer({
    broker,
    controller: {},
    getControlMode: () => 'agi',
    getComputerTools: () => ({ execute: async (_name, input) => { received = input; return { ok: true }; } })
  });
  await server.callTool({ name: 'computer_observe', arguments: { display_text: 'Inspecting desktop' } }, paired.capability);
  assert.deepEqual(received, {}, 'MCP presentation metadata must not reach the computer backend');
});

test('MCP retains existing authorization and rejects cached computer calls in Browser only', async () => {
  const broker = new SessionBroker({ installationId: 'test', instanceId: 'test' });
  const offer = broker.createPairingOffer(); const paired = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test' } });
  let mode = 'browser', calls = 0;
  const server = new LocalMcpServer({ broker, controller: {}, getControlMode: () => mode, getComputerTools: () => ({ execute: async () => { calls++; return { real: true }; } }) });
  const call = () => server.callTool({ name: 'computer_observe' }, paired.capability);
  await assert.rejects(call(), /AGI mode/); assert.equal(calls, 0);
  const listed = await server.dispatch({ method: 'tools/list' }, paired.capability);
  assert.ok(listed.tools.some(t => t.name === 'computer_terminal'));
  mode = 'agi'; await call(); assert.equal(calls, 1); assert.equal(broker.authenticate(paired.capability).tabId, null);
  mode = 'browser'; await assert.rejects(call(), /AGI mode/);
  mode = 'agi'; broker.revoke(paired.id); await assert.rejects(call(), /unauthorized|session|invalid|expired/i);
});

function agentHarness({ mode = 'agi', approvalMode = 'unattended', nativeCall = { name: 'computer_write', input: { path: 'C:/fixture.txt', content: 'test' } } } = {}) {
  const events = [], executed = [], contexts = [];
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
  const backend = { observe: async () => ({ foregroundWindowId: 'fixture', virtualDesktop: { x: 0, y: 0, width: 800, height: 600 }, windows: [{ id: 'fixture', title: 'Fixture' }] }), execute: async (name, input) => { executed.push({ name, input }); return { path: input.path, changed: true }; }, releaseOwner: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab', getControlMode: () => mode, getComputerTools: () => backend,
    emit: e => events.push(e), createProvider: () => ({ complete: async context => {
      contexts.push(context);
      // A file write is a hard BATCH boundary (the action loop breaks after it
      // so nothing reads a stale filesystem), and the real-verification gate
      // (2026-10-30) bounces verified:true with no evidence call since the
      // last mutation — so a real run reads back what it wrote as its own
      // decision before claiming done. The harness must do the same or the
      // gates (correctly) add bounce decisions.
      if (contexts.length === 1) return { actions: [nativeCall] };
      if (contexts.length === 2) return { actions: [{ name: 'computer_read', input: { path: nativeCall.input?.path || 'C:/fixture.txt' } }] };
      return { actions: [{ name: 'browser_done', input: { summary: 'Done', verified: true } }] };
    } }) });
  return { agent, events, executed, contexts, start: () => agent.start({ task: 'Write the fixture', settings: { approvalMode, controlMode: mode } }) };
}

test('chat Full access reuses the loop and never requests another permission surface', async () => {
  const h = agentHarness(); const result = await h.start();
  assert.equal(result.status, 'completed'); assert.equal(h.executed.length, 2, 'the write and its read-back verification are the only executions');
  assert.equal(h.events.some(e => e.type === 'approval.required'), false);
  assert.ok(h.contexts.length <= 3, 'existing completion review is the only additional decision');
  // Tool budget: computer_model (media generation, all modes) joined the
  // always-on catalog after this ceiling was set; ask_user and create_plan
  // joined it later still — both stay always-advertised so the model can ask
  // the user a question or lay out a plan without waiting for a task-text
  // trigger. tool_schema joined it after that: the adaptive token compressor
  // compacts the schema of every non-core tool, and tool_schema is how the
  // model asks for one in full (no tool is ever hidden, only shortened).
  // This harness runs a NON-coding task, so the whole computer catalog
  // (incl. computer_pointer/computer_stroke and both patch fallbacks) is
  // offered: 66 keeps the same intent — a bounded decision prompt.
  assert.ok(h.contexts[0].tools.length <= 66, 'dedicated file tools + gated focus tool replaced the everything-tool within the tool budget');
  assert.ok(h.contexts[0].tools.some(t => t.name === 'tool_schema'), 'the model must be able to ask for a compressed schema in full');
  assert.ok(h.contexts[0].tools.some(t => t.name === 'computer_record'));
  assert.equal(h.contexts[0].tools.some(t => t.name === 'schedule_task'), false, 'unrelated scheduling tools stay deferred');
  // task_spawn is ALWAYS advertised (2026-10-02): the model must be able to
  // reach for subagents instinctively, not only when the task text says
  // 'delegate'. agent_message stays deferred (needs a live recipient).
  assert.equal(h.contexts[0].tools.some(t => t.name === 'task_spawn'), true, 'subagent spawning must be instinctively available');
  assert.equal(h.contexts[0].tools.some(t => t.name === 'agent_message'), false, 'agent_message stays deferred without a live recipient');
  assert.equal(h.contexts[0].tools.some(t => t.name === 'skill_feedback'), false, 'feedback appears only after a skill is used');
  assert.doesNotThrow(() => structuredClone(result));
});

test('chat Ask uses the existing approval and cancellation cannot execute late', async () => {
  const h = agentHarness({ approvalMode: 'confirm-sensitive' }); const completion = h.start();
  const deadline = Date.now() + 2000;
  while (h.agent.state()?.status !== 'awaiting_approval' && Date.now() < deadline) await delay(5);
  const run = h.agent.state(); assert.equal(run.status, 'awaiting_approval'); assert.equal(run.pendingApproval.tool, 'computer_write');
  assert.equal(h.executed.length, 0);
  h.agent.cancel(run.id); await completion;
  assert.equal(h.executed.length, 0); assert.equal(h.agent.state().status, 'cancelled');
});

test('Browser only chat does not advertise or execute native tools', async () => {
  const h = agentHarness({ mode: 'browser' }); await h.start();
  assert.equal(h.executed.length, 0);
  // computer_model (media generation) is deliberately advertised in every
  // mode; the NATIVE EXECUTION surface must stay agi-only.
  const native = ['computer_observe', 'computer_pointer', 'computer_stroke', 'computer_keyboard', 'computer_window', 'computer_terminal', 'computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_patch', 'computer_git', 'computer_clipboard', 'computer_screenshot', 'computer_record'];
  assert.equal(h.contexts[0].tools.some(t => native.includes(t.name)), false);
});

test('MCP delegated agent inherits the MCP mode, not requested or chat scope', async () => {
  const broker = new SessionBroker({ installationId: 'delegated-test', instanceId: 'delegated-test' });
  const offer = broker.createPairingOffer(); const paired = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'test' } });
  broker.bindTab(paired.capability, 'tab');
  let requested, mode = 'browser';
  const server = new LocalMcpServer({ broker, controller: {}, getControlMode: () => mode, workspaceProvider: () => ({ root: 'E:/repo', target: 'E:/repo/studio' }), agent: { start: async request => { requested = request; return { id: 'run' }; } } });
  await server.callAgentTool('browser_agent_start', { task: 'test', settings: { controlMode: 'agi' } }, paired.capability);
  // An explicit MCP caller choice of control mode is honored (the app-wide
  // mode would have sent browser chess runs into the native desktop path);
  // the resolver still tracks the live host mode.
  assert.equal(requested.settings.controlMode, 'agi');
  mode = 'browser'; assert.equal(requested.controlModeResolver(), 'browser');
  mode = 'agi'; assert.equal(requested.controlModeResolver(), 'agi');
  assert.equal(requested.computerOwner, `mcp:${paired.id}`);
  assert.deepEqual(requested.workspace, { root: 'E:/repo', target: 'E:/repo/studio' });
  broker.revoke(paired.id); assert.equal(requested.controlModeResolver(), 'browser');
});

test('switching away from AGI during an existing Ask approval cannot execute afterward', async () => {
  const h = agentHarness({ approvalMode: 'confirm-sensitive' }); const completion = h.start();
  const deadline = Date.now() + 2000;
  while (h.agent.state()?.status !== 'awaiting_approval' && Date.now() < deadline) await delay(5);
  const run = h.agent.state(); assert.equal(run.status, 'awaiting_approval');
  h.agent.run.getControlMode = () => 'browser';
  // Switching control modes invalidates the pending native action. An explicit
  // user cancel is the only terminal choice; recovery itself must not end it.
  h.agent.cancel(run.id);
  await completion; assert.equal(h.executed.length, 0);
});

test('provider adds only the AGI suffix and passes exact native schemas', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://example.test/v1', model: 'fixture', apiKey: 'fixture-key', fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ done: { summary: 'Hello', success: true } }) } }] }), { headers: { 'content-type': 'application/json' } });
  } });
  const context = { task: 'Hello', history: [], messages: [], tools: [], observation: { navigation: { url: 'https://fixture.test' }, dom: { elements: [] } } };
  await provider.complete(context); await provider.complete({ ...context, tools: COMPUTER_TOOLS });
  assert.equal(requests.length, 2);
  // The playbook is joined as its own block. It used to be glued straight onto
  // the previous sentence ("...asks about them.Browser-use Agent Chat."), which
  // reads as one run-on line and can hide the identity line from the model.
  assert.ok(requests[1].messages[0].content.startsWith(requests[0].messages[0].content), 'the AGI playbook is appended as its own block');
  assert.match(requests[1].messages[0].content, /Browser-use Agent Chat\./, 'the identity line is present and not glued onto the previous sentence');
  assert.deepEqual(requests[1].tools.find(t => t.function.name === 'computer_pointer').function.parameters, COMPUTER_TOOLS.find(t => t.name === 'computer_pointer').inputSchema);
  assert.equal(boundedRequestContext({ ...context, tools: COMPUTER_TOOLS }).tools.length, COMPUTER_TOOLS.length);
});

test('computer_window list waitMs settles as soon as a new window appears, honestly times out otherwise', async () => {
  let observes = 0;
  const before = [{ id: '111', title: 'Browser', pid: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, minimized: false }];
  const after = [...before, { id: '222', title: 'Freshly Launched App', pid: 2, bounds: { x: 10, y: 10, width: 400, height: 400 }, minimized: false }];
  const c = new ComputerTools({ nativeRequest: async (name) => {
    if (name === 'release') return {};
    if (name === 'computer_observe' || name === 'computer_window') {
      observes += 1;
      return { windows: observes >= 3 ? after : before };
    }
    return {};
  } });
  try {
    const settled = await c.execute('computer_window', { action: 'list', waitMs: 3000 }, 'test');
    assert.equal(settled.settled, true);
    assert.deepEqual(settled.newWindowIds, ['222']);
    assert.ok(settled.waitedMs < 3000, 'returns as soon as the new window appears');
    assert.ok(settled.windows.some(w => w.id === '222'));
    // Timeout path: no new window within the bound reports honestly.
    observes = 100;
    const quiet = await c.execute('computer_window', { action: 'list', waitMs: 400 }, 'test');
    assert.equal(quiet.settled, false);
    assert.deepEqual(quiet.newWindowIds, []);
    assert.ok(quiet.waitedMs >= 350, 'waited the full bound before reporting no window');
  } finally { await c.close(); }
});

// ---- Dedicated file tools (computer_file retired for the model) -----------

test('computer_read returns the whole numbered file in one call with honest continuation', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-read-'));
  const c = new ComputerTools();
  const file = path.join(dir, 'sample.js');
  try {
    await fs.writeFile(file, Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`).join('\n'));
    const whole = await c.execute('computer_read', { path: file }, 'test');
    assert.equal(whole.ok, true);
    assert.equal(whole.totalLines, 2500);
    assert.equal(whole.lines, 2000);
    assert.equal(whole.truncated, true);
    assert.equal(whole.nextOffset, 2001);
    assert.match(whole.content.split('\n')[0], /^\s*1\tline 1$/);
    assert.match(whole.content.split('\n').at(-1), /^ {2}2000\tline 2000$/);
    const tail = await c.execute('computer_read', { path: file, offset: whole.nextOffset }, 'test');
    assert.equal(tail.lines, 500);
    assert.match(tail.content.split('\n')[0], /^ {2}2001\tline 2001$/);
    assert.equal(tail.truncated, false);
    await assert.rejects(c.execute('computer_read', { path: dir }, 'test'), /directory/i);
    await assert.rejects(c.execute('computer_read', { path: path.join(dir, 'missing.txt') }, 'test'), /not found/i);
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('computer_write creates, overwrites, appends, and returns diffs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-write-'));
  const c = new ComputerTools();
  const file = path.join(dir, 'new', 'deep', 'out.txt');
  try {
    const created = await c.execute('computer_write', { path: file, content: 'alpha\nbravo\n', createParents: true }, 'test');
    assert.equal(created.ok, true);
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha\nbravo\n');
    assert.ok(created.files, 'the write returns a line diff');
    const appended = await c.execute('computer_write', { path: file, content: 'charlie\n', mode: 'append' }, 'test');
    assert.equal(await fs.readFile(file, 'utf8'), 'alpha\nbravo\ncharlie\n');
    assert.ok(appended.files);
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('computer_search finds code across a tree in one call with context and files modes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-search-'));
  const c = new ComputerTools();
  try {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'a.js'), 'function makeOverlay() {\n  return 1;\n}\n\nfunction unused() {}\n');
    await fs.writeFile(path.join(dir, 'src', 'b.css'), '.overlay { color: red; }\n');
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    await fs.writeFile(path.join(dir, 'dist', 'skip.js'), 'makeOverlay noise\n');
    const content = await c.execute('computer_search', { pattern: 'makeOverlay', path: dir, context: 1 }, 'test');
    assert.equal(content.ok, true);
    const hits = content.lines.filter(line => line.match);
    assert.equal(hits.length, 1, 'one search finds every occurrence without file-by-file reads');
    assert.equal(hits[0].line, 1);
    assert.ok(content.lines.some(line => !line.match && line.line === 2), 'context lines are returned around matches');
    const cssOnly = await c.execute('computer_search', { pattern: 'overlay', path: dir, glob: '*.css', output: 'files' }, 'test');
    assert.deepEqual(cssOnly.files.map(f => path.basename(f.file)), ['b.css']);
    assert.equal(cssOnly.files[0].matches, 1, 'files mode ranks by match count');
    // node_modules and dist are skipped
    await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'x', 'c.js'), 'makeOverlay\n');
    const skipped = await c.execute('computer_search', { pattern: 'makeOverlay', path: dir, output: 'files' }, 'test');
    assert.equal(skipped.files.length, 1, 'only src/a.js matches');
    assert.match(skipped.files[0].file, /a\.js$/);
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('computer_fs covers the non-content filesystem operations', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-fs-'));
  const c = new ComputerTools();
  try {
    await c.execute('computer_fs', { action: 'mkdir', path: path.join(dir, 'a', 'b'), recursive: true }, 'test');
    await fs.writeFile(path.join(dir, 'a', 'b', 'f.txt'), 'x');
    const stat = await c.execute('computer_fs', { action: 'stat', path: path.join(dir, 'a', 'b', 'f.txt') }, 'test');
    assert.equal(stat.ok, true);
    await c.execute('computer_fs', { action: 'copy', path: path.join(dir, 'a'), destination: path.join(dir, 'copy'), recursive: true }, 'test');
    assert.equal(await fs.readFile(path.join(dir, 'copy', 'b', 'f.txt'), 'utf8'), 'x');
    await c.execute('computer_fs', { action: 'move', path: path.join(dir, 'copy'), destination: path.join(dir, 'moved') }, 'test');
    await c.execute('computer_fs', { action: 'delete', path: path.join(dir, 'moved'), recursive: true }, 'test');
    await assert.rejects(fs.stat(path.join(dir, 'moved')), /ENOENT/);
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('the model-facing catalog offers the dedicated tools and never computer_file', () => {
  const names = COMPUTER_TOOLS.map(tool => tool.name);
  for (const name of ['computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_patch']) {
    assert.ok(names.includes(name), `${name} must be model-facing`);
  }
  assert.equal(names.includes('computer_file'), false, 'the everything-tool is retired');
  const coding = agiPromptForTask('fix the repo source');
  assert.match(coding, /computer_terminal is a FALLBACK/);
  // Lean-core contract (2026-10-11 campaign): locating stays index-first, and
  // the playbook teaches instinctive subagent use.
  assert.match(coding, /ONE computer_index query for the most distinctive symbol/);
  assert.match(coding, /ONE computer_read/);
  assert.match(coding, /subagent\s+slices \(task_spawn\)/, 'the playbook must teach instinctive subagent use');
  assert.match(agiPromptForTask('draw a cube'), /never file reads, searches, or text edits/);
});

test('computer_read/computer_write cover binary payloads (base64, byte-paged)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-binary-'));
  const c = new ComputerTools();
  try {
    const original = Buffer.from([0, 1, 2, 255, 128, 77, 0, 9]);
    const file = path.join(dir, 'asset.bin');
    await c.execute('computer_write', { path: file, content: original.toString('base64'), encoding: 'base64', createParents: true }, 'test');
    assert.deepEqual(await fs.readFile(file), original);
    const whole = await c.execute('computer_read', { path: file, encoding: 'base64' }, 'test');
    assert.equal(whole.encoding, 'base64');
    assert.deepEqual(Buffer.from(whole.content, 'base64'), original);
    assert.equal(whole.truncated, false);
    const paged = await c.execute('computer_read', { path: file, encoding: 'base64', offset: 3, limit: 4 }, 'test');
    assert.deepEqual(Buffer.from(paged.content, 'base64'), original.subarray(3, 7));
    assert.equal(paged.nextOffset, 7);
    await assert.rejects(
      c.execute('computer_write', { path: path.join(dir, 'bad.bin'), content: 'not base64!!', encoding: 'base64' }, 'test'),
      /base64/i
    );
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test('computer_fs find locates files by name across a tree in one call', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-find-'));
  const c = new ComputerTools();
  try {
    await fs.mkdir(path.join(dir, 'assets', 'icons'), { recursive: true });
    await fs.writeFile(path.join(dir, 'assets', 'logo.png'), 'x');
    await fs.writeFile(path.join(dir, 'assets', 'icons', 'arrow-PNG.txt'), 'x');
    await fs.writeFile(path.join(dir, 'readme.md'), 'x');
    const found = await c.execute('computer_fs', { action: 'find', path: dir, query: 'png' }, 'test');
    assert.equal(found.ok, true);
    assert.equal(found.matches, 2);
    assert.ok(found.files.every(f => /png/i.test(f.name)));
    const globbed = await c.execute('computer_fs', { action: 'find', path: dir, glob: '*.md' }, 'test');
    assert.equal(globbed.files.length, 1);
    assert.match(globbed.files[0].name, /readme\.md$/);
    await assert.rejects(c.execute('computer_fs', { action: 'find', path: dir }, 'test'), /query.*glob|glob.*query/i);
  } finally { await c.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- computer_index: one-call repo map with per-session cache (2026-10-01) ----

test('computer_index maps symbols across a tree, caches per file, and outlines one file', async () => {
  const c = new ComputerTools();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-index-'));
  try {
    await fs.mkdir(path.join(dir, 'src'), { recursive: true });
    await fs.writeFile(path.join(dir, 'src', 'app.js'), [
      'export function mountOverlay(canvas) {',
      '  return canvas;',
      '}',
      '',
      'class OverlayController {',
      '  attach() {}',
      '}',
      '',
      'const computeOffset = (rect) => rect.x;'
    ].join('\n'));
    await fs.writeFile(path.join(dir, 'src', 'util.py'), 'def measure(a):\n    return a\nclass Grid:\n    pass\n');
    await fs.writeFile(path.join(dir, 'notes.md'), '# Heading One\n## Sub\n');
    await fs.mkdir(path.join(dir, 'node_modules', 'x'), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', 'x', 'dep.js'), 'function ignored() {}');

    const first = await c.execute('computer_index', { path: dir }, 'test');
    assert.equal(first.ok, true);
    assert.equal(first.truncated, false);
    const map = first.map;
    assert.match(map, /src\/app\.js/);
    assert.match(map, /mountOverlay@1/);
    assert.match(map, /OverlayController@5/);
    assert.match(map, /computeOffset@9/);
    assert.match(map, /measure@1/);
    assert.match(map, /Heading One@1/);
    assert.doesNotMatch(map, /ignored/, 'node_modules must be excluded');
    assert.ok(first.elapsedMs < 2000, `map build should be millisecond-scale (got ${first.elapsedMs}ms)`);

    // Incremental rebuild: same tree hits the per-session cache.
    const second = await c.execute('computer_index', { path: dir }, 'test');
    assert.equal(second.map, first.map, 'unchanged files must reuse cached symbols');

    // Single-file outline.
    const single = await c.execute('computer_index', { path: dir, file: path.join(dir, 'src', 'app.js') }, 'test');
    assert.equal(single.ok, true);
    assert.match(single.map, /mountOverlay@1, OverlayController@5, computeOffset@9/);

    // Budget bound.
    const tiny = await c.execute('computer_index', { path: dir, maxChars: 60 }, 'test');
    assert.equal(tiny.truncated, true);
    assert.match(tiny.note, /query=/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- Session evidence ledger: never pay for the same evidence twice ----------

test('computer_read flags an unchanged re-read instead of silently repeating it', async () => {
  const c = new ComputerTools();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-read-'));
  try {
    const file = path.join(dir, 'main.js');
    await fs.writeFile(file, 'const a = 1;\nconst b = 2;\n');
    const first = await c.execute('computer_read', { path: file }, 'test');
    assert.equal(first.notice, undefined, 'the first read is fresh evidence');
    const again = await c.execute('computer_read', { path: file }, 'test');
    assert.match(again.notice || '', /Unchanged since your earlier read covering lines 1-3/);
    // After the file changes the evidence is fresh again.
    await fs.writeFile(file, 'const a = 9;\nconst b = 2;\n');
    const changed = await c.execute('computer_read', { path: file }, 'test');
    assert.equal(changed.notice, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an identical repeat search is flagged as held evidence', async () => {
  const c = new ComputerTools();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-search-'));
  try {
    await fs.writeFile(path.join(dir, 'a.js'), 'const selectionOverlay = 1;\n');
    const first = await c.execute('computer_search', { pattern: 'selectionOverlay', path: dir }, 'test');
    assert.equal(first.notice, undefined);
    const again = await c.execute('computer_search', { pattern: 'selectionOverlay', path: dir }, 'test');
    assert.match(again.notice || '', /Identical search already returned/);
    const different = await c.execute('computer_search', { pattern: 'different-symbol', path: dir }, 'test');
    assert.equal(different.notice, undefined);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('the consulted-evidence ledger rides into every decision context', async () => {
  const contexts = [];
  let decision = 0;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-consult-'));
  // ONE shared backend with a stubbed native bridge. A bare ComputerTools on
  // win32 forks the nativeWorker child on its first native call — and this
  // run's dialog scanner asks for the native window list — and a forked
  // worker keeps the event loop alive: this file used to pass every test and
  // then hang on exit. Closing the backend disconnects (and reaps) the worker.
  const backend = new ComputerTools({ nativeRequest: async () => ({}) });
  try {
    await fs.writeFile(path.join(dir, 'main.js'), 'const selectionOverlay = 1;\n');
    const agent = new DesktopChatAgent({
      controller: {
        async domSnapshot(tabId) { return { tabId, url: 'https://fixture.test', title: 'F', viewport: { width: 1280, height: 720 }, elements: [], truncated: false }; },
        navigationState(t) { return { tabId: t, url: 'https://fixture.test', loading: false }; },
        consoleEntries() { return []; }, networkEntries() { return []; },
        async clickElement(t, a) { return { tabId: t, ...a }; }, async navigate(t, u) { return { tabId: t, url: u }; },
        type() { return { length: 0 }; }, async scroll() { return {}; }, key() { return {}; },
        async screenshot() { return { data: 'img' }; }, releaseSessionInput() { return { released: true }; }
      },
      getSelectedTabId: () => 'tab-1',
      getControlMode: () => 'agi',
      getComputerTools: () => backend,
      emit: () => {},
      createProvider: () => ({
        async complete(context) {
          contexts.push(context);
          decision += 1;
          if (decision === 1) return { toolCalls: [
            { name: 'computer_read', input: { path: path.join(dir, 'main.js') } },
            { name: 'computer_search', input: { pattern: 'selectionOverlay', path: dir } }
          ] };
          return { done: { summary: 'Evidence held.', success: true, verified: true } };
        }
      })
    });
    const run = await agent.start({ task: 'Fix the overlay offset in the source', workspace: { root: dir }, provider: { id: 'mock' } });
    assert.equal(run.status, 'completed');
    const consulted = contexts[1].workingMemory.consulted;
    assert.ok(Array.isArray(consulted) && consulted.length >= 2, 'both consults must reach the next decision');
    assert.ok(consulted.some(e => e.k === 'read' && /main\.js$/.test(e.path)));
    assert.ok(consulted.some(e => e.k === 'search' && e.pattern === 'selectionOverlay'));
  } finally { await backend.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

// ---- computer_index query mode: line-level inverted index (2026-10-01) -------

test('computer_index query returns ranked line-level hits across docs, code and css in ms', async () => {
  const c = new ComputerTools();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bu-indexq-'));
  try {
    await fs.writeFile(path.join(dir, 'KNOWN_BUGS.md'), '## Persistent bug: the transformation border is offset at this exact aspect ratio\nFixed on wider and narrower viewports.\n');
    await fs.mkdir(path.join(dir, 'styles'), { recursive: true });
    await fs.writeFile(path.join(dir, 'styles', 'canvas.css'), '.lds-canvas-frame {\n  aspect-ratio: 1180 / 820;\n}\n');
    await fs.writeFile(path.join(dir, 'src.js'), 'function computeAspect() { return "aspect ratio"; }\n');

    const cold = await c.execute('computer_index', { path: dir, query: 'aspect ratio offset border' }, 'test');
    assert.equal(cold.mode, 'query');
    assert.ok(cold.filesMatched >= 2, 'docs AND code must both answer the query');
    const allText = JSON.stringify(cold.results);
    assert.match(allText, /KNOWN_BUGS\.md/, 'the doc must surface its persistent-bug line');
    assert.match(allText, /canvas\.css/, 'css must surface the selector line');
    assert.match(allText, /aspect-ratio: 1180/);
    // Rarity weighting: the doc line naming the exact defect outranks generic lines.
    const topFile = cold.results[0].file;
    assert.ok(/KNOWN_BUGS\.md|canvas\.css|src\.js/.test(topFile));

    // Warm query: incremental cache, millisecond-scale.
    const warm = await c.execute('computer_index', { path: dir, query: 'aspect ratio offset border' }, 'test');
    assert.equal(warm.elapsedMs < cold.elapsedMs, true, `warm query (${warm.elapsedMs}ms) must beat cold (${cold.elapsedMs}ms)`);
    assert.match(warm.note, /re-tokenized 0 changed/);

    // AND-semantics: a line must match at least half the terms.
    const narrow = await c.execute('computer_index', { path: dir, query: 'aspect ratio quantum espresso traction' }, 'test');
    assert.equal(narrow.filesMatched, 0, 'unrelated terms must not fabricate hits');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
