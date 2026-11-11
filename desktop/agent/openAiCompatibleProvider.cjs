'use strict';

const {
  normalizeBaseUrl,
  providerEndpoint,
  providerError,
  retryableProviderStatus,
  currentVisualEvidence,
  openAiUserContent,
  anthropicUserContent,
  declaredReasoning,
  decisionBudgetCutOff,
  decisionOutputBudgetError,
  declaresVisualUnsupported,
  readOpenAiEventStream,
  readAnthropicEventStream,
  emitCompletedReasoning,
  openAiToolSchemas,
  anthropicToolSchemas,
  ANTHROPIC_VERSION,
  DECISION_MAX_TOKENS,
  REPAIR_MAX_TOKENS,
  LONG_REPORT_MAX_TOKENS
} = require('./providers/wire.cjs');
// ADAPTIVE TOKEN COMPRESSOR (Intel's Adaptive Token Compressor, harness tier):
// section-aware compression of the prompt-assembly stage.
const { HarnessCompressor } = require('./adaptiveTokenCompressor.cjs');
const { PROVIDER_LABELS, getProviderDescriptor, isClaudeModel, requiresResponsesProtocol } = require('./providers/descriptors.cjs');
const { pauseForRetry } = require('./providers/retry.cjs');
const {
  parseAgentResponse,
  extractEmbeddedDecision,
  hasExecutableDecision,
  actionOnlyRepairPrompt,
  recoverInformationalFinal,
  boundedRequestContext
} = require('./ollamaProvider.cjs');
const { measureProviderRequest } = require('./desktopAgentCoordinator.cjs');
const { isLongReportRequest } = require('./reportFilePolicy.cjs');
const { ProviderTurnLedger } = require('./providerTurnLedger.cjs');
const { summarizeConversation } = require('./providerCompaction.cjs');
const { activeModelVisionSupport } = require('./visionDelegate.cjs');

// PROMPT AUTHORSHIP REMOVED (rewrite): the harness assembles the system
// prompt (identity, persona, policies, tool guidance) and passes it as
// request.systemPrompt. The provider renders it verbatim and adds nothing.
const { IDENTITY_LINE } = require('./harness/identity.cjs');

class OpenAiCompatibleProvider {
  constructor({ providerId, baseUrl, model, apiKey, fetchImpl = globalThis.fetch, ttsVoice = '', visionDelegate = null }) {
    if (!PROVIDER_LABELS[providerId]) throw new Error('Unknown AI provider.');
    const label = PROVIDER_LABELS[providerId];
    if (!String(apiKey || '').trim()) throw new Error(`${label} requires an API key configured in secure storage.`);
    if (!String(model || '').trim()) throw new Error(`Choose ${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label} model before starting the agent.`);
    this.providerId = providerId;
    this.baseUrl = normalizeBaseUrl(baseUrl || getProviderDescriptor(providerId)?.defaultBaseUrl || '');
    this.model = String(model).trim();
    this.apiKey = String(apiKey).trim();
    this.ttsVoice = String(ttsVoice || '').trim();
    this.fetchImpl = fetchImpl;
    // VISION DELEGATE: describe({image}) → a vision-capable model's text
    // description, used when THIS model cannot see (visualUnsupported).
    this.visionDelegate = typeof visionDelegate === 'function' ? visionDelegate : null;
    this.visualUnsupported = false;
    this.visualProseStrikes = 0;
    this.visualHardFailures = 0;
    // Capability metadata resolution for THIS model (null = unresolved,
    // 'yes' | 'no' | 'unknown'). Resolved once per provider instance from the
    // connection's own /models roster before the first image-bearing
    // decision ships image content; null keeps the reactive latches below
    // as the only gate.
    this.visualCapability = null;
    // Set when native desktop vision is degraded (image rejected by the
    // provider). The agent publishes a one-time advisory when this flips.
    this.visionDegraded = false;
    this.nativeToolsBroken = false;
    // Prompt caching (Anthropic-protocol routes): the request structure is
    // append-only, so a cache breakpoint on the system block lets compliant
    // gateways reuse tools + system + older history instead of re-reading
    // them every decision. Latched off for the session when a gateway
    // rejects the extension; BROWSER_USE_PROMPT_CACHE=off disables it.
    this.promptCacheUnsupported = false;
    // Decision output budget (reasoning + plan + actions share it). Raised
    // progressively when a decision is cut off mid-thinking, so planning
    // models finish instead of re-deriving the same plan into the same cap.
    this.outputBudget = null;
    this.turnLedger = new ProviderTurnLedger();
  }

