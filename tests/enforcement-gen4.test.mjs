import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const {
  createCoordinatorState,
  recordObservation,
  recordAction,
  actionHash,
  constraintTamper,
  recordRejectedFill,
  rejectedFillActive,
  unbackedActionClaims,
  valueWriteLiterals,
  firstWriteViolations,
  parseNumberedRequirements,
  settleRequirementLedger,
  requirementCovered
} = require('../desktop/agent/desktopAgentCoordinator.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obsA = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Card number' }, { index: 1, tag: 'input', name: 'Name field' }] } };

// ---------- E12: claim-vs-trace cross-check (pure) ----------

test('E12 pure: a summary citing screenshots with no screenshot tool event and no fresh frame is unbacked — including the phrasings that slipped past the older gate', () => {
  // The exact gen3-gen-ab-timed-r2 phrasings: zero browser_screenshot calls.
  assert.match(unbackedActionClaims('Submitted. Confirmed by read-back and the screenshot.', { history: [] })[0], /screenshot/);
  assert.match(unbackedActionClaims('All verified (including the post-submit screenshot).', { history: [] })[0], /screenshot/);
  assert.match(unbackedActionClaims('The visible screenshot shows the errors are gone.', { history: [] })[0], /screenshot/);
});

test('E12 pure: backed screenshot claims pass — a screenshot tool event or the visual-evidence ledger', () => {
  const history = [{ tool: 'browser_screenshot', output: { ok: true } }];
  assert.deepEqual(unbackedActionClaims('The screenshot confirms the values.', { history }), []);
  // F3 (gen5): a recorded ledger entry (a real produced capture) backs the
  // citation; the ephemeral current frame alone no longer does — that escape
  // is the 15/15 fabricated-citation miss the gen4 judges measured.
  assert.deepEqual(unbackedActionClaims('The screenshot confirms the values.', { history: [], visualLedger: [{ source: 'auto', historyLength: 3 }] }), []);
  assert.match(unbackedActionClaims('The screenshot confirms the values.', { history: [], visualEvidence: { data: 'frame' } })[0], /visual-evidence ledger/);
});

test('E12 pure: post-submit screenshot phrasing with no submit-shaped action is unbacked; probe claims need a successful evidence read', () => {
  const claims = unbackedActionClaims('The post-submit screenshot shows success and the read-back verifies it.', { history: [] });
  assert.ok(claims.some((c) => /no submit-shaped action/.test(c)), 'post-submit with no submit is named');
  assert.ok(claims.some((c) => /read-back/.test(c)), 'the unbacked read-back is named');
  // A real read-back after a real submit backs the claim.
  const history = [
    { tool: 'browser_fill', output: { ok: true } },
    { tool: 'browser_key', input: { key: 'Enter' }, output: { ok: true } },
    { tool: 'browser_execute', output: { ok: true } }
  ];
  assert.deepEqual(unbackedActionClaims('Submitted; the read-back verifies the stored value.', { history }), []);
  // A probe claim with a submit in history but no probe AFTER it is unbacked.
  const staleOrder = [
    { tool: 'browser_execute', output: { ok: true } },
    { tool: 'browser_click', output: { ok: true } }
  ];
  assert.match(unbackedActionClaims('The read-back verifies the submission.', { history: staleOrder })[0], /after the last submit/);
});

test('E12 pure: generic summaries with no action-verb claims pass untouched', () => {
  assert.deepEqual(unbackedActionClaims('All four requirements are complete; deviations named in the report.', { history: [] }), []);
  assert.deepEqual(unbackedActionClaims('', { history: [] }), []);
});

// ---------- E12: dispatch-level gate ----------

test('E12 dispatch: a verified done citing a screenshot with zero screenshot calls is bounced ONCE with the claim named, then accepted', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'Acme' } }] };
    if (turn === 2) return { done: { summary: 'Verified. Confirmed by read-back and the post-submit screenshot.', success: true, verified: true } };
    if (turn === 3) return { done: { summary: 'Verified. Confirmed by read-back and the post-submit screenshot.', success: true, verified: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: 'Acme' })
  });
  const run = await h.start({});
  const bounces = run.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.recoverySource === 'unbacked_claim');
  assert.equal(bounces.length, 1, 'exactly one unbacked-claim bounce');
  assert.match(bounces[0].output.error, /screenshot/, 'the specific unbacked claim is named');
  assert.match(bounces[0].output.error, /tool history does not show/);
  assert.equal(run.result.success, true, 'the bounded-bounce pattern accepts the next done');
  assert.equal(run.result.verified, true);
});

