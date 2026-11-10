'use strict';

// Persistent Skill Brain storage and retrieval.
//
// skills.json is deliberately boring: a plain, human-editable JSON file in the
// app's userData directory. No database, no embeddings, no daemon. Each skill
// is the distilled, reusable form of ONE approved demonstration:
//
// {
//   "id": "skl-...",
//   "name": "Post the weekly update",
//   "when": "user asks to publish the weekly update post",
//   "steps": [
//     { "action": "Open the drafting page", "detail": "facebook.com/… → Create Post" },
//     { "action": "Fill the composer", "detail": "paste the update text" }
//   ],
//   "trigger": { "phrases": ["weekly update", "publish post"], "apps": ["Chrome"], "domains": ["facebook.com"] },
//   "usage": { "runs": 0, "successes": 0, "lastUsedAt": null },
//   "notes": ["post must include the metrics table"],
//   "source": { "sessionId": "rec-...", "recordedAt": 1726… },
//   "status": "active",
//   "createdAt": …, "updatedAt": …, "revision": 3
// }
//
// Matching is token overlap + trigger phrases + domain/app boosts — cheap,
// deterministic, provider-agnostic, and trivially debuggable by a human.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const MAX_SKILLS = 500;
const MAX_NOTES = 5;

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'then', 'from', 'into', 'when', 'user', 'agent', 'using', 'make', 'need', 'want', 'please']);

function tokensOf(text) {
  return new Set(String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2 && !STOP_WORDS.has(token)));
}

function safeId(prefix) {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeSkill(input) {
  const skill = input && typeof input === 'object' ? input : {};
  const steps = (Array.isArray(skill.steps) ? skill.steps : [])
    .map(step => typeof step === 'string'
      ? { action: String(step).slice(0, 200), detail: '' }
      : { action: String(step?.action || step?.detail || '').slice(0, 200), detail: String(step?.detail || '').slice(0, 400) })
    .filter(step => step.action)
    .slice(0, 40);
  const trigger = skill.trigger && typeof skill.trigger === 'object' ? skill.trigger : {};
  return {
    id: String(skill.id || safeId('skl')),
    name: String(skill.name || 'Unnamed skill').slice(0, 120),
    when: String(skill.when || skill.triggerText || '').slice(0, 400),
    steps,
    trigger: {
      phrases: (Array.isArray(trigger.phrases) ? trigger.phrases : []).map(item => String(item).toLowerCase().slice(0, 80)).filter(Boolean).slice(0, 12),
      apps: (Array.isArray(trigger.apps) ? trigger.apps : []).map(item => String(item).slice(0, 60)).filter(Boolean).slice(0, 8),
      domains: (Array.isArray(trigger.domains) ? trigger.domains : []).map(item => String(item).toLowerCase().replace(/^www\./, '').slice(0, 100)).filter(Boolean).slice(0, 8)
    },
    usage: {
      runs: Number(skill.usage?.runs) || 0,
      successes: Number(skill.usage?.successes) || 0,
      lastUsedAt: skill.usage?.lastUsedAt || null
    },
    notes: (Array.isArray(skill.notes) ? skill.notes : []).map(note => String(note).slice(0, 300)).filter(Boolean).slice(-MAX_NOTES),
    source: skill.source && typeof skill.source === 'object' ? {
      sessionId: String(skill.source.sessionId || '').slice(0, 60),
      recordedAt: Number(skill.source.recordedAt) || 0
    } : { sessionId: '', recordedAt: 0 },
    status: skill.status === 'paused' ? 'paused' : 'active',
    createdAt: Number(skill.createdAt) || Date.now(),
    updatedAt: Number(skill.updatedAt) || Date.now(),
    revision: Number(skill.revision) || 1
  };
}

class SkillStore {
  constructor(filePath) {
    this.filePath = String(filePath || '');
    this.skills = [];
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const list = Array.isArray(raw?.skills) ? raw.skills : Array.isArray(raw) ? raw : [];
      this.skills = list.slice(0, MAX_SKILLS).map(normalizeSkill);
    } catch {
      // Missing or hand-mangled file: start empty rather than overwrite the
      // user's edit with an empty list on save.
      try { if (fs.existsSync(this.filePath)) this.corrupt = true; } catch {}
      this.skills = this.skills || [];
    }
    return this.skills;
  }

  save() {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true });
    const payload = { version: SCHEMA_VERSION, updatedAt: new Date().toISOString(), skills: this.skills };
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(temporary, this.filePath);
    return this.skills;
  }

  list({ includePaused = true } = {}) {
    return this.skills.filter(skill => includePaused || skill.status === 'active');
  }

  get(skillId) {
    return this.skills.find(skill => skill.id === String(skillId || '')) || null;
  }

  add(skillDraft, source = {}) {
    const created = normalizeSkill({
      ...skillDraft,
      id: safeId('skl'),
      source: { sessionId: String(source.sessionId || ''), recordedAt: Number(source.recordedAt) || Date.now() },
      createdAt: Date.now(), updatedAt: Date.now(), revision: 1
    });
    this.skills.push(created);
    if (this.skills.length > MAX_SKILLS) this.skills = this.skills.slice(-MAX_SKILLS);
    this.save();
    return created;
  }

  update(skillId, patch) {
    const index = this.skills.findIndex(skill => skill.id === String(skillId || ''));
    if (index < 0) return null;
    const current = this.skills[index];
    const next = normalizeSkill({
      ...current,
      ...(patch && typeof patch === 'object' ? patch : {}),
      id: current.id,
      usage: { ...current.usage, ...(patch?.usage || {}) },
      source: current.source,
      createdAt: current.createdAt,
      updatedAt: Date.now(),
      revision: current.revision + 1
    });
    this.skills[index] = next;
    this.save();
    return next;
  }

  remove(skillId) {
    const before = this.skills.length;
    this.skills = this.skills.filter(skill => skill.id !== String(skillId || ''));
    const removed = this.skills.length !== before;
    if (removed) this.save();
    return removed;
  }

  recordOutcome(skillId, { success = false, note = null } = {}) {
    const skill = this.get(skillId);
    if (!skill) return null;
    skill.usage.runs += 1;
    if (success) skill.usage.successes += 1;
    skill.usage.lastUsedAt = Date.now();
    if (note) {
      skill.notes = [...skill.notes, String(note).slice(0, 300)].slice(-MAX_NOTES);
    }
    return this.update(skillId, {});
  }

  // Rank skills for the current task + context. Cheap, deterministic, and
  // explainable: token overlap on name/when/steps, boosted by declared trigger
  // phrases, domains and apps, and by the demonstrated success rate.
  search({ task = '', domains = [], apps = [], limit = 3 } = {}) {
    const query = tokensOf(task);
    const domainSet = new Set(domains.map(domain => String(domain).toLowerCase().replace(/^www\./, '')));
    const appSet = new Set(apps.map(app => String(app).toLowerCase()));
    const scored = [];
    for (const skill of this.skills) {
      if (skill.status !== 'active' || !skill.steps.length) continue;
      const skillTokens = tokensOf(`${skill.name} ${skill.when} ${skill.steps.map(step => `${step.action} ${step.detail}`).join(' ')}`);
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

  // Bounded digests for prompt injection — context efficiency is the point.
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

module.exports = { SkillStore, normalizeSkill, tokensOf };
