'use strict';
// Break down a REAL captured provider request into its instruction surfaces.
// Usage: node _wire_breakdown.cjs <wireDir> [index]
// Wire captures come from a real CLI run (BROWSER_USE_CLI_LOG_REQUESTS).

const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2] || 'scratch/dsh-verify/wire003';
const files = fs.readdirSync(dir).filter((f) => f.startsWith('request-')).sort();
const file = files[Number(process.argv[3] || files.length - 1)];
const req = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));

console.log(`wire: ${dir}/${file}`);
console.log(`model ${req.model} | messages ${req.messages.length} | tools ${(req.tools || []).length}\n`);

// --- system message ---
const system = req.messages.find((m) => m.role === 'system');
const sysText = typeof system?.content === 'string' ? system.content : String(system?.content || '');
console.log(`SYSTEM PROMPT: ${sysText.length.toLocaleString('en-US')} chars`);

// --- other messages ---
console.log('\n--- MESSAGES (non-system) ---');
let userJsonChars = 0;
for (const m of req.messages) {
  if (m.role === 'system') continue;
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  const tag = /^\s*\{/.test(text) && text.includes('"task"') ? ' [per-decision context JSON]' : '';
  console.log(`  ${String(m.role).padEnd(9)} ${String(text.length).padStart(7)}${tag}`);
  if (tag) userJsonChars = text.length;
}

// --- per-decision context JSON: what instruction fields ride on it ---
if (userJsonChars) {
  try {
    const ctx = JSON.parse(req.messages.find((m) => m.role !== 'system' && /^\s*\{/.test(String(m.content)) && String(m.content).includes('"task"')).content);
    console.log('\n--- PER-DECISION CONTEXT JSON: field sizes ---');
    const rows = Object.entries(ctx)
      .map(([k, v]) => [k, JSON.stringify(v).length])
      .sort((a, b) => b[1] - a[1]);
    for (const [k, n] of rows) console.log(`  ${String(n).padStart(7)}  ${k}`);
    console.log(`  ${String(userJsonChars).padStart(7)}  TOTAL`);
  } catch (error) {
    console.log('\n(context JSON parse failed:', error.message, ')');
  }
}

// --- tool schema: description text vs raw schema ---
console.log('\n--- TOOL SCHEMA ---');
let descChars = 0;
let argChars = 0;
let enumChars = 0;
const tools = req.tools || [];
const biggest = [];
for (const t of tools) {
  const d = String(t.description || '');
  descChars += d.length;
  biggest.push({ name: t.name, desc: d.length, args: JSON.stringify(t.parameters || t.input || {}).length });
  const args = t.parameters || t.input || {};
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.description === 'string') argChars += v.description.length;
    for (const value of Object.values(v)) if (value && typeof value === 'object') walk(value);
  };
  walk(args);
}
console.log(`  ${tools.length} tools | JSON total ${JSON.stringify(tools).length.toLocaleString('en-US')} chars`);
console.log(`  tool .description text: ${descChars.toLocaleString('en-US')} chars (schema-related)`);
console.log(`  argument .description text: ${argChars.toLocaleString('en-US')} chars (schema-related)`);

console.log('\n  biggest tool descriptions:');
for (const t of biggest.sort((a, b) => b.desc - a.desc).slice(0, 12)) {
  console.log(`    ${String(t.desc).padStart(6)}  ${t.name}`);
}

// --- totals ---
const msgChars = req.messages.reduce((a, m) => a + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
console.log(`\n=== TOTALS ===`);
console.log(`  system prompt prose     : ${sysText.length.toLocaleString('en-US')}  (DSH equivalent: 1,776)`);
console.log(`  conversation messages   : ${msgChars.toLocaleString('en-US')}`);
console.log(`  tool schema JSON        : ${JSON.stringify(tools).length.toLocaleString('en-US')}  (schema-related by definition)`);
console.log(`  whole request           : ${(sysText.length + msgChars + JSON.stringify(tools).length).toLocaleString('en-US')} chars`);