test('E12 dispatch: a verified done whose read-back claim is backed by a real execute passes without a bounce', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "return { read: document.querySelectorAll('input').length };" } }] };
    if (turn === 2) return { done: { summary: 'The read-back verifies the stored values.', success: true, verified: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async () => ({ result: { changed: false, value: 2 } })
  });
  const run = await h.start({});
  const bounces = run.history.filter((entry) => entry.output?.recoverySource === 'unbacked_claim');
  assert.equal(bounces.length, 0, 'a backed claim is never bounced');
  assert.equal(run.result.verified, true);
});

// ---------- E7 (gen4 a): positional-alias identity ----------

test('E7 pure: a .value write via the rejected control’s DOM position bounces; other positions pass', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  recordRejectedFill(state, { index: 2, name: 'Tax ID', tag: 'input', position: 1 });
  const tamper = (script) => constraintTamper(state, { name: 'browser_execute', input: { script } });
  // The exact arch4-untimed-r1 escape: positional selector, no id anchor.
  assert.match(tamper("document.querySelectorAll('input')[1].value = '889201100'; return true;").advisory, /input\[1\] via a positional selector/);
  // Bare variable indexed at the same position, collection named in-script.
  assert.match(tamper("const els = document.querySelectorAll('input'); els[1].value = 'x'; return true;").advisory, /input\[1\] via a positional selector/);
  // A different position is not the rejected control.
  assert.equal(tamper("document.querySelectorAll('input')[0].value = 'x'; return true;"), null);
  // A collection of a different tag never matches the positional alias.
  assert.equal(tamper("document.querySelectorAll('div')[1].value = 'x'; return true;"), null);
  // Reads still pass.
  assert.equal(tamper("return document.querySelectorAll('input')[1].value;"), null);
});

test('E7 pure: the positional window expires after its short TTL; legacy entries without armedAt stay valid', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  recordRejectedFill(state, { index: 2, name: 'Tax ID', tag: 'input', position: 1 });
  const script = "document.querySelectorAll('input')[1].value = 'x'; return true;";
  assert.match(constraintTamper(state, { name: 'browser_execute', input: { script } }).advisory, /positional selector/);
  for (let i = 0; i < 12; i += 1) recordObservation(state, obsA); // past the TTL
  assert.equal(constraintTamper(state, { name: 'browser_execute', input: { script } }), null, 'expired entries no longer arm the alias');
  assert.equal(rejectedFillActive(state, { index: 0, name: 'Legacy control' }), true, 'legacy entries (no armedAt) stay active');
  // A fresh rejection re-arms after expiry.
  recordRejectedFill(state, { index: 2, name: 'Tax ID', tag: 'input', position: 1 });
  assert.match(constraintTamper(state, { name: 'browser_execute', input: { script } }).advisory, /positional selector/);
});

test('E7 dispatch: after a rejected fill, a positional-selector write 1+ decisions later is bounced before execution', async () => {
  const executedScripts = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 2, text: 'TIN-8892011' } }] };
    // The arch4-untimed-r1 escape: the just-rejected control addressed by DOM position.
    if (turn === 2) return { actions: [{ name: 'browser_execute', input: { script: "document.querySelectorAll('input')[1].value = '889201100'; return { forced: true };" } }] };
    if (turn === 3) return { actions: [{ name: 'browser_fill', input: { index: 2, text: '889201100' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: false, matched: false, changed: false, reason: 'The control rejected the requested value (maxLength 9).' }),
    executePageScript: async (tabId, input) => { executedScripts.push(input.script); return { result: { changed: true, value: 1 } }; },
    elementSnapshots: new Map([['t', { elements: [
      { index: 0, tag: 'input', name: 'Email' },
      { index: 1, tag: 'button', name: 'Submit' },
      { index: 2, tag: 'input', name: 'Tax ID' }
    ] }]])
  });
  const run = await h.start({});
  assert.equal(executedScripts.length, 0, 'the positional bypass write never reached the page');
  const bounce = run.history.filter((entry) => entry.tool === 'browser_execute');
  assert.equal(bounce.length, 1);
  assert.equal(bounce[0].output.recoverySource, 'constraint_tamper');
  assert.match(bounce[0].output.error, /input\[1\] via a positional selector/);
  assert.equal(run.result.success, true, 'the model converges with the compliant fill');
});

