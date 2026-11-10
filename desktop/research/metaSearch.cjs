'use strict';

// Contained meta-search: searXNG's contract (fan a query out to several
// engines, normalize, deduplicate, rank-fuse, return JSON) implemented as a
// pure Node module inside the Electron main process. No Docker, no external
// service, no new processes, no API keys.
//
// Safety posture (see researchPipeline_flow_chat.md):
// - Human-scale volume: one search call per research task, not a crawler.
// - Per-engine token-bucket rate limits plus a global concurrency cap.
// - Cache-first: an identical query within the TTL performs zero requests.
// - Health registry: a challenged or failing engine cools down exponentially
//   and is skipped — never retried through, never solved, never proxied.
// - A degraded or fully empty result is an ordinary outcome; callers treat
//   findings as advisory.

const TRACKING_PARAM_RE = /^(utm_|fbclid$|gclid$|msclkid$|ref$|ref_src$|ref_url$|cmpid$|mc_cid$|mc_eid$|igshid$|_hsenc$|_hsmi$|s_kwcid$|yclid$)/;
const DEFAULT_LIMIT = 8;
const DEFAULT_CACHE_TTL_MS = 300_000;
const MAX_CACHE_ENTRIES = 200;
const GLOBAL_CONCURRENCY = 4;
const RRF_K = 60;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => {
      const point = Number(code);
      return Number.isFinite(point) && point > 0 && point < 0x110000 ? String.fromCodePoint(point) : ' ';
    });
}

function stripTags(value) {
  return decodeEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(body, regex) {
  const match = regex.exec(body);
  return match ? match[1] : '';
}

function unwrapDdgLink(href) {
  let url = String(href || '').trim();
  if (url.startsWith('//')) url = `https:${url}`;
  const redirect = url.match(/[?&]uddg=([^&]+)/);
  if (redirect) {
    try { url = decodeURIComponent(redirect[1]); } catch { url = redirect[1]; }
  }
  return url;
}

// Bing's RSS surface is the most parser-stable and ToS-considerate of the
// major engines: one XML document, no scraping markup to chase.
function parseBingRss(body) {
  const results = [];
  const items = String(body || '').match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    const title = stripTags(firstMatch(item, /<title>([\s\S]*?)<\/title>/));
    const url = decodeEntities(firstMatch(item, /<link>([\s\S]*?)<\/link>/)).trim();
    const snippet = stripTags(firstMatch(item, /<description>([\s\S]*?)<\/description>/));
    if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet });
  }
  return results;
}

function parseDuckDuckGo(body) {
  const results = [];
  const anchors = String(body || '').match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*>[\s\S]*?<\/a>/g) || [];
  const snippets = String(body || '').match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>[\s\S]*?<\/a>/g) || [];
  for (let index = 0; index < anchors.length; index += 1) {
    const anchor = anchors[index];
    const href = firstMatch(anchor, /href="([^"]+)"/);
    const url = unwrapDdgLink(href);
    const title = stripTags(anchor.replace(/^<a[^>]*>/, ''));
    const snippet = snippets[index] ? stripTags(snippets[index].replace(/^<a[^>]*>/, '')) : '';
    if (title && /^https?:\/\//i.test(url) && !/duckduckgo\.com\/y\.js/.test(url)) {
      results.push({ title, url, snippet });
    }
  }
  return results;
}

function parseMojeek(body) {
  const results = [];
  const blocks = String(body || '').match(/<a[^>]+class="title"[^>]*>[\s\S]*?<\/a>[\s\S]{0,600}?<p[^>]*class="s"[^>]*>[\s\S]*?<\/p>/g) || [];
  for (const block of blocks) {
    const href = firstMatch(block, /href="([^"]+)"/);
    const title = stripTags(block.replace(/^<a[^>]*>/, '').replace(/<p[\s\S]*$/, ''));
    const snippet = stripTags(firstMatch(block, /<p[^>]*class="s"[^>]*>([\s\S]*?)<\/p>/));
    if (title && /^https?:\/\//i.test(href)) results.push({ title, url: href, snippet });
  }
  return results;
}

