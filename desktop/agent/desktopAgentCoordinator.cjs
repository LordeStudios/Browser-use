'use strict';

const { isComputerTool, computerReadOnly } = require('../computer/computerCatalog.cjs');
const { performance } = require('node:perf_hooks');
const crypto = require('node:crypto');

async function measureProviderRequest(coordinator, { kind = 'decision', phase = 'decision', attempt = 1, body = '', signal }, execute) {
  const started = performance.now();
  let record = null, status = null, accepted = null, error = null;
  try {
    const metrics = coordinator?.metrics;
    if (metrics) {
      const requestBytes = Buffer.byteLength(body);
      const id = metrics.providerRequests = (metrics.providerRequests || 0) + 1;
      metrics.providerRequestBytes = (metrics.providerRequestBytes || 0) + requestBytes;
      metrics.providerRequestKinds ||= {};
      metrics.providerRequestKinds[kind] = (metrics.providerRequestKinds[kind] || 0) + 1;
      record = { id, kind, phase, attempt, requestBytes };
    }
  } catch { /* Diagnostics must not prevent a provider request. */ }
  try {
    return await execute((response, bodyError) => { status = Number.isFinite(response?.status) ? response.status : null; accepted = response?.ok; if (bodyError) error = bodyError; });
  } catch (failure) { error = failure; throw failure; }
  finally {
    if (record) try {
      const metrics = coordinator.metrics;
      const durationMs = Math.max(0, performance.now() - started);
      const outcome = signal?.aborted || error?.name === 'AbortError' ? 'aborted' : error || accepted === false ? 'failed' : 'completed';
      metrics.providerRequestMs = (metrics.providerRequestMs || 0) + durationMs;
      metrics.providerRequestOutcomes ||= {};
      metrics.providerRequestOutcomes[outcome] = (metrics.providerRequestOutcomes[outcome] || 0) + 1;
      metrics.providerRequestHistory = [...(metrics.providerRequestHistory || []), { ...record, status, outcome, durationMs }].slice(-32);
    } catch { /* Keep diagnostics outside the execution boundary. */ }
  }
}
const MAX_FACTS = 12;
const MAX_ACTIONS = 64;
const MAX_COMPLETED_WORK = 48;
const MAX_FILLS = 16;
// Qwen's five-call threshold, adapted to evidence-reading tools: identical
// arguments are not enough in a live browser; completed results must match too.
const LOOP_DETECTION_THRESHOLD = 5;

// Gen2 enforcement (E1): which browser tools address elements by index, and
// which successful calls change the page so thoroughly that every index minted
// before them is void. x/y coordinate actions are never anchors — they pass
// through unchanged. Gateway-level and advisory-reject only: the gateway bounces
// the action with a fix-naming error and the loop re-observes; nothing parks,
// terminates or fails a run because of a stale anchor.
const ANCHOR_ACTIONS = new Set(['browser_click', 'browser_fill', 'browser_type', 'browser_target_click', 'browser_target_drag']);
const NAVIGATION_ACTIONS = new Set(['browser_navigate', 'browser_new_tab', 'browser_select_tab', 'browser_focus_tab', 'browser_go_back']);

// Desktop mutation evidence and identity. Pure helpers: they compare the
// visible foreground window (not unrelated windows, pointer position or
// capture metadata) and normalize native action identity. They never block,
// latch or intercept a model action.
function nativeMutation(call) {
  return call?.name === 'computer_stroke'
    || call?.name === 'computer_pointer' && !['move', 'down', 'up'].includes(call.input?.action)
    || call?.name === 'computer_keyboard' && ['press', 'text'].includes(call.input?.action)
    || call?.name === 'computer_window' && call.input?.action === 'focus';
}

function nativeActionHash(call, observation) {
  const input = call.input || {};
  const screenshot = observation?.screenshot;
  const imageCoordinates = input.coordinateSpace === 'screenshot';
  const mapped = imageCoordinates && screenshot?.screenshotId === input.screenshotId
    && [screenshot.scaleX, screenshot.scaleY].every(v => Number.isFinite(v) && v > 0);
  const axis = (value, key) => Number.isFinite(value)
    ? Math.round(mapped ? (screenshot.origin?.[key] || 0) + value * screenshot[key === 'x' ? 'scaleX' : 'scaleY'] : value)
    : null;
  const point = p => ({ x: axis(p.x, 'x'), y: axis(p.y, 'y') });
  const shape = {
    action: call.name === 'computer_stroke' ? 'stroke' : input.action,
    windowId: String(input.windowId || observation?.desktop?.foregroundWindowId || ''),
    frame: !imageCoordinates || mapped ? 'desktop' : 'unresolved-screenshot'
  };
  if (call.name === 'computer_pointer' || call.name === 'computer_stroke') {
    shape.button = input.button || 'left';
    if (Number.isFinite(input.x) || Number.isFinite(input.y)) {
      const target = point(input);
      // Only identity uses a 4px click cell to catch one-pixel retry jitter.
      // Actual dispatch and all stroke/drag geometry retain exact coordinates.
      if (input.action === 'click') for (const key of ['x', 'y']) if (target[key] !== null) target[key] = Math.round(target[key] / 4) * 4;
      Object.assign(shape, target);
    }
    if (input.action === 'drag') { shape.endX = axis(input.endX, 'x'); shape.endY = axis(input.endY, 'y'); }
    if (input.action === 'scroll') { shape.deltaX = input.deltaX || 0; shape.deltaY = input.deltaY || 0; }
    if (Array.isArray(input.strokes) && input.strokes.every(s => Array.isArray(s?.points) && s.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y)))) {
      shape.strokeHash = crypto.createHash('sha256').update(JSON.stringify(input.strokes.map(s => s.points.map(point)))).digest('hex');
    }
  } else if (call.name === 'computer_keyboard') {
    shape.key = String(input.key || '').toLowerCase().replace(/\bctrl\b/g, 'control');
    // Distinct text must remain distinct without retaining it in policy state.
    if (input.action === 'text') shape.textHash = crypto.createHash('sha256').update(String(input.text || '')).digest('hex');
  }
  return `${call.name}:${JSON.stringify(shape)}`;
}

function nativeEvidence(observation) {
  const desktop = observation?.desktop;
  if (!desktop) return null;
  const front = desktop.windows?.find(w => w.id === desktop.foregroundWindowId);
  if (!front) return null;
  const image = observation.screenshot?.windowEvidence;
  const comparable = image?.windowId === front.id && image?.complete === true
    && JSON.stringify(image.bounds) === JSON.stringify(front.bounds) && Boolean(image.imageHash);
  return {
    windowId: front.id,
    geometry: JSON.stringify([front.id, front.pid, front.title, front.bounds, front.minimized === true]),
    imageHash: comparable ? image.imageHash : null
  };
}

function nativeEffect(before, after) {
  if (!before || !after) return null;
  if (before.geometry !== after.geometry) return true;
  if (!before.imageHash || !after.imageHash) return null;
  return before.imageHash !== after.imageHash;
}

function createCoordinatorState(seed = {}) {
  return {
    observationRevision: 0,
    fingerprint: null,
    lastObservedAt: 0,
    // E1 navigation epoch: bumped on every successful top-level navigation or
    // tab switch on the run's tab. anchorEpoch is the epoch the CURRENT element
    // snapshot was minted in; element-index actions dispatched while
    // anchorEpoch !== navigationEpoch are stale anchors (see staleAnchor).
    navigationEpoch: Number(seed.navigationEpoch) || 0,
    anchorEpoch: Number(seed.anchorEpoch) || 0,
    // E3 mutation sequence: every successful page mutation advances it. A fill
    // ledger entry carries the sequence value as of its own read-back; the
    // idempotent gateway trusts that proof only while no newer mutation ran.
    mutationSeq: Number(seed.mutationSeq) || 0,
    // E3 idempotent-fill ledger: successful browser_fill calls keyed by
    // (target identity hash, exact value hash), settled by the next
    // observation. See fillGate.
    fillLedger: Array.isArray(seed.fillLedger) ? seed.fillLedger.slice(-MAX_FILLS) : [],
    // E7 (gen3): controls whose fill the page just rejected. A browser_execute
    // that then writes .value into one of them is the fill-gate bypass arch1
    // ran in 4/4 campaigns — detectable at the payload site, unlike the prose
    // ban. Bounded window; entries are advisory state for the gateway only.
    rejectedFills: Array.isArray(seed.rejectedFills) ? seed.rejectedFills.slice(-4) : [],
    facts: Array.isArray(seed.facts) ? seed.facts.slice(-MAX_FACTS) : [],
    actionHashes: Array.isArray(seed.actionHashes) ? seed.actionHashes.slice(-MAX_ACTIONS) : [],
    completedWork: normalizeCompletedWork(seed.completedWork),
    lastMutation: null,
    pendingMutations: [],
    duplicateBlocks: 0,
    recentReadResults: [],
    replansWithoutProgress: 0,
    metrics: { observations: 0, screenshots: 0, providerCalls: 0, providerRequests: 0, providerRequestBytes: 0, providerRequestMs: 0, providerRequestKinds: {}, providerRequestOutcomes: {}, providerRequestHistory: [], firstToolStartedMs: null, firstToolSettledMs: null, actionAttempts: 0, duplicateActionsBlocked: 0, loopBreaks: 0, eventBytes: 0, providerContextBytes: 0, providerContextTokens: 0, phaseMs: { observe: 0, model: 0, execute: 0, verify: 0 } }
  };
}

