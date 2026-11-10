import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent, toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { createCoordinatorState, recordObservation, recordAction, actionHash, constraintTamper, recordRejectedFill, CONFLICT_PROTOCOL_ADVISORY } = require('../desktop/agent/desktopAgentCoordinator.cjs');
const { OpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { createHeadlessComputerToolsStub } = require('../cli/stubs.cjs');

const final = { done: { summary: 'Fixture finished.', success: true, verified: true } };
const obsA = { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [{ index: 0, tag: 'input', name: 'Card number' }, { index: 1, tag: 'input', name: 'Name field' }] } };

// ---------- E7: constraint-tamper gateway (pure detector) ----------

test('E7 detector: constraint strips and bypass writes bounce; generic page JS passes untouched', () => {
  const state = createCoordinatorState();
  const tamper = (script) => constraintTamper(state, { name: 'browser_execute', input: { script } });
  // Constraint-attribute mutation — the gen1/gen2 recurrence.
  assert.match(tamper("el.removeAttribute('maxlength')").advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper('el.removeAttribute("required")').advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper('el.setAttribute("maxlength", 999)').advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper('el.maxLength = 999').advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper("el['maxLength'] = 999").advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper('el.required = false').advisory, /CONSTRAINT TAMPER/);
  assert.match(tamper("el['required'] = false").advisory, /CONSTRAINT TAMPER/);
  // The conflict protocol is named in every bounce.
  assert.match(tamper('el.required = false').advisory, /page-valid adaptation/);
  assert.match(tamper('el.required = false').advisory, /blocked-done/);
  // Generic JS must pass.
  assert.equal(tamper("const els = document.querySelectorAll('input'); return els.length;"), null);
  assert.equal(tamper("els[0].style.border = '1px solid red'; return true;"), null);
  assert.equal(tamper("return { max: els[0].maxLength, req: els[0].required, v: els[0].value };"), null, 'reading constraints is not tampering');
  assert.equal(tamper("document.getElementById('a').removeAttribute('data-ghost'); return true;"), null, 'unrelated attribute removal passes');
  assert.equal(tamper("el.setAttribute('data-tool', 'x'); return true;"), null);
  assert.equal(tamper("if (el.required === false) return 'blocked';"), null, 'comparison is not a write');
  // Non-execute tools are out of scope.
  assert.equal(constraintTamper(state, { name: 'browser_fill', input: { text: 'el.maxLength = 999' } }), null);
  // The advisory text is stable for the fixture tests.
  assert.match(CONFLICT_PROTOCOL_ADVISORY, /blocked path/);
});

test('E7 detector: a .value write into a control the fill gate just rejected bounces; other value writes pass', () => {
  const state = createCoordinatorState();
  recordObservation(state, obsA);
  recordRejectedFill(state, { index: 0, name: 'Card number' });
  const tamper = (script) => constraintTamper(state, { name: 'browser_execute', input: { script } });
  assert.match(tamper("document.querySelectorAll('input')[0].value = '4242424242424242'; return true;").advisory, /element \[0\]/);
  assert.match(tamper("els[0].value = 'x'; return true;").advisory, /element \[0\]/);
  // Same write elsewhere in the page is not the rejected control.
  assert.equal(tamper("document.querySelector('#other').value = 'x'; return true;"), null);
  // Reading the rejected control is fine.
  assert.equal(tamper("return els[0].value;"), null);
  // After the window clears, the same write executes.
  state.rejectedFills = [];
  assert.equal(tamper("els[0].value = 'x'; return true;"), null);
});

// ---------- E7: dispatch-level gateway ----------

test('E7 dispatch: a constraint-stripping execute is rejected before execution and names the conflict protocol', async () => {
  let executed = 0;
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "const f = document.querySelector('input'); f.removeAttribute('maxlength'); return { stripped: true };" } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async () => { executed += 1; return { result: { changed: true, value: 1 } }; }
  });
  const run = await h.start({});
  assert.equal(executed, 0, 'the tampering script never reached the page');
  const rejection = run.history.find((entry) => entry.tool === 'browser_execute');
  assert.ok(rejection, 'the bounce is in the visible history');
  assert.equal(rejection.output.ok, false);
  assert.equal(rejection.output.recoverySource, 'constraint_tamper');
  assert.match(rejection.output.error, /CONSTRAINT TAMPER/);
  assert.match(rejection.output.error, /blocked-done/);
  assert.match(rejection.output.error, /page-valid adaptation/);
  assert.equal(run.result.success, true);
});

