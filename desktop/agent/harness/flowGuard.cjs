'use strict';

// FLOW + EVIDENCE GUARDS (harness pattern, adapted from the reference harness
// packages/guard): DECISION-LEVEL enforcement stages.
//
// The pure state machine (evidence epochs, novelty scoring, phases, notice
// cooldowns) lives in ../flowControlState.cjs. This module is the ONE owner
// that turns that assessment into SOURCED harness actions, and it owns the
// counters the old prompt-wall implementation scattered across the agent:
//
//   1. FlowGuard             — evidence novelty, evidence epochs, plan
//                              narration, evidence claims, thinking-budget tiers.
//   2. Evidence-streak guard — consecutive evidence-only decisions (the
//                              "EVIDENCE SUFFICIENT" accounting) and the
//                              read-only cap that eventually hard-rejects a read.
//   3. Actionless-stall guard — a decision that produced NO executable action,
//                              counted ONLY when the stall is IDENTICAL (same
//                              narration, same observation, same plan). A fresh
//                              decision resets it.
//
// Every guard is ADVISORY by default and never vetoes a call. The read-only cap
// is the single hard floor, and it is bounded: it names the exits instead of
// blocking progress forever.
//
// SOURCING IS LOAD-BEARING: an unlabeled injection would render as a plain
// user turn in derived history. Every notice carries { id, source, text }.
//
// GUARD STATE LIVES ON THE RUN, not on a guard object, so it survives
// checkpointing and a resumed run keeps its accounting.

const crypto = require('node:crypto');
const { isCodingTask } = require('../../computer/computerCatalog.cjs');
const {
  createFlowControlState,
  resetFlowControlForUserTurn,
  assessFlowControl,
  captureEvidence,
  touchedPathsFromCall,
  thinkingBudgetTier,
  thinkingBudgetNotice
} = require('../flowControlState.cjs');

// ── shared notice sources ──────────────────────────────────────────────────
const FLOW_NOTICE_SOURCE = 'guard:flow';
const EVIDENCE_NOTICE_SOURCE = 'guard:evidence-streak';
const STALL_NOTICE_SOURCE = 'guard:actionless-stall';

// ── flow guard ──────────────────────────────────────────────────────────────

// Decision-level flow assessment. Wraps the pure state machine and returns
// SOURCED actions: at most one advisory notice per decision, and at most one
// bounded recovery bounce per evidence epoch.
class FlowGuard {
  constructor(state = null) {
    this.state = createFlowControlState(state);
  }

  // resetForUserTurn(task) — a new objective starts a new evidence epoch.
  resetForUserTurn(task = '') {
    this.state = resetFlowControlForUserTurn(this.state, task);
    return this.state;
  }

  // assess(input) → { state, notice, bounce, assessment }
  //   input mirrors flowControlState.assessFlowControl.
  assess(input = {}) {
    const result = assessFlowControl(this.state, input);
    this.state = result.state;
    return {
      state: result.state,
      notice: result.notice
        ? { id: `guard.flow.${result.notice.key}`, source: FLOW_NOTICE_SOURCE, text: result.notice.text }
        : null,
      bounce: result.bounce
        ? { source: result.bounce.source, demand: result.bounce.demand }
        : null,
      assessment: result.assessment
    };
  }
}

// ── evidence-streak guard ───────────────────────────────────────────────────

// A decision is EVIDENCE-ONLY when every call it made was a read-style
// consult. The tool set is deliberately narrow: computer_fs counts only for
// its read actions (stat/list/find) — mkdir/copy/move/delete are mutations.
const EVIDENCE_STREAK_TOOLS = new Set([
  'computer_read', 'computer_search', 'computer_index', 'browser_observe',
  'browser_execute', 'browser_console_entries', 'browser_network_entries', 'browser_tabs'
]);
const EVIDENCE_FS_READ_ACTIONS = new Set(['stat', 'list', 'find']);

function genuineEvidenceCall(call) {
  const name = String(call?.name || '');
  if (EVIDENCE_STREAK_TOOLS.has(name)) return true;
  return name === 'computer_fs' && EVIDENCE_FS_READ_ACTIONS.has(String(call?.input?.action || ''));
}

// True only when EVERY call of the decision ran and returned ok. A call
// rejected by argument validation, or one that never ran (batch interrupted),
// is not evidence: the streak neither advances nor resets.
function evidenceCallsAllSucceeded(calls, run, sinceClock) {
  const remaining = (Array.isArray(run?.history) ? run.history : [])
    .filter((entry) => Number(entry?.at) > sinceClock && entry?.tool !== 'agent_advisory');
  for (const call of calls) {
    const index = remaining.findIndex((entry) => entry.tool === call.name);
    if (index === -1 || remaining[index].output?.ok !== true) return false;
    remaining.splice(index, 1);
  }
  return true;
}

// The streak fires at this many consecutive evidence-only decisions, then at
// every further multiple of it.
const EVIDENCE_SUFFICIENT_STREAK = 4;
// The read-only hard floor: after this many consecutive decisions with no
// mutation and no terminal result, a read-style call in a mutation-free
// decision is REJECTED before execution.
const READ_ONLY_ENFORCE_STREAK = 12;

