// GEN9 — installed skill packages (desktop/agent/skillsManager.cjs).
// Covers: SKILL.md parsing, install from a local folder (user + repo scopes),
// list/enable/disable, remove, update, search finds installed skills by
// trigger + body tokens, merged skillsApi round-trip (search/run/feedback),
// registry install, and CROSS-SURFACE discoverability: a manager built the way
// the desktop app builds it reads a skill the CLI installed into the shared
// user scope (owner surface-parity directive).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  SkillsManager,
  createMergedSkillsApi,
  parseFrontmatter,
  parseSkillId,
  SKILL_FILE
} = require('../desktop/agent/skillsManager.cjs');
const { SkillStore } = require('../desktop/record/skills.cjs');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Builds a local skill folder on disk.
function makeSkillFolder(root, { name = 'Post the weekly update', triggers = 'weekly update, publish post', body = '1. Open the drafting page.\n2. Paste the update text.' } = {}) {
  const dir = path.join(root, slugOf(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, SKILL_FILE), [
    '---',
    `name: ${name}`,
    'description: Publish the weekly metrics post to the drafting page',
    `triggers: ${triggers}`,
    'apps: Chrome',
    'domains: facebook.com',
    '---',
    '',
    body
  ].join('\n'), 'utf8');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'helper.js'), '// helper\n', 'utf8');
  return dir;
}

