import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const { HarnessCompressor } = require('../desktop/agent/adaptiveTokenCompressor.cjs');
// DSH REWRITE: the system prompt is assembled by the harness from named
// ordered sections (desktop/agent/prompt/sections.cjs). Providers no longer
// author prompts, so the compression contract is tested against the
// assembled prompt itself.
const { assembleSystemPrompt } = require('../desktop/agent/desktopChatAgent.cjs');

function fakeAgentRun(controlMode = 'browser') {
  return {
    settings: { controlMode, effort: 'standard', effortMode: 'standard', approvalMode: 'unattended' },
    effortTier: 'standard',
    instructionsFileText: '',
    systemFileText: null
  };
}

// The rules are read FROM the prompt, not quoted beside it: a test that
// hard-codes a copy of the contract drifts from the contract and then proves
// nothing. The DSH prompt carries NAMED policy sections; each section's full
// text is one indivisible rule.
function contractRules(system) {
  const names = ['EVIDENCE - ', 'FAILURE - ', 'APPROVAL - ', 'TOOLS - ', 'COMPLETION - '];
  const rules = [];
  for (const name of names) {
    const start = system.indexOf(name);
    assert.ok(start > 0, 'the prompt must carry a ' + name.trim() + ' policy section');
    const next = names.map((n) => system.indexOf(n, start + 1)).filter(i => i > start);
    const end = next.length ? Math.min(...next) : system.length;
    rules.push(system.slice(start, end).trim());
  }
  return rules;
}

test('the contract is read from the prompt, and every policy section is found', () => {
  const rules = contractRules(assembleSystemPrompt(fakeAgentRun('agi'), null));
  assert.ok(rules.length >= 5, `expected five policy sections, found ${rules.length}`);
  for (const name of ['EVIDENCE', 'FAILURE', 'APPROVAL', 'TOOLS', 'COMPLETION']) {
    assert.ok(rules.some((rule) => rule.includes(name)), `the contract must carry the "${name}" principle`);
  }
});

test('compression never removes or rewrites a rule from the agent contract', async () => {
  const compressor = new HarnessCompressor({});
  const system = assembleSystemPrompt(fakeAgentRun('agi'), null);
  const rules = contractRules(system);
  const compressed = await compressor.compressSystem(system);
  for (const rule of rules) {
    assert.ok(compressed.text.includes(rule), `compression changed a rule:\n  was: ${rule.slice(0, 160)}\n  now missing from the output`);
  }
});

test('the directives that decide whether a task counts as done survive', async () => {
  const compressor = new HarnessCompressor({});
  const system = assembleSystemPrompt(fakeAgentRun('agi'), null);
  const compressed = await compressor.compressSystem(system);
  // The planning rule rides the update_plan SCHEMA (tool-owned guidance); the
  // done contract rides the prompt's completion section.
  const planningTool = (require('../desktop/agent/agentInternals.cjs').toolDefinitions('multi-part work', 'agi', { workspace: true }))
    .find((tool) => tool.name === 'update_plan');
  const schemaRules = [String(planningTool.description)];
  for (const directive of [
    'Call browser_done only when the WHOLE requested outcome is present and supported by evidence',
    '"verified: true" means confirming evidence for each requirement individually'
  ]) {
    assert.ok(system.includes(directive), `the prompt must carry "${directive.slice(0, 50)}…"`);
    assert.ok(compressed.text.includes(directive), `compression dropped the directive "${directive.slice(0, 50)}…"`);
  }
  for (const directive of schemaRules) {
    assert.ok(directive.includes('Follow the stated requirements; do not invent extra ones'), 'the planning rule rides the update_plan schema');
    assert.match(directive, /one item per requested outcome/i, 'one plan item per requested part');
  }
});

test('the harness system prompt keeps the rules that stop a task from being narrowed', async () => {
  // DSH: ONE system prompt exists — the harness assembly. The rule that
  // stopped the 2026-10-30 run from finishing one part of the request and
  // calling it done lives in the COMPLETION policy section and must survive
  // compression.
  const outer = assembleSystemPrompt(fakeAgentRun('agi'), null);
  assert.ok(outer, 'the harness must expose the assembled system prompt');
  const compressor = new HarnessCompressor({});
  const compressed = await compressor.compressSystem(outer);
  for (const directive of [
    'Call browser_done only when the WHOLE requested outcome is present and supported by evidence',
    'When one part finishes, continue with the next and never narrow the goal to the part you finished'
  ]) {
    assert.ok(outer.includes(directive), `the provider prompt must carry "${directive.slice(0, 50)}…"`);
    assert.ok(compressed.text.includes(directive), `compression dropped the directive "${directive.slice(0, 50)}…"`);
  }
});

test('compression reports what it saved', async () => {
  const compressor = new HarnessCompressor({});
  const compressed = await compressor.compressSystem(assembleSystemPrompt(fakeAgentRun('agi'), null));
  assert.equal(typeof compressed.savedChars, 'number');
  assert.equal(typeof compressed.savedTokens, 'number');
});

test('a prompt with a genuinely duplicated rule loses only the duplicate', async () => {
  const compressor = new HarnessCompressor({});
  const sentence = 'Never re-read unchanged page state after a mutation, because the newest observation already recorded it. ';
  const doubled = sentence.repeat(6);
  const compressed = await compressor.compressSystem(doubled);
  const occurrences = compressed.text.split('Never re-read unchanged page state').length - 1;
  assert.equal(occurrences, 1, 'the duplicate should be collapsed');
  assert.ok(compressed.savedChars > 0, 'the saving must be reported');
});
