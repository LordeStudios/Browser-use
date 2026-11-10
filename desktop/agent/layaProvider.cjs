'use strict';

// Laya standalone provider (opt-in, provider disable): when the strong API
// model is turned off in settings (providerEnabled=false), the agent's
// commands go straight to Laya. This is the System One policy loop for
// stress-testing: every decision asks Laya typed questions over the candidate
// actions the current state offers and executes the confident answer.
//
// One system: the bundled in-process engine (layaEngine.cjs) decides by
// default; a configured sidecar endpoint (for the real checkpoint) is
// consulted first with the engine as the always-there fallback. Every decision
// records which brain answered (`laya.brain`).

const DEFAULT_TIMEOUT_MS = 2000;
const CONFIDENCE_GATE = 0.6;
const MAX_CANDIDATES = 12;
const LAUNCH_WAIT_MS = 30_000; // catalog cap; Store apps like Win11 Notepad can take 25s+ on first paint

const CLICKABLE_TAGS = new Set(['button', 'a', 'select', 'label']);
const CLICKABLE_INPUT_TYPES = new Set(['button', 'submit', 'checkbox', 'radio']);
const CLICKABLE_ROLES = new Set(['button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch']);

function elementLabel(element) {
  const text = String(element?.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const name = String(element?.name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${element?.tag || 'node'}${element?.role ? `[${element.role}]` : ''} "${text || name || 'unlabeled'}"`;
}

function isClickable(element) {
  if (element?.enabled === false) return false;
  const tag = String(element?.tag || '').toLowerCase();
  const role = String(element?.role || '').toLowerCase();
  const type = String(element?.type || '').toLowerCase();
  return CLICKABLE_TAGS.has(tag) || CLICKABLE_ROLES.has(role) || (tag === 'input' && CLICKABLE_INPUT_TYPES.has(type));
}

function candidateActions({ dom }) {
  const candidates = [];
  const elements = Array.isArray(dom?.elements) ? dom.elements : [];
  for (const element of elements) {
    if (!isClickable(element)) continue;
    const index = Number(element.index);
    if (!Number.isInteger(index) || index < 0) continue;
    candidates.push({ name: 'browser_click', input: { element: index }, label: `click ${elementLabel(element)}` });
    if (candidates.length >= MAX_CANDIDATES - 2) break;
  }
  candidates.push({ name: 'browser_scroll', input: { direction: 'down' }, label: 'scroll down to reveal more of the page' });
  candidates.push({ name: 'browser_scroll', input: { direction: 'up' }, label: 'scroll up to reveal earlier content' });
  return candidates;
}

// Computer-domain candidates: launch the task's named target (co-emitting the
// waitMs window list so launch and verification are one decision), focus an
// observed window, or inspect. Free-text authoring stays a strong-model skill.
// If a prior decision already launched this target, the FIRST candidate is
// "wait again" — a launch that produced no window is not evidence the target
// is broken, and repeating the same trigger is the loop we explicitly banned.
function computerCandidateActions({ desktop, task, history = [] }) {
  const { launchTarget } = require('./layaEngine.cjs');
  const candidates = [];
  const target = launchTarget(task);
  if (target) {
    const targetToken = target.toLowerCase();
    const alreadyLaunched = history.some((entry) => entry?.tool === 'computer_terminal'
      && String(entry?.input?.command || '').toLowerCase().includes(targetToken));
    if (alreadyLaunched) {
      candidates.push({
        name: 'computer_window',
        input: { action: 'list', waitMs: LAUNCH_WAIT_MS },
        label: `wait for the ${targetToken} window to appear`
      });
      // No launch bonus on the relaunch candidate: after a silent launch the
      // wait-again candidate must win the tie (the engine's launch bonus would
      // otherwise reward repeating the same trigger).
      candidates.push({
        label: `relaunch ${targetToken} and wait for its window`,
        actions: [
          { name: 'computer_terminal', input: { action: 'execute', command: `Start-Process -FilePath "${target}"` } },
          { name: 'computer_window', input: { action: 'list', waitMs: LAUNCH_WAIT_MS } }
        ]
      });
    } else {
      candidates.push({
        launch: true,
        label: `launch ${targetToken} and wait for its window`,
        actions: [
          { name: 'computer_terminal', input: { action: 'execute', command: `Start-Process -FilePath "${target}"` } },
          { name: 'computer_window', input: { action: 'list', waitMs: LAUNCH_WAIT_MS } }
        ]
      });
    }
  }
  for (const window of (Array.isArray(desktop?.windows) ? desktop.windows : []).slice(0, 6)) {
    const id = String(window?.id || '');
    if (!/^\d+$/.test(id)) continue;
    candidates.push({ name: 'computer_window', input: { action: 'focus', windowId: id }, label: `focus ${String(window?.title || 'window').toLowerCase()}` });
  }
  candidates.push({ name: 'computer_observe', input: {}, label: 'inspect the desktop windows' });
  return candidates;
}

function createLayaProvider({ endpoint = '', timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = null, now = Date.now, confidenceGate = CONFIDENCE_GATE, engine = null, predictBrain = null } = {}) {
  const bundled = engine || (() => {
    const { createLayaEngine } = require('./layaEngine.cjs');
    return createLayaEngine({ now });
  })();
  const useHttp = Boolean(fetchImpl) || Boolean(String(endpoint || '').trim());
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const base = String(endpoint || 'http://127.0.0.1:8765').replace(/\/+$/, '');
  // The completion review demands one explicit confirmation round trip: the
  // first "complete" answer is a proposal, the second consecutive one verifies.
  let completionProposed = false;
  // Loud scope failure: Laya is a mechanical action selector, not a creator.
  // Repeated no-confident picks mean the task needs the strong model — end the
  // run immediately with an actionable message instead of spiraling through
  // the recovery ladder (owner evidence: laya-only creative tasks burned the
  // full 8x12 retry budget failing over and over).
  let noConfidentPicks = 0;

  async function predict(state, questions) {
    // Jev brain first (LORDE_JEV_PLANNER): when the user selected Jev as the
    // System One brain, the standalone planner asks Jev before anything else.
    // Any failure degrades to the bundled engine — one system, never stranded.
    if (predictBrain) {
      try {
        const payload = await predictBrain(state, questions);
        if (payload?.answers) return { ...payload, brain: 'jev' };
      } catch { /* fall through to sidecar/bundled */ }
    }
    if (!useHttp) return { ...bundled.predict({ state, questions }), brain: 'bundled' };
    try {
      const response = await doFetch(`${base}/predict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, questions }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`Laya HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || !payload.answers) throw new Error('Laya payload malformed');
      return { answers: payload.answers, tookMs: Number(payload.tookMs ?? 0) || null, brain: 'sidecar' };
    } catch {
      // One system: the bundled engine takes over whenever the sidecar is not there.
      return { ...bundled.predict({ state, questions }), brain: 'bundled' };
    }
  }

  async function complete(context) {
    const observation = context?.observation || {};
    const dom = observation.dom || {};
    const desktop = observation.desktop;
    const isComputer = Boolean(desktop);
    const task = String(context?.task || '').slice(0, 400);
    const lastAction = Array.isArray(context.history) && context.history.length ? String(context.history.at(-1)?.tool || 'none') : 'none';
    const candidates = isComputer ? computerCandidateActions({ desktop, task, history: Array.isArray(context.history) ? context.history : [] }) : candidateActions({ dom });
    const { answers, tookMs, brain } = await predict({
      task,
      last_action: lastAction,
      url: String(dom.url || observation?.navigation?.url || '').slice(0, 300),
      title: String(dom.title || '').slice(0, 200),
      controls: (Array.isArray(dom.elements) ? dom.elements : []).slice(0, 12)
        .map(element => `${element?.tag || ''} ${String(element?.name || element?.text || '').slice(0, 60)}`).join(' | '),
      ...(isComputer ? {
        foreground: String(desktop.foregroundWindowId || ''),
        windows: (Array.isArray(desktop.windows) ? desktop.windows : []).slice(0, 10).map(window => String(window?.title || '')).join(' | ')
      } : {}),
      candidates: candidates.map((candidate) => candidate.label)
    }, {
      task_complete: { type: 'noul', instructions: 'Given the task and the current page state, has the whole goal already been achieved and verified on screen?' },
      best_action: {
        type: 'choice',
        instructions: 'Which candidate action best progresses the task now?',
        criteria: [...candidates.map((candidate) => candidate.label), 'none of them help']
      }
    });

    const completeConfidence = Number(answers.task_complete?.confidence ?? answers.task_complete?.probability ?? 0);
    const completeValue = Number(answers.task_complete?.noul ?? 0);
    if (completeConfidence >= confidenceGate && completeValue >= 0.5) {
      const verified = completionProposed;
      completionProposed = true;
      return { done: { summary: 'Laya verified the goal from the current on-screen state.', success: true, verified }, laya: { tookMs, brain } };
    }
    completionProposed = false;

    // A choice answer is a criteria KEY — the candidate label (bundled engine
    // and the real checkpoint both return labels, not indices).
    const choiceLabel = String(answers.best_action?.choice ?? '').trim();
    const choiceConfidence = Number(answers.best_action?.confidence ?? answers.best_action?.probability ?? 0);
    const choiceIndex = candidates.findIndex((candidate) => candidate.label === choiceLabel);
    if (choiceIndex >= 0 && choiceConfidence >= confidenceGate) {
      const chosen = candidates[choiceIndex];
      return { actions: chosen.actions || [{ name: chosen.name, input: chosen.input }], laya: { tookMs, brain } };
    }

    // No confident pick: grounded exploration ONCE, then an internal scope signal for the planner.
    // Laya's candidates are mechanical (click/scroll/focus/inspect); a task
    // that keeps yielding "none of them help" needs the strong model's
    // planning, and retrying cannot change that. The failure is thrown as a
    // Internal scope signal: the planner can switch to the API model or a
    // different grounded strategy. It is never a terminal provider block and
    // must not be surfaced as a failed chat.
    noConfidentPicks += 1;
    if (noConfidentPicks >= 2) {
      throw Object.assign(new Error(
        'Laya (the local quick-decision brain) can only execute mechanical steps — clicking visible controls, scrolling, focusing windows. This task needs authoring or planning that only the API model can do. Turn the API model on (Settings → AI provider); Laya will then handle the quick mechanical decisions alongside it automatically.'
      ), { code: 'LAYA_SCOPE_LIMIT' });
    }
    return { actions: [{ name: isComputer ? 'computer_observe' : 'browser_scroll', input: isComputer ? {} : { deltaY: 400 } }], laya: { tookMs, brain, note: 'no confident candidate' } };
  }

  return { complete };
}

module.exports = { createLayaProvider, candidateActions, computerCandidateActions, CONFIDENCE_GATE, LAUNCH_WAIT_MS };