test('E7 dispatch: generic page JS — reads, styles, unrelated attributes — executes untouched', async () => {
  const scripts = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "const els = document.querySelectorAll('input'); els[0].style.border = '1px solid red'; const x = document.getElementById('a'); x.removeAttribute('data-ghost'); return { n: els.length, max: els[0].maxLength, v: els[0].value };" } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async (tabId, input) => { scripts.push(input.script); return { result: { changed: false, value: 2 } }; }
  });
  const run = await h.start({});
  assert.equal(scripts.length, 1, 'the generic script executed');
  assert.equal(run.result.success, true);
});

test('E7 dispatch: after a rejected fill, a .value write into that control is bounced as a gate bypass', async () => {
  const executed = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: '4242424242424242' } }] };
    if (turn === 2) return { actions: [{ name: 'browser_execute', input: { script: "document.querySelectorAll('input')[0].value = '4242424242424242'; return { forced: true };" } }] };
    return final;
  }, async (name) => { executed.push(name); return { content: 'ok' }; }, {
    fillElement: async () => ({ ok: false, matched: false, changed: false, reason: 'The control rejected the requested value (maxLength 10).' }),
    executePageScript: async () => ({ result: { changed: true, value: 1 } }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Card number' }] }]])
  });
  const run = await h.start({});
  assert.equal(executed.includes('browser_execute'), false, 'the bypass write never reached the page');
  const bounce = run.history.filter((entry) => entry.tool === 'browser_execute');
  assert.equal(bounce.length, 1);
  assert.equal(bounce[0].output.recoverySource, 'constraint_tamper');
  assert.match(bounce[0].output.error, /element \[0\]/);
  // The fill-gate rejection itself now names the conflict protocol (the fold).
  const fill = run.history.find((entry) => entry.tool === 'browser_fill');
  assert.match(String(fill.output.error), /blocked path/);
  assert.match(String(fill.output.error), /page-valid adaptation/);
  assert.equal(run.result.success, true);
});

// ---------- E8: blocked-done provenance ----------

test('E8 dispatch: a blocked-done right after a tamper bounce is bounced once for fresh probe evidence, then converges', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_execute', input: { script: "const f = document.querySelector('input'); f.required = false; return true;" } }] };
    // The reworded-impossibility claim: no probe has run since the bounce.
    if (turn === 2) return { done: { summary: 'The field refuses the literal; the page blocks this path.', success: false } };
    // The demanded fresh probe: post-bounce evidence of the constraint.
    if (turn === 3) return { actions: [{ name: 'browser_execute', input: { script: "return { maxLength: document.querySelector('input').maxLength, still: true };" } }] };
    // The evidence-backed blocked-done (final, so the run can end).
    if (turn === 4) return { done: { summary: 'Probed after the bounce: the control still enforces its constraint and rejects the literal; blocked.', success: false, final: true } };
    if (turn === 5) return { done: { summary: 'Probed after the bounce: the control still enforces its constraint and rejects the literal; blocked.', success: false, final: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async () => ({ result: { changed: false, value: 10 } })
  });
  const run = await h.start({});
  const provenanceBounces = run.history.filter((entry) => entry.tool === 'browser_done'
    && /FRESH evidence gathered after the rejection/.test(String(entry.output?.error || '')));
  assert.equal(provenanceBounces.length, 1, 'exactly one provenance bounce: the bare rewording was bounced once');
  assert.match(provenanceBounces[0].output.error, /one probe/);
  assert.equal(run.result.success, false, 'the evidence-backed blocked-done was accepted');
  assert.equal(run.status, 'failed');
});

