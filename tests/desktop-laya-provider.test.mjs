import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLayaProvider, candidateActions } = require('../desktop/agent/layaProvider.cjs');

const DOM = {
  url: 'https://shop.test/checkout',
  title: 'Checkout',
  elements: [
    { index: 0, tag: 'h1', text: 'Checkout' },
    { index: 1, tag: 'button', text: 'Place order' },
    { index: 2, tag: 'a', text: 'Delivery options', enabled: false },
    { index: 3, tag: 'a', text: 'Back to cart' }
  ]
};

function layaAnswers(overrides = {}) {
  return {
    task_complete: { noul: 0.05, confidence: 0.9 },
    best_action: { choice: 0, confidence: 0.9 },
    ...overrides
  };
}

test('candidate actions are the visible interactive controls plus grounded scrolls', () => {
  const candidates = candidateActions({ dom: DOM });
  assert.equal(candidates.length, 4, 'two enabled clickables plus scroll down and up');
  assert.deepEqual(candidates.slice(0, 2).map((c) => c.input.element), [1, 3], 'disabled element 2 is not a candidate');
  assert.equal(candidates[2].name, 'browser_scroll');
});

test('a confident choice executes the chosen candidate action', async () => {
  let posted = null;
  const provider = createLayaProvider({
    fetchImpl: async (url, options) => {
      posted = JSON.parse(options.body);
      return Response.json({ answers: layaAnswers({ best_action: { choice: 'click button "Place order"', confidence: 0.87 } }), tookMs: 29 });
    }
  });
  const decision = await provider.complete({ task: 'Place the order', observation: { dom: DOM } });
  assert.equal(posted.questions.best_action.type, 'choice');
  assert.ok(Array.isArray(posted.questions.best_action.criteria), 'the real Laya contract requires criteria for choice questions');
  assert.ok(posted.questions.best_action.criteria.includes('none of them help'));
  assert.ok(posted.state.candidates.some((label) => label.includes('Place order')));
  assert.deepEqual(decision.actions, [{ name: 'browser_click', input: { element: 1 } }]);
  assert.equal(decision.laya.tookMs, 29);
});

test('completion is a proposal first and verified only on the consecutive reconfirm', async () => {
  let calls = 0;
  const provider = createLayaProvider({
    fetchImpl: async () => {
      calls += 1;
      // Calls 1-2 answer complete; call 3 (new work) says not complete; call 4 answers complete again.
      const answers = calls === 3
        ? layaAnswers({ task_complete: { noul: 0.05, confidence: 0.9 }, best_action: { choice: 2, confidence: 0.9 } })
        : layaAnswers({ task_complete: { noul: 0.95, confidence: 0.94 } });
      return Response.json({ answers, tookMs: 21 });
    }
  });
  const first = await provider.complete({ task: 'Place the order', observation: { dom: DOM } });
  assert.equal(first.done.success, true);
  assert.equal(first.done.verified, false, 'first complete answer is a proposal for the completion review');
  const second = await provider.complete({ task: 'Place the order', observation: { dom: DOM } });
  assert.equal(second.done.verified, true, 'consecutive reconfirm verifies');
  assert.equal(calls, 2);
  // New work arrives: a non-complete answer resets the proposal, so the next
  // completion is a fresh proposal again rather than auto-verified.
  await provider.complete({ task: 'Now also open settings', observation: { dom: DOM } });
  const fourth = await provider.complete({ task: 'Now also open settings', observation: { dom: DOM } });
  assert.equal(fourth.done.verified, false, 'a fresh completion after new work is a proposal again');
});

test('a dead sidecar falls back to the bundled engine — one system, never stranded', async () => {
  let calls = 0;
  const provider = createLayaProvider({
    fetchImpl: async () => { calls += 1; throw new Error('ECONNREFUSED'); }
  });
  const decision = await provider.complete({ task: 'Open photoshop', observation: { desktop: { foregroundWindowId: '1', windows: [] } }, history: [] });
  assert.equal(calls, 1, 'the sidecar was consulted first');
  assert.equal(decision.laya.brain, 'bundled');
  assert.equal(decision.actions[0].name, 'computer_terminal', 'the bundled engine still drives the launch flow');
});

test('no confident candidate degrades to a grounded scroll, never a fabricated click', async () => {
  const provider = createLayaProvider({
    fetchImpl: async () => Response.json({ answers: layaAnswers({ best_action: { choice: 'click button "Place order"', confidence: 0.2 } }), tookMs: 18 })
  });
  const decision = await provider.complete({ task: 'Find the settings page', observation: { dom: DOM } });
  assert.deepEqual(decision.actions, [{ name: 'browser_scroll', input: { deltaY: 400 } }]);
  assert.equal(decision.laya.note, 'no confident candidate');
});

test('a choice naming an unknown candidate is ignored', async () => {
  const provider = createLayaProvider({
    fetchImpl: async () => Response.json({ answers: layaAnswers({ best_action: { choice: 'delete the database', confidence: 0.99 } }), tookMs: 12 })
  });
  const decision = await provider.complete({ task: 'x', observation: { dom: DOM } });
  assert.equal(decision.actions[0].name, 'browser_scroll');
});
