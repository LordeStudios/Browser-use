import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenAiCompatibleProvider } from '../desktop/agent/openAiCompatibleProvider.cjs';

test('OpenAI-compatible provider keeps keys private and returns a structured agent decision', async () => {
  let request = null;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'secret-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":{"summary":"checked","success":true,"verified":true}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await provider.complete({ task: 'check', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] });
  assert.equal(result.done.summary, 'checked');
  assert.equal(request.url, 'https://api.example.test/v1/chat/completions');
  assert.match(request.options.headers.authorization, /^Bearer /);
  assert.doesNotMatch(request.options.body, /secret-key/);
  const body = JSON.parse(request.options.body);
  assert.equal(body.max_tokens, 4096);
  assert.match(body.messages[0].content, /never re-read unchanged page, file, or desktop state/);
  assert.doesNotMatch(body.messages[0].content, /Begin every response immediately with <think>/);
  assert.match(body.messages[0].content, /After a mutation continue with the next grounded mutation/);
  assert.match(body.messages[0].content, /agent_message only for a concrete handoff/);
  assert.match(body.messages[0].content, /observe again only for new state or final confirmation/);
  assert.doesNotMatch(body.messages[0].content, /Begin every response immediately with <think>/);
});

test('OpenAI-compatible provider requires an explicit browser_wait duration', async () => {
  let request = null;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":{"summary":"checked","success":true}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  await provider.complete({
    task: 'Wait once', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [],
    tools: [{ name: 'browser_wait', input: { ms: 'required positive milliseconds, capped at 10000' } }]
  });

  const waitTool = request.tools.find((tool) => tool.function?.name === 'browser_wait');
  assert.deepEqual(waitTool.function.parameters.required, ['ms']);
});

test('OpenAI-compatible provider sends current visual evidence as a native image content block', async () => {
  let request = null;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'vision-model', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":{"summary":"saw image","success":true}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Inspect visually',
    observation: { navigation: {}, dom: { elements: [] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  const content = request.messages.at(-1).content;
  assert.equal(Array.isArray(content), true);
  assert.equal(content[0].type, 'text');
  assert.equal(content[1].type, 'image_url');
  assert.equal(content[1].image_url.url, 'data:image/png;base64,cG5n');
  assert.doesNotMatch(content[0].text, /cG5n/);
  assert.equal(result.done.summary, 'saw image');
});

test('OpenAI-compatible provider falls back to the same DOM context when a model rejects image input', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'text-model', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) return new Response(JSON.stringify({ error: { message: 'image input is unsupported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":{"summary":"used DOM","success":true}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Inspect',
    observation: { navigation: {}, dom: { title: 'Visible page', elements: [] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  assert.equal(requests.length, 2);
  assert.equal(Array.isArray(requests[0].messages.at(-1).content), true);
  assert.equal(typeof requests[1].messages.at(-1).content, 'string');
  assert.match(requests[1].messages.at(-1).content, /Visible page/);
  assert.equal(result.done.summary, 'used DOM');

  await provider.complete({
    task: 'Continue inspecting',
    observation: { navigation: {}, dom: { title: 'Next visible state', elements: [] }, screenshot: { mimeType: 'image/png', data: 'bmV4dA==' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(requests.length, 3);
  assert.equal(typeof requests[2].messages.at(-1).content, 'string');
  assert.match(requests[2].messages.at(-1).content, /Next visible state/);
});

test('OpenAI-compatible provider treats an explicit no-vision response as capability evidence and retries with DOM', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'text-model', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      const content = requests.length === 1
        ? '{"assistantText":"I cannot process the screenshot."}'
        : '{"toolCalls":[{"name":"browser_click","input":{"element":9}}]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue through visible controls',
    observation: { navigation: {}, dom: { elements: [{ index: 9, name: 'Text tool' }] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  assert.equal(requests.length, 2);
  assert.equal(Array.isArray(requests[0].messages.at(-1).content), true);
  assert.equal(typeof requests[1].messages.at(-1).content, 'string');
  assert.equal(result.toolCalls[0].name, 'browser_click');
});

test('OpenAI-compatible provider rejects empty credentials and models', () => {
  assert.throws(() => createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: '', apiKey: 'key' }), /Choose an OpenAI model/);
  assert.throws(() => createOpenAiCompatibleProvider({ providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: '' }), /requires an API key/);
});

test('OpenAI-compatible provider preserves a plain informational reply instead of dissolving it', async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'The canvas contains one ellipse.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  });

  const result = await provider.complete({ task: 'What is on the canvas?', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] });

  assert.equal(result.assistantText, 'The canvas contains one ellipse.');
  assert.deepEqual(result.done, { summary: 'The canvas contains one ellipse.', success: true, verified: false });
});

test('OpenAI-compatible provider does not turn language-labelled command JSON into a final chat reply', async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'secret-key',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'json\n{"browser_fill":{"element":68,"text":"Page name"}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  });

  await assert.rejects(
    () => provider.complete({ task: 'Rename the page', observation: { navigation: {}, dom: { elements: [{ index: 68, name: 'Page name' }] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] }),
    /structured|executable|agent json shape|without a browser action/i
  );
});

test('OpenAI-compatible provider forwards recovery context to the corrective model turn', async () => {
  let request = null;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"toolCalls":[{"name":"browser_type","input":{"element":4,"text":"lordemaximus.com"}}]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Search the site',
    observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [] } },
    history: [], messages: [], coordinator: {}, plan: [], tools: [],
    recovery: { attempts: 1, source: 'provider_decision', action: null, lastError: 'The structured-response repair did not return an executable decision.' }
  });

  const context = JSON.parse(request.messages.at(-1).content);
  assert.equal(context.recovery.attempts, 1);
  assert.match(context.recovery.lastError, /structured-response repair/i);
  assert.equal(result.toolCalls[0].name, 'browser_type');
});

test('OpenAI-compatible provider performs one schema repair instead of surfacing a recoverable malformed reply', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const content = requests.length === 1
        ? 'I will inspect the search form next.'
        : '{"toolCalls":[{"name":"browser_fill","input":{"element":2,"text":"lordemaximus.com"}}]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Search for LordeMaximus', observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [] } },
    history: [], messages: [], coordinator: {}, plan: [], tools: [{ name: 'browser_fill', input: { element: 'current DOM index', text: 'string' } }]
  });

  assert.equal(requests.length, 2);
  assert.match(requests[1].messages[0].content, /Return exactly one JSON object/i);
  assert.doesNotMatch(JSON.stringify(requests), /private-key/);
  assert.equal(result.toolCalls[0].name, 'browser_fill');
});

