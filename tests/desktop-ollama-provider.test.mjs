import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOllamaProvider, parseAgentResponse, preflightOllama, boundedRequestContext, actionOnlyRepairPrompt } = require('../desktop/agent/ollamaProvider.cjs');

function jsonResponse(body, { ok = true, status = 200, statusText = 'OK' } = {}) {
  return {
    ok,
    status,
    statusText,
    async json() { return body; },
    async text() { return JSON.stringify(body); }
  };
}

function streamingResponse(chunks) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { value: undefined, done: true };
            return { value: encoder.encode(chunks[index++]), done: false };
          }
        };
      }
    },
    async json() { throw new Error('The streaming response should not be parsed as one JSON document.'); },
    async text() { return chunks.join(''); }
  };
}

test('structural repair ranks goal-relevant controls and marks successful targets completed', () => {
  const repair = actionOnlyRepairPrompt({
    task: 'Start fresh, apply the page, then add a footer',
    observation: { dom: { elements: [
      { index: 1, tag: 'button', name: 'New blank website', enabled: true },
      { index: 2, tag: 'button', name: 'Close panel', enabled: true },
      { index: 3, tag: 'button', name: 'Footer', enabled: true, pressed: true },
      { index: 4, tag: 'button', name: 'Apply page', enabled: true }
    ], regions: [{ kind: 'main', name: 'Editable surface', rect: { x: 100, y: 80, w: 600, h: 500 }, center: { x: 400, y: 330 }, descendantCount: 4 }] } },
    history: [{ tool: 'browser_click', output: { ok: true, result: { element: { name: 'New blank website' } } } }],
    tools: []
  }, 'The previous response only narrated progress.');

  assert.deepEqual(repair.observation.completedControls, ['New blank website']);
  assert.deepEqual(repair.observation.dom.elements.slice(0, 2).map((element) => element.name), ['Footer', 'Apply page']);
  assert.equal(repair.observation.dom.elements.find((element) => element.name === 'New blank website').completed, true);
  assert.equal(repair.observation.dom.elements.find((element) => element.name === 'Footer').pressed, true);
  assert.equal(repair.observation.dom.regions[0].name, 'Editable surface');
  assert.match(repair.instruction, /coordinate click or browser_drag/i);
});

test('preflight confirms an installed model and structured agent response', async () => {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'kimi-k2.7:latest' }] });
    return jsonResponse({ message: { content: '{"assistantText":"ready","toolCalls":[{"name":"browser_observe","input":{}}]}' } });
  };

  const result = await preflightOllama({ baseUrl: 'http://127.0.0.1:11434/', model: 'kimi-k2.7:latest', fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'kimi-k2.7:latest');
  assert.equal(result.structuredAction, 'browser_observe');
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/api/tags');
  assert.match(requests[1].options.body, /"format":"json"/);
});

test('preflight fails clearly when the selected model is not installed', async () => {
  await assert.rejects(
    () => preflightOllama({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'kimi-k2.7',
      fetchImpl: async () => jsonResponse({ models: [{ name: 'llama3.1:latest' }] })
    }),
    /kimi-k2\.7.*not installed/i
  );
});

test('preflight times out instead of leaving startup pending', async () => {
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  await assert.rejects(
    () => preflightOllama({ baseUrl: 'http://127.0.0.1:11434', model: 'kimi-k2.7', fetchImpl, timeoutMs: 10 }),
    /timed out|could not reach/i
  );
});

test('provider preserves browser tab details in the next decision context', () => {
  const context = boundedRequestContext({
    task: 'Can you see two tabs?',
    observation: {},
    tools: [],
    history: [{ tool: 'browser_tabs', output: { ok: true, result: [{ id: 'tab-1', title: 'Studio', url: 'https://studio.test/', loading: false }, { id: 'tab-2', title: 'Figma', url: 'https://figma.test/', loading: false }] } }]
  });
  assert.deepEqual(context.history[0].output.result, [{ id: 'tab-1', title: 'Studio', url: 'https://studio.test/', loading: false }, { id: 'tab-2', title: 'Figma', url: 'https://figma.test/', loading: false }]);
});

