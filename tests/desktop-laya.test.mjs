import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLayaVerifier, CONFIDENCE_GATE } = require('../desktop/agent/layaDecision.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const BROWSER_OBSERVATION = {
  navigation: { url: 'https://example.test/prices' },
  dom: { url: 'https://example.test/prices', title: 'Pricing', elements: [{ tag: 'button', name: 'Checkout' }] }
};

function layaResponse(overrides = {}) {
  return {
    answers: {
      page_changed: { noul: 0.94, confidence: 0.93 },
      effect_visible: { noul: 0.9, confidence: 0.88 },
      needs_attention: { noul: 0.05, confidence: 0.35 },
      ...overrides
    },
    tookMs: 33
  };
}

test('the verifier annotates the observation with above-gate typed answers', async () => {
  let posted = null;
  const verifier = createLayaVerifier({
    endpoint: 'http://127.0.0.1:8765',
    fetchImpl: async (url, options) => {
      posted = { url, body: JSON.parse(options.body) };
      return Response.json(layaResponse());
    }
  });
  const result = await verifier.verify({ observation: BROWSER_OBSERVATION, action: { name: 'browser_click', ok: true }, domain: 'browser' });
  assert.equal(posted.url, 'http://127.0.0.1:8765/predict');
  assert.equal(posted.body.questions.page_changed.type, 'noul');
  assert.match(posted.body.state.url, /example\.test/);
  assert.equal(result.layer, 'laya');
  assert.equal(result.answers.page_changed.value, 0.94);
  assert.ok(result.answers.effect_visible.confidence >= CONFIDENCE_GATE);
  assert.equal(result.answers.needs_attention, undefined, 'below-gate answers are omitted');
  // A confident NO is still a typed answer the strong model can act on.
  assert.equal(result.answers.page_changed.value, 0.94);
});

test('low-confidence answers are dropped so the strong model decides them', async () => {
  const verifier = createLayaVerifier({
    fetchImpl: async () => Response.json(layaResponse({ effect_visible: { noul: 0.4, confidence: 0.35 } }))
  });
  const result = await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  assert.equal(result.answers.effect_visible, undefined);
  assert.ok(result.answers.page_changed.confidence >= CONFIDENCE_GATE);
});

test('a configured sidecar that answers is used and labeled', async () => {
  const verifier = createLayaVerifier({
    fetchImpl: async () => Response.json(layaResponse())
  });
  const result = await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  assert.equal(result.brain, 'sidecar');
});

test('a dead sidecar degrades to the bundled engine — one system, never stranded', async () => {
  const verifier = createLayaVerifier({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); }
  });
  const result = await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  assert.ok(result, 'failure is invisible; the bundled engine answers');
  assert.equal(result.brain, 'bundled');
  // The engine only speaks when the state proves it: with no previous digest,
  // page change and effect claims stay below the gate and are omitted.
  assert.equal(result.answers.page_changed, undefined);
  assert.equal(result.answers.effect_visible, undefined);
});

test('repeated timeouts park the HTTP path so the sidecar cannot be queued into oblivion', async () => {
  let attempts = 0;
  const verifier = createLayaVerifier({
    timeoutMs: 30,
    fetchImpl: () => new Promise((resolve, reject) => {
      attempts += 1;
      const timer = setTimeout(() => resolve(Response.json(layaResponse())), 5_000);
      const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })); };
      require('node:timers').setTimeout(onAbort, 35).unref?.();
    })
  });
  // Two slow passes: both wait out the timeout, then the HTTP path is parked.
  await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  const before = attempts;
  const parked = await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser' });
  assert.equal(attempts, before, 'the parked verifier performs no further HTTP attempts');
  assert.equal(parked.brain, 'bundled', 'the bundled engine answers instantly instead');
});

