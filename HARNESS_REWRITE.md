# Browser-use × DeepSeek Harness — Master Rewrite Blueprint

> **Status**: living document. Every rewrite step below is verified against this file.
> **Source of truth for patterns**: `C:/Users/london/Desktop/deepseek/deepseek-harness` (studied: `packages/core/system-prompt`, `agent-loop`, `tools`, `tool-executor-native/-ptc`, `compaction/*`, `guard/*`, `goal/*`, `docs/agent-lifecycle.md`, `docs/tool-execution-pipeline.md`, `docs/defensive-patterns/general.md`).
> **Fork**: `C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork` (full working-tree snapshot; original at `C:/Users/london/Desktop/browser-use/browser-use` is untouched; baseline commit taken before any edit).

---

## 0. Why this rewrite exists

The current agent (`desktop/agent/desktopChatAgent.cjs`, 7,797 lines) grew by accretion through gen1→gen5 patch cycles (`README_PATCH_HARNESS_GEN3_SHIP.md`, `README_PATCH_STALL_CEILINGS.md`, `README_PATCH_AGENT_EFFORT.md`, …). Its decision loop (`recoveryLoop`, L2231–3581) interleaves at least nine overlapping control layers:

| # | Old mechanism | Location (old file) | Problem |
|---|---|---|---|
| 1 | `recoveryLoop` while-run | 2231–3581 | monolith: observation, notices, decisions, execution, done-gates in one 1,350-line body |
| 2 | stall heartbeat (`startStallHeartbeat`) | 3583–3615 | parallel watchdog #1, fires recoverable aborts, counts `watchdogFires` → park |
| 3 | decision watchdog (`withDecisionWatchdog`) | 3627–3751 | parallel watchdog #2 (120 s dead-air) + reasoning-budget ladder inside the same function |
| 4 | park/escalate (`parkOnDeadline`, `escalateRun`) | 3753–3794 | third policy layer; auto-resume timer |
| 5 | `scheduleRecovery` fingerprint machinery | 3796–3868 | "materially different" demand, unbounded fingerprints, one-shot E2 notices |
| 6 | flow control scoring (`flowControlState.cjs`) | whole file | one advisory + bounded recovery bounce, fourth veto-ish layer |
| 7 | enforcement gates E1–E12 + done-gate maze | 2408–2416, 3059–3186, 4657–5436 | self-conflicting: multiple gates can bounce the same call for different reasons; bounce prose scattered across 14 sites |
| 8 | effort tiers + reasoning budget | 423–576, 3653–3703 | prompt-tier escalation policy competing with provider-level reasoning effort |
| 9 | harness notice prose (14 texts) | 1041…5233 | unlabeled, unsourced guidance injected ad hoc |

The system prompt is equally fragmented: `V4_AGENT_PROMPT` + `AGI_PROMPT` + `MODELING_PLAYBOOK` (`computerCatalog.cjs` L163–242), `providerSystemPrompt()` + effort prompts (`openAiCompatibleProvider.cjs` L47–157), `REPLY_STYLE_PROMPT` (`replyStyle.cjs`), `PUBLIC_FEEDBACK_INSTRUCTION` (`providers/wire.cjs` L24), `REPAIR_SCHEMA_PROMPT` (`ollamaProvider.cjs`), `SUMMARY_PROMPT` (`providerTurnLedger.cjs` L11), research/recorder prompts, plus per-tool description prose. **No single owner defines who the agent is, how it must format output, or when it may stop** — each layer restates overlapping rules with slightly different wording, which is exactly the "self-conflicting system prompt" this rewrite removes.

**Rewrite rule (from deepseek-harness):** one owner per concern. The harness owns the prompt (named ordered sections), the loop (turn/step over a durable log), the recovery policy (uniform retry-then-park), the tool pipeline (log → guards → approval → timeout → execute → normalize), and identity (fixed one-liner + persona prefix/suffix). Everything else is functionality and must survive verbatim.

---

## 1. The DeepSeek Harness pattern spec (what we are copying)

Condensed from the study of `deepseek-harness` (43-point spec; the points below are the ones that apply to this codebase):

### 1.1 System prompt
1. Prompt = **registry of named, ordered sections**; one centrally owned order table. No monolithic template string.
2. Fixed minimal identity line registered by the harness itself: *"You are an AI agent powered by <Harness>."*
3. Persona = **prefix/suffix pair** under reserved section names (`deployment:persona-prefix` / `-suffix`); per-agent registrations *shadow* by name — they never duplicate.
4. Sections render in order; empty sections vanish; join with `\n\n`; strict `{{variable}}` interpolation (unknown/undefined → throw, never silent).
5. **Volatile facts** (cwd, time, current tab, sandbox/approval mode) are NOT in the system prompt — they ride a separate ordered *runtime-context snapshot* delivered as a user message whose header says it *supersedes earlier snapshots*; written only when it changed. This keeps the cached prompt prefix stable.
6. **Tools own their prompt guidance**: each tool registers its guidance section next to its registration, emitted only when the tool is active.
7. A `complete` section mode may replace the whole prompt (full-persona replacement).