function slugOf(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

test('parseFrontmatter splits keys and body, tolerates missing markers', () => {
  const parsed = parseFrontmatter('---\nname: My Skill\ntriggers: alpha, beta\n---\n\nBody line one.\n');
  assert.equal(parsed.meta.name, 'My Skill');
  assert.equal(parsed.meta.triggers, 'alpha, beta');
  assert.match(parsed.body, /Body line one/);
  const bare = parseFrontmatter('no markers here');
  assert.deepEqual(bare.meta, {});
  assert.match(bare.body, /no markers/);
});

test('install from a local folder into the user scope, list, scripts detected', async () => {
  const home = tmpDir('bu-skill-home-');
  const sourceRoot = tmpDir('bu-skill-src-');
  const folder = makeSkillFolder(sourceRoot);
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  const skill = await manager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  assert.equal(skill.id, 'inst-user-post-the-weekly-update');
  assert.equal(skill.name, 'Post the weekly update');
  assert.equal(skill.when, 'Publish the weekly metrics post to the drafting page');
  assert.equal(skill.enabled, true);
  assert.equal(skill.hasScripts, true);
  assert.equal(skill.trigger.domains.includes('facebook.com'), true);
  // Persisted on disk in the shared user scope.
  assert.equal(fs.existsSync(path.join(home, 'skills', 'post-the-weekly-update', SKILL_FILE)), true);
  assert.equal(fs.existsSync(path.join(home, 'skills', 'post-the-weekly-update', 'scripts', 'helper.js')), true);
  assert.equal(manager.list().length, 1);
  // .git noise is stripped on install.
  fs.mkdirSync(path.join(folder, '.git'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.git', 'HEAD'), 'ref: x\n', 'utf8');
  const again = await manager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  assert.equal(again.id, skill.id, 'same name reinstalls over the same slug');
  assert.equal(fs.existsSync(path.join(home, 'skills', 'post-the-weekly-update', '.git')), false);
});

test('install rejects folders without SKILL.md or without a name', async () => {
  const home = tmpDir('bu-skill-home2-');
  const empty = tmpDir('bu-skill-empty-');
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  await assert.rejects(() => manager.install({ source: { kind: 'local', path: empty } }), /no SKILL\.md found|not a skill folder/);
  const nameless = tmpDir('bu-skill-nameless-');
  fs.writeFileSync(path.join(nameless, SKILL_FILE), '---\ndescription: no name\n---\nbody', 'utf8');
  await assert.rejects(() => manager.install({ source: { kind: 'local', path: nameless } }), /must declare a name/);
});

test('repo scope wins on slug clash; enable/disable gates search; remove deletes', async () => {
  const home = tmpDir('bu-skill-home3-');
  const repo = tmpDir('bu-skill-repo3-');
  const src = tmpDir('bu-skill-src3-');
  const userFolder = makeSkillFolder(src, { name: 'Deploy widget', triggers: 'deploy', body: 'user-scope steps' });
  const repoFolder = makeSkillFolder(src, { name: 'Deploy widget', triggers: 'ship it', body: 'REPO-scope steps' });
  const manager = new SkillsManager({
    userDir: path.join(home, 'skills'),
    repoDir: path.join(repo, '.browser-use', 'skills')
  });
  await manager.install({ source: { kind: 'local', path: userFolder }, scope: 'user' });
  const repoSkill = await manager.install({ source: { kind: 'local', path: repoFolder }, scope: 'repo' });
  assert.equal(parseSkillId(repoSkill.id).scope, 'repo');
  const listed = manager.list();
  assert.equal(listed.length, 1, 'repo scope overrides the user slug');
  assert.equal(listed[0].steps[0].detail.includes('REPO-scope steps'), true);

  assert.equal(manager.disable(repoSkill.id).enabled, false);
  assert.equal(manager.search({ task: 'ship it' }).length, 0, 'disabled skills are not searched');
  assert.equal(manager.enable(repoSkill.id).enabled, true);
  assert.equal(manager.search({ task: 'ship it' }).length, 1);

  assert.equal(manager.remove(repoSkill.id), true);
  assert.equal(manager.list().length, 1, 'user scope resurfaces after the repo skill is removed');
  assert.equal(fs.existsSync(path.join(repo, '.browser-use', 'skills', 'deploy-widget')), false);
});

test('search finds installed skills by trigger phrase and body tokens', async () => {
  const home = tmpDir('bu-skill-home4-');
  const src = tmpDir('bu-skill-src4-');
  const folder = makeSkillFolder(src, {
    name: 'Post the weekly update',
    triggers: 'weekly update, publish post',
    body: 'Open the drafting page and paste the metrics table into the composer.'
  });
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  await manager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  const byPhrase = manager.search({ task: 'please publish the weekly update post now', limit: 3 });
  assert.equal(byPhrase.length, 1);
  assert.equal(byPhrase[0].skill.id, 'inst-user-post-the-weekly-update');
  assert.ok(byPhrase[0].score >= 1.5, 'trigger phrase boost applies');
  assert.equal(manager.search({ task: 'completely unrelated gardening query' }).length, 0);
  // Feedback raises the success-rate boost.
  manager.recordOutcome('inst-user-post-the-weekly-update', { success: true });
  const boosted = manager.search({ task: 'publish the weekly update post', limit: 3 });
  assert.equal(boosted.length, 1);
  assert.ok(boosted[0].score > byPhrase[0].score);
});

test('merged skillsApi: learned + installed both surface, run/feedback route correctly', async () => {
  const home = tmpDir('bu-skill-home5-');
  const src = tmpDir('bu-skill-src5-');
  const folder = makeSkillFolder(src, { name: 'Post the weekly update' });
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  await manager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  // A learned SkillStore skill with a DIFFERENT topic.
  const learned = new SkillStore(path.join(home, 'learned.json'));
  learned.add({ name: 'Water tomatoes', when: 'user asks to water garden tomatoes', steps: [{ action: 'Find the hose', detail: 'garden shed' }] }, {});

  const api = createMergedSkillsApi({ learnedStore: learned, manager });
  const results = api.search({ task: 'publish the weekly update', limit: 5 });
  assert.equal(results.length, 1);
  assert.equal(results[0].skill.id, 'inst-user-post-the-weekly-update');
  const garden = api.search({ task: 'water the garden tomatoes', limit: 5 });
  assert.equal(garden.length, 1);
  assert.equal(garden[0].store, 'learned');

  // run(): an installed id loads the package record; a learned id the store's.
  const installed = api.run('inst-user-post-the-weekly-update');
  assert.equal(installed.name, 'Post the weekly update');
  assert.match(installed.steps[0].detail, /drafting page/);
  const learnedSkill = api.run(garden[0].skill.id);
  assert.equal(learnedSkill.name, 'Water tomatoes');

  // feedback(): installed ids mutate the scope state file; learned ids the store.
  const updated = api.feedback('inst-user-post-the-weekly-update', { success: true, note: 'worked' });
  assert.equal(updated.usage.runs, 1);
  assert.equal(updated.usage.successes, 1);
  assert.deepEqual(updated.notes, ['worked']);
  const learnedUpdated = api.feedback(learned.skills[0].id, { success: true });
  assert.equal(learnedUpdated.usage.runs, 1);

  // digest() keeps the SkillStore shape the skill_run handler renders.
  const digest = api.digest(installed);
  assert.equal(digest.id, 'inst-user-post-the-weekly-update');
  assert.ok(Array.isArray(digest.steps) && digest.steps[0].includes('Follow the skill instructions'));
});

test('update re-installs from the recorded source and bumps the revision', async () => {
  const home = tmpDir('bu-skill-home6-');
  const src = tmpDir('bu-skill-src6-');
  const folder = makeSkillFolder(src, { name: 'Deploy widget', body: 'old steps' });
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  const skill = await manager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  assert.equal(manager.get(skill.id).steps[0].detail, 'old steps');
  fs.writeFileSync(path.join(folder, SKILL_FILE), '---\nname: Deploy widget\n---\nNEW steps', 'utf8');
  const updated = await manager.update(skill.id);
  assert.equal(updated.steps[0].detail, 'NEW steps');
  assert.equal(updated.revision, 2, 'revision bumped on update');
  assert.equal(updated.source.kind, 'local');
});

test('registry file install picks the named entry', async () => {
  const home = tmpDir('bu-skill-home7-');
  const src = tmpDir('bu-skill-src7-');
  const folder = makeSkillFolder(src, { name: 'Registry skill' });
  const registryFile = path.join(home, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ skills: [
    { name: 'missing', path: folder },
    { name: 'Registry skill', path: folder }
  ] }), 'utf8');
  const manager = new SkillsManager({ userDir: path.join(home, 'skills') });
  const skill = await manager.installFromRegistry({ registry: registryFile, name: 'registry skill', scope: 'user' });
  assert.equal(skill.id, 'inst-user-registry-skill');
  await assert.rejects(() => manager.installFromRegistry({ registry: registryFile, name: 'nope' }), /registry has no skill named/);
});

test('CROSS-SURFACE: a manager built the way the desktop builds it reads a CLI-installed skill (shared user scope)', async () => {
  const sharedHome = tmpDir('bu-skill-shared-');
  const src = tmpDir('bu-skill-src8-');
  const folder = makeSkillFolder(src, { name: 'Cross surface skill', triggers: 'parity check' });
  // CLI side: ~/.browser-use-cli/skills under the shared home.
  const cliManager = new SkillsManager({ userDir: path.join(sharedHome, '.browser-use-cli', 'skills') });
  await cliManager.install({ source: { kind: 'local', path: folder }, scope: 'user' });
  // Desktop side: the exact construction desktop/main.cjs uses (same userDir).
  const desktopManager = new SkillsManager({ userDir: path.join(sharedHome, '.browser-use-cli', 'skills') });
  const found = desktopManager.search({ task: 'run the parity check please', limit: 3 });
  assert.equal(found.length, 1, 'CLI-installed skill is discoverable from the desktop manager');
  assert.equal(found[0].skill.name, 'Cross surface skill');
  const desktopApi = createMergedSkillsApi({ manager: desktopManager });
  assert.equal(desktopApi.run('inst-user-cross-surface-skill').name, 'Cross surface skill');
});
