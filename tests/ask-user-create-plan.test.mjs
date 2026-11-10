import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent, toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

// ask_user and create_plan tools (run.txt 2026-10-29):
// - The agent must be able to PAUSE and ask a question without ending the run.
// - The agent must be able to CREATE a plan (not just update one).

function makeHarness(decisions, reply = 'Option 1') {
  let agentRef = null;
  const backend = new ComputerTools({
    nativeRequest: async () => ({}),
    capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null }
  });
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
  };
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {},
    createProvider: () => ({ complete: async () => {
      const d = decisions[Math.min(decision, decisions.length - 1)];
      decision++;
      return d;
    } })
  });
  const start = async () => {
    agentRef = agent;
    // Resolve ask_user with a reply once the resolver is available. The poll
    // is BOUNDED and its timer is unref'd: an unbounded poll keeps the event
    // loop alive after the run ends, so the test file never exits.
    let attempts = 0;
    const poll = () => {
      if (attempts++ > 200) return;
      if (agent.run && agent.resolveUserInput) {
        if (agent.resolveUserInput(agent.run, reply)) return;
      }
      const timer = setTimeout(poll, 5);
      if (typeof timer.unref === 'function') timer.unref();
    };
    poll();
    return agent.start({ task: 'Build GPU spoofing for specific apps', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
  };
  return { agent, backend, start };
}

test('ask_user is offered to the model and does not end the run', async () => {
  const defs = toolDefinitions('multi-part task', 'agi', { workspace: true });
  const askTool = defs.find((t) => t.name === 'ask_user');
  assert.ok(askTool, 'ask_user must be in the tool catalog');
  assert.ok(askTool.description.includes('does NOT end'), 'the description must say the run continues');
  assert.ok(askTool.input?.question, 'ask_user must accept a question');
});

test('create_plan is offered to the model alongside update_plan', () => {
  const defs = toolDefinitions('multi-part task', 'agi', { workspace: true });
  const createTool = defs.find((t) => t.name === 'create_plan');
  const updateTool = defs.find((t) => t.name === 'update_plan');
  assert.ok(createTool, 'create_plan must be in the tool catalog');
  assert.ok(updateTool, 'update_plan must remain in the tool catalog');
  assert.ok(createTool.description.includes('CREATE a new plan'), 'description must say it creates a plan');
});

test('ask_user returns the question and the run continues to the next decision', async () => {
  const h = makeHarness([
    { actions: [{ name: 'ask_user', input: { question: 'Which apps should see the RTX 4090?', options: '1) Per-app only. 2) System-wide (needs admin).' } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'Done after user replied.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    const askEntries = (run.history || []).filter((e) => e.tool === 'ask_user' && e.output?.ok === true);
    assert.ok(askEntries.length >= 1, `expected ask_user to succeed, got: ${JSON.stringify((run.history||[]).map(e=>e.tool))}`);
    const result = askEntries[0].output.result;
    assert.equal(result.asked, true);
    assert.match(result.question, /Which apps/);
    assert.ok(result.options, 'options must be included in the result');
    assert.equal(run.status, 'completed', 'the run must continue and complete after ask_user');
  } finally { await h.backend.close(); }
});

test('create_plan creates a plan that is visible in the run state', async () => {
  const h = makeHarness([
    { actions: [{ name: 'create_plan', input: { steps: [{ id: 'p1', text: 'Build interposition layer', verification: 'apps see the profile' }, { id: 'p2', text: 'Test with a real app', verification: 'app reports RTX 4090' }] } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'Plan created.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    assert.ok(run.plan && run.plan.length === 2, `expected 2 plan items, got ${JSON.stringify(run.plan)}`);
    assert.equal(run.plan[0].text, 'Build interposition layer');
  } finally { await h.backend.close(); }
});

test('ask_user without a question is rejected', async () => {
  const h = makeHarness([
    { actions: [{ name: 'ask_user', input: { options: 'Pick one' } }] },
    { actions: [{ name: 'browser_done', input: { summary: 'Done.', success: true, verified: true } }] }
  ]);
  try {
    const run = await h.start();
    const failures = (run.history || []).filter((e) => e.tool === 'ask_user' && e.output?.ok === false);
    assert.ok(failures.length >= 1, 'ask_user without question must fail');
    assert.match(String(failures[0].output.error), /requires a question/i);
  } finally { await h.backend.close(); }
});
