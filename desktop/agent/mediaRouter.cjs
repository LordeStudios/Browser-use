'use strict';

// Media router: one entry point for every NON-language model task (image, tts,
// stt, video). The kind decides the request path; the catalogue supplies
// candidates; failures fall through to the next same-kind model. No model ids
// and no default voices are hardcoded here — callers pass what they resolved.

const MODEL_KINDS = Object.freeze(['language', 'image', 'tts', 'stt', 'video']);
const KIND_PATHS = Object.freeze({
  language: '/chat/completions',
  image: '/images/generations',
  tts: '/audio/speech',
  stt: '/audio/transcriptions',
  video: '/video/generations',
});
// Image and video gateways commonly accept a generation and answer 202 with an
// async job envelope ({id, status:'processing'}); the asset is then served at
// GET <path>/<jobId>. TTS/STT answer synchronously.
const ASYNC_KINDS = Object.freeze(new Set(['image', 'video']));
const TRANSIENT_STATUSES = Object.freeze(new Set([408, 425, 429, 500, 502, 503, 504]));

function inferModelKind(id = '') {
  const name = String(id || '').toLowerCase();
  if (/(?:^|\/)(gpt-image|dall-e|image-gen|stable-?diffusion|midjourney|flux-|seedream|imagen|banana)/.test(name)) return 'image';
  if (/video|sora|kling|runway|veo|pika/.test(name)) return 'video';
  if (/whisper|transcrib|stt|speech-to-text/.test(name)) return 'stt';
  if (/(?:^|\/)(tts|text-to-speech)|speech|voice|audio/.test(name)) return 'tts';
  if (/embed|rerank/.test(name)) return 'language';
  return 'language';
}

function parseJsonLenient(text = '') {
  const raw = String(text || '');
  try { return JSON.parse(raw); } catch {}
  const unfenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(unfenced); } catch {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch {}
  }
  return null;
}

// Deep-walk any gateway payload for usable image references in nonstandard
// fields (message.images, b64_json, bare URLs, markdown images, data URLs).
function deepFindImage(node, out = [], depth = 0) {
  if (depth > 8 || out.length >= 6) return out;
  if (typeof node === 'string') {
    const dm = /data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]{100,}/.exec(node);
    if (dm) { out.push({ dataUrl: dm[0] }); return out; }
    const md = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/.exec(node);
    if (md) { out.push({ url: md[1] }); return out; }
    const bare = /https?:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp)(?:\?[^\s"'<>]*)?/i.exec(node);
    if (bare) out.push({ url: bare[0] });
    return out;
  }
  if (Array.isArray(node)) { for (const item of node) deepFindImage(item, out, depth + 1); return out; }
  if (node && typeof node === 'object') {
    if (typeof node.b64_json === 'string' && node.b64_json.length > 100) out.push({ dataUrl: 'data:image/png;base64,' + node.b64_json });
    if (typeof node.audio_base64 === 'string' && node.audio_base64.length > 100) out.push({ dataUrl: 'data:image/png;base64,' + node.audio_base64 });
    for (const value of Object.values(node)) deepFindImage(value, out, depth + 1);
  }
  return out;
}

function excerpt(text = '', cap = 220) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, cap);
}

function describeFailure(response, bodyText = '') {
  let detail = '';
  try {
    const parsed = JSON.parse(bodyText);
    detail = parsed?.error?.message || parsed?.message || '';
  } catch { detail = excerpt(bodyText); }
  return `HTTP ${response.status}${detail ? `: ${excerpt(detail)}` : ''}`;
}