function parseQwant(body) {
  const results = [];
  try {
    const payload = JSON.parse(String(body || ''));
    const groups = payload?.data?.result?.items?.mainline || [];
    for (const group of groups) {
      for (const item of group?.items || []) {
        const title = stripTags(item?.title);
        const url = String(item?.url || '');
        if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet: stripTags(item?.desc) });
      }
    }
  } catch { /* markup or shape change: degrade to zero results for this engine */ }
  return results;
}

// Google's markup shifts constantly and it challenges automated clients the
// most aggressively, so this adapter is deliberately conservative: modest
// rate limit, two anchor shapes, and a fast path to the health registry when
// a challenge page arrives.
function parseGoogle(body) {
  const results = [];
  const seen = new Set();
  const patterns = [
    /<a[^>]+href="\/url\?q=([^&"]+)[^"]*"[^>]*>(?:<[^>]+>)*<h3[^>]*>([\s\S]*?)<\/h3>/gi,
    /<a[^>]+href="(https?:\/\/(?!www\.google\.|news\.google\.|maps\.google\.)[^"]+)"[^>]*>(?:<[^>]+>)*<h3[^>]*>([\s\S]*?)<\/h3>/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(String(body || ''))) !== null) {
      const url = unwrapDdgLink(decodeEntities(match[1]));
      const title = stripTags(match[2]);
      if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
      seen.add(url);
      results.push({ title, url, snippet: '' });
    }
    if (results.length >= 10) break;
  }
  return results;
}

function parseBrave(body) {
  const results = [];
  const seen = new Set();
  const blocks = String(body || '').match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*>[\s\S]{0,400}?<\/a>/g) || [];
  for (const block of blocks) {
    const href = firstMatch(block, /href="(https?:\/\/[^"]+)"/);
    if (!/^https?:\/\//i.test(href) || /search\.brave\.com|brave\.com\/(privacy|faq|about)/i.test(href)) continue;
    const title = stripTags(block.replace(/^<a[^>]*>/, ''));
    if (!title || title.length < 8 || seen.has(href)) continue;
    seen.add(href);
    results.push({ title, url: href, snippet: '' });
    if (results.length >= 12) break;
  }
  return results;
}

