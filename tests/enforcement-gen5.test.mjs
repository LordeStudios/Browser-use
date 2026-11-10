import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const {
  createCoordinatorState,
  recordObservation,
  recordAction,
  recordRejectedFill,
  constraintTamper,
  presentationTamper,
  unbackedActionClaims,
  parseNumberedRequirements,
  settleRequirementLedger,
  requirementCovered,
  completedWorkEntry
} = require('../desktop/agent/desktopAgentCoordinator.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obsA = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Company name' }, { index: 1, tag: 'input', name: 'Email' }, { index: 2, tag: 'button', name: 'Submit' }] } };
// Parked-run tests: the auto-resume hold is shortened so the park is
// observable without waiting the production 60s (escalateRun reads this at
// park time).
process.env.BROWSER_USE_ESCALATION_RESUME_MS = '100';

// ---------- F1: the E4 matcher's settle promise is true ----------

test('F1 pure: an execute-driven fill (empty expectedOutcome, URL target) settles via its input hint', () => {
  const req = { id: 'A3', text: 'Fill the company field' };
  // The arch4-untimed-r4 shape: execute entry, no expectation, URL-shaped
  // target — the old matcher gave it ZERO coverage forever.
  const entry = { action: 'browser_execute', target: 'https://fixture.invalid/form', expectedOutcome: '', inputHint: "document.getElementById('company').value = '889201100';", effectObserved: true };
  assert.equal(requirementCovered(req, [entry]), true);
  assert.equal(requirementCovered(req, [{ ...entry, effectObserved: false }]), false, 'unobserved effect never settles');
});

test('F1 pure: a two-word click outcome does not false-settle a multi-word fill requirement', () => {
  const req = { id: 'A1', text: 'Fill the company name field with the full registered business name exactly as filed.' };
  // Old matcher: shared/min(10,3) = 0.67 >= 0.3 -> false settle. The fix scores
  // the overlap against the REQUIREMENT's words: 2/10 = 0.2 < 0.3.
  assert.equal(requirementCovered(req, [{ action: 'browser_click', target: 'Company name', expectedOutcome: 'company name filled', effectObserved: true }]), false);
  // A work entry that genuinely covers the requirement still settles it.
  assert.equal(requirementCovered(req, [{ action: 'browser_fill', target: 'Company name', expectedOutcome: 'full registered business name filed in the company name field', effectObserved: true }]), true);
});

test('F1 pure: a successful read-back after a mutation settles its requirement; an unrelated probe does not', () => {
  const req = { id: 'A1', text: 'Fill the company field' };
  const history = [
    { tool: 'browser_execute', input: { script: "document.getElementById('company').value = '889201100'; return { written: true };" }, output: { ok: true, result: { written: true } } },
    { tool: 'browser_execute', input: { script: "return { company: document.getElementById('company').value };" }, output: { ok: true, result: { company: '889201100' } } }
  ];
  const covered = requirementCovered(req, [], { history });
  assert.equal(covered, true, 'the read-back settles the fill requirement');
  // No earlier mutation -> a bare read settles nothing.
  const bareRead = [{ tool: 'browser_execute', input: { script: "return { company: document.getElementById('company').value };" }, output: { ok: true, result: { company: '889201100' } } }];
  assert.equal(requirementCovered(req, [], { history: bareRead }), false);
  // An unrelated probe (no requirement words) does not settle.
  const unrelated = [
    { tool: 'browser_execute', input: { script: "return { weather: 'sunny' };" }, output: { ok: true, result: { weather: 'sunny' } } },
    { tool: 'browser_execute', input: { script: "return { forecast: document.getElementById('weather').textContent };" }, output: { ok: true, result: { forecast: 'sunny' } } }
  ];
  assert.equal(requirementCovered(req, [], { history: unrelated }), false);
  // A null result confirms nothing.
  const nullRead = [
    { tool: 'browser_fill', input: { index: 0, text: 'x' }, output: { ok: true, result: { matched: true } } },
    { tool: 'browser_execute', input: { script: 'return null;' }, output: { ok: true, result: null } }
  ];
  assert.equal(requirementCovered(req, [], { history: nullRead }), false);
});

