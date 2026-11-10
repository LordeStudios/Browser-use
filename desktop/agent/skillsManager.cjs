'use strict';

// GEN9 — Installed skill PACKAGES (desktop/skills_mcp_plan.md).
//
// The learned-skill store (desktop/record/skills.cjs) holds distilled
// demonstrations. This module adds the OTHER half of a real skills system:
// INSTALLABLE skill packages — a folder with SKILL.md (frontmatter + body) and
// optional scripts/ — installed from a git URL, a local folder, or a
// marketplace-style registry file, into two persistent scopes shared by BOTH
// surfaces (desktop app + CLI):
//   user scope:  ~/.browser-use-cli/skills/<slug>/SKILL.md
//   repo scope:  <repo>/.browser-use/skills/<slug>/SKILL.md
//
// Installed skills become FIRST-CLASS through createMergedSkillsApi(): the
// existing agent tools (skill_search / skill_run / skill_feedback in
// desktopChatAgent.cjs) find and load them with ZERO agent changes, because
// the merged API returns the exact record shape the learned SkillStore uses.
//
// Zero dependencies. Every failure degrades to "skill unavailable", never a
// failed run.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const SKILL_FILE = 'SKILL.md';
const STATE_FILE = '.skills-state.json';
// A skill body is INSTRUCTIONS, and an instruction cut mid-sentence is worse
// than none: with a 6,000 cap the frontend-design skill (9,074 chars) was served
// as a fragment ending in "Then rev", and its entire "Restraint and
// self-critique" and "More on writing" sections — the quality-check part —
// never reached the model, which then skipped the quality checks. The cap is
// now sized to the tool-result bound (20,000 bytes in providerTurnLedger) with
// headroom for the JSON envelope, and a body that STILL exceeds it is cut at a
// section boundary with an explicit notice instead of mid-word.
const BODY_CAP = 14000;
const NOTES_CAP = 5;
const MAX_NOTES_CHARS = 300;
const GIT_TIMEOUT_MS = 120000;
const GIT_DEPTH = 1;

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'then', 'from', 'into', 'when', 'user', 'agent', 'using', 'make', 'need', 'want', 'please']);

function tokensOf(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)));
}

function slugify(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
}