// Once enforcement is engaged, this is what the next decision hears. Short and
// imperative; no "maybe" exits, because the model has already shown it will
// take a soft exit.
function readOnlyEnforcementDemand(taskText) {
  return `READ-ONLY CAP: ${READ_ONLY_ENFORCE_STREAK} consecutive decisions produced no edit or terminal result. Stop inspecting: state your best-supported hypothesis for the reported symptom in one line and apply the single smallest corrective change (computer_patch) now, or return browser_done. Do not read, search, or list again.${taskText ? ` The task: ${String(taskText).replace(/\s+/g, ' ').trim().slice(0, 300)}` : ''}`;
}

// observeEvidenceStreak(run, { calls, allSucceeded }) → { streak, notice }
//   A decision with any non-evidence call (mutation, plan, wait, terminal)
//   RESETS the streak. A decision whose calls failed neither advances nor
//   resets it — that decision is recovery context, not evidence.
function observeEvidenceStreak(run, { calls = [], allSucceeded = false } = {}) {
  if (!run) return { streak: 0, notice: null };
  const evidenceOnly = calls.length > 0 && calls.every((call) => genuineEvidenceCall(call));
  if (!evidenceOnly) {
    run.evidenceOnlyStreak = 0;
    return { streak: 0, notice: null };
  }
  if (!allSucceeded) {
    return { streak: Number(run.evidenceOnlyStreak) || 0, notice: null };
  }
  const streak = (Number(run.evidenceOnlyStreak) || 0) + 1;
  run.evidenceOnlyStreak = streak;
  const fires = streak >= EVIDENCE_SUFFICIENT_STREAK
    && streak % EVIDENCE_SUFFICIENT_STREAK === 0
    && streak < READ_ONLY_ENFORCE_STREAK;
  return {
    streak,
    notice: fires
      ? {
        id: `guard.evidence.${streak}`,
        source: EVIDENCE_NOTICE_SOURCE,
        text: `EVIDENCE SUFFICIENT: ${streak} consecutive evidence-only decisions with no patch. You have read enough to act — state your best-supported hypothesis for the reported symptom in one line and apply the patch (computer_patch) now. Further reads add no information.`
      }
      : null
  };
}

// ── actionless-stall guard ──────────────────────────────────────────────────

const ACTIONLESS_STALL_NOTICE_STREAK = 2;
const ACTIONLESS_STALL_PARK_STREAK = 3;

// Normalize narration for stall comparison: URLs, paths and numbers are
// masked so only the WORDS of a restated diagnosis decide the key.
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

// The stall key: narration + observation fingerprint + plan. Two decisions
// share a key only when the model restated the SAME diagnosis against the
// SAME state — that is the loop worth breaking.
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

// observeActionlessStall(run, input) → { count, notice, park }
//   A DIFFERENT stall resets the count to 1: only an IDENTICAL restatement
//   accumulates. The notice fires once per stall; the park fires once per
//   stall (the run parks, resumes, and only then may park again).
function observeActionlessStall(run, input = {}) {
  if (!run) return { count: 0, notice: null, park: null };
  const key = actionlessStallKey(input);
  const count = noteActionlessStall(run, key);
  const state = normalizeActionlessStall(run.actionlessStall);
  let notice = null;
  let park = null;
  if (count >= ACTIONLESS_STALL_NOTICE_STREAK && state.noticeKey !== key) {
    run.actionlessStall.noticeKey = key;
    notice = {
      id: `guard.stall.${count}`,
      source: STALL_NOTICE_SOURCE,
      text: 'ACTIONLESS STALL: stop restating the diagnosis. Use one smallest discriminating probe or concrete action now, and make the next attempt materially different.'
    };
  }
  if (count >= ACTIONLESS_STALL_PARK_STREAK && state.parkKey !== key) {
    run.actionlessStall.parkKey = key;
    park = {
      id: `guard.stall.park.${count}`,
      source: STALL_NOTICE_SOURCE,
      text: 'Repeated actionless decisions produced no new evidence or executable action; the run is parked to resume from preserved state.'
    };
  }
  return { count, notice, park };
}

// ── read-only cap ───────────────────────────────────────────────────────────

// READ-ONLY ENFORCEMENT: a fix/diagnosis task that keeps returning read-only
// decisions is re-narrating its analysis instead of executing. Advisory
// notices alone are not enough — a model that varies its query wording each
// turn sails past them forever. Once the streak clears the cap, further
// read-only calls in a decision with no mutation are REJECTED before
// execution. The only ways forward are a mutation, a terminal, or an explicit
// plan change — never another read.
function readOnlyCapApplies({ call, mutation, calls = [], mutates = null, streak = 0, taskText = '', workspace = null }) {
  if (mutation) return false;
  if (!genuineEvidenceCall(call)) return false;
  if (streak < READ_ONLY_ENFORCE_STREAK) return false;
  // A mutation batched alongside the read is allowed — the mutation is the point.
  const isMutation = typeof mutates === 'function' ? mutates : () => false;
  if (calls.some((other) => other.name !== call.name && isMutation(other.name, other.input))) return false;
  return isCodingTask(taskText, workspace);
}

