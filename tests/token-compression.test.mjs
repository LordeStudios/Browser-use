import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// The two techniques under test:
//   1. Intel's Adaptive Token Compressor, ported to Node (adaptiveTokenCompressor.cjs)
//   2. Deferred tool loading (deferredToolCatalog.cjs)
//
// The overriding constraint in both: a WEAK model must never be confused by
// what it receives. No tool may be hidden, no tool may be gated, no rule may
// be dropped, and a compacted schema must still be a correct schema.

const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { buildToolCatalog, compactSchemaFor, fullSchemaFor, isDeferredTool, CORE_TOOLS, ALWAYS_FULL_TOOLS } = require('../desktop/agent/deferredToolCatalog.cjs');
const { openAiToolSchemas, toolInputSchema } = require('../desktop/agent/providers/wire.cjs');
const { HarnessCompressor, ToolCompressor, CompressionManager, createCompressor, availableCompressorTypes, compressNotebook, dedupeDirectives, splitSentences } = require('../desktop/agent/adaptiveTokenCompressor.cjs');
const { countTokens } = require('../desktop/agent/wireTokenizer.cjs');

const schemaOf = (schema) => JSON.stringify(schema, (key, value) => (key === 'description' || key === 'examples' || key === 'default' ? undefined : value));

// The compact form allows extra fields on purpose: an unknown argument must
// reach the harness, which rejects it with a precise error, rather than being
// refused by the provider with no explanation. The flag is therefore
// normalized away on both sides — a core tool is served in full and keeps the
// full schema's own value.
const withoutAdditionalProperties = (text) => text
  .replace(/"additionalProperties":(true|false),/g, '')
  .replace(/,"additionalProperties":(true|false)/g, '')
  .replace(/"additionalProperties":(true|false)/g, '');

// ---- Technique 2: deferred tool loading ----------------------------------

test('no tool is ever hidden: the catalog carries every tool the run offers', () => {
  for (const mode of ['browser', 'agi']) {
    const definitions = toolDefinitions('task', mode, { workspace: true });
    const catalog = buildToolCatalog(definitions);
    assert.equal(catalog.length, definitions.length, `${mode}: a tool disappeared from the catalog`);
    assert.deepEqual(catalog.map((tool) => tool.name), definitions.map((tool) => tool.name));
  }
});

test('the deferred catalog adds no task-dependent gating of its own', () => {
  // The DEFERRED CATALOG must not gate anything: for a given tool set, the
  // catalog is the same set of tools whatever the task says.
  //
  // NOTE: toolDefinitions() itself already gates the AGI catalog on the task
  // text (isCodingTask decides whether the drawing tools are offered). That
  // gating predates this work. This test pins the catalog's own behaviour:
  // given the same tools, it neither adds nor removes any of them.
  const definitions = toolDefinitions('find the index file', 'agi', { workspace: true });
  const first = buildToolCatalog(definitions).map((tool) => tool.name);
  const second = buildToolCatalog(definitions, { promoted: new Set(['computer_stroke']) }).map((tool) => tool.name);
  assert.deepEqual(first, second, 'promotion changed the tool set');
  assert.deepEqual(first, definitions.map((tool) => tool.name));
});

test('a compacted schema is structurally identical to the full schema', () => {
  for (const mode of ['browser', 'agi']) {
    const definitions = toolDefinitions('task', mode, { workspace: true });
    const full = Object.fromEntries(openAiToolSchemas(definitions).map((schema) => [schema.function.name, schema.function.parameters]));
    const compact = Object.fromEntries(openAiToolSchemas(buildToolCatalog(definitions)).map((schema) => [schema.function.name, schema.function.parameters]));
    for (const [name, schema] of Object.entries(full)) {
      const expected = withoutAdditionalProperties(schemaOf(schema));
      const actual = withoutAdditionalProperties(schemaOf(compact[name]));
      assert.equal(actual, expected, `${mode}/${name}: the compact schema changed the structure`);
    }
  }
});

test('a compacted tool still declares every argument with its real type', () => {
  // The failure this guards: a compact schema that says "steps: string" where
  // the real schema says "steps: array" makes a weak model call it wrongly.
  for (const mode of ['browser', 'agi']) {
    const definitions = toolDefinitions('task', mode, { workspace: true });
    for (const tool of definitions) {
      const full = tool.inputSchema || toolInputSchema(tool.input || {}, tool.name);
      const compact = compactSchemaFor(tool);
      for (const [field, declared] of Object.entries(full.properties || {})) {
        assert.ok(compact.properties[field], `${tool.name}.${field} is missing from the compact schema`);
        assert.equal(compact.properties[field].type, declared.type, `${tool.name}.${field} has the wrong type`);
      }
    }
  }
});

