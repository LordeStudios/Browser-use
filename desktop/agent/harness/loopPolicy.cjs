'use strict';

// LOOP POLICY (DSH pattern): ONE owner for recovery, retry, backoff, effort
// and undecidable-output handling. This module replaces five overlapping
// mechanisms of the old harness (stall heartbeat, decision watchdog,
// park/escalate, scheduleRecovery fingerprints, flow-control scoring) with a
// single uniform model:
//
//   1. CLASSIFY every failure with the kept 10-class taxonomy.
//   2. TRANSPORT failures (provider reachability): retry INSIDE the open step
//      on the existing ladder — the user prompt is never re-admitted.
//   3. EVERYTHING ELSE: park once — status 'awaiting_recovery' +
//      run.escalated + auto-resume with backoff. Recovery is INDEFINITE
//      (owner directive, README_PATCH_STALL_CEILINGS.md): parking NEVER
//      terminates a run. The only external stop is the run deadline.
//   4. UNDECIDABLE model output (no tool call, no done): one sticky sourced
//      schema-repair notice per turn; the turn continues.

const { RETRY_DELAYS_MS, isTransportError, isHardProviderError } = require('../providers/retry.cjs');

// ---- Failure taxonomy (moved verbatim from the old agent file so tests and
// ---- UI pinning the 8-class strings keep working; PROVIDER_BLOCK kept).
const FAILURE_CLASSES = Object.freeze({
  INVALID_INPUT: ['invalid_plan_update', 'invalid_tool_input', 'agent_message_invalid', 'read_agent_result_invalid', 'research_objective_invalid', 'search_query_invalid', 'skill_unknown', 'subagent_close_invalid', 'wait_ms_invalid', 'computer_model_kind_invalid', 'computer_model_prompt_invalid'],
  TRANSIENT: ['action_timeout', 'observation_timeout', 'output_budget', 'internal_error', 'fetch_failed', 'pointer_interrupted', 'computer_model_failed'],
  STALE_STATE: ['stale_element', 'layout_changed', 'completion_evidence'],
  SCOPE: ['workspace_scope'],
  NO_EFFECT: ['browser_action'],
  CONFLICT: ['constraint_tamper'],
  LOOP: ['action_loop', 'duplicate_action', 'missing_terminal_result'],
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

// ---- Transport retry (in-step). The ladder lives in providers/retry.cjs and
// ---- stays the single source of delay values.
function nextRetryDelay(attempt) {
  const ladder = Array.isArray(RETRY_DELAYS_MS) && RETRY_DELAYS_MS.length ? RETRY_DELAYS_MS : [5000];
  return ladder[Math.min(Math.max(Number(attempt) || 0, 0), ladder.length - 1)];
}

// Bounded in-step retries: the ladder is finite by construction; when it is
// exhausted the step fails and the uniform park path takes over.
function retryBudget() {
  return Array.isArray(RETRY_DELAYS_MS) ? RETRY_DELAYS_MS.length : 1;
}

// ---- Escalation backoff for parked runs (auto-resume). Growth is bounded;
// ---- resumption is always scheduled — indefinite recovery. The env knob is
// ---- read at CALL time so tests and operators can retune cadence live.
function escalationBaseMs() {
  return Math.max(5_000, Number(process.env.BROWSER_USE_ESCALATION_RESUME_MS) || 60_000);
}
const ESCALATION_MAX_MS = 600_000;
function escalationBackoffMs(attempts) {
  const n = Math.max(0, Number(attempts) || 0);
  return Math.min(ESCALATION_MAX_MS, escalationBaseMs() * Math.pow(2, Math.min(n, 4)));
}

// ---- Sourced notices. Every injected guidance message carries a source —
// ---- unlabeled injections would render as plain user turns in history.
function recoveryNotice(attempt, failureClass, message) {
  return {
    id: `harness.recovery.${attempt}`,
    source: 'harness:recovery',
    text: `Recovery attempt ${attempt} after a ${failureClass} failure${message ? ` (${message})` : ''}. `
      + 'Treat prior tool results as authoritative evidence — inspect current state instead of assuming earlier narration is still current. '
      + 'Re-verify an uncertain claim with one corrected probe; never by re-executing a completed flow.'
  };
}

const SCHEMA_REPAIR_NOTICE = {
  id: 'harness.schema-repair',
  source: 'harness:schema',
  text: 'Your last reply contained no executable decision. Respond with exactly one decision: '
    + 'either a tool call (browser_* / computer_* / meta tools) or the browser_done tool with '
    + '{summary, success, verified}. Plain narration is not an action.'
};

const DEADLINE_NOTICE = {
  id: 'harness.deadline',
  source: 'harness:deadline',
  text: 'The external run deadline is close. Wrap up now: finish or explicitly report what remains and the concrete blocker via browser_done.'
};

const OBSERVATION_ADVISORY = {
  id: 'harness.observation',
  source: 'harness:observation',
  text: 'Page observation repeatedly failed. Proceed only from evidence you already hold, try browser_tabs to re-select a tab, or report the blocker via browser_done.'
};

// ---- Effort as model-selection config (not prompt tiers). One cap; the
// ---- provider receives it as configuration.
const EFFORT_BUDGET_MS = Object.freeze({
  minimal: 3_000,
  standard: 30_000,
  advanced: 120_000,
  auto: 30_000
});
function thinkingBudgetMs(effort) {
  return EFFORT_BUDGET_MS[effort] ?? EFFORT_BUDGET_MS.auto;
}

module.exports = {
  FAILURE_CLASSES,
  classifyFailure,
  isTransportError,
  isHardProviderError,
  RETRY_DELAYS_MS,
  nextRetryDelay,
  retryBudget,
  ESCALATION_MAX_MS,
  escalationBackoffMs,
  recoveryNotice,
  SCHEMA_REPAIR_NOTICE,
  DEADLINE_NOTICE,
  OBSERVATION_ADVISORY,
  EFFORT_BUDGET_MS,
  thinkingBudgetMs
};