test('computer-domain observations ask window questions', async () => {
  let posted = null;
  const verifier = createLayaVerifier({
    fetchImpl: async (url, options) => { posted = JSON.parse(options.body); return Response.json(layaResponse()); }
  });
  await verifier.verify({
    observation: { desktop: { foregroundWindowId: '42', windows: [{ id: '42', title: 'Blender', bounds: { x: 0, y: 0, width: 1920, height: 1080 } }] }, newWindowIds: ['42'] },
    action: { name: 'computer_window', ok: true },
    domain: 'computer'
  });
  assert.ok(posted.questions.new_window);
  assert.match(posted.state.windows, /Blender/);
  assert.equal(posted.questions.page_changed, undefined);
});

test('an aborted run skips the verifier entirely', async () => {
  let calls = 0;
  const verifier = createLayaVerifier({
    fetchImpl: async () => { calls += 1; return Response.json(layaResponse()); }
  });
  const controller = new AbortController();
  controller.abort();
  const result = await verifier.verify({ observation: BROWSER_OBSERVATION, domain: 'browser', signal: controller.signal });
  assert.equal(result, null);
  assert.equal(calls, 0);
});

// --- Agent wiring ---

function createAgentController() {
  return {
    calls: [],
    async domSnapshot() {
      return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; }
  };
}

test('laya verification rides on the NEXT decision — never blocking the current one', async () => {
  const controller = createAgentController();
  const received = [];
  const verified = [];
  const events = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'laya.verification') events.push(event); },
    layaVerifierFactory: () => ({
      verify: async (input) => {
        verified.push(input.domain);
        return { layer: 'laya', brain: 'bundled', answers: { page_changed: { value: 0.95, confidence: 0.94 } }, tookMs: 31 };
      }
    }),
    createProvider: () => ({
      async complete(context) {
        received.push({ observation: context.observation, layaVerification: context.layaVerification });
        if (received.length <= 2) return { actions: [{ name: 'browser_click', input: { element: 1 } }] };
        return { done: { summary: 'Done.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Verify me with laya', provider: { id: 'mock' }, settings: { layaEnabled: true } });
  // Decision 1 has no previous action (nothing to confirm); the two clicks
  // each trigger one non-blocking verify that lands on the NEXT decision.
  assert.deepEqual(verified, ['browser', 'browser'], 'mutating actions verify; nothing blocks the decision');
  assert.equal(received[0].layaVerification, undefined, 'decision 1 has no prior effect to verify');
  assert.equal(received[2].layaVerification?.answers?.page_changed?.value, 0.95, 'the settled annotation reaches a later decision');
  assert.equal(events.length, 2, 'every verify publishes its engagement');
  assert.equal(events[0].brain, 'bundled');
  assert.equal(events[0].answers.page_changed.value, 0.95);
  assert.equal(run.status, 'completed');
});

test('read-only actions never spend a laya verify', async () => {
  const controller = createAgentController();
  let verifies = 0;
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    layaVerifierFactory: () => ({ verify: async () => { verifies += 1; return { layer: 'laya', answers: {}, tookMs: 1 }; } }),
    createProvider: () => ({
      async complete() {
        calls += 1;
        if (calls === 1) return { actions: [{ name: 'browser_observe', input: {} }] };
        if (calls === 2) return { actions: [{ name: 'browser_console_entries', input: {} }] };
        return { done: { summary: 'Done.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Only read and wait in this run before finishing', provider: { id: 'mock' }, settings: { layaEnabled: true } });
  assert.equal(run.status, 'completed');
  assert.equal(verifies, 0, 'observes and read-only actions have no mechanical effect to confirm');
});

test('with laya off (default) the run is byte-identical to before — weak machines unaffected', async () => {
  const controller = createAgentController();
  let verifierCalls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    layaVerifierFactory: () => ({ verify: async () => { verifierCalls += 1; return { layer: 'laya', answers: {} }; } }),
    createProvider: () => ({ async complete(context) { assert.equal(context.observation?.layaVerification, undefined); return { done: { summary: 'Done.', success: true, verified: true } }; } })
  });
  const run = await agent.start({ task: 'No laya for me', provider: { id: 'mock' } });
  assert.equal(verifierCalls, 0, 'laya must not even be constructed off');
  assert.equal(run.status, 'completed');
});

test('a throwing verifier never touches the run', async () => {
  const controller = createAgentController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    layaVerifierFactory: () => ({ verify: async () => { throw new Error('laya exploded'); } }),
    createProvider: () => ({ async complete(context) { assert.equal(context.observation?.layaVerification, undefined); return { done: { summary: 'Unaffected.', success: true, verified: true } }; } })
  });
  const run = await agent.start({ task: 'Complete despite a broken accelerator', provider: { id: 'mock' }, settings: { layaEnabled: true } });
  assert.equal(run.status, 'completed');
  assert.equal(run.result.summary, 'Unaffected.');
});