test('F1 dispatch: an execute-driven fill settles its requirement at done time with the settle evidence recorded in the ledger', { timeout: 30000 }, async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    // Execute-driven fill with NO expectation annotation (the zero-coverage shape).
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "document.getElementById('company').value = '889201100'; return { written: true };" } }] };
    if (turn === 2) return { actions: [{ name: 'browser_fill', input: { index: 1, text: 'a@b.co' }, expect: 'email filled' }] };
    // The fresh read-back the bounce text promises will settle.
    if (turn === 3) return { actions: [{ name: 'browser_execute', input: { script: "return { company: document.getElementById('company').value, email: document.getElementById('email').value };" } }] };
    if (turn === 4) return { done: { summary: 'The read-back shows company 889201100 and email a@b.co.', success: true, verified: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: 'a@b.co' }),
    executePageScript: async () => ({ result: { changed: true, value: '889201100' } }),
    elementSnapshots: new Map([['t', { elements: obsA.dom.elements }]])
  });
  const run = await h.start({ task: 'A1) Fill the company field. A2) Fill the email field. Then verify every value.' });
  assert.deepEqual((run.requirementLedger || []).map((req) => req.id), ['A1', 'A2'], 'the ledger seeded');
  const ledger = run.requirementLedger;
  assert.equal(ledger[0].status, 'evidenced', 'the execute-driven fill settled its requirement');
  assert.equal(ledger[1].status, 'evidenced');
  assert.match(String(ledger[0].settledBy || ''), /(probe|observed)/, 'the settle evidence names what the gate counted');
  const reviewBounces = run.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.recoverySource === 'completion_review');
  assert.equal(reviewBounces.length, 1, 'only the multipart forced review fired');
  assert.equal(reviewBounces.some((entry) => /Requirement ledger:/.test(String(entry.output?.error || ''))), false, 'no open-requirement demand — the matcher settled the ledger');
  assert.equal(run.result.success, true);
  assert.equal(run.result.verified, true);
});

// ---------- F2: the bounded-bounce counter is reachable ----------

test('F2 dispatch: rebuilds between bounces do not reset the counter; the >=3 bound parks the run (never terminates)', { timeout: 30000 }, async () => {
  const events = [];
  let turn = 0;
  // The observation changes on every snapshot (a live status span) so real
  // mutations settle their completed-work entries; the Submit button identity
  // stays stable so a re-click is the SAME settled action.
  let version = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [
      { name: 'browser_click', input: { index: 2 }, expect: 'open the form' },
      { name: 'browser_fill', input: { index: 0, text: 'Acme' }, expect: 'step one complete' },
      { name: 'browser_fill', input: { index: 1, text: 'a@b.co' }, expect: 'step two complete' }
    ] };
    if (turn === 2) return { done: { summary: 'All requirements verified.', success: true, verified: true } };
    // The rebuild: re-click the already-settled Submit button (arch4's shape).
    if (turn === 3) return { actions: [{ name: 'browser_click', input: { index: 2 }, expect: 're-open the form' }] };
    if (turn === 4) return { done: { summary: 'All requirements verified.', success: true, verified: true } };
    if (turn === 5) return { actions: [{ name: 'browser_click', input: { index: 2 }, expect: 're-open the form again' }] };
    if (turn === 6) return { done: { summary: 'All requirements verified.', success: true, verified: true } };
    // Post-park auto-resume: the defer path settles the ledger and accepts.
    return { done: { summary: 'A1) skipped, not applicable; A2) skipped, not applicable.', success: true, verified: true } };
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => ({ ok: true }),
    fillElement: async () => ({ ok: true, matched: true, changed: true, value: 'x' }),
    elementSnapshots: new Map([['t', { elements: obsA.dom.elements }]]),
    domSnapshot: () => ({ ...obsA.dom, elements: obsA.dom.elements.map((el, i) => (i === 1 ? { ...el, name: `Email v${++version}` } : el)) })
  }, (event) => events.push(event));
  const parkedRun = await h.start({ task: 'A1) Fill the tax field. A2) Fill the email field. Then audit the form.' });
  assert.equal(parkedRun.status, 'awaiting_recovery', 'the bound parked the run (never terminated it)');
  // The auto-resume continues in a fresh run object — poll it to completion.
  let run = h.agent.run;
  for (let i = 0; i < 200 && run.status === 'awaiting_recovery'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = h.agent.run;
  }
  assert.equal(run.status, 'completed', 'the parked run auto-resumed and completed');
  const reviewBounces = run.history.filter((entry) => entry.tool === 'browser_done' && entry.output?.recoverySource === 'completion_review');
  // Three bounces accrued across the rebuilds (pre-F2 the counter reset to 0
  // on every rebuild step and could never pass 2); the fourth is the resumed
  // turn's own MULTIPART forced review — a new turn earns a fresh review.
  assert.ok(reviewBounces.length >= 3, `the counter was not reset by the rebuild re-clicks (${reviewBounces.length} bounces accrued)`);
  const escalation = events.find((event) => event?.type === 'run.escalated');
  assert.ok(escalation, 'the bound fired as a park');
  assert.match(String(escalation?.reason || ''), /Completion review bounced 3 times .* still open/, 'the park names the open requirements');
  assert.equal(run.result.success, true, 'the run completed after the park — nothing was terminated');
  assert.equal(run.result.verified, true);
}, { timeout: 30000 });

