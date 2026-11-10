import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MetaSearch, normalizeUrl } = require('../desktop/research/metaSearch.cjs');
const { runResearch, deriveQueries, extractPassages } = require('../desktop/research/researchWorker.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { decodeDuckDuckGoHref } = require('../desktop/mcp/browserViewController.cjs');
const { programFromWindowTitle, programFromObservation, composeObjective } = require('../desktop/research/programControlResearch.cjs');

test('duckduckgo result redirects resolve to the real target urls', () => {
  const target = 'https://support.microsoft.com/notepad-windows-11';
  const encoded = encodeURIComponent(target);
  assert.equal(decodeDuckDuckGoHref(`//duckduckgo.com/l/?uddg=${encoded}&rut=abc123`), target, 'protocol-relative redirect');
  assert.equal(decodeDuckDuckGoHref(`/l/?uddg=${encoded}`), target, 'root-relative redirect');
  assert.equal(decodeDuckDuckGoHref('https://example.com/direct'), 'https://example.com/direct', 'direct links pass through');
  assert.equal(decodeDuckDuckGoHref('//duckduckgo.com/y.js?ad_domain=x'), 'https://duckduckgo.com/y.js?ad_domain=x', 'non-l redirects are scheme-normalized, then filtered by the caller');
});

test('program names are extracted from window titles without noise', () => {
  assert.equal(programFromWindowTitle('GIMP'), 'GIMP');
  assert.equal(programFromWindowTitle('Untitled-1 @ 25% (RGB/8) *'), null, 'a document title identifies no program');
  assert.equal(programFromWindowTitle('report.docx - Word'), 'Word');
  assert.equal(programFromWindowTitle('Browser-use agent pointer'), null);
  assert.equal(programFromWindowTitle('Administrator:  C:\\Windows\\system32\\cmd.exe'), 'cmd', 'elevated system tools resolve to their executable basename');
  assert.equal(programFromWindowTitle('untitled - Paint'), 'Paint', 'the app segment rescues an untitled document');
  const desktop = { foregroundWindowId: '1', windows: [{ id: '1', title: 'Browser-use', minimized: false }, { id: '2', title: 'strokes.blend - Blender', minimized: false }] };
  assert.equal(programFromObservation(desktop), 'Blender', 'the foreground noise window is skipped for the first plausible app');
  assert.match(composeObjective('Blender', 'sculpt a face'), /user manual/i);
  assert.match(composeObjective('Blender', 'sculpt a face'), /Blender/);
});

function computerHarness({ researchRunner, knowledgeStore }) {
  let calls = 0;
  const researchObjectives = [];
  const controller = { navigationState: () => ({ url: 'https://fixture.invalid', loading: false }), domSnapshot: () => ({ elements: [] }), consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() { } };
  const desktop = { foregroundWindowId: '42', windows: [{ id: '42', title: 'GIMP', bounds: { x: 0, y: 0, width: 800, height: 600 } }] };
  const backend = { observe: async () => desktop, execute: async (name) => name === 'computer_screenshot' ? { source: 'native-desktop', data: 'px', mimeType: 'image/png', screenshotId: 's1' } : (desktop.foregroundWindowId = '42', { dispatched: true }), releaseOwner: async () => { }, releaseInput: async () => { } };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend, emit: () => { }, researchRunner, knowledgeStore, createProvider: () => ({ async complete() {
    calls += 1;
    if (calls === 1) return { actions: [{ name: 'computer_observe', input: {} }] };
    return { done: { summary: 'Done.', success: true, verified: true } };
  } }) });
  return { agent, objectives: researchObjectives, start: () => agent.start({ task: 'Draw a circle in GIMP', settings: { controlMode: 'agi', vision: 'off' }, provider: { id: 'mock' } }) };
}

test('an unknown native program only HINTS — research is the model\'s decision, never auto-spawned', async () => {
  const objectives = [];
  const h = computerHarness({
    researchRunner: async ({ task }) => { objectives.push(task); return { ok: true, tookMs: 3, sources: [{ title: 'a' }, { title: 'b' }], findings: 'GIMP circle: Select>Ellipse, Edit>Fill Selection.' }; },
    knowledgeStore: { record: () => { }, recall: () => [] }
  });
  // Research must NOT auto-spawn: the harness's job is the hint, and the
  // model decides whether to spend a research_task on it.
  const run = await h.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objectives.length, 0, 'no provider-consuming subagent behind the model\'s back');
  assert.equal(run.status, 'completed');
});

