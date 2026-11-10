'use strict';

const { CONFIDENCE_GATE, createLayaVerifier } = require('./layaDecision.cjs');

const DEFAULT_JEV_BASE_URL = 'https://api.typesafe.ai/v1';
const DEFAULT_JEV_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 2_000;

function browserState({ observation, action, task }) {
  const dom = observation?.dom || {};
  const elements = Array.isArray(dom.elements) ? dom.elements : [];
  return {
    last_action: String(action?.name || 'none').slice(0, 60),
    action_ok: Boolean(action?.ok),
    url: String(dom.url || observation?.navigation?.url || '').slice(0, 300),
    title: String(dom.title || '').slice(0, 200),
    controls: elements.slice(0, 12)
      .map((element) => `${element?.tag || ''} ${String(element?.name || element?.text || '').slice(0, 60)}`)
      .join(' | '),
    controls_count: elements.length,
    candidates: elements.slice(0, 12)
      .map((element) => `${String(element?.name || element?.text || '').slice(0, 60)} (${element?.tag || ''})`)
      .filter((label) => label.trim() !== '()'),
    task: String(task || '').slice(0, 500)
  };
}

function computerState({ observation, action, task }) {
  const windows = Array.isArray(observation?.desktop?.windows) ? observation.desktop.windows : [];
  return {
    last_action: String(action?.name || 'none').slice(0, 60),
    action_ok: Boolean(action?.ok),
    foreground: String(observation?.desktop?.foregroundWindowId || '').slice(0, 40),
    windows: windows.slice(0, 10).map((window) => `${String(window?.title || '').slice(0, 60)} at ${window?.bounds?.x || 0},${window?.bounds?.y || 0} ${window?.bounds?.width || 0}x${window?.bounds?.height || 0}`).join(' | '),
    new_window_ids: JSON.stringify(observation?.newWindowIds || []),
    candidates: windows.slice(0, 10).map((window) => String(window?.title || '').slice(0, 60)).filter(Boolean),
    task: String(task || '').slice(0, 500)
  };
}

function browserQuestions(state) {
  const criteria = Array.isArray(state?.candidates) && state.candidates.length
    ? Object.fromEntries(state.candidates.slice(0, 12).map((label) => [label, null]))
    : { 'none of them help': null };
  return {
    page_changed: { type: 'noul', instructions: 'Compared with the state before the last action, did the page state change?' },
    effect_visible: { type: 'noul', instructions: 'Does the current page state show the expected effect of the last action?' },
    needs_attention: { type: 'noul', instructions: 'Does the page look blocked or ambiguous and require close inspection?' },
    best_next_target: { type: 'choice', instructions: 'Which candidate control best advances the task now?', criteria }
  };
}

function computerQuestions(state) {
  const criteria = Array.isArray(state?.candidates) && state.candidates.length
    ? Object.fromEntries(state.candidates.slice(0, 10).map((label) => [label, null]))
    : { 'none of them help': null };
  return {
    new_window: { type: 'noul', instructions: 'Compared with the previous inventory, is a new application window present?' },
    target_foreground: { type: 'noul', instructions: 'Is the target window now the foreground window?' },
    dialog_open: { type: 'noul', instructions: 'Is a dialog, picker, or modal window open on screen?' },
    best_next_target: { type: 'choice', instructions: 'Which candidate window best advances the task now?', criteria }
  };
}

function answerConfidence(answer) {
  const explicit = Number(answer?.confidence ?? answer?.probability);
  if (Number.isFinite(explicit)) return explicit;
  // Jev's noul primitive returns a yes probability rather than a separate
  // confidence. Distance from 0.5 is its calibrated certainty signal.
  const noul = Number(answer?.noul);
  return Number.isFinite(noul) ? Math.abs(noul - 0.5) * 2 : 0;
}

function normalizeAnswers(rawAnswers) {
  if (!rawAnswers || typeof rawAnswers !== 'object' || Array.isArray(rawAnswers)) throw new Error('Jev response did not contain an answers object.');
  const answers = {};
  for (const [name, answer] of Object.entries(rawAnswers)) {
    if (!answer || typeof answer !== 'object') continue;
    const confidence = answerConfidence(answer);
    if (confidence < CONFIDENCE_GATE) continue;
    const value = answer.noul ?? answer.choice ?? answer.score ?? null;
    if (value === null || value === undefined) continue;
    answers[name] = {
      value,
      confidence: Number(confidence.toFixed(3)),
      ...(answer.evidence ? { evidence: String(answer.evidence).slice(0, 200) } : {})
    };
  }
  return answers;
}

