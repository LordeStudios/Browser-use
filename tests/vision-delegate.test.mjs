import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickVisionModel, describeImage, createVisionDescriber } = require('../desktop/agent/visionDelegate.cjs');

test('pickVisionModel: vision-capable only, cheapest first, active text-only model excluded', () => {
  const models = [
    { id: 'text-only-model', capabilities: {} },
    { id: 'premium-vision', capabilities: { vision: true }, pricing: { input: 5 } },
    { id: 'cheap-vision', capabilities: { vision: true }, pricing: { input: 0.1 } },
    { id: 'no-caps-object', pricing: { input: 0 } }
  ];
  assert.equal(pickVisionModel(models, 'text-only-model'), 'cheap-vision');
  assert.equal(pVision(models), 'cheap-vision');
  function pVision(list) { return pickVisionModel(list, ''); }
  assert.equal(pickVisionModel(models, 'cheap-vision'), 'premium-vision', 'the active model is never its own delegate');
  assert.equal(pickVisionModel([{ id: 'text-only' }], 'other'), null, 'no vision model → honest none');
});

test('describeImage posts the image part and returns the text; failures are honest', async () => {
  let captured = null;
  const ok = await describeImage({
    baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'vision-m',
    image: { mimeType: 'image/png', data: 'AAAA' },
    fetchImpl: async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'A login form with 2 fields.' } }] }) }; }
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, 'A login form with 2 fields.');
  assert.equal(captured.body.messages[0].content[1].image_url.url, 'data:image/png;base64,AAAA');
  const dead = await describeImage({ baseUrl: 'https://127.0.0.1:9/v1', apiKey: 'k', model: 'm', image: { data: 'AAAA' }, fetchImpl: globalThis.fetch });
  assert.equal(dead.ok, false);
  const noImage = await describeImage({ baseUrl: 'https://gw.example/v1', model: 'm', fetchImpl: async () => { throw new Error('never'); } });
  assert.equal(noImage.ok, false);
});

test('createVisionDescriber: resolves the model once, caches, honest none, wired into the provider', async () => {
  let modelFetches = 0;
  const describe = createVisionDescriber({
    baseUrl: 'https://gw.example/v1', apiKey: 'k', excludeModel: 'text-only',
    fetchImpl: async (url) => {
      if (String(url).endsWith('/models')) { modelFetches += 1; return { ok: true, status: 200, json: async () => ({ data: [{ id: 'text-only', capabilities: {} }, { id: 'vision-m', capabilities: { vision: true }, pricing: { input: 1 } }] }) }; }
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'desc' } }] }) };
    }
  });
  const first = await describe({ image: { data: 'AAAA' } });
  assert.equal(first.ok, true);
  const second = await describe({ image: { data: 'AAAA' } });
  assert.equal(second.ok, true);
  assert.equal(modelFetches, 1, 'the vision model resolves once per cache window');
  const none = createVisionDescriber({ baseUrl: 'https://gw.example/v1', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'text-only', capabilities: {} }] }) }) });
  const result = await none({ image: { data: 'AAAA' } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no vision-capable model/);
  const src = require('fs').readFileSync(require('path').join(process.cwd(), 'desktop/agent/openAiCompatibleProvider.cjs'), 'utf8');
  assert.match(src, /delegatedVision: \{ via: delegatedVision\.model/, 'the description rides the context as text evidence');
  const ollama = require('fs').readFileSync(require('path').join(process.cwd(), 'desktop/agent/ollamaProvider.cjs'), 'utf8');
  assert.match(ollama, /delegatedVision:/, 'boundedRequestContext carries the delegated description');
});