// ---------- E7 (gen4 b): first-write window ----------

test('E7 pure: literal .value writes are extracted; dynamic writes are not', () => {
  assert.deepEqual(valueWriteLiterals("t.value = 'TIN-889201199';").map((w) => w.literal), ['TIN-889201199']);
  assert.deepEqual(valueWriteLiterals("document.querySelectorAll('input')[1].value = '889201100';").map((w) => [w.literal, w.bracketIndex]), [['889201100', 1]]);
  assert.deepEqual(valueWriteLiterals("el['value'] = 'abc';").map((w) => w.literal), ['abc']);
  assert.deepEqual(valueWriteLiterals('el.value = computed;'), [], 'no literal — no trigger');
  assert.deepEqual(valueWriteLiterals("return el.value;"), [], 'a read is not a write');
});

test('E7 pure: firstWriteViolations — over-maxlength and under-minlength first writes into constrained controls; generic targets pass', () => {
  const probe = {
    controls: [
      { tag: 'input', id: 'tax', name: 'tax', maxLength: 9, minLength: 0 },
      { tag: 'input', id: 'email', name: 'email', maxLength: 0, minLength: 0 },
      { tag: 'textarea', id: 'notes', name: 'notes', maxLength: 0, minLength: 4 }
    ],
    ids: ['tax', 'email', 'notes', 'header']
  };
  // Positional first write into the maxlength-9 control — the gen-ab blind spot.
  let out = firstWriteViolations("document.querySelectorAll('input')[0].value = 'TIN-889201199';", probe);
  assert.equal(out.violations.length, 1);
  assert.match(out.violations[0], /13-character value .* maxLength is 9/);
  // By id.
  out = firstWriteViolations("document.getElementById('tax').value = 'TIN-889201199';", probe);
  assert.match(out.violations[0], /maxLength is 9/);
  // Under-minlength.
  out = firstWriteViolations("document.getElementById('notes').value = 'ab';", probe);
  assert.match(out.violations[0], /minLength is 4/);
  // Writes into unconstrained controls pass.
  assert.deepEqual(firstWriteViolations("document.querySelectorAll('input')[1].value = 'TIN-889201199';", probe).violations, []);
  // A compliant-length write passes.
  assert.deepEqual(firstWriteViolations("document.getElementById('tax').value = '889201100';", probe).violations, []);
  // A non-form element with a known id passes (constraints do not apply).
  assert.deepEqual(firstWriteViolations("document.getElementById('header').value = 'whatever long value';", probe).violations, []);
  // Dynamic / opaque writes never produce a literal write entry at all —
  // nothing to verify, nothing unresolved.
  assert.deepEqual(firstWriteViolations('el.value = computed;', probe), { violations: [], unresolved: 0 });
  assert.deepEqual(firstWriteViolations("return { max: document.getElementById('tax').maxLength };", probe), { violations: [], unresolved: 0 });
});

test('E7 dispatch: a FIRST over-maxlength script write with no prior rejection is bounced against the control’s own constraint', async () => {
  const executedScripts = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    // The gen-ab blind spot: over-limit write, no fill-gate rejection ever.
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "document.querySelectorAll('input')[0].value = 'TIN-889201199'; return { forced: true };" } }] };
    if (turn === 2) return { actions: [{ name: 'browser_fill', input: { index: 0, text: '889201100' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: '889201100' }),
    executePageScript: async (tabId, input) => {
      executedScripts.push(input.script);
      if (input.script.includes("querySelectorAll('input,textarea')")) {
        return { result: { controls: [
          { tag: 'input', id: 'tax', name: 'tax', maxLength: 9, minLength: 0 },
          { tag: 'input', id: 'email', name: 'email', maxLength: 0, minLength: 0 }
        ], ids: ['tax', 'email'] } };
      }
      return { result: { changed: true, value: 1 } };
    },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Tax ID' }] }]])
  });
  const run = await h.start({});
  assert.equal(executedScripts.includes("document.querySelectorAll('input')[0].value = 'TIN-889201199'; return { forced: true };"), false, 'the over-limit write never reached the page');
  const bounce = run.history.find((entry) => entry.tool === 'browser_execute');
  assert.equal(bounce.output.recoverySource, 'constraint_tamper');
  assert.match(bounce.output.error, /first-write of a 13-character value/);
  assert.match(bounce.output.error, /maxLength is 9/);
  assert.match(bounce.output.error, /page-valid adaptation/);
  assert.equal(run.result.success, true, 'the compliant path converges');
});

