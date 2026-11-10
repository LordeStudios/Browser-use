import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { codingCheckSatisfied } = require('../desktop/agent/desktopChatAgent.cjs');
const { createLayaProvider } = require('../desktop/agent/layaProvider.cjs');

const WORKSPACE = { root: 'E:/repo' };
const CODING_TASK = 'stress test the site as fast as possible and fix what you find';

const terminalEntry = (text) => ({ tool: 'computer_terminal', input: { action: 'execute' }, output: { ok: true, result: { stdout: text, exitCode: 0 } } });
const executeEntry = (value) => ({ tool: 'browser_execute', input: { script: 'probe' }, output: { ok: true, result: value } });

test('completed in-page probe evidence satisfies the coding gate (the 8-bounce regression)', () => {
  const run = { task: CODING_TASK, workspace: WORKSPACE, history: [executeEntry({ total: 300, ok: 300, errors: 0, note: 'site healthy' })] };
  assert.equal(codingCheckSatisfied(run), true, 'browser_execute measurement JSON with zero failures must count as completed evidence');
});

test('terminal evidence still satisfies the coding gate', () => {
  const run = { task: CODING_TASK, workspace: WORKSPACE, history: [terminalEntry('tests 12 passed')] };
  assert.equal(codingCheckSatisfied(run), true);
});

test('probe evidence with real failures does NOT satisfy the coding gate', () => {
  const run = { task: CODING_TASK, workspace: WORKSPACE, history: [executeEntry({ total: 300, ok: 290, errors: 10 })] };
  assert.equal(codingCheckSatisfied(run), false);
});

test('non-coding tasks bypass the gate entirely', () => {
  assert.equal(codingCheckSatisfied({ task: 'open google', history: [] }), true);
});

test('System One drives through Jev when the brain is jev (LORDE_JEV_PLANNER)', async () => {
  let consulted = 0;
  const predictBrain = async () => { consulted += 1; return { answers: { best_action: { choice: 'click button "Place order"', confidence: 0.91 } } }; };
  const provider = createLayaProvider({ predictBrain });
  const decision = await provider.complete({ task: 'Place the order', observation: { dom: { elements: [{ index: 1, tag: 'button', text: 'Place order' }] } } });
  assert.equal(consulted, 1, 'Jev was consulted before the bundled engine');
  assert.equal(decision.laya.brain, 'jev');
  assert.deepEqual(decision.actions, [{ name: 'browser_click', input: { element: 1 } }]);
});

test('a dead Jev brain degrades to the bundled engine in System One mode', async () => {
  const predictBrain = async () => { throw new Error('Jev HTTP 503'); };
  const provider = createLayaProvider({ predictBrain });
  const decision = await provider.complete({ task: 'Open photoshop', observation: { desktop: { foregroundWindowId: '1', windows: [] } }, history: [] });
  assert.equal(decision.laya.brain, 'bundled');
  assert.equal(decision.actions[0].name, 'computer_terminal');
});

test('Jev predictor maps noul probability to calibrated certainty for the Laya contract', async () => {
  const { createJevPredictor } = require('../desktop/agent/jevProvider.cjs');
  let body = null;
  const predictor = createJevPredictor({ apiKey: 'fixture-key', fetchImpl: async (url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ answers: { task_complete: { type: 'noul', noul: 0.95 }, best_action: { type: 'choice', choice: 'x', confidence: 0.7 } } });
  } });
  const { answers } = await predictor({ task: 'x' }, { task_complete: { type: 'noul', instructions: 'done?' } });
  assert.equal(body.model, 'jev-latest');
  assert.equal(answers.task_complete.confidence, 0.9, 'noul 0.95 -> certainty 0.9');
  assert.equal(answers.best_action.confidence, 0.7, 'choice confidence passes through');
});