async function pollJob({ fetchImpl, url, apiKey, pollIntervalMs, pollTimeoutMs, onNote }) {
  const deadline = Date.now() + pollTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    const response = await fetchImpl(url, { headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` } });
    const text = await response.text();
    const payload = parseJsonLenient(text);
    if (!response.ok) {
      // A not-yet-visible job id can briefly 404 right after submission; keep
      // polling until the deadline instead of failing the whole task.
      if (response.status === 404) continue;
      throw new Error(`job poll failed: ${describeFailure(response, text)}`);
    }
    const status = String(payload?.status || '').toLowerCase();
    if (status === 'succeeded' || payload?.data || payload?.url) return payload;
    if (status === 'failed') throw new Error(`job failed: ${excerpt(payload?.error?.message || text)}`);
    if (typeof onNote === 'function') onNote(`job ${status || 'processing'}`);
  }
  throw new Error('job polling timed out');
}

async function fetchAssetDataUrl(fetchImpl, url, apiKey) {
  const response = await fetchImpl(url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!response.ok) throw new Error(`asset download failed: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const mimeType = response.headers?.get?.('content-type') || 'image/png';
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

// One candidate attempt. Throws on failure; returns a normalized result.
async function attemptOnce(options) {
  const {
    baseUrl, apiKey, kind, model, prompt, voice, fileBase64, filename,
    fetchImpl, timeoutMs, pollIntervalMs = 10_000, pollTimeoutMs = 240_000, signal, onNote,
  } = options;
  const path = KIND_PATHS[kind];
  if (!path) throw new Error(`Unknown model kind: ${kind}`);
  const headers = { accept: 'application/json', authorization: `Bearer ${apiKey}` };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
  let response;
  let binaryBuffer = null;
  try {
    if (kind === 'stt') {
      const form = new FormData();
      form.append('model', model);
      form.append('file', new Blob([Buffer.from(String(fileBase64 || ''), 'base64')]), String(filename || 'audio.wav'));
      response = await fetchImpl(baseUrl + path, { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal });
    } else if (kind === 'image' && options.imageBase64) {
      // IMAGE EDIT (docs.xkiro.com/api/images-edits): multipart POST
      // /v1/images/edits — the source image rides as `image`, the prompt
      // describes the change. The 202 async job envelope and polling are
      // identical to generations, so the shared path below is reused.
      const form = new FormData();
      form.append('model', model);
      form.append('prompt', String(prompt || '').slice(0, 4000));
      form.append('image', new Blob([Buffer.from(String(options.imageBase64 || ''), 'base64')]), String(options.imageFilename || 'source.png'));
      if (options.size) form.append('size', String(options.size));
      response = await fetchImpl(baseUrl + path.replace('/generations', '/edits'), { method: 'POST', headers: { authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal });
    } else {
      const body = kind === 'tts'
        ? { model, input: String(prompt || '').slice(0, 4000), ...(voice ? { voice } : {}), response_format: 'mp3' }
        : kind === 'language'
          ? { model, messages: [{ role: 'user', content: String(prompt || '') }], stream: false }
          : { model, prompt: String(prompt || '').slice(0, 4000), n: 1 };
      response = await fetchImpl(baseUrl + path, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    }
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new Error(describeFailure(response, await response.text()));
  const contentType = String(response.headers?.get?.('content-type') || '');

  if (kind === 'tts') {
    // Audio answers are binary: read bytes directly, never text().
    binaryBuffer = Buffer.from(await response.arrayBuffer());
    if (/audio\//.test(contentType) || /ID3|ÿû|ÿó/.test(binaryBuffer.subarray(0, 4).toString('binary'))) {
      if (binaryBuffer.length < 1000) throw new Error('TTS returned no usable audio.');
      return { kind: 'audio', dataUrl: 'data:audio/mpeg;base64,' + binaryBuffer.toString('base64') };
    }
    // Some gateways wrap audio in JSON (b64/url) instead of streaming bytes.
    const payload = parseJsonLenient(binaryBuffer.toString('utf8'));
    const found = payload ? deepFindImage(payload) : [];
    if (found.length && found[0].url) return { kind: 'audio', url: found[0].url };
    if (found.length && found[0].dataUrl) return { kind: 'audio', dataUrl: found[0].dataUrl };
    throw new Error('TTS returned no usable audio.');
  }

  const rawBody = await response.text();
  let payload = parseJsonLenient(rawBody);
  if (!payload) throw new Error(`malformed JSON from ${model}: ${excerpt(rawBody)}`);

  // Async job envelope: submit accepted, asset not ready yet.
  const jobId = payload?.id && !payload?.data && !payload?.choices
    ? String(payload.id)
    : null;
  const looksAsync = jobId && (ASYNC_KINDS.has(kind) || /^(?:processing|queued|pending)$/i.test(String(payload.status || '')));
  if (looksAsync && (payload?.status === undefined || /^(?:processing|queued|pending)$/i.test(String(payload.status || '')))) {
    if (onNote) onNote(`job accepted (${jobId})`);
    payload = await pollJob({ fetchImpl, url: baseUrl + path + '/' + encodeURIComponent(jobId), apiKey, pollIntervalMs, pollTimeoutMs, onNote });
  }

  if (kind === 'image' || kind === 'video') {
    const item = Array.isArray(payload?.data) ? payload.data[0] : null;
    const directUrl = String(item?.url || payload?.url || payload?.result?.url || '');
    const b64 = String(item?.b64_json || payload?.b64_json || '');
    if (directUrl) return { kind: kind === 'image' ? 'image' : 'video', url: directUrl };
    if (b64) return { kind: kind === 'image' ? 'image' : 'video', dataUrl: `data:image/png;base64,${b64}` };
    const found = deepFindImage(payload);
    if (found.length) return { kind: kind === 'image' ? 'image' : 'video', ...(found[0].dataUrl ? { dataUrl: found[0].dataUrl } : { url: found[0].url }) };
    throw new Error(`${kind} response carried no asset.`);
  }

  if (kind === 'stt') {
    const text = payload?.text ?? payload?.result?.text;
    if (typeof text !== 'string') throw new Error('STT response carried no text.');
    return { kind: 'transcription', text };
  }

  // language
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('chat response carried no content.');
  return { kind: 'text', text: content };
}

// Run one non-language model task with a fallback cycle through the catalogue.
// candidates: [primaryModel, ...fallbacks] — each gets exactly one bounded
// attempt (transient HTTP statuses get one internal retry). Returns
// {ok:true, kind, model, ...asset} or {ok:false, kind, errors:[{model,error}]}.
// ASYNC-JOB budget floors, testable and used by runModelTask.
function effectiveBudgets(kind, { timeoutMs = 180_000, pollTimeoutMs = 240_000 } = {}) {
  const isAsyncKind = ASYNC_KINDS.has(kind);
  return {
    timeoutMs: isAsyncKind ? Math.max(timeoutMs, 300_000) : timeoutMs,
    pollTimeoutMs: isAsyncKind ? Math.max(pollTimeoutMs, 900_000) : pollTimeoutMs
  };
}

async function runModelTask(options) {
  const {
    baseUrl, apiKey, kind, model = '', prompt = '', voice, fileBase64, filename,
    imageBase64 = null, imageFilename = null, size = null,
    fallbackModels = [], fetchImpl = globalThis.fetch, timeoutMs = 180_000,
    pollIntervalMs = 10_000, pollTimeoutMs = 240_000, onNote,
  } = options;
  if (!MODEL_KINDS.includes(kind)) throw new Error(`Unknown model kind: ${kind}`);
  if (!baseUrl) throw new Error('A provider base URL is required.');
  if (!apiKey) throw new Error('An API key is required.');
  // ASYNC-JOB BUDGETS (image/video): gpt-image-2.5-class generation and
  // editing routinely takes 3-8 minutes server-side — the old 240s poll
  // ceiling failed jobs that were HEALTHY and still rendering ("polling
  // timed out" on a good request). Image/video get a 15-minute poll ceiling
  // and a 5-minute initial-request budget; language stays as passed.
  const budgets = effectiveBudgets(kind, { timeoutMs, pollTimeoutMs });
  const effectiveTimeoutMs = budgets.timeoutMs;
  const effectivePollTimeoutMs = budgets.pollTimeoutMs;
  const candidates = [...new Set([String(model || '').trim(), ...fallbackModels.map(m => String(m || '').trim())].filter(Boolean))];
  if (!candidates.length) throw new Error(`No ${kind} model is available on this connection. Add one or pick it in settings.`);
  const errors = [];
  for (const candidate of candidates) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await attemptOnce({ baseUrl, apiKey, kind, model: candidate, prompt, voice, fileBase64, filename, imageBase64, imageFilename, size, fetchImpl, timeoutMs: effectiveTimeoutMs, pollIntervalMs, pollTimeoutMs: effectivePollTimeoutMs, onNote });
        return { ok: true, kind, model: candidate, ...result };
      } catch (error) {
        const message = String(error?.message || error);
        errors.push({ model: candidate, error: excerpt(message, 300) });
        const transient = /HTTP (408|425|429|500|502|503|504)/.test(message);
        if (transient && attempt === 1) {
          if (onNote) onNote(`${candidate}: ${excerpt(message, 120)} — retrying once`);
          await new Promise(resolve => setTimeout(resolve, 1200));
          continue;
        }
        break;
      }
    }
    if (onNote && candidates.indexOf(candidate) < candidates.length - 1) onNote(`${candidate} failed — falling back to the next ${kind} model`);
  }
  return { ok: false, kind, errors };
}

function normalizeCustomModel(entry, defaultKind = null) {
  if (entry && typeof entry === 'object' && entry.id) {
    return { id: String(entry.id).trim(), kind: MODEL_KINDS.includes(entry.kind) ? entry.kind : inferModelKind(entry.id) };
  }
  const id = String(entry || '').trim();
  if (!id) return null;
  return { id, kind: MODEL_KINDS.includes(defaultKind) ? defaultKind : inferModelKind(id) };
}

module.exports = { effectiveBudgets,
  MODEL_KINDS,
  KIND_PATHS,
  ASYNC_KINDS,
  inferModelKind,
  parseJsonLenient,
  deepFindImage,
  runModelTask,
  normalizeCustomModel,
};