### 1.2 Tool schema advertisement
8. Tools are defined through one DSL: `defineTool({ name, description, parameters, execute })`; per-property `required`.
9. **Model-visible schema is exactly `{ name, description, parameters }`** — timeouts, concurrency, presenters never leak.
10. Tool descriptions carry *behavioral contracts* in imperative prose (truncation behavior, denial format, safety checks).
11. Canonical tool order: explicit list with `<unlisted-tools>` rest marker, else lexicographic.
12. Per-step tool admission (`resolve` + `when`): inactive tools are excluded from both declaration and dispatch, silently; a *failing* condition is a step error.
13. Every tool declares an output schema + pure `render` projection; failures are structured `{ isError, error: { message, info: { code } } }` — raw exceptions never reach the model.

### 1.3 Agent loop
14. **Turn** = user boundary; **step** = one model call + its tool batch. Loop continues while steering input (`next-step`) remains.
15. Everything durable is an event on the session log (`turn/start|end`, `step/start|end`, `assistant/message|attempt`, `tool/call|result`, inbox splices). Requests are **derived from the log**, then frozen — no parallel mutable history.
16. Two inbox queues: `next-turn` (one prompt per turn) and `next-step` (steering/injections claimed at each step boundary).
17. Retry happens **inside the open step** via a request-error decision (`{ kind: 'retry' }`); user input is never re-admitted on retry.
18. Pending tool results are recovered even when the step fails — a tool call never dangles without its result in the log.
19. `max-tokens` (undecidable output) is sticky for the turn.
20. Cancellation: typed causes, abort checks after every await, partial streams settle as `interrupted`.
21. Hooks are ordered, scoped waterfalls at fixed seams: `pre-step`, `request`, `request-error`, `turn-stopping` — not hardcoded branches.
22. Tool execution is bounded (deepseek default: 10 parallel; **this fork keeps sequential execution** because browser actions are stateful — the bound is 1, preserved as an explicit constant).

### 1.4 Tool execution pipeline (fixed order)
23. log `tool/call` → pre-execute waterfall (approval) → **monotonic deny-only guards** (no listener order can resurrect a denial) → approval (absent = deny) → timeout wrapper (structured `TOOL_TIMEOUT`) → tool body → normalize (throws → `isError` results) → post-execute waterfall → frozen result event → additional contexts ride into the next request after tool results.

### 1.5 Recovery, guards, compaction
24. **Guards are advisory first**: sourced context messages nudge the model (repeat-call detector: canonical-argument comparison, thresholds 3/5/8, gentle → detailed reminder). Hard denials are reserved for policy (approval).
25. Timeouts are cooperative and produce structured, routable error codes.
26. **Uniform failure model**: classify → structured record → retry-with-backoff inside the step for transport errors → park (`awaiting_recovery`) + auto-resume for anything else. **Recovery is indefinite** (owner directive, `README_PATCH_STALL_CEILINGS.md`): parking never terminates the run.
27. Compaction triggers: pressure at step boundaries + context-overflow on request error (retry only when the replacement actually advanced); summarizer reuses the conversation's own prefix (cache-friendly) and lands a structured, sectioned summary that never mentions compaction.
28. Failure facts are preserved: every error carries a code; unknown errors flatten to text under `UNKNOWN`.

### 1.6 Identity
29. Agent id == session id; the agent owns a scope; identity is the fixed harness line + persona prefix/suffix sections.

---

## 2. Functionality that MUST survive (completeness checklist)

Each item: **where it lives today → what happens in the rewrite**. This is the checklist the final verification walks. (Old file = old `desktopChatAgent.cjs` line refs from the inventory.)

### A. Runtime orchestration (keep verbatim)
- [ ] `src/index.js` all modes (stdio MCP / mcp-http / ws+control-center / smoke / script / command / agent / headed) — untouched.
- [ ] `src/config.js` flag+env surface — untouched.
- [ ] `src/seaBootstrap.cjs`, `browser-use.bat/.ps1`, `sea-config*.json`, `daemon/mcp-daemon.ps1` — untouched.
- [ ] `src/replay.js`, `src/upstream/runtime.js` — untouched.

