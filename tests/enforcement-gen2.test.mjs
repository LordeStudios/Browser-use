import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createCoordinatorState, recordObservation, recordAction, actionHash, bumpNavigationEpoch, staleAnchor, fillGate, hasCoordinatePair } = require('../desktop/agent/desktopAgentCoordinator.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obsA = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Name field' }, { index: 1, tag: 'input', name: 'Mail field' }] } };
const obsB = { navigation: { url: 'https://fixture.invalid/b', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Other field' }] } };

// ---------- E1: navigation epoch / stale-anchor rejection ----------

test('E1 mixed coordinate clicks stay coordinate-authoritative across string normalization', () => {
  const state = createCoordinatorState();
  const call = { name: 'browser_click', input: { x: '150', y: '90', element: 999 } };
  recordObservation(state, obsA);
  assert.equal(hasCoordinatePair(call.input), true);
  bumpNavigationEpoch(state);
  assert.equal(staleAnchor(state, call), null, 'coordinate clicks must not be rejected as stale element anchors');
  assert.match(actionHash(call), /coordinate/);
});

test('E1 element index with schema-default (0,0) coordinates means the element, not the page origin', () => {
  // Lichess log: {"element": 6, "x": 0, "y": 0} took the coordinate path and
  // clicked whatever sat at the page's top-left corner (hit: label.hbg). The
  // (0,0) pair beside an element index is the schema placeholder, not a point.
  assert.equal(hasCoordinatePair({ element: 6, x: 0, y: 0 }), false);
  assert.equal(hasCoordinatePair({ index: '6', x: '0', y: '0' }), false, 'string-normalized placeholder counts too');
  assert.equal(hasCoordinatePair({ x: 0, y: 0 }), true, 'a bare (0,0) with no element IS a deliberate origin click');
  assert.equal(hasCoordinatePair({ element: 6, x: 0, y: 40 }), true, 'non-origin coordinates stay coordinate-authoritative');
  assert.equal(hasCoordinatePair({ element: 6, x: 10, y: 0 }), true);

  const state = createCoordinatorState();
  recordObservation(state, obsA);
  const call = { name: 'browser_click', input: { element: 6, x: 0, y: 0 } };
  assert.ok(!/coordinate/.test(actionHash(call)), 'the placeholder click keys on the element, not the origin point');
  bumpNavigationEpoch(state);
  const rejected = staleAnchor(state, call);
  assert.ok(rejected, 'an element+placeholder click is an element anchor: post-navigation it must be rejected as stale');
  assert.match(rejected.advisory, /STALE ANCHOR/);
});

test('E1 gateway: fresh anchors pass; post-navigation element anchors are rejected with the fix named; x/y passes', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  const fill = { name: 'browser_fill', input: { index: 0, text: 'Ada' } };
  assert.equal(staleAnchor(state, fill), null, 'anchors from the current observation are fresh');
  assert.equal(staleAnchor(state, { name: 'browser_key', input: { key: 'Enter' } }), null, 'non-anchor tools pass');
  assert.equal(staleAnchor(state, { name: 'browser_click', input: { x: 120, y: 80 } }), null, 'coordinate actions pass');
  bumpNavigationEpoch(state);
  const rejected = staleAnchor(state, fill);
  assert.ok(rejected, 'element-index anchor from before the navigation is stale');
  assert.equal(rejected.allowed, false);
  assert.match(rejected.advisory, /STALE ANCHOR/);
  assert.match(rejected.advisory, /navigated/);
  assert.match(rejected.advisory, /re-observe/i);
  assert.equal(staleAnchor(state, { name: 'browser_click', input: { x: 150, y: 90 } }), null, 'x/y still passes after navigation');
  recordObservation(state, obsB);
  assert.equal(staleAnchor(state, fill), null, 'the fresh observation re-mints the anchors');
});

test('E1 dispatch: navigate then index-fill in one batch is rejected before execution and names the fix', async () => {
  const executed = [];
  let coordinateClick = false;
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [
      { name: 'browser_navigate', input: { url: 'https://fixture.invalid/b' } },
      { name: 'browser_fill', input: { index: 0, text: 'blind fill' } }
    ] };
    if (turn === 2) return { actions: [{ name: 'browser_click', input: { x: 150, y: 90 } }] };
    return final;
  }, async (name) => { executed.push(name); return { content: 'ok' }; }, {
    navigate: async () => ({ url: 'https://fixture.invalid/b' }),
    clickAt: async (tabId, point) => { coordinateClick = true; return { x: point.x, y: point.y }; },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Name field' }] }]])
  });
  const run = await h.start({});
  assert.equal(executed.includes('browser_fill'), false, 'the stale fill never reached the page');
  assert.ok(coordinateClick, 'the x/y click after re-observation passed the gateway');
  const rejection = run.history.find((entry) => entry.tool === 'browser_fill');
  assert.ok(rejection, 'the rejection is in the visible history');
  assert.equal(rejection.output.ok, false);
  assert.equal(rejection.output.recoverySource, 'stale_element');
  assert.match(rejection.output.error, /STALE ANCHOR/);
  assert.match(rejection.output.error, /re-observe/i);
  assert.equal(run.result.success, true);
  assert.equal(run.result.reason, undefined);
});

