'use strict';

// Loop controller flow state (pure, deterministic, no I/O).
//
//   Receive task -> Inspect -> new useful evidence? -> update task state ->
//   enough evidence to act? -> edit/execute -> verify -> criteria met? ->
//   complete | progress? -> bounded recovery -> new strategy? -> blocker.
//
// The harness never forces a phase. It observes what each decision actually
// did, scores whether the evidence it gathered was NEW and RELEVANT, and hands
// back at most one advisory notice (delivered through the existing one-shot
// harness-notice channel) plus, rarely, one bounded recovery bounce. Nothing
// here rejects a tool call, aborts a stream, or terminates a run.

const crypto = require('node:crypto');

const MAX_EVIDENCE = 64;
const MAX_NOTICE_LOG = 24;
const MAX_TOUCHED = 24;
const LOW_NOVELTY = 0.2;
const NOTICE_COOLDOWN_DECISIONS = 8;
const READ_SPAM_NOTICE_STREAK = 3;
const READ_SPAM_BOUNCE_STREAK = 5;
const SPRAWL_THRESHOLD = 6;
const MAX_PLAN_PROMPTS = 3;
// Thinking budget tiers. Normal-size, normal-time thinking never triggers
// anything; the first tier informs, the second insists. Both are advisory.
// These sit ABOVE ordinary work: 25s and 2,048 chars are routine for a real
// task, and a notice at that level only adds "why is it telling me to stop"
// to the reasoning it is complaining about.
const THINKING_TIERS = Object.freeze({ elevated: { chars: 4_096, ms: 45_000 }, heavy: { chars: 16_000, ms: 120_000 } });
// LORDE_VERIFY_CAP_V1 — maximum consecutive verify-only decisions before a
// stronger "stop verifying" notice. Prevents the 15+ verification loops seen
// after a successful patch.
const VERIFY_ONLY_STREAK_CAP = 3;

const PHASES = Object.freeze(['inspect', 'plan', 'act', 'verify', 'accept', 'complete']);
const EVIDENCE_CLAIM = new RegExp([
  // "enough evidence", "sufficient information", "enough context to act"
  String.raw`\b(?:enough|sufficient)\s+(?:evidence|information|context|data)\b`,
  // "the evidence is sufficient", "evidence is now enough/clear"
  String.raw`\b(?:evidence|information|context)\s+(?:is|are|seems?|looks?)\s+(?:now\s+)?(?:more\s+than\s+)?(?:enough|sufficient|clear|conclusive)\b`,
  // "I have enough", "we now know everything we need"
  String.raw`\b(?:i|we)\s+(?:now\s+)?(?:have|know)\s+(?:enough|everything|what\s+(?:i|we)\s+need)\b`,
  // "the root cause is clear/identified"
  String.raw`\b(?:the|this)\s+(?:root\s+)?(?:cause|issue|problem|bug)\s+is\s+(?:now\s+)?(?:clear|identified|obvious|found)\b`
].join('|'), 'i');
const PLANNING_MARKER = /\b(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|then|next|after\s+that|finally|step\s*\d+|my\s+plan|the\s+plan\s+is|plan\s*:)\b/gi;
const NUMBERED_STEP = /^\s*(?:\d{1,2}[.)]|[-*])\s+\S/gm;

function digest(value) {
  return crypto.createHash('sha256').update(String(value ?? '')).digest('hex').slice(0, 16);
}