### B. Browser layer (keep verbatim)
- [ ] `src/browser/*`: chromeLauncher, cdpClient, browserPool, input.js (incl. `:has-text` selectors, 1–10,000 ms wait contract), screenshot, domSnapshot, diagnostics, gestureEngine, touchOverlay, elementPicker, deviceProfiles, nativePointer — untouched.
- [ ] `desktop/mcp/browserViewController.cjs` (real tool implementations, captcha human-wait, pointer allow-listing, DOM collector w/ `\s` fix) — untouched.
- [ ] `desktop/mcp/localMcpServer.cjs`, `sessionBroker.cjs`, `deviceEmulator.cjs`, `debuggerLeaseManager.cjs`, `desktop/agent/mcpClient.cjs` — untouched.

### C. Tool surface (kept; advertisement re-expressed through the new schema layer)
- [ ] `ACTIONS` catalog + `browserTools` names/args (`browser_navigate … browser_done`, 46 tools) — names and arguments **byte-compatible**; descriptions rewritten into deepseek imperative-contract style (same behavioral content, one voice).
- [ ] `COMPUTER_TOOLS` catalog + validation/normalization (`computerCatalog.cjs`) — schemas/validation kept; prompt constants removed from this file (see §4).
- [ ] `deferredToolCatalog.cjs` tiering (core/compact/full) — kept; no tool hidden or gated.
- [ ] `toolExecutor.js` evidence envelope + action trace cap 300, `verification.js`, `permissions.js` risk classes — untouched.
- [ ] `cli/computerToolsBackend.cjs`, `cli/cliAgentApis.cjs`, `cli/cliAndroidApi.cjs`, `cli/stubs.cjs` — untouched.

### D. MCP stack (keep verbatim)
- [ ] `src/mcp/*`: stdio server, HTTP streamable + SSE, sessionStore, mcpAuth, mcpDispatch, gptBridge, `prompts/browser-use-agent-card.md` (remains an MCP prompt resource; its guidance text is updated to match the new prompt — same role, new owner), mcpAdapter.

### E. Servers / UI / realtime (keep verbatim)
- [ ] `src/server/websocketServer.js` + `eventBus.js` (NDJSON logs), `src/realtime/*` (frameStreamer, inputScheduler, realtimeServer), `src/ui/controlCenter.js`, `src/pairing/pairingService.js`, `src/session/browserSession.js`.
- [ ] `desktop/main.cjs` shell, `preload.cjs`, `webBridge.cjs`, `desktop/renderer/*`, `desktop/pointer/agentPointerOverlay.cjs`, `desktop/terminal/*`.
- [ ] `cli/tui.mjs` + `cli/tui/*` (App, guiBackend/guiServer/webShell, appConfig, screen/mouse, historyView, store/theme/registry).
- [ ] `cli/webContentsAdapter.cjs` — untouched.

### F. Provider transports (plumbing kept; prompt text removed)
- [ ] `providers/wire.cjs` streaming/token budgets/tool-schema wiring — kept; `PUBLIC_FEEDBACK_INSTRUCTION` removed (§4).
- [ ] `providers/retry.cjs` — transport classification (`isTransportError`, `isHardProviderError`) **kept as the classifier**; ladder values retained.
- [ ] `openAiCompatibleProvider.cjs`, `ollamaProvider.cjs`, `responsesProvider.cjs`, `cloudProvider.cjs` request plumbing — kept; `providerSystemPrompt()`, effort prompts, `REPAIR_SCHEMA_PROMPT` removed; providers receive the harness-assembled system prompt instead of authoring one.
- [ ] `visionDelegate.cjs`, `modelCatalog.cjs`, `modelCapabilityProbe.cjs`, `mediaRouter.cjs`, `thinkingStream.cjs`, `wireTokenizer.cjs` — kept.
- [ ] `hcuSession.cjs`, `desktop/agent/hcu*` — kept.

### G. Agent-loop-adjacent functionality (kept — data/plumbing, not policy)
- [ ] `observeRun`/`observe` (old L5819–5961) — kept verbatim (observation is data, not policy).
- [ ] `executeAction` (old L6037–6900) per-tool dispatch — kept verbatim (it is the tool body layer).
- [ ] `requiresApproval`/`approvalReason` (old L6913–6944) — kept (approval policy input).
- [ ] `normalizeToolCalls` (old L6970–7020) — kept.
- [ ] `serializeRun`/`serializeEventRun`/`checkpointSnapshot` (old L7706–7775) — kept verbatim (state serialization contract).
- [ ] `restoreConversationSnapshot` (old L1128–1209) — kept (resume is functionality).
- [ ] `desktopAgentCoordinator.cjs` fingerprints/ledgers — kept as **data providers**; its enforcement *decisions* are re-expressed as pipeline guards/advisories (§5.4).
- [ ] `ProviderTurnLedger` + `adaptiveTokenCompressor` — kept as compaction engines; `SUMMARY_PROMPT` rewritten to the deepseek structured template (§5.6).
- [ ] `interactionMemory.cjs`, `runNotebook.cjs`, `workspacePin.cjs`, `agentResultStore.cjs`, `requestQuote.cjs` (kept: quote-once helper), `runBudget.cjs` deadline parsing (kept: deadline → park trigger).
- [ ] `skillsManager.cjs`, `desktop/knowledge/knowledgeStore.cjs`, `desktop/record/*` (recorder loop kept; its system prompt rewritten §4), `desktop/schedule/*`, `desktop/android/*`.
- [ ] `agentPool.cjs`, `cli/cliSubagents.cjs` pool plumbing + traces, `desktop/research/*` (research loop kept; `SYSTEM_PROMPT` rewritten §4).
- [ ] `instructionLoader.cjs` (lorde.md > AGENTS.md > CLAUDE.md, 8 KB cap) — kept; loaded text becomes a prompt **section** instead of a free-floating block.
- [ ] `replyStyle.cjs` — **deleted**; its rule moves into the persona prefix as one sentence (§5.2).

