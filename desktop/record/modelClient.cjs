'use strict';

// One-shot model calls for Record & Learn, routed through the SAME provider
// seam every chat run uses (agent/providers/descriptors.cjs → wire.cjs).
//
// The model is never chosen here: the caller passes the application's active
// provider config (the same config createAgentProvider would receive) and this
// module speaks its protocol — openai-compat, anthropic, ollama, or responses.
// Cost efficiency comes from compact inputs and JSON-mode outputs, never from
// downgrading the user's selected model.

const {
  normalizeBaseUrl,
  providerEndpoint,
  ANTHROPIC_VERSION
} = require('../agent/providers/wire.cjs');
const { resolveProtocol, PROVIDER_LABELS } = require('../agent/providers/descriptors.cjs');

const TIMEOUT_MS_DEFAULT = 120_000;

function protocolOf(config) {
  return resolveProtocol(config?.id, config?.model || '');
}

function endpointFor(config, protocol) {
  if (protocol === 'ollama') return `${normalizeBaseUrl(config.baseUrl, 'http://127.0.0.1:11434')}/api/chat`;
  if (protocol === 'responses') return `${normalizeBaseUrl(config.baseUrl)}/responses`;
  if (protocol === 'anthropic') return providerEndpoint(normalizeBaseUrl(config.baseUrl), '/v1/messages');
  return providerEndpoint(normalizeBaseUrl(config.baseUrl), '/chat/completions');
}

function headersFor(config, protocol) {
  const apiKey = String(config.apiKey || '');
  if (protocol === 'anthropic') {
    return { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  if (protocol === 'ollama') return { 'content-type': 'application/json' };
  return { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
}

function bodyFor(config, protocol, { system, user, maxTokens, temperature = 0 }) {
  const budget = Math.max(256, Number(maxTokens) || 2_048);
  if (protocol === 'ollama') {
    return { model: config.model, stream: false, options: { temperature, num_predict: budget },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  }
  if (protocol === 'anthropic') {
    return { model: config.model, max_tokens: budget, temperature, stream: false,
      system, messages: [{ role: 'user', content: user }] };
  }
  if (protocol === 'responses') {
    return { model: config.model, store: false, stream: false, max_output_tokens: Math.max(budget, 1_024), temperature,
      instructions: system, input: user };
  }
  return { model: config.model, max_tokens: budget, temperature, stream: false,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
}

function extractText(protocol, payload) {
  if (protocol === 'ollama') return String(payload?.message?.content || '');
  if (protocol === 'anthropic') {
    return (Array.isArray(payload?.content) ? payload.content : [])
      .filter(part => part?.type === 'text').map(part => part.text || '').join('\n');
  }
  if (protocol === 'responses') {
    return (Array.isArray(payload?.output) ? payload.output : [])
      .filter(item => item?.type === 'message')
      .flatMap(item => item.content || [])
      .filter(part => part?.type === 'output_text')
      .map(part => part.text || '').join('\n');
  }
  return String(payload?.choices?.[0]?.message?.content || '');
}

function extractError(protocol, status, payload) {
  const detail = String(payload?.error?.message || payload?.message || payload?.error || '').replace(/\s+/g, ' ').slice(0, 300);
  const label = 'The model call';
  return new Error(`${label} failed (HTTP ${status}${detail ? `: ${detail}` : ''}).`);
}

// Returns the model's text. Throws on transport/HTTP errors — callers decide
// whether that is fatal (stop-time reconstruction reports it) or skippable
// (selective mid-recording refreshes just skip).
async function complete(config, { system, user, maxTokens, temperature, timeoutMs = TIMEOUT_MS_DEFAULT, signal } = {}) {
  const protocol = protocolOf(config);
  if (!protocol || !config?.model) throw new Error('No active model is configured; Record & Learn cannot reason right now.');
  const endpoint = endpointFor(config, protocol);
  const body = JSON.stringify(bodyFor(config, protocol, { system, user, maxTokens, temperature }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('The model call timed out.')), Math.max(1_000, timeoutMs));
  const onAbort = () => controller.abort(signal?.reason || new Error('The model call was cancelled.'));
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await globalThis.fetch(endpoint, {
      method: 'POST', headers: headersFor(config, protocol), body, signal: controller.signal
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* non-JSON body → error below */ }
    if (!response.ok) throw extractError(protocol, response.status, payload);
    const text = extractText(protocol, payload);
    if (!String(text || '').trim()) throw new Error('The model returned no content.');
    return text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

// Extracts the first JSON object from a reply that may carry prose or code
// fences around it.
function parseJsonObject(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(value); } catch { /* fall through to brace scan */ }
  const start = value.indexOf('{');
  if (start < 0) throw new Error('The model reply contained no JSON object.');
  let depth = 0, quoted = false, escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return JSON.parse(value.slice(start, index + 1));
    }
  }
  throw new Error('The model reply contained an incomplete JSON object.');
}

function providerLabel(config) {
  return PROVIDER_LABELS[config?.id] || config?.id || 'the active model';
}

module.exports = { complete, parseJsonObject, protocolOf, providerLabel };