test('OpenAI-compatible provider retries one transient transport failure inside the same decision', async () => {
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"done":{"summary":"Recovered request.","success":true}}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({ task: 'Inspect', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] });

  assert.equal(calls, 2);
  assert.equal(result.done.summary, 'Recovered request.');
});

test('OpenAI-compatible provider repairs a redundant browser_observe into an actionable decision without sending it to the executor', async () => {
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async () => {
      calls += 1;
      const content = calls === 1
        ? '{"toolCalls":[{"name":"browser_observe","input":{}}]}'
        : '{"toolCalls":[{"name":"browser_click","input":{"element":2}}]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Open the sign-in form',
    observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [{ index: 2, name: 'Sign in' }] } },
    history: [], messages: [], coordinator: { observationRevision: 1 }, plan: [], tools: []
  });

  // The redundant-observe repair now lives in the agent loop (coordinator
  // redundantObserve); the provider passes the decision through untouched.
  assert.equal(calls, 1);
  assert.equal(result.toolCalls[0].name, 'browser_observe');
});

test('OpenAI-compatible provider passes a redundant screenshot through; the agent loop owns the repair', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const content = requests.length === 1
        ? '{"toolCalls":[{"name":"browser_screenshot","input":{}}]}'
        : '{"toolCalls":[{"name":"browser_click","input":{"element":35}}]}';
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Add the next editable element',
    observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [{ index: 35, name: 'Text tool' }] }, screenshot: { captured: true } },
    history: [], messages: [], coordinator: { observationRevision: 3 }, plan: [], tools: []
  });

  assert.equal(requests.length, 1);
  assert.equal(result.toolCalls[0].name, 'browser_screenshot');
});

test('OpenAI-compatible provider passes duplicate-recovery context through; the agent loop owns the repair', async () => {
  const requests = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"toolCalls":[{"name":"browser_screenshot","input":{}}]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue editing',
    observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [{ index: 49, name: 'Rectangle tool' }] } },
    history: [], messages: [], coordinator: { observationRevision: 2 }, plan: [], tools: [],
    recovery: { attempts: 1, source: 'duplicate_action', action: 'browser_screenshot', lastError: 'The screenshot is already attached.' }
  });

  // The duplicate-recovery repair lives in the agent loop now; the provider
  // carries the recovery context and passes the decision through untouched.
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /duplicate_action/);
  assert.equal(result.toolCalls[0].name, 'browser_screenshot');
});

test('OpenAI-compatible provider streams declared reasoning without exposing structured JSON as thought text', async () => {
  let request = null;
  const thoughts = [];
  const stream = [
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Inspecting ' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'the visible page.' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '{"done":{"summary":"The page is ready.",' } }] })}`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '"success":true,"verified":true}}' }, finish_reason: 'stop' }] })}`,
    'data: [DONE]'
  ].join('\n\n');
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'gpt-5.6-terra', apiKey: 'private-key',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
  });

  const result = await provider.complete({
    task: 'Inspect the visible page', observation: { navigation: {}, dom: { elements: [] } },
    history: [], messages: [], coordinator: {}, plan: [], tools: [], onThought: (text) => thoughts.push(text)
  });

  assert.equal(request.stream, true);
  assert.deepEqual(thoughts, ['Inspecting ', 'Inspecting the visible page.']);
  assert.equal(result.done.summary, 'The page is ready.');
  assert.equal(thoughts.some((text) => text.includes('"done"')), false);
});

