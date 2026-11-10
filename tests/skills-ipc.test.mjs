import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const { SkillsManager, parseFrontmatter } = require('../desktop/agent/skillsManager.cjs');
const { SkillStore } = require('../desktop/record/skills.cjs');

// The two IPC handlers the Skills screen needs, exercised against the real
// manager and the real store. main.cjs is Electron-bound, so the handler
// bodies are mirrored here; the assertions are about the DATA they return.
function makeHandlers({ manager, store }) {
  return {
    'browser-use:skills-read': (skillId) => {
      if (!require('../desktop/agent/skillsManager.cjs').parseSkillId(skillId)) {
        const learned = store?.get(skillId);
        return learned ? { ok: true, kind: 'learned', skill: learned } : { ok: false, error: 'That skill no longer exists.' };
      }
      const skill = manager.get(skillId);
      if (!skill) return { ok: false, error: 'That skill no longer exists.' };
      try {
        const parsed = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
        return { ok: true, kind: 'installed', skill: { ...skill, steps: undefined, body: parsed.body.replace(/^\n+/, ''), meta: parsed.meta } };
      } catch (error) { return { ok: false, error: `Could not read ${skill.file}: ${error.message}` }; }
    },
    'browser-use:skills-update': (payload) => {
      try {
        const skill = manager.edit(String(payload?.id || ''), {
          name: payload?.name, description: payload?.description, triggers: payload?.triggers, body: payload?.body
        });
        return { ok: true, skill };
      } catch (error) { return { ok: false, error: error.message }; }
    },
    'browser-use:skills-list': () => manager.list().map((skill) => ({
      ...skill, installed: true, readOnly: false, cannotDelete: skill.scope === 'claude', status: skill.enabled ? 'active' : 'paused'
    }))
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-ipc-'));
  const userDir = path.join(root, 'user');
  const skillDir = path.join(userDir, 'demo');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'),
    '---\nname: demo\ndescription: The old description\nlicense: MIT\n---\n\n# Demo\n\nDo the careful thing, then verify it. '.repeat(6));
  const manager = new SkillsManager({ userDir });
  const store = new SkillStore(path.join(root, 'learned.json'));
  store.add({ name: 'Weekly update', when: 'When the user asks for one', steps: [{ action: 'Draft it', detail: 'then send' }] });
  return { root, userDir, skillDir, manager, store, handlers: makeHandlers({ manager, store }) };
}

test('reading an installed skill returns its full text, not the list summary', () => {
  const { handlers } = fixture();
  const result = handlers['browser-use:skills-read']('inst-user-demo');
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'installed');
  assert.match(result.skill.body, /Do the careful thing/);
  assert.ok(result.skill.body.length > 200, 'the screen must get the real body');
  assert.equal(result.skill.meta.license, 'MIT');
  assert.ok(result.skill.health, 'the screen needs the health verdict to show');
});

test('reading a learned skill returns its steps', () => {
  const { handlers, store } = fixture();
  const learned = store.list()[0];
  const result = handlers['browser-use:skills-read'](learned.id);
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'learned');
  assert.equal(result.skill.steps[0].action, 'Draft it');
});

test('reading a skill that is not there says so instead of throwing', () => {
  const { handlers } = fixture();
  const result = handlers['browser-use:skills-read']('inst-user-gone');
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer exists/);
});

test('updating a skill rewrites the file and the list reflects it', () => {
  const { handlers, skillDir } = fixture();
  const result = handlers['browser-use:skills-update']({
    id: 'inst-user-demo', name: 'Renamed demo',
    description: 'A description that explains when the agent should use this',
    triggers: ['alpha', 'beta'], body: '# Demo\n\nNew instructions that are long enough to be real work.\n'
  });
  assert.equal(result.ok, true);
  const onDisk = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(onDisk, /^name: Renamed demo$/m);
  assert.match(onDisk, /^triggers: alpha, beta$/m);
  assert.match(onDisk, /^license: MIT$/m);
  assert.match(onDisk, /New instructions/);
  const listed = handlers['browser-use:skills-list']()[0];
  assert.equal(listed.name, 'Renamed demo');
  assert.deepEqual(listed.trigger.phrases, ['alpha', 'beta']);
});

test('an update that fails is reported, not thrown', () => {
  const { handlers } = fixture();
  const result = handlers['browser-use:skills-update']({ id: 'inst-user-gone', name: 'x' });
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer exists/);
});

test('a learned skill can be added and updated through the store', () => {
  const { store } = fixture();
  const created = store.add({ name: 'New skill', when: 'When asked', steps: [{ action: 'Do it' }] });
  const updated = store.update(created.id, { name: 'Renamed', trigger: { phrases: ['x'] } });
  assert.equal(updated.name, 'Renamed');
  assert.deepEqual(updated.trigger.phrases, ['x']);
  assert.equal(store.get(created.id).name, 'Renamed');
});
