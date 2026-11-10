// Reasoning effort ladder (mode/permissions pill): Auto (default) / Minimal /
// Standard / Advanced. Auto STARTS at advanced — the strongest reasoning is
// the default — and the model moves one rung per decision in either direction
// with a reason. There are no model-family dampeners anywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  EFFORT_TIERS, normalizeEffortSetting, normalizeEffortTier, nextEffortTier, applyEffortEscalation
} = require('../desktop/agent/desktopChatAgent.cjs');
const { createOllamaProvider } = require('../desktop/agent/ollamaProvider.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { createCoordinatorState } = require('../desktop/agent/desktopAgentCoordinator.cjs');

function jsonResponse(body) {
  return { ok: true, status: 200, statusText: 'OK', async json() { return body; }, async text() { return JSON.stringify(body); } };
}
const DONE_CALL = '{"toolCalls":[{"name":"browser_done","input":{"summary":"ok","success":true,"verified":true}}]}';
const BASE = { task: 'Do the thing', observation: {}, history: [], messages: [], plan: [], goals: [], tools: [], coordinator: createCoordinatorState() };

test('effort settings and tiers normalize defensively', () => {
  assert.deepEqual([...EFFORT_TIERS], ['minimal', 'standard', 'advanced']);
  assert.equal(normalizeEffortSetting('auto'), 'auto');
  assert.equal(normalizeEffortSetting('standard'), 'standard');
  assert.equal(normalizeEffortSetting('banana'), 'auto');
  assert.equal(normalizeEffortSetting(undefined), 'auto');
  assert.equal(normalizeEffortTier('minimal'), 'minimal');
  assert.equal(normalizeEffortTier('mega'), null);
  assert.equal(nextEffortTier('minimal'), 'standard');
  assert.equal(nextEffortTier('standard'), 'advanced');
  assert.equal(nextEffortTier('advanced'), 'advanced');
});

test('fixed effort tiers never change and ignore model escalation requests', () => {
  for (const tier of EFFORT_TIERS) {
    const outcome = applyEffortEscalation({ mode: tier, tier, needSignals: 5 }, { requested: 'advanced', reason: 'this task is hard' });
    assert.deepEqual(outcome, { tier, escalated: null });
  }
});

test('auto policy: advanced start, one rung per decision in either direction, reason required', () => {
  // A leap of two rungs is always refused, even with a reason.
  assert.deepEqual(
    applyEffortEscalation({ mode: 'auto', tier: 'advanced', needSignals: 3 }, { requested: 'minimal', reason: 'trivial task' }),
    { tier: 'advanced', escalated: null }
  );
  // No reason, no adjustment — the model may never pick a tier randomly.
  assert.deepEqual(
    applyEffortEscalation({ mode: 'auto', tier: 'advanced', needSignals: 0 }, { requested: 'standard', reason: '   ' }),
    { tier: 'advanced', escalated: null }
  );
  assert.deepEqual(
    applyEffortEscalation({ mode: 'auto', tier: 'advanced', needSignals: 0 }, {}),
    { tier: 'advanced', escalated: null }
  );
  // De-escalation: a justified one-rung step down is granted.
  assert.deepEqual(
    applyEffortEscalation({ mode: 'auto', tier: 'advanced' }, { requested: 'standard', reason: 'the task is a two-file rename' }),
    { tier: 'standard', escalated: 'standard' }
  );
  // Re-escalation back up is granted the same way.
  assert.deepEqual(
    applyEffortEscalation({ mode: 'auto', tier: 'standard' }, { requested: 'advanced', reason: 'standard reasoning kept looping' }),
    { tier: 'advanced', escalated: 'advanced' }
  );
  // Fixed modes never move.
  assert.deepEqual(
    applyEffortEscalation({ mode: 'standard', tier: 'standard', needSignals: 2 }, { requested: 'minimal', reason: 'calm now' }),
    { tier: 'standard', escalated: null }
  );
  // Harness safety net escalates unconditionally by one rung, capped at top.
  assert.deepEqual(applyEffortEscalation({ mode: 'auto', tier: 'minimal' }, { harness: true }), { tier: 'standard', escalated: 'standard' });
  assert.deepEqual(applyEffortEscalation({ mode: 'auto', tier: 'standard' }, { harness: true }), { tier: 'advanced', escalated: 'advanced' });
  assert.deepEqual(applyEffortEscalation({ mode: 'auto', tier: 'advanced' }, { harness: true }), { tier: 'advanced', escalated: null });
});

test('ollama provider maps tiers onto the think flag, decision budget, and prompt', async () => {
  const cases = [
    { effort: 'minimal', think: false, numPredict: 1_536, prompt: /Reasoning effort: minimal/ },
    { effort: 'standard', think: undefined, numPredict: 2_048, prompt: /Reasoning effort: standard/ },
    { effort: 'advanced', think: undefined, numPredict: 4_096, prompt: null }
  ];
  for (const item of cases) {
    const bodies = [];
    const provider = createOllamaProvider({
      model: 'kimi-k2.7',
      fetchImpl: async (_url, options) => { bodies.push(JSON.parse(options.body)); return jsonResponse({ message: { content: DONE_CALL } }); }
    });
    await provider.complete({ ...BASE, effort: item.effort, effortMode: item.effort });
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].think, item.think, `${item.effort}: think flag`);
    assert.equal(bodies[0].options.num_predict, item.numPredict, `${item.effort}: decision budget`);
    if (item.prompt) assert.match(bodies[0].messages[0].content, item.prompt);
    else assert.doesNotMatch(bodies[0].messages[0].content, /Reasoning effort:/);
  }
});

