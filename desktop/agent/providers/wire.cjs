'use strict';

// The one provider wire seam. Every protocol framing helper lives here once —
// SSE/NDJSON stream readers, tool-call delta merging, reasoning extraction,
// visual-evidence shaping, endpoint/header construction — and the provider
// classes (openai-compatible, ollama, responses) consume them instead of each
// carrying a private copy. Behavior is unchanged from the backed-up pre-v2
// providers; this is deduplication, not redesign.

const { createThinkingStreamSplitter } = require('../thinkingStream.cjs');
const { isClaudeModel } = require('./descriptors.cjs');
const { measureProviderRequest } = require('../desktopAgentCoordinator.cjs');

const ANTHROPIC_VERSION = '2023-06-01';

// A reasoning model spends most of its budget on the visible analysis stream
// before it ever reaches the action JSON. A small ceiling truncates the
// response mid-thinking, which the parser reads as "commentary without an
// action" and drives the narration-recovery loop.
const DECISION_MAX_TOKENS = 4_096;
const REPAIR_MAX_TOKENS = 1_024;
const LONG_REPORT_MAX_TOKENS = 6_144;


function normalizeBaseUrl(value, fallback = null) {
  const source = String(value || fallback || '').trim();
  const url = new URL(source);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Provider base URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}

function providerEndpoint(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const suffix = String(path || '').startsWith('/') ? String(path) : `/${path || ''}`;
  if (base.endsWith('/v1') && suffix.startsWith('/v1/')) return `${base}${suffix.slice(3)}`;
  return `${base}${suffix}`;
}