// ---------- E3: idempotent-mutation gateway ----------

test('E3 gateway: duplicate fill returns alreadySet with the prior proof; changed value/target or page change executes', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  const fill = { name: 'browser_fill', input: { element: 0, text: 'hello' } };
  const hash = actionHash(fill);
  assert.equal(fillGate(state, hash, fill), null, 'no prior fill, no gate');
  recordAction(state, { hash, mutates: true, call: fill, output: { ok: true, result: { matched: true, changed: true, value: 'hello' } } });
  assert.equal(fillGate(state, hash, fill), null, 'an unsettled fill does not gate');
  recordObservation(state, obsA);
  const gate = fillGate(state, hash, fill);
  assert.ok(gate?.alreadySet === true, 'identical (target, value) after observed effect gates');
  assert.equal(gate.proof.changed, true);
  assert.equal(gate.proof.value, 'hello');
  assert.match(gate.advisory, /already in place/);
  const sameLength = { name: 'browser_fill', input: { element: 0, text: 'bells' } };
  assert.equal(fillGate(state, actionHash(sameLength), sameLength), null, 'same-length different value executes');
  const changedTarget = { name: 'browser_fill', input: { element: 1, text: 'hello' } };
  assert.equal(fillGate(state, actionHash(changedTarget), changedTarget), null, 'changed target executes');
  recordObservation(state, obsB);
  assert.equal(fillGate(state, hash, fill), null, 'a page change since application executes again');
});

test('E3 dispatch: identical refill short-circuits with alreadySet instead of executing again', async () => {
  let fillCount = 0;
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Ada Lovelace' } }] };
    if (turn === 2) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Ada Lovelace' } }] };
    if (turn === 3) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Different text' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async (tabId, input) => { fillCount += 1; return { ok: true, matched: true, changed: true, value: String(input?.text ?? '') }; },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Name field' }] }]])
  });
  const run = await h.start({});
  assert.equal(fillCount, 2, 'only the first fill and the changed-value fill executed');
  const fills = run.history.filter((entry) => entry.tool === 'browser_fill');
  assert.equal(fills.length, 3);
  assert.equal(fills[1].output.alreadySet, true);
  assert.equal(fills[1].output.ok, true);
  assert.equal(fills[1].output.result.value, 'Ada Lovelace');
  assert.match(fills[1].output.result.note, /already in place/);
  assert.equal(fills[2].output.alreadySet, undefined, 'the changed-value fill executed normally');
  assert.equal(run.result.success, true);
});

// ---------- E3 misfire regression (gen2 preflight): the ledger proof dies with any newer page evidence ----------