// ---------- F3: the screenshot-citation class ----------

test('F3 pure: the fabricated-citation phrasing families bounce with zero producing captures', () => {
  // The gen3-gen-ab-timed-r2 phrasings and the gen4 15/15 family.
  for (const summary of [
    'Submitted. Confirmed by read-back and the screenshot.',
    'All verified (including the post-submit screenshot).',
    'The visible screenshot shows the errors are gone.',
    'The fresh screenshot shows Business selected.',
    'The current screenshot shows the Payment section active.',
    'The screenshot captured at that point showed the Submitted panel.'
  ]) {
    const claims = unbackedActionClaims(summary, { history: [], visualLedger: [] });
    assert.ok(claims.some((claim) => /screenshot/.test(claim)), `bounces: ${summary}`);
  }
});

test('F3 pure: a post-submit citation needs a capture that postdates the submit; pre-submit frames do not back it', () => {
  const history = [
    { tool: 'browser_fill', output: { ok: true } },
    { tool: 'browser_click', output: { ok: true } }
  ];
  // A capture recorded BEFORE the submit (history length 1) does not back a
  // post-submit claim.
  const preSubmit = unbackedActionClaims('The post-submit screenshot shows success.', { history, visualLedger: [{ source: 'auto', historyLength: 1 }] });
  assert.ok(preSubmit.some((claim) => /after the last submit-shaped action/.test(claim)), 'a pre-submit frame is not post-submit evidence');
  // A capture recorded after the submit backs it.
  assert.deepEqual(unbackedActionClaims('The post-submit screenshot shows success.', { history, visualLedger: [{ source: 'auto', historyLength: 2 }] }), []);
  // A screenshot tool event after the submit backs it.
  const withEvent = [...history, { tool: 'browser_screenshot', output: { ok: true } }];
  assert.deepEqual(unbackedActionClaims('The post-submit screenshot shows success.', { history: withEvent, visualLedger: [] }), []);
  // Post-submit phrasing with no submit-shaped action at all still bounces.
  assert.match(unbackedActionClaims('The post-submit screenshot shows success.', { history: [], visualLedger: [{ source: 'tool', historyLength: 1 }] })[0], /no submit-shaped action/);
});

test('F3 pure: genuinely screenshot-backed claims pass', () => {
  const history = [{ tool: 'browser_screenshot', output: { ok: true, result: { data: 'frame' } } }];
  assert.deepEqual(unbackedActionClaims('The screenshot confirms the values.', { history, visualLedger: [] }), []);
  assert.deepEqual(unbackedActionClaims('The fresh screenshot shows the values.', { history: [], visualLedger: [{ source: 'auto', historyLength: 2 }] }), []);
});

// ---------- F4: cross-decision rebuild detection ----------

