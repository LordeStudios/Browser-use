import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLayaEngine, goalTokens, launchTarget } = require('../desktop/agent/layaEngine.cjs');
const { createLayaVerifier } = require('../desktop/agent/layaDecision.cjs');
const { createLayaProvider, LAUNCH_WAIT_MS } = require('../desktop/agent/layaProvider.cjs');

const engine = createLayaEngine();

test('goal tokens drop action verbs and stopwords; launch targets parse', () => {
  assert.deepEqual(goalTokens('Open Photoshop'), ['photoshop']);
  assert.deepEqual(goalTokens('open the file in gimp and draw a circle').sort(), ['circle', 'file', 'gimp']);
  assert.equal(launchTarget('You open photoshop'), 'photoshop');
  assert.equal(launchTarget('Youopen photoshop'), 'photoshop', 'the glued-typo form still detects the launch');
  assert.equal(launchTarget('please start "Adobe Photoshop"'), 'Adobe Photoshop');
  assert.equal(launchTarget('buy a coffee mug'), null);
});

test('verify answers only what the state proves: first pass abstains on change, then diffs', async () => {
  const verifier = createLayaVerifier({});
  const observation = { dom: { url: 'https://a.test/', title: 'A', elements: [{ tag: 'button', name: 'Buy' }] } };
  const first = await verifier.verify({ observation, domain: 'browser' });
  assert.equal(first.brain, 'bundled');
  assert.equal(first.answers.page_changed, undefined, 'no previous digest -> abstain (below gate)');
  assert.equal(first.answers.effect_visible, undefined, '"controls exist" alone is too weak to claim an effect');
  const second = await verifier.verify({ observation, domain: 'browser' });
  assert.equal(second.answers.page_changed.value, 0, 'identical digest -> confident no');
  assert.equal(second.answers.page_changed.evidence, 'url, title and control count are all unchanged');
  const third = await verifier.verify({ observation: { dom: { ...observation.dom, url: 'https://b.test/', title: 'B' } }, domain: 'browser' });
  assert.equal(third.answers.page_changed.value, 1, 'changed digest -> confident yes');
  assert.equal(third.answers.effect_visible.value, 1, 'controls changed alongside the diff -> effect visible');
  assert.ok(third.answers.effect_visible.evidence);
});

test('computer verify: new window ids and foreground decide the window questions', async () => {
  const answers = engine.predict({
    state: { last_action: 'computer_terminal', action_ok: true, foreground: '42', windows: 'Adobe Photoshop at 0,0', new_window_ids: '["42"]' },
    questions: { new_window: { type: 'noul' }, target_foreground: { type: 'noul' }, dialog_open: { type: 'noul' } }
  }).answers;
  assert.equal(answers.new_window.noul, 1);
  assert.equal(answers.target_foreground.noul, 1);
  assert.equal(answers.dialog_open.confidence, 0.55, 'no dialog evidence -> abstain below the gate');
});

test('task completion requires dispatched work and visible goal tokens', () => {
  const questions = { task_complete: { type: 'noul' } };
  const nothingDone = engine.predict({ state: { task: 'open photoshop', last_action: 'none', windows: 'Adobe Photoshop' }, questions }).answers.task_complete;
  assert.equal(nothingDone.noul, 0, 'goal visible but nothing dispatched -> not complete');
  const done = engine.predict({ state: { task: 'open photoshop', last_action: 'computer_window', windows: 'Adobe Photoshop at 0,0 800x600' }, questions }).answers.task_complete;
  assert.equal(done.noul, 1);
  assert.ok(done.confidence >= 0.6);
  const absent = engine.predict({ state: { task: 'open photoshop', last_action: 'computer_window', windows: 'Notepad' }, questions }).answers.task_complete;
  assert.equal(absent.noul, 0);
});

