import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  parseNumberedRequirements,
  settleRequirementLedger,
  requirementCovered,
  requirementHeadText,
  requirementTransitionDirection,
  transitionSettleEvidence
} = require('../desktop/agent/desktopAgentCoordinator.cjs');

// E8 (gen6): the requirement-ledger settlement gap that parked a completable
// run. The gen6-preflight run performed the ENTIRE task (five browser_done
// attempts, one even signing back in after logout to re-verify) yet R1 (Sign
// in) and R8 (Log out) stayed open and the run parked with "2 requirement(s)
// still open (R1, R8)".

const R1_TEXT = 'Sign in. If sign-in fails, read what the page tells you before retrying.';
const R8_TEXT = 'Log out and verify the sign-in screen is displayed again.';

// The exact gen6-preflight completed-work evidence for the auth transitions
// (revisions from the parked run's coordinator.completedWork).
const gen6AuthWork = [
  { action: 'browser_fill', target: 'Username', inputHint: 'admin', effectObserved: true, observedRevision: 3 },
  { action: 'browser_fill', target: 'Password', inputHint: 'clinic2026', effectObserved: true, observedRevision: 4 },
  { action: 'browser_click', id: 'browser_click:{"target":["button","sign in","sign in","loginBtn","",""]}', target: 'Sign in', effectObserved: true, observedRevision: 5 },
  { action: 'browser_click', id: 'browser_click:{"target":["button","log out","log out","logoutBtn","",""]}', target: 'Log out', effectObserved: true, observedRevision: 23 },
  { action: 'browser_click', id: 'browser_click:{"target":["button","sign in","sign in","loginBtn","",""]}', target: 'Sign in', effectObserved: true, observedRevision: 24 }
];

// ---------- E8 fix (a): imperative-head scoring ----------

test('E8 pure: the imperative head cuts at the first sentence period or "If ", falling back to the full text when the head is empty', () => {
  assert.equal(requirementHeadText(R1_TEXT), 'Sign in', 'the conditional tail is context, not denominator');
  assert.equal(requirementHeadText('Fill the company name field with the full registered business name exactly as filed.'), 'Fill the company name field with the full registered business name exactly as filed', 'a single-sentence requirement keeps its whole text');
  assert.equal(requirementHeadText('If the requested slot is unavailable, book the nearest available slot that same day.'), 'If the requested slot is unavailable, book the nearest available slot that same day.', 'a requirement that opens with its condition falls back to the full text');
  assert.equal(requirementHeadText(''), '');
});

test('E8 pure: a 12-word conditional-tail requirement settles on imperative-head evidence (the R1 shape)', () => {
  // Old arithmetic: full-text denominator 8 words {sign, fails, read, what,
  // page, tells, before, retrying}; the "Sign in" click's pool {sign} scored
  // 1/8 = 0.125 < 0.3 — R1 could NEVER settle while the run sat completed.
  // Head-only: {sign} vs {sign} = 1/1 = 1.0.
  const req = { id: 'R1', text: R1_TEXT };
  const click = [{ action: 'browser_click', target: 'Sign in', effectObserved: true }];
  assert.equal(requirementCovered(req, click), true, 'the imperative-head evidence settles the requirement');
  assert.equal(requirementCovered(req, click.map((entry) => ({ ...entry, effectObserved: false }))), false, 'unobserved effect never settles');
  assert.equal(requirementCovered(req, [{ action: 'browser_click', target: 'Tax ID', effectObserved: true }]), false, 'unrelated head evidence still does not settle');
});

test('E8 pure: the head cut never WIDENS a score the old matcher correctly rejected', () => {
  // The gen5 false-settle guard: a two-word click outcome must still not
  // settle a multi-word fill requirement (head = full text here).
  const req = { id: 'A1', text: 'Fill the company name field with the full registered business name exactly as filed.' };
  assert.equal(requirementCovered(req, [{ action: 'browser_click', target: 'Company name', expectedOutcome: 'company name filled', effectObserved: true }]), false);
  assert.equal(requirementCovered(req, [{ action: 'browser_fill', target: 'Company name', expectedOutcome: 'full registered business name filed in the company name field', effectObserved: true }]), true);
});

// ---------- E8 fix (b): the state-transition settle class ----------

test('E8 pure: the transition direction is the FIRST transition verb in the head, not a tail mention', () => {
  assert.equal(requirementTransitionDirection({ text: R1_TEXT }), 'login');
  assert.equal(requirementTransitionDirection({ text: R8_TEXT }), 'logout', '"Log out and verify the sign-in screen..." is a LOGOUT requirement despite its sign-in tail');
  assert.equal(requirementTransitionDirection({ text: 'Fill the company name field.' }), null);
});

test('E8 pure: a login/logout requirement settles via the observed screen-state change (the R1+R8 shape)', () => {
  const run = {
    requirementLedger: [
      { id: 'R1', text: R1_TEXT, status: 'open', evidence: null },
      { id: 'R8', text: R8_TEXT, status: 'open', evidence: null }
    ],
    coordinator: { completedWork: gen6AuthWork },
    history: []
  };
  const { ledger, open } = settleRequirementLedger(run, 'nothing deferred');
  assert.deepEqual(open.map((req) => req.id), [], 'both state-transition requirements settled');
  assert.equal(ledger[0].status, 'evidenced');
  assert.match(String(ledger[0].settledBy), /state transition settled: the observed login click at evidence rev 5 was followed by an observed logout click at rev 23/, 'the settle evidence names the observation chain');
  assert.equal(ledger[1].status, 'evidenced');
  assert.match(String(ledger[1].settledBy), /state transition settled: the observed logout click at evidence rev 23 was followed by an observed login click at rev 24/, 'the later sign-in click proves the sign-in screen was displayed');
});