test('F4 dispatch: a rebuild spread across decisions trips the E9 notice; a single re-execution stays silent', { timeout: 30000 }, async () => {
  const events = [];
  const seen = [];
  let turn = 0;
  let version = 0;
  const baseElements = [
    { index: 0, tag: 'button', name: 'Save' },
    { index: 1, tag: 'button', name: 'Next' },
    { index: 2, tag: 'input', name: 'Email' }
  ];
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    // First pass: two settled clicks in two decisions.
    if (turn === 1) return { actions: [{ name: 'browser_click', input: { index: 0 } }] };
    if (turn === 2) return { actions: [{ name: 'browser_click', input: { index: 1 } }] };
    // The rebuild: the same settled actions re-executed across decisions.
    if (turn === 3) return { actions: [{ name: 'browser_click', input: { index: 0 } }] };
    if (turn === 4) return { actions: [{ name: 'browser_click', input: { index: 1 } }] };
    if (turn === 5) return { actions: [{ name: 'browser_click', input: { index: 0 } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => ({ ok: true }),
    elementSnapshots: new Map([['t', { elements: baseElements }]]),
    domSnapshot: () => ({ ...obsA.dom, elements: [...baseElements, { index: 3, tag: 'span', name: `status v${++version}` }] })
  }, (event) => events.push(event));
  const run = await h.start({ task: 'Inspect fixture' });
  assert.equal(run.result.success, true);
  assert.equal(run.rebuildNoticeFired, true, 'the cross-decision rebuild tripped the trigger');
  assert.ok(seen[5] && seen[5].some((line) => /REBUILD DETECTED/.test(line)), 'the notice rides the next decision context');
  assert.match((run.harnessNoticeLedger || []).find((entry) => /REBUILD DETECTED/.test(entry.text))?.text || '', /across 3 decision\(s\)/, 'the notice names the flow granularity');
  const deliveries = events.filter((event) => event?.type === 'harness.notice.delivered');
  assert.equal(deliveries.length, 1, 'exactly one delivery — one-shot');
}, { timeout: 30000 });

test('F4 dispatch: a single settled re-execution (the refilled reloaded form) stays silent', { timeout: 30000 }, async () => {
  const seen = [];
  let turn = 0;
  let version = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [{ name: 'browser_click', input: { index: 0 } }] };
    // One legitimate re-execution in a later decision.
    if (turn === 2) return { actions: [{ name: 'browser_click', input: { index: 0 } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    clickElement: async () => ({ ok: true }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'button', name: 'Save' }] }]]),
    domSnapshot: () => ({ ...obsA.dom, elements: [{ index: 0, tag: 'button', name: 'Save' }, { index: 1, tag: 'span', name: `status v${++version}` }] })
  });
  const run = await h.start({ task: 'Inspect fixture' });
  assert.equal(run.result.success, true);
  assert.equal(run.rebuildNoticeFired, false, 'no rebuild notice for a single re-execution');
  assert.ok(!seen.some((batch) => batch && batch.some((line) => /REBUILD DETECTED/.test(line))), 'no REBUILD notice was armed');
});

// ---------- F5: presentation-mutation tamper ----------

test('F5 pure: manufactured-cleanliness scripts bounce; generic styling and error-token reads pass', () => {
  const tamper = (script, state = createCoordinatorState()) => presentationTamper(state, { name: 'browser_execute', input: { script } });
  // arch2 untimed-r1: classList.remove of error classes.
  assert.match(
    tamper("document.querySelectorAll('.field').forEach(f => f.classList.remove('invalid','error','is-invalid')); return true;").advisory,
    /PRESENTATION TAMPER.*classList\.remove/,
    'the arch2 classList escape bounces'
  );
  // removeAttribute('style') + error tokens elsewhere in the script.
  assert.match(
    tamper("ff.removeAttribute('style'); const n = document.querySelectorAll('.error').length; return { n };").advisory,
    /PRESENTATION TAMPER.*removeAttribute/
  );
  // Style property cleared to an empty string + error tokens.
  assert.match(
    tamper("const el = document.querySelector('.error-message'); el.style.borderColor = ''; return true;").advisory,
    /PRESENTATION TAMPER.*style/
  );
  // arch1 timed-r3: a style-clear naming the control whose fill was just
  // rejected — no error token in the script at all.
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  recordRejectedFill(state, { index: 2, name: 'Filename', tag: 'input', position: 0 });
  assert.match(
    tamper("document.getElementById('Filename').style.borderColor = ''; return true;", state).advisory,
    /PRESENTATION TAMPER.*whose fill was just rejected/,
    'the arch1 borderColor escape bounces'
  );
  // Generic styling passes: setting styles/colors/layout, adding classes,
  // removing non-error classes, and error-token reads without clears.
  assert.equal(tamper("els[0].style.border = '1px solid red'; els[1].style.backgroundColor = '#eee'; return { n: els.length };"), null);
  assert.equal(tamper("panel.classList.add('highlight'); panel.style.display = 'flex'; return true;"), null);
  assert.equal(tamper("row.classList.remove('hidden'); return true;"), null);
  assert.equal(tamper("return { errors: document.querySelectorAll('.error').length };"), null);
  assert.equal(tamper("return document.querySelector('#file-name').style.borderColor;"), null, 'a read is not a clear');
  // Non-execute tools are never inspected.
  assert.equal(presentationTamper(state, { name: 'browser_click', input: {} }), null);
});

