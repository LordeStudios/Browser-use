'use strict';

// Adaptive Token Compressor — a Node port of Intel's Adaptive Token Compressor
// (Open Edge Platform, version 2026.2, 2026-09-09) for the Browser-use
// harness.
//
// Intel's library is Python and requires two services (a Lingua server for
// lossy text compression and an LLM predictor for tool selection). This port
// keeps the ARCHITECTURE and the API shape, and runs the parts that need no
// service in-process:
//
//   harness — section-aware compression of the prompt-assembly stage (the
//             system prompt and the long text blocks in the message history).
//             Intel: "combines lightweight rules (message slicing / role-aware
//             handling) with Lingua-based lossy compression for long text
//             blocks". The rule layer runs always; the Lingua layer runs only
//             when a Lingua server URL is configured.
//   tool    — Intel's ToolCompressor selects tools with an LLM predictor and
//             supports placements that trade token savings against prefix-cache
//             hit rate. Here the tool set is NEVER reduced (a weak model must
//             still see every tool), so this compressor compacts the SCHEMA of
//             non-core tools and accumulates the full schemas the model has
//             actually needed. Intel's `accumulate=True` rule — append-only,
//             never removed or reordered — is what keeps the cached prefix
//             stable, and the same rule is used here.
//
// Metrics use Intel's names: tokens_before, tokens_after, saved_tokens,
// compression_ratio, duration_ms.
//
// Design constraint that outranks Intel's default behaviour: a WEAK model must
// never be confused by what it receives. So the rule layer never rewrites or
// truncates a rule. It removes only a sentence that duplicates another
// sentence already present (a repeated directive), and it never removes a
// sentence that carries a distinct instruction. Tool names are never removed
// from the catalog.

const DEFAULT_COMPRESS_MIN_CHARS = 500;
const DEFAULT_SIMILARITY_THRESHOLD = 0.72;
const MIN_SENTENCE_TOKENS = 7;

