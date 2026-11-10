'use strict';

// Xkiro live web-search client (https://docs.xkiro.com/api/web-search/):
// POST /v1/search with Bearer auth, model 'xkiro/web-search', structured
// results (title/url/snippet) — no scraping, no challenge walls. The research
// agent uses this as its PRIMARY search when the run's provider is xkiro,
// falling back to real-Google-in-tab on any failure. Never constructed for
// non-xkiro providers. The same client also serves /v1/fetch (model
// 'xkiro/web-fetch', https://docs.xkiro.com/api/web-fetch/): structured page
// content for up to N URLs without opening any tab.

function createXkiroSearch({ baseUrl, apiKey, fetchImpl = null, timeoutMs = 12_000 } = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const endpoint = /\/v1$/.test(base) ? `${base}/search` : `${base}/v1/search`;
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));

  async function search({ query, maxResults = 8, signal = null } = {}) {
    const text = String(query || '').trim();
    if (!text) return { ok: false, error: 'empty query' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromSignal = () => controller.abort();
    signal?.addEventListener('abort', abortFromSignal, { once: true });
    try {
      const response = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${String(apiKey || '')}` },
        body: JSON.stringify({
          model: 'xkiro/web-search',
          query: text.slice(0, 300),
          max_results: Math.min(Math.max(Number(maxResults) || 8, 1), 20)
        }),
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, error: `xkiro search HTTP ${response.status}` };
      const payload = await response.json();
      const results = (Array.isArray(payload?.results) ? payload.results : [])
        .map((entry) => ({
          title: String(entry?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          url: String(entry?.url || '').trim().slice(0, 500),
          snippet: String(entry?.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 300)
        }))
        .filter((entry) => /^https?:\/\//i.test(entry.url) && entry.title);
      return { ok: results.length > 0, results, query: text };
    } catch (error) {
      return { ok: false, error: String(error?.message || 'xkiro search failed').slice(0, 200) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromSignal);
    }
  }

  async function fetchPages({ urls = [], maxContentTokens = 4000, signal = null } = {}) {
    const list = (Array.isArray(urls) ? urls : []).map((url) => String(url || '').trim()).filter((url) => /^https?:\/\//i.test(url)).slice(0, 5);
    if (!list.length) return { ok: false, error: 'no valid http(s) urls' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abortFromSignal = () => controller.abort();
    signal?.addEventListener('abort', abortFromSignal, { once: true });
    try {
      const response = await doFetch(endpoint.replace(/\/search$/, '/fetch'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${String(apiKey || '')}` },
        body: JSON.stringify({ model: 'xkiro/web-fetch', urls: list, max_content_tokens: Math.min(Math.max(Number(maxContentTokens) || 4000, 500), 20_000) }),
        signal: controller.signal
      });
      if (!response.ok) return { ok: false, error: `xkiro fetch HTTP ${response.status}` };
      const payload = await response.json();
      const results = (Array.isArray(payload?.results) ? payload.results : [])
        .map((entry) => ({
          url: String(entry?.url || '').trim().slice(0, 500),
          title: String(entry?.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
          content: String(entry?.content || '').slice(0, 12_000)
        }))
        .filter((entry) => entry.url && entry.content);
      return { ok: results.length > 0, results };
    } catch (error) {
      return { ok: false, error: String(error?.message || 'xkiro fetch failed').slice(0, 200) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromSignal);
    }
  }

  return { search, fetchPages };
}

module.exports = { createXkiroSearch };
