import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TerminalManager, MAX_SESSIONS } = require('../desktop/terminal/terminalSession.cjs');

// Collects output until a predicate matches, so a test asserts on what the
// shell actually produced rather than on a fixed sleep that would be flaky on
// a loaded machine.
function waitForOutput(chunks, predicate, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const combined = chunks.join('');
      if (predicate(combined)) {
        clearInterval(poll);
        resolve(combined);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        clearInterval(poll);
        reject(new Error(`Timed out waiting for shell output. Received: ${JSON.stringify(combined.slice(-400))}`));
      }
    }, 100);
    if (typeof poll.unref === 'function') poll.unref();
  });
}

test('a terminal session runs a real command and streams its output', async () => {
  const chunks = [];
  const manager = new TerminalManager({ onData: (_id, data) => chunks.push(data) });
  try {
    const created = manager.create({ cols: 100, rows: 30 });
    assert.ok(created.id, 'a session must report an id');
    assert.ok(['pty', 'piped'].includes(created.backend), 'the backend must be declared, not implied');

    manager.write(created.id, 'Write-Output BROWSERUSE_TERMINAL_OK\r');
    const output = await waitForOutput(chunks, (text) => text.includes('BROWSERUSE_TERMINAL_OK'));
    assert.match(output, /BROWSERUSE_TERMINAL_OK/);
  } finally {
    manager.disposeAll();
  }
});

test('the session reports which backend it obtained', async () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const info = manager.backendInfo();
    assert.equal(typeof info.ptyAvailable, 'boolean');
    // A reduced terminal must be visible in the UI rather than inferred from
    // behaviour that quietly stops working.
    assert.equal(info.backend, info.ptyAvailable ? 'pty' : 'piped');
    if (!info.ptyAvailable) assert.ok(info.error, 'a missing PTY must explain itself');
  } finally {
    manager.disposeAll();
  }
});

test('resize is accepted and reflected in the reported geometry', async () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const created = manager.create({ cols: 80, rows: 24 });
    manager.resize(created.id, 120, 40);
    const status = manager.get(created.id).status();
    assert.equal(status.cols, 120);
    assert.equal(status.rows, 40);
  } finally {
    manager.disposeAll();
  }
});

test('geometry is clamped to a usable range', async () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const created = manager.create({ cols: 5000, rows: -20 });
    const status = manager.get(created.id).status();
    assert.ok(status.cols <= 400 && status.cols >= 20, `columns clamped, got ${status.cols}`);
    assert.ok(status.rows >= 5 && status.rows <= 200, `rows clamped, got ${status.rows}`);
  } finally {
    manager.disposeAll();
  }
});

test('snapshot and setDimensions preserve the active session identity', async () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const created = manager.create({ cols: 80, rows: 24 });
    const resized = manager.setDimensions(created.id, 132, 41);
    assert.equal(resized.id, created.id);
    assert.equal(resized.cols, 132);
    assert.equal(resized.rows, 41);
    assert.equal(manager.snapshot(created.id).id, created.id);
  } finally {
    manager.disposeAll();
  }
});

test('disposing a session stops it and removes it from the registry', async () => {
  const exits = [];
  const manager = new TerminalManager({ onData: () => {}, onExit: (id, code) => exits.push({ id, code }) });
  const created = manager.create({});
  assert.equal(manager.list().length, 1);
  // Presentation changes must retain this identity; only explicit disposal ends
  // the process and emits the matching terminal lifecycle event.
  assert.equal(manager.snapshot(created.id)?.id, created.id);
  assert.equal(manager.dispose(created.id), true);
  assert.equal(manager.list().length, 0);
  assert.deepEqual(exits, [{ id: created.id, code: null }]);
  // A shell that outlives its window becomes an orphan process.
  assert.equal(manager.get(created.id), null);
  assert.equal(manager.dispose(created.id), false, 'disposing twice must not throw');
});

test('the session count is bounded', () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    for (let index = 0; index < MAX_SESSIONS; index += 1) manager.create({});
    assert.throws(() => manager.create({}), /At most/);
  } finally {
    manager.disposeAll();
  }
});

test('writing to an unknown session fails without throwing', () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    assert.equal(manager.write('term-does-not-exist', 'echo hi\r'), false);
    assert.equal(manager.resize('term-does-not-exist', 80, 24), false);
  } finally {
    manager.disposeAll();
  }
});