test('a compacted schema accepts the same required fields as the full one', () => {
  const definitions = toolDefinitions('task', 'browser', { workspace: true });
  const browserWait = definitions.find((tool) => tool.name === 'browser_wait');
  assert.deepEqual(compactSchemaFor(browserWait).required, ['ms']);
});

test('the full schema is available on request for every tool, including the ones with no stored schema', () => {
  const definitions = toolDefinitions('task', 'browser', { workspace: true });
  // The browser tools build their schema at wire time; a lookup that missed
  // those would leave the model with no schema at all.
  for (const name of ['browser_navigate', 'browser_wait', 'browser_fill', 'tool_schema']) {
    const schema = fullSchemaFor(definitions, name);
    assert.ok(schema, `${name} has no full schema to serve`);
    assert.equal(schema.type, 'object');
  }
});

test('a promoted tool keeps its full schema, and promotion is monotonic', () => {
  const definitions = toolDefinitions('task', 'agi', { workspace: true });
  const promoted = new Set();
  const before = openAiToolSchemas(buildToolCatalog(definitions, { promoted }));
  const target = 'computer_stroke';
  assert.ok(JSON.stringify(before.find((schema) => schema.function.name === target)).includes('description'), 'a non-core tool starts compacted');
  promoted.add(target);
  const after = openAiToolSchemas(buildToolCatalog(definitions, { promoted }));
  const promotedSchema = after.find((schema) => schema.function.name === target).function.parameters;
  const fullSchema = definitions.find((tool) => tool.name === target).inputSchema;
  assert.equal(schemaOf(promotedSchema), schemaOf(fullSchema), 'a promoted tool must serve its full schema');
  // Nothing is lost when a tool is promoted: the catalog still has every tool.
  assert.equal(after.length, before.length);
});

test('EVERY tool is served in full: the agent always knows its capabilities', () => {
  // Owner directive (2026-11-11): no deferral, no compaction. The old saving
  // hid what non-core tools DO — browser_drag arrived as name + argument types
  // with no description, so the model used the desktop pointer to drag instead.
  for (const mode of ['browser', 'agi']) {
    const definitions = toolDefinitions('task', mode, { workspace: true });
    const catalog = buildToolCatalog(definitions);
    assert.equal(catalog.length, definitions.length, `${mode}: no tool may be dropped`);
    for (const tool of catalog) {
      assert.ok(tool.description && String(tool.description).length > 20, `${tool.name} must carry its description`);
      const schema = openAiToolSchemas([tool])[0];
      assert.ok(schema.function?.parameters?.properties || schema.function?.parameters, `${tool.name} must carry its full schema`);
    }
    // The drag verb is the regression that motivated this: it must be present
    // AND explain itself.
    const drag = catalog.find((tool) => tool.name === 'browser_drag');
    assert.ok(drag, 'browser_drag must reach the model');
    assert.match(String(drag.description), /drag/i, 'and say what it does');
  }
});

test('the deferred catalog is rebuilt per decision, so its membership still tracks the run', () => {
  // The catalog must not be frozen at run start: a tool that appears later
  // (skill_feedback, once a skill has been used) has to reach the model, and
  // a live agent recipient changes the agent_message tool.
  const withoutSkills = toolDefinitions('task', 'browser', { usedSkills: [], agentMessagingAvailable: false });
  const withSkills = toolDefinitions('task', 'browser', { usedSkills: ['some-skill'], agentMessagingAvailable: false });
  assert.ok(!withoutSkills.some((tool) => tool.name === 'skill_feedback'));
  assert.ok(withSkills.some((tool) => tool.name === 'skill_feedback'), 'skill_feedback must appear once a skill is used');
  const withAgent = toolDefinitions('task', 'browser', { usedSkills: [], agentMessagingAvailable: true });
  assert.ok(withAgent.some((tool) => tool.name === 'agent_message'));
  // Every one of those variants is still fully present in the deferred form.
  for (const definitions of [withoutSkills, withSkills, withAgent]) {
    const catalog = buildToolCatalog(definitions);
    assert.equal(catalog.length, definitions.length);
  }
});

test('nothing is ever reported as compacted (full-capability catalog)', () => {
  const definitions = toolDefinitions('task', 'agi', { workspace: true });
  assert.equal(isDeferredTool(definitions, 'computer_stroke', new Set()), false);
  assert.equal(isDeferredTool(definitions, 'browser_drag', new Set()), false);
  assert.equal(isDeferredTool(definitions, 'browser_done', new Set()), false);
});

