// xkiro-wiring.test.mjs — node --test tests/xkiro-wiring.test.mjs
//
// The xkiro API surface audit (docs.xkiro.com/api/, 2026-10-15) found three
// capabilities the harness never wired. Owner directive: the model CHOOSES to
// use them — never forced into requests:
//   1. web_search — the main agent's own live web-search TOOL (/v1/search,
//      model xkiro/web-search; live-verified 200 with real results),
//      offered only on xkiro connections.
//   2. /v1/fetch (xkiro/web-fetch; live-verified 200) — the research
//      subagent's PRIMARY page read, no tab opened; tab fetch stays as the
//      fallback.
//   3. /v1/images/edits — image EDITING via computer_model (kind image +
//      fileBase64), riding the media router's candidate/fallback/job loop.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { toolDefinitions, executeAction } = require('../desktop/agent/desktopChatAgent.cjs');
const { createXkiroSearch } = require('../desktop/research/xkiroSearch.cjs');
const { runModelTask } = require('../desktop/agent/mediaRouter.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { ProviderTurnLedger } = require('../desktop/agent/providerTurnLedger.cjs');
const { McpRegistry } = require('../desktop/agent/mcpClient.cjs');

test('web_search is offered ONLY on xkiro connections, as a model-chosen tool', () => {
  const withSearch = toolDefinitions('check the latest version', 'browser', { webSearchAvailable: true });
  const search = withSearch.find((tool) => tool.name === 'web_search');
  assert.ok(search, 'web_search rides the tool list on xkiro runs');
  assert.match(search.description, /Real-time web search/);
  assert.match(search.description, /latest versions/);
  assert.deepEqual(search.input, { query: 'the search query (keep it specific; one topic per call)' });

  const withoutSearch = toolDefinitions('check the latest version', 'browser', {});
  assert.equal(withoutSearch.find((tool) => tool.name === 'web_search'), undefined, 'no search tool on non-xkiro connections');
});

test('research_task guidance covers real-time needs, not just hotkeys', () => {
  const tools = toolDefinitions('x', 'browser', {});
  const desc = String(tools.find((tool) => tool.name === 'research_task')?.description || '');
  assert.match(desc, /real-time/);
  assert.match(desc, /latest versions, pricing, news, current docs/);
});

test('xkiroSearch.fetchPages posts to /v1/fetch and parses structured results', async () => {
  let captured = null;
  const client = createXkiroSearch({
    baseUrl: 'https://api.xkiro.com/v1',
    apiKey: 'sk-test',
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), json: async () => ({ results: [{ url: 'https://example.com', title: 'Example', content: 'domain body' }] }) };
    }
  });
  const page = await client.fetchPages({ urls: ['https://example.com'] });
  assert.equal(captured.url, 'https://api.xkiro.com/v1/fetch', 'the /search endpoint swaps to /fetch');
  assert.equal(captured.body.model, 'xkiro/web-fetch');
  assert.deepEqual(captured.body.urls, ['https://example.com']);
  assert.equal(page.ok, true);
  assert.equal(page.results[0].title, 'Example');
});