test('standalone computer flow: launch task co-emits the launch and the waitMs window list', async () => {
  const provider = createLayaProvider({});
  const decision = await provider.complete({ task: 'Open photoshop', observation: { desktop: { foregroundWindowId: '1', windows: [{ id: '1', title: 'File Explorer' }] } }, history: [] });
  assert.equal(decision.laya.brain, 'bundled');
  assert.equal(decision.actions.length, 2, 'launch and window-list verification are one decision');
  assert.equal(decision.actions[0].name, 'computer_terminal');
  assert.match(decision.actions[0].input.command, /Start-Process -FilePath "photoshop"/);
  assert.deepEqual(decision.actions[1].input, { action: 'list', waitMs: LAUNCH_WAIT_MS });
});

test('a silent launch (exit 0, no window) waits again before relaunching', async () => {
  // Exactly the notepad transcript: the launch succeeded, the 30s wait found
  // no window, and the next decision must not repeat the same trigger blindly.
  const provider = createLayaProvider({});
  const history = [
    { tool: 'computer_terminal', input: { action: 'execute', command: 'Start-Process -FilePath "notepad"' } },
    { tool: 'computer_window', input: { action: 'list', waitMs: LAUNCH_WAIT_MS } }
  ];
  const decision = await provider.complete({
    task: 'Youopen notepad',
    observation: { desktop: { foregroundWindowId: '6685608', windows: [{ id: '6685608', title: 'Browser-use' }, { id: '65762', title: 'Start' }] } },
    history
  });
  assert.equal(decision.actions[0].name, 'computer_window', 'wait-again outranks relaunch');
  assert.deepEqual(decision.actions[0].input, { action: 'list', waitMs: LAUNCH_WAIT_MS });
  assert.equal(decision.actions.length, 1, 'a wait is one action, not a second launch');
});

test('standalone computer flow: goal tokens visible after work -> done, then verified', async () => {
  const provider = createLayaProvider({});
  const observation = { desktop: { foregroundWindowId: '42', windows: [{ id: '42', title: 'Adobe Photoshop' }] } };
  const history = [{ tool: 'computer_terminal' }, { tool: 'computer_window' }];
  const proposal = await provider.complete({ task: 'Open photoshop', observation, history });
  assert.equal(proposal.done.verified, false);
  const verified = await provider.complete({ task: 'Open photoshop', observation, history });
  assert.equal(verified.done.verified, true);
});

test('standalone computer flow without a launch verb falls back to grounded observation', async () => {
  const provider = createLayaProvider({});
  const decision = await provider.complete({ task: 'Tidy the desktop', observation: { desktop: { foregroundWindowId: '1', windows: [] } }, history: [] });
  assert.deepEqual(decision.actions, [{ name: 'computer_observe', input: {} }]);
});

test('standalone browser flow still scores element candidates against the task', async () => {
  const provider = createLayaProvider({});
  const decision = await provider.complete({
    task: 'place the order',
    observation: { dom: { url: 'https://shop.test/', title: 'Checkout', elements: [{ index: 0, tag: 'h1', text: 'Checkout' }, { index: 1, tag: 'button', text: 'Place order' }, { index: 2, tag: 'a', text: 'Back to cart' }] } },
    history: [{ tool: 'browser_click' }]
  });
  assert.deepEqual(decision.actions, [{ name: 'browser_click', input: { element: 1 } }]);
  assert.equal(decision.laya.brain, 'bundled');
});

test('a configured sidecar still takes precedence, with the engine as fallback', async () => {
  let calls = 0;
  const provider = createLayaProvider({
    fetchImpl: async () => { calls += 1; throw new Error('ECONNREFUSED'); }
  });
  const decision = await provider.complete({ task: 'Open photoshop', observation: { dom: { url: 'https://a.test/', title: 'A', elements: [] } }, history: [] });
  assert.equal(calls, 1, 'the sidecar was consulted first');
  assert.equal(decision.laya.brain, 'bundled', 'the engine answered when the sidecar failed');
});