test('E3 misfire: later mutation, navigation, or failed same-value fill voids the proof — the refill executes', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  const fill = { name: 'browser_fill', input: { element: 0, text: 'Amara Nakato' } };
  const hash = actionHash(fill);
  recordAction(state, { hash, mutates: true, call: fill, output: { ok: true, result: { matched: true, changed: true, value: 'Amara Nakato' } } });
  recordObservation(state, obsA);
  assert.ok(fillGate(state, hash, fill)?.alreadySet === true, 'still gated: the fill read-back is the newest evidence');
  // The preflight misfire: a LATER mutation (the model clicks the field) whose
  // whole-page snapshot is unchanged — the old gate kept vouching for a value
  // it had not re-verified since the fill itself.
  const click = { name: 'browser_click', input: { element: 0 } };
  recordAction(state, { hash: actionHash(click), mutates: true, call: click, output: { ok: true, result: { index: 0 } } });
  assert.equal(fillGate(state, hash, fill), null, 'a later mutation voids the fill proof even when the fingerprint is unchanged');
  // Re-arm, then the exact preflight trigger: navigate away and back — the
  // reload mints fresh EMPTY fields the old read-back knows nothing about.
  recordAction(state, { hash, mutates: true, call: fill, output: { ok: true, result: { matched: true, changed: true, value: 'Amara Nakato' } } });
  recordObservation(state, obsA);
  bumpNavigationEpoch(state);
  assert.equal(fillGate(state, hash, fill), null, 'a navigation voids the whole ledger (a reloaded form must refill)');
  // Re-arm, then a failed same-value fill: live evidence the value does not hold.
  recordAction(state, { hash, mutates: true, call: fill, output: { ok: true, result: { matched: true, changed: true, value: 'Amara Nakato' } } });
  recordObservation(state, obsA);
  recordAction(state, { hash, mutates: true, call: fill, output: { ok: false, error: 'The control did not retain the requested value.' } });
  assert.equal(fillGate(state, hash, fill), null, 'a failed same-value fill voids the matching proof');
});

test('E3 misfire dispatch: fill, click, same fill — the third fill EXECUTES instead of returning alreadySet', async () => {
  let fillCount = 0;
  let clickCount = 0;
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Amara Nakato' } }] };
    if (turn === 2) return { actions: [{ name: 'browser_click', input: { element: 0 } }] };
    if (turn === 3) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Amara Nakato' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async (tabId, input) => { fillCount += 1; return { ok: true, matched: true, changed: true, value: String(input?.text ?? '') }; },
    clickElement: async () => { clickCount += 1; return { ok: true, index: 0 }; },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Name field' }] }]])
  });
  const run = await h.start({});
  assert.equal(clickCount, 1, 'the intervening click executed');
  assert.equal(fillCount, 2, 'the refill after the click EXECUTED (was: alreadySet misfire)');
  const refill = run.history.filter((entry) => entry.tool === 'browser_fill')[1];
  assert.equal(refill.output.alreadySet, undefined, 'the refill was not short-circuited');
  assert.equal(run.result.success, true);
});

// ---------- done-bounce loop regression (gen2 preflight): convergence ----------

test('done gate: a browser task linking file:/// fixture URLs is not a coding task — the verified done is not bounced', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Ada Lovelace' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async (tabId, input) => ({ ok: true, matched: true, changed: true, value: String(input?.text ?? '') }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Name field' }] }]])
  });
  const run = await h.start({}, { task: 'Fill the customer form at file:///F:/harness-lab/browser-use/tests/checkout.html and verify with page evidence' });
  const codingBounces = run.history.filter((entry) => entry.tool === 'browser_done' && /This coding task requires/.test(String(entry.output?.error || '')));
  assert.equal(codingBounces.length, 0, 'the fixture link must not classify the task as coding work');
  assert.equal(run.result.success, true);
});

test('done gate: after the forced review, the audited re-done with verified:true converges — audit probes do not re-arm the review', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Ada Lovelace' } }] };
    if (turn === 2) return { done: { summary: 'Requirement covered; the disclosed substitution is page-validated.', success: true, verified: true } };
    if (turn === 3) return { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async (tabId, input) => ({ ok: true, matched: true, changed: true, value: String(input?.text ?? '') }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Name field' }] }]])
  });
  const run = await h.start({}, { task: 'Fill the customer form at file:///F:/labs/tests/checkout.html then verify the payment step' });
  const proposals = run.history.filter((entry) => entry.tool === 'browser_done' && /Completion is a proposal/.test(String(entry.output?.error || '')));
  assert.equal(proposals.length, 1, 'exactly one forced review: the audit-and-re-done cycle must converge, not loop');
  assert.equal(run.result.success, true, 'the audited re-done was accepted');
});

// ---------- E2: one-shot harness event notices ----------