test('F5 dispatch: a presentation-clear on a just-rejected control is bounced before execution; generic styling executes untouched', { timeout: 30000 }, async () => {
  const executedScripts = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'TIN-8892011' } }] };
    // The arch1 escape: erase the error border left by the rejected fill.
    if (turn === 2) return { actions: [{ name: 'browser_execute', input: { script: "document.getElementById('Filename').style.borderColor = ''; return { cleared: true };" } }] };
    if (turn === 3) return { actions: [{ name: 'browser_execute', input: { script: "const el = document.getElementById('Filename'); el.style.outline = '1px solid blue'; return { styled: true };" } }] };
    if (turn === 4) return { actions: [{ name: 'browser_fill', input: { index: 0, text: '889201100' } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: false, matched: false, changed: false, reason: 'The control rejected the requested value (maxLength 9).' }),
    executePageScript: async (tabId, input) => { executedScripts.push(input.script); return { result: { changed: false, value: 1 } }; },
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Filename' }] }]])
  });
  const run = await h.start({ task: 'Fill the file name field' });
  assert.equal(executedScripts.some((script) => script.includes("borderColor = ''")), false, 'the presentation-clear never reached the page');
  assert.equal(executedScripts.some((script) => script.includes("outline = '1px solid blue'")), true, 'generic styling executed untouched');
  const bounce = run.history.find((entry) => entry.tool === 'browser_execute' && entry.output?.recoverySource === 'constraint_tamper' && /PRESENTATION TAMPER/.test(String(entry.output?.error || '')));
  assert.ok(bounce, 'the tamper bounce fired through the E7 channel');
  assert.match(bounce.output.error, /whose fill was just rejected/);
  assert.match(bounce.output.error, /manufactured/);
  assert.equal(run.result.success, true, 'the run converges with the compliant fill');
});

// ---------- F6: decision watchdog ----------

test('F6 dispatch: a hung model call is retried once, then the run parks via escalateRun — never terminates', { timeout: 30000 }, async () => {
  const events = [];
  let completeCalls = 0;
  const h = harness((context) => {
    completeCalls += 1;
    if (completeCalls <= 2) return new Promise(() => { /* the hung model call: never resolves, never streams */ });
    return final;
  }, async () => ({ content: 'ok' }), {}, (event) => events.push(event));
  const parkedRun = await h.start({ task: 'Inspect fixture', decisionWatchdogMs: 80 });
  assert.equal(parkedRun.status, 'awaiting_recovery', 'the watchdog parked the run (never terminated it)');
  let run = h.agent.run;
  for (let i = 0; i < 200 && run.status === 'awaiting_recovery'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    run = h.agent.run;
  }
  assert.equal(run.status, 'completed', 'the parked run auto-resumed and completed');
  const escalations = events.filter((event) => event?.type === 'run.escalated');
  assert.equal(escalations.length, 1, 'exactly one park');
  assert.match(String(escalations[0]?.reason || ''), /Decision watchdog.*hung twice/, 'the park names the watchdog');
  assert.ok(completeCalls >= 3, `the hung call was retried once, then the resumed run got a fresh decision (${completeCalls} calls)`);
  assert.equal(run.result.success, true, 'the run completed after the park — nothing was terminated');
  assert.equal(parkedRun.decisionWatchdogFires, 2, 'both dead-air fires are counted');
}, { timeout: 30000 });

// ---------- dispatch harness (mirrors enforcement-gen4) ----------

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}, emit = undefined) {
  let calls = 0;
  const controller = { navigationState: () => obsA.navigation,
    domSnapshot: () => (controllerExtras.domSnapshot ? controllerExtras.domSnapshot() : obsA.dom),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
  Object.assign(controller, controllerExtras);
  if (controllerExtras.domSnapshot) controller.domSnapshot = controllerExtras.domSnapshot;
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: emit || (() => {}), createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: (settings && settings.task) || 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}