test('the serialized run never carries the verifier function across IPC', async () => {
  const controller = createAgentController();
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    layaVerifierFactory: () => ({ verify: async () => ({ layer: 'laya', answers: {} }) }),
    createProvider: () => ({ async complete() { return { done: { summary: 'Done.', success: true, verified: true } }; } })
  });
  const run = await agent.start({ task: 'Serialize me with the verifier active on this run', provider: { id: 'mock' }, settings: { layaEnabled: true } });
  assert.equal('layaVerifier' in run, false);
  assert.doesNotThrow(() => structuredClone(run));
});

// ---- Laya delivery + ranking (2026-10-01) ------------------------------------
// Two silent drops found: layaVerification was accepted by the agent but
// ignored by every provider signature (it never reached any model), and the
// engine's choice/ranking path was never asked anything (no task, no
// candidates, no choice question).

test('layaVerification and the consulted ledger survive boundedRequestContext', () => {
  const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');
  const context = boundedRequestContext({
    task: 'Fix the overlay', messages: [], observation: { dom: { elements: [] } }, plan: [], goals: [],
    workingMemory: { consulted: [{ k: 'read', path: 'src/editor/canvas.js', from: 130, to: 199, total: 2763 }] },
    layaVerification: {
      brain: 'bundled', tookMs: 12,
      answers: { page_changed: { value: 1, confidence: 0.8 }, best_next_target: { value: 'Add to favourites (button)', confidence: 0.71 } }
    }
  });
  assert.equal(context.workingMemory.consulted?.length, 1, 'consulted evidence must reach the real request context');
  assert.equal(context.layaVerification.answers.best_next_target.value, 'Add to favourites (button)');
  assert.match(context.layaVerification.note, /advisory/i);
  // Omitted entirely when the layer has nothing above the confidence gate.
  const quiet = boundedRequestContext({ task: 't', messages: [], plan: [], goals: [], layaVerification: { brain: 'bundled', answers: {} } });
  assert.equal(quiet.layaVerification, undefined);
});

test('the verify layer asks the ranking question and Laya ranks candidates against the task', async () => {
  const { createLayaVerifier } = require('../desktop/agent/layaDecision.cjs');
  const verifier = createLayaVerifier({});
  const verification = await verifier.verify({
    domain: 'browser',
    task: 'add this item to favourites',
    action: { name: 'browser_click', ok: true },
    observation: {
      dom: {
        url: 'https://shop.test/item/1', title: 'Item page',
        elements: [
          { index: 0, tag: 'button', name: 'Add to favourites', text: 'Add to favourites', enabled: true },
          { index: 1, tag: 'button', name: 'Share', text: 'Share', enabled: true },
          { index: 2, tag: 'a', name: 'Back to results', text: 'Back to results', enabled: true }
        ]
      }
    }
  });
  const ranking = verification?.answers?.best_next_target;
  assert.ok(ranking, 'the ranking question must be asked');
  assert.match(String(ranking.value), /Add to favourites/i, 'the favourite control must win the goal-overlap ranking');
  assert.ok(ranking.confidence >= 0.6, 'a clear winner clears the confidence gate');
});
