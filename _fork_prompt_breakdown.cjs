'use strict';
// Fork instruction-surface inventory.
// Measures everything this fork sends to the model, bucketed the same way the
// DSH inventory does: system-prompt prose, tool-schema descriptions, and the
// standalone instruction constants (notices, recovery demands, wire text).
// Usage: node _fork_prompt_breakdown.cjs

const fs = require('node:fs');
const path = require('node:path');

const sections = require('./desktop/agent/prompt/sections.cjs');
const { createPromptRegistry } = require('./desktop/agent/harness/promptRegistry.cjs');
const { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION } = require('./desktop/agent/harness/identity.cjs');

// 1. Render the system prompt for a realistic AGI run and split it by section.
function renderPrompt({ controlMode = 'agi', workspace = 'E:/repo', effort = 'standard' } = {}) {
  const registry = createPromptRegistry();
  sections.registerPromptSections(registry, {
    controlMode,
    effort,
    effortMode: 'standard',
    approvalMode: 'unattended',
    modelingPlaybook: '',
    drawingPlaybook: '',
    instructionsFile: ''
  });
  return registry.render();
}

const prompt = renderPrompt();
console.log('=== FORK SYSTEM PROMPT (agi, standard, unattended) ===');
console.log(`rendered prompt: ${prompt.length.toLocaleString('en-US')} chars`);

// 2. Measure each named policy block from sections.cjs.
const blockSizes = {
  'PERSONA_PREFIX': sections.PERSONA_PREFIX.length,
  'PLAN_POLICY': sections.PLAN_POLICY.length,
  'EVIDENCE_POLICY': sections.EVIDENCE_POLICY.length,
  'BATCHING_POLICY': sections.BATCHING_POLICY.length,
  'FAILURE_POLICY': sections.FAILURE_POLICY.length,
  'COMPLETION_POLICY': sections.COMPLETION_POLICY.length,
  'TOOLS_CATALOG_NOTE': sections.TOOLS_CATALOG_NOTE.length,
  'REPAIR_POLICY': sections.REPAIR_POLICY.length,
  'MODELING_PLAYBOOK (attached only when a 3D app is open)': sections.MODELING_PLAYBOOK.length,
  'DRAWING_PLAYBOOK (attached only when a drawing app is open)': sections.DRAWING_PLAYBOOK.length
};
console.log('\n--- policy blocks (sections.cjs) ---');
let policyTotal = 0;
for (const [name, size] of Object.entries(blockSizes)) {
  policyTotal += size;
  console.log(`  ${size.toLocaleString('en-US').padStart(7)}  ${name}`);
}
console.log(`  ${policyTotal.toLocaleString('en-US').padStart(7)}  TOTAL (all blocks, incl. playbooks not always attached)`);

// computerSection text (agi-only) — measure by rendering with and without agi.
const browserPrompt = renderPrompt({ controlMode: 'browser' });
const computerBlock = prompt.length - browserPrompt.length;
console.log(`  ${computerBlock.toLocaleString('en-US').padStart(7)}  COMPUTER/CODING WORKFLOW block (agi-only delta)`);

// 3. Tool schema surface (the schema-related bucket).
const { toolDefinitions } = require('./desktop/agent/desktopChatAgent.cjs');
const agiTools = toolDefinitions('Fix the favourites toggle in the header', 'agi', { workspace: true, observationDomain: 'browser' });
const browserTools = toolDefinitions('open example.com', 'browser', {});
const schemaChars = JSON.stringify(agiTools).length;
let descChars = 0;
let descCount = 0;
for (const tool of agiTools) {
  const d = String(tool.description || '');
  descCount += 1;
  descChars += d.length;
  for (const v of Object.values(tool.input || {})) {
    if (typeof v === 'string') descChars += v.length;
  }
}
console.log(`\n=== TOOL SCHEMA (the schema-related surface) ===`);
console.log(`  agi catalog: ${agiTools.length} tools, JSON ${schemaChars.toLocaleString('en-US')} chars`);
console.log(`  of which description/arg text: ~${descChars.toLocaleString('en-US')} chars across ${descCount} tools`);
console.log(`  browser catalog: ${browserTools.length} tools`);

// 4. Every instruction string (>=200 chars) in the modules that shape the wire.
//    Catches literals inside functions and object properties, not just consts.
const targets = [
  'desktop/agent/agentInternals.cjs',
  'desktop/agent/desktopChatAgent.cjs',
  'desktop/agent/harness/loopPolicy.cjs',
  'desktop/agent/harness/flowGuard.cjs',
  'desktop/agent/harness/inbox.cjs',
  'desktop/agent/harness/guards.cjs',
  'desktop/agent/ollamaProvider.cjs',
  'desktop/agent/openAiCompatibleProvider.cjs',
  'desktop/agent/desktopAgentCoordinator.cjs',
  'desktop/agent/progressState.cjs',
  'desktop/agent/requestQuote.cjs',
  'desktop/agent/interactionMemory.cjs',
  'desktop/agent/deferredToolCatalog.cjs'
];
const standalone = [];
for (const rel of targets) {
  const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const re = /'((?:[^'\\\n]|\\.){200,})'|"((?:[^"\\\n]|\\.){200,})"|`((?:[^`\\]|\\.){200,})`/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    // Skip code-looking literals (JSON schemas, regexes, base64, CSS) that are
    // data rather than prose: require >= 40% alphabetic words with spaces.
    const words = text.split(/\s+/).filter((w) => /^[A-Za-z]{2,}$/.test(w)).length;
    if (words / Math.max(1, text.split(/\s+/).length) < 0.55) continue;
    standalone.push({ file: rel, chars: text.length, text });
  }
}
console.log(`\n=== INSTRUCTION PROSE OUTSIDE THE SYSTEM PROMPT (>=200-char string literals) ===`);
let standaloneTotal = 0;
const byFile = new Map();
for (const s of standalone) {
  standaloneTotal += s.chars;
  byFile.set(s.file, (byFile.get(s.file) || 0) + s.chars);
}
console.log(`  ${standalone.length} literals, ${standaloneTotal.toLocaleString('en-US')} chars total, by file:`);
for (const [file, chars] of [...byFile.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${String(chars).padStart(8)}  ${file}`);
}
console.log('\n  longest 25:');
for (const s of standalone.slice().sort((a, b) => b.chars - a.chars).slice(0, 25)) {
  console.log(`    ${String(s.chars).padStart(6)}  ${s.file.replace('desktop/agent/', '')}  ::  ${s.text.slice(0, 90).replace(/\s+/g, ' ')}`);
}

fs.writeFileSync(path.join(__dirname, 'scratch/fork-inventory.json'), JSON.stringify({ promptLength: prompt.length, blockSizes, computerBlock, schemaChars, descChars, standalone }, null, 1));
console.log('\nfull detail -> scratch/fork-inventory.json');