### H. Persistence (keep verbatim)
- [ ] EventBus logs, ChatHistoryStore, CredentialStore, SkillStore, runNotebook file format, schedulerStore, `~/.browser-use` pairing state, `out-dir/trace.jsonl` + `final-state.json` + `--resume`.

### I. Public API contract (must not break — verified list from consumer scan)
- [ ] `module.exports` of `desktopChatAgent.cjs` keeps **every** name: `DesktopChatAgent, isMultipartTask, isMultiAskTask, multiAskChecklist, ACTIONS, externalProviderBlock, MAX_BROWSER_WAIT_MS, EFFORT_TIERS, normalizeEffortSetting, normalizeEffortTier, nextEffortTier, applyEffortEscalation, defaultResearchAgent, inspectionValue, archiveToolResult, toolDefinitions, isTaskAddition, turnBoundaryNotice, steeringAdditionNotice, steeringReplacementNotice, normalizeToolCalls, isAnswerOnlyTask, isAnswerOnlyRequest, isAnalysisOnlyRequest, claimsCompletion, turnHasMutations, remainingRunMs, executeAction, normalizeAttachments, advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective, settleObjectiveLedgerOnTerminal, activeObjectiveEntry`.
- [ ] Constructor option keys unchanged (all 30 keys incl. `controller, getSelectedTabId, createTab, closeTab, selectTab, focusTab, writeReportFile, modelTaskApi, catalogApi, androidApi, getComputerTools, hcuApi, getControlMode, emit, createProvider, onTerminal, onCheckpoint, titleApi, scheduleApi, spawnTask, skillsApi, messageApi, subagentApi, createResultStore, researchRunner, researchMetaSearch, knowledgeStore, layaVerifierFactory, jevVerifierFactory, notebookDir`).
- [ ] Public methods unchanged: `start(request)`, `state()`, `settleActiveThought`, `handleSlashCommand`, `steer`, `steerNow`, `deliverSteering`, `deliverNativeSurfaceNotice`, `spawnResearch`, `receiveAgentMessage`, `resumeAfterRecovery`, `considerProgramResearch`, `deliverResearch`, `deliverKnowledge`, `verifyWithLaya`, `handleEagerAction`, `cancel`, `approve`, `requireRun`, `executeOrRequestApproval`, `waitForApproval`, `resolveApproval`, `waitForUserInput`, `resolveUserInput`, `drainEagerResults`, `record`, `assertProgress`, `publish`, `forceCompactRun`. **No `stop()` exists; none is added.**
- [ ] `run.status` values unchanged: `starting, running, awaiting_approval, awaiting_input, awaiting_recovery, completed, failed, cancelled` (`paused` never set, only tolerated in consumer checks).
- [ ] Event names + payload shapes unchanged (full list in §6 of the API contract study): `run.started/completed/failed/cancelled/escalated/title`, `assistant.message/thinking/thought/thought.stamp/thinking.completed`, `decision.timing`, `tool.started/result/progress`, `approval.required/resolved`, `user.input.required/received`, `user.message.queued/delivered`, `plan.updated`, `goals.updated`, `context.compacted`, `harness.notice.delivered`, `agent.message`, `agent.fastpath`, `agent.reasoningBudget`, `laya.enabled/verification`, `research.notice`, `program.research.hinted/cached`, `notebook.open`, `computer.cleanup.error`, `persistence.error`.
- [ ] Provider contract unchanged: single `provider.complete(requestObject)` → decision object `{ assistantText?, actions?/toolCalls?, done?, effortNeeded?, effortReason?, thinkingBudgetMs?, mediaAnswer?, mediaAudio? }`; request key set unchanged. Test mocks (`{ done: { summary, success, verified } }`, `{ assistantText }`) keep passing.
- [ ] `start()` resolves only when the run settles; consumers may call `state()` right after.
- [ ] `cli/agent-cli.mjs` observer, exit codes (completed→0, cancelled/timedOut→2, else 1), trace.jsonl event stream — unchanged.
- [ ] `agentRunQueue.mjs` continuation semantics, `harness.queue.*` / `harness.continuation.*` events — unchanged.
- [ ] `cliSubagents.cjs` lifecycle events `harness.subagent.*` — unchanged.