  // GATEWAY-EXACT: POST /v1/messages/count_tokens (xkiro serves it for every
  // model id, live-verified). Returns input_tokens or null on ANY failure —
  // the caller keeps its UTF-8 estimate and nothing else changes.
  async countTokensViaGateway({ system = '', messages = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await this.fetchImpl(providerEndpoint(this.baseUrl, '/v1/messages/count_tokens'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: this.model, ...(system ? { system } : {}), messages }),
        signal: controller.signal
      });
      if (!response.ok) return null;
      const payload = await response.json();
      const tokens = Number(payload?.input_tokens);
      return Number.isFinite(tokens) && tokens > 0 ? tokens : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // CAPABILITY METADATA: resolve THIS model's image-input support from the
  // connection's own /models roster (the same roster and explicit-flag rule
  // the vision delegate trusts). Strictly bounded and non-fatal: any failure
  // stays 'unknown' and the reactive latches below keep their role. Resolved
  // once per provider instance, and only when a decision actually has an
  // image to ship — plain text runs never pay the fetch.
  async resolveVisionCapability() {
    if (this.visualCapability) return this.visualCapability;
    this.visualCapability = 'unknown';
    try {
      const supported = await activeModelVisionSupport({ baseUrl: this.baseUrl, apiKey: this.apiKey, model: this.model, fetchImpl: this.fetchImpl });
      if (supported === true) this.visualCapability = 'yes';
      else if (supported === false) this.visualCapability = 'no';
    } catch {}
    return this.visualCapability;
  }

