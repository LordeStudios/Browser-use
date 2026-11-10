'use strict';

// Laya decision layer (opt-in): a System One accelerator that answers
// mechanical confirmation questions about a fresh observation in one pass, so
// the strong API model stops spending whole decisions on "did the effect
// land?" round trips. The strong model keeps full planning authority; Laya's
// answers ride along as typed annotations with calibrated confidences, and
// anything below the confidence gate is simply omitted (the strong model then
// decides as it always did).
//
// One system: the bundled in-process engine (layaEngine.cjs) answers by
// default. An external sidecar (laya-server/server.py, for the real
// checkpoint) stays an optional accelerator — set layaEndpoint and it is
// consulted first, with the bundled engine silently taking over whenever the
// sidecar is absent or slow. The result labels which brain answered
// (`brain: 'bundled' | 'sidecar'`).

// 450ms was measured against a GPU sidecar (~33ms per predict). A CPU
// checkpoint answers in ~490ms warm — just past 450ms, so the real brain
// would time out on every decision and the 60s cooldown would park it,
// silently forcing the bundled engine forever on CPU-only machines. The
// verify rides CONCURRENTLY with the provider call and never blocks a
// decision (its answer lands on the next decision), so a generous timeout
// costs zero latency; it only bounds how late an annotation can arrive.
const DEFAULT_TIMEOUT_MS = 2000;
const CONFIDENCE_GATE = 0.6;

// Typed question templates. One predict call answers all questions.
function browserQuestions() {
  return {
    page_changed: { type: 'noul', instructions: 'Compared with the state before the last action, did the page state change (new content, new controls, navigation, or dialog)?' },
    effect_visible: { type: 'noul', instructions: 'Does the current page state show the kind of effect a click, typing, or form action normally produces (changed values, opened panels, new elements, navigation)?' },
    needs_attention: { type: 'noul', instructions: 'Does the page state look blocked or ambiguous (consent screen, captcha, error message, empty body) such that a strong model must look closely?' },
    // Laya's strongest area: goal-overlap RANKING of the current observation's
    // candidate controls against the task (see bestActionAnswer).
    best_next_target: { type: 'choice', instructions: 'Which candidate control best advances the task right now?' },
    // Composite verification (LORDE_COMPOSITE_VERIFY): one pass answers all
    // verification dimensions instead of N sequential model decisions.
    task_progressed: { type: 'noul', instructions: 'Given the task and the current state, has the work progressed toward the goal since the last action?' },
    needs_verification: { type: 'noul', instructions: 'Does the current state suggest the last action needs further verification before the task can be considered done?' }
  };
}

function computerQuestions() {
  return {
    new_window: { type: 'noul', instructions: 'Compared with the window inventory before the last action, is at least one new application window now present?' },
    target_foreground: { type: 'noul', instructions: 'Is the window that was the target of the last action the foreground window now?' },
    dialog_open: { type: 'noul', instructions: 'Is a dialog, picker, or modal window now open on screen?' },
    best_next_target: { type: 'choice', instructions: 'Which candidate window should receive the next action?' },
    // Composite verification for coding/desktop work.
    task_progressed: { type: 'noul', instructions: 'Given the task and the current desktop state, has the work progressed toward the goal since the last action?' },
    needs_verification: { type: 'noul', instructions: 'Does the current state suggest the last action needs further verification before the task can be considered done?' }
  };
}

// LORDE_CODING_VERIFY_V1 — composite verification for coding tasks. One
// predict call answers all verification dimensions (patch applied, test
// passes, no regressions, UI correct) instead of N sequential model decisions.
function codingVerifyQuestions() {
  return {
    patch_applied: { type: 'noul', instructions: 'Given the code state and the task, has the patch/edit been applied correctly?' },
    test_passes: { type: 'noul', instructions: 'Does the code state indicate the relevant test passes or the build compiles cleanly?' },
    no_regressions: { type: 'noul', instructions: 'Are there signs of new errors, regressions, or broken functionality in the current state?' },
    goal_achieved: { type: 'noul', instructions: 'Does the current state match the task goal — is the work done to specification?' }
  };
}