// Enter submits: a programmatic bare LF must behave like the Enter key, not
// like PSReadLine's "insert newline". This is the regression behind an agent
// typing "claude\n" and staring at a ">>" continuation prompt forever.
test('a command submitted with a bare LF executes like Enter', async () => {
  const chunks = [];
  const manager = new TerminalManager({ onData: (_id, data) => chunks.push(data) });
  try {
    const created = manager.create({ cols: 100, rows: 30 });
    const command = process.platform === 'win32' ? 'Write-Output LF_SUBMIT_OK' : 'printf LF_SUBMIT_OK';
    manager.write(created.id, `${command}\n`);
    const output = await waitForOutput(chunks, (text) => text.includes('LF_SUBMIT_OK'));
    assert.match(output, /LF_SUBMIT_OK/);
    assert.doesNotMatch(output.slice(-200), />>/, 'no continuation prompt should remain');
  } finally {
    manager.disposeAll();
  }
});

// The agent's execute mirror: a view-only transcript with no shell process.
// Writes append to the view, nothing spawns, and the session never exits on
// its own — disposal by the owner is the only way it ends.
test('a virtual session echoes writes without spawning a shell', () => {
  const chunks = [];
  const exits = [];
  const manager = new TerminalManager({
    onData: (_id, data) => chunks.push(data),
    onExit: (id, code) => exits.push({ id, code })
  });
  try {
    const created = manager.create({ virtual: true, cwd: 'E:/fixture' });
    assert.equal(created.virtual, true, 'the virtual flag must be visible to the UI');
    assert.equal(created.backend, 'virtual');
    assert.equal(created.shell, 'agent-execute');
    assert.equal(created.disposed, false);

    const header = '\r\n\x1b[36m▶ npm run build\x1b[0m\r\n';
    assert.equal(manager.write(created.id, header), true, 'writes into a virtual session are accepted');
    assert.ok(chunks.join('').includes('npm run build'), 'written data is emitted to the view');

    // A virtual session never exits by itself and has no process to kill.
    assert.equal(manager.get(created.id).process, null);
    assert.equal(exits.length, 0);

    assert.equal(manager.dispose(created.id), true);
    assert.deepEqual(exits, [{ id: created.id, code: null }], 'disposal emits the normal lifecycle event');
    assert.equal(manager.write(created.id, 'after dispose'), false, 'writes after disposal are rejected');
  } finally {
    manager.disposeAll();
  }
});

// Stale-config fix, final model: the host (broker) snapshot loses every
// credential-shaped variable, while the explicitly pushed environment — which
// the client rebuilds from the CURRENT registry — wins on top. So a
// system-wide key keeps working with its CURRENT value, a stale inherited copy
// never shadows on-disk config, and "not logged in" never appears when the
// user's key legitimately lives in the registry.
test('host credentials are dropped and registry-fresh pushed credentials win', () => {
  const previous = {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ZHIPUAI_API_KEY: process.env.ZHIPUAI_API_KEY,
    SOME_SERVICE_BASE_URL: process.env.SOME_SERVICE_BASE_URL
  };
  process.env.ANTHROPIC_API_KEY = 'stale-anthropic-key';
  process.env.ZHIPUAI_API_KEY = 'stale-zhipu-key';
  process.env.SOME_SERVICE_BASE_URL = 'https://stale.example';
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const stale = manager.create({ virtual: true, cols: 80, rows: 24 });
    assert.equal(manager.get(stale.id).env.ANTHROPIC_API_KEY, undefined, 'stale inherited key must be dropped');
    assert.equal(manager.get(stale.id).env.ZHIPUAI_API_KEY, undefined);
    assert.equal(manager.get(stale.id).env.SOME_SERVICE_BASE_URL, undefined, 'stale base URLs shadow current config too');
    // The push carries registry-fresh credentials — they must win, or a
    // system-wide key would vanish from terminals ("not logged in").
    const pushed = manager.create({ virtual: true, cols: 80, rows: 24, env: { ANTHROPIC_API_KEY: 'registry-fresh-key', BROWSER_USE_ENV_PROBE: 'kept' } });
    assert.equal(manager.get(pushed.id).env.ANTHROPIC_API_KEY, 'registry-fresh-key', 'registry-fresh pushed credentials must win');
    assert.equal(manager.get(pushed.id).env.BROWSER_USE_ENV_PROBE, 'kept');
    assert.equal(manager.get(pushed.id).env.TERM, 'xterm-256color');
    assert.ok(manager.get(stale.id).staleEnvKeys.includes('ANTHROPIC_API_KEY'), 'dropped keys are surfaced for the notice');
  } finally {
    manager.disposeAll();
    if (previous.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous.ANTHROPIC_API_KEY;
    if (previous.ZHIPUAI_API_KEY === undefined) delete process.env.ZHIPUAI_API_KEY; else process.env.ZHIPUAI_API_KEY = previous.ZHIPUAI_API_KEY;
    if (previous.SOME_SERVICE_BASE_URL === undefined) delete process.env.SOME_SERVICE_BASE_URL; else process.env.SOME_SERVICE_BASE_URL = previous.SOME_SERVICE_BASE_URL;
  }
});

