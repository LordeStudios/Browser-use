import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readOpenAiEventStream } = require('../desktop/agent/providers/wire.cjs');
const { createJevVerifier } = require('../desktop/agent/jevProvider.cjs');

function sseResponse(frames) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const chunk = (delta) => ({ choices: [{ delta }] });
// Real OpenAI-compatible streams carry function.name only on the FIRST delta
// of a tool call; later fragments carry arguments only.
const argChunk = (index, id, name, fragment) => chunk({ tool_calls: [{ index, id, type: 'function', ...(name ? { function: { name, arguments: fragment } } : { function: { arguments: fragment } }) }] });

test('fast path emits the first complete streamed tool call before the stream finishes', async () => {
  // Frame timeline: args complete in frame 3; the model keeps generating for
  // several frames afterwards (narration). The early call must land while
  // frames 4+ are still pending, not after the stream ends.
  const frames = [
    chunk({ content: 'I am going to click the order button. As I was saying, ' }),
    argChunk(0, 'c1', 'browser_click', '{"elem'),
    argChunk(0, 'c1', null, 'ent": 1}'),
    chunk({ content: 'this action places the order because the checkout summary is correct and the payment method was already selected earlier in the conversation' }),
    chunk({ content: ' and the inventory is confirmed and the address matches and nothing else needs checking.' })
  ];
  let responseResolved = false;
  const slow = sseResponse(frames.length ? frames : []).body;
  // Rebuild with artificial pacing so the debounce window sits inside the stream.
  const encoder = new TextEncoder();
  const paced = new ReadableStream({
    async start(controller) {
      for (const frame of frames.slice(0, 3)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      // Quiet period longer than the debounce while the model "narrates".
      await new Promise((resolve) => setTimeout(resolve, 320));
      responseResolved = false;
      for (const frame of frames.slice(3)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  void slow; void responseResolved;
  let earlyCall = null;
  let streamFinished = false;
  const readPromise = readOpenAiEventStream(new Response(paced, { status: 200 }), null, () => { streamFinished = true; }, (call) => { earlyCall = call; });
  await readPromise;
  assert.ok(earlyCall, 'the fast path fired');
  assert.equal(earlyCall.name, 'browser_click');
  assert.deepEqual(earlyCall.input, { element: 1 });
});

test('multi-key arguments emit only when the object genuinely closes', async () => {
  // Realistic stream shape: {"element": 1, then "x": 100, then "y": 200}.
  // No intermediate fragment parses as complete JSON, so the debounce can
  // never execute a prefix; the emit carries the complete arguments.
  const frames = [
    argChunk(0, 'c1', 'browser_click', '{"element": 1,'),
    argChunk(0, 'c1', null, '"x": 100,'),
    argChunk(0, 'c1', null, '"y": 200}'),
    chunk({ content: 'done.' })
  ];
  const encoder = new TextEncoder();
  const paced = new ReadableStream({
    async start(controller) {
      for (const frame of frames.slice(0, 3)) controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      await new Promise((resolve) => setTimeout(resolve, 320));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frames[3])}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    }
  });
  let earlyCall = null;
  await readOpenAiEventStream(new Response(paced, { status: 200 }), null, null, (call) => { earlyCall = call; });
  assert.ok(earlyCall, 'the fast path fired once the full arguments settled');
  assert.equal(earlyCall.name, 'browser_click');
  assert.deepEqual(earlyCall.input, { element: 1, x: 100, y: 200 }, 'only the complete arguments were handed over');
});

test('non-action narration alone never fires the fast path', async () => {
  let earlyCall = null;
  const frames = [
    chunk({ content: 'I will click the button shortly. ' }),
    chunk({ content: 'First let me explain the plan in detail for several sentences. ' }),
    chunk({ content: 'The plan continues here.' })
  ];
  await readOpenAiEventStream(sseResponse(frames), null, null, (call) => { earlyCall = call; });
  assert.equal(earlyCall, null);
});

test('jev confirmAction approves a confident safe action and fails closed on errors', async () => {
  const answers = { execute_now: { type: 'noul', noul: 0.93 } };
  const verifier = createJevVerifier({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(body.questions.execute_now.type, 'noul');
    return Response.json({ answers });
  } });
  const verdict = await verifier.confirmAction({ action: { name: 'browser_click', input: { element: 3 } }, task: 'Place the order' });
  assert.equal(verdict.ok, true);

  const reject = createJevVerifier({ apiKey: 'fixture-key', fetchImpl: async () => Response.json({ answers: { execute_now: { type: 'noul', noul: 0.4 } } }) });
  assert.equal((await reject.confirmAction({ action: { name: 'browser_click', input: { element: 3 } }, task: 'x' })).ok, false);

  const dead = createJevVerifier({ apiKey: 'fixture-key', fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await dead.confirmAction({ action: { name: 'browser_click', input: { element: 3 } }, task: 'x' })).ok, false, 'fail closed');
});