function createJevVerifier({
  baseUrl = DEFAULT_JEV_BASE_URL,
  modelId = DEFAULT_JEV_MODEL,
  apiKey = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = null,
  now = Date.now,
  fallback = null
} = {}) {
  const fallbackVerifier = fallback || createLayaVerifier({ now });
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const base = String(baseUrl || DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
  const model = String(modelId || DEFAULT_JEV_MODEL).trim() || DEFAULT_JEV_MODEL;
  const key = String(apiKey || '').trim();
  let inflight = null;

  async function request(state, questions, signal, { raw = false } = {}) {
    if (!key) throw new Error('Jev API key is not configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new Error('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const response = await doFetch(`${base}/systemone`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ state, model, questions }),
        signal: controller.signal
      });
      if (!response?.ok) throw new Error(`Jev HTTP ${response?.status || 0}`);
      const payload = await response.json();
      // raw: confirmAction applies its own stricter gate; the 0.6 confidence
      // normalization must not silently drop the answer first.
      return { answers: raw ? (payload?.answers && typeof payload.answers === 'object' ? payload.answers : null) : normalizeAnswers(payload?.answers), tookMs: Number(payload?.usage?.tookMs ?? payload?.tookMs ?? 0) || null, brain: 'jev' };
    } finally {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async function verify(input = {}) {
    if (input.signal?.aborted || !input.observation) return null;
    const domain = input.domain === 'computer' ? 'computer' : 'browser';
    const state = domain === 'computer'
      ? computerState(input)
      : browserState(input);
    const questions = domain === 'computer' ? computerQuestions(state) : browserQuestions(state);
    try {
      if (!inflight) inflight = request(state, questions, input.signal).finally(() => { inflight = null; });
      const payload = await inflight;
      return { layer: 'jev', brain: payload.brain, answers: payload.answers, used: Object.keys(payload.answers).length > 0, tookMs: payload.tookMs, model };
    } catch {
      // Jev is an accelerator, never a run dependency. The bundled Laya
      // verifier preserves the existing fail-silent behavior on bad keys,
      // timeouts, rate limits, and malformed provider responses.
      return fallbackVerifier.verify(input);
    }
  }

  // Fast-path gate (LORDE_FAST_PATH): one typed noul question asking whether
  // the model's already-decided action should execute IMMEDIATELY — before the
  // decision stream finishes. Fail-closed on any error: the agent then simply
  // waits for the normal buffered decision.
  async function confirmAction({ action, task, observation, signal } = {}) {
    const name = String(action?.name || '').slice(0, 60);
    if (!name) return { ok: false, reason: 'no action' };
    const dom = observation?.dom || {};
    const inputSummary = JSON.stringify(action?.input || {}).slice(0, 300);
    try {
      const payload = await request({
        action: `${name} ${inputSummary}`,
        url: String(dom.url || observation?.navigation?.url || '').slice(0, 300),
        title: String(dom.title || '').slice(0, 200),
        task: String(task || '').slice(0, 500)
      }, {
        execute_now: {
          type: 'noul',
          instructions: 'The assistant already decided this action. Should it be executed immediately right now: is it correct for the current page state and non-destructive (no data loss, no irreversible side effect)? Answer no if the action looks premature, wrong for this state, or destructive.'
        }
      }, signal, { raw: true });
      const answer = payload.answers?.execute_now;
      const noul = Number(answer?.noul ?? answer?.value);
      if (!Number.isFinite(noul)) return { ok: false, reason: 'unparseable' };
      const gate = Math.min(0.99, Math.max(0.5, Number(process.env.BROWSER_USE_FAST_PATH_GATE) || 0.8));
      return { ok: noul >= gate, noul };
    } catch {
      return { ok: false, reason: 'unavailable' };
    }
  }

  return { verify, confirmAction, get healthy() { return true; }, brain: 'jev', baseUrl: base, modelId: model };
}

// System-One-drives planner brain (LORDE_JEV_PLANNER): maps Jev's typed
// answers onto the Laya answer contract so the standalone provider (provider
// off) can consult Jev before the bundled engine. noul probabilities become
// calibrated certainty (distance from 0.5); choice confidences pass through.
function createJevPredictor({ baseUrl = DEFAULT_JEV_BASE_URL, modelId = DEFAULT_JEV_MODEL, apiKey = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const base = String(baseUrl || DEFAULT_JEV_BASE_URL).replace(/\/+$/, '');
  const model = String(modelId || DEFAULT_JEV_MODEL).trim() || DEFAULT_JEV_MODEL;
  const key = String(apiKey || '').trim();
  return async function predict(state, questions) {
    if (!key) throw new Error('Jev API key is not configured.');
    const response = await doFetch(`${base}/systemone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ state, model, questions }),
      signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
    });
    if (!response?.ok) throw new Error(`Jev HTTP ${response?.status || 0}`);
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || !payload.answers) throw new Error('Jev payload malformed');
    const answers = {};
    for (const [name, answer] of Object.entries(payload.answers || {})) {
      if (!answer || typeof answer !== 'object') continue;
      const noul = Number(answer.noul);
      const explicit = Number(answer.confidence);
      const confidence = Number.isFinite(explicit) ? explicit : (Number.isFinite(noul) ? Number((Math.abs(noul - 0.5) * 2).toFixed(3)) : 0);
      answers[name] = { ...answer, confidence };
    }
    return { answers, tookMs: Number(payload?.usage?.tookMs ?? 0) || null };
  };
}

module.exports = {
  DEFAULT_JEV_BASE_URL,
  DEFAULT_JEV_MODEL,
  DEFAULT_TIMEOUT_MS,
  browserState,
  computerState,
  normalizeAnswers,
  createJevVerifier,
  createJevPredictor
};