// ── evidence-phase checkpoint nudge ─────────────────────────────────────────

// Discrete early checkpoints, then recurring every 3rd decision — a run that
// keeps reading past 7 must not go unnagged forever. The recurring cadence
// STOPS at the read-only cap: past it the read-only rejection carries the
// demand, and another advisory here would just restate it.
const EVIDENCE_PHASE_CHECKPOINTS = Object.freeze([3, 5, 7]);

// Three variants, chosen by what the run IS:
//   diagnosis  — the requested outcome is an EXPLANATION. Once the evidence
//                identifies the cause, more research is not progress: the
//                answer is the deliverable.
//   coding     — an AGI run on a coding task: co-emit the smallest relevant
//                read and the patch on the single most likely cause.
//   general    — advance or answer; do not re-inspect.
function evidencePhaseNudge({ streak = 0, taskText = '', controlMode = 'browser', workspace = null, quote = (t) => t } = {}) {
  const text = String(taskText || '');
  const diagnosisTask = /\b(?:why|find out|diagnose|diagnosis|explain|investigate|figure out|root cause)\b/i.test(text);
  if (diagnosisTask) {
    return [
      `Evidence-phase check: ${streak} consecutive read-only decisions on a diagnosis task.`,
      'If the evidence already identifies the cause, ANSWER NOW: return browser_done with the diagnosis and the specific supporting evidence. Do not run more queries to feel thorough.',
      'Only keep reading when one precise fact is genuinely still missing — state that fact in one sentence and fetch exactly it this decision.',
      text ? `The question to answer: ${quote(text)}` : ''
    ].filter(Boolean).join('\n');
  }
  if (controlMode === 'agi' && isCodingTask(text, workspace)) {
    return [
      `Evidence-phase check: ${streak} consecutive decisions produced NO edit.`,
      'Decide from the evidence already collected: co-emit computer_read (the smallest relevant section) and computer_patch on the single most likely cause THIS decision — or state the one precise fact still missing and the single command that obtains it.',
      'Further untargeted git/search/list calls are not acceptable progress.',
      text ? `The task you must complete: ${quote(text)}` : ''
    ].filter(Boolean).join('\n');
  }
  return [
    `Evidence-phase check: ${streak} consecutive read-only decisions.`,
    'Decide from the evidence already collected: perform the next grounded ACTION that advances the goal, or return browser_done with what the evidence supports. Re-inspecting the same surface is not progress.',
    text ? `The task you must complete: ${quote(text)}` : ''
  ].filter(Boolean).join('\n');
}

// observeEvidencePhase(run, { batchHadMutation, calls }) → { streak, nudge }
//   The streak counts consecutive decisions that issued calls but performed
//   NO mutation. Any mutation resets it.
function observeEvidencePhase(run, { batchHadMutation = false, calls = [] } = {}) {
  if (!run) return { streak: 0, nudge: null };
  if (batchHadMutation) {
    run.readOnlyDecisionStreak = 0;
    return { streak: 0, nudge: null };
  }
  if (!calls.length) return { streak: Number(run.readOnlyDecisionStreak) || 0, nudge: null };
  const streak = (Number(run.readOnlyDecisionStreak) || 0) + 1;
  run.readOnlyDecisionStreak = streak;
  const atCheckpoint = EVIDENCE_PHASE_CHECKPOINTS.includes(streak)
    || (streak > 7 && (streak - 7) % 3 === 0 && streak < READ_ONLY_ENFORCE_STREAK);
  return {
    streak,
    nudge: atCheckpoint
      ? {
        id: `guard.evidence-phase.${streak}`,
        source: EVIDENCE_NOTICE_SOURCE,
        text: evidencePhaseNudge({ streak, taskText: run.task, controlMode: run.settings?.controlMode, workspace: run.workspace })
      }
      : null
  };
}

module.exports = {
  FLOW_NOTICE_SOURCE,
  EVIDENCE_NOTICE_SOURCE,
  STALL_NOTICE_SOURCE,
  FlowGuard,
  EVIDENCE_STREAK_TOOLS,
  EVIDENCE_SUFFICIENT_STREAK,
  READ_ONLY_ENFORCE_STREAK,
  EVIDENCE_FS_READ_ACTIONS,
  ACTIONLESS_STALL_NOTICE_STREAK,
  ACTIONLESS_STALL_PARK_STREAK,
  EVIDENCE_PHASE_CHECKPOINTS,
  genuineEvidenceCall,
  evidenceCallsAllSucceeded,
  readOnlyEnforcementDemand,
  readOnlyCapApplies,
  observeEvidenceStreak,
  evidencePhaseNudge,
  observeEvidencePhase,
  normalizeStallText,
  actionlessStallKey,
  normalizeActionlessStall,
  resetActionlessStall,
  noteActionlessStall,
  observeActionlessStall,
  createFlowControlState,
  resetFlowControlForUserTurn,
  assessFlowControl,
  captureEvidence,
  touchedPathsFromCall,
  thinkingBudgetTier,
  thinkingBudgetNotice
};