test('provider sends a compact fresh observation without duplicating raw DOM state', () => {
  const context = boundedRequestContext({
    task: 'Inspect the page',
    observation: {
      navigation: { url: 'https://example.test/', loading: false },
      dom: {
        url: 'https://example.test/',
        title: 'Example',
        viewport: { width: 1280, height: 720 },
        truncated: true,
        elements: Array.from({ length: 160 }, (_, index) => ({ index, tag: 'button', name: `Button ${index}`, text: `Button ${index}`, rect: { x: 0, y: index } }))
      },
      consoleEntries: Array.from({ length: 15 }, (_, index) => ({ message: `console ${index}` })),
      networkEntries: Array.from({ length: 15 }, (_, index) => ({ message: `network ${index}` }))
    },
    tools: [],
    history: []
  });

  assert.equal(context.observation.dom.elements.length, 120);
  assert.equal(context.observation.consoleEntries.length, 8);
  assert.equal(context.observation.networkEntries.length, 8);
  assert.equal(context.observation.dom.truncated, true);
});

test('provider removes screenshot bytes and typed content from bounded context', () => {
  const context = boundedRequestContext({
    task: 'Continue safely',
    observation: { screenshot: { tabId: 'tab-1', mimeType: 'image/png', data: 'very-large-base64-image' }, dom: { elements: [] } },
    history: [{ tool: 'browser_observe', output: { ok: true, observation: { screenshot: { data: 'history-image' }, dom: {} } } }, { tool: 'browser_type', input: { element: 1, text: 'private text' }, output: { ok: true } }],
    messages: ['First task', 'Follow-up task'],
    coordinator: { facts: ['The menu is open'], observationRevision: 2, completedWork: [{ action: 'browser_click', target: 'Navigation', effectObserved: true, observedRevision: 2 }] },
    workingMemory: { previousReasoning: 'Continue with the next unfinished control.', strategyEpoch: 3 },
    plan: [{ text: 'Change color', status: 'current', verification: 'red fill is visible' }],
    tools: []
  });
  const serialized = JSON.stringify(context);
  assert.doesNotMatch(serialized, /very-large-base64-image|history-image|private text/);
  assert.equal(context.messages.length, 2);
  assert.equal(context.state.facts[0], 'The menu is open');
  assert.equal(context.state.completedWork[0].target, 'Navigation');
  // Reasoning is display-only: it must never re-enter the model's context.
  // Replaying any tail of the prior think is what made the model re-derive
  // the same analysis inside one thought and repeat it card to card.
  assert.equal('previousReasoning' in context.workingMemory, false, 'the prior reasoning must not be replayed');
  assert.equal(context.workingMemory.strategyEpoch, 3);
  assert.match(context.workingMemory.authority, /never restate/i);
  assert.match(context.workingMemory.authority, /does not re-derive/i);
  assert.equal(context.history[1].input.text, '[12 characters]');
});