function normalizeText(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function taskKey(value) {
  return digest(normalizeText(value));
}

function tokens(value) {
  return new Set(normalizeText(value).match(/[a-z0-9_#.-]{3,}/g) || []);
}

function normalizeEvidence(value) {
  if (!value || typeof value !== 'object') return null;
  const kind = String(value.kind || '').slice(0, 16);
  if (!['read', 'search', 'index', 'screenshot'].includes(kind)) return null;
  const range = (field) => (value[field] === null || value[field] === undefined || !Number.isFinite(Number(value[field])) ? null : Number(value[field]));
  return {
    kind,
    subject: normalizeText(value.subject).slice(0, 500),
    queryKey: normalizeText(value.queryKey).slice(0, 240),
    artifactHash: String(value.artifactHash || '').slice(0, 32),
    resultDigest: String(value.resultDigest || '').slice(0, 32),
    resultKeys: Array.isArray(value.resultKeys) ? value.resultKeys.slice(0, 80).map((item) => normalizeText(item).slice(0, 240)) : [],
    from: range('from'),
    to: range('to'),
    epoch: Math.max(0, Number(value.epoch) || 0),
    novelty: Math.max(0, Math.min(1, Number(value.novelty) || 0)),
    relevant: value.relevant !== false
  };
}

function normalizeFlowControlState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    phase: PHASES.includes(source.phase) ? source.phase : 'inspect',
    taskFingerprint: String(source.taskFingerprint || '').slice(0, 32),
    decisionNumber: Math.max(0, Number(source.decisionNumber) || 0),
    planPrompted: source.planPrompted === true,
    planPromptCount: Math.max(0, Math.min(MAX_PLAN_PROMPTS, Number(source.planPromptCount) || 0)),
    planMissingStreak: Math.max(0, Math.min(50, Number(source.planMissingStreak) || 0)),
    lowYieldStreak: Math.max(0, Math.min(50, Number(source.lowYieldStreak) || 0)),
    evidenceEpoch: Math.max(0, Number(source.evidenceEpoch) || 0),
    bounceEpoch: Number.isFinite(Number(source.bounceEpoch)) ? Number(source.bounceEpoch) : -1,
    touchedPaths: Array.isArray(source.touchedPaths) ? source.touchedPaths.slice(-MAX_TOUCHED).map((item) => normalizeText(item).slice(0, 300)).filter(Boolean) : [],
    evidence: Array.isArray(source.evidence) ? source.evidence.slice(-MAX_EVIDENCE).map(normalizeEvidence).filter(Boolean) : [],
    noticeLog: Array.isArray(source.noticeLog)
      ? source.noticeLog.slice(-MAX_NOTICE_LOG).map((item) => ({ key: String(item?.key || '').slice(0, 80), decision: Math.max(0, Number(item?.decision) || 0) })).filter((item) => item.key)
      : []
  };
}

function createFlowControlState(previous = null) {
  return normalizeFlowControlState(previous);
}

// New user turn / replaced objective: per-objective prompts, evidence and
// bounce state start over (a new evidence epoch), nothing else is touched.
function resetFlowControlForUserTurn(previous = null, task = '') {
  const state = normalizeFlowControlState(previous);
  return {
    ...state,
    phase: 'inspect',
    taskFingerprint: taskKey(task),
    planPrompted: false,
    planPromptCount: 0,
    planMissingStreak: 0,
    lowYieldStreak: 0,
    evidenceEpoch: state.evidenceEpoch + 1,
    bounceEpoch: -1,
    touchedPaths: [],
    evidence: [],
    noticeLog: []
  };
}

// ---------- evidence capture ----------

function resultKeysOf(result) {
  const keys = [];
  for (const item of Array.isArray(result?.files) ? result.files : []) keys.push(typeof item === 'string' ? item : (item?.file || item?.path || item?.relative));
  for (const item of Array.isArray(result?.lines) ? result.lines : []) keys.push(`${item?.file || ''}:${item?.line ?? ''}:${item?.text || ''}`);
  if (typeof result?.map === 'string') for (const line of result.map.split('\n')) if (line) keys.push(line);
  return keys.filter(Boolean).slice(0, 80);
}

// Compact, content-free summary of ONE successful consult (read/search/index),
// captured while the full tool output is still in hand. Returns null for any
// other tool: browser observations, mutations and waits are judged by the
// coordinator's own fingerprints, not by this ledger.
function captureEvidence(call, output) {
  const name = String(call?.name || '');
  if (!['computer_read', 'computer_search', 'computer_index', 'browser_screenshot', 'computer_screenshot'].includes(name) || output?.ok !== true) return null;
  const input = call.input || {};
  const result = output.result && typeof output.result === 'object' ? output.result : output;
  // A screenshot IS evidence. Excluding it made every screenshot a zero-yield
  // decision (and every DOM read a yielding one), which is a structural push
  // toward reading the DOM instead of looking at the screen.
  if (name === 'browser_screenshot' || name === 'computer_screenshot') {
    // The capture's identity is its content marker: two different frames are
    // two pieces of evidence, the same frame twice is not.
    const mark = digest(String(result?.screenshotId || result?.data || result?.mimeType || name) + String(result?.url || ''));
    return normalizeEvidence({
      kind: 'screenshot',
      subject: String(result?.url || result?.tabId || (name === 'computer_screenshot' ? 'desktop' : 'page')),
      queryKey: '',
      artifactHash: mark,
      resultDigest: mark,
      relevant: true
    });
  }
  if (name === 'computer_read') {
    const offset = Number(result.fromLine ?? input.offset) || 1;
    return normalizeEvidence({
      kind: 'read',
      subject: result.path || input.path || '',
      queryKey: '',
      artifactHash: result.workspace?.hash || result.contentHash || '',
      resultDigest: digest(result.content),
      from: offset,
      to: Number(result.toLine) || offset + Math.max(0, (Number(result.lines) || 1) - 1)
    });
  }
  const keys = resultKeysOf(result);
  return normalizeEvidence({
    kind: name === 'computer_search' ? 'search' : 'index',
    subject: result.root || input.path || input.root || '',
    queryKey: [input.pattern, input.query, input.glob, input.output || input.outputMode].filter(Boolean).join(' | '),
    resultDigest: digest(keys.join('\n') || result.map || ''),
    resultKeys: keys
  });
}

function overlapRatio(candidate, prior) {
  if (candidate.from === null || candidate.to === null || prior.from === null || prior.to === null) return 0;
  const overlap = Math.max(0, Math.min(candidate.to, prior.to) - Math.max(candidate.from, prior.from) + 1);
  return Math.min(1, overlap / Math.max(1, candidate.to - candidate.from + 1));
}

function setSimilarity(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (!a.size && !b.size) return 1;
  let common = 0;
  for (const item of b) if (a.has(item)) common += 1;
  return common / Math.max(1, new Set([...a, ...b]).size);
}

function tokenSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const token of a) if (b.has(token)) common += 1;
  return common / Math.max(a.size, b.size);
}