test('the brain cache prevents re-researching a known program', async () => {
  const objectives = [];
  const h = computerHarness({
    researchRunner: async ({ task }) => { objectives.push(task); return { ok: true, findings: 'x', sources: [] }; },
    knowledgeStore: { record: () => { }, recall: (query) => query.includes('GIMP') ? [{ kind: 'recipe', text: 'GIMP circle steps' }] : [] }
  });
  await h.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(objectives.length, 0, 'a learnt program is served from the brain cache');
});

// Deterministic engine fixtures: adapters parse JSON bodies so MetaSearch
// merging/dedupe/health logic is tested independently of live markup.
function jsonEngine(name, host, results, minIntervalMs = 0) {
  return {
    name,
    buildUrl: q => `https://${host}/search?q=${encodeURIComponent(q)}`,
    parse: body => JSON.parse(body),
    minIntervalMs,
    timeoutMs: 500
  };
}

function createMetaSearchFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    for (const [pattern, respond] of routes) {
      if (pattern.test(url)) return respond(url);
    }
    throw new Error(`no route for ${url}`);
  };
  return { calls, fetchImpl };
}

test('normalizeUrl strips tracking params, www, hash and trailing slash', () => {
  assert.equal(
    normalizeUrl('https://WWW.Example.test/docs/guide/?utm_source=x&fbclid=abc&id=7#top'),
    'https://example.test/docs/guide?id=7'
  );
  assert.equal(normalizeUrl('javascript:alert(1)'), '');
  assert.equal(normalizeUrl('not a url'), '');
});

test('merges engines, dedupes tracking-variant URLs, and rank-fuses', async () => {
  const { calls, fetchImpl } = createMetaSearchFetch([
    [/^https:\/\/a\.test\//, () => Response.json([
      { title: 'Guide to face retouching', url: 'https://docs.example.test/guide?utm_source=agg', snippet: 'step by step' },
      { title: 'Other result', url: 'https://other.test/page', snippet: 'other' }
    ])],
    [/^https:\/\/b\.test\//, () => Response.json([
      { title: 'Guide to face retouching', url: 'https://docs.example.test/guide', snippet: 'ranked first here too' },
      { title: 'Third result', url: 'https://third.test/x', snippet: 'third' }
    ])]
  ]);
  const search = new MetaSearch({
    fetchImpl,
    engines: [jsonEngine('a', 'a.test'), jsonEngine('b', 'b.test')],
    cacheTtlMs: 0
  });
  const result = await search.search({ query: 'face retouching guide' });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, false);
  assert.equal(result.results.length, 3);
  const first = result.results[0];
  assert.equal(first.url, 'https://docs.example.test/guide');
  assert.deepEqual(first.engines, ['a', 'b']);
  // Ranked 1st by both engines: RRF 2/(60+1) beats every single-engine 1/(60+1).
  assert.ok(first.score > result.results[1].score);
  assert.equal(calls.length, 2);
});

test('a cache hit performs zero fetches until the TTL expires', async () => {
  let calls = 0;
  const search = new MetaSearch({
    fetchImpl: async () => { calls += 1; return Response.json([{ title: 'Only result', url: 'https://one.test/a', snippet: '' }]); },
    engines: [jsonEngine('a', 'a.test')],
    cacheTtlMs: 50
  });
  const first = await search.search({ query: 'same query' });
  const second = await search.search({ query: 'same query' });
  assert.equal(second.cached, true);
  assert.equal(calls, 1);
  await new Promise(resolve => setTimeout(resolve, 60));
  await search.search({ query: 'same query' });
  assert.equal(calls, 2);
  assert.equal(first.results.length, 1);
});