function providerError(providerLabel, response, body) {
  const detail = String(body?.error?.message || body?.message || response.statusText || '').replace(/\s+/g, ' ').slice(0, 260);
  return new Error(`${providerLabel} request failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

function retryableProviderStatus(status) {
  return [408, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function providerText(value, seen = new Set()) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => providerText(part, seen)).join('');
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  for (const key of ['text', 'content', 'thinking', 'thinking_content', 'reasoning_content', 'reasoning', 'analysis', 'thought', 'thoughts', 'summary', 'value']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const text = providerText(value[key], seen);
    if (text) return text;
  }
  return '';
}

function currentVisualEvidence(observation) {
  const screenshot = observation?.screenshot;
  let data = String(screenshot?.data || '').trim();
  if (!data) return null;
  let mimeType = String(screenshot?.mimeType || 'image/png').toLowerCase();
  const dataUrl = data.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
  if (dataUrl) {
    mimeType = dataUrl[1].toLowerCase();
    data = dataUrl[2].replace(/\s+/g, '');
  }
  // Reject non-base64 image data: file://, blob:, content:// URLs are not base64 and
  // would cause provider 400 errors that retried forever (the empty-thought rain).
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(data)) return null;
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) return null;
  if (!data || data.length > 20_000_000) return null;
  return { mimeType, data };
}

function openAiUserContent(context, visuals = []) {
  const text = JSON.stringify(context);
  if (!visuals.length) return text;
  return [
    { type: 'text', text },
    ...visuals.map((visual) => ({ type: 'image_url', image_url: { url: `data:${visual.mimeType};base64,${visual.data}` } }))
  ];
}

function anthropicUserContent(context, visuals = []) {
  const text = JSON.stringify(context);
  if (!visuals.length) return text;
  return [
    { type: 'text', text },
    ...visuals.map((visual) => ({ type: 'image', source: { type: 'base64', media_type: visual.mimeType, data: visual.data } }))
  ];
}

function collapseExactRepeatedText(value) {
  const text = String(value || '');
  if (text.length >= 2 && text.length % 2 === 0) {
    const half = text.length / 2;
    if (text.slice(0, half) === text.slice(half)) return text.slice(0, half);
  }
  return text;
}

function declaredReasoning(message) {
  if (!message || typeof message !== 'object') return '';
  return providerText([
    message.reasoning_content,
    message.reasoning_details,
    message.reasoning,
    message.thinking_content,
    message.thinking,
    message.thought,
    message.thoughts,
    message.analysis
  ]);
}

// Some Ollama-backed models expose reasoning through message.thinking, while
// others place it directly in message.content. Keep the latter out of the
// structured-response parser and out of the visible final reply.
function extractInlineReasoning(content) {
  let publicContent = String(content || '');
  const reasoning = [];
  publicContent = publicContent.replace(/<(?:think|thinking)\b[^>]*>([\s\S]*?)<\/(?:think|thinking)>/gi, (_match, body) => {
    const text = String(body || '').trim();
    if (text) reasoning.push(text);
    return '';
  });
  // A few providers end a response before closing the reasoning tag. It is
  // still private reasoning, never a candidate user-facing final response.
  const dangling = publicContent.match(/<(?:think|thinking)\b[^>]*>([\s\S]*)$/i);
  if (dangling) {
    const text = String(dangling[1] || '').trim();
    if (text) reasoning.push(text);
    publicContent = publicContent.slice(0, dangling.index);
  }
  return { content: publicContent.replace(/<\/(?:think|thinking)>/gi, '').trim(), reasoning: reasoning.join('\n\n') };
}

// The provider ended the response because reasoning + plan + actions exhausted
// max_tokens, so the decision arrived without an executable action. This is a
// budget condition, not narration: the plan was real but discarded, and the
// model must not be scolded into re-deriving it into the same cap.
function decisionBudgetCutOff(payload, isAnthropic) {
  if (isAnthropic) return payload?.stop_reason === 'max_tokens' || payload?.delta?.stop_reason === 'max_tokens';
  return ['length', 'max_tokens'].includes(payload?.choices?.[0]?.finish_reason);
}

function decisionOutputBudgetError(previousBudget, raisedBudget) {
  const error = new Error(`The model's decision was cut off by the ${previousBudget}-token output limit while it was still reasoning or planning, before it emitted an executable action. Nothing was executed; the output budget was raised to ${raisedBudget}. Do not resume or extend the reasoning: stop thinking now and emit the single action you had already settled on (or the done JSON) immediately — acting beats more reasoning.`);
  error.code = 'DECISION_OUTPUT_BUDGET';
  return error;
}

function declaresVisualUnsupported(payload, isAnthropic) {
  // Only final user-facing content can establish a capability claim. Models
  // often mention vision limitations in hidden reasoning while still correctly
  // interpreting the attached frame; treating that text as proof caused false
  // permanent degradation.
  const text = isAnthropic
    ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'text').map((part) => String(part?.text || '')).join(' ') : '')
    : providerText(payload?.choices?.[0]?.message?.content);
  if (/\b(?:i\s+can\s+see|shows?|depicts?|visible|displayed|screenshot\s+(?:shows?|contains?))\b/i.test(text)
      && /\b(?:image|screenshot|screen|window|button|dialog)\b/i.test(text)) return false;
  return /\b(?:(?:cannot|can't|unable to)\s+(?:process|view|see|inspect)\s+(?:the\s+)?(?:image|images|screenshot|screenshots)|(?:image|vision)\s+(?:input\s+)?(?:is\s+)?(?:not supported|unavailable))\b/i.test(text);
}

function mergeStreamText(current, next) {
  // SSE deltas are additive, even when consecutive fragments are identical.
  // Text-based deduplication corrupts code, numbers, quotes and reasoning.
  return current + String(next ?? '');
}

function mergeToolCallDelta(toolCalls, delta) {
  const index = Math.max(0, Number(delta?.index) || 0);
  const current = toolCalls[index] || { index, id: '', type: 'function', function: { name: '', arguments: '' } };
  current.id = delta?.id || current.id;
  current.type = delta?.type || current.type;
  if (delta?.function) {
    current.function.name = mergeStreamText(current.function.name, delta.function.name);
    current.function.arguments = mergeStreamText(current.function.arguments, delta.function.arguments);
  }
  toolCalls[index] = current;
}

function createStreamCollector(onThought, onStream) {
  const splitter = createThinkingStreamSplitter();
  let full = '';
  let nativeThinking = false;
  let lastThought = '';

  const publish = () => {
    const state = splitter.push(full);
    onStream?.(state);
    if (state.thinkingText !== lastThought) {
      lastThought = state.thinkingText;
      onThought?.(state.thinkingText);
    }
    return state;
  };

  return Object.freeze({
    reasoning(text) {
      const value = String(text || '');
      if (!value) return publish();
      if (!nativeThinking) {
        full += '<think>';
        nativeThinking = true;
      }
      full += value;
      return publish();
    },
    reply(text) {
      const value = String(text || '');
      if (nativeThinking) {
        full += '</think>';
        nativeThinking = false;
      }
      full += value;
      return publish();
    },
    finish() {
      if (nativeThinking) full += '</think>';
      publish();
      const state = splitter.finish();
      onStream?.(state);
      return state;
    }
  });
}

async function consumeJsonEventStream(response, acceptPayload) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';
  let accepted = 0;

  // No-token watchdog: a provider that delivers partial output ("thinking")
  // then goes silent leaves reader.read() pending forever — the visible
  // symptom was a run that froze until the human switched tabs. Idle timeout
  // is classified so the request loop can replay the transport once.
  const IDLE_MS = Math.max(15_000, Number(process.env.PROVIDER_STREAM_IDLE_MS) || 90_000);
  const acceptLine = (line) => {
    const value = String(line || '').trim();
    if (!value || value.startsWith(':') || /^(?:event|id|retry):/i.test(value)) return;
    const data = value.startsWith('data:') ? value.slice(5).trim() : value;
    if (!data || data === '[DONE]') return;
    let payload;
    try { payload = JSON.parse(data); } catch { return; }
    accepted += 1;
    acceptPayload(payload);
  };
  const readChunk = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Provider stream went silent for ${Math.round(IDLE_MS / 1000)}s mid-response.`);
      error.code = 'PROVIDER_STREAM_IDLE';
      try { reader.cancel(() => {}); } catch { /* the rejection is the cleanup */ }
      reject(error);
    }, IDLE_MS);
    if (typeof timer.unref === 'function') timer.unref();
    reader.read().then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });

  for (;;) {
    const { value, done } = await readChunk();
    const decoded = decoder.decode(value || new Uint8Array(), { stream: !done });
    raw = `${raw}${decoded}`.slice(-4_000_000);
    buffer += decoded;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) acceptLine(line);
    if (done) break;
  }
  if (buffer.trim()) acceptLine(buffer);
  if (accepted === 0 && raw.trim()) {
    try { acceptPayload(JSON.parse(raw.trim())); } catch {}
  }
}

function mergedFragment(current, next) {
  const merged = mergeStreamText(current, next);
  return { merged, fragment: merged.startsWith(current) ? merged.slice(current.length) : String(next || '') };
}

// Streamed provider errors arrive as in-band error events with HTTP-style
// types but a 200 status. They must surface with their true status class so
// the transport classifier can retry them — swallowing them made the agent
// blame the model for a server fault and loop on recovery instead.
const STREAM_ERROR_STATUS = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
};

function streamError(error, providerLabel) {
  const status = STREAM_ERROR_STATUS[String(error?.type || '')] || 500;
  const message = String(error?.message || 'The provider stream failed.').slice(0, 300);
  const failure = new Error(`${providerLabel} stream error (${status} ${error?.type || 'api_error'}): ${message}`);
  failure.code = 'PROVIDER_STREAM_ERROR';
  failure.status = status;
  return failure;
}

async function readOpenAiEventStream(response, onThought, onStream, onToolCall = null) {
  const stream = createStreamCollector(onThought, onStream);
  const toolCalls = [];
  let content = '';
  let reasoning = '';
  let terminal = null;

  // Fast path (LORDE_FAST_PATH): while the model is still generating (usually
  // narrating), its FIRST tool call's arguments are already complete. Once the
  // arguments parse as valid JSON AND the stream has been quiet for a short
  // debounce (so a prefix like {"element":1 of {"element":1,"x":100} never
  // fires), the call is handed to the agent for immediate non-destructive
  // execution. Purely advisory: the full decision still resolves normally and
  // the agent decides whether to act on the early call.
  const FAST_DEBOUNCE_MS = Math.max(0, Number(process.env.BROWSER_USE_FAST_PATH_DEBOUNCE_MS) || 200);
  let fastTimer = null;
  let fastEmitted = false;
  const maybeEmitFast = () => {
    if (!onToolCall || fastEmitted || fastTimer) return;
    const first = toolCalls.find(Boolean);
    const args = String(first?.function?.arguments || '').trim();
    if (!first?.function?.name || !args) return;
    try { JSON.parse(args); } catch { return; }
    fastTimer = setTimeout(() => {
      fastTimer = null;
      if (fastEmitted) return;
      const call = toolCalls.find(Boolean);
      const finalArgs = String(call?.function?.arguments || '').trim();
      if (!call?.function?.name || !finalArgs) return;
      let input;
      try { input = JSON.parse(finalArgs); } catch { return; }
      fastEmitted = true;
      try { onToolCall({ name: call.function.name, input: (input && typeof input === 'object') ? input : {} }); } catch { /* the fast path must never break the stream */ }
    }, FAST_DEBOUNCE_MS);
    if (typeof fastTimer.unref === 'function') fastTimer.unref();
  };

  const acceptPayload = (payload) => {
    if (payload?.error) throw streamError(payload.error, 'OpenAI');
    terminal = payload;
    const choice = payload?.choices?.[0] || {};
    const delta = choice.delta || choice.message || payload?.message || payload?.delta || {};
    const nextReasoning = declaredReasoning(delta) || declaredReasoning(choice) || declaredReasoning(payload);
    if (nextReasoning) {
      const next = mergedFragment(reasoning, nextReasoning);
      reasoning = next.merged;
      if (next.fragment) stream.reasoning(next.fragment);
    }
    const nextContent = providerText(delta.content ?? choice.text ?? payload.response);
    if (nextContent) {
      const next = mergedFragment(content, nextContent);
      content = next.merged;
      if (next.fragment) stream.reply(next.fragment);
    }
    if (delta.tool_calls?.length) {
      for (const toolCall of delta.tool_calls) mergeToolCallDelta(toolCalls, toolCall);
      maybeEmitFast();
    }
  };
  try {
    await consumeJsonEventStream(response, acceptPayload);
  } finally {
    if (fastTimer) { clearTimeout(fastTimer); fastTimer = null; }
  }

  const state = stream.finish();
  const terminalChoice = terminal?.choices?.[0] || {};
  return {
    ...(terminal || {}),
    choices: [{
      ...terminalChoice,
      message: {
        ...(terminalChoice.message || {}),
        content: state.replyText.trim(),
        ...(state.thinkingText ? { reasoning_content: state.thinkingText } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls.filter(Boolean).map(({ index, ...call }) => call) } : {})
      }
    }]
  };
}

async function readAnthropicEventStream(response, onThought, onStream) {
  const stream = createStreamCollector(onThought, onStream);
  const blocks = new Map(), argumentsByIndex = new Map();
  let message = {}, stopReason = null, usage = {};
  await consumeJsonEventStream(response, payload => {
    if (payload.type === 'error') throw streamError(payload.error, 'Anthropic');
    if (payload.type === 'message_start') { message = payload.message || {}; usage = { ...message.usage }; }
    if (payload.usage) usage = { ...usage, ...payload.usage };
    if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
    if (payload.type === 'content_block_start') {
      const block = { ...payload.content_block };
      blocks.set(payload.index, block);
      if (block.type === 'thinking') stream.reasoning(block.thinking || '');
      if (block.type === 'text') stream.reply(block.text || '');
    }
    const block = blocks.get(payload.index), delta = payload.delta || {};
    if (!block) return;
    if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + (delta.thinking || ''); stream.reasoning(delta.thinking || ''); }
    if (delta.type === 'signature_delta') block.signature = (block.signature || '') + (delta.signature || '');
    if (delta.type === 'text_delta') { block.text = (block.text || '') + (delta.text || ''); stream.reply(delta.text || ''); }
    if (delta.type === 'input_json_delta') argumentsByIndex.set(payload.index, (argumentsByIndex.get(payload.index) || '') + (delta.partial_json || ''));
  });
  stream.finish();
  const content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([index, block]) => {
    if (block.type !== 'tool_use' || !argumentsByIndex.has(index)) return block;
    try { return { ...block, input: JSON.parse(argumentsByIndex.get(index)) }; }
    catch { return null; } // Incomplete tool arguments never become an empty call.
  }).filter(Boolean);
  return { ...message, stop_reason: stopReason || message.stop_reason, usage, content };
}

// Ollama speaks NDJSON, not SSE. Mocks and older fetch implementations may not
// expose a stream; the JSON path stays compatible while live sessions stream.
async function requestStreamingChat(fetchImpl, url, options, label, onThought, onStream, telemetry = null) {
  if (telemetry) return measureProviderRequest(telemetry.coordinator, { ...telemetry, body: options.body, signal: options.signal }, received => requestStreamingChat(receivingFetch(fetchImpl, received), url, options, label, onThought, onStream));
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new Error(`${label} could not reach ${new URL(url).origin}: ${error.message}`);
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).trim().slice(0, 500);
    throw new Error(`${label} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  if (!response.body?.getReader) return response.json();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const splitter = createThinkingStreamSplitter();
  let buffer = '';
  let full = '';
  let nativeThinking = false;
  let lastThought = '';
  let terminal = null;
  const publish = () => {
    const state = splitter.push(full);
    onStream?.(state);
    if (state.thinkingText !== lastThought) {
      lastThought = state.thinkingText;
      onThought?.(state.thinkingText);
    }
  };
  const acceptMessage = (message) => {
    const nextThought = String(message?.thinking || '');
    const nextContent = String(message?.content || '');
    if (nextThought) {
      if (!nativeThinking) {
        full += '<think>';
        nativeThinking = true;
      }
      full += nextThought;
      publish();
    }
    if (nextContent) {
      if (nativeThinking) {
        full += '</think>';
        nativeThinking = false;
      }
      full += nextContent;
      publish();
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n');
    buffer = done ? '' : lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let chunk;
      try { chunk = JSON.parse(line); } catch { continue; }
      const message = chunk.message || {};
      acceptMessage(message);
      if (chunk.done) terminal = chunk;
    }
    if (done) break;
  }
  if (buffer.trim()) {
    try {
      terminal = JSON.parse(buffer);
      acceptMessage(terminal?.message || {});
    } catch {}
  }
  if (nativeThinking) full += '</think>';
  publish();
  const finalState = splitter.finish();
  onStream?.(finalState);
  // Streaming providers send content in deltas and commonly put an empty
  // message on the terminal chunk. Returning that terminal chunk directly
  // discarded the accumulated final JSON, leaving only reasoning visible.
  if (terminal) return {
    ...terminal,
    message: {
      ...(terminal.message || {}),
      content: finalState.replyText.trim(),
      ...(finalState.thinkingText ? { thinking: finalState.thinkingText } : {})
    }
  };
  return { message: { content: finalState.replyText.trim(), ...(finalState.thinkingText ? { thinking: finalState.thinkingText } : {}) } };
}

