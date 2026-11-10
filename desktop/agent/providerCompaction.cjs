'use strict';

const { measureProviderRequest } = require('./desktopAgentCoordinator.cjs');

// Dedicated summary requests never carry tool schemas or execute model output.
// The summary must hold five arrays of concrete findings for a long
// conversation; a 4096-token ceiling truncated real summaries and, because the
// caller used to fail closed on that, could stall a healthy run.
const SUMMARY_OUTPUT_TOKENS = 16_384;
async function summarizeConversation({ protocol, model, endpoint, headers, fetchImpl, coordinator, signal, system, input }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(input) }];
  const body = protocol === 'anthropic'
    ? { model, max_tokens: SUMMARY_OUTPUT_TOKENS, system, messages: messages.slice(1), stream: false }
    : protocol === 'responses'
      ? { model, instructions: system, input: messages.slice(1), max_output_tokens: SUMMARY_OUTPUT_TOKENS, store: false, stream: false }
      : protocol === 'ollama'
        ? { model, messages, format: 'json', options: { temperature: 0, num_predict: SUMMARY_OUTPUT_TOKENS }, stream: false }
        : { model, messages, max_tokens: SUMMARY_OUTPUT_TOKENS, temperature: 0, stream: false };
  const serialized = JSON.stringify(body);
  return measureProviderRequest(coordinator, { kind: 'compaction', phase: 'compaction', body: serialized, signal }, async received => {
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: serialized, signal });
    received(response);
    if (!response.ok) throw new Error(`Compaction request failed (${response.status}).`);
    const payload = await response.json();
    if (payload?.error) throw new Error('Compaction returned a provider error.');
    let text;
    if (protocol === 'anthropic') {
      if (payload.stop_reason === 'max_tokens') throw new Error('Compaction output was truncated.');
      text = (payload.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
    } else if (protocol === 'responses') {
      if (payload.status !== 'completed') throw new Error('Compaction response did not complete.');
      text = (payload.output || []).filter(p => p.type === 'message').flatMap(p => p.content || []).filter(p => p.type === 'output_text').map(p => p.text).join('');
    } else {
      if (payload.done_reason === 'length' || payload.choices?.[0]?.finish_reason === 'length') throw new Error('Compaction output was truncated.');
      text = protocol === 'ollama' ? payload.message?.content : payload.choices?.[0]?.message?.content;
    }
    return JSON.parse(String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim());
  });
}
module.exports = { summarizeConversation };