// 1 = materially new evidence, 0 = nothing the run does not already hold.
// Compared only within the same evidence epoch: an edit, navigation or new
// user turn opens a new epoch, so a legitimate re-read after a change is new.
function scoreEvidenceNovelty(ledger, entry) {
  if (!entry) return 0;
  const prior = (ledger || []).filter((item) => item.kind === entry.kind && item.subject === entry.subject && item.epoch === entry.epoch);
  if (!prior.length) return 1;
  const latest = prior.at(-1);
  if (entry.artifactHash && latest.artifactHash && entry.artifactHash !== latest.artifactHash) return 1;
  if (entry.kind === 'read') {
    const overlap = Math.max(...prior.map((item) => overlapRatio(entry, item)));
    if (overlap >= 0.98) return entry.resultDigest === latest.resultDigest ? 0 : 0.05;
    if (overlap >= 0.5) return Math.max(0.05, 1 - overlap);
    return 0.8;
  }
  const resultSimilarity = Math.max(...prior.map((item) => setSimilarity(item.resultKeys, entry.resultKeys)));
  const querySimilarity = Math.max(...prior.map((item) => tokenSimilarity(item.queryKey, entry.queryKey)));
  if (resultSimilarity >= 0.98) return querySimilarity >= 0.5 ? 0 : 0.05;
  if (resultSimilarity >= 0.75) return 0.15;
  return resultSimilarity > 0 ? 0.5 : 1;
}