function parseYahoo(body) {
  const results = [];
  const seen = new Set();
  const anchors = String(body || '').match(/<a[^>]+class="[^"]*\bac-[^"]*"[^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g)
    || String(body || '').match(/<h3[^>]*class="title[^"]*"[^>]*>[\s\S]*?<\/h3>/g) || [];
  for (const anchor of anchors) {
    let href = firstMatch(anchor, /href="([^"]+)"/);
    const title = stripTags(anchor.replace(/^<h3[^>]*>/, '').replace(/^<a[^>]*>/, ''));
    const proxy = href.match(/[?&]ru=([^&]+)/);
    if (proxy) {
      try { href = decodeURIComponent(proxy[1]); } catch { href = proxy[1]; }
    }
    if (!title || !/^https?:\/\//i.test(href) || seen.has(href)) continue;
    seen.add(href);
    results.push({ title, url: href, snippet: '' });
    if (results.length >= 12) break;
  }
  return results;
}

// Keyless OFFICIAL APIs first: they welcome programmatic access (no bot wall,
// no ToS gray area) and cover exactly the questions a computer-use agent has —
// "how do I do X on Windows" lives on Superuser; "what is X" on Wikipedia.
// Measured live from this environment: Stack Exchange 200/real results,
// Wikipedia 200, HN Algolia 200 — while every scraper engine (Bing RSS,
// DuckDuckGo, Mojeek, Brave, Yahoo, Qwant, Google) is bot-walled or serves
// canned junk, so they stay as degraded best-effort fallbacks only.
function parseStackExchange(body) {
  const results = [];
  try {
    const payload = JSON.parse(String(body || ''));
    for (const item of payload?.items || []) {
      const title = stripTags(item?.title);
      const url = String(item?.link || '');
      if (title && /^https?:\/\//i.test(url)) {
        results.push({ title, url, snippet: stripTags(item?.excerpt || '') });
      }
    }
  } catch { /* shape change: degrade to zero results */ }
  return results;
}

function parseWikipediaSearch(body) {
  const results = [];
  try {
    const payload = JSON.parse(String(body || ''));
    for (const item of payload?.query?.search || []) {
      const title = stripTags(item?.title);
      if (!title) continue;
      results.push({ title, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title).replace(/\s+/g, '_'))}`, snippet: stripTags(item?.snippet || '') });
    }
  } catch { /* degrade */ }
  return results;
}

function parseHnAlgolia(body) {
  const results = [];
  try {
    const payload = JSON.parse(String(body || ''));
    for (const item of payload?.hits || []) {
      const title = stripTags(item?.title || item?.story_title || '');
      const url = String(item?.url || `https://news.ycombinator.com/item?id=${item?.objectID || ''}`);
      if (title && /^https?:\/\//i.test(url)) results.push({ title, url, snippet: '' });
    }
  } catch { /* degrade */ }
  return results;
}

// API engines need KEYWORDS, not task phrases: a 15-word imperative sent to
// Stack Exchange returns nothing, and Wikipedia's lenient matcher surfaces
// loosely-related pages whose snippets happen to contain query words (measured
// live: "HFS Plus" for a Calculator task). Strip stopwords and bare numbers.
const KEYWORD_STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'from', 'with', 'by', 'at', 'is', 'are', 'be', 'this', 'that', 'it', 'its', 'as', 'how', 'do', 'does', 'i', 'my', 'me', 'we', 'you', 'your']);
function toKeywords(query, max = 8) {
  return String(query || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(token => token.length > 1 && !KEYWORD_STOPWORDS.has(token) && !/^\d+$/.test(token))
    .slice(0, max).join(' ');
}

const ENGINES = [
  // Stack Exchange's q= is AND-semantics: seven keywords match nothing
  // (measured live), while four to five match the right questions.
  { name: 'stackexchange', buildUrl: q => `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=superuser&pagesize=10&q=${encodeURIComponent(toKeywords(q, 5))}`, parse: parseStackExchange, minIntervalMs: 5000, timeoutMs: 6000 },
  { name: 'wikipedia', buildUrl: q => `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(toKeywords(q, 4))}&format=json&srlimit=8`, parse: parseWikipediaSearch, minIntervalMs: 1000, timeoutMs: 6000 },
  { name: 'hn', buildUrl: q => `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(toKeywords(q, 4))}&hitsPerPage=8`, parse: parseHnAlgolia, minIntervalMs: 1000, timeoutMs: 6000 },
  { name: 'bing', buildUrl: q => `https://www.bing.com/search?q=${encodeURIComponent(q)}&format=rss&count=15`, parse: parseBingRss, minIntervalMs: 1500, timeoutMs: 6000 },
  { name: 'duckduckgo', buildUrl: q => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, parse: parseDuckDuckGo, minIntervalMs: 800, timeoutMs: 6000 },
  { name: 'mojeek', buildUrl: q => `https://www.mojeek.com/search?q=${encodeURIComponent(q)}`, parse: parseMojeek, minIntervalMs: 800, timeoutMs: 6000 },
  { name: 'qwant', buildUrl: q => `https://api.qwant.com/v3/search/web?q=${encodeURIComponent(q)}&count=10&locale=en_US&offset=0&device=desktop&safesearch=1`, parse: parseQwant, minIntervalMs: 800, timeoutMs: 6000 },
  { name: 'brave', buildUrl: q => `https://search.brave.com/search?q=${encodeURIComponent(q)}`, parse: parseBrave, minIntervalMs: 800, timeoutMs: 6000 },
  { name: 'yahoo', buildUrl: q => `https://search.yahoo.com/search?p=${encodeURIComponent(q)}`, parse: parseYahoo, minIntervalMs: 800, timeoutMs: 6000 },
  { name: 'google', buildUrl: q => `https://www.google.com/search?q=${encodeURIComponent(q)}&num=15&hl=en`, parse: parseGoogle, minIntervalMs: 3000, timeoutMs: 6000 }
];

const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

function normalizeUrl(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return ''; }
  if (!/^https?:$/.test(parsed.protocol)) return '';
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAM_RE.test(key)) parsed.searchParams.delete(key);
  }
  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) parsed.pathname = parsed.pathname.slice(0, -1);
  return parsed.toString();
}

