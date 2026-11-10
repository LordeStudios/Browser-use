'use strict';

// BROWSER_USE_CHAT_LIFECYCLE_ADAPTIVE_WAIT_STOP

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const {
  createCoordinatorState,
  recordObservation,
  actionHash,
  canAttempt,
  recordAction,
  recordFacts,
  madeProgress,
  shouldCaptureAuto,
  isMutation,
  bumpNavigationEpoch,
  staleAnchor,
  fillGate,
  constraintTamper,
  presentationTamper,
  completedWorkEntry,
  recordRejectedFill,
  unbackedActionClaims,
  valueWriteLiterals,
  firstWriteViolations,
  parseNumberedRequirements,
  settleRequirementLedger,
  requirementCovered,
  CONFLICT_PROTOCOL_ADVISORY,
  hasCoordinatePair: coordinatorHasCoordinatePair
} = require('./desktopAgentCoordinator.cjs');
const { isLongReportRequest, normalizeReportInput, shouldRequireLongReport } = require('./reportFilePolicy.cjs');
const { extractEmbeddedDecision, redactEmbeddedDecision, hasExecutableDecision } = require('./ollamaProvider.cjs');
const { COMPUTER_TOOLS, isComputerTool, computerReadOnly, isCodingTask, normalizeControlMode } = require('../computer/computerCatalog.cjs');
const { RETRY_DELAYS_MS, isTransportError, pauseForRetry } = require('./providers/retry.cjs');
const { ProviderTurnLedger, boundedResult, normalizeLedgerSnapshot, normalizeObjectiveLedger, sanitizeLedgerValue } = require('./providerTurnLedger.cjs');
const { parseTaskDeadlineMs, normalizeRunBudgetMs, deadlineAtForTurn, remainingRunMs } = require('./runBudget.cjs');
const { createInteractionMemory, observeInteraction, prepareAction } = require('./interactionMemory.cjs');
// GEN9 RUN NOTEBOOK: durable per-run session state (user rules, working
// repos, credentials, commands, project facts, requirements, write trail).
// The file on disk is the source of truth; the wire sees a pinned projection.
const { createRunNotebook, notebookIndex: notebookIndexText, appendUserLine: notebookAppendUserLine } = require('./runNotebook.cjs');
const { registerRepo, recordRepoMentions, renderRepoMapWire } = require('./workspacePin.cjs');
// DEFERRED TOOL LOADING: the full tool catalog lives on the run; the provider
// receives a compact form of the tools that are not core, and the model can
// ask for a full schema with tool_schema.
const { buildToolCatalog, fullSchemaFor, isDeferredTool } = require('./deferredToolCatalog.cjs');
const { parseHcuToolName } = require('./hcuSession.cjs');
// ADAPTIVE TOKEN COMPRESSOR: the harness-layer compressor (a Node port of
// Intel's Adaptive Token Compressor). It compresses the wire projection of
// durable state, never the state itself.
const { compressNotebook } = require('./adaptiveTokenCompressor.cjs');
// One helper for every place the user's request is restated to the model, so a
// long request is never cut to its first sentence or two (requestQuote.cjs).
const { quoteRequest } = require('./requestQuote.cjs');
const { normalizeDomAttachments, replaceDomReferences } = require('../renderer/domAttachments.cjs');
const {
  createFlowControlState,
  resetFlowControlForUserTurn,
  assessFlowControl,
  captureEvidence,
  touchedPathsFromCall,
  thinkingBudgetTier,
  thinkingBudgetNotice
} = require('./flowControlState.cjs');

const MAX_ATTACHMENT_TEXT_CHARS = 120_000;
const MAX_ATTACHMENT_TEXT_TOTAL_CHARS = 240_000;
const MAX_ATTACHMENT_IMAGE_BYTES = 8_000_000;
const ATTACHMENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const COMPLETION_REVIEW_MUTATION_THRESHOLD = 3;
// Stage A escalation ladder: watchdog fires (stall heartbeat, no-progress
// results) park the run at this threshold — escalate (awaiting_recovery +
// run.escalated + auto-resume), NEVER terminate. Any successful mutation
// resets the count. Env-tunable 2-10 for probes.
const ESCALATION_PARK_FIRES = Math.min(10, Math.max(2, Number(process.env.BROWSER_USE_ESCALATION_PARK_FIRES) || 4));

// Stage B (harness merge v5): 8-class failure taxonomy over the EXISTING
// recoverySource strings (kept byte-identical — tests and UI pin them).
// Classification is additive: it labels each recovery, drives the recovery
// directive, and feeds the recovery record. Unknown sources classify as
// UNCLASSIFIED and behave exactly as before.
const FAILURE_CLASSES = Object.freeze({
  INVALID_INPUT: ['invalid_plan_update', 'invalid_tool_input', 'agent_message_invalid', 'read_agent_result_invalid', 'research_objective_invalid', 'search_query_invalid', 'skill_unknown', 'subagent_close_invalid', 'wait_ms_invalid', 'computer_model_kind_invalid', 'computer_model_prompt_invalid'],
  TRANSIENT: ['action_timeout', 'observation_timeout', 'output_budget', 'internal_error', 'fetch_failed', 'pointer_interrupted', 'computer_model_failed'],
  STALE_STATE: ['stale_element', 'layout_changed', 'completion_evidence'],
  SCOPE: ['workspace_scope'],
  NO_EFFECT: ['browser_action'],
  // E7 (gen3): a constraint-tamper bounce is a page conflict, not a lost
  // effect — its class labels the recovery demand without changing any
  // pre-existing classification.
  CONFLICT: ['constraint_tamper'],
  LOOP: ['action_loop', 'duplicate_action', 'missing_terminal_result'],
  // E12 (gen4): a verified done whose summary cites evidence the tool record
  // does not show — the same EVIDENCE_MISSING family as the screenshot gate.
  EVIDENCE_MISSING: ['unverified_external_block', 'screenshot_claim_unverified', 'unbacked_claim', 'stale_task_acknowledgment', 'done_incomplete_work', 'completion_review', 'unsuccessful_done'],
  PROVIDER_BLOCK: ['agent_provider_blocked', 'provider_unreachable', 'computer_model_provider_failed']
});
function classifyFailure(source) {
  const key = String(source || '');
  for (const [failureClass, sources] of Object.entries(FAILURE_CLASSES)) {
    if (sources.includes(key)) return failureClass;
  }
  return 'UNCLASSIFIED';
}

// E13 (gen4) moment-of-need bridge: the anti-rebuild sentence rides EVERY
// completion_review bounce message itself. The gen1/gen2/gen-ab evidence
// (arch1-timed-r2's double rebuild, legacy untimed-r2's five-bounce spiral,
// gen-ab untimed-r3's evidence-demand-driven Task-A rebuild) shows
// prompt-only placement fails at exactly this bounce — the gate is the site
// that fires at the vulnerable moment, the same argument that justified E7's
// fold into the fill-gate rejection.
const COMPLETION_BRIDGE = 'Re-verify an uncertain claim with one corrected probe; never by re-executing a completed flow.';

// Gen2 enforcement (E2): one-shot harness event notices. Harness events
// (navigation, classified recovery, park-resume) arm a transient line; the
// NEXT decision's context drains the queue and renders it once. Never
// accumulated across decisions, never repeated, zero standing prompt bytes.
const MAX_HARNESS_NOTICES = 4;
function pushHarnessNotice(run, text) {
  const line = String(text || '').replace(/\s+/g, ' ').trim();
  if (!line || !run) return;
  const queue = Array.isArray(run.harnessNotices) ? run.harnessNotices : (run.harnessNotices = []);
  queue.push(line);
  if (queue.length > MAX_HARNESS_NOTICES) queue.splice(0, queue.length - MAX_HARNESS_NOTICES);
  // E9 (gen4) delivery proof: every armed notice carries an id in a durable
  // ledger, so its DELIVERY into a decision context can be published as a
  // trace event (harness.notice.delivered) instead of being indistinguishable
  // from a notice the model never saw (the gen3 arch1-timed-r2 ambiguity).
  if (!Array.isArray(run.harnessNoticeLedger)) run.harnessNoticeLedger = [];
  run.harnessNoticeSeq = (Number(run.harnessNoticeSeq) || 0) + 1;
  run.harnessNoticeLedger.push({ id: `notice-${run.harnessNoticeSeq}`, text: line, armedAt: Date.now() });
}
// F3 (gen5) visual-evidence ledger: a durable record of every capture the run
// actually produced — explicit screenshot tool calls, in-band observation
// captures, and image attachments — each stamped with its history position
// and coordinator revision. E12's screenshot-citation matching reads this
// ledger, so a verified summary's "the post-submit screenshot" / "the fresh
// screenshot" claims are checked against captures that REALLY happened at
// trace positions that support the claim (a capture recorded before the last
// submit is not post-submit evidence). Bounded; entries never expire (the
// prose bar "evidence you captured does not expire" applies to the gate too).
function recordVisualCapture(run, source) {
  if (!run) return;
  if (!Array.isArray(run.visualLedger)) run.visualLedger = [];
  run.visualLedger.push({
    at: Date.now(),
    source: String(source || 'unknown').slice(0, 24),
    revision: Number(run.coordinator?.observationRevision) || 0,
    historyLength: Array.isArray(run.history) ? run.history.length : 0
  });
  if (run.visualLedger.length > 64) run.visualLedger.splice(0, run.visualLedger.length - 64);
}

function noticeIdFor(run, line) {
  const ledger = Array.isArray(run?.harnessNoticeLedger) ? run.harnessNoticeLedger : [];
  return (ledger.find((entry) => entry?.text === line) || {}).id || 'notice-unknown';
}
function drainHarnessNotices(run) {
  if (!run || !Array.isArray(run.harnessNotices) || !run.harnessNotices.length) return null;
  return run.harnessNotices.splice(0);
}
// E1: successful calls in this set change the page so thoroughly that every
// element index minted before them is void (navigation-epoch bump).
const NAVIGATION_TOOL_NAMES = new Set(['browser_navigate', 'browser_new_tab', 'browser_select_tab', 'browser_focus_tab', 'browser_go_back']);
// E5: ~10x a healthy decision's reasoning volume (MERGE evidence: the
// 6.15 MB-thought run and the 5,646-char circular deliberations tripped
// nothing because every decision carried tool calls).
const THOUGHT_BUDGET_CHARS = 4_096;
const MULTIPART_TASK_PATTERN = /\b(?:and then|then|audit\b[^.]{0,160}\b(?:fix|apply|implement|change)|inspect\b[^.]{0,160}\b(?:fix|apply|implement|change)|detect\b[^.]{0,160}\b(?:fix|apply|implement|change))\b/i;

// MULTI-ASK DETECTION. MULTIPART_TASK_PATTERN only recognizes SEQUENCE words
// ("and then", "audit ... fix"). A message that is simply a long list of
// separate requests — the 2026-10-30 run.txt asked for twelve things in plain
// prose and ended "start with creating a plan" — contains none of them, so the
// plan prompt, the plan-missing flow check and the forced completion review all
// stayed silent and the run finished after a fraction of the work.
//
// A task is multi-ask when the user explicitly asks for a plan, or when it holds
// at least MULTI_ASK_MIN separate request clauses. Measured against all 61
// distinct user messages in the saved history: it flags the seven long briefs
// and none of the short chat messages ("hello", "fix that", "continue", ...).
const MULTI_ASK_MIN = 4;
// How many separate instructions a request holds.
//
// A splitter on punctuation is lossy — the real 2026-10-30 request is 1,082
// characters with three sentence breaks, and its asks are separated by pasted
// element ids, so splitting it found 5 where there were 12. The DISTINCT
// REQUEST VERBS are a better signal: the same request holds 11, a one-line
// chat message holds 0 or 1, and a pasted element id (search_with_google)
// is not a verb and does not count. The number is a FLOOR — the model may
// account for more instructions than this — never a limit.
const REQUEST_VERBS = new Set([
  'want', 'need', 'should', 'must', 'use', 'make', 'create', 'add', 'remove', 'replace', 'fix', 'change',
  'update', 'reorganize', 'reorganise', 'rewrite', 'redesign', 'show', 'feature', 'pull', 'find', 'build',
  'implement', 'move', 'rename', 'delete', 'animate', 'apply', 'ensure', 'keep', 'stop', 'start', 'test',
  'verify', 'check', 'search', 'install', 'write', 'generate', 'convert', 'improve', 'clean', 'organize',
  'organise', 'perfect', 'give', 'set'
]);
const REQUEST_VERB_FLOOR_CAP = 20;
// A pasted element id: word-ish parts joined by underscores (weather_card,
// search_with_google, div_3_div_1_svg_1). Each one is a thing the user
// pointed at and expects to be changed.
const ELEMENT_TARGET = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
// The accounting lines in a done summary: one per instruction, each starting
// with DONE: or SKIPPED:. A line must also say something — a bare "DONE:" is
// not an account of an instruction.
function countAccountingLines(summary) {
  const text = String(summary || '');
  if (!text.trim()) return 0;
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*•]?\s*(DONE|SKIPPED)\s*[:—-]\s*(.+)$/i);
    if (match && String(match[2]).trim().length >= 8) count += 1;
  }
  return count;
}
function requestInstructionCount(task) {
  const verbs = new Set();
  const targets = new Set();
  for (const token of String(task || '').match(/[A-Za-z][A-Za-z0-9_]*/g) || []) {
    const lower = token.toLowerCase();
    // A token with an underscore is a pasted element id, not a word. It is
    // still a THING the user pointed at, so it counts as an instruction
    // target: the 2026-10-30 request named eleven of them (weather_card,
    // search_with_google, div_3_div_1_svg_1, ...), and counting only the
    // verbs counted that request at eleven instructions when it holds about
    // twenty.
    if (lower.includes('_')) {
      if (ELEMENT_TARGET.test(lower)) targets.add(lower);
      continue;
    }
    const stem = lower.replace(/(?:ing|ed|es|s)$/, '');
    if (REQUEST_VERBS.has(lower) || REQUEST_VERBS.has(stem)) verbs.add(lower);
  }
  return Math.min(REQUEST_VERB_FLOOR_CAP, verbs.size + targets.size);
}

// ── PAGE FRESHNESS ─────────────────────────────────────────────────────────
// The 2026-10-31 run: the agent patched the page file three more times and
// then took a screenshot WITHOUT reloading. The frame showed the page as it
// was BEFORE those patches, and the harness accepted that frame as evidence —
// so the model concluded "the icons render" about a page whose icons no longer
// rendered. The user's complaint was exactly this: the agent failed "even
// with a screenshot and inspection".
//
// A frame is evidence of a change only if the page was loaded AFTER the
// change. The harness knows both halves of that: it applies the patch, and it
// sees the navigation. So it can tell the difference between a screenshot
// that shows the change and one that shows the page it just replaced.

function normalizeWebPath(value) {
  return String(value || '').split('?')[0].split('#')[0].replace(/\\/g, '/').toLowerCase();
}

// Does the page at this URL depend on the file that changed?
function pageDependsOnFile(url, filePath) {
  const page = normalizeWebPath(url);
  const file = normalizeWebPath(filePath);
  if (!page || !file) return false;
  const name = file.split('/').pop();
  if (!name) return false;
  if (page.endsWith('/' + name) || page.endsWith(file)) return true;
  // A stylesheet or script that sits beside the page is part of that page.
  if (/\.(?:css|js|mjs)$/.test(name)) {
    const dir = file.slice(0, file.length - name.length);
    return Boolean(dir) && page.startsWith(dir);
  }
  return false;
}

// Files the loaded page depends on that have changed SINCE it was loaded.
function stalePageFiles(run, tabId) {
  if (!run.pageChanges?.size) return [];
  const load = run.pageLoads?.get(String(tabId || run.tabId || ''));
  if (!load) return [];
  const loadedAt = Number(load.at) || 0;
  const stale = [];
  for (const [file, changedAt] of run.pageChanges) {
    if (!pageDependsOnFile(load.url, file)) continue;
    if ((Number(changedAt) || 0) <= loadedAt) continue;
    stale.push({ file, at: changedAt });
  }
  return stale;
}

// The last time a file this page depends on changed. A frame older than this
// cannot show that change.
function lastPageChangeAfter(run, url) {
  let latest = 0;
  for (const [file, changedAt] of run.pageChanges || []) {
    if (!pageDependsOnFile(url, file)) continue;
    latest = Math.max(latest, Number(changedAt) || 0);
  }
  return latest;
}
const MULTI_ASK_REQUEST = /\b(?:want|wants|need|needs|should|must|use|using|make|create|add|remove|replace|fix|change|update|reorganize|reorganise|rewrite|redesign|show|feature|pull|find|build|implement|move|rename|delete|animate|apply|ensure|keep|stop|start|test|verify|check|search|install|write|generate|convert|improve|clean|organize|organise)\b/i;
const MULTI_ASK_PLAN = /\b(?:(?:create|make|write|draw up|come up with|start with|begin with|first)\b[^.\n]{0,24}\b(?:a\s+)?plan|plan\s+first|plan\s+(?:it|this|the work|before))\b/i;
// The request clauses in a message, used ONLY to decide whether it is
// multi-part. Verb-bearing clauses are counted, so the detector stays
// conservative on short chat messages. It is deliberately NOT used to build the
// per-ask checklist: a message is run-on prose, and splitting it loses asks.
function multiAskClauses(task) {
  return String(task || '').split(/(?<=[.!?;])\s+|\n+|\s+(?:also|and also|plus)\s+/i)
    .map((part) => part.trim())
    .filter((part) => part.length > 12 && MULTI_ASK_REQUEST.test(part) && !MULTI_ASK_PLAN.test(part));
}
function isMultiAskTask(task) {
  const text = String(task || '');
  if (MULTI_ASK_PLAN.test(text)) return true;
  if (multiAskClauses(text).length >= MULTI_ASK_MIN) return true;
  // A comma-separated list of requests is ONE clause, so the clause count
  // misses it — and that list is exactly how the 2026-10-30 request was
  // written (twelve instructions, one run-on sentence). The distinct request
  // verbs catch it. Measured over 61 saved messages this adds 5, all of them
  // genuinely multi-instruction, and none of the short ones.
  return requestInstructionCount(task) >= MULTI_ASK_MIN;
}
// The forced completion review quotes the user's asks back so the model has to
// account for EACH one. Without a numbered list the harness has no per-ask
// ledger, and the review was a generic "audit the whole goal" that a model could
// answer with one sentence about the part it happened to finish. The checklist
// is advice, not a gate: it cannot park or block a finished run.
function multiAskChecklist(task) {
  if (!isMultiAskTask(task)) return '';
  // The harness does NOT try to split the message into asks. Real messages are
  // run-on prose (the 2026-10-30 one is 1,082 characters with three sentence
  // breaks, and its asks are separated by pasted element ids, not punctuation),
  // so any splitter produces a lossy list that looks complete while omitting
  // instructions — "no em dashes", "real posts" and "favicon" were all lost by
  // the first attempt. Quoting the message verbatim cannot omit anything, and it
  // makes the model enumerate the asks itself.
  const message = String(task || '').replace(/\s+/g, ' ').trim();
  const quoted = message.length > 1800 ? `${message.slice(0, 1800)} [message continues; re-read it in full]` : message;
  const floor = requestInstructionCount(task);
  return ` The user's request, verbatim: "${quoted}" Before returning done, write one line per separate instruction in it, in order, each on its own line and starting with "DONE:" or "SKIPPED:", naming the instruction and the evidence (or the reason it was skipped). This request holds about ${floor} instruction${floor === 1 ? '' : 's'}; write a line for EACH one you were asked for, and one for anything you chose not to do. An instruction your summary does not mention is treated as not done.`;
}
// The single question every multipart consumer asks.
function isMultipartTask(task) {
  return MULTIPART_TASK_PATTERN.test(String(task || '')) || isMultiAskTask(task);
}
// Consecutive waits escalate cumulatively, so polling a long-running job
// (a build, a dispatched agent, a render) waits minutes per decision instead
// of burning one decision per 10 seconds. The model may also request any
// duration up to MAX_BROWSER_WAIT_MS directly.
const WAIT_BACKOFF_MS = Object.freeze([500, 1_000, 2_000, 4_000, 8_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000]);
// Pure reads and waits produce no mechanical effect for Laya to confirm â€”
// verifying after them would only burn sidecar passes for nothing.
const READ_ONLY_ACTION_NAMES = new Set(['browser_observe', 'browser_screenshot', 'browser_wait', 'browser_console_entries', 'browser_network_entries', 'browser_navigation_state', 'browser_tabs', 'browser_query', 'browser_extract', 'computer_observe', 'computer_screenshot', 'computer_window', 'research_task', 'web_search', 'skill_search', 'update_plan', 'chat_compact', 'notebook']);
// Evidence-phase steering (EVIDENCE SUFFICIENT) counts decisions made only of
// evidence-gathering calls. The tool set is unchanged from the original nudge,
// except that computer_fs counts only for its read-style actions: mkdir/copy/
// move/delete are mutations and used to advance the "you have read enough"
// streak as if they were reads.
const EVIDENCE_STREAK_TOOLS = new Set(['computer_read', 'computer_search', 'computer_index', 'browser_observe', 'browser_execute', 'browser_console_entries', 'browser_network_entries', 'browser_tabs']);
function genuineEvidenceCall(call) {
  const name = String(call?.name || '');
  if (EVIDENCE_STREAK_TOOLS.has(name)) return true;
  return name === 'computer_fs' && ['stat', 'list', 'find'].includes(String(call?.input?.action || ''));
}
// True only when EVERY call of the decision ran and returned ok. Pairing is by
// tool name in order over the history entries recorded since the decision
// began; a failed call (for example arguments rejected by validation) or a call
// that never ran (batch interrupted) is not evidence.
function evidenceCallsAllSucceeded(calls, run, sinceClock) {
  const remaining = (Array.isArray(run.history) ? run.history : [])
    .filter((entry) => Number(entry?.at) > sinceClock && entry?.tool !== 'agent_advisory');
  for (const call of calls) {
    const index = remaining.findIndex((entry) => entry.tool === call.name);
    if (index === -1 || remaining[index].output?.ok !== true) return false;
    remaining.splice(index, 1);
  }
  return true;
}
const MAX_BROWSER_WAIT_MS = 900_000;
// LORDE_FAST_PATH allowlist: actions safe to execute eagerly the moment the
// model's streamed tool-call arguments are complete. Clicks, scrolls, pointer
// moves, and page queries — never typing/filling (overwrites content),
// navigation, terminal/file work, or anything with an approval requirement.
// LORDE_FAST_PATH_CODING_V1 — read-only coding tools join the fast path: file
// reads, searches, index queries, fs stat/list/find, and browser observes all
// have zero destructive side effects and can start during model deliberation.
// The "announced it six times before acting" latency disappears for the
// read-heavy phases of coding work.
const FAST_PATH_ACTIONS = new Set([
  'browser_click', 'browser_scroll', 'browser_mousemove', 'browser_query', 'browser_extract',
  'computer_read', 'computer_search', 'computer_index',
  'browser_observe', 'browser_tabs', 'browser_console_entries', 'browser_network_entries',
  'skill_search'
]);
const DEFAULT_SETTINGS = Object.freeze({
  maxActionsPerStep: 12,
  stepTimeoutMs: 90_000,
  // F6 (gen5) decision watchdog: dead-air window per model call before one
  // bounded retry runs; a second hang parks the run (never terminates).
  decisionWatchdogMs: 120_000,
  vision: 'auto',
  approvalMode: 'unattended',
  // Reasoning effort (mode/permissions pill): 'auto' starts every run at
  // minimal and escalates one tier only on demonstrated need; a fixed tier
  // never changes mid-run. 'advanced' is exactly the previous behavior.
  effort: 'auto',
  // System One verifier brain: off by default. Legacy layaEnabled settings
  // migrate to laya in normalizeSettings; new UI values are off|laya|jev.
  layaBrain: 'off',
  layaEnabled: false,
  layaEndpoint: '',
  jevBaseUrl: 'https://api.typesafe.ai/v1',
  jevModelId: 'jev-latest'
});

// Reasoning effort ladder. Ordered low -> deep; `auto` STARTS at advanced
// (the strongest reasoning) and may move ONE rung per decision in either
// direction — down when the task clearly needs less thinking, back up when a
// phase genuinely needs more (see applyEffortEscalation). There are no
// model-family dampeners: the harness must behave identically with the
// strongest and the weakest models.
const EFFORT_TIERS = Object.freeze(['minimal', 'standard', 'advanced']);
function normalizeEffortSetting(value) {
  return ['auto', ...EFFORT_TIERS].includes(value) ? value : 'auto';
}
function normalizeEffortTier(value) {
  return EFFORT_TIERS.includes(value) ? value : null;
}
function nextEffortTier(tier) {
  const index = EFFORT_TIERS.indexOf(tier);
  return index >= 0 && index < EFFORT_TIERS.length - 1 ? EFFORT_TIERS[index + 1] : 'advanced';
}
// Pure auto-effort adjustment policy. The model steers the tier around the
// advanced start: a request (`effortNeeded` + `effortReason` in the decision
// JSON) is granted when it moves EXACTLY one rung in either direction with a
// concrete reason — down when the task clearly needs less thinking, up when a
// phase genuinely needs more. No rung-skipping, no reason-free changes, no
// need-signal gates. `harness: true` (recovery safety net) escalates
// unconditionally by one rung — repeated recoveries ARE the evidence that the
// current tier is insufficient. Fixed modes ignore the request entirely.
function applyEffortEscalation({ mode, tier }, { requested = '', reason = '', harness = false, thinkingBudgetMs = null } = {}) {
  // DIRECT REASONING BUDGET (owner): the model names its thinking budget the
  // way it names a wait. Honour it exactly — no one-rung clamp, no reason
  // required — and let it end reasoning early by naming a small budget. The
  // effort tier already IS the budget knob (minimal turns thinking off), so
  // this reuses it instead of adding a second system. Fixed effort modes stay
  // authoritative: an explicit user choice is not the harness fighting the model.
  const budget = Number(thinkingBudgetMs);
  if (mode === 'auto' && thinkingBudgetMs !== null && thinkingBudgetMs !== undefined && thinkingBudgetMs !== '' && Number.isFinite(budget) && budget >= 0) {
    const mapped = budget <= 20_000 ? 'minimal' : budget <= 60_000 ? 'standard' : 'advanced';
    return { tier: mapped, escalated: mapped === (normalizeEffortTier(tier) || 'advanced') ? null : mapped };
  }
  if (mode !== 'auto') return { tier, escalated: null };
  if (harness) {
    if (tier === 'advanced') return { tier, escalated: null };
    return { tier: nextEffortTier(tier), escalated: nextEffortTier(tier) };
  }
  const currentTier = normalizeEffortTier(tier) || 'advanced';
  const wanted = normalizeEffortTier(requested);
  const reasonText = String(reason || '').trim();
  if (wanted && reasonText && Math.abs(EFFORT_TIERS.indexOf(wanted) - EFFORT_TIERS.indexOf(currentTier)) === 1) {
    return { tier: wanted, escalated: wanted };
  }
  return { tier: currentTier, escalated: null };
}

const PROGRESS_GUARDED_READ_ACTIONS = new Set([
  'browser_tabs',
  'browser_observe',
  'browser_mousemove',
  'browser_screenshot',
  'browser_console_entries',
  'browser_network_entries',
  'browser_navigation_state',
  'browser_query',
  'browser_extract',
  'browser_wait'
]);

const ACTIONS = Object.freeze({
  browser_observe: { risk: 'read' },
  browser_tabs: { risk: 'read' },
  browser_new_tab: { risk: 'external-navigation', terminatesSequence: true },
  browser_select_tab: { risk: 'browser-control', terminatesSequence: true },
  // The one agent route to the human-visible active tab. The foreground gate
  // (no other agent may own tabs) is enforced by the injected focusTab
  // callback in main.cjs via tabFocusPolicy.cjs.
  browser_focus_tab: { risk: 'browser-control' },
  browser_mousemove: { risk: 'browser-control' },
  browser_click: { risk: 'browser-control' },
  browser_target_click: { risk: 'browser-control' },
  browser_drag: { risk: 'browser-control' },
  browser_target_drag: { risk: 'browser-control' },
  browser_type: { risk: 'browser-edit' },
  browser_fill: { risk: 'browser-edit' },
  browser_scroll: { risk: 'browser-control' },
  browser_key: { risk: 'browser-control' },
  browser_screenshot: { risk: 'read' },
  browser_console_entries: { risk: 'read' },
  browser_network_entries: { risk: 'read' },
  browser_navigation_state: { risk: 'read' },
  browser_query: { risk: 'read' },
  browser_extract: { risk: 'read' },
  browser_execute: { risk: 'browser-control' },
  browser_wait: { risk: 'read' },
  browser_go_back: { risk: 'browser-control' },
  browser_gesture: { risk: 'browser-control' },
  browser_set_device_mode: { risk: 'browser-control' },
  // Navigation and page scripts belong inside a batch: the batch continues
  // with the remaining dependent actions and the outer loop re-observes once
  // after it. Only tab-context switches end a batch mid-decision.
  browser_navigate: { risk: 'external-navigation' },
  browser_search: { risk: 'read' },
  browser_fetch: { risk: 'read' },
  computer_model: { risk: 'read' },
  schedule_task: { risk: 'read' },
  // Re-points the run's DEFAULT search/scope root to a directory the USER
  // named (task or message). A convenience, never an access gate: every path
  // on disk stays accessible with or without it.
  workspace_retarget: { risk: 'read' },
  // GEN9: the persistent notebook — read (full or one section) and update
  // (append). Per-run durable state; touches nothing outside the run's own
  // notebook file, so it is read-risk and batchable.
  notebook: { risk: 'read' },
  task_spawn: { risk: 'read' },
  model_catalog: { risk: 'read' },
  android_devices: { risk: 'read' },
  android_adb: { risk: 'read' },
  // LORDE_RESIDENT_SUBAGENTS_V365 — resident worker management: the roster is
  // inspectable and closing is explicit, by alias.
  subagent_list: { risk: 'read' },
  subagent_close: { risk: 'read' },
  // LORDE_READ_AGENT_RESULT_V368 — the turn ledger archives large tool
  // results and tells the model to "use read_agent_result", but the tool
  // NEVER EXISTED: big reads became unreachable stubs and the model looked
  // progressively dumber as the conversation grew. Wire the real tool.
  read_agent_result: { risk: 'read' },
  // DEFERRED TOOL LOADING: ask for a tool's full input schema. Every tool is
  // always in the catalog, but a tool that is not core carries only its
  // argument names and types. This serves the full schema on demand and
  // promotes the tool for the rest of the run.
  tool_schema: { risk: 'read' },
  // Model-decided background research: the silent subagent is a tool the
  // strong model calls when fresh web evidence would make the task faster or
  // more correct â€” never an automatic per-message spawn.
  research_task: { risk: 'read' },
  web_search: { risk: 'read' },
  // Cross-session coordination: message another live session (or all of
  // them) so sessions negotiate ownership of files/tabs/computer instead of
  // fighting. The receiving session replies automatically via its own
  // subagent; the reply arrives here as advisory context.
  agent_message: { risk: 'read' },
  // Record & Learn: learned skills are read-only guidance plus a telemetry
  // note; executing a skill happens through the normal action tools.
  skill_search: { risk: 'read' },
  skill_run: { risk: 'read' },
  skill_feedback: { risk: 'read' },
  write_report_file: { risk: 'filesystem-write', terminatesSequence: true },
  // The todo-list pattern: plan state lives in the harness and the model
  // updates it through a tool, so it survives native tool-call responses
  // (which carry no JSON content envelope for planUpdate).
  update_plan: { risk: 'read' },
  // Pause and ask the user a question or present options — the run does NOT
  // end. The user's reply arrives as a pendingUserMessage in the next decision.
  ask_user: { risk: 'read' },
  create_plan: { risk: 'read' },
  // On-demand conversation-memory compaction: the model (or the user via
  // /compact) forces the turn ledger to summarize + evict right now.
  chat_compact: { risk: 'read' },
  browser_done: { risk: 'read', terminatesSequence: true },
  // Retired everything-tool: kept executable for direct callers, but
  // toolDefinitions never offers it to the model.
  computer_file: { risk: 'computer-control' },
  ...Object.fromEntries(COMPUTER_TOOLS.map(tool => [tool.name, { risk: 'computer-control' }]))
});

function canonicalActionName(value) {
  const declared = String(value || '').trim();
  if (ACTIONS[declared]) return declared;
  // Some otherwise valid provider decisions compact the separators in tool
  // names (for example `browsermousemove`). Resolve only unambiguous catalog
  // aliases; inputs still pass through the normal action-specific validation.
  const compact = declared.toLowerCase().replace(/[^a-z0-9]/g, '');
  return Object.keys(ACTIONS).find((name) => name.replace(/_/g, '') === compact) || declared;
}

function hcuReadOnly(name, input = {}) {
  if (!parseHcuToolName(name)) return false;
  if (name === 'mcp__hcu__AX') return ['apps', 'observe', 'find'].includes(String(input.mode || 'observe'));
  const actions = Array.isArray(input.actions) ? input.actions : [];
  return actions.length === 1 && ['screenshot', 'zoom'].includes(String(actions[0]?.type || ''));
}

function hcuMutation(name, input = {}) {
  return Boolean(parseHcuToolName(name)) && !hcuReadOnly(name, input);
}

function actionMutates(name, input = {}) {
  return isMutation(name, input) || hcuMutation(name, input);
}

// LORDE_RISK_GATES_V1 — risk-scaled confidence thresholds for System One
// gating. Different actions get different bars depending on consequences.
// Used by the fast path confirmAction gate and the composite verification
// confidence gate. Values are calibrated starting points — tune per domain.
const RISK_GATES = Object.freeze({
  low: 0.6,      // new file, append, read-only, scroll, mousemove
  medium: 0.75,  // edit existing file, click, type, fill
  high: 0.9      // delete, overwrite, terminal execute, destructive browser ops
});
function actionRiskLevel(name, input = {}) {
  if (['computer_patch', 'computer_write'].includes(name)) {
    const isDelete = input.mode === 'write' && String(input.patch || input.content || '').includes('Delete File');
    return isDelete ? 'high' : 'medium';
  }
  if (name === 'computer_terminal') return input.action === 'execute' ? 'high' : 'low';
  if (name === 'computer_fs' && ['delete', 'move'].includes(input.action)) return 'high';
  if (name === 'computer_fs_batch') return 'high';
  if (['browser_click', 'browser_type', 'browser_fill', 'browser_key'].includes(name)) return 'medium';
  if (['browser_execute', 'browser_drag', 'browser_target_drag'].includes(name)) return 'medium';
  return 'low';
}
function riskGateFor(name, input = {}) {
  return RISK_GATES[actionRiskLevel(name, input)] ?? RISK_GATES.low;
}

function fallbackConversationTitle(task) {
  return normalizeConversationTitle(task, 'Browser task');
}

function normalizeConversationTitle(value, fallback) {
  const title = String(value || '').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '').slice(0, 80);
  return title || String(fallback || 'Browser task').slice(0, 80);
}

// LORDE_AI_CHAT_TITLES_V1 — the conversation name is the AI's job, not the
// first message frozen forever. After every real user turn (and at completion)
// one tiny completion proposes a name from the recent context; the name keeps
// evolving with the chat, silently. Failures are cosmetic and swallowed.
const TITLE_GENERATE_MIN_INTERVAL_MS = 30000;

async function maybeGenerateConversationTitle(agent, run, { force = false } = {}) {
  if (!agent?.titleApi || !run || !Array.isArray(run.messages)) return;
  const userMessages = run.messages.filter((message) => message.role === 'user'
    && message.source !== 'runtime' && String(message.content || '').trim());
  if (!userMessages.length) return;
  const now = Date.now();
  if (run.titleInFlight) return;
  if (!force && now - Number(run.titleGeneratedAt || 0) < TITLE_GENERATE_MIN_INTERVAL_MS) return;
  const latestUserText = String(userMessages.at(-1).content || '').trim();
  if (!force && run.titleSource === latestUserText) return; // nothing new to name
  run.titleInFlight = true;
  try {
    run.titleGeneratedAt = now;
    run.titleSource = latestUserText;
    const assistantMessages = run.messages.filter((message) => message.role === 'assistant' && String(message.content || '').trim());
    const recent = userMessages.slice(-3)
      .map((message) => `User: ${String(message.content).slice(0, 280).replace(/\s+/g, ' ')}`)
      .join('\n');
    const prompt = 'Write a short conversation title (3-6 words, Title Case, no quotes, no trailing punctuation) that captures the CURRENT topic of this chat. The topic may have shifted since the first message — name what the chat is about NOW. Reply with ONLY the title text.\n\n'
      + `First message: ${String(userMessages[0].content).slice(0, 280).replace(/\s+/g, ' ')}\n`
      + (assistantMessages.length ? `Latest assistant reply: ${String(assistantMessages.at(-1).content).slice(0, 280).replace(/\s+/g, ' ')}\n` : '')
      + `Recent messages:\n${recent}`;
    const raw = await agent.titleApi({
      connectionId: run.provider?.connectionId || '',
      provider: run.provider?.id || 'ollama',
      model: run.provider?.model || '',
      prompt
    });
    const next = normalizeConversationTitle(String(raw || '').split('\n')[0], run.title || run.task);
    if (next && next !== run.title) {
      run.title = next;
      agent.publish('run.title', run, { title: run.title });
      // Persist immediately: the name must survive even if the run ends here.
      if (agent.onCheckpoint) {
        try { agent.onCheckpoint(checkpointSnapshot(run)); } catch { /* best effort */ }
      }
    }
  } catch { /* naming is cosmetic — never surface an error */ }
  finally {
    run.titleInFlight = false;
  }
}

function normalizeConversationMessage(value, fallbackRole = 'user') {
  const role = value?.role === 'assistant' ? 'assistant' : fallbackRole === 'assistant' ? 'assistant' : 'user';
  const content = String(value?.content ?? value?.text ?? value ?? '').replace(/\0/g, '').trim();
  if (!content) return null;
  const at = Number.isFinite(Number(value?.at)) ? Number(value.at) : Date.now();
  const domAttachments = normalizeDomAttachments(value?.domAttachments);
  // A badge marks WHO produced this message when it is not the main agent
  // talking to the user: a subagent's findings, a research brief, another
  // session's reply. Without it those cards are indistinguishable from the
  // agent's own voice in the transcript.
  const badge = String(value?.badge ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  // The content of a badged message is addressed to the MODEL ("advisory
  // context — do not acknowledge it"). A display body carries the
  // user-facing half of the same message, so the transcript shows the
  // findings and never the instruction aimed at the model.
  const displayContent = String(value?.displayContent ?? '').replace(/\0/g, '').trim();
  return {
    role, content, at,
    ...(value?.id ? { id: String(value.id).slice(0, 120) } : {}),
    ...(value?.source === 'runtime' ? { source: 'runtime' } : {}),
    ...(badge ? { badge } : {}),
    ...(displayContent ? { displayContent } : {}),
    ...(domAttachments.length ? { domAttachments } : {})
  };
}

function normalizeConversationMessages(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => normalizeConversationMessage(value)).filter(Boolean).slice(-40);
}

function nextTimelineAt(run) {
  const next = Math.max(Date.now(), Number(run?.timelineClock || 0) + 1);
  run.timelineClock = next;
  return next;
}

function appendConversationMessage(run, role, content, { source = null, domAttachments = null, badge = null, displayContent = null } = {}) {
  const message = normalizeConversationMessage({ role, content, at: nextTimelineAt(run), ...(source ? { source } : {}), ...(badge ? { badge } : {}), ...(displayContent ? { displayContent } : {}), ...(domAttachments?.length ? { domAttachments } : {}) }, role);
  if (!message) return null;
  run.messages = [...normalizeConversationMessages(run.messages), message].slice(-40);
  return message;
}

function ensureTerminalAssistantMessage(run) {
  const summary = String(run?.result?.summary || run?.result?.error || '').trim();
  if (!summary || run?.status === 'cancelled') return;
  // The model's own closing reply often IS the summary; appending again would
  // submit the terminal message twice, so check recent assistant entries.
  const recentAssistant = normalizeConversationMessages(run.messages).filter(message => message.role === 'assistant').slice(-3);
  if (recentAssistant.some(message => message.content === summary)) return;
  appendConversationMessage(run, 'assistant', summary);
}

// ── Objective ledger (task ladder) lifecycle ────────────────────────────────
// One entry per user TASK in the conversation, newest last. The ACTIVE entry
// is the model's only objective; DONE/ABANDONED entries are closed history.
// The incident this fixes: a stale pinned objective ("its broken DOM 1")
// survived two turns — one of them pure Q&A — and the model resurrected the
// closed task instead of answering the newest message.

function activeObjectiveEntry(ledger) {
  return [...(ledger || [])].reverse().find(entry => entry?.status === 'active') || null;
}

// Close the ACTIVE entry: done only when its turn ended verified; otherwise it
// is abandoned (an unverified or superseded task is not done work).
function closeActiveObjective(ledger, { status = 'abandoned', verified = false, outcomeSummary = '', at = Date.now() } = {}) {
  const active = activeObjectiveEntry(ledger);
  if (!active) return null;
  active.status = status;
  active.verified = verified === true;
  active.closedAtClock = Number(at) || Date.now();
  if (outcomeSummary) active.outcomeSummary = String(outcomeSummary).replace(/\s+/g, ' ').trim().slice(0, 300);
  return active;
}

// Advance the ledger at a turn start. `boundary` (a user turn whose task text
// differs from the previous turn's — including after Q&A-only turns) closes
// the previous ACTIVE entry done-if-verified else abandoned, then opens the
// newest task text as ACTIVE. Same-task continuations (recovery/resume) leave
// the ledger untouched.
function advanceObjectiveLedger(previousLedger, task, { boundary = false, previousResult = null, at = Date.now() } = {}) {
  const ledger = normalizeObjectiveLedger(previousLedger);
  const taskText = String(task || '').replace(/\s+/g, ' ').trim();
  if (boundary) {
    const active = activeObjectiveEntry(ledger);
    if (active && active.task !== taskText) {
      closeActiveObjective(ledger, {
        status: previousResult?.verified === true ? 'done' : 'abandoned',
        verified: previousResult?.verified === true,
        at
      });
    }
  }
  const active = activeObjectiveEntry(ledger);
  if (!active || active.task !== taskText) {
    if (taskText) {
      const index = (ledger.at(-1)?.index || 0) + 1;
      ledger.push({ index, task: quoteRequest(taskText), status: 'active', startedAtClock: Number(at) || Date.now(), closedAtClock: 0, outcomeSummary: '', verified: false });
    }
  }
  return normalizeObjectiveLedger(ledger);
}

// A pure Q&A turn is a boundary for the objective pointer but never becomes a
// ladder task: retire the no-work entry opened for it so the ladder lists
// tasks only.
function retireAnswerOnlyObjective(ledger) {
  const list = normalizeObjectiveLedger(ledger);
  const active = activeObjectiveEntry(list);
  if (active && !active.outcomeSummary) return normalizeObjectiveLedger(list.filter(entry => entry !== active));
  return list;
}

// Mirror the run's ledger into the wire ledger. Called at every mutation
// point; a missing wire ledger (pre-wire run states) degrades silently.
function syncObjectiveLedger(run) {
  try { run?.turnLedger?.setObjectiveLedger?.(run?.objectiveLedger); } catch { /* the ladder is advisory wiring, never a run-stopper */ }
}

// GEN9: mirror the notebook + workspace pin into the pinned wire head. Called
// at run start, before each provider decision, and after any notebook write —
// the wire context is re-read from DISK each time, so a user /notebook edit
// or popup Save reaches the very next decision without any notification path.
function syncNotebook(run) {
  try {
    if (!run?.notebook || !run?.turnLedger) return;
    if (typeof run.notebook.syncRepoSection === 'function') run.notebook.syncRepoSection(Array.isArray(run.repoMap) ? run.repoMap : []);
    run.turnLedger.setWorkspacePin?.(renderRepoMapWire({ workspace: run.workspace, repoMap: Array.isArray(run.repoMap) ? run.repoMap : [] }));
    // ADAPTIVE COMPRESSION: the notebook is re-sent on EVERY decision, so its
    // empty sections are per-request overhead. The wire projection drops the
    // empty sections and the template line; the FILE on disk keeps
    // everything, and a section that later gains content comes back in full.
    const notebookWire = compressNotebook(run.notebook.wireContext()).text;
    run.turnLedger.setNotebookText?.(notebookWire);
  } catch { /* the notebook is never a run-stopper */ }
}

// Default notebook directory when no notebookDir was injected (tests, exotic
// embeddings): a temp sibling so a run never fails for lack of a home.
function defaultNotebookDir() {
  return path.join(require('node:os').tmpdir(), 'browser-use-notebooks');
}

// Close out the ACTIVE entry at a terminal state: verified completion closes
// it done with the summary; an explicit user cancellation marks it abandoned.
// Other terminal states leave the entry for the next turn boundary to close.
function settleObjectiveLedgerOnTerminal(run) {
  if (!Array.isArray(run?.objectiveLedger)) return;
  const active = activeObjectiveEntry(run.objectiveLedger);
  if (!active) return;
  if (run.status === 'completed') {
    // Every completed terminal closes its entry: done only when verified
    // (closeActiveObjective's own convention — an unverified task is not done
    // work), abandoned otherwise, with the outcome summary preserved. Leaving
    // an unverified completion ACTIVE made every later addition turn inherit
    // a stale second active objective (owner directive 2026-10-15: additions
    // extend the work; stale actives must not accumulate under it).
    closeActiveObjective(run.objectiveLedger, {
      status: run.result?.verified === true ? 'done' : 'abandoned',
      verified: run.result?.verified === true,
      outcomeSummary: run.result?.summary || '',
      at: run.completedAt || Date.now()
    });
    syncObjectiveLedger(run);
  } else if (run.status === 'cancelled') {
    closeActiveObjective(run.objectiveLedger, { status: 'abandoned', verified: false, at: Date.now() });
    syncObjectiveLedger(run);
  }
}

const { normalizeConversationPlan, applyPlanUpdate, applyProgressUpdate } = require('./progressState.cjs');

// LORDE_SPECULATIVE_READ_V1 — speculative fan-out for file reads. After a
// computer_search or computer_index returns results, pre-read the top result
// files concurrently so the model's likely next computer_read is already
// cached when it issues it. Non-destructive, bounded to 3 files, never blocks
// the decision loop.
function speculativePreRead(run, call, result, executeActionFn) {
  if (!run || !result?.ok) return;
  const isSearch = call.name === 'computer_search' && call.input?.output !== 'files';
  const isIndex = call.name === 'computer_index';
  if (!isSearch && !isIndex) return;
  // Extract candidate file paths from search/index results.
  const candidates = [];
  if (isSearch && Array.isArray(result.result?.matches)) {
    for (const match of result.result.matches.slice(0, 5)) {
      const file = String(match?.file || match?.path || '').trim();
      if (file && file.length < 400 && !candidates.includes(file)) candidates.push(file);
    }
  }
  if (isIndex && Array.isArray(result.result?.hits)) {
    for (const hit of result.result.hits.slice(0, 5)) {
      const file = String(hit?.file || hit?.path || '').trim();
      if (file && file.length < 400 && !candidates.includes(file)) candidates.push(file);
    }
  }
  // Cap: at most 3 speculative reads per decision to avoid I/O storms.
  const toRead = candidates.slice(0, 3);
  for (const filePath of toRead) {
    const readCall = { name: 'computer_read', input: { path: filePath, limit: 200 }, _speculative: true };
    try {
      Promise.resolve(executeActionFn(readCall)).then((output) => {
        if (output?.ok) {
          // Cache under the SAME key the dispatch loop will compute for the
          // model's own read, so the cache can actually be consumed there
          // (a private key shape was a cache that could never be hit). The
          // entry carries its call so an unconsumed speculative read is
          // distinguishable from an unrecorded eager ACTION when the run
          // settles its ledger.
          const observation = { desktop: run.latestObservation?.desktop, screenshot: run.latestObservation?.screenshot };
          const hash = actionHash(readCall, null, observation);
          if (run.eagerResults instanceof Map && !run.eagerResults.has(hash)) {
            run.eagerResults.set(hash, { call: readCall, output });
          }
        }
      }).catch(() => { /* speculative reads must never break the run */ });
    } catch { /* speculative reads are best-effort */ }
  }
}

function normalizeWorkingMemory(value) {
  return {
    strategyEpoch: Math.max(0, Math.min(10_000, Number(value?.strategyEpoch) || 0)),
    // Consulted-evidence ledger: every file/search/index the run already
    // holds, preserved across continuation so a long chat never pays for the
    // same evidence twice ("never forgets what it read in that chat").
    consulted: Array.isArray(value?.consulted) ? value.consulted.slice(-40) : []
  };
}

// Record one consult (computer_read/search/index) into the run's evidence
// ledger. Identical consecutive entries collapse into a `times` counter so a
// loop is visible without growing the ledger.
function recordConsulted(run, call, output) {
  if (!output?.ok) return;
  const result = output.result || {};
  let entry = null;
  if (call.name === 'computer_read') entry = { k: 'read', path: String(result.path || call.input?.path || '').slice(-160), from: result.fromLine, to: result.toLine, total: result.totalLines };
  else if (call.name === 'computer_search') entry = { k: 'search', pattern: String(call.input?.pattern || '').slice(0, 120), matches: result.matches, engine: result.engine || 'ripgrep' };
  else if (call.name === 'computer_index') entry = { k: 'index', root: String(result.root || call.input?.path || '').slice(-120), files: result.files };
  if (!entry) return;
  const last = (run.consulted || []).at(-1);
  if (last && JSON.stringify({ ...last, times: undefined }) === JSON.stringify(entry)) last.times = (last.times || 1) + 1;
  else run.consulted = [...(run.consulted || []), entry].slice(-40);
  run.workingMemory.consulted = run.consulted;
}

function safeAttachmentName(value) {
  return String(value || 'attachment').split(/[\\/]/).pop().replace(/[\0-\x1f\x7f]/g, '').trim().slice(0, 160) || 'attachment';
}

// Attachment normalization. Filesystem-sourced attachments arrive as
// { kind: 'path', path } (owner directive: the agent receives the SOURCE PATH
// and reads it with its own file tools — no content copy, no size/count
// budget, folders included). In-memory attachments keep the legacy text/image
// budgets. See desktop/attachments_path_flow_chat.md.
async function normalizeAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('Attached files were malformed. Choose the files again.');
  let textTotal = 0;
  const normalized = [];
  for (const attachment of value) {
    const name = safeAttachmentName(attachment?.name);
    if (attachment?.kind === 'path') {
      const rawPath = String(attachment?.path || '').trim();
      if (!rawPath) throw new Error(`${name} was attached without a source path. Attach the file or folder again.`);
      let stat = null;
      try {
        stat = await fs.promises.stat(rawPath);
      } catch {
        throw new Error(`${name}: the attached path no longer exists on disk (${rawPath}). Remove it and attach it again.`);
      }
      const mimeType = String(attachment?.mimeType || '').toLowerCase().trim().slice(0, 100);
      normalized.push({
        name,
        kind: 'path',
        mimeType,
        path: path.resolve(rawPath),
        isDirectory: stat.isDirectory(),
        size: stat.isDirectory() ? Math.max(0, Number(attachment?.size) || 0) : stat.size
      });
      continue;
    }
    const kind = attachment?.kind === 'image' ? 'image' : ['text', 'file', 'selection'].includes(attachment?.kind) ? 'text' : '';
    const mimeType = String(attachment?.mimeType || (kind === 'text' ? 'text/plain' : '')).toLowerCase().trim().slice(0, 100);
    if (kind === 'text') {
      const content = String(attachment?.content ?? attachment?.text ?? '').replace(/\0/g, '');
      if (content.length > MAX_ATTACHMENT_TEXT_CHARS) throw new Error(`${name} is too large. Text files must be under 120,000 characters.`);
      textTotal += content.length;
      if (textTotal > MAX_ATTACHMENT_TEXT_TOTAL_CHARS) throw new Error('The attached text is too large. Keep the combined text under 240,000 characters.');
      normalized.push({ name, kind, mimeType: mimeType || 'text/plain', size: Math.max(0, Number(attachment?.size) || Buffer.byteLength(content)), content });
      continue;
    }
    if (kind === 'image' && ATTACHMENT_IMAGE_TYPES.has(mimeType)) {
      const dataUrlMatch = String(attachment?.dataUrl || '').match(/^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/i);
      const suppliedMimeType = dataUrlMatch?.[1]?.toLowerCase();
      if (suppliedMimeType && suppliedMimeType !== mimeType) throw new Error(`${name} has inconsistent image metadata.`);
      const data = String(dataUrlMatch?.[2] || attachment?.data || '').replace(/\s+/g, '');
      if (!data || !/^[a-z0-9+/]+={0,2}$/i.test(data)) throw new Error(`${name} could not be read as an image.`);
      const decodedSize = Buffer.byteLength(data, 'base64');
      if (decodedSize > MAX_ATTACHMENT_IMAGE_BYTES) throw new Error(`${name} is too large. Images must be under 8 MB.`);
      normalized.push({ name, kind, mimeType, size: decodedSize, data });
      continue;
    }
    throw new Error(`${name} is not a supported text or image file.`);
  }
  return normalized;
}

function compactThoughtText(value) {
  const parts = String(value || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return String(value || '');
  const kept = [parts[0]];
  for (const part of parts.slice(1)) {
    const normalized = normalizeStallText(part);
    const prior = kept.map(normalizeStallText);
    const repeats = prior.some((item) => item === normalized || sentenceOverlap(item, normalized) >= 0.72);
    const meta = /\b(?:the task|my plan|the plan|let me|actually|i should|i need to|the user asked|do not repeat)\b/i.test(part);
    if (!repeats && !meta) kept.push(part);
  }
  return kept.join('\n\n');
}

function createThoughtAccumulator(onUpdate) {
  let lastPublished = '';
  return (value) => {
    const next = compactThoughtText(value);
    if (!next || next === lastPublished) return lastPublished;
    // The provider stream is cumulative. Replace the current card with the
    // newest cumulative text; never append a revised/retried thought as a
    // second segment. A new action closes this card before the next decision.
    lastPublished = next;
    onUpdate(next);
    return lastPublished;
  };
}

const ACTIONLESS_STALL_NOTICE_STREAK = 2;
const ACTIONLESS_STALL_PARK_STREAK = 3;
// READ-ONLY ENFORCEMENT (run.txt req #2 "application controls execution"): a
// fix/diagnosis task that keeps returning read-only decisions is re-narrating
// its analysis instead of executing. The evidence-phase notices are advisory
// only, so a model that varies its query wording each turn sails past them
// forever. Once the streak clears this cap on a coding/diagnosis task, further
// read-only calls in a decision with no mutation are REJECTED before execution
// and the model is told, in the rejection, to patch or terminate. This is a
// hard floor, not another advisory: the only way forward is a mutation,
// terminal, or an explicit plan change — never another read.
const READ_ONLY_ENFORCE_STREAK = 12;
// Once enforcement is engaged, this is what the next decision hears. Short and
// imperative; no "maybe" exits, because the model has already shown it will
// take a soft exit.
function readOnlyEnforcementDemand(taskText) {
  return `READ-ONLY CAP: ${READ_ONLY_ENFORCE_STREAK} consecutive decisions produced no edit or terminal result. Stop inspecting: state your best-supported hypothesis for the reported symptom in one line and apply the single smallest corrective change (computer_patch) now, or return browser_done. Do not read, search, or list again.${taskText ? ` The task: ${String(taskText).replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}`;
}

function normalizeStallText(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z]:\\[^\s]+|\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g, '[path]')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s|m|kb|mb|gb|%)?\b/gi, '[n]')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(-2_000);
}

function actionlessStallKey({ narration = '', observationFingerprint = '', plan = [], source = 'empty_decision' } = {}) {
  const stable = JSON.stringify({
    source: String(source || 'empty_decision'),
    narration: normalizeStallText(narration),
    observation: String(observationFingerprint || ''),
    plan: JSON.stringify(Array.isArray(plan) ? plan : [])
  });
  return crypto.createHash('sha256').update(stable).digest('hex');
}

function normalizeActionlessStall(value) {
  return {
    key: String(value?.key || '').slice(0, 128),
    count: Math.max(0, Math.min(20, Number(value?.count) || 0)),
    noticeKey: String(value?.noticeKey || '').slice(0, 128),
    parkKey: String(value?.parkKey || '').slice(0, 128)
  };
}

function resetActionlessStall(run) {
  if (run) run.actionlessStall = { key: '', count: 0, noticeKey: '', parkKey: '' };
}

function noteActionlessStall(run, key) {
  if (!run) return 0;
  const value = String(key || '').slice(0, 128);
  const previous = normalizeActionlessStall(run.actionlessStall);
  run.actionlessStall = previous.key === value
    ? { ...previous, count: Math.min(20, previous.count + 1) }
    : { key: value, count: 1, noticeKey: '', parkKey: '' };
  return run.actionlessStall.count;
}

function resetStreamingThoughtStall(run) {
  if (!run) return;
  run.streamingThoughtStall = { seen: [], cursor: 0, repeats: 0, noticeArmed: false };
}

// Word overlap between two sentences. The field run repeated its reasoning
// with small edits ("the constraint said one tool call per decision" /
// "...because batches get clipped"), so an exact string match never fired
// and the stall notice stayed silent through 137 repeated sentences.
function sentenceOverlap(left, right) {
  const a = new Set(left.split(' ').filter((word) => word.length > 3));
  const b = new Set(right.split(' ').filter((word) => word.length > 3));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function noteStreamingThought(run, value) {
  if (!run) return false;
  const text = normalizeStallText(value);
  if (text.length < 160) return false;
  const sentences = text.match(/[^.!?\n]{40,}?[.!?]/g) || [];
  const state = run.streamingThoughtStall || (run.streamingThoughtStall = { seen: [], cursor: 0, repeats: 0, noticeArmed: false });
  if (sentences.length < state.cursor) {
    state.cursor = 0;
    state.seen = [];
  }
  for (const sentence of sentences.slice(state.cursor)) {
    const normalized = sentence.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    if (normalized.length < 40) continue;
    const repeated = state.seen.some((seen) => seen === normalized || sentenceOverlap(seen, normalized) >= 0.72);
    if (repeated) state.repeats = Math.min(10, state.repeats + 1);
    state.seen.push(normalized);
  }
  state.cursor = sentences.length;
  state.seen = state.seen.slice(-12);
  return state.repeats >= 1;
}

function restoreConversationSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const messages = normalizeConversationMessages(snapshot.messages);
  const thinkingArchive = normalizeThinkingArchive(snapshot.thinkingArchive);
  if (!messages.length && Array.isArray(snapshot.transcript)) {
    for (const entry of snapshot.transcript) {
      if (entry?.type === 'user' || entry?.type === 'assistant') {
        const message = normalizeConversationMessage(entry, entry.type);
        if (message) messages.push(message);
      }
    }
  }
  const historySource = Array.isArray(snapshot.history) ? snapshot.history : Array.isArray(snapshot.transcript) ? snapshot.transcript : [];
  const history = historySource.map((entry) => {
    const tool = String(entry?.tool || (entry?.type && !['user', 'assistant'].includes(entry.type) ? entry.type : '')).trim();
    if (!tool) return null;
    return {
      at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now(),
      step: Number.isFinite(Number(entry?.step)) ? Number(entry.step) : 0,
      tool,
      ...(typeof entry?.callId === 'string' ? { callId: entry.callId } : {}),
      input: entry?.input ?? null,
      expect: normalizeExpectation(entry?.expect),
      repeat: entry?.repeat === true,
      output: entry?.output ?? null
    };
  }).filter(Boolean).slice(-80);
  const timelineClock = Math.max(0, ...messages.map((message) => Number(message.at) || 0), ...history.map((entry) => Number(entry.at) || 0));
  const provider = snapshot.providerConfig && typeof snapshot.providerConfig === 'object'
    ? snapshot.providerConfig
    : snapshot.provider && typeof snapshot.provider === 'object'
      ? snapshot.provider
      : { id: String(snapshot.provider || 'ollama'), model: String(snapshot.model || '') };
  return {
    id: String(snapshot.id || '').trim(),
    task: String(snapshot.task || '').trim(),
    title: normalizeConversationTitle(snapshot.title, messages.find((message) => message.role === 'user')?.content || 'Browser task'),
    provider,
    settings: normalizeSettings({ ...DEFAULT_SETTINGS, ...(snapshot.settings || {}) }),
    providerLedger: normalizeLedgerSnapshot(snapshot.providerLedger),
    // The task ladder survives snapshots/checkpoints: a conversation reopened
    // after an app restart keeps its DONE/ABANDONED history and its ACTIVE
    // objective instead of re-deriving (or losing) them.
    objectiveLedger: normalizeObjectiveLedger(snapshot.objectiveLedger),
    pendingUserMessages: Array.isArray(snapshot.pendingUserMessages) ? snapshot.pendingUserMessages.map(value => normalizeConversationMessage(value)).filter(Boolean) : [],
    history,
    messages: messages.slice(-40),
    plan: normalizeConversationPlan(snapshot.plan),
    goals: normalizeConversationPlan(snapshot.goals),
    attemptSequence: Number(snapshot.attemptSequence) || 0,
    completedWork: Array.isArray(snapshot.completedWork)
      ? snapshot.completedWork.slice(-48)
      : Array.isArray(snapshot.coordinator?.completedWork) ? snapshot.coordinator.completedWork.slice(-48) : [],
    workingMemory: normalizeWorkingMemory(snapshot.workingMemory),
    flowControl: createFlowControlState(snapshot.flowControl),
    createdAt: Number.isFinite(Number(snapshot.createdAt)) ? Number(snapshot.createdAt) : Date.now(),
    turnStartedAt: Number.isFinite(Number(snapshot.turnStartedAt)) ? Number(snapshot.turnStartedAt) : null,
    deadlineAt: Number.isFinite(Number(snapshot.deadlineAt)) && Number(snapshot.deadlineAt) > 0 ? Number(snapshot.deadlineAt) : null,
    eventRevision: Number.isFinite(Number(snapshot.eventRevision)) ? Number(snapshot.eventRevision) : 0,
    timelineClock,
    observationDomain: ['browser', 'computer'].includes(snapshot.observationDomain) ? snapshot.observationDomain
      : snapshot.lastObservedUrl || snapshot.target ? String(snapshot.lastObservedUrl || snapshot.target).startsWith('computer://') ? 'computer' : 'browser' : null,
    lastObservedUrl: String(snapshot.lastObservedUrl || snapshot.target || '').trim() || null,
    // GEN9: the notebook file path + repo map survive snapshots/checkpoints —
    // the conversation's durable state re-opens (or re-seeds, if the file was
    // removed) on continuation instead of being lost with the process.
    notebookPath: String(snapshot.notebookPath || '').trim() || null,
    repoMap: Array.isArray(snapshot.repoMap) ? snapshot.repoMap.filter(item => item && typeof item === 'object' && item.root) : [],
    // Native-surface awareness ledger: the window ids the run has ALREADY
    // announced. It must survive snapshots/continuations — otherwise the next
    // run's first native scan finds no ledger and re-seeds its baseline from
    // the live window list, silently swallowing a dialog that was open but
    // never announced. Persisted as a plain array (JSON.stringify(new Set(...))
    // is `{}`), rehydrated as a Set by the run construction below.
    nativeSurfaceSeen: Array.isArray(snapshot.nativeSurfaceSeen)
      ? snapshot.nativeSurfaceSeen.map((id) => String(id)).filter(Boolean)
      : snapshot.nativeSurfaceSeen instanceof Set
        ? [...snapshot.nativeSurfaceSeen].map((id) => String(id)).filter(Boolean)
        : [],
    thinkingArchive
  };
}

// Reasoning is display-only in the live conversation (it must never re-enter
// the model's context), but the transcript history should still show WHAT the
// agent thought. Bounded per-card records: the tail of each thinking card, so
// saved conversations render the collapsed "Thought for Ns" cards.
const THINKING_ARCHIVE_RECORDS = 60;
const THINKING_ARCHIVE_TAIL_CHARS = 2_000;
function normalizeThinkingArchive(values) {
  if (!Array.isArray(values)) return [];
  return values.slice(-THINKING_ARCHIVE_RECORDS).map((record) => ({
    at: Number.isFinite(Number(record?.at)) ? Number(record.at) : Date.now(),
    elapsedMs: Math.max(0, Number(record?.elapsedMs) || 0),
    text: String(record?.text ?? '').replace(/\0/g, '').trim().slice(-THINKING_ARCHIVE_TAIL_CHARS)
  })).filter((record) => record.text);
}

// Snapshot the live thought card into the durable archive. Called at decision
// boundaries (card close / action start / run end); identical consecutive
// tails collapse so recovery chains archive once per card.
function archiveActiveThinking(run) {
  if (!run || !run.activeThoughtId) return false;
  const text = String(run.activeThoughtAccumulator?.() || '').trim();
  if (!text) return false;
  const tail = text.slice(-THINKING_ARCHIVE_TAIL_CHARS).trim();
  const archive = Array.isArray(run.thinkingArchive) ? run.thinkingArchive : [];
  const last = archive[archive.length - 1];
  if (last && last.text === tail) return false;
  const record = {
    at: Date.now(),
    elapsedMs: Math.max(0, Date.now() - Number(run.activeThoughtStartedAt || Date.now())),
    text: tail
  };
  run.thinkingArchive = normalizeThinkingArchive([...archive, record]);
  return true;
}

// A model often STATES its reasoning budget in prose ("a maximum of 20s")
// instead of putting the field in the decision JSON, and the USER states a
// ceiling in the task ("thinking must use a maximum of 10s"). Honour all of
// them: the JSON field wins, then a named budget in the response text, and
// the same parser reads the user ceiling into thinkingBudgetCapMs.
//
// The escapes below are NOT decoration. A build with the backslashes stripped
// matched literal "D"/"d" instead of digits, so it could never read a number:
// every prose budget was silently dropped and a stated "10s" was never
// enforced. Keep \D and \d intact.
function harvestThinkingBudgetFromText(text) {
  const source = String(text || '').replace(/\s+/g, ' ');
  if (!source) return NaN;
  // "no thinking" / "without reasoning" is a stated ZERO budget, not a missing
// one — it must arrive as 0 so it can disable reasoning instead of falling
// through to the 30s default.
  if (/(?:\bno\b|\bwithout\b|\bzero\b)\s+(?:any\s+)?(?:thinking|reasoning)\b/i.test(source)) return 0;
  const named = /thinkingbudgetms\D{0,6}(\d{1,7})/i.exec(source);
  if (named) return Number(named[1]);
// A time is a REASONING budget only when the sentence is about thinking,
// reasoning or a decision — "wait a maximum of 30s" is a browser_wait
// argument and must never become a thinking ceiling.
  const applies = /think|reason|decid/i.test(source);
  if (!applies) return NaN;
  const leading = /(?:budget|max(?:imum)?|limit|ceiling|at most|no more than|up to)\D{0,24}(\d{1,4})\s*(?:s\b|sec(?:onds?)?)/i.exec(source);
  if (leading) return Number(leading[1]) * 1000;
  const trailing = /(\d{1,4})\s*(?:s\b|sec(?:onds?)?)\s*(?:max(?:imum)?|limit|ceiling|budget)\b/i.exec(source);
  if (trailing) return Number(trailing[1]) * 1000;
  return NaN;
}

function harvestThinkingBudget(response) {
  const direct = Number(response?.thinkingBudgetMs ?? response?.done?.thinkingBudgetMs);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const text = [response?.assistantText, response?.done?.summary, typeof response?.thinking === 'string' ? response.thinking : '']
    .filter(Boolean).join(' ');
  return harvestThinkingBudgetFromText(text);
}

function externalProviderBlock(error) {
  // NATIVE_VISION_UNAVAILABLE removed: vision degradation is now handled
  // gracefully inside the provider (latch + text-only fallback + advisory).
  if (['PROVIDER_PROTOCOL_UNSUPPORTED', 'CONTEXT_BUDGET_BLOCKED'].includes(error?.code)) return error.message;
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').trim();
  const normalized = message.toLowerCase();
  const modelBlock = (/\b(?:unknown|unsupported|unavailable|invalid)\s+model\b/.test(normalized) || /\bmodel\b/.test(normalized) && /\b(?:does not exist|not found|is unavailable)\b/.test(normalized));
  // A flaky gateway reports "model does not exist" during capacity blips even
  // though the model is in the roster. Transport classification owns that case
  // (bounded retry ladder); only a genuine model block is terminal.
  if (modelBlock && !isTransportError(error)) {
    return 'The selected model is no longer available from this provider. Refresh the providerâ€™s models, choose an available one, then retry.';
  }
  // 402/"wallet" must land here like 401/403: isTransportError already
  // excludes them, so the fallback would otherwise be the deliberately
  // unbounded recovery loop (observed: 1038 identical 402 recoveries in a
  // single run). Matches isHardProviderError in providers/retry.cjs.
  const accountBlock = /\b(?:401|402|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|payment|past due|billing|insufficient (?:quota|credits|wallet)|account (?:disabled|suspended)/.test(normalized);
  if (!accountBlock) return null;
  if (/payment|past due|billing|quota|credits|wallet|account (?:disabled|suspended)/.test(normalized)) {
    return 'The configured AI provider account needs attention before this task can continue. Update that provider account or choose another configured connection, then retry.';
  }
  return 'The configured AI provider rejected this connection. Update its credential in chat settings or choose another configured connection, then retry.';
}

function isCheapInformationalTask(task) {
  const request = String(task || '').trim();
  if (/^(?:what(?:'s| is) the )?(?:working )?repo(?:\s+(?:path|location))?\s*\??$/i.test(request)) return true;
  if (!request || request.length > 240) return false;
  if (/\b(?:fix|build|edit|write|read|run|test|verify|inspect|search|find|launch|change|create|delete|open|close|click|fill|type|navigate|use computer|use browser|project|repo|file|source|code)\b/i.test(request)) return false;
  return /[?？]\s*$/.test(request) || /^(?:hi|hello|hey|thanks|thank you|what is|who is|how are you)\b/i.test(request);
}

// Rapid surfaces cannot afford the normal deliberation ceiling. A game,
// live page, timer, chess match, or explicit "act now" request should emit the
// first grounded action within seconds; the next observation can supply the
// detail. This is a routing hint, not task-specific behavior.
function isRapidTask(task) {
  return /\b(?:rapid|quick(?:ly)?|as fast as possible|immediately|right now|real[- ]time|live|game|play|beat|chess|stockfish|timer|ticking)\b/i.test(String(task || ''));
}

// OWNER DIRECTIVE (2026-10-15): mid-run, queued, and fast-forwarded user
// messages are ADDITIONS to the running work — appended requirements or
// updates — never a change of direction. The agent keeps pursuing the
// existing tasks and plan and folds the new instruction in. Only an EXPLICIT
// abandon/replace mention in the message itself flips it to a replacement
// (the old closed-turn behavior). Conservative on purpose: only
// unambiguous cues qualify; weak ones ("actually", "also", "now") stay
// additions.
const TASK_REPLACEMENT_CUES = /\b(?:instead|replaces?\b|replaced\b|start\s+(?:over|again|from\s+scratch)|scratch\s+that|scrap\s+that|forget\s+(?:that|it|about)\b|abandon\b|never\s*mind\b|change\s+of\s+plan\b|new\s+task\b|don'?t\s+bother\b|stop\s+(?:doing|working\s+on)\b|ignore\s+(?:that|everything|all|my\s+previous|the\s+previous)\b|cancel\s+(?:that|this)\b|stop\s+(?:the\s+(?:current\s+)?)?(?:task|job|work|automation)\b|override\s+that\b|take\s+over\b|switch\s+to\b|pivot\s+to\b)/i;
function isTaskAddition(text) {
  return !TASK_REPLACEMENT_CUES.test(String(text || ''));
}

// The two turn-framing notices, pure for tests. The ADDITION variant is the
// owner-mandated default: extend the running work, carry the plan, append
// items — never restart. The REPLACEMENT variant is the pre-existing
// closed-turn contract, kept for explicitly-mentioned direction changes.
function turnBoundaryNotice(task, { addition } = {}) {
  const objective = String(task).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (addition) {
    return [
      'USER ADDITION — this message EXTENDS the running work and is now the PRIMARY objective. Earlier items that are already done or skipped stay closed; do not re-verify them.',
      `Current objective: "${objective}"`,
      'APPEND plan item(s) for what it asks (update_plan). Continue an unfinished earlier item only if this message refers to it or depends on it.',
      'browser_done must answer THIS message; already-closed items need no new evidence.'
    ].join('\n');
  }
  return isCheapInformationalTask(task)
    ? `TURN BOUNDARY — NEW TASK. Work exclusively on this objective: "${objective}". Every earlier task in this conversation is CLOSED.`
    : [
        'TURN BOUNDARY — NEW TASK. Every earlier task in this conversation is CLOSED; its history is background context only.',
        `Work exclusively on this objective: "${objective}"`,
        'Do not revisit, re-verify, or extend any prior task unless this objective explicitly includes it. The attached plan/goals (if any) start empty on purpose.',
        'Multi-part objective: if the user requested several things, create ONE plan item per sub-request (update_plan) before starting, and every item must be addressed or explicitly deferred before browser_done — a conclusion that covers only some sub-requests is incomplete.'
      ].join('\n');
}

function steeringAdditionNotice(latestText) {
  const text = String(latestText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    'The user sent a NEW instruction mid-run. Treat it as an ADDITION to the running work — an appended requirement or update — NOT a change of direction: keep executing the existing plan and fold this in (append/update plan items via update_plan; leave untouched items alone).',
    `Added instruction: "${text}"`,
    'Only when THIS message explicitly cancels or replaces the previous task (e.g. "instead", "forget that", "start over") does it become the sole objective — then wrap up or explicitly hand off the previous task and name what you dropped.'
  ].join('\n');
}

// The mid-run variant for messages that DO carry an explicit cancel/replace
// cue: the instruction becomes the sole objective and the previous task is
// wrapped up or handed off — never silently dropped.
function steeringReplacementNotice(latestText) {
  const text = String(latestText || '').replace(/\s+/g, ' ').trim().slice(0, 400);
  return [
    'The user sent a NEW instruction mid-run that explicitly replaces the previous task; the message below is now the sole authoritative objective.',
    `New objective: "${text}"`,
    'Wrap up or explicitly hand off the remaining steps of the previous task, name what you dropped, and do not keep executing the old plan unchanged.'
  ].join('\n');
}

// DONE-GATE SHARED HELPERS (extracted from the real-verification gate so the
// turn scoping below can use the same mutation classification). The evidence
// window keeps its own "what mutates" view: a browser click settles through
// the harness's re-observation, so historyEntryMutated stays the narrow
// native/file view. The turn-level question ("did this turn change anything
// at all") uses the coordinator's isMutation instead.
const READ_ONLY_FS_ACTIONS = new Set(['stat', 'list', 'find']);
const READ_ONLY_GIT_ACTIONS = new Set(['status', 'diff', 'log']);
// A terminal command that changes the world (installs, git commits, file
// writes) is a mutation; a verification command (go version, npm test,
// curl, ls) is not. The distinction only sets the evidence window — it
// never decides whether the run may finish.
const MUTATING_TERMINAL_COMMAND = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|uninstall|rm)\b|\bpip3?\s+install\b|\b(?:apt|apt-get|yum|dnf|brew|winget|choco|snap)\s+(?:install|uninstall|remove|add)\b|\bgit\s+(?:commit|checkout|switch|merge|rebase|reset|clean|apply|add|rm|mv|init)\b|\b(?:mkdir|rmdir|rm|del|erase|touch|chmod|chown|patch|tee|truncate|unlink)\b|\b(?:new-item|set-content|add-content|remove-item|copy-item|move-item|out-file|rename-item)\b/i;
function terminalCommandMutates(command) {
  const text = String(command || '');
  if (!text.trim()) return false;
  if (MUTATING_TERMINAL_COMMAND.test(text)) return true;
  const withoutComparisons = text.replace(/->|=>|>=|<=|==|!=/g, ' ').replace(/\d?>&/g, ' ');
  return withoutComparisons.includes('>');
}
function browserExecuteWrites(script) {
  const text = String(script || '');
  if (!text.trim()) return false;
  if (valueWriteLiterals(text).length) return true;
  return /\.(?:innerHTML|outerHTML|textContent|innerText|value)\s*=(?!=)|localStorage\.setItem|sessionStorage\.setItem|document\.write\s*\(|\.setAttribute\s*\(|\.removeChild\s*\(|\.remove\s*\(|\.appendChild\s*\(|\.insertAdjacentHTML\s*\(|\.submit\s*\(|\.click\s*\(|location\.(?:href|assign|replace)\s*=|history\.(?:pushState|replaceState)\s*\(/i.test(text);
}
function historyEntryMutated(entry) {
  const tool = String(entry?.tool || '');
  const input = entry?.input || {};
  if (tool === 'computer_write' || tool === 'computer_patch') return true;
  if (tool === 'computer_fs') return !READ_ONLY_FS_ACTIONS.has(String(input.action || ''));
  if (tool === 'computer_git') return !READ_ONLY_GIT_ACTIONS.has(String(input.action || ''));
  if (tool === 'browser_fill' || tool === 'browser_type') return true;
  if (tool === 'browser_execute') return browserExecuteWrites(input.script);
  if (tool === 'computer_terminal') return terminalCommandMutates(input.command);
  return false;
}
// Executed and CHANGED are different facts (the Stage C distinction). This is
// the second one: did the recorded output prove a state change actually
// landed? A rejected or no-op patch, a write that produced no diff, or a
// result that carries no change evidence leaves nothing to verify — bouncing
// a claim for lacking proof of a non-change is the false positive this gate
// must never make. A mutating terminal command is its own change evidence
// when it exited 0 (the operation ran; its EFFECT is the next observation's
// business, not this gate's).
function historyEntryConfirmsChange(entry) {
  const recorded = entry?.output;
  if (!recorded || recorded.ok !== true) return false;
  const layers = [recorded, recorded.result && typeof recorded.result === 'object' ? recorded.result : null].filter(Boolean);
  for (const layer of layers) {
    if (layer.changed === true) return true;
    if (layer.applied === true && Array.isArray(layer.files) && layer.files.length > 0) return true;
    if (Array.isArray(layer.files) && layer.files.some((file) => Number(file?.addedLines) > 0 || Number(file?.removedLines) > 0)) return true;
    if (Number(layer.addedLines) > 0 || Number(layer.removedLines) > 0) return true;
    if (layer.moved === true || layer.deleted === true || layer.removed === true) return true;
    if (Number(layer.bytesWritten) > 0 && layer.changed !== false) return true;
  }
  const tool = String(entry?.tool || '');
  if (tool === 'computer_terminal' && terminalCommandMutates(String(entry?.input?.command || ''))) {
    for (const layer of layers) {
      const exitCode = layer.exitCode;
      if (exitCode !== undefined && exitCode !== null) return Number(exitCode) === 0;
      const nested = layer.result && typeof layer.result === 'object' ? layer.result.exitCode : undefined;
      if (nested !== undefined && nested !== null) return Number(nested) === 0;
    }
    return /"exitCode"\s*:\s*0\b/.test(JSON.stringify(recorded) || '');
  }
  return false;
}
// Did the CURRENT turn change anything anywhere (browser, desktop or file)?
// Reads, searches and screenshots are not mutations. Used to scope the
// done-gate evidence demands: a turn that changed nothing has no "fixes
// landed" to confirm, so its explanation completes without mutation proof.
function turnHasMutations(run) {
  const turnStart = Number(run?.turnStartedAt) || 0;
  return (Array.isArray(run?.history) ? run.history : []).some((entry) =>
    Number(entry?.at || 0) >= turnStart && isMutation(String(entry?.tool || ''), entry?.input || {}));
}
// The summary asserts that work is finished ("completed", "fixed",
// "DONE: ..."), as opposed to an honest partial report ("could not verify").
// Combined with turnHasMutations this is the one case where verified:false
// must bounce: the model claims changes landed but refuses to verify them.
// Explanations and labelled "not fully proven" reports pass untouched.
function claimsCompletion(summary) {
  // The DONE:/SKIPPED: accounting labels are structural scaffolding the
  // multi-ask checklist forces the model to write; a bare "DONE:" label is
  // not a prose claim that work finished. Strip the label and read only the
  // line's content, so an honest "DONE: <finding>. SKIPPED: <fix> — unproven"
  // is never mistaken for "I did it".
  const text = String(summary || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]?\s*(?:DONE|SKIPPED)\s*[:—-]\s*/i, ''))
    .join(' ');
  // Remove NEGATED completion phrases first ("could not fix", "did not
  // verify", "no changes made", "unproven") so a cancelled claim never reads
  // as a live one. What survives is any UNQUALIFIED assertion that a change
  // landed — the exact fabrication class the gate exists for.
  const stripped = text
    .replace(/(?:could\s+not|cannot|can'?t|unable\s+to|did\s+not|didn'?t|failed\s+to|never|no\s+longer|not)\s+(?:be\s+)?(?:yet\s+)?(?:creat|verif|confirm|complet|build|launch|start|run|install|finish|fix|resolv|add|implement|deploy|patch|updat|remov|address)\w*/gi, ' ')
    .replace(/\b(?:still\s+blocked|remains?\s+(?:blocked|incomplete|unverified|unconfirmed|unproven)|not\s+(?:yet\s+)?(?:created|verified|confirmed|built|launched|started|running|installed|complete[ds]?|finished|proven)|unproven|unverified|nothing\s+to\s+(?:verify|confirm)|no\s+(?:changes?|mutations?|edits?)\s+(?:were\s+)?(?:made|applied))\b/gi, ' ');
  return /\b(?:complet(?:e[ds]?|ion)|finished|fixed|resolved|implemented|installed|created|added|built|deployed|launched|patched|updated|removed|addressed|done|success(?:ful(?:ly)?)?|working)\b/i.test(stripped);
}
// A request whose deliverable is a REPLY, not a change: a question, or a
// direct demand for an answer ("answer me", "tell me", "stop ignoring me").
// Request-shape only — it does not look at tool history — so the done gates
// can drop their evidence demands for answers even when the turn used reads
// and searches to find the answer. Work verbs cancel the shape ("tell me the
// status and fix the bug" is work).
const ANSWER_DEMAND = /\b(?:answer\s+(?:me|this|that|it|hello|hi|hey)|tell\s+me|explain|describe|let\s+me\s+know|respond\s+to\s+me|what\s+do\s+you\s+think|stop\s+ignoring\s+me|acknowledge)\b/i;
function isAnswerOnlyRequest(task) {
  const request = String(task || '').trim();
  if (!request) return false;
  const questionShaped = /[?？]\s*$/.test(request)
    || /^(?:who|what|why|how|when|where|which|can|could|is|are|do|does|did|should|have|has|had|was|were|would|will)\b/i.test(request)
    || ANSWER_DEMAND.test(request);
  if (!questionShaped) return false;
  return !/\b(?:click|type|fill|navigate|open|close|edit|patch|write|read|delete|create|test|verify|inspect|search|find|launch|run|change|fix|use computer|use browser)\b/i.test(request);
}

function isAnswerOnlyTask(task, assistantText, run) {
  // Only tool history from the CURRENT turn blocks the answer-only fast path.
  // Prior turns that used browser tools do not prevent a follow-up question
  // from being answered directly.
  const turnStart = Number(run?.turnStartedAt) || 0;
  const currentTurnHistory = (run?.history || []).filter(entry => Number(entry?.at || 0) >= turnStart);
  if (currentTurnHistory.length) return false;
  const answer = String(assistantText || '').trim();
  if (!answer) return false;
  // AN OPEN PLAN ITEM MUST NEVER BLOCK A CONVERSATIONAL REPLY. The plan
  // belongs to an earlier automation task; the new message is a different
  // request. This one condition is what trapped "hello" inside the
  // automation completion protocol (open item f11 kept the run "incomplete").
  return isAnswerOnlyRequest(task) || isCheapInformationalTask(task);
}

// A request that EXPLICITLY forbids changing anything yet — "don't change
// anything yet", "just diagnose / identify the root causes", "no edits yet",
// "tell me the issues first". These produce analysis/explanation output, not
// mutations, so the evidence machinery (coding test gate, per-outcome
// observed-effect audit, forced verified:true) must NOT demand proof of a
// change the user forbade. This is the exact shape of the 2026-10-31 run's
// final request ("don't change anything yet... find their root causes") that
// the completion gate kept demanding "observed proof" for. Genuine change
// tasks are unaffected: they carry no such no-change cue.
const NO_CHANGE_CUE = /\b(?:don'?t|do\s+not|no|never|without)\s+(?:yet\s+)?(?:make\s+)?(?:any\s+)?(?:changes?|edits?|modifications?|patches|fixes|writes?|mutations?)\b|\b(?:don'?t|do\s+not)\s+change\s+anything\b|\bno\s+(?:edits?|changes?|file\s+edits?|writes?)\b|\b(?:just|only)\s+(?:diagnose|analy[sz]e|identify|inspect|review|tell\s+me|explain|report|look)\b|\broot\s+causes?\b|\bwhat\s+(?:went|is)\s+wrong\b|\bfind\s+(?:out\s+)?(?:why|what|the\s+(?:issue|issues|problem|problems|cause|causes))\b/i;
function isAnalysisOnlyRequest(task) {
  const request = String(task || '');
  // DOMINANT analysis marker: "just / only / merely / simply + <analysis verb>"
  // is an explicit restriction of the task to analysis. It outranks any noun
  // that merely looks like a work verb ("why the BUILD fails") and any future
  // intent ("the best way to fix them"), so the change-evidence gate stays
  // disarmed for a genuine diagnosis.
  if (/\b(?:just|only|merely|simply)\s+(?:go\s+|please\s+)?(?:diagnose|analy[sz]e|identify|inspect|review|explain|tell\s+me|report|look|find|figure\s+out|walk\s+me)\b/i.test(request)) return true;
  if (!NO_CHANGE_CUE.test(request)) return false;
  // SAFETY: a positive imperative work verb ("fix the bug and don't change
  // anything else yet", "add X, no edits to Y") keeps the change-evidence gate
  // ARMED — the user asked for a change, so its landing must be proven. But the
  // no-change cue itself contains negated change words ("don't change
  // anything yet", "no edits"), so strip those BEFORE hunting for a real work
  // verb — otherwise the exact "…find their root causes. don't change anything
  // yet" request would cancel its own analysis shape. After stripping, a
  // remaining imperative work verb means this is a change task; only
  // analysis verbs (identify, diagnose, plan, find, explain) qualify as
  // analysis-only.
  const withoutNegatedChange = request
    .replace(/(?:don'?t|do\s+not|no|never|without|avoid)\s+(?:yet\s+)?(?:making\s+|make\s+)?(?:any\s+)?(?:changes?|edits?|modifications?|patches|fixes|writes?|mutations?|touch\w*|modif\w*)/gi, ' ')
    .replace(/\bno\s+(?:edits?|changes?|file\s+edits?|writes?)\b/gi, ' ')
    .replace(/\bwithout\s+(?:changing|editing|modifying|touching|fixing|patching|writing)\b/gi, ' ');
  return !/\b(?:fix\w*|build\w*|implement\w*|create\w*|add\w*|write|edit\w*|patch\w*|change\w*|updat\w*|remov\w*|delet\w*|renam\w*|mov\w*|deploy\w*|install\w*|refactor\w*|rewrit\w*|redesign\w*|apply|applied|animat\w*|configure|typ(?:e|ing)|click\w*|fill\w*|navigat\w*)\b/i.test(withoutNegatedChange);
}

function coerceElementIndex(value) {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  if (typeof value === 'string') {
    const match = value.match(/(?:index=)?(\d+)/);
    if (match) {
      const fromString = Number(match[1]);
      if (Number.isInteger(fromString) && fromString >= 0) return fromString;
    }
  }
  return undefined;
}
// Deterministic default when no runner is injected (tests, minimal builds):
// the contained pipeline only â€” it never touches a provider, so scripted
// provider tests stay hermetic.
function defaultDeterministicResearch(context) {
  const { runResearch } = require('../research/researchWorker.cjs');
  return runResearch({ task: context.task, signal: context.signal, metaSearch: context.metaSearch || undefined });
}

// The default research runner: the REAL subagent â€” a bounded LLM tool loop
// (desktop/research/researchAgent.cjs) that decides what to search, reads
// results in its own background tab, and synthesizes a findings brief. When
// no provider or browser is available, or the provider fails mid-research,
// it falls back to the deterministic contained pipeline â€” silent either way.
function defaultResearchAgent(context) {
  const { runResearchAgent } = require('../research/researchAgent.cjs');
  const { runResearch } = require('../research/researchWorker.cjs');
  const deterministic = () => runResearch({ task: context.task, signal: context.signal, metaSearch: context.metaSearch || undefined });
  if (!context.providerFactory) return deterministic();
  return runResearchAgent(context)
    .then(result => (result && (result.ok || result.aborted)) ? result : deterministic())
    .catch(() => deterministic());
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
    // computer_model: routes non-language generation (image/tts/stt/video)
    // through the user's provider catalogue (main.cjs runMediaTaskForConnection).
    this.modelTaskApi = modelTaskApi;
    this.catalogApi = catalogApi;
    this.androidApi = androidApi;
    this.scheduleApi = scheduleApi;
    this.spawnTask = spawnTask;
    this.skillsApi = skillsApi;
    // Cross-session message hub (wired by main.cjs): delivers messages to
    // other live sessions and routes their automatic replies back here.
    this.messageApi = messageApi || null;
    this.subagentApi = subagentApi || null;
    this.createResultStore = createResultStore;
    this.getComputerTools = getComputerTools;
    this.hcuApi = hcuApi || null;
    this.getControlMode = getControlMode;
    // Background research runner (desktop/research/researchAgent.cjs).
    // Injectable for tests; the composition root (main.cjs createChatAgent)
    // wires the shared MetaSearch and lets the real LLM subagent default run.
    this.researchRunner = researchRunner;
    this.researchMetaSearch = researchMetaSearch;
    // Durable cross-run knowledge (desktop/knowledge/knowledgeStore.cjs).
    // Injectable for tests; a throwing or missing store degrades to no memory.
    this.knowledgeStore = knowledgeStore;
    // System One verifier layer. Injectable for tests; the default builds the
    // existing Laya sidecar client. The Jev factory is kept separate so the
    // main process can inject its secure credential only for Jev runs.
    this.layaVerifierFactory = layaVerifierFactory || ((opts) => require('./layaDecision.cjs').createLayaVerifier(opts));
    this.jevVerifierFactory = jevVerifierFactory || ((opts) => require('./jevProvider.cjs').createJevVerifier(opts));
    // Transport failures replay on the cumulative API-only ladder from
    // providers/retry.cjs. Deterministic browser outcomes never use it.
    this.transportRetryDelays = RETRY_DELAYS_MS;
    this.emit = emit;
    this.createProvider = createProvider;
    this.onTerminal = onTerminal;
    this.onCheckpoint = onCheckpoint;
    // LORDE_AI_CHAT_TITLES_V1 — main-process callback that performs one tiny
    // completion to name the conversation (see createChatAgent in main.cjs).
    this.titleApi = titleApi;
    // GEN9: where per-run notebook files live (desktop: userData/notebooks;
    // CLI: the run's --out-dir). Null falls back to a temp directory.
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
    // SLASH-FIRST: /notebook is a UI command, not a task — it must open the
    // notebook IMMEDIATELY. Without this, an idle app queued '/notebook' as
    // a full agent run and burned a model decision answering a UI command.
    // (With a live conversation, handleSlashCommand already intercepts it.)
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
    // Slash commands typed while a conversation exists (idle OR live) act
    // directly on that conversation WITHOUT burning a model decision. Without
    // this, an idle '/compact' became a regular task: the model called
    // chat_compact on an already-small ledger and re-stated the previous
    // conclusion as its answer.
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
    // Legacy renderer payloads may still call captured elements DOM 1/DOM 2.
    // Upgrade those aliases at the agent boundary before they can enter model
    // context; the frontend remains the only place that renders links.
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
    if (previous?.heartbeatTimer) { clearInterval(previous.heartbeatTimer); previous.heartbeatTimer = null; }
    if (previous?.escalationTimer) { clearInterval(previous.escalationTimer); previous.escalationTimer = null; }
    // Turn clock: "Worked for" measures the CURRENT turn. A continuation whose
    // task text differs is a NEW user turn (the clock restarts); an identical
    // task is the same turn continuing (recovery/resume — the clock carries).
    const turnContinuation = continuation && previous && task === String(previous.task || '').trim();
    // OWNER DIRECTIVE (2026-10-15): a new-turn continuation whose message is
    // an ADDITION (no explicit replace/abandon cue) extends the running work
    // — the plan/goals and the pinned objective carry forward, the objective
    // ledger keeps the previous task open — instead of resetting everything.
    const additionTurn = continuation && !turnContinuation && isTaskAddition(task);
    // WALL-CLOCK turn start: pool runs carry queuedAt (the moment the spawn
    // was requested) so the "Worked for" clock measures queue stalling too,
    // not just the time after a slot freed. Direct chat runs have no queue
    // and start now.
    const turnStartedAt = turnContinuation
      ? Number(previous.turnStartedAt || previous.createdAt || Date.now())
      : (Number.isFinite(Number(request?.queuedAt)) && Number(request.queuedAt) > 0 ? Number(request.queuedAt) : Date.now());
    // Run-level external deadline: the only source that can create a
    // non-resuming parked state. Parsed from unambiguous task phrases
    // ("within 30 seconds") or an explicit settings.maxRunMs. null = unlimited.
    const deadlineAt = deadlineAtForTurn({
      task,
      explicitMs: request?.settings?.maxRunMs,
      turnStartedAt,
      previousDeadlineAt: previous?.deadlineAt,
      sameTurn: turnContinuation
    });
    const providerConfig = request?.provider || previous?.provider || { id: 'ollama', model: '' };
    // Publish an identifiable startup snapshot before provider construction.
    // Providers can reject synchronously (for example, a cloud connection
    // without a model); pool tracking must never observe a null run in that
    // case, and the original provider error must remain visible.
    const startupRunId = continuation ? previous.id : crypto.randomUUID();
    this.run = { id: startupRunId, task, status: 'starting', provider: providerConfig, history: [], plan: [], goals: [], result: null };
    const provider = this.createProvider(providerConfig);
    // Kept on the run so harness-initiated compaction (chat_compact, /compact)
    // can reach the provider's own summarizer transport.
    const providerInstance = provider;
    const remoteExecution = provider?.executionTarget === 'remote';
    const settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(previous?.settings || {}), ...(request?.settings || {}) });
    if (Number.isFinite(Number(provider?.absoluteTimeoutMs)) && Number(provider.absoluteTimeoutMs) > 0) settings.stepAbsoluteTimeoutMs = Number(provider.absoluteTimeoutMs);
    let resolvedWorkspace = normalizeWorkspace(request?.workspace || previous?.workspace || workspaceFromTask(task));
    // A filesystem attachment that IS a folder seeds the run's default
    // workspace scope when the caller declared none (task text and explicit
    // request.workspace win): the agent's computer tools read the folder
    // directly from that root — that is the whole point of path attachments.
    // The existing AGI promotion below follows from the seeded root, so the
    // file tools are actually available to use it.
    if (!resolvedWorkspace?.root) {
      const directoryAttachment = Array.isArray(attachments)
        ? attachments.find((item) => item?.kind === 'path' && item?.isDirectory)
        : null;
      if (directoryAttachment) {
        resolvedWorkspace = normalizeWorkspace({ root: directoryAttachment.path, target: directoryAttachment.path });
      }
    }
    // A task that declares a filesystem workspace is file work by definition:
    // in browser mode every file action fails with "Computer tools require the
    // user-selected AGI mode". Promote THIS run to agi when a workspace is
    // declared and execution is local; an explicit agi choice is always
    // honored, and remote providers stay browser-only (the throw below stands).
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
    // AGI exposes both browser and computer tools. Start from the browser
    // observation when a task names an open page, but do not force the domain:
    // the model can switch to computer_observe or a computer_* action whenever
    // a native dialog, strict canvas, file picker, or desktop surface appears.
    // (Starting from native window metadata instead made every browser task
    // blind: the model received desktop titles and bounds, not the page, and
    // reasoned about what it could not see.)
    const initialDomain = previous?.observationDomain || 'browser';
    // E11 (gen3): probe the computer backend ONCE for the headless-stub marker
    // (cli/stubs.cjs). When the backend is the headless CLI stub, the native
    // file tools it cannot execute are stripped from the advertised catalog —
    // they failed in every headless campaign run. The desktop backend keeps
    // the full surface.
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
      // DEFERRED TOOL LOADING: the tools whose full schema the model has asked
      // for. Promotion is monotonic (Intel's accumulate rule), so the cached
      // prompt prefix stays stable and a tool never loses its schema mid-run.
      // The full catalog itself is rebuilt per decision (its membership
      // changes with the run's skills and live agents) and kept on
      // run.activeToolCatalog for the schema-serving path.
      promotedTools: new Set(continuation ? [...(previous?.promotedTools || [])] : []),
      title: continuation ? previous.title : fallbackConversationTitle(task),
      provider: providerConfig,
      providerInstance,
      settings,
      status: 'running',
      history: continuation ? [...(previous.history || [])].slice(-80) : [],
      // Native-surface awareness ledger (window ids already announced),
      // rehydrated as a Set. A dialog already surfaced before the continuation
      // must never re-nudge; one that was open but never announced must stay
      // FRESH rather than being swallowed by a re-seeded baseline.
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
      // Wall clock of the current turn's start (new user message or fresh
      // run); carried across same-turn recovery/resume, reset on steers.
      turnStartedAt,
      // External deadline (absolute epoch ms) or null for unlimited. This is
      // the ONLY source that parks a run without auto-resume — ordinary
      // recovery/stall/heartbeat paths remain indefinite per the owner
      // directive in README_PATCH_STALL_CEILINGS.md.
      deadlineAt,
      deadlineParked: false,
      deadlineFinishNoticeArmed: false,
      // Stall heartbeat: the wall-clock of the last observable progress (any
      // published event except the synthetic thinking-clock ticks). The
      // interval below turns silence into a visible warning, then a forced
      // step end, instead of an invisible 7.5-minute provider window.
      lastRealActivityAt: Date.now(),
      // Fast path (LORDE_FAST_PATH): actions the model decided whose args
      // finished streaming BEFORE its decision did. Executed immediately when
      // non-destructive; the batch loop consumes the recorded result instead
      // of re-executing. Keyed by actionHash, persists across decision
      // replays so a replayed decision cannot double-execute.
      eagerResults: new Map(),
      eagerInFlight: false,
      stallRecoveries: 0,
      heartbeatTimer: null,
      // Park-and-hold escalation (Stage A): watchdog fires accumulate here and
      // park the run at the threshold — never terminate it.
      watchdogFires: 0,
      escalation: null,
      escalationTimer: null,
      completedAt: null,
      telemetryDetailed: continuation ? previous.telemetryDetailed !== false : !isCheapInformationalTask(task),
      lastObservedUrl: continuation ? previous.lastObservedUrl : null,
      // A new task in the same conversation is a TURN BOUNDARY: the previous
      // task's plan and goals are closed work. Carrying them forward made the
      // model resurrect old objectives ("remove that label" executed as an
      // old task's leftover plan). Same-task continuations keep them.
      // Same-turn recovery AND no-prior-task resumes keep the restored
      // plan/goals; only a real turn boundary (known prior task, new task
      // text) starts empty on purpose.
      // ADDITION turns (owner directive 2026-10-15) CARRY them: a mid-run/
      // queued message extends the running work, so the model appends items
      // to the live plan instead of restarting from an empty one.
      plan: (continuation && (turnContinuation || !previous?.task || additionTurn)) ? normalizeConversationPlan(previous.plan) : [],
      goals: (continuation && (turnContinuation || !previous?.task || additionTurn)) ? normalizeConversationPlan(previous.goals) : [],
      // A NEW user turn in an existing conversation: the completed-work ledger
      // resets (below) and the first browser_done is forced through the
      // completion review with the current objective restated, so a done about
      // the closed task can never pass the evidence gate. EVERY turn whose
      // task text differs from the previous turn's is a boundary — including
      // the turn after a pure Q&A exchange. The old `previous?.task` guard
      // starved the boundary after Q&A turns (and after any continuation
      // restored from a snapshot that predates task persistence), leaving the
      // pinned objective stale: the model resurrected a task fixed two turns
      // earlier instead of answering the newest message. The cheap path stays
      // cheap — the boundary notice is just shorter for Q&A-shaped tasks.
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
      // Actionless model stall detector. This is diagnostic-only and has its
      // own park threshold so unrelated heartbeat/thought watchdog fires do
      // not cross-contaminate it.
      actionlessStall: continuation ? normalizeActionlessStall(previous?.actionlessStall) : { key: '', count: 0, noticeKey: '', parkKey: '' },
      streamingThoughtStall: { seen: [], cursor: 0, repeats: 0, noticeArmed: false },
      // Loop-controller flow state (inspect -> plan -> act -> verify -> accept):
      // bounded digests/counters only, never file contents. A same-task
      // continuation keeps it; a new turn starts a fresh evidence epoch.
      flowControl: continuation && turnContinuation
        ? createFlowControlState(previous?.flowControl)
        : resetFlowControlForUserTurn(continuation ? previous?.flowControl : null, task),
      // E2 one-shot harness notices (navigation / classified recovery /
      // park-resume / E9 rebuild tripwire): armed by events, delivered into
      // exactly one RENDERED decision (cleared post-decision since E10).
      harnessNotices: continuation && Array.isArray(previous?.harnessNotices) ? [...previous.harnessNotices] : [],
      // E7/E8 (gen3): the run's last constraint conflict — a fill the page
      // rejected or an E7 tamper bounce — recorded with the history length at
      // bounce time, the provenance boundary the blocked-done gate reads.
      constraintRejection: null,
      blockProvenanceBounces: 0,
      // E9 (gen3): the rebuild tripwire fires at most once per run.
      rebuildNoticeFired: false,
      // E11 (gen3): the computer backend is the headless CLI stub.
      computerToolsHeadless,
      // Auto starts at standard so direct commands act quickly; rapid surfaces
      // and cheap conversation start at minimal and skip deliberation. The
      // model may request advanced only when a real decision needs it.
      // Fixed tiers never move.
      effortTier: settings.effort === 'auto'
        ? (isCheapInformationalTask(task) || isRapidTask(task) ? 'minimal' : 'standard')
        : settings.effort,
      effortTierRecoveries: 0,
      effortNeedSignals: 0,
      requiredEvidenceRevision: 0,
      decisionObservationRevision: 0,
      latestObservation: null,
      // Per-tab grounding: the newest observation for every tab this run has
      // explicitly observed, so actions carrying an explicit tabId validate
      // coordinates and visual targets against THAT tab, not the last one.
      // Runtime-only state: excluded from serialization (serializeRun) and
      // bounded by MAX_TAB_OBSERVATIONS.
      observationsByTab: new Map(),
      diagnosticCursor: { console: [], network: [] },
      visualEvidence: null,
      // F3 (gen5) visual-evidence ledger: durable record of every capture the
      // run produced (tool calls, in-band observation frames, image
      // attachments) — E12's screenshot-citation matching reads it.
      visualLedger: [],
      intermediateMessagePublished: false,
      usage: continuation ? (previous.usage || previous.turnLedger?.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 }) : { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
      thoughtCount: Number(previous?.thoughtCount) || 0,
      // The completed-work ledger is per-TURN evidence. Carrying the closed
      // task's mutations into a new turn let a wrong-task browser_done pass
      // the evidence-verified gate on work the new task never did (reported as
      // "the effects fix" completing a favourites run). Same-turn recovery
      // AND resumes with no known prior task text keep the ledger.
      // ADDITION turns keep this RESET too: the carried plan items stay done,
      // but the ADDED requirement still needs fresh evidence — a mutation
      // hash from the previous turn must never verify the new turn's done.
      coordinator: createCoordinatorState({ completedWork: continuation && (turnContinuation || !previous?.task) ? (previous.completedWork || previous.coordinator?.completedWork) : [] }),
      workingMemory: continuation ? normalizeWorkingMemory(previous.workingMemory) : normalizeWorkingMemory(null),
      completionCandidate: null,
      completionReviewForced: false,
      completionReviewBounces: 0,
      incompleteWorkBounces: 0,
      // The coverage-accounting gate keeps its own counter: it and the
      // plan-items gate are separate gates, and one bounce from each must not
      // add up to a shared limit.
      accountingBounces: 0,
      // E4 (gen4) requirement ledger: numbered requirements in the task text
      // (A1) … B2) … or plain 1. 2. 3.) seed per-requirement entries at run
      // start, so the completion_review bounce can name the SPECIFIC open
      // requirement + its missing evidence, and a done whose ledger is fully
      // settled is accepted without the generic review round trip. Empty for
      // tasks without numbered requirements (behavior unchanged).
      requirementLedger: parseNumberedRequirements(task).map((req) => ({ ...req, status: 'open', evidence: null })),
      lastCheckpointStep: -1,
      eventRevision: continuation ? Number(previous.eventRevision || 0) : 0,
      timelineClock: continuation ? Number(previous.timelineClock || 0) : 0,
      messages: continuation ? normalizeConversationMessages(previous.messages) : [],
      interactionMemory: createInteractionMemory(continuation ? previous.interactionMemory : null),
      thinkingArchive: continuation ? normalizeThinkingArchive(previous.thinkingArchive) : []
    };
    // Tool executors are standalone functions, but ask_user must publish the
    // pending question before it waits. Keep this callback runtime-only; it is
    // removed by serializeRun and never crosses IPC.
    run.publishEvent = (type, payload = {}) => this.publish(type, run, payload);
    run.resultStore = this.createResultStore?.(run.id) || null;
    // F3: an image attachment the run started with is visual evidence it
    // genuinely holds — seed the ledger so citation matching can see it.
    if (Array.isArray(attachments) && attachments.some((item) => item?.kind === 'image')) recordVisualCapture(run, 'attachment');
    run.turnLedger = new ProviderTurnLedger({ snapshot: continuation ? (previous.turnLedger?.snapshot() || previous.providerLedger) : null,
      contextTokens: settings.contextWindowTokens || 131_072, archive: run.resultStore ? value => run.resultStore.write(value) : null });
    // A new user message is a NEW turn: the per-turn usage counters (the
    // footer's requests/tokens) restart here. Turn continuations — recovery
    // restarting the SAME task — keep counting the same turn.
    if (!turnContinuation) run.turnLedger.beginTurn();
    // GEN9 RUN NOTEBOOK — durable per-run session state. The file on disk is
    // the source of truth; it is created (seeded from the task's requirements
    // and the resolved workspace) at run start and re-opened on continuation.
    // If a restored conversation predates repoMap persistence, the map is
    // rehydrated from the notebook's WORKING REPOS section (workspacePin
    // parseRepoSection) — one source of truth, mirrored, never duplicated.
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
      // The task-derived workspace (or attachment-seeded root) is THE working
      // repo from the first decision — D1's exact failure (the `-v2` suffix
      // forgotten mid-run) starts with the pin living only in prose.
      registerRepo(run.repoMap, resolvedWorkspace?.root, { pinned: Boolean(resolvedWorkspace?.root), source: 'task' });
    } else if (!run.repoMap.some(item => item.pinned)) {
      // Restore from an older snapshot: rehydrate from the notebook mirror,
      // then re-pin the CURRENT workspace (the authoritative default).
      run.repoMap = run.notebook.repoMapFromDisk();
      registerRepo(run.repoMap, resolvedWorkspace?.root, { pinned: Boolean(resolvedWorkspace?.root), source: 'previous' });
    }
    // Directories the task text names join the repo map even when they are
    // not the pinned root (referenced, not active — the N2 row).
    recordRepoMentions(run.repoMap, task, fs);
    if (notebookSeed.seeded || run.notebook.syncRepoSection(run.repoMap).changed) syncNotebook(run);
    run.pendingUserMessages = continuation ? (previous.pendingUserMessages || []) : [];
    run.computerOwner = request.computerOwner || `chat:${run.id}`;
    run.coordinator.metrics.attemptStartedAt = run.attemptStartedAt;
    // A thinking ceiling the USER states in the task ("thinking must use a
    // maximum of 10s") is hard and run-wide: every decision is held to it,
    // not just the turn that mentioned it. The model can lower it, never
    // raise it (see the clamp in withDecisionWatchdog).
    const statedBudget = harvestThinkingBudgetFromText(task);
    if (Number.isFinite(statedBudget) && statedBudget >= 0) {
      run.thinkingBudgetCapMs = Math.min(statedBudget, 15 * 60_000);
      // A stated ZERO budget ("no thinking") is the one case that turns
      // reasoning off at the provider. A stated non-zero budget deliberately
      // does NOT touch the effort tier: "minimal" prompts for the fewest
      // actions, which batches more work into each decision and measured
      // 18-26s of thinking against 10.6s at the default tier — the opposite of
      // the limit asked for. The NUMBER is what steers the model, and it holds
      // itself to it (9.1-12.1s against a stated 10s).
      if (statedBudget === 0 && run.settings?.effort === 'auto') {
        const affordable = applyEffortEscalation({ mode: 'auto', tier: run.effortTier }, { thinkingBudgetMs: 0 }).tier;
        if (affordable && EFFORT_TIERS.indexOf(affordable) < EFFORT_TIERS.indexOf(run.effortTier)) run.effortTier = affordable;
      }
    } else if (continuation && Number.isFinite(Number(previous?.thinkingBudgetCapMs))) {
      run.thinkingBudgetCapMs = Number(previous.thinkingBudgetCapMs);
    }
    if (request?.resumeRecovery !== true && (!continuation || run.newTurn)) appendConversationMessage(run, 'user', task, { domAttachments });
    // LORDE_AI_CHAT_TITLES_V1 — a real user turn may have shifted the topic:
    // let the model rename the conversation (throttled, silent, best effort).
    void maybeGenerateConversationTitle(this, run);
    // Skill Brain: surface learned skills for this task from the very first
    // decision, so proven steps replace trial-and-error. Runtime-sourced, so
    // the note never masquerades as a user instruction.
    try {
      const matched = this.skillsApi?.search?.({ task, limit: 2 }) || [];
      if (matched.length) {
        run.usedSkills = [];
        const lines = matched.map(entry => {
          const digest = this.skillsApi.digest(entry.skill);
          return `- ${digest.name} (skillId: ${digest.id}) â€” when: ${digest.when || 'as demonstrated'} â€” steps: ${digest.steps.join(' -> ')}`;
        });
        appendConversationMessage(run, 'user', `Learned skills that may cover this task (call skill_run with a skillId to load full steps before improvising):\n${lines.join('\n')}`, { source: 'runtime' });
      }
    } catch { /* a missing skill store must never block a run */ }
    // Research subagent: MODEL-DECIDED, not compulsory. The run never spawns
    // research automatically â€” the strong model calls research_task when the
    // task involves unfamiliar software specifics (hotkeys, URIs, flags) where
    // fresh web evidence makes it faster and more correct. Findings, when they
    // arrive, are delivered as advisory runtime context at a later model
    // boundary, exactly once; any failure is discarded silently. The user
    // must never notice research existed.
    // See desktop/research/researchPipeline_flow_chat.md.
    run.research = { promise: null, result: null, delivered: true, pending: false };
    run.researchDefaults = { providerConfig, remoteExecution, task };
    // Cross-session inbox: messages from other live sessions, delivered into
    // the next decision context exactly once, then cleared.
    run.pendingAgentMessages = Array.isArray(request?.initialAgentMessages)
      ? request.initialAgentMessages.slice(-12).map(message => ({ ...message, text: String(message?.text || '').slice(0, 4000) }))
      : [];
    run.researchHost = this;
    // System One verification brain (opt-in): the new layaBrain switch is
    // off|laya|jev. Keep legacy layaEnabled settings working as laya until
    // main-process migration has persisted the new field.
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
        // The key is injected only by the main-process factory from secure
        // storage; never accept or copy it through run settings.
        run.layaVerifier = this.jevVerifierFactory({ baseUrl: settings.jevBaseUrl, modelId: settings.jevModelId, fallback: this.layaVerifierFactory({}) });
        this.publish('laya.enabled', run, { mode: 'jev', endpoint: settings.jevBaseUrl, brain: 'jev', model: settings.jevModelId });
      } catch { run.layaVerifier = null; }
    }
    // Turn boundary for follow-up tasks in the same conversation: the model
    // otherwise reads the whole prior history (including closed tasks' work,
    // e.g. an old device-status chip fix) and resurrects those objectives
    // instead of the new instruction. Runtime context — never rendered.
    // EVERY turn whose task text differs from the previous turn's is a
    // boundary, regardless of whether the prior turn did work: the pinned
    // objective and the task ladder must lead with the NEWEST user
    // instruction after a Q&A turn exactly as after a task turn. A stale
    // originalTask made the model dismiss the new task as "prior turns' work"
    // and resubmit the old conclusion. The cheap path keeps its economics:
    // Q&A-shaped turns get a one-line boundary instead of the full ceremony.
    if (run.newTurn) {
      // OWNER DIRECTIVE (2026-10-15): an addition turn EXTENDS the pinned
      // objective instead of replacing it — the previous task text stays in
      // the pin alongside the addition. Explicit-replacement turns keep the
      // swap (a stale pin must never outvote the user's newest word).
      if (additionTurn) {
        // The live ledger's pin is authoritative; a mock/legacy continuation
        // (whose provider never called begin) falls back to the previous
        // turn's task text so the extension chain is never lost.
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
      // An addition turn keeps the previous objective OPEN (it is still being
      // worked) — only an explicit replacement closes it (done when verified,
      // abandoned otherwise).
      { boundary: run.newTurn && !additionTurn, previousResult: continuation ? previous.result : null, at: Date.now() });
    syncObjectiveLedger(run);
    // GEN9: the pinned notebook + workspace pin lead the wire from the very
    // first decision (and every one after — see the per-decision sync below).
    syncNotebook(run);
    if (run.newTurn) {
      // OWNER DIRECTIVE (2026-10-15): the ADDITION framing is the default —
      // a queued/fast-forwarded message extends the running work. The
      // closed-turn framing fires only when the message explicitly cancels
      // or replaces the previous task.
      appendConversationMessage(run, 'user', turnBoundaryNotice(task, { addition: additionTurn }), { source: 'runtime' });
    }
    // The model must know why computer_* tools exist on a run the user left in
    // browser mode: the declared workspace promoted this run to file work.
    if (workspacePromoted) {
      appendConversationMessage(run, 'user', `This run enabled the native file tools (computer_*) because the task declares a workspace at ${resolvedWorkspace.root}. That workspace is the DEFAULT search/index scope, not a boundary: file, terminal, and git access anywhere on disk is allowed.`, { source: 'runtime' });
    }
    // Notice-only planning guidance for genuinely multi-part work. The plan
    // remains optional: this teaches the difference between a thought-list and
    // the validated update_plan state without blocking a useful first action.
    if (isMultipartTask(task) && !run.plan.length && !run.flowControl.planPrompted) {
      run.flowControl.planPrompted = true;
      run.flowControl.planPromptCount = Math.min(3, run.flowControl.planPromptCount + 1);
      pushHarnessNotice(run, 'FLOW: this is a multi-part task. Emit update_plan with one item per requested outcome and a short verification criterion; thinking that lists steps is not a harness-owned plan. Then inspect the relevant context and act on the first item.');
    }
    this.run = run;
    // HCU is an optional, lazy native-window sidecar. Discovery happens once
    // before the first decision so the model sees AX/GUI schemas atomically;
    // an unavailable or disabled sidecar leaves the existing computer_* path
    // unchanged.
    if (run.settings.controlMode === 'agi' && this.hcuApi?.ensure) {
      try { run.hcuTools = await this.hcuApi.ensure(); } catch { run.hcuTools = []; }
    }
    this.publish('run.started', run, { task, continuation, workspacePromoted, hcu: run.hcuTools.length ? 'ready' : 'off' });
    this.startStallHeartbeat(run);

    recoveryLoop: while (run.status === 'running') {
      try {
        let latestObservation = null;
        while (run.status === 'running') {
        // fix15: an accepted done is terminal — never re-decide after it. The
        // guard sits at the decision-loop boundary (NOT inside the provider
        // call closure, where a `break` is illegal), and it resolves the run to
        // a terminal status before leaving: breaking out with status still
        // 'running' would send the finally-block's missing_terminal_result
        // recovery straight back into this loop forever.
        if (run.result) {
          if (run.status === 'running') run.status = run.result.success === false ? 'failed' : 'completed';
          break recoveryLoop;
        }
        // Anything executed eagerly during the previous decision's stream and
        // never consumed by its batch is still a real execution: settle it
        // into history now, exactly once, before the next decision starts.
        this.drainEagerResults(run);
        // External deadline check: when the budget is exhausted, park without
        // auto-resume. This is the only non-resuming parked state.
        if (remainingRunMs(run) === 0 && !run.deadlineParked) {
          this.parkOnDeadline(run);
          break recoveryLoop;
        }
        // LORDE_VERIFY_CAP_V1 — when the run deadline is near (< 30s remaining),
        // push a one-shot "stop verifying, finish now" notice. Prevents the
        // 15+ verification loops observed after a successful patch when the
        // user said "finish in 10s" and the agent kept re-verifying.
        if (remainingRunMs(run) !== null && remainingRunMs(run) < 30_000 && !run.deadlineFinishNoticeArmed) {
          run.deadlineFinishNoticeArmed = true;
          pushHarnessNotice(run, 'DEADLINE: budget is nearly exhausted. STOP verifying. If the task is done or the blocker is external, return browser_done NOW with what you have. No more reads, searches, or verification steps.');
        }
        this.deliverSteering(run);
        this.deliverResearch(run);
        // PATCH CADENCE (2026-10-31): twenty patches to one file, the last
        // twelve one line each. Each of those costs a re-read, a decision and
        // a new file hash, and a run that ends there looks like it is working
        // while the actual change never lands as a whole. One notice, at the
        // boundary, then the harness stops repeating itself.
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
            // This sampled effect fingerprint is only a hint. Providers always
            // receive current evidence, including current element indices.
            run.lastObservationChanged = recordObservation(run.coordinator, latestObservation).changed;
            run.interactionDelta = observeInteraction(run.interactionMemory, latestObservation);
          } catch (error) {
            if (run.status !== 'running' || run.abortController.signal.aborted) throw error;
            if (isMessageInterrupt(error)) { latestObservation = null; continue; }
            // An observation that fails EVERY time is a dead end, not a retry
            // loop: each pass allocates a recovery record and a turn, and an
            // unbounded one is an allocation storm that kills the process.
            // Past the ceiling the run is PARKED holding its state (recovery
            // never terminates a run), so the user can fix the surface and
            // resume. A successful observation resets the streak.
            run.observationFailures = (run.observationFailures || 0) + 1;
            if (run.observationFailures >= 40) {
              this.escalateRun(run, `Observation failed ${run.observationFailures} times in a row (${String(error?.message || error).slice(0, 160)}). The run is parked holding its state and its objective; fix the observed surface, then resume.`);
              latestObservation = null;
              break;
            }
            this.scheduleRecovery(run, {
              source: 'observation_timeout',
              error,
              recordSyntheticHistory: true
            });
            latestObservation = null;
            continue;
          }
        }
        if (latestObservation?.navigation?.url) run.lastObservedUrl = latestObservation.navigation.url;
        if (latestObservation) {
          if (latestObservation.screenshot?.data) {
            run.visualEvidence = latestObservation.screenshot;
            // F3: an in-band observation capture is a real produced frame —
            // ledger it (once per observation revision, not per decision
            // re-read of the same observation).
            if (!Array.isArray(run.visualLedger)
              || !run.visualLedger.some((item) => item.source === 'auto' && item.revision === (Number(run.coordinator.observationRevision) || 0))) {
              recordVisualCapture(run, 'auto');
            }
          } else if (run.visualEvidence?.data) latestObservation.screenshot = run.visualEvidence;
          run.latestObservation = latestObservation;
          storeTabObservation(run, run.tabId, latestObservation);
          // Durable visual memory: history stores actions, not what the page
          // looked like between decisions. Without this digest the model
          // re-inspects surfaces it already saw ("I clicked the tab but do not
          // know its controls") and repeats whole inspection passes.
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
        // LORDE_NATIVE_SURFACE_AWARENESS_V365 — detect a native dialog the
        // run's own browser action just opened and steer the model to the
        // computer tools BEFORE it stalls on a tab-bound observation that
        // cannot show the dialog. Runs even when the observation failed
        // (exactly when a modal is blocking the page).
        try { await this.deliverNativeSurfaceNotice(run); } catch { /* advisory detection must never break the decision loop */ }
        this.deliverKnowledge(run, latestObservation);
        this.considerProgramResearch(run, latestObservation);
        this.verifyWithLaya(run, latestObservation);
        // Keep one continuous live thought stream per decision chain, the way
        // polished coding agents do: recovery cycles (narration-only output,
        // schema repair, provider retry) extend the current thinking card
        // instead of ending it and starting an identical new one. A new card
        // starts only after an action executes, a strategy reset, or the run
        // ends. Completion is published in-order before its following
        // action/result, so the renderer can settle this card without ever
        // classifying the terminal reply itself as thinking.
        // PER-DECISION THINKING CLOCK. The thought CARD spans recovery cycles
        // (its text accumulates on purpose), but its timer must NOT: a counter
        // that keeps climbing made "Thought for 45s" out of a fresh decision's
        // first seconds. Every decision starts its count at 0.
        const decisionThinkingStart = Date.now();
        if (!run.activeThoughtId) {
          resetStreamingThoughtStall(run);
          run.activeThoughtId = `${run.id}:decision:${run.step + 1}`;
          run.activeThoughtStartedAt = Date.now();
          // The thought accumulator belongs to the card, not the decision:
          // reasoning from recovery cycles appends to the same live transcript
          // instead of replacing it with a fresh stream each provider call.
          run.thoughtCount = (run.thoughtCount || 0) + 1;
          run.activeThoughtAccumulator = createThoughtAccumulator((reasoning) => {
            // Keep durable strategy memory bounded without truncating what the
            // user sees across provider retries and schema-repair streams.
            // The model's own decision JSON is harvested and executed; showing
            // the raw object in the live transcript is noise, not information.
            const repeated = noteStreamingThought(run, reasoning);
            if (repeated && !run.streamingThoughtStall.noticeArmed) {
              run.streamingThoughtStall.noticeArmed = true;
              pushHarnessNotice(run, 'STREAMING STALL: the current reasoning is repeating. When this decision ends, take the smallest concrete action or discriminating probe instead of restating the task.');
              // Repetition IS the reasoning drifting. A one-shot notice cannot
              // stop a loop it only observes after the fact — end the thought
              // now and let the already-formed decision run.
              if (!run.streamingThoughtStall.abortArmed) {
                run.streamingThoughtStall.abortArmed = true;
                const drift = new Error('The reasoning stream is repeating itself. Close the reasoning now and act on the decision already formed.');
                drift.code = 'REASONING_BUDGET_EXPIRED';
                if (typeof run.abortDecision === 'function') run.abortDecision(drift);
              }
            }
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
        // E2/E10: snapshot the notice queue BEFORE the provider call and clear
        // it only AFTER the decision settles. Draining at call time lost every
        // notice whose decision then failed at the transport or output budget
        // (the splice ran inside the call arguments) — the one-shot channel
        // consumed its message before any model ever saw it. A failed decision
        // executed nothing, so re-delivering the notice on the retry is the
        // correct one-shot semantics: exactly one RENDERED decision, not one
        // attempted call.
        const pendingHarnessNotices = run.harnessNotices?.length ? [...run.harnessNotices] : null;
        // History clock BEFORE the provider call. A fast-path (eager) action
        // executes while the decision is still streaming, so its history entry
        // is older than historyMarkerBeforeBatch; entry.at is strictly
        // increasing, so "at > decisionStartClock" selects exactly this
        // decision's entries (eager included) and survives history trimming.
        const decisionStartClock = Number(run.timelineClock || 0);
        // GEN9: re-read the notebook from disk for THIS decision — a user
        // /notebook edit or popup Save lands in the very next model decision,
        // and the pinned wire head always carries the current state.
        syncNotebook(run);
        try {
          // Every browser or computer action comes from the provider model's current decision.
          response = await withinStepTimeout(run, 'waiting for the model', async (stepSignal, streamProgress) => {
              // First-stream timestamp: the honest split between provider
              // time-to-first-token (queueing/hidden reasoning — genuine
              // provider latency) and generation-after-first-token.
              let firstStreamAt = 0;
              const wrapped = () => { if (!firstStreamAt) firstStreamAt = performance.now(); return streamProgress(); };
              // Baseline for the per-decision thinking measurement below: the
              // accumulator is cumulative when a no-action decision skips the
              // archive step, so the delta — not the raw length — is the
              // honest per-decision reasoning volume.
              run.thoughtBaseChars = String(run.activeThoughtAccumulator?.() || '').length;
              // F6 (gen5): the provider call runs under the per-decision
              // watchdog — ~120s of dead air aborts the attempt and one
              // bounded retry runs; a second hang parks the run via
              // escalateRun (never terminates). The step/absolute backstops
              // still apply as the last-resort ceiling.
              // fix15 guard lives at the decision-loop boundary (see above):
              // a `break` here, inside this async closure, is a SyntaxError.
              const completed = await Promise.resolve(this.withDecisionWatchdog(run, stepSignal, (attemptSignal, onActivity) => provider.complete({
                task: run.task,
                agentIdentity: run.agentIdentity,
                attachments: run.attachments,
                workspace: run.workspace,
                observation: latestObservation,
                // Laya's settled verify rides along here (never awaited inline —
                // see verifyWithLaya): typed confirmations of the PREVIOUS
                // action's effect, advisory only, omitted entirely when off.
                ...(run.layaVerification ? { layaVerification: run.layaVerification } : {}),
                ...(run.researchHint ? { researchHint: run.researchHint } : {}),
                // Cross-session messages: delivered into exactly ONE decision
                // context, then cleared (they are handoffs, not ambient state).
                ...(Array.isArray(run.pendingAgentMessages) && run.pendingAgentMessages.length
                  ? { agentMessages: run.pendingAgentMessages.splice(0, run.pendingAgentMessages.length) }
                  : {}),
                // E2 one-shot harness notices (navigation / classified recovery
                // / park-resume / E9 rebuild tripwire): delivered into exactly
                // ONE decision context; the queue clears after the decision
                // settles (E10 — see pendingHarnessNotices above).
                ...(pendingHarnessNotices ? { harnessNotices: pendingHarnessNotices } : {}),
                observationUnchanged: run.lastObservationChanged === false,
                history: [...run.history],
                messages: run.messages,
                coordinator: run.coordinator,
                plan: run.plan,
                goals: run.goals,
                recovery: run.recovery,
                workspace: run.workspace,
                // DEFERRED TOOL LOADING: the full catalog stays on the run
                // (every tool, always), and the provider receives the compact
                // form of the tools that are not core. A compact tool keeps its
                // name, description and every argument name and type, so a
                // call made against it is still correct; only the long per-field
                // prose is dropped. The model asks for a full schema with
                // tool_schema, and a promoted tool keeps its full schema for
                // the rest of the run.
                tools: buildToolCatalog(run.activeToolCatalog = toolDefinitions(run.task, run.settings.controlMode, {
                  usedSkills: run.usedSkills,
                  observationDomain: run.observationDomain,
                  agentMessagingAvailable: Boolean(run.messageApi?.hasLiveRecipient?.(run.id)),
                  workspace: Boolean(run.workspace?.root),
                  // NAMING: the xkiro live web-search API rides as a MODEL-CHOSEN
                  // tool (never a forced request param) — offered only when the
                  // run's connection can serve it.
                  webSearchAvailable: String(run.provider?.id || '') === 'xkiro',
                  patchFallbackLevel: Number(run.patchFallbackLevel) || 0,
                  hcuTools: run.hcuTools || [],
                  // E11: the headless stub cannot execute the native file
                  // tools — never advertise what every call would refuse.
                  ...(run.computerToolsHeadless ? { headlessComputer: true } : {})
                }), { promoted: run.promotedTools || new Set() }),
                // Resolved effort tier + mode; providers map it onto their own
                // reasoning controls (think flag, num_predict, reasoning_effort).
                effort: run.effortTier,
                effortMode: run.settings.effort,
                signal: attemptSignal,
                workingMemory: run.workingMemory,
                interactionMemory: run.interactionMemory,
                turnLedger: run.turnLedger,
                onThought: accumulateThought,
                // Streamed deltas prove the model is alive: any activity resets
                // the step deadline AND the F6 decision watchdog's dead-air
                // window instead of killing a long think mid-stream.
                onStream: () => { wrapped(); onActivity(); },
                onProgress: () => { wrapped(); onActivity(); },
                // Fast path: the first complete streamed tool call hands to the
                // Jev gate for immediate non-destructive execution while the
                // model is still generating (LORDE_FAST_PATH).
                onActionReady: (call) => this.handleEagerAction(run, call)
              })));
              const settledAt = performance.now();
              run.lastDecisionBreakdown = {
                connectMs: firstStreamAt ? Math.round(firstStreamAt - decisionStartedAt) : null,
                streamMs: firstStreamAt ? Math.round(settledAt - firstStreamAt) : null,
                totalMs: Math.round(settledAt - decisionStartedAt)
              };
              return completed;
            });
          run.decisionCount += 1;
          // VISION DEGRADATION ADVISORY: the provider discovered at runtime
          // that the model cannot accept images. Inform the user once per run.
          if (run.providerInstance?.visionDegraded && !run.visionAdvisoryPublished) {
            run.visionAdvisoryPublished = true;
            this.publish('assistant.message', run, {
              text: `⚠️ ${run.provider?.model || 'The active model'} does not support image input. Continuing with text evidence only. Switch to a vision-capable model for full desktop awareness.`
            });
          }
          // E10: the decision settled and RENDERED — now the notices are
          // consumed. Exactly the delivered lines are removed, so any notice
          // armed while the provider call was in flight survives.
          if (pendingHarnessNotices) {
            run.harnessNotices = (Array.isArray(run.harnessNotices) ? run.harnessNotices : [])
              .filter(line => !pendingHarnessNotices.includes(line));
            // E9 (gen4) delivery proof: the DELIVERY into a rendered decision
            // context is a trace event with the notice ids, so the traces can
            // distinguish "the model saw the notice" from "a notice armed at
            // the last decision" (the gen3 blind spot).
            this.publish('harness.notice.delivered', run, {
              notices: pendingHarnessNotices.map((line) => ({ id: noticeIdFor(run, line), text: line }))
            });
          }
          // Per-decision phase breakdown, visible in the console panel: this
          // is how genuine provider latency (queueing, hidden reasoning) is
          // told apart from programmatic latency (capture, upload, execution).
          this.publish('decision.timing', run, {
            observeMs: Number(run.lastObserveMs) || 0,
            ...(run.lastDecisionBreakdown || {})
          });
          // Auto effort: honor a justified model-requested escalation (one
          // tier, reason required, advanced gated on objective need signals).
          // Fixed modes ignore the request entirely.
          const effortOutcome = applyEffortEscalation(
            { mode: run.settings.effort, tier: run.effortTier, needSignals: run.effortNeedSignals },
            { requested: response?.effortNeeded, reason: response?.effortReason, thinkingBudgetMs: response?.thinkingBudgetMs ?? response?.done?.thinkingBudgetMs }
          );
          if (effortOutcome.escalated) {
            run.effortTier = effortOutcome.tier;
            run.effortTierRecoveries = 0;
          }
          // The model names its reasoning budget the way it names a wait; the
          // watchdog enforces it as a wall-clock deadline on the NEXT decision
          // (see withDecisionWatchdog). Owner: "set the thinking to only a
          // maximum of 20s" must actually mean 20 seconds.
          // A decision that WAS produced clears the cut streak. The ceiling
          // may park the run only for consecutive cuts that produced nothing —
          // never for an occasional overrun in an otherwise healthy run.
          run.reasoningBudgetCuts = 0;
          const namedBudget = harvestThinkingBudget(response);
          if (Number.isFinite(namedBudget) && namedBudget >= 0) {
            // 0 is meaningful ("act with no reasoning"), so it must NOT be
            // dropped by a > 0 test. A ceiling the user stated in the task
            // always wins: the model may spend less than it, never more.
            const capMs = Number(run.thinkingBudgetCapMs);
            run.thinkingBudgetMs = Math.min(namedBudget, 15 * 60_000,
              Number.isFinite(capMs) && capMs >= 0 ? capMs : 15 * 60_000);
          }
        } catch (error) {
          if (run.status !== 'running' || run.abortController.signal.aborted) throw error;
          if (String(error?.message || '') === 'agent-message-arrived') {
            // A coordination message interrupted provider generation. This is
            // not a recovery failure: discard the unfinished decision and
            // immediately request a fresh decision with the inbox message.
            latestObservation = null;
            continue;
          }
          // REASONING BUDGET (owner): the model's time is up. If it had
          // already settled on an action inside its reasoning, act on it —
          // spending another decision re-deriving a choice the stream already
          // contained is the stall this budget exists to end. If it had not,
          // the next decision is told to emit one action and stop.
          if (error?.code === 'REASONING_BUDGET_EXPIRED') {
            const reasoned = String(run.activeThoughtAccumulator?.() || '');
            const partial = reasoned ? extractEmbeddedDecision(reasoned) : null;
            if (partial && hasExecutableDecision(partial)) {
              response = partial;
              this.publish('agent.reasoningBudget', run, { budgetMs: run.thinkingBudgetMs, salvaged: true });
            } else {
              run.reasoningBudgetCuts = (run.reasoningBudgetCuts || 0) + 1;
              this.publish('agent.reasoningBudget', run, { budgetMs: run.thinkingBudgetMs, salvaged: false, cuts: run.reasoningBudgetCuts });
              // CLOSE-OUT, not another full attempt. The cut interrupted a
              // decision that was still forming, so the next attempt's only job
              // is to emit it. Re-cutting that attempt is what turned a single
              // overrun into a dead run: three cuts, no decision, run parked.
              run.budgetCloseout = true;
              // The cut found no decision to run. Drop the effort tier to what
              // this budget can actually afford, so the recovery emits an
              // action instead of reasoning straight into the same cut again.
              // The model climbs back one rung with a reason; the harness only
              // ever lowers it here.
              if (run.settings?.effort === 'auto') {
                const cheaper = applyEffortEscalation({ mode: 'auto', tier: run.effortTier }, { thinkingBudgetMs: run.thinkingBudgetMs }).tier;
                if (cheaper && EFFORT_TIERS.indexOf(cheaper) < EFFORT_TIERS.indexOf(run.effortTier)) run.effortTier = cheaper;
              }
              // NEVER escalate, park, or end the run on a budget cut. A cut
              // means the ceiling interrupted a decision that was still
              // forming — that is the ceiling doing its job, not the run
              // failing. Three strikes used to park the whole task and hand the
              // user a budget error as the result. The close-out above is the
              // recovery; the run ends only when the task ends or its own
              // deadline does.
              // Do not feed the interrupted chain of thought back as recovery
              // context. The plan, latest observation and completed work are
              // already in the next request; replaying this text makes the
              // model repeat the same plan until the next budget cut.
              this.scheduleRecovery(run, {
                source: 'reasoning_budget',
                error: `Reasoning ceiling reached. Use the latest observation and recorded plan; emit only the single next action or browser_done now. Do not restate the task, plan, or prior reasoning.`,
                recordSyntheticHistory: true
              });
              latestObservation = null;
              continue;
            }
          }
          // Count completed-but-invalid decisions, never disconnected retries.
          if (!isTransportError(error)) run.decisionCount += 1;
          const providerBlock = externalProviderBlock(error);
          if (providerBlock) {
            this.record(run, { name: 'agent_provider_blocked', input: {} }, { ok: false, recoverable: false, error: providerBlock });
            run.status = 'failed';
            run.result = { summary: providerBlock, success: false, verified: false, reason: 'provider_external_block' };
            break;
          }
          // The provider cut the decision off at its output-token limit while
          // the model was still reasoning or planning: the plan was real but
          // discarded. Raise-and-inform, never scold â€” telling the model to
          // "just act" made it re-derive the same oversized plan into the
          // same cap, over and over (the plan-forever loop).
          if (error?.code === 'DECISION_OUTPUT_BUDGET') {
            run.workingMemory.outputBudgetCutOffs = (run.workingMemory.outputBudgetCutOffs || 0) + 1;
            this.scheduleRecovery(run, {
              source: 'output_budget',
              error: 'The provider output-token limit interrupted the previous decision before execution. The budget was raised and any retained reasoning is available as evidence: continue it where it stopped, reconciled with the newest observation.',
              recordSyntheticHistory: true
            });
            continue;
          }
          // A network/transport failure is not a model mistake: the failed turn
          // emitted no decision and executed nothing, so replaying it is safe.
          // Cline retry discipline: a SHORT bounded ladder (1s â†’ 2s â†’ 4s),
          // then an honest failure. The old 20s..10m ladder that reset forever
          // could hold a run hostage for hours on a dead connection.
          if (isMessageInterrupt(error)) { latestObservation = null; continue; }
          // LORDE_FLOOD_CAPS_V365 — a request-size/403-class rejection means
          // the context itself is too big (message floods are the usual
          // cause). Shed the flood and retry immediately; transport-retrying
          // an oversized request just exhausts the ladder and kills the run
          // without a visible word.
          if (isTransportError(error) === false && /\b403\b|\b413\b|too large|context length|maximum context|prompt is too long|request too large/i.test(String(error?.message || error))) {
            run.pendingAgentMessages = [];
            run.messages = normalizeConversationMessages(run.messages).slice(-10);
            appendConversationMessage(run, 'user', 'CONTEXT SHED: an incoming-message flood made the request oversized. Pending agent messages were dropped (senders are throttled); the newest conversation tail was kept. Continue the objective.', { source: 'runtime' });
            latestObservation = null;
            continue;
          }
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
            // Transient: the renderer shows this as a live connection strip
            // that clears itself once the model is producing again, instead
            // of a permanent transcript entry.
            this.publish('assistant.message', run, { text: `Connection error (${String(error.message || error).replace(/\s+/g, ' ').slice(0, 160)}). Retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${this.transportRetryDelays.length}); the task will continue automatically.`, transient: true });
            // A killed stream leaves a truncated thinking fragment in working
            // memory; replaying it biases the retry into re-deriving an even
            // longer thought (the growing-timeout spiral). Restart reasoning
            // fresh instead of feeding the model its own unfinished thought.
              await pauseForRetry(delayMs, run.abortController.signal);
            if (run.status !== 'running' || run.abortController.signal.aborted) break;
            continue;
          }
          // Bounded provider-failure recovery: a repeated IDENTICAL provider
          // error (e.g. a 400 caused by bad image data) is not transient and
          // must not replay forever. After 3 identical failures the run is
          // parked (never terminated) so the user can inspect and resume.
          // (Skipped when a reasoning-budget cut already salvaged a decision:
          // there IS a response to execute, so this is not a provider failure.)
          if (!response) {
            if ((run.recoveryFingerprintCount || 0) >= 2 && run.recovery?.source === 'provider_decision') {
              const detail = String(error?.message || error).replace(/\s+/g, ' ').slice(0, 200);
              this.escalateRun(run, `Provider failed with the same error ${run.recoveryFingerprintCount + 1}x (${detail}). The run is parked; fix the root cause or switch the provider connection, then resume.`);
              break;
            }
            this.scheduleRecovery(run, {
              source: 'provider_decision',
              error,
              recordSyntheticHistory: true
            });
            latestObservation = null;
            continue;
          }
        } finally {
          clearInterval(thinkingTimer);
          thinkingMs = Math.max(0, Date.now() - thinkingStartedAt);
          run.coordinator.metrics.phaseMs.model += performance.now() - decisionStartedAt;
        }
        if (run.status !== 'running' || run.result) break;
        run.transportRetryAttempts = 0;
        run.lastObservationChanged = true;
        // LORDE_STORM_DAMPING_V365 — a message that lands while the model was
        // thinking voids only MUTATING decisions. Coordination/read-only
        // responses (spawn a worker, send a message, plan bookkeeping, reads,
        // waits) execute normally: under the field storm the coordinator
        // repeated the same 2-4 minute "spawn eve" thought SEVEN times
        // (~25 minutes) without ever spawning, because every arrival
        // discarded the just-decided task_spawn.
        if (run.messageArrivedWhileStep) {
          run.messageArrivedWhileStep = false;
          const provisionalCalls = normalizeToolCalls(response?.actions || response?.toolCalls || (terminalInput ? [{ name: 'browser_done', input: terminalInput }] : []), run.settings.maxActionsPerStep);
          const stormSafe = new Set(['agent_message', 'task_spawn', 'subagent_close', 'subagent_list', 'update_plan', 'browser_wait', 'browser_observe', 'browser_tabs', 'browser_fetch', 'computer_index', 'computer_search', 'computer_read', 'computer_fs', 'skill_search']);
          if (!provisionalCalls.every((call) => stormSafe.has(call.name))) {
            latestObservation = null;
            continue;
          }
          // Safe calls proceed; the messages reach the next decision context.
        }
        // The old response may have been planned before the user's new scope.
        // Do not execute it or accept its final answer; its pending calls will
        // settle as not executed before the next model request.
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
        // Providers sometimes state a complete, evidence-backed answer beside a
        // final non-activating pointer placement but omit the required done
        // object. Waiting for another provider turn leaves the app looking frozen
        // after the visible pointer has already reached its requested endpoint.
        // Treat only an unambiguous, completed one-move decision as terminal;
        // future-tense progress prose remains a normal follow-up decision.
        if (conclusivePointerMove) {
          calls = [...calls, terminalPointerMoveCompletion(assistantText)];
        }
        // Effort demotion (auto mode): runs START at advanced, which on
        // OpenAI-compatible routes means the provider's own (unbounded)
        // reasoning budget, and only the MODEL could step the ladder down —
        // which speculation-heavy models never request. A decision that burns
        // a large thinking stream without executing a mutation is a
        // harness-side signal: two in a row step the tier down one rung, so
        // long investigations stop paying the full thinking toll per action.
        // Any decision with a mutation (or a normal executed batch) resets.
        {
          const thinkingChars = Math.max(0, String(run.activeThoughtAccumulator?.() || '').length - Number(run.thoughtBaseChars || 0));
          const executable = calls.some((call) => !['update_plan', 'browser_done'].includes(call.name));
          // Low-yield = the decision produced NO executable action at all
          // (pure speculation, plan bookkeeping, or an empty response). Real
          // work — including long-thinking investigations that end in reads —
          // is never penalized.
          const lowYield = calls.length === 0 || (!executable && thinkingChars > 16_000);
          if (run.settings.effort === 'auto' && run.effortTier !== 'minimal' && lowYield) {
            run.speculationStreak = (run.speculationStreak || 0) + 1;
            if (run.speculationStreak >= 2) {
              const demoted = EFFORT_TIERS[Math.max(0, EFFORT_TIERS.indexOf(run.effortTier) - 1)];
              if (demoted !== run.effortTier) {
                run.effortTier = demoted;
                run.effortTierDemotions = (run.effortTierDemotions || 0) + 1;
              }
              run.speculationStreak = 0;
            }
          } else if (executable) {
            run.speculationStreak = 0;
          }
          // Evidence-phase steering is computed after execution below, where
          // decisionEntries contain the real success/failure envelopes. Do not
          // count proposed calls here: this is exactly where malformed
          // display_text calls previously became false "evidence".
          // E5 (gen2 enforcement): thought-budget steering. Pure-reasoning
          // stalls carry tool calls, so the no-progress detectors are blind to
          // them. A decision whose reasoning ran ~10x a healthy budget gets a
          // one-shot notice (the E2 channel); three consecutive over-budget
          // decisions feed the existing watchdog ladder exactly like a stall
          // (nudge → park → hold). Never terminates a run.
          // Escalating, model-aware thinking budget: normal-size, normal-time
          // thinking stays silent; an elevated or heavy decision (by size OR
          // wall-clock) is told its three exits — real plan, act on held
          // evidence, or keep thinking only if one fact is missing. Delivered
          // after the decision settles, so a live thought stream is never cut.
          // Wall-clock only counts when the decision also produced real
          // reasoning: provider queueing / time-to-first-token on a slow route
          // is latency, not deliberation, and must not read as over-thinking.
          const deliberationMs = thinkingChars >= 1_024 ? thinkingMs : 0;
          const thinkingTier = thinkingBudgetTier({ chars: thinkingChars, ms: deliberationMs });
          run.lastThinkingTier = thinkingTier;
          if (thinkingChars > THOUGHT_BUDGET_CHARS || thinkingTier > 0) {
            run.overThoughtStreak = (run.overThoughtStreak || 0) + 1;
            pushHarnessNotice(run, thinkingBudgetNotice(Math.max(thinkingTier, 1)));
            if (run.overThoughtStreak >= 3) {
              run.overThoughtStreak = 0;
              run.watchdogFires = (run.watchdogFires || 0) + 1;
              if (run.watchdogFires >= ESCALATION_PARK_FIRES) {
                this.escalateRun(run, `${run.watchdogFires} watchdog fires: repeated over-budget deliberation produced no discriminating test.`);
              }
            }
          } else {
            run.overThoughtStreak = 0;
          }
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
          // Some models write their decision as a raw JSON object inside the
          // visible narration (the "JSON leak"). That text usually contains a
          // valid, executable decision â€” harvest it instead of looping.
          const leaked = extractEmbeddedDecision(assistantText)
            || extractEmbeddedDecision(String(run.activeThoughtAccumulator?.() || ''));
          if (leaked) {
            calls = normalizeToolCalls(
              leaked.actions || leaked.toolCalls || (leaked.done ? [{ name: 'browser_done', input: leaked.done }] : []),
              run.settings.maxActionsPerStep
            );
          }
        }
        if (calls.length === 0 && !responsePlanApplied) {
          // A no-call decision still has a flow outcome. In particular, a
          // model may say "enough evidence" or narrate a multi-step plan in
          // thinking while emitting no executable call; assess it before the
          // actionless recovery path so the next decision receives guidance.
          const noActionFlow = assessFlowControl(run.flowControl, {
            calls: [],
            evidence: [],
            assistantText,
            reasoningText: String(run.activeThoughtAccumulator?.() || ''),
            planChanged: false,
            planLength: run.plan.length,
            taskIsMultipart: isMultipartTask(run.task),
            thinkingChars: Math.max(0, String(run.activeThoughtAccumulator?.() || '').length - Number(run.thoughtBaseChars || 0)),
            thinkingMs,
            taskText: run.task,
            planTexts: run.plan.map((item) => item.text)
          });
          run.flowControl = noActionFlow.state;
          if (noActionFlow.notice) pushHarnessNotice(run, noActionFlow.notice.text);
        }
        if (calls.length === 0 && responsePlanApplied) {
          // Plan bookkeeping is still a model decision. Preserve it as part of
          // the conversation and let the model decide when planning is useful.
          run.step += 1;
          continue;
        }
        if (calls.length === 0 && isAnswerOnlyTask(run.task, assistantText, run)) {
          // A pure question is not a failed action. Do not inject recovery
          // notices or force a browser/tool call into a conversational answer.
          run.status = 'completed';
          run.result = { summary: assistantText, success: true, verified: false, reason: 'answer_only' };
          // The question never becomes a ladder task — retire the ACTIVE
          // entry opened for it so the ladder keeps listing tasks only. The
          // pinned objective still points at this newest user text.
          run.objectiveLedger = retireAnswerOnlyObjective(run.objectiveLedger);
          syncObjectiveLedger(run);
          appendConversationMessage(run, 'assistant', assistantText);
          break;
        }
        if (calls.length === 0) {
          // An actionless response is recovery context, not a visible reply or
          // a terminal failure. Track exact repeated actionless decisions only
          // while the evidence and plan remain unchanged. This catches a model
          // narrating the same diagnosis forever without penalizing fresh reads,
          // waits, mutations, or valid answer-only turns.
          const stallKey = actionlessStallKey({
            narration: assistantText,
            observationFingerprint: run.coordinator?.fingerprint,
            plan: run.plan,
            source: 'empty_decision'
          });
          const stallCount = noteActionlessStall(run, stallKey);
          if (stallCount >= ACTIONLESS_STALL_NOTICE_STREAK && run.actionlessStall.noticeKey !== stallKey) {
            run.actionlessStall.noticeKey = stallKey;
            pushHarnessNotice(run, 'ACTIONLESS STALL: stop restating the diagnosis. Use one smallest discriminating probe or concrete action now, and make the next attempt materially different.');
          }
          if (stallCount >= ACTIONLESS_STALL_PARK_STREAK && run.actionlessStall.parkKey !== stallKey) {
            run.actionlessStall.parkKey = stallKey;
            this.settleActiveThought(run, 'actionless_stall');
            this.escalateRun(run, 'Repeated actionless decisions produced no new evidence or executable action; the run is parked to resume from preserved state.');
            latestObservation = null;
            continue;
          }
          if (stallCount >= ACTIONLESS_STALL_NOTICE_STREAK) this.settleActiveThought(run, 'actionless_recovery');
          this.scheduleRecovery(run, {
            source: 'empty_decision',
            error: 'The previous response contained no executable action or terminal result. Choose one now: the next concrete tool call, or browser_done. Do not restate what you just said — your own text is already in the conversation above; act on the newest observation instead.',
            recordSyntheticHistory: true
          });
          latestObservation = null;
          continue;
        }
        resetActionlessStall(run);
        // The thinking card closes only at a genuine decision boundary. A
        // narration-only recovery keeps the same card open and appends to it,
        // so the transcript shows one continuous reasoning stream instead of
        // repeated "Thought for Ns" fragments.
        const onlyUpdatesPlan = calls.length > 0 && calls.every((call) => call.name === 'update_plan');
        archiveActiveThinking(run);
        if (!onlyUpdatesPlan) this.publish('assistant.thinking.completed', run, { thoughtId, elapsedMs: Date.now() - thinkingStartedAt });
        // browser_done owns the final visible reply. Suppressing a speculative
        // assistantText here prevents a second, conflicting chat message.
        if (assistantText && !onlyUpdatesPlan && !conclusivePointerMove && !calls.some((call) => call.name === 'browser_done') && !run.intermediateMessagePublished) {
          // Intermediate status prose is visible UI, not durable chat context.
          // Feeding promises such as "I will click..." back into the next
          // decision causes models to rehearse the same unfinished intent.
          this.publish('assistant.message', run, { text: assistantText, thinkingMs });
          run.intermediateMessagePublished = true;
        }

        // Waiting on a long-running job is patience, not decision burn. Keep
        // the wait telemetry, but never turn it into a deterministic stop or
        // a forced action choice.
        const pureWait = calls.length > 0 && calls.every(isWaitPollCall);
        run.lastDecisionWasWait = pureWait;
        if (pureWait) {
          run.decisionCount = Math.max(0, run.decisionCount - 1);
          run.waitTurns = (run.waitTurns || 0) + 1;
        }
        run.step += 1;
        // Retain only this pre-action evidence object; the live observation
        // deliberately drops its screenshot before dispatch.
        const decisionObservation = { desktop: run.latestObservation?.desktop, screenshot: run.latestObservation?.screenshot };
        const planBeforeDecision = JSON.stringify(run.plan || []);
        // Marks where THIS decision's history entries begin. A batch can stop
        // early (rejected call, file-write boundary), so "the last N entries"
        // is not the same as "this decision's entries" — the flow controller
        // must only ever score evidence the decision itself produced.
        const historyMarkerBeforeBatch = run.history.at(-1) || null;
        // E9 (gen3) rebuild tripwire: counts THIS decision's executions of
        // actions whose verified evidence is already settled. One re-execution
        // is the sanctioned corrected probe; two or more in one decision is a
        // completed-flow rebuild.
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
              // Goal-aware ranking: the map leads with files relevant to THIS
              // task (Laya-style goal-token overlap) without the model having
              // to restate the objective.
              ...(run.task && !call.input?.goal ? { goal: quoteRequest(run.task, 1500) } : {})
            };
          }
          // OWNER DIRECTIVE (workspace default-scope, 2026-10-11): the
          // declared workspace is the DEFAULT scope (search/index roots,
          // terminal cwd auto-injection), never the ONLY allowed scope. The
          // former workspaceViolation hard rejection of out-of-root paths is
          // deliberately REMOVED — out-of-root file/terminal/git paths execute
          // normally. Do not re-add a root-boundary access filter; the
          // WorkspaceChangeGuard's file-ownership integrity checks (foreign
          // change / changedAfterRead) are unrelated and stay.
          // Element snapshots are per-tab: an index click carrying an explicit
          // tabId must resolve against THAT tab's snapshot, not the run's.
          const resolvedElement = resolveSnapshotElement(this.controller, String(call.input?.tabId || run.tabId), call);
          const hash = actionHash(call, resolvedElement, decisionObservation);
          // Fast path: this call already executed eagerly while the decision
          // was still streaming (LORDE_FAST_PATH). Its result, history entry,
          // and events exist; consuming the marker here is what prevents a
          // second execution of the model's own decision.
          if (run.eagerResults instanceof Map && run.eagerResults.has(hash)) {
            const eagerEntry = run.eagerResults.get(hash);
            run.eagerResults.delete(hash);
            const eagerOutput = eagerEntry && typeof eagerEntry === 'object' && eagerEntry.output !== undefined ? eagerEntry.output : eagerEntry;
            if (eagerOutput && typeof eagerOutput === 'object') {
              // A consumed eager result must be recorded exactly like the
              // fill-proof path above: without this.record the ledger has no
              // result for the call and settle() truthfully stubs it as
              // "was not executed" even though it ran eagerly.
              this.record(run, call, eagerOutput);
              this.publish('tool.result', run, { tool: call.name, output: eagerOutput, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, eagerOutput) } });
              if (mutation) latestObservation = null;
              continue;
            }
            // No consumable eager output: never silently drop the call —
            // fall through so it executes normally and gets recorded.
          }
          const redundantAppend = repeatedAppendAfterFill(run, call);
          const redundantObserve = repeatedOuterObservation(run, call);
          const redundantScreenshot = repeatedScreenshotFromCurrentObservation(run, call);
          // E3 idempotent-mutation gateway: a fill whose (target identity +
          // exact value) was already applied with observed effect returns the
          // prior proof instead of executing again. Changed target, changed
          // value, or a page change since application executes normally.
          const fillProof = fillGate(run.coordinator, hash, call);
          if (fillProof) {
            const output = { ok: true, alreadySet: true, result: { ...fillProof.proof, alreadySet: true, note: fillProof.advisory } };
            this.record(run, call, output);
            this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
            continue;
          }
          // E7 (gen3) constraint-tamper gateway: a browser_execute that strips
          // or bypasses a form constraint, or writes .value into a control the
          // fill gate just rejected, is rejected BEFORE execution with the
          // conflict-protocol bounce. Recoverable, never a kill; generic JS
          // (reads, styles, unrelated attributes) passes untouched.
          // F5 (gen5): the same channel now also catches presentation-mutation
          // tampering — style/class clears of error/invalid state, or a
          // presentation-clear on a control whose fill the page just rejected
          // (the arch1 borderColor='' / arch2 classList.remove escapes).
          const tamper = constraintTamper(run.coordinator, call) || presentationTamper(run.coordinator, call);
          if (tamper) {
            const output = { ok: false, recoverable: true, recoverySource: 'constraint_tamper', error: tamper.advisory };
            this.record(run, call, output);
            this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
            // E8 provenance boundary: the tamper bounce arms the blocked-done
            // gate and marks the conflict for the fill-gate fold.
            run.constraintRejection = { historyLength: run.history.length, kind: 'tamper' };
            this.scheduleRecovery(run, { source: 'constraint_tamper', error: output.error, call, recordSyntheticHistory: true });
            latestObservation = null;
            continue;
          }
          // E7 (gen4) first-write window: a browser_execute that literally
          // writes .value into a form control is checked against the control's
          // OWN constraint (maxLength/minLength, read by a cheap read-only
          // pre-probe) even with NO prior fill-gate rejection — the gen-ab
          // blind spot where a first 13-char write into a maxlength-9 control
          // sailed through. A verified violation bounces with the conflict
          // protocol; when the executor cannot verify the target (opaque
          // variable provenance) the write is ALLOWED and a HARNESS notice
          // rides the next decision. Generic JS — dynamic writes, reads,
          // styles, non-form elements — never reaches the probe.
          if (call.name === 'browser_execute' && valueWriteLiterals(String(call.input?.script || '')).length) {
            const probedControls = await withinStepTimeout(run, 'reading form-control constraints', () =>
              probeFormControlConstraints(this.controller, String(call.input?.tabId || run.tabId)));
            if (Array.isArray(probedControls) || (probedControls && typeof probedControls === 'object')) {
              const fw = firstWriteViolations(String(call.input?.script || ''), probedControls);
              if (fw.violations.length) {
                const output = { ok: false, recoverable: true, recoverySource: 'constraint_tamper', error: `${CONFLICT_PROTOCOL_ADVISORY} Detected: ${fw.violations[0]}` };
                this.record(run, call, output);
                this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
                run.constraintRejection = { historyLength: run.history.length, kind: 'tamper' };
                this.scheduleRecovery(run, { source: 'constraint_tamper', error: output.error, call, recordSyntheticHistory: true });
                latestObservation = null;
                continue;
              }
              if (fw.unresolved > 0) {
                const controls = Array.isArray(probedControls) ? probedControls : (Array.isArray(probedControls.controls) ? probedControls.controls : []);
                if (controls.some((control) => Number(control?.maxLength) > 0 || Number(control?.minLength) > 0)) {
                  pushHarnessNotice(run, "HARNESS: a browser_execute writes .value directly into a form control; its own maxLength/minLength could not be verified before execution — confirm the write stayed within the control's constraint.");
                }
              }
            }
          }
          // E1 navigation-epoch gateway: element-index anchors minted before a
          // top-level navigation are rejected with a fix-naming error; x/y
          // coordinate actions pass through unchanged.
          const stale = staleAnchor(run.coordinator, call);
          const attempt = stale
            ? stale
            : redundantAppend || redundantObserve || redundantScreenshot
              ? { allowed: true, advisory: redundantAppend || redundantObserve || redundantScreenshot }
              : canAttempt(run.coordinator, hash, mutation, call.expect, call.repeat);
          // The advisory is evidence for the next decision: it has to ride the
          // history entry. Computing it and dropping it left the model (and the
          // transcript) with no idea why the call was redundant.
          if (attempt.advisory) call.advisory = attempt.advisory;
          if (!attempt.allowed) {
            // 'stale_element' is the pre-existing recovery source for
            // stale-anchor rejections (byte-compatible: tests and the Stage B
            // taxonomy pin it); the duplicate gate keeps its own source.
            const gateSource = stale ? 'stale_element' : 'duplicate_action';
            const output = { ok: false, recoverable: true, recoverySource: gateSource, error: attempt.advisory || 'The same mutation was already attempted against this evidence.' };
            this.record(run, call, output);
            this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
            this.scheduleRecovery(run, { source: gateSource, error: output.error, call, recordSyntheticHistory: true });
            latestObservation = null;
            continue;
          }
          // READ-ONLY ENFORCEMENT (run.txt req #2): a coding/diagnosis task whose
          // decisions keep returning only reads/searches has already been told,
          // advisably, that it has read enough. Advisory notices are not enough —
          // a model that varies its query wording never trips the identical-read
          // guards. Past the cap, with no mutation in the batch, a read-style
          // call is REJECTED before execution and the rejection names the only
          // exits. A mutation, terminal, or plan change in the same batch still
          // passes (never block real progress); reads batched alongside a
          // mutation are allowed because the mutation is the point.
          if (
            !mutation
            && genuineEvidenceCall(call)
            && (run.readOnlyDecisionStreak || 0) >= READ_ONLY_ENFORCE_STREAK
            && !calls.some((other) => other.name !== call.name && actionMutates(other.name, other.input))
            && isCodingTask(run.task, run.workspace)
          ) {
            run.readOnlyCapFired = (run.readOnlyCapFired || 0) + 1;
            const demand = readOnlyEnforcementDemand(run.task);
            const output = { ok: false, recoverable: true, recoverySource: 'read_only_cap', error: demand };
            this.record(run, call, output);
            this.publish('tool.result', run, { tool: call.name, output, inspection: { input: inspectionValue(call.name, call.input), output: inspectionValue(call.name, output) } });
            this.scheduleRecovery(run, { source: 'read_only_cap', error: demand, call, recordSyntheticHistory: true });
            latestObservation = null;
            continue;
          }
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
            // Do not time out a human approval prompt. A browser_wait is
            // bounded by the model's own chosen duration and abortable via
            // the run signal, so the step deadline must not cut a long,
            // legitimate wait short. Otherwise, a hung browser command is
            // recoverable evidence rather than a reason to discard the task.
            // LORDE_WAIT_LIVE_V369 — browser_wait runs for up to 15 minutes;
            // publishing only its result made the chat look dead for the
            // whole wait. Announce the start so the renderer can show a live
            // waiting card with an elapsed timer.
            if (call.name === 'browser_wait') this.publish('tool.started', run, { tool: 'browser_wait', input: call.input });
            // ask_user waits on a human, so it is exempt from the step timer
            // exactly like browser_wait: the user may take minutes to answer.
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
            // A browser mutation invalidates the last captured frame; the next
            // observation must re-ground the planner in fresh pixels — EXCEPT
            // text-input mutations under vision auto: fill/type results carry
            // structured proof (matched/changed/value) and the DOM snapshot is
            // the grounding evidence, so uploading fresh pixels adds latency
            // and tokens without information. Clicks, drags, keys, navigation,
            // and any visual-surface work re-arm the capture, and
            // browser_screenshot remains available to the model at any time.
            const textOnlyInputMutation = call.name === 'browser_fill' || call.name === 'browser_type';
            if (!textOnlyInputMutation || run.settings.vision !== 'auto') run.browserNeedsImage = true;
          }
          const latestOutput = run.history.at(-1)?.output;

          // Dead-end detection for terminal jobs: when a job is polled
          // repeatedly with zero output, the run is stuck in a wait loop and
          // must switch strategies instead of polling forever. After 3
          // consecutive empty polls the harness demands a different approach.
          if (call.name === 'computer_terminal' && call.input?.action === 'read' && latestOutput?.result?.state === 'running') {
            const emptyOutput = !String(latestOutput?.result?.output || '').trim();
            if (emptyOutput) {
              run.terminalJobStallCount = (run.terminalJobStallCount || 0) + 1;
              if (run.terminalJobStallCount === 3) {
                pushHarnessNotice(run, `TERMINAL JOB STALL: the job has produced no output across ${run.terminalJobStallCount} polls. Verify whether the expected outcome already exists (e.g. check for the installed binary/file with a direct command), then either proceed or switch to a different install/run strategy. Do not keep polling the same job.`);
              }
            } else {
              run.terminalJobStallCount = 0;
            }
          }
          if (call.name === 'computer_terminal' && call.input?.action === 'read' && latestOutput?.result?.error && /maximum lifetime/i.test(String(latestOutput.result.error))) {
            pushHarnessNotice(run, 'TERMINAL JOB TIMEOUT: the command was killed after exceeding its maximum lifetime. Do not retry the same command — switch to a different approach (e.g. direct download instead of package manager, or a prebuilt binary instead of building from source).');
          }
          if (call.name !== 'computer_terminal' || call.input?.action !== 'read') {
            // Any non-poll action resets the stall counter.
            if (run.terminalJobStallCount) run.terminalJobStallCount = 0;
          }
          // E7/E8 (gen3): a fill the page rejected is the fill-gate constraint
          // rejection. It arms the blocked-done provenance gate and marks the
          // control so the tamper gateway catches the immediate JS bypass.
          // Gen4: the rejected control's identity now includes its DOM
          // POSITION (tag + index among same-tag elements) — the
          // querySelectorAll('input')[N] positional alias that evaded the
          // same-step, selector-text window in arch4-untimed-r1.
          if (call.name === 'browser_fill' && latestOutput?.ok === false) {
            const rejectedIndex = coerceElementIndex(call.input?.element ?? call.input?.index);
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
          // E1/E2: a successful top-level navigation or tab switch bumps the
          // navigation epoch (pre-navigation element anchors are now stale at
          // the gateway until the next observation re-mints them) and arms a
          // one-shot harness notice for the next decision's context.
          if (latestOutput?.ok === true && NAVIGATION_TOOL_NAMES.has(call.name)) {
            bumpNavigationEpoch(run.coordinator);
            if (call.name === 'browser_navigate') pushHarnessNotice(run, 'PAGE CHANGED: re-observe before acting on remembered indices.');
          }
          const loopIssue = recordAction(run.coordinator, { hash, mutates: mutation, output: latestOutput, expectation: call.expect, call, observation: decisionObservation });
          if (loopIssue) {
            // One replan opportunity, then preserve the conversation and stop.
            // A successful repeated read must not erase this separate counter.
            run.readLoopRecoveries = (run.readLoopRecoveries || 0) + 1;
            this.scheduleRecovery(run, { source: 'action_loop', error: loopIssue, call, recordSyntheticHistory: true });
            latestObservation = null;
            break;
          }
          // E9 (gen3) rebuild tripwire: an executed mutation whose identity
          // matches a completed-work entry whose effect is already verified is
          // a re-execution of settled work. One is the corrected probe B3
          // sanctions; two or more in one decision re-executes a completed
          // flow (arch2 untimed-r1 burned 28 of 56 decisions doing exactly
          // that, unobserved). Advisory only: a one-shot E2-channel notice
          // carrying the prior evidence pointer — never a kill, never a gate.
          // F4 (gen5) cross-decision detection: a REBUILD is spread across
          // decisions, not batches — arch4's plateau arm re-executed five
          // full rebuild flows across 54 decisions while E9 fired ZERO times,
          // because the trigger only counted within one decision, excluded
          // navigations, and per-decision hashes never collided across
          // passes. A settled re-execution is now tallied per decision; >=3
          // of them spanning >=2 distinct decisions (navigations included —
          // re-navigating a settled URL is re-execution) trips the same
          // notice. A single legitimate re-execution (the refilled
          // reloaded-checkout form) stays silent.
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
          // A form fill focuses its observed control. A single immediate Enter
          // issued by the same grounded model decision is the semantic submit
          // that follows that fill. It
          // does not need an extra provider round trip merely to rediscover
          // the same focused field.
          const continueFocusedSubmit = mutation && mayContinueFocusedSubmit(
            run,
            call,
            calls[callIndex + 1],
            outcome
          );
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
            // File writes are a hard evidence boundary. Do not let a model
            // batch patch -> read/patch/terminal against a stale filesystem.
            latestObservation = null;
            break;
          }
          // Batched execution: a mutation invalidates the observation used to
          // plan the batch, but it must not end the batch. The remaining calls
          // keep executing consecutively and the outer loop re-observes once,
          // after the batch â€” matching how polished automation agents run
          // dependent actions before their next supervision checkpoint. A
          // stale element or any other failure still ends the batch through
          // the normal error path below.
          // Dialog-trigger anticipation: clicking an element whose text suggests
          // a native dialog (upload, browse, file, open, save, print) should
          // immediately switch to desktop observation. The dialog opens after
          // the click, so the next computer_observe will see it.
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
        // Evidence-phase forcing function: read-only runs can burn many
        // decisions on status/search/observe orientation without ever editing
        // — or, for diagnosis tasks, without ever ANSWERING. Every evidence
        // call returns different content, so unchanged-page guards never fire
        // (and a model that varies its query wording each turn never trips
        // the identical-reads guard either). Runtime context only (never
        // user-visible); reset by any mutation or a new user command.
        const batchHadMutation = calls.some((call) => actionMutates(call.name, call.input));
        // LORDE_STALL_NUDGE_V367 — self-awareness delivered as advisory,
        // never a gate. The streak advances ONLY when this decision produced at
        // least one genuinely executed, successful read-style result and no
        // mutation/terminal. A failed call (for example a malformed argument
        // rejected before execution) is neither evidence nor an invitation to
        // patch: the model must fix the call, not be told it has read enough.
        {
          const evidenceOnly = calls.length > 0 && calls.every((call) => genuineEvidenceCall(call));
          if (!evidenceOnly) {
            // Any mutation, plan update, wait or terminal in the decision ends the streak.
            run.evidenceOnlyStreak = 0;
          } else if (evidenceCallsAllSucceeded(calls, run, decisionStartClock)) {
            run.evidenceOnlyStreak = (run.evidenceOnlyStreak || 0) + 1;
            // Advisory only below the enforcement cap; at the cap the read-only
            // rejection carries the demand and a second notice here would just
            // re-tell the model what the rejection already said.
            if (run.evidenceOnlyStreak >= 4 && run.evidenceOnlyStreak % 4 === 0 && run.evidenceOnlyStreak < READ_ONLY_ENFORCE_STREAK) {
              appendConversationMessage(run, 'user', `EVIDENCE SUFFICIENT: ${run.evidenceOnlyStreak} consecutive evidence-only decisions with no patch. You have read enough to act — state your best-supported hypothesis for the reported symptom in one line and apply the patch (computer_patch) now. Further reads add no information.`, { source: 'runtime' });
            }
          }
          // else: a call failed or never ran. That is recovery context, not
          // evidence — the streak neither advances nor resets.
        }
        // Flow controller: score consult novelty once per decision, then hand
        // one bounded phase notice to the next model call. It never rejects a
        // tool and it never interrupts the current stream.
        const flowThinkingChars = Math.max(0, String(run.activeThoughtAccumulator?.() || '').length - Number(run.thoughtBaseChars || 0));
        const markerIndex = historyMarkerBeforeBatch ? run.history.lastIndexOf(historyMarkerBeforeBatch) : -1;
        const decisionEntries = run.history.slice(markerIndex + 1);
        const flowEvidence = decisionEntries
          .map((entry) => captureEvidence({ name: entry.tool, input: entry.input }, entry.output))
          .filter(Boolean);
        const flowTouchedPaths = calls.flatMap(touchedPathsFromCall);
        const mutationSucceeded = calls.some((call) => actionMutates(call.name, call.input)
          && decisionEntries.some((entry) => entry.tool === call.name && entry.output?.ok === true));
        // A failed action invalidates what the model thought it knew: the next
        // read is a legitimate re-check, not read-spam.
        const actionFailed = decisionEntries.some((entry) => entry.output?.ok === false);
        const flowResult = assessFlowControl(run.flowControl, {
          calls,
          evidence: flowEvidence,
          assistantText,
          reasoningText: String(run.activeThoughtAccumulator?.() || ''),
          planChanged: JSON.stringify(run.plan || []) !== planBeforeDecision,
          planLength: run.plan.length,
          taskIsMultipart: isMultipartTask(run.task),
          thinkingChars: flowThinkingChars,
          thinkingMs,
          mutationSucceeded,
          actionFailed,
          touchedPaths: flowTouchedPaths,
          taskText: run.task,
          planTexts: run.plan.map((item) => item.text)
        });
        run.flowControl = flowResult.state;
        if (flowResult.notice) pushHarnessNotice(run, flowResult.notice.text);
        // assessFlowControl returns a bounce at most once per evidence epoch
        // (it records bounceEpoch in the state it hands back).
        if (flowResult.bounce) {
          this.scheduleRecovery(run, { source: flowResult.bounce.source, error: flowResult.bounce.demand, recordSyntheticHistory: true });
        }
        if (batchHadMutation) {
          run.readOnlyDecisionStreak = 0;
        } else if (calls.length) {
          run.readOnlyDecisionStreak = (run.readOnlyDecisionStreak || 0) + 1;
          const streak = run.readOnlyDecisionStreak;
          // Discrete early checkpoints, then recurring every 3rd decision —
          // a run that keeps reading past 7 must not go unnagged forever. The
          // recurring cadence STOPS at the enforcement cap: past it the
          // read-only rejection carries the demand, and another advisory here
          // would just restate it.
          if ([3, 5, 7].includes(streak) || (streak > 7 && (streak - 7) % 3 === 0 && streak < READ_ONLY_ENFORCE_STREAK)) {
            const taskText = String(run.task || '');
            const diagnosisTask = /\b(?:why|find out|diagnose|diagnosis|explain|investigate|figure out|root cause)\b/i.test(taskText);
            const nudge = diagnosisTask
              // The requested outcome is an EXPLANATION. Once the evidence
              // identifies the cause, more research is not progress — the
              // answer is the deliverable.
              ? [
                `Evidence-phase check: ${streak} consecutive read-only decisions on a diagnosis task.`,
                'If the evidence already identifies the cause, ANSWER NOW: return browser_done with the diagnosis and the specific supporting evidence. Do not run more queries to feel thorough.',
                'Only keep reading when one precise fact is genuinely still missing — state that fact in one sentence and fetch exactly it this decision.',
                taskText ? `The question to answer: ${quoteRequest(taskText)}` : ''
              ].filter(Boolean).join('\n')
              : run.settings.controlMode === 'agi' && isCodingTask(taskText, run.workspace)
                ? [
                  `Evidence-phase check: ${streak} consecutive decisions produced NO edit.`,
                  'Decide from the evidence already collected: co-emit computer_read (the smallest relevant section) and computer_patch on the single most likely cause THIS decision — or state the one precise fact still missing and the single command that obtains it.',
                  'Further untargeted git/search/list calls are not acceptable progress.',
                  taskText ? `The task you must complete: ${quoteRequest(taskText)}` : ''
                ].filter(Boolean).join('\n')
                // General read-only drift (browser mode, non-diagnosis):
                // advance or answer — do not re-inspect.
                : [
                  `Evidence-phase check: ${streak} consecutive read-only decisions.`,
                  'Decide from the evidence already collected: perform the next grounded ACTION that advances the goal, or return browser_done with what the evidence supports. Re-inspecting the same surface is not progress.',
                  taskText ? `The task you must complete: ${quoteRequest(taskText)}` : ''
                ].filter(Boolean).join('\n');
            appendConversationMessage(run, 'user', nudge, { source: 'runtime' });
          }
        }
        // Stage C: one consolidated progress assessment per decision, computed
        // from existing state only. Its ONLY consumer is steering — a runtime
        // advisory naming what is missing. It never fails, blocks, or
        // terminates a run (owner directive: recovery is indefinite).
        const progressAssessment = madeProgress(run.coordinator, {
          // recordObservation's changed signal, read per decision: the
          // coordinator's fingerprint vs the one the previous consumer run saw.
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
      if (run.heartbeatTimer) { clearInterval(run.heartbeatTimer); run.heartbeatTimer = null; }
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
      // Keep only the current run target. Tabs created for intermediate
      // navigation are run-owned resources, not user tabs, and must not
      // accumulate across a long recovery or continuation session.
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

  // Stall heartbeat — fully internal, never surfaced to the user. A run can
  // sit in status 'running' with zero observable progress (provider never
  // streams, or a tab command queues behind a hung DevTools command) while
  // every deadline fires invisibly and recovery re-hangs. The heartbeat keeps
  // a wall-clock activity record and, past a hard ceiling, ends the current
  // step so recovery re-grounds. No events, no notices, no console entries:
  // the user's surface never learns the heartbeat exists. Deliberately
  // UNBOUNDED (owner directive): fires only re-ground, they never terminate.
  startStallHeartbeat(run) {
    // Deliberate waits are NEVER stalls: the wait executors touch the
    // heartbeat on every poll (chunks <= 2s), so this ceiling only ever fires
    // on a genuinely silent run — a provider that never streams or a command
    // that never settles. Overridable for tests via BROWSER_USE_STALL_MS.
    const HARD_STALL_MS = clamp(Number(process.env.BROWSER_USE_STALL_MS) || 420_000, 1_000, 3_600_000);
    const CHECK_EVERY_MS = Math.min(10_000, Math.max(250, Math.round(HARD_STALL_MS / 3)));
    if (run.heartbeatTimer) clearInterval(run.heartbeatTimer);
    run.heartbeatTimer = setInterval(() => {
      try {
        if (!this.run || this.run !== run || run.status !== 'running') return;
        const idleMs = Date.now() - Number(run.lastRealActivityAt || Date.now());
        if (idleMs < HARD_STALL_MS) return;
        run.stallRecoveries = (run.stallRecoveries || 0) + 1;
        run.lastRealActivityAt = Date.now();
        // Stage A: a heartbeat fire is a watchdog fire. Fires accumulate toward
        // the park threshold; they never terminate the run — at the threshold
        // escalateRun parks it (awaiting_recovery + run.escalated + auto-resume).
        run.watchdogFires = (run.watchdogFires || 0) + 1;
        if (run.watchdogFires >= ESCALATION_PARK_FIRES) {
          this.escalateRun(run, `Stall heartbeat fired ${run.watchdogFires} times with no intervening successful mutation.`);
        }
        // Deliberately UNBOUNDED (owner directive): every fire only ends the
        // current step so recovery re-grounds — the heartbeat never
        // terminates a run, no matter how many fires accumulate.
        const error = new Error(`Stall heartbeat: no observable activity for ${Math.round(idleMs / 1000)}s; the current step was ended so the run can re-ground.`);
        error.code = 'agent_stall_abort';
        error.recoverable = true;
        run.activeStepController?.abort(error);
      } catch { /* the heartbeat must never break the run loop */ }
    }, CHECK_EVERY_MS);
    if (typeof run.heartbeatTimer.unref === 'function') run.heartbeatTimer.unref();
  }

  // F6 (gen5) decision watchdog: a per-decision dead-air bound (~120s of no
  // stream/progress activity) with ONE bounded retry on a hung model call.
  // arch1-timed-r1 lost 25% of its scoreboard budget to 372s of dead air on a
  // decision whose provider call never returned — the runner had no
  // per-decision timeout and the backstep kill (540s) murdered a
  // protocol-correct run. After the bounded retry hangs too, the run is
  // PARKED via escalateRun (Stage A — awaiting_recovery + auto-resume), never
  // terminated: the owner directive holds that recovery paths never kill
  // runs. The step/absolute backstops (withinStepTimeout) stay as the
  // last-resort ceiling; this watchdog fires long before them.
  withDecisionWatchdog(run, parentSignal, attemptFn) {
    const windowMs = clamp(Number(run.settings.decisionWatchdogMs) || 120_000, 50, 600_000);
    return new Promise((resolve, reject) => {
      let currentGen = 0;
      let settled = false;
      let timer = null;
      const startAttempt = () => {
        const gen = ++currentGen;
        const controller = new AbortController();
        let lastActivity = Date.now();
        const onActivity = () => { lastActivity = Date.now(); };
        const abortAttempt = (reason) => { try { controller.abort(reason); } catch { /* abort is best effort */ } };
        let budgetTimer = null;
        const abortFromRun = () => abortAttempt(run.abortController.signal.reason || new Error('Agent run was cancelled.'));
        if (run.abortController.signal.aborted) abortFromRun();
        else run.abortController.signal.addEventListener('abort', abortFromRun, { once: true });
        if (parentSignal) {
          if (parentSignal.aborted) abortAttempt(parentSignal.reason || new Error('step aborted'));
          else parentSignal.addEventListener('abort', () => abortAttempt(parentSignal.reason || new Error('step aborted')), { once: true });
        }
        const cleanup = () => {
          clearInterval(timer);
          clearTimeout(budgetTimer);
          if (run.abortDecision === abortAttempt) run.abortDecision = null;
          run.abortController.signal.removeEventListener('abort', abortFromRun);
        };
        // REASONING BUDGET (owner): a monotonic wall-clock deadline on THIS
        // attempt. The dead-air watchdog below never fires while the model is
        // actively thinking — continuous streaming keeps it fed, which is how
        // "a maximum of 20s" became a two-minute monologue. The budget is
        // ALWAYS live and is a real limit: 30 seconds unless the model names a
        // different one with thinkingBudgetMs (like browser_wait's ms). It is
        // NOT derived from the effort tier — that tier starts at its maximum
        // and moves one rung per decision, so a tier-derived budget was 180s
        // of "limit" that never cut anything. When it expires the attempt is
        // cut so the action it already settled on is salvaged and executed.
        const rawBudget = Number(run.thinkingBudgetMs);
        const capBudget = Number(run.thinkingBudgetCapMs);
        let budgetMs = Number.isFinite(rawBudget) && rawBudget > 0
          ? rawBudget
          : (isRapidTask(run.task) ? 3_000 : 30_000);
        // A ceiling the USER stated in the task ("a maximum of 10s") is a hard
        // limit on every decision of the run, not just the one that named it.
        if (Number.isFinite(capBudget) && capBudget >= 0) budgetMs = Math.min(budgetMs, capBudget);
        run.thinkingBudgetMs = budgetMs;
        // THE BUDGET IS THE MODEL'S TARGET, THE CUT IS A RUNAWAY GUARD.
        // Normal tasks keep the wider runaway guard so a cut does not discard a
        // nearly formed action. Rapid tasks are different: the first grounded
        // action is more valuable than a polished explanation, so their short
        // ceiling is enforced directly.
        const guardMs = isRapidTask(run.task) ? budgetMs : Math.max(budgetMs, 30_000);
        const budgetCut = () => {
          if (settled || gen !== currentGen) return;
          const err = new Error(`The reasoning budget of ${Math.round(guardMs / 1000)}s expired while the model was still reasoning. Close the reasoning and act on the decision already formed.`);
          err.code = 'REASONING_BUDGET_EXPIRED';
          abortAttempt(err);
        };
        // A close-out attempt is never cut again. Its whole job is to emit the
        // action the previous cut interrupted; it is bounded by the dead-air
        // watchdog and the run deadline instead. Consumed by exactly one
        // attempt so a later decision is held to the budget again.
        //
        // A budget of 0 ("act with no reasoning") deliberately does NOT fire
        // instantly. Cutting a thought stream that has barely started is
        // strictly worse than letting it run: the interrupted attempt discards
        // a half-formed decision and the close-out has to re-derive it from
        // scratch, which measured 25s against 10s left uncut. So 0 turns
        // reasoning down at the provider instead (the effort tier), and keeps
        // the runaway guard — where a provider CAN switch reasoning off, the
        // tier already did it and there is nothing here left to cut.
        const isCloseOut = run.budgetCloseout === true;
        if (isCloseOut) run.budgetCloseout = false;
        else {
          clearTimeout(budgetTimer);
          budgetTimer = setTimeout(budgetCut, guardMs);
          if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
        }
        // The stream repeating itself IS the reasoning drifting: end it now and
        // act on the decision already formed (owner: "ends the thinking the
        // moment it detects any contradictions or drifting").
        run.abortDecision = abortAttempt;
        timer = setInterval(() => {
          if (settled || gen !== currentGen) return;
          if (Date.now() - lastActivity < windowMs) return;
          run.decisionWatchdogFires = (run.decisionWatchdogFires || 0) + 1;
          if (gen === 1) {
            // First fire: abort the hung attempt and retry exactly once.
            this.publish('agent.decisionWatchdog', run, { fire: 1, windowMs, decision: Number(run.decisionCount) || 0 });
            pushHarnessNotice(run, `DECISION WATCHDOG: the model call produced no activity for ~${Math.round(windowMs / 1000)}s and was aborted; one bounded retry is running (a second hang parks the run — nothing is terminated).`);
            cleanup();
            lastActivity = Date.now();
            startAttempt();
            return;
          }
          // Second fire: park, never terminate.
          settled = true;
          cleanup();
          this.escalateRun(run, `Decision watchdog: the model call hung twice (~${Math.round(windowMs / 1000)}s of dead air each) without producing a decision. The run is parked holding its state; recovery resumes it automatically.`);
          reject(new Error(`decision watchdog: the model call hung twice (~${Math.round(windowMs / 1000)}s dead air each); the run was parked via escalateRun.`));
        }, 250);
        if (typeof timer.unref === 'function') timer.unref();
        Promise.resolve().then(() => attemptFn(controller.signal, onActivity)).then(
          (value) => {
            if (gen !== currentGen) return; // a stale attempt settled after its retry started
            if (!settled) { settled = true; cleanup(); resolve(value); }
          },
          (error) => {
            if (gen !== currentGen) return;
            if (!settled) { settled = true; cleanup(); reject(error); }
          }
        );
      };
      startAttempt();
    });
  }

  // Stage A (harness merge v5): park-and-hold escalation. Watchdog and budget
  // fires NEVER terminate a run (owner directive — README_PATCH_STALL_CEILINGS
  // DO-NOT-RE-ADD). At the park threshold the run is set to awaiting_recovery,
  // announced with a run.escalated event, and an unref'd timer re-grounds it
  // indefinitely; a user message or cancel() is the only manual exit.
  // External deadline park: the ONLY non-resuming parked state. Deliberately
  // distinct from escalateRun (which auto-resumes). A run parked here keeps
  // its state and waits for an explicit user message/continuation. Ordinary
  // recovery, stall, and heartbeat paths remain indefinite per
  // README_PATCH_STALL_CEILINGS.md.
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
    // Clear any auto-resume timer: a deadline park waits for the user.
    if (run.escalationTimer) { clearInterval(run.escalationTimer); run.escalationTimer = null; }
    return true;
  }

  escalateRun(run, reason) {
    if (!run || run.status !== 'running') return false;
    run.status = 'awaiting_recovery';
    run.watchdogFires = 0;
    run.escalation = { at: Date.now(), reason: String(reason || '').slice(0, 400), fires: (Number(run.escalation?.fires) || 0) + 1 };
    this.publish('run.escalated', run, { reason: run.escalation.reason });
    appendConversationMessage(run, 'user', `PARKED: ${run.escalation.reason} Held state: plan ${Array.isArray(run.plan) ? run.plan.length : 0} items, completed work ${run.coordinator?.completedWork?.length || 0}, last evidence revision ${run.coordinator?.observationRevision || 0}. Resume is automatic; a message from you retargets the run.`, { source: 'runtime' });
    try { run.activeStepController?.abort(new Error('run-escalated')); } catch { /* parking must never depend on an abortable step */ }
    const resumeMs = Math.min(600_000, Math.max(1_000, Number(process.env.BROWSER_USE_ESCALATION_RESUME_MS) || 60_000));
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

  scheduleRecovery(run, { source, error, call = null, recordSyntheticHistory = false }) {
    const lastError = redactRecoveryError(error, call);
    const attempts = Number(run.recovery?.attempts || 0) + 1;
    run.recovery = {
      attempts,
      lastError,
      source: String(source || 'agent').slice(0, 80),
      action: call?.name || null
    };
    // Identical-recovery tracking: the SAME source repeating with the SAME
    // redacted error is evidence the current strategy is stuck (used by
    // diagnostics and tests; distinct failures each reset the count).
    // Deliberately UNBOUNDED (owner directive): recovery cycles keep the run
    // alive without inspection — a repeating observation_timeout must keep
    // re-grounding, never terminate the run.
    const fingerprint = `${run.recovery.source}|${lastError}`;
    if (run.recoveryFingerprint === fingerprint) run.recoveryFingerprintCount = (run.recoveryFingerprintCount || 0) + 1;
    else {
      run.recoveryFingerprint = fingerprint;
      run.recoveryFingerprintCount = 0;
    }
    // Stage B: label the failure, append the recovery record, and — when the
    // SAME source repeats with the SAME redacted error — demand a materially
    // different next attempt. Records and demands are information for the next
    // decision; nothing here bounds or terminates the recovery loop.
    const failureClass = classifyFailure(run.recovery.source);
    run.recovery.failureClass = failureClass;
    // Never queue identical one-shot notices repeatedly while a provider or
    // page remains stuck. The model already has the first notice and current
    // recovery state; only a new fingerprint merits another notice.
    const noticeFingerprint = `${run.recovery.source}|${lastError}`;
    const noticeSeen = run.noticeFingerprints ||= new Set();
    // E2: a classified recovery arms a one-shot notice — guidance arrives
    // in-band at the moment of need instead of as standing prompt prose.
    if (failureClass && failureClass !== 'UNCLASSIFIED' && !noticeSeen.has(noticeFingerprint)) {
      noticeSeen.add(noticeFingerprint);
      const priorSameClass = (Array.isArray(run.recoveryLog) ? run.recoveryLog : [])
        .filter((entry) => entry && String(entry.failureClass || '') === String(failureClass)).length;
      const transientFailure = /TRANSIENT|TIMEOUT|TIMED.?OUT|RATE|NETWORK|STALL|RETRY/i.test(String(failureClass));
      if (priorSameClass >= 2) {
        pushHarnessNotice(run, `RECOVERED from ${failureClass} (same failure ${priorSameClass + 1}x): confirmed dead end — make the next attempt materially different.`);
      } else if (transientFailure) {
        pushHarnessNotice(run, `RECOVERED from ${failureClass}: transient failure — retry the SAME call unchanged; do not switch approach over a hiccup.`);
      } else {
        pushHarnessNotice(run, `RECOVERED from ${failureClass}: correct the specific defect in the failed call and retry it; demand a different approach only after the same call fails repeatedly.`);
      }
    }
    run.recoveryLog = [...(Array.isArray(run.recoveryLog) ? run.recoveryLog : []), {
      at: Date.now(),
      source: run.recovery.source,
      failureClass,
      actionHash: call ? actionHash(call) : null,
      note: lastError.slice(0, 300)
    }].slice(-8);
    if (run.recoveryFingerprintCount >= 1) {
      run.recovery.demand = `Identical recovery repeated (${run.recoveryFingerprintCount + 1}x) for ${failureClass} "${run.recovery.source}". State what is materially different about this attempt: put the difference in the retried call's expect, or add one memoryUpdate fact naming it — a different mechanism, target, or timing hypothesis. Never repeat an identical expectation.`;
    }
    run.coordinator.replansWithoutProgress += 1;
    if (recordSyntheticHistory) {
      const advisoryKey = `${run.recovery.source}|${lastError}`;
      const advisorySeen = run.advisoryFingerprints ||= new Set();
      // Advisory context is one-shot. Re-recording the same timeout/recovery
      // turns internal control flow into dozens of visible chat cards and can
      // crowd out the next real model decision.
      if (!advisorySeen.has(advisoryKey)) {
        advisorySeen.add(advisoryKey);
        this.record(run, { name: 'agent_advisory', input: { source: run.recovery.source, action: run.recovery.action } }, { ok: true, recoverable: true, advisory: lastError });
      }
    }
    // The exact result is context for the next provider decision. It is not a
    // user-facing instruction, a strategy reset, or a cancellation request.
    return true;
  }

  // Harness-initiated compaction (chat_compact tool, /compact command): force
  // the run's ledger to summarize + evict right now, outside any decision.
  async forceCompactRun(run, reason) {
    const ledger = run.turnLedger;
    if (!ledger) throw new Error('No conversation ledger is active for this conversation.');
    const summarize = run.providerInstance?.summarizeFor
      ? (system, input, signal) => run.providerInstance.summarizeFor(system, input, signal, run.coordinator)
      : null;
    const stats = await ledger.compact({ current: {}, system: 'compact', tools: [], outputTokens: 2_048, summarize, signal: run.abortController?.signal, force: true });
    this.publish('context.compacted', run, { reason: reason || 'user_slash', ...(stats || {}) });
    return stats || { compacted: false };
  }

  // User slash commands typed in the chat box (mid-run via steer). /compact
  // acts immediately; /goal and /plan rewrite the live lists exactly like the
  // UI editors do, then announce the edit at the next model boundary.
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
    // GEN9: /notebook — open the run's persistent notebook. Desktop: the
    // renderer listens for the notebook.open event and shows the editable
    // popup (monospace, Save merges user sections). `/notebook <text>`
    // appends a user line (NOTES section) directly from the chat box.
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
    // Unknown slash: pass through as a normal steer so nothing is silently eaten.
    return this.steerNow(run, text);
  }

  steer({ runId, text, plan, goals, attachments, domAttachments }) {
    const run = this.requireRun(runId);
    const rawText = String(text || '').trim();
    if (!plan?.length && !goals?.length && rawText.startsWith('/')) return this.handleSlashCommand(run, rawText);
    return this.steerNow(run, text, plan, goals, attachments, domAttachments);
  }

  // Internal steering without slash interception (handleSlashCommand funnels
  // its announcements through here; a passthrough /unknown must NOT re-enter
  // the interceptor and recurse).
  steerNow(run, text, plan, goals, attachments = [], domAttachments = []) {
    if (!['running', 'awaiting_approval', 'awaiting_input', 'paused'].includes(run.status)) throw new Error('This run has ended. Send a continuation instead.');
    // ask_user: the user's reply resolves the pending question and resumes the run.
    if (run.status === 'awaiting_input' && run.userInputResolver && String(text || '').trim()) {
      // The reply IS the ask_user tool result. Queueing it again as a steering
      // message would deliver the same answer to the model twice.
      this.resolveUserInput(run, String(text).trim());
      return { id: crypto.randomUUID(), status: 'answered', runId: run.id };
    }
    // A user plan or goal edit rewrites the live list immediately and is
    // announced at the next model boundary so the agent never keeps working
    // toward a list the user already replaced.
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
    // Fast-forwarded DOM evidence enters the same attachment context as a
    // normal send. The hyperlink is renderer-only; the model receives the
    // stable element name and captured HTML, never a DOM N alias.
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
    // Preserve non-DOM attachments on fast-forward as well. They already came
    // through the trusted renderer, so this synchronous path only copies the
    // bounded metadata/content shape; normal sends still use full validation.
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
    // A new user command is a NEW turn: the "Worked for" clock restarts, and
    // prior action-loop state (duplicate suppression, no-progress counters)
    // belongs to the old scope and must not block the new one.
    run.turnStartedAt = Date.now();
    // The usage counters belong to the same turn as the clock: restarting only
    // the clock made the footer read "28s · 83 requests" for a one-line reply.
    run.turnLedger?.beginTurn();
    // User steering unblocks a stalled run: watchdog accounting resets (Stage A)
    // and the progress streak resets (Stage C).
    run.watchdogFires = 0;
    run.progressStreak = 0;
    run.progressStreakNudged = false;
    run.readOnlyDecisionStreak = 0;
    resetActionlessStall(run);
    resetStreamingThoughtStall(run);
    run.flowControl = resetFlowControlForUserTurn(run.flowControl, String(messages.at(-1)?.content || run.task || ''));
    run.loopState = { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 };
    for (const message of messages) this.publish('user.message.delivered', run, { messageId: message.id });
    // Scope note (runtime context, never rendered): OWNER DIRECTIVE
    // (2026-10-15) — a mid-run message is an ADDITION by default; the model
    // keeps executing the existing plan and folds the instruction in. Only an
    // explicit cancel/replace mention makes it the sole objective.
    const latestText = String(messages.at(-1)?.content || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    appendConversationMessage(run, 'user',
      isTaskAddition(latestText) ? steeringAdditionNotice(latestText) : steeringReplacementNotice(latestText),
      { source: 'runtime' });
  }

  // LORDE_NATIVE_SURFACE_AWARENESS_V365 — an AGI-capable run must not go
  // blind after its own browser action opens a native OS window (file
  // open/save, print, system dialog): browser observation is tab-bound and
  // cannot see, move, or close native windows, so the model used to carry on
  // as if nothing happened and left the dialog hanging for the human. One
  // cheap native window enumeration per decision diffs against the run's
  // baseline; a NEW native dialog — from ANY process, not just ours (the old
  // same-PID filter hid the exact permission/file dialogs that dead-locked
  // runs) — injects a runtime notice steering the model to
  // computer_observe/screenshot + pointer + keyboard until the dialog is
  // dismissed. Browser-only runs are exempt: they have no computer tools to
  // switch to.
  async deliverNativeSurfaceNotice(run) {
    if (!run || run.remoteExecution) return;
    if (run.settings?.controlMode !== 'agi' || typeof run.getComputerTools !== 'function') return;
    const now = Date.now();
    if (now < (run.nativeSurfaceCheckAt || 0)) return;
    run.nativeSurfaceCheckAt = now + 4000;
    let backend = null;
    try { backend = run.getComputerTools(); } catch { return; }
    // TELEMETRY PATH — a window enumeration is a harness-internal probe, not
    // a model action: backends and evidence ledgers must never count it as
    // an executed tool call. The probe therefore rides the backend's
    // dedicated telemetry entry point (scanWindows) whenever the backend has
    // one; the read-only desktop snapshot is the next best source, and the
    // model tool-call entry point is only a last resort — flagged with
    // nativeScan so a backend that understands the flag can exclude it.
    const scanWindows = typeof backend?.scanWindows === 'function'
      ? (owner, signal) => backend.scanWindows(owner, { signal })
      : typeof backend?.observe === 'function'
        ? (owner, signal) => backend.observe(owner, { signal, nativeScan: true })
        : typeof backend?.execute === 'function'
          ? (owner, signal) => backend.execute('computer_window', { action: 'list' }, owner, { signal, nativeScan: true })
          : null;
    if (!scanWindows) return;
    let inventory = null;
    // The observation step of THIS decision already enumerated the desktop:
    // that inventory IS the scan. Enumerating again milliseconds later is the
    // same data and costs a second backend round trip on every decision.
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
    // Detect ANY new dialog window during the run — not just our own PID.
    // File dialogs opened by the browser, permission prompts, and popups from
    // other processes must all be seen and handled. The pid filter was too
    // restrictive and missed the exact dialogs the user complained about.
    const DIALOG_CLASSES = new Set(['#32770', '#32771', 'Chrome_WidgetWin_1', 'Chrome_WidgetWin_0']);
    const isDialog = (w) => {
      const cls = String(w?.className || '');
      const title = String(w?.title || '').toLowerCase();
      // Harness-owned panels (the agent pointer overlay and the app's own
      // window) trip the broad heuristics below ('browser' contains 'browse';
      // the Chromium frame class is in DIALOG_CLASSES) but are the harness
      // itself, never a dialog to resolve. Genuine own-PID dialogs (Open,
      // Save As) still surface: tests pin that behavior.
      if (w?.own === true) return false;
      if (/^browser-use( agent pointer)?$/.test(title)) return false;
      const looksDialog = DIALOG_CLASSES.has(cls)
        || /open|save|select|choose|upload|permission|allow|deny|confirm|dialog|browse|file/.test(title);
      return looksDialog && !w?.minimized;
    };
    const dialogs = windows.filter(isDialog);
    // Baseline is captured at the run's FIRST check (before the model has
    // acted): whatever windows exist then predate this run and never nag.
    if (!run.nativeSurfaceSeen) run.nativeSurfaceSeen = new Set(windows.map(w => w.id));
    const fresh = dialogs.filter(dialog => !run.nativeSurfaceSeen.has(dialog.id));
    if (!fresh.length) return;
    for (const dialog of fresh) run.nativeSurfaceSeen.add(dialog.id);
    // A fresh dialog invalidates any cached observation: it predates the
    // dialog, and the done gates must not accept browser_done until the model
    // has re-observed the state with the dialog in it ("never finish while a
    // dialog is still open"). The in-flight decision keeps its own local
    // observation object — only the cached copies go stale.
    run.computerObservationDirty = true;
    // The cached observation is stale now: it can never show the dialog the
    // run must resolve.
    run.latestObservation = null;
    // WHO GETS THE NUDGE — a browser-domain run is tab-bound and literally
    // cannot see native windows, so ANY fresh dialog (own or foreign) means
    // "switch to desktop tools" (the dead-loop fix). A run already in the
    // computer domain sees every dialog in its normal observation and may be
    // mid-flow driving its own dialogs on purpose — there only FOREIGN popups
    // that stole focus unexpectedly (permission prompts, other apps' dialogs)
    // are worth a notice.
    const switching = run.observationDomain !== 'computer';
    const worthNoticing = switching ? fresh : fresh.filter((dialog) => Number(dialog.pid) !== process.pid);
    if (!worthNoticing.length) return;
    // AUTO-SWITCH to computer observation domain: switching means the next
    // observation gives the model desktop-level state including the dialog;
    // any later browser_* action switches back automatically.
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

  // Model-invoked background research (research_task tool). Spawns the silent
  // subagent for the objective; the run never waits and the model decides
  // whether the task needs it at all. One pending research per run.
  spawnResearch(run, objective, { kind = 'fact', key = null } = {}) {
    const research = run.research;
    // A refused objective is DROPPED, not queued: the brief that arrives
    // later belongs to the objective already running, never to this one. The
    // note must say so plainly — a model that reads "findings will arrive"
    // here concludes its topic was researched, and writes that topic from
    // prebuilt knowledge while reporting it as researched.
    if (!research || research.pending) {
      return {
        started: false,
        note: research?.pending
          ? 'This objective was NOT started: one research brief is already running for this run, and only that one will be delivered. Do not treat this topic as researched — research it yourself, or re-request it after the current brief arrives.'
          : 'Research is unavailable in this run.'
      };
    }
    const researchRunner = this.researchRunner
      || (process.env.BROWSER_USE_RESEARCH === 'off' ? null : defaultDeterministicResearch);
    if (!researchRunner) return { started: false, note: 'Research is unavailable in this session.' };
    const { providerConfig, remoteExecution, task } = run.researchDefaults || {};
    research.pending = true;
    research.delivered = false;
    try {
      const researchContext = {
        task: String(objective || task || '').slice(0, 4000),
        signal: run.abortController.signal,
        runId: run.id,
        // The subagent's own provider: same connection the run selected.
        providerFactory: () => this.createProvider(providerConfig),
        // Xkiro runs get the primary live web-search API (structured results,
        // no challenge walls); every other provider never sees it.
        searchApiFactory: String(providerConfig?.id || '') === 'xkiro' ? () => {
          const provider = this.createProvider(providerConfig);
          return { baseUrl: provider.baseUrl, apiKey: provider.apiKey };
        } : null,
        // Its own browser surface: a dedicated background tab searching real
        // Google with the session's cookies, paced like a human. Never the
        // user's working tab. If Google shows a human-verification challenge,
        // notify surfaces it to the chat while the search waits for the user
        // to clear it, then resumes. Unavailable for remote providers.
        browser: remoteExecution ? null : {
          createTab: this.createTab,
          closeTab: tabId => { try { this.controller.closeTab(tabId); } catch { } },
          search: (tabId, options) => this.controller.search(tabId, { ...(options || {}), engine: 'google' }),
          fetchPage: args => this.controller.fetchPage(args),
          notify: message => this.publish('research.notice', run, { message: String(message).slice(0, 300) })
        },
        metaSearch: this.researchMetaSearch
      };
      // Race the runner against a cleanup grace timer so a hung provider
      // never leaves research.pending true forever (which permanently
      // refuses all later research for this run).
      const researchBudgetMs = 120_000; // 2 min budget + 30s grace
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
          if (result?.timedOut) {
            research.result = null;
          }
          // Knowledge write-back: only findings with real relevant sources
          // enter the store — a bare “no relevant sources” or junk result
          // must never become a durable “fact” (measured live: junk search
          // results once poisoned recall for unrelated tasks).
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

  // Cross-session inbox: another live session delivered a message. It rides
  // into the next normal decision context, preserving this agent's own
  // provider, tools, observation, tab, and task state.
  receiveAgentMessage({ from, fromLabel, text, reply = false }) {
    const run = this.run;
    if (!run || !['running', 'awaiting_approval', 'awaiting_input', 'paused', 'awaiting_recovery'].includes(run.status)) return { delivered: false, reason: 'session-not-live' };
    const entry = { at: Date.now(), from: String(from || ''), fromLabel: String(fromLabel || 'another session').slice(0, 120), text: String(text || '').slice(0, 8000), reply: reply === true };
    if (run.status === 'awaiting_recovery') {
      this.publish('agent.message', run, { from: entry.from, fromLabel: entry.fromLabel, text: entry.text, reply: entry.reply });
      void this.resumeAfterRecovery(entry).catch(() => {});
      return { delivered: true, resumed: true };
    }
    // LORDE_STORM_DAMPING_V365 — the field run produced 184 agent messages:
    // identical reports re-delivered 15+ times, each interrupt shredding the
    // receiver's current step and triggering another re-send. Damping: exact
    // duplicates from the same sender inside 90s are dropped; unread pending
    // messages batch onto the SAME decision boundary instead of re-aborting
    // the step; interrupts rate-limit to one per 15s per run.
    const nowMs = Date.now();
    if ((run.pendingAgentMessages || []).some(m => m.from === entry.from && m.text === entry.text && nowMs - Number(m.at || 0) < 90000)) {
      return { delivered: false, reason: 'duplicate-suppressed' };
    }
    // LORDE_FLOOD_CAPS_V365 — reworded resends bypass text dedupe (the field
    // storm resent a TOP-10 list 6+ times with different phrasing). Per
    // sender: one stored message per 45s, and 8 per run maximum — beyond
    // that the sender is throttled and told why.
    const senderMessages = (run.messageLog ||= []).filter(m => m.from === entry.from);
    // LORDE_DAMPING_RECALIBRATED_V370 — the field run showed a coordinator's
    // legitimate relays ("project is at E:...", defect reports) rejected after
    // 8 messages/45s cooldown, reading to the model as "john didn't receive".
    // Keep the safety valve high: only true floods (duplicates already deduped)
    // hit these bounds.
    if (nowMs - Number(senderMessages.at(-1)?.at || 0) < 12_000) return { delivered: false, reason: 'sender-cooldown' };
    if (senderMessages.length >= 40) return { delivered: false, reason: 'sender-capped', note: 'This sender has delivered 40 messages to this run; further messages are rate-limited.' };
    run.messageLog.push({ from: entry.from, at: entry.at });
    if (run.messageLog.length > 400) run.messageLog.splice(0, run.messageLog.length - 400);
    // entry.urgent === true is the USER's fast-forward: it always interrupts.
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
    // The next normal decision retains this agent's full tools and context.
    return { delivered: true };
  }

  async resumeAfterRecovery(message = null) {
    const run = this.run;
    if (!run || run.status !== 'awaiting_recovery') return { resumed: false, reason: 'session-not-awaiting-recovery' };
    if (this.recoveryResumePromise) return this.recoveryResumePromise;
    // E2: park-resume arms a one-shot re-grounding notice for the first
    // decision after the hold.
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

  // Program Control: when a run drives a native program the brain knows
  // nothing about, surface a HINT — nothing more. Research itself is the
  // MODEL's decision (research_task); auto-spawning a provider-consuming
  // subagent behind the model's back cost a full decision's worth of provider
  // capacity on tasks that never needed it.
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
    // Advisory only: the model sees this in its next decision context and can
    // fire research_task with the suggested objective if it judges it useful.
    run.researchHint = { program, objective: composeObjective(program, run.task) };
    this.publish('program.research.hinted', run, { program });
  }

  // Research findings land here at most once per run, only at a model
  // boundary, and only while the run is still active. Runtime-sourced advisory
  // context (the Skill Brain precedent): the model reconciles it against fresh
  // observation; it is never a user instruction, never durable history beyond
  // the bounded conversation window, and its absence is indistinguishable from
  // research that found nothing.
  deliverResearch(run) {
    const research = run.research;
    if (!research || research.delivered || !research.result) return;
    research.delivered = true;
    if (run.status !== 'running') return;
    const findings = String(research.result.findings || '').trim();
    if (!findings) return;
    const content = [
      'Background research finished for this task (advisory context, not a new request â€” do not acknowledge it; reconcile it against fresh observation and use only what still holds):',
      '',
      findings
    ].join('\n');
    const message = appendConversationMessage(run, 'user', content, { source: 'runtime', badge: 'research', displayContent: findings });
    // The badge and a user-facing body ride along so the renderer can show
    // the brief live, marked as research. The body's text is the findings
    // alone: the model-facing preamble above is addressed to the MODEL
    // ("do not acknowledge it") and would be noise on a user-facing card.
    if (message) this.publish('user.message.delivered', run, { messageId: message.id, badge: 'research', content: findings });
  }

  // Durable knowledge recall (desktop/knowledge/knowledgeStore_flow_chat.md):
  // once per run, right after the first fresh observation, surface learned
  // facts/recipes as advisory runtime context. The store is try/catch-wrapped
  // everywhere: a broken or empty store is indistinguishable from no memory
  // and can never block or delay a decision.
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
      'Prior knowledge for this task (advisory, learned in earlier runs â€” reconcile against fresh observation; stale advice loses to what you can see now):',
      ...lines
    ].join('\n');
    try {
      const message = appendConversationMessage(run, 'user', content, { source: 'runtime' });
      if (message) this.publish('user.message.delivered', run, { messageId: message.id });
    } catch { /* memory must never block a run */ }
  }

  // Laya decision layer: one local forward pass answering mechanical
  // confirmation questions about the fresh observation. The typed answers
  // (with calibrated confidences) ride along on the observation the strong
  // model receives â€” so it can skip whole "did the effect land?" confirmation
  // decisions while keeping full planning authority. Below-gate or unavailable
  // answers are omitted: with Laya off, dead, or slow, the run behaves exactly
  // as before. This is why the strong model can keep its strength and lose the
  // confirmation lag.
  // NON-BLOCKING by design: verify runs CONCURRENTLY with the provider call
  // (which costs seconds; a CPU sidecar pass costs hundreds of ms â€” awaiting
  // it serially added a dead silent stall before every decision). The settled
  // annotation lands on run.layaVerification and rides on the NEXT decision's
  // observation â€” which is exactly right, because the answers describe the
  // effect of the PREVIOUS action. Pure reads and waits have no mechanical
  // effect to confirm and are skipped outright.
  verifyWithLaya(run, observation) {
    const verifier = run.layaVerifier;
    if (!verifier || !observation) return;
    if (run.layaInFlight) return; // one verify at a time; the result lands on the next observation
    const lastAction = Array.isArray(run.history) ? run.history.at(-1) : null;
    // No previous action (first decision) or a pure read/wait: nothing has
    // been executed, so there is no mechanical effect to confirm.
    if (!lastAction || READ_ONLY_ACTION_NAMES.has(lastAction.tool)) return;
    run.layaInFlight = true;
    // LORDE_COMPOSITE_VERIFY — for coding tasks, fire coding verification
    // questions alongside the standard effect verification. One predict call
    // answers all dimensions (patch_applied, test_passes, no_regressions,
    // goal_achieved) instead of N sequential model decisions.
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
        // LORDE_LAYA_VISIBLE_V369 — engagement is ALWAYS observable: what the
        // brain answered (or that it abstained), which brain, how long. Only
        // confident answers ride into the model's context.
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

  // LORDE_FAST_PATH — Jev-executed fast path. The model's decision stream
  // carries its first tool call before the stream finishes (the rest is
  // usually narration). The moment that call's arguments are complete, this
  // handler can execute it immediately: the model already decided, so the
  // "announced it six times before acting" latency disappears. Strictly
  // gated: allowlisted non-destructive actions only, the run's own approval
  // gates still apply, a Jev verdict is required when the Jev brain answers,
  // and exactly one eager action may run per decision. Any failure is
  // silent — the normal buffered decision path remains the ceiling.
  async handleEagerAction(run, rawCall) {
    try {
      if (process.env.BROWSER_USE_FAST_PATH === 'off') return;
      if (!run || run.status !== 'running' || run.abortController?.signal.aborted) return;
      if (!run.eagerResults || run.eagerInFlight) return;
      if (run.pendingApproval || run.pendingUserMessages?.length) return;
      const name = String(rawCall?.name || '');
      if (!FAST_PATH_ACTIONS.has(name)) return;
      const call = { name, input: (rawCall.input && typeof rawCall.input === 'object' && !Array.isArray(rawCall.input)) ? { ...rawCall.input } : {} };
      if (requiresApproval(call, run)) return;
      const decisionObservation = { desktop: run.latestObservation?.desktop, screenshot: run.latestObservation?.screenshot };
      const resolvedElement = resolveSnapshotElement(this.controller, String(call.input?.tabId || run.tabId), call);
      const hash = actionHash(call, resolvedElement, decisionObservation);
      if (run.eagerResults.has(hash)) return;
      // Coordinator duplicate protection: a hash the run already attempted
      // must not re-execute eagerly (it would be a duplicate click).
      const attempt = canAttempt(run.coordinator, hash, actionMutates(call.name, call.input), call.expect, call.repeat);
      if (!attempt.allowed) return;
      // LORDE_RISK_GATES_V1 — risk-scaled confidence gate. The Jev confirmAction
      // already applies its own threshold; this adds the risk-level floor for
      // the bundled Laya fallback (which has no confirmAction). Low-risk actions
      // pass on the static allowlist alone; medium/high require the Jev verdict
      // when available, or the risk-gate confidence from the Laya verify.
      const riskGate = riskGateFor(call.name, call.input);
      if (typeof run.layaVerifier?.confirmAction === 'function') {
        const verdict = await run.layaVerifier.confirmAction({ action: call, task: run.task, observation: run.latestObservation, signal: run.abortController.signal });
        if (!verdict?.ok) return;
        // For high-risk actions, demand higher confidence from the verdict.
        if (actionRiskLevel(call.name, call.input) !== 'low' && Number(verdict.noul) > 0 && Number(verdict.noul) < riskGate) return;
      } else if (actionRiskLevel(call.name, call.input) !== 'low') {
        // No Jev verifier for medium/high risk: rely on the static allowlist
        // and coordinator duplicate-check alone (existing behavior).
      }
      const grounding = prepareAction(run.interactionMemory, call);
      if (!grounding.ok) return;
      run.eagerInFlight = true;
      try {
        this.publish('agent.fastpath', run, { tool: call.name, input: inspectionValue(call.name, call.input) });
        const outcome = await this.executeOrRequestApproval(run, call, { hash });
        // Mirror the batch loop's post-mutation evidence rules so the
        // decision's remaining batch and the next observation behave exactly
        // as if this action had executed inside the batch.
        if (actionMutates(call.name, call.input) && run.observationDomain === 'browser' && String(call.name).startsWith('browser_')) {
          run.browserNeedsImage = true;
        }
        // Store the CALL with the outcome: an eager action whose result is
        // never consumed (the decision changed shape, or the batch stopped
        // before reaching it) must still be recorded exactly once when the
        // run settles — otherwise the ledger claims "not executed" about an
        // action that really ran.
        if (run.eagerResults instanceof Map) run.eagerResults.set(hash, { call, output: outcome });
      } finally {
        run.eagerInFlight = false;
      }
    } catch { /* the fast path must never break the decision loop */ }
  }

  cancel(runId) {
    const run = this.requireRun(runId);
    if (!['running', 'awaiting_approval', 'awaiting_input', 'paused', 'awaiting_recovery'].includes(run.status)) return serializeRun(run);
    // A parked run holds an auto-resume timer; the user's cancel must stop it.
    if (run.escalationTimer) { clearInterval(run.escalationTimer); run.escalationTimer = null; }
    run.status = 'cancelled';
    run.abortController.abort();
    // An explicit user cancellation/abandonment closes the ACTIVE ladder task
    // as abandoned — the model must never resume it on a later turn unless the
    // user reopens it with a new instruction.
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
    // Plan state is harness-owned: the model files updates through the
    // update_plan tool and this class publishes them, the way a todo list
    // survives every decision regardless of response format.
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
    // Task bookkeeping updates the floating plan in place; it is not a new
    // execution beat. Concrete browser actions still close the current decision
    // chain so their next observation starts a fresh thought card.
    if (call.name !== 'update_plan' && call.name !== 'create_plan') {
      archiveActiveThinking(run);
      resetStreamingThoughtStall(run);
      run.activeThoughtId = null;
      run.activeThoughtStartedAt = null;
      run.activeThoughtAccumulator = null;
      run.usage = run.turnLedger?.usage || run.usage;
    }
    const executableTool = !['update_plan', 'create_plan', 'browser_done'].includes(call.name);
    if (executableTool && run.coordinator.metrics.firstToolStartedMs === null) run.coordinator.metrics.firstToolStartedMs = performance.now() - run.attemptStartedClock;
    this.publish('tool.started', run, { tool: call.name, args: redactArgs(call.name, call.input), inspection: { input: inspectionInput, output: null } });
    // TOOL PROGRESS HEARTBEAT — long tools (computer_model generation,
    // computer_index building, computer_search sweeps, terminal jobs) left
    // the UI silent for minutes and the user could not tell a working run
    // from a crashed one. A slow tool now publishes tool.progress every 4s;
    // the renderer shows a live elapsed card. The heartbeat can never break
    // the tool it wraps.
    const heartbeatStartedAt = Date.now();
    const heartbeat = executableTool ? setInterval(() => {
      try { this.publish('tool.progress', run, { tool: call.name, elapsedMs: Date.now() - heartbeatStartedAt }); } catch { /* progress is additive */ }
    }, 4000) : null;
    let output;
    try {
      // BOTH plan tools report through the same path. create_plan used to skip
      // this branch and fall through to executeAction, which returned
      // {ok:true, created:true} even when the plan had just been REJECTED — so
      // the model was told it had a plan, none existed, no pill was drawn, and
      // the done-gate (which only counts plan items that exist) never fired.
      output = (call.name === 'update_plan' || call.name === 'create_plan') && planUpdateResult
        ? planUpdateResult.ok
          ? { ok: true, result: { tasks: run.plan.length, goals: run.goals.length, added: planUpdateResult.added, updated: planUpdateResult.updated, removed: planUpdateResult.removed, ...(call.name === 'create_plan' ? { created: true } : {}) } }
          : { ok: false, recoverable: true, recoverySource: 'invalid_plan_update', error: `${planUpdateResult.error} The plan was NOT created. Resend ${call.name} with steps as an array of strings or {text,status,verification} objects.` }
        : await executeAction(this.controller, run, call);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }
    if (executableTool) {
      // Real work between terminal claims resets the bounded-bounce counters:
      // a fresh claim after new evidence still earns its review/bounce. The
      // completion-review epoch resets only on PAGE work: the forced-review
      // demand prescribes audit probes (browser_execute reads, observe,
      // screenshot) between the bounce and the re-done, and resetting on them
      // made the review unconvergeable. browser_execute is dual-use and stays
      // on the no-reset side — a model doing real work almost always also
      // clicks/fills/navigates, which resets.
      run.failedClaimBounces = 0;
      run.criterionAuditBounces = 0;
      run.incompleteWorkBounces = 0;
      if (actionMutates(call.name, call.input || {}) && call.name !== 'browser_execute') {
        // F2 (gen5): only LEDGER-AFFECTING settlements or NEW requirement
        // coverage reset the bounded completion-review counter. The old
        // unconditional reset made the >=3 bound dead code for any mutating
        // model: arch4's plateau arm rebuilt its flow five times through
        // navigations and clicks, each resetting the counter to 0 (final
        // counter value was 2 in all nine gen4 states). A mutation that
        // re-produces already-settled state — its action identity matches a
        // completed-work entry whose effect was observed — is a rebuild step
        // and must not reset. When a requirement ledger is armed, only work
        // that actually covers a still-open requirement resets.
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
      // The controller already attempted one safe stable-identity rematch. Mark
      // this snapshot stale and require exactly one fresh next-turn observation.
      output = { ...output, state: 'stale', recoverable: true };
    }
    if (['browser_screenshot', 'computer_screenshot'].includes(call.name) && output.ok && output.result?.data && run.latestObservation) {
      // Screenshot bytes live only on the current in-memory observation. The
      // provider consumes them on the next decision; serializers and history
      // redact them. A page mutation replaces this observation and therefore
      // invalidates the image automatically.
      run.visualEvidence = output.result;
      run.latestObservation.screenshot = output.result;
      // F3: an explicit screenshot tool call is a real produced capture —
      // ledger it for E12's citation matching.
      recordVisualCapture(run, 'tool');
    }
    // Page mutations invalidate the observation used to choose them. A model
    // must see a newer DOM state before a successful terminal claim is allowed.
    if (output.ok && actionMutates(call.name, call.input)) {
      // A successful mutation is real progress: watchdog fires reset (Stage A)
      // and the progress streak resets (Stage C).
      run.watchdogFires = 0;
      run.progressStreak = 0;
      run.progressStreakNudged = false;
      run.visualEvidence = null;
      if (run.latestObservation?.screenshot) delete run.latestObservation.screenshot;
      run.requiredEvidenceRevision = run.coordinator.observationRevision + 1;
    }
    if (call.name === 'browser_done' && output.ok && output.success !== false && (run.computerObservationDirty || run.coordinator.observationRevision < Number(run.requiredEvidenceRevision || 0))) {
      output = {
        ...output,
        ok: false,
        recoverable: true,
        recoverySource: 'completion_evidence',
        error: 'An action or native evidence refresh occurred after the latest observation. Inspect the fresh state before declaring the task complete.'
      };
    }
    // A fresh native observation may legitimately show an honest capability
    // limit; forcing that report back into review would only loop it.
    const freshNativePartial = run.observationDomain === 'computer' && run.latestObservation?.desktop
      && !run.computerObservationDirty && run.coordinator.observationRevision >= Number(run.requiredEvidenceRevision || 0);
    // Fixable-problem gate (2026-10-29): final:true is ONLY for a verified
    // external block the agent cannot resolve (user denied admin, network
    // down, missing OS permission). A code bug, build failure, startup crash,
    // or exit-code error is FIXABLE — the agent must fix it, not end the run.
    // Field run: 3x "Agent run failed" with final:true reporting diagnosed
    // code issues the agent could have patched.
    // Choice-in-summary gate: the agent is asking the user to pick an option
    // in its done summary. That is what ask_user is for — the run must NOT
    // end when a feasible path exists and the only blocker is a choice.
    if (call.name === 'browser_done' && output.ok && output.success === false) {
      const choiceSummary = String(output.summary || '');
      const asksUserToPick = /(?:tell me which|which (?:apps?|games?|option|approach|path|one|method)|pick one|choose one|let me know which|specify which|inform me which|need (?:you|the user) to (?:choose|pick|select|specify|name)|want (?:me|the agent) to (?:choose|pick)|select (?:an? )?(?:option|approach|path))\b/i.test(choiceSummary);
      const offersAlternatives = /(?:specific apps?|per-app|app[- ]?only|option[\s\S]{0,200}option|1\)[\s\S]{0,200}2\)|\b[A-Ca-c1-3]\)\s)/i.test(choiceSummary);
      if (asksUserToPick && offersAlternatives) {
        run.choiceInSummaryBounces = (run.choiceInSummaryBounces || 0) + 1;
        if (run.choiceInSummaryBounces <= 2) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'choice_in_summary',
            error: 'You are asking the user to pick an option in your done summary. That is what ask_user is for — use ask_user with your question and numbered options and WAIT for the reply. Do NOT end the run to ask. If a feasible option needs no user input (for example per-app spoofing needs no admin), TRY IT NOW instead of asking.'
          };
        }
      }
    }
    if (call.name === 'browser_done' && output.ok && output.success === false && output.final === true) {
      const summaryText = String(output.summary || '');
      const fixableProblem = /(?:exits?\s+(?:with\s+)?(?:code|status)|does\s+not\s+(?:work|run|launch|start|stay|pass)|doesn'?t\s+(?:work|run|launch|start|stay|pass)|is\s+(?:broken|crash(?:es|ing)?|fail(?:s|ing)?|not\s+(?:running|passing|working|staying))|fails?\s+to|could\s+not\s+(?:be\s+)?(?:creat|build|launch|start|run|install|verif)|immediate\s+(?:close|exit|quit)|closes?\s+(?:immediately|right\s+away)|refuses?\s+to\s+(?:stay|stay\s+alive|run|start)|the\s+source\s+code\s+explains|the\s+cause\s+is|the\s+(?:bug|issue|problem|error)\s+is\s+(?:in|caused\s+by|that)|needs?\s+(?:a\s+)?(?:code\s+)?(?:fix|patch|change|update)|should\s+(?:be\s+)?(?:fixed|patched|changed|updated|modified))/i.test(summaryText);
      if (fixableProblem) {
        run.fixableBlockBounces = (run.fixableBlockBounces || 0) + 1;
        if (run.fixableBlockBounces <= 2) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'unverified_external_block',
            error: 'final:true is reserved for external blocks you cannot resolve (user denied admin, network down, OS permission). You described a fixable problem — a code bug, build error, or startup failure. Fix it with computer_patch / computer_write and verify the fix, or if you truly cannot fix it, name the external blocker that prevents the fix.'
          };
        }
      }
    }
    if (call.name === 'browser_done' && output.ok && output.success === false && output.final === true && !freshNativePartial && !hasVerifiedExternalBlock(run.latestObservation, output)) {
      // Bound identical failed-claim bounces: once the same external-block
      // claim has been rejected twice with no new evidence in between, accept
      // the honest failure report. Bouncing forever spun the unbounded
      // internal recovery loop and hung whole runs (and this suite).
      run.failedClaimBounces = (run.failedClaimBounces || 0) + 1;
      if (run.failedClaimBounces < 2) {
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'unverified_external_block',
          error: 'A failed terminal claim needs fresh visible evidence of an external block and no safe visible next route. Reconcile the latest page evidence and decide whether to continue, wait, inspect, or report the block.'
        };
      }
    }
    // E8 (gen3) blocked-done provenance: after a fill-gate rejection or an E7
    // tamper bounce, a blocked-done claiming that block must cite evidence
    // gathered AFTER the bounce — a tool result showing the constraint or the
    // attempt. After a tamper bounce the block also cannot stand until one
    // page-valid adaptation (a compliant fill/type/execute) was attempted.
    // arch2 timed-r1: the gate bounced the impossibility claim at D17, then
    // ACCEPTED the same claim reworded at D18 — one fill away from done.
    // Bounded exactly once: the first unproven claim is bounced with the
    // fresh-probe demand, the next blocked-done is accepted (the existing
    // bounded-bounce pattern — never terminates).
    if (call.name === 'browser_done' && output.ok && output.success === false && run.constraintRejection) {
      const since = Number(run.constraintRejection.historyLength) || 0;
      const postBounce = Array.isArray(run.history) ? run.history.slice(since) : [];
      const hasFreshProbe = postBounce.some((entry) => !['browser_done', 'agent_advisory', 'update_plan'].includes(entry.tool));
      const needsAdaptation = run.constraintRejection.kind === 'tamper';
      const hasAdaptation = !needsAdaptation
        || postBounce.some((entry) => ['browser_fill', 'browser_type', 'browser_execute'].includes(entry.tool) && entry.output?.ok === true);
      if (!hasFreshProbe || !hasAdaptation) {
        run.blockProvenanceBounces = (run.blockProvenanceBounces || 0) + 1;
        if (run.blockProvenanceBounces <= 1) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'unverified_external_block',
            error: `A blocked-done after a constraint conflict needs FRESH evidence gathered after the rejection: run one probe (browser_execute or browser_observe) whose result shows the constraint or the attempt${needsAdaptation ? ', and — after a tamper bounce — attempt one page-valid adaptation (a compliant fill or execute) first' : ''}. A rewording of the earlier claim is not evidence.`
          };
        }
      }
    }
    // Fabricated-evidence gate: a conclusion that cites screenshot evidence
    // without a successful screenshot anywhere in the run (and no image
    // attachment) is bounced. Models late in long conversations increasingly
    // "remember" screenshots they never took. Bounded: two identical bounces
    // then the claim is stripped and the rest of the conclusion stands.
    // IMPORTANT: the harness auto-captures real screenshots with observations
    // (vision auto) and stores them in run.visualEvidence — a model claim of
    // "screenshot confirms" is HONEST when that frame exists, even though no
    // browser_screenshot tool event ever ran. Only bounce when the run holds
    // no visual evidence anywhere (no auto capture, no tool capture, no image
    // attachment). A mutation clears visualEvidence, so a post-patch claim
    // still requires a fresh frame.
    // PAGE FRESHNESS: a frame taken BEFORE the change is not evidence OF the
    // change (the history still holds that old screenshot, so it is dated
    // against the page's later edits), and neither is a frame of a page that
    // was never RELOADED after the change — it still renders the old content,
    // however recently it was captured. Until the page reflects the edit, no
    // screenshot of it can back a claim about that edit.
    const pageReflectsChanges = !run.pageChanges?.size || stalePageFiles(run, run.tabId).length === 0;
    const hasRealVisualEvidence = pageReflectsChanges && (
      Boolean(run.visualEvidence?.data)
      || Boolean(run.frameEvidence && run.frameEvidence.at > lastPageChangeAfter(run, run.frameEvidence.url)))
      || (Array.isArray(run.attachments) && run.attachments.some((item) => item?.kind === 'image'));
    if (call.name === 'browser_done' && output.ok && output.success !== false
        && /\bscreenshots?\s+(?:confirms?|shows?|verif(?:ies|ied)|proves?|demonstrates?)\b|\bper\s+(?:the\s+)?screenshots?\b|\bscreenshot\s+evidence\b/i.test(String(output.summary || ''))
        && !hasRealVisualEvidence) {
      run.screenshotClaimBounces = (run.screenshotClaimBounces || 0) + 1;
      if (run.screenshotClaimBounces < 3) {
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'screenshot_claim_unverified',
          error: 'Your conclusion cites screenshot evidence, but this run has taken no screenshot and has no image attachment. Take a browser_screenshot/computer_screenshot that actually shows the claimed state and return done again, or restate the conclusion citing only evidence that exists.'
        };
      } else {
        output = { ...output, summary: `[unverified screenshot claim removed] ${String(output.summary || '').replace(/\bscreenshots?\s+(?:confirms?|shows?|verif(?:ies|ied)|proves?|demonstrates?)\b[^.;]*/gi, '').trim()}` };
      }
    }
    // E12 (gen4) claim-vs-trace cross-check: before a verified:true done is
    // ACCEPTED, the summary's action claims (screenshot / probe / read-back /
    // observed, and post-submit phrasing) are string-matched against the run's
    // actual tool history — three generations of judge evidence (gen2-timed-r2,
    // gen3-gen-ab-timed-r2) show accepted verified:true summaries citing
    // observations no tool event backs. Bounded-bounce: the first unbacked
    // claim set is bounced ONCE with each specific claim named; the next done
    // is accepted (never terminates).
    // Fake-verification gate (2026-10-29): verified:true is a LIE when the
    // summary itself says verification failed or the outcome is incomplete.
    // The model must not flip verified:true while reporting "could not be
    // verified" or success:false — that is the exact fabrication class the
    // user flagged ("empty verifications").
    // An honest failure report of a VISIBLE external block is not an
    // overstatement: the block is on screen and the run cannot proceed. The
    // terminal result already forces verified:false for a failed outcome, so
    // bouncing it here only burned review calls until the model gave up and
    // the run reported success instead ("never marks it as a successful
    // result" is the requirement this preserves).
    const honestlyBlocked = output.success === false && output.final === true
      && hasVerifiedExternalBlock(run.latestObservation, output);
    if (call.name === 'browser_done' && call.input?.verified === true && output.ok && !honestlyBlocked) {
      const summaryText = String(output.summary || '');
      const contradictsVerified = /(?:could not|cannot|can't|unable to|did not|didn't|failed to|not)\s+(?:be\s+)?(?:creat|verif|confirm|complet|build|launch|start|run|install)/i.test(summaryText)
        || /(?:still\s+blocked|remains?\s+(?:blocked|incomplete|unverified|unconfirmed)|not\s+(?:yet\s+)?(?:created|verified|confirmed|built|launched|started|running|installed))/i.test(summaryText);
      run.verificationContradictionBounces = (run.verificationContradictionBounces || 0) + 1;
      if ((output.success === false || contradictsVerified) && run.verificationContradictionBounces <= 2) {
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'unbacked_claim',
          error: 'verified:true contradicts your own report. You stated the outcome is incomplete or unverified (success:false, or the summary says it "could not be verified"). Set verified:false and report honestly, or if the work IS done, state what you confirmed and set success:true with verified:true.'
        };
      }
    }
    if (call.name === 'browser_done' && output.ok && output.success !== false && call.input?.verified === true && !isCritiqueOnlyRun(run)) {
      const unbacked = unbackedActionClaims(String(output.summary || ''), { history: run.history, visualEvidence: run.visualEvidence, visualLedger: run.visualLedger });
      if (unbacked.length) {
        run.unbackedClaimBounces = (run.unbackedClaimBounces || 0) + 1;
        if (run.unbackedClaimBounces <= 1) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'unbacked_claim',
            error: `verified:true claims evidence this run's tool history does not show: ${unbacked.join('; ')}. State what evidence supports your verified claim and show it via a tool call, or set verified:false and report what you actually confirmed.`
          };
        }
      }
    }
    // Stale-acknowledgment gate: a new-turn done whose summary substantially
    // duplicates a PREVIOUS turn's accepted conclusion is bounced — the model
    // must report against the CURRENT objective, not re-acknowledge finished
    // work. Bounded: after two bounces accept (avoid loops).
    if (call.name === 'browser_done' && output.ok && run.newTurn && !isCritiqueOnlyRun(run)) {
      const wordsOf = (value) => new Set(String(value || '').toLowerCase().match(/[a-z0-9']{4,}/g) || []);
      const priorSummaries = run.history
        .filter((entry) => entry.tool === 'browser_done' && entry.output?.ok === true && Number(entry.at || 0) < Number(run.turnStartedAt || 0))
        .map((entry) => String(entry.output?.summary || ''));
      const currentWords = wordsOf(output.summary);
      const stalePrior = priorSummaries.find((prev) => {
        const prevWords = wordsOf(prev);
        if (!prevWords.size || !currentWords.size) return false;
        let shared = 0;
        for (const word of currentWords) if (prevWords.has(word)) shared += 1;
        return shared / Math.min(prevWords.size, currentWords.size) >= 0.6;
      });
      if (stalePrior) {
        run.staleSummaryBounces = (run.staleSummaryBounces || 0) + 1;
        if (run.staleSummaryBounces < 3) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'stale_task_acknowledgment',
            error: `Your conclusion restates the PREVIOUS turn's completed work ("${String(stalePrior).slice(0, 160)}"). The current objective is: "${quoteRequest(run.task)}". Audit THAT objective and report against it: every sub-request addressed or explicitly deferred.`
          };
        }
      }
    }
    // LORDE_DONE_GATE_V369 — a run whose OWN plan has open items, or whose
    // spawned subagents are still queued/running, cannot submit done: the
    // field run submitted with the goal at 0/4 and workers still active.
    // This is a harness-owned completion boundary, not an advisory.
    if (call.name === 'browser_done' && output.ok && output.success !== false) {
      // A REQUEST THAT HOLDS SEVERAL INSTRUCTIONS MUST BE ACCOUNTED FOR, one
      // line per instruction, whether or not the run ever made a plan.
      //
      // The 2026-10-30 run ended "successfully" with eight of twelve
      // instructions never attempted, and its plan held zero items: the
      // plan-item gate below had nothing to check and passed. Requiring a
      // PLAN would not have helped either — the model must be able to follow
      // a request to the dot with no plan at all, so the plan stays optional
      // and this gate does the work. It reads the summary's accounting lines
      // (each one starts with DONE: or SKIPPED:) and requires one per
      // instruction. The completion review asks for exactly this format, so
      // the advisory and the gate agree on one rule.
      const askCount = requestInstructionCount(run.task);
      const multiAsk = isMultiAskTask(run.task);
      const accountingLines = countAccountingLines(output.summary);
      // ONE demand per bounce. The accounting gate and the plan-items gate
      // are separate gates with separate counters, and only one of them fires
      // per done: otherwise the second overwrites the first's message (so the
      // model is told to close plan items while its accounting is still
      // missing) while both counters advance behind the model's back.
      let accounted = true;
      if (multiAsk && askCount > 0 && accountingLines < askCount) {
        accounted = false;
        // Its own counter: the plan-items gate below keeps its own, and one
        // bounce from each must not add up to the shared limit and park a run
        // that has not actually repeated itself.
        run.accountingBounces = (run.accountingBounces || 0) + 1;
        if (run.accountingBounces <= 2) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'done_uncovered_instructions',
            error: `Done rejected: the summary accounts for ${accountingLines} instruction${accountingLines === 1 ? '' : 's'}, but this request holds about ${askCount}. Write one line per instruction — each line starting with "DONE:" (with the evidence) or "SKIPPED:" (with the reason) — covering every instruction in the request, then call done again.${multiAskChecklist(run.task)}${COMPLETION_BRIDGE}`
          };
        } else {
          this.escalateRun(run, `Done bounced ${run.accountingBounces} times with only ${accountingLines} of about ${askCount} instructions accounted for. The run is parked holding its state; account for each instruction to proceed.`);
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'done_uncovered_instructions',
            error: `Done rejected ${run.accountingBounces} times — the run is parked rather than bouncing again. The summary accounts for ${accountingLines} of about ${askCount} instructions. Write a DONE: or SKIPPED: line for each one, then send a message to resume.${multiAskChecklist(run.task)}`
          };
        }
      }
      if (accounted) {
      const openItems = (Array.isArray(run.plan) ? run.plan : []).filter((item) => !['done', 'skipped'].includes(String(item?.status || '')));
      const ownSubagents = typeof run.subagentApi?.list === 'function'
        ? (run.subagentApi.list().subagents || []).filter((sub) => sub.parentRunId === run.id && ['queued', 'running'].includes(String(sub.status)))
        : [];
      if (openItems.length || ownSubagents.length) {
        run.incompleteWorkBounces = (run.incompleteWorkBounces || 0) + 1;
        if (run.incompleteWorkBounces <= 2) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'done_incomplete_work',
            error: `Done rejected: the goal is not complete. Plan items open: ${openItems.length}${openItems.length ? ` (${openItems.map((item) => String(item?.text || item?.id || '').slice(0, 40)).join('; ').slice(0, 200)})` : ''}. Subagents still working: ${ownSubagents.length}${ownSubagents.length ? ` (${ownSubagents.map((sub) => sub.alias).join(', ')})` : ''}. Finish the remaining plan items and subagent work — or mark items skipped with a reason and close finished subagents — then call done again.`
          };
        } else {
          // Bounded like every other done gate: two rejections to let the model
          // close or skip the named items, then PARK (never terminate — owner
          // directive). An unbounded gate here let any provider that re-emits
          // done with open items spin the recovery loop to heap death
          // (638k rejections observed in the 2026-10-18 OOM snapshot).
          this.escalateRun(run, `Done bounced ${run.incompleteWorkBounces} times with ${openItems.length} plan item(s) open and ${ownSubagents.length} subagent(s) working. The run is parked holding its state; close or skip the named items to proceed.`);
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'done_incomplete_work',
            error: `Done rejected ${run.incompleteWorkBounces} times — the run is parked rather than bouncing again. Plan items open: ${openItems.length}; subagents working: ${ownSubagents.length}. Finish or skip the named items, then send a message to resume.`
          };
        }
      }
      }
    }
    // Stage D (harness merge v5): criterion-level completion audit. verified:true
    // requires per-outcome evidence: every plan item marked done that carries a
    // verification string must be covered by completed-work evidence whose
    // effect was observed. Additive gate — same rejection shape and
    // recoverySource conventions as the other done gates; bounded like the
    // judgment gates (reject twice, then accept) so it can never terminate a
    // run, and silent when no plan item declares a verification.
    if (call.name === 'browser_done' && output.ok && output.success !== false && call.input?.verified === true && !isCritiqueOnlyRun(run)) {
      const evidencedOutcomes = (run.coordinator.completedWork || []).filter((entry) => entry?.effectObserved === true);
      const unverifiedItems = (Array.isArray(run.plan) ? run.plan : [])
        .filter((item) => String(item?.status || '') === 'done' && String(item?.verification || '').trim())
        .filter((item) => !evidencedOutcomes.some((entry) => {
          const verificationWords = new Set(String(item.verification || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
          const outcomeWords = new Set(String(entry.expectedOutcome || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []);
          if (!verificationWords.size || !outcomeWords.size) return true; // nothing comparable: accept as covered
          let shared = 0;
          for (const word of outcomeWords) if (verificationWords.has(word)) shared += 1;
          return shared / Math.min(verificationWords.size, outcomeWords.size) >= 0.3;
        }));
      if (unverifiedItems.length) {
        run.criterionAuditBounces = (run.criterionAuditBounces || 0) + 1;
        if (run.criterionAuditBounces <= 2) {
          output = {
            ...output,
            ok: false,
            recoverable: true,
            recoverySource: 'completion_review',
            error: `verified:true requires confirming evidence for EACH outcome. No observed-effect evidence covers: ${unverifiedItems.map((item) => String(item?.text || '').slice(0, 60)).join('; ')}. Show the evidence that confirms each outcome (you decide what verification means for this task — a screenshot, a running process, a test result, a file existing on disk), or mark the item skipped with a reason. ${COMPLETION_BRIDGE}`
          };
        }
      }
    }
    // FILE-MUTATION GATE: a request to edit/add/remove/patch a file cannot
    // finish after only reads, planning, or notebook writes. This prevents the
    // model from claiming a desktop edit while new1.txt showed only
    // computer_fs/computer_read plus an advisory. The next decision must land a
    // real write tool before a successful browser_done is accepted.
    if (call.name === 'browser_done' && output.ok && output.success !== false && !isCritiqueOnlyRun(run)
      && requiresFileMutation(run.task) && !fileMutationSatisfied(run)) {
      run.fileMutationGateBounces = (run.fileMutationGateBounces || 0) + 1;
      output = {
        ...output,
        ok: false,
        recoverable: true,
        recoverySource: 'file_mutation_required',
        error: `The task explicitly requests a file edit, but no file mutation has landed in this turn. Use computer_patch (the primary legacy context patch) now; if it fails repeatedly, use computer_patch_live, then computer_patch_chunk. Do not finish from reads, planning, or notebook updates.`
      };
    }
    if (call.name === 'browser_done' && output.ok && output.success !== false && !isCritiqueOnlyRun(run) && !codingCheckSatisfied(run)) {
      // Bounded like the stale-acknowledgment gate: two rejections to let the
      // model produce the missing evidence, then accept. An UNBOUNDED gate
      // here re-bounced a finished browser-side stress test eight times and
      // forced five redundant re-probes — the definition of wasted time.
      run.codingGateBounces = (run.codingGateBounces || 0) + 1;
      if (run.codingGateBounces <= 2) {
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'completion_review',
          error: `This coding task requires the requested test/check to have actually completed successfully before the final claim. Run it and return the real result. ${COMPLETION_BRIDGE}`
        };
      }
    }
    if (call.name === 'browser_done' && output.ok && output.success !== false && !isCritiqueOnlyRun(run) && requiresCompletionReview(run)) {
      // E4 (gen4): settle the requirement ledger against the run's observed
      // evidence at done time. A requirement is evidenced by observed-effect
      // work whose words cover it, or explicitly deferred in the done summary.
      const { open: openRequirements } = settleRequirementLedger(run, String(output.summary || ''));
      const ledgerArmed = Array.isArray(run.requirementLedger) && run.requirementLedger.length > 0;
      const ledgerComplete = ledgerArmed && openRequirements.length === 0;
      // A done that already asserts verification is accepted without the extra
      // review round trip only when the coordinator's own evidence agrees:
      // every recorded mutation's effect was observed and no plan item is left
      // unaccounted — or the requirement ledger is fully settled
      // (accept-on-ledger). Otherwise the standard review bounce applies.
      const evidenceVerified = call.input?.verified === true
        && Array.isArray(run.coordinator.completedWork) && run.coordinator.completedWork.length > 0
        && run.coordinator.completedWork.every((entry) => entry?.effectObserved === true)
        && !(Array.isArray(run.plan) && run.plan.some((item) => !['done', 'skipped'].includes(item?.status)))
        // E4: a requirement ledger with OPEN requirements is itself a named
        // gap — coarse observed-effect agreement does not accept over it.
        && !(ledgerArmed && openRequirements.length > 0);
      // A multipart objective needs one explicit review even when the model
      // asserts verification after completing only a single observed action.
      // The request is quoted ONCE per message. The multi-ask checklist below
      // quotes it verbatim, so repeating it here made a 1,081-character
      // request appear three times in one bounce and pushed the tail (the
      // instructions that close it) past the recovery-text cap.
      const checklist = multiAskChecklist(run.task);
      const currentObjective = checklist
        ? ' The current objective is the request quoted verbatim below.'
        : ` The current objective is: "${quoteRequest(run.task)}".`;
      // Bounded review bounces: the same completion_review rejection repeating
      // three times means the model will not converge on verified:true (a
      // static or looping provider). With the ledger SETTLED the terminal
      // result is accepted rather than spinning the unbounded internal
      // recovery loop forever. F2 (gen5): with requirements still OPEN the
      // bound fires as a park (escalateRun — never a termination): the old
      // exhaustion path silently accepted a done with open requirements, and
      // the counter it exhausted never got past 2 because mutations reset it.
      run.completionReviewBounces = (run.completionReviewBounces || 0) + 1;
      const reviewExhausted = run.completionReviewBounces >= 3;
      // The forced review fires ONCE per work chunk. The demand itself tells
      // the model to audit and return done — and the audit's probes are
      // successful tools, which used to clear run.completionCandidate, so the
      // exact cycle the demand prescribed re-armed the forced review forever
      // (four rejections until the clock). The latch resets only on real page
      // work (the reset site below), never on the audit's own evidence reads.
      // F2: the latch's fall-through must not accept a done whose requirement
      // ledger still has open requirements that the F1 matcher can now settle
      // — an open ledger with verified:true bounces even after the forced
      // review already fired.
      const ledgerOpen = ledgerArmed && openRequirements.length > 0;
      const needForcedReview = !run.completionReviewForced
        && ((!evidenceVerified && !ledgerComplete) || isMultipartTask(run.task))
        // Honest-exit: a success:false, unverified done whose summary does not
        // claim the work is finished is a truthful blocker report, not a proposal.
        && (call.input?.verified === true
          || call.input?.success !== false
          || claimsCompletion(String(output.summary || '')));
      // FAILURE LADDER: a success:false stop is accepted only with proof the
      // agent exhausted its options — (1) several known approaches tried,
      // (2) research done, (3) at least one attempt combining knowledge with
      // research. A genuine external blocker (login, permission, a step only the
      // user can take) may stop immediately. No bounce cap: an unproven failure
      // is always sent back to research or replan.
      const failureLadder = run.failureLadder || { tools: new Set(), researched: false, postResearchActions: 0 };
      const failSummary = String(output.summary || '');
      const isFailureStop = call.input?.success === false || String(call.input?.success) === 'false';
      const externalBlocker = /\b(log ?in|sign ?in|password|captcha|2fa|two-factor|permission denied|access denied|only (you|the user)|needs? (your|the user'?s?) (input|approval|action|decision)|payment)\b/i.test(failSummary);
      const missingRungs = [];
      if (failureLadder.tools.size < 2) missingRungs.push('try every known way first (only ' + failureLadder.tools.size + ' kind of approach used so far)');
      if (!failureLadder.researched) missingRungs.push('research alternative ways around the problem (research_task or web_search)');
      if (failureLadder.postResearchActions < 1) missingRungs.push('make at least one new attempt that combines what you know with what the research found');
      if (isFailureStop && !externalBlocker && missingRungs.length) {
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'unproven_failure',
          error: `Failure rejected: there is no proof that every possible solution was exhausted.${currentObjective} Still missing: ${missingRungs.join('; ')}. Research an alternative way to manoeuvre or replan, then act. A failure stop is accepted only after known approaches, research, and a combined attempt have all been tried — then state clearly that all possible solutions were exhausted and list what was tried.`
        };
      } else if (!reviewExhausted && (needForcedReview || (ledgerOpen && call.input?.verified === true))) {
        run.completionReviewForced = true;
        run.completionCandidate = {
          summary: String(output.summary || '').slice(0, 1_000),
          observationRevision: run.coordinator.observationRevision,
          completedWorkCount: run.coordinator.completedWork.length
        };
        // E4: the bounce names the SPECIFIC open requirement and its missing
        // evidence instead of only a generic audit demand (the generic bounce
        // is the two-generation debt that caused legacy untimed-r2's death
        // spiral and gen-ab untimed-r3's evidence-demand rebuild).
        const ledgerDemand = openRequirements.length
          ? ` Requirement ledger: ${openRequirements.map((req) => `${req.id}) "${String(req.text).slice(0, 80)}" — no observed-effect evidence covers it yet`).join('; ')}. A fresh probe, read-back, or observed result settles a requirement; state it skipped with a reason to defer one.`
          : checklist;
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'completion_review',
          error: `Completion is a proposal, not a terminal result yet. Audit the whole original goal against the newest observation, prior reasoning, and completed-work ledger.${currentObjective}${ledgerDemand} Return the next missing action, or return browser_done again with verified:true only when every requested outcome is supported. ${COMPLETION_BRIDGE}`
        };
      } else if (!reviewExhausted && call.input?.verified !== true && claimsCompletion(String(output.summary || ''))) {
        // Only a summary that CLAIMS the work is done is held to verified:true.
        // An honest, clearly-labelled "not fully proven yet" / "could not fully
        // verify X, here is what I did" done is a truthful terminal result —
        // bouncing it forced the model to either re-run finished work or flip
        // to a false verified:true (the "no honest way out" trap). Work claims
        // still need proof; a candid report does not.
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'completion_review',
          error: `The completion review did not explicitly verify the whole goal.${currentObjective} Continue with the next missing action, or return browser_done with verified:true after reconciling all current evidence. ${COMPLETION_BRIDGE}`
        };
      } else if (reviewExhausted && ledgerOpen) {
        // F2: the bound fired with requirements still open. Park the run
        // (Stage A — awaiting_recovery + auto-resume, NEVER a termination)
        // instead of silently accepting an unverified done or spinning.
        // E8 (gen6) verified: the park's auto-resume re-attempts settlement
        // every cycle — escalateRun arms the unref'd escalation timer, each
        // resumeAfterRecovery start({resumeRecovery:true}) carries the
        // completed-work ledger and history forward (same-task turn
        // continuation), re-seeds every requirement open, and the settle pass
        // re-runs at the next done; only ledger-AFFECTING work resets the
        // bounce counter (the reset site above), so a resume that produces new
        // covering evidence settles and accepts, while a resume that returns
        // done without new evidence re-parks naming the same open ids — the
        // cycle is indefinite and never terminates.
        this.escalateRun(run, `Completion review bounced ${run.completionReviewBounces} times with ${openRequirements.length} requirement(s) still open (${openRequirements.map((req) => req.id).join(', ')}). The run is parked holding its state; settle the named requirements or restate the objective.`);
        output = {
          ...output,
          ok: false,
          recoverable: true,
          recoverySource: 'completion_review',
          error: `Completion review exhausted (${run.completionReviewBounces} bounces) with requirements still open: ${openRequirements.map((req) => `${req.id}) "${String(req.text).slice(0, 80)}"`).join('; ')}. A fresh probe, read-back, or observed result settles a requirement; state it skipped with a reason to defer one.${currentObjective}`
        };
      }
    }
    // REAL-VERIFICATION GATE (2026-10-30): verified:true is PROSE until the
    // run PRODUCES proof. The field run wrote "Verifying Go installation" in
    // its thinking, never ran a verification command, then submitted
    // browser_done with verified:true and a success summary — nothing in the
    // history proved anything. The gates around it demand "a fresh
    // observation, probe numbers, or a real test result" but never check that
    // the agent actually MADE one. This gate checks exactly that: the run's
    // history SINCE THE LAST MUTATION must hold at least one successful
    // evidence-producing tool call.
    // It sits LAST in the done-gate sequence on purpose: every gate above
    // keeps its own bounce and its own message, and this gate only speaks
    // when nothing else objected — it is additional, never a substitute.
    // Bounded like every other done gate (two bounces, then accept) so it
    // can never deadlock a run.
    if (call.name === 'browser_done' && output.ok && output.success !== false && call.input?.verified === true && !isCritiqueOnlyRun(run)) {
      // Evidence-producing tools: the calls that actually PRODUCE proof that
      // a claimed outcome happened.
      const VERIFICATION_EVIDENCE_TOOLS = new Set([
        'computer_screenshot', 'browser_screenshot', 'computer_read', 'computer_search',
        'computer_index', 'browser_observe', 'browser_execute', 'computer_git', 'computer_fs'
      ]);
      // (Mutation classification lives at module scope now — shared with the
      // turn-scoped done-gate scoping: terminalCommandMutates,
      // browserExecuteWrites, historyEntryMutated, READ_ONLY_*.)
      const historyEntryVerified = (entry) => {
        const tool = String(entry?.tool || '');
        const recorded = entry?.output;
        if (!recorded || recorded.ok !== true) return false;
        const input = entry?.input || {};
        if (tool === 'computer_terminal') {
          const exitCode = recorded?.result?.exitCode;
          if (exitCode !== undefined && exitCode !== null) return Number(exitCode) === 0;
          // A large terminal output is archived to a preview envelope; the
          // exit code survives in the preview text.
          return /"exitCode"\s*:\s*0\b/.test(JSON.stringify(recorded) || '');
        }
        if (tool === 'computer_git') return READ_ONLY_GIT_ACTIONS.has(String(input.action || ''));
        if (tool === 'computer_fs') return READ_ONLY_FS_ACTIONS.has(String(input.action || ''));
        // computer_file is the RETIRED everything-tool: the model can never
        // select it, and its legacy reads prove nothing about the outcome a
        // verified claim is about.
        if (tool === 'computer_file') return false;
        return VERIFICATION_EVIDENCE_TOOLS.has(tool);
      };
      const verificationHistory = Array.isArray(run.history) ? run.history : [];
      // Scope the check to THIS turn: a continuation carries the previous
      // turn's history, and a claim about the previous turn's work is not this
      // turn's verification debt.
      const turnStartedAt = Number(run.turnStartedAt || 0);
      const turnEntries = turnStartedAt > 0
        ? verificationHistory.filter((entry) => Number(entry?.at || 0) >= turnStartedAt)
        : verificationHistory;
      // A turn that ran no tool at all has nothing to re-verify — the
      // claim-citation gates own the "cited evidence that does not exist"
      // class, and this gate stays out of their way. computer_file is the
      // RETIRED everything-tool: the model can never select it, so a legacy
      // call is not work that needs re-verifying.
      const turnToolCalls = turnEntries.filter((entry) => !['browser_done', 'agent_advisory', 'update_plan', 'create_plan', 'computer_file'].includes(String(entry?.tool || '')));
      // Verification debt attaches only to a CONFIRMED change. A call that ran
      // but whose recorded output proves no state change (a rejected or no-op
      // patch, a write with no diff) leaves nothing to answer for — demanding
      // proof of a non-change is a false-positive bounce, and it is exactly
      // how a legitimate completion got stuck re-submitting the same done
      // while the gate kept refusing it.
      let lastMutationIndex = -1;
      for (let index = 0; index < turnEntries.length; index += 1) {
        if (historyEntryMutated(turnEntries[index]) && historyEntryConfirmsChange(turnEntries[index])) lastMutationIndex = index;
      }
      if (turnToolCalls.length && lastMutationIndex >= 0) {
        // A BROWSER turn is verified by the harness's own fresh observation:
        // the loop re-observes the page before every decision, so a page
        // change has already been looked at. A NATIVE turn is not — a
        // desktop frame says nothing about a file's content or a command's
        // exit code, so the agent must actually run, read or capture
        // something. That is the fabrication this gate exists for
        // ("Verifying Go installation" with no command run).
        const turnHasNativeWork = turnEntries.some((entry) => String(entry?.tool || '').startsWith('computer_') && String(entry?.tool || '') !== 'computer_file');
        // The harness re-observes before every decision, so the agent's own
        // context carries a fresh look at the page. A stale observation (the
        // run changed something after the last look) is exactly what
        // requiredEvidenceRevision tracks.
        const freshObservation = Number(run.coordinator?.observationRevision || 0) >= Number(run.requiredEvidenceRevision || 0);
        const freshObservationIsEvidence = !turnHasNativeWork && freshObservation;
        const evidenceEntry = turnEntries.slice(lastMutationIndex + 1).find((entry) => historyEntryVerified(entry));
        if (!evidenceEntry && !freshObservationIsEvidence) {
          run.realVerificationBounces = (run.realVerificationBounces || 0) + 1;
          if (run.realVerificationBounces <= 2) {
            output = {
              ...output,
              ok: false,
              recoverable: true,
              recoverySource: 'unverified_verification_claim',
              error: 'verified:true requires a real verification tool call after your last change. Your summary claims you verified, but the history shows no evidence-producing tool call since the last mutation. Run the verification command and show its output, or set verified:false.'
            };
          }
        }
      }
    }
    // VERIFICATION NEVER BLOCKS A GENUINE RUN (owner policy, 2026-11-02).
    // Every done-gate above is a CHECK, not a veto. A bounced done is exactly
    // the trap that made the model invent evidence files and mark real work
    // "skipped" just to get past the gate — so the gate's concern is preserved
    // as a NOTE on the ACCEPTED result instead of another round of proof, and
    // an unsupported "verified" claim is downgraded to verified:false rather
    // than argued with. The run closes; nothing is fabricated; no error is
    // shown. A claim with NO work behind it is still corrected: that is a
    // wrong answer, not verification friction.
    if (call.name === 'browser_done' && output?.ok === false && output?.recoverable === true && output?.error) {
      const turnStart = Number(run.turnStartedAt || 0);
      const workedThisTurn = (Array.isArray(run.history) ? run.history : [])
        .some((entry) => Number(entry?.at || 0) >= turnStart
          && !['browser_done', 'agent_advisory', 'agent_recovery', 'update_plan', 'create_plan'].includes(String(entry?.tool || ''))
          && entry?.output?.ok !== false);
      if (workedThisTurn) {
        const claimsVerified = call.input?.verified === true;
        output = {
          ...output,
          ok: true,
          verificationNote: String(output.error).slice(0, 600),
          ...(output.recoverySource ? { verificationSource: output.recoverySource } : {}),
          ...(claimsVerified ? { verified: false, verifiedDowngraded: true } : {})
        };
      }
    }
    recordConsulted(run, call, output);
    const publicOutput = redactOutput(call.name, output, call.input);
    // Tool outputs can be much larger than the provider/renderer envelope
    // (git diffs, search/index results, generated media metadata). Archive the
    // complete sanitized result ONCE and expose a resultId instead of a
    // misleading preview. The model can call read_agent_result; it must not
    // re-run the original tool just because the UI envelope is bounded.
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

    // LORDE_SPECULATIVE_READ_V1 — after search/index results, pre-read the
    // top result files so the model's likely next computer_read is cached.
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
      run.recoveryFingerprint = '';
      run.recoveryFingerprintCount = 0;
      run.completionCandidate = null;
    }
    if (!PROGRESS_GUARDED_READ_ACTIONS.has(call.name) && call.name !== 'browser_scroll' && call.name !== 'browser_done') {
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
        // A claimed verification the run could not back is downgraded, not
        // argued with: the result says so plainly instead of bouncing.
        ...(output.verifiedDowngraded ? { verifiedDowngraded: true, ...(output.verificationNote ? { verificationNote: output.verificationNote } : {}) } : {}),
        ...(output.success === false ? { reason: 'reported_incomplete' } : {}) };
      // GEN9 DECISIONS ledger: a terminal summary is durable session state
      // (what was claimed done, whether it was verified) — the next turn and
      // any continuation start from the record, not from re-derivation.
      if (run.notebook && output.summary) {
        try { run.notebook.append('DECISIONS', `${output.success === false ? 'FAILED' : (run.result.verified ? 'DONE (verified)' : 'DONE')}: ${String(output.summary).replace(/\s+/g, ' ').slice(0, 240)}`); } catch { /* best effort */ }
      }
      return 'terminated';
    }
    return action.terminatesSequence ? 'terminated' : 'continue';
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

  // ask_user: pause the run and wait for the user's text reply. Modeled on
  // waitForApproval but with free-form input instead of allow/deny buttons.
  // The user's reply resolves the promise and the run resumes with the reply
  // as the tool result — so the next decision has it as fresh evidence.
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
  // settles, so history and the turn ledger never claim "was not executed"
  // about an action that really ran. Speculative pre-reads are NOT model
  // decisions — they are dropped here without a history entry.
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
    // Every attempt is kept, including rejected ones. Collapsing browser_done
    // entries here hid the real defect — a run that bounced the same
    // completion three times LOOKED like one clean done in history, and the
    // rejection path could not be inspected or tested. Repeated attempts are
    // bounded by the gates' own bounce ceilings (each accepts a legitimate
    // completion within two bounces), not by erasing the evidence.
    run.history = [...run.history, {
      at: nextTimelineAt(run),
      step: run.step,
      tool: call.name,
      input: redactArgs(call.name, call.input),
      ...(call.callId ? { callId: call.callId } : {}),
      expect: normalizeExpectation(call.expect),
      repeat: call.repeat === true,
      // Bounded media provenance rides at the entry top level (outside output
      // redaction) so generated assets survive chat-history persistence.
      ...(output?.media && typeof output.media === 'object' ? { media: output.media } : {}),
      // Advisory duplicate context rides in the transcript like any other
      // evidence — information for the next decision, never a veto.
      ...(call.advisory ? { note: String(call.advisory).slice(0, 500) } : {}),
      // Use the compact result envelope in history and the provider ledger;
      // the complete sanitized value is in AgentResultStore when truncated.
      output: redactOutput(call.name, storedOutput, call.input)
    }].slice(-80);
    run.turnLedger?.record(run.history.at(-1));
  }

  assertProgress(run, call, output) {
    if (!PROGRESS_GUARDED_READ_ACTIONS.has(call.name) && call.name !== 'browser_scroll') return null;
    // A screenshot is fresh model evidence, not an attempted page mutation.
    // Equivalent repeated reads are already blocked by the coordinator; they
    // must not accumulate across intervening successful interactions.
    if (call.name === 'browser_screenshot') return null;
    const observation = output.observation || output.result;
    const fingerprint = observationFingerprint(observation);
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
      // Stage A: repeated no-progress results are watchdog fires too. They
      // accumulate toward the park threshold (escalate, never terminate).
      run.watchdogFires = (run.watchdogFires || 0) + 1;
      if (run.watchdogFires >= ESCALATION_PARK_FIRES) {
        this.escalateRun(run, `${run.watchdogFires} watchdog fires: repeated ${call.name} results produced no observable change.`);
      }
      return `The latest ${call.name} result produced no observable page change. Treat it as evidence: repeating the same read will not help. Change approach or execute the next grounded action now; inspect again only if a prior action could have changed the state.`;
    }
    return null;
  }

  publish(type, run, payload) {
    run.eventRevision = (run.eventRevision || 0) + 1;
    // Heartbeat source of truth: every real published event proves observable
    // progress. Excluded: the synthetic thinking-clock ticks (assistant.thinking,
    // fired every 750ms while WAITING) — they are exactly what a stall looks
    // like from the outside. Nothing the heartbeat itself does publishes here.
    if (type !== 'assistant.thinking') run.lastRealActivityAt = Date.now();
    const terminal = ['run.started', 'run.completed', 'run.failed', 'run.cancelled'].includes(type);
    const eventRun = terminal ? serializeRun(run) : serializeEventRun(run);
    const event = { type, revision: run.eventRevision, run: eventRun, ...payload };
    // Screenshot bytes are a live-renderer affordance, not diagnostic data.
    // Keep them out of telemetry sizing just as they stay out of run history.
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

// LORDE_MESSAGE_INTERRUPT_V365 — receiveAgentMessage aborts the active step
// when a coordination message arrives mid-step (agent-message-arrived). That
// abort is a healthy interruption, not a failure: the message is already in
// the inbox, so the run must re-observe and re-decide immediately instead of
// paying a recovery attempt and a retry delay (the field transcript showed a
// parent waiting minutes for a subagent that had already been messaged).
function isMessageInterrupt(error) {
  return String(error?.message || error || '').includes('agent-message-arrived');
}

function isStaleElementFailure(output) {
  return output?.ok === false && /element index .*stale|observe the page again/i.test(String(output.error || ''));
}

// Preserve only the narrow, native form interaction that the fill helper
// fill helper establishes itself: observed control -> replacement value ->
// Enter. Do not batch clicks, navigation, arbitrary key chords, or selectors
// from stale evidence. The next loop still observes after the key before a
// terminal claim can be accepted.
function mayContinueFocusedSubmit(run, call, nextCall, outcome) {
  if (outcome !== 'continue' || !nextCall || nextCall.name !== 'browser_key') return false;
  if (!['browser_fill', 'browser_type'].includes(call.name)) return false;
  if (call.name === 'browser_type' && coerceElementIndex(call.input?.element ?? call.input?.index) === undefined) return false;
  const currentTabId = String(call.input?.tabId || run.tabId || '');
  const nextTabId = String(nextCall.input?.tabId || run.tabId || '');
  if (!currentTabId || currentTabId !== nextTabId) return false;
  const key = String(nextCall.input?.key || '').trim().toLowerCase();
  const action = String(nextCall.input?.action || 'press').trim().toLowerCase();
  return action === 'press' && (key === 'enter' || key === 'return');
}

function hasVerifiedExternalBlock(observation, output) {
  if (!observation || output?.success !== false || output?.final !== true) return false;
  const landmarks = Array.isArray(observation?.dom?.landmarks) ? observation.dom.landmarks : [];
  const elements = Array.isArray(observation?.dom?.elements) ? observation.dom.elements : [];
  const visibleText = [
    observation?.dom?.title,
    ...landmarks.map((landmark) => `${landmark?.label || ''} ${landmark?.text || ''}`),
    ...elements.map((element) => `${element?.name || ''} ${element?.text || ''}`)
  ].join(' ').replace(/\s+/g, ' ').toLowerCase();
  const externalBlock = /\b(?:captcha|unusual traffic|verify you are human|automated browser|access denied|forbidden|not authorized|temporarily unavailable|maintenance|service unavailable|site (?:is )?(?:unavailable|can.t be reached)|connection refused|dns(?:_probe)?(?:_finished)?_nxdomain)\b/.test(visibleText);
  const visibleRoute = /\b(?:sign in|log in|retry|try again|continue|go back|reload)\b/.test(elements.map((element) => `${element?.name || ''} ${element?.text || ''}`).join(' ').toLowerCase());
  return externalBlock && !visibleRoute;
}

function isFastInteractiveTask(task) {
  const text = String(task || '').trim();
  if (!text || text.length > 500) return false;
  if (/\b(?:implement|write|edit|patch|create|audit|research|debug|fix|build|install|report|test|inspect|analy[sz]e)\b/i.test(text)) return false;
  return /\b(?:click|tap|press|select|move|drag|play|place|open|close|submit)\b/i.test(text);
}

function requiresCompletionReview(run) {
  // A completed remote task is a separate execution, not a local browser
  // action. Re-asking the provider to review it creates a second cloud run.
  if (run?.remoteExecution) return false;
  // The deliverable of a question / answer-demand turn is the reply itself:
  // there is no work whose landing could need confirming, and the
  // stale-acknowledgment gate already guards against answering with the
  // previous task's summary. Forcing the completion review here made every
  // status question end in "Completion is a proposal... verify the whole
  // goal" — observed proof demanded for an explanation.
  if (isAnswerOnlyRequest(run?.task)) return false;
  // Same for an explicit no-change / diagnosis request ("don't change
  // anything yet", "just find the root causes"): its deliverable is an
  // explanation, and the user forbade mutations. Demanding verified:true +
  // observed-effect proof here is exactly the "Proof for an answer" friction
  // the run hit — the completion gate asked for proof of a change that was
  // not allowed to happen.
  if (isAnalysisOnlyRequest(run?.task)) return false;
  const completedWorkCount = Array.isArray(run?.coordinator?.completedWork) ? run.coordinator.completedWork.length : 0;
  const visiblePlanNeedsReview = Array.isArray(run?.plan) && run.plan.some((item) => !['done', 'skipped'].includes(item?.status));
  // A NEW turn in an existing conversation gets one explicit review — but
  // only when the closed turn actually produced work (a pure Q&A exchange has
  // nothing to mis-attribute, and plain follow-up answers stay one-decision
  // cheap). Its history is full of the closed task's evidence, and without
  // the review a done about that closed task used to be accepted verbatim.
  if (run?.newTurn && run?.closedTurnHadWork) return true;
  // Short, direct interactions are already grounded by the next outer-loop
  // observation. A second model review only adds latency and invites re-clicks.
  if (isFastInteractiveTask(run?.task) && completedWorkCount <= 3 && !visiblePlanNeedsReview) return false;
  return isMultipartTask(run?.task) || completedWorkCount >= COMPLETION_REVIEW_MUTATION_THRESHOLD || visiblePlanNeedsReview;
}

function repeatedAppendAfterFill(run, call) {
  if (call?.name !== 'browser_type') return null;
  const element = coerceElementIndex(call.input?.element ?? call.input?.index);
  if (element === undefined) return null;
  const typedLength = String(call.input?.text || '').length;
  const history = Array.isArray(run.history) ? run.history : [];
  const fillIndex = history.findLastIndex((entry) => entry?.tool === 'browser_fill' && entry?.output?.ok === true && entry?.output?.result?.matched === true);
  if (fillIndex < 0) return null;
  // A subsequent page mutation can legitimately change field ownership or
  // focus; only block an append while the successful fill is still the last
  // page-changing operation in this bounded turn sequence.
  if (history.slice(fillIndex + 1).some((entry) => isMutation(entry?.tool))) return null;
  const fill = history[fillIndex];
  const fillElement = coerceElementIndex(fill?.input?.element ?? fill?.input?.index);
  const filledLength = redactedInputLength(fill?.input?.text);
  const fillTabId = String(fill?.input?.tabId || run.tabId || '');
  const typeTabId = String(call.input?.tabId || run.tabId || '');
  if (fillElement !== element || filledLength !== typedLength || fillTabId !== typeTabId) return null;
  return 'This observed field was already replaced with the requested-length value. Do not append it again; use the retained filled state or submit/inspect the field instead.';
}

function repeatedOuterObservation(run, call) {
  if (call?.name !== 'browser_observe') return null;
  const decisionRevision = Number(run.decisionObservationRevision || 0);
  const currentRevision = Number(run.coordinator?.observationRevision || 0);
  if (!decisionRevision || decisionRevision !== currentRevision) return null;
  return 'A fresh outer-loop page observation is already available for this decision. Do not repeat browser_observe; choose the next grounded visible action or complete the task.';
}

function repeatedScreenshotFromCurrentObservation(run, call) {
  if (call?.name !== 'browser_screenshot') return null;
  if (!run.visualEvidence?.data) return null;
  return 'The current decision already has a fresh screenshot attached. Use that visual evidence now; capture another screenshot only after a page-changing action invalidates it.';
}

function redactedInputLength(value) {
  const match = /^\[(\d+) characters\]$/.exec(String(value || ''));
  return match ? Number(match[1]) : -1;
}

async function waitForNavigationSettle(controller, tabId, timeoutMs = 5_000, signal = null) {  const startedAt = Date.now();
  for (;;) {
    const navigation = await controller.navigationState(tabId);
    if (!navigation?.loading || Date.now() - startedAt >= timeoutMs) return navigation;
    await waitFor(Math.min(300, Math.max(0, timeoutMs - (Date.now() - startedAt))), signal);
  }
}

// A wait returns as soon as an in-flight navigation settles (bounded by the
// requested ms); an already-idle page sleeps the full requested duration so
// waits for animations or lazy content stay honest.
// A decision is "waiting" when every call is a passive wait or a read-only
// poll of a running job â€” the shape of patiently awaiting completion rather
// than doing new work.
function isWaitPollCall(call) {
  if (call?.name === 'browser_wait') return true;
  if (call?.name === 'computer_terminal') return ['read', 'list'].includes(call.input?.action);
  return false;
}

// A wait returns as soon as an in-flight navigation settles (bounded by the
// requested ms); an already-idle page sleeps the full requested duration so
// waits for animations or lazy content stay honest. onPoll keeps the stall
// heartbeat honest: a deliberate 15-minute wait is activity, not a hang.
async function waitWithSettle(controller, tabId, ms, signal, onPoll = null) {
  const startedAt = Date.now();
  const touch = () => { try { onPoll?.(); } catch { /* heartbeat is advisory */ } };
  touch();
  let first = null;
  try { first = await controller.navigationState(tabId); } catch { first = null; }
  if (first?.loading) {
    for (;;) {
      touch();
      const navigation = await controller.navigationState(tabId);
      if (!navigation?.loading || Date.now() - startedAt >= ms) return { waitedMs: Date.now() - startedAt, settled: Boolean(navigation && !navigation.loading), stillLoading: Boolean(navigation?.loading) };
      await waitFor(Math.min(300, Math.max(0, startedAt + ms - Date.now())), signal);
    }
  }
  // Idles are split into short sleeps so a cancelled or steered run wakes up
  // promptly, the stall heartbeat sees a deliberate wait as ALIVE (a touch
  // every chunk — never longer than WAIT_HEARTBEAT_CHUNK_MS), and the
  // heartbeat's hard ceiling can never fire mid-wait.
  const WAIT_HEARTBEAT_CHUNK_MS = 2_000;
  while (Date.now() - startedAt < ms) {
    touch();
    const slept = await waitFor(Math.min(WAIT_HEARTBEAT_CHUNK_MS, Math.max(0, ms - (Date.now() - startedAt))), signal).then(() => true, () => false);
    if (!slept) break;
  }
  if (signal?.aborted) throw signal.reason || new Error('Agent run was cancelled.');
  let after = null;
  try { after = await controller.navigationState(tabId); } catch { after = null; }
  return { waitedMs: Date.now() - startedAt, settled: Boolean(after && !after.loading), stillLoading: Boolean(after?.loading) };
}

function assertComputerMode(run) {
  // The host's control-mode resolver is authoritative WHEN PRESENT (the user
  // can switch modes live); when absent, the run's own promoted settings are
  // the authority. A missing host hook must never read as "wrong mode" — that
  // turned a promoted run into an observation failure, and the recovery loop
  // re-entered immediately: an unbounded allocation storm instead of a run.
  const hostMode = typeof run.getControlMode === 'function' ? run.getControlMode() : run.settings.controlMode;
  if (run.settings.controlMode !== 'agi' || hostMode !== 'agi' || !run.getComputerTools) throw new Error('Computer tools require the user-selected AGI mode.');
}

function invalidateComputerObservation(run) {
  run.computerObservationDirty = true;
  run.pendingComputerDesktop = null;
  run.computerNeedsImage = true;
  run.computerScreenshotStep = null;
  run.visualEvidence = null;
  if (run.latestObservation?.screenshot) delete run.latestObservation.screenshot;
}

async function observeRun(controller, run) {
  if (run.observationDomain !== 'computer') {
    // Browser-domain auto vision mirrors the computer-domain contract: pixels
    // are captured when an executed mutation invalidated the last frame
    // (browserNeedsImage), not as a per-decision default. Without this the
    // model plays visual surfaces (games, canvases, maps) permanently blind
    // under vision 'auto'.
    const skipNavigationSettle = run.skipNavigationSettleOnce === true;
    run.skipNavigationSettleOnce = false;
    return observe(controller, run.tabId, run.settings.vision, {
      needsVisualEvidence: Boolean(run.browserNeedsImage) && run.settings.vision !== 'off',
      diagnosticCursor: run.diagnosticCursor,
      skipNavigationSettle
    }).then((observation) => {
      if (observation?.screenshot?.data) run.browserNeedsImage = false;
      // Grounding digest: the decision sees what its evidence rests on —
      // fresh pixels, a stale carried frame, or DOM only — and can request
      // re-grounding (browser_screenshot) instead of guessing blindly.
      if (observation) observation.grounding = {
        hasPixels: Boolean(observation.screenshot?.data),
        pixelsFrom: observation.screenshot?.data ? 'fresh' : (run.visualEvidence?.data ? 'stale-carried' : 'none'),
        capturedAt: Date.now()
      };
      return observation;
    });
  }
  let desktop = null;
  try {
    // Both the mode assertion and the backend call live behind this guard: a
    // run promoted to AGI on a host with no native backend (or with a
    // control-mode resolver that disagrees) must fall back to the browser
    // surface. Throwing here sent the run into an observation-failure loop
    // that never reached a single model decision.
    assertComputerMode(run);
    desktop = run.pendingComputerDesktop || await run.getComputerTools().observe(run.computerOwner, { signal: run.abortController.signal });
  } catch {
    desktop = null;
  }
  run.pendingComputerDesktop = null;
  // Not a native desktop surface (a browser-only backend, a stub, a capture
  // that is unavailable in this build): fall back to the browser observation
  // rather than inventing a desktop frame. This is what makes the fresh-AGI
  // native-metadata default safe for every backend.
  if (!desktop || !Array.isArray(desktop.windows)) {
    run.observationDomain = 'browser';
    run.computerObservationDirty = false;
    return observe(controller, run.tabId, run.settings.vision, {
      needsVisualEvidence: Boolean(run.browserNeedsImage) && run.settings.vision !== 'off',
      diagnosticCursor: run.diagnosticCursor
    });
  }
  run.computerUsed = true;
  run.computerObservationDirty = false;
  const front = desktop.windows.find(window => window.id === desktop.foregroundWindowId);
  const observation = { desktop, navigation: { url: 'computer://desktop', loading: false },
    dom: { title: front?.title || 'Desktop', viewport: desktop.virtualDesktop, elements: [], landmarks: [], regions: [] }, consoleEntries: [], networkEntries: [] };
  if (run.computerNeedsImage && run.settings.vision !== 'off') {
    // One short, abortable settlement avoids comparing transient pressed-state
    // frames; it is not a claim that an application has finished processing.
    await waitFor(100, run.abortController.signal);
    observation.screenshot = await run.getComputerTools().execute('computer_screenshot', {}, run.computerOwner, { signal: run.abortController.signal });
    run.computerNeedsImage = false;
  }
  // Same grounding digest for desktop observations: fresh pixels, a carried
  // frame, or none — the decision never has to guess what it is looking at.
  observation.grounding = {
    hasPixels: Boolean(observation.screenshot?.data),
    pixelsFrom: observation.screenshot?.data ? 'fresh' : (run.visualEvidence?.data ? 'stale-carried' : 'none'),
    capturedAt: Date.now()
  };
  return observation;
}

async function observe(controller, tabId, vision, { needsVisualEvidence = false, hasCurrentScreenshot = false, diagnosticCursor = null, skipNavigationSettle = false } = {}) {
  // A partially-wired surface (a headless harness, a build without a browser
  // window, a controller whose tab methods are not available) must degrade to
  // empty evidence instead of throwing on every decision. Without this the
  // loop's recovery path re-enters immediately and spins forever — the run
  // never reaches another provider call and the process stops servicing
  // timers (an execution deadlock, not a slow observation).
  const controllerCall = (name, args, fallback) => {
    const fn = controller?.[name];
    if (typeof fn !== 'function') return Promise.resolve(fallback);
    return Promise.resolve(fn.call(controller, ...args));
  };
  // A navigation that is still in flight produces an empty-DOM observation,
  // which forces the model into hand-rolled wait-wait-read cycles. Let the
  // load settle before the snapshot so each post-navigation decision sees the
  // real page.
  const navigation = await (async () => {
    const initial = await controllerCall('navigationState', [tabId], { url: '', loading: false });
    return initial?.loading && !skipNavigationSettle ? waitForNavigationSettle(controller, tabId) : initial;
  })();
  // Pixel capture runs CONCURRENTLY with the DOM snapshot: the capture
  // decision depends only on the settled navigation state, the vision policy,
  // and the re-arm flag — all known here — so the 0.5-4s CDP shot no longer
  // serializes after the DOM read. Identical bytes, gathered in parallel.
  const captureWanted = shouldCaptureAuto({ vision, navigation, hasCurrentScreenshot, needsVisualEvidence });
  const screenshotPromise = captureWanted
    ? controllerCall('screenshot', [tabId], null).then(
        (screenshot) => ({ screenshot }),
        (error) => ({ error })
      )
    : null;
  const [dom, allConsoleEntries, allNetworkEntries] = await Promise.all([
    // Relevance anchor: over-cap pages keep the controls nearest where the
    // agent last acted (the pointer position), so big pages surface relevant
    // evidence instead of the first 120 DOM nodes. Under-cap pages are
    // byte-identical to the previous behavior.
    controllerCall('domSnapshot', [tabId, {
      maxElements: 120, interactiveOnly: true, includeText: true,
      anchor: controller.lastPointer?.get?.(String(tabId)) || null
    }], { url: '', title: '', elements: [] }),
    controllerCall('consoleEntries', [tabId], []),
    controllerCall('networkEntries', [tabId], [])
  ]);
  const consoleEntries = diagnosticDelta(allConsoleEntries, diagnosticCursor, 'console');
  const networkEntries = diagnosticDelta(allNetworkEntries, diagnosticCursor, 'network');
  // The DOM snapshot is sampled from the document that supplied the controls.
  // During a client-side navigation WebContents#getURL can lag by one turn;
  // retain its loading/history flags but use the DOM document URL as the
  // action-grounding location whenever it is available.
  const observedUrl = String(dom?.url || '').trim();
  const effectiveNavigation = observedUrl ? { ...navigation, url: observedUrl } : navigation;
  const observation = {
    navigation: effectiveNavigation,
    dom: summarizeDomForModel(dom),
    consoleEntries,
    networkEntries
  };
  // DOM/AX evidence is the normal fast path. Auto vision is opt-in per
  // observation revision, keeping local-model context and compositor work small.
  if (screenshotPromise) {
    const captured = await screenshotPromise;
    if (captured.error) {
      if (vision === 'always') throw captured.error;
      observation.visionUnavailable = String(captured.error?.message || 'Background visual capture is unavailable.');
    } else {
      observation.screenshot = captured.screenshot;
    }
  }
  return observation;
}

function diagnosticDelta(entries, cursor, kind) {
  const list = Array.isArray(entries) ? entries : [];
  if (!cursor || !Array.isArray(cursor[kind])) return list.slice(0, 20);
  const previous = new Set(cursor[kind]);
  const delta = list.filter((entry) => !previous.has(String(entry?.id || JSON.stringify(entry)))).slice(0, 20);
  cursor[kind] = list.slice(0, 40).map((entry) => String(entry?.id || JSON.stringify(entry)));
  return delta;
}

function summarizeDomForModel(dom) {
  if (!dom || !Array.isArray(dom.elements)) return dom;
  return {
    url: dom.url,
    title: dom.title,
    readyState: dom.readyState,
    viewport: dom.viewport,
    truncated: dom.truncated,
    landmarksTotal: Array.isArray(dom.landmarks) ? dom.landmarks.length : 0,
    regionsTotal: Array.isArray(dom.regions) ? dom.regions.length : 0,
    landmarks: Array.isArray(dom.landmarks) ? dom.landmarks.slice(0, 20).map((landmark) => ({
      tag: landmark?.tag,
      role: landmark?.role,
      label: landmark?.label,
      text: String(landmark?.text || '').slice(0, 240)
    })) : [],
    regions: Array.isArray(dom.regions) ? dom.regions.slice(0, 16).map((region) => ({
      kind: String(region?.kind || '').slice(0, 40),
      name: String(region?.name || '').slice(0, 120),
      rect: region?.rect,
      center: region?.center,
      childCount: Number(region?.childCount || 0),
      descendantCount: Number(region?.descendantCount || 0)
    })) : [],
    elements: dom.elements.map((e) => ({
      index: e.index,
      tag: e.tag,
      role: e.role,
      name: e.name,
      text: e.text,
      ...(typeof e.href === 'string' && e.href ? { href: e.href } : {}),
      rect: e.rect,
      enabled: e.enabled,
      ...(typeof e.pressed === 'boolean' ? { pressed: e.pressed } : {}),
      ...(typeof e.selected === 'boolean' ? { selected: e.selected } : {}),
      ...(typeof e.expanded === 'boolean' ? { expanded: e.expanded } : {}),
      ...(typeof e.dataTool === 'string' && e.dataTool ? { dataTool: e.dataTool } : {}),
      ...(typeof e.testId === 'string' && e.testId ? { testId: e.testId } : {}),
      // The model needs to know that a just-filled control retained a value so
      // it does not append the same query on the next turn. Never send the
      // value itself: presence and length are sufficient state evidence and
      // preserve form/privacy boundaries.
      valuePresent: typeof e.value === 'string' && e.value.length > 0,
      valueLength: typeof e.value === 'string' ? Math.min(e.value.length, 4_000) : 0
    }))
  };
}

// E7 (gen4) first-write window: read the page's form-control constraints
// (maxLength/minLength per input/textarea, plus the page's element ids so a
// non-form target can be told apart from an unverifiable one). Read-only
// pre-probe; any failure returns null and the gate stands down (allow). This
// is an INTERNAL probe — it is never recorded in history and never dispatches
// the model's script.
async function probeFormControlConstraints(controller, tabId) {
  try {
    const probeScript = "return (function(){ try { var controls=[]; var els=document.querySelectorAll('input,textarea'); for (var i=0;i<els.length&&i<50;i++){ var e=els[i]; controls.push({ tag: String(e.tagName||'').toLowerCase(), id: String(e.id||''), name: String(e.name||''), maxLength: (typeof e.maxLength==='number'&&e.maxLength>=0)?e.maxLength:0, minLength: (typeof e.minLength==='number'&&e.minLength>=0)?e.minLength:0 }); } var ids=[]; var withIds=document.querySelectorAll('[id]'); for (var j=0;j<withIds.length&&j<100;j++){ if (withIds[j].id) ids.push(String(withIds[j].id)); } return { controls: controls, ids: ids }; } catch (e) { return null; } })()";
    const result = await controller.executePageScript(tabId, { script: probeScript });
    const proof = result?.result;
    if (proof && typeof proof === 'object' && !Array.isArray(proof)) return proof;
    if (Array.isArray(proof)) return { controls: proof, ids: [] };
    return null;
  } catch { return null; }
}

async function executeAction(controller, run, call) {
  // Failure-ladder bookkeeping: which kinds of approach were tried, whether
  // research happened, and how many attempts followed the research.
  if (run && call?.name && call.name !== 'browser_done') {
    if (!run.failureLadder) run.failureLadder = { tools: new Set(), researched: false, postResearchActions: 0 };
    const isResearch = call.name === 'research_task' || call.name === 'web_search' || call.name === 'browser_search';
    if (isResearch) run.failureLadder.researched = true;
    else {
      run.failureLadder.tools.add(call.name);
      if (run.failureLadder.researched) run.failureLadder.postResearchActions += 1;
    }
  }
  try {
    // Workspace handoff: re-scope the run to a directory the user named.
    if (call.name === 'workspace_retarget') {
      const requested = path.resolve(String(call.input?.path || '').trim());
      if (!/^[A-Za-z]:[\\/]/.test(requested) && !requested.startsWith('/')) return { ok: false, recoverable: true, error: 'workspace_retarget needs an absolute directory path.' };
      let stat = null;
      try { stat = fs.statSync(requested); } catch { return { ok: false, recoverable: true, error: `Path not found: ${requested}` }; }
      if (!stat.isDirectory()) return { ok: false, recoverable: true, error: `Not a directory: ${requested}` };
      const mentioned = [
        String(run.task || ''),
        ...(Array.isArray(run.messages) ? run.messages : [])
          .filter((message) => message?.role === 'user' && message?.source !== 'runtime')
          .map((message) => String(message?.content || ''))
      ].join('\n');
      const norm = (value) => String(value || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
      const mentionedPaths = [...new Set((mentioned.match(/[A-Za-z]:[\\/][^\s"',;)\]]+/g) || []).map(norm))];
      const retargetRoot = norm(requested);
      const allowed = !mentionedPaths.length || mentionedPaths.some((candidate) => retargetRoot.startsWith(candidate) || candidate.startsWith(retargetRoot));
      if (!allowed) return { ok: false, recoverable: true, error: 'Refused: only a directory the user named (in the task or a message) can become the run workspace. Ask the user to name it.' };
      run.workspace = { ...(run.workspace || {}), root: requested, target: requested, url: null };
      run.workspaceRetargetedAt = Date.now();
      // GEN9: the handoff re-pins the repo map AND the notebook's WORKING
      // REPOS section — one source of truth, mirrored to disk immediately.
      registerRepo(run.repoMap, requested, { pinned: true, source: 'retarget' });
      run.notebook?.syncRepoSection?.(Array.isArray(run.repoMap) ? run.repoMap : []);
      appendConversationMessage(run, 'user', `WORKSPACE HANDOFF: this run is now scoped to ${requested}. File, terminal, and git work are verified against this root.`, { source: 'runtime' });
      return { ok: true, result: { root: requested, target: requested } };
    }
    // GEN9: the notebook tool — the ONE model route to the durable notebook.
    // op=read (default): full text, or one section with section="NAME".
    // op=update: append text under a known section (agent sections keep
    // ownership; user sections are never rewritten by the model — updates to
    // USER RULES etc. land as suggested lines in NOTES instead, so a user
    // edit can never be clobbered by the model).
    if (call.name === 'notebook') {
      if (!run.notebook) return { ok: false, recoverable: false, error: 'No notebook is active for this run.' };
      const op = String(call.input?.op || 'read').toLowerCase();
      const section = String(call.input?.section || '').trim();
      if (op === 'read') {
        if (section) {
          const body = run.notebook.readSection(section);
          if (body === null) return { ok: false, recoverable: true, error: `No section "${section}" exists. Sections live in the notebook wire block; use op=read without section to list them.` };
          return { ok: true, result: { tool: 'notebook', section, content: body.slice(0, 20_000) } };
        }
        return { ok: true, result: { tool: 'notebook', path: run.notebook.filePath, content: String(run.notebook.read() || '').slice(0, 20_000) } };
      }
      if (op === 'update' || op === 'append') {
        const text = String(call.input?.text || '').trim();
        if (!text) return { ok: false, recoverable: true, error: 'notebook update needs text to append.' };
        const USER_SECTIONS = ['USER RULES', 'CREDENTIALS & KEYS', 'COMMANDS', 'NOTES'];
        const isUserSection = USER_SECTIONS.some(name => name.toLowerCase() === section.toLowerCase());
        const target = isUserSection ? 'NOTES' : (section || 'PROJECT FACTS');
        const result = run.notebook.append(target, text.slice(0, 500));
        syncNotebook(run);
        return { ok: result.ok !== false, result: { tool: 'notebook', section: target, appended: text.slice(0, 200), ...(isUserSection ? { note: `"${section}" is user-owned; the line was appended to NOTES instead so your edits there are never clobbered.` } : {}) } };
      }
      return { ok: false, recoverable: true, error: 'notebook op must be "read" or "update".' };
    }
    if (call.name !== 'browser_wait') {
      run.loopState.consecutiveWaits = 0;
      run.loopState.lastWaitedMs = 0;
    }
    const hcuTool = parseHcuToolName(call.name);
    if (hcuTool) {
      assertComputerMode(run);
      run.computerUsed = true;
      run.observationDomain = 'computer';
      try {
        const result = await run.hcuApi.execute(call.name, call.input, run.computerOwner, { signal: run.abortController.signal });
        if (result?.images?.length) {
          const image = { ...result.images[0], source: 'hcu' };
          run.visualEvidence = image;
          run.computerNeedsImage = false;
          run.latestObservation = run.latestObservation || { desktop: { windows: [], pointer: null }, screenshot: null };
          run.latestObservation.screenshot = image;
        }
        return { ok: result?.ok !== false, result, ...(result?.error ? { error: result.error } : {}) };
      } catch (error) {
        const message = String(error?.message || error);
        const stale = /stale_ref|gui_frame_stale|window_changed/i.test(message);
        return { ok: false, recoverable: true, recoverySource: stale ? 'layout_changed' : 'hcu_error', error: message, hcu: true };
      }
    }
    // Retired computer_file stays executable for direct callers (compat), even
    // though toolDefinitions never offers it to the model.
    if (isComputerTool(call.name) || call.name === 'computer_file') {
      assertComputerMode(run);
      run.computerUsed = true;
      if (['computer_observe', 'computer_pointer', 'computer_stroke', 'computer_keyboard', 'computer_window', 'computer_screenshot'].includes(call.name)) {
        const changedDomain = run.observationDomain !== 'computer';
        const mayChangeDesktop = !computerReadOnly(call.name, call.input);
        run.observationDomain = 'computer';
        if (changedDomain || mayChangeDesktop) invalidateComputerObservation(run);
      }
      // A failed native gesture may already have moved or drawn. Invalidate
      // before dispatch; read-only calls must not consume a pending capture.
      let result;
      try {
        result = await run.getComputerTools().execute(call.name, call.input, run.computerOwner, {
          signal: run.abortController.signal,
          onProgress: (progress) => {
            if (progress?.type === 'patch.progress') this.publish('tool.progress', run, { tool: call.name, ...progress });
          }
        });
      } catch (error) {
        if (['computer_patch', 'computer_patch_live'].includes(call.name)) {
          const key = String(call.input?.path || '');
          const failures = (run.patchFailures ||= new Map());
          const count = (failures.get(key) || 0) + 1;
          failures.set(key, count);
          if (count >= 6) {
            return { ok: false, recoverable: true, recoverySource: 'patch_fallback_required', error: `Patch has failed ${count} cumulative times for ${key}. Stop retrying patch tools and use computer_patch_chunk (overwrite/append/insert raw content).`, fallbackTool: 'computer_patch_chunk', failures: count };
          }
          if (count >= 3 && call.name === 'computer_patch') {
            return { ok: false, recoverable: true, recoverySource: 'patch_fallback_required', error: `Primary computer_patch has failed ${count} times for ${key}. Use computer_patch_live with ordered per-line ops next; return to computer_patch after the fallback succeeds.`, fallbackTool: 'computer_patch_live', failures: count };
          }
        }
        throw error;
      }
      if (call.name === 'computer_patch_chunk' && result?.applied === true) {
        (run.patchFailures ||= new Map()).delete(String(call.input?.path || ''));
      }
      if (['computer_patch', 'computer_patch_live'].includes(call.name)) {
        const key = String(call.input?.path || '');
        const failed = result?.applied === false || (Array.isArray(result?.opErrors) && result.opErrors.length > 0);
        if (failed) {
          const failures = (run.patchFailures ||= new Map());
          const count = (failures.get(key) || 0) + 1;
          failures.set(key, count);
          if (count >= 6) return { ok: false, recoverable: true, recoverySource: 'patch_fallback_required', error: `Patch has failed ${count} cumulative times for ${key}. Use computer_patch_chunk next.`, fallbackTool: 'computer_patch_chunk', result, failures: count };
          if (count >= 3 && call.name === 'computer_patch') return { ok: false, recoverable: true, recoverySource: 'patch_fallback_required', error: `Primary patch failed ${count} times for ${key}. Use computer_patch_live next.`, fallbackTool: 'computer_patch_live', result, failures: count };
        } else {
          (run.patchFailures ||= new Map()).delete(key);
        }
      }
      if (call.name === 'computer_observe' || call.name === 'computer_window' && call.input.action === 'list') {
        if (run.computerScreenshotStep !== run.step && (run.visualEvidence?.source === 'native-desktop' || run.settings.vision === 'always')) invalidateComputerObservation(run);
        run.pendingComputerDesktop = Array.isArray(result?.windows) ? result : null;
        run.computerObservationDirty = true;
      }
      if (call.name === 'computer_screenshot') {
        run.computerNeedsImage = false;
        run.computerScreenshotStep = run.step;
        run.pendingComputerDesktop = null;
        run.computerObservationDirty = true;
        run.visualEvidence = result;
        if (run.latestObservation) run.latestObservation.screenshot = result;
      }
      // GEN9 WRITE TRAIL (defect D4): an applied file mutation is logged
      // durably in the notebook — "the file on disk already contains the
      // avatar patch" loops die when the last landed write is pinned on the
      // wire. Best-effort; never affects the action result.
      const writeLanded = (['computer_patch', 'computer_patch_chunk'].includes(call.name) && result?.applied === true)
        || (['computer_write', 'computer_fs', 'computer_fs_batch'].includes(call.name) && (result?.changed === true || result?.results?.some?.((item) => item.changed === true)));
      if (writeLanded && run.notebook) {
        try {
          const target = String(call.input?.path || call.input?.filename || call.input?.destination || 'unknown');
          run.notebook.append('WRITE TRAIL', `${target} — ${call.name}${call.input?.action ? ` ${call.input.action}` : ''} applied`);
        } catch { /* trail is best-effort */ }
      }
      // PATCH CADENCE (2026-10-31): the 2026-10-31 run made twenty patches to
      // one HTML file and the last twelve were ONE LINE each — a long tail of
      // one-line edits, each one costing a re-read, a decision and a fresh
      // file hash. The harness can see the shape of that: count the patches
      // per file and how many lines each one carried. When a file is being
      // edited a line at a time, say so once, at the next boundary.
      if (['computer_patch', 'computer_patch_chunk'].includes(call.name) && result?.applied === true && Array.isArray(result.files)) {
        for (const file of result.files) {
          const key = String(file?.path || call.input?.path || '');
          if (!key) continue;
          const entry = (run.patchCadence ||= new Map()).get(key) || { patches: 0, lines: 0, small: 0 };
          entry.patches += 1;
          const changed = Math.max(0, Number(file.addedLines) || 0) + Math.max(0, Number(file.removedLines) || 0);
          entry.lines += changed;
          if (changed <= 3) entry.small += 1;
          entry.lastAt = Date.now();
          (run.patchCadence ||= new Map()).set(key, entry);
          // PAGE FRESHNESS: the loaded page now differs from what is on
          // screen. Until it is reloaded, a frame of it cannot show the change.
          (run.pageChanges ||= new Map()).set(key, Date.now());
        }
      }
      return { ok: result?.state !== 'failed', result, ...(result?.outcome ? { outcome: result.outcome } : {}), ...(result?.state === 'failed' ? { error: result.error || `Command exited with status ${result.exitCode}.` } : {}),
        ...((['computer_patch', 'computer_patch_chunk'].includes(call.name) && result?.applied === true) || (call.name === 'computer_write' || call.name === 'computer_fs' || call.name === 'computer_fs_batch') && (result.changed === true || result.results?.some?.((item) => item.changed === true)) ? { progress: true } : {}) };
    }
    if (call.name.startsWith('browser_') && !['browser_done', 'browser_wait'].includes(call.name)) {
      if (run.observationDomain === 'computer') {
        run.visualEvidence = null;
        run.pendingComputerDesktop = null;
        run.computerObservationDirty = false;
        run.computerScreenshotStep = null;
        if (run.latestObservation?.screenshot) delete run.latestObservation.screenshot;
        // A browser action after desktop control invalidates the desktop
        // frame; the next browser observation re-grounds in fresh pixels.
        run.browserNeedsImage = true;
      }
      run.observationDomain = 'browser';
    }
    if (call.name === 'browser_tabs') return { ok: true, result: controller.listTabs() };
    if (call.name === 'browser_new_tab') {
      if (typeof run.createTab !== 'function') throw new Error('Creating tabs is unavailable in this Desktop build.');
      const previousTabId = String(run.tabId || '');
      const tab = await run.createTab(call.input.url);
      if (!tab?.id) throw new Error('The browser did not return the new tab identity.');
      run.ownedTabIds = [...new Set([...(run.ownedTabIds || []), String(tab.id)])];
      run.tabId = tab.id;
      if (previousTabId && previousTabId !== String(tab.id) && run.ownedTabIds.includes(previousTabId) && typeof run.closeTab === 'function') {
        try { run.closeTab(previousTabId, { preserveRun: true }); } catch { /* stale tab cleanup is best effort */ }
        run.ownedTabIds = run.ownedTabIds.filter((id) => id !== previousTabId);
      }
      run.loopState = { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 };
      return { ok: true, result: tab };
    }
    if (call.name === 'browser_select_tab') {
      const tabId = String(call.input.tabId || '');
      if (!tabId || typeof run.selectTab !== 'function') throw new Error('browser_select_tab requires a valid tabId.');
      const selection = Promise.resolve().then(() => run.selectTab(tabId));
      // Selecting a tab is a binding change, not a navigation. Bound the host
      // callback so a stale WebContents/IPC handoff can never hold the agent
      // thought indefinitely. The late promise is observed but never awaited.
      selection.catch(() => {});
      let selected;
      try {
        selected = await Promise.race([
          selection,
          waitFor(1_500, run.abortController?.signal).then(() => { throw new Error('browser_select_tab timed out while switching the run binding. Re-list tabs and retry once.'); })
        ]);
      } catch (error) {
        return { ok: false, recoverable: true, recoverySource: 'tab_selection', error: String(error?.message || error), tabId };
      }
      if (!selected?.id) return { ok: false, recoverable: true, recoverySource: 'tab_selection', error: 'browser_select_tab returned no selected tab identity. Re-list tabs and retry once.', tabId };
      run.tabId = selected.id;
      run.skipNavigationSettleOnce = true;
      run.latestObservation = null;
      run.loopState = { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 };
      return { ok: true, result: { ...selected, selectedTabId: String(selected.id), note: 'Tab binding changed immediately. The next decision receives a fresh observation for this tab; no tab-load wait is required.' } };
    }
    if (call.name === 'browser_focus_tab') {
      // The human-facing switch: changes which tab is visible/selected. The
      // injected callback (main.cjs) enforces the ownership gate — refused
      // while any other live agent owns tabs — and never rebinds this run.
      if (typeof run.focusTab !== 'function') throw new Error('Foreground tab switching is unavailable in this Desktop build.');
      const tabId = String(call.input.tabId || run.tabId || '');
      if (!tabId) throw new Error('browser_focus_tab requires a valid tabId.');
      const focused = await run.focusTab(tabId, run.id);
      return { ok: true, result: focused };
    }
    if (call.name === 'chat_compact') {
      const ledger = run.turnLedger;
      if (!ledger) return { ok: false, recoverable: false, error: 'No conversation ledger is active for this run.' };
      const summarize = run.providerInstance?.summarizeFor
        ? (system, input, signal) => run.providerInstance.summarizeFor(system, input, signal, run.coordinator)
        : null;
      const stats = await ledger.compact({ current: {}, system: 'compact', tools: [], outputTokens: 2_048, summarize, signal: run.abortController?.signal, force: true });
      const didCompact = Boolean(stats?.compacted);
      const note = didCompact
        ? 'Conversation memory compacted: closed turns were summarized into the state snapshot and the oldest groups dropped. If work is mid-flight, continue it from the snapshot; if the conversation is idle, reply with ONE short line acknowledging the compaction — do NOT restate prior conclusions.'
        : `Nothing to compact — the live window is already small (${stats?.turnsAfter ?? 0} retained turn(s)). Do NOT restate prior conclusions; if the conversation is idle, reply with one short line acknowledging that memory is already compact.`;
      return { ok: true, result: { tool: 'chat_compact', ...(stats || {}), note } };
    }
    if (call.name === 'update_plan' || call.name === 'create_plan') {
      // The plan itself was already applied and published by the caller; this
      // branch only records the executor result.
      return { ok: true, result: { steps: run.plan.length, created: call.name === 'create_plan' } };
    }
    if (call.name === 'ask_user') {
      const question = String(call.input?.question || '').trim();
      if (!question) return { ok: false, recoverable: true, error: 'ask_user requires a question.' };
      const options = String(call.input?.options || '').trim();
      const context = String(call.input?.context || '').trim();
      // The question is returned as the tool result — it appears in the
      // transcript and the user sees it. The run continues; the user's reply
      // arrives as a pendingUserMessage in the next decision.
      // Custom card rendering: the model may supply html + css to design the
      // question card (icons, tables, flowcharts, illustrations). Sanitized
      // in the renderer; falls back to plain text when omitted.
      const html = String(call.input?.html || '').trim();
      const css = String(call.input?.css || '').trim();
      // Pause the run: the question is shown to the user and the run WAITS
      // for their reply. The reply is returned as this tool's result.
      // Pause the run: the question is shown to the user and the run WAITS
      // for their reply. Inline promise because executeAction is a standalone
      // function without access to the agent instance (this).
      run.status = 'awaiting_input';
      run.pendingUserQuestion = { id: crypto.randomUUID(), question: question.slice(0, 4000), options: options.slice(0, 4000) };
      // Publish the question BEFORE waiting. The old handler only returned the
      // card as the tool result, which does not exist until the user answers —
      // so the user never saw the question and the run waited forever.
      const askCard = {
        asked: true, answered: false, question,
        ...(options ? { options } : {}),
        ...(context ? { context } : {}),
        ...(html ? { html } : {}),
        ...(css ? { css } : {})
      };
      try { run.publishEvent?.('user.input.required', { question: { ...run.pendingUserQuestion, context, html, css }, card: askCard }); } catch { /* the card is additive */ }
      const reply = await new Promise((resolve) => {
        run.userInputResolver = resolve;
        // Cancelling the run must release the wait instead of hanging forever.
        const release = () => resolve('');
        if (run.abortController?.signal?.aborted) release();
        else run.abortController?.signal?.addEventListener('abort', release, { once: true });
      });
      run.userInputResolver = null;
      run.pendingUserQuestion = null;
      if (run.status === 'cancelled' || run.abortController?.signal?.aborted) throw new Error('Agent run was cancelled.');
      if (run.status !== 'cancelled') run.status = 'running';
      try { run.publishEvent?.('user.input.received', { reply }); } catch { /* additive */ }
      return {
        ok: true,
        result: {
          asked: true,
          answered: true,
          question,
          ...(options ? { options } : {}),
          ...(context ? { context } : {}),
          ...(html ? { html } : {}),
          ...(css ? { css } : {}),
          userReply: reply,
          note: 'The user\'s reply is in userReply. Act on it — do NOT repeat the question.'
        }
      };
    }
    if (call.name === 'browser_done') {
      const reportWritten = run.history.some((entry) => entry.tool === 'write_report_file' && entry.output?.ok);
      if (call.input.success !== false && shouldRequireLongReport(run.task) && !reportWritten) {
        return {
          ok: false,
          recoverable: true,
          error: 'This request explicitly asks for a comprehensive long-form analysis. Create the supported report file, choosing TXT or HTML yourself, then return a concise saved-file confirmation.'
        };
      }
      const success = call.input.success !== false;
      return { ok: true, summary: String(call.input.summary || 'Task completed.').slice(0, 4_000), success, verified: success && call.input.verified === true, final: call.input.final === true };
    }
    if (call.name === 'write_report_file') {
      if (typeof run.writeReportFile !== 'function') throw new Error('Formatted report files are unavailable in this Desktop build.');
      const report = normalizeReportInput(run.task, call.input);
      return { ok: true, result: await run.writeReportFile(report) };
    }
    const targetTabId = String(call.input?.tabId || run.tabId);
    if (!(call.name === 'browser_wait' && run.observationDomain === 'computer') && typeof controller.listTabs === 'function' && !controller.listTabs().some((tab) => tab.id === targetTabId)) {
      // A missing bound tab is recoverable, not a crash: report it once as a
      // bounded advisory with the recovery action, instead of throwing the same
      // error on every later call and spawning endless advisory cards.
      const missingTabKey = `missing-tab:${targetTabId}`;
      run.missingTabNotices = run.missingTabNotices || {};
      if (!run.missingTabNotices[missingTabKey]) {
        run.missingTabNotices[missingTabKey] = true;
        return {
          ok: false,
          recoverable: true,
          recoverySource: 'missing_bound_tab',
          error: `Tab ${targetTabId} is no longer available. Open or rebind a tab with browser_tabs/browser_new_tab and continue from a fresh observation; do not retry the same action on the missing tab.`,
          advisory: 'The bound tab is no longer available'
        };
      }
      throw new Error(`Tab ${targetTabId} is no longer available.`);
    }
    if (call.name === 'browser_observe') {
      const observation = await observe(controller, targetTabId, run.settings.vision);
      run.lastObservedUrl = observation.navigation.url;
      storeTabObservation(run, targetTabId, observation);
      return { ok: true, observation };
    }
    if (call.name === 'browser_mousemove') {
      if (call.input?.tabId !== undefined && targetTabId !== String(run.tabId) && !run.observationsByTab?.has(targetTabId)) {
        throw new Error('browser_mousemove coordinates must match a tab this run has observed. Run browser_observe on that tabId first, then act on it.');
      }
      const point = viewportPoint(run, call.input.x, call.input.y, 'browser_mousemove', targetTabId, {
        coordinateSpace: call.input.coordinateSpace,
        screenshotId: call.input.screenshotId
      });
      return pointerActionOutput(await controller.mouseMove(targetTabId, point, { sessionId: run.id }), 'pointer movement');
    }
    if (call.name === 'browser_target_click') {
      const target = resolveVisualTarget(latestObservationForAction(run, targetTabId), call.input?.target);
      if (!target) throw new Error('Visual target was not found or was ambiguous; observe the current surface again.');
      return pointerActionOutput(await controller.clickAt(targetTabId, target.center, run.id), 'semantic target click');
    }
    if (call.name === 'browser_target_drag') {
      const from = resolveVisualTarget(latestObservationForAction(run, targetTabId), call.input?.from);
      const to = resolveVisualTarget(latestObservationForAction(run, targetTabId), call.input?.to);
      if (!from || !to) throw new Error('Visual drag target was not found or was ambiguous; observe the current surface again.');
      return pointerActionOutput(await controller.drag(targetTabId, { startX: from.center.x, startY: from.center.y, endX: to.center.x, endY: to.center.y, steps: clamp(call.input?.steps ?? 8, 1, 100), durationMs: clamp(call.input?.durationMs ?? 250, 5, 5_000) }, run.id), 'semantic target drag');
    }
    if (call.name === 'browser_click') {
      // Coordinate input is authoritative when present. Models often retain a
      // stale DOM index while adding the fresh visual point; resolving the
      // index first silently clicks an unrelated control (the chess failure
      // clicked the site logo instead of the board). The index remains useful
      // metadata for the model but never overrides an explicit point.
      if (coordinatorHasCoordinatePair(call.input)) {
        if (call.input.element !== undefined && coerceElementIndex(call.input.element) === undefined) {
          throw new Error('browser_click element index must be a non-negative integer when provided; omit it for pure coordinate clicks.');
        }
        const point = viewportPoint(run, call.input.x, call.input.y, 'browser_click', targetTabId, {
          coordinateSpace: call.input.coordinateSpace,
          screenshotId: call.input.screenshotId
        });
        const result = pointerActionOutput(await controller.clickAt(targetTabId, point, run.id), 'coordinate click');
        const hit = result?.result?.hit;
        if (result.ok && hit && hit.hit === false) {
          return {
            ok: false,
            recoverable: true,
            recoverySource: 'click_missed_target',
            error: `The click was dispatched at viewport (${point.x}, ${point.y}) but document.elementFromPoint found no element there. The coordinates are outside page content — likely screenshot image pixels. Retry with coordinateSpace="screenshot" and the latest screenshotId, or take a fresh browser_screenshot and re-derive the point.`,
            result
          };
        }
        if (result.ok && hit?.hit && hit.isCanvas) {
          result.result.canvasHit = true;
        }
        return result;
      }
      const rawIndex = call.input.element !== undefined ? call.input.element : call.input.index;
      const index = coerceElementIndex(rawIndex);
      if (index !== undefined) return pointerActionOutput(await controller.clickElement(targetTabId, { index }, run.id), 'indexed click');
      throw new Error('browser_click requires either an element index or {x, y} coordinates.');
    }
    if (call.name === 'browser_drag') {
      const frame = { coordinateSpace: call.input.coordinateSpace, screenshotId: call.input.screenshotId };
      const start = viewportPoint(run, call.input.startX, call.input.startY, 'browser_drag start', targetTabId, frame);
      const end = viewportPoint(run, call.input.endX, call.input.endY, 'browser_drag end', targetTabId, frame);
      return pointerActionOutput(await controller.drag(targetTabId, {
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          steps: clamp(call.input.steps ?? 12, 1, 100),
          durationMs: clamp(call.input.durationMs ?? 300, 5, 5_000)
        }, run.id), 'drag');
    }
    if (call.name === 'browser_type') {
      const rawIndex = call.input.element !== undefined ? call.input.element : call.input.index;
      const index = coerceElementIndex(rawIndex);
      if (index !== undefined) {
        const focus = await controller.clickElement(targetTabId, { index }, run.id);
        const focusOutput = pointerActionOutput(focus, 'field focus');
        if (!focusOutput.ok) return focusOutput;
      }
      return { ok: true, result: await controller.type(targetTabId, { text: String(call.input.text || '') }) };
    }
    if (call.name === 'browser_fill') {
      const rawIndex = call.input.element !== undefined ? call.input.element : call.input.index;
      const index = coerceElementIndex(rawIndex);
      if (index === undefined) throw new Error('browser_fill requires an element index from the current DOM snapshot.');
      if (typeof controller.fillElement !== 'function') throw new Error('Idempotent field filling is unavailable in this Desktop build.');
      const result = await controller.fillElement(targetTabId, { index, text: String(call.input.text || '') });
      if (result?.ok !== true) {
        // E7 (gen3): the rejection names the conflict protocol (the arch1 D1
        // fold) so the blocked path is present at the decision, not only in
        // the prompt.
        return { ok: false, recoverable: true, error: `${String(result?.reason || 'The page did not accept the requested field value.')} The page rejecting this value is the blocked path: attempt the blocked-done, or commit the minimal page-valid adaptation and name the deviation.`, result };
      }
      return { ok: true, result, progress: result.changed === true };
    }
    if (call.name === 'browser_scroll') return pointerActionOutput(await controller.scroll(targetTabId, call.input, run.id), 'scroll');
    if (call.name === 'browser_key') return { ok: true, result: await controller.key(targetTabId, call.input, run.id) };
    if (call.name === 'browser_screenshot') {
      // PAGE FRESHNESS: a frame is evidence of a change only if the page was
      // loaded AFTER the change. On 2026-10-31 the agent patched the page file
      // three times, took a screenshot without reloading, and used the stale
      // frame to claim the change worked — when it had not.
      //
      // Refuse the stale frame and say exactly what to do. Bounded: after two
      // refusals the frame is allowed through, with the staleness stated in
      // the result, so a run can never be wedged by this rule.
      const stale = stalePageFiles(run, targetTabId);
      if (stale.length) {
        run.staleFrameRefusals = (run.staleFrameRefusals || 0) + 1;
        const file = stale[0].file;
        const where = file.split(/[\\/]/).pop();
        if (run.staleFrameRefusals <= 2) {
          return {
            ok: false,
            recoverable: true,
            recoverySource: 'stale_page_view',
            error: `STALE VIEW: ${file} was changed after this page was loaded, so the page on screen does NOT show that change. A screenshot of it cannot verify the change. Reload the page first — browser_navigate to the same URL (add ?verify=1 to bypass the cache), then take the screenshot again.`
          };
        }
        const frame = await controller.screenshot(targetTabId);
        return { ok: true, result: { ...frame, staleWarning: `This page was NOT reloaded after ${where} changed; the frame does not show that change.` } };
      }
      const frame = await controller.screenshot(targetTabId);
      // The frame's own provenance: which page it shows, and when. The done
      // gate checks this frame against the page's later changes.
      run.frameEvidence = { at: Date.now(), url: String(run.pageLoads?.get(String(targetTabId))?.url || run.lastObservedUrl || '') };
      return { ok: true, result: frame };
    }
    if (call.name === 'browser_console_entries') return { ok: true, result: controller.consoleEntries(targetTabId) };
    if (call.name === 'browser_network_entries') return { ok: true, result: controller.networkEntries(targetTabId) };
    if (call.name === 'browser_navigation_state') return { ok: true, result: controller.navigationState(targetTabId) };
    if (call.name === 'browser_query') {
      // Selector/text lookups must find what EXISTS (run-forensics
      // 2026-10-15): the implicit interactiveOnly:true default returned
      // count:0 for an existing non-interactive node (.statgrid) and sent
      // the model chasing a wrong "element missing" hypothesis for a full
      // cycle. Lookup by selector/text now defaults to the whole DOM; an
      // explicit interactiveOnly from the model is still honored.
      const input = { ...call.input };
      if (input.interactiveOnly === undefined && (input.selector || input.text)) input.interactiveOnly = false;
      const result = await controller.queryElements(targetTabId, { ...input, maxElements: Math.min(Number(input.maxElements) || 100, 250) });
      return { ok: true, result: compactQueryResult(result, input) };
    }
    if (call.name === 'browser_extract') {
      const result = await controller.queryElements(targetTabId, { ...call.input, interactiveOnly: false, includeText: true, maxElements: Math.min(Number(call.input.maxElements) || 100, 250) });
      return { ok: true, result: compactQueryResult(result, call.input) };
    }
    if (call.name === 'browser_execute') {
      const result = await controller.executePageScript(targetTabId, call.input);
      const proof = result?.result;
      if (proof && typeof proof === 'object' && proof.ok === false) {
        return { ok: false, recoverable: true, error: String(proof.reason || proof.error || 'The page command reported that it could not complete the requested action.'), result };
      }
      // LORDE_PROOF_FIRST_V367 — the script's proof previously sat at
      // result.result.*, and context truncation showed the model only
      // {tabId}, which sent it re-deriving page state from file reads.
      // Flatten: the proof rides at the top of result. The original nesting is
      // kept alongside it so consumers that read the raw script return keep
      // working (and a truncated context still has the flat proof to show).
      const flat = (proof && typeof proof === 'object') ? { ...proof, tabId: result?.tabId } : { value: proof ?? null, tabId: result?.tabId };
      return { ok: true, result: { ...flat, result: proof ?? null }, progress: proof?.changed === true };
    }
    if (call.name === 'browser_wait') {
      const requestedMs = Number(call.input.ms);
      if (!Number.isFinite(requestedMs) || requestedMs <= 0) {
        return {
          ok: false,
          recoverable: true,
          recoverySource: 'wait_ms_invalid',
          error: `browser_wait requires an explicit positive ms value no greater than ${MAX_BROWSER_WAIT_MS} (15 minutes). For a known long-running job, wait long: request progressively larger waits (30s, 1m, 2m, 5m...) instead of polling.`,
          result: { requestedMs: call.input.ms ?? null, waitedMs: 0 }
        };
      }
      // Clamp to remaining run budget if an external deadline is active.
      const budgetRemaining = remainingRunMs(run);
      if (budgetRemaining !== null && budgetRemaining <= 0) {
        return {
          ok: false,
          recoverable: false,
          recoverySource: 'deadline_exceeded',
          error: 'The run deadline has already expired; no further wait can start.',
          result: { requestedMs: call.input.ms ?? null, waitedMs: 0 }
        };
      }
      const requestedWaitMs = Math.min(Math.round(requestedMs), MAX_BROWSER_WAIT_MS, budgetRemaining ?? Infinity);
      const waitNumber = Math.max(0, Number(run.loopState.consecutiveWaits) || 0) + 1;
      // The escalation floor exists to stop rapid repeated short waits; the
      // first wait of a streak honors the model's exact value.
      const minimumMs = waitNumber >= 2 ? WAIT_BACKOFF_MS[Math.min(waitNumber - 1, WAIT_BACKOFF_MS.length - 1)] : 0;
      const escalatedMs = Math.min(MAX_BROWSER_WAIT_MS, budgetRemaining ?? Infinity, Math.max(requestedWaitMs, minimumMs));
      const waitController = new AbortController();
      const abortFromRun = () => waitController.abort(run.abortController.signal.reason || new Error('run-cancelled'));
      run.abortController.signal.addEventListener('abort', abortFromRun, { once: true });
      run.messageWakeController = waitController;
      let settled;
      let wokenByAgentMessage = false;
      try {
        settled = await waitWithSettle(controller, targetTabId, escalatedMs, waitController.signal, () => { run.lastRealActivityAt = Date.now(); });
      } catch (error) {
        if (waitController.signal.aborted && !run.abortController.signal.aborted) {
          wokenByAgentMessage = true;
          // LORDE_CRITIC_GATES_V365 — the wake must not be a riddle: the
          // arriving messages ride along in the result (they are ALSO
          // delivered into the next decision context; not consumed here).
          settled = {
            waitedMs: 0, settled: false, stillLoading: false,
            ...(Array.isArray(run.pendingAgentMessages) && run.pendingAgentMessages.length
              ? { incomingMessages: run.pendingAgentMessages.slice(-4).map(message => ({ from: String(message.fromLabel || message.from || 'agent').slice(0, 80), text: String(message.text || '').slice(0, 600) })) }
              : {})
          };
        } else throw error;
      } finally {
        run.abortController.signal.removeEventListener('abort', abortFromRun);
        if (run.messageWakeController === waitController) run.messageWakeController = null;
      }
      if (run.observationDomain === 'computer') invalidateComputerObservation(run);
      run.loopState.consecutiveWaits = waitNumber;
      run.loopState.lastWaitedMs = settled.waitedMs;
      const nextMinimumMs = WAIT_BACKOFF_MS[Math.min(waitNumber, WAIT_BACKOFF_MS.length - 1)];
      const note = settled.stillLoading
        ? 'The page is still loading after this wait; wait again or inspect the partial state.'
        : (escalatedMs > requestedWaitMs && settled.waitedMs > requestedWaitMs
          ? `Consecutive waits escalated cumulatively from ${requestedWaitMs}ms to ${escalatedMs}ms: the awaited work looks long-running, so keep waiting longer rather than polling.`
          : null);
      return {
        ok: true,
        result: {
          requestedMs: Math.round(requestedMs),
          waitedMs: settled.waitedMs,
          settled: settled.settled,
          ...(settled.stillLoading ? { stillLoading: true } : {}),
          consecutiveWaits: waitNumber,
          nextMinimumMs,
          ...(wokenByAgentMessage ? { wokenByAgentMessage: true, note: 'Woken by an incoming agent message; the next decision receives it with full tools.' } : {}),
          ...(!wokenByAgentMessage && note ? { note } : {})
        }
      };
    }
    if (call.name === 'browser_search') {
      const query = String(call.input?.query || '').trim();
      if (!query) return { ok: false, recoverable: true, recoverySource: 'search_query_invalid', error: 'browser_search requires a non-empty query string.', result: { query: null } };
      const previousSearch = [...(Array.isArray(run.history) ? run.history : [])].reverse().find((entry) => entry.tool === 'browser_search');
      const previousQuery = String(previousSearch?.input?.query || '').trim().toLowerCase();
      if (previousQuery && previousQuery === query.toLowerCase() && previousSearch?.output?.result?.usable === false) {
        return {
          ok: false,
          recoverable: true,
          recoverySource: 'search_no_results',
          error: 'The same search already returned no usable organic results. Change the query, fetch a known reference URL, or inspect the rendered page; do not repeat the same search.',
          result: { query, repeated: true, nextAction: 'change query or use browser_fetch/browser_execute' }
        };
      }
      const searched = await controller.search(targetTabId, { query, maxResults: call.input?.maxResults });
      const results = Array.isArray(searched?.results) ? searched.results : [];
      return {
        ok: true,
        result: {
          ...searched,
          results,
          resultCount: results.length,
          usable: results.length > 0,
          nextAction: results.length > 0
            ? 'Review the result titles and URLs, then browser_fetch the most relevant page or open it in the browser. Search again only with a materially different query.'
            : searched?.captcha
              ? 'Search is blocked by human verification; do not repeat equivalent searches.'
              : 'No usable results. Change the query or use browser_fetch/browser_execute on a known reference instead of repeating this search.'
        }
      };
    }
    if (call.name === 'browser_fetch') {
      const fetched = await controller.fetchPage(call.input);
      if (fetched?.ok === false) return { ok: false, recoverable: true, recoverySource: 'fetch_failed', error: String(fetched.error || 'The fetch failed.'), result: { url: call.input?.url ?? null } };
      return { ok: true, result: fetched };
    }
    if (call.name === 'computer_model') {
      if (typeof run.modelTaskApi !== 'function') return { ok: true, result: { available: false, note: 'No provider connection is available for media generation in this session.' } };
      const kind = String(call.input?.kind || '').trim().toLowerCase();
      const prompt = String(call.input?.prompt || '').trim();
      if (!['image', 'tts', 'stt', 'video'].includes(kind)) {
        return { ok: false, recoverable: true, recoverySource: 'computer_model_kind_invalid', error: 'computer_model requires kind: image, tts, stt, or video.', result: {} };
      }
      if (kind !== 'stt' && !prompt) {
        return { ok: false, recoverable: true, recoverySource: 'computer_model_prompt_invalid', error: 'computer_model requires a full, self-contained prompt for this kind.', result: {} };
      }
      try {
        const outcome = await run.modelTaskApi({
          kind,
          model: call.input?.model,
          prompt,
          voice: call.input?.voice,
          fileBase64: call.input?.fileBase64,
          filename: call.input?.filename,
          // IMAGE EDIT (xkiro /v1/images/edits): imagePath is the sanctioned
          // path — the HARNESS reads and attaches the local file, so no image
          // bytes ever transit the model context (the fileBase64 transit
          // burned ~10 decisions on one run and never completed). fileBase64
          // with kind:'image' still routes to the edits endpoint for
          // bytes the model genuinely already holds.
          ...(kind === 'image' && call.input?.imagePath ? { imagePath: String(call.input.imagePath || '') } : {}),
          saveTo: String(call.input?.saveTo || '') || undefined,
          ...(kind === 'image' && !call.input?.imagePath && call.input?.fileBase64 ? { imageBase64: String(call.input.fileBase64 || ''), imageFilename: String(call.input?.filename || 'source.png'), size: call.input?.size || null } : {}),
        });
        if (outcome?.ok) {
          // Bounded media provenance for chat history persistence: URLs are
          // cheap; a dataUrl is capped so the history file stays sane.
          const dataUrl = typeof outcome.dataUrl === 'string' && outcome.dataUrl.length <= 4_000_000 ? outcome.dataUrl : null;
          const media = { kind: outcome.kind || kind, url: outcome.url || null, ...(dataUrl ? { dataUrl } : {}), model: outcome.model || '' };
          // The MODEL's result stays compact — path/URL only. Megabytes of
          // base64 never ride the context (the UI gets the full dataUrl via
          // `media`; the on-disk copy exists as savedPath).
          const { dataUrl: _withheld, ...compact } = outcome; // eslint-disable-line no-unused-vars
          return { ok: true, result: { ...compact, ...(dataUrl && !outcome.url && !outcome.savedPath ? { dataUrlWithheld: `${dataUrl.length} chars — pass saveTo next time to land it as a file` } : {}), note: `Asset produced by ${outcome.model || 'the connection'}; provenance matters — do not present generated media as a photograph of a real event.` }, media };
        }
        const detail = (outcome?.errors || []).map((e) => `${e.model}: ${String(e.error).slice(0, 140)}`).join(' | ').slice(0, 600);
        return { ok: false, recoverable: true, recoverySource: 'computer_model_provider_failed', error: `Every same-kind model failed — ${detail || 'no attempts were made'}.`, result: { attempts: (outcome?.errors || []).length } };
      } catch (error) {
        return { ok: false, recoverable: true, recoverySource: 'computer_model_failed', error: String(error.message || error).slice(0, 400) };
      }
    }
    if (call.name === 'schedule_task') {
      if (typeof run.scheduleApi !== 'function') return { ok: false, recoverable: false, error: 'Scheduling is not available in this session.' };
      return { ok: true, result: await run.scheduleApi(call.input || {}) };
    }
    if (call.name === 'task_spawn') {
      if (typeof run.spawnTask !== 'function') return { ok: false, recoverable: false, error: 'Background agent runs are not available in this session.' };
      return { ok: true, result: await run.spawnTask(call.input || {}, run) };
    }
    if (call.name === 'model_catalog') {
      // MODEL CATALOG: summary mode (facet counts) without filters, filtered
      // listing with them — the full 43KB blob never rides the wire again.
      if (typeof run.catalogApi !== 'function') return { ok: true, result: { connections: [], note: 'No provider catalog is available in this session.' } };
      return { ok: true, result: await run.catalogApi(call.input || {}) };
    }
    if (call.name === 'android_devices' || call.name === 'android_adb') {
      if (!run.androidApi || typeof run.androidApi.execute !== 'function') return { ok: false, recoverable: false, error: 'Native Android device support is unavailable in this session.' };
      const result = await run.androidApi.execute(call.name, call.input || {});
      if (result?.ok === false) return { ok: false, recoverable: true, recoverySource: 'android_command_failed', error: result.error || `Android ${call.name} failed.`, result };
      return { ok: true, result };
    }
    if (call.name === 'subagent_list') {
      if (typeof run.subagentApi?.list !== 'function') return { ok: true, result: { subagents: [], note: 'Subagent management is unavailable in this session.' } };
      return { ok: true, result: run.subagentApi.list() };
    }
    if (call.name === 'tool_schema') {
      // The full schema for one tool, on request. The model asks for exactly
      // the tool it is unsure about; the answer names every field, its type
      // and what it means, so the next call is right the first time.
      const name = String(call.input?.name || call.input?.tool || '').trim();
      if (!name) {
        return { ok: false, recoverable: true, recoverySource: 'invalid_tool_input', error: 'tool_schema requires the name of the tool. Pass the exact tool name as it appears in the tool list.', result: { allowedFields: ['name'] } };
      }
      const catalog = Array.isArray(run.activeToolCatalog) ? run.activeToolCatalog : [];
      const tool = catalog.find((item) => item?.name === name);
      if (!tool) {
        const available = catalog.map((item) => item.name).filter(Boolean).slice(0, 60);
        return { ok: false, recoverable: true, recoverySource: 'invalid_tool_input', error: `Unknown tool "${name}". Available tools: ${available.join(', ')}.`, result: { allowedFields: available } };
      }
      const schema = fullSchemaFor(catalog, name);
      // Promotion is monotonic: this tool keeps its full schema for the rest
      // of the run, so the model does not have to ask twice.
      if (run.promotedTools instanceof Set) run.promotedTools.add(name);
      return {
        ok: true,
        result: {
          name,
          description: tool.description || '',
          inputSchema: schema || { type: 'object', properties: {} },
          note: 'This is the full schema for this tool. Its arguments are unchanged; call it directly with these fields.'
        }
      };
    }
    if (call.name === 'read_agent_result') {
      const resultId = String(call.input?.resultId || '').trim();
      if (!/^[a-f0-9]{64}$/.test(resultId)) return { ok: false, recoverable: true, recoverySource: 'read_agent_result_invalid', error: 'read_agent_result requires the 64-char resultId from a truncated tool result.', result: {} };
      if (!run.resultStore) return { ok: false, recoverable: false, error: 'No result store is available in this session.', result: {} };
      try {
        const chunk = run.resultStore.read({ resultId, offset: Number(call.input?.offset) || 0, limit: 12_000 });
        return { ok: true, result: chunk };
      } catch (error) {
        return { ok: false, recoverable: false, error: String(error.message || error).slice(0, 300), result: {} };
      }
    }
    if (call.name === 'subagent_close') {
      const alias = String(call.input?.alias || '').trim();
      if (!alias) return { ok: false, recoverable: true, recoverySource: 'subagent_close_invalid', error: 'subagent_close requires the alias of the subagent to close (subagent_list shows the roster).', result: { closed: false } };
      if (typeof run.subagentApi?.close !== 'function') return { ok: true, result: { closed: false, note: 'Subagent management is unavailable in this session.' } };
      return { ok: true, result: await run.subagentApi.close(alias) };
    }
    if (call.name === 'research_task') {
      const objective = String(call.input?.objective || '').trim();
      if (!objective) return { ok: false, recoverable: true, recoverySource: 'research_objective_invalid', error: 'research_task requires a one-sentence objective describing what to research.', result: { started: false } };
      // executeAction is a standalone function â€” the agent instance rides on
      // the run (set once in start()) so the spawn keeps its provider context.
      if (typeof run.researchHost?.spawnResearch !== 'function') return { ok: true, result: { started: false, note: 'Research is unavailable in this session.' } };
      return { ok: true, result: run.researchHost.spawnResearch(run, objective) };
    }
    if (call.name === 'web_search') {
      // The model-chosen live web search (xkiro connections only). The client
      // is the SAME one the research subagent uses as its primary search —
      // one implementation, two consumers.
      const providerConfig = run.researchDefaults?.providerConfig || run.provider;
      if (String(providerConfig?.id || '') !== 'xkiro') return { ok: false, error: 'web_search is available only on xkiro connections.' };
      const query = String(call.input?.query || '').trim();
      if (!query) return { ok: false, recoverable: true, error: 'web_search requires a query.', result: { results: [] } };
      try {
        const { createXkiroSearch } = require('../research/xkiroSearch.cjs');
        const client = createXkiroSearch({ baseUrl: providerConfig.baseUrl, apiKey: providerConfig.apiKey });
        const result = await client.search({ query, maxResults: 8 });
        if (!result.ok) return { ok: false, recoverable: true, error: `web_search failed: ${result.error || 'no results'} — if the fact is still needed, open a tab and browser_search instead.` };
        return { ok: true, result: { query: result.query, resultCount: result.results.length, results: result.results } };
      } catch (error) {
        return { ok: false, recoverable: true, error: `web_search failed: ${String(error?.message || error).slice(0, 200)} — if the fact is still needed, open a tab and browser_search instead.` };
      }
    }
    if (call.name === 'agent_message') {
      const to = String(call.input?.to || 'any').trim() || 'any';
      const text = String(call.input?.message || '').trim();
      if (!text) return { ok: false, recoverable: true, recoverySource: 'agent_message_invalid', error: 'agent_message requires a message body.', result: { sent: false } };
      if (typeof run.messageApi?.send !== 'function') return { ok: true, result: { sent: false, note: 'No message hub is available in this session.' } };
      return { ok: true, result: await run.messageApi.send({ from: run.id, fromLabel: `${run.agentIdentity || 'agent1'} · ${run.title || 'a session'}`, to, text }) };
    }
    if (call.name === 'skill_search') {
      if (typeof run.skillsApi?.search !== 'function') return { ok: true, result: { matches: [], note: 'The skill store is unavailable in this session.' } };
      const domains = String(call.input?.domains || '').split(',').map(item => item.trim()).filter(Boolean);
      const apps = String(call.input?.apps || '').split(',').map(item => item.trim()).filter(Boolean);
      const found = run.skillsApi.search({ task: String(call.input?.task || run.task || ''), domains, apps, limit: 3 });
      // Search returns whole skill records; the model gets digests and loads the
      // full body only through skill_run, as before.
      const matches = typeof run.skillsApi.digest === 'function'
        ? found.map((entry) => ({ ...run.skillsApi.digest(entry.skill || entry), score: entry.score }))
        : found;
      return { ok: true, result: { matches, note: matches.length ? 'Call skill_run with a skillId to receive its full steps before acting.' : 'No learned skill covers this yet; proceed with normal tools.' } };
    }
    if (call.name === 'skill_run') {
      if (typeof run.skillsApi?.run !== 'function') return { ok: false, recoverable: false, error: 'The skill store is unavailable in this session.' };
      const skill = run.skillsApi.run(String(call.input?.skillId || ''));
      if (!skill) return { ok: false, recoverable: true, recoverySource: 'skill_unknown', error: 'No skill with that id exists; call skill_search again.', result: { skillId: call.input?.skillId ?? null } };
      // Track provenance so a successful run can reinforce the skill later.
      if (!Array.isArray(run.usedSkills)) run.usedSkills = [];
      if (!run.usedSkills.includes(skill.id)) run.usedSkills.push(skill.id);
      return { ok: true, result: { skillId: skill.id, name: skill.name, when: skill.when, steps: skill.steps.map(step => step.detail ? `${step.action} â€” ${step.detail}` : step.action), notes: skill.notes, note: 'Execute these steps with the normal browser/computer tools, verifying each observable outcome. These are proven steps, not suggestions to re-derive.' } };
    }
    if (call.name === 'skill_feedback') {
      if (typeof run.skillsApi?.feedback !== 'function') return { ok: true, result: { recorded: false } };
      const updated = run.skillsApi.feedback(String(call.input?.skillId || ''), {
        success: call.input?.success === true,
        note: call.input?.note ? String(call.input.note).slice(0, 300) : null
      });
      return { ok: true, result: { recorded: Boolean(updated), successRate: updated?.usage ? Math.round(100 * updated.usage.successes / Math.max(1, updated.usage.runs)) : null } };
    }
    if (call.name === 'browser_go_back') return { ok: true, result: await controller.goBack(targetTabId) };
    if (call.name === 'browser_gesture') return { ok: true, result: await controller.gesture(targetTabId, call.input) };
    if (call.name === 'browser_set_device_mode') return { ok: true, result: await controller.setDeviceMode(targetTabId, call.input) };
    if (call.name === 'browser_navigate') {
      const navigated = await controller.navigate(targetTabId, call.input.url);
      // PAGE FRESHNESS: this load is the new baseline for the page.
      (run.pageLoads ||= new Map()).set(String(targetTabId), { url: String(call.input?.url || navigated?.url || ''), at: Date.now() });
      return { ok: true, result: navigated };
    }
    return { ok: false, error: `Unsupported action: ${call.name}` };
  } catch (error) {
    // A malformed call is the model's input error, not a lost effect. Classify
    // it so recovery names the cause (INVALID_INPUT) and the result carries the
    // rejected field plus the schema's allowed fields. Without this the model
    // saw only "Invalid computer_read.display_text." and guessed at length and
    // punctuation limits across 17 identical retries.
    if (error?.code === 'INVALID_TOOL_INPUT') {
      // DEFERRED TOOL LOADING: when a tool was served compacted, its argument
      // prose was never shown to the model, so the precise field list above is
      // the first time it sees them. Point it at the schema so it can ask for
      // the full contract instead of guessing again.
      const compacted = isDeferredTool(run.activeToolCatalog, call.name, run.promotedTools);
      return {
        ok: false,
        recoverable: true,
        recoverySource: 'invalid_tool_input',
        error: `${error.message} Fix the arguments and call ${call.name} again; do not retry the same arguments, and use a different tool only if this one cannot do the job.${compacted ? ` Call tool_schema with name="${call.name}" for this tool's full argument list before retrying.` : ''}`,
        result: {
          tool: call.name,
          ...(error.field ? { field: error.field } : {}),
          ...(error.reason ? { reason: error.reason } : {}),
          ...(Array.isArray(error.allowed) ? { allowedFields: error.allowed } : {}),
          ...(compacted ? { schemaHint: `tool_schema name=${call.name}` } : {})
        }
      };
    }
    return { ok: false, error: error.message };
  }
}

function pointerActionOutput(result, action) {
  if (result?.input !== 'interrupted') return { ok: true, result };
  return {
    ok: false,
    recoverable: true,
    recoverySource: 'pointer_interrupted',
    error: `The ${action} was interrupted before it could be completed safely. Observe the current page and retry from fresh visible evidence.`,
    result
  };
}

function requiresApproval(call, run) {
  if (run.settings.approvalMode === 'unattended') return false;
  if (parseHcuToolName(call.name)) return hcuMutation(call.name, call.input);
  if (isComputerTool(call.name)) return !computerReadOnly(call.name, call.input);
  // Spawning an isolated agent run or a recurring schedule delegates real
  // effects to a future unattended run, so Ask mode confirms it up front.
  if (call.name === 'task_spawn') return true;
  if (call.name === 'schedule_task' && call.input?.action === 'create') return true;
  // Clicks and page scripts can submit, delete, navigate, or transmit data. The
  // model cannot reliably classify those effects before execution, so Ask mode
  // treats them as sensitive alongside typing and browser-level key actions.
  if (['browser_type', 'browser_fill', 'browser_key', 'browser_go_back', 'browser_click', 'browser_drag', 'browser_execute', 'write_report_file'].includes(call.name)) return true;
  if (call.name !== 'browser_navigate') return false;
  const latestObservation = run.history.findLast((entry) => entry.tool === 'browser_observe')?.output?.observation?.navigation?.url;
  const current = latestObservation || run.lastObservedUrl;
  try { return !current || new URL(call.input.url).origin !== new URL(current).origin; } catch { return true; }
}

function approvalReason(call, run) {
  if (call.name === 'browser_navigate') return `The agent wants to leave the current website and open ${call.input.url}.`;
  if (call.name === 'browser_go_back') return 'The agent wants to use browser history. This can return to another website, so confirm the destination is safe.';
  if (call.name === 'browser_key') return 'The agent wants to send a key to the page. Keyboard shortcuts can change browser history, so confirm the action is safe.';
  if (call.name === 'browser_type') return 'The agent wants to type into the active page. Confirm the page and text are safe before allowing it.';
  if (call.name === 'browser_fill') return 'The agent wants to replace a value in a page form control. Confirm the page and text are safe before allowing it.';
  if (call.name === 'browser_click') return 'The agent wants to click a page control. This could submit, delete, or navigate, so confirm the target is safe.';
  if (call.name === 'browser_drag') return 'The agent wants to drag across the visible page. Confirm the current page and target region are safe.';
  if (call.name === 'browser_execute') return 'The agent wants to run a bounded page command. This can change page state or transmit data, so confirm it is safe.';
  if (call.name === 'write_report_file') return `The agent wants to save a formatted ${String(call.input?.format || 'report').toUpperCase()} report in your Documents folder.`;
  if (call.name === 'task_spawn') return `The agent wants to start an isolated background agent run for: ${String(call.input?.task || '').slice(0, 160)}.`;
  if (call.name === 'schedule_task' && call.input?.action === 'create') return `The agent wants to create a recurring scheduled task (${String(call.input?.cron || `${call.input?.everySeconds}s interval`)}) for: ${String(call.input?.task || '').slice(0, 160)}.`;
  return `The agent wants to run ${call.name}.`;
}

function shouldFinalizeConclusivePointerMove(calls, assistantText) {
  if (!Array.isArray(calls) || calls.length !== 1 || calls[0]?.name !== 'browser_mousemove') return false;
  const text = String(assistantText || '').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  // A final result must not be inferred from planning language. The provider
  // still gets another decision whenever it signals more work is ahead.
  if (/\b(?:will|shall|need to|needs to|going to|next|then|afterward|later|plan to|intend to)\b/i.test(text)) return false;
  return /^(?:verified|confirmed|completed|finished|done\b|successfully|moved|positioned|the pointer is now|i have\b)/i.test(text);
}

function terminalPointerMoveCompletion(summary) {
  const text = String(summary || '').trim().slice(0, 4_000) || 'Task completed.';
  return {
    name: 'browser_done',
    input: {
      summary: text,
      success: true,
      verified: /\b(?:verified|confirmed|checked|validated)\b/i.test(text)
    },
    expect: null,
    repeat: false
  };
}

function normalizeToolCalls(calls, limit) {
  if (!Array.isArray(calls)) return [];
  return calls.slice(0, limit).map((call) => {
    const input = call?.input && typeof call.input === 'object' && !Array.isArray(call.input) ? { ...call.input } : {};
    const embeddedExpect = input.expect;
    const embeddedRepeat = input.repeat;
    delete input.expect;
    delete input.repeat;
    for (const annotation of ['title', 'description', 'reason', 'label']) delete input[annotation];
    // Provider/tool adapters sometimes attach a presentation label to a call.
    // It is not an execution argument and, if left in place, strict computer
    // schemas reject an otherwise valid read/search after a context switch.
    if (isComputerTool(String(call?.name || ''))) {
      delete input.display_text;
      delete input.displayText;
    }
    const targetIndex = coerceElementIndex(Array.isArray(input.target) && input.target.length === 1 ? input.target[0] : input.target);
    if (coerceElementIndex(input.element ?? input.index) === undefined && targetIndex !== undefined) {
      input.element = targetIndex;
      delete input.target;
    }
    if (String(call?.name || '') === 'browser_drag') {
      input.startX = input.startX ?? input.fromX;
      input.startY = input.startY ?? input.fromY;
      input.endX = input.endX ?? input.toX;
      input.endY = input.endY ?? input.toY;
      delete input.fromX;
      delete input.fromY;
      delete input.toX;
      delete input.toY;
    }
    return {
      name: canonicalActionName(call?.name),
      ...(typeof call?.callId === 'string' ? { callId: call.callId.slice(0, 200) } : {}),
      input,
      expect: normalizeExpectation(call?.expect ?? embeddedExpect),
      repeat: call?.repeat === true || embeddedRepeat === true
    };
  }).map((call) => {
    if (call.name !== 'browser_done') return call;
    // Some gateways deliver boolean tool arguments as strings ("true"). The
    // completion-review gate compares `verified` strictly, so a string value
    // would reject a legitimately verified completion forever.
    const input = { ...call.input };
    for (const key of ['success', 'verified', 'final']) {
      if (typeof input[key] === 'string') input[key] = input[key].trim().toLowerCase() === 'true';
    }
    return { ...call, input };
  }).filter((call) => ACTIONS[call.name] || parseHcuToolName(call.name));
}

function normalizeExpectation(expect) {
  if (typeof expect === 'string') return expect.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
  if (expect && typeof expect === 'object') {
    try { return JSON.stringify(expect).slice(0, 500); } catch { return null; }
  }
  return null;
}

function normalizeSettings(settings) {
  const safeSettings = { ...(settings || {}) };
  delete safeSettings.jevApiKey;
  const layaBrain = ['off', 'laya', 'jev'].includes(safeSettings.layaBrain)
    ? safeSettings.layaBrain
    : (safeSettings.layaEnabled ? 'laya' : 'off');
  return {
    ...DEFAULT_SETTINGS,
    ...safeSettings,
    layaBrain,
    layaEnabled: layaBrain === 'laya',
    maxActionsPerStep: clamp(safeSettings.maxActionsPerStep, 1, 16),
    contextWindowTokens: clamp(settings.contextWindowTokens ?? 131_072, 16_384, 1_048_576),
    stepTimeoutMs: clamp(settings.stepTimeoutMs, 5_000, 180_000),
    decisionWatchdogMs: clamp(Number(settings.decisionWatchdogMs) || 120_000, 50, 600_000),
    vision: ['off', 'auto', 'always'].includes(settings.vision) ? settings.vision : 'auto',
    controlMode: normalizeControlMode(settings.controlMode),
    approvalMode: ['confirm-sensitive', 'unattended'].includes(settings.approvalMode) ? settings.approvalMode : 'confirm-sensitive',
    effort: normalizeEffortSetting(settings.effort)
  };
}

function compactQueryResult(result, input) {
  const elements = Array.isArray(result?.elements) ? result.elements : [];
  return {
    tabId: result?.tabId,
    url: result?.url,
    title: result?.title,
    viewport: result?.viewport,
    query: {
      selector: typeof input?.selector === 'string' ? input.selector : null,
      text: typeof input?.text === 'string' ? input.text : null,
      count: elements.length,
      truncated: Boolean(result?.truncated)
    },
    elements: elements.slice(0, 50).map((element) => ({
      index: element.index,
      tag: element.tag,
      role: element.role,
      name: element.name,
      text: element.text,
      ...(typeof element.href === 'string' && element.href ? { href: element.href } : {}),
      rect: element.rect,
      enabled: element.enabled
    }))
  };
}

function observationFingerprint(value) {
  if (Array.isArray(value)) return JSON.stringify(value.slice(0, 20).map((tab) => [tab.id, tab.title, tab.url, tab.loading]));
  const navigation = value?.navigation || value;
  const dom = value?.dom || value;
  const viewport = dom?.viewport || value?.viewport;
  if (!navigation?.url && !dom?.url) return null;
  const elements = Array.isArray(dom?.elements) ? dom.elements : Array.isArray(value?.elements) ? value.elements : [];
  const signature = elements.slice(0, 20).map((element) => [element.tag, element.name, element.text, element.rect?.x, element.rect?.y].join('|')).join('~');
  return JSON.stringify({
    url: navigation.url || dom.url,
    loading: Boolean(navigation.loading),
    scrollX: viewport?.scrollX || 0,
    scrollY: viewport?.scrollY || 0,
    signature
  });
}

function latestObservationForAction(run, tabId = null) {
  return (tabId ? run?.observationsByTab?.get(String(tabId)) : null) || run?.latestObservation || null;
}

// Per-tab grounding store: bounded to the most recent tabs this run touched,
// so explicit-tabId actions validate against the target tab's own viewport.
const MAX_TAB_OBSERVATIONS = 8;
function storeTabObservation(run, tabId, observation) {
  const key = String(tabId || '');
  const map = run?.observationsByTab;
  if (!key || !map || !observation) return;
  map.delete(key);
  map.set(key, observation);
  while (map.size > MAX_TAB_OBSERVATIONS) map.delete(map.keys().next().value);
}

function resolveVisualTarget(observation, target) {
  const wanted = String(target || '').trim();
  if (!wanted) return null;
  const targets = Array.isArray(observation?.dom?.visualTargets) ? observation.dom.visualTargets : [];
  const matches = targets.filter(item => {
    const identity = [item?.classes, item?.label, item?.role, item?.tag].filter(Boolean).join(' ');
    return identity === wanted || identity.includes(wanted) || String(item?.classes || '').split(/\s+/).includes(wanted);
  });
  return matches.length === 1 && matches[0]?.center ? matches[0] : null;
}

function resolveSnapshotElement(controller, tabId, call) {
  // Coordinate clicks are grounded by the current frame; a stale DOM index
  // accompanying the point must not participate in rematching or hashing.
  if (coordinatorHasCoordinatePair(call?.input)) return null;
  const index = coerceElementIndex(call?.input?.element ?? call?.input?.index);
  if (index === undefined) return null;
  try { return controller.elementSnapshots?.get(tabId)?.elements?.find((element) => element.index === index) || null; } catch { return null; }
}

function normalizeProgressInput(input) {
  return {
    deltaX: Number(input?.deltaX) || 0,
    deltaY: Number(input?.deltaY) || 0,
    ms: Number(input?.ms) || 0,
    selector: typeof input?.selector === 'string' ? input.selector : null,
    text: typeof input?.text === 'string' ? input.text : null
  };
}

// A step timeout is a dead-air detector, not a ceiling on legitimate work:
// the model phase resets the deadline on every streamed delta, so a decision
// that is actively thinking is never killed mid-stream. The absolute cap
// still ends a stream that trickles forever. Overridable for tests.
const STEP_ABSOLUTE_TIMEOUT_FACTOR = 20;
// Recovery exhaustion no longer stops the chat after the first exhaustion:
// Recovery cycles are internal and unbounded; provider/API failures and explicit cancellation are terminal.

function defaultWorkspaceRoot() {
  try {
    return path.resolve(String(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: process.cwd(), encoding: 'utf8', windowsHide: true })).trim());
  } catch { return path.resolve(process.cwd()); }
}

function workspaceFromTask(task) {
  const text = String(task || '');
  // A path the user typed is a workspace candidate when it is absolute and
  // points into a directory tree (drive-letter, UNC or POSIX root). The old
  // filter only ever recognised ONE developer's checkout — every other
  // absolute path in a task seeded nothing at all.
  const looksLikePath = (token) => /^[A-Za-z]:[\\/][^\s]/.test(token) || /^\\\\[^\s]/.test(token) || /^\/[^/\s]+/.test(token);
  const matches = text.split(/\s+/)
    .map(token => token.replace(/^["']|["']$/g, '').replace(/[),.;]+$/, '').trim())
    .filter(looksLikePath);
  if (!matches.length) return null;
  // Prefer a candidate that really exists; a path we cannot see cannot be
  // resolved to a repository root honestly.
  const target = matches.find((candidate) => {
    try { return fs.existsSync(candidate) && fs.statSync(candidate).isDirectory(); } catch { return false; }
  });
  if (!target) return null;
  try {
    // stderr is silenced on purpose: a non-checkout must not print git noise.
    const root = String(execFileSync('git', ['-C', target, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
    if (root) return { root: path.resolve(root), target };
  } catch { /* not a git checkout (or git is unavailable) */ }
  return { root: target, target };
}

function normalizeWorkspace(value) {
  // Preserve legacy AGI callers that intentionally provide synthetic paths in
  // tests or native-app sessions. Scope enforcement becomes active only when
  // the caller supplies an explicit run workspace contract.
  if (!value || typeof value !== 'object') return null;
  const input = value;
  const root = path.resolve(String(input.root || input.workspaceRoot || defaultWorkspaceRoot()).trim());
  const rawTarget = input.target || input.targetPath;
  const target = rawTarget ? path.resolve(String(rawTarget).trim()) : null;
  const rawUrl = input.url || input.targetUrl;
  const url = rawUrl ? String(rawUrl).trim().slice(0, 2_000) : null;
  return { root, ...(target ? { target } : {}), ...(url ? { url } : {}) };
}



function withinStepTimeout(run, label, operation) {
  const timeout = run.settings.stepTimeoutMs;
  const configuredAbsoluteMs = Number(run.settings.stepAbsoluteTimeoutMs);
  const absoluteMs = Number.isFinite(configuredAbsoluteMs) && configuredAbsoluteMs > 0
    ? clamp(configuredAbsoluteMs, timeout, 24 * 60 * 60_000)
    : timeout * (clamp(Number(run.settings.stepAbsoluteTimeoutFactor) || STEP_ABSOLUTE_TIMEOUT_FACTOR, 1, 100));
  // External run deadline (if set) is an additional absolute bound: no single
  // step may outlive the run-level budget. The deadline abort fires via the
  // run signal below and parks the run via parkOnDeadline() in the loop.
  const remainingBudget = remainingRunMs(run);
  const effectiveAbsoluteMs = remainingBudget === null ? absoluteMs : Math.min(absoluteMs, remainingBudget);
  const stepController = new AbortController();
  run.activeStepController = stepController;
  const abortFromRun = () => stepController.abort(run.abortController.signal.reason || new Error('Agent run was cancelled.'));
  if (run.abortController.signal.aborted) abortFromRun();
  else run.abortController.signal.addEventListener('abort', abortFromRun, { once: true });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const startedAt = Date.now();
    const cleanup = () => {
      clearTimeout(timer);
      run.abortController.signal.removeEventListener('abort', abortFromRun);
      if (run.activeStepController === stepController) run.activeStepController = null;
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    // A model that is thinking correctly must never be killed by a timer:
    // before its first streamed token it may legitimately stay silent far
    // longer than the step deadline (reasoning-model time-to-first-token),
    // so the pre-stream window is stepTimeoutMs x 5 (configurable via
    // modelConnectMs). Once streaming starts, every delta resets the normal
    // deadline. The absolute cap still ends a step that never finishes.
    const connectMs = clamp(Number(run.settings.modelConnectMs) || timeout * 5, timeout, 30 * 60_000);
    let sawProgress = false;
    const fire = () => {
      const window = sawProgress ? timeout : connectMs;
      const error = new Error(`Timed out after ${window}ms while ${label}.`);
      error.code = 'agent_step_timeout';
      error.recoverable = true;
      error.stepTimeoutMs = window;
      stepController.abort(error);
      settle(reject, error);
    };
    const armTimer = () => {
      timer = setTimeout(fire, Math.max(0, Math.min(sawProgress ? timeout : connectMs, startedAt + effectiveAbsoluteMs - Date.now())));
    };
    // Stream progress resets the dead-air deadline; the absolute cap still
    // ends a step that never finishes.
    const progress = () => {
      if (settled) return;
      sawProgress = true;
      clearTimeout(timer);
      armTimer();
    };
    armTimer();
    Promise.resolve().then(() => operation(stepController.signal, progress)).then(
      (value) => settle(resolve, value),
      (error) => {
        if (run.abortController.signal.aborted) settle(reject, error);
        else if (stepController.signal.aborted && stepController.signal.reason?.code === 'agent_step_timeout') settle(reject, stepController.signal.reason);
        else settle(reject, error);
      }
    );
  });
}

function waitFor(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Agent wait was cancelled.')); return; }
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      callback(value);
    };
    const abort = () => finish(reject, new Error('Agent wait was cancelled.'));
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function clamp(value, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : min;
}

function viewportPoint(run, xValue, yValue, actionLabel, tabId = null, options = {}) {
  const x = Number(xValue);
  const y = Number(yValue);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${actionLabel} requires finite x and y coordinates.`);
  // Screenshot-frame coordinates are image pixels. Map them into CSS viewport
  // pixels through the capture's scale before bounds validation, so canvas and
  // pixel-reasoned clicks land at any DPR, zoom, or window size.
  if (options.coordinateSpace === 'screenshot') {
    const shot = run?.visualEvidence;
    const scaleX = Number(shot?.scaleX);
    const scaleY = Number(shot?.scaleY);
    if (!shot?.screenshotId || shot.screenshotId !== options.screenshotId) {
      throw new Error(`${actionLabel} screenshot coordinates require the latest screenshotId from browser_screenshot for this run.`);
    }
    if (!(scaleX > 0) || !(scaleY > 0)) {
      throw new Error(`${actionLabel} cannot map screenshot coordinates: the capture did not include a CSS-viewport scale. Use CSS-viewport coordinates instead.`);
    }
    return viewportPoint(run, x * scaleX, y * scaleY, actionLabel, tabId, { coordinateSpace: 'viewport' });
  }
  // Coordinates belong to the TARGET tab: validate against that tab's own
  // observation when one exists, falling back to the run's latest frame.
  const viewport = (tabId ? run?.observationsByTab?.get(String(tabId)) : null)?.dom?.viewport || run?.latestObservation?.dom?.viewport;
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (!(width > 0) || !(height > 0)) throw new Error(`${actionLabel} requires a current viewport observation.`);
  const point = { x: Math.round(x), y: Math.round(y) };
  if (point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) {
    throw new Error(`${actionLabel} coordinates must stay inside the current ${Math.round(width)} by ${Math.round(height)} viewport.`);
  }
  return point;
}

// isCodingTask lives in computer/computerCatalog.cjs — one shared detector
// (keyword regex OR a declared workspace) for tool narrowing, prompt selection
// and the coding test gate.

// LORDE_CRITIC_GATES_V365 — a critique/review run (task says critic/critique/
// review/audit AND forbids edits) has no test to run and no mutation to
// verify: its report IS the deliverable. The coding-task completion gates
// (test-required check, verified-evidence review, stale-acknowledgment bounce
// on repeat reports) misclassified the field critics and stalled them for
// rounds — mary reported "browser_done submissions are being rejected by a
// completion gate that assumes a coding task".
function requiresFileMutation(task) {
  const text = String(task || '').replace(/https?:\/\/\S+/gi, ' ');
  return /\b(?:edit|modify|change|update|add|remove|delete|write|patch|append|insert)\b/i.test(text)
    && /\b(?:file|files|txt|text|html|css|js|json|repo|source|lines?|desktop)\b/i.test(text);
}

function fileMutationSatisfied(run) {
  const since = Number(run?.turnStartedAt || 0);
  return (Array.isArray(run?.history) ? run.history : []).some((entry) => Number(entry?.at || 0) >= since
    && ['computer_patch', 'computer_patch_live', 'computer_patch_chunk', 'computer_write', 'computer_fs', 'computer_fs_batch'].includes(String(entry?.tool || ''))
    && entry?.output?.ok === true
    && (entry.output?.applied === true || entry.output?.changed === true || entry.output?.result?.applied === true || entry.output?.result?.changed === true));
}

function isCritiqueOnlyRun(run) {
  const task = String(run?.task || '');
  return /\b(critic|critique|review|audit)\b/i.test(task)
    && /never edit|do not edit|don't edit|no file edits|no edits|without editing|read-?only/i.test(task);
}

function codingCheckSatisfied(run) {
  // Fixture and artifact links ("file:///.../tests/checkout.html") name work
  // TARGETS, not coding work: the URL scheme's "file" made isCodingTask class
  // every browser task that links a local fixture as a coding task, and the
  // gate then demanded a terminal test result a form-filling run can never
  // produce (four done bounces, clock death). Strip URLs before detection.
  // Quoted spans are the same category: data the task types into a page
  // ("fill Full name "Max Test"") — the \btest\b inside a person's name made
  // the same gate demand a test from a browser checkout flow (run
  // run-2026-10-10-211303: two done bounces with an invented "coding task"
  // requirement, then the run was clock-killed mid-verification). Double
  // quotes only: apostrophe stripping would eat real keywords ("don't break
  // the tests").
  const taskText = String(run?.task || '').replace(/\w+:\/\/\S*/g, ' ').replace(/"[^"]{1,120}"/g, ' ');
  if (!isCodingTask(taskText) || !/\b(?:test|tests|check|lint|build|compile|verify|stress(?:\s|-)?test)\b/i.test(taskText)) return true;
  const entries = Array.isArray(run?.history) ? run.history : [];
  // Terminal evidence: exit code 0 / passing test summary, no nonzero failures.
  const terminalOk = entries.some((entry) => {
    if (entry?.tool !== 'computer_terminal' || entry?.input?.action !== 'execute' || entry?.output?.ok !== true) return false;
    const text = JSON.stringify(entry.output);
    return /(?:exitCode["']?\s*:\s*0|\btests?\s+\d+\b.*\bpass(?:ed)?\b|\bpass(?:ed)?\b.*\btests?\s+\d+\b)/is.test(text)
      && !/\b(?:fail|failed|error)\s*[:=]\s*[1-9]/i.test(text);
  });
  if (terminalOk) return true;
  // Browser evidence: in-page probes (browser_execute) carry completed
  // measurement JSON — a browser-side test can never produce a terminal exit
  // code, and demanding one bounced a real, successful stress test EIGHT
  // times (lordemaximus run), burning minutes on re-probes.
  return entries.some((entry) => {
    if (entry?.tool !== 'browser_execute' || entry?.output?.ok !== true) return false;
    const text = JSON.stringify(entry.output?.result ?? entry.output);
    const completed = /\b(?:ok|passed|success(?:ful)?|healthy|reachable)\b/i.test(text) || /"(?:ok|success)"\s*:\s*true/i.test(text);
    const failed = /"(?:errors?|failed|failures)"\s*:\s*[1-9]/i.test(text);
    return completed && !failed;
  });
}

// E11 (gen3): native file tools the headless CLI computer stub cannot execute
// (every call refused in every headless campaign run). Stripped from the
// advertised catalog when the backend is the stub; the desktop app keeps them.
const HEADLESS_UNAVAILABLE_COMPUTER_TOOLS = new Set([
  'computer_read', 'computer_search', 'computer_index', 'computer_fs',
  'computer_patch', 'computer_patch_live', 'computer_patch_chunk', 'computer_write', 'computer_git'
]);

function toolDefinitions(task = '', controlMode = 'browser', { usedSkills = [], observationDomain = 'browser', agentMessagingAvailable = false, workspace = false, headlessComputer = false, webSearchAvailable = false, hcuTools = [] } = {}) {
  const SKILL_TOOL_DESCRIPTIONS = {
    skill_search: 'Search the learned-skill store for a proven, previously demonstrated procedure matching the current task. Use it before improvising multi-step work the user may have shown before.',
    skill_run: 'Load the full step list of a learned skill (by skillId from skill_search). The steps are proven demonstrations; execute them with the normal tools and verify each observable outcome.',
    skill_feedback: 'Record how a used skill went (success plus an optional correction note) so future matches and steps improve.',
    chat_compact: 'Immediately compact THIS conversation memory: closed turns are summarized into the state snapshot and the oldest groups dropped, freeing context headroom. Use it when you notice earlier instructions or evidence falling out of reach, or before opening a large new phase of work. The objective is always pinned and never compacted away.',
    workspace_retarget: 'Re-points this run\'s DEFAULT search/scope root to a directory the USER named (in the task or a later message) when the objective moves to a new repo or folder mid-conversation — it changes the defaults (search/index roots, terminal cwd auto-injection), never a boundary: file, terminal, and git access anywhere on disk stays allowed. Refused for directories the user never mentioned — ask them to name the path instead.',
    notebook: 'The run\'s PERSISTENT notebook (survives compaction, restart, continuation — the pinned wire block IS this notebook). op=read returns the whole file or one section (section="PROJECT FACTS" etc.); op=update appends a durable line. KEEP IT CURRENT: record the working repo + build/serve pipeline once discovered (PROJECT FACTS: e.g. "build: node build.mjs -> dist/; dev server serves dist/, NOT src/"), every applied patch lands in WRITE TRAIL automatically, and every settled decision in DECISIONS. When you notice a fact you would hate to re-derive, put it here instead of trusting the conversation to remember.',
    create_plan: 'CREATE a new plan from scratch for multi-step work.',
    update_plan: 'Maintain the harness task/goal list; state survives across decisions. For multi-step work, emit this tool with one item per requested outcome and a concise verification criterion. Thinking that lists steps is not a real plan update.',
    ask_user: 'Ask the user a question; the run does NOT end. Cards obey the app theme.',
    schedule_task: 'Create, list, pause, resume, or remove scheduled background runs.',
    task_spawn: 'Start one isolated background agent run (a subagent) with its own tab, FULL tool access, and its OWN EMPTY context window — it never sees your conversation, only the task text you write, so make it complete and self-contained. Real alias (john, mary, ...) tied to YOUR conversation. A worker starts on its own tab but can see EVERY open tab: browser_tabs lists them and any tab-scoped tool accepts a tabId — when your task references an open reference page (a spec, a design, a Google Doc), pass its concrete tabId in the task text so the worker compares against the real thing instead of skipping it. For file work in a git workspace the worker gets its own worktree + branch, so parallel workers never conflict. The pool runs many workers concurrently (default 8, BROWSER_USE_POOL_CAP up to 32); extra spawns queue for a free slot, so size the swarm to the work. COMPLETE-BRIEF RULE: never spawn with unknown critical inputs ("files are somewhere", unspecified paths/URLs) — resolve them first (one lookup) or wait for the user; a subagent started on an incomplete brief forces a follow-up agent_message and wastes its whole head start. SPLIT-DONT-DUMP RULE: never hand the ENTIRE task to one subagent while you wait — partition it (you own a share hands-on, each subagent owns a parallel share). An idle waiting coordinator is a wrong partition. Findings are delivered back into THIS conversation automatically when a subagent finishes; its conversation and tab stay alive afterwards, so assign follow-ups with agent_message to its alias and close it with subagent_close when its work is no longer needed. Do NOT poll subagent_list to check progress. MODEL SELECTION: when the user says which model (or connection) a subagent should run on, pass model (exact id) and optionally connectionId from model_catalog — an unmatched model id fails honestly rather than silently falling back.',
    model_catalog: 'The FULL model catalog of this machine, discovered LIVE from each provider connection, with REAL per-model metadata (usdPerM [input,output] per 1M tokens, ctx, out, caps, tier). TWO MODES: NO filters → compact SUMMARY (per-connection modelsCount, byKind/byCap/byTier tallies, cheapest, largest-context). Any filter → ONLY the matching models with full metadata — filter instead of paging a giant list. CAPABILITY RESOLUTION LADDER for anything beyond the gateway-advertised flags (vision/tools/reasoning): unadvertised capabilities (video input, audio input, JSON mode, streaming) are UNKNOWN, NEVER absent — resolve in order: (1) YOUR OWN KNOWLEDGE of the model — vendor model lines you know accept image usually accept video too; (2) web_search for any model you are unsure about (one query per model id); (3) ONLY if both are insufficient: model_catalog with probe:true plus a NARROW search/kind filter — it live-probes just those models with tiny requests and merges conclusive results. Never answer "0 models" from gateway flags alone; if a probe fails while your knowledge or web sources say the capability exists, the request SHAPE is wrong — the probe tries multiple content shapes and reports which worked; report the conflict instead of declaring the capability unsupported. Answer all catalog questions FROM THIS TOOL, never from memory of rosters (they change weekly). "Strongest/best" rankings: reason from the metadata, verify qualitative standing with web_search for unfamiliar ids, disclose ranking is judgment. Call it BEFORE task_spawn when the user names a model or connection.',
    android_devices: 'Manage REAL Android devices connected to this Windows host: list/refresh state; pair or connect wireless; select; stream via scrcpy; stop stream; remove; toggle programmatic taps. stream-start returns a Browser-use tabId/url: immediately browser_select_tab that tab, then use browser_screenshot/browser_observe/browser_click/browser_drag on the device surface. This is separate from simulated browser_set_device_mode. When a device is selected, use android_adb for app install, logcat, screenshots, shell, input, files, and testing. A known wireless device may report a reconnect advisory when it is reachable but disconnected.',
    android_adb: 'Run any ADB command against the selected/explicit Android device. Prefer args[] (the harness also accepts command as a compatibility string); flags such as -d/-l/--top are valid and are passed as argv, never as a shell. For smooth multi-step mobile testing, pass commands[] (up to 32): the harness executes them in order in one tool call, returns per-command stdout/stderr/exitCode, and supports stopOnError. Fully unattended per user policy; every command is logged. Use this for app launch/install, logcat, dumpsys, screenshots, input, files, and shell commands.',
    subagent_list: 'List your named subagents with alias, current task, and status. Residents keep their own tab and full conversation after finishing, so you can keep assigning them follow-up work with agent_message and reuse everything they learned.',
    subagent_close: 'Close a resident subagent by alias when its work is no longer needed: any active run is cancelled, its tab is released, and it is removed from the roster. Closed subagents cannot receive more tasks or messages.',
    read_agent_result: 'Retrieve the FULL sanitized content of a large tool result that came back as {truncated: true, resultId} instead of inline. Pass resultId (and offset from nextOffset to page through); returns content + nextOffset. Prefer this over re-running the original tool — the archived result is the real evidence.',
    tool_schema: 'Get the full argument list for a tool before calling it.',
    web_search: 'Real-time web search: structured results (title, URL, snippet) — no tab, no scraping. Use it when the task depends on CURRENT knowledge your training may lack: latest versions or releases, prices, news, today-dated facts, current docs/APIs of fast-moving software. Follow up with browser_fetch or a tab only if a full page must be read. Not for operating pages, local files, or facts you already know — do not re-search known ground.',
    write_report_file: 'Write the required long-form report file (.txt or .html).'
  };
  // Every tab-scoped action accepts an explicit target tab. Without this hint
  // in the schema the model cannot discover multi-tab control (it sent empty
  // arguments to browser_select_tab and gave up on switching entirely).
  const TAB_TARGET_HINT = 'optional target tab id from browser_tabs; defaults to this run\'s current tab. Observe a tab first, then act on it by id — any number of tabs can be controlled in parallel.';
  const inputs = {
    browser_observe: { tabId: TAB_TARGET_HINT },
    browser_mousemove: { x: 'current viewport x', y: 'current viewport y', tabId: TAB_TARGET_HINT },
    browser_click: { element: 'optional DOM index; used when x/y are absent; if finite x/y are also supplied, they intentionally take precedence', x: 'CSS-viewport x (default); with coordinateSpace="screenshot", image-pixel x', y: 'CSS-viewport y (default); with coordinateSpace="screenshot", image-pixel y', coordinateSpace: '"viewport" (default) or "screenshot"', screenshotId: 'required when coordinateSpace="screenshot": the latest screenshotId from browser_screenshot', tabId: TAB_TARGET_HINT },
    computer_patch: { path: 'absolute path of the file to patch', patch: 'legacy *** Begin Patch / *** End Patch context patch; PRIMARY tool', acknowledgeExistingChanges: 'optional protected-change acknowledgment', expectedHash: 'current file hash' },
    computer_patch_live: { path: 'absolute path of the file to edit', ops: 'ordered per-line ops after primary patch failures', },
    computer_patch_chunk: { path: 'absolute file to edit', mode: 'overwrite|append|insert', content: 'raw text chunk; no line numbers or anchors — final fallback after cumulative failures' },
    browser_target_click: { target: 'unique visual target identity from the latest visualTargets observation', tabId: TAB_TARGET_HINT },
    browser_target_drag: { from: 'unique visual target identity from the latest visualTargets observation', to: 'unique visual target identity from the latest visualTargets observation', steps: 'optional 1-100', durationMs: 'optional 5-5000', tabId: TAB_TARGET_HINT },
    browser_drag: { startX: 'viewport x', startY: 'viewport y', endX: 'viewport x', endY: 'viewport y', steps: 'optional 1-100', durationMs: 'optional 5-5000', tabId: TAB_TARGET_HINT },
    browser_type: { element: 'optional current DOM index', text: 'text to append via native keyboard input', tabId: TAB_TARGET_HINT },
    browser_fill: { element: 'current DOM index', text: 'replaces the field value; returns matched proof', tabId: TAB_TARGET_HINT },
    browser_scroll: { deltaX: 'horizontal pixels', deltaY: 'vertical pixels', tabId: TAB_TARGET_HINT },
    browser_key: { key: 'key name', tabId: TAB_TARGET_HINT },
    browser_screenshot: { tabId: TAB_TARGET_HINT },
    browser_console_entries: { tabId: TAB_TARGET_HINT },
    browser_network_entries: { tabId: TAB_TARGET_HINT },
    browser_navigation_state: { tabId: TAB_TARGET_HINT },
    browser_query: { selector: 'optional CSS selector', text: 'optional case-insensitive text filter', interactiveOnly: 'optional true to limit to interactive controls', maxElements: 'optional 1-250', tabId: TAB_TARGET_HINT },
    browser_extract: { selector: 'optional CSS selector', text: 'optional case-insensitive text filter', maxElements: 'optional 1-250', tabId: TAB_TARGET_HINT },
    browser_execute: { script: 'bounded page script returning compact proof JSON', tabId: TAB_TARGET_HINT },
    browser_navigate: { url: 'absolute URL', tabId: TAB_TARGET_HINT },
    browser_go_back: { tabId: TAB_TARGET_HINT },
    browser_gesture: { gesture: 'tap, doubleTap, longPress, swipe, scroll, pinch, rotate, or multiFingerSwipe', x: 'contact x for tap/doubleTap/longPress/scroll', y: 'contact y for tap/doubleTap/longPress/scroll', tabId: TAB_TARGET_HINT },
    browser_set_device_mode: { profileId: 'device profile id, or desktop to reset', orientation: 'optional portrait or landscape', tabId: TAB_TARGET_HINT },
    browser_search: { query: 'keywords', maxResults: 'optional 1-20 (default 8); results are organic titles with hrefs', tabId: TAB_TARGET_HINT },
    browser_select_tab: { tabId: 'target tab id from browser_tabs; this run then observes and acts on that tab' },
    browser_focus_tab: { tabId: 'tab id from browser_tabs to bring to the foreground (default: this run\'s tab); refused while another agent owns tabs' },
    browser_new_tab: { url: 'optional absolute URL (default about:blank); opens as a background tab and becomes this run\'s tab' },
    browser_wait: { ms: 'positive ms, up to 900000 (15m); short repeats escalate (15s..10m) — prefer one long wait for a known long job; returns early once navigation settles' },
    browser_fetch: { url: 'absolute URL', maxLength: 'optional body characters (default 20000, cap 100000); scripts/styles stripped' },
    computer_model: { kind: 'image | tts | stt | video — the type of asset the task needs', prompt: 'full, self-contained generation prompt (image/video/tts) — describe subject, style, lighting; no text inside the image; for an image EDIT describe the change to make (upscale, angle, background, …)', model: 'optional exact model id; omit to use the connection default with automatic fallback through same-kind models', voice: 'optional TTS voice id', imagePath: "image kind: absolute path of a LOCAL image file to EDIT — the harness reads and attaches it; NEVER read image bytes into your context (computer_read base64 of an image wastes hundreds of KB and the bytes never survive to the next call)", saveTo: "optional absolute output path — the finished asset is written to this file and returned as savedPath", fileBase64: 'stt: base64 audio payload to transcribe; image kind WITHOUT imagePath = edit the attached bytes (only when you already hold them)', filename: 'stt: audio file name; image edit: the source image file name', size: 'image edit only: optional output size like 1024x1024' },
    workspace_retarget: { path: 'absolute directory path the user named (task or message)' },
    notebook: { op: 'read | update (default read)', section: 'optional section name for read (e.g. PROJECT FACTS) or the target section for update; user-owned sections route to NOTES', text: 'update only: the durable line to append' },
    schedule_task: { action: 'create | preview | list | update | pause | resume | remove', name: 'short task name', prompt: 'complete natural-language instruction the agent should execute when it fires', task: 'legacy alias for prompt', schedule: 'alarm schedule object: once, daily, weekdays, weekly, monthly, interval, or cron', execution: 'agent by default; programmatic only for explicit allowlisted built-ins such as shutdown', clientRequestId: 'idempotency key for a create request', cron: 'legacy 5-field cron in local time', everySeconds: 'legacy interval seconds >= 60', jobId: 'job id from list (update/pause/resume/remove)' },
    task_spawn: { task: 'complete task text for the isolated background agent run', label: 'optional short label', model: 'optional exact model id for the subagent (from model_catalog) — use it whenever the user names a model for the spawned run', connectionId: 'optional connection id (from model_catalog) to run the subagent on a different provider connection than yours' },
    model_catalog: { kind: 'filter: language|image|tts|stt|video', cap: 'filter by capability: gateway-advertised flags (vision/tools/reasoning) or unadvertised ones like video-input — unadvertised caps are UNKNOWN until resolved, not absent', tier: 'filter: free|paid|premium', search: 'filter: substring of model id or display name — NARROW before probing', minContext: 'filter: minimum context tokens', maxInputUsd: 'filter: max input USD per 1M tokens', connectionId: 'filter: one connection id', limit: 'max models returned in filtered mode (default 50, cap 200)', probe: 'true ONLY as the LAST rung of the ladder (below): live-probes the models your OTHER filters selected with tiny requests (max_tokens 1) to settle an unadvertised capability' },
    android_devices: { action: 'list | refresh | pair | connect | disconnect | remove | select | programmatic-input | stream-start | stream-stop', serial: 'device serial/address from the list', address: 'wireless address host:port', pairingCode: 'Android wireless debugging pairing code', label: 'friendly device label', enabled: 'programmatic input toggle', maxFps: 'stream fps 5..60', maxSize: 'stream max width', bitrate: 'stream bitrate' },
    android_adb: { serial: 'target device serial; omit to use selected device', args: 'ADB argv array (or compatibility command string); example ["shell","input","tap","400","600"] or ["logcat","-d"]', commands: 'optional ordered batch of up to 32 command objects, each with args and optional serial/timeoutMs', stopOnError: 'batch only: boolean; stop after first failed command', timeoutMs: 'command timeout' },
    subagent_list: {},
    subagent_close: { alias: 'alias of the subagent to close (from subagent_list)' },
    read_agent_result: { resultId: 'the 64-char resultId from a truncated tool result', offset: 'optional character offset; pass nextOffset from the previous chunk to continue' },
    tool_schema: { name: 'tool name' },
    agent_message: { to: 'agent1/agent2/agent3 or live run id; any = rotate live targets', message: 'concrete coordination request: resource/fact needed, blocker, and question' },
    web_search: { query: 'the search query (keep it specific; one topic per call)' },
    research_task: { objective: 'what to research, in one sentence' },
    skill_search: { task: 'what the user asked for, in one sentence', domains: 'optional comma-separated current domains', apps: 'optional comma-separated current app names' },
    skill_run: { skillId: 'skill id from skill_search' },
    skill_feedback: { skillId: 'skill id from skill_search', success: 'true when the skill steps led to the outcome', note: 'optional correction or caveat for next time' },
    write_report_file: { filename: 'descriptive name ending in .txt or .html', format: 'txt for text-led or html for polished visual reports', content: 'complete formatted report with at least 1000 characters; TXT may use ASCII tables, HTML must be static with no scripts' },
    chat_compact: { reason: 'optional one-line reason, shown to the user' },
    update_plan: controlMode === 'agi'
      ? { goals: 'optional goal array {id,text,status}; omit = unchanged, [] clears', goalOperations: 'goal edits (same shape as operations)', steps: 'replacement array; strings or {id,text,status,verification}', operations: "edits: {op:'add'|'update'|'remove'|'clear', text?, id?, status?, verification?, index?|beforeId?|afterId?}" }
      : { steps: 'replacement array; strings or {id,text,status,verification}', operations: "edits: {op:'add'|'update'|'remove'|'clear', text?, id?, status?, verification?, index?|beforeId?|afterId?}" },
    create_plan: controlMode === 'agi'
      ? { goals: 'goals', steps: 'strings or {id,text,status,verification}', operations: 'edits {op,...}' }
      : { steps: 'strings or {id,text,status,verification}', operations: 'edits {op,...}' },
    ask_user: { question: 'question', options: 'options', context: 'context', html: 'HTML card body: tables, SVG, icons; no scripts', css: 'CSS for the card; use theme variables' },
    browser_done: { summary: 'string', success: 'boolean', verified: 'true only after completion review reconciles the whole goal', final: 'true only for a verified external block' }
  };
  const schedulingIntent = /\b(?:schedule|scheduled|recurring|cron|every (?:day|week|month|hour|morning|night)|remind me)\b/i.test(String(task || ''));
  const delegationIntent = /\b(?:spawn|delegate|background agent|parallel agent|subagent|separate agent)\b/i.test(String(task || ''));
  const deferred = new Set([
    ...(!schedulingIntent ? ['schedule_task'] : []),
    ...(!(Array.isArray(usedSkills) && usedSkills.length) ? ['skill_feedback'] : []),
    ...(!agentMessagingAvailable ? ['agent_message'] : []),
    // The xkiro live web-search tool: offered when the connection serves it —
    // a MODEL-CHOSEN capability, never a forced request parameter.
    ...(!webSearchAvailable ? ['web_search'] : [])
  ]);
  const BROWSER_TOOL_DESCRIPTIONS = {
    browser_observe: 'Fresh page evidence for one tab: URL, title, viewport, enabled controls with indices, regions. This is a DOM capture (structured text) — NEVER call it a screenshot; a screenshot exists only when browser_screenshot returned real pixels.',
    browser_tabs: 'List open tabs with ids, titles, and which one is currently active.',
    browser_new_tab: 'Open an isolated background tab without changing existing tabs; it becomes this run\'s tab.',
    browser_select_tab: 'Switch this run to another open tab by id; the next decision observes that tab. Never changes which tab the human sees.',
    browser_focus_tab: 'Bring a tab to the foreground as the visible active tab (the human-facing switch). Refused while another agent owns tabs; background control by tabId stays available either way.',
    browser_mousemove: 'Move the pointer to viewport x/y; this is a standalone action and does not establish a required later click target.',
    browser_click: 'Click at CSS-viewport x/y, or by optional DOM index. Coordinate x/y are authoritative when both coordinate and index fields are present; index-only clicks resolve the current element center. For coordinates read from a browser_screenshot image (canvas boards, pixel targets), pass coordinateSpace="screenshot" and the capture\'s screenshotId so image pixels are mapped to viewport pixels at the current DPR/zoom/window size. Every click result includes a post-click hit test; on a miss, re-derive from a fresh screenshot instead of repeating the same coordinates. If the click opens a native OS dialog (file open/save, print), browser tools cannot see it — switch to computer_observe + computer_pointer to resolve it (AGI mode).',
    browser_target_click: 'Click a unique visual target from the latest observation.',
    browser_drag: 'Drag from start x/y to end x/y.',
    browser_target_drag: 'Drag one visual target to another.',
    browser_type: 'Append typed text via native keyboard input. For a stable multi-field form, emit all independent browser_fill/browser_type calls in ONE response action array; do not wait/rethink between fields. Stop the array before submit/navigation or if a field result is unexpected.',
    browser_fill: 'Replace a field value; returns matched proof. For a stable multi-field form, emit all independent fills in ONE response action array; the harness executes them in order without a provider round trip between fields. Stop before submit/navigation. If a native OS dialog opens (file picker, save as), browser tools cannot see it — resolve it with computer_observe + computer_pointer (AGI mode).',
    browser_scroll: 'Scroll the page by pixel deltas.',
    browser_key: 'Send a key press.',
    browser_screenshot: 'Capture a PNG of the target tab. The result includes width/height (image pixels), cssViewport, scaleX/scaleY, devicePixelRatio, and screenshotId; use that screenshotId with coordinateSpace="screenshot" on browser_click/browser_drag when you read coordinates from the image.',
    browser_console_entries: 'Read page console entries. DIAGNOSTICS ONLY — debugging a failure you can already see, or OCR-class text the DOM does not carry. Never evidence of what the page shows or its load state (dom + screenshot are that evidence).',
    browser_network_entries: 'Read network failures. DIAGNOSTICS ONLY — request traffic never proves page state; successful requests are not evidence at all.',
    browser_navigation_state: 'Read URL, loading, back/forward.',
    browser_query: 'Query elements by selector or text.',
    browser_extract: 'Extract bounded page content.',
    browser_execute: 'Run bounded page JavaScript in the target tab (defaults to this run\'s tab; pass tabId for another); no native windows, terminal, or files. On strict canvases use browser coordinates first, then computer_* input if the surface rejects it.',
    browser_wait: 'Wait; returns early once navigation settles.',
    browser_go_back: 'Go back in tab history.',
    browser_gesture: 'Native touch gesture (tap/swipe/pinch) under a mobile/tablet profile.',
    browser_set_device_mode: 'Emulate mobile/tablet (viewport, DPR, touch) to verify responsive layouts; reset with desktop.',
    browser_navigate: 'Navigate the target tab to an absolute URL.',
    browser_search: 'Web search in the current tab; returns titles with hrefs.',
    browser_fetch: 'Fetch an http(s) URL as bounded stripped text without a tab.',
    computer_model: 'Generate a non-language asset through the user\'s configured AI providers: kind image (a picture), tts (spoken audio), stt (a transcript from fileBase64), or video. Use it by itself when a task needs an asset — a website hero image, narration audio, a transcript — instead of claiming the asset exists. Image kind can also EDIT an existing local picture: pass imagePath (the harness reads and attaches the file — never pull image bytes through your own context) and optionally saveTo to land the result as a real file (returned as savedPath). Falls back across same-kind models automatically; the result returns the asset URL/data URL with the model that produced it.',
    browser_done: 'Before calling this, CHECK BY INSTINCT: re-read your plan/goals list and the original user request — every plan item must be done or explicitly skipped, and every sub-request in the original ask must be addressed in your summary. If ANY item or sub-request remains, do not call done: do the next piece of work first. Subagents you spawned count too — their findings must be received and acted on (or their pending work explicitly handed off) before finishing. Then answer only after reconciling every part of the objective with evidence. Finishing one part of a larger goal is not done: continue with the next part, or report the concrete blocker. Never finish while your own summary still lists remaining work.',
    agent_message: 'Coordination tool, only when the task cannot progress without a concrete handoff, shared-resource decision, or fact from another live agent. Never a default step, status chat, or delegation. Include the exact task, resource, question - other chats do not know your context. Delivery needs the target running, actively waiting, or a resident subagent of yours: an idle resident starts the message as its new assignment on its SAME conversation and reports findings back. When another agent asks you a direct question or requests your findings, REPLYING with agent_message addressed to it is required — that is a requested report, not status chat. Never assume or claim a reply unless it appears in agentMessages.',
    research_task: 'OPTIONAL silent research: a bounded subagent searches the web and reads up to three pages, delivering one brief later. Call it when the task needs real-time or unfamiliar knowledge — latest versions, pricing, news, current docs, unfamiliar software specifics (hotkeys, URI schemes, flags, app internals); for a single current fact prefer web_search (faster, inline). Never wait for it; keep working. ONE brief per run: a second call while one is pending is refused and that objective is NOT researched, so do not plan multiple topics around it — research the single most important topic, and treat any topic whose brief was refused as NOT researched.'
  };
  return Object.entries(ACTIONS)
    .filter(([name]) => name !== 'computer_file' && !isComputerTool(name) && !deferred.has(name) && (name !== 'write_report_file' || isLongReportRequest(task)))
    .map(([name, metadata]) => ({ name, ...((SKILL_TOOL_DESCRIPTIONS[name] || BROWSER_TOOL_DESCRIPTIONS[name]) ? { description: SKILL_TOOL_DESCRIPTIONS[name] || BROWSER_TOOL_DESCRIPTIONS[name] } : {}), input: inputs[name] || {} }))
    .concat(controlMode === 'agi'
      ? (isCodingTask(task, workspace)
        ? COMPUTER_TOOLS.filter(tool => ['computer_terminal', 'computer_index', 'computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_fs_batch', 'computer_patch', 'computer_patch_live', 'computer_patch_chunk', 'computer_git', 'computer_keyboard', 'computer_screenshot', 'computer_clipboard', 'computer_model', 'computer_observe', 'computer_window', 'computer_record'].includes(tool.name))
        : COMPUTER_TOOLS
      ).filter(tool => !(headlessComputer && HEADLESS_UNAVAILABLE_COMPUTER_TOOLS.has(tool.name)))
        .map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }))
      : [])
    .concat(controlMode === 'agi' && Array.isArray(hcuTools) ? hcuTools : []);
}

function archiveToolResult(run, output) {
  const archive = run?.resultStore && typeof run.resultStore.write === 'function'
    ? (value) => run.resultStore.write(value)
    : null;
  try {
    const bounded = boundedResult(output, archive);
    const parsed = JSON.parse(bounded);
    // The provider-facing envelope is intentionally explicit. A model seeing
    // this must retrieve the omitted bytes, never replay the original command.
    if (parsed?.truncated === true && parsed.resultId && !parsed.nextAction) {
      parsed.nextAction = 'Call read_agent_result with this resultId and offset/nextOffset before re-running the original tool.';
    }
    return parsed;
  } catch (error) {
    // Never turn result archival into a tool failure; preserve a compact,
    // honest error envelope. The original action result has already been
    // recorded by the caller for diagnostics.
    return { ok: output?.ok === true, truncated: true, notice: `Tool result could not be archived: ${String(error?.message || error).slice(0, 180)}. The omitted result is not available; do not blindly retry.` };
  }
}

function inspectionValue(tool, value) {
  // Archived tool results already contain a retrieval pointer. Never replace
  // that pointer with another preview: the UI and model must both know how to
  // retrieve the omitted bytes.
  const archived = value?.result ?? value;
  if (archived?.truncated === true && archived.resultId) return archived;
  // The dedicated file tools render as compact, human-readable diagnostics —
  // never a truncated raw-JSON blob (the old search result flooded the
  // transcript with escaped absolute paths).
  if (tool === 'computer_search' || tool === 'computer_read' || tool === 'computer_fs' || tool === 'computer_index') {
    const result = value?.result ?? value ?? {};
    const shorten = (file) => String(file || '').split(/[\\/]/).slice(-3).join('/');
    if (tool === 'computer_index' && typeof result.map === 'string') {
      const mapLines = result.map.split('\n').filter(Boolean);
      return {
        files: result.files, included: result.included, truncated: result.truncated, elapsedMs: result.elapsedMs,
        ...(result.note ? { note: result.note } : {}),
        ...(result.repeat ? { repeat: result.repeat } : {}),
        map: mapLines.slice(0, 60).map((line) => line.slice(0, 200)).join('\n'),
        ...(mapLines.length > 60 ? { notice: `showing 60 of ${mapLines.length} map lines` } : {})
      };
    }
    if (tool === 'computer_search') {
      if (Array.isArray(result.files)) {
        const files = result.files.map((f) => (typeof f === 'string' ? { file: f } : f));
        return {
          engine: result.engine, outputMode: 'files', totalFiles: result.totalFiles, truncated: result.truncated,
          ...(result.notice ? { notice: result.notice } : {}),
          matches: files.slice(0, 40).map((f) => `${f.matches ?? '?'}× ${shorten(f.file)}`)
        };
      }
      if (Array.isArray(result.lines)) {
        return {
          engine: result.engine, outputMode: 'content', matches: result.matches, truncated: result.truncated,
          ...(result.notice ? { notice: result.notice } : {}),
          lines: result.lines.slice(0, 80).map((l) => `${l.match ? '>' : ' '} ${shorten(l.file)}:${l.line}: ${String(l.text || '').slice(0, 140)}`),
          ...(result.lines.length > 80 ? { notice: `showing 80 of ${result.lines.length} lines` } : {})
        };
      }
    }
    if (tool === 'computer_read' && typeof result.content === 'string') {
      return {
        path: result.path, lines: `${result.fromLine}-${result.toLine} of ${result.totalLines}`,
        truncated: result.truncated, ...(result.nextOffset ? { nextOffset: result.nextOffset } : {}),
        preview: result.content.split('\n').slice(0, 40).join('\n')
      };
    }
    if (tool === 'computer_fs' && Array.isArray(result.files) && result.action === 'find') {
      return { action: 'find', matches: result.matches, truncated: result.truncated, files: result.files.slice(0, 40).map((f) => f.relative || f.file) };
    }
  }
  if (tool === 'browser_fill') return { ...value, text: `[${String(value?.text || '').length} characters masked]` };
  if (['browser_screenshot', 'computer_screenshot'].includes(tool)) return { notice: 'Screenshot image data is excluded from diagnostics.' };
  if (tool === 'write_report_file') {
    const saved = value?.result || value;
    if (saved?.path) return { path: saved.path, filename: saved.filename, format: saved.format, characters: saved.characters };
    return { filename: value?.filename, format: value?.format, content: `[${String(value?.content || '').length} report characters]` };
  }
  if (tool === 'browser_type') return { ...value, text: `[${String(value?.text || '').length} characters â€” masked]` };
  // computer_patch AND diff-bearing computer_write mutations: the renderer
  // draws an IDE-style diff from the structured chunks — cap the line count
  // instead of letting the truncator elide them. The executors wrap results
  // as { ok, result: { ... } }, so unwrap before matching (the transcript
  // must never fall back to raw JSON).
  if (tool === 'computer_patch' || tool === 'computer_write' || tool === 'computer_git') {
    const patchResult = value?.files ? value : value?.result;
    if (tool !== 'computer_git' && Array.isArray(patchResult?.files)) {
      const MAX_DIFF_LINES = 400;
      let budget = MAX_DIFF_LINES;
      const files = patchResult.files.map((file) => {
        const diff = Array.isArray(file?.diff) ? file.diff.map((chunk) => {
          if (budget <= 0) return { ...chunk, lines: [], truncated: true };
          const lines = chunk.lines.slice(0, budget);
          budget -= lines.length;
          return lines.length < chunk.lines.length ? { ...chunk, lines, truncated: true } : chunk;
        }) : [];
        return { ...file, diff };
      });
      return { ...patchResult, files, ...(budget <= 0 ? { notice: `Diff view truncated at ${MAX_DIFF_LINES} lines; the full file is on disk.` } : {}) };
    }
    // computer_git: plain text output — keep it whole under the cap instead
    // of JSON-stringifying the envelope.
    if (tool === 'computer_git' && typeof patchResult?.output === 'string') {
      return { ...patchResult, output: patchResult.output.slice(0, 12_000), ...(patchResult.output.length > 12_000 ? { notice: 'Git output truncated at 12,000 characters; use limit/paths to narrow it.' } : {}) };
    }
  }
  try {
    const serialized = JSON.stringify(value ?? null);
    return serialized.length <= 12_000 ? value : { notice: 'Diagnostic output was truncated.', preview: serialized.slice(0, 12_000) };
  } catch { return { notice: 'Diagnostic value could not be serialized.' }; }
}

function screenshotPreviewValue(tool, output) {
  if (!['browser_screenshot', 'computer_screenshot'].includes(tool) || output?.ok !== true) return null;
  const data = String(output?.result?.data || '');
  const mimeType = String(output?.result?.mimeType || '').toLowerCase();
  if (!data || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return null;
  // A normal full-window PNG is far below this ceiling. Refuse an anomalous
  // payload instead of sending unbounded bytes through renderer IPC.
  if (data.length > 32_000_000) return null;
  return {
    data,
    mimeType,
    tabId: String(output?.result?.tabId || ''),
    source: String(output?.result?.source || '').slice(0, 40)
  };
}

function redactArgs(tool, args) {
  if (tool === 'write_report_file') return { ...args, content: `[${String(args?.content || '').length} report characters]` };
  if (tool === 'computer_write') return { ...args, ...(args?.content !== undefined ? { content: `[${String(args.content).length} characters]` } : {}) };
  if (!['browser_type', 'browser_fill', 'computer_keyboard'].includes(tool)) return args;
  return { ...args, text: `[${String(args.text || '').length} characters]` };
}

function redactOutput(tool, output, input = null) {
  let redacted = output;
  // The pixels are not in this JSON, but the field must not read as an empty
  // capture: a screenshot result with no data makes the model fall back to the
  // DOM instead of looking at the frame that is already waiting in its next
  // request as vision.
  if (['browser_screenshot', 'computer_screenshot'].includes(tool) && output?.result?.data) redacted = { ...output, result: { ...output.result, data: '[image pixels are attached to your NEXT request as vision — look at them there, not here]' } };
  if ((tool === 'browser_type' || tool === 'browser_fill') && redacted?.error) redacted = { ...redacted, error: redactTypedText(redacted.error, input?.text) };
  return redacted;
}

function redactRecoveryError(error, call) {
  const message = String(error?.message || error || 'An action could not be completed.').replace(/\s+/g, ' ').trim();
  // A 1,200-character cut took the TAIL off the completion-review demand,
  // which quotes the user's request verbatim — the instructions that close the
  // request are the ones that fell off, so the model was asked to account for
  // instructions it could not see. Keep the head and the tail instead, and
  // mark the cut so the model re-reads the full task.
  const bound = (text) => (text.length <= 6_000 ? text : `${text.slice(0, 4_000)} [...] ${text.slice(-1_800)}`);
  return ['browser_type', 'browser_fill'].includes(call?.name) ? bound(redactTypedText(message, call.input?.text)) : bound(message);
}

function redactTypedText(value, typedValue) {
  const text = String(value || '');
  const typed = String(typedValue || '');
  if (!typed) return text;
  return text.split(typed).join(`[${typed.length} characters]`);
}

function serializeEventRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    agentIdentity: run.agentIdentity || 'agent1',
    tabId: run.tabId,
    task: run.task,
    title: run.title,
    status: run.status,
    step: run.step,
    failures: run.failures,
    pendingApproval: run.pendingApproval,
    result: run.result,
    plan: run.plan,
    goals: run.goals,
    attemptId: run.attemptId,
    attemptSequence: run.attemptSequence,
    recovery: run.recovery,
    workspace: run.workspace,
    recoveryFingerprint: run.recoveryFingerprint || '',
    recoveryFingerprintCount: Number(run.recoveryFingerprintCount || 0),
    actionlessStall: normalizeActionlessStall(run.actionlessStall),
    telemetryDetailed: run.telemetryDetailed !== false,
    usage: run.turnLedger?.turnUsage || run.turnLedger?.usage || run.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0 },
    usageLifetime: run.turnLedger?.usage || null,
    coordinator: {
      observationRevision: run.coordinator?.observationRevision || 0,
      duplicateBlocks: run.coordinator?.duplicateBlocks || 0,
      metrics: run.coordinator?.metrics
    }
  };
}

function serializeRun(run) {
  if (!run) return null;
  // Keep runtime-only callbacks out of IPC, persisted conversations, and every
  // live agent event. Electron structured-clones these payloads and rejects a
  // function before the renderer can receive the run id needed for Stop/New
  // chat/History controls.
  const { publishEvent, abortController, approval, providerInstance, createTab, closeTab, selectTab, focusTab, writeReportFile, modelTaskApi, catalogApi, androidApi, scheduleApi, spawnTask, skillsApi, messageApi, latestObservation, observationsByTab, thinkingArchive, heartbeatTimer, escalationTimer, visualEvidence, attachments, activeThoughtAccumulator, activeStepController, recoveryResumePromise, getComputerTools, getControlMode, attemptStartedClock, pendingComputerDesktop, computerObservationDirty, computerScreenshotStep, turnLedger, resultStore, research, researchHost, researchDefaults, layaVerifier, researchHint, pendingAgentMessages, subagentApi, eagerResults, notebook, deadlineTimer, deadlineFinishNoticeArmed, ...serializable } = run;
  const attachmentMetadata = Array.isArray(attachments) ? attachments.map(({ name, kind, mimeType, size }) => ({ name, kind, mimeType, size })) : [];
  // GEN9: the notebook instance is excluded (functions cannot cross IPC) but
  // notebookPath travels so a continuation re-opens the SAME file, and the
  // compact index summarizes what is currently pinned.
  // Native-surface awareness ledger travels as a plain ARRAY: a Set survives
  // Electron's structured clone but JSON.stringify(new Set(...)) is `{}`, which
  // silently dropped the "already announced" window ids from every persisted
  // conversation and made the next continuation swallow still-open dialogs.
  const nativeSurfaceSeen = run.nativeSurfaceSeen instanceof Set
    ? [...run.nativeSurfaceSeen]
    : Array.isArray(run.nativeSurfaceSeen) ? [...run.nativeSurfaceSeen] : [];
  return { ...serializable,
    // `usage` is what the footer and cost counter render, so it must be the
    // PER-TURN ledger. `serializable.usage` is run.usage, which is assigned the
    // ledger-LIFETIME counters; terminal events (run.completed) serialize through
    // here, so the footer showed conversation-cumulative tokens, requests and
    // cost. The lifetime totals stay available as usageLifetime.
    usage: turnLedger?.turnUsage || serializable.usage,
    usageLifetime: turnLedger?.usage || null,
    providerLedger: turnLedger?.snapshot(), attachments: attachmentMetadata, history: [...run.history],
    nativeSurfaceSeen,
    notebookPath: String(run.notebookPath || notebook?.filePath || '') || null,
    notebookIndex: notebook ? (notebookIndexText(notebook.read?.() || '', notebook.filePath) || null) : null };
}

// The checkpoint (chat history persistence) carries the bounded thinking
// archive even though live per-event serialization omits it.
function checkpointSnapshot(run) {
  return { ...serializeRun(run), thinkingArchive: normalizeThinkingArchive(run?.thinkingArchive) };
}

module.exports = { DesktopChatAgent, isMultipartTask, isMultiAskTask, multiAskChecklist, ACTIONS, externalProviderBlock, MAX_BROWSER_WAIT_MS, EFFORT_TIERS, normalizeEffortSetting, normalizeEffortTier, nextEffortTier, applyEffortEscalation, defaultResearchAgent, inspectionValue, archiveToolResult, toolDefinitions, codingCheckSatisfied,
  // OWNER DIRECTIVE (2026-10-15) turn-addition semantics: the classifier and
  // the pure framing notices are unit-tested directly
  // (tests/turn-addition-semantics.test.mjs).
  isTaskAddition, turnBoundaryNotice, steeringAdditionNotice, steeringReplacementNotice,
  // Provider normalization is exported for contract tests: transport metadata
  // must not become an execution argument after a provider/context switch.
  normalizeToolCalls,
  // Answer-only classification: scoped to current-turn tool history so a
  // follow-up question after prior browser work still completes directly.
  isAnswerOnlyTask, isAnswerOnlyRequest, isAnalysisOnlyRequest, claimsCompletion, turnHasMutations,
  // Run budget/deadline helpers for focused tests.
  remainingRunMs,
  // GEN9: executeAction is exported for the notebook-tool unit tests
  // (tests/gen9-notebook.test.mjs) — the dispatch is otherwise internal.
  executeAction,
  // Attachment normalization is unit-tested directly (tests/attachment-path.test.mjs):
  // path-kind acceptance, missing-path refusal, budget exemption.
  normalizeAttachments,
  // Objective-ledger lifecycle helpers (unit-tested in tests/objective-ledger.test.mjs).
  advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective, settleObjectiveLedgerOnTerminal, activeObjectiveEntry };