// The push merge is what makes a system-wide API key survive: registry values
// are CURRENT by definition, inherited-shell credentials are untrustworthy.
test('buildPushEnvironment prefers registry values and drops shell-only credentials', () => {
  const { buildPushEnvironment } = require('../desktop/terminal/terminalBrokerClient.cjs');
  const inherited = {
    ANTHROPIC_API_KEY: 'stale-from-dev-shell',
    OPENAI_API_KEY: 'shell-only-openai-key',
    PATH: 'C:/old-shell-path',
    FEATURE_FLAG: 'on'
  };
  const registry = {
    ANTHROPIC_API_KEY: 'fresh-registry-key',
    PATH: 'C:/current-registry-path',
    BRAND_NEW_VAR: 'from-registry'
  };
  const pushed = buildPushEnvironment(inherited, registry);
  assert.equal(pushed.ANTHROPIC_API_KEY, 'fresh-registry-key', 'a registry-backed credential pushes its CURRENT value');
  assert.equal(pushed.OPENAI_API_KEY, undefined, 'a credential known only to the inherited shell is dropped');
  assert.equal(pushed.PATH, 'C:/current-registry-path', 'registry wins for keys it defines');
  assert.equal(pushed.FEATURE_FLAG, 'on', 'non-credential inherited variables pass through');
  assert.equal(pushed.BRAND_NEW_VAR, 'from-registry', 'new registry-only variables are included');
  assert.equal(pushed.ELECTRON_RUN_AS_NODE, undefined);
  // No registry access (failure/non-Windows): credentials are dropped rather
  // than trusted from an inherited shell; plain variables survive.
  const fallback = buildPushEnvironment(inherited, {});
  assert.equal(fallback.ANTHROPIC_API_KEY, undefined);
  assert.equal(fallback.OPENAI_API_KEY, undefined);
  assert.equal(fallback.PATH, 'C:/old-shell-path');
});

test('Claude profile resolves exactly one Anthropic credential source without exposing values', () => {
  const { resolveSessionEnvironment } = require('../desktop/terminal/terminalSession.cjs');
  const both = { ANTHROPIC_API_KEY: 'api-secret', ANTHROPIC_AUTH_TOKEN: 'token-secret', SAFE: 'kept' };
  const automatic = resolveSessionEnvironment(both, { profile: 'claude-code', credentialMode: 'auto' });
  assert.equal(automatic.credentialSource, 'api-key');
  assert.equal(automatic.env.ANTHROPIC_API_KEY, 'api-secret');
  assert.equal(automatic.env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(automatic.env.SAFE, 'kept');
  const token = resolveSessionEnvironment(both, { profile: 'claude-code', credentialMode: 'auth-token' });
  assert.equal(token.credentialSource, 'auth-token');
  assert.equal(token.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(token.env.ANTHROPIC_AUTH_TOKEN, 'token-secret');
  const shell = resolveSessionEnvironment(both, { profile: 'shell' });
  assert.equal(shell.env.ANTHROPIC_API_KEY, 'api-secret');
  assert.equal(shell.env.ANTHROPIC_AUTH_TOKEN, 'token-secret');
  assert.doesNotMatch(JSON.stringify({ source: automatic.credentialSource }), /api-secret|token-secret/);
});

test('submit appends one Enter and increments input/output revisions', async () => {
  const chunks = [];
  const manager = new TerminalManager({ onData: (_id, data) => chunks.push(data) });
  try {
    const created = manager.create({ cols: 100, rows: 30 });
    const command = process.platform === 'win32' ? 'Write-Output SUBMIT_ACK_OK' : 'printf SUBMIT_ACK_OK';
    const before = manager.snapshot(created.id);
    const submitted = manager.submit(created.id, `${command}\n\n`);
    assert.equal(submitted.accepted, true);
    assert.equal(submitted.status.inputRevision, before.inputRevision + 1);
    await waitForOutput(chunks, (text) => text.includes('SUBMIT_ACK_OK'));
    const after = manager.snapshot(created.id);
    assert.ok(after.outputRevision > before.outputRevision);
    assert.ok(['running', 'ready', 'quiet'].includes(after.phase));
  } finally { manager.disposeAll(); }
});

test('a natural process exit remains as an inspectable tombstone until disposal', async () => {
  const manager = new TerminalManager({ onData: () => {} });
  try {
    const created = manager.create({ cols: 80, rows: 24 });
    manager.submit(created.id, 'exit');
    const deadline = Date.now() + 10_000;
    while (!['exited', 'error'].includes(manager.snapshot(created.id)?.phase) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    const tombstone = manager.snapshot(created.id);
    assert.ok(tombstone, 'natural exit must remain visible');
    assert.equal(tombstone.alive, false);
    assert.ok(['exited', 'error'].includes(tombstone.phase));
    assert.equal(manager.dispose(created.id), true);
    assert.equal(manager.snapshot(created.id), null);
  } finally { manager.disposeAll(); }
});
