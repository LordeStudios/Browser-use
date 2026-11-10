'use strict';

// Bundled System One engine: the in-process brain behind the Laya decision
// layer. One system, no external dependencies — the app ships this engine, and
// an external sidecar (laya-server/server.py, for the real checkpoint) remains
// an optional accelerator via layaEndpoint.
//
// Contract parity with the sidecar: predict({state, questions}) returns
// {answers: {name: {noul|choice|score, confidence}}, tookMs}. Answers below
// the caller's confidence gate are dropped by the callers, so this engine only
// speaks when it has real evidence in the state it receives. It never invents
// evidence it cannot see: undecidable questions get low confidence and are
// omitted, leaving the decision to whoever asked.

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'of', 'my', 'me', 'please', 'then', 'with', 'using', 'use', 'into', 'from', 'that', 'this', 'it', 'is', 'are', 'was', 'be', 'new', 'current', 'currently']);
const ACTION_VERBS = new Set(['open', 'start', 'launch', 'run', 'click', 'press', 'type', 'enter', 'go', 'navigate', 'browse', 'visit', 'check', 'make', 'create', 'draw', 'add', 'set', 'select', 'find', 'search', 'buy', 'install', 'boot', 'fire', 'place']);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9.#-]*/g)?.filter(token => token.length >= 2) || [];
}

// Goal tokens: what the task is ABOUT (objects and qualifiers, not verbs).
function goalTokens(task) {
  return [...new Set(tokenize(task).filter(token => !STOPWORDS.has(token) && !ACTION_VERBS.has(token) && !/^\d+$/.test(token)))];
}

function normalizeToken(token) {
  return token.replace(/(?:ings|ing|ies|es|s)$/, '');
}

function overlap(goalTokensList, haystackTokens) {
  const hay = new Set(haystackTokens.map(normalizeToken));
  let matched = 0;
  for (const token of goalTokensList) if (hay.has(normalizeToken(token))) matched += 1;
  return { matched, total: goalTokensList.length };
}

const BLOCKED_PATTERN = /\b(?:captcha|error|not found|denied|blocked|unavailable|forbidden|service unavailable|access denied)\b/i;
const DIALOG_PATTERN = /\b(?:dialog|open|save as|save image|select|picker|prompt|confirm|are you sure|settings wizard|print)\b/i;
// Launch intent: "open X", "start X", also mid-task after "and/then", and the
// glued typo form ("Youopen photoshop") where a prefix is stuck to the verb.
const LAUNCH_PATTERN = /(?:^|\b(?:and|then|please|you)\s+)?\b(?:open|start|launch|run|fire up|boot)\s+([^,;.]{2,60})/i;
const GLUED_LAUNCH_PATTERN = /^\w*?(?:open|start|launch|boot)\s+([^,;.]{2,60})/i;

