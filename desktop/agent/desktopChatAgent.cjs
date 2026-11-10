'use strict';

// DESKTOP CHAT AGENT — harness edition (DSH rewrite).
//
// This file is the RUN LOOP + PUBLIC CONTRACT of the Browser-use chat agent.
// All module-level functionality (tool catalogs, serializers, validators,
// redactors, observation and action execution) lives verbatim in
// ./agentInternals.cjs and is consumed through `I` below.
//
// Loop design follows the DeepSeek Harness pattern (see HARNESS_REWRITE.md):
//   • TURN  = one user task/steering boundary; STEP = one provider decision
//     plus its tool batch. The loop continues while steering input remains.
//   • The prompt is a registry of named ordered sections
//     (harness/promptRegistry.cjs + prompt/sections.cjs) — no monolithic
//     template, no provider-authored system prompts, volatile facts ride a
//     superseding runtime-context user message.
//   • ONE recovery model (harness/loopPolicy.cjs): transport failures retry
//     inside the open step on the providers/retry ladder; everything else
//     parks the run (awaiting_recovery + auto-resume). Recovery is
//     INDEFINITE — parking never terminates (owner directive preserved).
//   • Guards are advisory-first and sourced; the only hard denies are the
//     approval gate and the mechanical correctness guards (stale anchor,
//     duplicate action, constraint tamper). Done handling runs ONE bounded
//     completion review instead of the old gate maze.
//   • Cancellation is a typed abort; partial streams settle; pending tool
//     results are recorded even when a step fails.

const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

// Functionality library (verbatim from the original implementation).
const I = require('./agentInternals.cjs');

// Harness core (DSH pattern).
const { createPromptRegistry, SECTION_ORDERS } = require('./harness/promptRegistry.cjs');
const { registerPromptSections, modelingPlaybookFor, drawingPlaybookFor } = require('./prompt/sections.cjs');
const { createInbox } = require('./harness/inbox.cjs');
const { RepeatCallGuard } = require('./harness/guards.cjs');
const loopPolicy = require('./harness/loopPolicy.cjs');

const {
  createCoordinatorState, recordObservation, actionHash, canAttempt, recordAction, recordFacts,
  madeProgress, isMutation, bumpNavigationEpoch, staleAnchor, fillGate, constraintTamper,
  presentationTamper, completedWorkEntry, recordRejectedFill, unbackedActionClaims,
  valueWriteLiterals, firstWriteViolations, parseNumberedRequirements, settleRequirementLedger,
  requirementCovered, CONFLICT_PROTOCOL_ADVISORY
} = require('./desktopAgentCoordinator.cjs');
const { normalizeConversationPlan, applyPlanUpdate, applyProgressUpdate } = require('./progressState.cjs');
const { extractEmbeddedDecision, redactEmbeddedDecision, hasExecutableDecision } = require('./ollamaProvider.cjs');
const { COMPUTER_TOOLS, isComputerTool, isCodingTask, normalizeControlMode } = require('../computer/computerCatalog.cjs');
const { RETRY_DELAYS_MS, isTransportError, pauseForRetry } = require('./providers/retry.cjs');
const { ProviderTurnLedger, boundedResult, normalizeLedgerSnapshot, normalizeObjectiveLedger, sanitizeLedgerValue } = require('./providerTurnLedger.cjs');
const { parseTaskDeadlineMs, normalizeRunBudgetMs, deadlineAtForTurn } = require('./runBudget.cjs');
const { createInteractionMemory, observeInteraction, prepareAction } = require('./interactionMemory.cjs');
const { createRunNotebook, notebookIndex: notebookIndexText, appendUserLine: notebookAppendUserLine } = require('./runNotebook.cjs');
const { registerRepo, recordRepoMentions, renderRepoMapWire } = require('./workspacePin.cjs');
const { buildToolCatalog, fullSchemaFor, isDeferredTool } = require('./deferredToolCatalog.cjs');
const { parseHcuToolName } = require('./hcuSession.cjs');
const { compressNotebook } = require('./adaptiveTokenCompressor.cjs');
const { quoteRequest } = require('./requestQuote.cjs');
const { normalizeDomAttachments, replaceDomReferences } = require('../renderer/domAttachments.cjs');

// Re-exported module-level functionality (public contract — unchanged names).
const {
  isMultipartTask, isMultiAskTask, multiAskChecklist, ACTIONS,
  externalProviderBlock, MAX_BROWSER_WAIT_MS, EFFORT_TIERS, normalizeEffortSetting,
  normalizeEffortTier, nextEffortTier, applyEffortEscalation, defaultResearchAgent,
  inspectionValue, archiveToolResult, toolDefinitions,
  isTaskAddition, turnBoundaryNotice, steeringAdditionNotice, steeringReplacementNotice,
  normalizeToolCalls,
  isAnswerOnlyTask, isAnswerOnlyRequest, isAnalysisOnlyRequest, claimsCompletion, turnHasMutations,
  remainingRunMs,
  executeAction,
  normalizeAttachments,
  advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective, settleObjectiveLedgerOnTerminal, activeObjectiveEntry
} = I;

// Internals consumed by the class below.
const {
  recordVisualCapture, pushHarnessNotice, noticeIdFor,
  appendConversationMessage, normalizeConversationMessages,
  maybeGenerateConversationTitle, nextTimelineAt, ensureTerminalAssistantMessage,
  restoreConversationSnapshot, archiveActiveThinking, harvestThinkingBudget, harvestThinkingBudgetFromText,
  normalizeSettings, normalizeWorkspace, workspaceFromTask, defaultNotebookDir, syncNotebook, syncObjectiveLedger,
  recordConsulted, speculativePreRead, createThoughtAccumulator, isMessageInterrupt,
  serializeRun, serializeEventRun, checkpointSnapshot,
  observeRun, requiresApproval, approvalReason, withinStepTimeout, resolveSnapshotElement,
  shouldFinalizeConclusivePointerMove, terminalPointerMoveCompletion, isWaitPollCall,
  repeatedAppendAfterFill, repeatedOuterObservation, repeatedScreenshotFromCurrentObservation,
  mayContinueFocusedSubmit, assertComputerMode, redactArgs, redactOutput, redactRecoveryError,
  normalizeExpectation, screenshotPreviewValue, normalizeProgressInput, isStaleElementFailure,
  hasVerifiedExternalBlock, isCritiqueOnlyRun, requiresFileMutation, fileMutationSatisfied,
  codingCheckSatisfied, storeTabObservation, probeFormControlConstraints,
  fallbackConversationTitle, normalizeConversationTitle, DEFAULT_SETTINGS,
  safeAttachmentName, MAX_ATTACHMENT_TEXT_CHARS
} = I;

// Loop-level helpers re-derived from the same sources of truth (the old
// module-private lists): navigation epoch tools and the mutation classifier.
const NAVIGATION_TOOL_NAMES = new Set(['browser_navigate', 'browser_new_tab', 'browser_select_tab', 'browser_focus_tab', 'browser_go_back']);
function hcuReadOnly(name, input = {}) {
  if (!parseHcuToolName(name)) return false;
  if (name === 'mcp__hcu__AX') return ['apps', 'observe', 'find'].includes(String(input.mode || 'observe'));
  const actions = Array.isArray(input.actions) ? input.actions : [];
  return actions.length === 1 && ['screenshot', 'zoom'].includes(String(actions[0]?.type || ''));
}
function hcuMutation(name, input = {}) { return Boolean(parseHcuToolName(name)) && !hcuReadOnly(name, input); }
function actionMutates(name, input = {}) { return isMutation(name, input) || hcuMutation(name, input); }

// Decision-turn system prompt assembly (DSH: assemble per step).
// One registry render per decision; the instruction-file text (lorde.md /
// AGENTS.md / CLAUDE.md) is a section, not a free-floating block; a
// --system-file override replaces the WHOLE prompt via a complete:true
// section (the DSH `complete` mode).
function assembleSystemPrompt(run, observation) {
  const registry = createPromptRegistry();
  registerPromptSections(registry, {
    controlMode: run.settings.controlMode,
    effort: run.effortTier,
    effortMode: run.settings.effort,
    approvalMode: run.settings.approvalMode,
    modelingPlaybook: modelingPlaybookFor(observation?.desktop),
    drawingPlaybook: drawingPlaybookFor(observation?.desktop),
    instructionsFile: run.instructionsFileText || ''
  });
  if (run.systemFileText) {
    registry.section({
      name: 'deployment:system-file',
      order: SECTION_ORDERS.DEPLOYMENT_PERSONA_PREFIX,
      text: String(run.systemFileText),
      interpolate: false,
      complete: true
    });
  }
  return registry.render();
}

// Runtime-context snapshot (DSH: volatile facts as a superseding user message).
function runtimeContextText(run, observation) {
  const parts = [];
  if (run.tabId) parts.push(`Current tab: ${run.tabId}${observation?.navigation?.url ? ` — ${String(observation.navigation.url).slice(0, 200)}` : ''}.`);
  parts.push(`Observation domain: ${run.observationDomain}. Control mode: ${run.settings.controlMode}. Approval mode: ${run.settings.approvalMode}.`);
  parts.push(`Effort: ${run.effortTier} (${run.settings.effort}). Step: ${run.step}. Recovery attempts: ${Number(run.recovery?.attempts) || 0}.`);
  const remaining = remainingRunMs(run);
  if (remaining !== null) parts.push(`Run deadline: ${remaining > 0 ? `${Math.round(remaining / 1000)}s remaining` : 'expired'}.`);
  if (run.workspace?.root) parts.push(`Workspace root: ${run.workspace.root} (default scope, not a boundary).`);
  return parts.join('\n');
}

class DesktopChatAgent {
  constructor({ controller, getSelectedTabId, createTab, closeTab = null, selectTab, focusTab = null, writeReportFile = null, modelTaskApi = null, catalogApi = null, androidApi = null, getComputerTools = null, hcuApi = null, getControlMode = () => 'browser', emit, createProvider, onTerminal = null, onCheckpoint = null, titleApi = null, scheduleApi = null, spawnTask = null, skillsApi = null, messageApi = null, subagentApi = null, createResultStore = null, researchRunner = null, researchMetaSearch = null, knowledgeStore = null, layaVerifierFactory = null, jevVerifierFactory = null, notebookDir = null }) {
    this.controller = controller;
    this.getSelectedTabId = getSelectedTabId;
    this.createTab = createTab;
    this.closeTab = closeTab;
    this.selectTab = selectTab;
    this.focusTab = focusTab;
    this.writeReportFile = writeReportFile;
    this.modelTaskApi = modelTaskApi;
    this.catalogApi = catalogApi;
    this.androidApi = androidApi;
    this.scheduleApi = scheduleApi;
    this.spawnTask = spawnTask;
    this.skillsApi = skillsApi;
    this.messageApi = messageApi || null;
    this.subagentApi = subagentApi || null;
    this.createResultStore = createResultStore;
    this.getComputerTools = getComputerTools;
    this.hcuApi = hcuApi || null;
    this.getControlMode = getControlMode;
    this.researchRunner = researchRunner;
    this.researchMetaSearch = researchMetaSearch;
    this.knowledgeStore = knowledgeStore;
    this.layaVerifierFactory = layaVerifierFactory || ((opts) => require('./layaDecision.cjs').createLayaVerifier(opts));
    this.jevVerifierFactory = jevVerifierFactory || ((opts) => require('./jevProvider.cjs').createJevVerifier(opts));
    this.transportRetryDelays = RETRY_DELAYS_MS;
    this.emit = emit;
    this.createProvider = createProvider;
    this.onTerminal = onTerminal;
    this.onCheckpoint = onCheckpoint;
    this.titleApi = titleApi;
    this.notebookDir = notebookDir;
    this.run = null;
  }

  state() {
    return serializeRun(this.run);
  }

  settleActiveThought(run, reason = 'recovery') {
    if (!run?.activeThoughtId) return false;
    const thoughtId = run.activeThoughtId;
    const startedAt = Number(run.activeThoughtStartedAt || Date.now());
    archiveActiveThinking(run);
    this.publish('assistant.thinking.completed', run, {
      thoughtId,
      reason: String(reason || 'recovery'),
      elapsedMs: Math.max(0, Date.now() - startedAt)
    });
    run.activeThoughtId = null;
    run.activeThoughtStartedAt = null;
    run.activeThoughtAccumulator = null;
    run.thoughtBaseChars = 0;
    run.intermediateMessagePublished = false;
    return true;
  }

