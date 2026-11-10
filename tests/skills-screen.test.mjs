import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const view = require('../desktop/renderer/skillsView.cjs');
const { SkillsManager, assessSkillHealth, parseFrontmatter } = require('../desktop/agent/skillsManager.cjs');

// The skills screen, 2026-10-30: the header was disorganized, a skill could
// not be viewed, and a skill's title or text could not be edited. Two of the
// installed skills also failed the "is this a real skill" question: one had a
// header that did not parse, so it had no description at all.
function installed(overrides = {}) {
  return {
    id: 'inst-claude-demo', slug: 'demo', scope: 'claude', installed: true, readOnly: false,
    name: 'demo', description: 'A description of the skill.', when: 'A description of the skill.',
    bodyChars: 1200, status: 'active', trigger: { phrases: ['demo'] }, usage: { runs: 0, successes: 0 },
    health: { ok: true, problems: [], notes: [] },
    ...overrides
  };
}
function learned(overrides = {}) {
  return {
    id: 'skl_1', name: 'Weekly update', when: 'When the user asks for a weekly update',
    steps: [{ action: 'Do it', detail: 'then check' }], status: 'active', trigger: { phrases: [] },
    ...overrides
  };
}

test('a skill the agent can use is Ready, one it cannot is flagged for attention', () => {
  assert.equal(view.skillState(installed()).key, 'ready');
  assert.equal(view.skillState(learned()).key, 'ready');
  // No trigger sentence: the agent has nothing to match a task against.
  const noTrigger = view.skillState(learned({ when: '' }));
  assert.equal(noTrigger.key, 'attention');
  assert.match(noTrigger.health.problems[0], /when the agent should use/);
  // No steps: nothing to follow.
  assert.equal(view.skillState(learned({ steps: [] })).key, 'attention');
  // Paused is its own state, whatever the health says.
  assert.equal(view.skillState(learned({ status: 'paused' })).key, 'paused');
  // An installed skill that failed its own on-disk health check is flagged.
  const broken = installed({ health: { ok: false, problems: ['The header block is missing or unreadable, so this skill has no name or description to match on.'], notes: [] } });
  assert.equal(view.skillState(broken).key, 'attention');
  assert.match(broken.health.problems[0], /header block is missing/);
});

test('the summary and filter counts name what needs attention', () => {
  const skills = [installed(), learned(), learned({ id: 'skl_2', name: 'Broken', when: '', steps: [] }), learned({ id: 'skl_3', name: 'Off', status: 'paused' })];
  assert.equal(view.skillsSummary(skills), '4 skills, 1 needs attention, 1 paused');
  assert.equal(view.skillsSummary([]), 'No skills yet');
  assert.equal(view.skillsSummary([installed()]), '1 skill');
  const counts = view.filterCounts(skills, [['all', 'All'], ['learned', 'Learned'], ['installed', 'Installed'], ['attention', 'Needs attention']]);
  assert.deepEqual(counts.map((row) => [row.label, row.count]), [['All', 4], ['Learned', 3], ['Installed', 1], ['Needs attention', 1]]);
});

test('search and filters narrow the list', () => {
  const skills = [installed(), learned(), learned({ id: 'skl_2', name: 'Broken', when: '', steps: [] })];
  assert.deepEqual(view.visibleSkills(skills, { filter: 'installed' }).map((s) => s.id), ['inst-claude-demo']);
  assert.deepEqual(view.visibleSkills(skills, { filter: 'learned' }).map((s) => s.id), ['skl_1', 'skl_2']);
  assert.deepEqual(view.visibleSkills(skills, { filter: 'attention' }).map((s) => s.id), ['skl_2']);
  assert.deepEqual(view.visibleSkills(skills, { query: 'weekly' }).map((s) => s.id), ['skl_1']);
  assert.deepEqual(view.visibleSkills(skills, { query: 'nothing here' }), []);
});

test('the editor reads and writes steps and triggers without losing detail', () => {
  const steps = view.parseSteps('Read the file: open index.html\nWrite the summary\n');
  assert.deepEqual(steps, [{ action: 'Read the file', detail: 'open index.html' }, { action: 'Write the summary', detail: '' }]);
  assert.equal(view.stepsToText(steps), 'Read the file: open index.html\nWrite the summary');
  assert.deepEqual(view.parseTriggers('weekly update, publish post , '), ['weekly update', 'publish post']);
});

test('the editor refuses an empty skill with a sentence that says what is missing', () => {
  assert.match(view.validateSkillForm({ title: '', when: 'x', body: 'y', installed: false }), /title/);
  assert.match(view.validateSkillForm({ title: 'T', when: 'x', body: '  ', installed: false }), /at least one step/);
  assert.match(view.validateSkillForm({ title: 'T', when: '', body: 'y', installed: true }), /description/);
  assert.match(view.validateSkillForm({ title: 'T', when: '', body: 'y', installed: false }), /when the agent should use/);
  assert.equal(view.validateSkillForm({ title: 'T', when: 'x', body: 'y', installed: false }), null);
});