test('E7 dispatch: an unverifiable first write is ALLOWED and logs a HARNESS notice; a compliant write logs nothing', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "t.value = 'TIN-889201199'; return true;" } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async () => ({ result: { controls: [{ tag: 'input', id: 'tax', name: 'tax', maxLength: 9, minLength: 0 }], ids: ['tax'] } })
  });
  const run = await h.start({});
  assert.equal(run.result.success, true, 'the write was allowed');
  assert.ok(Array.isArray(seen[1]) && seen[1].some((line) => /HARNESS: .*maxLength\/minLength could not be verified/.test(line)), 'the HARNESS notice rides the next decision');
});

test('E7 dispatch: generic JS — dynamic writes, reads, styles — executes untouched with ZERO constraint probes', async () => {
  const executedScripts = [];
  let probeCalls = 0;
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "const els = document.querySelectorAll('input'); els[0].style.border = '1px solid red'; el.value = computed; return { n: els.length, max: els[0].maxLength };" } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async (tabId, input) => {
      if (input.script.includes("querySelectorAll('input,textarea')")) { probeCalls += 1; return { result: { controls: [], ids: [] } }; }
      executedScripts.push(input.script);
      return { result: { changed: false, value: 2 } };
    }
  });
  const run = await h.start({});
  assert.equal(executedScripts.length, 1, 'the generic script executed');
  assert.equal(probeCalls, 0, 'no literal value write — no probe round trip');
  assert.equal(run.result.success, true);
});

// ---------- E9 (gen4): delivery proof ----------

test('E9 dispatch: a delivered rebuild notice is published as a harness.notice.delivered trace event with its id', async () => {
  const events = [];
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [
      { name: 'browser_execute', input: { script: "return { probed: 'a', value: document.querySelectorAll('input').length };" } },
      { name: 'browser_execute', input: { script: "return { probed: 'b', value: document.querySelectorAll('input').length };" } }
    ] };
    // The rebuild: the same two already-verified actions, re-executed.
    if (turn === 2) return { actions: [
      { name: 'browser_execute', input: { script: "return { probed: 'a', value: document.querySelectorAll('input').length };" } },
      { name: 'browser_execute', input: { script: "return { probed: 'b', value: document.querySelectorAll('input').length };" } }
    ] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async () => ({ result: { changed: true, value: 3 } })
  }, (event) => events.push(event));
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(Array.isArray(seen[2]) && seen[2].some((line) => /REBUILD DETECTED/.test(line)), 'the notice rides the next decision context');
  const deliveries = events.filter((event) => event?.type === 'harness.notice.delivered');
  assert.equal(deliveries.length, 1, 'exactly one delivery event mid-run');
  const rebuildDelivery = deliveries[0].notices.find((notice) => /REBUILD DETECTED/.test(notice.text));
  assert.ok(rebuildDelivery, 'the rebuild notice is in the delivery event');
  assert.match(rebuildDelivery.id, /^notice-\d+$/, 'the notice carries its id');
  assert.ok(Number.isFinite(deliveries[0].revision), 'the delivery event is a real published event (revision stamped)');
  assert.ok(!seen[3], 'the notice is one-shot');
  // Correlation: the delivered notice exists in the run's durable ledger.
  const ledgerEntry = (run.harnessNoticeLedger || []).find((entry) => /REBUILD DETECTED/.test(entry.text));
  assert.ok(ledgerEntry && ledgerEntry.id === rebuildDelivery.id, 'the trace event id correlates with the run ledger');
});

// ---------- E13: moment-of-need bridge ----------

test('E13 dispatch: the completion_review bounce itself carries the anti-rebuild bridge sentence', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [
      { name: 'browser_fill', input: { index: 0, text: 'Acme' } },
      { name: 'browser_fill', input: { index: 1, text: 'a@b.co' } },
      { name: 'browser_fill', input: { index: 2, text: '9 digits' } }
    ] };
    if (turn === 2) return { done: { summary: 'Everything is filled.', success: true } };
    if (turn === 3) return { done: { summary: 'Everything is filled.', success: true, verified: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: 'x' }),
    elementSnapshots: new Map([['t', { elements: [
      { index: 0, tag: 'input', name: 'Company' },
      { index: 1, tag: 'input', name: 'Email' },
      { index: 2, tag: 'input', name: 'Tax ID' }
    ] }]])
  });
  const run = await h.start({});
  const reviewBounce = run.history.find((entry) => entry.tool === 'browser_done' && /Completion is a proposal/.test(String(entry.output?.error || '')));
  assert.ok(reviewBounce, 'the forced review bounce fired');
  assert.match(reviewBounce.output.error, /one corrected probe; never by re-executing a completed flow/, 'the bridge rides the bounce message itself');
  assert.equal(run.result.success, true);
});