async function requestJson(fetchImpl, url, options, label, telemetry = null) {
  if (telemetry) return measureProviderRequest(telemetry.coordinator, { ...telemetry, body: options.body, signal: options.signal }, received => requestJson(receivingFetch(fetchImpl, received), url, options, label));
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (error) {
    throw new Error(`${label} could not reach ${new URL(url).origin}: ${error.message}`);
  }
  if (!response.ok) {
    const detail = String(await response.text().catch(() => '')).trim().slice(0, 500);
    throw new Error(`${label} failed: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  return response.json();
}

// Telemetry glue shared by requestJson/requestStreamingChat: previously each
// provider file re-implemented the same measureProviderRequest wrapper.
function receivingFetch(fetchImpl, received) {
  return async (...args) => {
    const response = await fetchImpl(...args);
    received(response);
    return response;
  };
}

// OpenAI Responses API stream reader (moved verbatim from responsesProvider).
async function readResponsesEventStream(response, onThought, onProgress) {
  if (!response.body?.getReader || !String(response.headers?.get?.('content-type') || '').includes('text/event-stream')) return response.json();
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', final = null, summary = '';
  const accept = line => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
    let event; try { event = JSON.parse(data); } catch { return; }
    // Any parsed event proves the stream is alive and resets the step
    // deadline; long reasoning phases are progress, not dead air.
    onProgress?.();
    if (['response.completed', 'response.incomplete', 'response.failed'].includes(event.type)) final = event.response;
    if (event.type === 'error') throw new Error(String(event.error?.message || event.message || 'Responses stream failed.'));
    // Reasoning summaries are opt-in on the Responses API: without this field
    // the stream carries no summary deltas and the thought channel stays empty.
    // Public commentary (`response.output_text.delta`) deliberately remains
    // message output, never replayed as invented reasoning.
    if (['response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(event.type) && event.delta) {
      summary += event.delta; onThought?.(summary);
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    // Bytes arriving (even between events) count as stream liveness.
    onProgress?.();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || '';
    for (const line of lines) accept(line);
    if (buffer.length > 8_000_000) throw new Error('Responses stream item exceeded the supported size.');
    if (done) break;
  }
  if (buffer) accept(buffer);
  if (!final) throw new Error('Responses stream ended without a terminal response; no partial tool call was executed.');
  return final;
}

function emitCompletedReasoning(payload, isAnthropic, onThought) {
  if (typeof onThought !== 'function') return;
  const message = isAnthropic ? null : payload?.choices?.[0]?.message;
  const native = isAnthropic
    ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'thinking').map((part) => part.thinking || part.text).join('\n\n') : '')
    : declaredReasoning(message);
  const content = isAnthropic
    ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '')
    : providerText(message?.content);
  const inline = extractInlineReasoning(content).reasoning;
  const thought = [native, inline].filter(Boolean).join('\n\n').trim();
  if (thought) onThought(thought);
}

function nativeVisionError() {
  return Object.assign(new Error('The provider could not accept or inspect the native desktop image. Native visual work has stopped rather than continuing blindly. Check image support or choose a vision-capable model; the existing work is not verified.'), { code: 'NATIVE_VISION_UNAVAILABLE' });
}

// ── Tool schemas ────────────────────────────────────────────────────────────

const NUMERIC_TOOL_INPUTS = new Set(['x', 'y', 'ms', 'element', 'index', 'steps', 'durationMs', 'deltaX', 'deltaY', 'startX', 'startY', 'endX', 'endY', 'maxElements']);

function androidAdbToolInputSchema() {
  return { type: 'object', properties: {
    serial: { type: 'string', description: 'Target serial; omitted uses the selected device.' },
    args: { type: 'array', items: { type: 'string' }, description: 'ADB argv array. Example ["shell","input","tap","400","600"] or ["logcat","-d"]. The harness never invokes a shell.' },
    command: { type: 'string', description: 'Compatibility command string; prefer args[]. It is parsed into argv without a shell.' },
    commands: { type: 'array', maxItems: 32, description: 'Optional ordered batch. Each item has args[] or command, optional serial and timeoutMs.', items: { type: 'object', properties: { serial: { type: 'string' }, args: { type: 'array', items: { type: 'string' } }, command: { type: 'string' }, timeoutMs: { type: 'number' } } } },
    stopOnError: { type: 'boolean', description: 'Batch only: default true; stop after the first failed command.' },
    totalTimeoutMs: { type: 'number', description: 'Batch only: aggregate timeout, default 180000.' },
    timeoutMs: { type: 'number' }
  } };
}

function androidDevicesToolInputSchema() {
  return { type: 'object', properties: {
    action: { type: 'string', enum: ['list', 'refresh', 'pair', 'connect', 'disconnect', 'remove', 'select', 'programmatic-input', 'stream-start', 'stream-stop'] },
    serial: { type: 'string' }, address: { type: 'string' }, pairingCode: { type: 'string' }, label: { type: 'string' },
    enabled: { type: 'boolean' }, maxFps: { type: 'number', minimum: 5, maximum: 60 }, maxSize: { type: 'number' }, bitrate: { type: 'string' }
  } };
}

function planToolInputSchema() {
  const status = { type: 'string', enum: ['pending', 'current', 'done', 'skipped'] };
  const schema = {
    type: 'object',
    properties: {
      steps: {
        type: 'array',
        description: 'Replacement task list; size is yours.',
        items: {
          anyOf: [
            { type: 'string' },
            { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' }, status, verification: { type: 'string' } }, required: ['text'] }
          ]
        }
      },
      operations: {
        type: 'array',
        description: 'Granular task edits: add, update, remove, or clear as work changes.',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
            id: { type: 'string' },
            text: { type: 'string' },
            status,
            verification: { type: 'string' },
            index: { type: 'number' },
            beforeId: { type: 'string' },
            afterId: { type: 'string' }
          },
          required: ['op']
        }
      }
    }
  };
  schema.properties.steps.items.anyOf[1].properties.goalId = { type: 'string', description: 'Optional associated goal ID.' };
  schema.properties.operations.items.properties.goalId = { type: 'string' };
  schema.properties.goals = { ...schema.properties.steps, description: 'Model-authored goals; omitted = unchanged, empty clears.' };
  schema.properties.goalOperations = { ...schema.properties.operations, description: 'Add/update/remove/clear operations on model-authored goals.' };
  return schema;
}

function toolInputSchema(input = {}, toolName = '') {
  if (toolName === 'android_adb') return androidAdbToolInputSchema();
  if (toolName === 'android_devices') return androidDevicesToolInputSchema();
  // create_plan takes the SAME arguments as update_plan, so it gets the same
  // hand-written schema. It used to fall through to the generated one below,
  // where `steps` collided with the numeric-name list (meant for browser_drag's
  // step count) and became type "number", and `operations` became "string".
  // The model obeyed the schema and sent `steps: 5` — a plan of zero tasks.
  if (toolName === 'update_plan' || toolName === 'create_plan') return planToolInputSchema();
  const properties = {};
  for (const [key, description] of Object.entries(input)) {
    properties[key] = { type: NUMERIC_TOOL_INPUTS.has(key) ? 'number' : 'string', description: String(description) };
  }
  const schema = { type: 'object', properties };
  if (toolName === 'browser_wait') schema.required = ['ms'];
  return schema;
}

function openAiToolSchemas(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => tool?.name).map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || `Browser action ${tool.name}. Input fields: ${JSON.stringify(tool.input || {})}.`,
      parameters: tool.inputSchema || toolInputSchema(tool.input, tool.name)
    }
  }));
}

function anthropicToolSchemas(tools) {
  return (Array.isArray(tools) ? tools : []).filter((tool) => tool?.name).map((tool) => ({
    name: tool.name,
    description: tool.description || `Browser action ${tool.name}. Input fields: ${JSON.stringify(tool.input || {})}.`,
    input_schema: tool.inputSchema || toolInputSchema(tool.input, tool.name)
  }));
}

module.exports = {
  ANTHROPIC_VERSION,
  DECISION_MAX_TOKENS,
  REPAIR_MAX_TOKENS,
  LONG_REPORT_MAX_TOKENS,
  normalizeBaseUrl,
  providerEndpoint,
  providerError,
  retryableProviderStatus,
  providerText,
  currentVisualEvidence,
  openAiUserContent,
  anthropicUserContent,
  declaredReasoning,
  extractInlineReasoning,
  decisionBudgetCutOff,
  decisionOutputBudgetError,
  declaresVisualUnsupported,
  mergeStreamText,
  mergeToolCallDelta,
  createStreamCollector,
  consumeJsonEventStream,
  mergedFragment,
  STREAM_ERROR_STATUS,
  streamError,
  readOpenAiEventStream,
  readAnthropicEventStream,
  requestJson,
  requestStreamingChat,
  readResponsesEventStream,
  emitCompletedReasoning,
  nativeVisionError,
  openAiToolSchemas,
  anthropicToolSchemas,
  toolInputSchema,
  planToolInputSchema
};