---

## 3. New architecture

```
desktop/agent/
├── harness/                      ← NEW: the DSH-style harness core (all policy lives here)
│   ├── promptRegistry.cjs        ← named ordered sections + persona slots + strict interpolation
│   ├── identity.cjs              ← fixed harness identity line + section-name constants
│   ├── runtimeContext.cjs        ← ordered volatile-fact snapshot (supersedes-earlier user message)
│   ├── toolSchema.cjs            ← defineTool DSL + projectToolSchema ({name,description,parameters})
│   ├── pipeline.cjs              ← tool execution pipeline (call→guards→approval→timeout→body→normalize→record)
│   ├── guards.cjs                ← repeat-call advisory detector + timeout policy (deny-only, advisory-first)
│   ├── inbox.cjs                 ← next-turn / next-step queues (splice + claim)
│   ├── loopPolicy.cjs            ← uniform recovery: classify → retry-in-step (transport) → park+auto-resume
│   └── errors.cjs                ← structured codes (TOOL_TIMEOUT, UNKNOWN_TOOL, PROVIDER_UNREACHABLE, …)
├── prompt/
│   └── sections.cjs              ← NEW: the actual prompt content (browser-use persona, policies,
│                                    tool guidance, AGI modeling section) — the ONLY prompt text home
└── desktopChatAgent.cjs          ← REWRITTEN internals; same file path, same public contract (§2.I)
```

`src/ollama/` — the simple `--agent` loop is rewritten onto the same patterns: `agentLoop.js` becomes a thin turn/step loop over the new `toolSchema`/`pipeline` shapes with the prompt built by a mini registry (`promptBuilder.js` rewritten as sections; `commandParser.js` kept only as the JSON fallback for non-tool-calling models, clearly labeled).

### 3.1 Section order table (the one table that owns prompt layout)

| Order | Section name | Content owner |
|---|---|---|
| -1000 | `harness:identity` | `identity.cjs` — *"You are an AI agent powered by the Browser-use harness."* |
| 0 | `deployment:persona-prefix` | `prompt/sections.cjs` — Browser-use Agent Chat persona: who it serves, the reply-style rule (plain language, no protocol talk — absorbs `replyStyle.cjs` + `PUBLIC_FEEDBACK_INSTRUCTION`), output discipline (one decision per turn: either a tool batch or `browser_done`; never narrate protocol) |
| 500 | `policy:goal` | objective ledger / plan policy (absorbs `update_plan` guidance + goal rounds) |
| 600 | `policy:approval` | approval & unattended-mode statement |
| 700 | `policy:effort` | effort/reasoning-budget statement (single source; kills the tier-prompt ladder) |
| 1000–2900 | `tool:<name>` | per-tool guidance, registered with the tool (absorbs the long use-rules from tool descriptions where they are policy, not contract) |
| 3000 | `tools:catalog-note` | deferred-catalog notice + `tool_schema` usage |
| 3100 | `tools:computer` | AGI/computer-mode section incl. `MODELING_PLAYBOOK`/`DRAWING_PLAYBOOK` content (tool-owned, only in `agi` control mode) |
| 9000 | `context:instructions-file` | user instruction files (lorde.md/AGENTS.md/CLAUDE.md via `instructionLoader.cjs`) |
| 9900 | `policy:completion` | the completion/evidence rule (single statement replacing E1–E12 bounce prose): verify by re-reading evidence, not by re-executing flows; absorbs `COMPLETION_BRIDGE` |
| 10200 | `deployment:persona-suffix` | closing persona line |

**Rules enforced by `promptRegistry.cjs`:** sections join `'\n\n'`, empty ones vanish, duplicate names shadow (scoped over global), `{{var}}` interpolation throws on unknown/undefined, `complete: true` sections replace everything (only one allowed).

### 3.2 Loop semantics (new `desktopChatAgent.cjs` internals)

