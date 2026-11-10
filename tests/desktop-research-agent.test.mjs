import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runResearchAgent, RESEARCH_TOOLS, SYSTEM_PROMPT } = require('../desktop/research/researchAgent.cjs');
const { defaultResearchAgent } = require('../desktop/agent/desktopChatAgent.cjs');

function createBrowser() {
  const calls = [];
  return {
    calls,
    createTab: async (url) => { calls.push(['createTab', url]); return { id: 'tab-research' }; },
    closeTab: (tabId) => calls.push(['closeTab', tabId]),
    search: async (tabId, { query }) => {
      calls.push(['search', tabId, query]);
      return {
        query,
        results: [
          { title: 'Listary command line options', href: 'https://docs.listary.test/cli' },
          { title: 'Launch apps with Listary', href: 'https://forum.listary.test/launch' }
        ]
      };
    },
    fetchPage: async ({ url }) => {
      calls.push(['fetch', url]);
      return { ok: true, url, text: 'Listary supports command-line activation: Listary.exe -show. The default hotkey is double Ctrl but can be changed in settings.' };
    }
  };
}

test('the subagent runs a real tool loop: searches the browser, reads a page, synthesizes, closes its tab', async () => {
  const browser = createBrowser();
  const decisions = [];
  const provider = {
    complete: async (context) => {
      decisions.push({ tools: context.tools.map(tool => tool.name), effort: context.effort, messages: context.messages.length });
      const step = decisions.length;
      if (step === 1) return { actions: [{ name: 'browser_search', input: { query: 'listary command line activate' } }] };
      if (step === 2) return { actions: [{ name: 'browser_fetch', input: { url: 'https://docs.listary.test/cli' } }] };
      return { actions: [{ name: 'finish', input: { findings: 'Listary activates via "Listary.exe -show" or double Ctrl (docs.listary.test/cli).' } }] };
    }
  };
  const result = await runResearchAgent({ task: 'using listary, open photoshop', providerFactory: () => provider, browser, metaSearch: null, budgetMs: 20_000 });
  assert.equal(result.ok, true);
  assert.equal(result.agent, true, 'a real subagent produced this');
  assert.match(result.findings, /Listary\.exe -show/);
  assert.equal(browser.calls[0][0], 'createTab');
  assert.equal(browser.calls.filter(([name]) => name === 'search').length, 1);
  assert.equal(browser.calls.filter(([name]) => name === 'fetch').length, 1);
  assert.equal(browser.calls.at(-1)[0], 'closeTab', 'the research tab must be closed');
  assert.equal(browser.calls.at(-1)[1], 'tab-research');
  // Every decision exposed exactly the research tools at minimal effort.
  // Direct-HTTP search engines are not offered: measured live, several are
  // denied or empty from this machine (google scrape = empty wall), while
  // Google in the tab works like a human search.
  assert.deepEqual(decisions[0].tools, ['browser_search', 'browser_fetch', 'finish']);
  assert.equal(decisions[0].effort, 'minimal');
  // Sources tracked from what the agent chose to read.
  assert.ok(result.sources.some(source => source.url === 'https://docs.listary.test/cli'));
});

test('a hallucinated web_search call is ignored — the meta-search is never consulted', async () => {
  const metaSearch = { search: async () => { throw new Error('meta search must not be consulted anymore'); } };
  const provider = {
    complete: async () => ({ actions: [{ name: 'web_search', input: { query: 'windows calculator command line' } }] })
  };
  const result = await runResearchAgent({ task: 'open calculator via command line', providerFactory: () => provider, browser: null, metaSearch, budgetMs: 10_000 });
  // The call is not in the tool list, so it is not a usable tool call: the
  // loop ends with no findings and no sources, and the mock above proves the
  // denied direct-HTTP engines were never touched.
  assert.equal(result.ok, false);
  assert.equal(result.findings, '');
  assert.deepEqual(result.sources, []);
});

test('the page-read budget caps fetches and the model is told why', async () => {
  let fetches = 0;
  const browser = {
    createTab: async () => ({ id: 't' }),
    closeTab: () => {},
    search: async (tabId, { query }) => ({ query, results: [{ title: 'x', href: 'https://x.test/a' }] }),
    fetchPage: async () => { fetches += 1; return { ok: true, url: 'https://x.test/a', text: 'content' }; }
  };
  const provider = {
    complete: async (context) => {
      const last = context.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      if (last.includes('budget exhausted') || last.includes('Page-read budget')) {
        return { actions: [{ name: 'finish', input: { findings: 'summarized from three reads' } }] };
      }
      return { actions: [{ name: 'browser_fetch', input: { url: 'https://x.test/a' } }] };
    }
  };
  const result = await runResearchAgent({ task: 'research pages', providerFactory: () => provider, browser, metaSearch: null, budgetMs: 20_000, maxSteps: 8 });
  assert.equal(fetches, 3, 'hard cap of three page reads');
  assert.equal(result.ok, true);
  assert.match(result.findings, /summarized/);
});