// ---------- E4: requirement ledger ----------

test('E4 pure: numbered requirements seed the ledger; short tasks seed nothing', () => {
  const lettered = parseNumberedRequirements('Do the form. A1) Fill the company name field. A2) Fill the email field. A3) Fill the tax field.');
  assert.deepEqual(lettered.map((req) => req.id), ['A1', 'A2', 'A3']);
  assert.match(lettered[0].text, /Fill the company name field/);
  const numeric = parseNumberedRequirements('Steps:\n1. Open the page\n2. Fill the form\n3. Submit it');
  assert.deepEqual(numeric.map((req) => req.id), ['R1', 'R2', 'R3']);
  assert.deepEqual(parseNumberedRequirements('Inspect fixture'), []);
  assert.deepEqual(parseNumberedRequirements(''), []);
});

test('E4 pure: observed-effect work whose words cover a requirement settles it; uncovered work does not', () => {
  const req = { id: 'A1', text: 'Fill the company name field' };
  assert.equal(requirementCovered(req, [{ target: 'Company name', expectedOutcome: 'company name filled', effectObserved: true }]), true);
  assert.equal(requirementCovered(req, [{ target: 'Company name', expectedOutcome: 'company name filled', effectObserved: false }]), false, 'unobserved effect never settles');
  assert.equal(requirementCovered(req, [{ target: 'Tax ID', expectedOutcome: 'tax filled', effectObserved: true }]), false);
});

test('E4 dispatch: the forced-review bounce names the specific open requirement and its missing evidence; a settled/deferred ledger accepts without another bounce', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    // Work happens, but with expectations that cover nothing (honest-but-vague).
    if (turn === 1) return { actions: [
      { name: 'browser_fill', input: { index: 0, text: 'Acme' }, expect: 'step one complete' },
      { name: 'browser_fill', input: { index: 1, text: 'a@b.co' }, expect: 'step two complete' },
      { name: 'browser_fill', input: { index: 2, text: '9 digits' }, expect: 'step three complete' }
    ] };
    if (turn === 2) return { done: { summary: 'All requirements verified.', success: true, verified: true } };
    // The explicit defer: every requirement stated skipped with a reason.
    if (turn === 3) return { done: { summary: 'A1) skipped — the fixture exposes no company control; A2) skipped, not applicable; A3) skipped, not applicable.', success: true, verified: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: 'x' }),
    elementSnapshots: new Map([['t', { elements: [
      { index: 0, tag: 'input', name: 'Company name' },
      { index: 1, tag: 'input', name: 'Email' },
      { index: 2, tag: 'input', name: 'Tax ID' }
    ] }]])
  });
  const run = await h.start({ task: 'A1) Fill the company name field. A2) Fill the email field. A3) Fill the tax field. Verify every value.' });
  assert.deepEqual((run.requirementLedger || []).map((req) => req.id), ['A1', 'A2', 'A3'], 'the ledger seeded at run start');
  const reviewBounce = run.history.find((entry) => entry.tool === 'browser_done' && /Requirement ledger:/.test(String(entry.output?.error || '')));
  assert.ok(reviewBounce, 'the E4 ledger demand fired');
  assert.match(reviewBounce.output.error, /A1\) "Fill the company name field\." — no observed-effect evidence covers it yet/);
  assert.match(reviewBounce.output.error, /A2\) "Fill the email field\."/);
  assert.equal(run.result.success, true, 'the ledger settled/deferred — accepted without another bounce');
  assert.equal(run.result.verified, true);
  assert.equal(run.history.filter((entry) => entry.output?.recoverySource === 'completion_review').length, 1, 'exactly one review bounce');
});

// ---------- dispatch harness (mirrors enforcement-gen3) ----------

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}, emit = undefined) {
  let calls = 0;
  const controller = { navigationState: () => obsA.navigation, domSnapshot: () => obsA.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {}, ...controllerExtras };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: emit || (() => {}), createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: (settings && settings.task) || 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}