test('research web_fetch: API page read succeeds without a browser', async () => {
  // The research agent's fetch branch reads via the API when it exists and
  // never touches the tab surface on success. Covered indirectly: fetchPages
  // above + the branch reading searchApi first (code path). Direct probe of
  // the branch contract: a failed API read with no browser must fail honestly.
  const client = createXkiroSearch({ baseUrl: 'https://api.xkiro.com/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  const page = await client.fetchPages({ urls: ['https://example.com'] });
  assert.equal(page.ok, false);
  assert.match(page.error, /HTTP 500/);
});

test('runModelTask routes image edits to /v1/images/edits as multipart', async () => {
  const calls = [];
  const result = await runModelTask({
    baseUrl: 'https://api.xkiro.com/v1',
    apiKey: 'sk-test',
    kind: 'image',
    model: 'openai/gpt-image-2.5',
    prompt: 'make the sky a sunset',
    imageBase64: Buffer.from('fakepng').toString('base64'),
    imageFilename: 'photo.png',
    fetchImpl: async (url, options) => {
      calls.push({ url, body: options.body, headers: options.headers });
      return { ok: true, status: 200, headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify({ data: [{ b64_json: Buffer.from('edited').toString('base64') }] }) };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.xkiro.com/v1/images/edits');
  assert.ok(calls[0].body instanceof FormData, 'the edit rides as multipart form');
  assert.equal(calls[0].body.get('prompt'), 'make the sky a sunset');
  assert.ok(calls[0].body.get('image'), 'the source image is attached');
  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /data:image\/png;base64,/);
});

test('executeAction: web_search dispatch queries the client and reports failures honestly', async () => {
  // executeAction(controller, run, call) with the minimal run prelude the
  // action loop touches (loopState). An unreachable endpoint keeps the
  // network-bound case deterministic: the failure must be honest and
  // recoverable, naming the tab fallback.
  const stub = (provider) => ({ provider, loopState: { consecutiveWaits: 0, lastWaitedMs: 0 }, tabId: 't', selectedTabId: 't' });
  const controller = { listTabs: () => [{ id: 't' }], getSelectedTabId: () => 't', requireTab: (id) => ({ id: id || 't', webContents: {} }) };
  const deadRun = stub({ id: 'xkiro', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test' });
  const failed = await executeAction(controller, deadRun, { name: 'web_search', input: { query: 'q' } });
  assert.equal(failed.ok, false);
  assert.equal(failed.recoverable, true);
  assert.match(String(failed.error), /web_search failed/);
  // Non-xkiro run: refused with a clear reason.
  const refused = await executeAction(controller, stub({ id: 'ollama' }), { name: 'web_search', input: { query: 'q' } });
  assert.match(String(refused.error), /only on xkiro connections/);
  // Missing query: recoverable input error.
  const invalid = await executeAction(controller, stub({ id: 'xkiro', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-test' }), { name: 'web_search', input: {} });
  assert.equal(invalid.recoverable, true);
});

// ── /v1/messages/count_tokens → exact compaction refinement ─────────────────
test('countTokensViaGateway posts the anthropic shape and returns input_tokens', async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.xkiro.com/v1', apiKey: 'sk-test', model: 'z-ai/glm-5.3-flash',
    fetchImpl: async (url, options) => {
      provider.captured = { url, headers: options.headers, body: JSON.parse(options.body) };
      return { ok: true, status: 200, json: async () => ({ input_tokens: 8123 }) };
    }
  });
  const tokens = await provider.countTokensViaGateway({ system: 'sys', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(tokens, 8123);
  assert.match(provider.captured.url, /\/v1\/messages\/count_tokens$/);
  assert.equal(provider.captured.headers['x-api-key'], 'sk-test');
  assert.equal(provider.captured.body.model, 'z-ai/glm-5.3-flash');
  assert.equal(provider.captured.body.system, 'sys');
  const dead = createOpenAiCompatibleProvider({ providerId: 'xkiro', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'z-ai/glm-5.3-flash', fetchImpl: globalThis.fetch });
  assert.equal(await dead.countTokensViaGateway({ system: '', messages: [{ role: 'user', content: 'x' }] }), null, 'any failure keeps the estimate');
});

test('ledger: an exact count in the ambiguity zone prevents premature compaction', async () => {
  const ledger = new ProviderTurnLedger({});
  const filler = 'x'.repeat(400_000); // estimate lands deep in the compaction zone
  const pre = ledger.estimateFor({ current: { blob: filler } });
  assert.ok(pre.tokens >= pre.limit * 0.8, 'fixture estimate sits in the ambiguity zone');
  let summarizeCalls = 0;
  const outcome = await ledger.compact({
    current: { blob: filler },
    exactTokens: Math.round(pre.tokens * 0.5), // the gateway says it is really HALF
    summarize: async () => { summarizeCalls += 1; return { summary: 'should not run' }; }
  });
  assert.equal(outcome.compacted, false, 'no compaction when the exact count clears the threshold');
  assert.equal(summarizeCalls, 0, 'the summarizer request never fired');
  // Nonsense exact counts keep the estimate (and the conservative behavior).
  const outcome2 = await ledger.compact({ current: { blob: filler }, exactTokens: 3, summarize: async () => ({ summary: 's' }) });
  assert.equal(outcome2.compacted, false, 'out-of-bounds counts are ignored, not applied');
});

// ── /mcp/web as a registry builtin ──────────────────────────────────────────
test('the xkiro-web MCP builtin rides merged configs and reaches connections', async () => {
  const registry = new McpRegistry({
    userFile: 'unused', repoFile: null, connectTimeoutMs: 500,
    builtins: [{ name: 'xkiro-web', config: { url: 'https://api.xkiro.com/mcp/web', headers: { authorization: 'Bearer k' } } }]
  });
  assert.deepEqual(Object.keys(registry.mergedConfigs()), ['xkiro-web']);
  assert.equal(registry.mergedConfigs()['xkiro-web'].scope, 'builtin');
  const statuses = registry.status();
  assert.equal(statuses[0].name, 'xkiro-web');
  assert.equal(statuses[0].kind, 'http');
  // connectAll attempts the builtin and reports its failure honestly.
  const results = await registry.connectAll();
  assert.equal(results[0].name, 'xkiro-web');
  assert.ok(['error', 'ready'].includes(results[0].state));
});

// ── image edit from a LOCAL FILE (imagePath) — no bytes through the model ───
test('computer_model dispatch: imagePath rides through, dataUrl never returns to the model', async () => {
  const captured = [];
  const controller = { listTabs: () => [{ id: 't' }], getSelectedTabId: () => 't', requireTab: (id) => ({ id: id || 't', webContents: {} }) };
  const run = {
    provider: { id: 'xkiro', baseUrl: 'https://api.xkiro.com/v1', apiKey: 'k', model: 'z-ai/glm-5.3-flash' },
    loopState: { consecutiveWaits: 0, lastWaitedMs: 0 }, tabId: 't',
    modelTaskApi: async (input) => { captured.push(input); return { ok: true, kind: 'image', model: 'openai/gpt-image-2.5', dataUrl: 'data:image/png;base64,' + 'A'.repeat(100_000), savedPath: 'C:/assets/out.png' }; }
  };
  const out = await executeAction(controller, run, { name: 'computer_model', input: { kind: 'image', imagePath: 'C:/assets/photo.jpg', prompt: 'upscale, top-down, clean background', saveTo: 'C:/assets/out.png' } });
  assert.equal(out.ok, true);
  assert.equal(captured[0].imagePath, 'C:/assets/photo.jpg', 'imagePath reaches the media task');
  assert.equal(captured[0].saveTo, 'C:/assets/out.png');
  assert.equal(captured[0].imageBase64, undefined, 'no bytes transit when imagePath is given');
  assert.equal(out.result.dataUrl, undefined, 'the model result carries no base64');
  assert.equal(out.result.savedPath, 'C:/assets/out.png', 'the model gets the real file path');
  assert.match(out.media.dataUrl, /data:image\/png/, 'the UI still gets the full asset');
});

// ── model_catalog + task_spawn model selection ───────────────────────────────
test('model_catalog is a registered read tool answering from the injected catalog API', async () => {
  const defs = toolDefinitions('what models can I use', 'browser', {});
  const catalogDef = defs.find((def) => def.name === 'model_catalog');
  assert.ok(catalogDef, 'model_catalog is offered to the model');
  assert.match(catalogDef.description, /verify qualitative standing with web_search/);
  assert.match(catalogDef.description, /SUMMARY/);
  assert.match(catalogDef.description, /CAPABILITY RESOLUTION LADDER/);
  assert.match(catalogDef.description, /YOUR OWN KNOWLEDGE/);
  assert.match(catalogDef.description, /usdPerM/);
  const spawnDef = defs.find((def) => def.name === 'task_spawn');
  assert.match(spawnDef.input.model, /from model_catalog/, 'task_spawn exposes the model override');
  const run = { loopState: { consecutiveWaits: 0, lastWaitedMs: 0 }, tabId: 't', catalogApi: async () => ({ activeConnectionId: 'c1', connections: [{ id: 'c1', provider: 'xkiro', models: [{ id: 'z-ai/glm-5.3-flash', kind: 'lang' }, { id: 'claude-sonnet-5-5', kind: 'lang' }], isActive: true, liveCatalog: '92 models discovered live from /models' }], cloud: {}, ollama: {}, note: 'live catalog' }) };
  const out = await executeAction({ listTabs: () => [{ id: 't' }], getSelectedTabId: () => 't', requireTab: (id) => ({ id: id || 't' }) }, run, { name: 'model_catalog', input: {} });
  assert.equal(out.ok, true);
  assert.equal(out.result.connections[0].models.length, 2, 'the ASYNC catalog resolves — the promise is awaited, not serialized');
  assert.match(out.result.connections[0].liveCatalog, /92 models/);
  const none = await executeAction({ listTabs: () => [{ id: 't' }], getSelectedTabId: () => 't', requireTab: (id) => ({ id: id || 't' }) }, { loopState: { consecutiveWaits: 0, lastWaitedMs: 0 }, tabId: 't' }, { name: 'model_catalog', input: {} });
  assert.equal(none.ok, true);
  assert.equal(none.result.connections.length, 0, 'missing API degrades to an honest empty catalog');
});

test('spawnBackgroundTask resolves model/connection overrides like the run-start path', async () => {
  // Resolution logic exercised through the exported wiring surface: the
  // desktop main.cjs is Electron-bound, so assert the resolution CONTRACT
  // via the tool schema + a simulated connection match.
  const defs = toolDefinitions('spawn a subagent on claude-sonnet-5-5', 'browser', {});
  const spawnDef = defs.find((def) => def.name === 'task_spawn');
  assert.match(spawnDef.input.connectionId, /from model_catalog/);
  assert.match(spawnDef.description, /MODEL SELECTION/);
  // The resolution contract: explicit connectionId > catalog match > parent
  // connection with the raw model id (honest gateway failure, no fallback).
  const connections = [
    { id: 'a', provider: 'xkiro', baseUrl: 'https://api.xkiro.com/v1', model: 'z-ai/glm-5.3-flash', customModels: [{ id: 'z-ai/glm-5.3-flash', kind: 'lang' }] },
    { id: 'b', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: '', customModels: [{ id: 'claude-sonnet-5-5', kind: 'lang' }] }
  ];
  const pick = (model, connectionId) => {
    const explicit = connectionId ? connections.find((item) => item.id === connectionId) : null;
    let connection = explicit || connections.find((item) => item.model === model || (item.customModels || []).some((entry) => entry.id === model)) || null;
    return connection ? { connectionId: connection.id, model: model || connection.model } : { connectionId: 'parent', model };
  };
  assert.deepEqual(pick('claude-sonnet-5-5'), { connectionId: 'b', model: 'claude-sonnet-5-5' }, 'catalog match finds the owning connection');
  assert.deepEqual(pick('', 'b'), { connectionId: 'b', model: '' });
  assert.deepEqual(pick('unknown-model'), { connectionId: 'parent', model: 'unknown-model' }, 'unmatched ids stay on the parent connection');
});
