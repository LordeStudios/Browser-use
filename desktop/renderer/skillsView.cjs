(function (root) {
  'use strict';

  // The Skills screen's decisions, kept out of the DOM code so they can be
  // tested without a browser (this file is both a browser global and a Node
  // module, the same shape desktop/renderer/toolTarget.cjs uses).
  //
  // The screen answers one question per skill: can the agent find it and follow
  // it? Everything below serves that question. A skill is READY when the agent
  // can match it to a task and act on it, NEEDS ATTENTION when it cannot, and
  // PAUSED when the person turned it off.

  const READY = 'ready';
  const ATTENTION = 'attention';
  const PAUSED = 'paused';

  // Where a skill came from, in words a person would use.
  function skillOrigin(skill) {
    if (!skill || !skill.installed) return 'Learned from a recording';
    return ({ claude: 'Claude skill folder', repo: 'This repo', user: 'Installed' })[skill.scope] || 'Installed';
  }

  // The verdict for one skill. Installed skills carry their own health check
  // (from the agent's skill manager, which inspects the file on disk); learned
  // skills are checked here on the two things that make them usable: a
  // sentence saying when to use them, and at least one step.
  function skillHealth(skill) {
    if (!skill) return { ok: false, problems: ['This skill no longer exists.'], notes: [] };
    if (skill.installed) {
      const health = skill.health && typeof skill.health === 'object' ? skill.health : null;
      if (health) return { ok: Boolean(health.ok), problems: [...(health.problems || [])], notes: [...(health.notes || [])] };
      return { ok: true, problems: [], notes: [] };
    }
    const problems = [];
    if (!String(skill.when || '').trim()) problems.push('No sentence says when the agent should use this skill.');
    if (!Array.isArray(skill.steps) || !skill.steps.length) problems.push('It has no steps.');
    return { ok: problems.length === 0, problems, notes: [] };
  }

  function skillState(skill) {
    const health = skillHealth(skill);
    if (skill && skill.status === 'paused') return { key: PAUSED, label: 'Paused', health };
    if (!health.ok) return { key: ATTENTION, label: 'Needs attention', health };
    return { key: READY, label: 'Ready', health };
  }

  function skillDescription(skill) {
    if (!skill) return '';
    return skill.installed ? (skill.description || skill.when || '') : (skill.when || '');
  }

  // The one-line facts under a skill's name.
  function skillFacts(skill) {
    const facts = [skillOrigin(skill)];
    if (!skill) return facts;
    if (skill.installed) facts.push(`${Number(skill.bodyChars || 0).toLocaleString('en-US')} characters`);
    else facts.push(`${(skill.steps || []).length} ${(skill.steps || []).length === 1 ? 'step' : 'steps'}`);
    if (skill.usage && skill.usage.runs) facts.push(`worked ${skill.usage.successes} of ${skill.usage.runs} times`);
    return facts;
  }

  function matchesFilter(skill, filter) {
    if (filter === 'learned') return !skill.installed;
    if (filter === 'installed') return Boolean(skill.installed);
    if (filter === ATTENTION) return skillState(skill).key === ATTENTION;
    return true;
  }

  function matchesQuery(skill, query) {
    const text = String(query || '').trim().toLowerCase();
    if (!text) return true;
    return `${skill.name || ''} ${skillDescription(skill)}`.toLowerCase().includes(text);
  }

  function visibleSkills(skills, { filter = 'all', query = '' } = {}) {
    return (skills || []).filter((skill) => skill && matchesFilter(skill, filter) && matchesQuery(skill, query));
  }

  // Counts for the filter chips and the line under the title.
  function skillsSummary(skills) {
    const list = skills || [];
    const total = list.length;
    if (!total) return 'No skills yet';
    const attention = list.filter((skill) => skillState(skill).key === ATTENTION).length;
    const paused = list.filter((skill) => skillState(skill).key === PAUSED).length;
    const parts = [`${total} ${total === 1 ? 'skill' : 'skills'}`];
    if (attention) parts.push(`${attention} ${attention === 1 ? 'needs' : 'need'} attention`);
    if (paused) parts.push(`${paused} paused`);
    return parts.join(', ');
  }

  function filterCounts(skills, filters) {
    const list = skills || [];
    return (filters || []).map(([key, label]) => ({ key, label, count: list.filter((skill) => matchesFilter(skill, key)).length }));
  }

  // The editor's fields, split by skill kind. Installed skills edit their
  // SKILL.md (title, description, trigger phrases, instructions); learned
  // skills edit title, trigger sentence and steps.
  function formFields(skill) {
    const installed = Boolean(skill && skill.installed);
    return {
      installed,
      whenLabel: installed ? 'Description' : 'Use it when',
      whenHint: installed
        ? 'One or two sentences. The agent reads this to decide whether the skill fits a task.'
        : 'One sentence the agent matches against the task.',
      bodyLabel: installed ? 'Instructions' : 'Steps',
      bodyHint: installed
        ? 'Plain text or Markdown. This is the exact text the agent is given.'
        : 'Write one step per line. Use "action: detail" to add detail.',
      showTriggers: installed || !skill
    };
  }

  // "action: detail" per line, or the whole line as the action.
  function parseSteps(text) {
    return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const at = line.indexOf(': ');
      return at > 0 ? { action: line.slice(0, at).trim(), detail: line.slice(at + 2).trim() } : { action: line, detail: '' };
    });
  }

  function stepsToText(steps) {
    return (steps || []).map((step) => (step.detail ? `${step.action}: ${step.detail}` : step.action)).join('\n');
  }

  function parseTriggers(text) {
    return String(text || '').split(',').map((item) => item.trim()).filter(Boolean);
  }

  // What the editor refuses to save, in the words of the person editing.
  function validateSkillForm({ title, when, body, installed }) {
    if (!String(title || '').trim()) return 'Give the skill a title.';
    if (!String(body || '').trim()) return installed ? 'Write the instructions the agent should follow.' : 'Add at least one step.';
    if (!String(when || '').trim()) return installed ? 'Add a description so the agent can tell when to use this skill.' : 'Say when the agent should use this skill.';
    return null;
  }

  const api = {
    READY, ATTENTION, PAUSED,
    skillOrigin, skillHealth, skillState, skillDescription, skillFacts,
    matchesFilter, matchesQuery, visibleSkills, skillsSummary, filterCounts,
    formFields, parseSteps, stepsToText, parseTriggers, validateSkillForm
  };
  root.BrowserUseSkillsView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