```
start(request)
 ├─ throw if live; build run (same fields/events as before: status 'starting' → 'running', run.started)
 ├─ restore snapshot / continuation / notebook / deadline (kept verbatim from old 1667–2230)
 └─ await runLoop(run):
      turnLoop: while run.status === 'running' and not aborted:
        step:
          1. CLAIM INBOX  — steering (next-step) first, else continue current turn
          2. PRE-STEP     — deadline check (runBudget) → park; compact-if-pressure (ledger)
          3. OBSERVE      — observeRun + withinStepTimeout (kept verbatim); failure → park after
                            repeated observation failures (counter, advisory notice, no ceiling)
          4. DELIVER      — research / knowledge / laya verify / native-surface notices (kept)
          5. ASSEMBLE     — prompt registry render + runtime-context snapshot (supersedes header)
                            + buildToolCatalog(toolDefinitions(...)) (unchanged shape)
          6. DECIDE       — provider.complete(...) with:
                              • in-step transport retry via providers/retry.cjs ladder
                                (request-error waterfall: isTransportError → retry, else → step error)
                              • empty/undecidable decision → one sourced schema-repair notice,
                                sticky per turn (replaces REPAIR_SCHEMA_PROMPT scatter)
                              • thinkingBudget: single policy in loopPolicy.cjs (one cap, one cut event)
          7. EXECUTE      — for each normalized call, pipeline:
                              tool/call record → approval (requiresApproval/waitForApproval kept)
                              → deny-only guards (coordinator canAttempt/fillGate/constraintTamper
                                demoted to ADVISORY notices; approval remains the only hard deny)
                              → timeout wrapper (TOOL_TIMEOUT structured result)
                              → executeAction (verbatim) → normalize throws → isError envelope
                              → record() + assertProgress() (kept)
                            batch ends when a call concludes the turn (browser_done) or fails hard
          8. DONE         — browser_done concludes the turn: single completion-review advisory
                            (evidence-vs-claim check from coordinator facts; one sourced notice if
                            unbacked; accepted either way — no bounce spirals)
          9. RECOVER      — step error: classifyFailure (kept taxonomy) → structured recovery record
                            → park (status 'awaiting_recovery' + run.escalated + auto-resume timer
                            with backoff) — recovery is INDEFINITE (owner directive preserved)
        until turn concludes (done / cancelled / no pending steering)
 ├─ terminal finalize (kept: missing_terminal_result guard as a *repair*, run.completed/failed/cancelled)
 └─ return serializeRun(run)
```

**Deleted entirely:** `startStallHeartbeat`, `withDecisionWatchdog` (incl. reasoning-budget ladder), `parkOnDeadline`'s separate park state machine, `escalateRun`, `scheduleRecovery` fingerprint machinery, `flowControlState.cjs` scoring, effort-tier prompt escalation (`applyEffortEscalation` demoted to a no-op passthrough kept only for export compatibility), E1–E12 gate bounce prose, all 14 ad-hoc harness notice texts, `WAIT_BACKOFF_MS` ladder (replaced by `loopPolicy.cjs` single backoff), `ESCALATION_PARK_FIRES`.

