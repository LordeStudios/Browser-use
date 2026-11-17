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
// The flow/evidence guard family has ONE owner: harness/flowGuard.cjs. The
// helpers below are imported from there so this module keeps a single
// definition of each rule (it used to hold a private copy that nothing
// called).
const {
  normalizeStallText,
  genuineEvidenceCall,
  evidenceCallsAllSucceeded,
  readOnlyEnforcementDemand,
  READ_ONLY_ENFORCE_STREAK,
  EVIDENCE_STREAK_TOOLS,
  actionlessStallKey,
  normalizeActionlessStall,
  resetActionlessStall,
  noteActionlessStall
} = require('./harness/flowGuard.cjs');

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
function recordVisualCapture(run, source, screenshot = null) {
  if (!run) return;
  if (!Array.isArray(run.visualLedger)) run.visualLedger = [];
  run.visualLedger.push({
    at: Date.now(),
    source: String(source || 'unknown').slice(0, 24),
    revision: Number(run.coordinator?.observationRevision) || 0,
    historyLength: Array.isArray(run.history) ? run.history.length : 0,
    // The capture's frame identity and image/CSS scale: a model click citing
    // this id maps through THIS scale even after a later auto-capture
    // replaced run.visualEvidence (the staleness trap that bounced the
    // model's own screenshot id on the live chess run).
    ...(screenshot?.screenshotId ? { screenshotId: String(screenshot.screenshotId) } : {}),
    ...(Number(screenshot?.scaleX) > 0 ? { scaleX: Number(screenshot.scaleX) } : {}),
    ...(Number(screenshot?.scaleY) > 0 ? { scaleY: Number(screenshot.scaleY) } : {})
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
  maxActionsPerStep: 48,
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
  // File dialogs: the agent answers Open/Save itself instead of driving the OS
  // dialog. Reading state is safe; attaching files or writing to disk is not.
  browser_file_dialog_arm: { risk: 'browser-control' },
  browser_file_dialog_state: { risk: 'read' },
  browser_file_dialog_accept: { risk: 'filesystem-write' },
  browser_file_dialog_cancel: { risk: 'browser-control' },
  browser_downloads_set_path: { risk: 'filesystem-write' },
  browser_downloads_list: { risk: 'read' },
  browser_save_file: { risk: 'filesystem-write' },
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
  // A small model asked for "only the title" still sometimes answers
  // `**Title:** "Compare Pricing"`. That text is printed in the header and in
  // a history tab, so the wrapper is stripped rather than shown. Decoration
  // and the label prefix can wrap each other (`**Title:**`), hence the passes.
  let title = String(value || '').replace(/\s+/g, ' ').trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = title;
    title = title
      .replace(/^["'“”‘’*`\s]+/, '')
      .replace(/["'“”‘’*`\s]+$/, '')
      .replace(/^(?:conversation\s+title|chat\s+title|title)\s*[:\-–—]\s*/i, '')
      .trim();
    if (title === before) break;
  }
  title = title.replace(/[.!?]+$/, '').trim().slice(0, 80);
  return title || String(fallback || 'Browser task').slice(0, 80);
}

// LORDE_AI_CHAT_TITLES_V1 — the conversation name is the AI's job, not the
// first message frozen forever. After every real user turn (and at completion)
// one tiny completion proposes a name from the recent context; the name keeps
// evolving with the chat, silently. Failures are cosmetic and swallowed.
const TITLE_GENERATE_MIN_INTERVAL_MS = 30000;

async function maybeGenerateConversationTitle(agent, run, { force = false, inRun = false } = {}) {
  if (!agent?.titleApi || !run || !Array.isArray(run.messages)) return;
  const userMessages = run.messages.filter((message) => message.role === 'user'
    && message.source !== 'runtime' && String(message.content || '').trim());
  if (!userMessages.length) return;
  const now = Date.now();
  if (run.titleInFlight) return;
  if (!force && now - Number(run.titleGeneratedAt || 0) < TITLE_GENERATE_MIN_INTERVAL_MS) return;
  const latestUserText = String(userMessages.at(-1).content || '').trim();
  // `titleSource` answers "has a NEW user turn arrived since the last name?".
  // A mid-run refresh has no new turn by definition — its trigger is new
  // evidence — so the throttle alone paces it.
  if (!force && !inRun && run.titleSource === latestUserText) return; // nothing new to name
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
  let summary = String(run?.result?.summary || run?.result?.error || '').trim();
  // A terminal failure with no summary used to end SILENTLY. That is the exact
  // confusion that makes a user re-send the same message several times: the
  // spinner stops and nothing says why. Never leave a failed run without a
  // sentence — an honest "it stopped" beats an empty transcript.
  if (!summary && run?.status === 'failed') {
    summary = 'The run stopped before returning a result, so nothing is confirmed. The work so far is preserved — send a message to retry from here.';
  }
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

// READ-ONLY ENFORCEMENT (run.txt req #2 "application controls execution"): a
// fix/diagnosis task that keeps returning read-only decisions is re-narrating
// its analysis instead of executing. The evidence-phase notices are advisory
// only, so a model that varies its query wording each turn sails past them
// forever. Once the streak clears this cap on a coding/diagnosis task, further
// read-only calls in a decision with no mutation are REJECTED before execution
// and the model is told, in the rejection, to patch or terminate. This is a
// hard floor, not another advisory: the only way forward is a mutation,
// terminal, or an explicit plan change — never another read.
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
    // The native-dialog DEMAND travels with the conversation: a dialog is
    // only looked for after the agent asked for one, and a continuation that
    // is still resolving the file picker it opened must keep that demand.
    nativeDialogExpectedUntil: Number.isFinite(Number(snapshot.nativeDialogExpectedUntil)) ? Number(snapshot.nativeDialogExpectedUntil) : 0,
    nativeDialogExpectedReason: String(snapshot.nativeDialogExpectedReason || ''),
    nativeDialogDetected: Boolean(snapshot.nativeDialogDetected),
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

// Rapid surfaces cannot afford the normal deliberation ceiling: an explicit
// "act now" request, a timer/ticking surface, or a real-time/live page should
// emit the first grounded action within seconds — the next observation can
// supply the detail. This is a routing hint read from TIME-PRESSURE LANGUAGE
// ONLY. It must never key off the task's TOPIC: the harness stays
// task-agnostic (owner directive 2026-11-11 — no game/chess vocabulary; a
// topic keyword is not an urgency signal).
function isRapidTask(task) {
  return /\b(?:rapid|quick(?:ly)?|as fast as possible|asap|immediately|right (?:now|away)|no delay|real[- ]time|live|timer|ticking|urgent)\b/i.test(String(task || ''));
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

// Debugger pinning follows the run's tab binding: pin the new tab, unpin the
// old one. Pinning removes the attach -> command -> detach churn from every
// CDP command (four cycles per click before this) — the latency and the
// attach-race failures behind the hit-test's bare errors. Best effort: a
// missing pinDebugger (mock controllers) just keeps the churn behavior.
function rebindDebuggerPin(controller, run, nextTabId) {
  try {
    if (typeof controller?.pinDebugger !== 'function') return;
    const next = String(nextTabId || '');
    if (!next) return;
    for (const pinned of run.pinnedDebuggerTabs || []) {
      if (String(pinned) !== next) {
        try { controller.unpinDebugger(pinned, run.id); } catch { /* best effort */ }
      }
    }
    controller.pinDebugger(next, run.id);
    run.pinnedDebuggerTabs = [next];
  } catch { /* pinning is a latency optimization; never fail the action */ }
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
      const tabId = String(call.input.tabId || '').trim();
      if (!tabId || typeof run.selectTab !== 'function') throw new Error('browser_select_tab requires a valid tabId from browser_tabs.');
      // The host owns tab existence; the roster only makes the FAILURE
      // actionable. Pre-rejecting on a list that might be a partial view would
      // refuse valid ids, which is worse than a slightly later error.
      let roster = [];
      try { roster = controller.listTabs?.() || []; } catch { roster = []; }
      const rosterLine = () => (roster.length
        ? roster.map((tab) => `${tab.id}${tab.active ? ' (visible)' : ''}`).join(', ')
        : 'none');
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
        // IMMEDIATE FEEDBACK. The old reply was a bare host message with no tab
        // map, so a wrong id looked identical to a slow switch and the run
        // stalled until a human stopped it. Say what exists and what the run
        // is still bound to.
        return {
          ok: false,
          recoverable: true,
          recoverySource: 'tab_selection',
          tabId,
          error: `The tab switch FAILED, so the run still targets ${run.tabId || 'no tab'}: ${String(error?.message || error)} Open tabs right now: ${rosterLine()}. Use one of those ids, or call browser_new_tab first — do not re-send ${tabId}.`,
          result: { tabId, selectedTabId: run.tabId || null, tabs: compactTabRoster(controller, run.tabId) }
        };
      }
      if (!selected?.id) return { ok: false, recoverable: true, recoverySource: 'tab_selection', error: 'browser_select_tab returned no selected tab identity. Re-list tabs and retry once.', tabId };
      // VERIFY THE SWITCH. The host can resolve with a DIFFERENT tab (or the
      // same one) when the requested id was handled loosely; reporting success
      // regardless is how a run ended up acting on the wrong page while every
      // reply looked fine. A mismatch is a recoverable failure with the roster.
      if (String(selected.id) !== tabId) {
        return {
          ok: false,
          recoverable: true,
          recoverySource: 'tab_selection',
          tabId,
          error: `The tab switch did not take: ${tabId} was requested but ${selected.id} came back as the bound tab. Nothing was assumed — open tabs are ${rosterLine()}; select again from that list.`,
          result: { requestedTabId: tabId, selectedTabId: String(selected.id), tabs: compactTabRoster(controller, selected.id) }
        };
      }
      run.tabId = selected.id;
      rebindDebuggerPin(controller, run, selected.id);
      run.skipNavigationSettleOnce = true;
      run.latestObservation = null;
      run.loopState = { recentActions: [], unchangedPages: 0, lastFingerprint: null, noProgressActions: 0, consecutiveWaits: 0, lastWaitedMs: 0 };
      // Immediate, explicit feedback about what actually changed: the run's
      // target is NOT the same thing as the tab the human is looking at.
      const visibleTabId = roster.find((tab) => tab.active)?.id || null;
      const isVisible = selected.active === true || (visibleTabId && String(visibleTabId) === tabId);
      return {
        ok: true,
        result: {
          ...selected,
          selectedTabId: String(selected.id),
          boundTabId: String(selected.id),
          activeTabId: visibleTabId,
          switched: Boolean(isVisible),
          tabs: compactTabRoster(controller, selected.id),
          note: isVisible
            ? 'Tab binding changed immediately: this tab is now the run target AND the visible tab. The next decision receives a fresh observation for it.'
            : `Tab binding changed immediately: this tab is now the run target. The VISIBLE tab did not change (still ${visibleTabId || 'none'}), which is expected — use browser_focus_tab if you need it brought to the front. Do not re-select.`
        }
      };
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
      // THIN REPLY GATE (one bounce per run). The persona tells the model to
      // "mention only NEW evidence and the next action" — right during work,
      // wrong at the end, where it produced bare "Done"/"Finished"/"Replied"
      // summaries. A user who receives one assumes the agent did not
      // understand and re-sends the task. Bounce ONCE with the actual request
      // quoted; if the model still returns a token, accept it rather than
      // loop.
      const requested = String(call.input?.summary || '').replace(/\s+/g, ' ').trim();
      if (call.input.success !== false && !run.thinReplyBounced && isThinTerminalReply(requested)) {
        run.thinReplyBounced = true;
        return {
          ok: false,
          recoverable: true,
          error: `Your summary "${requested.slice(0, 80)}" is a status token, not an answer. The user asked: "${quoteRequest(run.task, 300)}". Reply to THEM in one or two sentences: what you did or found, and anything they must know or decide. Do not answer "Done", "Finished" or "Completed".`
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
    if (call.name === 'browser_file_dialog_arm') {
      return { ok: true, ...(await controller.fileDialogArm(targetTabId)) };
    }
    if (call.name === 'browser_file_dialog_state') {
      const stateTab = call.input?.tabId !== undefined ? String(call.input.tabId) : targetTabId;
      return { ok: true, ...(await controller.fileDialogState(stateTab)) };
    }
    if (call.name === 'browser_file_dialog_accept') {
      return { ok: true, ...(await controller.fileDialogAccept(targetTabId, {
        files: call.input?.files,
        selector: call.input?.selector
      })) };
    }
    if (call.name === 'browser_file_dialog_cancel') {
      return { ok: true, ...(await controller.fileDialogCancel(targetTabId)) };
    }
    if (call.name === 'browser_downloads_set_path') {
      return { ok: true, ...(await controller.downloadsSetPath(targetTabId, { directory: call.input?.directory })) };
    }
    if (call.name === 'browser_downloads_list') {
      return { ok: true, ...(await controller.downloadsList()) };
    }
    if (call.name === 'browser_save_file') {
      return { ok: true, ...(await controller.saveFileToDisk(call.input || {})) };
    }
    if (call.name === 'browser_observe') {
      const observation = await observe(controller, targetTabId, run.settings.vision);
      run.lastObservedUrl = observation.navigation.url;
      storeTabObservation(run, targetTabId, observation);
      // WHERE AM I / WHAT EXISTS. The observation is the one payload the model
      // sees on every decision, so the tab map belongs here: a run that never
      // called browser_tabs still knows its bound tab and every open one, and
      // cannot invent an id or guess which page "tab" it is clicking.
      observation.navigation = {
        ...observation.navigation,
        boundTabId: String(targetTabId),
        activeTabId: (() => { try { return controller.listTabs?.()?.find((tab) => tab.active)?.id || null; } catch { return null; } })(),
        tabs: compactTabRoster(controller, targetTabId)
      };
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
      // ELEMENT-FIRST. A DOM element's rect is EXACT — the browser itself lays
      // it out and the hit test reads the same box. Model coordinates are a
      // guess derived from pixels. The old rule ("coordinates are
      // authoritative when present") was right only when the index was stale;
      // the index is re-resolved against the CURRENT snapshot at click time,
      // so it cannot be stale. The live click-order run clicked element 40
      // (Reset at 790,500) with a guessed (825,648) and hit <main> — a DOM
      // target missed by the model's arithmetic, which must never happen.
      // When the index resolves, it wins; coordinates are the fallback.
      const requestedIndex = coerceElementIndex(call.input.element !== undefined ? call.input.element : call.input.index);
      if (requestedIndex !== undefined) {
        let urlBefore = '';
        try { urlBefore = String(controller.navigationState?.(targetTabId)?.url || ''); } catch { urlBefore = ''; }
        try {
          const clicked = pointerActionOutput(await controller.clickElement(targetTabId, { index: requestedIndex }, run.id), 'indexed click');
          return clickDeliveryOutcome(clicked, { controller, tabId: targetTabId, urlBefore });
        } catch (elementError) {
          // Fail-closed element resolution falls back to an explicit point when
          // the model supplied one; otherwise the element error is the answer.
          if (!coordinatorHasCoordinatePair(call.input)) throw elementError;
        }
      }
      if (coordinatorHasCoordinatePair(call.input)) {
        // An element value beside valid coordinates is metadata, never a
        // veto: models say "no element" as ""/-1/null-like values, and the
        // old rejection bounced the click and forced a recovery cycle — the
        // live chess run (recovery log 2026-11-11 18:11) shows five bounced
        // clicks in a row on the same valid coordinate pair while the model
        // knew the move. Drop the uncoercible value and click the point the
        // model actually aimed at.
        const point = viewportPoint(run, call.input.x, call.input.y, 'browser_click', targetTabId, {
          coordinateSpace: call.input.coordinateSpace,
          screenshotId: call.input.screenshotId
        });
        let urlBefore = '';
        try { urlBefore = String(controller.navigationState?.(targetTabId)?.url || ''); } catch { urlBefore = ''; }
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
        // A page that hovered but never received the press is a failure.
        return clickDeliveryOutcome(result, { controller, tabId: targetTabId, urlBefore });
      }
      throw new Error('browser_click requires either an element index or {x, y} coordinates.');
    }
    if (call.name === 'browser_drag') {
      // ELEMENT-FIRST DRAG: two DOM targets resolve to exact centers — the
      // browser lays them out, so the drag has 0 offset regardless of the
      // model's pixel arithmetic (the drag-relay run never even attempted a
      // drag because only coordinates were available). Coordinates remain the
      // fallback when an index cannot be resolved.
      const fromIndex = coerceElementIndex(call.input.fromElement !== undefined ? call.input.fromElement : call.input.from);
      const toIndex = coerceElementIndex(call.input.toElement !== undefined ? call.input.toElement : call.input.to);
      if (fromIndex !== undefined && toIndex !== undefined) {
        const fromEl = resolveSnapshotElement(controller, targetTabId, { input: { element: fromIndex } });
        const toEl = resolveSnapshotElement(controller, targetTabId, { input: { element: toIndex } });
        if (fromEl?.center && toEl?.center) {
          return pointerActionOutput(await controller.drag(targetTabId, {
            startX: Math.round(fromEl.center.x),
            startY: Math.round(fromEl.center.y),
            endX: Math.round(toEl.center.x),
            endY: Math.round(toEl.center.y),
            steps: clamp(call.input.steps ?? 24, 1, 100),
            durationMs: clamp(call.input.durationMs ?? 450, 5, 5_000)
          }, run.id), 'element drag');
        }
      }
      const frame = { coordinateSpace: call.input.coordinateSpace, screenshotId: call.input.screenshotId };
      const start = viewportPoint(run, call.input.startX, call.input.startY, 'browser_drag start', targetTabId, frame);
      const end = viewportPoint(run, call.input.endX, call.input.endY, 'browser_drag end', targetTabId, frame);
      return pointerActionOutput(await controller.drag(targetTabId, {
          startX: start.x,
          startY: start.y,
          endX: end.x,
          endY: end.y,
          steps: clamp(call.input.steps ?? 24, 1, 100),
          durationMs: clamp(call.input.durationMs ?? 450, 5, 5_000)
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

// A COMPACT TAB ROSTER, attached to every tab-scoped reply. The model kept
// acting on a tab map it had invented: it asked for ids that were never open
// and clicked page "tabs" by guessed index because nothing in the reply told it
// which tabs exist or which one it was actually bound to. Two fields cost
// almost nothing and remove the guesswork entirely.
function compactTabRoster(controller, boundTabId = '') {
  try {
    return (controller.listTabs?.() || []).map((tab) => ({
      id: String(tab.id),
      title: String(tab.title || '').slice(0, 60),
      active: tab.active === true,
      ...(String(tab.id) === String(boundTabId) ? { bound: true } : {})
    }));
  } catch {
    return [];
  }
}

// A CLICK THAT ONLY HOVERED IS A FAILURE. The cursor animation runs before the
// input, so the page can paint hover styling while the press is swallowed; the
// old reply said ok:true, and the model sat waiting for an effect that would
// never arrive. `delivered === false` is the probe's explicit verdict that no
// press reached the page — the one signal that must never be reported as
// success. `delivered: null` means "the probe was not armed", which proves
// nothing and stays a success.
function clickDeliveryOutcome(output, { controller, tabId, urlBefore = '' } = {}) {
  const delivered = output?.result?.delivered;
  if (delivered !== false) return output;
  // A click that NAVIGATED cannot leave a click record on the old document.
  // Reading that as "swallowed" would fail every link click on the web.
  let urlAfter = '';
  try { urlAfter = String(controller.navigationState?.(tabId)?.url || ''); } catch { urlAfter = ''; }
  if (urlAfter && urlBefore && urlAfter !== urlBefore) return output;
  const result = output.result || {};
  const x = Math.round(Number(result.x ?? result.element?.center?.x ?? 0));
  const y = Math.round(Number(result.y ?? result.element?.center?.y ?? 0));
  return {
    ok: false,
    recoverable: true,
    recoverySource: 'click_not_delivered',
    error: `The pointer reached (${x}, ${y}) and the page showed hover styling, but no click reached it — the press was swallowed, so the click did NOT happen. Take a fresh browser_observe and click the element again (or browser_target_click on its visible label); do not wait for a result that will never arrive.`,
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

// A STATUS TOKEN IS NOT AN ANSWER.
//
// Observed terminal summaries: "Done", "Finished", "Completed", "Replied",
// "Acknowledged user's greeting. No specific task requested." Each one leaves
// the user with nothing to read, so they conclude the agent ignored the
// request and send the message again. The prompt states the contract; this is
// the mechanical backstop for models that ignore it.
const THIN_REPLY_TOKEN = /^(?:(?:all\s+)?(?:done|finished|complete|completed|replied|replied\s+to\s+(?:the\s+)?user|ok|okay|sure|noted|acknowledged|understood|working\s+on\s+it|task\s+(?:completed|done|finished))[\s.!]*)$/i;
const THIN_REPLY_META = /^(?:acknowledged|noted|understood)\b[\s\S]{0,80}\bno\s+(?:specific\s+)?(?:task|request|action|instruction)s?\b/i;

function isThinTerminalReply(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value) return true;
  if (THIN_REPLY_TOKEN.test(value)) return true;
  if (THIN_REPLY_META.test(value)) return true;
  // "Done." / "Finished!" with a trailing filename is still a token.
  if (value.length <= 18 && /^(?:done|finished|completed|replied)\b/i.test(value)) return true;
  return false;
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
    maxActionsPerStep: clamp(safeSettings.maxActionsPerStep, 1, 64),
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
      if (run.activeStepRetire === retire) run.activeStepRetire = null;
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    // Retire hook (): lets parkRun converge an abandoned step whose
    // provider call never settles (a hung model or a hung mock). Without it
    // the step's dead-air timer keeps the event loop alive for the whole
    // connect window after the run has already parked.
    const retire = (error) => settle(reject, error instanceof Error ? error : new Error(String(error || 'Step retired.')));
    run.activeStepRetire = retire;
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
  // The screenshotId ALONE selects this frame: models mislabel image pixels as
  // "viewport" (lichess 2026-11-11: DPR 1.25 turned y=579 image px into a CSS
  // click below a board whose bottom edge was y=557), so a present
  // screenshotId is the authoritative declaration — and a stale or unmatched
  // one is rejected instead of being silently read 1:1.
  const screenshotId = options.screenshotId === undefined || options.screenshotId === null || String(options.screenshotId) === ''
    ? null : String(options.screenshotId);
  if (options.coordinateSpace === 'screenshot' || screenshotId) {
    // The cited id maps against ANY capture this run still holds: the model's
    // own browser_screenshot id stays valid after later auto-captures replaced
    // run.visualEvidence — rejecting it looped the run (six bounced clicks,
    // live recovery log 2026-11-11 18:11). Only an id no retained capture
    // knows is stale.
    const shot = run?.visualEvidence;
    let capture = shot?.screenshotId && shot.screenshotId === screenshotId ? shot : null;
    if (!capture && screenshotId && Array.isArray(run?.visualLedger)) {
      const retained = run.visualLedger.find(entry => entry?.screenshotId === screenshotId && Number(entry?.scaleX) > 0 && Number(entry?.scaleY) > 0);
      if (retained) capture = { screenshotId, scaleX: retained.scaleX, scaleY: retained.scaleY };
    }
    if (!capture) {
      throw new Error(`${actionLabel} screenshot coordinates require the latest screenshotId from browser_screenshot for this run.`);
    }
    const scaleX = Number(capture.scaleX);
    const scaleY = Number(capture.scaleY);
    if (!(scaleX > 0) || !(scaleY > 0)) {
      throw new Error(`${actionLabel} cannot map screenshot coordinates: the capture did not include a CSS-viewport scale. Use CSS-viewport coordinates instead.`);
    }
    // The capture's scale is image/CSS (physical px per CSS px, e.g. 1.25 at
    // DPR 1.25), so image pixels map to CSS by DIVIDING. The previous
    // multiplication produced the CSS→image direction and pushed every
    // screenshot-space click further off target instead of onto it.
    return viewportPoint(run, x / scaleX, y / scaleY, actionLabel, tabId, { coordinateSpace: 'viewport' });
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
  'computer_patch', 'computer_patch_live', 'computer_patch_chunk', 'computer_write', 'computer_git',
  // A headless run IS the process: restarting the app would kill the caller
  // mid-decision, so the tool is not offered there.
  'computer_resume'
]);

function toolDefinitions(task = '', controlMode = 'browser', { usedSkills = [], observationDomain = 'browser', agentMessagingAvailable = false, workspace = false, headlessComputer = false, webSearchAvailable = false, hcuTools = [] } = {}) {
  const SKILL_TOOL_DESCRIPTIONS = {
    skill_search: 'Search the learned-skill store for a proven, previously demonstrated procedure matching the current task. Use it before improvising multi-step work the user may have shown before.',
    skill_run: 'Load the full step list of a learned skill (by skillId from skill_search). The steps are proven demonstrations; execute them with the normal tools and verify each observable outcome.',
    skill_feedback: 'Record how a used skill went (success plus an optional correction note) so future matches and steps improve.',
    chat_compact: 'Immediately compact THIS conversation memory: closed turns are summarized into the state snapshot and the oldest groups dropped, freeing context headroom. Use it when you notice earlier instructions or evidence falling out of reach, or before opening a large new phase of work. The objective is always pinned and never compacted away.',
    workspace_retarget: 'Re-points this run\'s DEFAULT search/scope root to a directory the USER named (in the task or a later message) when the objective moves to a new repo or folder mid-conversation — it changes the defaults (search/index roots, terminal cwd auto-injection), never a boundary: file, terminal, and git access anywhere on disk stays allowed. Refused for directories the user never mentioned — ask them to name the path instead.',
    notebook: 'The run\'s PERSISTENT notebook (survives compaction and continuation; the pinned wire block IS this file). op=read returns the file or one section; op=update appends a durable line. Keep it current: record the build/serve pipeline once discovered and any fact you would hate to re-derive. Write-trail and settled decisions are recorded automatically.',
    create_plan: 'CREATE a new plan from scratch for multi-step work.',
    update_plan: 'Maintain the harness task/goal list; state survives across decisions. Follow the stated requirements; do not invent extra ones. For multi-part work, emit this tool with ONE item per requested outcome, each with a concise verification criterion, then act on the first part immediately; thinking that lists steps is not a plan update. When one part finishes, continue with the next and never narrow the goal to the part you finished.',
    ask_user: 'Ask the user a question; the run does NOT end. Cards obey the app theme.',
    schedule_task: 'Create, list, pause, resume, or remove scheduled background runs.',
    task_spawn: 'Start one isolated background agent run (a subagent) with its own tab, full tool access and its OWN EMPTY context window — it never sees your conversation, only the task text, so make it complete and self-contained. The pool runs many workers concurrently; extra spawns queue. Rules: never spawn with unknown critical inputs (resolve them first or ask); never hand the ENTIRE task to one subagent while you wait — partition it and keep a hands-on share; findings return automatically when a worker finishes, then follow up with agent_message and close it with subagent_close. Pass model (exact id) to choose a worker\'s model; an unmatched id fails honestly.',
    model_catalog: 'The FULL model catalog of this machine, discovered LIVE per provider connection with real metadata (usdPerM [input,output], ctx, out, caps, tier). No filters → compact summary; any filter → only matching models with full metadata (filter, don\'t page). Capability ladder for flags the gateway does not advertise (video/audio input, JSON mode): your own knowledge of the model line → web_search (one query per id) → model_catalog with probe:true plus a narrow filter, which live-probes and reports which content shapes worked. Answer catalog questions FROM THIS TOOL, never from memory of rosters; if a probe fails while your knowledge or web sources say the capability exists, the request SHAPE was wrong — report the conflict instead of declaring it unsupported. Call it BEFORE task_spawn when the user names a model or connection.',
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
    browser_click: { element: 'DOM index — PREFERRED and exact: the browser lays the element out, so a resolved index wins over guessed coordinates; x/y are the fallback', x: 'CSS-viewport x (default); image-pixel x when screenshotId is passed', y: 'CSS-viewport y (default); image-pixel y when screenshotId is passed', coordinateSpace: '"viewport" (default) or "screenshot"', screenshotId: 'the latest screenshotId from browser_screenshot; passing it maps x/y from that image\'s pixels to viewport pixels at the captured DPR/zoom', tabId: TAB_TARGET_HINT },
    computer_patch: { path: 'absolute path of the file to patch', patch: 'legacy *** Begin Patch / *** End Patch context patch; PRIMARY tool', acknowledgeExistingChanges: 'optional protected-change acknowledgment', expectedHash: 'current file hash' },
    computer_patch_live: { path: 'absolute path of the file to edit', ops: 'ordered per-line ops after primary patch failures', },
    computer_patch_chunk: { path: 'absolute file to edit', mode: 'overwrite|append|insert', content: 'raw text chunk; no line numbers or anchors — final fallback after cumulative failures' },
    browser_target_click: { target: 'identity of a visualTargets entry (its label, a class, or tag+class) — must match EXACTLY ONE entry; use it for objects the element list does not index', tabId: TAB_TARGET_HINT },
    browser_target_drag: { from: 'identity of a visualTargets entry (label, class, or tag+class) — must match exactly ONE entry', to: 'identity of the destination visualTargets entry — must match exactly ONE entry', steps: 'optional 1-100', durationMs: 'optional 5-5000', tabId: TAB_TARGET_HINT },
    browser_drag: { fromElement: 'DOM index of the source element — PREFERRED when the element list indexes it', toElement: 'DOM index of the destination element — PREFERRED when indexed', startX: 'CSS-viewport x of the source point — for visual objects use their visualTargets center.x directly (same coordinate space)', startY: 'CSS-viewport y of the source point', endX: 'CSS-viewport x of the destination point', endY: 'CSS-viewport y of the destination point', steps: 'optional 1-100', durationMs: 'optional 5-5000', screenshotId: 'optional: the latest browser_screenshot screenshotId when coordinates were read from the image', tabId: TAB_TARGET_HINT },
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
    browser_file_dialog_arm: { tabId: TAB_TARGET_HINT },
    browser_file_dialog_state: { tabId: TAB_TARGET_HINT },
    browser_file_dialog_accept: { files: 'absolute paths to attach — one path unless the picker reported multiple: true', selector: 'optional CSS selector when the page uses a custom file control', tabId: TAB_TARGET_HINT },
    browser_file_dialog_cancel: { tabId: TAB_TARGET_HINT },
    browser_downloads_set_path: { directory: 'absolute directory that should receive downloads', tabId: TAB_TARGET_HINT },
    browser_downloads_list: {},
    browser_save_file: { path: 'absolute destination file path', text: 'UTF-8 text content', base64: 'base64 content for binary files' },
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
    browser_click: 'Click a DOM element by index (PREFERRED: the browser lays it out, so a resolved index is exact and beats any guessed pixel), or click a point with CSS-viewport x/y. When both are present the index wins; coordinates are the fallback for objects the element list does not index (use a visualTargets center directly). For coordinates read from a browser_screenshot image (canvas boards, pixel targets), pass coordinateSpace="screenshot" and the capture\'s screenshotId so image pixels are mapped to viewport pixels at the current DPR/zoom/window size. Every click result includes a post-click hit test; on a miss, re-derive from a fresh screenshot instead of repeating the same coordinates. Co-emit the whole KNOWN-input click chain in ONE decision — accept terms, then the policy link, then submit; or a canvas piece-move as click-source then click-destination (or browser_drag) — never one click per decision with thinking between, which loses board/selection state and replans the same step. If the click opens a native OS dialog (file open/save, print), browser tools cannot see it — switch to computer_observe + computer_pointer to resolve it (AGI mode).',
    browser_target_click: 'Click a unique visual target from the latest observation.',
    browser_drag: 'Drag in the page. PREFERRED: fromElement/toElement (DOM indices from the element list) — the drag runs between their exact centers, no pixel math. Fallback: startX/startY to endX/endY in CSS-viewport pixels (a visualTargets center works directly). Use it for sliders, kanban cards, canvas pieces, reordering — anything click cannot express.',
    browser_target_drag: 'Drag one visual target to another.',
    browser_type: 'Append typed text via native keyboard input. For a stable multi-field form, emit all independent browser_fill/browser_type calls in ONE response action array; do not wait/rethink between fields. Stop the array before submit/navigation or if a field result is unexpected.',
    browser_fill: 'Replace a field value; returns matched proof. For a stable multi-field form, emit all independent fills in ONE response action array; the harness executes them in order without a provider round trip between fields. Stop before submit/navigation. If a native OS dialog opens (file picker, save as), browser tools cannot see it — resolve it with computer_observe + computer_pointer (AGI mode).',
    browser_scroll: 'Scroll the page by pixel deltas.',
    browser_key: 'Press a key in the bound tab (named keys like Enter, Tab, Escape, ArrowDown, or a single character). Use it for keyboard-driven UIs, dialogs and shortcuts; for typing into a field use browser_type or browser_fill instead.',
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
    browser_file_dialog_arm: 'Arm native file-dialog interception on the target tab. Call it once before an action that may open an Open/Save dialog (a file input, an upload button, a download link) so the OS dialog never appears and the harness owns the answer.',
    browser_file_dialog_state: 'Report whether a native file chooser is waiting on the tab (mode, multiple, backendNodeId) plus recent downloads and the download directory. Poll it after any action that may have opened a picker: when pending is non-null the dialog is open and waiting for browser_file_dialog_accept.',
    browser_file_dialog_accept: 'Attach absolute file paths to the page file input with no OS dialog. Works even when no chooser is pending: it then targets input[type=file] directly (pass selector for a custom control), so a picker that opened before arming is still answerable.',
    browser_file_dialog_cancel: 'Dismiss the waiting Open dialog the way a person pressing Cancel would.',
    browser_downloads_set_path: 'Route every download (Save As) on the tab to a directory so no Save dialog is shown. Creates the directory when missing.',
    browser_downloads_list: 'List downloads tracked for the tab with state, bytes, and the destination path — use it to confirm a save completed instead of guessing.',
    browser_save_file: 'Write content straight to an absolute path with no dialog: pass text or base64. Use it when the task is "save this output as a file" rather than downloading it from the page.',
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
        ? COMPUTER_TOOLS.filter(tool => ['computer_terminal', 'computer_index', 'computer_read', 'computer_write', 'computer_search', 'computer_fs', 'computer_fs_batch', 'computer_patch', 'computer_patch_live', 'computer_patch_chunk', 'computer_git', 'computer_keyboard', 'computer_screenshot', 'computer_clipboard', 'computer_model', 'computer_observe', 'computer_window', 'computer_record', 'computer_resume'].includes(tool.name))
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
  const { publishEvent, abortController, approval, providerInstance, inbox, repeatGuard, messageWakeController, noticeFingerprints, advisoryFingerprints, createTab, closeTab, selectTab, focusTab, writeReportFile, modelTaskApi, catalogApi, androidApi, scheduleApi, spawnTask, skillsApi, messageApi, latestObservation, observationsByTab, thinkingArchive, heartbeatTimer, escalationTimer, visualEvidence, attachments, activeThoughtAccumulator, activeStepController, recoveryResumePromise, getComputerTools, getControlMode, attemptStartedClock, pendingComputerDesktop, computerObservationDirty, computerScreenshotStep, turnLedger, resultStore, research, researchHost, researchDefaults, layaVerifier, researchHint, pendingAgentMessages, subagentApi, eagerResults, notebook, deadlineTimer, deadlineFinishNoticeArmed, ...serializable } = run;
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

// AGENT INTERNALS (rewrite): the functionality library of the chat agent —
// every module-level helper, catalog, serializer and validator, moved VERBATIM
// from the original desktopChatAgent.cjs. The class (loop/prompt/recovery) is
// rebuilt on the harness in ./desktopChatAgent.cjs and consumes these through
// this export surface.
// VERIFICATION EVIDENCE (promoted from the old done-gate, rewrite): the
// calls that actually PRODUCE proof that a claimed outcome happened.
const VERIFICATION_EVIDENCE_TOOLS = new Set([
  'computer_screenshot', 'browser_screenshot', 'computer_read', 'computer_search',
  'computer_index', 'browser_observe', 'browser_execute', 'computer_git', 'computer_fs'
]);
function historyEntryVerified(entry) {
  const tool = String(entry?.tool || '');
  const recorded = entry?.output;
  if (!recorded || recorded.ok !== true) return false;
  const input = entry?.input || {};
  if (tool === 'computer_terminal') {
    const exitCode = recorded?.result?.exitCode;
    if (exitCode !== undefined && exitCode !== null) return Number(exitCode) === 0;
    return /"exitCode"\s*:\s*0\b/.test(JSON.stringify(recorded) || '');
  }
  if (tool === 'computer_git') return READ_ONLY_GIT_ACTIONS.has(String(input.action || ''));
  if (tool === 'computer_fs') return READ_ONLY_FS_ACTIONS.has(String(input.action || ''));
  if (tool === 'computer_file') return false;
  return VERIFICATION_EVIDENCE_TOOLS.has(tool);
}

module.exports = {
  // Public contract surface (re-exported by desktopChatAgent.cjs)
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
  advanceObjectiveLedger, closeActiveObjective, retireAnswerOnlyObjective, settleObjectiveLedgerOnTerminal, activeObjectiveEntry,
  // Internals consumed by the rewritten class
  normalizeAttachmentsHelpers: { safeAttachmentName, MAX_ATTACHMENT_TEXT_CHARS, MAX_ATTACHMENT_IMAGE_BYTES },
  recordVisualCapture, pushHarnessNotice, drainHarnessNotices, noticeIdFor,
  appendConversationMessage, normalizeConversationMessage, normalizeConversationMessages,
  maybeGenerateConversationTitle, nextTimelineAt, ensureTerminalAssistantMessage,
  restoreConversationSnapshot, archiveActiveThinking, harvestThinkingBudget, harvestThinkingBudgetFromText,
  normalizeSettings: (typeof normalizeSettings === 'function' ? normalizeSettings : null),
  normalizeWorkspace: (typeof normalizeWorkspace === 'function' ? normalizeWorkspace : null),
  workspaceFromTask: (typeof workspaceFromTask === 'function' ? workspaceFromTask : null),
  defaultNotebookDir, syncNotebook, syncObjectiveLedger, recordConsulted, speculativePreRead,
  resetStreamingThoughtStall, isMessageInterrupt: (typeof isMessageInterrupt === 'function' ? isMessageInterrupt : null),
  serializeRun, serializeEventRun, checkpointSnapshot,
  observeRun, requiresApproval, approvalReason,
  withinStepTimeout: (typeof withinStepTimeout === 'function' ? withinStepTimeout : null),
  resolveSnapshotElement: (typeof resolveSnapshotElement === 'function' ? resolveSnapshotElement : null),
  shouldFinalizeConclusivePointerMove: (typeof shouldFinalizeConclusivePointerMove === 'function' ? shouldFinalizeConclusivePointerMove : null),
  isThinTerminalReply: (typeof isThinTerminalReply === 'function' ? isThinTerminalReply : null),
  terminalPointerMoveCompletion: (typeof terminalPointerMoveCompletion === 'function' ? terminalPointerMoveCompletion : null),
  isWaitPollCall: (typeof isWaitPollCall === 'function' ? isWaitPollCall : null),
  repeatedAppendAfterFill: (typeof repeatedAppendAfterFill === 'function' ? repeatedAppendAfterFill : null),
  repeatedOuterObservation: (typeof repeatedOuterObservation === 'function' ? repeatedOuterObservation : null),
  repeatedScreenshotFromCurrentObservation: (typeof repeatedScreenshotFromCurrentObservation === 'function' ? repeatedScreenshotFromCurrentObservation : null),
  mayContinueFocusedSubmit: (typeof mayContinueFocusedSubmit === 'function' ? mayContinueFocusedSubmit : null),
  assertComputerMode: (typeof assertComputerMode === 'function' ? assertComputerMode : null),
  redactArgs: (typeof redactArgs === 'function' ? redactArgs : null),
  redactOutput: (typeof redactOutput === 'function' ? redactOutput : null),
  redactRecoveryError: (typeof redactRecoveryError === 'function' ? redactRecoveryError : null),
  normalizeExpectation: (typeof normalizeExpectation === 'function' ? normalizeExpectation : null),
  screenshotPreviewValue: (typeof screenshotPreviewValue === 'function' ? screenshotPreviewValue : null),
  normalizeProgressInput: (typeof normalizeProgressInput === 'function' ? normalizeProgressInput : null),
  isStaleElementFailure: (typeof isStaleElementFailure === 'function' ? isStaleElementFailure : null),
  hasVerifiedExternalBlock: (typeof hasVerifiedExternalBlock === 'function' ? hasVerifiedExternalBlock : null),
  isCritiqueOnlyRun: (typeof isCritiqueOnlyRun === 'function' ? isCritiqueOnlyRun : null),
  requiresFileMutation: (typeof requiresFileMutation === 'function' ? requiresFileMutation : null),
  fileMutationSatisfied: (typeof fileMutationSatisfied === 'function' ? fileMutationSatisfied : null),
  codingCheckSatisfied: (typeof codingCheckSatisfied === 'function' ? codingCheckSatisfied : null),
  requiresCompletionReview: (typeof requiresCompletionReview === 'function' ? requiresCompletionReview : null),
  storeTabObservation: (typeof storeTabObservation === 'function' ? storeTabObservation : null),
  probeFormControlConstraints: (typeof probeFormControlConstraints === 'function' ? probeFormControlConstraints : null),
  clamp: (typeof clamp === 'function' ? clamp : null),
  inspectValueAliases: { inspectionValue, screenshotPreviewValue },
  // Extended internals (rewrite): consumed by the rewritten class.
  isCheapInformationalTask, isRapidTask, normalizeWorkingMemory, normalizeThinkingArchive,
  defaultDeterministicResearch, coerceElementIndex, countAccountingLines, requestInstructionCount,
  stalePageFiles, lastPageChangeAfter, historyEntryMutated, historyEntryConfirmsChange, historyEntryVerified,
  observationFingerprint, FAST_PATH_ACTIONS, PROGRESS_GUARDED_READ_ACTIONS, READ_ONLY_ACTION_NAMES,
  actionRiskLevel, riskGateFor, viewportPoint,
  fallbackConversationTitle, normalizeConversationTitle,
  DEFAULT_SETTINGS, WAIT_BACKOFF_MS: null,
  // Shared stall-ladder budget (): the over-thought ladder and the
  // no-observable-change ladder feed the SAME counter, and the counter is
  // what the park threshold is measured against.
  THOUGHT_BUDGET_CHARS, ESCALATION_PARK_FIRES
};
