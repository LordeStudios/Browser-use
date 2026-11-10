'use strict';

// The single provider catalog. Every provider the app can talk to is described
// here once: its display label, its wire protocol, and how it executes.
// Replaces the scattered PROVIDER_LABELS map, the dead {ollama, cloud}-only
// providerContract.cjs, and the Responses-API model-regex routing that lived
// inside the OpenAI-compatible factory.
//
// Protocol is a TRANSPORT fact (how bytes are framed), not a quality judgment:
//   openai-compat — POST /chat/completions, OpenAI tool-call deltas, SSE
//   anthropic     — POST /v1/messages, content blocks, SSE
//   responses     — OpenAI Responses API (input items + function_call output)
//   ollama        — POST /api/chat NDJSON with JSON-mode decisions
//   cloud         — Browser-use Cloud relay (remote browser execution)

const EXECUTION_TARGETS = Object.freeze({ local: 'local-browser', remote: 'remote-browser' });

const PROVIDER_DESCRIPTORS = Object.freeze({
  ollama: Object.freeze({
    id: 'ollama', label: 'Local Ollama', protocol: 'ollama',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'http://127.0.0.1:11434', auth: 'none'
  }),
  openai: Object.freeze({
    id: 'openai', label: 'OpenAI', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.openai.com/v1', auth: 'bearer'
  }),
  anthropic: Object.freeze({
    id: 'anthropic', label: 'Anthropic', protocol: 'anthropic',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.anthropic.com', auth: 'x-api-key'
  }),
  gemini: Object.freeze({
    id: 'gemini', label: 'Google Gemini', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', auth: 'bearer'
  }),
  deepseek: Object.freeze({
    id: 'deepseek', label: 'DeepSeek', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.deepseek.com/v1', auth: 'bearer'
  }),
  grok: Object.freeze({
    id: 'grok', label: 'xAI', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.x.ai/v1', auth: 'bearer'
  }),
  perplexity: Object.freeze({
    id: 'perplexity', label: 'Perplexity', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.perplexity.ai', auth: 'bearer'
  }),
  openrouter: Object.freeze({
    id: 'openrouter', label: 'OpenRouter', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://openrouter.ai/api/v1', auth: 'bearer'
  }),
  xkiro: Object.freeze({
    id: 'xkiro', label: 'xKiro', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: '', auth: 'bearer'
  }),
  groq: Object.freeze({
    id: 'groq', label: 'Groq', protocol: 'openai-compat',
    executionTarget: EXECUTION_TARGETS.local, supportsLocalActions: true, supportsCancellation: true,
    defaultBaseUrl: 'https://api.groq.com/openai/v1', auth: 'bearer'
  }),
  cloud: Object.freeze({
    id: 'cloud', label: 'Browser Use Cloud', protocol: 'cloud',
    executionTarget: EXECUTION_TARGETS.remote, supportsLocalActions: false, supportsCancellation: true,
    defaultBaseUrl: '', auth: 'bearer'
  })
});

const PROVIDER_LABELS = Object.freeze(Object.fromEntries(
  Object.values(PROVIDER_DESCRIPTORS).map((descriptor) => [descriptor.id, descriptor.label])
));

const OPENAI_COMPAT_IDS = Object.freeze(Object.values(PROVIDER_DESCRIPTORS)
  .filter((descriptor) => descriptor.protocol === 'openai-compat')
  .map((descriptor) => descriptor.id));

function getProviderDescriptor(id) {
  return PROVIDER_DESCRIPTORS[String(id || '').trim()] || null;
}

// Claude-family models served through an OpenAI-compatible gateway (xkiro)
// still speak the Anthropic wire protocol; the model name decides, exactly as
// the old openAiCompatibleProvider.isAnthropic branch did.
function isClaudeModel(model) {
  return /(?:^|\/)claude(?:[-/]|$)/i.test(String(model || '')) || /(?:^|\/)anthropic\//i.test(String(model || ''));
}

// Astra tool calling is Responses-only in the official API (protocol
// compatibility routing, not task/model-quality routing).
function requiresResponsesProtocol(model) {
  return /^(?:openai\/)?gpt-6-astra(?:$|[-:])/i.test(String(model || ''));
}

// One resolution seam: given a connection (provider id + model), which wire
// protocol does the turn speak? "cloud" stays its own protocol.
function resolveProtocol(providerId, model = '') {
  const descriptor = getProviderDescriptor(providerId);
  if (!descriptor) return 'ollama';
  if (descriptor.protocol === 'ollama' || descriptor.protocol === 'cloud') return descriptor.protocol;
  if (descriptor.protocol === 'anthropic') return 'anthropic';
  if (requiresResponsesProtocol(model)) return 'responses';
  if (descriptor.id === 'anthropic' || (descriptor.id === 'xkiro' && isClaudeModel(model))) return 'anthropic';
  return 'openai-compat';
}

// Public status surface for the settings payload (moved verbatim from the
// retired providerContract.cjs). Only the two execution-target providers are
// listed here — the renderer's provider selection remains local-vs-cloud;
// API-key connections live in their own store and flow through
// createAgentProvider instead.
function publicProviderStatus({ settings = {}, cloudCredential = {} } = {}) {
  const local = PROVIDER_DESCRIPTORS.ollama;
  const remote = PROVIDER_DESCRIPTORS.cloud;
  return {
    selected: settings.aiChatProvider === 'cloud' ? 'cloud' : 'ollama',
    providers: [local, remote].map((provider) => ({
      id: provider.id,
      label: provider.label,
      executionTarget: provider.executionTarget,
      supportsLocalActions: provider.supportsLocalActions,
      supportsCancellation: provider.supportsCancellation,
      configured: provider.id === 'cloud' ? cloudCredential.configured === true : Boolean(settings.aiChatModel && settings.aiChatBaseUrl),
      credential: provider.id === 'cloud' ? cloudCredential.display || '' : ''
    }))
  };
}

module.exports = {
  PROVIDER_DESCRIPTORS,
  PROVIDER_LABELS,
  OPENAI_COMPAT_IDS,
  EXECUTION_TARGETS,
  getProviderDescriptor,
  isClaudeModel,
  requiresResponsesProtocol,
  resolveProtocol,
  publicProviderStatus
};
