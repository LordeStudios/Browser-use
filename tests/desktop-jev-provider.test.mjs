import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createJevVerifier, normalizeAnswers, DEFAULT_JEV_BASE_URL, DEFAULT_JEV_MODEL } = require('../desktop/agent/jevProvider.cjs');

const observation = {
  navigation: { url: 'https://example.test/checkout' },
  dom: { title: 'Checkout', elements: [{ index: 1, tag: 'button', text: 'Place order' }] }
};

function response(answers) {
  return new Response(JSON.stringify({ model: DEFAULT_JEV_MODEL, answers, usage: { input_tokens: 10, output_tokens: 4 } }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('Jev verifier posts typed System One questions with secure bearer auth', async () => {
  let request = null;
  const verifier = createJevVerifier({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    request = { url, options };
    return response({
      page_changed: { type: 'noul', noul: 0.95 },
      best_next_target: { type: 'choice', choice: 'button Place order (button)', confidence: 0.91 }
    });
  } });
  const result = await verifier.verify({ observation, action: { name: 'browser_click', ok: true }, task: 'Place the order', domain: 'browser' });
  assert.equal(request.url, `${DEFAULT_JEV_BASE_URL}/systemone`);
  assert.equal(request.options.headers.authorization, 'Bearer fixture-key');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, DEFAULT_JEV_MODEL);
  assert.equal(body.state.task, 'Place the order');
  assert.equal(body.questions.page_changed.type, 'noul');
  assert.equal(body.questions.best_next_target.type, 'choice');
  assert.equal(result.layer, 'jev');
  assert.equal(result.brain, 'jev');
  assert.equal(result.answers.page_changed.value, 0.95);
  assert.equal(result.answers.page_changed.confidence, 0.9);
});

test('noul probability becomes calibrated certainty without requiring a nonexistent confidence field', () => {
  const answers = normalizeAnswers({ yes: { type: 'noul', noul: 0.9 }, uncertain: { type: 'noul', noul: 0.6 } });
  assert.equal(answers.yes.confidence, 0.8);
  assert.equal(answers.uncertain, undefined);
});

test('Jev failures fall back to bundled Laya without throwing or exposing the key', async () => {
  let fallbackCalls = 0;
  const verifier = createJevVerifier({ apiKey: 'fixture-key', fetchImpl: async () => { throw new Error('network down'); }, fallback: {
    verify: async () => { fallbackCalls += 1; return { layer: 'laya', brain: 'bundled', answers: {}, used: false }; }
  } });
  const result = await verifier.verify({ observation, action: { name: 'browser_click', ok: true }, task: 'Place the order', domain: 'browser' });
  assert.equal(fallbackCalls, 1);
  assert.equal(result.layer, 'laya');
  assert.equal(JSON.stringify(result).includes('fixture-key'), false);
});

test('missing Jev key degrades to fallback', async () => {
  let fallbackCalls = 0;
  const verifier = createJevVerifier({ fallback: { verify: async () => { fallbackCalls += 1; return { layer: 'laya', answers: {} }; } } });
  await verifier.verify({ observation, action: { name: 'browser_click', ok: true }, task: 'x', domain: 'browser' });
  assert.equal(fallbackCalls, 1);
});