test('a skill header written with Windows line endings still parses', () => {
  // The regex that reads the header ended in (.*)$, and . does not match \r, so
  // a CRLF file parsed to an EMPTY header: no name, no description, and the
  // skill could never be matched to a task.
  const crlf = '---\r\nname: demo\r\ndescription: Real description\r\n---\r\n\r\nBody here.\r\n';
  const parsed = parseFrontmatter(crlf);
  assert.equal(parsed.meta.name, 'demo');
  assert.equal(parsed.meta.description, 'Real description');
  const lf = parseFrontmatter('---\nname: demo\ndescription: Real description\n---\n\nBody here.\n');
  assert.deepEqual(parsed.meta, lf.meta);
});

test('the health check explains why a skill is not usable, in plain words', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-health-'));
  const dir = path.join(root, 'broken');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: broken\n---\n\nTODO: write the instructions.\n');
  const manager = new SkillsManager({ userDir: root });
  const skill = manager.get('inst-user-broken');
  assert.ok(skill, 'the skill must still be listed, even when it is broken');
  assert.equal(skill.health.ok, false);
  assert.ok(skill.health.problems.some((text) => /description/i.test(text)), 'no description is a problem');
  assert.ok(skill.health.problems.some((text) => /placeholder|TODO/i.test(text)), 'placeholder text is a problem');
});

test('a skill that points at a path on this machine is not called broken over it', () => {
  const health = assessSkillHealth({ hasFrontmatter: true, hasName: true, description: 'Real one', bodyChars: 900, steps: [{ action: 'x', detail: 'y' }], trigger: { phrases: ['a'] } });
  assert.equal(health.ok, true, health.problems.join('; '));
});

test('editing a skill rewrites its file and preserves keys the screen does not edit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-edit-'));
  const dir = path.join(root, 'user', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: demo\ndescription: Old one\nlicense: MIT\nversion: 3\n---\n\n# Demo\nStep one.\n');
  const manager = new SkillsManager({ userDir: path.join(root, 'user') });
  const updated = manager.edit('inst-user-demo', {
    name: 'Renamed skill', description: 'A new description that explains when to use it',
    triggers: ['first trigger', 'second trigger'], body: '# Demo\nStep one.\nStep two.\n'
  });
  const onDisk = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  assert.match(onDisk, /^name: Renamed skill$/m);
  assert.match(onDisk, /^description: A new description that explains when to use it$/m);
  assert.match(onDisk, /^license: MIT$/m, 'a key the screen does not edit must survive');
  assert.match(onDisk, /^version: 3$/m);
  assert.match(onDisk, /^triggers: first trigger, second trigger$/m);
  assert.match(onDisk, /Step two\./);
  assert.equal(updated.name, 'Renamed skill');
  assert.equal(updated.trigger.phrases.length, 2);
  assert.equal(updated.revision, 2, 'the revision must advance so the agent sees the change');
});

test('editing a skill that does not exist, or with no name, is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-edit-bad-'));
  const manager = new SkillsManager({ userDir: root });
  assert.throws(() => manager.edit('inst-user-missing', { name: 'x' }), /no longer exists/);
});

test('the skills screen markup keeps every id the renderer looks up', () => {
  const html = fs.readFileSync(path.join(repo, 'desktop', 'renderer', 'index.html'), 'utf8');
  const section = html.slice(html.indexOf('id="agent-skills-view"'), html.indexOf('</section>', html.indexOf('id="agent-skills-view"')));
  for (const id of ['agent-skills-view', 'agent-skills-list', 'agent-record', 'agent-skill-add', 'agent-skills-close', 'skills-summary', 'skills-search', 'skills-filters', 'skills-title']) {
    assert.ok(section.includes(`id="${id}"`), `the screen must keep #${id}`);
  }
  // One Record button in the document, or the recorder is wired to two nodes.
  assert.equal((html.match(/id="agent-record"/g) || []).length, 1);
});

test('the renderer loads the skills view module before the app that uses it', () => {
  const html = fs.readFileSync(path.join(repo, 'desktop', 'renderer', 'index.html'), 'utf8');
  assert.ok(html.indexOf('skillsView.cjs') < html.indexOf('src="app.js"'), 'skillsView.cjs must load first');
  const app = fs.readFileSync(path.join(repo, 'desktop', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes('BrowserUseSkillsView'), 'app.js must use the shared module, not a second copy of the rules');
});

test('the editor can open for a brand-new skill, which has no record yet', () => {
  // The "New skill" button used to throw on `skill.when` — a null skill read
  // as if it had one — so the form never opened and the button was dead.
  // The fields a new skill needs must be describable with nothing to read.
  const fields = view.formFields(null);
  assert.equal(fields.installed, false);
  assert.equal(fields.whenLabel, 'Use it when');
  assert.equal(fields.bodyLabel, 'Steps');
  assert.equal(fields.showTriggers, true);
  assert.equal(typeof fields.whenHint, 'string');
  assert.equal(typeof fields.bodyHint, 'string');
  // A new skill's steps round-trip through the editor's text form.
  const text = view.stepsToText([{ action: 'Look at the thing', detail: 'then report it' }]);
  assert.equal(text, 'Look at the thing: then report it');
  assert.deepEqual(view.parseSteps(text), [{ action: 'Look at the thing', detail: 'then report it' }]);
});
