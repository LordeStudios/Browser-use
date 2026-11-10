// The plan-forever loop: a reasoning model's decision was cut off by the
// output-token limit while it was still thinking/planning, the response was
// discarded, and the recovery prompt told it to "just act" — so it re-derived
// the same oversized plan into the same cap, over and over. The fix: detect
// the cut-off, raise the budget, and tell the model to act instead of re-plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
const { createCoordinatorState } = require('../desktop/agent/desktopAgentCoordinator.cjs');

const call = (id, name, input) => ({ type: 'function_call', id: 'item-' + id, call_id: id, name, arguments: JSON.stringify(input), status: 'completed' });
const base = { task: 'Perform fixture operations', tools: COMPUTER_TOOLS, history: [], coordinator: createCoordinatorState() };
const sse = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });

test('a Responses decision cut off by max_output_tokens raises the budget and retains its reasoning', async () => {
  const bodies = [];
  const reasoningItem = { type: 'reasoning', id: 'r1', encrypted_content: 'continuity-blob', summary: [] };
  const provider = createOpenAiCompatibleProvider({
    protocol: 'responses', providerId: 'xkiro', baseUrl: 'https://fixture.invalid/v1', model: 'openai/gpt-6-astra', apiKey: 'key',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [reasoningItem] });
      return Response.json({ status: 'completed', output: [call('end', 'browser_done', { summary: 'Resumed and acted.', success: true })] });
    }
  });
  await assert.rejects(provider.complete(base), error => {
    assert.equal(error.code, 'DECISION_OUTPUT_BUDGET');
    assert.match(error.message, /max_output_tokens/);
    assert.match(error.message, /retained/);
    return true;
  });
  // The retry decision requests the raised budget...
  await provider.complete(base);
  assert.equal(bodies[0].max_output_tokens, 16384, 'reasoning models start with a realistic output budget');
  assert.equal(bodies[1].max_output_tokens, 32768);
  // ...and receives the partial reasoning back, so it resumes its own
  // interrupted thinking instead of re-deriving it from scratch.
  assert.deepEqual(bodies[1].input.find(item => item.id === 'r1'), reasoningItem);
});

test('a chat decision cut off by finish_reason length raises the budget instead of looping', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'key',
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return sse([
          { choices: [{ delta: { role: 'assistant' }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: 'length' }] }
        ]);
      }
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'browser_done', arguments: '{"summary":"Done","success":true}' } }] }, finish_reason: 'tool_calls' }] }]);
    }
  });
  await assert.rejects(provider.complete({ ...base, onThought: () => {} }), error => {
    assert.equal(error.code, 'DECISION_OUTPUT_BUDGET');
    assert.match(error.message, /output limit/);
    return true;
  });
  await provider.complete({ ...base, onThought: () => {} });
  assert.equal(bodies[0].max_tokens, 4096);
  assert.equal(bodies[1].max_tokens, 16384);
});

test('an Anthropic tool call truncated by max_tokens is dropped, never executed with empty input', async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://fixture.invalid/v1', model: 'anthropic/claude-haiku-4.5', apiKey: 'key',
    fetchImpl: async () => sse([
      { type: 'message_start', message: { id: 'm' } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu1', name: 'computer_observe' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"action":"read","pa' } },
      { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }
    ])
  });
  await assert.rejects(provider.complete({ ...base, onThought: () => {} }), error => {
    assert.equal(error.code, 'DECISION_OUTPUT_BUDGET');
    return true;
  });
});

test('the agent informs the model of the cut-off instead of scolding narration', async () => {
  let calls = 0;
  const lastRecovery = [];
  const provider = {
    async complete(context) {
      calls += 1;
      if (calls === 1) { const e = new Error('cut off'); e.code = 'DECISION_OUTPUT_BUDGET'; throw e; }
      lastRecovery.push(context.recovery?.lastError || '');
      return { done: { summary: 'Acted after the budget was raised.', success: true, verified: true } };
    }
  };
  const controller = {
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    async domSnapshot() { return { url: 'https://example.test/', title: 'Example', viewport: { width: 800, height: 600 }, elements: [], truncated: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 'tab-1', emit: () => {}, createProvider: () => provider });
  const run = await agent.start({ task: 'Plan then act', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  // The multipart-task completion review adds one explicit verification round
  // trip: budget-cut decision -> recovered done proposal -> accepted review.
  assert.equal(calls, 3);
  // The recovery context names the budget condition and points at the
  // retained reasoning; it is never framed as narration-without-action.
  assert.match(lastRecovery[0], /output-token limit/);
  assert.match(lastRecovery[0], /continue it where it stopped/);
  const recoveryEntry = run.history.find(entry => entry.tool === 'agent_recovery');
  assert.equal(recoveryEntry?.output?.result?.source ?? recoveryEntry?.input?.source, 'output_budget');
});