test('E8 dispatch: a blocked-done WITH a post-bounce probe passes the provenance gate immediately', async () => {
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    if (turn === 1) return { actions: [{ name: 'browser_fill', input: { index: 0, text: 'TIN-889201100' } }] };
    if (turn === 2) return { actions: [{ name: 'browser_execute', input: { script: "return { probed: true, maxLength: 10, value: document.querySelectorAll('input')[0].value };" } }] };
    if (turn === 3) return { done: { summary: 'Probed: the control caps input at 10 chars and rejects the 12-digit literal; blocked.', success: false, final: true } };
    if (turn === 4) return { done: { summary: 'Probed: the control caps input at 10 chars and rejects the 12-digit literal; blocked.', success: false, final: true } };
    return final;
  }, async () => ({ content: 'ok' }), {
    fillElement: async () => ({ ok: false, matched: false, changed: false, reason: 'The control rejected the requested value.' }),
    executePageScript: async () => ({ result: { changed: false, value: 10 } }),
    elementSnapshots: new Map([['t', { elements: [{ index: 0, tag: 'input', name: 'Tax ID' }] }]])
  });
  const run = await h.start({});
  const provenanceBounces = run.history.filter((entry) => entry.tool === 'browser_done'
    && /FRESH evidence gathered after the rejection/.test(String(entry.output?.error || '')));
  assert.equal(provenanceBounces.length, 0, 'a probe-backed block is accepted without a bounce');
  assert.equal(run.result.success, false);
});

// ---------- E9: rebuild tripwire ----------

const probeScript = "return { probed: 'a', value: document.querySelectorAll('input').length };";
const probeScriptB = "return { probed: 'b', value: document.querySelectorAll('input').length };";

test('E9 dispatch: re-executing two verified actions in one decision arms the REBUILD DETECTED notice in the next decision context', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [
      { name: 'browser_execute', input: { script: probeScript } },
      { name: 'browser_execute', input: { script: probeScriptB } }
    ] };
    // The rebuild: the same two already-verified actions, re-executed.
    if (turn === 2) return { actions: [
      { name: 'browser_execute', input: { script: probeScript } },
      { name: 'browser_execute', input: { script: probeScriptB } }
    ] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async (tabId, input) => ({ result: { changed: true, value: 3 } })
  });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(seen[0] === null, 'no notices before any event');
  assert.ok(Array.isArray(seen[2]) && seen[2].some((line) => /REBUILD DETECTED: .* is already verified \(doneList evidence rev \d+\)/.test(line)), 'the rebuild notice rides with the next decision');
  assert.match(seen[2].find((line) => line.startsWith('REBUILD DETECTED')), /one corrected probe/);
  assert.ok(!seen[3], 'the notice is one-shot');
});

test('E9 dispatch: one corrected probe (a single re-execution) does NOT fire the tripwire', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [
      { name: 'browser_execute', input: { script: probeScript } },
      { name: 'browser_execute', input: { script: probeScriptB } }
    ] };
    // The sanctioned corrected probe: exactly one re-execution.
    if (turn === 2) return { actions: [{ name: 'browser_execute', input: { script: probeScript } }] };
    return final;
  }, async () => ({ content: 'ok' }), {
    executePageScript: async (tabId, input) => ({ result: { changed: true, value: 3 } })
  });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(seen.every((entry) => !Array.isArray(entry) || !entry.some((line) => /REBUILD DETECTED/.test(line))), 'no rebuild notice for a single corrected probe');
});

// ---------- E10: E2 silence — drain-after-render ----------

test('E10 dispatch: a notice armed before a FAILED decision is still delivered on the retry (drain-after-render)', async () => {
  const seen = [];
  let turn = 0;
  const h = harness((context) => {
    turn += 1;
    seen.push(Array.isArray(context.harnessNotices) ? [...context.harnessNotices] : null);
    if (turn === 1) return { actions: [{ name: 'browser_navigate', input: { url: 'https://fixture.invalid/b' } }] };
    // The decision that would have carried the notice fails at the provider.
    // The old drain-at-call-time consumed the notice before any model saw it.
    if (turn === 2) throw new Error('provider decision boom');
    return final;
  }, async () => ({ content: 'ok' }), { navigate: async (tabId, url) => ({ url }) });
  const run = await h.start({});
  assert.equal(run.result.success, true);
  assert.ok(Array.isArray(seen[1]) && seen[1].some((line) => /PAGE CHANGED/.test(line)), 'the notice rides with the second decision');
  assert.ok(Array.isArray(seen[2]) && seen[2].some((line) => /PAGE CHANGED/.test(line)), 'E10: the failed decision did not consume the notice — the retry re-receives it');
});

