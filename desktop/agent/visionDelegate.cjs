'use strict';
// VISION DELEGATE — provider-generic. When the ACTIVE model cannot see
// images (it rejected them twice, or it is text-only), the harness does not
// fail the viewing step and does not switch the run's model: it asks a
// VISION-capable model on the SAME connection to describe the image, and
// that description rides into the decision as TEXT evidence. The text-only
// model keeps running the task; only the SEEING was delegated. Frames from
// a recording flow through the same path — they are images too.

const DEFAULT_VISION_PROMPT = 'Describe this screenshot for a text-only agent that must act on it: what is shown, every readable text, element positions worth knowing, and anything visually wrong. Be concrete and complete; this description replaces the image.';

function pickVisionModel(models, excludeModel) {
  const list = (Array.isArray(models) ? models : [])
    .filter((entry) => entry && typeof entry === 'object' && entry.id && entry.capabilities?.vision === true)
    .filter((entry) => String(entry.id).trim() !== String(excludeModel || '').trim());
  list.sort((a, b) => (Number(a.pricing?.input) || 0) - (Number(b.pricing?.input) || 0));
  return list[0]?.id || null;
}

async function describeImage({ baseUrl, apiKey, model, image, prompt, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const id = String(model || '').trim();
  if (!base || !id) return { ok: false, reason: 'missing endpoint or vision model' };
  const rawData = String(image?.data || '').trim();
  const rawDataUrl = String(image?.dataUrl || '').trim();
  const dataUrl = /^data:[^;,]+;base64,[a-z0-9+/=\s]+$/i.test(rawDataUrl)
    ? rawDataUrl
    : (/^[a-z0-9+/]+={0,2}$/i.test(rawData) ? `data:${image?.mimeType || 'image/png'};base64,${rawData}` : null);
  // file://, content://, blob:, and arbitrary paths are client-local; the
  // provider cannot read them and would return an unrecoverable 400.
  if (!dataUrl) return { ok: false, reason: 'no inline image to describe (client-local URLs are not supported)' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: [{ type: 'text', text: String(prompt || DEFAULT_VISION_PROMPT) }, { type: 'image_url', image_url: { url: dataUrl } }] }],
        max_tokens: 2000,
        stream: false
      }),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, reason: `vision model returned HTTP ${response.status}` };
    const payload = await response.json();
    const text = String(payload?.choices?.[0]?.message?.content || '').trim();
    if (!text) return { ok: false, reason: 'vision model returned no text' };
    return { ok: true, model: id, text };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error).slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

// The delegate resolves its vision model ONCE per cache window (live /models,
// cheapest vision first, the active text-only model excluded) and describes
// on demand. Every failure is honest and non-fatal — the run continues
// text-only exactly as before when no vision model exists.
function createVisionDescriber({ baseUrl, apiKey, excludeModel = '', fetchImpl = globalThis.fetch, cacheMs = 600_000, now = Date.now } = {}) {
  let cachedModel = null;
  let cachedAt = 0;
  let resolution = null; // null = not resolved; 'none' = no vision model exists
  return async function describe({ image, prompt } = {}) {
    if (resolution === 'none') return { ok: false, reason: 'no vision-capable model on this connection' };
    if (!cachedModel || (now() - cachedAt) > cacheMs) {
      try {
        const response = await fetchImpl(`${String(baseUrl || '').replace(/\/$/, '')}/models`, { headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) } });
        if (!response.ok) return { ok: false, reason: `model discovery failed (HTTP ${response.status})` };
        const payload = await response.json();
        const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
        cachedModel = pickVisionModel(models, excludeModel);
        cachedAt = now();
        if (!cachedModel) { resolution = 'none'; return { ok: false, reason: 'no vision-capable model on this connection' }; }
      } catch (error) {
        return { ok: false, reason: `model discovery failed (${String(error?.message || error).slice(0, 120)})` };
      }
    }
    return describeImage({ baseUrl, apiKey, model: cachedModel, image, prompt, fetchImpl });
  };
}

// CAPABILITY METADATA read: the ACTIVE model's own entry from the same
// /models roster pickVisionModel trusts. Only an EXPLICIT flag settles the
// question — gateway flags are a subset of what a model can do, so an absent
// flag is unknown, never a "no" (degrading a capable model would be a real
// regression). true = image input supported; false = the gateway explicitly
// declares the model text-only; null = unknown, the caller keeps its current
// behavior (rejections latch in-flight).
async function activeModelVisionSupport({ baseUrl, apiKey, model, fetchImpl = globalThis.fetch, timeoutMs = 2500 } = {}) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const id = String(model || '').trim();
  if (!base || !id) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/models`, { headers: { accept: 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, signal: controller.signal });
    if (!response?.ok) return null;
    const payload = await response.json().catch(() => null);
    const models = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : (Array.isArray(payload) ? payload : []);
    const entry = models.find((item) => String(item?.id || '') === id)
      || models.find((item) => String(item?.id || '').endsWith(`/${id}`))
      || models.find((item) => id.endsWith(`/${String(item?.id || '')}`));
    if (!entry || !entry.capabilities || typeof entry.capabilities !== 'object') return null;
    if (entry.capabilities.vision === true) return true;
    if (entry.capabilities.vision === false) return false;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { pickVisionModel, describeImage, createVisionDescriber, activeModelVisionSupport, DEFAULT_VISION_PROMPT };
