import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { SkillsManager, createMergedSkillsApi } = require('../desktop/agent/skillsManager.cjs');

// The 2026-10-30 run used the UI design skill and still skipped its quality
// checks. The cause was not the model: the skill body was cut at 6,000 of
// 9,074 characters, so the "Restraint and self-critique" section — the part
// that IS the quality check — never reached the model.
//
// This drives the real agent's skill_search -> skill_run path against the
// real installed skills and checks what the MODEL would receive.

const installedSkill = process.env.BROWSER_USE_INSTALLED_SKILL || 'inst-claude-frontend-design';

function buildAgent(actions) {
  const backend = new ComputerTools({ nativeRequest: async () => ({}), capture: null,
    workspaceGuard: { beforeMutation: async () => null, afterMutation: async () => null, noteRead: async () => null } });
  const controller = { navigationState: () => ({ url: 'https://f.test', loading: false }),
    domSnapshot: () => ({ url: 'https://f.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {} };
  const manager = new SkillsManager({
    userDir: fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-skills-')),
    claudeDir: path.join(repo, '.claude', 'skills')
  });
  let turn = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'agi', getComputerTools: () => backend,
    emit: () => {}, skillsApi: createMergedSkillsApi({ manager }),
    createProvider: () => ({ complete: async () => ({ actions: [actions[Math.min(turn++, actions.length - 1)]] }) })
  });
  return { agent, backend };
}

test('skill_search finds an installed skill by what it is for', async () => {
  const { agent, backend } = buildAgent([
    { name: 'skill_search', input: { task: 'redesign a homepage with distinctive visual design' } },
    { name: 'browser_done', input: { summary: 'done', success: true, verified: true } }
  ]);
  try {
    const run = await Promise.race([agent.start({ task: 'redesign a homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }), new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
    const search = (run?.history || []).find((entry) => entry.tool === 'skill_search');
    assert.ok(search, 'the search must run');
    assert.equal(search.output.ok, true);
    const matches = search.output.result?.matches || [];
    assert.ok(matches.length, `the search must find the installed skill: ${JSON.stringify(search.output)}`);
    assert.ok(matches.some((match) => String(match.skillId || match.id || '').includes('frontend-design') || String(match.name || '').includes('frontend design')),
      `the design skill must be found: ${JSON.stringify(matches)}`);
  } finally { await backend.close(); }
});

test('skill_run gives the model the WHOLE skill body, not the list summary', async () => {
  const { agent, backend } = buildAgent([
    { name: 'skill_run', input: { skillId: installedSkill } },
    { name: 'browser_done', input: { summary: 'done', success: true, verified: true } }
  ]);
  try {
    const run = await Promise.race([agent.start({ task: 'redesign a homepage', settings: { approvalMode: 'unattended', controlMode: 'agi' } }), new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
    const loaded = (run?.history || []).find((entry) => entry.tool === 'skill_run');
    assert.ok(loaded, 'the run must load the skill');
    assert.equal(loaded.output.ok, true, `the skill must load: ${JSON.stringify(loaded.output)}`);
    const steps = loaded.output.result?.steps || [];
    const body = steps.join('\n');

    const onDisk = fs.readFileSync(path.join(repo, '.claude', 'skills', 'frontend-design', 'SKILL.md'), 'utf8');
    const bodyText = onDisk.split(/^---\s*$/m).slice(2).join('---');
    const meaningful = bodyText.split('\n').map((line) => line.trim()).filter((line) => line.length > 40);

    // The body the model receives must be the body on disk, not a summary.
    assert.ok(body.length > 9000, `the whole body must reach the model, got ${body.length} characters`);
    for (const line of meaningful) {
      assert.ok(body.includes(line), `the body the model receives is missing a line of the skill:\n  ${line.slice(0, 120)}`);
    }
    // And the quality-check section in particular — the part the 2026-10-30
    // run never saw.
    assert.ok(/self-critique|self critique|restraint/i.test(body), 'the quality-check section must reach the model');
  } finally { await backend.close(); }
});
