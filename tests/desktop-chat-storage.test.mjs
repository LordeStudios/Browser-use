import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CredentialStore } = require('../desktop/store/credentialStore.cjs');
const { ChatHistoryStore } = require('../desktop/store/chatHistoryStore.cjs');

function directory() { return fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-store-')); }

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace(/^encrypted:/, '')
  };
}

test('credential store persists only encrypted Cloud secret data', () => {
  const dir = directory();
  try {
    const filePath = path.join(dir, 'secrets.json');
    const store = new CredentialStore({ safeStorage: fakeSafeStorage(), filePath });
    const status = store.set('browserUseCloudApiKey', 'bu_secret_value_1234');
    assert.equal(status.configured, true);
    assert.match(status.display, /1234$/);
    assert.equal(store.get('browserUseCloudApiKey'), 'bu_secret_value_1234');
    assert.equal(fs.readFileSync(filePath, 'utf8').includes('bu_secret_value_1234'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('credential store rejects plaintext fallback when encryption is unavailable', () => {
  const dir = directory();
  try {
    const store = new CredentialStore({ safeStorage: { isEncryptionAvailable: () => false }, filePath: path.join(dir, 'secrets.json') });
    assert.throws(() => store.set('browserUseCloudApiKey', 'bu_secret'), /unavailable/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('history store keeps title, messages, optional plan, working memory, completed work, and transcript independent', () => {
  const dir = directory();
  try {
    const store = new ChatHistoryStore({ filePath: path.join(dir, 'history.json') });
    store.append({
      id: 'run-1',
      title: 'Renamed conversation',
      provider: 'ollama',
      providerConfig: { id: 'ollama', model: 'model-a' },
      status: 'completed',
      summary: 'Token bu_secret_12345',
      success: false,
      verified: false,
      reason: 'provider_external_block',
      messages: [
        { role: 'user', content: 'Original prompt', at: 1 },
        { role: 'assistant', content: 'Original reply', at: 2 }
      ],
      plan: [{ text: 'Keep working', status: 'current', verification: 'Visible result' }],
      workingMemory: { previousReasoning: 'Continue after using sk_secret without restarting.', strategyEpoch: 2 },
      completedWork: [{ action: 'browser_click', target: 'Control bu_secret_12345', expectedOutcome: 'Panel visible', effectObserved: true, observedRevision: 4 }],
      transcript: [{ at: 3, step: 1, tool: 'browser_type', input: { text: 'sk_secret' }, output: { ok: true } }]
    });
    const saved = store.get('run-1');
    assert.match(saved.summary, /\[redacted\]/);
    assert.equal(saved.title, 'Renamed conversation');
    assert.equal(saved.success, false);
    assert.equal(saved.verified, false);
    assert.equal(saved.reason, 'provider_external_block');
    assert.deepEqual(saved.messages.map(({ role, content }) => [role, content]), [
      ['user', 'Original prompt'],
      ['assistant', 'Original reply']
    ]);
    assert.equal(saved.plan[0].status, 'current');
    assert.match(saved.workingMemory.previousReasoning, /\[redacted\]/);
    assert.equal(saved.workingMemory.strategyEpoch, 2);
    assert.match(saved.completedWork[0].target, /\[redacted\]/);
    assert.equal(saved.completedWork[0].effectObserved, true);
    assert.equal(saved.transcript[0].tool, 'browser_type');
    assert.match(JSON.stringify(saved.transcript[0].input), /\[redacted\]/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('legacy completed history stays readable while explicit failed outcomes remain failed', () => {
  const dir = directory();
  try {
    const store = new ChatHistoryStore({ filePath: path.join(dir, 'history.json') });
    store.append({ id: 'legacy', status: 'completed', summary: 'Old success' });
    store.append({ id: 'blocked', status: 'failed', summary: 'Blocked', success: false, verified: false, reason: 'provider_external_block' });
    assert.equal(store.get('legacy').success, true);
    assert.equal(store.get('legacy').verified, false);
    assert.equal(store.get('blocked').status, 'failed');
    assert.equal(store.get('blocked').success, false);
    assert.equal(store.get('blocked').reason, 'provider_external_block');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('truncation envelopes stop multiplying across repeated saves', () => {
  const { redactStructured } = require('../desktop/store/chatHistoryStore.cjs');
  // A tool result that already carried a truncation envelope (notice + preview)
  // historically re-serialized into ever-deeper escaped layers on every save.
  const envelope = { notice: 'Saved diagnostic was truncated.', preview: JSON.stringify({ lots: 'of escaped json content...'.repeat(20) }) };
  const padded = { ...envelope, filler: 'x'.repeat(300000) };
  const once = redactStructured(padded);
  const onceSize = JSON.stringify(once).length;
  // Re-saving the already-truncated value must not grow it further: each pass
  // either passes the envelope through or re-slices to the same bound.
  let previous = once;
  let previousSize = onceSize;
  for (let pass = 0; pass < 5; pass++) {
    const next = redactStructured(previous);
    const nextSize = JSON.stringify(next).length;
    assert.ok(nextSize <= previousSize + 64, 're-saving must not multiply the envelope');
    previous = next; previousSize = nextSize;
  }
  assert.equal(previous.notice, 'Saved diagnostic was truncated.');
});

test('small envelopes survive round-trips intact', () => {
  const { redactStructured } = require('../desktop/store/chatHistoryStore.cjs');
  const envelope = { notice: 'Saved diagnostic was truncated.', preview: 'tiny' };
  assert.deepEqual(redactStructured(envelope), envelope);
});
