// Workspace default-scope contract (owner directive 2026-10-11): the declared
// workspace is the DEFAULT scope (search/index roots, terminal cwd
// auto-injection), never the ONLY allowed scope. Out-of-root file/terminal/git
// paths execute normally; the former workspaceViolation root-rejection is gone.
// The WorkspaceChangeGuard's file-ownership integrity semantics are a separate
// mechanism (tests/workspace-change-guard.test.mjs) and are unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obsA = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Name field' }] } };

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}) {
  let calls = 0;
  const controller = { navigationState: () => obsA.navigation, domSnapshot: () => obsA.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} , ...controllerExtras };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}

test('default-scope workspace: out-of-root file read/write, git repo, and terminal cwd all EXECUTE', async () => {
  const executed = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/other-tree/src/app.js' } }] };
    if (turn === 2) return { actions: [{ name: 'computer_write', input: { path: 'C:/other-tree/notes.txt', content: 'hello' } }] };
    if (turn === 3) return { actions: [{ name: 'computer_git', input: { action: 'status', repo: 'F:/elsewhere/repo' } }] };
    if (turn === 4) return { actions: [{ name: 'computer_terminal', input: { action: 'execute', command: 'node -v', cwd: 'F:/elsewhere/repo' } }] };
    return final;
  }, async (name, input) => { executed.push({ name, input }); return { content: 'ok' }; });
  const run = await h.start({}, { workspace: { root: 'C:/current-checkout' } });
  assert.equal(run.result.success, true);
  // The run's startup native scan (computer_window list) also reaches the
  // backend; only the four model calls are under test here.
  assert.deepEqual(executed.filter((entry) => entry.name !== 'computer_window').map((entry) => entry.name),
    ['computer_file', 'computer_write', 'computer_git', 'computer_terminal'],
    'every out-of-root call reached the executor; nothing was refused');
  assert.ok(!run.history.some((entry) => entry.output?.recoverySource === 'workspace_scope'), 'no workspace_scope rejection exists anywhere in the run');
  assert.ok(!run.history.some((entry) => /verified workspace root/.test(String(entry.output?.error || ''))), 'no root-boundary error text anywhere');
});

test('default scope still applies: terminal cwd and computer_index path default to the run workspace', async () => {
  const executed = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [
      { name: 'computer_terminal', input: { action: 'execute', command: 'node -v' } },
      { name: 'computer_index', input: { query: 'symbol' } }
    ] };
    return final;
  }, async (name, input) => { executed.push({ name, input }); return { content: 'ok' }; });
  const run = await h.start({}, { workspace: { root: 'C:/current-checkout' } });
  assert.equal(run.result.success, true);
  const terminal = executed.find((entry) => entry.name === 'computer_terminal');
  const index = executed.find((entry) => entry.name === 'computer_index');
  assert.equal(terminal.input.cwd, path.resolve('C:/current-checkout'), 'terminal cwd auto-injection still uses the default root');
  assert.equal(index.input.path, path.resolve('C:/current-checkout'), 'computer_index still defaults to the default root');
  assert.equal(index.input.goal, 'Inspect fixture', 'goal-aware ranking still applies');
});

test('workspace_retarget re-points the default root; nothing is gated on it', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-scope-retarget-'));
  try {
    const executed = [];
    let turn = 0;
    const h = harness((context) => {
      turn += 1;
      if (turn === 1) return { actions: [{ name: 'workspace_retarget', input: { path: tmp } }] };
      if (turn === 2) return { actions: [{ name: 'computer_terminal', input: { action: 'execute', command: 'node -v' } }] };
      return final;
    }, async (name, input) => { executed.push({ name, input }); return { content: 'ok' }; });
    const run = await h.start({}, { workspace: { root: 'C:/current-checkout' } });
    assert.equal(run.result.success, true);
    const retarget = run.history.find((entry) => entry.tool === 'workspace_retarget');
    assert.ok(retarget, 'the retarget executed');
    assert.equal(retarget.output.ok, true);
    assert.equal(run.workspace.root, path.resolve(tmp), 'the default root was re-pointed');
    const terminal = executed.find((entry) => entry.name === 'computer_terminal');
    assert.equal(terminal.input.cwd, path.resolve(tmp), 'terminal cwd auto-injection follows the re-pointed default');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('source regression guard: the root-rejection machinery stays removed', () => {
  const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'desktop', 'agent', 'desktopChatAgent.cjs'), 'utf8');
  assert.ok(!/function\s+workspaceViolation|workspaceViolation\(/.test(source), 'workspaceViolation must not return');
  assert.ok(!source.includes('scopeViolation'), 'scopeViolation must not return');
  assert.ok(!source.includes('verified workspace root'), 'root-boundary error text must not return');
  assert.ok(!source.includes('outside this run'), 'root-boundary error text must not return');
});