test('steps exhausted without a finish triggers one final no-tools summary call', async () => {
  let sawEmptyTools = false;
  const provider = {
    complete: async (context) => {
      if (Array.isArray(context.tools) && context.tools.length === 0) {
        sawEmptyTools = true;
        return { assistantText: 'Findings: the launcher exposes a documented CLI (source: forum).' };
      }
      return { actions: [{ name: 'browser_search', input: { query: 'q' } }] };
    }
  };
  const browser = { createTab: async () => ({ id: 't' }), closeTab: () => {}, search: async () => ({ query: 'q', results: [{ title: 't', href: 'https://f.test/x' }] }) };
  const result = await runResearchAgent({ task: 'task about launchers', providerFactory: () => provider, browser, metaSearch: null, budgetMs: 20_000, maxSteps: 2 });
  assert.equal(sawEmptyTools, true);
  assert.equal(result.ok, true);
  assert.match(result.findings, /documented CLI/);
});

test('a provider that always throws returns ok:false and never throws upward', async () => {
  const result = await runResearchAgent({
    task: 'anything at all',
    providerFactory: () => ({ complete: async () => { throw new Error('provider down'); } }),
    browser: null,
    metaSearch: null,
    budgetMs: 5000
  });
  assert.equal(result.ok, false);
});

test('defaultResearchAgent falls back to the deterministic pipeline when the provider fails', async () => {
  const metaSearchCalls = [];
  const result = await defaultResearchAgent({
    task: 'open the windows calculator from the command line and compute 20*40',
    signal: null,
    providerFactory: () => ({ complete: async () => { throw new Error('provider down'); } }),
    browser: null,
    metaSearch: { search: async ({ query }) => { metaSearchCalls.push(query); return { ok: true, query, degraded: false, cached: false, results: [{ title: 'Windows Calculator command line', url: 'https://en.wikipedia.org/wiki/Windows_Calculator', snippet: '', engines: ['wikipedia'] }, { title: 'Calculator app launch uri ms-calculator', url: 'https://learn.test/calculator', snippet: '', engines: ['bing'] }] }; } }
  });
  assert.ok(metaSearchCalls.length >= 1, 'deterministic fallback must have run');
  assert.equal(result.ok, true);
  assert.match(result.findings, /Sources:/);
});

test('a missing providerFactory goes straight to the deterministic pipeline', async () => {
  let metaSearchCalls = 0;
  const result = await defaultResearchAgent({
    task: 'research the windows sound mixer settings application',
    signal: null,
    providerFactory: null,
    browser: null,
    metaSearch: { search: async ({ query }) => { metaSearchCalls += 1; return { ok: true, query, degraded: false, cached: false, results: [] }; } }
  });
  assert.equal(metaSearchCalls >= 1, true);
  assert.equal(result.ok, false, 'no relevant sources is an honest empty');
});

test('browser_search uses real Google and a captcha challenge surfaces a notify plus the captcha flag', async () => {
  const searchOptions = [];
  const notices = [];
  const browser = {
    createTab: async () => ({ id: 't' }),
    closeTab: () => {},
    search: async (tabId, options) => {
      searchOptions.push(options);
      // First search hits the challenge wall; the second (after the model
      // retries) is clear.
      if (searchOptions.length === 1) return { query: options.query, results: [], resultCount: 0, captcha: true, captchaKind: 'google-sorry', notice: 'human-verification challenge' };
      return { query: options.query, results: [{ title: 'clean', href: 'https://g.test/r' }] };
    },
    fetchPage: async () => ({ ok: true, url: 'https://g.test/r', text: 'content' }),
    notify: (message) => notices.push(message)
  };
  const decisions = [];
  const provider = {
    complete: async () => {
      decisions.push(decisions.length);
      if (decisions.length === 1) return { actions: [{ name: 'browser_search', input: { query: 'listary cli' } }] };
      if (decisions.length === 2) return { actions: [{ name: 'browser_search', input: { query: 'listary cli flags' } }] };
      return { actions: [{ name: 'finish', input: { findings: 'found the cli flags.' } }] };
    }
  };
  const result = await runResearchAgent({ task: 'listary cli', providerFactory: () => provider, browser, metaSearch: null, budgetMs: 20_000, minSearchGapMs: 0 });
  assert.equal(result.ok, true);
  assert.equal(searchOptions.length, 2);
  assert.equal(searchOptions[0].engine, 'google', 'the research surface must search real Google');
  assert.equal(searchOptions[1].engine, 'google');
  assert.equal(notices.length, 1, 'the challenge surfaced one human notice');
  assert.match(notices[0], /verify|challenge/i);
});