test('E2 wire: notices render into exactly one decision context', () => {
  const withNotices = boundedRequestContext({ task: 't', harnessNotices: ['PAGE CHANGED: re-observe before acting on remembered indices.'] });
  assert.deepEqual(withNotices.harnessNotices, ['PAGE CHANGED: re-observe before acting on remembered indices.']);
  assert.match(withNotices.harnessNoticesNote, /one-shot/i);
  const without = boundedRequestContext({ task: 't' });
  assert.equal(without.harnessNotices, undefined);
});

test('E2 dispatch: navigation and classified recovery arm one-shot notices that drain after one decision', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [{ name: 'browser_navigate', input: { url: 'https://fixture.invalid/b' } }] };
    // A quiet read arms nothing: the drained queue must stay empty.
    if (turn === 2) return { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }] };
    return final;
  }, async () => ({ content: 'ok' }), { navigate: async (tabId, url) => ({ url }) });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(seen[0] === null, 'no notices before any event');
  assert.ok(Array.isArray(seen[1]) && seen[1].some((line) => /PAGE CHANGED: re-observe before acting on remembered indices\./.test(line)), 'navigation notice rides with the next decision');
  assert.ok(!seen[2], 'notices are one-shot: drained, never repeated, never accumulated');
});

test('E2 dispatch: an out-of-workspace path EXECUTES (default-scope workspace, no root rejection)', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    // The declared workspace is the DEFAULT scope, never the only allowed
    // scope: a read far outside the run root executes normally (owner
    // directive 2026-10-11). The former workspace_scope rejection and its
    // "RECOVERED from SCOPE" notice are deliberately gone.
    if (turn === 1) return { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/old-checkout/file.txt' } }] };
    return final;
  });
  const run = await h.start({}, { workspace: { root: 'C:/current-checkout' } });
  assert.equal(run.result.success, true);
  const read = run.history.find((entry) => entry.tool === 'computer_file');
  assert.ok(read, 'the out-of-root read reached the executor');
  assert.equal(read.output.ok, true, 'the out-of-root read was not rejected');
  assert.equal(read.output.recoverySource, undefined, 'no workspace_scope recovery source anywhere');
  assert.ok(seen.every((entry) => !Array.isArray(entry) || !entry.some((line) => /RECOVERED from SCOPE/.test(line))), 'no scope-class recovery notice arms');
});

// ---------- E5: thought-budget steering ----------

test('E5: an over-budget deliberation arms a one-shot notice; three in a row feed the watchdog ladder', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((ctx) => {
    turn += 1;
    seen.push(Array.isArray(ctx.harnessNotices) ? [...ctx.harnessNotices] : null);
    ctx.onThought('r'.repeat(5_000));
    if (turn <= 3) return { actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }] };
    return final;
  }, async () => ({ content: 'ok' }));
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(Array.isArray(seen[1]) && seen[1].some((line) => /cheapest discriminating test/.test(line)), 'the over-budget notice rides with the next decision');
  // Every later turn is itself over-budget, so it re-arms a NEW event notice —
  // but each decision still sees at most one line: never accumulated.
  assert.ok(seen.every((entry) => !Array.isArray(entry) || entry.length === 1), 'notices never accumulate across decisions');
  assert.ok((run.watchdogFires || 0) >= 1, 'three consecutive over-budget decisions feed the watchdog ladder (park, never terminate)');
});

// ---------- E6: failure-class label in recovery directives ----------

test('E6: the recovery demand names the failure class; unclassified demands stay unprefixed', () => {
  const labelled = boundedRequestContext({ task: 't', recovery: { attempts: 2, source: 'stale_element', failureClass: 'STALE_STATE', demand: 'State what is materially different about this attempt.' } });
  assert.equal(labelled.recovery.demand, '[STALE_STATE] State what is materially different about this attempt.');
  const unclassified = boundedRequestContext({ task: 't', recovery: { attempts: 1, source: 'weird', failureClass: 'UNCLASSIFIED', demand: 'Try again.' } });
  assert.equal(unclassified.recovery.demand, 'Try again.');
  const plain = boundedRequestContext({ task: 't', recovery: { attempts: 1, source: 'agent', demand: 'Try again.' } });
  assert.equal(plain.recovery.demand, 'Try again.');
});

// ---------- dispatch harness (mirrors agent-continuity-regressions) ----------

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}) {
  let calls = 0;
  const controller = { navigationState: () => obsA.navigation, domSnapshot: () => obsA.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} , ...controllerExtras };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}