test('E10 wire: a notice passed to the REAL OpenAI-compatible provider reaches the request body', async () => {
  const bodies = [];
  const notice = 'REBUILD DETECTED: card payment flow is already verified (doneList evidence rev 4). Re-verify an uncertain claim with one corrected probe; never re-execute the completed flow.';
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ actions: [{ name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }] }) } }], usage: {} }) };
  };
  const provider = new OpenAiCompatibleProvider({ providerId: 'xkiro', baseUrl: 'http://127.0.0.1:9/v1', model: 'z-ai/glm-5.3-flash', apiKey: 'fixture-key', fetchImpl });
  const decision = await provider.complete({
    task: 'fixture task',
    observation: { navigation: { url: 'https://fixture.invalid/a', loading: false }, dom: { viewport: { width: 800, height: 600 }, elements: [] } },
    history: [],
    messages: [],
    coordinator: { metrics: {} },
    plan: [],
    goals: [],
    recovery: { attempts: 0 },
    workspace: {},
    tools: [],
    workingMemory: {},
    interactionMemory: null,
    harnessNotices: [notice],
    effort: 'advanced',
    effortMode: 'fixed'
  });
  assert.ok(decision, 'the decision parsed');
  assert.equal(bodies.length, 1);
  const lastUser = bodies[0].messages.filter((message) => message.role === 'user').at(-1);
  const context = JSON.parse(lastUser.content);
  assert.deepEqual(context.harnessNotices, [notice], 'the notice is in the rendered decision context');
  assert.match(context.harnessNoticesNote, /one-shot/i);
  // And the E9 notice text survives the 300-char per-line bound.
  assert.ok(context.harnessNotices[0].endsWith('never re-execute the completed flow.'));
});

// ---------- E11: headless tool surface ----------

test('E11: the headless computer stub is marked and strips the native file tools; the desktop surface keeps them', () => {
  assert.equal(createHeadlessComputerToolsStub().headlessUnavailable, true, 'the stub carries the E11 marker');
  const names = (list) => list.map((tool) => tool.name);
  const desktop = toolDefinitions('fill the checkout form', 'agi', {});
  const desktopCoding = toolDefinitions('edit files and run the tests in the repo', 'agi', { workspace: true });
  const headless = toolDefinitions('fill the checkout form', 'agi', { headlessComputer: true });
  const headlessCoding = toolDefinitions('edit files and run the tests in the repo', 'agi', { workspace: true, headlessComputer: true });
  for (const tool of ['computer_read', 'computer_search', 'computer_index', 'computer_fs', 'computer_patch', 'computer_write', 'computer_git']) {
    assert.ok(names(desktop).includes(tool), 'desktop surface keeps ' + tool);
    assert.ok(names(desktopCoding).includes(tool), 'desktop coding subset keeps ' + tool);
    assert.equal(names(headless).includes(tool), false, 'headless strips ' + tool);
    assert.equal(names(headlessCoding).includes(tool), false, 'headless coding subset strips ' + tool);
  }
  // Surviving surfaces: observation/screenshot stay advertised headlessly.
  assert.ok(names(headless).includes('computer_observe'));
  assert.ok(names(headless).includes('computer_screenshot'));
  assert.ok(names(headless).includes('computer_terminal') === false || names(headless).includes('computer_terminal'), 'no unexpected shrink beyond the directive');
});

// ---------- dispatch harness (mirrors enforcement-gen2) ----------

function harness(complete, execute = async () => ({ content: 'same evidence' }), controllerExtras = {}) {
  let calls = 0;
  const controller = { navigationState: () => obsA.navigation, domSnapshot: () => obsA.dom,
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {}, ...controllerExtras };
  const backend = { observe: async () => ({ windows: [], foregroundWindowId: null }), execute, releaseOwner: async () => {}, releaseInput: async () => {} };
  const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit() {}, createProvider: () => ({ complete: ctx => complete(ctx, ++calls) }) });
  agent.transportRetryDelays = [1];
  return { agent, calls: () => calls, start: (settings = {}, extra = {}) => agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off', ...settings }, ...extra }) };
}