// A consult is relevant when its subject/query shares vocabulary with the
// task, the visible plan, or a file the run already touched. Used only to
// notice aimless sprawl across many unrelated files; never to refuse a read.
function isRelevant(entry, { taskText = '', planTexts = [], touchedPaths = [] } = {}) {
  const subject = normalizeText(entry.subject);
  if (entry.kind === 'read' && touchedPaths.some((path) => path && (subject === path || subject.endsWith(path) || path.endsWith(subject)))) return true;
  const context = tokens(`${taskText} ${(planTexts || []).join(' ')}`);
  if (!context.size) return true;
  const probe = tokens(`${subject.replace(/[\\/]/g, ' ')} ${entry.queryKey}`);
  for (const token of probe) if (context.has(token)) return true;
  for (const touched of touchedPaths) for (const token of tokens(touched.replace(/[\\/]/g, ' '))) if (probe.has(token)) return true;
  return false;
}

function touchedPathsFromCall(call) {
  const input = call?.input || {};
  const paths = [];
  if (['computer_write'].includes(call?.name) && input.path) paths.push(input.path);
  if (call?.name === 'computer_patch') {
    for (const match of String(input.patch || input.input || '').matchAll(/\*\*\* (?:Update|Add|Delete) File:\s*(.+)/g)) paths.push(match[1].trim());
    if (input.path) paths.push(input.path);
  }
  return paths.map((item) => normalizeText(item)).filter(Boolean);
}

// ---------- thinking budget ----------

function thinkingBudgetTier({ chars = 0, ms = 0 } = {}) {
  const size = Math.max(0, Number(chars) || 0);
  const time = Math.max(0, Number(ms) || 0);
  if (size >= THINKING_TIERS.heavy.chars || time >= THINKING_TIERS.heavy.ms) return 2;
  if (size >= THINKING_TIERS.elevated.chars || time >= THINKING_TIERS.elevated.ms) return 1;
  return 0;
}

// Both tiers keep the E5 wording ("cheapest discriminating test") so the
// notice stays one recognisable line, and name the three exits the user asked
// for: plan, act on held evidence, or keep thinking only if truly needed.
// boundedRequestContext cuts every notice at NOTICE_MAX_CHARS, so the closing
// "keep thinking only if..." exit must always fit inside it.
const NOTICE_MAX_CHARS = 300;
function thinkingBudgetNotice(tier) {
  if (tier >= 2) {
    return 'Your last decision used a very large thinking budget — run the cheapest discriminating test. Stop deliberating: write the real plan with update_plan, act on the evidence you hold, or verify and finish. Keep thinking only if one named fact is still missing.';
  }
  return 'Your last decision spent its length reasoning — run the cheapest discriminating test. Thinking budget check: if this is multi-step work, record it with update_plan; if the evidence suffices, act on it; keep thinking only if one precise fact is missing.';
}

// ---------- decision classification ----------

function planningNarrationScore(text) {
  const value = String(text || '');
  return (value.match(PLANNING_MARKER) || []).length + (value.match(NUMBERED_STEP) || []).length;
}

function classifyDecision({ calls = [], assistantText = '', reasoningText = '', planChanged = false, planLength = 0, taskIsMultipart = false } = {}) {
  const list = Array.isArray(calls) ? calls : [];
  const texts = `${assistantText}\n${reasoningText}`;
  const hasDone = list.some((call) => call?.name === 'browser_done');
  const hasPlan = list.some((call) => call?.name === 'update_plan') || planChanged === true;
  const hasExecutable = list.some((call) => call && !['update_plan', 'browser_done'].includes(call.name));
  return {
    hasDone,
    hasPlan,
    hasExecutable,
    evidenceClaim: EVIDENCE_CLAIM.test(texts),
    planningNarration: taskIsMultipart === true && !hasPlan && !(Number(planLength) > 0) && planningNarrationScore(texts) >= 3,
    planMissing: taskIsMultipart === true && !hasPlan && !(Number(planLength) > 0)
  };
}