test('Ollama provider sends current visual evidence through the native images field', async () => {
  let request = null;
  const provider = createOllamaProvider({
    model: 'vision-model',
    fetchImpl: async (_url, options) => {
      request = JSON.parse(options.body);
      return jsonResponse({ message: { content: '{"done":{"summary":"saw image","success":true}}' } });
    }
  });

  const result = await provider.complete({
    task: 'Inspect visually',
    observation: { dom: { elements: [] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  assert.deepEqual(request.messages.at(-1).images, ['cG5n']);
  assert.doesNotMatch(request.messages.at(-1).content, /cG5n/);
  assert.deepEqual(request.options, { temperature: 0, num_predict: 4096 });
  assert.match(request.messages[0].content, /Reason briefly, never restate the task or history/);
  assert.match(request.messages[0].content, /similar existing content does not satisfy the requested initialization/);
  assert.match(request.messages[0].content, /browser_mousemove/);
  assert.match(request.messages[0].content, /never fake pointer placement with a click or drag/i);
  assert.equal(result.done.summary, 'saw image');
});

test('Ollama provider retries with DOM evidence when the selected model rejects images', async () => {
  const requests = [];
  const provider = createOllamaProvider({
    model: 'text-model',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      if (requests.length === 1) return jsonResponse({ error: 'image input is not supported' }, { ok: false, status: 400, statusText: 'Bad Request' });
      return jsonResponse({ message: { content: '{"done":{"summary":"used DOM","success":true}}' } });
    }
  });

  const result = await provider.complete({
    task: 'Inspect',
    observation: { dom: { title: 'Visible page', elements: [] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages.at(-1).images, ['cG5n']);
  assert.equal(requests[1].messages.at(-1).images, undefined);
  assert.match(requests[1].messages.at(-1).content, /Visible page/);
  assert.equal(result.done.summary, 'used DOM');

  await provider.complete({
    task: 'Continue inspecting',
    observation: { dom: { title: 'Next visible state', elements: [] }, screenshot: { mimeType: 'image/png', data: 'bmV4dA==' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].messages.at(-1).images, undefined);
  assert.match(requests[2].messages.at(-1).content, /Next visible state/);
});

test('Ollama provider treats an explicit no-vision response as capability evidence and retries with DOM', async () => {
  const requests = [];
  const provider = createOllamaProvider({
    model: 'text-model',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      requests.push(body);
      return requests.length === 1
        ? jsonResponse({ message: { content: 'I cannot process the screenshot.' } })
        : jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_click","input":{"element":9}}]}' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue through visible controls',
    observation: { dom: { elements: [{ index: 9, name: 'Text tool' }] }, screenshot: { mimeType: 'image/png', data: 'cG5n' } },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].messages.at(-1).images, ['cG5n']);
  assert.equal(requests[1].messages.at(-1).images, undefined);
  assert.equal(result.toolCalls[0].name, 'browser_click');
});

test('bounded conversation context keeps the first turn and the latest follow-ups', () => {
  const messages = Array.from({ length: 18 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user',
    content: index === 0 ? 'Original prompt' : `Turn ${index}`
  }));
  const context = boundedRequestContext({ task: 'Continue', observation: {}, history: [], messages, tools: [] });

  assert.equal(context.messages.length, 12);
  assert.equal(context.messages[0].content, 'Original prompt');
  assert.equal(context.messages.at(-1).content, 'Turn 17');
});

test('provider includes bounded recovery context so the next decision can correct the last error', () => {
  const context = boundedRequestContext({
    task: 'Search the site',
    observation: { navigation: { url: 'https://example.test/' }, dom: { elements: [] } },
    history: [{ tool: 'browser_execute', input: { script: 'return null;' }, output: { ok: false, error: 'The search form did not expose an input field.' } }],
    recovery: { attempts: 2, source: 'browser_action', action: 'browser_execute', lastError: 'The search form did not expose an input field.' },
    tools: []
  });

  assert.deepEqual(context.recovery, {
    attempts: 2,
    source: 'browser_action',
    action: 'browser_execute',
    lastError: 'The search form did not expose an input field.'
  });
  assert.match(JSON.stringify(context.history), /search form/i);
});

test('provider accepts native Ollama tool calls when content is empty', async () => {
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => jsonResponse({ message: { content: '', tool_calls: [{ function: { name: 'browser_click', arguments: { element: 5 } } }] } })
  });
  const result = await provider.complete({ task: 'Click search', observation: {}, history: [], tools: [] });
  assert.equal(result.toolCalls[0].name, 'browser_click');
  assert.deepEqual(result.toolCalls[0].input, { element: 5 });
  assert.match(result.toolCalls[0].callId, /^local-/);
});

test('provider repairs one malformed structured response and bounds history', async () => {
  const requests = [];
  const replies = [
    jsonResponse({ message: { content: 'I will click the search button.' } }),
    jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_observe","input":{}}]}' } })
  ];
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body)); return replies.shift(); }
  });
  const history = Array.from({ length: 35 }, (_, index) => ({ step: index, tool: 'browser_wait', input: {}, output: { ok: true, result: { waitedMs: index } } }));
  const result = await provider.complete({ task: 'Continue', observation: {}, history, tools: [] });
  assert.equal(result.toolCalls[0].name, 'browser_observe');
  assert.equal(requests.length, 2);
  // Older entries are collapsed to stubs, not dropped: the full step/tool
  // record survives while only the last 12 carry detailed payloads.
  const boundedHistory = JSON.parse(requests[0].messages.at(-1).content).history;
  assert.equal(boundedHistory.length, 35);
  assert.equal(boundedHistory.slice(0, 23).every((entry) => entry.outcome === '[older action — details cleared; confirmed outcomes are in doneList]' && entry.tool === 'browser_wait'), true);
  assert.equal(boundedHistory.slice(-12).every((entry) => entry.input !== undefined && entry.output !== undefined), true);
});