test('E8 pure: a logout requirement settles via the newest observation fingerprint showing the sign-in screen', () => {
  // The run logged out and never signed back in: the newest observation IS
  // the sign-in screen (sign-in affordance present, logout affordance gone).
  const evidence = transitionSettleEvidence(
    { text: R8_TEXT },
    [{ action: 'browser_click', id: 'click logout', target: 'Log out', effectObserved: true, observedRevision: 23 }],
    { fingerprint: JSON.stringify({ url: 'file:///fixture', elements: [['button', '', 'sign in', 'sign in', ''], ['input', '', 'password', '', '']] }) }
  );
  assert.match(String(evidence), /state transition settled: the newest observation shows the login affordance/, 'the fingerprint marker settles it');
  assert.match(String(evidence), /the sign-in screen is displayed/);
});

test('E8 pure: a login requirement settles via the newest observation showing the authenticated screen', () => {
  const evidence = transitionSettleEvidence(
    { text: R1_TEXT },
    [{ action: 'browser_click', target: 'Sign in', effectObserved: true, observedRevision: 5 }],
    { fingerprint: JSON.stringify({ elements: [['button', '', 'log out', 'log out', '']] }) }
  );
  assert.match(String(evidence), /newest observation shows the logout affordance/, 'a visible Log out control means the authenticated screen was reached');
});

test('E8 pure: unobserved effects and missing post-state proof never settle a transition (no false settle)', () => {
  // effectObserved=false: the click landed nowhere.
  assert.equal(transitionSettleEvidence({ text: R8_TEXT }, [
    { action: 'browser_click', target: 'Log out', effectObserved: false, observedRevision: 23 },
    { action: 'browser_click', target: 'Sign in', effectObserved: true, observedRevision: 24 }
  ], null), null);
  // The logout click with NO later sign-in interaction and a fingerprint still
  // showing the authenticated screen (logout failed or was never verified):
  // the requirement stays open.
  assert.equal(transitionSettleEvidence({ text: R8_TEXT }, [
    { action: 'browser_click', target: 'Log out', effectObserved: true, observedRevision: 23 }
  ], { fingerprint: JSON.stringify({ elements: [['button', '', 'log out', 'log out', '']] }) }), null, 'still on the dashboard — no sign-in proof');
  // The order matters: a sign-in click BEFORE the logout is not post-state
  // proof of the logout.
  assert.equal(transitionSettleEvidence({ text: R8_TEXT }, [
    { action: 'browser_click', target: 'Sign in', effectObserved: true, observedRevision: 5 },
    { action: 'browser_click', target: 'Log out', effectObserved: true, observedRevision: 23 }
  ], null), null, 'the login click predates the logout — no post-logout proof');
});

// ---------- E8 fix (c): the park still fires for GENUINELY open requirements ----------

test('E8 pure: a genuinely uncovered requirement stays open and the park would name it', () => {
  // The F2 shape: work happened but covered nothing (tax field never filled).
  const run = {
    requirementLedger: [
      { id: 'A1', text: 'Fill the tax field.', status: 'open', evidence: null },
      { id: 'A2', text: 'Fill the email field.', status: 'open', evidence: null }
    ],
    coordinator: {
      completedWork: [
        { action: 'browser_fill', target: 'Company name', inputHint: 'Acme', effectObserved: true, observedRevision: 3 }
      ]
    },
    history: []
  };
  const { ledger, open } = settleRequirementLedger(run, 'All requirements verified.');
  assert.deepEqual(open.map((req) => req.id), ['A1', 'A2'], 'neither requirement is covered by the unrelated fill — both stay genuinely open');
  assert.ok(open.every((req) => /tax|email/.test(req.text)), 'the park notice lists exactly what the ledger has not settled');
});

test('E8 pure: the deferred path still works at the park boundary (nothing was terminated)', () => {
  const run = {
    requirementLedger: [{ id: 'R1', text: R1_TEXT, status: 'open', evidence: null }],
    coordinator: { completedWork: [] },
    history: []
  };
  const { ledger, open } = settleRequirementLedger(run, 'R1) skipped, not applicable — the fixture exposes no sign-in flow.');
  assert.deepEqual(open.map((req) => req.id), [], 'the explicit defer settles the ledger');
  assert.equal(ledger[0].status, 'deferred');
});

// ---------- the seeded-ledger parse of the exact gen6 task text ----------

test('E8 pure: the gen6 task text seeds the R1..R8 ledger unchanged', () => {
  const task = 'Work through the CarePoint Clinic staff portal.\n\nPhase 1:\n1. Sign in. If sign-in fails, read what the page tells you before retrying.\n2. Verify the stats.\n\nPhase 2:\n3. Filter the registry.';
  const seeded = parseNumberedRequirements(task);
  assert.deepEqual(seeded.map((req) => req.id), ['R1', 'R2', 'R3']);
  assert.match(seeded[0].text, /If sign-in fails/);
});