test('xkiro runs get xkiro_search first and it routes to the search API', async () => {
  const seenTools = [];
  const searched = [];
  const browser = {
    createTab: async () => ({ id: 't' }), closeTab: () => {},
    search: async () => { throw new Error('google tab search must not run when xkiro search succeeds'); },
    fetchPage: async () => ({ ok: false })
  };
  const provider = {
    complete: async (context) => {
      seenTools.push(context.tools.map((tool) => tool.name));
      if (seenTools.length === 1) return { actions: [{ name: 'xkiro_search', input: { query: 'listary cli flags' } }] };
      return { done: { findings: 'found it' } };
    }
  };
  const searchApiFactory = () => ({ baseUrl: 'https://api.xkiro.com/v1', apiKey: 'k', fetchImpl: fakeFetch });
  let fakeFetch;
  fakeFetch = async (url, options) => {
    searched.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ results: [{ title: 'Listary docs', url: 'https://listary.app/docs', snippet: 'flags' }] }), { status: 200 });
  };
  const { createXkiroSearch } = require('../desktop/research/xkiroSearch.cjs');
  const result = await runResearchAgent({
    task: 'find listary cli flags', providerFactory: () => provider, browser, searchApiFactory,
    metaSearch: { search: async () => { throw new Error('meta search must not run'); } },
    budgetMs: 10_000
  });
  assert.equal(seenTools[0][0], 'xkiro_search', 'primary tool listed first for kxiro runs');
  assert.equal(seenTools[0].includes('browser_search'), true, 'google fallback still offered');
  assert.ok(searched[0]?.url.includes('/v1/search'), 'hits the xkiro search endpoint');
  assert.equal(result.ok, true);
});

test('a dead xkiro search API falls back to Google in the tab without the model asking', async () => {
  // The search service being down must not end the research: the tab is the
  // only engine that still works, and the fallback has to happen on its own.
  // Without it the run produced no findings and the working agent answered
  // from prebuilt knowledge instead of sourced material.
  const browserCalls = [];
  const browser = {
    createTab: async () => { browserCalls.push('createTab'); return { id: 't' }; },
    closeTab: () => {},
    search: async (tabId, options) => {
      browserCalls.push(['search', options.query]);
      return { query: options.query, results: [{ title: 'GPU discovery docs', href: 'https://g.test/discovery' }] };
    },
    fetchPage: async ({ url }) => ({ ok: true, url, text: 'DXGI adapter enumeration details.' }),
    notify: () => {}
  };
  const provider = {
    complete: async (context) => {
      const last = context.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      // The model tries the API once and then finishes — it never asks for
      // browser_search itself.
      if (last.includes('TOOL RESULT')) return { actions: [{ name: 'finish', input: { findings: 'from tab results' } }] };
      return { actions: [{ name: 'xkiro_search', input: { query: 'gpu discovery windows' } }] };
    }
  };
  const searchApiFactory = () => ({
    baseUrl: 'https://api.xkiro.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('boom', { status: 503 })
  });

  const result = await runResearchAgent({
    task: 'how do programs discover video cards', providerFactory: () => provider, browser, searchApiFactory,
    metaSearch: { search: async () => { throw new Error('meta search must not run'); } },
    budgetMs: 10_000
  });

  const searched = browserCalls.filter(call => Array.isArray(call) && call[0] === 'search');
  assert.equal(searched.length, 1, 'the tab fallback ran exactly once');
  assert.equal(searched[0][2] || searched[0][1], 'gpu discovery windows', 'the fallback reused the API query');
  assert.ok(result.sources.some(source => source.url === 'https://g.test/discovery'), 'tab results became sources');
  assert.equal(result.ok, true);
});

test('a failed search does not block the next engine — the model may try the other path', async () => {
  const browserCalls = [];
  const browser = {
    createTab: async () => ({ id: 't' }),
    closeTab: () => {},
    search: async (tabId, options) => {
      browserCalls.push(options.query);
      return { query: options.query, results: [{ title: 'x', href: 'https://x.test/a' }] };
    },
    fetchPage: async () => ({ ok: true, url: 'https://x.test/a', text: 'content' }),
    notify: () => {}
  };
  const provider = {
    complete: async (context) => {
      const last = context.messages.filter(message => message.role === 'user').at(-1)?.content || '';
      if (last.includes('TOOL RESULT xkiro_search')) return { actions: [{ name: 'browser_search', input: { query: 'second engine' } }] };
      if (last.includes('TOOL RESULT browser_search')) return { actions: [{ name: 'finish', input: { findings: 'done' } }] };
      return { actions: [{ name: 'xkiro_search', input: { query: 'first engine' } }] };
    }
  };
  const searchApiFactory = () => ({
    baseUrl: 'https://api.xkiro.com/v1',
    apiKey: 'k',
    fetchImpl: async () => new Response('boom', { status: 500 })
  });

  const result = await runResearchAgent({
    task: 'two engines', providerFactory: () => provider, browser, searchApiFactory,
    metaSearch: null, budgetMs: 10_000
  });

  assert.equal(browserCalls.length, 2, 'the second search was not blocked by the review gate');
  assert.equal(result.ok, true);
});
