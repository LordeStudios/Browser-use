// Regression tests for the run-2026-10-10 trace failures:
// - run-2026-10-10-214922 ("hello", provider xkiro): a 402 "Insufficient
//   wallet balance" fell through the hard-block classifier into the
//   deliberately unbounded recovery loop — 1038 identical recoveries, ~49MB
//   of burned request bytes, until a coincidental 429 finally triggered the
//   transport ladder and the run died as provider_unreachable.
// - run-2026-10-10-211303 (checkout flow): the coding gate classified the
//   task as coding because the fill VALUE "Max Test" contains \btest\b, and
//   bounced a done twice with an invented "this coding task requires a
//   test/check" requirement the task never asked for.
// - Outcome 1 (capabilities): a text-only model must not be SENT screenshots;
//   capability metadata (the /models roster the vision delegate already
//   trusts) must gate image attachment proactively instead of waiting for a
//   rejection round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent, externalProviderBlock, codingCheckSatisfied } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { classifyOutcome } = require('../desktop/schedule/scheduler.cjs');

const PNG = { mimeType: 'image/png', data: 'cG5n' };

function chatResponse(content) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
}

// ---- Outcome 1: capability metadata gates image content proactively --------

test('a text-only capability flag keeps screenshots off the wire and delegates the viewing', async () => {
  const probes = { models: 0, chat: [] };
  const described = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'glm-5.3-flash', apiKey: 'secret-key',
    visionDelegate: ({ image }) => { described.push(image); return { ok: true, model: 'roster-vision-model', text: 'The page shows an order confirmation form.' }; },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) {
        probes.models += 1;
        return new Response(JSON.stringify({ data: [{ id: 'glm-5.3-flash', capabilities: { tools: true, vision: false } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"used the text description","success":true}}');
    }
  });
  const result = await provider.complete({
    task: 'Inspect the page',
    observation: { navigation: {}, dom: { title: 'Checkout', elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(provider.visualCapability, 'no');
  assert.equal(provider.visualUnsupported, true, 'an explicit text-only flag must latch the text-only path');
  assert.equal(provider.visionDegraded, true);
  assert.equal(probes.models, 1, 'the /models roster is read once per provider instance');
  assert.equal(probes.chat.length, 1);
  const lastContent = probes.chat[0].messages.at(-1).content;
  assert.equal(typeof lastContent, 'string', 'the decision rides as text-only context');
  assert.doesNotMatch(lastContent, /image_url|cG5n/, 'the screenshot never rides to a text-only model');
  assert.match(lastContent, /order confirmation form/, 'the delegated description replaces the image as text');
  assert.deepEqual(described, [PNG], 'the vision delegate received the frame on the same decision');
  assert.equal(result.done.summary, 'used the text description');

  // The resolution is cached for the instance: the next visual decision
  // re-reads nothing and still sends no image.
  await provider.complete({
    task: 'Continue inspecting',
    observation: { navigation: {}, dom: { title: 'Checkout 2', elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(probes.models, 1, 'no second /models read');
  const secondContent = probes.chat[1].messages.at(-1).content;
  assert.doesNotMatch(secondContent, /image_url|cG5n/);
});

test('an attachment image is withheld from a text-only model just like observation screenshots', async () => {
  const probes = { chat: [] };
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'text-model', apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'text-model', capabilities: { vision: false } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"ok","success":true}}');
    }
  });
  await provider.complete({
    task: 'Inspect the attachment',
    observation: { navigation: {}, dom: { elements: [] } },
    attachments: [{ kind: 'image', mimeType: 'image/png', data: 'cG5n' }],
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  const lastContent = probes.chat[0].messages.at(-1).content;
  assert.doesNotMatch(lastContent, /image_url|cG5n/, 'image attachments must not ride to a text-only model either');
});

test('a failed capability metadata read keeps the reactive path and the run continues', async () => {
  const probes = { chat: [] };
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'maybe-vision-model', apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) throw new Error('connection refused');
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"saw the image","success":true}}');
    }
  });
  const result = await provider.complete({
    task: 'Inspect visually',
    observation: { navigation: {}, dom: { elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(provider.visualCapability, 'unknown', 'a failed probe is unknown, never a no');
  assert.equal(provider.visualUnsupported, false);
  const lastContent = probes.chat[0].messages.at(-1).content;
  assert.equal(Array.isArray(lastContent), true, 'the image still ships when metadata is unknown (previous behavior)');
  assert.equal(lastContent[1].type, 'image_url');
  assert.equal(result.done.summary, 'saw the image');
});

test('an explicitly vision-capable model keeps receiving screenshots (no regression)', async () => {
  const probes = { chat: [] };
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'vision-model', apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'vision-model', capabilities: { vision: true } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"saw image","success":true}}');
    }
  });
  await provider.complete({
    task: 'Inspect visually',
    observation: { navigation: {}, dom: { elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(provider.visualCapability, 'yes');
  assert.equal(provider.visualUnsupported, false);
  assert.equal(provider.visionDegraded, false);
  const lastContent = probes.chat[0].messages.at(-1).content;
  assert.equal(Array.isArray(lastContent), true);
  assert.equal(lastContent[1].type, 'image_url', 'a vision-capable model still gets the image');
  assert.equal(lastContent[1].image_url.url, 'data:image/png;base64,cG5n');
  // A metadata entry without a vision flag is unknown, never a no.
  const unknownProvider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'flagless-model', apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'flagless-model', capabilities: { tools: true } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"ok","success":true}}');
    }
  });
  await unknownProvider.complete({
    task: 'Inspect visually',
    observation: { navigation: {}, dom: { elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(unknownProvider.visualCapability, 'unknown', 'an absent flag is unknown, never a no');
  assert.equal(Array.isArray(probes.chat.at(-1).messages.at(-1).content), true);
});

// ---- Outcome 5/6: a hard billing block stops the unbounded recovery loop ---

function blockTestController() {
  return {
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    async domSnapshot() { return { url: 'https://example.test/', title: 'Example', viewport: { width: 800, height: 600 }, elements: [], truncated: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
}

test('a 402 billing error fails the run fast instead of looping identical recoveries', async () => {
  let calls = 0;
  const messages = [];
  const provider = {
    async complete() { calls += 1; throw new Error('xKiro request failed (402): Insufficient wallet balance'); }
  };
  const agent = new DesktopChatAgent({
    controller: blockTestController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') messages.push(event.text); },
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5];
  const run = await agent.start({ task: 'Report the billing block', provider: { id: 'mock' } });
  assert.equal(calls, 1, 'a billing block must never be retried (the traced run looped 1038 times)');
  assert.equal(run.status, 'failed');
  assert.equal(run.result.reason, 'provider_external_block');
  assert.match(run.result.summary, /account needs attention/, 'the user is told the account, not the credential, is the blocker');
  assert.ok(!run.history.some(entry => entry.tool === 'agent_recovery'), 'no recovery cycles burn on a hard account block');
  assert.ok(!run.recovery || !run.recovery.attempts, 'the recovery counter must stay untouched');
});

test('externalProviderBlock classifies 402 wallet wording with the account guidance', () => {
  assert.match(externalProviderBlock({ message: 'xKiro request failed (402): Insufficient wallet balance' }), /account needs attention/);
  assert.match(externalProviderBlock({ message: 'Provider request failed (402)' }), /rejected this connection/, 'a bare 402 without wallet wording keeps the credential guidance');
  assert.match(externalProviderBlock({ message: 'Payment required (402): past due.' }), /account needs attention/);
  assert.match(externalProviderBlock({ message: 'API key missing or invalid (401).' }), /credential/, '401 behavior unchanged');
  assert.equal(externalProviderBlock({ message: 'connection refused' }), null);
  assert.equal(externalProviderBlock({ message: 'socket hang up' }), null);
});

test('a scheduled 402 outcome is non-retryable', () => {
  const classified = classifyOutcome({ status: 'failed', result: { summary: 'xKiro request failed (402): Insufficient wallet balance' } });
  assert.equal(classified.outcome, 'failed');
  assert.equal(classified.retryable, false, 'the schedule retry ladder must not burn on a billing block');
});

// ---- Outcome 3/5: the coding gate must not invent requirements -------------

const CHECKOUT_TASK = 'Complete the checkout flow on the page that is already open: click "Enter shipping", fill Full name "Max Test", Street address "123 Main St", City "Kampala", select country "Uganda", continue to payment, fill card number 4111111111111111, expiry 12/28, cvv 123, place the order, and verify the page shows the order confirmed message.';

test('the coding gate no longer fires on a browser task whose quoted fill value contains test', () => {
  assert.equal(codingCheckSatisfied({ task: CHECKOUT_TASK, history: [] }), true,
    'a person name inside a quoted fill value is data, not a test demand');
  assert.equal(codingCheckSatisfied({ task: 'Fill Full name "Max Test" in the open form and verify the page shows the saved name.', history: [] }), true);
  // The gate stays live for genuine coding asks. Note "run the tests" alone
  // never armed the gate (isCodingTask's \btest\b is singular) — "patch" +
  // the test demand is the pre-existing firing shape.
  assert.equal(codingCheckSatisfied({ task: 'Fix the pagination bug in the patch and run the tests', history: [] }), false,
    'a real coding task without test evidence still bounces');
  assert.equal(codingCheckSatisfied({ task: 'Run `npm test` then fix any failures', history: [] }), false,
    'backticked test commands still trigger the gate');
  assert.equal(
    codingCheckSatisfied({
      task: 'Fix the pagination bug in the patch and run the tests',
      history: [{ tool: 'computer_terminal', input: { action: 'execute' }, output: { ok: true, result: { exitCode: 0, stdout: '3 passing' } } }]
    }),
    true, 'real terminal evidence still satisfies the gate'
  );
});

function gateTestController() {
  const calls = [];
  return {
    calls,
    async domSnapshot(tabId) {
      calls.push(['snapshot', tabId]);
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Save', text: 'Save', enabled: true }], truncated: false };
    },
    navigationState(tabId) { return { tabId, url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async clickElement(tabId, args, owner) { calls.push(['click', tabId, args, owner]); return { tabId, ...args }; },
    async screenshot() { return { data: 'base64-image' }; },
    type() { return { length: 0 }; },
    async scroll() { return {}; },
    key() { return {}; },
    releaseSessionInput() { return { released: true }; }
  };
}

test('a browser run with a quoted person name finishes without the invented coding requirement', async () => {
  let decisions = 0;
  const messages = [];
  const agent = new DesktopChatAgent({
    controller: gateTestController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') messages.push(event.text); },
    createProvider: () => ({
      async complete() {
        decisions += 1;
        if (decisions === 1) return { toolCalls: [{ name: 'browser_click', input: { element: 0 } }] };
        return { done: { summary: 'The requested form step is complete.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Fill Full name "Max Test" in the open form and verify the page shows the saved name.', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(decisions, 2, 'the done must be accepted on the first attempt (pre-fix it bounced twice)');
  assert.ok(!messages.some(text => /coding task requires/.test(text)), 'no invented coding requirement reaches the model');
  assert.ok(!run.history.some(entry => entry.tool === 'agent_recovery'), 'no recovery was needed');
});

// ---- Outcome 2/4: optional failures are contained ---------------------------

test('an optional capability probe failing does not abort the run', async () => {
  const probes = { chat: [] };
  const described = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'text-model', apiKey: 'secret-key',
    visionDelegate: ({ image }) => { described.push(image); return { ok: false, reason: 'no vision-capable model on this connection' }; },
    fetchImpl: async (url, options) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'text-model', capabilities: { vision: false } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      probes.chat.push(JSON.parse(options.body));
      return chatResponse('{"done":{"summary":"continued from the DOM evidence","success":true}}');
    }
  });
  const result = await provider.complete({
    task: 'Inspect the page',
    observation: { navigation: {}, dom: { title: 'Visible page', elements: [] }, screenshot: PNG },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.deepEqual(described.length, 1, 'the delegate was attempted once');
  assert.equal(result.done.summary, 'continued from the DOM evidence', 'a failed optional describe never fails the decision');
  const lastContent = probes.chat[0].messages.at(-1).content;
  assert.doesNotMatch(lastContent, /image_url|cG5n/);
  assert.match(lastContent, /Visible page/, 'the DOM context keeps the run grounded');
});