function launchTarget(task) {
  const match = String(task || '').match(LAUNCH_PATTERN) || String(task || '').match(GLUED_LAUNCH_PATTERN);
  if (!match) return null;
  const target = match[1].replace(/^(?:the|my|a|an)\s+/i, '').replace(/["']/g, '').replace(/[.!?]+$/, '').trim();
  return target || null;
}

function tookMs(startedAt, now) {
  return Math.max(1, now() - startedAt);
}

// --- Verify answers (the state builders supply everything observable) ---

function browserVerifyAnswers(state) {
  const answers = {};
  const controlsCount = Number(state.controls_count ?? 0);
  const prev = state.prev_url !== undefined || state.prev_title !== undefined || state.prev_controls_count !== undefined;
  const changed = prev && (state.url !== state.prev_url || state.title !== state.prev_title || controlsCount !== Number(state.prev_controls_count ?? 0));
  // page_changed: only decidable with a previous digest; otherwise abstain.
  // A confident YES rests on a hard diff (url/title/count all recorded); a NO
  // is deliberately weaker — same url/title/count still misses in-page swaps,
  // so it barely clears the gate and carries its evidence.
  if (changed === true) answers.page_changed = { noul: 1, confidence: 0.9, evidence: 'url/title/control-count differ from the previous decision' };
  else if (prev) answers.page_changed = { noul: 0, confidence: 0.62, evidence: 'url, title and control count are all unchanged' };
  else answers.page_changed = { noul: 0.5, confidence: 0.4 };

  // effect_visible: "controls exist" is weak evidence for YES (omitted unless
  // the diff also moved); an empty DOM is solid evidence for NO.
  if (controlsCount > 0) {
    if (changed === true) answers.effect_visible = { noul: 1, confidence: 0.75, evidence: 'controls appeared/changed alongside the state diff' };
  } else {
    answers.effect_visible = { noul: 0, confidence: 0.75, evidence: 'zero interactive elements in the fresh DOM' };
  }

  const blocked = BLOCKED_PATTERN.test(`${state.title || ''} ${state.controls || ''}`);
  answers.needs_attention = blocked
    ? { noul: 1, confidence: 0.75, evidence: 'blocked/error marker text in title or controls' }
    : { noul: 0, confidence: 0.62, evidence: 'no blocked/error marker text found' };
  return answers;
}

function computerVerifyAnswers(state) {
  const answers = {};
  let newIds = [];
  try { newIds = JSON.parse(state.new_window_ids || '[]'); } catch { newIds = []; }
  if (newIds.length > 0) answers.new_window = { noul: 1, confidence: 0.95, evidence: `the waitMs list reported new window ids` };
  else answers.new_window = { noul: 0, confidence: 0.85, evidence: 'the waitMs list reported no new window ids' };

  const foreground = String(state.foreground || '');
  if (newIds.map(String).includes(foreground)) answers.target_foreground = { noul: 1, confidence: 0.9, evidence: 'the foreground window is one of the new window ids' };
  else if (!foreground) answers.target_foreground = { noul: 0, confidence: 0.8, evidence: 'no foreground window reported' };
  else answers.target_foreground = { noul: 0.5, confidence: 0.4 }; // target window identity is not in the state

  const dialog = DIALOG_PATTERN.test(String(state.windows || ''));
  answers.dialog_open = dialog
    ? { noul: 1, confidence: 0.8, evidence: 'a window title matches a dialog/picker pattern' }
    : { noul: 0, confidence: 0.55 };
  return answers;
}

// LORDE_CODING_VERIFY_V1 — composite coding verification. The state carries
// terminal output, file diffs, and task text; the engine scores each dimension
// mechanically. Below-gate answers are omitted so the strong model decides.
function codingVerifyAnswers(state) {
  const answers = {};
  const terminal = String(state.terminal_output || state.output || '');
  const diff = String(state.diff || state.patch_result || '');
  const task = String(state.task || '');
  const errorPattern = /\b(?:error|failed|failure|exception|traceback|panic|fatal)\b/i;
  const passPattern = /\b(?:pass(?:ed|ing)?|ok(?:ay)?|success(?:ful)?|compiles?|clean|build\s+(?:ok|succeeded))\b/i;

  // patch_applied: diff evidence or terminal output showing a change.
  if (diff.trim() && !errorPattern.test(diff)) answers.patch_applied = { noul: 1, confidence: 0.75, evidence: 'diff/patch result shows a non-error change' };
  else if (diff.trim() && errorPattern.test(diff)) answers.patch_applied = { noul: 0, confidence: 0.7, evidence: 'diff/patch result contains error markers' };

  // test_passes: terminal output with pass markers and no failures.
  if (terminal.trim()) {
    const hasPass = passPattern.test(terminal);
    const hasFail = errorPattern.test(terminal) && /(?:failed|failure|error)\s*[:=]\s*[1-9]/i.test(terminal);
    if (hasPass && !hasFail) answers.test_passes = { noul: 1, confidence: 0.8, evidence: 'terminal shows pass/ok markers with no counted failures' };
    else if (hasFail) answers.test_passes = { noul: 0, confidence: 0.85, evidence: 'terminal shows counted failures/errors' };
  }

  // no_regressions: no error markers in terminal or diff.
  const anyError = errorPattern.test(terminal) || errorPattern.test(diff);
  answers.no_regressions = anyError
    ? { noul: 0, confidence: 0.7, evidence: 'error/failure markers present in terminal or diff' }
    : { noul: 1, confidence: 0.65, evidence: 'no error/failure markers found in available output' };

  // goal_achieved: overlap of task goal tokens with the combined state text.
  const tokens = goalTokens(task);
  const haystack = `${state.url || ''} ${state.title || ''} ${terminal.slice(-500)} ${diff.slice(-300)}`;
  const { matched, total } = overlap(tokens, tokenize(haystack));
  const fraction = total > 0 ? matched / total : 0;
  if (fraction >= 0.8) answers.goal_achieved = { noul: 1, confidence: 0.75, evidence: `goal-token overlap ${Math.round(fraction * 100)}%` };
  else if (fraction <= 0.2) answers.goal_achieved = { noul: 0, confidence: 0.7, evidence: `goal-token overlap only ${Math.round(fraction * 100)}%` };
  return answers;
}

// LORDE_PROGRESS_VERIFY — task progression check for browser/desktop states.
function progressVerifyAnswers(state) {
  const answers = {};
  const haystack = `${state.url || ''} ${state.title || ''} ${state.controls || ''} ${state.windows || ''} ${state.foreground || ''}`;
  const hasChange = state.prev_url !== undefined
    ? (state.url !== state.prev_url || state.title !== state.prev_title)
    : false;
  const taskTokens = goalTokens(state.task || '');
  const { matched, total } = overlap(taskTokens, tokenize(haystack));
  const fraction = total > 0 ? matched / total : 0;

  if (hasChange && fraction > 0.2) answers.task_progressed = { noul: 1, confidence: 0.75, evidence: 'state changed and goal tokens are present' };
  else if (hasChange) answers.task_progressed = { noul: 1, confidence: 0.62, evidence: 'state changed since last action' };
  else if (fraction > 0.4) answers.task_progressed = { noul: 1, confidence: 0.6, evidence: 'goal tokens present despite no state diff' };

  const blocked = BLOCKED_PATTERN.test(haystack);
  answers.needs_verification = blocked
    ? { noul: 1, confidence: 0.75, evidence: 'blocked/error markers suggest verification needed' }
    : { noul: 0, confidence: 0.6, evidence: 'no blocked/error markers found' };
  return answers;
}

// --- Standalone policy answers ---

function taskCompleteAnswer(state, task) {
  const tokens = goalTokens(task);
  if (tokens.length === 0) return { noul: 0.5, confidence: 0.4 };
  // Nothing has been dispatched yet — the goal cannot be achieved.
  if (String(state.last_action || 'none') === 'none') return { noul: 0, confidence: 0.85 };
  // Completion evidence is the state OUTCOME surfaces (navigation target,
  // window inventory) — never the clickable labels, or the "Place order"
  // button would satisfy "place the order" before it was ever clicked.
  const haystack = `${state.url || ''} ${state.title || ''} ${state.windows || ''} ${state.foreground || ''}`;
  const { matched, total } = overlap(tokens, tokenize(haystack));
  const fraction = matched / total;
  if (fraction === 1) return { noul: 1, confidence: 0.9 };
  if (fraction >= 0.6) return { noul: 1, confidence: 0.7 };
  return { noul: 0, confidence: 0.6 };
}

function bestActionAnswer(state, task, candidates) {
  const tokens = goalTokens(task);
  const target = launchTarget(task);
  const targetTokens = target ? tokenize(target) : [];
  let bestIndex = -1;
  let bestScore = 0;
  let secondScore = 0;
  candidates.forEach((candidate, index) => {
    const label = typeof candidate === 'string' ? candidate : String(candidate?.label || '');
    const labelTokens = tokenize(label);
    let score = overlap(tokens, labelTokens).matched;
    // Launch-first policy: an explicit open/start target outranks generic matches.
    if (candidate.launch && target && overlap(targetTokens, labelTokens).matched > 0) score += 1.5;
    if (score > bestScore) { secondScore = bestScore; bestScore = score; bestIndex = index; }
    else if (score > secondScore) secondScore = score;
  });
  if (bestIndex === -1 || bestScore <= 0) return { choice: 'none of them help', confidence: 0.9 };
  const margin = (bestScore - secondScore) / bestScore;
  const confidence = Math.min(0.95, 0.62 + 0.3 * margin + (bestScore >= 2 ? 0.05 : 0));
  // The choice answer is the candidate LABEL (criteria key), matching the real
  // Laya contract where a choice returns one of the criteria keys.
  return { choice: candidates[bestIndex], confidence: Number(confidence.toFixed(3)) };
}

function createLayaEngine({ now = Date.now } = {}) {
  // Contract twin of laya-server/server.py: one predict call answers all
  // questions with typed values and calibrated confidences.
  function predict({ state = {}, questions = {} } = {}) {
    const startedAt = now();
    const answers = {};
    for (const [name, question] of Object.entries(questions)) {
      const type = question?.type;
      if (type === 'noul') {
        if (name === 'page_changed' || name === 'effect_visible' || name === 'needs_attention') answers[name] = browserVerifyAnswers(state)[name];
        else if (name === 'new_window' || name === 'target_foreground' || name === 'dialog_open') answers[name] = computerVerifyAnswers(state)[name];
        else if (name === 'task_complete') answers[name] = taskCompleteAnswer(state, state.task || question.instructions || '');
        else if (name === 'task_progressed' || name === 'needs_verification') answers[name] = progressVerifyAnswers(state)[name];
        else if (name === 'patch_applied' || name === 'test_passes' || name === 'no_regressions' || name === 'goal_achieved') answers[name] = codingVerifyAnswers(state)[name];
        else answers[name] = { noul: 0.5, confidence: 0.4 }; // unknown noul question: abstain
      } else if (type === 'choice') {
        answers[name] = bestActionAnswer(state, state.task || '', Array.isArray(state.candidates) ? state.candidates : []);
      } else {
        answers[name] = { score: 0, confidence: 0.4 };
      }
    }
    return { answers, tookMs: tookMs(startedAt, now) };
  }
  return { predict };
}

module.exports = { createLayaEngine, goalTokens, launchTarget, STOPWORDS, ACTION_VERBS };