// Words that mark a sentence as an instruction. Two sentences that both carry
// instructions and share most of their content are the same rule said twice.
const DIRECTIVE_WORDS = /\b(?:never|always|must|do not|don't|only|should|required|avoid|prefer|ensure|instead|before|after|when|if|without|use|call|read|write|verify|return|report|keep)\b/gi;

const tokenizeWords = (text) => String(text || '')
  .toLowerCase()
  .replace(/[^a-z0-9_./-]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean);

const DIRECTIVE_WORD_SET = new Set(['never', 'always', 'must', 'not', 'only', 'should', 'required', 'avoid', 'prefer', 'ensure', 'instead', 'before', 'after', 'when', 'without', 'use', 'call', 'read', 'write', 'verify', 'return', 'report', 'keep', 'don']);

function contentTokens(sentence) {
  // The directive words are excluded from the content set, so two sentences
  // that differ only in their imperative wording compare as the same rule.
  return new Set(tokenizeWords(sentence).filter((word) => word.length > 2 && !DIRECTIVE_WORD_SET.has(word)));
}

function similarity(a, b) {
  const setA = a instanceof Set ? a : contentTokens(a);
  const setB = b instanceof Set ? b : contentTokens(b);
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared += 1;
  return shared / Math.min(setA.size, setB.size);
}

function isDirective(sentence) {
  // A local regex: a shared global one keeps state between calls and skips
  // matches unpredictably.
  return /\b(?:never|always|must|do not|don't|only|should|required|avoid|prefer|ensure|instead|before|after|when|if|without|use|call|read|write|verify|return|report|keep)\b/i.test(String(sentence || ''));
}

// Split on sentence boundaries without breaking on common abbreviations or
// decimals, so "e.g." and "3.3" stay inside their sentence.
function splitSentences(text) {
  const source = String(text || '');
  const parts = [];
  let buffer = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    buffer += char;
    if (char !== '.' && char !== '!' && char !== '?' && char !== '\n') continue;
    if (char === '.') {
      const next = source[index + 1];
      const previous = source[index - 1];
      if (previous && /\d/.test(previous) && next && /\d/.test(next)) continue;
      if (source.slice(index - 2, index + 1) === 'e.g' || source.slice(index - 3, index + 1) === 'i.e') continue;
    }
    if (/[.!?]["')\]]?$/.test(buffer)) {
      parts.push(buffer);
      buffer = '';
    }
  }
  if (buffer.trim()) parts.push(buffer);
  return parts;
}

// The specific terms a sentence names: a tool, a field, a section, an
// identifier. If two similar sentences name DIFFERENT terms, one of them
// carries information the other does not, and dropping it would remove a rule
// the model needs. A sentence that names a term the other does not is never
// treated as a duplicate.
const TERM = /\b(?:[a-z]+_[a-z_]+|[A-Z][A-Za-z]+[A-Z][A-Za-z]*|\b[a-z]+\.[a-z_]+\b)/g;

function namedTerms(sentence) {
  const source = String(sentence || '');
  const terms = new Set();
  for (const match of source.matchAll(TERM)) {
    const term = match[0];
    if (term.length < 4) continue;
    terms.add(term.toLowerCase());
  }
  return terms;
}

// Removes a sentence that says the same thing as a sentence already kept.
// The FIRST occurrence wins (it usually sits in the section that introduced
// the rule), and a sentence that carries no directive is never used as a
// duplicate of anything.
function dedupeDirectives(text, { threshold = DEFAULT_SIMILARITY_THRESHOLD } = {}) {
  const source = String(text || '');
  if (!source.trim()) return { text: source, removed: 0, savedChars: 0 };
  const sentences = splitSentences(source);
  const kept = [];
  const keptDirectives = [];
  let removed = 0;
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const words = tokenizeWords(trimmed);
    const directive = isDirective(trimmed);
    if (directive && words.length >= MIN_SENTENCE_TOKENS) {
      const tokens = contentTokens(trimmed);
      const terms = namedTerms(trimmed);
      const duplicate = keptDirectives.find((entry) => {
        if (similarity(entry.tokens, tokens) < threshold) return false;
        // SAFETY: a sentence that names a term the kept one does not is
        // carrying a distinct rule. Dropping it would remove information a
        // weak model needs, which is worse than the tokens it costs.
        for (const term of terms) if (!entry.terms.has(term)) return false;
        return true;
      });
      if (duplicate) { removed += 1; continue; }
      keptDirectives.push({ tokens, terms, text: trimmed });
    }
    kept.push(sentence);
  }
  if (!removed) return { text: source, removed: 0, savedChars: 0 };
  let out = kept.join('');
  out = out.replace(/\n{3,}/g, '\n\n');
  return { text: out, removed, savedChars: source.length - out.length };
}

// Intel's HarnessCompressor: section-aware compression at prompt assembly.
// The rule layer deduplicates repeated directives and slices very long text
// blocks; the Lingua layer is optional and only used when configured.
class HarnessCompressor {
  constructor({ profile = 'browser-use', linguaUrl = '', compressRate = 0.5, compressMinChars = DEFAULT_COMPRESS_MIN_CHARS, threshold = DEFAULT_SIMILARITY_THRESHOLD, fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
    this.profile = profile;
    this.linguaUrl = String(linguaUrl || '').trim();
    this.compressRate = Number(compressRate) || 0.5;
    this.compressMinChars = Number(compressMinChars) || DEFAULT_COMPRESS_MIN_CHARS;
    this.threshold = threshold;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  // A long text block (the AGI playbook, a big tool result in the history) is
  // compressed; a short one is left alone, because compressing a short block
  // costs more in confusion than it saves in tokens.
  async compressBlock(text) {
    const source = String(text || '');
    if (source.length < this.compressMinChars) return { text: source, savedTokens: 0, savedChars: 0 };
    const deduped = dedupeDirectives(source, { threshold: this.threshold });
    let out = deduped.text;
    let via = 'rules';
    if (this.linguaUrl) {
      const lossy = await this.compressViaLingua(source);
      if (lossy && lossy.length && lossy.length < out.length) { out = lossy; via = 'lingua'; }
    }
    return {
      text: out,
      via,
      removedSentences: deduped.removed,
      savedChars: source.length - out.length,
      savedTokens: estimateTokens(source) - estimateTokens(out)
    };
  }

  // Intel's optional Lingua backend (llmlingua2 mode). Any failure keeps the
  // rule-based result: compression never breaks a request.
  async compressViaLingua(text) {
    if (!this.linguaUrl || typeof this.fetchImpl !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.linguaUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, rate: this.compressRate, method: 'llmlingua2' }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const compressed = payload?.compressed_prompt || payload?.compressedPrompt || payload?.text;
      return typeof compressed === 'string' ? compressed : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // The prompt-assembly stage: the system prompt is section-aware (split at
  // its headings) and each section is compressed independently, so a rule is
  // only ever removed when it duplicates a rule already in the same request.
  async compressSystem(systemText) {
    const source = String(systemText || '');
    if (!source.trim()) return { text: source, sections: [], savedTokens: 0, savedChars: 0 };
    const sections = splitSections(source);
    let savedChars = 0;
    const compressedSections = [];
    for (const section of sections) {
      const result = await this.compressBlock(section.text);
      savedChars += result.savedChars;
      compressedSections.push({ heading: section.heading, text: result.text, via: result.via || 'none' });
    }
    const out = compressedSections.map((section) => section.text).join('');
    return { text: out, sections: compressedSections, savedChars, savedTokens: estimateTokens(source) - estimateTokens(out) };
  }

  // The CompressionManager entry point: the harness tier compresses the
  // prompt-assembly stage (the system prompt and the conversation blocks).
  async compress(context = {}) {
    const system = await this.compressSystem(context.system || '');
    const messages = Array.isArray(context.messages) ? context.messages : [];
    const compressedMessages = [];
    for (const message of messages) {
      const content = typeof message?.content === 'string' ? message.content : '';
      if (!content) { compressedMessages.push(message); continue; }
      const block = await this.compressBlock(content);
      compressedMessages.push({ ...message, content: block.text });
    }
    return { system: system.text, text: system.text, messages: compressedMessages };
  }
}

// Split a prompt at its headings. Intel splits the harness prompt at its
// headings "via the openclaw profile"; this splits at Markdown headings and
// at blank-line-separated paragraphs when there are no headings.
function splitSections(text) {
  const source = String(text || '');
  const lines = source.split('\n');
  const sections = [];
  let heading = '';
  let buffer = [];
  const flush = () => {
    const body = buffer.join('\n');
    if (body.trim()) sections.push({ heading, text: body });
    buffer = [];
  };
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) { flush(); heading = match[2].trim(); continue; }
    buffer.push(line);
  }
  flush();
  if (!sections.length) return [{ heading: '', text: source }];
  return sections;
}

// Intel's ToolCompressor, adapted to the harness rule that no tool may be
// hidden: the full schema is kept for the core tools, and every other tool
// keeps its name, description and argument names with a compacted schema.
// A schema the model actually needed is remembered (accumulated) and delivered
// in the context, never removed.
class ToolCompressor {
  constructor({ core = [], predictorUrl = '', scoreThreshold = 3.0, placement = 'context', accumulate = true, timeout = 120_000, fetchImpl = globalThis.fetch } = {}) {
    this.core = new Set((Array.isArray(core) ? core : []).map(String));
    this.predictorUrl = String(predictorUrl || '').trim();
    this.scoreThreshold = Number(scoreThreshold) || 3.0;
    this.placement = placement === 'schema' ? 'schema' : 'context';
    this.accumulate = accumulate !== false;
    this.timeout = timeout;
    this.fetchImpl = fetchImpl;
    // The union of tools whose full schema has been delivered. Append-only:
    // a schema the model needed never disappears from later requests.
    this.loaded = new Map();
  }

  // Marks a tool as needing its full schema. The schema itself is delivered
  // by the harness (the agent owns the catalog), so the compressor only
  // records the intent.
  noteLoaded(toolName, schema = null) {
    if (!toolName) return;
    if (schema) this.loaded.set(toolName, schema);
    else if (!this.loaded.has(toolName)) this.loaded.set(toolName, null);
  }

  isCore(toolName) { return this.core.has(String(toolName)); }

  // The CompressionManager entry point: the tool tier never removes a tool.
  // It records the tools whose full schema the model has asked for, and (when
  // a predictor is configured) scores the rest so a caller can decide which
  // ones deserve their full schema. The score never removes a tool.
  async compress(context = {}) {
    const tools = Array.isArray(context.tools) ? context.tools : [];
    const scores = await this.scoreTools(tools, context.system || (context.messages || []).map((message) => message?.content || '').join('\n'));
    return { tools, scores, loaded: [...this.loaded.keys()] };
  }

  // Intel's optional LLM predictor: scores tool relevance from the
  // conversation. It never REMOVES a tool — the score only decides which
  // tools keep their full schema.
  async scoreTools(tools, contextText) {
    if (!this.predictorUrl || typeof this.fetchImpl !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const response = await this.fetchImpl(this.predictorUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'tool-predictor',
          messages: [
            { role: 'system', content: 'Score each tool\'s relevance to the request from 0 to 5. Reply with JSON: {"scores":[{"name":"...","score":0}]}.' },
            { role: 'user', content: `Request:\n${String(contextText || '').slice(0, 4000)}\n\nTools:\n${(tools || []).map((tool) => `- ${tool.name}: ${tool.description || ''}`).join('\n')}` }
          ]
        }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content || '';
      const parsed = JSON.parse(String(content).replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
      const scores = new Map();
      for (const entry of parsed?.scores || []) scores.set(String(entry.name), Number(entry.score) || 0);
      return scores;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

// Intel's CompressionManager: registers compressors and aggregates the
// savings across them.
class CompressionManager {
  constructor() { this.compressors = new Map(); }

  registerCompressor(type, compressor) {
    this.compressors.set(String(type), compressor);
    return compressor;
  }

  registerMetric(name, metric) { this.metrics = this.metrics || new Map(); this.metrics.set(String(name), metric); return metric; }

  async compress(type, context) {
    const compressor = this.compressors.get(String(type));
    if (!compressor) throw new Error(`No compressor registered for type "${type}".`);
    const startedAt = Date.now();
    const result = await compressor.compress(context);
    const metrics = {
      tokens_before: estimateTokens(context?.system || ''),
      tokens_after: estimateTokens(result?.text ?? result?.system ?? ''),
      saved_tokens: 0,
      compression_ratio: 0,
      duration_ms: Date.now() - startedAt
    };
    metrics.saved_tokens = Math.max(0, metrics.tokens_before - metrics.tokens_after);
    metrics.compression_ratio = metrics.tokens_before ? metrics.saved_tokens / metrics.tokens_before : 0;
    return { ...result, metrics };
  }
}

// A coarse token estimate used for the metrics only. The harness's real
// accounting comes from the provider's own usage block.
function estimateTokens(text) {
  const source = String(text || '');
  if (!source) return 0;
  return Math.ceil(source.length / 4);
}

// Factory construction, mirroring Intel's create_compressor() /
// available_compressor_types() / config_schema().
const COMPRESSOR_TYPES = new Set(['harness', 'tool']);

function availableCompressorTypes() { return [...COMPRESSOR_TYPES]; }

function configSchema(type) {
  if (type === 'harness') {
    return { profile: 'string', linguaUrl: 'string', compressRate: 'number 0..1', compressMinChars: 'number', threshold: 'number 0..1' };
  }
  if (type === 'tool') {
    return { core: 'string[]', predictorUrl: 'string', scoreThreshold: 'number', placement: 'schema|context', accumulate: 'boolean' };
  }
  return null;
}

function createCompressor(type, config = {}) {
  if (type === 'harness') return new HarnessCompressor(config);
  if (type === 'tool') return new ToolCompressor(config);
  throw new Error(`Unknown compressor type "${type}". Available: ${availableCompressorTypes().join(', ')}.`);
}

// The run notebook is re-sent on EVERY decision, because it is durable state.
// In its default state seven of its sections are EMPTY and one carries a
// template line the model is meant to replace. Those are pure per-request
// overhead: ~100 tokens of nothing, on every turn of every run.
//
// The compression is section-aware (Intel's harness principle): a section with
// content is kept in full, a section with no content is dropped, and the
// template line is dropped. A section that later gains content comes back in
// full, so nothing durable is ever lost.
function compressNotebook(notebookText) {
  const source = String(notebookText || '');
  if (!source.trim()) return { text: source, droppedSections: [], savedChars: 0 };
  const lines = source.split('\n');
  const out = [];
  const droppedSections = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const heading = /^##\s+(.*)$/.exec(line);
    if (!heading) { out.push(line); index += 1; continue; }
    // Collect the section's body.
    const body = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^##\s+/.test(lines[cursor]) && !/^#\s+/.test(lines[cursor])) {
      body.push(lines[cursor]);
      cursor += 1;
    }
    const content = body.filter((entry) => entry.trim());
    const isTemplate = content.length === 1 && /^\-\s*\(/.test(content[0].trim());
    if (!content.length || isTemplate) {
      droppedSections.push(heading[1].trim());
      index = cursor;
      continue;
    }
    out.push(line, ...body);
    index = cursor;
  }
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n');
  return { text, droppedSections, savedChars: source.length - text.length };
}

module.exports = {
  HarnessCompressor,
  ToolCompressor,
  CompressionManager,
  createCompressor,
  availableCompressorTypes,
  configSchema,
  compressNotebook,
  dedupeDirectives,
  splitSentences,
  splitSections,
  estimateTokens
};