function observationFingerprint(observation) {
  const navigation = observation?.navigation || {};
  const dom = observation?.dom || {};
  const viewport = dom.viewport || {};
  const elements = Array.isArray(dom.elements) ? dom.elements.slice(0, 24) : [];
  const landmarks = Array.isArray(dom.landmarks) ? dom.landmarks.slice(0, 12) : [];
  const regions = Array.isArray(dom.regions) ? dom.regions.slice(0, 12) : [];
  const visualTargets = Array.isArray(dom.visualTargets) ? dom.visualTargets.slice(0, 96) : [];
  return JSON.stringify({
    // Desktop fingerprint covers only the visible foreground window's
    // identity/geometry plus a window-scoped image hash when comparable, so
    // unrelated windows or the pointer cannot fake observation change.
    ...(observation?.desktop ? { desktop: nativeEvidence(observation) } : {}),
    url: navigation.url || dom.url || '', loading: Boolean(navigation.loading),
    // Viewport geometry is layout identity. A resize/zoom must invalidate
    // cached coordinate decisions even when the DOM content is unchanged.
    viewportWidth: Number(viewport.width) || 0,
    viewportHeight: Number(viewport.height) || 0,
    devicePixelRatio: Number(viewport.devicePixelRatio || observation?.devicePixelRatio) || 1,
    scrollX: viewport.scrollX || 0, scrollY: viewport.scrollY || 0,
    elements: elements.map((element) => [element.tag, element.role, normalize(element.name), normalize(element.text), normalize(element.href), Boolean(element.enabled), element.pressed, element.selected, element.expanded, element.rect?.x, element.rect?.y]),
    landmarks: landmarks.map((landmark) => [landmark.tag, landmark.role, normalize(landmark.label), normalize(landmark.text)]),
    regions: regions.map((region) => [region.kind, normalize(region.name), region.rect?.x, region.rect?.y, region.rect?.w, region.rect?.h, Number(region.childCount || 0), Number(region.descendantCount || 0)]),
    visualTargets: visualTargets.map((target) => [target.tag, normalize(target.classes), normalize(target.label), target.rect?.x, target.rect?.y, target.rect?.w, target.rect?.h])
  });
}

function recordObservation(state, observation) {
  const fingerprint = observationFingerprint(observation);
  const changed = fingerprint !== state.fingerprint;
  // Every mutation awaiting evidence settles against the next observation.
  // A whole-observation fingerprint cannot attribute which batch member caused
  // the change, so a changed observation confirms each pending member and an
  // unchanged one removes its unproven ledger entry, matching the previous
  // single-mutation semantics generalized to batches.
  for (const pending of state.pendingMutations.splice(0)) {
    // Native mutations settle only against foreground-window evidence:
    // unknown (no comparable crop) is never confirmed as effect.
    const effect = pending.native ? nativeEffect(pending.nativeEvidence, nativeEvidence(observation)) : fingerprint !== pending.beforeFingerprint;
    const effectObserved = pending.reportedProgress === true || effect === true;
    const workIndex = state.completedWork.findLastIndex((entry) => entry.id === pending.workId);
    if (workIndex >= 0 && effectObserved) {
      state.completedWork[workIndex] = { ...state.completedWork[workIndex], effectObserved, observedRevision: state.observationRevision + 1 };
    } else if (workIndex >= 0) {
      // An observation that fails to confirm a pending mutation removes its
      // unproven ledger entry: unobserved work is not completed work.
      state.completedWork.splice(workIndex, 1);
    }
    const actionIndex = state.actionHashes.findLastIndex((entry) => entry.hash === pending.hash && entry.fingerprint === pending.beforeFingerprint);
    if (actionIndex >= 0) state.actionHashes[actionIndex] = { ...state.actionHashes[actionIndex], progress: effectObserved,
      ...(pending.native ? { nativeEffect: effect } : {}) };
  }
  // E1: the snapshot just recorded was minted in the current navigation epoch,
  // so element indices observed now are fresh by definition. Any later
  // navigation bumps the epoch and re-arms stale-anchor rejection until the
  // next observation re-mints the anchors.
  state.anchorEpoch = state.navigationEpoch;
  // E3: every recorded fill settles against the next observation — the DOM
  // snapshot is the grounding evidence for text-input mutations, so a
  // successful fill plus one observation proves the value is in place. The
  // applied fingerprint pins "unchanged target": a later page change un-gates
  // the identical refill (the value may have been reverted).
  for (const fill of state.fillLedger) {
    if (fill.effectObserved !== true) {
      fill.effectObserved = true;
      fill.appliedFingerprint = fingerprint;
    }
  }
  if (state.lastMutation?.awaitingObservation) {
    state.lastMutation = {
      ...state.lastMutation,
      awaitingObservation: false,
      effectObserved: state.lastMutation.reportedProgress === true || (state.lastMutation.native
        ? nativeEffect(state.lastMutation.nativeEvidence, nativeEvidence(observation)) === true : changed),
      observedFingerprint: fingerprint,
      observedRevision: state.observationRevision + 1
    };
  }
  state.observationRevision += 1;
  state.fingerprint = fingerprint;
  state.lastObservedAt = Date.now();
  state.metrics.observations += 1;
  if (observation?.screenshot) state.metrics.screenshots += 1;
  if (changed) state.replansWithoutProgress = 0;
  return { revision: state.observationRevision, changed, fingerprint };
}

function hasCoordinatePair(input = {}) {
  const finiteCoordinate = (value) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string' || value.trim() === '') return false;
    return Number.isFinite(Number(value));
  };
  return finiteCoordinate(input.x) && finiteCoordinate(input.y);
}

function actionHash(call, element = null, observation = null) {
  if (nativeMutation(call)) return nativeActionHash(call, observation);
  const input = call?.input || {};
  const hasCoordinates = hasCoordinatePair(input);
  const hasElementTarget = !hasCoordinates && (input.element !== undefined || input.index !== undefined);
  const target = hasCoordinates
    ? ['coordinate', bucket(input.x), bucket(input.y)]
    : element ? [element.tag, normalize(element.name), normalize(element.text), element.id || '', element.testId || '', element.dataTool || ''] : [input.selector || '', input.tabId || '', input.element ?? input.index ?? ''];
  // Coordinate-bearing clicks are keyed by their explicit point; index-only
  // clicks are keyed by the resolved element or supplied index. Annotations
  // such as expect prose never change either target identity.
  const normalized = ['browser_type', 'browser_fill'].includes(call?.name)
    ? { target, length: String(input.text || '').length }
    : call?.name === 'browser_scroll'
      ? { target, x: bucket(input.deltaX), y: bucket(input.deltaY) }
      : call?.name === 'browser_drag'
        ? { target, startX: bucket(input.startX), startY: bucket(input.startY), endX: bucket(input.endX), endY: bucket(input.endY) }
      : call?.name === 'browser_navigate'
        ? { target, url: canonicalUrl(input.url) }
        : hasElementTarget
          ? { target }
          : { target, input: normalizeInput(input) };
  return `${call?.name || ''}:${JSON.stringify(normalized)}`;
}

function canAttempt(state, hash, mutates, expectation = null, explicitRepeat = false) {
  if (!mutates || String(hash).startsWith('browser_scroll:')) return { allowed: true };
  const expectedOutcome = expectationKey(expectation);
  const applied = [...state.actionHashes].reverse().find((entry) => entry.hash === hash && entry.ok === true && entry.progress === true);
  if (applied && explicitRepeat && expectedOutcome && expectedOutcome !== applied.expectedOutcome) {
    return { allowed: true, advisory: 'This action completed before with a different expected outcome. Treat the result as evidence and decide whether to re-check it.' };
  }
  if (applied) {
    return { allowed: true, advisory: 'You already performed this exact action successfully earlier in the task. Treat the result as evidence and decide whether repeating it serves the current goal.' };
  }
  const recent = state.actionHashes.filter((entry) => entry.hash === hash && entry.fingerprint === state.fingerprint && !entry.progress);
  if (recent.length) {
    return { allowed: true, advisory: `This action has been attempted ${recent.length} time${recent.length === 1 ? '' : 's'} against the current evidence without a confirmed effect. Decide whether to retry, inspect, wait, change approach, or move to the next grounded action; ending the run is governed by the browser_done rule.` };
  }
  return { allowed: true };
}

// E1 (gen2 enforcement): a successful top-level navigation or tab switch makes
// every element-index anchor minted before it stale. Called by the dispatch
// layer after the navigation result lands ok. E3: a navigation also voids the
// whole fill ledger — the reload mints fresh fields whose values the old
// read-backs say nothing about (an empty reloaded checkout form must refill).
function bumpNavigationEpoch(state) {
  if (!state) return 0;
  state.navigationEpoch = (Number(state.navigationEpoch) || 0) + 1;
  state.fillLedger = [];
  return state.navigationEpoch;
}

// E1 gateway: element-index actions dispatched against a pre-navigation
// snapshot are rejected with a fix-naming error. Purely advisory-reject — the
// caller records the bounce, the loop re-observes, and the next decision acts
// on fresh indices. x/y coordinate actions and non-anchor tools pass through.
function staleAnchor(state, call) {
  if (!state || state.anchorEpoch === state.navigationEpoch) return null;
  const name = String(call?.name || '');
  if (!ANCHOR_ACTIONS.has(name)) return null;
  const input = call?.input || {};
  if (hasCoordinatePair(input)) return null;
  if (input.element === undefined && input.index === undefined) return null;
  return {
    allowed: false,
    advisory: 'STALE ANCHOR: the page navigated since this element index was captured — re-observe, then act on the fresh indices.'
  };
}