  async complete({ task, agentIdentity, systemPrompt, attachments, observation, observationUnchanged, history, messages, coordinator, plan, goals, recovery, workspace, tools, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint, turnLedger, effort, effortMode, signal, onThought, onStream, onActionReady }) {
    // the harness system prompt arrives on the request; the provider
    // renders it verbatim and authors no persona.
    const effortTier = ['minimal', 'standard', 'advanced'].includes(effort) ? effort : 'advanced';
    const harnessSystemRaw = String(systemPrompt || '').trim()
      || require('./prompt/sections.cjs').defaultSystemPrompt({ effort: effortTier, effortMode });
    const effortSystemPrompt = effortTier === 'minimal'
      ? 'Reasoning effort: minimal. Decide and act immediately on the freshest evidence; skip deliberation entirely and issue the fewest actions that make progress.'
      : effortTier === 'standard'
        ? 'Reasoning effort: standard. Keep private reasoning to one or two short sentences, then act.'
        : '';
    // Auto effort: the model may request one tier more depth, but only with a
    // concrete reason; the harness clamps abuse (see applyEffortEscalation).
    const effortEscalationPrompt = effortMode === 'auto'
      ? ` Reasoning effort starts at ${effortTier} and adjusts to the task: set "effortNeeded" one step toward "standard" or "minimal" + a one-sentence "effortReason" when the task clearly needs less thinking, or one step toward "advanced" when a phase genuinely needs deeper reasoning. One step per decision; never adjust by habit. You may instead put "thinkingBudgetMs" (a NUMBER of milliseconds) as a TOP-LEVEL field of your decision JSON, next to actions/assistantText — it is read directly and sets the reasoning budget of your next decision: 0 = act immediately with no reasoning, 3000 = minimal, 20000 = brief, 60000 = deliberate. State it in the JSON every decision you want it to hold; a summary line does not set it. Stop reasoning the moment the next action is clear.`
      : '';
    const effortPrefix = `${effortSystemPrompt}${effortEscalationPrompt ? `${effortSystemPrompt ? ' ' : ''}${effortEscalationPrompt}` : ''}${effortSystemPrompt || effortEscalationPrompt ? '\n\n' : ''}`;
    const harnessSystem = `${effortPrefix}${harnessSystemRaw}`;
    const ledger = turnLedger || this.turnLedger;
    const identity = `${this.providerId}:${this.baseUrl}:${this.model}`;
    // CAPABILITY METADATA LATCH: resolve THIS model's image-input support
    // from the connection's /models roster BEFORE the first image-bearing
    // decision. An explicit capabilities.vision === false pre-latches the
    // same text-only path a rejection would latch (below), so a text-only
    // model is never sent screenshots or attachment images at all — and the
    // vision delegate (next block) still describes the frame as text on this
    // same decision. Absent flags and failed reads keep the previous
    // reactive behavior; 'yes' changes nothing.
    if (!this.visualUnsupported && !this.visualCapability) {
      const pendingVisual = Boolean(currentVisualEvidence(observation))
        || (Array.isArray(attachments) && attachments.some((item) => item?.kind === 'image' && item?.data));
      if (pendingVisual) {
        await this.resolveVisionCapability();
        if (this.visualCapability === 'no') {
          this.visualUnsupported = true;
          this.visionDegraded = true;
        }
      }
    }
    // VISION DELEGATE (text-only fallback) — BEFORE the context build: when
    // the active model cannot see images (visualUnsupported latched by prior
    // rejections), a vision-capable model on the SAME connection describes
    // the screenshot and the description rides as TEXT evidence — the
    // viewing step is delegated instead of failed, and the run stays on its
    // model. Every failure keeps the previous text-only behavior.
    let delegatedVision = null;
    if (this.visualUnsupported && typeof this.visionDelegate === 'function') {
      const subject = currentVisualEvidence(observation)
        || (Array.isArray(attachments) ? attachments.filter((item) => item?.kind === 'image').map((item) => currentVisualEvidence({ screenshot: item })).filter(Boolean)[0] : null);
      if (subject) {
        try { delegatedVision = await this.visionDelegate({ image: subject }); } catch { delegatedVision = null; }
      }
    }
    const context = boundedRequestContext({ task, agentIdentity, attachments, observation, observationUnchanged, history, messages, coordinator, plan, goals, recovery, workspace, tools, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint, ...(delegatedVision?.ok ? { delegatedVision: { via: delegatedVision.model, description: String(delegatedVision.text).slice(0, 8000) } } : {}) });
    const currentContext = ledger.begin(context);
    try {
      const contextBytes = Buffer.byteLength(JSON.stringify(context));
      coordinator.metrics.providerContextBytes += contextBytes;
      // ~4 chars/token estimate (see boundedRequestContext): makes context
      // growth visible in the same units the provider window speaks.
      coordinator.metrics.providerContextTokens += Math.ceil(contextBytes / 4);
    } catch {}
    // One protocol resolution seam (descriptors.cjs): Claude-family models on
    // an OpenAI-compatible gateway still speak the Anthropic wire protocol.
    const isAnthropic = this.providerId === 'anthropic' || (this.providerId === 'xkiro' && isClaudeModel(this.model));
    const endpoint = isAnthropic
      ? providerEndpoint(this.baseUrl, '/v1/messages')
      : providerEndpoint(this.baseUrl, '/chat/completions');
    const headers = isAnthropic
      ? { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION }
      : { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` };
    const visual = currentVisualEvidence(observation);
    const nativeImage = Boolean(observation?.desktop && observation?.screenshot);
    if (nativeImage && (!visual || this.visualUnsupported)) {
      // Degrade instead of killing the run: latch vision off and continue
      // with text evidence (window list, foreground title, etc.). The
      // advisory flag informs the user once; the vision delegate (if
      // configured) picks up on the next decision.
      this.visualUnsupported = true;
      this.visionDegraded = true;
    }
    const attachmentVisuals = Array.isArray(attachments) ? attachments
      .filter((item) => item?.kind === 'image')
      .map((item) => currentVisualEvidence({ screenshot: item }))
      .filter(Boolean) : [];
    let accumulatedThought = '';
    // Text-only retry scope for THIS decision when the provider claims (in
    // prose) that it cannot act on the image. Reset every call so the image
    // capability is retried on the next decision instead of being lost for
    // the session — see the strike-based latch below.
    let skipVisuals = false;
    const relayThought = (text) => {
      const next = String(text || '');
      if (!next || typeof onThought !== 'function') return;
      if (next === accumulatedThought) return;
      accumulatedThought = next;
      onThought(next);
    };
    const request = async (system, userContext, { repair = false } = {}) => {
      const wantsStream = Boolean(onThought || onStream);
      const reportRequest = isLongReportRequest(task);
      const decisionBudget = this.outputBudget || (isAnthropic ? 4_096 : DECISION_MAX_TOKENS);
      const maxTokens = reportRequest
        ? LONG_REPORT_MAX_TOKENS
        : repair
          ? (isAnthropic ? 2_048 : REPAIR_MAX_TOKENS)
          : effortTier === 'minimal' ? 1_024 : decisionBudget;
      // The AGI playbook must ride with the AGI tool CATALOG (any run advertising
// computer_* tools), not only with desktop observations — a browser-fixture
// run that can execute computer_file/computer_patch needs the same rules.
// isComputerTool, not a name prefix: computer_model (media generation) is
// advertised in plain browser mode too, and matching on "computer_" attached the
// whole ~4,500-character AGI/Coding-mode playbook to every request — a one-word
// "hello" arrived with desktop-control and repo-editing rules.
// the system prompt comes from the harness registry verbatim — the
// provider authors no PERSONA. The per-request EFFORT PROTOCOL is the one
// provider-owned block: it states the tier this request runs at and the
// escalation channel the model may use, which is wire config (the tier maps
// onto reasoning_effort/thinking on this very request), not persona. It names
// the MECHANISM, never a "harness" the model can narrate.
const userSafeSystem = String(system || '').trim() || IDENTITY_LINE;
      // ADAPTIVE COMPRESSION (Intel's Adaptive Token Compressor, harness tier):
      // the system prompt is compressed section-aware before it goes on the
      // wire. The rule layer removes a directive only when it duplicates a
      // directive already in the same request AND names no term the other does
      // not — so a distinct rule is never dropped. The optional Lingua
      // backend (a lossy pass) runs only when a Lingua server is configured.
      const harnessCompressor = this.harnessCompressor || (this.harnessCompressor = new HarnessCompressor({
        linguaUrl: process.env.BROWSER_USE_LINGUA_URL || ''
      }));
      const compressedSystem = (await harnessCompressor.compressSystem(userSafeSystem)).text;
      let lastError = null;
      let requestKind = repair ? 'repair' : 'decision';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        // Recomputed per attempt: a 400 latch from attempt 1 must strip the
        // cache extension from attempt 2.
        const usePromptCache = isAnthropic && !this.promptCacheUnsupported && process.env.BROWSER_USE_PROMPT_CACHE !== 'off';
        const activeVisuals = (this.visualUnsupported || skipVisuals) ? [] : [visual, ...attachmentVisuals].filter(Boolean);
        const activeTools = this.nativeToolsBroken ? [] : (isAnthropic ? anthropicToolSchemas(tools) : openAiToolSchemas(tools));
        const wireContext = activeTools.length ? { ...userContext, tools: undefined } : userContext;
        // GATEWAY-EXACT token refinement (xkiro only, owner-wired): inside the
        // compaction ambiguity zone the UTF-8 estimate decides whether a
        // summarizer request fires — one exact /v1/messages/count_tokens call
        // there prevents premature compaction (and the per-decision summarizer
        // churn that comes with it). Strictly bounded: 2.5s timeout, any
        // failure keeps the estimate, the decision never waits on more.
        let exactTokens = null;
        if (this.providerId === 'xkiro' && typeof ledger.estimateFor === 'function') {
          try {
            const pre = ledger.estimateFor({ current: wireContext, system: compressedSystem, tools: activeTools, outputTokens: maxTokens, extraTokens: activeVisuals.length * 4096 });
            if (pre.tokens >= pre.limit * 0.8 && pre.tokens <= pre.limit * 1.1) {
              const preWire = ledger.wireMessages({ format: 'openai', identity });
              exactTokens = await this.countTokensViaGateway({
                system: compressedSystem,
                messages: preWire.map((message) => ({
                  role: message.role === 'assistant' || message.role === 'user' ? message.role : 'user',
                  content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
                })).filter((message) => message.content)
              });
            }
          } catch { exactTokens = null; }
        }
        await ledger.compact({ current: wireContext, system: compressedSystem, tools: activeTools, outputTokens: maxTokens,
          extraTokens: activeVisuals.length * 4096, signal, metrics: coordinator?.metrics, exactTokens,
          summarize: (system, input, signal) => summarizeConversation({ protocol: isAnthropic ? 'anthropic' : 'openai', model: this.model, endpoint, headers, fetchImpl: this.fetchImpl, coordinator, signal, system, input }) });
        const prior = ledger.wireMessages({ format: isAnthropic ? 'anthropic' : this.nativeToolsBroken ? 'json' : 'openai', identity });
        const body = isAnthropic
          ? {
              model: this.model,
              max_tokens: maxTokens,
              stream: wantsStream,
              // Minimal effort skips extended thinking entirely (omit the
              // field — Anthropic has no "disabled" type); standard keeps the
              // previous 1_024 budget; advanced is exactly previous behavior.
              ...(effortTier === 'minimal' ? {} : { thinking: { type: 'enabled', budget_tokens: 1_024 } }),
              ...(activeTools.length ? { tools: activeTools } : {}),
              system: usePromptCache
                ? [{ type: 'text', text: compressedSystem, cache_control: { type: 'ephemeral' } }]
                : compressedSystem,
              messages: [...prior, { role: 'user', content: anthropicUserContent(wireContext, activeVisuals) }]
            }
          : { model: this.model, max_tokens: maxTokens, temperature: 0, stream: wantsStream,
              // OpenAI-style reasoning effort: minimal->low, standard->medium;
              // advanced omits the field (previous behavior). Broadly
              // OpenAI-compatible servers ignore unknown/extra parameters.
              ...(effortTier === 'advanced' ? {} : { reasoning_effort: effortTier === 'minimal' ? 'low' : 'medium' }),
              ...(activeTools.length ? { tools: activeTools, tool_choice: 'auto' } : {}),
              messages: [{ role: 'system', content: compressedSystem }, ...prior, { role: 'user', content: openAiUserContent(wireContext, activeVisuals) }] };
        let response, payload, transportFailed = false;
        const serializedBody = JSON.stringify(body);
        try {
          ({ response, payload } = await measureProviderRequest(coordinator, { kind: requestKind, phase: repair ? 'repair' : 'decision', attempt, body: serializedBody, signal }, async received => {
            let response;
            try { response = await this.fetchImpl(endpoint, { method: 'POST', headers, body: serializedBody, signal }); }
            catch (error) { transportFailed = true; throw error; }
            received(response);
            let payload = null;
            if (response.ok && wantsStream && response.body?.getReader) {
              payload = isAnthropic
                ? await readAnthropicEventStream(response, relayThought, onStream)
                : await readOpenAiEventStream(response, relayThought, onStream, typeof onActionReady === 'function' ? onActionReady : null);
            } else {
              try { payload = await response.json(); } catch (error) { received(response, error); }
            }
            return { response, payload };
          }));
        } catch (error) {
          // Preserve the existing retry boundary: a partial stream is not a
          // fresh transport failure and must not be silently replayed. A
          // stream that went SILENT mid-response (no tokens for the idle
          // window) gets exactly one replay — the request itself is replayed
          // because the partial decision never executed any tool.
          const streamIdle = error?.code === 'PROVIDER_STREAM_IDLE';
          if (streamIdle && attempt === 1) {
            lastError = error;
            requestKind = 'transport-retry';
            await pauseForRetry(500, signal);
            continue;
          }
          if (!transportFailed || signal?.aborted || attempt === 2) throw error;
          lastError = error;
          requestKind = 'transport-retry';
          await pauseForRetry(250 * attempt, signal);
          continue;
        }
        if (response.ok) {
          ledger.observeUsage(payload?.usage, Buffer.byteLength(serializedBody));
          emitCompletedReasoning(payload, isAnthropic, relayThought);
          if (activeVisuals.length && declaresVisualUnsupported(payload, isAnthropic) && (nativeImage || attempt < 2)) {
            // Native desktop image: the model explicitly said it cannot see —
            // latch immediately (stronger signal than a browser prose complaint)
            // and degrade to text evidence. The run continues.
            // Browser screenshot: strike-based (one prose complaint may be a
            // delivery glitch, not a capability gap).
            skipVisuals = true;
            if (nativeImage) {
              this.visualProseStrikes += 1;
              if (this.visualProseStrikes >= 2) {
                this.visualUnsupported = true;
                this.visionDegraded = true;
              }
            } else {
              this.visualProseStrikes += 1;
              if (this.visualProseStrikes >= 2) this.visualUnsupported = true;
            }
            requestKind = 'capability-fallback';
            lastError = new Error('The provider did not act on the attached image; retrying this decision with text evidence only.');
            continue;
          }
          if (activeVisuals.length) this.visualHardFailures = 0;
          return payload;
        }
        const error = providerError(PROVIDER_LABELS[this.providerId], response, payload);
        // Some Anthropic-compatible gateways reject the caching extension.
        // Latch it off for the session and retry the identical request without
        // it; a persistent 400 still surfaces honestly on the final attempt.
        if (usePromptCache && Number(response.status) === 400 && attempt < 2) {
          this.promptCacheUnsupported = true;
          requestKind = 'capability-fallback';
          lastError = error;
          continue;
        }
        // Model gateways vary in native tool-calling support. Degrade to the
        // JSON-in-content protocol instead of turning the capability mismatch
        // into a hard failure.
        if (activeTools.length && Number(response.status) === 400 && attempt < 2) {
          this.nativeToolsBroken = true;
          requestKind = 'capability-fallback';
          lastError = error;
          continue;
        }
        // Native image rejected by the provider: degrade to text-only and
        // retry this decision. A capability gap is not a terminal failure —
        // the run continues with window/DOM text evidence.
        if (nativeImage && [400, 403, 413, 415, 422].includes(Number(response.status)) && attempt < 2) {
          // 403/413 commonly mean gateway policy or payload size, not a
          // model capability result. Retry text-only for this decision while
          // preserving the chance to send a smaller image next time.
          if ([403, 413].includes(Number(response.status))) skipVisuals = true;
          else {
            this.visualHardFailures += 1;
            if (this.visualHardFailures >= 2) {
              this.visualUnsupported = true;
              this.visionDegraded = true;
            }
            skipVisuals = true;
          }
          requestKind = 'capability-fallback';
          lastError = error;
          continue;
        }
        // 403 joins the visual fallback list because size-gated gateways
        // reject large image-bearing requests with 403; dropping the image
        // recovers the decision instead of failing it. A request without
        // visuals still fails loud (an auth problem must stay one).
        if (activeVisuals.length && [400, 403, 413, 415, 422].includes(Number(response.status)) && attempt < 2) {
          // Model gateways vary in multimodal support, and 403/413 often mean
          // policy or payload size. Preserve the task and retry text-only, but
          // do not permanently classify those transient/size failures as a
          // text-only model.
          if ([403, 413].includes(Number(response.status))) skipVisuals = true;
          else {
            this.visualHardFailures += 1;
            if (this.visualHardFailures >= 2) this.visualUnsupported = true;
            skipVisuals = true;
          }
          requestKind = 'capability-fallback';
          lastError = error;
          continue;
        }
        if (!retryableProviderStatus(response.status) || attempt === 2) throw error;
        lastError = error;
        requestKind = 'transport-retry';
        await pauseForRetry(250 * attempt, signal);
      }
      throw lastError || new Error('The provider request could not be completed.');
    };
    const contentFor = (payload) => isAnthropic
      ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : '')
      : payload?.choices?.[0]?.message?.content;
    const parseDecision = (payload, { allowPlainText = false } = {}) => {
      const content = contentFor(payload);
      const message = isAnthropic ? null : payload?.choices?.[0]?.message;
      const reasoningText = isAnthropic
        ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'thinking').map((part) => part.thinking || part.text).join('\n') : '')
        : declaredReasoning(message);
      const nativeToolCalls = isAnthropic
        ? (Array.isArray(payload?.content) ? payload.content.filter((part) => part?.type === 'tool_use').map((part) => ({ id: part.id, name: part.name, arguments: part.input })) : [])
        : message?.tool_calls;
      let parsed;
      try {
        parsed = parseAgentResponse(content, nativeToolCalls);
      } catch (error) {
        // A model that wrote its decision as raw JSON inside the visible
        // stream (the "JSON leak") still produced an executable decision.
        // Harvest it before spending a repair round trip.
        const embedded = extractEmbeddedDecision([content, reasoningText].filter(Boolean).join('\n'));
        if (embedded && hasExecutableDecision(embedded)) return ledger.accept(embedded, payload, isAnthropic ? 'anthropic' : this.nativeToolsBroken ? 'json' : 'openai', identity);
        const informationalFinal = allowPlainText ? recoverInformationalFinal(task, content) : null;
        if (informationalFinal) return informationalFinal;
        throw error;
      }
      if (hasExecutableDecision(parsed)) return ledger.accept(parsed, payload, isAnthropic ? 'anthropic' : this.nativeToolsBroken ? 'json' : 'openai', identity);
      const embedded = extractEmbeddedDecision([content, reasoningText, parsed?.assistantText].filter(Boolean).join('\n'));
      if (embedded && hasExecutableDecision(embedded)) return ledger.accept(embedded, payload, isAnthropic ? 'anthropic' : this.nativeToolsBroken ? 'json' : 'openai', identity);
      const informationalFinal = allowPlainText ? recoverInformationalFinal(task, parsed?.assistantText) : null;
      if (informationalFinal) return informationalFinal;
      throw new Error('The provider returned commentary without a browser action or done result.');
    };
    // Media models: image generators reply with markdown/data images and no
    // agent JSON; TTS models reply with audio. Both are terminal media
    // answers — the loop completes and the transcript renders the payload.
    const isTtsModel = /(?:^|\/)(tts|text-to-speech)/i.test(this.model);
    const parseMediaAnswer = (content) => {
      const text = String(content || '');
      if (/!\[[^\]]*\]\((data:image\/|https?:\/\/)[^)]+\)|data:image\/(?:png|jpeg|webp);base64,/.test(text)) {
        return { done: { summary: text.slice(0, 4000), success: true, verified: false }, mediaAnswer: true };
      }
      return null;
    };
    const speakViaAudioApi = async (input) => {
      // The caller's configured TTS model defines the voice contract; send no
      // voice field unless one was explicitly configured on the connection.
      const voice = this.ttsVoice;
      const audioResponse = await this.fetchImpl(providerEndpoint(this.baseUrl, '/audio/speech'), {
        method: 'POST', headers, body: JSON.stringify({ model: this.model, input: String(input || '').slice(0, 4000), ...(voice ? { voice } : {}), response_format: 'mp3' }), signal
      });
      if (!audioResponse.ok) throw providerError(PROVIDER_LABELS[this.providerId], audioResponse, null);
      const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
      return { done: { summary: `[TTS] ${String(input || '').slice(0, 200)}`, success: true, verified: false }, mediaAudio: { mimeType: 'audio/mpeg', dataUrl: `data:audio/mpeg;base64,${audioBuffer.toString('base64')}` } };
    };
    if (isTtsModel) return speakViaAudioApi(String(currentContext?.task || ''));
    let payload = await request(harnessSystem, currentContext);
    try {
      const decision = parseDecision(payload);
      const mediaOnSuccess = parseMediaAnswer(contentFor(payload));
      if (mediaOnSuccess) return mediaOnSuccess;
      return decision;
    } catch (firstError) {
      // Image models reply with media and no agent JSON: parse fails, but the
      // content IS the answer. Return it as a terminal media answer instead of
      // entering repair loops.
      const mediaFallback = parseMediaAnswer(contentFor(payload));
      if (mediaFallback) return mediaFallback;
      // A token-limit cut-off is a budget condition, not a malformed
      // decision: a repair request with a smaller budget cannot fix it and
      // would just burn another round trip. Raise the budget and report the
      // cut-off so the agent steers the model to COMMIT the action it had
      // already settled on — not to resume reasoning or re-plan.
      if (decisionBudgetCutOff(payload, isAnthropic)) {
        // The cut-off usually lands AFTER the model already chose its action
        // and was still talking about it. Salvage that choice and act on it —
        // paying for a bigger budget and another round of reasoning to
        // re-derive an action that is already in the partial output is what
        // turns one decision into a two-minute monologue.
        const salvaged = extractEmbeddedDecision(contentFor(payload));
        if (salvaged && hasExecutableDecision(salvaged)) {
          try {
            const synthetic = isAnthropic
              ? { content: [{ type: 'text', text: JSON.stringify(salvaged) }] }
              : { choices: [{ message: { content: JSON.stringify(salvaged) } }] };
            return parseDecision(synthetic);
          } catch { /* fall through to the budget raise */ }
        }
        const previousBudget = this.outputBudget || (isAnthropic ? 4_096 : DECISION_MAX_TOKENS);
        this.outputBudget = Math.min(previousBudget * 4, 32_768);
        throw decisionOutputBudgetError(previousBudget, this.outputBudget);
      }
      const content = contentFor(payload);
      try {
        // Repair reuses the SAME harness system prompt — the schema-repair demand
// already reached the model as a sourced harness notice (loopPolicy).
        // The corrective turn keeps the harness system prompt and adds the
        // one-shot repair directive (a harness section, not provider prose).
        payload = await request(`${harnessSystem}\n\n${require('./prompt/sections.cjs').REPAIR_POLICY}`, actionOnlyRepairPrompt(context, content || firstError.message, tools), { repair: true });
        return parseDecision(payload, { allowPlainText: true });
      } catch (repairError) {
        const informationalFinal = recoverInformationalFinal(task, contentFor(payload));
        if (informationalFinal) return informationalFinal;
        throw repairError;
      }
    }
  }

  // Harness-invoked compaction (chat_compact tool, /compact command): the
  // provider owns its own summarizer transport, so compaction triggered
  // OUTSIDE a decision reuses the exact same channel.
  summarizeFor(system, input, signal, coordinator) {
    return summarizeConversation({ protocol: this.providerId === 'anthropic' || (this.providerId === 'xkiro' && isClaudeModel(this.model)) ? 'anthropic' : 'openai', model: this.model, endpoint: this.providerId === 'anthropic' || (this.providerId === 'xkiro' && isClaudeModel(this.model)) ? providerEndpoint(this.baseUrl, '/v1/messages') : providerEndpoint(this.baseUrl, '/chat/completions'), headers: this.providerId === 'anthropic' || (this.providerId === 'xkiro' && isClaudeModel(this.model)) ? { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': ANTHROPIC_VERSION } : { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` }, fetchImpl: this.fetchImpl, coordinator, signal, system, input });
  }
}

function createOpenAiCompatibleProvider(options = {}) {
  // Protocol compatibility, not task/model-quality routing. Keep the exact
  // selected ID; Astra tool calling is Responses-only in the official API
  // (resolution lives in descriptors.requiresResponsesProtocol).
  if (options.protocol === 'responses' || requiresResponsesProtocol(options.model)) {
    const { ResponsesProvider } = require('./responsesProvider.cjs');
    return new ResponsesProvider(options);
  }
  return new OpenAiCompatibleProvider(options);
}

module.exports = { OpenAiCompatibleProvider, createOpenAiCompatibleProvider, openAiToolSchemas, PROVIDER_LABELS };