// Minimal frontmatter parser: "---" delimited block of `key: value` lines
// (values may be quoted). Lists are comma-separated strings. Never throws.
function parseFrontmatter(raw) {
  // Normalize Windows line endings first. The frontmatter regex below ends in
  // `(.*)$`, and `.` does not match "\r", so a CRLF file parsed to an EMPTY
  // header: browser-use-expressive-settings showed no description, could never
  // be matched to a task, and looked like an unnamed skill in the UI.
  const text = String(raw || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const head = text.slice(4, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const meta = {};
  for (const line of head.split('\n')) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    meta[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

// Is this a REAL skill, or a file that merely sits in the skills folder?
//
// A skill only helps if the agent can (a) find it for a task and (b) act on
// what it says. So the checks are about exactly those two things, and every
// finding is a plain sentence the Skills screen shows as-is:
//   - no frontmatter / no name: the header did not parse, so the skill has no
//     identity and the matcher has nothing to match on;
//   - no description: `when` is empty, so search can only match on body words;
//   - a body too short to be instructions;
//   - placeholder text (TODO / lorem ipsum) left in the body;
//   - a body that references a path that is not on this machine.
// `problems` block trust in the skill; `notes` are worth knowing but harmless.
function assessSkillHealth(skill, fsLike = fs) {
  const problems = [];
  const notes = [];
  const body = String(skill?.steps?.[0]?.detail || '');
  if (!skill?.hasFrontmatter) problems.push('The header block is missing or unreadable, so this skill has no name or description to match on.');
  else if (!skill?.hasName) problems.push('The header has no name field.');
  if (!String(skill?.description || '').trim()) problems.push('No description, so the agent can only find this skill by words in its body.');
  if (Number(skill?.bodyChars) < 200) problems.push(`The instructions are only ${Number(skill?.bodyChars) || 0} characters; that is too short to guide a task.`);
  if (/\b(?:TODO|TBD|FIXME|lorem ipsum)\b/i.test(body)) problems.push('The body still contains placeholder text (TODO, TBD or lorem ipsum).');
  const winPaths = [...new Set(body.match(/\b[A-Za-z]:[\\/][^\s`'")\]]{3,}/g) || [])].slice(0, 6);
  const missing = winPaths.filter((candidate) => { try { return !fsLike.existsSync(candidate.replace(/[.,;:]+$/, '')); } catch { return true; } });
  if (missing.length) notes.push(`Mentions ${missing.length === 1 ? 'a path' : `${missing.length} paths`} that ${missing.length === 1 ? 'does' : 'do'} not exist on this machine: ${missing.slice(0, 2).join(', ')}.`);
  if (Number(skill?.bodyChars) > BODY_CAP) notes.push(`The body is ${skill.bodyChars} characters; the agent is given the first ${BODY_CAP}, cut at a section heading.`);
  if (!Array.isArray(skill?.trigger?.phrases) || !skill.trigger.phrases.length) notes.push('No trigger phrases; it is matched on its description and body words.');
  return { ok: problems.length === 0, problems, notes };
}

// Cuts an over-long skill body at the last heading that fits, never mid-word,
// and says so. A model that is told the skill was shortened can ask for the
// rest; one handed a silent fragment follows it as if it were complete.
function capSkillBody(body) {
  const text = String(body || '');
  if (text.length <= BODY_CAP) return text;
  const head = text.slice(0, BODY_CAP);
  const lastHeading = head.lastIndexOf('\n## ');
  const cut = lastHeading > BODY_CAP * 0.5 ? head.slice(0, lastHeading) : head.slice(0, Math.max(head.lastIndexOf('\n\n'), 0) || BODY_CAP);
  return `${cut.trimEnd()}\n\n[Skill shortened: ${text.length - cut.length} of ${text.length} characters omitted at a section boundary. Read the full SKILL.md before skipping any step.]`;
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim()).filter(Boolean);
}

function skillId(scope, slug) {
  return `inst-${scope}-${slug}`;
}

function parseSkillId(id) {
  const match = String(id || '').match(/^inst-(user|repo)-([a-z0-9-]+)$/);
  return match ? { scope: match[1], slug: match[2] } : null;
}

function emptyState() {
  return { version: 1, disabled: [], usage: {}, installed: {} };
}

// Reads the scope's state file. A missing or corrupt state is an empty store —
// the SKILL.md folders remain the truth for what is installed.
function readState(scopeDir, fsLike) {
  try {
    const parsed = JSON.parse(fsLike.readFileSync(path.join(scopeDir, STATE_FILE), 'utf8'));
    return {
      version: 1,
      disabled: Array.isArray(parsed?.disabled) ? parsed.disabled.filter(item => typeof item === 'string') : [],
      usage: parsed?.usage && typeof parsed.usage === 'object' ? parsed.usage : {},
      installed: parsed?.installed && typeof parsed.installed === 'object' ? parsed.installed : {}
    };
  } catch {
    return emptyState();
  }
}

function writeState(scopeDir, state, fsLike) {
  try {
    fsLike.mkdirSync(scopeDir, { recursive: true });
    const tmp = path.join(scopeDir, `${STATE_FILE}.${crypto.randomUUID()}.tmp`);
    fsLike.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fsLike.renameSync(tmp, path.join(scopeDir, STATE_FILE));
    return true;
  } catch {
    return false; // state persistence is best-effort; installs still work
  }
}

// Lists a scope's skill folders (any folder carrying SKILL.md).
function scanScope(scopeDir, fsLike) {
  try {
    return fsLike.readdirSync(scopeDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name !== STATE_FILE && !entry.name.startsWith('.'))
      .map(entry => entry.name);
  } catch {
    return [];
  }
}

// Recursively copies a directory tree (skills are small; a bounded copy keeps
// the zero-dep promise without shelling out to robocopy/cp).
function copyTree(from, to, fsLike) {
  fsLike.mkdirSync(to, { recursive: true });
  for (const entry of fsLike.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target, fsLike);
    else if (entry.isFile() || entry.isSymbolicLink()) fsLike.copyFileSync(source, target);
  }
}

function rmtree(dir, fsLike) {
  try { fsLike.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function gitClone(url, target, { ref, execFileImpl, log } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['clone', '--depth', String(GIT_DEPTH)];
    if (ref) args.push('--branch', String(ref));
    args.push(String(url), target);
    execFileImpl('git', args, { timeout: GIT_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        log?.(`git clone failed: ${String(stderr || error.message).slice(0, 300)}`);
        reject(new Error(`git clone failed: ${String(stderr || error.message).trim().split('\n').pop() || 'unknown error'}`));
      } else resolve(target);
    });
  });
}

function execFileAsync(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error); else resolve(String(stdout || '').trim());
    });
  });
}

class SkillsManager {
  constructor({ userDir, repoDir = null, fs: fsLike = fs, execFileImpl = execFile, now = Date.now, log = null } = {}) {
    if (!userDir) throw new Error('skillsManager requires a userDir scope');
    this.userDir = userDir;
    this.repoDir = repoDir || null;
    this.fs = fsLike;
    this.execFileImpl = execFileImpl;
    this.now = now;
    this.log = log;
  }

  scopeDir(scope) {
    if (scope === 'repo') return this.repoDir;
    return this.userDir;
  }

  // ---- reading -----------------------------------------------------------

  // Loads one skill folder into a SkillStore-shaped record.
  readSkill(scope, slug, state) {
    const scopeDir = this.scopeDir(scope);
    if (!scopeDir) return null;
    const file = path.join(scopeDir, slug, SKILL_FILE);
    let raw;
    try { raw = this.fs.readFileSync(file, 'utf8'); } catch { return null; }
    const { meta, body } = parseFrontmatter(raw);
    const hasFrontmatter = Object.keys(meta).length > 0;
    const name = String(meta.name || slug).slice(0, 120);
    const description = String(meta.description || '').slice(0, 400);
    const usageRow = state.usage?.[skillId(scope, slug)] || {};
    const installedRow = state.installed?.[slug] || {};
    const skill = {
      id: skillId(scope, slug),
      slug,
      scope,
      dir: path.join(scopeDir, slug),
      name,
      when: description,
      description,
      triggers: splitList(meta.triggers),
      trigger: {
        phrases: splitList(meta.triggers).map(item => item.toLowerCase().slice(0, 80)).slice(0, 12),
        apps: splitList(meta.apps).map(item => item.slice(0, 60)).slice(0, 8),
        domains: splitList(meta.domains).map(item => item.toLowerCase().replace(/^www\./, '').slice(0, 100)).slice(0, 8)
      },
      version: String(meta.version || '').slice(0, 40),
      // The body IS the procedure: one step keeps the learned-store shape the
      // skill_run handler already renders (desktopChatAgent.cjs skill_run).
      steps: [{ action: 'Follow the skill instructions', detail: capSkillBody(body.trim()) }],
      bodyChars: body.trim().length,
      hasFrontmatter,
      hasName: Boolean(String(meta.name || '').trim()),
      file,
      hasScripts: (() => { try { return this.fs.statSync(path.join(scopeDir, slug, 'scripts')).isDirectory(); } catch { return false; } })(),
      source: installedRow.source && typeof installedRow.source === 'object'
        ? { kind: String(installedRow.source.kind || 'local'), path: String(installedRow.source.path || ''), url: String(installedRow.source.url || ''), ref: String(installedRow.source.ref || '') }
        : { kind: 'local', path: '', url: '', ref: '' },
      installedAt: Number(installedRow.installedAt) || 0,
      revision: Number(installedRow.revision) || 1,
      enabled: !state.disabled.includes(slug),
      usage: {
        runs: Number(usageRow.runs) || 0,
        successes: Number(usageRow.successes) || 0,
        lastUsedAt: usageRow.lastUsedAt || null
      },
      notes: (Array.isArray(usageRow.notes) ? usageRow.notes : []).slice(-NOTES_CAP)
    };
    skill.health = assessSkillHealth(skill, this.fs);
    return skill;
  }

  // All installed skills across scopes; repo scope wins on a slug clash
  // (the pinned repo's conventions outrank the user's global set).
  list() {
    const out = new Map();
    for (const scope of ['user', 'repo']) {
      const scopeDir = this.scopeDir(scope);
      if (!scopeDir) continue;
      const state = readState(scopeDir, this.fs);
      for (const slug of scanScope(scopeDir, this.fs)) {
        const skill = this.readSkill(scope, slug, state);
        if (skill) out.set(slug, skill); // later passes overwrite: repo > user
      }
    }
    return [...out.values()];
  }

  get(idOrSlug) {
    const parsed = parseSkillId(idOrSlug);
    const wanted = parsed ? parsed.slug : String(idOrSlug || '').toLowerCase();
    const wantedScope = parsed ? parsed.scope : null;
    const all = this.list();
    if (wantedScope) return all.find(skill => skill.scope === wantedScope && skill.slug === wanted) || null;
    return all.find(skill => skill.slug === wanted) || all.find(skill => skill.id === String(idOrSlug)) || null;
  }

  // ---- state mutations ----------------------------------------------------

  mutateState(scope, mutator) {
    const scopeDir = this.scopeDir(scope);
    if (!scopeDir) return null;
    const state = readState(scopeDir, this.fs);
    mutator(state);
    writeState(scopeDir, state, this.fs);
    return state;
  }

  enable(idOrSlug) {
    const skill = this.get(idOrSlug);
    if (!skill) return null;
    this.mutateState(skill.scope, state => { state.disabled = state.disabled.filter(item => item !== skill.slug); });
    return this.get(skill.id);
  }

  disable(idOrSlug) {
    const skill = this.get(idOrSlug);
    if (!skill) return null;
    this.mutateState(skill.scope, state => {
      if (!state.disabled.includes(skill.slug)) state.disabled.push(skill.slug);
    });
    return this.get(skill.id);
  }

  remove(idOrSlug) {
    const skill = this.get(idOrSlug);
    if (!skill) return false;
    rmtree(skill.dir, this.fs);
    this.mutateState(skill.scope, state => {
      delete state.installed[skill.slug];
      delete state.usage[skill.id];
      state.disabled = state.disabled.filter(item => item !== skill.slug);
    });
    return true;
  }

  // Edits a skill from the Skills screen. The SKILL.md file stays the single
  // source of truth: the header is rewritten from the edited fields and the
  // body is replaced, preserving any frontmatter key the screen does not edit
  // (license, version, apps, domains, ...). Returns the re-read record.
  edit(idOrSlug, { name, description, triggers, body } = {}) {
    const skill = this.get(idOrSlug);
    if (!skill) throw new Error('That skill no longer exists.');
    const file = path.join(skill.dir, SKILL_FILE);
    const original = String(this.fs.readFileSync(file, 'utf8')).replace(/\r\n?/g, '\n');
    const parsed = parseFrontmatter(original);
    const nextName = String(name ?? skill.name).trim();
    if (!nextName) throw new Error('A skill needs a name.');
    if (/[\r\n]/.test(nextName)) throw new Error('The name must be a single line.');
    // Keep the original key order and casing for keys the screen does not edit.
    const order = [];
    if (original.startsWith('---')) {
      const close = original.indexOf('\n---', 3);
      for (const line of original.slice(4, close > 0 ? close : 4).split('\n')) {
        const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:/);
        if (m) order.push(m[1]);
      }
    }
    const meta = { ...parsed.meta };
    const set = (key, value) => {
      if (!order.some((k) => k.toLowerCase() === key)) order.push(key);
      meta[key] = String(value).replace(/[\r\n]+/g, ' ').trim();
    };
    set('name', nextName);
    if (description !== undefined) set('description', description);
    if (triggers !== undefined) set('triggers', Array.isArray(triggers) ? triggers.join(', ') : triggers);
    const head = order
      .filter((k) => meta[k.toLowerCase()] !== undefined && String(meta[k.toLowerCase()]) !== '')
      .map((k) => `${k}: ${meta[k.toLowerCase()]}`)
      .join('\n');
    const nextBody = (body === undefined ? parsed.body : String(body).replace(/\r\n?/g, '\n')).replace(/^\n+/, '').trimEnd();
    const tmp = `${file}.${crypto.randomUUID().slice(0, 6)}.tmp`;
    this.fs.writeFileSync(tmp, `---\n${head}\n---\n\n${nextBody}\n`, 'utf8');
    this.fs.renameSync(tmp, file);
    this.mutateState(skill.scope, (state) => {
      const row = state.installed[skill.slug] || (state.installed[skill.slug] = { source: { kind: 'local', path: '', url: '', ref: '' }, installedAt: this.now() });
      row.updatedAt = this.now();
      row.revision = (Number(row.revision) || 1) + 1;
    });
    return this.get(skill.id);
  }

  // Re-install from the recorded source (git url / local path), bumping the
  // revision. Usage state survives (usage is keyed by id, not rewritten).
  async update(idOrSlug) {
    const skill = this.get(idOrSlug);
    if (!skill) return null;
    const source = skill.source;
    const staged = source.kind === 'git'
      ? await stageFromGit({ url: source.url, ref: source.ref, fs: this.fs, execFileImpl: this.execFileImpl, log: this.log })
      : { dir: source.path, cleanup: () => {} };
    try {
      const outcome = this.stageIntoScope(skill.scope, staged.dir, { source, existingSlug: skill.slug });
      // stageIntoScope already bumps the revision (previous + 1); usage state
      // survives because it is keyed by id, not rewritten.
      return outcome || this.get(skill.id);
    } finally {
      staged.cleanup();
    }
  }

  // ---- installing ----------------------------------------------------------

  // Copies a staged skill source dir into the scope. Returns the record.
  stageIntoScope(scope, sourceDir, { source = { kind: 'local', path: sourceDir, url: '', ref: '' }, existingSlug = null } = {}) {
    const scopeDir = this.scopeDir(scope);
    if (!scopeDir) throw new Error(`scope "${scope}" is not available (no repo pinned)`);
    let meta = {};
    let body = '';
    try {
      const parsed = parseFrontmatter(this.fs.readFileSync(path.join(sourceDir, SKILL_FILE), 'utf8'));
      meta = parsed.meta; body = parsed.body;
    } catch (error) {
      throw new Error(`not a skill folder (missing or unreadable ${SKILL_FILE}): ${error.message}`);
    }
    const name = String(meta.name || '').trim();
    if (!name) throw new Error(`${SKILL_FILE} frontmatter must declare a name`);
    const slug = existingSlug || slugify(name);
    const target = path.join(scopeDir, slug);
    // Stage to a temp name first so a failed copy never leaves a half skill.
    const staging = path.join(scopeDir, `.${slug}.${crypto.randomUUID().slice(0, 6)}.staging`);
    try {
      copyTree(sourceDir, staging, this.fs);
      // Drop source-control noise — the scope keeps skills, not repos.
      rmtree(path.join(staging, '.git'), this.fs);
      rmtree(path.join(staging, 'node_modules'), this.fs);
      rmtree(target, this.fs);
      this.fs.renameSync(staging, target);
    } catch (error) {
      rmtree(staging, this.fs);
      throw error;
    }
    this.mutateState(scope, state => {
      const previous = state.installed[slug];
      state.installed[slug] = {
        source: { kind: String(source.kind || 'local'), path: String(source.path || ''), url: String(source.url || ''), ref: String(source.ref || '') },
        installedAt: previous?.installedAt || this.now(),
        updatedAt: this.now(),
        revision: (Number(previous?.revision) || 0) + 1
      };
      state.disabled = state.disabled.filter(item => item !== slug);
    });
    const state = readState(scopeDir, this.fs);
    return this.readSkill(scope, slug, state);
  }

  // install({ source }) — source kinds:
  //   { kind: 'local', path }                       copy a local folder
  //   { kind: 'git', url, ref?, subdir? }           clone + copy (needs git on PATH)
  //   { kind: 'registry', registry: <path|url>, name }  marketplace entry lookup
  async install({ source, scope = 'user' } = {}) {
    if (!source || typeof source !== 'object') throw new Error('install requires { source }');
    let kind = source.kind;
    if (!kind) {
      kind = /^https?:\/\//i.test(String(source.path || source.url || ''))
        ? (String(source.name) ? 'registry' : 'git')
        : 'local';
    }
    if (kind === 'registry') return this.installFromRegistry({ registry: source.registry || source.path || source.url, name: source.name, scope });
    let staged;
    if (kind === 'git') {
      staged = await stageFromGit({ url: source.url || source.path, ref: source.ref, fs: this.fs, execFileImpl: this.execFileImpl, log: this.log });
    } else {
      const dir = path.resolve(String(source.path || ''));
      let stat = null;
      try { stat = this.fs.statSync(dir); } catch { /* reported below */ }
      if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${dir}`);
      staged = { dir, cleanup: () => {} };
    }
    try {
      const skillRoot = staged.dir && this.fs.existsSync(path.join(staged.dir, SKILL_FILE))
        ? staged.dir
        : findNestedSkillRoot(staged.dir, this.fs);
      if (!skillRoot) throw new Error(`no ${SKILL_FILE} found at the source root or one level deep`);
      const sourceMeta = kind === 'git'
        ? { kind: 'git', path: '', url: String(source.url || source.path || ''), ref: String(source.ref || '') }
        : { kind: 'local', path: skillRoot, url: '', ref: '' };
      return this.stageIntoScope(scope, skillRoot, { source: sourceMeta });
    } finally {
      staged.cleanup();
    }
  }

  async installFromRegistry({ registry, name, scope = 'user' } = {}) {
    if (!name) throw new Error('registry install requires a skill name');
    let raw;
    if (/^https?:\/\//i.test(String(registry))) {
      raw = await (await fetch(String(registry))).text();
    } else {
      try { raw = this.fs.readFileSync(path.resolve(String(registry)), 'utf8'); } catch (error) {
        throw new Error(`registry file unreadable: ${error.message}`);
      }
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (error) { throw new Error(`registry is not valid JSON: ${error.message}`); }
    const entries = Array.isArray(parsed?.skills) ? parsed.skills : Array.isArray(parsed) ? parsed : [];
    const entry = entries.find(item => item && String(item.name).toLowerCase() === String(name).toLowerCase());
    if (!entry) throw new Error(`registry has no skill named "${name}" (has ${entries.length} entries)`);
    const kind = entry.url ? 'git' : 'local';
    return this.install({ source: { kind, url: entry.url, ref: entry.ref, path: entry.path }, scope });
  }

  // ---- search / feedback (SkillStore-compatible semantics) ------------------

  // Same scoring family as desktop/record/skills.cjs so merged rankings are
  // comparable: token overlap / sqrt(query size), trigger phrase +1.5,
  // domain +1.2, app +0.6, success rate +0.8.
  search({ task = '', domains = [], apps = [], limit = 3 } = {}) {
    const query = tokensOf(task);
    const domainSet = new Set((domains || []).map(domain => String(domain).toLowerCase().replace(/^www\./, '')));
    const appSet = new Set((apps || []).map(app => String(app).toLowerCase()));
    const scored = [];
    for (const skill of this.list()) {
      if (!skill.enabled) continue;
      const skillTokens = tokensOf(`${skill.name} ${skill.when} ${skill.steps.map(step => step.detail).join(' ')}`);
      let score = 0;
      for (const token of query) if (skillTokens.has(token)) score += 1;
      if (query.size) score = score / Math.sqrt(query.size);
      for (const phrase of skill.trigger.phrases) {
        if (String(task || '').toLowerCase().includes(phrase)) score += 1.5;
      }
      for (const domain of skill.trigger.domains) if (domainSet.has(domain)) score += 1.2;
      for (const app of skill.trigger.apps) if (appSet.has(app.toLowerCase())) score += 0.6;
      if (skill.usage.runs > 0) score += 0.8 * (skill.usage.successes / skill.usage.runs);
      if (score >= 0.75) scored.push({ skill, score: Math.round(score * 100) / 100 });
    }
    scored.sort((left, right) => right.score - left.score);
    return scored.slice(0, Math.max(1, Math.min(5, limit)));
  }

  recordOutcome(idOrSlug, { success = false, note = null } = {}) {
    const skill = this.get(idOrSlug);
    if (!skill) return null;
    this.mutateState(skill.scope, state => {
      const row = state.usage[skill.id] || (state.usage[skill.id] = { runs: 0, successes: 0, lastUsedAt: null, notes: [] });
      row.runs += 1;
      if (success) row.successes += 1;
      row.lastUsedAt = this.now();
      if (note) row.notes = [...(row.notes || []), String(note).slice(0, MAX_NOTES_CHARS)].slice(-NOTES_CAP);
    });
    return this.get(skill.id);
  }

  // SkillStore digest shape (desktop/record/skills.cjs digest()).
  digest(entry) {
    const skill = entry?.skill || entry;
    return {
      id: skill.id,
      name: skill.name,
      when: skill.when,
      steps: skill.steps.map(step => step.detail ? `${step.action} — ${step.detail}` : step.action),
      successRate: skill.usage.runs ? Math.round(100 * skill.usage.successes / skill.usage.runs) : null,
      notes: skill.notes
    };
  }
}

// Finds a nested skill root exactly one level deep (git repos often wrap the
// skill in a folder, or the repo root may BE the skill one level down).
function findNestedSkillRoot(dir, fsLike) {
  try {
    for (const entry of fsLike.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const nested = path.join(dir, entry.name);
      if (fsLike.existsSync(path.join(nested, SKILL_FILE))) return nested;
      for (const inner of fsLike.readdirSync(nested, { withFileTypes: true })) {
        if (!inner.isDirectory()) continue;
        const deeper = path.join(nested, inner.name);
        if (fsLike.existsSync(path.join(deeper, SKILL_FILE))) return deeper;
      }
    }
  } catch { /* fallthrough */ }
  return null;
}

function stageFromGit({ url, ref, fs: fsLike, execFileImpl, log }) {
  if (!url) throw new Error('git install requires a url');
  const tmp = path.join(fsLike.mkdtempSync(path.join(require('node:os').tmpdir(), 'buse-skill-')));
  return gitClone(url, tmp, { ref, execFileImpl, log }).then(() => ({ dir: tmp, cleanup: () => rmtree(tmp, fsLike) }));
}

// The ONE adapter both surfaces pass to DesktopChatAgent (constructor
// `skillsApi`). Learned skills keep priority on id collisions; search merges
// both stores and sorts by score.
function createMergedSkillsApi({ learnedStore = null, manager = null } = {}) {
  const learnedSearch = (input) => {
    try { return learnedStore?.search?.(input) || []; } catch { return []; }
  };
  return {
    search(input = {}) {
      const learned = learnedSearch(input).map(entry => ({ skill: entry.skill, score: entry.score, store: 'learned' }));
      const installed = manager ? manager.search(input).map(entry => ({ ...entry, store: 'installed' })) : [];
      const seen = new Set();
      return [...learned, ...installed]
        .filter(entry => {
          if (!entry.skill?.id || seen.has(entry.skill.id)) return false;
          seen.add(entry.skill.id);
          return true;
        })
        .sort((left, right) => right.score - left.score)
        .slice(0, Math.max(1, Math.min(5, input.limit || 3)));
    },
    run(skillId) {
      const parsed = parseSkillId(skillId);
      if (parsed || !learnedStore?.get?.(skillId)) {
        return manager?.get(skillId) || learnedStore?.get?.(skillId) || null;
      }
      return learnedStore.get(skillId);
    },
    feedback(skillId, outcome) {
      const parsed = parseSkillId(skillId);
      if (parsed && manager) return manager.recordOutcome(skillId, outcome);
      if (learnedStore?.recordOutcome) return learnedStore.recordOutcome(skillId, outcome) || (manager ? manager.get(skillId) : null);
      return manager ? manager.recordOutcome(skillId, outcome) : null;
    },
    digest(entry) {
      const skill = entry?.skill || entry;
      if (manager && parseSkillId(skill?.id)) return manager.digest(skill);
      if (learnedStore?.digest) return learnedStore.digest(entry);
      if (manager) return manager.digest(skill);
      return null;
    }
  };
}

module.exports = {
  SkillsManager,
  createMergedSkillsApi,
  parseFrontmatter,
  parseSkillId,
  slugify,
  tokensOf,
  assessSkillHealth,
  SKILL_FILE,
  STATE_FILE,
  BODY_CAP
};