// E3 key: target identity comes from the action hash (element identity or
// selector/coordinates) plus the EXACT value digest — the hash body only
// carries the text length, so same-length different-value fills stay distinct.
function fillKey(hash, value) {
  return `${String(hash)}|${crypto.createHash('sha256').update(String(value ?? '')).digest('hex')}`;
}

// E3 gateway: a fill whose (target identity + exact value) was already applied
// AND whose effect was observed returns the prior proof instead of executing
// again — but ONLY while the fill's own read-back is still the newest page
// evidence: no successful mutation may have run since the fill (mutationSeq
// unchanged), no navigation may have happened (bumpNavigationEpoch clears the
// ledger), and the page must still look like the page the fill settled
// against. Changed target, changed value, any later mutation, a navigation, or
// a page change since application executes normally. Successful prior fills
// only — failed fills never enter the ledger (and a failed fill voids its
// matching proof in recordAction).
function fillGate(state, hash, call) {
  if (String(call?.name || '') !== 'browser_fill') return null;
  const text = call?.input?.text;
  if (text === undefined || text === null || String(text) === '') return null;
  if (!state || !Array.isArray(state.fillLedger)) return null;
  const key = fillKey(hash, text);
  const entry = [...state.fillLedger].reverse().find((item) => item.key === key
    && item.effectObserved === true
    && item.appliedFingerprint !== null
    && item.appliedFingerprint === state.fingerprint
    && Number(item.mutationSeq) === Number(state.mutationSeq));
  if (!entry) return null;
  return {
    alreadySet: true,
    proof: { ...(entry.proof || {}), value: String(text).slice(0, 200) },
    advisory: 'already in place — advance to the next requirement'
  };
}