test('provider repairs a duplicate-recovery action into a different grounded tool', async () => {
  const requests = [];
  const provider = createOllamaProvider({
    model: 'agent-model',
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      requests.push(request);
      return requests.length === 1
        ? jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_screenshot","input":{}}]}' } })
        : jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_click","input":{"element":49}}]}' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue editing',
    observation: { dom: { elements: [{ index: 49, name: 'Rectangle tool' }] } },
    history: [], messages: [], coordinator: { observationRevision: 2 }, plan: [], tools: [],
    recovery: { attempts: 1, source: 'duplicate_action', action: 'browser_screenshot', lastError: 'The screenshot is already attached.' }
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].options, { temperature: 0, num_predict: 1024 });
  const repair = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(repair.disallowedAction, 'browser_screenshot');
  assert.equal(result.toolCalls[0].name, 'browser_click');
});

test('provider repairs a prose-only completion into one executable terminal decision', async () => {
  const requests = [];
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? jsonResponse({ message: { content: '{"assistantText":"The circle is already red."}' } })
        : jsonResponse({ message: { content: '{"done":{"summary":"Verified red circle.","success":true}}' } });
    }
  });

  const observation = {
    navigation: { url: 'https://studio.example.test/' },
    dom: { title: 'Studio', elements: [{ index: 7, tag: 'div', name: 'Ellipse', text: 'Ellipse' }] }
  };
  const tools = [{ name: 'browser_done', input: { summary: 'string', success: 'boolean' } }];
  const result = await provider.complete({ task: 'Create a red circle', observation, history: [], tools });

  assert.equal(requests.length, 2);
  assert.equal(result.done.success, true);
  const repairContext = JSON.parse(requests[1].messages[1].content);
  assert.match(repairContext.instruction, /browser action or done JSON/i);
  assert.equal(repairContext.observation.dom.elements[0].name, 'Ellipse');
  assert.deepEqual(repairContext.tools, tools);
});

test('provider preserves streamed final text when the terminal chunk is only the response suffix', async () => {
  const thoughts = [];
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => streamingResponse([
      `${JSON.stringify({ message: { thinking: 'Checking the page.' }, done: false })}\n`,
      `${JSON.stringify({ message: { content: '{"assistantText":"The final ' }, done: false })}\n`,
      `${JSON.stringify({ message: { content: 'reply is visible.","done":{"summary":"The final reply is visible.","success":true,"verified":true}}' }, done: true })}\n`
    ])
  });

  const result = await provider.complete({ task: 'Say what you found', observation: {}, history: [], tools: [], onThought: (text) => thoughts.push(text) });

  assert.equal(result.assistantText, 'The final reply is visible.');
  assert.equal(result.done.summary, 'The final reply is visible.');
  assert.deepEqual(thoughts, ['Checking the page.']);
});