  async start(request) {
    // SLASH-FIRST: /notebook is a UI command, not a task.
    const idleSlash = !this.run && /^\/notebook(?:\s|$)/i.test(String(request?.task || '').trim());
    if (idleSlash) {
      const rest = String(request.task).trim().slice('/notebook'.length).trim();
      const filePath = path.join(this.notebookDir || defaultNotebookDir(), 'notebook.md');
      const notebook = createRunNotebook({ filePath, task: '' });
      notebook.ensureSeeded();
      const idleRun = { id: null, task: null, status: 'idle', title: null, tabId: null, coordinator: null };
      if (rest) {
        const result = notebookAppendUserLine(filePath, rest);
        if (!result.ok) throw new Error('Nothing to append.');
        const detail = `Noted in the notebook (NOTES): ${rest.slice(0, 120)}`;
        this.publish('assistant.message', idleRun, { text: detail });
        return { status: 'notebook-appended', path: filePath };
      }
      this.publish('notebook.open', idleRun, { path: filePath });
      this.publish('assistant.message', idleRun, { text: `Notebook: ${filePath} — it survives compaction, restart, and continuation. User sections (USER RULES, CREDENTIALS & KEYS, COMMANDS, NOTES) are yours to edit in the popup.` });
      return { status: 'notebook-open', path: filePath };
    }
    if (this.run && String(request?.task || '').trim().startsWith('/')) {
      await this.handleSlashCommand(this.run, String(request.task).trim());
      return serializeRun(this.run);
    }
    if (this.run && ['running', 'awaiting_approval', 'awaiting_input', 'paused'].includes(this.run.status)) {
      if (request?.resumeRecovery && this.recoveryResumePromise) return this.recoveryResumePromise;
      throw new Error('An AI chat task is already active for this Browser-use window.');
    }
    const rawTask = String(request?.task || '').trim();
    if (!rawTask) throw new Error('Task must contain at least 1 character.');
    const domAttachments = normalizeDomAttachments(request?.domAttachments);
    const task = replaceDomReferences(rawTask, domAttachments);
    const rawAttachments = Array.isArray(request?.attachments) ? request.attachments : [];
    const normalizedAttachments = await normalizeAttachments(rawAttachments);
    const legacyDomByName = new Map(domAttachments.map((dom, index) => [String(index + 1), dom]));
    const attachments = normalizedAttachments.map((attachment, index) => {
      const rawName = String(rawAttachments[index]?.name || '').toLowerCase();
      const legacyMatch = rawName.match(/^dom[\s_-]*(\d+)$/i);
      const dom = legacyMatch ? legacyDomByName.get(legacyMatch[1]) : null;
      if (!dom) return attachment;
      return { ...attachment, name: dom.name, content: replaceDomReferences(attachment.content, domAttachments) };
    });
    const requestedContinuation = request?.continuation === true;
    let previous = null;
    if (requestedContinuation && request?.conversation) previous = restoreConversationSnapshot(request.conversation);
    if (requestedContinuation && !previous && this.run && ['completed', 'failed', 'cancelled', 'awaiting_recovery'].includes(this.run.status)) {
      const requestedId = String(request?.conversationId || '').trim();
      if (!requestedId || requestedId === this.run.id) previous = this.run;
    }
    if (requestedContinuation && !previous) throw new Error('The conversation could not be restored. Open it from history and retry.');
    const continuation = Boolean(previous);
    if (previous?.escalationTimer) { clearInterval(previous.escalationTimer); previous.escalationTimer = null; }
    const turnContinuation = continuation && previous && task === String(previous.task || '').trim();
    const additionTurn = continuation && !turnContinuation && isTaskAddition(task);
    const turnStartedAt = turnContinuation
      ? Number(previous.turnStartedAt || previous.createdAt || Date.now())
      : (Number.isFinite(Number(request?.queuedAt)) && Number(request.queuedAt) > 0 ? Number(request.queuedAt) : Date.now());
    const deadlineAt = deadlineAtForTurn({
      task,
      explicitMs: request?.settings?.maxRunMs,
      turnStartedAt,
      previousDeadlineAt: previous?.deadlineAt,
      sameTurn: turnContinuation
    });
    const providerConfig = request?.provider || previous?.provider || { id: 'ollama', model: '' };
    const startupRunId = continuation ? previous.id : crypto.randomUUID();
    this.run = { id: startupRunId, task, status: 'starting', provider: providerConfig, history: [], plan: [], goals: [], result: null };
    const provider = this.createProvider(providerConfig);
    const providerInstance = provider;
    const remoteExecution = provider?.executionTarget === 'remote';
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(previous?.settings || {}), ...(request?.settings || {}) });
    if (Number.isFinite(Number(provider?.absoluteTimeoutMs)) && Number(provider.absoluteTimeoutMs) > 0) settings.stepAbsoluteTimeoutMs = Number(provider.absoluteTimeoutMs);
    let resolvedWorkspace = normalizeWorkspace(request?.workspace || previous?.workspace || workspaceFromTask(task));
    if (!resolvedWorkspace?.root) {
      const directoryAttachment = Array.isArray(attachments)
        ? attachments.find((item) => item?.kind === 'path' && item?.isDirectory)
        : null;
      if (directoryAttachment) {
        resolvedWorkspace = normalizeWorkspace({ root: directoryAttachment.path, target: directoryAttachment.path });
      }
    }
    let workspacePromoted = false;
    if (resolvedWorkspace?.root && settings.controlMode !== 'agi' && !remoteExecution) {
      settings.controlMode = 'agi';
      workspacePromoted = true;
    }
    if (settings.controlMode === 'agi' && remoteExecution) throw new Error('This remote browser provider cannot execute local computer tools. Select a locally executed provider connection.');
    let tabId = request?.tabId || this.getSelectedTabId();
    const ownedTabIds = new Set(Array.isArray(request?.ownedTabIds) ? request.ownedTabIds.map(String) : []);
    for (const ownedTabId of previous?.ownedTabIds || []) ownedTabIds.add(String(ownedTabId));
    if (!tabId && !remoteExecution) {
      if (typeof this.createTab !== 'function') throw new Error('No active Browser-use tab is available and this Desktop build cannot create one.');
      const created = await this.createTab('about:blank');
      tabId = created?.id;
      if (tabId) ownedTabIds.add(String(tabId));
      if (!tabId) throw new Error('Browser-use could not create a task tab. Open a tab and retry.');
    }
    const initialDomain = previous?.observationDomain || 'browser';
    const computerToolsHeadless = (() => {
      if (settings.controlMode !== 'agi' || typeof this.getComputerTools !== 'function') return false;
      try { return this.getComputerTools()?.headlessUnavailable === true; } catch { return false; }
    })();
    const run = {
      id: startupRunId,
      tabId,
      ownedTabIds: [...ownedTabIds],
      createTab: this.createTab,
      closeTab: this.closeTab,
      selectTab: this.selectTab,
      focusTab: this.focusTab,
      writeReportFile: this.writeReportFile,
      modelTaskApi: this.modelTaskApi,
      catalogApi: this.catalogApi,
      androidApi: this.androidApi,
      scheduleApi: this.scheduleApi,
      spawnTask: this.spawnTask,
      messageApi: this.messageApi,
      subagentApi: this.subagentApi,
      skillsApi: this.skillsApi,
      getComputerTools: this.getComputerTools,
      hcuApi: this.hcuApi,
      hcuTools: [],
      getControlMode: request.controlModeResolver || this.getControlMode,
      computerOwner: null,
      remoteExecution,
      observationDomain: initialDomain,
      computerNeedsImage: initialDomain === 'computer' && (continuation || settings.vision === 'always'),
      browserNeedsImage: continuation ? Boolean(previous?.browserNeedsImage) : false,
      task,
      attachments,
      workspace: resolvedWorkspace,
      promotedTools: new Set(continuation ? [...(previous?.promotedTools || [])] : []),
      title: continuation ? previous.title : fallbackConversationTitle(task),
      provider: providerConfig,
      providerInstance,
      settings,
      status: 'running',
      history: continuation ? [...(previous.history || [])].slice(-80) : [],
      nativeSurfaceSeen: continuation
        ? ((Array.isArray(previous?.nativeSurfaceSeen) || previous?.nativeSurfaceSeen instanceof Set)
          ? new Set([...previous.nativeSurfaceSeen].map((id) => String(id)).filter(Boolean))
          : undefined)
        : undefined,
      step: 0,
      decisionCount: 0,
      failures: 0,
      pendingApproval: null,
      result: null,
      abortController: new AbortController(),
      messageWakeController: null,
      activeStepController: null,
      messageArrivedWhileStep: false,
      recoveryResumePromise: null,
      agentIdentity: String(request?.agentIdentity || 'agent1'),
      approval: null,
      createdAt: continuation ? previous.createdAt : Date.now(),
      turnStartedAt,
      // External deadline (absolute epoch ms) or null. The ONLY source that
      // parks a run without auto-resume — every other recovery path parks
      // WITH auto-resume and is indefinite (owner directive preserved).
      deadlineAt,
      deadlineParked: false,
      deadlineFinishNoticeArmed: false,
      lastRealActivityAt: Date.now(),
      eagerResults: new Map(),
      eagerInFlight: false,
      stallRecoveries: 0,
      completedAt: null,
      escalation: null,
      escalationTimer: null,
      telemetryDetailed: continuation ? previous.telemetryDetailed !== false : !I.isCheapInformationalTask(task),
      lastObservedUrl: continuation ? previous.lastObservedUrl : null,
      plan: (continuation && (turnContinuation || !previous?.task || additionTurn)) ? normalizeConversationPlan(previous.plan) : [],
      goals: (continuation && (turnContinuation || !previous?.task || additionTurn)) ? normalizeConversationPlan(previous.goals) : [],
      newTurn: continuation && !turnContinuation,
      closedTurnHadWork: Boolean(
        (Array.isArray(previous?.plan) && previous.plan.length)
        || (Array.isArray(previous?.completedWork) && previous.completedWork.length)
        || (Array.isArray(previous?.coordinator?.completedWork) && previous.coordinator.completedWork.length)),
      attemptId: crypto.randomUUID(),
      attemptStartedAt: Date.now(),
      attemptStartedClock: performance.now(),
      attemptSequence: (Number(previous?.attemptSequence) || 0) + 1,
      loopState: { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 },
      recovery: { attempts: 0, lastError: '', source: '', action: null },
      recoveryEpisodes: Number(previous?.recoveryEpisodes || 0),
      recoveryContinuation: null,
      // DSH advisory guard state: canonical repeat-call detection (replaces
      // the old actionless-stall / streaming-stall / flow-control scoring).
      repeatGuard: new RepeatCallGuard(),
      schemaRepairArmed: false,
      effortTier: settings.effort === 'auto'
        ? (I.isCheapInformationalTask(task) || I.isRapidTask(task) ? 'minimal' : 'standard')
        : settings.effort,
      effortTierRecoveries: 0,
      effortNeedSignals: 0,
      requiredEvidenceRevision: 0,
      decisionObservationRevision: 0,
      latestObservation: null,
      observationsByTab: new Map(),
      diagnosticCursor: { console: [], network: [] },
      visualEvidence: null,
      visualLedger: [],
      intermediateMessagePublished: false,
      usage: continuation ? (previous.usage || previous.turnLedger?.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 }) : { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      thoughtCount: Number(previous?.thoughtCount) || 0,
      coordinator: createCoordinatorState({ completedWork: continuation && (turnContinuation || !previous?.task) ? (previous.completedWork || previous.coordinator?.completedWork) : [] }),
      workingMemory: I.normalizeWorkingMemory(continuation ? previous.workingMemory : null),
      completionCandidate: null,
      completionReviewForced: false,
      // DSH completion review: ONE bounded review per turn (replaces the
      // twelve-gate maze). Counters kept for observability.
      completionReviewBounces: 0,
      incompleteWorkBounces: 0,
      requirementLedger: parseNumberedRequirements(task).map((req) => ({ ...req, status: 'open', evidence: null })),
      lastCheckpointStep: -1,
      eventRevision: continuation ? Number(previous.eventRevision || 0) : 0,
      timelineClock: continuation ? Number(previous.timelineClock || 0) : 0,
      messages: continuation ? normalizeConversationMessages(previous.messages) : [],
      interactionMemory: createInteractionMemory(continuation ? previous.interactionMemory : null),
      thinkingArchive: continuation ? I.normalizeThinkingArchive(previous.thinkingArchive) : [],
      // Prompt-layer state (DSH): instruction-file text + optional complete
      // system-prompt override (--system-file). Volatile facts never enter
      // these; they ride the runtime-context snapshot per decision.
      instructionsFileText: String(request?.instructionsFile || '').trim(),
      systemFileText: typeof request?.systemFile === 'string' && request.systemFile.trim() ? String(request.systemFile) : null,
      transportRetryAttempts: 0
    };
    run.publishEvent = (type, payload = {}) => this.publish(type, run, payload);
    run.resultStore = this.createResultStore?.(run.id) || null;
    if (Array.isArray(attachments) && attachments.some((item) => item?.kind === 'image')) recordVisualCapture(run, 'attachment');
    run.turnLedger = new ProviderTurnLedger({ snapshot: continuation ? (previous.turnLedger?.snapshot() || previous.providerLedger) : null,
      contextTokens: settings.contextWindowTokens || 131_072, archive: run.resultStore ? value => run.resultStore.write(value) : null });
    if (!turnContinuation) run.turnLedger.beginTurn();
    run.repoMap = Array.isArray(previous?.repoMap) ? [...previous.repoMap] : [];
    run.notebook = createRunNotebook({
      filePath: String(previous?.notebookPath || '') || path.join(this.notebookDir || defaultNotebookDir(), `${run.id}.md`),
      task,
      workspace: resolvedWorkspace,
      repoMap: run.repoMap
    });
    const notebookSeed = run.notebook.ensureSeeded();
    run.notebookPath = run.notebook.filePath;
    if (!continuation) {
      registerRepo(run.repoMap, resolvedWorkspace?.root, { pinned: Boolean(resolvedWorkspace?.root), source: 'task' });
    } else if (!run.repoMap.some(item => item.pinned)) {
      run.repoMap = run.notebook.repoMapFromDisk();
      registerRepo(run.repoMap, resolvedWorkspace?.root, { pinned: Boolean(resolvedWorkspace?.root), source: 'previous' });
    }
    recordRepoMentions(run.repoMap, task, fs);
    if (notebookSeed.seeded || run.notebook.syncRepoSection(run.repoMap).changed) syncNotebook(run);
    run.pendingUserMessages = continuation ? (previous.pendingUserMessages || []) : [];
    run.computerOwner = request.computerOwner || `chat:${run.id}`;
    run.coordinator.metrics.attemptStartedAt = run.attemptStartedAt;
    // A thinking ceiling the USER states in the task ("thinking must use a
    // maximum of 10s") is hard and run-wide (kept functionality).
    const statedBudget = harvestThinkingBudgetFromText(task);
    if (Number.isFinite(statedBudget) && statedBudget >= 0) {
      run.thinkingBudgetCapMs = Math.min(statedBudget, 15 * 60_000);
      if (statedBudget === 0 && run.settings?.effort === 'auto') {
        const affordable = applyEffortEscalation({ mode: 'auto', tier: run.effortTier }, { thinkingBudgetMs: 0 }).tier;
        if (affordable && EFFORT_TIERS.indexOf(affordable) < EFFORT_TIERS.indexOf(run.effortTier)) run.effortTier = affordable;
      }
    } else if (continuation && Number.isFinite(Number(previous?.thinkingBudgetCapMs))) {
      run.thinkingBudgetCapMs = Number(previous.thinkingBudgetCapMs);
    }
    if (request?.resumeRecovery !== true && (!continuation || run.newTurn)) appendConversationMessage(run, 'user', task, { domAttachments });
    void maybeGenerateConversationTitle(this, run);
    try {
      const matched = this.skillsApi?.search?.({ task, limit: 2 }) || [];
      if (matched.length) {
        run.usedSkills = [];
        const lines = matched.map(entry => {
          const digest = this.skillsApi.digest(entry.skill);
          return `- ${digest.name} (skillId: ${digest.id}) — when: ${digest.when || 'as demonstrated'} — steps: ${digest.steps.join(' -> ')}`;
        });
        appendConversationMessage(run, 'user', `Learned skills that may cover this task (call skill_run with a skillId to load full steps before improvising):\n${lines.join('\n')}`, { source: 'runtime' });
      }
    } catch { /* a missing skill store must never block a run */ }
    run.research = { promise: null, result: null, delivered: true, pending: false };
    run.researchDefaults = { providerConfig, remoteExecution, task };
    run.pendingAgentMessages = Array.isArray(request?.initialAgentMessages)
      ? request.initialAgentMessages.slice(-12).map(message => ({ ...message, text: String(message?.text || '').slice(0, 4000) }))
      : [];
    run.researchHost = this;
    run.layaVerifier = null;
    const layaBrain = ['off', 'laya', 'jev'].includes(settings.layaBrain)
      ? settings.layaBrain
      : (settings.layaEnabled ? 'laya' : 'off');
    if (layaBrain === 'laya') {
      try {
        run.layaVerifier = this.layaVerifierFactory({ endpoint: settings.layaEndpoint });
        this.publish('laya.enabled', run, { mode: settings.layaEndpoint ? 'sidecar' : 'bundled', endpoint: settings.layaEndpoint || null, brain: 'laya' });
      } catch { run.layaVerifier = null; }
    } else if (layaBrain === 'jev') {
      try {
        run.layaVerifier = this.jevVerifierFactory({ baseUrl: settings.jevBaseUrl, modelId: settings.jevModelId, fallback: this.layaVerifierFactory({}) });
        this.publish('laya.enabled', run, { mode: 'jev', endpoint: settings.jevBaseUrl, brain: 'jev', model: settings.jevModelId });
      } catch { run.layaVerifier = null; }
    }
    if (run.newTurn) {
      if (additionTurn) {
        const pinned = String(run.turnLedger?.originalTask || previous?.task || '').trim();
        run.turnLedger?.setOriginalTask?.(pinned && !pinned.includes(String(task).trim().slice(0, 80))
          ? `${pinned}\nADDITION: ${task}`.slice(0, 2000)
          : task);
      } else {
        run.turnLedger?.setOriginalTask?.(task);
      }
    }
    run.objectiveLedger = advanceObjectiveLedger(
      continuation ? previous.objectiveLedger : null,
      task,
      { boundary: run.newTurn && !additionTurn, previousResult: continuation ? previous.result : null, at: Date.now() });
    syncObjectiveLedger(run);
    syncNotebook(run);
    if (run.newTurn) {
      appendConversationMessage(run, 'user', turnBoundaryNotice(task, { addition: additionTurn }), { source: 'runtime' });
    }
    if (workspacePromoted) {
      appendConversationMessage(run, 'user', `This run enabled the native file tools (computer_*) because the task declares a workspace at ${resolvedWorkspace.root}. That workspace is the DEFAULT search/index scope, not a boundary: file, terminal, and git access anywhere on disk is allowed.`, { source: 'runtime' });
    }
    if (isMultipartTask(task) && !run.plan.length) {
      pushHarnessNotice(run, 'FLOW: this is a multi-part task. Emit update_plan with one item per requested outcome and a short verification criterion; thinking that lists steps is not a harness-owned plan. Then inspect the relevant context and act on the first item.');
    }
    run.inbox = createInbox();
    this.run = run;
    if (run.settings.controlMode === 'agi' && this.hcuApi?.ensure) {
      try { run.hcuTools = await this.hcuApi.ensure(); } catch { run.hcuTools = []; }
    }
    this.publish('run.started', run, { task, continuation, workspacePromoted, hcu: run.hcuTools.length ? 'ready' : 'off' });

    // ── THE LOOP (DSH turn/step shape) ───────────────────────────────────────
    recoveryLoop: while (run.status === 'running') {
      try {
        let latestObservation = null;
        while (run.status === 'running') {
          // An accepted done is terminal — never re-decide after it.
          if (run.result) {
            if (run.status === 'running') run.status = run.result.success === false ? 'failed' : 'completed';
            break recoveryLoop;
          }
          this.drainEagerResults(run);
          // External deadline: the only non-resuming park.
          if (remainingRunMs(run) === 0 && !run.deadlineParked) {
            this.parkOnDeadline(run);
            break recoveryLoop;
          }
          // LORDE_VERIFY_CAP_V1 (kept): near-deadline one-shot finish notice.
          if (remainingRunMs(run) !== null && remainingRunMs(run) < 30_000 && !run.deadlineFinishNoticeArmed) {
            run.deadlineFinishNoticeArmed = true;
            pushHarnessNotice(run, loopPolicy.DEADLINE_NOTICE.text);
          }
          this.deliverSteering(run);
          this.deliverResearch(run);
          // PATCH CADENCE (kept): one-shot whole-stroke edit advisory.
          if (run.patchCadence && !run.patchCadenceNotified) {
            for (const [file, entry] of run.patchCadence) {
              if (entry.patches < 3 || entry.small < 2) continue;
              run.patchCadenceNotified = true;
              pushHarnessNotice(run, `PATCH CADENCE: you have patched ${file} ${entry.patches} times, and ${entry.small} of those changed only a line or two. Apply the remaining change to that file in ONE patch that carries the whole edit, instead of a series of one-line patches. One patch for the change, then verify the result.`);
              break;
            }
          }
          if (!latestObservation && !remoteExecution) {
            const observedAt = Date.now();
            const observeBefore = Number(run.coordinator.metrics.phaseMs.observe) || 0;
            try {
              latestObservation = await withinStepTimeout(run, 'observing the page', () => observeRun(this.controller, run));
              run.observationFailures = 0;
              run.coordinator.metrics.phaseMs.observe += Date.now() - observedAt;
              run.lastObserveMs = Math.round((Number(run.coordinator.metrics.phaseMs.observe) || 0) - observeBefore);
              run.lastObservationChanged = recordObservation(run.coordinator, latestObservation).changed;
              run.interactionDelta = observeInteraction(run.interactionMemory, latestObservation);
            } catch (error) {
              if (run.status !== 'running' || run.abortController.signal.aborted) throw error;
              if (isMessageInterrupt(error)) { latestObservation = null; continue; }
              // Observation failure: classified recovery; the streak cap
              // PARKS holding state (never terminates — owner directive).
              run.observationFailures = (run.observationFailures || 0) + 1;
              if (run.observationFailures >= 40) {
                this.parkRun(run, `Observation failed ${run.observationFailures} times in a row (${String(error?.message || error).slice(0, 160)}). The run is parked holding its state and its objective; fix the observed surface, then resume.`);
                latestObservation = null;
                break;
              }
              pushHarnessNotice(run, loopPolicy.OBSERVATION_ADVISORY.text);
              this.scheduleRecovery(run, { source: 'observation_timeout', error, recordSyntheticHistory: true });
              latestObservation = null;
              continue;
            }
          }
          if (latestObservation?.navigation?.url) run.lastObservedUrl = latestObservation.navigation.url;
          if (latestObservation) {
            if (latestObservation.screenshot?.data) {
              run.visualEvidence = latestObservation.screenshot;
              if (!Array.isArray(run.visualLedger)
                || !run.visualLedger.some((item) => item.source === 'auto' && item.revision === (Number(run.coordinator.observationRevision) || 0))) {
                recordVisualCapture(run, 'auto');
              }
            } else if (run.visualEvidence?.data) latestObservation.screenshot = run.visualEvidence;
            run.latestObservation = latestObservation;
            storeTabObservation(run, run.tabId, latestObservation);
            const digestParts = latestObservation.desktop ? [] : [
              latestObservation.navigation?.url || '',
              latestObservation.dom?.title || '',
              ...(Array.isArray(latestObservation.dom?.elements) ? latestObservation.dom.elements.slice(0, 12) : [])
                .map((element) => String(element?.name || element?.text || '').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
            ].filter(Boolean);
            if (digestParts.length) {
              recordFacts(run.coordinator, [`Observed: ${digestParts.join(' | ')}`.slice(0, 500)]);
            }
          }
          run.decisionObservationRevision = latestObservation ? run.coordinator.observationRevision : 0;
          try { await this.deliverNativeSurfaceNotice(run); } catch { /* advisory detection must never break the decision loop */ }
          this.deliverKnowledge(run, latestObservation);
          this.considerProgramResearch(run, latestObservation);
          this.verifyWithLaya(run, latestObservation);
          // Live thought card (kept: UI functionality).
          const decisionThinkingStart = Date.now();
          if (!run.activeThoughtId) {
            run.activeThoughtId = `${run.id}:decision:${run.step + 1}`;
            run.activeThoughtStartedAt = Date.now();
            run.thoughtCount = (run.thoughtCount || 0) + 1;
            run.activeThoughtAccumulator = createThoughtAccumulator((reasoning) => {
              this.publish('assistant.thought', run, { thoughtId: run.activeThoughtId, text: redactEmbeddedDecision(reasoning), elapsedMs: Math.max(0, Date.now() - decisionThinkingStart) });
            });
          }
          const thinkingStartedAt = decisionThinkingStart;
          const thoughtId = run.activeThoughtId;
          if (run.telemetryDetailed && run.thoughtCount % 10 === 0) this.publish('assistant.thought.stamp', run, { thoughtCount: run.thoughtCount, elapsedMs: Math.max(0, Date.now() - decisionThinkingStart), at: Date.now() });
          const accumulateThought = run.activeThoughtAccumulator;
          this.publish('assistant.thinking', run, { thoughtId, elapsedMs: 0 });
          const thinkingTimer = setInterval(() => {
            if (run.status === 'running') this.publish('assistant.thinking', run, { thoughtId, elapsedMs: Math.max(0, Date.now() - thinkingStartedAt) });
          }, 750);
          let response;
          let thinkingMs = 0;
          const decisionStartedAt = performance.now();
          run.coordinator.metrics.providerCalls += 1;
          const pendingHarnessNotices = run.harnessNotices?.length ? [...run.harnessNotices] : null;
          syncNotebook(run);
          try {
            response = await withinStepTimeout(run, 'waiting for the model', async (stepSignal, streamProgress) => {
              let firstStreamAt = 0;
              const wrapped = () => { if (!firstStreamAt) firstStreamAt = performance.now(); return streamProgress(); };
              run.thoughtBaseChars = String(run.activeThoughtAccumulator?.() || '').length;
              // THE DECISION CALL (DSH): one attempt; transport retry is the
              // loop's request-error policy; the reasoning budget rides as
              // provider config, not a parallel watchdog.
              const completed = await Promise.resolve((async () => {
                const budgetMs = Number(run.thinkingBudgetMs) || (I.isRapidTask(run.task) ? 3_000 : 30_000);
                const capBudget = Number(run.thinkingBudgetCapMs);
                const effectiveBudget = Number.isFinite(capBudget) && capBudget >= 0 ? Math.min(budgetMs, capBudget) : budgetMs;
                run.thinkingBudgetMs = effectiveBudget;
                return provider.complete({
                  task: run.task,
                  agentIdentity: run.agentIdentity,
                  // DSH: the harness owns the system prompt (identity,
                  // persona, policies, tool guidance). Providers render it
                  // verbatim as the system message and add nothing of their own.
                  systemPrompt: assembleSystemPrompt(run, latestObservation),
                  runtimeContext: runtimeContextText(run, latestObservation),
                  attachments: run.attachments,
                  workspace: run.workspace,
                  observation: latestObservation,
                  ...(run.layaVerification ? { layaVerification: run.layaVerification } : {}),
                  ...(run.researchHint ? { researchHint: run.researchHint } : {}),
                  ...(Array.isArray(run.pendingAgentMessages) && run.pendingAgentMessages.length
                    ? { agentMessages: run.pendingAgentMessages.splice(0, run.pendingAgentMessages.length) }
                    : {}),
                  ...(pendingHarnessNotices ? { harnessNotices: pendingHarnessNotices } : {}),
                  observationUnchanged: run.lastObservationChanged === false,
                  history: [...run.history],
                  messages: run.messages,
                  coordinator: run.coordinator,
                  plan: run.plan,
                  goals: run.goals,
                  recovery: run.recovery,
                  tools: buildToolCatalog(run.activeToolCatalog = toolDefinitions(run.task, run.settings.controlMode, {
                    usedSkills: run.usedSkills,
                    observationDomain: run.observationDomain,
                    agentMessagingAvailable: Boolean(run.messageApi?.hasLiveRecipient?.(run.id)),
                    workspace: Boolean(run.workspace?.root),
                    webSearchAvailable: String(run.provider?.id || '') === 'xkiro',
                    patchFallbackLevel: Number(run.patchFallbackLevel) || 0,
                    hcuTools: run.hcuTools || [],
                    ...(run.computerToolsHeadless ? { headlessComputer: true } : {})
                  }), { promoted: run.promotedTools || new Set() }),
                  effort: run.effortTier,
                  effortMode: run.settings.effort,
                  thinkingBudgetMs: effectiveBudget,
                  signal: stepSignal,
                  workingMemory: run.workingMemory,
                  interactionMemory: run.interactionMemory,
                  turnLedger: run.turnLedger,
                  onThought: accumulateThought,
                  onStream: () => { wrapped(); },
                  onProgress: () => { wrapped(); },
                  onActionReady: (call) => this.handleEagerAction(run, call)
                });
              })());
              const settledAt = performance.now();
              run.lastDecisionBreakdown = {
                connectMs: firstStreamAt ? Math.round(firstStreamAt - decisionStartedAt) : null,
                streamMs: firstStreamAt ? Math.round(settledAt - firstStreamAt) : null,
                totalMs: Math.round(settledAt - decisionStartedAt)
              };
              return completed;
            });
            run.decisionCount += 1;
            if (run.providerInstance?.visionDegraded && !run.visionAdvisoryPublished) {
              run.visionAdvisoryPublished = true;
              this.publish('assistant.message', run, {
                text: `⚠️ ${run.provider?.model || 'The active model'} does not support image input. Continuing with text evidence only. Switch to a vision-capable model for full desktop awareness.`
              });
            }
            if (pendingHarnessNotices) {
              run.harnessNotices = (Array.isArray(run.harnessNotices) ? run.harnessNotices : [])
                .filter(line => !pendingHarnessNotices.includes(line));
              this.publish('harness.notice.delivered', run, {
                notices: pendingHarnessNotices.map((line) => ({ id: noticeIdFor(run, line), text: line }))
              });
            }
            this.publish('decision.timing', run, {
              observeMs: Number(run.lastObserveMs) || 0,
              ...(run.lastDecisionBreakdown || {})
            });
            // Effort as model-selection config (DSH): the decision may steer
            // one rung with a reason; the budget is honored exactly.
            const effortOutcome = applyEffortEscalation(
              { mode: run.settings.effort, tier: run.effortTier, needSignals: run.effortNeedSignals },
              { requested: response?.effortNeeded, reason: response?.effortReason, thinkingBudgetMs: response?.thinkingBudgetMs ?? response?.done?.thinkingBudgetMs }
            );
            if (effortOutcome.escalated) {
              run.effortTier = effortOutcome.tier;
              run.effortTierRecoveries = 0;
            }
            run.reasoningBudgetCuts = 0;
            const namedBudget = harvestThinkingBudget(response);
            if (Number.isFinite(namedBudget) && namedBudget >= 0) {
              const capMs = Number(run.thinkingBudgetCapMs);
              run.thinkingBudgetMs = Math.min(namedBudget, 15 * 60_000,
                Number.isFinite(capMs) && capMs >= 0 ? capMs : 15 * 60_000);
            }
          } catch (error) {
            if (run.status !== 'running' || run.abortController.signal.aborted) throw error;
            if (String(error?.message || '') === 'agent-message-arrived') {
              latestObservation = null;
              continue;
            }
            // REASONING BUDGET (kept): salvage the decision the cut interrupted.
            if (error?.code === 'REASONING_BUDGET_EXPIRED') {
              const reasoned = String(run.activeThoughtAccumulator?.() || '');
              const partial = reasoned ? extractEmbeddedDecision(reasoned) : null;
              if (partial && hasExecutableDecision(partial)) {
                response = partial;
                this.publish('agent.reasoningBudget', run, { budgetMs: run.thinkingBudgetMs, salvaged: true });
              } else {
                run.reasoningBudgetCuts = (run.reasoningBudgetCuts || 0) + 1;
                this.publish('agent.reasoningBudget', run, { budgetMs: run.thinkingBudgetMs, salvaged: false, cuts: run.reasoningBudgetCuts });
                run.budgetCloseout = true;
                if (run.settings?.effort === 'auto') {
                  const cheaper = applyEffortEscalation({ mode: 'auto', tier: run.effortTier }, { thinkingBudgetMs: run.thinkingBudgetMs }).tier;
                  if (cheaper && EFFORT_TIERS.indexOf(cheaper) < EFFORT_TIERS.indexOf(run.effortTier)) run.effortTier = cheaper;
                }
                this.scheduleRecovery(run, {
                  source: 'reasoning_budget',
                  error: 'Reasoning ceiling reached. Use the latest observation and recorded plan; emit only the single next action or browser_done now. Do not restate the task, plan, or prior reasoning.',
                  recordSyntheticHistory: true
                });
                latestObservation = null;
                continue;
              }
            }
            if (!isTransportError(error)) run.decisionCount += 1;
            const providerBlock = externalProviderBlock(error);
            if (providerBlock) {
              this.record(run, { name: 'agent_provider_blocked', input: {} }, { ok: false, recoverable: false, error: providerBlock });
              run.status = 'failed';
              run.result = { summary: providerBlock, success: false, verified: false, reason: 'provider_external_block' };
              break;
            }
            if (error?.code === 'DECISION_OUTPUT_BUDGET') {
              run.workingMemory.outputBudgetCutOffs = (run.workingMemory.outputBudgetCutOffs || 0) + 1;
              this.scheduleRecovery(run, {
                source: 'output_budget',
                error: 'The provider output-token limit interrupted the previous decision before execution. The budget was raised and any retained reasoning is available as evidence: continue it where it stopped, reconciled with the newest observation.',
                recordSyntheticHistory: true
              });
              continue;
            }
            if (isMessageInterrupt(error)) { latestObservation = null; continue; }
            // Context flood: shed and retry immediately (kept).
            if (isTransportError(error) === false && /\b403\b|\b413\b|too large|context length|maximum context|prompt is too long|request too large/i.test(String(error?.message || error))) {
              run.pendingAgentMessages = [];
              run.messages = normalizeConversationMessages(run.messages).slice(-10);
              appendConversationMessage(run, 'user', 'CONTEXT SHED: an incoming-message flood made the request oversized. Pending agent messages were dropped (senders are throttled); the newest conversation tail was kept. Continue the objective.', { source: 'runtime' });
              latestObservation = null;
              continue;
            }
            // DSH REQUEST-ERROR POLICY: transport failures retry INSIDE the
            // open step on the rising ladder (user input never re-admitted).
            if (isTransportError(error)) {
              const attempt = (run.transportRetryAttempts || 0) + 1;
              if (attempt > this.transportRetryDelays.length) {
                const message = `The provider remained unavailable after the cumulative transport retry budget was exhausted (${Math.round(this.transportRetryDelays.reduce((total, delay) => total + delay, 0) / 60000)} minutes). The browser task state was preserved; retry the provider or continue the conversation when it is available.`;
                this.record(run, { name: 'agent_provider_unreachable', input: {} }, { ok: false, recoverable: false, error: message });
                run.status = 'failed';
                run.result = { summary: message, success: false, verified: false, reason: 'provider_unreachable' };
                break;
              }
              const delayMs = this.transportRetryDelays[attempt - 1];
              run.transportRetryAttempts = attempt;
              this.publish('assistant.message', run, { text: `Connection error (${String(error.message || error).replace(/\s+/g, ' ').slice(0, 160)}). Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${this.transportRetryDelays.length}); the task will continue automatically.`, transient: true });
              await pauseForRetry(delayMs, run.abortController.signal);
              if (run.status !== 'running' || run.abortController.signal.aborted) break;
              continue;
            }
            // DSH RECOVERY: any other step error parks the run once
            // (awaiting_recovery + auto-resume). Recovery is indefinite.
            if (!response) {
              this.parkRun(run, `The provider failed (${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200)}). The run is parked; recovery resumes it automatically.`);
              break;
            }
          } finally {
            clearInterval(thinkingTimer);
            thinkingMs = Math.max(0, Date.now() - thinkingStartedAt);
            run.coordinator.metrics.phaseMs.model += performance.now() - decisionStartedAt;
          }
          if (run.status !== 'running' || run.result) break;
          run.transportRetryAttempts = 0;
          run.lastObservationChanged = true;
          // Message storm damping (kept): void only MUTATING decisions.
          if (run.messageArrivedWhileStep) {
            run.messageArrivedWhileStep = false;
            const provisionalCalls = normalizeToolCalls(response?.actions || response?.toolCalls || (response?.done ? [{ name: 'browser_done', input: response.done }] : []), run.settings.maxActionsPerStep);
            const stormSafe = new Set(['agent_message', 'task_spawn', 'subagent_close', 'subagent_list', 'update_plan', 'browser_wait', 'browser_observe', 'browser_tabs', 'browser_fetch', 'computer_index', 'computer_search', 'computer_read', 'computer_fs', 'skill_search']);
            if (!provisionalCalls.every((call) => stormSafe.has(call.name))) {
              latestObservation = null;
              continue;
            }
          }
          if (run.pendingUserMessages?.length) { latestObservation = null; continue; }

          const assistantText = String(response?.assistantText || '').trim().slice(0, 8_000);
          const terminalInput = response?.done && typeof response.done === 'object'
            ? {
                ...response.done,
                summary: String(response.done.summary || assistantText).trim().slice(0, 4_000) || 'Task completed.'
              }
            : response?.done;
          const proposedCalls = response?.actions || response?.toolCalls || (terminalInput ? [{ name: 'browser_done', input: terminalInput }] : []);
          let calls = normalizeToolCalls(proposedCalls, run.settings.maxActionsPerStep)
            .map((call) => call.name === 'browser_done' && !String(call.input?.summary || '').trim()
              ? {
                  ...call,
                  input: {
                    ...(call.input || {}),
                    summary: assistantText.slice(0, 4_000) || 'Task completed.'
                  }
                }
              : call);
          if (Array.isArray(proposedCalls) && proposedCalls.length > calls.length) {
            pushHarnessNotice(run, `BATCH TRUNCATED: ${proposedCalls.length - calls.length} action(s) exceeded the per-decision limit of ${run.settings.maxActionsPerStep}. Batch only independent calls; continue the remaining work in the next decision.`);
          }
          const conclusivePointerMove = shouldFinalizeConclusivePointerMove(calls, assistantText);
          if (conclusivePointerMove) {
            calls = [...calls, terminalPointerMoveCompletion(assistantText)];
          }
          recordFacts(run.coordinator, response?.memoryUpdate);
          if (typeof response?.title === 'string' && response.title.trim()) {
            run.title = normalizeConversationTitle(response.title, run.task);
            this.publish('run.title', run, { title: run.title });
          }
          const proposedPlan = response?.planUpdate ?? response?.plan;
          let responsePlanApplied = false;
          if (Array.isArray(proposedPlan)) {
            const update = applyPlanUpdate(run.plan, proposedPlan);
            if (update.ok) {
              const changed = JSON.stringify(update.plan) !== JSON.stringify(run.plan || []);
              run.plan = update.plan;
              responsePlanApplied = changed;
              if (changed) this.publish('plan.updated', run, { plan: run.plan });
            }
          }
          if (calls.length === 0) {
            // JSON-leak harvest (kept): a decision narrated as raw JSON is
            // executed instead of looping.
            const leaked = extractEmbeddedDecision(assistantText)
              || extractEmbeddedDecision(String(run.activeThoughtAccumulator?.() || ''));
            if (leaked) {
              calls = normalizeToolCalls(
                leaked.actions || leaked.toolCalls || (leaked.done ? [{ name: 'browser_done', input: leaked.done }] : []),
                run.settings.maxActionsPerStep
              );
            }
          }
          if (calls.length === 0 && responsePlanApplied) {
            run.step += 1;
            continue;
          }
          if (calls.length === 0 && isAnswerOnlyTask(run.task, assistantText, run)) {
            run.status = 'completed';
            run.result = { summary: assistantText, success: true, verified: false, reason: 'answer_only' };
            run.objectiveLedger = retireAnswerOnlyObjective(run.objectiveLedger);
            syncObjectiveLedger(run);
            appendConversationMessage(run, 'assistant', assistantText);
            break;
          }
          if (calls.length === 0) {
            // DSH UNDECIDABLE OUTPUT: one sticky schema-repair notice per
            // turn + classified recovery. No parallel stall trackers.
            if (!run.schemaRepairArmed) {
              run.schemaRepairArmed = true;
              pushHarnessNotice(run, loopPolicy.SCHEMA_REPAIR_NOTICE.text);
            }
            this.settleActiveThought(run, 'no_action_decision');
            this.scheduleRecovery(run, {
              source: 'empty_decision',
              error: 'The previous response contained no executable action or terminal result. Choose one now: the next concrete tool call, or browser_done. Do not restate what you just said — your own text is already in the conversation above; act on the newest observation instead.',
              recordSyntheticHistory: true
            });
            latestObservation = null;
            continue;
          }
          run.schemaRepairArmed = false;
          const onlyUpdatesPlan = calls.length > 0 && calls.every((call) => call.name === 'update_plan');
          archiveActiveThinking(run);
          if (!onlyUpdatesPlan) this.publish('assistant.thinking.completed', run, { thoughtId, elapsedMs: Date.now() - thinkingStartedAt });
          if (assistantText && !onlyUpdatesPlan && !conclusivePointerMove && !calls.some((call) => call.name === 'browser_done') && !run.intermediateMessagePublished) {
            this.publish('assistant.message', run, { text: assistantText, thinkingMs });
            run.intermediateMessagePublished = true;
          }
          const pureWait = calls.length > 0 && calls.every(isWaitPollCall);
          run.lastDecisionWasWait = pureWait;
          if (pureWait) {
            run.decisionCount = Math.max(0, run.decisionCount - 1);
            run.waitTurns = (run.waitTurns || 0) + 1;
          }
          run.step += 1;
          const decisionObservation = { desktop: run.latestObservation?.desktop, screenshot: run.latestObservation?.screenshot };
          const planBeforeDecision = JSON.stringify(run.plan || []);
          let decisionSettledReexecutions = 0;
          for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
            const call = calls[callIndex];
            if (run.status !== 'running' || run.result) break;
            if (run.pendingUserMessages?.length) { latestObservation = null; break; }
            const mutation = actionMutates(call.name, call.input);
            if (run.workspace?.root && call.name === 'computer_terminal' && ['execute', 'open'].includes(call.input?.action) && !call.input.cwd) {
              call.input = { ...call.input, cwd: run.workspace.root };
            }
            if (run.workspace?.root && call.name === 'computer_index') {
              call.input = {
                ...call.input,
                ...(call.input?.path ? {} : { path: run.workspace.root }),
                ...(run.task && !call.input?.goal ? { goal: quoteRequest(run.task, 1500) } : {})
              };
            }
            const resolvedElement = resolveSnapshotElement(this.controller, String(call.input?.tabId || run.tabId), call);
            const hash = actionHash(call, resolvedElement, decisionObservation);
            // Fast path consume (kept verbatim semantics).
            if (run.eagerResults instanceof Map && run.eagerResults.has(hash)) {
              const eagerEntry = run.eagerResults.get(hash);
              run.eagerResults.delete(hash);
              const eagerOutput = eagerEntry && typeof eagerEntry === 'object' && eagerEntry.output !== undefined ? eagerEntry.output : eagerEntry;
              if (eagerOutput && typeof eagerOutput === 'object') {
                this.record(run, call, eagerOutput);
                this.publish('tool.result', run, { tool: call.name, output: eagerOutput, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, eagerOutput) } });
                if (mutation) latestObservation = null;
                continue;
              }
            }
            // ── DSH GUARD LAYER (pre-execute: deny-only mechanical guards,
            //    everything else advisory) ──
            const fillProof = fillGate(run.coordinator, hash, call);
            if (fillProof) {
              const output = { ok: true, alreadySet: true, result: { ...fillProof.proof, alreadySet: true, note: fillProof.advisory } };
              this.record(run, call, output);
              this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
              continue;
            }
            const tamper = constraintTamper(run.coordinator, call) || presentationTamper(run.coordinator, call);
            if (tamper) {
              const output = { ok: false, recoverable: true, recoverySource: 'constraint_tamper', error: tamper.advisory };
              this.record(run, call, output);
              this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
              run.constraintRejection = { historyLength: run.history.length, kind: 'tamper' };
              this.scheduleRecovery(run, { source: 'constraint_tamper', error: output.error, call, recordSyntheticHistory: true });
              latestObservation = null;
              continue;
            }
            // First-write constraint probe: ADVISORY ONLY (was a hard gate).
            if (call.name === 'browser_execute' && valueWriteLiterals(String(call.input?.script || '')).length) {
              try {
                const probedControls = await withinStepTimeout(run, 'reading form-control constraints', () =>
                  probeFormControlConstraints(this.controller, String(call.input?.tabId || run.tabId)));
                if (Array.isArray(probedControls) || (probedControls && typeof probedControls === 'object')) {
                  const fw = firstWriteViolations(String(call.input?.script || ''), probedControls);
                  if (fw.violations.length) {
                    pushHarnessNotice(run, `${CONFLICT_PROTOCOL_ADVISORY} Detected: ${fw.violations[0]} The call was allowed through — verify the result and respect the control's constraint.`);
                  } else if (fw.unresolved > 0) {
                    const controls = Array.isArray(probedControls) ? probedControls : (Array.isArray(probedControls.controls) ? probedControls.controls : []);
                    if (controls.some((control) => Number(control?.maxLength) > 0 || Number(control?.minLength) > 0)) {
                      pushHarnessNotice(run, "HARNESS: a browser_execute writes .value directly into a form control; its own maxLength/minLength could not be verified before execution — confirm the write stayed within the control's constraint.");
                    }
                  }
                }
              } catch { /* advisory probe must never break the batch */ }
            }
            const stale = staleAnchor(run.coordinator, call);
            const redundantAppend = repeatedAppendAfterFill(run, call);
            const redundantObserve = repeatedOuterObservation(run, call);
            const redundantScreenshot = repeatedScreenshotFromCurrentObservation(run, call);
            const attempt = stale
              ? stale
              : redundantAppend || redundantObserve || redundantScreenshot
                ? { allowed: true, advisory: redundantAppend || redundantObserve || redundantScreenshot }
                : canAttempt(run.coordinator, hash, mutation, call.expect, call.repeat);
            if (attempt.advisory) call.advisory = attempt.advisory;
            if (!attempt.allowed) {
              const gateSource = stale ? 'stale_element' : 'duplicate_action';
              const output = { ok: false, recoverable: true, recoverySource: gateSource, error: attempt.advisory || 'The same mutation was already attempted against this evidence.' };
              this.record(run, call, output);
              this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
              this.scheduleRecovery(run, { source: gateSource, error: output.error, call, recordSyntheticHistory: true });
              latestObservation = null;
              continue;
            }
            // DSH repeat-call guard (advisory, canonical-argument based —
            // replaces the identical-action stall trackers).
            const repeatNotice = run.repeatGuard.observe(call.name, call.input);
            if (repeatNotice) pushHarnessNotice(run, repeatNotice.text);
            const grounding = prepareAction(run.interactionMemory, call);
            if (!grounding.ok) {
              const output = { ok: false, recoverable: true, recoverySource: 'layout_changed', error: grounding.message };
              this.record(run, call, output);
              this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
              this.scheduleRecovery(run, { source: 'layout_changed', error: output.error, call, recordSyntheticHistory: true });
              latestObservation = null;
              continue;
            }
            const executedAt = Date.now();
            let outcome;
            try {
              if (call.name === 'browser_wait') this.publish('tool.started', run, { tool: 'browser_wait', input: call.input });
              outcome = requiresApproval(call, run) || call.name === 'browser_wait' || call.name === 'ask_user'
                ? await this.executeOrRequestApproval(run, call, { hash })
                : await withinStepTimeout(run, `executing ${call.name}`, () => this.executeOrRequestApproval(run, call, { hash }));
            } catch (error) {
              if (run.status !== 'running' || run.abortController.signal.aborted) throw error;
              if (isMessageInterrupt(error)) { latestObservation = null; break; }
              const output = { ok: false, recoverable: true, recoverySource: 'action_timeout', error: String(error?.message || 'The browser action timed out.') };
              this.record(run, call, output);
              this.publish('tool.result', run, {
                tool: call.name,
                output: redactOutput(call.name, output, call.input),
                inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, redactOutput(call.name, output, call.input)) }
              });
              this.scheduleRecovery(run, { source: 'action_timeout', error, call });
              latestObservation = null;
              continue;
            }
            run.coordinator.metrics.phaseMs.execute += Date.now() - executedAt;
            run.coordinator.metrics.actionAttempts += 1;
            if (mutation && run.observationDomain === 'browser' && String(call.name).startsWith('browser_')) {
              const textOnlyInputMutation = call.name === 'browser_fill' || call.name === 'browser_type';
              if (!textOnlyInputMutation || run.settings.vision !== 'auto') run.browserNeedsImage = true;
            }
            const latestOutput = run.history.at(-1)?.output;
            // Terminal-job stall advisories (kept, one-shot each).
            if (call.name === 'computer_terminal' && call.input?.action === 'read' && latestOutput?.result?.state === 'running') {
              const emptyOutput = !String(latestOutput?.result?.output || '').trim();
              if (emptyOutput) {
                run.terminalJobStallCount = (run.terminalJobStallCount || 0) + 1;
                if (run.terminalJobStallCount === 3) {
                  pushHarnessNotice(run, 'TERMINAL JOB STALL: the job has produced no output across 3 polls. Verify whether the expected outcome already exists (e.g. check for the installed binary/file with a direct command), then either proceed or switch to a different install/run strategy. Do not keep polling the same job.');
                }
              } else {
                run.terminalJobStallCount = 0;
              }
            }
            if (call.name === 'computer_terminal' && call.input?.action === 'read' && latestOutput?.result?.error && /maximum lifetime/i.test(String(latestOutput.result.error))) {
              pushHarnessNotice(run, 'TERMINAL JOB TIMEOUT: the command was killed after exceeding its maximum lifetime. Do not retry the same command — switch to a different approach (e.g. direct download instead of package manager, or a prebuilt binary instead of building from source).');
            }
            if (call.name !== 'computer_terminal' || call.input?.action !== 'read') {
              if (run.terminalJobStallCount) run.terminalJobStallCount = 0;
            }
            // Fill rejection marks the control (kept: mechanical evidence).
            if (call.name === 'browser_fill' && latestOutput?.ok === false) {
              const rejectedIndex = I.coerceElementIndex(call.input?.element ?? call.input?.index);
              const rejectedName = String(resolvedElement?.name || resolvedElement?.text || '').replace(/\s+/g, ' ').trim();
              const rejectedTag = String(resolvedElement?.tag || '').toLowerCase();
              let rejectedPosition;
              if (rejectedTag && rejectedIndex !== undefined) {
                try {
                  const snapshotElements = this.controller.elementSnapshots?.get(String(call.input?.tabId || run.tabId))?.elements;
                  if (Array.isArray(snapshotElements)) {
                    const sameTag = snapshotElements.filter((el) => String(el?.tag || '').toLowerCase() === rejectedTag && Number(el?.index) <= Number(rejectedIndex));
                    if (sameTag.length > 0) rejectedPosition = sameTag.length - 1;
                  }
                } catch { /* positional identity is best-effort */ }
              }
              recordRejectedFill(run.coordinator, {
                index: rejectedIndex,
                name: rejectedName,
                ...(rejectedTag ? { tag: rejectedTag } : {}),
                ...(Number.isFinite(rejectedPosition) ? { position: rejectedPosition } : {})
              });
              run.constraintRejection = {
                historyLength: run.history.length,
                kind: 'fill_rejected',
                ...(rejectedIndex !== undefined ? { index: rejectedIndex } : {})
              };
            }
            if (latestOutput?.ok === true && NAVIGATION_TOOL_NAMES.has(call.name)) {
              bumpNavigationEpoch(run.coordinator);
              if (call.name === 'browser_navigate') pushHarnessNotice(run, 'PAGE CHANGED: re-observe before acting on remembered indices.');
            }
            const loopIssue = recordAction(run.coordinator, { hash, mutates: mutation, output: latestOutput, expectation: call.expect, call, observation: decisionObservation });
            if (loopIssue) {
              run.readLoopRecoveries = (run.readLoopRecoveries || 0) + 1;
              this.scheduleRecovery(run, { source: 'action_loop', error: loopIssue, call, recordSyntheticHistory: true });
              latestObservation = null;
              break;
            }
            // Rebuild tripwire (kept: one-shot sourced advisory).
            if (mutation && latestOutput?.ok === true) {
              const settled = run.coordinator.completedWork.find((entry) => entry.id === hash && entry.effectObserved === true);
              if (settled) {
                decisionSettledReexecutions += 1;
                run.settledReexecutionCount = (run.settledReexecutionCount || 0) + 1;
                const decisionNumber = Number(run.decisionCount) || 0;
                if (!Array.isArray(run.settledReexecutionDecisions)) run.settledReexecutionDecisions = [];
                if (!run.settledReexecutionDecisions.includes(decisionNumber)) run.settledReexecutionDecisions.push(decisionNumber);
                const withinDecision = decisionSettledReexecutions >= 2 && !NAVIGATION_TOOL_NAMES.has(call.name);
                const acrossDecisions = run.settledReexecutionCount >= 3 && run.settledReexecutionDecisions.length >= 2;
                if ((withinDecision || acrossDecisions) && !run.rebuildNoticeFired) {
                  run.rebuildNoticeFired = true;
                  pushHarnessNotice(run, `REBUILD DETECTED: ${String(settled.target || 'a completed flow').slice(0, 120)} is already verified (doneList evidence rev ${Number(settled.observedRevision) || '?'}) and has now been re-executed ${run.settledReexecutionCount} times across ${run.settledReexecutionDecisions.length} decision(s). Re-verify an uncertain claim with one corrected probe; never re-execute the completed flow.`);
                }
              }
            }
            const continueFocusedSubmit = mutation && mayContinueFocusedSubmit(run, call, calls[callIndex + 1], outcome);
            if (outcome === 'reobserve') {
              latestObservation = null;
              break;
            }
            const fileMutation = call.name === 'computer_patch'
              || call.name === 'computer_write'
              || (call.name === 'computer_file' && ['write', 'append', 'edit', 'delete', 'move', 'copy'].includes(String(call.input?.action || '')))
              || (call.name === 'computer_fs' && ['mkdir', 'copy', 'move', 'delete'].includes(String(call.input?.action || '')))
              || call.name === 'computer_fs_batch';
            if (fileMutation) {
              latestObservation = null;
              break;
            }
            if (call.name === 'browser_click' && latestOutput?.ok === true) {
              const elementText = String(resolvedElement?.text || resolvedElement?.name || call.input?.text || '').toLowerCase();
              const opensDialog = /upload|browse|choose file|select file|open file|save as|print|attach|import|pick file/.test(elementText);
              if (opensDialog && run.observationDomain === 'browser') {
                run.observationDomain = 'computer';
                run.computerObservationDirty = true;
                latestObservation = null;
                pushHarnessNotice(run, 'DIALOG EXPECTED: the element you clicked likely opens a native file/permission dialog. The observation domain has switched to desktop. Use computer_observe + computer_pointer to resolve the dialog, then switch back with browser_observe.');
              }
            }
            if (mutation || run.computerObservationDirty) latestObservation = null;
            if (latestObservation && Boolean(latestObservation.desktop) !== (run.observationDomain === 'computer')) latestObservation = null;
            if (outcome === 'terminated') break;
          }
          // A different executed call resets the repeat-call streak.
          if (calls.some((call) => call.name !== 'browser_done')) run.repeatGuard.reset();
          // DSH PROGRESS ADVISORY (kept: madeProgress, one single source).
          const progressAssessment = madeProgress(run.coordinator, {
            observationChanged: run.coordinator.fingerprint !== null && run.coordinator.fingerprint !== run.lastProgressFingerprint,
            planStatusChanged: JSON.stringify(run.plan || []) !== planBeforeDecision,
            lastProgressRevision: Number(run.lastProgressRevision || 0)
          });
          run.lastProgressFingerprint = run.coordinator.fingerprint;
          if (progressAssessment.artifactChanged) {
            run.lastProgressRevision = run.coordinator.completedWork
              .filter((entry) => entry?.effectObserved === true)
              .reduce((max, entry) => Math.max(max, Number(entry?.observedRevision || 0)), Number(run.lastProgressRevision || 0));
          }
          if (progressAssessment.progress) {
            run.progressStreak = 0;
            run.progressStreakNudged = false;
          } else {
            run.progressStreak = (run.progressStreak || 0) + 1;
            if (run.progressStreak >= 3 && !run.progressStreakNudged) {
              run.progressStreakNudged = true;
              const missing = !progressAssessment.newEvidence
                ? 'Name the one specific fact your next read or search must establish, or act on what you hold — re-inspection is not progress.'
                : !progressAssessment.stateChanged && !progressAssessment.artifactChanged
                  ? 'Your recent actions produced no observed effect. Inspect the mechanism once (a fresh observation, the console, or the relevant configuration) before the next attempt.'
                  : 'If the evidence already supports the outcome, verify and submit done; if it supports a different action, take it.';
              appendConversationMessage(run, 'user', `Progress check: the last ${run.progressStreak} decisions produced no new evidence, no observed effect, and no plan-status change. ${missing}`, { source: 'runtime' });
            }
          }
        }
      } catch (error) {
        if (isMessageInterrupt(error)) { continue; }
        if (run.status === 'cancelled') {
          // Cancellation is an intentional end state, not an agent failure.
        } else if (remainingRunMs(run) === 0 && !run.deadlineParked) {
          this.parkOnDeadline(run);
        } else {
          this.scheduleRecovery(run, { source: 'internal_error', error, recordSyntheticHistory: true });
          run.internalRecoveryPending = true;
        }
      } finally {
        if (run.internalRecoveryPending && run.status === 'running') {
          run.internalRecoveryPending = false;
          continue recoveryLoop;
        }
        archiveActiveThinking(run);
        run.activeThoughtId = null;
        run.activeThoughtStartedAt = null;
        run.activeThoughtAccumulator = null;
        run.usage = run.turnLedger?.usage || run.usage;
        if (run.status === 'running') {
          this.scheduleRecovery(run, { source: 'missing_terminal_result', error: 'The decision loop reached a boundary without a terminal result. Continue internally from fresh evidence.', recordSyntheticHistory: true });
          continue recoveryLoop;
        }
        run.completedAt = Date.now();
        this.drainEagerResults(run);
        run.turnLedger?.settle(run.history);
        settleObjectiveLedgerOnTerminal(run);
        ensureTerminalAssistantMessage(run);
        this.controller.releaseSessionInput(run.id);
        if (run.computerUsed) {
          try {
            const backend = run.getComputerTools();
            if (run.status === 'completed' && run.result?.success === true) await backend.releaseInput?.(run.computerOwner);
            else await backend.releaseOwner(run.computerOwner);
          }
          catch (error) { this.publish('computer.cleanup.error', run, { error: error.message }); }
        }
        const finalTabId = String(run.tabId || '');
        if (typeof run.closeTab === 'function') {
          for (const ownedTabId of run.ownedTabIds || []) {
            if (String(ownedTabId) !== finalTabId) {
              try { run.closeTab(ownedTabId, { preserveRun: true }); } catch { /* stale tab cleanup is best effort */ }
            }
          }
        }
        run.ownedTabIds = finalTabId ? [finalTabId] : [];
        this.publish(run.status === 'completed' ? 'run.completed' : run.status === 'failed' ? 'run.failed' : run.status === 'cancelled' ? 'run.cancelled' : 'agent.recovery_waiting', run, { result: run.result });
        try { this.onTerminal?.(serializeRun(run)); } catch {}
      }
    }
    return serializeRun(run);
  }

  // ── UNIFORM RECOVERY (DSH loopPolicy) ────────────────────────────────────
  // parkRun: the ONE park mechanism. Status 'awaiting_recovery' +
  // run.escalated + auto-resume timer with bounded backoff. NEVER terminates
  // (owner directive preserved). The external-deadline park (parkOnDeadline)
  // is the only non-resuming park.
  parkRun(run, reason) {
    if (!run || run.status !== 'running') return false;
    run.status = 'awaiting_recovery';
    run.escalation = { at: Date.now(), reason: String(reason || '').slice(0, 400), fires: (Number(run.escalation?.fires) || 0) + 1 };
    this.publish('run.escalated', run, { reason: run.escalation.reason });
    appendConversationMessage(run, 'user', `PARKED: ${run.escalation.reason} Held state: plan ${Array.isArray(run.plan) ? run.plan.length : 0} items, completed work ${run.coordinator?.completedWork?.length || 0}, last evidence revision ${run.coordinator?.observationRevision || 0}. Resume is automatic; a message from you retargets the run.`, { source: 'runtime' });
    try { run.activeStepController?.abort(new Error('run-escalated')); } catch { /* parking must never depend on an abortable step */ }
    const resumeMs = loopPolicy.escalationBackoffMs(Number(run.recoveryEpisodes) || 0);
    if (run.escalationTimer) clearInterval(run.escalationTimer);
    run.escalationTimer = setInterval(() => {
      try {
        if (!this.run || this.run !== run || run.status !== 'awaiting_recovery') {
          clearInterval(run.escalationTimer);
          run.escalationTimer = null;
          return;
        }
        void this.resumeAfterRecovery(null).catch(() => {});
      } catch { /* the auto-resume must never break the parked run */ }
    }, resumeMs);
    if (typeof run.escalationTimer.unref === 'function') run.escalationTimer.unref();
    return true;
  }

  // External-deadline park: the only non-resuming parked state (kept).
  parkOnDeadline(run, reason = null) {
    if (!run || run.status === 'cancelled' || run.status === 'completed' || run.status === 'failed') return false;
    if (run.deadlineParked) return false;
    run.deadlineParked = true;
    run.status = 'awaiting_recovery';
    run.escalation = {
      at: Date.now(),
      reason: String(reason || `Run deadline expired (${Math.round((Date.now() - Number(run.turnStartedAt || Date.now())) / 1000)}s of budget). The run is parked with its state preserved; send a message to continue.`).slice(0, 400),
      fires: (Number(run.escalation?.fires) || 0) + 1,
      externalDeadline: true
    };
    this.publish('run.escalated', run, { reason: run.escalation.reason, externalDeadline: true });
    appendConversationMessage(run, 'user', `DEADLINE EXPIRED: ${run.escalation.reason}`, { source: 'runtime' });
    try { run.activeStepController?.abort(new Error('external-deadline-expired')); } catch { /* abort is best effort */ }
    if (run.escalationTimer) { clearInterval(run.escalationTimer); run.escalationTimer = null; }
    return true;
  }

  // scheduleRecovery (slim, DSH-shaped): classify → structured record → ONE
  // sourced one-shot notice → bounded recovery log. No fingerprint demands,
  // no parallel watchdog accounting.
  scheduleRecovery(run, { source, error, call = null, recordSyntheticHistory = false }) {
    const lastError = redactRecoveryError(error, call);
    const attempts = Number(run.recovery?.attempts || 0) + 1;
    const failureClass = loopPolicy.classifyFailure(String(source || ''));
    run.recovery = {
      attempts,
      lastError,
      source: String(source || 'agent').slice(0, 80),
      action: call?.name || null,
      failureClass
    };
    run.recoveryLog = [...(Array.isArray(run.recoveryLog) ? run.recoveryLog : []), {
      at: Date.now(),
      source: run.recovery.source,
      failureClass,
      actionHash: call ? actionHash(call) : null,
      note: lastError.slice(0, 300)
    }].slice(-8);
    const noticeSeen = run.noticeFingerprints ||= new Set();
    const noticeKey = `${run.recovery.source}|${lastError}`;
    if (failureClass && failureClass !== 'UNCLASSIFIED' && !noticeSeen.has(noticeKey)) {
      noticeSeen.add(noticeKey);
      const notice = loopPolicy.recoveryNotice(attempts, failureClass, lastError.slice(0, 160));
      pushHarnessNotice(run, notice.text);
    }
    run.coordinator.replansWithoutProgress += 1;
    if (recordSyntheticHistory) {
      const advisorySeen = run.advisoryFingerprints ||= new Set();
      if (!advisorySeen.has(noticeKey)) {
        advisorySeen.add(noticeKey);
        this.record(run, { name: 'agent_advisory', input: { source: run.recovery.source, action: run.recovery.action } }, { ok: true, recoverable: true, advisory: lastError });
      }
    }
    return true;
  }

  // Harness-initiated compaction (chat_compact tool, /compact command).
  async forceCompactRun(run, reason) {
    const ledger = run?.turnLedger;
    if (!ledger) throw new Error('No conversation ledger is active for this conversation.');
    const summarize = run.providerInstance?.summarizeFor
      ? (system, input, signal) => run.providerInstance.summarizeFor(system, input, signal, run.coordinator)
      : null;
    const stats = await ledger.compact({ current: {}, system: 'compact', tools: [], outputTokens: 2_048, summarize, signal: run.abortController?.signal, force: true });
    this.publish('context.compacted', run, { reason: reason || 'user_slash', ...(stats || {}) });
    return stats || { compacted: false };
  }

  // User slash commands typed in the chat box (mid-run via steer).
  async handleSlashCommand(run, text) {
    const content = String(text || '').trim();
    const spaceAt = content.search(/\s/);
    const command = (spaceAt === -1 ? content.slice(1) : content.slice(1, spaceAt)).toLowerCase();
    const rest = spaceAt === -1 ? '' : content.slice(spaceAt + 1).trim();
    if (command === 'compact') {
      const stats = await this.forceCompactRun(run, 'user_slash');
      const detail = `Compacted: ${stats.turnsBefore ?? '?'} -> ${stats.turnsAfter ?? '?'} retained turns, context now ~${stats.inputTokenEstimate ?? '?'} tokens. Ready to continue.`;
      appendConversationMessage(run, 'assistant', detail);
      this.publish('assistant.message', run, { text: detail });
      return { status: 'compacted', detail, ...stats };
    }
    if (command === 'goal' || command === 'goals') {
      if (!rest) return this.handleSlashCommand(run, '/plan-help goals');
      const items = rest.split(/\n|;/).map(item => item.trim()).filter(Boolean);
      const update = applyPlanUpdate(run.goals, { steps: items });
      if (!update.ok) throw new Error(`Invalid /goal: ${update.error}`);
      run.goals = update.plan;
      this.publish('goals.updated', run, { goals: run.goals, source: 'user_slash' });
      const announce = `The user replaced the goals via /goal. Updated goals:\n${items.map((g, i) => `${i + 1}. ${g}`).join('\n')}\nReconcile these goals with the current work immediately: keep achieved goals, pursue the remaining ones, and drop goals the edit removed.`;
      if (['running', 'awaiting_approval', 'awaiting_input', 'paused'].includes(run.status)) return this.steerNow(run, announce);
      appendConversationMessage(run, 'assistant', announce);
      this.publish('assistant.message', run, { text: announce });
      return { status: 'goal-set', goals: run.goals };
    }
    if (command === 'plan') {
      if (!rest) return this.handleSlashCommand(run, '/plan-help plan');
      const items = rest.split(/\n|;/).map(item => item.trim()).filter(Boolean);
      const update = applyPlanUpdate(run.plan, { steps: items });
      if (!update.ok) throw new Error(`Invalid /plan: ${update.error}`);
      run.plan = update.plan;
      this.publish('plan.updated', run, { plan: run.plan, source: 'user_slash' });
      const announce = `The user replaced the working plan via /plan. Updated plan:\n${items.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nAdopt this plan now: keep completed work, continue from the first pending item, and discard steps the edit removed.`;
      if (['running', 'awaiting_approval', 'awaiting_input', 'paused'].includes(run.status)) return this.steerNow(run, announce);
      appendConversationMessage(run, 'assistant', announce);
      this.publish('assistant.message', run, { text: announce });
      return { status: 'plan-set', plan: run.plan };
    }
    if (command === 'notebook') {
      if (!run.notebook) throw new Error('No notebook is active for this conversation.');
      const filePath = run.notebook.filePath;
      if (rest) {
        const result = notebookAppendUserLine(filePath, rest);
        if (!result.ok) throw new Error('Nothing to append.');
        syncNotebook(run);
        const detail = `Noted in the notebook (NOTES): ${rest.slice(0, 120)}`;
        appendConversationMessage(run, 'assistant', detail);
        this.publish('assistant.message', run, { text: detail });
        return { status: 'notebook-appended', path: filePath };
      }
      const detail = `Run notebook: ${filePath} — it survives compaction, restart, and continuation. User sections (USER RULES, CREDENTIALS & KEYS, COMMANDS, NOTES) are yours to edit in the popup.`;
      this.publish('notebook.open', run, { path: filePath });
      appendConversationMessage(run, 'assistant', detail);
      this.publish('assistant.message', run, { text: detail });
      return { status: 'notebook-open', path: filePath };
    }
    if (command === 'plan-help') {
      const detail = `/goal <one goal per ; or newline> — replace the goals
/plan <one step per ; or newline> — replace the working plan
/notebook — open the run's persistent notebook (/notebook <text> appends a note)
/compact — summarize closed turns and free context now`;
      this.publish('assistant.message', run, { text: detail });
      return { status: 'help', detail };
    }
    return this.steerNow(run, text);
  }

  steer({ runId, text, plan, goals, attachments, domAttachments }) {
    const run = this.requireRun(runId);
    const rawText = String(text || '').trim();
    if (!plan?.length && !goals?.length && rawText.startsWith('/')) return this.handleSlashCommand(run, rawText);
    return this.steerNow(run, text, plan, goals, attachments, domAttachments);
  }

  steerNow(run, text, plan, goals, attachments = [], domAttachments = []) {
    if (!['running', 'awaiting_approval', 'awaiting_input', 'paused'].includes(run.status)) throw new Error('This run has ended. Send a continuation instead.');
    if (run.status === 'awaiting_input' && run.userInputResolver && String(text || '').trim()) {
      this.resolveUserInput(run, String(text).trim());
      return { id: crypto.randomUUID(), status: 'answered', runId: run.id };
    }
    let planEdited = null;
    if (Array.isArray(plan) && plan.length) {
      const update = applyPlanUpdate(run.plan, plan);
      if (!update.ok) throw new Error('The edited plan is invalid.');
      run.plan = update.plan;
      planEdited = update.plan;
      this.publish('plan.updated', run, { plan: run.plan, source: 'user_edit' });
    }
    let goalsEdited = null;
    if (Array.isArray(goals) && goals.length) {
      const update = applyPlanUpdate(run.goals, { steps: goals });
      if (!update.ok) throw new Error('The edited goals are invalid.');
      run.goals = update.plan;
      goalsEdited = update.plan;
      this.publish('goals.updated', run, { goals: run.goals, source: 'user_edit' });
    }
    let content = String(text || '').trim();
    if (!content && planEdited) {
      content = ['The user edited the working plan. Updated plan:',
        ...planEdited.map((item, index) => `${index + 1}. [${item.status || 'pending'}] ${item.text}`),
        'Adopt this plan now: keep completed work, continue from the first pending item, and discard steps the edit removed.'].join('\n');
    }
    if (!content && goalsEdited) {
      content = ['The user edited the goals. Updated goals:',
        ...goalsEdited.map((item, index) => `${index + 1}. [${item.status || 'pending'}] ${item.text}`),
        'Reconcile these goals with the current work immediately: keep achieved goals, pursue the remaining ones, and drop goals the edit removed.'].join('\n');
    }
    if (!content) throw new Error('Steering messages must contain at least 1 character.');
    if ((run.pendingUserMessages || []).length >= 20) throw new Error('Wait for queued messages to be delivered before adding more.');
    const stableDomAttachments = normalizeDomAttachments(domAttachments);
    content = replaceDomReferences(content, stableDomAttachments);
    const known = new Set((run.attachments || []).map((item) => `${item.name}|${item.selector || ''}`));
    const knownNames = new Set((run.attachments || []).map((item) => String(item.name || '')));
    for (const dom of stableDomAttachments) {
      const key = `${dom.name}|${dom.selector || ''}`;
      if (known.has(key) || knownNames.has(dom.name)) continue;
      run.attachments = [...(run.attachments || []), {
        name: dom.name, kind: 'text', mimeType: 'text/html', size: dom.text.length,
        content: dom.text, selector: dom.selector, previewText: dom.previewText
      }];
      known.add(key);
      knownNames.add(dom.name);
    }
    for (const attachment of Array.isArray(attachments) ? attachments : []) {
      if (attachment?.inline && attachment?.selector) continue;
      const kind = attachment?.kind === 'path' ? 'path' : attachment?.kind === 'image' ? 'image' : 'text';
      const content = kind === 'text' ? String(attachment?.content ?? attachment?.text ?? '').slice(0, MAX_ATTACHMENT_TEXT_CHARS) : undefined;
      const key = `${String(attachment?.name || 'attachment')}|${String(attachment?.path || '')}`;
      if (known.has(key)) continue;
      run.attachments = [...(run.attachments || []), {
        name: safeAttachmentName(attachment?.name), kind, mimeType: String(attachment?.mimeType || '').slice(0, 100),
        size: Math.max(0, Number(attachment?.size) || (content ? Buffer.byteLength(content) : 0)),
        ...(kind === 'path' ? { path: String(attachment?.path || ''), isDirectory: attachment?.isDirectory === true } : {}),
        ...(content !== undefined ? { content } : {})
      }];
      known.add(key);
    }
    const message = {
      id: crypto.randomUUID(), role: 'user', content, at: nextTimelineAt(run),
      ...(stableDomAttachments.length ? { domAttachments: stableDomAttachments } : {}),
      ...(planEdited || goalsEdited ? { source: planEdited ? 'plan_edit' : 'goal_edit' } : {})
    };
    run.pendingUserMessages.push(message);
    this.publish('user.message.queued', run, { messageId: message.id });
    return { id: message.id, status: 'queued', runId: run.id, ...(planEdited ? { plan: planEdited } : {}), ...(goalsEdited ? { goals: goalsEdited } : {}) };
  }

  deliverSteering(run) {
    if (!run.pendingUserMessages?.length) return;
    const messages = run.pendingUserMessages.splice(0);
    run.messages = [...normalizeConversationMessages(run.messages), ...messages].slice(-40);
    run.completionCandidate = null;
    run.completionReviewForced = false;
    run.completionReviewBounces = 0;
    run.incompleteWorkBounces = 0;
    run.recovery = { attempts: 0, lastError: '', source: '', action: null };
    run.turnStartedAt = Date.now();
    run.turnLedger?.beginTurn();
    // User steering resets the advisory guard state (DSH: steering is fresh
    // evidence of intent — streaks and repair notices belong to the old turn).
    run.progressStreak = 0;
    run.progressStreakNudged = false;
    run.schemaRepairArmed = false;
    run.repeatGuard?.reset();
    run.loopState = { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 };
    for (const message of messages) this.publish('user.message.delivered', run, { messageId: message.id });
    const latestText = String(messages.at(-1)?.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    appendConversationMessage(run, 'user',
      isTaskAddition(latestText) ? steeringAdditionNotice(latestText) : steeringReplacementNotice(latestText),
      { source: 'runtime' });
  }

  // LORDE_NATIVE_SURFACE_AWARENESS_V365 (kept: functionality).
  async deliverNativeSurfaceNotice(run) {
    if (!run || run.remoteExecution) return;
    if (run.settings?.controlMode !== 'agi' || typeof run.getComputerTools !== 'function') return;
    const now = Date.now();
    if (now < (run.nativeSurfaceCheckAt || 0)) return;
    run.nativeSurfaceCheckAt = now + 4000;
    let backend = null;
    try { backend = run.getComputerTools(); } catch { return; }
    const scanWindows = typeof backend?.scanWindows === 'function'
      ? (owner, signal) => backend.scanWindows(owner, { signal })
      : typeof backend?.observe === 'function'
        ? (owner, signal) => backend.observe(owner, { signal, nativeScan: true })
        : typeof backend?.execute === 'function'
          ? (owner, signal) => backend.execute('computer_window', { action: 'list' }, owner, { signal, nativeScan: true })
          : null;
    if (!scanWindows) return;
    let inventory = null;
    const observed = run.latestObservation?.desktop;
    if (observed && Array.isArray(observed.windows) && run.nativeSurfaceScanRevision !== run.coordinator?.observationRevision) {
      run.nativeSurfaceScanRevision = run.coordinator?.observationRevision;
      inventory = observed;
    }
    if (!inventory) {
      try {
        inventory = await Promise.race([
          scanWindows(run.computerOwner || `native-scan:${run.id}`, run.abortController?.signal),
          new Promise(resolve => setTimeout(() => resolve(null), 3000))
        ]);
      } catch { return; }
    }
    const windows = Array.isArray(inventory?.windows) ? inventory.windows : [];
    const DIALOG_CLASSES = new Set(['#32770', '#32771', 'Chrome_WidgetWin_1', 'Chrome_WidgetWin_0']);
    const isDialog = (w) => {
      const cls = String(w?.className || '');
      const title = String(w?.title || '').toLowerCase();
      if (w?.own === true) return false;
      if (/^browser-use( agent pointer)?$/.test(title)) return false;
      const looksDialog = DIALOG_CLASSES.has(cls)
        || /open|save|select|choose|upload|permission|allow|deny|confirm|dialog|browse|file/.test(title);
      return looksDialog && !w?.minimized;
    };
    const dialogs = windows.filter(isDialog);
    if (!run.nativeSurfaceSeen) run.nativeSurfaceSeen = new Set(windows.map(w => w.id));
    const fresh = dialogs.filter(dialog => !run.nativeSurfaceSeen.has(dialog.id));
    if (!fresh.length) return;
    for (const dialog of fresh) run.nativeSurfaceSeen.add(dialog.id);
    run.computerObservationDirty = true;
    run.latestObservation = null;
    const switching = run.observationDomain !== 'computer';
    const worthNoticing = switching ? fresh : fresh.filter((dialog) => Number(dialog.pid) !== process.pid);
    if (!worthNoticing.length) return;
    if (switching) run.observationDomain = 'computer';
    const listed = worthNoticing.map(dialog => `"${String(dialog.title || 'Untitled').slice(0, 80)}" (windowId ${dialog.id})`).join(', ');
    appendConversationMessage(run, 'user', [
      `NATIVE DIALOG OPEN: ${listed}.${switching ? ' The observation domain has switched to desktop — use computer tools to resolve it.' : ' It is open on the desktop — use computer tools to resolve it.'}`,
      'Handle it NOW with native tools, then return to browser work:',
      '1. computer_observe to see the desktop and the dialog.',
      '2. computer_pointer / computer_keyboard to operate it — pick the file, confirm Open/Save, click Allow/Yes, or cancel. Use computer_window focus if it is behind another window.',
      '3. If a file picker is open, use computer_pointer to click the file list or computer_keyboard to type a path and press Enter.',
      '4. Once the dialog is gone, switch back with a fresh browser_observe.',
      'Never finish the task while a dialog is still open — it will block the flow forever.'
    ].join('\n'), { source: 'runtime' });
  }

  spawnResearch(run, objective, { kind = 'fact', key = null } = {}) {
    const research = run.research;
    if (!research || research.pending) {
      return {
        started: false,
        note: research?.pending
          ? 'This objective was NOT started: one research brief is already running for this run, and only that one will be delivered. Do not treat this topic as researched — research it yourself, or re-request it after the current brief arrives.'
          : 'Research is unavailable in this run.'
      };
    }
    const researchRunner = this.researchRunner
      || (process.env.BROWSER_USE_RESEARCH === 'off' ? null : I.defaultDeterministicResearch);
    if (!researchRunner) return { started: false, note: 'Research is unavailable in this session.' };
    const { providerConfig, remoteExecution, task } = run.researchDefaults || {};
    research.pending = true;
    research.delivered = false;
    try {
      const researchContext = {
        task: String(objective || task || '').slice(0, 4000),
        signal: run.abortController.signal,
        runId: run.id,
        providerFactory: () => this.createProvider(providerConfig),
        searchApiFactory: String(providerConfig?.id || '') === 'xkiro' ? () => {
          const provider = this.createProvider(providerConfig);
          return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
        } : null,
        browser: remoteExecution ? null : {
          createTab: this.createTab,
          closeTab: tabId => { try { this.controller.closeTab(tabId); } catch { } },
          search: (tabId, options) => this.controller.search(tabId, { ...(options || {}), engine: 'google' }),
          fetchPage: args => this.controller.fetchPage(args),
          notify: message => this.publish('research.notice', run, { message: String(message).slice(0, 300) })
        },
        metaSearch: this.researchMetaSearch
      };
      const researchBudgetMs = 120_000;
      const researchGraceMs = 30_000;
      let researchTimer = null;
      const researchTimeout = new Promise((resolve) => {
        researchTimer = setTimeout(() => resolve({ ok: false, timedOut: true }), researchBudgetMs + researchGraceMs);
      });
      research.promise = Promise.race([
        Promise.resolve(researchRunner(researchContext)),
        researchTimeout
      ])
        .then((result) => {
          clearTimeout(researchTimer);
          research.pending = false;
          research.result = result && result.ok && result.findings && !result.timedOut ? result : null;
          if (research.result && Array.isArray(result.sources) && result.sources.length >= 2 && this.knowledgeStore) {
            try { this.knowledgeStore.record(key || task, kind, String(result.findings).slice(0, 600), { source: 'research' }); } catch { }
          }
        })
        .catch(() => { clearTimeout(researchTimer); research.pending = false; research.result = null; });
      return { started: true, note: 'Research started in the background; findings will arrive as advisory context at a later decision. Keep working.' };
    } catch (error) {
      research.pending = false;
      research.result = null;
      return { started: false, note: 'Research could not start in this session.' };
    }
  }

  receiveAgentMessage({ from, fromLabel, text, reply = false }) {
    const run = this.run;
    if (!run || !['running', 'awaiting_approval', 'awaiting_input', 'paused', 'awaiting_recovery'].includes(run.status)) return { delivered: false, reason: 'session-not-live' };
    const entry = { at: Date.now(), from: String(from || ''), fromLabel: String(fromLabel || 'another session').slice(0, 120), text: String(text || '').slice(0, 8000), reply: reply === true };
    if (run.status === 'awaiting_recovery') {
      this.publish('agent.message', run, { from: entry.from, fromLabel: entry.fromLabel, text: entry.text, reply: entry.reply });
      void this.resumeAfterRecovery(entry).catch(() => {});
      return { delivered: true, resumed: true };
    }
    const nowMs = Date.now();
    if ((run.pendingAgentMessages || []).some(m => m.from === entry.from && m.text === entry.text && nowMs - Number(m.at || 0) < 90000)) {
      return { delivered: false, reason: 'duplicate-suppressed' };
    }
    const senderMessages = (run.messageLog ||= []).filter(m => m.from === entry.from);
    if (nowMs - Number(senderMessages.at(-1)?.at || 0) < 12_000) return { delivered: false, reason: 'sender-cooldown' };
    if (senderMessages.length >= 40) return { delivered: false, reason: 'sender-capped', note: 'This sender has delivered 40 messages to this run; further messages are rate-limited.' };
    run.messageLog.push({ from: entry.from, at: entry.at });
    if (run.messageLog.length > 400) run.messageLog.splice(0, run.messageLog.length - 400);
    const shouldInterrupt = entry.urgent === true
      || (!(Array.isArray(run.pendingAgentMessages) && run.pendingAgentMessages.length > 0)
      && (nowMs - Number(run.lastMessageInterruptAt || 0) >= 15000));
    if (shouldInterrupt) {
      run.lastMessageInterruptAt = nowMs;
      if (run.messageWakeController && !run.messageWakeController.signal.aborted) {
        run.messageWakeController.abort(new Error('agent-message-arrived'));
      }
      if (run.activeStepController && !run.activeStepController.signal.aborted) {
        run.activeStepController.abort(new Error('agent-message-arrived'));
      }
    }
    run.messageArrivedWhileStep = true;
    if (!Array.isArray(run.pendingAgentMessages)) run.pendingAgentMessages = [];
    run.pendingAgentMessages.push(entry);
    if (run.pendingAgentMessages.length > 6) run.pendingAgentMessages.splice(0, run.pendingAgentMessages.length - 6);
    this.publish('agent.message', run, { from: entry.from, fromLabel: entry.fromLabel, text: entry.text, reply: entry.reply });
    return { delivered: true };
  }

  async resumeAfterRecovery(message = null) {
    const run = this.run;
    if (!run || run.status !== 'awaiting_recovery') return { resumed: false, reason: 'session-not-awaiting-recovery' };
    if (this.recoveryResumePromise) return this.recoveryResumePromise;
    pushHarnessNotice(run, 'RUN RESUMED after a recovery hold: re-ground from the freshest observation before acting.');
    const resumeRequest = {
      task: run.task,
      continuation: true,
      resumeRecovery: true,
      conversationId: run.id,
      provider: run.provider,
      settings: run.settings,
      tabId: run.tabId,
      ownedTabIds: run.ownedTabIds,
      initialAgentMessages: message ? [message] : []
    };
    this.recoveryResumePromise = this.start(resumeRequest).finally(() => { this.recoveryResumePromise = null; });
    return this.recoveryResumePromise;
  }

  considerProgramResearch(run, observation) {
    if (run.programResearchHinted) return;
    if (run.observationDomain !== 'computer' || !observation?.desktop) return;
    const { programFromObservation, composeObjective, brainKnowsProgram } = require('../research/programControlResearch.cjs');
    const program = programFromObservation(observation.desktop);
    if (!program) { run.programResearchHinted = true; return; }
    run.programResearchHinted = true;
    if (brainKnowsProgram(this.knowledgeStore, program)) {
      this.publish('program.research.cached', run, { program });
      return;
    }
    run.researchHint = { program, objective: composeObjective(program, run.task) };
    this.publish('program.research.hinted', run, { program });
  }

  deliverResearch(run) {
    const research = run.research;
    if (!research || research.delivered || !research.result) return;
    research.delivered = true;
    if (run.status !== 'running') return;
    const findings = String(research.result.findings || '').trim();
    if (!findings) return;
    const content = [
      'Background research finished for this task (advisory context, not a new request — do not acknowledge it; reconcile it against fresh observation and use only what still holds):',
      '',
      findings
    ].join('\n');
    const message = appendConversationMessage(run, 'user', content, { source: 'runtime', badge: 'research', displayContent: findings });
    if (message) this.publish('user.message.delivered', run, { messageId: message.id, badge: 'research', content: findings });
  }

  deliverKnowledge(run, observation) {
    const store = this.knowledgeStore;
    if (!store || run.knowledgeInjected) return;
    run.knowledgeInjected = true;
    if (run.status !== 'running') return;
    let recalled = [];
    try {
      const programTitles = [];
      const desktop = observation?.desktop;
      if (Array.isArray(desktop?.windows)) {
        for (const window of desktop.windows.slice(0, 8)) {
          if (window?.title) programTitles.push(String(window.title).slice(0, 120));
        }
      }
      recalled = store.recall([run.task, ...programTitles].join(' \n'), { limit: 3 }) || [];
    } catch { return; }
    if (!recalled.length) return;
    const lines = recalled.map((entry, index) => `${index + 1}. [${entry.kind}${entry.verified ? ', verified' : ''}] ${entry.text}`);
    const content = [
      'Prior knowledge for this task (advisory, learned in earlier runs — reconcile against fresh observation; stale advice loses to what you can see now):',
      ...lines
    ].join('\n');
    try {
      const message = appendConversationMessage(run, 'user', content, { source: 'runtime' });
      if (message) this.publish('user.message.delivered', run, { messageId: message.id });
    } catch { /* memory must never block a run */ }
  }

  verifyWithLaya(run, observation) {
    const verifier = run.layaVerifier;
    if (!verifier || !observation) return;
    if (run.layaInFlight) return;
    const lastAction = Array.isArray(run.history) ? run.history.at(-1) : null;
    if (!lastAction || I.READ_ONLY_ACTION_NAMES.has(lastAction.tool)) return;
    run.layaInFlight = true;
    const isCoding = isCodingTask(run.task, run.workspace);
    const codingVerify = isCoding && typeof verifier.verifyCoding === 'function'
      ? Promise.resolve(verifier.verifyCoding({
          observation,
          action: { name: lastAction.tool, ok: Boolean(lastAction.output?.ok) },
          task: run.task,
          terminalOutput: lastAction.output?.result?.output || '',
          patchResult: lastAction.output?.result?.diff || '',
          signal: run.abortController.signal
        })).catch(() => null)
      : Promise.resolve(null);
    Promise.resolve(verifier.verify({
      observation,
      action: lastAction ? { name: lastAction.tool, ok: Boolean(lastAction.output?.ok) } : null,
      domain: run.observationDomain === 'computer' ? 'computer' : 'browser',
      task: run.task,
      signal: run.abortController.signal
    })).then((verification) => {
      return codingVerify.then((coding) => {
        if (!verification && !coding) return;
        const merged = {
          at: Date.now(),
          ...(verification || {}),
          ...(coding ? { coding: coding.answers || coding } : {})
        };
        if (verification?.used || coding?.used) run.layaVerification = merged;
        if (verification) this.publish('laya.verification', run, verification);
        if (coding) this.publish('laya.verification', run, { layer: 'coding', ...coding });
      });
    }).catch(() => { /* the accelerator must never touch the run */ }).finally(() => {
      run.layaInFlight = false;
    });
  }

  // LORDE_FAST_PATH (kept): eager execution of allowlisted streamed calls.
  async handleEagerAction(run, rawCall) {
    try {
      if (process.env.BROWSER_USE_FAST_PATH === 'off') return;
      if (!run || run.status !== 'running' || run.abortController?.signal.aborted) return;
      if (!run.eagerResults || run.eagerInFlight) return;
      if (run.pendingApproval || run.pendingUserMessages?.length) return;
      const name = String(rawCall?.name || '');
      if (!I.FAST_PATH_ACTIONS.has(name)) return;
      const call = { name, input: (rawCall.input && typeof rawCall.input === 'object' && !Array.isArray(rawCall.input)) ? { ...rawCall.input } : {} };
      if (requiresApproval(call, run)) return;
      const decisionObservation = { desktop: run.latestObservation?.desktop, screenshot: run.latestObservation?.screenshot };
      const resolvedElement = resolveSnapshotElement(this.controller, String(call.input?.tabId || run.tabId), call);
      const hash = actionHash(call, resolvedElement, decisionObservation);
      if (run.eagerResults.has(hash)) return;
      const attempt = canAttempt(run.coordinator, hash, actionMutates(call.name, call.input), call.expect, call.repeat);
      if (!attempt.allowed) return;
      const riskGate = I.riskGateFor(call.name, call.input);
      if (typeof run.layaVerifier?.confirmAction === 'function') {
        const verdict = await run.layaVerifier.confirmAction({ action: call, task: run.task, observation: run.latestObservation, signal: run.abortController.signal });
        if (!verdict?.ok) return;
        if (I.actionRiskLevel(call.name, call.input) !== 'low' && Number(verdict.noul) > 0 && Number(verdict.noul) < riskGate) return;
      }
      const grounding = prepareAction(run.interactionMemory, call);
      if (!grounding.ok) return;
      run.eagerInFlight = true;
      try {
        this.publish('agent.fastpath', run, { tool: call.name, input: inspectionValue(call.name, call.input) });
        const outcome = await this.executeOrRequestApproval(run, call, { hash });
        if (actionMutates(call.name, call.input) && run.observationDomain === 'browser' && String(call.name).startsWith('browser_')) {
          run.browserNeedsImage = true;
        }
        if (run.eagerResults instanceof Map) run.eagerResults.set(hash, { call, output: outcome });
      } finally {
        run.eagerInFlight = false;
      }
    } catch { /* the fast path must never break the decision loop */ }
  }

  cancel(runId) {
    const run = this.requireRun(runId);
    if (!['running', 'awaiting_approval', 'awaiting_input', 'paused', 'awaiting_recovery'].includes(run.status)) return serializeRun(run);
    if (run.escalationTimer) { clearInterval(run.escalationTimer); run.escalationTimer = null; }
    run.status = 'cancelled';
    run.abortController.abort();
    settleObjectiveLedgerOnTerminal(run);
    this.controller.releaseSessionInput(run.id);
    if (run.computerUsed) void run.getComputerTools().releaseOwner(run.computerOwner).catch(error => this.publish('computer.cleanup.error', run, { error: error.message }));
    this.resolveApproval(run, { decision: 'deny' });
    this.publish('run.cancelled', run, {});
    return serializeRun(run);
  }

  approve({ runId, approvalId, decision }) {
    const run = this.requireRun(runId);
    if (run.status !== 'awaiting_approval' || run.pendingApproval?.id !== approvalId) throw new Error('This AI chat approval is no longer active.');
    if (!['allow_once', 'deny'].includes(decision)) throw new Error('Approval decision must be allow_once or deny.');
    this.resolveApproval(run, { decision });
    return serializeRun(run);
  }

  requireRun(runId) {
    if (!this.run || this.run.id !== runId) throw new Error('Unknown AI chat run.');
    return this.run;
  }

  // ── TOOL EXECUTION + DONE HANDLING ───────────────────────────────────────
  // Execution plumbing (approval, plan tools, tool.started/result events,
  // record, archival, speculative pre-read) is kept. The old twelve-gate
  // done maze is replaced by ONE bounded completion review (DSH): compute
  // the named evidence gaps, bounce ONCE with them, then accept with a
  // verification note — verification never blocks a genuine run.
  async executeOrRequestApproval(run, call, { hash = null } = {}) {
    const hcuTool = parseHcuToolName(call.name);
    const action = ACTIONS[call.name];
    if (!action && !hcuTool) throw new Error(`Unsupported browser action: ${call.name}`);
    if (hcuTool) {
      if (run.settings.controlMode !== 'agi' || !run.hcuApi?.execute) throw new Error('HCU tools require AGI mode and an available HCU sidecar.');
    } else if (isComputerTool(call.name)) assertComputerMode(run);
    if (requiresApproval(call, run)) {
      const approval = await this.waitForApproval(run, call);
      if (approval.decision !== 'allow_once') {
        this.record(run, call, { ok: false, error: 'The local user declined this browser action.' });
        return 'terminated';
      }
    }
    if (run.status !== 'running') return 'terminated';
    if (run.pendingUserMessages?.length) return 'terminated';

    const inspectionInput = inspectionValue(call.name, call.input);
    let planUpdateResult = null;
    if (call.name === 'update_plan' || call.name === 'create_plan') {
      planUpdateResult = applyProgressUpdate(run.plan, run.goals, call.input);
      if (planUpdateResult.ok) {
        const changed = JSON.stringify([planUpdateResult.plan, planUpdateResult.goals]) !== JSON.stringify([run.plan || [], run.goals || []]);
        run.plan = planUpdateResult.plan;
        run.goals = planUpdateResult.goals;
        if (changed) this.publish('plan.updated', run, { plan: run.plan, goals: run.goals });
      }
    }
    if (call.name !== 'update_plan' && call.name !== 'create_plan') {
      archiveActiveThinking(run);
      run.activeThoughtId = null;
      run.activeThoughtStartedAt = null;
      run.activeThoughtAccumulator = null;
      run.usage = run.turnLedger?.usage || run.usage;
    }
    const executableTool = !['update_plan', 'create_plan', 'browser_done'].includes(call.name);
    if (executableTool && run.coordinator.metrics.firstToolStartedMs === null) run.coordinator.metrics.firstToolStartedMs = performance.now() - run.attemptStartedClock;
    this.publish('tool.started', run, { tool: call.name, args: redactArgs(call.name, call.input), inspection: { input: inspectionInput, output: null } });
    const heartbeatStartedAt = Date.now();
    const heartbeat = executableTool ? setInterval(() => {
      try { this.publish('tool.progress', run, { tool: call.name, elapsedMs: Date.now() - heartbeatStartedAt }); } catch { /* progress is additive */ }
    }, 4000) : null;
    let output;
    try {
      output = (call.name === 'update_plan' || call.name === 'create_plan') && planUpdateResult
        ? planUpdateResult.ok
          ? { ok: true, result: { tasks: run.plan.length, goals: run.goals.length, added: planUpdateResult.added, updated: planUpdateResult.updated, removed: planUpdateResult.removed, ...(call.name === 'create_plan' ? { created: true } : {}) } }
          : { ok: false, recoverable: true, recoverySource: 'invalid_plan_update', error: `${planUpdateResult.error} The plan was NOT created. Resend ${call.name} with steps as an array of strings or {text,status,verification} objects.` }
        : await executeAction(this.controller, run, call);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (executableTool) {
      run.failedClaimBounces = 0;
      run.criterionAuditBounces = 0;
      run.incompleteWorkBounces = 0;
      if (actionMutates(call.name, call.input || {}) && call.name !== 'browser_execute') {
        // Only LEDGER-AFFECTING settlements or NEW requirement coverage reset
        // the bounded completion-review counter (kept: F2 rule).
        const reProduced = Boolean(hash)
          && (run.coordinator.completedWork || []).some((entry) => entry.id === hash && entry.effectObserved === true);
        const ledgerReqs = Array.isArray(run.requirementLedger) ? run.requirementLedger : [];
        const openReqs = ledgerReqs.filter((req) => req.status === 'open');
        let coversOpen = false;
        if (openReqs.length && output?.ok === true) {
          const work = completedWorkEntry(call, output, hash, call.expect);
          if (work) coversOpen = openReqs.some((req) => requirementCovered(req, [{ ...work, effectObserved: true }]));
        }
        if (!reProduced && (!ledgerReqs.length || coversOpen)) {
          run.completionReviewBounces = 0;
          run.completionReviewForced = false;
        }
      }
      if (run.coordinator.metrics.firstToolSettledMs === null) run.coordinator.metrics.firstToolSettledMs = performance.now() - run.attemptStartedClock;
    }
    if (!output.ok && isStaleElementFailure(output) && ['browser_click', 'browser_type', 'browser_fill'].includes(call.name)) {
      output = { ...output, state: 'stale', recoverable: true };
    }
    if (['browser_screenshot', 'computer_screenshot'].includes(call.name) && output.ok && output.result?.data && run.latestObservation) {
      run.visualEvidence = output.result;
      run.latestObservation.screenshot = output.result;
      recordVisualCapture(run, 'tool');
    }
    if (output.ok && actionMutates(call.name, call.input)) {
      run.progressStreak = 0;
      run.progressStreakNudged = false;
      run.visualEvidence = null;
      if (run.latestObservation?.screenshot) delete run.latestObservation.screenshot;
      run.requiredEvidenceRevision = run.coordinator.observationRevision + 1;
    }
    // Mechanical staleness check (kept): a done decided against an
    // observation older than the last mutation is re-grounded, not argued.
    if (call.name === 'browser_done' && output.ok && output.success !== false && (run.computerObservationDirty || run.coordinator.observationRevision < Number(run.requiredEvidenceRevision || 0))) {
      output = {
        ...output,
        ok: false,
        recoverable: true,
        recoverySource: 'completion_evidence',
        error: 'An action or native evidence refresh occurred after the latest observation. Inspect the fresh state before declaring the task complete.'
      };
    }
    // ── THE COMPLETION REVIEW (DSH: one bounded review, named gaps) ──
    if (call.name === 'browser_done' && output.ok && !isCritiqueOnlyRun(run)) {
      output = this.reviewCompletion(run, call, output);
    }
    recordConsulted(run, call, output);
    const publicOutput = redactOutput(call.name, output, call.input);
    const storedOutput = archiveToolResult(run, publicOutput);
    const eventOutput = publicOutput?.media && storedOutput && typeof storedOutput === 'object'
      ? { ...storedOutput, media: publicOutput.media }
      : storedOutput;
    const screenshotPreview = screenshotPreviewValue(call.name, output);
    this.record(run, call, publicOutput, storedOutput);
    this.publish('tool.result', run, {
      tool: call.name,
      output: eventOutput,
      inspection: { input: inspectionInput, output: inspectionValue(call.name, eventOutput) },
      ...(screenshotPreview ? { screenshotPreview } : {})
    });

    if (output.ok && ['computer_search', 'computer_index'].includes(call.name)) {
      try {
        speculativePreRead(run, call, { ok: true, result: output.result || output }, (specCall) => executeAction(this.controller, run, specCall));
      } catch { /* speculative pre-read is best-effort */ }
    }

    if (!output.ok) {
      if (!output.recoverable) run.failures += 1;
      this.scheduleRecovery(run, {
        source: output.recoverySource || (output.state === 'stale' ? 'stale_element' : 'browser_action'),
        error: output.error || 'The browser action did not produce a usable result.',
        call
      });
      return 'terminated';
    }
    run.failures = 0;
    if (call.name !== 'browser_done') {
      run.recovery = { attempts: 0, lastError: '', source: '', action: null };
      run.completionCandidate = null;
    }
    if (!I.PROGRESS_GUARDED_READ_ACTIONS.has(call.name) && call.name !== 'browser_scroll' && call.name !== 'browser_done') {
      run.loopState.noProgressActions = 0;
      run.loopState.unchangedPages = 0;
    }
    const progressIssue = this.assertProgress(run, call, output);
    if (progressIssue) {
      this.record(run, { name: 'agent_advisory', input: { source: 'no_progress', action: call.name } }, { ok: true, recoverable: true, advisory: progressIssue });
      // No-change is evidence. The next decision owns the response.
    }
    if (call.name === 'browser_done') {
      if (output.success === false && output.final !== true) {
        this.scheduleRecovery(run, {
          source: 'unsuccessful_done',
          error: output.summary || 'The previous terminal result was unsuccessful.',
          call
        });
        return 'terminated';
      }
      run.status = output.success === false ? 'failed' : 'completed';
      run.result = { summary: output.summary, success: output.success !== false, verified: output.success === true && output.verified === true,
        ...(output.verifiedDowngraded ? { verifiedDowngraded: true, ...(output.verificationNote ? { verificationNote: output.verificationNote } : {}) } : {}),
        ...(output.success === false ? { reason: 'reported_incomplete' } : {}) };
      if (run.notebook && output.summary) {
        try { run.notebook.append('DECISIONS', `${output.success === false ? 'FAILED' : (run.result.verified ? 'DONE (verified)' : 'DONE')}: ${String(output.summary).replace(/\s+/g, ' ').slice(0, 240)}`); } catch { /* best effort */ }
      }
      return 'terminated';
    }
    return action.terminatesSequence ? 'terminated' : 'continue';
  }

  // THE completion review. Replaces the old twelve-gate maze with ONE pass:
  //   1. collect named gaps (open plan items / working subagents / open
  //      requirements / unbacked claims / unverifiable screenshot claims /
  //      verification contradictions / missing file mutation / failed coding
  //      check / multi-ask accounting shortfall / unproven failure stop)
  //   2. bounce ONCE per bound with the SPECIFIC gaps named
  //   3. after the bound: accept with a verification note (verification
  //      never blocks a genuine run; an unsupported "verified" claim is
  //      downgraded, not argued with)
  reviewCompletion(run, call, output) {
    const summary = String(output.summary || '');
    const claimsSuccess = output.success !== false;
    const claimsVerified = call.input?.verified === true;
    const honestlyBlocked = output.success === false && output.final === true
      && hasVerifiedExternalBlock(run.latestObservation, output);

    // Specific bounded bounces (≤2 each): choice-in-summary and
    // fixable-problem. Each prevents a real, named failure mode.
    if (claimsSuccess && output.success !== false) {
      const asksUserToPick = /(?:tell me which|which (?:apps?|games?|option|approach|path|one|method)|pick one|choose one|let me know which|specify which|inform me which|need (?:you|the user) to (?:choose|pick|select|specify|name)|want (?:me|the agent) to (?:choose|pick)|select (?:an? )?(?:option|approach|path))\b/i.test(summary);
      const offersAlternatives = /(?:specific apps?|per-app|app[- ]?only|option[\s\S]{0,200}option|1\)[\s\S]{0,200}2\)|\b[A-Ca-c1-3]\)\s)/i.test(summary);
      if (asksUserToPick && offersAlternatives) {
        run.choiceInSummaryBounces = (run.choiceInSummaryBounces || 0) + 1;
        if (run.choiceInSummaryBounces <= 2) {
          return {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'choice_in_summary',
            error: 'You are asking the user to pick an option in your done summary. That is what ask_user is for — use ask_user with your question and numbered options and WAIT for the reply. Do NOT end the run to ask. If a feasible option needs no user input (for example per-app spoofing needs no admin), TRY IT NOW instead of ending.'
          };
        }
      }
    }
    if (output.success === false && output.final === true) {
      const fixableProblem = /(?:exits?\s+(?:with\s+)?(?:code|status)|does\s+not\s+(?:work|run|launch|start|stay|pass)|doesn'?t\s+(?:work|run|launch|start|stay|pass)|is\s+(?:broken|crash(?:es|ing)?|fail(?:s|ing)?|not\s+(?:running|passing|working|staying))|fails?\s+to|could\s+not\s+(?:be\s+)?(?:creat|build|launch|start|run|install|verif)|immediate\s+(?:close|exit|quit)|closes?\s+(?:immediately|right\s+away)|refuses?\s+to\s+(?:stay|stay\s+alive|run|start)|the\s+source\s+code\s+explains|the\s+cause\s+is|the\s+(?:bug|issue|problem|error)\s+is\s+(?:in|caused\s+by|that)|needs?\s+(?:a\s+)?(?:code\s+)?(?:fix|patch|change|update)|should\s+(?:be\s+)?(?:fixed|patched|changed|updated|modified))/i.test(summary);
      if (fixableProblem) {
        run.fixableBlockBounces = (run.fixableBlockBounces || 0) + 1;
        if (run.fixableBlockBounces <= 2) {
          return {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'unverified_external_block',
            error: 'final:true is reserved for external blocks you cannot resolve (user denied admin, network down, OS permission). You described a fixable problem — a code bug, build error, or startup failure. Fix it with computer_patch / computer_write and verify the fix, or if you truly cannot fix it, name the external blocker that prevents the fix.'
          };
        }
      }
    }

    // The named-gap audit for success claims.
    if (claimsSuccess) {
      const gaps = [];
      const openItems = (Array.isArray(run.plan) ? run.plan : []).filter((item) => !['done', 'skipped'].includes(String(item?.status || '')));
      const ownSubagents = typeof run.subagentApi?.list === 'function'
        ? (run.subagentApi.list().subagents || []).filter((sub) => sub.parentRunId === run.id && ['queued', 'running'].includes(String(sub.status)))
        : [];
      if (openItems.length) {
        gaps.push(`plan items open: ${openItems.length} (${openItems.map((item) => String(item?.text || item?.id || '').slice(0, 40)).join('; ').slice(0, 200)})`);
      }
      if (ownSubagents.length) {
        gaps.push(`subagents still working: ${ownSubagents.map((sub) => sub.alias).join(', ')}`);
      }
      const askCount = I.requestInstructionCount(run.task);
      if (I.isMultiAskTask(run.task) && askCount > 0 && I.countAccountingLines(summary) < askCount) {
        gaps.push(`the request holds about ${askCount} instructions but the summary accounts for ${I.countAccountingLines(summary)} — write one DONE:/SKIPPED: line per instruction`);
      }
      if (claimsVerified && !honestlyBlocked) {
        const { open: openRequirements } = settleRequirementLedger(run, summary);
        if (openRequirements.length) {
          gaps.push(`requirement ledger open: ${openRequirements.map((req) => `${req.id}) "${String(req.text).slice(0, 60)}"`).join('; ')} — no observed-effect evidence covers them yet`);
        }
        const contradictsVerified = /(?:could not|cannot|can't|unable to|did not|didn't|failed to|not)\s+(?:be\s+)?(?:creat|verif|confirm|complet|build|launch|start|run|install)/i.test(summary)
          || /(?:still\s+blocked|remains?\s+(?:blocked|incomplete|unverified|unconfirmed)|not\s+(?:yet\s+)?(?:created|verified|confirmed|built|launched|started|running|installed))/i.test(summary);
        if (output.success === false || contradictsVerified) {
          gaps.push('verified:true contradicts your own report (the summary says the outcome is incomplete or unverified)');
        }
        const unbacked = unbackedActionClaims(summary, { history: run.history, visualEvidence: run.visualEvidence, visualLedger: run.visualLedger });
        if (unbacked.length) {
          gaps.push(`claims this run's tool history does not show: ${unbacked.join('; ')}`);
        }
        const pageReflectsChanges = !run.pageChanges?.size || I.stalePageFiles(run, run.tabId).length === 0;
        const hasRealVisualEvidence = pageReflectsChanges && (
          Boolean(run.visualEvidence?.data)
          || Boolean(run.frameEvidence && run.frameEvidence.at > I.lastPageChangeAfter(run, run.frameEvidence.url)))
          || (Array.isArray(run.attachments) && run.attachments.some((item) => item?.kind === 'image'));
        if (/\bscreenshots?\s+(?:confirms?|shows?|verif(?:ies|ied)|proves?|demonstrates?)\b|\bper\s+(?:the\s+)?screenshots?\b|\bscreenshot\s+evidence\b/i.test(summary) && !hasRealVisualEvidence) {
          gaps.push('the summary cites screenshot evidence but this run holds no real screenshot or image attachment');
        }
        // Real-verification debt: at least one evidence-producing tool call
        // since the last confirmed change on NATIVE turns (browser turns are
        // verified by the harness's own re-observation).
        const turnStartedAt = Number(run.turnStartedAt || 0);
        const turnEntries = turnStartedAt > 0
          ? (Array.isArray(run.history) ? run.history : []).filter((entry) => Number(entry?.at || 0) >= turnStartedAt)
          : (Array.isArray(run.history) ? run.history : []);
        const turnToolCalls = turnEntries.filter((entry) => !['browser_done', 'agent_advisory', 'update_plan', 'create_plan', 'computer_file'].includes(String(entry?.tool || '')));
        const lastMutationIndex = turnEntries.reduce((acc, entry, index) => (I.historyEntryMutated(entry) && I.historyEntryConfirmsChange(entry) ? index : acc), -1);
        const evidenceEntry = lastMutationIndex >= 0 && turnEntries.slice(lastMutationIndex + 1).find((entry) => I.historyEntryVerified(entry));
        const turnHasNativeWork = turnEntries.some((entry) => String(entry?.tool || '').startsWith('computer_') && String(entry?.tool || '') !== 'computer_file');
        const freshObservation = Number(run.coordinator?.observationRevision || 0) >= Number(run.requiredEvidenceRevision || 0);
        if (turnToolCalls.length && lastMutationIndex >= 0 && !evidenceEntry && !(turnHasNativeWork === false && freshObservation)) {
          gaps.push('no evidence-producing tool call since the last confirmed change — run the verification command or capture the proof');
        }
      }
      if (requiresFileMutation(run.task) && !fileMutationSatisfied(run)) {
        gaps.push('the task explicitly requests a file edit, but no file mutation has landed in this turn');
      }
      if (!codingCheckSatisfied(run)) {
        gaps.push('the requested test/check for this coding task has not completed successfully yet');
      }
      if (output.success === false && !honestlyBlocked) {
        const externalBlocker = /\b(log ?in|sign ?in|password|captcha|2fa|two-factor|permission denied|access denied|only (you|the user)|needs? (your|the user'?s?) (input|approval|action|decision)|payment)\b/i.test(summary);
        const failureLadder = run.failureLadder || { tools: new Set(), researched: false, postResearchActions: 0 };
        const missingRungs = [];
        if (failureLadder.tools.size < 2) missingRungs.push('try every known way first');
        if (!failureLadder.researched) missingRungs.push('research alternative ways around the problem (research_task or web_search)');
        if (failureLadder.postResearchActions < 1) missingRungs.push('make at least one new attempt combining what you know with what the research found');
        if (!externalBlocker && missingRungs.length) {
          gaps.push(`failure stop lacks proof of exhausted options: ${missingRungs.join('; ')}`);
        }
      }

      if (gaps.length && run.completionReviewBounces < 2 && (claimsVerified || claimsCompletion(summary) || output.success !== false)) {
        run.completionReviewBounces += 1;
        run.completionReviewForced = true;
        run.completionCandidate = {
          summary: summary.slice(0, 1_000),
          observationRevision: run.coordinator.observationRevision,
          completedWorkCount: run.coordinator.completedWork.length
        };
        return {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'completion_review',
          error: `Completion audit — these named gaps stand between your summary and the goal: ${gaps.join(' · ')}. `
            + 'Close each one with evidence (a fresh probe, a read-back, a test result, a file on disk) or state it skipped with a reason, then return browser_done again. '
            + 'Re-verify an uncertain claim with one corrected probe; never by re-executing a completed flow.'
            + `${I.multiAskChecklist(run.task)}`
        };
      }
      // Bound reached: accept. An unsupported verified claim is DOWNGRADED
      // with a note — never argued with, never fabricated.
      if (gaps.length && claimsVerified && output.success !== false) {
        return {
          ...output,
          verified: false,
          verifiedDowngraded: true,
          verificationNote: gaps.join(' · ').slice(0, 600),
          verificationSource: 'completion_review'
        };
      }
    }
    return output;
  }

  waitForApproval(run, call) {
    run.status = 'awaiting_approval';
    const pendingApproval = {
      id: crypto.randomUUID(),
      tool: call.name,
      args: redactArgs(call.name, call.input),
      reason: approvalReason(call, run)
    };
    run.pendingApproval = pendingApproval;
    this.publish('approval.required', run, { approval: pendingApproval });
    return new Promise((resolve) => { run.approval = resolve; }).then((approval) => {
      run.approval = null;
      run.pendingApproval = null;
      if (run.status !== 'cancelled') run.status = 'running';
      this.publish('approval.resolved', run, { decision: approval.decision });
      return approval;
    });
  }

  resolveApproval(run, result) {
    const resolve = run.approval;
    if (resolve) resolve(result);
  }

  // ask_user: pause the run and wait for the user's text reply.
  waitForUserInput(run, question, options) {
    run.status = 'awaiting_input';
    const pendingQuestion = {
      id: crypto.randomUUID(),
      question: String(question || '').slice(0, 4000),
      options: String(options || '').slice(0, 4000)
    };
    run.pendingUserQuestion = pendingQuestion;
    this.publish('user.input.required', run, { question: pendingQuestion });
    return new Promise((resolve) => { run.userInputResolver = resolve; }).then((reply) => {
      run.userInputResolver = null;
      run.pendingUserQuestion = null;
      if (run.status !== 'cancelled') run.status = 'running';
      this.publish('user.input.received', run, { reply });
      return reply;
    });
  }

  resolveUserInput(run, text) {
    const resolve = run?.userInputResolver;
    if (resolve) { resolve(String(text || '')); return true; }
    return false;
  }

  // Eager and speculative executions the decision never consumed are still
  // REAL executions. Record each eager one exactly once before the run
  // settles.
  drainEagerResults(run) {
    if (!(run.eagerResults instanceof Map) || !run.eagerResults.size) return;
    const pending = [...run.eagerResults.values()];
    run.eagerResults.clear();
    for (const entry of pending) {
      const call = entry && typeof entry === 'object' ? entry.call : null;
      const output = entry && typeof entry === 'object' && entry.output !== undefined ? entry.output : entry;
      if (!call || !output || typeof output !== 'object' || call._speculative) continue;
      this.record(run, call, output);
      this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
    }
  }

  record(run, call, output, storedOutput = output) {
    // Every attempt is kept, including rejected ones (bounded by the review's
    // own bounce ceiling, not by erasing evidence).
    run.history = [...run.history, {
      at: nextTimelineAt(run),
      step: run.step,
      tool: call.name,
      input: redactArgs(call.name, call.input),
      ...(call.callId ? { callId: call.callId } : {}),
      expect: normalizeExpectation(call.expect),
      repeat: call.repeat === true,
      ...(output?.media && typeof output.media === 'object' ? { media: output.media } : {}),
      ...(call.advisory ? { note: String(call.advisory).slice(0, 500) } : {}),
      output: redactOutput(call.name, storedOutput, call.input)
    }].slice(-80);
    run.turnLedger?.record(run.history.at(-1));
  }

  // Progress assertion (DSH: advisory only — no watchdog accounting).
  assertProgress(run, call, output) {
    if (!I.PROGRESS_GUARDED_READ_ACTIONS.has(call.name) && call.name !== 'browser_scroll') return null;
    if (call.name === 'browser_screenshot') return null;
    const observation = output.observation || output.result;
    const fingerprint = I.observationFingerprint(observation);
    const scrollDidNotMove = call.name === 'browser_scroll' && output.result?.moved === false;
    const action = `${call.name}:${JSON.stringify(normalizeProgressInput(call.input))}`;
    const inherentlyPassive = call.name === 'browser_wait';
    if (!fingerprint || observation?.navigation?.loading || observation?.loading) {
      const repeated = action === run.loopState.recentActions.at(-1);
      run.loopState.unchangedPages = 0;
      run.loopState.recentActions = [...run.loopState.recentActions, action].slice(-4);
      run.loopState.noProgressActions = scrollDidNotMove || inherentlyPassive || repeated ? run.loopState.noProgressActions + 1 : 0;
      run.loopState.lastFingerprint = fingerprint || null;
    } else {
      const repeated = fingerprint === run.loopState.lastFingerprint && action === run.loopState.recentActions.at(-1);
      run.loopState.lastFingerprint = fingerprint;
      run.loopState.recentActions = [...run.loopState.recentActions, action].slice(-4);
      run.loopState.unchangedPages = repeated ? run.loopState.unchangedPages + 1 : 0;
      run.loopState.noProgressActions = repeated || scrollDidNotMove ? run.loopState.noProgressActions + 1 : 0;
    }
    if (run.loopState.noProgressActions >= 3) {
      run.loopState.noProgressActions = 0;
      run.loopState.unchangedPages = 0;
      return `The latest ${call.name} result produced no observable page change. Treat it as evidence: repeating the same read will not help. Change approach or execute the next grounded action now; inspect again only if a prior action could have changed the state.`;
    }
    return null;
  }

  publish(type, run, payload) {
    run.eventRevision = (run.eventRevision || 0) + 1;
    if (type !== 'assistant.thinking') run.lastRealActivityAt = Date.now();
    const terminal = ['run.started', 'run.completed', 'run.failed', 'run.cancelled'].includes(type);
    const eventRun = terminal ? serializeRun(run) : serializeEventRun(run);
    const event = { type, revision: run.eventRevision, run: eventRun, ...payload };
    const metricEvent = event.screenshotPreview
      ? { ...event, screenshotPreview: { ...event.screenshotPreview, data: '[ui-only image]' } }
      : event;
    try { run.coordinator.metrics.eventBytes += Buffer.byteLength(JSON.stringify(metricEvent)); } catch {}
    this.emit(event);
    if (this.onCheckpoint && ['run.started', 'plan.updated', 'tool.result', 'user.message.queued', 'user.message.delivered', 'approval.required', 'approval.resolved', 'run.cancelled', 'run.completed', 'run.failed'].includes(type)) {
      try { this.onCheckpoint(checkpointSnapshot(run)); }
      catch (error) { this.emit({ type: 'persistence.error', run: serializeEventRun(run), error: error.message }); }
    }
  }
}

module.exports = {
  // Additive (DSH): prompt assembly exported for tests and tooling.
  assembleSystemPrompt, runtimeContextText,
  DesktopChatAgent, isMultipartTask, isMultiAskTask, multiAskChecklist, ACTIONS,
  externalProviderBlock, MAX_BROWSER_WAIT_MS, EFFORT_TIERS, normalizeEffortSetting,
  normalizeEffortTier, nextEffortTier, applyEffortEscalation, defaultResearchAgent,
  inspectionValue, archiveToolResult, toolDefinitions,
  isTaskAddition, turnBoundaryNotice, steeringAdditionNotice, steeringReplacementNotice,
  normalizeToolCalls,
  isAnswerOnlyTask, isAnswerOnlyRequest, isAnalysisOnlyRequest, claimsCompletion, turnHasMutations,
  remainingRunMs,
  executeAction,
  normalizeAttachments,
  advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective, settleObjectiveLedgerOnTerminal, activeObjectiveEntry
};
