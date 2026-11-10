import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { TerminalBrokerClient } = require('../desktop/terminal/terminalBrokerClient.cjs');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brokerPath = path.join(root, 'desktop', 'terminal', 'terminalBroker.cjs');

function pipeName() {
  const id = crypto.randomBytes(12).toString('hex');
  return process.platform === 'win32' ? `\\\\.\\pipe\\browser-use-terminal-test-${id}` : path.join('/tmp', `browser-use-terminal-test-${id}.sock`);
}

function waitFor(predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (predicate()) { clearInterval(timer); resolve(); }
      else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error('Timed out waiting for terminal output.')); }
    }, 25);
  });
}

test('a broker-owned shell survives client disconnect and restores its bounded scrollback', async () => {
  const pipePath = pipeName();
  const secret = crypto.randomBytes(24).toString('base64url');
  const output = [];
  const options = {
    pipePath,
    secret,
    brokerPath,
    executablePath: process.execPath,
    onData: (_id, data) => output.push(data),
    onExit: () => {}
  };
  const first = new TerminalBrokerClient(options);
  let second;
  try {
    await first.connect();
    const created = await first.create({ cols: 100, rows: 30 });
    assert.ok(created?.id);
    await first.writeInput(created.id, 'Write-Output BROKER_RECONNECT_MARKER\r');
    await waitFor(() => output.join('').includes('BROKER_RECONNECT_MARKER'));
    first.disconnect();

    second = new TerminalBrokerClient({ ...options, onData: () => {} });
    await second.connect();
    const recovered = second.snapshot(created.id);
    assert.equal(recovered?.id, created.id, 'the same shell must be available after the client process disconnects');
    assert.match(recovered?.history || '', /BROKER_RECONNECT_MARKER/, 'scrollback generated before app close must be restored');
    await second.dispose(created.id);
    await second.shutdown();
  } finally {
    first.disconnect();
    second?.disconnect();
  }
});

// Fresh-environment contract: every connecting Desktop pushes its current
// environment, and NEW sessions (reset or brand new) merge it over the
// broker's own snapshot — so a fixed API key reaches terminals without
// waiting for the broker process to die.
test('a pushed environment reaches new sessions created after it', async () => {
  const pipePath = pipeName();
  const secret = crypto.randomBytes(24).toString('base64url');
  const output = [];
  const client = new TerminalBrokerClient({
    pipePath,
    secret,
    brokerPath,
    executablePath: process.execPath,
    onData: (_id, data) => output.push(data),
    onExit: () => {}
  });
  try {
    await client.connect();
    assert.equal(await client.request('setEnv', { env: { BROWSER_USE_ENV_PROBE: 'fresh-value-42' } }), true);
    const created = await client.create({ cols: 100, rows: 30 });
    assert.ok(created?.id);
    await client.writeInput(created.id, 'Write-Output PROBE=$env:BROWSER_USE_ENV_PROBE\r');
    await waitFor(() => output.join('').includes('PROBE=fresh-value-42'));
    await client.dispose(created.id);
    await client.shutdown();
  } finally {
    client.disconnect();
  }
});

test('send returns acknowledgement revisions and reconnect keeps authoritative state', async () => {
  const pipePath = pipeName();
  const secret = crypto.randomBytes(24).toString('base64url');
  const first = new TerminalBrokerClient({ pipePath, secret, brokerPath, executablePath: process.execPath, onData: () => {}, onExit: () => {} });
  let second;
  try {
    await first.connect();
    const created = await first.create({ cols: 100, rows: 30 });
    const command = process.platform === 'win32' ? 'Write-Output BROKER_SEND_OK' : 'printf BROKER_SEND_OK';
    const acknowledged = await first.sendInput(created.id, command, { expected: 'BROKER_SEND_OK', timeoutMs: 10_000 });
    assert.equal(acknowledged.accepted, true);
    assert.equal(acknowledged.submitted, true);
    assert.ok(acknowledged.inputRevision >= 1);
    assert.equal(acknowledged.matched, true, 'an expected literal must be observed before send reports success');
    first.disconnect();
    second = new TerminalBrokerClient({ pipePath, secret, brokerPath, executablePath: process.execPath, onData: () => {}, onExit: () => {} });
    await second.connect();
    const restored = await second.refresh(created.id);
    assert.ok(restored.outputRevision >= acknowledged.outputRevision);
    assert.match(restored.history || '', /BROKER_SEND_OK/);
    await second.dispose(created.id);
    await second.shutdown();
  } finally { first.disconnect(); second?.disconnect(); }
});