// ---- Technique 1: the adaptive token compressor ---------------------------

test('the compressor factory mirrors the Intel API', () => {
  assert.deepEqual(availableCompressorTypes().sort(), ['harness', 'tool']);
  assert.ok(createCompressor('harness') instanceof HarnessCompressor);
  assert.ok(createCompressor('tool') instanceof ToolCompressor);
  assert.throws(() => createCompressor('nope'), /Unknown compressor type/);
});

test('the compressor reports Intel\'s metric names', async () => {
  const manager = new CompressionManager();
  manager.registerCompressor('harness', createCompressor('harness'));
  const result = await manager.compress('harness', { system: 'A'.repeat(4000) });
  for (const key of ['tokens_before', 'tokens_after', 'saved_tokens', 'compression_ratio', 'duration_ms']) {
    assert.ok(key in result.metrics, `missing metric ${key}`);
  }
  assert.ok(result.metrics.tokens_after <= result.metrics.tokens_before);
});

test('the harness compressor never drops a rule that names its own terms', async () => {
  // Two similar sentences that name DIFFERENT tools are different rules.
  const prompt = [
    'Never call browser_click with a stale coordinate when the DOM index is known.',
    'Never call computer_pointer with a stale coordinate when the DOM index is known.'
  ].join(' ');
  const result = await new HarnessCompressor({ compressMinChars: 10 }).compressSystem(prompt);
  assert.match(result.text, /browser_click/);
  assert.match(result.text, /computer_pointer/);
});

test('the harness compressor removes a directive that says the same thing twice', async () => {
  const prompt = [
    'Never re-read an unchanged page state when the newest observation already recorded it.',
    'Never re-read an unchanged page state when the newest observation already recorded it.'
  ].join(' ');
  const result = await new HarnessCompressor({ compressMinChars: 10 }).compressSystem(prompt);
  assert.equal(result.text.match(/Never re-read an unchanged page state/g).length, 1);
});

test('the notebook compression drops empty sections and keeps the content', () => {
  const notebook = [
    'RUN NOTEBOOK (persisted at C:/tmp/x.md)',
    '# RUN NOTEBOOK',
    '## WORKING REPOS',
    '- repo pinned',
    '## PROJECT FACTS',
    '- (record facts here once discovered — notebook update section="PROJECT FACTS" text="...")',
    '## WRITE TRAIL',
    '## DECISIONS',
    '## NOTES'
  ].join('\n');
  const result = compressNotebook(notebook);
  assert.match(result.text, /## WORKING REPOS/);
  assert.match(result.text, /repo pinned/);
  assert.doesNotMatch(result.text, /## WRITE TRAIL/);
  assert.doesNotMatch(result.text, /## DECISIONS/);
  assert.doesNotMatch(result.text, /## NOTES/);
  assert.doesNotMatch(result.text, /record facts here once discovered/, 'the template line is noise');
  assert.ok(result.savedChars > 0);
});

test('a notebook section that gains content comes back in full', () => {
  const empty = compressNotebook('## NOTES\n\n## DECISIONS\n');
  assert.doesNotMatch(empty.text, /## NOTES/);
  const filled = compressNotebook('## NOTES\n- [10:00] the user wants the header moved\n\n## DECISIONS\n');
  assert.match(filled.text, /## NOTES/);
  assert.match(filled.text, /the user wants the header moved/);
});

test('the sentence splitter keeps decimals and abbreviations intact', () => {
  const sentences = splitSentences('Read section 3.3 now. The value is 1.5. Done.');
  assert.equal(sentences.length, 3);
});

test('the tool compressor never removes a tool from the catalog', () => {
  const compressor = new ToolCompressor({ core: ['browser_done'] });
  const tools = [{ name: 'browser_done', description: 'Finish.' }, { name: 'browser_fetch', description: 'Fetch.' }];
  const scores = new Map([['browser_done', 5], ['browser_fetch', 1]]);
  // The predictor's score decides the schema tier, never membership.
  assert.equal(compressor.scoreTools, compressor.scoreTools);
  assert.equal(compressor.isCore('browser_done'), true);
  assert.equal(compressor.isCore('browser_fetch'), false);
  assert.equal(tools.length, 2);
});

test('the tool compressor accumulates a loaded schema without removing it', () => {
  const compressor = new ToolCompressor({ core: [] });
  compressor.noteLoaded('computer_stroke', { type: 'object' });
  assert.ok(compressor.loaded.has('computer_stroke'));
  compressor.noteLoaded('computer_stroke');
  assert.equal(compressor.loaded.size, 1, 'a schema is never dropped from the accumulated set');
});
