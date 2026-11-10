'use strict';

// The REAL research subagent: a bounded LLM tool loop that runs beside a
// working agent run. It decides what to search, which results to read, and
// what to keep — it is not a programmatic query that forwards everything it
// receives. Its only output is one synthesized findings brief, delivered as
// advisory context at a later model boundary of the working agent.
//
// Invariants (researchPipeline_flow_chat.md):
// - Fire-and-forget: the working agent never waits; findings inject once.
// - Invisible failure: any error discards silently (deterministic fallback).
// - Never touches the user's tab: it searches in its own background tab and
//   closes it when done.
// - Bounded: maxSteps decisions, hard budget, one tab, ≤3 page reads.

const DEFAULT_BUDGET_MS = 90_000;
const DEFAULT_MAX_STEPS = 8;
const MAX_PAGE_READS = 3;
const TOOL_RESULT_CHAR_CAP = 6_000;
// Human pacing for automated Google searches: repeated queries closer than
// this look like a bot burst and invite the challenge wall. Shared per
// process — the browser is one session, so the pace is one human's pace.
const MIN_BROWSER_SEARCH_GAP_MS = 20_000;
let lastBrowserSearchAt = 0;

async function interruptibleDelay(ms, signal) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('research aborted');
    await new Promise(resolve => setTimeout(resolve, Math.min(250, deadline - Date.now())));
  }
}

const num = description => ({ type: 'number', description });
const str = description => ({ type: 'string', description });

const RESEARCH_TOOLS = [
  {
    name: 'browser_search',
    description: 'A real Google search in a dedicated browser tab (the session\'s real cookies; searches are paced like a human). This is the ONLY search tool: it opens Google exactly like a person does. If Google shows a "not a robot" challenge, up to 90 seconds are left for the human to clear it in the visible window, then the search resumes automatically. Returns organic result titles with hrefs.',
    inputSchema: { type: 'object', properties: { query: str('Search query') }, required: ['query'] }
  },
  {
    name: 'browser_fetch',
    description: 'Read one page as bounded plain text (scripts/styles stripped). Use on the most promising result href; at most three reads per run.',
    inputSchema: { type: 'object', properties: { url: str('Absolute http(s) URL') }, required: ['url'] }
  },
  {
    name: 'finish',
    description: 'Deliver the findings brief and end the research. Cite source URLs inline. Synthesize — never dump raw page text. An empty findings string means nothing relevant was found.',
    inputSchema: { type: 'object', properties: { findings: str('The synthesized findings brief (markdown, <= 6000 chars); empty when nothing relevant was found') }, required: ['findings'] }
  }
];

const XKIRO_SEARCH_TOOL = {
  name: 'xkiro_search',
  description: 'PRIMARY search: structured live-web results via the xkiro search API (titles, URLs, snippets — no challenge walls, no scraping). Use this FIRST for every search; browser_search (real Google in the tab) is the fallback when this fails or returns nothing.',
  inputSchema: { type: 'object', properties: { query: str('Search query') }, required: ['query'] }
};

// Per-run tool list: xkiro users get the primary API search first; every
// other provider never sees it and runs the Google-in-tab pipeline alone.
function researchTools(searchApi) {
  return searchApi ? [XKIRO_SEARCH_TOOL, ...RESEARCH_TOOLS] : RESEARCH_TOOLS;
}

const SYSTEM_PROMPT = [
  'You are the silent background research subagent of a working computer agent.',
  'Your steps are never shown; only your final findings brief is delivered to the working agent as advisory context.',
  'Goal: research the task and produce a compact, factual brief that makes the working agent faster and more correct — the exact command, hotkey, URI, menu path, or API it needs, with source URLs.',
  'Tool guidance: xkiro_search, when offered, is the PRIMARY search (structured live-web results); use it first. browser_fetch reads one page — on xkiro runs it goes through the structured /v1/fetch API (no tab opened); only when that fails does it fall back to opening the page in a tab. browser_search (real Google in the tab) is the search fallback when xkiro_search fails or returns nothing; a captcha challenge waits up to 90s for the human to clear it.',
  'Rules: at most three page reads; one tool call per decision; synthesize findings with source URLs; never dump raw page text; never invent facts — if sources disagree or nothing relevant exists, say so in the findings; finish as soon as the brief is good enough.'
].join(' ');

