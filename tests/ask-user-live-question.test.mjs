import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ask_user used to return its card only as the tool RESULT, which does not
// exist until the user answers, so the question never reached the screen and
// the run waited forever. The question must be published before the wait, a
// typed reply must resolve it exactly once, and cancel must release it.

async function makeAgent(events, firstAction) {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
  const backend = new ComputerTools({
    nativeRequest: async () => ({}), capture: null,
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
    emit: (event) => events.push(event),
    createProvider: () => ({ complete: async () => {
      decision += 1;
      if (decision === 1) return { actions: [firstAction] };
      return { actions: [{ name: 'browser_done', input: { summary: 'Done.', success: true, verified: true } }] };
    } })
  });
  return { agent, backend };
}

const ASK = { name: 'ask_user', input: { question: 'Which approach?', options: '1) Per-app\n2) System-wide' } };

test('ask_user publishes the question before waiting and a typed reply resolves it once', async () => {
  const events = [];
  const { agent, backend } = await makeAgent(events, ASK);
  try {
    const started = agent.start({ task: 'Pick an approach', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
    let waited = 0;
    while (!events.some((event) => event.type === 'user.input.required') && waited++ < 400) await new Promise((resolve) => setTimeout(resolve, 10));
    const asked = events.find((event) => event.type === 'user.input.required');
    assert.ok(asked, 'user.input.required must be published BEFORE the run waits');
    assert.equal(asked.run.status, 'awaiting_input');
    assert.equal(asked.card.question, 'Which approach?');
    assert.match(asked.card.options, /System-wide/);

    const ack = agent.steer({ runId: asked.run.id, text: 'Per-app' });
    assert.equal(ack.status, 'answered', 'the reply answers the question instead of queueing a second copy');
    const run = await started;
    const entry = run.history.find((item) => item.tool === 'ask_user');
    assert.equal(entry.output.result.userReply, 'Per-app');
    assert.equal(run.pendingUserMessages.length, 0, 'the answer must not also be queued as a steering message');
    assert.ok(events.some((event) => event.type === 'user.input.received' && event.reply === 'Per-app'));
  } finally { await backend.close(); }
});

test('cancelling a run that is waiting on ask_user releases the wait', async () => {
  const events = [];
  const { agent, backend } = await makeAgent(events, ASK);
  try {
    const started = agent.start({ task: 'Pick an approach', settings: { approvalMode: 'unattended', controlMode: 'agi' } });
    let waited = 0;
    while (!events.some((event) => event.type === 'user.input.required') && waited++ < 400) await new Promise((resolve) => setTimeout(resolve, 10));
    const asked = events.find((event) => event.type === 'user.input.required');
    assert.ok(asked);
    agent.cancel(asked.run.id);
    const settled = await Promise.race([started.then(() => 'settled', () => 'settled'), new Promise((resolve) => setTimeout(() => resolve('hung'), 5000))]);
    assert.equal(settled, 'settled', 'a cancelled ask_user must not hang the run');
  } finally { await backend.close(); }
});

test('the .claude/skills scope makes SKILL.md folders visible to list and search', () => {
  const { SkillsManager, parseSkillId } = require('../desktop/agent/skillsManager.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-claude-scope-'));
  const claudeDir = path.join(root, '.claude', 'skills');
  fs.mkdirSync(path.join(claudeDir, 'frontend-design'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'frontend-design', 'SKILL.md'),
    '---\nname: frontend-design\ndescription: Distinctive visual design for new user interface work\n---\n\nPick a palette, typography and layout deliberately.\n');
  const manager = new SkillsManager({ userDir: path.join(root, 'user-skills'), claudeDir });
  const [skill] = manager.list();
  assert.equal(skill.id, 'inst-claude-frontend-design');
  assert.equal(skill.scope, 'claude');
  assert.deepEqual(parseSkillId(skill.id), { scope: 'claude', slug: 'frontend-design' });
  assert.equal(manager.search({ task: 'design a distinctive user interface palette' })[0]?.skill.id, skill.id);
});
