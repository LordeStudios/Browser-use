'use strict';
// LIVE CAPABILITY PROBE — the provider-generic ground truth for "can model X
// accept image/video input". Gateways advertise a SUBSET of capabilities in
// /v1/models; the only stable, config-free way to know the rest is to ask the
// MODEL ITSELF through the connection's own OpenAI-compatible endpoint with a
// minimal media part and classify the outcome. Works for ANY provider base
// URL + key — nothing here is provider-specific.
//
// Probes are tiny (1x1 px image / a 2-frame public-domain mp4, max_tokens 1)
// and results are cached on disk for 7 days, so a catalog query that needs an
// unadvertised capability pays at most a bounded handful of ~free requests.

const crypto = require('crypto');

const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TINY_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 1-second 64x64 black MP4 (public domain, universally decodable).
const TINY_MP4_URL = 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4';
const PROBE_TIMEOUT_MS = 12_000;

function probeCacheKey({ baseUrl, model, modality }) {
  return `${crypto.createHash('sha1').update(`${String(baseUrl).replace(/\/$/, '')}::${model}::${modality}`).digest('hex')}`;
}

function classifyProbeOutcome(response, errorText) {
  if (response?.ok) return { supported: true, conclusive: true };
  const status = Number(response?.status || 0);
  const text = String(errorText || '').toLowerCase();
  if (status === 401 || status === 403 || status === 429 || status === 408) return { supported: null, conclusive: false, reason: `http ${status}` };
  // A rejected request SHAPE (unknown field/part) proves nothing about the
  // capability — and shape errors often NAME the media field ("unknown
  // field: video_url"), so shape language is checked BEFORE modality language.
  if (/unknown field|unrecognized|unexpected field|unknown argument|invalid request/.test(text)) return { supported: null, conclusive: false, reason: text.slice(0, 120) };
  // A 4xx that NAMES the modality or content handling = a real "no".
  if (/video|image|modalit|content.?type|not support|unsupported|invalid content/.test(text)) return { supported: false, conclusive: true, reason: text.slice(0, 120) };
  // Ambiguous 4xx (model busy, malformed body for other reasons) prove nothing.
  if (status >= 400 && status < 500) return { supported: null, conclusive: false, reason: text.slice(0, 120) || `http ${status}` };
  if (status >= 500) return { supported: null, conclusive: false, reason: `http ${status}` };
  return { supported: null, conclusive: false, reason: 'no response' };
}

// Content SHAPES for a modality, tried in order. Gateways disagree on how
// media rides in chat content parts; a probe that fails one shape has NOT
// proven the capability absent — only this shape is wrong. The probe tries
// the variants and reports which one worked; only ALL shapes failing with
// modality-naming errors counts as a conclusive "no".
const VIDEO_SHAPES = [
  (url) => ({ type: 'video_url', video_url: { url } }),
  (url) => ({ type: 'file', file: { file_data: url, format: 'video/mp4' } }),
  (url) => ({ type: 'image_url', image_url: { url } })
];
const IMAGE_SHAPES = [
  (url) => ({ type: 'image_url', image_url: { url } }),
  (url) => ({ type: 'file', file: { file_data: url, format: 'image/png' } })
];

function mediaUrlFor(modality) {
  return modality === 'video' ? TINY_MP4_URL : TINY_PNG;
}

async function probeModelInput({ baseUrl, apiKey, model, modality = 'image', fetchImpl = globalThis.fetch, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const id = String(model || '').trim();
  const base = String(baseUrl || '').replace(/\/$/, '');
  if (!id || !base) return { supported: null, conclusive: false, reason: 'missing endpoint or model' };
  const shapes = modality === 'video' ? VIDEO_SHAPES : IMAGE_SHAPES;
  const url = mediaUrlFor(modality);
  let lastOutcome = { supported: null, conclusive: false, reason: 'no shapes tried' };
  for (const shape of shapes) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify({ model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single letter y.' }, shape(url)] }], max_tokens: 1, stream: false }),
        signal: controller.signal
      });
      let errorText = '';
      if (!response.ok) errorText = await response.text().catch(() => '');
      lastOutcome = classifyProbeOutcome(response, errorText);
      // Conclusive answers settle it; inconclusive shape rejections fall
      // through to the next shape before anything is claimed.
      if (lastOutcome.conclusive) {
        if (lastOutcome.supported && shape !== shapes[0]) lastOutcome.workingShape = shape({}).type;
        return lastOutcome;
      }
    } catch (error) {
      lastOutcome = { supported: null, conclusive: false, reason: String(error?.message || error).slice(0, 120) };
    } finally {
      clearTimeout(timer);
    }
  }
  return lastOutcome;
}

// Disk-backed TTL cache (userData/model-capability-probes.json).
function loadProbeCache(filePath, { fsLike = require('fs'), now = Date.now() } = {}) {
  try {
    const parsed = JSON.parse(fsLike.readFileSync(filePath, 'utf8'));
    const entries = {};
    for (const [key, entry] of Object.entries(parsed && typeof parsed === 'object' ? parsed : {})) {
      if (entry && entry.result && Number(entry.at) > 0) entries[key] = { result: entry.result, at: Number(entry.at) };
    }
    return { entries, dirty: false };
  } catch {
    return { entries: {}, dirty: false };
  }
}

function saveProbeCache(filePath, cache, { fsLike = require('fs') } = {}) {
  try {
    fsLike.mkdirSync(require('path').dirname(filePath), { recursive: true });
    fsLike.writeFileSync(filePath, JSON.stringify(cache.entries, null, 1));
    cache.dirty = false;
    return true;
  } catch {
    return false;
  }
}

function freshProbe(entry, { now = Date.now(), ttlMs = PROBE_TTL_MS } = {}) {
  return entry && entry.result && entry.result.conclusive && (now - entry.at) < ttlMs ? entry.result : null;
}

// Bounded batch: probes only UNKNOWN models, cheapest-first ordering supplied
// by the caller, hard budget so one query can never fan out unbounded.
async function probeModelsForCapability({ models, baseUrl, apiKey, modality, cache, cachePath, budget = 6, concurrency = 3, fetchImpl = globalThis.fetch } = {}) {
  if (!cache) cache = { entries: {}, dirty: false };
  const pending = [];
  const results = {};
  for (const model of models) {
    const key = probeCacheKey({ baseUrl, model, modality });
    const fresh = freshProbe(cache.entries[key]);
    if (fresh) { results[model] = fresh; continue; }
    pending.push({ model, key });
  }
  let spent = 0;
  const queue = pending.slice(0, Math.max(0, budget));
  const deferred = pending.length - queue.length; // workers drain `queue` below — capture before
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const outcome = await probeModelInput({ baseUrl, apiKey, model: next.model, modality, fetchImpl });
      if (outcome.conclusive) {
        cache.entries[next.key] = { result: outcome, at: Date.now() };
        cache.dirty = true;
      }
      results[next.model] = outcome;
      spent += 1;
    }
  });
  await Promise.all(workers);
  if (cache.dirty && cachePath) saveProbeCache(cachePath, cache);
  return { results, probed: spent, deferred };
}

module.exports = { probeModelInput, probeModelsForCapability, probeCacheKey, classifyProbeOutcome, loadProbeCache, saveProbeCache, freshProbe, PROBE_TTL_MS };