function toolResultMessage(name, result) {
  return `TOOL RESULT ${name}:\n${JSON.stringify(result).slice(0, TOOL_RESULT_CHAR_CAP)}`;
}

// Bounded LLM loop. Never throws; returns { ok, tookMs, findings, sources }.
async function runResearchAgent({ task, signal = null, providerFactory = null, browser = null, metaSearch = null, searchApiFactory = null, budgetMs = DEFAULT_BUDGET_MS, maxSteps = DEFAULT_MAX_STEPS, minSearchGapMs = MIN_BROWSER_SEARCH_GAP_MS, now = Date.now } = {}) {
  const startedAt = now();
  const sources = [];
  let pageReads = 0;
  let tabId = null;
  try {
    if (!providerFactory) return { ok: false, reason: 'no provider', tookMs: now() - startedAt };
    if (signal?.aborted) return { ok: false, aborted: true, tookMs: now() - startedAt };
    const deadline = startedAt + budgetMs;
    const remaining = () => deadline - now();
    const check = () => { if (signal?.aborted) throw new Error('research aborted'); };

    if (browser?.createTab) {
      try {
        const created = await browser.createTab('about:blank');
        tabId = created?.id || null;
      } catch { tabId = null; }
    }

    // Primary search client: only constructed when the caller determined the
    // run's provider is xkiro (base URL + credential available). Any failure
    // here silently leaves the run on the Google-in-tab pipeline.
    let searchApi = null;
    if (searchApiFactory) {
      try {
        const config = searchApiFactory();
        if (config?.baseUrl && config?.apiKey) {
          const { createXkiroSearch } = require('./xkiroSearch.cjs');
          searchApi = createXkiroSearch({ baseUrl: config.baseUrl, apiKey: config.apiKey, fetchImpl: config.fetchImpl });
        }
      } catch { searchApi = null; }
    }
    const tools = researchTools(searchApi);
    const messages = [{ role: 'user', content: `Research task: ${String(task || '').slice(0, 4000)}` }];
    const provider = providerFactory();
    let findings = '';
    // Whether the LAST search failed outright. A failed search produced no
    // results to consume, so it must not block the next engine — a dead
    // search API that strands the fallback leaves the run with no research
    // at all, and the working agent then answers from prebuilt knowledge.
    let lastSearchFailed = false;

    // One in-tab Google search, shared by the browser_search tool and the
    // automatic fallback the xkiro branch takes when the search API is down.
    // Real Google in the session's tab (real cookies, human pacing).
    // If a challenge wall appears the search call itself waits up to 90s
    // for the human to clear it in the visible window; surface that so
    // the user knows to look at the browser.
    const searchInTab = async (query) => {
      if (!browser || !tabId) return { ok: false, error: 'browser_search is unavailable for this run (no local browser).' };
      const gap = minSearchGapMs - (now() - lastBrowserSearchAt);
      if (gap > 0 && remaining() > gap + 2_000) await interruptibleDelay(gap, signal);
      lastBrowserSearchAt = now();
      const searched = await browser.search(tabId, { query: String(query || '').slice(0, 300), maxResults: 8, engine: 'google' });
      if (searched?.captcha && typeof browser.notify === 'function') {
        try { browser.notify(`Google wants to verify a research search is human — please complete the challenge in the browsing window; the search resumes automatically.`); } catch { }
      }
      const results = (searched?.results || []).slice(0, 8);
      return {
        ok: results.length > 0 || Boolean(searched?.captcha),
        query: searched?.query ?? query,
        results,
        resultCount: results.length,
        usable: results.length > 0,
        nextAction: results.length > 0
          ? 'Review these results and fetch the most relevant page before searching again.'
          : searched?.captcha
            ? 'Search is blocked by a human-verification challenge; do not repeat equivalent searches. Ask the user to clear it or use another available search path.'
            : 'No organic results were collected. Review the rendered-page notice/elements and change the query or use browser_fetch on a known reference; do not repeat the same query.',
        notice: searched?.notice || null,
        ...(searched?.elements?.length ? { renderedElements: searched.elements } : {}),
        ...(searched?.captcha ? { captcha: true } : {})
      };
    };

    for (let step = 0; step < maxSteps; step++) {
      check();
      if (remaining() <= 2_000) break;
      const response = await provider.complete({
        task,
        messages: [...messages],
        tools,
        effort: 'minimal',
        effortMode: 'auto',
        signal,
        observation: null,
        observationUnchanged: false,
        history: [],
        coordinator: { completedWork: [], observationRevision: 0, duplicateBlocks: 0, metrics: { phaseMs: {}, providerCalls: 0, providerRequests: [] } },
        plan: [],
        goals: [],
        recovery: null,
        workingMemory: {},
        attachments: []
      });
      const calls = Array.isArray(response?.actions) ? response.actions
        : Array.isArray(response?.toolCalls) ? response.toolCalls
        : response?.done && typeof response.done === 'object' ? [{ name: 'finish', input: response.done }] : [];
      const call = calls.find(candidate => tools.some(tool => tool.name === candidate?.name));
      if (!call) {
        // No usable tool call: treat visible prose as the findings if any.
        findings = String(response?.assistantText || '').trim();
        break;
      }
      const name = call.name;
      const input = call.input || {};
      const lastSearch = [...messages].reverse().find(message => message.role === 'user' && /^TOOL RESULT (?:browser_search|xkiro_search):/.test(String(message.content || '')));
      const lastSearchResult = lastSearch ? String(lastSearch.content || '') : '';
      if ((name === 'browser_search' || name === 'xkiro_search') && lastSearchResult && !lastSearchFailed && !/Review these results|No organic results|Search is blocked|no results/i.test(lastSearchResult)) {
        // A search must be consumed before another equivalent search. The model
        // gets a bounded correction instead of a silent query loop.
        messages.push({ role: 'user', content: 'SEARCH REVIEW REQUIRED: inspect the previous search results, choose a relevant URL to browser_fetch, or explain why the results are unusable and change the query. Do not issue another search before reviewing the result.' });
        continue;
      }
      let result;
      if (name === 'finish') {
        findings = String(input.findings ?? '').trim();
        break;
      } else if (name === 'xkiro_search') {
        if (!searchApi) result = { ok: false, error: 'xkiro_search is unavailable in this run.' };
        else {
          const searched = await searchApi.search({ query: String(input.query || '').slice(0, 300), maxResults: 8, signal });
          if (searched?.ok) {
            result = { ok: true, query: input.query, results: searched.results.slice(0, 8), source: 'xkiro' };
          } else {
            // The search API is down (or empty). Fall back to real Google in
            // the tab RIGHT HERE rather than handing the model a dead end:
            // the tab is the only engine that works when the API service is
            // unavailable, and without this the run ends with no research at
            // all and the working agent answers from prebuilt knowledge.
            const fallback = await searchInTab(input.query);
            if (fallback.ok) {
              result = { ...fallback, source: 'google-tab-fallback', apiError: searched?.error || 'no results' };
            } else {
              result = { ok: false, query: input.query, error: searched?.error || 'no results', fallbackError: fallback.error };
            }
          }
        }
      } else if (name === 'browser_search') {
        result = await searchInTab(input.query);
      } else if (name === 'browser_fetch') {
        if (pageReads >= MAX_PAGE_READS) result = { ok: false, error: `Page-read budget exhausted (${MAX_PAGE_READS}); synthesize from what you have.` };
        else {
          pageReads += 1;
          // PRIMARY page read on xkiro runs: the structured /v1/fetch API —
          // no tab opened, no challenge walls. The in-tab fetch remains the
          // fallback (API failure or non-xkiro runs keep the old path).
          let page = null;
          if (searchApi?.fetchPages) {
            const apiPage = await searchApi.fetchPages({ urls: [String(input.url || '').slice(0, 1000)] });
            if (apiPage?.ok && apiPage.results?.[0]) {
              const entry = apiPage.results[0];
              page = { ok: true, finalUrl: entry.url, text: entry.content };
            }
          }
          if (!page && browser) {
            const tabPage = await browser.fetchPage({ url: String(input.url || '').slice(0, 1000), maxLength: 12_000 });
            page = tabPage?.ok
              ? { ok: true, finalUrl: tabPage.finalUrl || input.url, text: String(tabPage.text || '') }
              : { ok: false, error: tabPage?.error || tabPage?.reason || 'fetch failed' };
          }
          result = page?.ok
            ? { ok: true, url: page.finalUrl || input.url, text: String(page.text || '').slice(0, TOOL_RESULT_CHAR_CAP) }
            : { ok: false, url: input.url, error: page?.error || 'fetch failed' };
        }
      } else {
        result = { ok: false, error: `Unknown tool ${name}.` };
      }
      // Track every URL the agent chose to read or search, for the store.
      // Deduplicated: a fetched page is also a search result, and the store's
      // "two real sources" gate must not read one page as two.
      const trackSource = (title, url) => {
        if (!url) return;
        if (sources.some(source => source.url === url)) return;
        sources.push({ title: title || url, url });
      };
      if (name === 'browser_fetch' && result?.ok && result.url) trackSource(result.url, result.url);
      if (name === 'browser_search') for (const entry of result?.results || []) trackSource(entry.title, entry.href);
      if (name === 'xkiro_search') {
        for (const entry of result?.results || []) {
          // xkiro results carry `url`; a Google-in-tab fallback carries `href`.
          trackSource(entry.title, entry.url || entry.href);
        }
      }
      // A search that produced nothing usable must not block the next
      // engine — the model needs to be free to try the other path.
      if (name === 'xkiro_search' || name === 'browser_search') lastSearchFailed = result?.ok !== true && result?.usable !== true;

      messages.push({ role: 'assistant', content: JSON.stringify({ action: { name, input } }).slice(0, 2_000) });
      messages.push({ role: 'user', content: toolResultMessage(name, result) });
      while (messages.length > 12) messages.splice(1, 1); // keep the task + recent turns
    }

    if (!findings && remaining() > 2_000) {
      // Steps exhausted without a finish: one final no-tools call to summarize.
      check();
      messages.push({ role: 'user', content: 'Budget reached. Without calling any tool, write the final findings brief now from the evidence above (source URLs included). If nothing relevant was found, return an empty findings string.' });
      const final = await provider.complete({
        task, messages: [...messages], tools: [], effort: 'minimal', effortMode: 'auto', signal,
        observation: null, observationUnchanged: false, history: [],
        coordinator: { completedWork: [], observationRevision: 0, duplicateBlocks: 0, metrics: { phaseMs: {}, providerCalls: 0, providerRequests: [] } },
        plan: [], goals: [], recovery: null, workingMemory: {}, attachments: []
      });
      findings = String(final?.assistantText || final?.done?.summary || '').trim();
    }

    return {
      ok: Boolean(findings) || sources.length > 0,
      tookMs: now() - startedAt,
      findings: String(findings || '').slice(0, 6_000),
      sources: sources.slice(0, 12),
      degraded: false,
      agent: true
    };
  } catch (error) {
    if (signal?.aborted) return { ok: false, aborted: true, tookMs: now() - startedAt };
    return { ok: false, error: error?.message || 'research agent failed', tookMs: now() - startedAt };
  } finally {
    if (tabId && browser?.closeTab) {
      try { browser.closeTab(tabId); } catch { /* cleanup is best-effort */ }
    }
  }
}

module.exports = { runResearchAgent, RESEARCH_TOOLS, SYSTEM_PROMPT };
