import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runModelTask, inferModelKind, normalizeCustomModel, MODEL_KINDS } = require('../desktop/agent/mediaRouter.cjs');

const BASE = 'https://gateway.test/v1';

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    arrayBuffer: async () => Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function binaryResponse(status, buffer, contentType) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    text: async () => buffer.toString('binary'),
    arrayBuffer: async () => buffer,
  };
}

function callsTo(calls) {
  return (url, options = {}) => {
    calls.push({ url, options });
    return calls._next(calls.length - 1, { url, options });
  };
}

test('image generation returns the asset url from a synchronous response', async () => {
  const calls = [];
  const fetchImpl = callsTo(calls);
  calls._next = () => jsonResponse(200, { data: [{ url: 'https://cdn.test/pic.png' }] });
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'image', model: 'm1', prompt: 'a frame', fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://cdn.test/pic.png');
  assert.equal(result.model, 'm1');
  assert.equal(calls[0].url, `${BASE}/images/generations`);
});

test('async 202 job envelope is polled until the asset url arrives', async () => {
  const calls = [];
  let polls = 0;
  const fetchImpl = (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/images/generations') && calls.length === 1) {
      return Promise.resolve(jsonResponse(202, { id: 'job-1', object: 'image.generation.job', status: 'processing' }));
    }
    if (url.endsWith('/images/generations/job-1')) {
      polls += 1;
      if (polls < 2) return Promise.resolve(jsonResponse(200, { id: 'job-1', status: 'processing' }));
      return Promise.resolve(jsonResponse(200, { id: 'job-1', status: 'succeeded', data: [{ url: 'https://cdn.test/0.png' }] }));
    }
    return Promise.resolve(jsonResponse(404, { error: { message: 'nope' } }));
  };
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'image', model: 'm1', prompt: 'x', fetchImpl, pollIntervalMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.url, 'https://cdn.test/0.png');
  assert.ok(polls >= 2, 'the job must actually be polled');
});

test('a failed model falls back to the next same-kind candidate', async () => {
  const seen = [];
  const fetchImpl = (url) => {
    seen.push(url);
    if (url.includes('/images/generations') && !seen.some((u) => u !== url)) {
      return Promise.resolve(jsonResponse(403, { error: { message: 'paid model' } }));
    }
    return Promise.resolve(jsonResponse(200, { data: [{ url: 'https://cdn.test/fallback.png' }] }));
  };
  // The mock above is stateless per call, so model the paywall by body instead.
  const calls = [];
  const fetch2 = (url, options = {}) => {
    calls.push({ url, body: options.body || '' });
    if (calls.filter((c) => c.url.endsWith('/images/generations')).length === 1) {
      return Promise.resolve(jsonResponse(403, { error: { message: 'paid model' } }));
    }
    return Promise.resolve(jsonResponse(200, { data: [{ url: 'https://cdn.test/fallback.png' }] }));
  };
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'image', model: 'paid-model', prompt: 'x', fallbackModels: ['free-image-model'], fetchImpl: fetch2, pollIntervalMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'free-image-model');
  assert.ok(String(calls[0].body).includes('paid-model'));
  assert.ok(String(calls[1].body).includes('free-image-model'));
});

test('malformed JSON is recorded and the cycle continues', async () => {
  const calls = [];
  const fetch2 = (url) => {
    calls.push(url);
    if (calls.length === 1) return Promise.resolve(jsonResponse(200, '<html>not json</html>'));
    return Promise.resolve(jsonResponse(200, { data: [{ url: 'https://cdn.test/recovered.png' }] }));
  };
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'image', model: 'broken', prompt: 'x', fallbackModels: ['good'], fetchImpl: fetch2 });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'good');
});

test('tts sends the voice only when provided and returns a data URL', async () => {
  const calls = [];
  const audio = Buffer.from('ID3x' + 'a'.repeat(2000));
  const fetch2 = (url, options = {}) => { calls.push({ url, body: options.body || '' }); return Promise.resolve(binaryResponse(200, audio, 'audio/mpeg')); };
  const withVoice = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'tts', model: 'speaker-1', prompt: 'hello', voice: 'nova', fetchImpl: fetch2 });
  assert.equal(withVoice.ok, true);
  assert.match(withVoice.dataUrl, /^data:audio\/mpeg;base64,/);
  assert.ok(String(calls[0].body).includes('"voice":"nova"'));
  calls.length = 0;
  const withoutVoice = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'tts', model: 'speaker-1', prompt: 'hello', fetchImpl: fetch2 });
  assert.equal(withoutVoice.ok, true);
  assert.equal(String(calls[0].body).includes('alloy'), false, 'no hardcoded voice may be injected');
  assert.equal(String(calls[0].body).includes('voice'), false);
});

test('stt posts multipart and returns the transcript text', async () => {
  const calls = [];
  const fetch2 = (url, options = {}) => { calls.push({ url, options }); return Promise.resolve(jsonResponse(200, { text: 'hello world' })); };
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'stt', model: 'ears-1', prompt: '', fileBase64: Buffer.from('wav').toString('base64'), filename: 'a.wav', fetchImpl: fetch2 });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'hello world');
  assert.ok(calls[0].options.body instanceof FormData);
});

test('every candidate failing returns ok:false with per-model errors', async () => {
  const fetch2 = () => Promise.resolve(jsonResponse(403, { error: { message: 'paid model' } }));
  const result = await runModelTask({ baseUrl: BASE, apiKey: 'k', kind: 'image', model: 'm1', prompt: 'x', fallbackModels: ['m2'], fetchImpl: fetch2 });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((e) => e.model), ['m1', 'm2']);
  assert.ok(result.errors.every((e) => /paid model/.test(e.error)), 'the real provider error must reach the caller');
});

test('inferModelKind maps catalogue names without hardcoding any list', async () => {
  assert.equal(inferModelKind('openai/gpt-image-2.5'), 'image');
  assert.equal(inferModelKind('openai/sora-2'), 'video');
  assert.equal(inferModelKind('openai/whisper-large'), 'stt');
  assert.equal(inferModelKind('openai/tts-1'), 'tts');
  assert.equal(inferModelKind('anthropic/claude-opus-4.6'), 'language');
  assert.equal(inferModelKind('z-ai/glm-5'), 'language');
});

test('normalizeCustomModel keeps legacy strings working and preserves kinds', () => {
  assert.deepEqual(normalizeCustomModel('openai/gpt-image-2.5'), { id: 'openai/gpt-image-2.5', kind: 'image' });
  assert.deepEqual(normalizeCustomModel({ id: 'x', kind: 'video' }), { id: 'x', kind: 'video' });
  assert.deepEqual(normalizeCustomModel({ id: 'y', kind: 'bogus' }), { id: 'y', kind: 'language' });
  assert.deepEqual(MODEL_KINDS, ['language', 'image', 'tts', 'stt', 'video']);
});