**Kept alive (contract):** `EFFORT_TIERS`, `normalizeEffortSetting`, `normalizeEffortTier`, `nextEffortTier` remain exported (tests/UI import them) but tier *promotion* no longer rewrites prompts; `effort` flows to the provider as `ModelSelection.reasoningEffort`-style config (deepseek pattern: model selection carries effort, prompts don't).

### 3.3 Recovery model (replaces five overlapping mechanisms)

One function, `loopPolicy.cjs → recover(run, failure)`:

1. **Classify** with the kept `classifyFailure` taxonomy (INVALID_INPUT / TRANSIENT / STALE_STATE / SCOPE / NO_EFFECT / CONFLICT / LOOP / EVIDENCE_MISSING / PROVIDER_BLOCK / UNCLASSIFIED).
2. **Record** a structured recovery entry on the run (`{ attempt, failureClass, source, code, message }`) — replaces fingerprints with a bounded ring (last 8, as today).
3. **Transport-class failures** (provider): retry inside the open step on the existing ladder (5 s→240 s, `RETRY_DELAYS_MS`); each retry re-prepares the same assembled request (no user re-admission).
4. **Everything else**: park once — `status: 'awaiting_recovery'`, `run.escalated`, publish `run.escalated`, schedule auto-resume with backoff (env-tunable, default 60 s). `resumeAfterRecovery` (public API) re-enters the loop with a single sourced recovery notice: *"Recovery attempt N after <failureClass>: treat prior tool results as authoritative evidence; re-verify the uncertain claim with one corrected probe; never by re-executing a completed flow."*
5. **No ceiling.** Parking never terminates. Deadline is the only external stop (park on deadline, as today).

### 3.4 Guards (advisory-first, deny-only)

- `repeat-call`: canonical-argument hash (reuse `actionHash` from the coordinator); identical consecutive calls at 3 → gentle sourced reminder; 5 → detailed (tool, count, args preview ≤500 chars); 8 → detailed + escalation note. Never vetoes.
- `timeout`: cooperative — every tool body executes under `withToolTimeout` from `pipeline.cjs`; expiry produces `{ isError: true, error: { message, info: { code: 'TOOL_TIMEOUT' } } }`.
- `approval` remains the ONLY hard deny (unchanged `requiresApproval`/`approvalReason`/`waitForApproval`).
- Coordinator checks (`fillGate`, `constraintTamper`, `presentationTamper`, `staleAnchor`, `canAttempt`) are demoted from gate to **sourced advisory** results: the call executes unless approval denies; the advisory rides the result as `additionalContext`.

### 3.5 Compaction

- Triggers: pressure check at pre-step (ledger tokens) + overflow on provider error (context-overflow code → compact → retry once when the surface advanced).
- Engine: `ProviderTurnLedger` (kept) with the rewritten structured summary template (fixed sections: Primary Request and Intent / Key Evidence / Files and Pages Touched / Errors and Fixes / Current Work / Next Step / Critical Context) delivered as the **final user message** reusing the conversation prefix; landed summary carries the checkpoint preamble ("treat as established background; continue directly; never mention this checkpoint").
- `/compact` slash command → `forceCompactRun` (kept).

### 3.6 Identity

`identity.cjs`:
```js
IDENTITY_LINE = 'You are an AI agent powered by the Browser-use harness.'
PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix'
```
Persona prefix (in `prompt/sections.cjs`) names the agent **Browser-use Agent Chat** (preserving the product identity users see), states the service relationship, the plain-language reply rule, and the output discipline. Every other file loses its prompt text.

---

## 4. Prompt inventory → disposition table (every old text accounted for)

| Old prompt/guideline text | Old location | Disposition |
|---|---|---|
| Simple agent system prompt | `src/ollama/promptBuilder.js` L5 | rewritten as mini registry sections (§3) |
| `V4_AGENT_PROMPT` (gen5 chat harness prompt) | `computerCatalog.cjs` L163–181 | deleted; content redistributed into persona prefix + `policy:*` + `tool:*` sections |
| `AGI_PROMPT` / `agiPromptForTask` | `computerCatalog.cjs` L220–242 | deleted; AGI-mode guidance becomes `tools:computer` section |
| `MODELING_PLAYBOOK` / `DRAWING_PLAYBOOK` | `computerCatalog.cjs` L189–198 | moved into `tools:computer` section (content preserved, tool-owned) |
| `providerSystemPrompt()` ("You are Browser-use Agent Chat…", anti-restate rules) | `openAiCompatibleProvider.cjs` L47–54 | deleted; replaced by identity + persona prefix; providers no longer author prompts |
| Effort-tier prompts + escalation channel prompt | `openAiCompatibleProvider.cjs` L144–157 | deleted; effort is model-selection config (§3.2) |
| `REPLY_STYLE_PROMPT` | `replyStyle.cjs` L7–13 | file deleted; one sentence in persona prefix |
| `PUBLIC_FEEDBACK_INSTRUCTION` | `providers/wire.cjs` L24 | deleted; covered by persona prefix output discipline |
| `REPAIR_SCHEMA_PROMPT` | `ollamaProvider.cjs` | deleted; replaced by sticky schema-repair notice from `loopPolicy.cjs` |
| `SUMMARY_PROMPT` + `EVIDENCE_RULE` | `providerTurnLedger.cjs` L11–13 | rewritten to structured template (§3.5); `EVIDENCE_RULE` principle kept verbatim inside it |
| Research `SYSTEM_PROMPT` | `researchAgent.cjs` L67–72 | rewritten in same imperative style (kept minimal) |
| Recorder `RECONSTRUCTION_SYSTEM_PROMPT` | `recorder.cjs` L22–26 | rewritten in same imperative style |
| Vision `DEFAULT_VISION_PROMPT` | `visionDelegate.cjs` | kept (it is a *model input format*, not harness policy) — lightly edited for style only |
| 14 harness notice texts | `desktopChatAgent.cjs` scattered | deleted; replaced by sourced notices from the new systems (recovery notice §3.3, repeat-call §3.4, completion advisory §3.2-8, deadline notice from `runBudget` park, observation advisory) |
| Long use-rules inside `BROWSER_TOOL_DESCRIPTIONS` / `SKILL_TOOL_DESCRIPTIONS` / `COMPUTER_TOOLS` descriptions | `desktopChatAgent.cjs` L7398–7527, `computerCatalog.cjs` L23–131 | **behavioral contracts kept** (deepseek: descriptions carry contracts) but rewritten into one imperative voice; pure policy sentences (e.g. "emit all independent fills in one array") move to `tool:<name>` sections |
| MCP `browser-use-agent-card.md` | `src/mcp/prompts/` | updated to align with the new prompt (same structure: connection + tool-use instructions); remains an MCP prompt resource |
| `instructionLoader.cjs` output | runtime | kept; rendered as `context:instructions-file` section |
| `AGI_COMPUTER_TOOLS` header comments guidance | `computerCatalog.cjs` comments | comments kept (documentation), no runtime text |

---

## 5. Files: create / rewrite / delete

| Action | File | Notes |
|---|---|---|
| CREATE | `desktop/agent/harness/promptRegistry.cjs` | registry + render + interpolation |
| CREATE | `desktop/agent/harness/identity.cjs` | identity line + reserved names |
| CREATE | `desktop/agent/harness/runtimeContext.cjs` | snapshot builder (supersedes header) |
| CREATE | `desktop/agent/harness/toolSchema.cjs` | defineTool + projectToolSchema + canonical order |
| CREATE | `desktop/agent/harness/pipeline.cjs` | execution pipeline + withToolTimeout |
| CREATE | `desktop/agent/harness/guards.cjs` | repeat-call detector (canonical args, 3/5/8) |
| CREATE | `desktop/agent/harness/inbox.cjs` | next-turn/next-step splice/claim |
| CREATE | `desktop/agent/harness/loopPolicy.cjs` | recovery/backoff/effort-as-config/schema-repair notice |
| CREATE | `desktop/agent/harness/errors.cjs` | error codes + normalization |
| CREATE | `desktop/agent/prompt/sections.cjs` | all prompt content (persona, policies, tool guidance) |
| REWRITE | `desktop/agent/desktopChatAgent.cjs` | internals per §3.2/3.3/3.4; public contract frozen (§2.I); functionality blocks carried over verbatim where marked |
| REWRITE | `src/ollama/agentLoop.js` | thin turn/step loop on harness shapes |
| REWRITE | `src/ollama/promptBuilder.js` | mini section registry |
| KEEP | `src/ollama/commandParser.js` | JSON fallback parser for non-tool-calling models (labeled) |
| EDIT | `desktop/computer/computerCatalog.cjs` | remove prompt constants; keep schemas/validation |
| EDIT | `desktop/agent/openAiCompatibleProvider.cjs` | remove prompt authorship; accept harness system prompt |
| EDIT | `desktop/agent/ollamaProvider.cjs` | remove `REPAIR_SCHEMA_PROMPT` authorship |
| EDIT | `desktop/agent/providers/wire.cjs` | remove `PUBLIC_FEEDBACK_INSTRUCTION` |
| DELETE | `desktop/agent/replyStyle.cjs` | absorbed into persona prefix |
| EDIT | `desktop/agent/providerTurnLedger.cjs` | new structured summary template |
| EDIT | `desktop/research/researchAgent.cjs`, `desktop/record/recorder.cjs` | prompt text rewritten |
| EDIT | `src/mcp/prompts/browser-use-agent-card.md` | aligned with new prompt |
| KEEP | `desktop/agent/flowControlState.cjs` | **file retained on disk for any straggler imports but no longer loaded by the agent** — verify no runtime import remains, then delete |
| REWRITE | `README.md` (fork) | document the new harness |

---

## 6. Verification plan (walked after implementation)

1. `node --check` every created/modified `.cjs`/`.mjs`/`.js` file.
2. `git diff --stat` review: only files listed in §5 touched.
3. Contract tests: `tests/desktop-ai-chat-agent.test.mjs` (mock providers `{done:{summary,success,verified}}` / `{assistantText}`) must pass — proves provider contract + status machine + events.
4. Enforcement/gen tests: `tests/enforcement-gen4/5.test.mjs` expect `harness.notice.delivered` — the sourced-notice system must still emit it.
5. Grep sweeps: zero references to deleted symbols (`V4_AGENT_PROMPT`, `AGI_PROMPT`, `providerSystemPrompt`, `REPLY_STYLE_PROMPT`, `PUBLIC_FEEDBACK_INSTRUCTION`, `REPAIR_SCHEMA_PROMPT`, `startStallHeartbeat`, `withDecisionWatchdog`, `scheduleRecovery`, `ESCALATION_PARK_FIRES`, `WAIT_BACKOFF_MS`) outside the old baseline commit.
6. Checklist walk: every §2 box ticked with evidence (file+line or test).
7. `src/` smoke path still importable (`node --check src/index.js` + require graph sanity via `node -e "require('./src/config.js')"` style checks where ESM allows).

---

## 7. Explicit non-goals

- No new features beyond the harness core (no new tools, no UI changes).
- No behavior change in browser control, MCP, pairing, realtime, terminal, android, schedule, recorder, skills, knowledge, notebook.
- Desktop/CLI/TUI integration code untouched — the agent's public contract (§2.I) is the seam.
- Ghidra is not needed: `browser-use.exe` is a Node SEA built from this same source tree (`sea-config.json` → `src/seaBootstrap.cjs`), so the source is authoritative; the fork rebuilds the exe from source. (rea.git's relevant takeaways — evidence-backed verification and disciplined AGENTS.md — are reflected in §1.5 and the verification plan; its Ghidra tooling targets binary RE, which has no role here.)
