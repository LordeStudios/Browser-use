import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { compactModelEntry } = require('../desktop/agent/modelCatalog.cjs');

test('compactModelEntry preserves quality/price metadata and EVERY advertised capability flag', () => {
  const rich = compactModelEntry({
    id: 'google/gemini-3.6-flash', display_name: 'Gemini 3.6 Flash',
    pricing: { input: 0.75, output: 3.75 },
    capabilities: { vision: true, tools: true, reasoning: true, video: true },
    context_length: 1000000, max_output_tokens: 65536, access_tier: 'paid'
  }, 'lang');
  assert.equal(rich.caps.includes('video'), true, 'future capability flags survive without a patch');
  assert.deepEqual(rich.usdPerM, [0.75, 3.75]);
  const free = compactModelEntry({ id: 'qwen/x:free', pricing: { input: 0, output: 0 } }, 'lang');
  assert.deepEqual(free.usdPerM, [0, 0]);
  assert.equal(compactModelEntry({ id: ' ' }, 'lang'), null);
  assert.equal(compactModelEntry(null, 'lang'), null);
});

test('catalogResponse: summary mode tallies facets; filtered mode answers capability questions', () => {
  const { catalogResponse } = require('../desktop/agent/modelCatalog.cjs');
  const rows = [{
    id: 'c1', provider: 'xkiro', baseUrlHost: 'api.xkiro.com', selectedModel: 'z-ai/glm-5.3-flash',
    isActive: true, hasApiKey: true, modelsCount: 4, savedOnlyCount: 1, liveCatalog: '3 models discovered live',
    models: [
      { id: 'a', kind: 'language', caps: ['vision', 'tools', 'reasoning'], usdPerM: [5, 25], ctx: 1000000, tier: 'paid' },
      { id: 'b', kind: 'language', caps: ['tools', 'reasoning'], usdPerM: [0.1, 0.4], ctx: 200000, tier: 'paid' },
      { id: 'c', kind: 'image', usdPerM: [0, 0], ctx: 0, tier: 'free' },
      { id: 'd', kind: 'tts', usdPerM: [0, 0], tier: 'free' }
    ]
  }];
  const extras = { activeConnectionId: 'c1', cloud: {}, ollama: {} };
  const summary = catalogResponse(extras, rows, {});
  assert.equal(summary.mode, 'summary');
  assert.equal(summary.connections[0].modelsCount, 4);
  assert.deepEqual(summary.connections[0].byKind, { language: 2, image: 1, tts: 1 });
  assert.deepEqual(summary.connections[0].byCap, { vision: 1, tools: 2, reasoning: 2 }, 'facet counts answer capability questions without the full list');
  assert.equal(summary.connections[0].byCap.video, undefined, 'an unadvertised capability is absent, not zero-guessed');
  assert.equal(summary.connections[0].cheapestPaid, 'b');
  assert.equal(summary.connections[0].largestContext, 'a');

  const vision = catalogResponse(extras, rows, { cap: 'vision' });
  assert.equal(vision.mode, 'filtered');
  assert.equal(vision.matchedCount, 1);
  assert.equal(vision.models[0].id, 'a');
  const video = catalogResponse(extras, rows, { cap: 'video' });
  assert.equal(video.matchedCount, 0, 'unadvertised capability filters to an honest empty set');
  const cheap = catalogResponse(extras, rows, { maxInputUsd: 1, limit: 1 });
  assert.equal(cheap.matchedCount, 3, 'the two free entries (0 USD) and b (0.1) all pass the ceiling');
  assert.equal(cheap.returnedCount, 1);
  assert.match(cheap.note, /3 matched/);
  const langAlias = catalogResponse(extras, rows, { kind: 'lang' });
  assert.equal(langAlias.matchedCount, 2, 'lang aliases to language');
  const search = catalogResponse(extras, rows, { search: 'GPT' });
  assert.equal(search.matchedCount, 0);
  const searched = catalogResponse(extras, rows, { search: 'a' });
  assert.ok(searched.matchedCount >= 1);
});