test('one failing engine degrades the result without losing the others', async () => {
  const { fetchImpl } = createMetaSearchFetch([
    [/^https:\/\/good\.test\//, () => Response.json([{ title: 'Works', url: 'https://good.test/r', snippet: '' }])],
    [/^https:\/\/bad\.test\//, () => { throw new Error('boom'); }]
  ]);
  const search = new MetaSearch({
    fetchImpl,
    engines: [jsonEngine('good', 'good.test'), jsonEngine('bad', 'bad.test')],
    cacheTtlMs: 0
  });
  const result = await search.search({ query: 'anything' });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.results.length, 1);
  const bad = result.engines.find(engine => engine.name === 'bad');
  assert.equal(bad.status, 'error');
});

test('two consecutive failures cool an engine down; a success resets health', async () => {
  let badCalls = 0;
  let goodCalls = 0;
  const search = new MetaSearch({
    fetchImpl: async (url) => {
      if (url.includes('bad.')) { badCalls += 1; throw new Error('challenge'); }
      goodCalls += 1;
      return Response.json([{ title: 'Fine', url: 'https://good.test/r', snippet: '' }]);
    },
    engines: [jsonEngine('good', 'good.test'), jsonEngine('bad', 'bad.test')],
    cacheTtlMs: 0
  });
  await search.search({ query: 'first' });
  await search.search({ query: 'second' });
  assert.equal(badCalls, 2);
  const third = await search.search({ query: 'third' });
  assert.equal(badCalls, 2, 'cooled-down engine must not be fetched again');
  assert.equal(third.engines.find(engine => engine.name === 'bad').status, 'cooldown');
  assert.equal(goodCalls, 3);
  assert.equal(third.ok, true);
});

test('a pre-aborted signal short-circuits without any fetch', async () => {
  let calls = 0;
  const search = new MetaSearch({
    fetchImpl: async () => { calls += 1; return Response.json([]); },
    engines: [jsonEngine('a', 'a.test')],
    cacheTtlMs: 0
  });
  const controller = new AbortController();
  controller.abort();
  const result = await search.search({ query: 'x', signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(calls, 0);
});

test('bing RSS and duckduckgo HTML adapters parse their fixtures', () => {
  const { ENGINES } = require('../desktop/research/metaSearch.cjs');
  const bingEngine = ENGINES.find(engine => engine.name === 'bing');
  const ddgEngine = ENGINES.find(engine => engine.name === 'duckduckgo');
  const bingResults = bingEngine.parse('<rss><item><title>Bing hit</title><link>https://bing.test/page</link><description>Snip</description></item></rss>');
  assert.deepEqual(bingResults, [{ title: 'Bing hit', url: 'https://bing.test/page', snippet: 'Snip' }]);
  const ddgResults = ddgEngine.parse(
    '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fddg.test%2Fpage&amp;rut=x">DDG hit</a>' +
    '<a class="result__snippet" href="#">Useful snippet text</a>'
  );
  assert.deepEqual(ddgResults, [{ title: 'DDG hit', url: 'https://ddg.test/page', snippet: 'Useful snippet text' }]);
});

test('deriveQueries builds a stopword-free question-form variant', () => {
  const queries = deriveQueries('Open Photoshop and clean up the face of a photo');
  assert.equal(queries.length, 2);
  assert.equal(queries[0], 'Open Photoshop and clean up the face of a photo');
  assert.equal(queries[1], 'how to open photoshop clean face photo');
});

test('extractPassages scores query overlap and keeps document order', () => {
  const text = [
    'The healing brush tool removes blemishes from portrait photos. '.repeat(3),
    'Completely unrelated passage about knitting wool and needles in winter. '.repeat(3),
    'Photoshop face cleanup works best with a soft round brush at low flow. '.repeat(3)
  ].join(' ');
  const passages = extractPassages(text, ['photoshop', 'face', 'brush']);
  assert.equal(passages.length, 2);
  assert.match(passages[0], /healing brush/);
  assert.match(passages[1], /face cleanup/);
});

test('runResearch returns sources and passages from relevant fixture pages', async () => {
  const metaSearch = {
    search: async ({ query }) => ({
      ok: true, query, degraded: false, cached: false,
      results: [
        { title: 'How to clean up the face of a photo with photoshop', url: 'https://docs.one.test/guide', snippet: '', engines: ['bing'] },
        { title: 'Photoshop face retouching for photo cleanup', url: 'https://docs.two.test/page', snippet: '', engines: ['duckduckgo'] }
      ]
    })
  };
  const fetchPage = async (url) => ({
    ok: true,
    text: `<html><head><style>body{}</style></head><body><p>The healing brush removes blemishes from the face in portrait photos quickly and cleanly. Photoshop recommends a soft brush at low flow for natural skin retouching results.</p></body></html>`,
    finalUrl: url
  });
  const result = await runResearch({ task: 'clean up the face in a photo with photoshop', metaSearch, fetchPage, budgetMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.sources.length, 2);
  assert.ok(result.sources.every(source => source.read));
  assert.ok(result.passages.length >= 1);
  assert.match(result.findings, /Sources:/);
  assert.match(result.findings, /docs\.one\.test/);
  assert.match(result.findings, /healing brush/);
});

test('irrelevant engine results are gated out before any page fetch', async () => {
  // Measured live: a task phrase like "open calculator and compute 20*40"
  // made engines return OpenAI, Open University and a French housing site.
  let fetches = 0;
  const metaSearch = {
    search: async ({ query }) => ({
      ok: true, query, degraded: true, cached: false,
      results: [
        { title: 'OpenAI | Research & Deployment', url: 'https://openai.com/', snippet: '', engines: ['bing'] },
        { title: 'Seqens, le logement avec vous', url: 'https://www.seqens.fr/', snippet: '', engines: ['bing'] },
        { title: 'OPEN | English meaning - Cambridge Dictionary', url: 'https://dictionary.cambridge.org/dictionary/english/open', snippet: '', engines: ['bing'] }
      ]
    })
  };
  const result = await runResearch({
    task: 'open the calculator windows app and compute 20*40',
    metaSearch,
    fetchPage: async () => { fetches += 1; return { ok: true, text: 'x' }; },
    budgetMs: 5000
  });
  assert.equal(result.ok, false, 'gating yields an honest empty: silently discarded upstream');
  assert.equal(result.reason, 'no relevant sources');
  assert.equal(fetches, 0, 'no page may be fetched for irrelevant sources');
  assert.equal(result.sources.length, 0);
  assert.equal(result.findings, '');
});

test('unreadable pages still yield a bare source list instead of failing', async () => {
  const metaSearch = {
    search: async ({ query }) => ({
      ok: true, query, degraded: false, cached: false,
      results: [{ title: 'Blocked wall documentation', url: 'https://wall.test/a', snippet: '', engines: ['bing'] }]
    })
  };
  const fetchPage = async () => ({ ok: false, status: 403 });
  const result = await runResearch({ task: 'read the blocked wall of text about widgets', metaSearch, fetchPage, budgetMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.degraded, true);
  assert.equal(result.passages.length, 0);
  assert.match(result.findings, /\[1\] Blocked wall documentation — https:\/\/wall\.test\/a/);
});

test('zero search results fail softly and never throw', async () => {
  const result = await runResearch({
    task: 'anything at all',
    metaSearch: { search: async () => ({ ok: false, results: [], degraded: true, cached: false, query: 'x' }) },
    fetchPage: async () => { throw new Error('should not be reached'); },
    budgetMs: 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no search results');
});

test('a hung page fetch is raced against the budget and the worker finalizes partial', async () => {
  const metaSearch = {
    search: async ({ query }) => ({
      ok: true, query, degraded: false, cached: false,
      results: [
        { title: 'Painting task guide', url: 'https://slow.test/a', snippet: '', engines: ['bing'] },
        { title: 'About painting walls slowly', url: 'https://slow.test/b', snippet: '', engines: ['bing'] }
      ]
    })
  };
  const startedAt = Date.now();
  const result = await runResearch({
    task: 'task about painting',
    metaSearch,
    fetchPage: () => new Promise(() => {}),
    budgetMs: 700
  });
  assert.ok(Date.now() - startedAt < 2000, 'worker must not hang past the budget');
  assert.equal(result.ok, true);
  assert.ok(result.sources.length >= 1);
  assert.equal(result.passages.length, 0);
});

test('a pre-aborted signal skips all fetching', async () => {
  let fetches = 0;
  const controller = new AbortController();
  controller.abort();
  const result = await runResearch({
    task: 'task about painting walls',
    metaSearch: { search: async () => { throw new Error('must not be called'); } },
    fetchPage: async () => { fetches += 1; return { ok: true, text: 'x' }; },
    signal: controller.signal,
    budgetMs: 1000
  });
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
  assert.equal(fetches, 0);
});

function createAgentController() {
  const calls = [];
  return {
    calls,
    async domSnapshot() {
      return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'button', name: 'Go', text: 'Go', enabled: true }], truncated: false };
    },
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async clickElement(tabId, args, owner) { calls.push(['click', tabId, args, owner]); return { tabId, ...args }; },
    releaseSessionInput() { return { released: true }; }
  };
}

test('research is model-decided: research_task spawns the subagent and its findings reach the next decision', async () => {
  const controller = createAgentController();
  const received = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async ({ task }) => {
      assert.match(task, /retouch/i);
      return { ok: true, tookMs: 5, findings: 'Photoshop retouching guides: use the healing brush (J) at low flow.' };
    },
    createProvider: () => ({
      async complete(context) {
        received.push(context.messages);
        // Decision 1 chooses to research AND sets a plan (the model's calls —
        // nothing spawns automatically); decision 2 proposes completion with
        // the findings in context (bounced for the standard review); decision
        // 3 returns the verified completion the review asked for.
        if (received.length === 1) return { actions: [{ name: 'research_task', input: { objective: 'Photoshop retouching hotkeys for portrait retouching' } }, { name: 'update_plan', input: { steps: ['Retouch the photo'] } }] };
        if (received.length === 2) return { done: { summary: 'Done with research in context.', success: true } };
        return { done: { summary: 'Done with research in context.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Retouch the face in this portrait photo please', provider: { id: 'mock' } });
  assert.equal(received.length, 3);
  const injected = received[1].filter(message => /Background research finished/.test(message.content));
  assert.equal(injected.length, 1);
  assert.match(injected[0].content, /healing brush/);
  const persisted = run.messages.find(message => /Background research finished/.test(message.content));
  assert.equal(persisted?.source, 'runtime');
});

test('research_task is a no-op while a previous research is still pending, and never spawns on its own', async () => {
  const controller = createAgentController();
  let researchRuns = 0;
  let releaseResearch;
  const researchGate = new Promise((resolve) => { releaseResearch = resolve; });
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async () => { researchRuns += 1; await researchGate; return { ok: true, findings: 'late findings' }; },
    createProvider: () => ({
      async complete(context) {
        calls += 1;
        // Decision 1 spawns research; decision 2 tries to spawn again while
        // the first is still pending; decision 3 finishes.
        if (calls === 1) return { actions: [{ name: 'research_task', input: { objective: 'listary dual ctrl hotkey documentation' } }] };
        if (calls === 2) return { actions: [{ name: 'research_task', input: { objective: 'listary dual ctrl hotkey documentation' } }] };
        releaseResearch();
        return { done: { summary: 'Done.', success: true, verified: true } };
      }
    })
  });
  let calls = 0;
  const run = await agent.start({ task: 'Open listary with its dual ctrl hotkey', provider: { id: 'mock' } });
  assert.equal(researchRuns, 1, 'the pending research is never duplicated');
  assert.equal(run.status, 'completed');
});

test('a refused research objective is reported as NOT started, never as covered', async () => {
  // The brief that eventually arrives belongs to the objective already
  // running. A refusal that reads "findings will arrive" lets the model
  // conclude the dropped topic WAS researched, and write it from prebuilt
  // knowledge while reporting it as researched.
  const controller = createAgentController();
  const seen = [];
  let decisions = 0;
  let releaseResearch;
  const researchGate = new Promise((resolve) => { releaseResearch = resolve; });
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async () => { await researchGate; return { ok: true, findings: 'findings for the FIRST objective only' }; },
    createProvider: () => ({
      async complete(context) {
        decisions += 1;
        const results = (context.history || []).map(entry => JSON.stringify(entry)).join('\n');
        seen.push(results);
        if (decisions === 1) return { actions: [{ name: 'research_task', input: { objective: 'first topic' } }] };
        if (decisions === 2) return { actions: [{ name: 'research_task', input: { objective: 'second topic' } }] };
        releaseResearch();
        return { done: { summary: 'Done.', success: true, verified: true } };
      }
    })
  });
  await agent.start({ task: 'Research two topics', provider: { id: 'mock' } });
  const refusal = seen.find(text => text.includes('was NOT started'));
  assert.ok(refusal, 'the refusal note must say the objective was not started');
  assert.match(refusal, /only that one will be delivered/);
  assert.doesNotMatch(refusal, /its findings will arrive as advisory context/);
});

test('a rejecting research runner leaves the run completely untouched', async () => {
  const controller = createAgentController();
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async () => { throw new Error('search backend exploded'); },
    createProvider: () => ({
      async complete() {
        decisions += 1;
        return { done: { summary: 'Completed without research.', success: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Just answer this question directly without any research', provider: { id: 'mock' } });
  assert.equal(decisions, 1);
  assert.equal(run.status, 'completed');
  assert.equal(run.messages.some(message => /Background research finished/.test(message.content)), false);
  assert.equal(run.result.summary, 'Completed without research.');
});

test('the serialized run never carries the research state across IPC', async () => {
  const controller = createAgentController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async () => ({ ok: true, findings: 'x' }),
    createProvider: () => ({ async complete() { return { done: { summary: 'Done.', success: true } }; } })
  });
  const run = await agent.start({ task: 'Serialize this complete run state for the ipc boundary', provider: { id: 'mock' } });
  assert.equal('research' in run, false);
  assert.doesNotThrow(() => structuredClone(run));
});