function browserState({ observation, action, previous, task }) {
  const dom = observation?.dom || {};
  const elements = Array.isArray(dom.elements) ? dom.elements : [];
  return {
    last_action: String(action?.name || 'none').slice(0, 60),
    action_ok: Boolean(action?.ok),
    url: String(dom.url || observation?.navigation?.url || '').slice(0, 300),
    title: String(dom.title || '').slice(0, 200),
    controls: elements.slice(0, 12)
      .map(element => `${element?.tag || ''} ${String(element?.name || element?.text || '').slice(0, 60)}`).join(' | '),
    controls_count: elements.length,
    // Ranking candidates: the interactive controls Laya scores against the
    // task's goal tokens (bestActionAnswer picks by overlap + margin).
    candidates: elements.slice(0, 12)
      .map(element => `${String(element?.name || element?.text || '').slice(0, 60)} (${element?.tag || ''})`)
      .filter(label => label.trim() !== '()'),
    task: String(task || '').slice(0, 500),
    ...(previous ? { prev_url: previous.url, prev_title: previous.title, prev_controls_count: previous.controlsCount } : {})
  };
}

function computerState({ observation, action, task }) {
  const windows = Array.isArray(observation?.desktop?.windows) ? observation.desktop.windows : [];
  return {
    last_action: String(action?.name || 'none').slice(0, 60),
    action_ok: Boolean(action?.ok),
    foreground: String(observation?.desktop?.foregroundWindowId || '').slice(0, 40),
    windows: windows.slice(0, 10).map(window => `${String(window?.title || '').slice(0, 60)} at ${window?.bounds?.x || 0},${window?.bounds?.y || 0} ${window?.bounds?.width || 0}x${window?.bounds?.height || 0}`).join(' | '),
    new_window_ids: JSON.stringify(observation?.newWindowIds || []),
    candidates: windows.slice(0, 10).map(window => String(window?.title || '').slice(0, 60)).filter(Boolean),
    task: String(task || '').slice(0, 500)
  };
}

function browserDigest(observation) {
  const dom = observation?.dom || {};
  return {
    url: String(dom.url || observation?.navigation?.url || ''),
    title: String(dom.title || ''),
    controlsCount: Array.isArray(dom.elements) ? dom.elements.length : 0
  };
}

function computerDigest(observation) {
  return {
    foreground: String(observation?.desktop?.foregroundWindowId || ''),
    windowIds: (Array.isArray(observation?.desktop?.windows) ? observation.desktop.windows : []).map(window => String(window?.id || ''))
  };
}

// LORDE_CODING_VERIFY_V1 — build the state for composite coding verification.
// Carries terminal output, patch diff, and task text so the engine can score
// each dimension mechanically in one forward pass.
function codingVerifyState({ observation, action, task, terminalOutput = '', patchResult = '' }) {
  const dom = observation?.dom || {};
  return {
    last_action: String(action?.name || 'none').slice(0, 60),
    action_ok: Boolean(action?.ok),
    url: String(dom.url || observation?.navigation?.url || '').slice(0, 300),
    title: String(dom.title || '').slice(0, 200),
    terminal_output: String(terminalOutput || '').slice(-2_000),
    diff: String(patchResult || '').slice(-1_500),
    task: String(task || '').slice(0, 500)
  };
}

// LORDE_PROGRESS_VERIFY — build state for task progression verification.
function progressVerifyState({ observation, action, previous, task }) {
  return browserState({ observation, action, previous, task });
}