function tokenizeTitle(title) {
  return new Set(String(title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(token => token.length > 2));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

class MetaSearch {
  constructor({ fetchImpl = null, engines = ENGINES, cacheTtlMs = DEFAULT_CACHE_TTL_MS, now = Date.now, maxCacheEntries = MAX_CACHE_ENTRIES, requestHeaders = REQUEST_HEADERS } = {}) {
    this.fetchImpl = fetchImpl || ((url, options) => fetch(url, options));
    this.engines = engines;
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.maxCacheEntries = maxCacheEntries;
    this.requestHeaders = requestHeaders;
    this.cache = new Map();
    this.inflight = new Map();
    this.health = new Map(engines.map(engine => [engine.name, { failures: 0, cooldownUntil: 0, lastUsedAt: 0 }]));
    this.lastRequestAt = new Map();
    this.inflightRequests = 0;
    this.waiters = [];
  }

  // Token bucket: global concurrency cap, then the per-engine minimum interval.
  async acquireSlot(engine) {
    if (this.inflightRequests >= GLOBAL_CONCURRENCY) {
      await new Promise(resolve => this.waiters.push(resolve));
    }
    this.inflightRequests += 1;
    const health = this.health.get(engine.name);
    const last = this.lastRequestAt.get(engine.name) || 0;
    const earliest = Math.max(last + engine.minIntervalMs, health?.cooldownUntil || 0);
    const waitMs = earliest - this.now();
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    this.lastRequestAt.set(engine.name, this.now());
  }

  releaseSlot() {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    const waiter = this.waiters.shift();
    if (waiter) waiter();
  }

  markHealth(engine, ok) {
    const health = this.health.get(engine.name);
    if (!health) return;
    if (ok) {
      health.failures = 0;
      health.cooldownUntil = 0;
      return;
    }
    health.failures += 1;
    // One failure is ordinary (transient network, one slow response): retry on
    // the next task. From the second consecutive failure the engine cools down
    // exponentially — it is skipped without a request, never retried through.
    if (health.failures < 2) return;
    const cooldownMs = Math.min(60_000 * 2 ** Math.max(0, health.failures - 2), 30 * 60_000);
    health.cooldownUntil = this.now() + cooldownMs;
  }

  normalizeQuery(query) {
    return String(query || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 400);
  }

  async fetchEngine(engine, query) {
    const health = this.health.get(engine.name);
    const statuses = { ok: 'ok', cooldown: 'cooldown', error: 'error', empty: 'empty', aborted: 'aborted' };
    if (health && this.now() < health.cooldownUntil) {
      return { status: statuses.cooldown, results: [], ms: 0 };
    }
    const startedAt = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), engine.timeoutMs || 6000);
    try {
      await this.acquireSlot(engine);
      const response = await this.fetchImpl(engine.buildUrl(query), { headers: this.requestHeaders, signal: controller.signal, redirect: 'follow' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = String(response.headers?.get?.('content-type') || '');
      if (contentType && !/text\/|application\/(rss|xml|json)/i.test(contentType)) throw new Error(`unsupported content-type ${contentType}`);
      const body = await response.text();
      const results = (engine.parse(body) || []).slice(0, 15);
      const status = results.length ? statuses.ok : statuses.empty;
      this.markHealth(engine, status === statuses.ok);
      return { status, results, ms: this.now() - startedAt };
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === 'AbortError';
      if (!aborted) this.markHealth(engine, false);
      return { status: aborted ? statuses.aborted : statuses.error, results: [], ms: this.now() - startedAt };
    } finally {
      clearTimeout(timer);
      this.releaseSlot();
    }
  }

  mergeResults(engineOutcomes, limit) {
    const byKey = new Map();
    for (const outcome of engineOutcomes) {
      if (outcome.status !== 'ok') continue;
      outcome.results.forEach((result, rank) => {
        const url = normalizeUrl(result.url);
        if (!url) return;
        const key = url;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { title: result.title, url: result.url, normalizedUrl: url, snippet: result.snippet || '', engines: [], score: 0, titleTokens: tokenizeTitle(result.title) };
          byKey.set(key, entry);
        }
        entry.engines.push(outcome.engine.name);
        entry.score += 1 / (RRF_K + rank + 1);
        if (!entry.snippet && result.snippet) entry.snippet = result.snippet;
        // Prefer the cleanest URL among duplicates: the shortest variant of the
        // same normalized target drops tracking/redirect parameters and avoids
        // surfacing affiliate or campaign links to the agent.
        if (result.url.length < entry.url.length) {
          entry.url = result.url;
          entry.title = result.title;
          entry.titleTokens = tokenizeTitle(result.title);
          if (result.snippet && !entry.snippet) entry.snippet = result.snippet;
        } else if (result.title && result.title.length > entry.title.length) {
          entry.title = result.title;
          entry.titleTokens = tokenizeTitle(result.title);
        }
      });
    }
    const entries = [...byKey.values()];
    // Title near-duplicates across different URLs (syndicated copies, AMP
    // variants) collapse to the highest-ranked copy.
    entries.sort((a, b) => b.score - a.score);
    const kept = [];
    for (const entry of entries) {
      if (kept.some(other => jaccard(other.titleTokens, entry.titleTokens) >= 0.85)) continue;
      kept.push(entry);
      if (kept.length >= limit) break;
    }
    return kept.map(({ title, url, snippet, engines, score }) => ({ title, url, snippet, engines, score: Number(score.toFixed(6)) }));
  }

  async search({ query, limit = DEFAULT_LIMIT, signal = null } = {}) {
    const text = String(query || '').trim();
    if (!text) return { ok: false, error: 'query required', results: [], engines: [], degraded: false };
    const key = this.normalizeQuery(text);
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      return { ...cached.result, cached: true };
    }
    if (signal?.aborted) return { ok: false, aborted: true, results: [], engines: [], degraded: false };
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    const startedAt = this.now();
    const promise = (async () => {
      const outcomes = await Promise.all(this.engines.map(async engine => {
        const outcome = await this.fetchEngine(engine, text);
        return { ...outcome, engine };
      }));
      const results = this.mergeResults(outcomes, limit);
      const engineReport = outcomes.map(({ engine, status, results: count, ms }) => ({ name: engine.name, status, count: Array.isArray(count) ? count.length : 0, ms }));
      const okEngines = outcomes.filter(outcome => outcome.status === 'ok');
      const result = {
        ok: okEngines.length > 0,
        query: text,
        tookMs: this.now() - startedAt,
        results,
        engines: engineReport,
        degraded: okEngines.length > 0 && okEngines.length < outcomes.length
      };
      if (result.ok) {
        this.cache.set(key, { at: this.now(), result });
        if (this.cache.size > this.maxCacheEntries) {
          const oldest = this.cache.keys().next().value;
          this.cache.delete(oldest);
        }
      }
      return result;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
}

module.exports = { MetaSearch, normalizeUrl, tokenizeTitle, jaccard, decodeEntities, stripTags, ENGINES, TRACKING_PARAM_RE };