function recentlyNoticed(state, key) {
  return state.noticeLog.some((item) => item.key === key && state.decisionNumber - item.decision < NOTICE_COOLDOWN_DECISIONS);
}

function logNotice(state, key) {
  state.noticeLog = [...state.noticeLog.filter((item) => item.key !== key), { key, decision: state.decisionNumber }].slice(-MAX_NOTICE_LOG);
}

const NOTICE_TEXT = Object.freeze({
  evidenceClaim: 'FLOW: the evidence is sufficient — act now or call update_plan. A settled decision is final: never reopen it with "but wait", "hmm", theories, or speculation. Take the smallest grounded edit or command, verify it, or return browser_done. Keep reasoning only if one precise fact is missing.',
  planNarration: 'FLOW: listing steps in your thinking does not create a plan. Call update_plan now with one item per requested outcome and a short verification criterion, then act on the first item immediately — think while working (batch independent calls in one response), not before.',
  planFollowUp: 'FLOW: this multi-part task still has no harness-owned plan. Call update_plan with the requested outcomes (or proceed with a concrete action while keeping the full checklist) — the plan is what completion review will check. Then act on it immediately.',
  lowYield: 'FLOW: your recent reads/searches added little new or relevant evidence. Name the one precise missing fact and fetch only that, or act on the strongest supported diagnosis. A re-read is justified only after an edit, navigation, or external change.',
  bounce: 'Your last several reads/searches returned evidence the run already holds (or files unrelated to the task). Choose one: name the single precise fact still missing and fetch only it, act on the strongest supported diagnosis, or report the blocker. Do not vary the offset, file, or query wording to repeat the same read.',
});