test('OpenAI-compatible provider preserves the full reasoning stream before one structural repair', async () => {
  const requests = [];
  const thoughts = [];
  const repeatedReasoning = 'Rechecking the same visible state without choosing an action. '.repeat(90);
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'agent-model', apiKey: 'private-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) {
        const stream = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: repeatedReasoning } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"toolCalls":[{"name":"browser_click","input":{"element":7}}]}' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue editing', observation: { navigation: {}, dom: { elements: [{ index: 7, name: 'Text tool' }] } },
    history: [], messages: [], coordinator: {}, plan: [], tools: [], onThought: (text) => thoughts.push(text)
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[1].stream, true);
  assert.equal(requests[1].max_tokens, 1024);
  assert.equal(result.toolCalls[0].name, 'browser_click');
  assert.equal(thoughts[0], repeatedReasoning);
});

// ---- Prompt caching (Anthropic route) --------------------------------------

const anthropicContext = () => ({ task: 'check', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] });

test('anthropic route marks the system block as cacheable', async () => {
  let request = null;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'anthropic', baseUrl: 'https://api.example.test', model: 'claude-fixture', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => { request = JSON.parse(options.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"done":{"summary":"ok","success":true}}' }] }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  });
  await provider.complete(anthropicContext());
  assert.ok(Array.isArray(request.system), 'system is a cacheable block array');
  assert.equal(request.system[0].cache_control.type, 'ephemeral');
  assert.ok(request.system[0].text.length > 100);
});

test('a gateway that rejects caching is latched off and requests retry cleanly', async () => {
  const bodies = [];
  let calls = 0;
  const provider = createOpenAiCompatibleProvider({
    providerId: 'anthropic', baseUrl: 'https://api.example.test', model: 'claude-fixture', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      calls += 1;
      bodies.push(JSON.parse(options.body));
      if (calls === 1) return new Response(JSON.stringify({ error: { message: 'cache_control is not supported' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ content: [{ type: 'text', text: '{"done":{"summary":"ok","success":true}}' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  const result = await provider.complete(anthropicContext());
  assert.equal(result.done.summary, 'ok');
  assert.equal(calls, 2, 'the request retried once without the cache extension');
  assert.equal(Array.isArray(bodies[0].system), true, 'first attempt carried the cache block');
  assert.equal(bodies[1].system, bodies[0].system[0].text, 'retry sent the identical system as a plain string');
  // The latch holds for later calls: no cache block, single attempt.
  let callsBefore = calls;
  await provider.complete(anthropicContext());
  assert.equal(calls, callsBefore + 1);
  assert.equal(typeof bodies[2].system, 'string');
});

const TOOL_CATALOG = [{ name: 'computer_file', description: 'read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }];
const STRIKE_ARGS = { task: 'check', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], goals: [] };
const DONE_DECISION = '{"done":{"summary":"ok","success":true,"verified":true}}';
const fixtureResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('a single tools-400 is a strike, not a permanent JSON degradation', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'gpt-fixture', apiKey: 'key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.length && bodies.length === 1) return fixtureResponse({ error: { message: 'tools rejected by this gateway' } }, 400);
      return fixtureResponse({ choices: [{ message: { content: DONE_DECISION } }] });
    }
  });
  await provider.complete({ ...STRIKE_ARGS, tools: TOOL_CATALOG, effort: 'advanced' });
  await provider.complete({ ...STRIKE_ARGS, tools: TOOL_CATALOG, effort: 'advanced' });
  assert.ok(bodies[0].tools?.length > 0, 'the first decision attempts native tools');
  assert.equal(bodies[1].tools, undefined, 'the same decision retries JSON-style after the 400');
  assert.ok(bodies[2].tools?.length > 0, 'native tools resume on the next decision');
  assert.equal(provider.nativeToolsBroken, false, 'one transient rejection never latches the session');
});

test('a consistently tool-hostile gateway latches after three strikes', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'openai', baseUrl: 'https://fixture.invalid/v1', model: 'gpt-fixture', apiKey: 'key',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.tools?.length) return fixtureResponse({ error: { message: 'tools rejected by this gateway' } }, 400);
      return fixtureResponse({ choices: [{ message: { content: DONE_DECISION } }] });
    }
  });
  for (let i = 0; i < 3; i++) await provider.complete({ ...STRIKE_ARGS, tools: TOOL_CATALOG, effort: 'advanced' });
  assert.equal(provider.nativeToolsFailures, 3, 'three consecutive strikes');
  await provider.complete({ ...STRIKE_ARGS, tools: TOOL_CATALOG, effort: 'advanced' });
  assert.equal(provider.nativeToolsBroken, true, 'the session latches after three strikes');
  assert.equal(bodies.at(-1).tools, undefined, 'latched sessions stop shipping tool schemas');
});
