import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { probeModelInput, probeModelsForCapability, classifyProbeOutcome, probeCacheKey, loadProbeCache, freshProbe } = require('../desktop/agent/modelCapabilityProbe.cjs');

const ok = { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'y' } }] }) };
const noVideo = { ok: false, status: 400, text: async () => 'video content is not supported for this model' };
const badShape = { ok: false, status: 400, text: async () => 'unknown field: video_url' };
const rateLimited = { ok: false, status: 429, text: async () => 'slow down' };

test('classify: modality-naming 4xx is a real NO, shape errors are inconclusive, 429 unknown', async () => {
  assert.deepEqual(classifyProbeOutcome(noVideo, await noVideo.text()), { supported: false, conclusive: true, reason: 'video content is not supported for this model' });
  assert.equal(classifyProbeOutcome(badShape, 'unknown field: video_url').conclusive, false, 'a rejected SHAPE proves nothing');
  assert.equal(classifyProbeOutcome(rateLimited, 'slow down').conclusive, false);
  assert.deepEqual(classifyProbeOutcome(ok, ''), { supported: true, conclusive: true });
});

test('probeModelInput tries multiple content shapes before concluding anything', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    seen.push(body.messages[0].content[1].type);
    return seen.length === 1 ? badShape : ok; // first shape rejected, second works
  };
  const outcome = await probeModelInput({ baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'm', modality: 'video', fetchImpl });
  assert.equal(outcome.supported, true);
  assert.equal(outcome.workingShape, 'file', 'reports WHICH shape worked');
  assert.deepEqual(seen, ['video_url', 'file'], 'shape fallback actually happened');
});

test('probeModelsForCapability: bounded budget, cache reuse, only inconclusive re-probe', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return /p2/.test(calls[calls.length - 1]) ? noVideo : ok;
  };
  const cache = { entries: {}, dirty: false };
  const first = await probeModelsForCapability({ models: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'], baseUrl: 'https://gw.example/v1', apiKey: 'k', modality: 'video', cache, budget: 3, fetchImpl });
  assert.equal(first.probed, 3, 'hard budget: never more probes than the budget');
  assert.equal(first.deferred, 5, 'the rest are deferred, not silently probed');
  assert.equal(first.results.p1.supported, true);
  assert.equal(first.results.p2.supported, false, 'modality-naming 400 = conclusive no');
  assert.ok(cache.dirty);
  const saved = JSON.stringify(cache.entries);
  const second = await probeModelsForCapability({ models: ['p1', 'p2'], baseUrl: 'https://gw.example/v1', apiKey: 'k', modality: 'video', cache, budget: 3, fetchImpl });
  assert.equal(calls.length, 3, 'cached conclusive results are not re-probed');
  assert.equal(second.probed, 0);
  assert.equal(JSON.stringify(cache.entries), saved);
});

test('probe cache keys isolate per endpoint+model+modality and TTL-gate', () => {
  assert.notEqual(probeCacheKey({ baseUrl: 'https://a/v1', model: 'm', modality: 'video' }), probeCacheKey({ baseUrl: 'https://b/v1', model: 'm', modality: 'video' }));
  assert.notEqual(probeCacheKey({ baseUrl: 'https://a/v1', model: 'm', modality: 'video' }), probeCacheKey({ baseUrl: 'https://a/v1', model: 'm', modality: 'image' }));
  assert.equal(freshProbe({ result: { supported: true, conclusive: true }, at: Date.now() - 8 * 24 * 3600 * 1000 }), null, 'stale conclusive entries re-probe');
  const fsLike = { readFileSync: () => '{ not json', mkdirSync: () => {}, writeFileSync: () => {} };
  assert.deepEqual(loadProbeCache('x', { fsLike }).entries, {});
});