// One consolidated assessment per decision. `evidence` is the list of
// captureEvidence() entries from this decision's successful consults.
function assessFlowControl(previous, input = {}) {
  const state = normalizeFlowControlState(previous);
  state.decisionNumber += 1;
  const {
    calls = [], evidence = [], assistantText = '', reasoningText = '', planChanged = false, planLength = 0,
    taskIsMultipart = false, thinkingChars = 0, thinkingMs = 0, mutationSucceeded = false, actionFailed = false,
    touchedPaths = [], taskText = '', planTexts = []
  } = input;
  const classification = classifyDecision({ calls, assistantText, reasoningText, planChanged, planLength, taskIsMultipart });
  const hasMutation = mutationSucceeded === true;
  if (touchedPaths.length) state.touchedPaths = [...new Set([...state.touchedPaths, ...touchedPaths])].slice(-MAX_TOUCHED);

  const scored = [];
  for (const raw of Array.isArray(evidence) ? evidence : []) {
    const entry = normalizeEvidence({ ...raw, epoch: state.evidenceEpoch });
    if (!entry) continue;
    entry.novelty = scoreEvidenceNovelty(state.evidence, entry);
    entry.relevant = isRelevant(entry, { taskText, planTexts, touchedPaths: state.touchedPaths });
    state.evidence.push(entry);
    scored.push(entry);
  }
  state.evidence = state.evidence.slice(-MAX_EVIDENCE);
  const sprawl = new Set(state.evidence.filter((item) => item.epoch === state.evidenceEpoch && !item.relevant).map((item) => item.subject || item.queryKey)).size >= SPRAWL_THRESHOLD;
  const yielding = scored.filter((entry) => entry.novelty >= LOW_NOVELTY && (entry.relevant || !sprawl));
  const newEvidence = yielding.length > 0;
  const lowYield = scored.length > 0 && !newEvidence;

  if (hasMutation) {
    // A successful edit/execution changes the artifact: everything read before
    // it is history, so the next read of the same range is genuinely new.
    state.evidenceEpoch += 1;
    state.lowYieldStreak = 0;
    state.bounceEpoch = -1;
    state.phase = 'act';
  } else if (actionFailed) {
    // A failed action invalidates what the model thought it knew: the next
    // read is a legitimate re-check of the real state, not read-spam.
    state.evidenceEpoch += 1;
    state.lowYieldStreak = 0;
    state.bounceEpoch = -1;
  } else if (lowYield) {
    state.lowYieldStreak += 1;
  } else if (newEvidence || classification.hasPlan) {
    state.lowYieldStreak = 0;
  }
  // Consecutive non-acting decisions on a multi-part task with no plan. Acting,
  // finishing, or actually recording a plan all end the streak.
  if (classification.planMissing && !hasMutation && !classification.hasDone) state.planMissingStreak += 1;
  else state.planMissingStreak = 0;
  if (classification.hasDone) state.phase = 'accept';
  else if (!hasMutation && classification.hasPlan && taskIsMultipart) state.phase = 'plan';
  else if (!hasMutation && scored.length) state.phase = 'inspect';
  else if (!hasMutation && state.phase === 'act' && classification.hasExecutable) state.phase = 'verify';

  const tier = thinkingBudgetTier({ chars: thinkingChars, ms: thinkingMs });
  const evidenceClaimStall = classification.evidenceClaim && !hasMutation && !classification.hasDone
    && (!classification.hasExecutable || lowYield || tier >= 1);

  // Priority: evidence claim without action > plan prompts > low-yield reads.
  // At most one notice per decision, each with a cooldown.
  let notice = null;
  if (evidenceClaimStall && !recentlyNoticed(state, 'evidence-claim')) notice = { key: 'evidence-claim', text: NOTICE_TEXT.evidenceClaim };
  else if (classification.planningNarration && !classification.hasExecutable && state.planPromptCount < MAX_PLAN_PROMPTS && !recentlyNoticed(state, 'plan-narration')) {
    state.planPromptCount += 1;
    notice = { key: 'plan-narration', text: NOTICE_TEXT.planNarration };
  } else if (classification.planMissing && !classification.hasExecutable && state.planMissingStreak >= 3 && state.planPromptCount < MAX_PLAN_PROMPTS && !recentlyNoticed(state, 'plan-follow-up')) {
    state.planPromptCount += 1;
    notice = { key: 'plan-follow-up', text: NOTICE_TEXT.planFollowUp };
  } else if (state.lowYieldStreak >= READ_SPAM_NOTICE_STREAK && !recentlyNoticed(state, 'low-yield')) {
    notice = { key: 'low-yield', text: NOTICE_TEXT.lowYield };
  }
  if (notice) logNotice(state, notice.key);

  // One bounded recovery per evidence epoch: advisory context for the next
  // decision, never a rejected call. Further low-yield reads in the same epoch
  // fall through to the existing watchdog/park ladder.
  let bounce = null;
  if (state.lowYieldStreak >= READ_SPAM_BOUNCE_STREAK && state.bounceEpoch !== state.evidenceEpoch) {
    state.bounceEpoch = state.evidenceEpoch;
    bounce = { source: 'evidence_repetition', demand: NOTICE_TEXT.bounce };
  }

  return {
    state,
    notice,
    bounce,
    assessment: { ...classification, tier, newEvidence, lowYield, sprawl, evidenceClaimStall, phase: state.phase }
  };
}

module.exports = {
  NOTICE_MAX_CHARS,
  NOTICE_TEXT,
  PHASES,
  LOW_NOVELTY,
  THINKING_TIERS,
  createFlowControlState,
  normalizeFlowControlState,
  resetFlowControlForUserTurn,
  captureEvidence,
  scoreEvidenceNovelty,
  isRelevant,
  touchedPathsFromCall,
  thinkingBudgetTier,
  thinkingBudgetNotice,
  classifyDecision,
  assessFlowControl,
  taskKey
};
