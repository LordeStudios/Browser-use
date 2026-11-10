import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const repo = path.resolve(import.meta.dirname, '..');
const { HarnessCompressor } = require('../desktop/agent/adaptiveTokenCompressor.cjs');
const { agiPromptForTask } = require('../desktop/computer/computerCatalog.cjs');

// The compressor runs over the WHOLE system prompt, and the system prompt
// carries the agent's behavioral contract. If the compressor eats a rule, the
// agent silently stops obeying it — which is exactly the failure this work set
// out to fix ("the harness skipped my instructions"). So the contract must
// survive compression intact, and that is asserted here rather than assumed.
//
// The rules are taken FROM the prompt, not quoted beside it: a test that
// hard-codes a copy of the contract drifts from the contract and then proves
// nothing.
function contractRules(system) {
  const start = system.indexOf('Principles:');
  assert.ok(start > 0, 'the prompt must carry a Principles block');
  const block = system.slice(start);
  // Split on the numbered-item boundary. A regex over the whole block lets a
  // greedy match swallow the next item's number, which hides a principle.
  return block
    .split(/\n(?=\d\. )/)
    .map((part) => part.trim())
    .filter((part) => /^\d\. /.test(part));
}

test('the contract is read from the prompt, and every principle is found', () => {
  const rules = contractRules(agiPromptForTask('do the thing'));
  assert.ok(rules.length >= 6, `expected six principles, found ${rules.length}`);
  for (const name of ['Outcome', 'Evidence', 'Batch independent calls', 'Failure', 'Finish', 'Blocked']) {
    assert.ok(rules.some((rule) => rule.includes(name)), `the contract must carry the "${name}" principle`);
  }
});

test('compression never removes or rewrites a rule from the agent contract', async () => {
  const compressor = new HarnessCompressor({});
  const system = agiPromptForTask('do the thing');
  const rules = contractRules(system);
  const compressed = await compressor.compressSystem(system);
  for (const rule of rules) {
    assert.ok(compressed.text.includes(rule), `compression changed a rule:\n  was: ${rule.slice(0, 160)}\n  now missing from the output`);
  }
});

test('the directives that decide whether a task counts as done survive', async () => {
  const compressor = new HarnessCompressor({});
  const system = agiPromptForTask('do the thing');
  const compressed = await compressor.compressSystem(system);
  for (const directive of [
    'Follow requirements literally, including untested edge cases',
    'browser_done only when every plan item is done or skipped with a reason, nothing spawned outstanding',
    'verified:true means confirming evidence for EACH requirement individually, never a general impression'
  ]) {
    assert.ok(system.includes(directive), `the prompt must carry "${directive.slice(0, 50)}…"`);
    assert.ok(compressed.text.includes(directive), `compression dropped the directive "${directive.slice(0, 50)}…"`);
  }
});

test('the outer provider prompt keeps the rules that stop a task from being narrowed', async () => {
  // The provider sends TWO prompts: its own instruction block, then the AGI
  // playbook. Both are compressed. The outer block carries the rule that
  // stopped the 2026-10-30 run from finishing one part of the request and
  // calling it done, so it must survive too.
  const provider = require('../desktop/agent/openAiCompatibleProvider.cjs');
  const outer = provider.providerSystemPrompt ? provider.providerSystemPrompt() : null;
  assert.ok(outer, 'the provider must expose the system prompt it sends');
  const compressor = new HarnessCompressor({});
  const compressed = await compressor.compressSystem(outer);
  for (const directive of [
    'browser_done only when the whole requested outcome is present and supported by evidence',
    'never narrow the goal to the part you finished or end while your own summary lists remaining work',
    'With an active plan or multi-part goal, finishing one part means continue with the next part',
    'Keep reasoning and user-facing text short.'
  ]) {
    assert.ok(outer.includes(directive), `the provider prompt must carry "${directive.slice(0, 50)}…"`);
    assert.ok(compressed.text.includes(directive), `compression dropped the directive "${directive.slice(0, 50)}…"`);
  }
});

test('compression reports what it saved', async () => {
  const compressor = new HarnessCompressor({});
  const compressed = await compressor.compressSystem(agiPromptForTask('do the thing'));
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