function createLayaVerifier({ endpoint = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, now = Date.now, engine = null } = {}) {
  const bundled = engine || lazyEngine();
  // HTTP is only engaged when explicitly configured (endpoint or an injected
  // fetch for tests); everything else is answered in-process.
  const useHttp = Boolean(fetchImpl) || Boolean(String(endpoint || '').trim());
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const base = String(endpoint || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  let previous = null;
  let inflight = null;
  // Sidecar protection: an aborted (timed-out) predict still executes
  // server-side — a CPU checkpoint slower than the timeout would pile aborted
  // torch jobs onto the queue and saturate a core. Two timeouts in a row park
  // the HTTP path for a minute; the bundled engine answers instantly instead.
  let httpCooldownUntil = 0;
  let timeoutsInARow = 0;

  function lazyEngine() {
    const { createLayaEngine } = require('./layaEngine.cjs');
    return createLayaEngine({ now });
  }

  async function httpPredict(state, questions, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new Error('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await doFetch(`${base}/predict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, questions }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`laya HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || !payload.answers) throw new Error('laya payload malformed');
      return payload;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  // Sidecar first when configured; the bundled engine is the always-there
  // fallback, so a dead or slow sidecar degrades instead of disabling Laya.
  async function predict(state, questions, signal) {
    if (!useHttp || now() < httpCooldownUntil) {
      const payload = bundled.predict({ state, questions });
      return { ...payload, brain: 'bundled' };
    }
    try {
      const payload = await httpPredict(state, questions, signal);
      timeoutsInARow = 0;
      return { answers: payload.answers, tookMs: Number(payload.tookMs ?? 0) || null, brain: 'sidecar' };
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error?.name === 'AbortError' || /abort|timeout/i.test(String(error?.message || error))) {
        timeoutsInARow += 1;
        if (timeoutsInARow >= 2) {
          httpCooldownUntil = now() + 60_000;
          timeoutsInARow = 0;
        }
      } else {
        timeoutsInARow = 0;
      }
      const payload = bundled.predict({ state, questions });
      return { ...payload, brain: 'bundled' };
    }
  }

  // Verify one fresh observation. Never throws; returns null when the caller
  // aborted — the strong model then sees exactly what it would have seen
  // without this layer. Tracks the previous state digest internally so the
  // engine can diff mechanical effects between decisions.
  async function verify({ observation, action, domain, task, signal = null } = {}) {
    if (signal?.aborted) return null;
    if (!observation) return null;
    try {
      const isComputer = domain === 'computer';
      const state = isComputer
        ? computerState({ observation, action, task })
        : browserState({ observation, action, previous, task });
      const questions = isComputer ? computerQuestions() : browserQuestions();
      // One predict per observation; identical in-flight calls share.
      if (!inflight) {
        inflight = predict(state, questions, signal).finally(() => { inflight = null; });
      }
      const payload = await inflight;
      previous = isComputer ? computerDigest(observation) : browserDigest(observation);
      const answers = {};
      for (const [name, answer] of Object.entries(payload.answers || {})) {
        const confidence = Number(answer?.confidence ?? answer?.probability ?? 0);
        if (confidence >= CONFIDENCE_GATE) {
          answers[name] = {
            value: answer.noul ?? answer.choice ?? answer.score ?? null,
            confidence: Number(confidence.toFixed(3)),
            ...(answer.evidence ? { evidence: String(answer.evidence).slice(0, 200) } : {})
          };
        }
      }
      // LORDE_LAYA_VISIBLE_V369 — all-abstain results used to return an empty
      // answers object (invisible everywhere). Mark them so the run can show
      // the layer is alive and WHY it is not advising.
      return { layer: 'laya', brain: payload.brain || 'bundled', answers, used: Object.keys(answers).length > 0, tookMs: Number(payload.tookMs ?? 0) || null };
    } catch (error) {
      if (signal?.aborted) return null;
      return null;
    }
  }

  // LORDE_CODING_VERIFY_V1 — composite coding verification. One predict call
  // answers all verification dimensions (patch_applied, test_passes,
  // no_regressions, goal_achieved) so the model doesn't need N sequential
  // decisions to confirm a patch. Returns null on any failure (fail-silent).
  async function verifyCoding({ observation, action, task, terminalOutput = '', patchResult = '', signal = null } = {}) {
    if (signal?.aborted) return null;
    try {
      const state = codingVerifyState({ observation, action, task, terminalOutput, patchResult });
      const questions = codingVerifyQuestions();
      const payload = await predict(state, questions, signal);
      const answers = {};
      for (const [name, answer] of Object.entries(payload.answers || {})) {
        const confidence = Number(answer?.confidence ?? 0);
        if (confidence >= CONFIDENCE_GATE) {
          answers[name] = {
            value: answer.noul ?? answer.choice ?? answer.score ?? null,
            confidence: Number(confidence.toFixed(3)),
            ...(answer.evidence ? { evidence: String(answer.evidence).slice(0, 200) } : {})
          };
        }
      }
      return { layer: 'coding', brain: payload.brain || 'bundled', answers, used: Object.keys(answers).length > 0, tookMs: Number(payload.tookMs ?? 0) || null };
    } catch {
      return null;
    }
  }

  return { verify, verifyCoding, get healthy() { return true; } };
}

module.exports = { createLayaVerifier, browserQuestions, computerQuestions, codingVerifyQuestions, codingVerifyState, progressVerifyState, CONFIDENCE_GATE, DEFAULT_TIMEOUT_MS };
