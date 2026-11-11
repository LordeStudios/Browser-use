'use strict';

const { boundedRequestContext } = require('./ollamaProvider.cjs');
const { readResponsesEventStream } = require('./providers/wire.cjs');
const { ProviderTurnLedger } = require('./providerTurnLedger.cjs');
const { summarizeConversation } = require('./providerCompaction.cjs');
const { openAiToolSchemas } = require('./openAiCompatibleProvider.cjs');
const { measureProviderRequest } = require('./desktopAgentCoordinator.cjs');

// PROMPT AUTHORSHIP REMOVED (rewrite): the harness assembles the system
// prompt; the provider renders request.systemPrompt verbatim.
const { IDENTITY_LINE } = require('./harness/identity.cjs');

class ResponsesProvider {
  constructor({ baseUrl, model, apiKey, fetchImpl = globalThis.fetch }) {
    this.baseUrl = String(baseUrl || '').replace(/\/$/, '');
    const url = new URL(this.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || !model || !apiKey) throw new Error('Valid provider URL, model and credential required.');
    Object.assign(this, { model, apiKey, fetchImpl });
    this.turnLedger = new ProviderTurnLedger({ contextTokens: 65_536 });
    this.partialReasoning = [];
    // Decision output budget (reasoning + plan + actions share it). Raised
    // progressively when a decision is cut off mid-thinking by
    // max_output_tokens, so planning models finish instead of re-deriving
    // the same plan into the same cap.
    this.outputBudget = null;
  }

  // Harness-invoked compaction (chat_compact tool, /compact command).
  summarizeFor(system, input, signal, coordinator) {
    return summarizeConversation({ protocol: 'responses', model: this.model, endpoint: `${this.baseUrl}/responses`, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, fetchImpl: this.fetchImpl, coordinator, signal, system, input });
  }

