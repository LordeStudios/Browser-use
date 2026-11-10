'use strict';

// Wire tokenizer — answers "what does the model actually receive, and how big
// is each part of it?" for a provider request body.
//
// No tokenizer vocabulary ships in this repo and none can be downloaded
// reliably, so this is a deterministic APPROXIMATION of a GPT-style BPE
// (cl100k family): the same pre-tokenization regex, then a length-based
// sub-word estimate per piece. It is exact for short common words and
// punctuation and typically within ~15% on prose and JSON — good enough to
// compare sections and spot a bloated one, NOT a billing figure. Real billing
// numbers come from the provider's own usage block (ProviderTurnLedger).

const PRETOKEN = /'(?:[sdmt]|ll|ve|re)| ?\p{L}+| ?\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+/gu;
const CJK = /[぀-ヿ㐀-鿿가-힯]/u;

function pieceCount(piece) {
  const body = piece.replace(/^ /, '');
  if (!body) return 1; // whitespace run
  if (/^\p{N}+$/u.test(body)) return 1; // the regex already caps digit runs at 3
  if (/^\p{L}+$/u.test(body)) {
    if (CJK.test(body)) return Math.max(1, Math.round(body.length * 1.1));
    if (/^[\x00-\x7f]+$/.test(body)) return Math.max(1, Math.round(body.length / 4.5));
    return Math.max(1, Math.round(body.length / 2.2)); // accented / non-Latin scripts split finer
  }
  // Punctuation runs: JSON glue such as {" ":" "," merges into ~2-char tokens.
  return Math.max(1, Math.ceil(body.replace(/[\r\n]+$/, '').length / 2) + (/[\r\n]$/.test(body) ? 1 : 0));
}

function countTokens(text) {
  const source = String(text ?? '');
  if (!source) return 0;
  let total = 0;
  for (const match of source.matchAll(PRETOKEN)) total += pieceCount(match[0]);
  return total;
}

// Splits text into approximate token pieces for display. The piece count can
// differ from countTokens() by a few on very short fragments (rounding), so use
// countTokens() for sizing and tokenize() only to show where the splits fall.
function tokenize(text) {
  const source = String(text ?? '');
  const pieces = [];
  for (const match of source.matchAll(PRETOKEN)) {
    const piece = match[0];
    const count = pieceCount(piece);
    if (count <= 1) { pieces.push(piece); continue; }
    const lead = piece.startsWith(' ') ? ' ' : '';
    const body = piece.slice(lead.length);
    const size = Math.ceil(body.length / count);
    for (let index = 0; index < count; index += 1) {
      const part = body.slice(index * size, (index + 1) * size);
      if (part) pieces.push(index === 0 ? lead + part : part);
    }
  }
  return pieces;
}

// Directive density: sentences that command the model. A prompt that issues
// dozens of "never"/"always"/"must" rules across several sources is where
// mixed instructions come from.
const DIRECTIVE = /\b(?:never|always|must|do not|don't|only|should|required|forbidden|prefer|ensure|before|immediately|now)\b/gi;
function directiveCount(text) {
  return (String(text || '').match(DIRECTIVE) || []).length;
}

function section(label, text) {
  const value = typeof text === 'string' ? text : JSON.stringify(text ?? '');
  return { label, chars: value.length, bytes: Buffer.byteLength(value), tokens: countTokens(value), directives: directiveCount(value) };
}

// Splits a captured OpenAI-style or Anthropic-style request body into the
// labelled parts the model reads. `anchors` attribute pieces of the system
// prompt to the source that produced it.
function breakdownRequest(body, anchors = {}) {
  const anthropic = Array.isArray(body?.system) || (typeof body?.system === 'string' && !Array.isArray(body?.messages?.find?.((m) => m.role === 'system')));
  let system = '';
  let messages = Array.isArray(body?.messages) ? [...body.messages] : [];
  if (anthropic && body.system !== undefined) {
    system = Array.isArray(body.system) ? body.system.map((part) => part.text || '').join('\n') : String(body.system);
  } else if (messages[0]?.role === 'system') {
    system = String(messages.shift().content || '');
  }
  const last = messages.length && messages[messages.length - 1].role === 'user' ? messages.pop() : null;
  const lastText = last ? (typeof last.content === 'string' ? last.content : (last.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n')) : '';
  let context = null;
  try { context = JSON.parse(lastText); } catch { /* the last user message is not the JSON context */ }

  const parts = [];
  // System prompt, attributed by anchor strings when they are present.
  const cuts = Object.entries(anchors)
    .map(([label, anchor]) => ({ label, at: anchor ? system.indexOf(anchor) : -1 }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  if (!cuts.length) parts.push({ group: 'system', ...section('system prompt', system) });
  else {
    if (cuts[0].at > 0) parts.push({ group: 'system', ...section('system: base provider prompt', system.slice(0, cuts[0].at)) });
    cuts.forEach((cut, index) => parts.push({ group: 'system', ...section(`system: ${cut.label}`, system.slice(cut.at, cuts[index + 1]?.at ?? system.length)) }));
  }
  if (Array.isArray(body?.tools) && body.tools.length) parts.push({ group: 'tools', ...section(`tool schemas (${body.tools.length})`, body.tools) });
  if (messages.length) {
    parts.push({ group: 'history', ...section(`prior wire messages (${messages.length})`, messages), roles: messages.map((m) => m.role) });
  }
  if (context && typeof context === 'object') {
    for (const [key, value] of Object.entries(context)) parts.push({ group: 'context', ...section(`context.${key}`, value ?? null) });
  } else if (lastText) {
    parts.push({ group: 'context', ...section('final user message', lastText) });
  }
  const totals = parts.reduce((sum, part) => ({ chars: sum.chars + part.chars, bytes: sum.bytes + part.bytes, tokens: sum.tokens + part.tokens, directives: sum.directives + part.directives }), { chars: 0, bytes: 0, tokens: 0, directives: 0 });
  return { parts, totals, context, system };
}

module.exports = { countTokens, tokenize, directiveCount, section, breakdownRequest };
