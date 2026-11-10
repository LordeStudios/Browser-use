'use strict';

// Background research worker: the "read the tutorial while already working"
// capability. Given a user task, it queries the contained meta-search, reads a
// small bounded set of result pages, and returns an extractive findings
// summary. It runs fire-and-forget next to a live agent run and must never
// throw, never block the run, and never be visible when it fails.
//
// No LLM calls: summarization is deterministic extractive scoring, so research
// adds no provider cost, no decision latency, and cannot destabilize a run.

const { MetaSearch, normalizeUrl } = require('./metaSearch.cjs');

const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_MAX_PAGES = 5;
const MAX_PER_HOST = 2;
const PAGE_TIMEOUT_MS = 12_000;
const PAGE_MAX_BYTES = 1_000_000;
const FINDINGS_CHAR_CAP = 8_000;
const MAX_PASSAGES = 8;
const PASSAGE_MIN_CHARS = 80;
const PASSAGE_MAX_CHARS = 400;
const QUERY_CHAR_CAP = 180;

const STOPWORDS = new Set(['a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or', 'our', 'please', 'so', 'some', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this', 'to', 'up', 'use', 'using', 'want', 'was', 'we', 'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with', 'without', 'would', 'you', 'your']);

function deriveQueries(task) {
  const primary = String(task || '').replace(/\s+/g, ' ').trim().slice(0, QUERY_CHAR_CAP);
  if (!primary) return [];
  const tokens = [];
  const seen = new Set();
  for (const raw of primary.toLowerCase().split(/[^a-z0-9+#.]+/)) {
    const token = raw.replace(/^[.+#]+|[.+#]+$/g, '');
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
    if (tokens.length >= 10) break;
  }
  const variant = tokens.join(' ');
  const queries = [primary];
  // Task phrases are poor search queries (engines keyword-match them into
  // homepage junk). A question form is what a human would type for an
  // unfamiliar task; search both and let the relevance gate decide.
  if (variant && !/^how to\b/i.test(primary)) queries.push(`how to ${variant}`);
  return queries.slice(0, 2);
}

// Exact-token relevance: search engines keyword-match task phrases into
// unrelated homepages (measured live: "open calculator..." returned OpenAI,
// Open University, and a French housing site). A result that shares no exact
// token with the query is noise by construction. Require overlap of at least
// MIN_RELEVANT_TOKENS distinct query tokens across title + snippet + url.
// Exact-token relevance: search engines keyword-match task phrases into
// unrelated homepages (measured live: "open calculator..." returned OpenAI,
// Open University, and a French housing site). A result that shares fewer
// than two exact query tokens across title + snippet + url is noise by
// construction — the single-token relaxation was measured to let dictionary
// homepages through, so the gate is strict.
const MIN_RELEVANT_TOKENS = 2;

function resultTokens(result) {
  return tokenize(`${result.title || ''} ${result.snippet || ''} ${result.url || ''}`);
}

function relevantResults(results, queryTokens) {
  const wanted = new Set(queryTokens);
  if (!wanted.size) return [];
  return results.filter(result => {
    // Distinct tokens only: a word appearing in both title and url ("open" in
    // a dictionary page) must not count twice and masquerade as relevance.
    let overlap = 0;
    for (const token of new Set(resultTokens(result))) if (wanted.has(token)) overlap += 1;
    return overlap >= MIN_RELEVANT_TOKENS;
  });
}

function tokenize(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(token => token.length > 2);
}

function extractReadableText(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|head|iframe|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractPassages(text, queryTokens, maxPassages = MAX_PASSAGES) {
  if (!text) return [];
  // Paragraph-ish chunks: split on sentence boundaries but keep chunks in the
  // 80-400 char band so a passage is a readable claim, not a whole page.
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length + 1 > PASSAGE_MAX_CHARS) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
    if (current.length >= PASSAGE_MAX_CHARS) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  const wanted = new Set(queryTokens);
  const scored = [];
  chunks.forEach((chunk, index) => {
    const trimmed = chunk.trim();
    if (trimmed.length < PASSAGE_MIN_CHARS) return;
    // Whole-word matching only: substring matching let unrelated language
    // passages score ("app" inside French "l'application") and surface as key
    // passages for tasks they had nothing to do with.
    const words = new Set(tokenize(trimmed));
    let overlap = 0;
    for (const token of wanted) if (words.has(token)) overlap += 1;
    if (!overlap) return;
    // Early-document passages tend to be summaries; small position bonus.
    const positionBonus = index < 6 ? 0.5 : 0;
    scored.push({ text: trimmed.slice(0, PASSAGE_MAX_CHARS), overlap: overlap + positionBonus, index });
  });
  scored.sort((a, b) => b.overlap - a.overlap || a.index - b.index);
  // Preserve document order among the winners so the summary reads coherently.
  return scored.slice(0, maxPassages).sort((a, b) => a.index - b.index).map(entry => entry.text);
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function createFetchPage({ fetchImpl = null, timeoutMs = PAGE_TIMEOUT_MS, maxBytes = PAGE_MAX_BYTES } = {}) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  return async function fetchPage(url, { signal = null } = {}) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) return { ok: false, aborted: true };
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9'
        },
        signal: controller.signal,
        redirect: 'follow'
      });
      if (!response.ok) return { ok: false, status: response.status };
      const contentType = String(response.headers?.get?.('content-type') || '');
      if (contentType && !/text\/html|text\/plain|text\/xml|application\/(xhtml|xml|json)/i.test(contentType)) {
        return { ok: false, reason: 'unsupported content-type' };
      }
      const declaredLength = Number(response.headers?.get?.('content-length') || 0);
      if (declaredLength > maxBytes) return { ok: false, reason: 'too large' };
      const body = await response.text();
      return { ok: true, text: body.length > maxBytes ? body.slice(0, maxBytes) : body, finalUrl: response.url || url };
    } catch (error) {
      if (signal?.aborted || controller.signal.aborted) return { ok: false, aborted: true };
      return { ok: false, reason: error?.message || 'fetch failed' };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

function buildFindings({ queries, tookMs, sources, passages, degraded, cached }) {
  const lines = [];
  lines.push(`Web research for this task (advisory; took ${(tookMs / 1000).toFixed(1)}s${cached ? ', cached' : ''}${degraded ? ', some search engines unavailable' : ''}).`);
  lines.push(`Queries: ${queries.map(query => `"${query}"`).join('; ')}`);
  if (sources.length) {
    lines.push('Sources:');
    sources.forEach((source, index) => lines.push(` [${index + 1}] ${source.title} — ${source.url}${source.engines?.length ? ` (${source.engines.join(', ')})` : ''}`));
  }
  if (passages.length) {
    lines.push('Key passages:');
    passages.forEach((passage) => lines.push(` [${passage.source}] "${passage.text}"`));
  }
  if (!sources.length) lines.push('No usable sources were found; rely on direct observation.');
  return lines.join('\n').slice(0, FINDINGS_CHAR_CAP);
}

// The entry point wired into the chat agent. Never throws; every outcome is a
// plain object the caller can discard.
async function runResearch({ task, signal = null, metaSearch = null, fetchPage = null, budgetMs = DEFAULT_BUDGET_MS, maxPages = DEFAULT_MAX_PAGES, now = Date.now } = {}) {
  const startedAt = now();
  try {
    const search = metaSearch || new MetaSearch();
    const readPage = fetchPage || createFetchPage();
    if (signal?.aborted) return { ok: false, aborted: true, tookMs: now() - startedAt };

    const queries = deriveQueries(task);
    if (!queries.length) return { ok: false, reason: 'no query', tookMs: now() - startedAt };

    const deadline = startedAt + budgetMs;
    const remaining = () => Math.max(0, deadline - now());

    let searchResult = await search.search({ query: queries[0], signal });
    if (signal?.aborted) return { ok: false, aborted: true, tookMs: now() - startedAt };
    // Both query forms are searched and merged: task phrases and how-to forms
    // surface different sources, and the relevance gate below discards noise.
    if (queries[1] && remaining() > 3_000) {
      const variant = await search.search({ query: queries[1], signal });
      if (variant?.ok) {
        const seen = new Set((searchResult?.results || []).map(result => normalizeUrl(result.url)));
        const extra = (variant.results || []).filter(result => {
          const url = normalizeUrl(result.url);
          if (!url || seen.has(url)) return false;
          seen.add(url);
          return true;
        });
        searchResult = searchResult?.ok
          ? { ...searchResult, results: [...(searchResult.results || []), ...extra] }
          : variant;
      }
    }
    if (!searchResult?.ok) {
      return { ok: false, reason: 'no search results', tookMs: now() - startedAt, degraded: Boolean(searchResult?.degraded) };
    }

    // Relevance gate BEFORE any page fetch: search engines keyword-match task
    // phrases into unrelated homepages (measured live), and every junk source
    // this pipeline ever recorded shared zero exact tokens with its query.
    const queryTokens = [...new Set(queries.flatMap(query => tokenize(query)))];
    const relevant = relevantResults(searchResult.results || [], queryTokens);
    if (!relevant.length) {
      // Honest empty: ok:false (not a failure signal upstream — the runner
      // discards silently), never findings, never a store write.
      return {
        ok: false, reason: 'no relevant sources', queries, tookMs: now() - startedAt, sources: [], passages: [],
        degraded: Boolean(searchResult.degraded), cached: Boolean(searchResult.cached), findings: ''
      };
    }

    const ranked = relevant;
    const perHost = new Map();
    const picked = [];
    for (const result of ranked) {
      const host = hostOf(result.url);
      if (!host) continue;
      const count = perHost.get(host) || 0;
      if (count >= MAX_PER_HOST) continue;
      perHost.set(host, count + 1);
      picked.push(result);
      if (picked.length >= maxPages) break;
    }

    const sources = [];
    const passages = [];
    for (const result of picked) {
      if (signal?.aborted) break;
      if (remaining() <= 500) break;
      const sourceIndex = sources.length + 1;
      let page;
      if (remaining() > 500) {
        // An in-flight read is raced against the remaining budget so one slow
        // page can never eat the whole allowance.
        let budgetTimer;
        page = await Promise.race([
          readPage(result.url, { signal }),
          new Promise(resolve => { budgetTimer = setTimeout(() => resolve({ ok: false, reason: 'budget' }), remaining()); })
        ]).finally(() => clearTimeout(budgetTimer));
      } else {
        page = { ok: false, reason: 'budget' };
      }
      sources.push({ title: result.title, url: result.url, engines: result.engines || [], read: Boolean(page?.ok) });
      if (page?.ok && page.text) {
        const text = extractReadableText(page.text);
        for (const passage of extractPassages(text, queryTokens)) {
          passages.push({ source: sourceIndex, text: passage });
          if (passages.length >= MAX_PASSAGES) break;
        }
      }
      if (passages.length >= MAX_PASSAGES) break;
    }

    const tookMs = now() - startedAt;
    return {
      ok: true,
      queries,
      tookMs,
      degraded: Boolean(searchResult.degraded) || sources.some(source => !source.read),
      cached: Boolean(searchResult.cached),
      sources,
      passages,
      findings: buildFindings({ queries, tookMs, sources, passages, degraded: Boolean(searchResult.degraded) || sources.some(source => !source.read), cached: Boolean(searchResult.cached) })
    };
  } catch (error) {
    if (signal?.aborted) return { ok: false, aborted: true, tookMs: now() - startedAt };
    return { ok: false, error: error?.message || 'research failed', tookMs: now() - startedAt };
  }
}

module.exports = { runResearch, deriveQueries, extractReadableText, extractPassages, createFetchPage, buildFindings, STOPWORDS };