// E7 (gen3) constraint-tamper gateway: a browser_execute script is inspected
// BEFORE execution for constraint removal/bypass on form controls — the exact
// gen1/gen2 recurrence the prose ban never stopped (arch4 ran
// removeAttribute('maxlength') verbatim; arch1 routed the fill gate via
// script in 4/4 runs; arch3 attempted a knowing ".value is not restricted by
// maxlength" bypass). Two detection classes, both mechanical:
//   1. mutation of CONSTRAINT attributes — removeAttribute/setAttribute on
//      maxlength/required/minlength, .maxLength/.required property writes;
//   2. a .value WRITE into a control whose fill the page just rejected in
//      this run (recordRejectedFill) — value-forcing past the gate.
// Generic JS must pass untouched: querySelectorAll, style changes, reads of
// .value/.maxLength/attributes without assignment, removes of unrelated
// attributes. On a hit the caller rejects the execute with the conflict
// protocol bounce (recoverable, never a kill) — the same shape as the fill
// and stale-anchor gates.
const CONSTRAINT_TAMPER_PATTERNS = [
  { re: /removeAttribute(?:Node)?\s*\(\s*['"`](?:max\s*-?\s*length|min\s*-?\s*length|required)\b['"`]\s*\)/i, label: "removeAttribute on a form constraint (maxlength/minlength/required)" },
  { re: /setAttribute\s*\(\s*['"`](?:max\s*-?\s*length|min\s*-?\s*length|required)\b['"`]/i, label: "setAttribute rewriting a form constraint (maxlength/minlength/required)" },
  { re: /\.\s*maxLength\s*=[^=]/, label: '.maxLength write (raising or clearing the field limit)' },
  { re: /\[\s*['"`]maxLength['"`]\s*\]\s*=[^=]/i, label: "['maxLength'] write (raising or clearing the field limit)" },
  { re: /\.\s*required\s*=[^=]/, label: '.required write (removing or toggling the field requirement)' },
  { re: /\[\s*['"`]required['"`]\s*\]\s*=[^=]/i, label: "['required'] write (removing or toggling the field requirement)" }
];
const VALUE_WRITE_PATTERN = /\.\s*value\s*(?:\+=|\|=|=(?!=))|\[\s*['"`]value['"`]\s*\]\s*(?:\+=|\|=|=(?!=))/i;
const CONFLICT_PROTOCOL_ADVISORY = 'CONSTRAINT TAMPER: this script strips or bypasses a page constraint the fill gate enforces. The page rejecting a value is the blocked path: attempt the blocked-done, or commit the minimal page-valid adaptation and name the deviation — never force the literal in by editing the constraint.';
function constraintTamper(state, call) {
  if (String(call?.name || '') !== 'browser_execute') return null;
  const script = String(call?.input?.script || '');
  if (!script) return null;
  for (const pattern of CONSTRAINT_TAMPER_PATTERNS) {
    if (pattern.re.test(script)) return { allowed: false, advisory: `${CONFLICT_PROTOCOL_ADVISORY} Detected: ${pattern.label}.` };
  }
  // Class 2: a value write into a control the fill gate just rejected. Keyed
  // on the rejected control's identity (element index token, its snapshot
  // name, or — gen4 — its DOM position among same-tag elements), so unrelated
  // .value writes elsewhere in the page still pass. Entries expire after a
  // short TTL (rejectedFillActive).
  const rejected = Array.isArray(state?.rejectedFills)
    ? state.rejectedFills.filter((entry) => rejectedFillActive(state, entry)
      && (Number.isFinite(entry?.index) || String(entry?.name || '').length >= 4))
    : [];
  if (rejected.length && VALUE_WRITE_PATTERN.test(script)) {
    for (const entry of rejected) {
      if (Number.isFinite(entry.index) && new RegExp(`\\[\\s*${entry.index}\\s*\\]`).test(script)) {
        return { allowed: false, advisory: `${CONFLICT_PROTOCOL_ADVISORY} Detected: a .value write into element [${entry.index}], the control whose fill was just rejected.` };
      }
      if (String(entry.name || '').length >= 4 && script.includes(entry.name)) {
        return { allowed: false, advisory: `${CONFLICT_PROTOCOL_ADVISORY} Detected: a .value write naming "${String(entry.name).slice(0, 60)}", the control whose fill was just rejected.` };
      }
      // Gen4 positional alias: `querySelectorAll('input')[N]` / `els[N].value`
      // where N is the rejected control's position among same-tag elements —
      // the exact arch4-untimed-r1 escape (snapshot index 2, positional
      // selector [1], 1-3 decisions later). The tag must appear in a
      // collection call in the script; N matches the recorded position.
      if (String(entry.tag || '') && Number.isFinite(entry.position)) {
        const tag = String(entry.tag).replace(/[^a-z0-9-]/g, '');
        const collection = new RegExp(`(?:querySelectorAll|getElementsByTagName)\\s*\\(\\s*['"\`]${tag}['"\`]\\s*\\)`);
        const positional = new RegExp(`\\[\\s*${entry.position}\\s*\\]\\s*(?:\\.\\s*value|\\[\\s*['"\`]value['"\`]\\s*\\])`);
        if (collection.test(script) && positional.test(script)) {
          return { allowed: false, advisory: `${CONFLICT_PROTOCOL_ADVISORY} Detected: a .value write into ${tag}[${entry.position}] via a positional selector — the control whose fill was just rejected.` };
        }
      }
    }
  }
  return null;
}

// ---------- F5 (gen5) presentation-mutation tamper ----------
// The arch1-timed-r3 escape: after a failed submit left a red error border,
// the agent executed `style.borderColor=''` on the field, re-measured, and
// reported "cleared" — the accepted summary leaned on the manufactured
// cleanliness. arch2-untimed-r1 did the same with removeAttribute('style')
// and classList.remove('invalid','error','is-invalid') before counting
// visible errors. No gate watched presentation mutations; zero notices fired.
// Mechanical classes, both bounced through E7's channel (recoverable, never
// a kill):
//   1. a presentation-CLEARING operation (style.<prop> = '', style
//      .removeProperty, removeAttribute('style'/'class'), className = '',
//      classList.remove) combined with error/invalid tokens anywhere in the
//      script — the manufactured-cleanliness signature (arch2);
//   2. a style-clear targeting the identity of a control whose fill the page
//      just rejected (the same identity matching as the constraint-tamper
//      class 2) — arch1's borderColor='' on the rejected field, which names
//      no error token at all.
// Generic styling passes untouched: SETTING styles/colors/layout, classList
// .add, classList.remove of non-error tokens, and error-token reads without
// any clearing operation.
const PRESENTATION_CLEAR_PATTERNS = [
  { re: /\.\s*style\s*\.\s*[A-Za-z_$][\w$]*\s*=\s*(['"`])\s*\1/, label: "clearing an inline style property (style.<prop> = '')" },
  { re: /\.\s*style\s*\.\s*removeProperty\s*\(/, label: 'style.removeProperty (clearing inline presentation state)' },
  { re: /removeAttribute\s*\(\s*['"`](?:style|class)\b['"`]\s*\)/i, label: "removeAttribute on style/class (clearing presentation or class state)" },
  { re: /\.\s*className\s*=\s*(['"`])\s*\1/, label: "className = '' (clearing the element's class state)" },
  { re: /classList\s*\.\s*remove\s*\(/, label: 'classList.remove (stripping class state)' }
];
const PRESENTATION_ERROR_TOKEN = /(?:^|[^a-z-])(?:errors?|invalid|is-invalid|invalid-state|has-error|has-danger|validation-error|field-error|form-error|error-state|error-border|error-message|error-text)(?:[^a-z-]|$)/i;
const PRESENTATION_TAMPER_ADVISORY = "PRESENTATION TAMPER: this script clears error/invalid presentation state (style/class mutations) instead of resolving the underlying problem — any 'clean' measurement taken after it is manufactured. Resolve or honestly report the real validation state; never erase error styling between a failed submit and the done claim.";
function presentationTamper(state, call) {
  if (String(call?.name || '') !== 'browser_execute') return null;
  const script = String(call?.input?.script || '');
  if (!script) return null;
  // Class 1: a clearing operation + error/invalid tokens in the script.
  for (const pattern of PRESENTATION_CLEAR_PATTERNS) {
    if (pattern.re.test(script) && PRESENTATION_ERROR_TOKEN.test(script)) {
      return { allowed: false, advisory: `${PRESENTATION_TAMPER_ADVISORY} Detected: ${pattern.label} on error/invalid state.` };
    }
  }
  // Class 2: a style-clear naming the control whose fill the page just
  // rejected — the arch1 escape clears the rejected field's presentation
  // without any error token in the script. Same identity matching and TTL
  // window as the constraint-tamper value-write check.
  const clearOnly = PRESENTATION_CLEAR_PATTERNS.filter((pattern) => pattern.re.test(script));
  if (clearOnly.length) {
    const rejected = Array.isArray(state?.rejectedFills)
      ? state.rejectedFills.filter((entry) => rejectedFillActive(state, entry)
        && (Number.isFinite(entry?.index) || String(entry?.name || '').length >= 4))
      : [];
    if (rejected.length) {
      for (const entry of rejected) {
        if (Number.isFinite(entry.index) && new RegExp(`\\[\\s*${entry.index}\\s*\\]`).test(script)) {
          return { allowed: false, advisory: `${PRESENTATION_TAMPER_ADVISORY} Detected: a presentation-clearing write into element [${entry.index}], the control whose fill was just rejected.` };
        }
        if (String(entry.name || '').length >= 4 && script.includes(entry.name)) {
          return { allowed: false, advisory: `${PRESENTATION_TAMPER_ADVISORY} Detected: a presentation-clearing write naming "${String(entry.name).slice(0, 60)}", the control whose fill was just rejected.` };
        }
        if (String(entry.tag || '') && Number.isFinite(entry.position)) {
          const tag = String(entry.tag).replace(/[^a-z0-9-]/g, '');
          const collection = new RegExp(`(?:querySelectorAll|getElementsByTagName)\\s*\\(\\s*['"\`]${tag}['"\`]\\s*\\)`);
          const positional = new RegExp(`\\[\\s*${entry.position}\\s*\\]\\s*(?:\\.\\s*style|\\[\\s*['"\`]style['"\`]\\s*\\]|\\.\\s*classList|removeAttribute)`);
          if (collection.test(script) && positional.test(script)) {
            return { allowed: false, advisory: `${PRESENTATION_TAMPER_ADVISORY} Detected: a presentation-clearing write into ${tag}[${entry.position}] via a positional selector — the control whose fill was just rejected.` };
          }
        }
      }
    }
  }
  return null;
}

// ---------- E12 (gen4) claim-vs-trace cross-check ----------
// Three generations of judge evidence (gen2-timed-r2, gen3-gen-ab-timed-r2)
// show accepted verified:true summaries citing observations the tool record
// does not show ("the post-submit screenshot" with zero screenshot calls).
// Mechanical, cheap matching: action-verb claims in the summary are matched
// against tool NAMES + their position in the run history — not full NLP. Pure:
// returns the unbacked claim descriptions; the caller bounces once.

const E12_PROBE_TOOLS = ['browser_execute', 'browser_query', 'browser_extract', 'browser_observe', 'browser_tabs'];
const E12_SCREENSHOT_TOOLS = ['browser_screenshot', 'computer_screenshot'];
// A NATIVE read-back is evidence too. The probe set was browser-only, so a run
// that verified its patch by reading the file back was told "the run recorded
// no probe/read-back" and bounced — an unbacked-claim false positive that cost
// an extra provider call and a re-submitted completion.
const E12_NATIVE_PROBE_TOOLS = ['computer_read', 'computer_search', 'computer_index', 'computer_observe', 'computer_screenshot', 'computer_terminal'];
const E12_READ_ONLY_GIT_ACTIONS = ['status', 'diff', 'log'];
const E12_READ_ONLY_FS_ACTIONS = ['stat', 'list', 'find'];

function e12IsProbe(entry) {
  if (!entry || entry?.output?.ok !== true) return false;
  const tool = String(entry?.tool || '');
  if (E12_PROBE_TOOLS.includes(tool) || E12_NATIVE_PROBE_TOOLS.includes(tool)) return true;
  if (tool === 'computer_git') return E12_READ_ONLY_GIT_ACTIONS.includes(String(entry?.input?.action || ''));
  if (tool === 'computer_fs') return E12_READ_ONLY_FS_ACTIONS.includes(String(entry?.input?.action || ''));
  return false;
}

function e12BackedBy(history, toolNames) {
  return (Array.isArray(history) ? history : []).some((entry) => toolNames.includes(String(entry?.tool || '')) && entry?.output?.ok === true);
}

// The last submit-shaped event's index (a click, or an Enter keypress) — the
// subject mutation a "post-submit" claim must be evidenced after.
function e12LastSubmitIndex(history) {
  const entries = Array.isArray(history) ? history : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.output?.ok !== true) continue;
    const tool = String(entry?.tool || '');
    if (tool === 'browser_click') return i;
    if (tool === 'browser_key' && /enter|return/i.test(String(entry?.input?.key || ''))) return i;
  }
  return -1;
}

function unbackedActionClaims(summary, { history = [], visualEvidence = null, visualLedger = null } = {}) {
  const text = String(summary || '');
  if (!text.trim()) return [];
  const unbacked = [];
  const lastSubmit = e12LastSubmitIndex(history);
  const postSubmitPhrasing = /\bpost-?submit(?:ting|ted)?\b|\bafter (?:the )?(?:re-?)?submit(?:ting|ted|s)?\b/i.test(text);
  // F3 (gen5): screenshot-citation claims must match against screenshot tool
  // events AND the run's visual-evidence ledger — a durable record of every
  // capture the run actually produced (explicit browser_screenshot /
  // computer_screenshot tool calls, in-band observation captures, image
  // attachments), each stamped with its history position. The old escape —
  // the ephemeral current frame backing ANY citation — is gone: the gen4
  // judges measured the class at 15/15 accepted fabrications across arms
  // ("confirmed by ... screenshot", "the visible screenshot", "the post-submit
  // screenshot", "the fresh/current screenshot", "screenshot captured at that
  // point") because the ephemeral frame or nothing at all was checked. A
  // post-submit citation additionally requires the capture to postdate the
  // last submit-shaped action — a frame captured before the submit is not
  // post-submit evidence.
  if (/\bscreens?hots?\b|\bscreens?hot_?id\b|\bscreencaps?\b|\b(?:fresh|current|latest|final|on-screen|visible)\s+captures?\b|\bcaptured (?:at|in) (?:that|the) (?:point|frame|moment)\b/i.test(text)) {
    const entries = Array.isArray(history) ? history : [];
    const screenshotEventIndexes = entries
      .map((entry, i) => (E12_SCREENSHOT_TOOLS.includes(String(entry?.tool || '')) && entry?.output?.ok === true ? i : -1))
      .filter((i) => i >= 0);
    const ledgerEntries = (Array.isArray(visualLedger) ? visualLedger : [])
      .filter((item) => item && ['tool', 'auto', 'attachment'].includes(String(item?.source || '')));
    const producing = screenshotEventIndexes.length > 0 || ledgerEntries.length > 0;
    // Post-submit backing: a producing capture whose history position is after
    // the last submit-shaped entry (a capture recorded when history already
    // contained the submit entry postdates it).
    const evidenceAfterSubmit = screenshotEventIndexes.some((i) => i > lastSubmit)
      || ledgerEntries.some((item) => Number.isFinite(Number(item?.historyLength)) && Number(item.historyLength) >= lastSubmit + 1);
    if (postSubmitPhrasing && lastSubmit < 0) {
      unbacked.push('a screenshot is cited as post-submit evidence, but the run recorded no submit-shaped action (a click or Enter) to be after');
    } else if (postSubmitPhrasing && !evidenceAfterSubmit) {
      unbacked.push('a screenshot is cited as post-submit evidence, but no screenshot-producing capture (tool call or recorded frame) exists after the last submit-shaped action');
    } else if (!producing) {
      unbacked.push('a screenshot is cited as evidence, but this run has no screenshot tool call and no capture in its visual-evidence ledger');
    }
  }
  // Probe / read-back claims need a successful evidence-reading tool event,
  // and one AFTER the subject mutation when the claim is about a submission.
  if (/\b(probe[ds]?|probing|read[- ]?back|re-?read|read the (?:submitted|summary|result|page|form))\b/i.test(text)) {
    const probeAnywhere = (Array.isArray(history) ? history : []).some(e12IsProbe);
    if (lastSubmit >= 0) {
      const probeAfterSubmit = (Array.isArray(history) ? history : []).some((entry, i) => i > lastSubmit && e12IsProbe(entry));
      if (!probeAfterSubmit) unbacked.push('a probe/read-back is claimed to verify the submission, but no successful probe ran after the last submit-shaped action');
    } else if (!probeAnywhere) {
      unbacked.push('a probe/read-back is claimed, but the run recorded no successful browser_execute/query/extract/observe tool event');
    }
  }
  // Observed / visible claims need at least one successful observation-domain
  // event somewhere in the run (or a current captured frame).
  if (/\b(observed|visibly|visible (?:error|message|confirmation|result)|saw the)\b/i.test(text)
    && !e12BackedBy(history, [...E12_PROBE_TOOLS, ...E12_SCREENSHOT_TOOLS])
    && !visualEvidence?.data) {
    unbacked.push('an observation is claimed, but the run recorded no successful observation, probe, or screenshot event');
  }
  // VISUAL-STATE claims (run-forensics 2026-10-15, all 3 audits): "aurora
  // wave now visible on the hero", "the icon chips appear top-left as
  // requested", "looks premium — verified visually" are claims about
  // RENDERED output, and none of them matched the older marker classes —
  // one run shipped this fabrication class 5 times ("stop hallucinating"
  // x3). The claim needs a capture that POSTDATES the last content-changing
  // action: a frame from before the last edit cannot show the claimed state.
  if (/\b(?:now\s+visible|visible\s+(?:on|in|at)\b|appears?\b|appeared\b|looks?\s|verified\s+visually|visually\s+verified)\b/i.test(text)) {
    const entries = Array.isArray(history) ? history : [];
    const contentAction = /^(?:browser_(?:execute|click|type|fill|key|navigate)|computer_(?:patch|write|fs|terminal))$/;
    const lastContentAction = entries.reduce((acc, entry, i) => (contentAction.test(String(entry?.tool || '')) ? i : acc), -1);
    const capturePositions = [
      ...entries.map((entry, i) => (E12_SCREENSHOT_TOOLS.includes(String(entry?.tool || '')) && entry?.output?.ok === true ? i : -1)).filter((i) => i >= 0),
      ...(Array.isArray(visualLedger) ? visualLedger : [])
        .filter((item) => item && ['tool', 'auto', 'attachment'].includes(String(item?.source || '')))
        .map((item) => Number(item.historyLength))
    ];
    const freshCapture = capturePositions.some((position) => position > lastContentAction);
    if (!freshCapture) {
      unbacked.push(lastContentAction >= 0
        ? 'a visual state is claimed, but no capture postdates the last content-changing action — take a real screenshot after the change before claiming what it shows'
        : 'a visual state is claimed, but this run recorded no screenshot of the claimed state');
    }
  }
  return unbacked;
}

// ---------- E7 (gen4) first-write window ----------
// Blind spot (a), proven in gen-ab: a FIRST script write of an over-maxlength
// value into a constrained control with no prior fill-gate rejection sails
// through (13 chars retained in a maxlength-9 field). The control's OWN
// constraint is the limit — no rejection history is needed. Pure decision:
// the caller probes the page's form-control constraints, then this function
// decides bounce / allow / allow-with-notice. Generic JS (dynamic writes,
// reads, styles, non-form elements) passes.

// Literal `.value = '<literal>'` writes with their target expression.
const VALUE_WRITE_SIMPLE = /\b([A-Za-z_$][\w$]*)\s*(?:\[\s*(\d+)\s*\])?\s*(?:\.\s*value\s*|\[\s*['"`]value['"`]\s*\]\s*)=\s*(['"`])((?:(?!\3)[^\n])*)\3/g;
const VALUE_WRITE_CHAINED = /\[\s*(\d+)\s*\]\s*(?:\.\s*value\s*|\[\s*['"`]value['"`]\s*\]\s*)=\s*(['"`])((?:(?!\2)[^\n])*)\2/g;
const VALUE_WRITE_CALLED = /\)\s*(?:\.\s*value\s*|\[\s*['"`]value['"`]\s*\]\s*)=\s*(['"`])((?:(?!\1)[^\n])*)\1/g;

function literalWrite(text, match, literal, extra = {}) {
  // The literal (+ its quotes) always terminates the match, so the value's
  // own start — where the anchor scan must stop — is computable.
  const valueIndex = match.index + match[0].length - literal.length - 2;
  return { index: match.index, valueIndex, literal, ...extra };
}

function valueWriteLiterals(script) {
  const text = String(script || '');
  const writes = [];
  VALUE_WRITE_SIMPLE.lastIndex = 0;
  for (let match = VALUE_WRITE_SIMPLE.exec(text); match; match = VALUE_WRITE_SIMPLE.exec(text)) {
    writes.push(literalWrite(text, match, match[4], { varName: match[1], bracketIndex: match[2] !== undefined ? Number(match[2]) : null }));
  }
  VALUE_WRITE_CHAINED.lastIndex = 0;
  for (let match = VALUE_WRITE_CHAINED.exec(text); match; match = VALUE_WRITE_CHAINED.exec(text)) {
    // Chained form (…('input')[1].value = 'x'): the simple pattern cannot
    // match across the ')' boundary, so record it with only a bracket index.
    if (writes.some((w) => Math.abs(w.index - match.index) < 4)) continue;
    writes.push(literalWrite(text, match, match[3], { varName: null, bracketIndex: Number(match[1]) }));
  }
  VALUE_WRITE_CALLED.lastIndex = 0;
  for (let match = VALUE_WRITE_CALLED.exec(text); match; match = VALUE_WRITE_CALLED.exec(text)) {
    // Call-chain form (document.getElementById('tax').value = 'x').
    if (writes.some((w) => Math.abs(w.index - match.index) < 4)) continue;
    writes.push(literalWrite(text, match, match[2], { varName: null, bracketIndex: null }));
  }
  return writes.sort((a, b) => a.index - b.index);
}

// Nearest anchor before the write: an id anchor, a name anchor, or a tagged
// collection call. Returns { kind, value, n } or null.
function e7WriteAnchor(scriptBeforeWrite) {
  const anchors = [];
  for (const match of scriptBeforeWrite.matchAll(/\b(?:getElementById)\s*\(\s*['"`]([\w-]+)['"`]/g)) anchors.push({ at: match.index, kind: 'id', value: match[1] });
  for (const match of scriptBeforeWrite.matchAll(/\bquerySelector\s*\(\s*['"`]#([\w-]+)['"`]/g)) anchors.push({ at: match.index, kind: 'id', value: match[1] });
  for (const match of scriptBeforeWrite.matchAll(/\bgetElementsByName\s*\(\s*['"`]([\w-]+)['"`]/g)) anchors.push({ at: match.index, kind: 'name', value: match[1] });
  for (const match of scriptBeforeWrite.matchAll(/\bquerySelector\s*\(\s*['"`]\[\s*name(?:=["']|=["`])\s*([\w-]+)\s*["']?\s*\]['"`]/g)) anchors.push({ at: match.index, kind: 'name', value: match[1] });
  for (const match of scriptBeforeWrite.matchAll(/(?:querySelectorAll|getElementsByTagName)\s*\(\s*['"`]([A-Za-z][\w-]*)['"`]\s*\)\s*\[\s*(\d+)\s*\]/g)) anchors.push({ at: match.index, kind: 'tag', value: match[1], n: Number(match[2]) });
  for (const match of scriptBeforeWrite.matchAll(/(?:querySelectorAll|getElementsByTagName)\s*\(\s*['"`]([A-Za-z][\w-]*)['"`]\s*\)/g)) anchors.push({ at: match.index, kind: 'tagCollection', value: match[1] });
  if (!anchors.length) return null;
  return anchors.sort((a, b) => a.at - b.at).at(-1);
}

function e7Constrained(control) { return Number(control?.maxLength) > 0 || Number(control?.minLength) > 0; }

function firstWriteViolations(script, probe) {
  const text = String(script || '');
  const controls = Array.isArray(probe) ? probe : Array.isArray(probe?.controls) ? probe.controls : [];
  const knownIds = Array.isArray(probe?.ids) ? probe.ids : null;
  const violations = [];
  let unresolved = 0;
  for (const write of valueWriteLiterals(text)) {
    const length = write.literal.length;
    // The anchor scan runs up to the literal's own start so an anchor INSIDE
    // the write expression (getElementById('tax').value) is still seen.
    const anchor = e7WriteAnchor(text.slice(0, write.valueIndex));
    // A write with no parseable anchor at all (opaque variable provenance)
    // cannot be verified — the caller allows it and logs a HARNESS notice.
    if (!anchor) { unresolved += 1; continue; }
    let target = null;
    if (anchor.kind === 'id') {
      if (knownIds && !controls.some((c) => String(c?.id || '') === anchor.value) && !knownIds.includes(anchor.value)) { unresolved += 1; continue; }
      target = controls.find((c) => String(c?.id || '') === anchor.value) || null;
      // An id that exists on the page but is NOT a form control: constraints
      // do not apply — the write passes.
      if (!target && knownIds && knownIds.includes(anchor.value)) continue;
    } else if (anchor.kind === 'name') {
      target = controls.find((c) => String(c?.name || '') === anchor.value) || null;
    } else if (anchor.kind === 'tag' || (anchor.kind === 'tagCollection' && write.bracketIndex !== null)) {
      const tag = String(anchor.value).toLowerCase();
      const n = anchor.kind === 'tag' ? anchor.n : write.bracketIndex;
      const candidates = controls.filter((c) => String(c?.tag || '').toLowerCase() === tag);
      target = candidates[n] || null;
    } else {
      // tagCollection without a bracket on the write itself: unverifiable.
      unresolved += 1;
      continue;
    }
    if (!target) { unresolved += 1; continue; }
    if (!e7Constrained(target)) continue; // unconstrained control: passes
    const max = Number(target.maxLength) || 0;
    const min = Number(target.minLength) || 0;
    const where = `${String(target.tag || 'control')}${String(target.id || target.name || '') ? ` (${String(target.id || target.name).slice(0, 40)})` : ''}`;
    if (max > 0 && length > max) {
      violations.push(`a first-write of a ${length}-character value into ${where} whose own maxLength is ${max} — no prior rejection is needed; the control's own constraint is the limit.`);
    } else if (min > 0 && length < min) {
      violations.push(`a first-write of a ${length}-character value into ${where} whose own minLength is ${min} — no prior rejection is needed; the control's own constraint is the limit.`);
    }
  }
  return { violations, unresolved };
}

// ---------- E4 (gen4) requirement ledger ----------
// Three generations of debt: the generic done-bounce names no specific gap.
// Numbered requirements in the task text (A1) … B2) … or plain 1. 2. 3.)
// seed per-requirement entries at run start; the completion_review bounce
// names the specific open requirement + its missing evidence; a done is
// accepted on the ledger when every requirement's evidence is settled.
function parseNumberedRequirements(task) {
  const text = String(task || '');
  if (!text.trim()) return [];
  const requirements = [];
  const letterAnchors = [...text.matchAll(/\b([A-Z]\d{1,2})\s*[).:]\s*/g)];
  if (letterAnchors.length >= 2) {
    for (let i = 0; i < letterAnchors.length; i += 1) {
      const start = letterAnchors[i].index + letterAnchors[i][0].length;
      const end = i + 1 < letterAnchors.length ? letterAnchors[i + 1].index : text.length;
      const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
      if (body) requirements.push({ id: letterAnchors[i][1], text: body.slice(0, 300) });
    }
  } else {
    const numeric = [...text.matchAll(/(?:^|\n)\s*(\d{1,2})[.)]\s+([^\n]+)/g)];
    if (numeric.length >= 2) {
      for (const match of numeric) requirements.push({ id: `R${match[1]}`, text: String(match[2]).replace(/\s+/g, ' ').trim().slice(0, 300) });
    }
  }
  return requirements.slice(0, 12);
}

function requirementWords(text) { return new Set(String(text || '').toLowerCase().match(/[a-z0-9]{4,}/g) || []); }

// E8 (gen6) fix (a): score word-overlap against the requirement's IMPERATIVE
// HEAD — the first sentence/clause, up to the first sentence period or a
// conditional "If " — not the full text. The gen6-preflight run completed its
// entire task yet R1 ("Sign in. If sign-in fails, read what the page tells
// you before retrying.") stayed open forever: the full text's 12-word
// conditional tail diluted a 2-word imperative head below the 0.3 threshold
// (the "Sign in" click's pool {sign} scored 1/8 = 0.125 < 0.3). The tail is
// context, never part of the denominator. A requirement that OPENS with its
// condition ("If the requested slot is unavailable, book ...") has an empty
// head — the full text is the fallback so the head cut can only shrink a
// score the old matcher under-counted, never widen one it correctly rejected.
function requirementHeadText(text) {
  const full = String(text || '').replace(/\s+/g, ' ').trim();
  if (!full) return '';
  const period = /(?:\.\s|\.$)/.exec(full);
  const conditional = /\bIf\s/.exec(full);
  let cut = full.length;
  if (period) cut = Math.min(cut, period.index);
  if (conditional) cut = Math.min(cut, conditional.index);
  const head = full.slice(0, cut).trim();
  return requirementWords(head).size ? head : full;
}

// F1 (gen5) E4 matcher: make the settle promise true. The gen4 judges measured
// three production defects in the old matcher: (a) execute-driven fills carry
// an empty expectedOutcome and a URL-shaped target, so they had ZERO coverage
// forever and each rebuild was "taught" by a gate whose bounce text promised a
// settle path that did not exist; (b) probes/read-backs settled nothing — no
// code path led from a probe result to the ledger; (c) the 0.3-of-the-SMALLER-
// set word lottery false-settled (a click's two outcome words clearing a
// 15-word fill requirement). The rework:
//   Path 1 — observed-effect work settles when its words (target + expected
//     outcome + the call's own input text) cover >= 0.3 of the REQUIREMENT's
//     words (not of the smaller set — the false-settle fix);
//   Path 2 — a successful probe/read-back that postdates a successful
//     mutation and reads back a value matching the requirement settles it
//     (the bounce text's "a fresh probe, read-back, or observed result settles
//     a requirement" is now true as coded).
// requirementSettleEvidence returns the settle-evidence string (recorded in
// the ledger entry so a bounced agent — and the judge — can see what the gate
// counted) or null; requirementCovered keeps its boolean contract.
const E4_PROBE_TOOLS = ['browser_execute', 'browser_query', 'browser_extract', 'browser_observe', 'browser_fetch'];
// Pure-utility code tokens never carry attribution on their own — a probe
// script's scaffolding (document, querySelectorAll, return) must not count
// toward matching a requirement.
const E4_CODE_STOPWORDS = new Set(['document', 'window', 'queryselector', 'queryselectorall', 'getelementbyid', 'getelementsbyname', 'getelementsbytagname', 'return', 'value', 'length', 'index', 'element', 'elements', 'function', 'const', 'let', 'await', 'async', 'true', 'false', 'null', 'undefined', 'addeventlistener', 'dispatchevent', 'innerhtml', 'textcontent', 'style', 'classlist', 'removeattribute', 'https', 'http', 'localhost', 'object']);

function workSettleEvidence(req, completedWork) {
  const reqWords = requirementWords(requirementHeadText(req?.text));
  if (!reqWords.size) return 'the requirement text has no comparable words; accepted as covered';
  for (const entry of Array.isArray(completedWork) ? completedWork : []) {
    if (entry?.effectObserved !== true) continue;
    const poolWords = requirementWords(`${entry?.target || ''} ${entry?.expectedOutcome || ''} ${entry?.inputHint || ''}`);
    const shared = [...poolWords].filter((word) => reqWords.has(word));
    if (shared.length / reqWords.size >= 0.3) {
      return `observed ${String(entry.action || 'work')} covering {${shared.slice(0, 6).join(', ')}} (evidence rev ${Number(entry?.observedRevision) || '?'}): "${String(entry?.target || '').slice(0, 60)}"`;
    }
  }
  return null;
}

function probeSettleEvidence(req, history) {
  // E8 fix (a): the same imperative-head denominator as the work path — a
  // conditional tail is context for probes too.
  const reqWords = requirementWords(requirementHeadText(req?.text));
  if (!reqWords.size) return null;
  const entries = Array.isArray(history) ? history : [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    const tool = String(entry?.tool || '');
    if (!E4_PROBE_TOOLS.includes(tool) || entry?.output?.ok !== true) continue;
    const result = entry?.output?.result;
    // A null or error result confirms nothing (prompt rule 4).
    if (result === null || result === undefined) continue;
    if (typeof result === 'string' && !result.trim()) continue;
    if (typeof result === 'object' && !Array.isArray(result) && !Object.keys(result).length) continue;
    // The read-back must postdate an earlier successful mutation by a
    // DIFFERENT entry — a bare read with no work behind it settles nothing.
    const earlierMutation = entries.some((other, j) => j < i
      && other?.output?.ok === true
      && (isMutation(String(other?.tool || ''), other?.input || {}) || other?.tool === 'browser_fill'));
    if (!earlierMutation) continue;
    const probeText = [
      entry?.input?.script,
      entry?.input?.selector,
      entry?.input?.query,
      typeof result === 'string' ? result : JSON.stringify(result)
    ].map((part) => String(part || '')).join(' ').slice(0, 2000);
    const probeWords = new Set([...requirementWords(probeText)].filter((word) => !E4_CODE_STOPWORDS.has(word)));
    const shared = [...probeWords].filter((word) => reqWords.has(word));
    if (shared.length >= 1) {
      return `probe ${tool} at history #${i + 1} read back matching value(s) {${shared.slice(0, 4).join(', ')}} after the run's mutation`;
    }
  }
  return null;
}

// E8 (gen6) fix (b): the state-transition settle class. Sign-in / log-out
// requirements produce no value read-back (probeSettleEvidence cannot apply),
// and their actions' word pools are too small to clear any overlap threshold —
// the "Log out" button's pool is literally EMPTY ("log" and "out" both sit
// under the 4-char token floor), so gen6's R8 ("Log out and verify the
// sign-in screen is displayed again.") scored 0/5 and could never settle no
// matter how the run performed. The ONLY honest evidence for a state
// transition is the observed screen-state change itself, and it is fully
// deterministic — no NLP, no per-app marker vocabulary:
//   * A click can only land on a visible, enabled control, so each
//     successful, effect-observed click on a login/logout affordance proves
//     the screen that owns that control was displayed at that evidence
//     revision.
//   * A login requirement ("Sign in ...") settles when the observed login
//     click is followed by an observed logout click (only an authenticated
//     screen offers "Log out"), or the newest observation fingerprint still
//     shows the logout affordance.
//   * A logout requirement ("Log out and verify the sign-in screen ...")
//     settles when the observed logout click is followed by an observed login
//     click (only the sign-in screen offers a clickable "Sign in"), or the
//     newest observation fingerprint shows the sign-in affordance with no
//     logout affordance.
// The transition direction is the FIRST transition verb in the requirement's
// head ("Log out and verify the sign-in screen..." is a logout requirement
// even though its tail mentions sign-in).
const E4_LOGIN_AFFORDANCE = /(?:^|[^a-z])(?:sign|log)[\s_-]?in(?![a-z])|(?:^|[^a-z])(?:login|signin|log-in|sign-in)(?![a-z])/i;
const E4_LOGOUT_AFFORDANCE = /(?:^|[^a-z])(?:sign|log)[\s_-]?(?:out|off)(?![a-z])|(?:^|[^a-z])(?:logout|signout|log-out|sign-out)(?![a-z])/i;

function requirementTransitionDirection(req) {
  const head = requirementHeadText(req?.text);
  const login = E4_LOGIN_AFFORDANCE.exec(head);
  const logout = E4_LOGOUT_AFFORDANCE.exec(head);
  if (!login && !logout) return null;
  if (login && logout) return logout.index < login.index ? 'logout' : 'login';
  return login ? 'login' : 'logout';
}

// Only a click is trusted as affordance evidence (a fill's value could belong
// to any screen; a click's target had to be on screen). The entry id carries
// the raw target tuple ("button","sign in","sign in","loginBtn") so id+target
// covers element names, selectors, and test ids.
function workAffordance(entry) {
  if (String(entry?.action || '') !== 'browser_click') return null;
  const text = `${entry?.target || ''} ${entry?.id || ''}`;
  if (E4_LOGOUT_AFFORDANCE.test(text)) return 'logout';
  if (E4_LOGIN_AFFORDANCE.test(text)) return 'login';
  return null;
}

// The newest observation fingerprint (observationFingerprint's own JSON) holds
// the current page's element names/texts — a deterministic record of the
// screen the run is on. Malformed/absent fingerprints return null (no claim).
function fingerprintAffordances(coordinator) {
  let snapshot = null;
  try { snapshot = JSON.parse(String(coordinator?.fingerprint || '')); } catch { return null; }
  if (!snapshot || typeof snapshot !== 'object') return null;
  const parts = [];
  for (const element of Array.isArray(snapshot.elements) ? snapshot.elements : []) parts.push(element?.[2], element?.[3]);
  for (const landmark of Array.isArray(snapshot.landmarks) ? snapshot.landmarks : []) parts.push(landmark?.[2], landmark?.[3]);
  const text = parts.filter((part) => typeof part === 'string').join(' ');
  if (!text) return null;
  return { login: E4_LOGIN_AFFORDANCE.test(text), logout: E4_LOGOUT_AFFORDANCE.test(text) };
}

function transitionSettleEvidence(req, completedWork, coordinator = null) {
  const direction = requirementTransitionDirection(req);
  if (!direction) return null;
  const opposite = direction === 'login' ? 'logout' : 'login';
  const entries = (Array.isArray(completedWork) ? completedWork : [])
    .map((entry) => ({ entry, affordance: workAffordance(entry), revision: Number(entry?.observedRevision) || 0 }))
    .filter((item) => item.affordance !== null && item.entry?.effectObserved === true);
  const source = entries.filter((item) => item.affordance === direction).sort((a, b) => a.revision - b.revision)[0];
  if (!source) return null;
  const screen = direction === 'login' ? 'the authenticated screen' : 'the sign-in screen';
  const proof = entries.filter((item) => item.affordance === opposite && item.revision > source.revision)
    .sort((a, b) => a.revision - b.revision)[0];
  if (proof) {
    return `state transition settled: the observed ${direction} click at evidence rev ${source.revision} was followed by an observed ${opposite} click at rev ${proof.revision} — only ${screen} offers that control, so the page state moved the way the requirement names`;
  }
  const visible = fingerprintAffordances(coordinator);
  if (visible && visible[opposite] && !(direction === 'logout' && visible[direction])) {
    return `state transition settled: the newest observation shows the ${opposite} affordance — ${screen} is displayed after the observed ${direction} click at evidence rev ${source.revision}`;
  }
  return null;
}

function requirementSettleEvidence(req, completedWork, { history = [], coordinator = null } = {}) {
  const transition = transitionSettleEvidence(req, completedWork, coordinator);
  if (transition) return transition;
  const work = workSettleEvidence(req, completedWork);
  if (work) return work;
  return probeSettleEvidence(req, history);
}

function requirementCovered(req, completedWork, evidence = {}) {
  return requirementSettleEvidence(req, completedWork, evidence) !== null;
}

// Settle pass at done time: observed-effect work whose words cover a
// requirement settles it; the done summary may explicitly defer one.
// F1 (d): the settle evidence is recorded on the entry (req.settledBy) so the
// ledger shows WHICH trace step settled each requirement.
function settleRequirementLedger(run, summary = '') {
  const ledger = Array.isArray(run?.requirementLedger) ? run.requirementLedger : [];
  if (!ledger.length) return { ledger, open: [] };
  const text = String(summary || '');
  const history = Array.isArray(run?.history) ? run.history : [];
  for (const req of ledger) {
    if (req.status !== 'open') continue;
    if (new RegExp(`\\b${req.id}\\b[^.]{0,80}\\b(skipped|deferred|not applicable|n\\/a)\\b`, 'i').test(text)
      || new RegExp(`\\b(skipped|deferred|not applicable|n\\/a)\\b[^.]{0,80}\\b${req.id}\\b`, 'i').test(text)) {
      req.status = 'deferred';
      continue;
    }
    const evidence = requirementSettleEvidence(req, run?.coordinator?.completedWork, { history, coordinator: run?.coordinator || null });
    if (evidence) {
      req.status = 'evidenced';
      req.settledBy = String(evidence).slice(0, 300);
    }
  }
  return { ledger, open: ledger.filter((req) => req.status === 'open') };
}

// E7: record a fill the page rejected (the fill-gate constraint rejection) so
// the tamper gateway can catch the immediate script bypass. Bounded window;
// pure state update, no gating on its own.
// Gen4 hardening: the entry also carries the control's DOM POSITION identity —
// its tag and its index among same-tag elements in the snapshot — because
// arch4-untimed-r1 evaded the detector with a positional selector
// (`querySelectorAll('input')[1]`) 1-3 decisions after the rejection. Entries
// carry a short TTL in observation revisions so the alias window cannot stay
// armed forever.
const REJECTED_FILL_TTL_REVISIONS = 10;
function recordRejectedFill(state, { index, name, tag, position } = {}) {
  if (!state || !Array.isArray(state.rejectedFills)) return;
  const entry = {
    ...(Number.isFinite(Number(index)) ? { index: Number(index) } : {}),
    ...(String(name || '').trim() ? { name: String(name).trim().slice(0, 80) } : {}),
    ...(String(tag || '').trim() ? { tag: String(tag).trim().toLowerCase().slice(0, 24) } : {}),
    ...(Number.isFinite(Number(position)) && Number(position) >= 0 ? { position: Number(position) } : {}),
    armedAt: Number(state.observationRevision) || 0,
    ttl: REJECTED_FILL_TTL_REVISIONS
  };
  if (!('index' in entry) && !('name' in entry)) return;
  state.rejectedFills = [...state.rejectedFills, entry].slice(-4);
}

// A rejected-fill entry is armed for a short window of observation revisions.
// Legacy entries (no armedAt — restored seeds) stay valid: the original
// same-step window never expired either.
function rejectedFillActive(state, entry) {
  const armedAt = Number(entry?.armedAt);
  if (!Number.isFinite(armedAt)) return true;
  return (Number(state?.observationRevision) || 0) - armedAt <= Number(entry?.ttl ?? REJECTED_FILL_TTL_REVISIONS);
}

function stableDigest(value) {
  const canonicalize = item => Array.isArray(item) ? item.map(canonicalize)
    : item && typeof item === 'object' ? Object.fromEntries(Object.keys(item).sort().map(key => [key, canonicalize(item[key])])) : item;
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function repeatedReadResult(state, call, output) {
  const name = call?.name, input = call?.input || {}, result = output?.result;
  const readsEvidence = ['browser_tabs', 'browser_observe', 'browser_console_entries', 'browser_network_entries', 'browser_navigation_state', 'browser_query', 'browser_extract', 'browser_fetch'].includes(name)
    || name === 'computer_file' && ['list', 'read', 'stat', 'search'].includes(input.action)
    || name === 'computer_terminal' && input.action === 'read' && Boolean(input.jobId);
  // An active job can be quiet. GUI actions/captures have incomplete effect
  // evidence, and unrelated writes invalidate earlier read-result comparisons.
  if (!readsEvidence || output?.ok !== true || output.progress === true || ['running', 'queued', 'pending'].includes(result?.state)) {
    state.recentReadResults = [];
    return null;
  }
  const key = stableDigest([name, input, output]);
  const recent = state.recentReadResults = [...(state.recentReadResults || []), key].slice(-6);
  const identical = recent.length >= LOOP_DETECTION_THRESHOLD && recent.slice(-LOOP_DETECTION_THRESHOLD).every(item => item === key);
  const alternating = recent.length === 6 && recent[0] !== recent[1] && recent.every((item, index) => item === recent[index % 2]);
  if (!identical && !alternating) return null;
  state.recentReadResults = [];
  state.metrics.loopBreaks = (state.metrics.loopBreaks || 0) + 1;
  return `${alternating ? 'Alternating reads' : 'Repeated reads'} returned identical evidence ${alternating ? 'across three cycles' : 'five times'}. Treat the results as evidence and decide whether to read again, act, wait, change approach, or answer.`;
}

function recordAction(state, { hash, mutates, output, expectation = null, fingerprint = state.fingerprint, call = null, observation = null }) {
  const loopIssue = repeatedReadResult(state, call, output);
  if (!mutates) return loopIssue;
  // E3: every successful page mutation advances the mutation sequence, so any
  // later mutation is newer than every earlier fill's read-back proof. Failed
  // mutations change nothing and leave the sequence — but a FAILED fill is
  // direct read-back evidence that its (target, value) does not currently
  // hold, so it voids the matching ledger proof instead.
  if (output?.ok === true) state.mutationSeq = (Number(state.mutationSeq) || 0) + 1;
  if (call?.name === 'browser_fill' && output?.ok === false && state.fillLedger.length) {
    const failedHash = String(hash || '');
    state.fillLedger = state.fillLedger.filter((item) => !String(item.key || '').startsWith(`${failedHash}|`));
  }
  // Dispatch success is not page progress. Only explicit post-action evidence
  // may set expectedChangeMissing/progress in a future verification probe.
  const progress = output?.progress === true;
  const native = nativeMutation(call), evidence = native ? nativeEvidence(observation) : null;
  state.actionHashes = [...state.actionHashes, {
    hash,
    fingerprint,
    progress,
    ok: output?.ok === true,
    expectedOutcome: expectationKey(expectation),
    ...(native ? { nativeEvidence: evidence, nativeEffect: null } : {})
  }].slice(-MAX_ACTIONS);
  const work = output?.ok === true ? completedWorkEntry(call, output, hash, expectation) : null;
  if (work) state.completedWork = [...state.completedWork, work].slice(-MAX_COMPLETED_WORK);
  // E3: ledger successful fills for the idempotent-mutation gateway. The next
  // observation settles the entry (recordObservation). The entry carries the
  // mutation sequence as of its own dispatch: the gateway short-circuits a
  // refill only while this is still the newest page mutation, so any later
  // mutation, navigation or failed same-value fill voids the proof and the
  // refill executes normally (a reloaded checkout form must refill).
  if (call?.name === 'browser_fill' && output?.ok === true) {
    state.fillLedger = [...state.fillLedger, {
      key: fillKey(hash, call.input?.text),
      beforeFingerprint: fingerprint,
      effectObserved: false,
      appliedFingerprint: null,
      mutationSeq: state.mutationSeq,
      proof: {
        matched: output.result?.matched,
        changed: output.result?.changed,
        value: output.result?.value
      }
    }].slice(-MAX_FILLS);
  }
  state.lastMutation = {
    hash,
    ok: output?.ok === true,
    beforeFingerprint: fingerprint,
    awaitingObservation: output?.ok === true,
    effectObserved: false,
    observedFingerprint: null,
    observedRevision: 0,
    expectedOutcome: expectationKey(expectation),
    workId: work?.id || null,
    reportedProgress: progress,
    ...(native ? { native: true, nativeEvidence: evidence } : {})
  };
  if (output?.ok === true) state.pendingMutations.push({ hash, beforeFingerprint: fingerprint, workId: work?.id || null, reportedProgress: progress,
    ...(native ? { native: true, nativeEvidence: evidence } : {}) });
  if (progress) state.replansWithoutProgress = 0;
  return loopIssue;
}

// Stage C (harness merge v5): one consolidated progress assessment computed
// from state fragments that already exist — recordObservation's changed flag
// (passed by the caller), the read-result ledger, the mutation ledger's settled
// effect, completed-work evidence revisions, and plan status transitions. Pure:
// it computes an assessment; the consumer steers, it never blocks or fails.
function madeProgress(state, { observationChanged = false, planStatusChanged = false, lastProgressRevision = 0 } = {}) {
  const assessment = {
    newEvidence: observationChanged === true
      || (Array.isArray(state.recentReadResults) && state.recentReadResults.length === 1),
    stateChanged: state.lastMutation?.effectObserved === true || state.lastMutation?.reportedProgress === true,
    artifactChanged: Array.isArray(state.completedWork)
      && state.completedWork.some((entry) => entry?.effectObserved === true
        && Number(entry?.observedRevision || 0) > Number(lastProgressRevision || 0)),
    criterionChanged: planStatusChanged === true,
    repeatedFailure: Number(state.replansWithoutProgress || 0) >= 2 && state.lastMutation?.ok === false
  };
  assessment.progress = assessment.newEvidence || assessment.stateChanged
    || assessment.artifactChanged || assessment.criterionChanged;
  return assessment;
}

function recordFacts(state, facts) {  if (!Array.isArray(facts)) return state.facts;
  const additions = facts.map((fact) => String(fact || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4);
  state.facts = [...state.facts, ...additions].filter((fact, index, all) => all.indexOf(fact) === index).slice(-MAX_FACTS);
  return state.facts;
}

function shouldCaptureAuto({ vision, navigation, hasCurrentScreenshot, needsVisualEvidence }) {
  if (vision === 'always') return true;
  if (vision !== 'auto' || navigation?.loading || hasCurrentScreenshot) return false;
  return Boolean(needsVisualEvidence);
}

function isMutation(name, input = {}) {
  if (isComputerTool(name)) return !computerReadOnly(name, input);
  return ['browser_execute', 'browser_click', 'browser_target_click', 'browser_drag', 'browser_target_drag', 'browser_type', 'browser_fill', 'browser_scroll', 'browser_key', 'browser_go_back', 'browser_gesture', 'browser_set_device_mode', 'browser_navigate', 'browser_new_tab', 'browser_select_tab', 'browser_focus_tab', 'browser_search'].includes(name);
}

function normalize(value) { return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
function bucket(value) { const number = Number(value) || 0; return Math.sign(number) * Math.min(1000, Math.round(Math.abs(number) / 100) * 100); }
function canonicalUrl(value) { try { return new URL(String(value || '')).toString(); } catch { return String(value || ''); } }
function normalizeInput(input) {
  return Object.fromEntries(Object.entries(input || {}).filter(([key]) => ![
    'element',
    'index',
    'text',
    'expect',
    'repeat',
    'title',
    'description',
    'reason',
    'label'
  ].includes(key)).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 200) : value]));
}

function expectationKey(expectation) {
  if (expectation === undefined || expectation === null || expectation === '') return '';
  if (typeof expectation === 'string') return normalize(expectation);
  try { return JSON.stringify(expectation, Object.keys(expectation || {}).sort()); } catch { return normalize(expectation); }
}

function normalizeCompletedWork(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_COMPLETED_WORK).map((entry, index) => ({
    id: String(entry?.id || `restored-${index}`).slice(0, 600),
    action: String(entry?.action || '').slice(0, 80),
    target: String(entry?.target || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    expectedOutcome: String(entry?.expectedOutcome || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    ...(String(entry?.inputHint || '').trim() ? { inputHint: String(entry?.inputHint).replace(/\s+/g, ' ').trim().slice(0, 300) } : {}),
    effectObserved: entry?.effectObserved === true,
    observedRevision: Number(entry?.observedRevision || 0)
  })).filter((entry) => entry.action);
}

function completedWorkEntry(call, output, hash, expectation) {
  if (!call?.name) return null;
  const result = output?.result || {};
  const element = result?.element || {};
  const target = [element.name, element.text, element.dataTool, element.testId]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || coordinateTarget(call) || publicUrlTarget(result.url || call.input?.url) || 'current page';
  // F1 (gen5): the call's own input text (an execute script's field references,
  // a fill's value) joins the attribution pool. Execute-driven fills carry an
  // empty expectedOutcome and a URL-shaped target — without the input hint
  // they could never cover their requirement and every rebuild was "taught" by
  // the gate.
  const inputHint = String(call.input?.script || call.input?.text || call.input?.patch || call.input?.content || call.input?.command || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return {
    id: String(hash || `${call.name}:${Date.now()}`).slice(0, 600),
    action: String(call.name).slice(0, 80),
    target: target.slice(0, 160),
    expectedOutcome: expectationKey(expectation).slice(0, 500),
    ...(inputHint ? { inputHint } : {}),
    effectObserved: false,
    observedRevision: 0
  };
}

function coordinateTarget(call) {
  const input = call?.input || {};
  if (call?.name === 'computer_patch' || call?.name === 'computer_write') return `file ${String(input.path || '').split(/[\\/]/).pop().slice(0, 80)}`;
  if (call?.name === 'computer_terminal') return `terminal ${String(input.command || '').replace(/\s+/g, ' ').trim().slice(0, 100)}`;
  if (call?.name === 'computer_keyboard') return input.action === 'text' ? 'focused native text control' : `native key ${String(input.key || '').slice(0, 40)}`;
  if (call?.name === 'computer_stroke') return `native window ${String(input.windowId || '').slice(0, 30)}; ${input.strokes?.length || 0} strokes dispatched`;
  if (call?.name === 'computer_pointer') return `native ${input.action || 'input'} ${Number.isFinite(input.x) ? Math.round(input.x) : '?'},${Number.isFinite(input.y) ? Math.round(input.y) : '?'} (${input.coordinateSpace || 'desktop'})`;
  if (call?.name === 'computer_window') return `native window ${String(input.windowId || '').slice(0, 30)}`;
  if (call?.name === 'browser_click' && hasCoordinatePair(input)) {
    return `viewport point ${Math.round(Number(input.x))},${Math.round(Number(input.y))}`;
  }
  if (call?.name === 'browser_drag' && [input.startX, input.startY, input.endX, input.endY].every((value) => Number.isFinite(Number(value)))) {
    return `viewport drag ${Math.round(Number(input.startX))},${Math.round(Number(input.startY))} to ${Math.round(Number(input.endX))},${Math.round(Number(input.endY))}`;
  }
  if (call?.name === 'browser_key') return `key ${String(input.key || '').slice(0, 40)}`;
  return '';
}

function publicUrlTarget(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.origin}${url.pathname}`.slice(0, 160);
  } catch { return ''; }
}

module.exports = { measureProviderRequest, createCoordinatorState, recordObservation, actionHash, canAttempt, recordAction, recordFacts, madeProgress, shouldCaptureAuto, isMutation, observationFingerprint, bumpNavigationEpoch, staleAnchor, fillGate, constraintTamper, presentationTamper, PRESENTATION_TAMPER_ADVISORY, recordRejectedFill, CONFLICT_PROTOCOL_ADVISORY, LOOP_DETECTION_THRESHOLD, unbackedActionClaims, valueWriteLiterals, firstWriteViolations, parseNumberedRequirements, settleRequirementLedger, requirementCovered, requirementSettleEvidence, completedWorkEntry, rejectedFillActive, requirementHeadText, requirementTransitionDirection, transitionSettleEvidence, hasCoordinatePair };