test('ollama auto mode advertises the escalation channel and effortNeeded survives parsing', async () => {
  const bodies = [];
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_done","input":{"summary":"ok","success":true,"verified":true}}],"effortNeeded":"standard","effortReason":"the checkout flow has twelve dependent fields"}' } });
    }
  });
  const result = await provider.complete({ ...BASE, effort: 'minimal', effortMode: 'auto' });
  assert.match(bodies[0].messages[0].content, /effortNeeded/);
  assert.match(bodies[0].messages[0].content, /starts you at minimal reasoning effort and adjusts/);
  // The extra decision fields ride through the parser untouched so the agent
  // can apply its own clamping policy.
  assert.equal(result.effortNeeded, 'standard');
  assert.equal(result.effortReason, 'the checkout flow has twelve dependent fields');
});

test('openai-compatible protocol maps effort onto reasoning_effort and thinking', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'gpt-fixture',
    apiKey: 'key',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ choices: [{ message: { content: DONE_CALL } }] }); }
  });
  await provider.complete({ ...BASE, effort: 'minimal', effortMode: 'minimal' });
  await provider.complete({ ...BASE, effort: 'standard', effortMode: 'standard' });
  await provider.complete({ ...BASE });
  assert.equal(bodies[0].reasoning_effort, 'low');
  assert.equal(bodies[1].reasoning_effort, 'medium');
  assert.equal(bodies[2].reasoning_effort, undefined);
  assert.match(bodies[0].messages[0].content, /Reasoning effort: minimal/);
  assert.doesNotMatch(bodies[2].messages[0].content, /Reasoning effort:/);
});

test('anthropic protocol drops extended thinking at minimal and keeps it otherwise', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'anthropic',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'claude-fixture',
    apiKey: 'key',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ content: [{ type: 'text', text: DONE_CALL }] }); }
  });
  await provider.complete({ ...BASE, effort: 'minimal', effortMode: 'minimal' });
  await provider.complete({ ...BASE });
  assert.equal(bodies[0].thinking, undefined);
  assert.deepEqual(bodies[1].thinking, { type: 'enabled', budget_tokens: 1_024 });
});

test('responses protocol maps effort onto the reasoning control', async () => {
  const call = (id) => ({ type: 'function_call', id, call_id: id, name: 'browser_done', arguments: JSON.stringify({ summary: 'ok', success: true, verified: true }), status: 'completed' });
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    protocol: 'responses',
    providerId: 'xkiro',
    baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture',
    apiKey: 'key',
    fetchImpl: async (_url, init) => { bodies.push(JSON.parse(init.body)); return jsonResponse({ status: 'completed', output: [call('end-' + bodies.length)], usage: { input_tokens: 5, output_tokens: 5 } }); }
  });
  await provider.complete({ ...BASE, effort: 'minimal', effortMode: 'minimal' });
  await provider.complete({ ...BASE, effort: 'standard', effortMode: 'standard' });
  await provider.complete({ ...BASE });
  assert.deepEqual(bodies[0].reasoning, { summary: 'auto', effort: 'low' });
  assert.deepEqual(bodies[1].reasoning, { summary: 'auto', effort: 'medium' });
  assert.deepEqual(bodies[2].reasoning, { summary: 'auto', effort: 'high' });
});

// ---- Harness-side demotion on low-yield speculation (2026-10-01) ------------

function createDemotionController() {
  return {
    async domSnapshot(tabId) { return { tabId, url: 'https://fixture.test', title: 'Fixture', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'B', text: 'B', enabled: true }], truncated: false }; },
    navigationState(tabId) { return { tabId, url: 'https://fixture.test', loading: false }; },
    consoleEntries() { return []; }, networkEntries() { return []; },
    async clickElement(tabId, args, owner) { return { tabId, ...args }; },
    async navigate(tabId, url) { return { tabId, url }; },
    type() { return { length: 0 }; }, async scroll() { return {}; }, key() { return {}; },
    async screenshot() { return { data: 'img' }; }, releaseSessionInput() { return { released: true }; }
  };
}

test('auto demotes one rung after two consecutive big-thinking no-action decisions', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller: createDemotionController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(args) {
        decision += 1;
        if (args.onThought) args.onThought('speculation '.repeat(2_200)); // ~24k chars of reasoning
        if (decision <= 2) return { assistantText: 'Still theorizing about the overlay.' };
        return { done: { summary: 'Investigated.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Look into the overlay borders', settings: { effort: 'auto' }, provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.effortTier, 'standard', 'two low-yield decisions must demote advanced -> standard');
  assert.equal(run.effortTierDemotions, 1);
});

test('a decision with a real mutation resets the speculation streak', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller: createDemotionController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(args) {
        decision += 1;
        if (args.onThought) args.onThought('speculation '.repeat(2_200));
        if (decision === 1) return { assistantText: 'Theorizing only.' };
        if (decision === 2) return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
        if (decision === 3) return { assistantText: 'Theorizing again.' };
        return { done: { summary: 'Done.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Check the overlay', settings: { effort: 'auto' }, provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  // Decisions 1 and 3 are low-yield but separated by a mutation: no demotion.
  assert.equal(run.effortTier, 'advanced');
  assert.equal(run.effortTierDemotions || 0, 0);
});
