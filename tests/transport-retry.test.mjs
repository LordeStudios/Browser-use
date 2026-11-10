// Deterministic harness tests for run-level transport retries: a network
// failure must replay the SAME decision with increasing backoff and must not
// consume the model recovery budget or be misreported as narration.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { isTransportError, RETRY_DELAYS_MS, isHardProviderError, retryDelayMs } = require('../desktop/agent/providers/retry.cjs');

function createController() {
  return {
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    async domSnapshot() { return { url: 'https://example.test/', title: 'Example', viewport: { width: 800, height: 600 }, elements: [], truncated: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
}

test('the retry ladder is a rising 5s/15s/30s/1m/2m/4m counter', () => {
  // Owner-specified: a "fetch failed" hiccup must not burn the whole retry
  // budget in three seconds and end the chat.
  assert.deepEqual([...RETRY_DELAYS_MS], [5_000, 15_000, 30_000, 60_000, 120_000, 240_000]);
  assert.equal(retryDelayMs(7), 240_000, 'attempts past the ladder stay at the top of the ramp');
});

test('hard provider errors are classified as never-retryable', () => {
  assert.equal(isHardProviderError(new Error('API key missing or invalid (401).')), true);
  assert.equal(isHardProviderError(new Error('Payment required (402): past due.')), true);
  assert.equal(isHardProviderError(Object.assign(new Error('The selected connection must support the Responses tool-calling contract.'), { code: 'PROVIDER_PROTOCOL_UNSUPPORTED' })), true);
  assert.equal(isHardProviderError(new Error('fetch failed')), false, 'transport faults stay retryable');
  assert.equal(isHardProviderError(new Error('connection refused')), false);
});

test('a network error retries the same decision without burning recovery attempts', async () => {
  const decisions = [];
  const provider = {
    async complete(context) {
      decisions.push({ recovery: context.recovery?.source || '', attempts: context.recovery?.attempts || 0 });
      if (decisions.length === 1) { const e = new Error('fetch failed'); throw e; }
      if (decisions.length === 2) { const e = new Error('socket hang up'); throw e; }
      return { done: { summary: 'Recovered after network blips.', success: true } };
    }
  };
  const messages = [];
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') messages.push(event.text); },
    createProvider: () => provider
  });
  // Instant retries for the test; ordering and counts are what matter.
  agent.transportRetryDelays = [5, 5];
  const run = await agent.start({ task: 'Finish despite network blips', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(decisions.length, 3);
  // Recovery was never engaged: no recovery source, no consumed attempts.
  assert.deepEqual(decisions.map(d => d.recovery), ['', '', '']);
  assert.equal(run.coordinator.replansWithoutProgress > 0, false);
  assert.equal(run.history.some(entry => entry.tool === 'agent_recovery'), false);
  // The user saw two retry notices.
  assert.equal(messages.length, 2);
  assert.match(messages[0], /Connection error.*Retrying in 0s \(attempt 1 of 2\)/);
  assert.match(messages[1], /attempt 2 of 2/);
});

test('an exhausted transport ladder fails the run honestly instead of waiting forever', async () => {
  let calls = 0;
  const messages = [];
  const provider = {
    async complete() { calls += 1; throw new Error('connection refused'); }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') messages.push(event.text); },
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5, 5];
  const run = await agent.start({ task: 'A dead connection must end the run', provider: { id: 'mock' } });
  assert.equal(run.status, 'failed', 'API/provider outage is allowed to end the run');
  assert.equal(run.result?.reason, 'provider_unreachable');
  assert.ok(calls >= 3, `every ladder slot was used before failing (${calls} attempts)`);
  assert.ok(messages.some(text => text.includes('Connection error')), 'the user saw the retry notices');
  assert.ok(!run.history.some(entry => entry.tool === 'agent_recovery'), 'outages never burn the model recovery budget');
});

test('recovery exhaustion stays internal and the next decision can finish', async () => {
  let calls = 0;
  const notices = [];
  const provider = {
    async complete(context) {
      calls += 1;
      // Narrate without acting; the bounded runtime should stop after one
      // fresh restart rather than expose recovery internals to the user.
      const lastUser = [...(context.messages || [])].reverse().find(m => m.role === 'user');
      if (calls <= 3 || !context.messages?.some(message => message.source === 'runtime')) {
        return { assistantText: 'I will act next.', actions: [] };
      }
      return { done: { summary: 'Re-planned after the fresh restart message.', success: true, verified: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') notices.push(event.text); },
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Keep going after exhaustion', provider: { id: 'mock' }, settings: { maxRecoveries: 2, maxActionsPerStep: 5 } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true, 'the run continues after bounded recovery');
  assert.equal(run.result.reason, undefined);
  // The model retained the restart as internal runtime context...
  const restart = run.messages.filter(m => m.source === 'runtime' && /Internal recovery cycle/.test(String(m.content || '')));
  assert.ok(restart.length >= 1, 'internal runtime recovery context was retained');
  // ...and the user never saw the internal notice in the chat.
  assert.equal(notices.filter(text => text.includes('Internal recovery cycle')).length, 0);
});

test('permanent provider blocks still fail fast without retries', async () => {  let calls = 0;
  const provider = {
    async complete() { calls += 1; throw new Error('API key missing or invalid (401).'); }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Should fail fast', provider: { id: 'mock' } });
  assert.equal(calls, 1);
  assert.equal(run.result.reason, 'provider_external_block');
});

test('a server error inside a 200 SSE stream surfaces as a transport failure', async () => {
  const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
  const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
  // Chat completions path.
  const chat = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'key',
    fetchImpl: async () => sse([{ error: { type: 'api_error', message: 'A server error occurred. Please try again.' } }])
  });
  await assert.rejects(chat.complete({ task: 'x', history: [], coordinator: { metrics: {} }, onThought: () => {} }), error => {
    assert.equal(error.code, 'PROVIDER_STREAM_ERROR');
    assert.equal(error.status, 500);
    return true;
  });
  // Anthropic messages path (the live defect: the error event was swallowed,
  // the empty stream parsed as "invalid agent JSON shape", and the agent
  // blamed the model instead of retrying the server fault).
  const anthropic = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://fixture.invalid/v1', model: 'anthropic/claude-haiku-4.5', apiKey: 'key',
    fetchImpl: async () => sse([
      { type: 'error', error: { type: 'api_error', message: 'A server error occurred. Please try again.' } },
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } }
    ])
  });
  await assert.rejects(anthropic.complete({ task: 'x', history: [], coordinator: { metrics: {} }, onThought: () => {} }), error => {
    assert.equal(error.code, 'PROVIDER_STREAM_ERROR');
    assert.equal(error.status, 500);
    return true;
  });
  // Server-class stream errors ride the retry ladder; auth errors fail fast.
  assert.equal(isTransportError(new Error('Anthropic stream error (500 api_error): A server error occurred.')), true);
  assert.equal(isTransportError(new Error('Anthropic stream error (529 overloaded_error): Overloaded.')), true);
  assert.equal(isTransportError(new Error('Anthropic stream error (401 authentication_error): Invalid API key.')), false);
});

test('an in-stream server error triggers the transport ladder, never model recovery', async () => {
  let calls = 0;
  const provider = {
    async complete() {
      calls += 1;
      if (calls === 1) { const e = new Error('Anthropic stream error (500 api_error): A server error occurred. Please try again.'); e.code = 'PROVIDER_STREAM_ERROR'; throw e; }
      return { done: { summary: 'Recovered after the server error.', success: true } };
    }
  };
  const messages = [];
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') messages.push(event.text); },
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Survive a server blip', provider: { id: 'mock' } });
  assert.equal(run.result.success, true);
  assert.equal(calls, 2);
  assert.equal(run.history.some(entry => entry.tool === 'agent_recovery'), false, 'the server fault was never misreported as model narration');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Connection error/);
});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

// A provider call that hangs until the step timeout aborts it (no orphan
// timers left behind for the test runner).
const hangUntilAborted = context => new Promise(resolve => {
  const timer = setTimeout(resolve, 60_000);
  context.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

test('a step timeout leaves no truncated reasoning fragment for the retry', async () => {
  const seen = [];
  let calls = 0;
  const provider = {
    async complete(context) {
      calls += 1;
      seen.push(String(context.workingMemory?.previousReasoning || ''));
      if (calls < 3) {
        // Simulate a killed stream: the onThought handler already stored the
        // model's unfinished thought in working memory.
        context.workingMemory.previousReasoning = 'half-finished long think about the scene plan...';
        throw new Error('Timed out after 90000ms while waiting for the model.');
      }
      return { done: { summary: 'Recovered once the connection returned.', success: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5, 5];
  await agent.start({ task: 'Restart reasoning fresh', provider: { id: 'mock' } });
  assert.equal(calls, 3);
  // Call 1 sees an empty store; calls 2 and 3 must see it cleared, not the
  // previous attempt's fragment (the growing-timeout spiral driver).
  assert.equal(seen[0], '');
  assert.equal(seen[1], '');
  assert.equal(seen[2], '');
});

test('a model that streams deltas is never killed by the step timeout', async () => {
  let calls = 0;
  const provider = {
    async complete(context) {
      calls += 1;
      // Think longer than stepTimeoutMs while actively streaming: each delta
      // resets the dead-air deadline.
      for (let i = 0; i < 12; i += 1) { await pause(500); context.onStream?.({}); }
      return { done: { summary: 'Long think completed.', success: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Survive a long think', provider: { id: 'mock' }, settings: { stepTimeoutMs: 5_000 } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(calls, 1, 'no retry was needed: the stream was alive the whole time');
});

test('a model silent before its first token outlives the step deadline', async () => {
  let calls = 0;
  const provider = {
    async complete(context) {
      calls += 1;
      if (calls === 1) {
        // Time-to-first-token longer than stepTimeoutMs: the model is
        // thinking server-side and no delta has arrived yet. This must NOT
        // be killed by the step deadline.
        await pause(8_000);
        context.onStream?.({});
        return { done: { summary: 'Long silent think completed.', success: true } };
      }
      return { done: { summary: 'never reached', success: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Silent think must survive', provider: { id: 'mock' }, settings: { stepTimeoutMs: 5_000 } });
  assert.equal(run.result.success, true, 'the pre-stream think was not killed by the step deadline');
  assert.equal(calls, 1, 'no retry was needed');
});

test('a truly silent model call still times out and retries', async () => {
  let calls = 0;
  const provider = {
    async complete(context) {
      calls += 1;
      if (calls === 1) { await hangUntilAborted(context); return { done: { summary: 'never reached', success: true } }; }
      return { done: { summary: 'Recovered after dead air.', success: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const startedAt = Date.now();
  const run = await agent.start({ task: 'Dead air must fail', provider: { id: 'mock' }, settings: { stepTimeoutMs: 5_000, modelConnectMs: 3_000 } });
  assert.equal(run.result.success, true);
  assert.ok(Date.now() - startedAt < 15_000, 'the dead-air call was cut at the connect window, not left hanging');
  assert.equal(calls, 2);
});

test('the absolute cap ends a stream that trickles forever', async () => {
  let calls = 0;
  const provider = {
    async complete(context) {
      calls += 1;
      if (calls === 1) {
        // Deltas every 500ms keep resetting the deadline, but the absolute
        // cap (stepTimeoutMs x factor) must still fire.
        const stream = setInterval(() => context.onStream?.({}), 500);
        context.signal?.addEventListener('abort', () => clearInterval(stream), { once: true });
        await hangUntilAborted(context);
        return { done: { summary: 'never reached', success: true } };
      }
      return { done: { summary: 'Recovered from a trickling stream.', success: true } };
    }
  };
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const startedAt = Date.now();
  const run = await agent.start({ task: 'Trickle must end', provider: { id: 'mock' }, settings: { stepTimeoutMs: 5_000, stepAbsoluteTimeoutFactor: 2 } });
  assert.equal(run.result.success, true);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 10_000 && elapsed < 20_000, `the cap fired near 10s (got ${Math.round(elapsed / 1000)}s)`);
  assert.equal(calls, 2);
});