test('provider preserves the full local reasoning stream before one structural repair', async () => {
  const requests = [];
  const thoughts = [];
  const repeatedReasoning = 'Rechecking the same visible state without choosing an action. '.repeat(90);
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return requests.length === 1
        ? streamingResponse([`${JSON.stringify({ message: { thinking: repeatedReasoning }, done: false })}\n`])
        : jsonResponse({ message: { content: '{"toolCalls":[{"name":"browser_click","input":{"element":7}}]}' } });
    }
  });

  const result = await provider.complete({
    task: 'Continue editing', observation: { dom: { elements: [{ index: 7, name: 'Text tool' }] } },
    history: [], tools: [], onThought: (text) => thoughts.push(text)
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].options, { temperature: 0, num_predict: 1024 });
  assert.equal(result.toolCalls[0].name, 'browser_click');
  assert.equal(thoughts[0], repeatedReasoning);
});

test('provider keeps inline think tags out of final replies while preserving the thought channel', async () => {
  const thoughts = [];
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => streamingResponse([
      `${JSON.stringify({ message: { content: '<think>I can see the canvas elements.' }, done: false })}\n`,
      `${JSON.stringify({ message: { content: '</think>{"assistantText":"The canvas contains one ellipse.","done":{"summary":"The canvas contains one ellipse.","success":true,"verified":true}}' }, done: true })}\n`
    ])
  });

  const result = await provider.complete({ task: 'What is on the canvas?', observation: {}, history: [], tools: [], onThought: (text) => thoughts.push(text) });

  assert.equal(result.assistantText, 'The canvas contains one ellipse.');
  assert.equal(result.done.summary, 'The canvas contains one ellipse.');
  assert.deepEqual(thoughts, ['I can see the canvas elements.']);
});

test('parser removes inline think blocks before reading a structured final answer', () => {
  const result = parseAgentResponse('<think>Internal browser analysis</think>{"done":{"summary":"The page is ready.","success":true}}');
  assert.equal(result.done.summary, 'The page is ready.');
});

test('provider retains a plain informational reply when its repair is also unstructured', async () => {
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => jsonResponse({ message: { content: 'The canvas contains one ellipse.' } })
  });

  const result = await provider.complete({ task: 'What is on the canvas?', observation: {}, history: [], tools: [] });

  assert.equal(result.assistantText, 'The canvas contains one ellipse.');
  assert.deepEqual(result.done, { summary: 'The canvas contains one ellipse.', success: true, verified: false });
});

test('provider never converts an unstructured mutation request into a terminal answer', async () => {
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => jsonResponse({ message: { content: 'I will delete the selected item.' } })
  });

  await assert.rejects(
    () => provider.complete({ task: 'Delete the selected item', observation: {}, history: [], tools: [] }),
    /could not be understood|structured-response repair/i
  );
});

test('provider never paints language-labelled command JSON as an informational reply', async () => {
  const provider = createOllamaProvider({
    model: 'agent-model',
    fetchImpl: async () => jsonResponse({ message: { content: 'json\n{"browser_fill":{"element":68,"text":"Page name"}}' } })
  });

  await assert.rejects(
    () => provider.complete({ task: 'Rename the page', observation: { dom: { elements: [{ index: 68, name: 'Page name' }] } }, history: [], tools: [] }),
    /structured|executable|agent json shape/i
  );
});

test('provider rejects an internal schema template rather than exposing it as a reply', () => {
  assert.throws(
    () => parseAgentResponse('{"assistantText":"ready","toolCalls":[{"name":"browser_done","input":{"summary":"Structured response check","success":false}}]}'),
    /internal response template/i
  );
});

test('provider accepts a fenced JSON object but rejects malformed tool calls', async () => {
  const provider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => jsonResponse({
      message: { content: '```json\n{"assistantText":"Inspecting","toolCalls":[{"name":"browser_observe","input":{}}]}\n```' }
    })
  });

  const result = await provider.complete({ task: 'Inspect', observation: {}, history: [], tools: [] });
  assert.equal(result.toolCalls[0].name, 'browser_observe');

  const invalidProvider = createOllamaProvider({
    model: 'kimi-k2.7',
    fetchImpl: async () => jsonResponse({ message: { content: '{"toolCalls":"not-an-array"}' } })
  });
  await assert.rejects(
    () => invalidProvider.complete({ task: 'Inspect', observation: {}, history: [], tools: [] }),
    /valid agent JSON/i
  );
});
