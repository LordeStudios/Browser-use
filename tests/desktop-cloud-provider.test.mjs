import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRemoteTask, createCloudProvider, redactKey, DEFAULT_TIMEOUT_MS } from '../desktop/agent/cloudProvider.cjs';

test('redactKey hides most of a Browser Use Cloud API key', () => {
  assert.equal(redactKey('bu_abcdefghijklmnopqrstuvwxyz1234'), 'bu_abc...1234');
  assert.equal(redactKey('short'), '*****');
  assert.equal(redactKey(''), '');
  assert.equal(redactKey(null), '');
});

test('createCloudProvider requires an API key', () => {
  assert.throws(() => createCloudProvider({}), /requires an API key/);
  assert.throws(() => createCloudProvider({ apiKey: '' }), /requires an API key/);
  assert.doesNotThrow(() => createCloudProvider({ apiKey: 'bu_test', model: 'account-model' }));
});

test('cloud provider requires an explicitly configured model', () => {
  assert.throws(() => createCloudProvider({ apiKey: 'bu_test' }), /Choose a Browser Use Cloud model/);
  const provider = createCloudProvider({ apiKey: 'bu_test', model: 'account-model' });
  assert.equal(provider.model, 'account-model');
  assert.equal(provider.executionTarget, 'remote');
});

test('remote provider receives prior user and assistant turns on a follow-up', () => {
  const task = buildRemoteTask('Continue from there', [
    { role: 'user', content: 'Open the current project' },
    { role: 'assistant', content: 'The project is open.' },
    { role: 'user', content: 'Continue from there' }
  ]);

  assert.match(task, /User: Open the current project/);
  assert.match(task, /Assistant: The project is open\./);
  assert.match(task, /Current request:\nContinue from there/);
});


function fakeClient(statuses, result = { status: 'completed', result: 'Remote result' }) {
  const calls = { create: 0, status: 0, get: 0, cancel: 0 };
  return {
    calls,
    runs: {
      async create() { calls.create += 1; return { id: 'run-1', status: statuses.shift() || 'running' }; },
      async status() { calls.status += 1; return { status: statuses.shift() || result.status }; },
      async get() { calls.get += 1; return result; },
      async cancel() { calls.cancel += 1; return { status: 'cancelled' }; }
    }
  };
}

test('cloud provider uses the SDK-aligned long-running default and reports polling progress', async () => {
  const client = fakeClient(['running', 'completed']);
  let progress = 0;
  const provider = createCloudProvider({ apiKey: 'bu_test', model: 'account-model', client, delay: async () => {} });
  const response = await provider.complete({ task: 'Long task', onProgress: () => { progress += 1; } });
  assert.equal(provider.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.ok(provider.absoluteTimeoutMs > provider.timeoutMs);
  assert.equal(client.calls.cancel, 0);
  assert.equal(client.calls.get, 1);
  assert.ok(progress >= 2);
  assert.match(response.toolCalls[0].input.summary, /Remote result/);
});

test('cloud provider cancels only after its configured deadline', async () => {
  const client = fakeClient(['running', 'running', 'running']);
  const times = [0, 5, 10];
  const provider = createCloudProvider({ apiKey: 'bu_test', model: 'account-model', client, timeoutMs: 10, pollIntervalMs: 1, now: () => times.shift() ?? 10, delay: async () => {} });
  await assert.rejects(provider.complete({ task: 'Long task' }), /timed out/);
  assert.equal(client.calls.cancel, 1);
  assert.equal(client.calls.get, 0);
});

test('cloud provider cancellation stops the remote run', async () => {
  const client = fakeClient(['running']);
  const controller = new AbortController();
  controller.abort(new Error('stop'));
  const provider = createCloudProvider({ apiKey: 'bu_test', model: 'account-model', client, delay: async () => {} });
  await assert.rejects(provider.complete({ task: 'Long task', signal: controller.signal }), /cancelled/);
  assert.equal(client.calls.cancel, 1);
});