  async complete({ task, agentIdentity, systemPrompt, observation, observationUnchanged, attachments, history = [], tools, coordinator, messages, plan, goals, recovery, workspace, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint, turnLedger, effort, effortMode, signal, onThought, onProgress }) {
    // Effort tier (resolved by DesktopChatAgent): minimal->low,
    // standard->medium; advanced omits the field (previous behavior).
    const effortTier = ['minimal', 'standard', 'advanced'].includes(effort) ? effort : 'advanced';
    const ledger = turnLedger || this.turnLedger;
    const identity = `${this.baseUrl}:${this.model}:responses`;
    const context = boundedRequestContext({ task, agentIdentity, observation, observationUnchanged, attachments, history, tools, coordinator, messages, plan, goals, recovery, workspace, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint });
    const { tools: _tools, ...state } = ledger.begin(context);
    const content = [{ type: 'input_text', text: JSON.stringify(state) }];
    const image = observation?.screenshot;
    // Malformed/oversized native image: skip the image and continue with
    // text evidence rather than killing the run.
    // Client-local references (file://, content://, blob:) are NOT readable by
    // the provider and produce an unrecoverable 400. Only validated base64 or
    // data:image/... URLs may become input_image parts.
    const base64Payload = (value) => {
      const text = String(value || '').trim();
      const dataUrl = text.match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
      const payload = dataUrl ? dataUrl[2].replace(/\s+/g, '') : text;
      if (!payload || !/^[a-z0-9+/]+={0,2}$/i.test(payload)) return null;
      return payload;
    };
    const nativeImageUsable = !(observation?.desktop && image && (!base64Payload(image.data) || image.data.length > 20_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)));
    const nativeImageData = base64Payload(image?.data);
    if (nativeImageUsable && nativeImageData && nativeImageData.length <= 20_000_000 && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType)) content.push({ type: 'input_image', image_url: `data:${image.mimeType};base64,${nativeImageData}` });
    for (const attachment of attachments || []) {
      const attachmentData = attachment?.kind === 'image' ? base64Payload(attachment.data) : null;
      if (attachmentData) content.push({ type: 'input_image', image_url: `data:${attachment.mimeType};base64,${attachmentData}` });
    }
    // the harness owns the system prompt; the provider renders it verbatim.
    const instructions = String(systemPrompt || '').trim() || IDENTITY_LINE;
    const schemas = openAiToolSchemas(tools).map(({ function: tool }) => ({ type: 'function', ...tool, strict: false }));
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
    await ledger.compact({ current: state, system: instructions, tools: schemas, outputTokens: this.outputBudget || 16_384,
      extraTokens: content.filter(part => part.type === 'input_image').length * 4096 + Math.ceil(JSON.stringify(this.partialReasoning).length / 2), signal, metrics: coordinator?.metrics,
      summarize: (system, input, signal) => summarizeConversation({ protocol: 'responses', model: this.model, endpoint: `${this.baseUrl}/responses`, headers, fetchImpl: this.fetchImpl, coordinator, system, input, signal }) });
    const input = [...ledger.wireMessages({ format: 'responses', identity }), { role: 'user', content }, ...this.partialReasoning];
    // Reasoning models spend much of their output on thinking; a decision
    // budget sized for plain chat models guarantees a mid-think cut-off.
    const body = JSON.stringify({ model: this.model, store: false, stream: true, max_output_tokens: this.outputBudget || 16_384,
      instructions, input,
      // Ask the provider to expose user-safe reasoning summaries for the
      // thought channel; models that produce none simply emit none. Effort
      // tier maps onto the Responses reasoning control; advanced omits it.
      reasoning: { summary: 'auto', effort: effortTier === 'minimal' ? 'low' : effortTier === 'standard' ? 'medium' : 'high' },
      include: ['reasoning.encrypted_content'],
      tools: schemas });
    const payload = await measureProviderRequest(coordinator, { body, signal, kind: 'decision' }, async received => {
      const response = await this.fetchImpl(`${this.baseUrl}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, body, signal });
      received(response);
      if (!response.ok) {
        let details; try { details = await response.json(); } catch {}
        const error = new Error(`Responses request failed (${response.status}): ${String(details?.error?.message || response.statusText).slice(0, 400)}`);
        if ([400, 404, 405, 415, 422, 501].includes(response.status)) {
          error.code = 'PROVIDER_PROTOCOL_UNSUPPORTED';
          error.message += ' The selected connection must support the Responses tool-calling contract. No Chat Completions fallback was attempted.';
        }
        throw error;
      }
      return readResponsesEventStream(response, onThought, onProgress);
    });
    ledger.observeUsage(payload?.usage, Buffer.byteLength(body));
    if (coordinator?.metrics) coordinator.metrics.lastProviderResponse = { protocol: 'responses', status: payload?.status, usage: payload?.usage, incompleteReason: payload?.incomplete_details?.reason };
    if (payload?.status !== 'completed' || !Array.isArray(payload.output)) {
      // max_output_tokens cut-off is a budget condition, not a malformed
      // decision: raise the budget AND retain the partial reasoning (with its
      // encrypted continuity blob) as continuity context only. The next
      // decision must NOT resume the interrupted reasoning — the cut-off
      // happened mid-plan, so "continuing" the thinking only extends the
      // speculation loop; the model already had a decision forming and must
      // commit it immediately.
      if (payload?.status === 'incomplete' && payload?.incomplete_details?.reason === 'max_output_tokens') {
        // The cut-off often lands AFTER the model already emitted its tool
        // call(s) and was still talking. Commit what it already chose instead
        // of paying for a bigger budget and another round of reasoning to
        // re-derive an action the output already contains.
        try {
          const committed = (Array.isArray(payload.output) ? payload.output : [])
            .filter((item) => item?.type === 'function_call' && item?.call_id && item?.name && typeof item?.arguments === 'string');
          const calls = committed.map((call) => ({ name: call.name, input: JSON.parse(call.arguments || '{}'), callId: call.call_id }));
          if (calls.length && calls.every((call) => call.input && typeof call.input === 'object' && !Array.isArray(call.input))
            && new Set(calls.map((call) => call.callId)).size === calls.length) {
            const said = (Array.isArray(payload.output) ? payload.output : [])
              .filter((item) => item?.type === 'message').flatMap((item) => item.content || [])
              .filter((part) => part.type === 'output_text').map((part) => part.text).join('\n');
            this.partialReasoning = [];
            return ledger.accept({ actions: calls, ...(said ? { assistantText: said } : {}) }, payload, 'responses', identity);
          }
        } catch { /* fall through to the budget raise */ }
        const previousBudget = this.outputBudget || 16_384;
        this.outputBudget = Math.min(previousBudget * 4, 32_768);
        const partialReasoning = payload.output.filter(item => item?.type === 'reasoning');
        if (partialReasoning.length) this.partialReasoning = partialReasoning;
        const error = new Error(`The model's decision was cut off by the ${previousBudget}-token max_output_tokens limit while it was still reasoning or planning. Nothing was executed; the output budget was raised to ${this.outputBudget} and the partial reasoning was retained as context only. Do not resume or extend the thinking: stop now and emit the single action you had already settled on (or the done JSON) immediately — acting beats more reasoning.`);
        error.code = 'DECISION_OUTPUT_BUDGET';
        throw error;
      }
      throw new Error(`Responses request not completed: ${payload?.status || 'missing status'} ${payload?.incomplete_details?.reason || payload?.error?.message || ''}`);
    }
    if (Buffer.byteLength(JSON.stringify(payload.output)) > 1_000_000) throw new Error('Completed Responses output exceeds the replay bound.');
    const calls = payload.output.filter(item => item.type === 'function_call').map(call => {
      if (typeof call.call_id !== 'string' || !call.call_id || typeof call.name !== 'string' || !call.name) throw new Error('Responses tool call lacks an identity or name; no actions were accepted.');
      const input = JSON.parse(call.arguments || '{}');
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Responses tool arguments; no partial call was executed.');
      return { name: call.name, input, callId: call.call_id };
    });
    if (new Set(calls.map(call => call.callId)).size !== calls.length) throw new Error('Responses returned duplicate tool-call IDs; no actions were accepted.');
    const commentary = payload.output.filter(item => item.type === 'message').flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text).join('\n');
    this.partialReasoning = [];
    if (calls.length) return ledger.accept({ actions: calls, ...(commentary ? { assistantText: commentary } : {}) }, payload, 'responses', identity);
    // A commentary phase is not a final answer. Preserve it for continuity,
    // then let the existing actionless recovery request execution.
    const onlyCommentary = payload.output.filter(item => item.type === 'message').every(item => item.phase === 'commentary');
    if (commentary.trim() && !onlyCommentary) return { done: { summary: commentary, success: true, verified: false } };
    if (commentary.trim()) return ledger.accept({ assistantText: commentary, actions: [] }, payload, 'responses', identity);
    throw new Error('Responses returned neither executable tools nor a final answer.');
  }
}
module.exports = { ResponsesProvider };
