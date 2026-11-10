'use strict';
// ORPHAN DETECTOR: the fork moved helpers verbatim into agentInternals.cjs but
// dropped some of their CALL SITES. A helper that is declared and exported but
// referenced nowhere is the smoking gun of lost behaviour.
const fs = require('node:fs');
const path = require('node:path');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(cjs|mjs|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const root = 'C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork';
const internalsPath = path.join(root, 'desktop/agent/agentInternals.cjs');
const internals = fs.readFileSync(internalsPath, 'utf8');

const names = new Set();
const declRe = /^(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm;
let m;
while ((m = declRe.exec(internals))) names.add(m[1]);

const corpusFiles = walk(root).filter(f => f !== internalsPath);
const corpus = corpusFiles.map(f => fs.readFileSync(f, 'utf8')).join('\n');
const exportTail = internals.slice(internals.lastIndexOf('module.exports'));

const esc = s => s.replace(/\$/g, '\\$');
const orphans = [];
const internalOnly = [];
for (const name of names) {
  const outside = (corpus.match(new RegExp('\\b' + esc(name) + '\\b', 'g')) || []).length;
  if (outside > 0) continue;
  const inside = (internals.match(new RegExp('\\b' + esc(name) + '\\b', 'g')) || []).length;
  const exported = new RegExp('\\b' + esc(name) + '\\b').test(exportTail);
  if (inside <= 1) orphans.push({ name, exported });
  else internalOnly.push({ name, inside, exported });
}

orphans.sort((a, b) => a.name.localeCompare(b.name));
console.log('=== TRULY DEAD (' + orphans.length + '): declared+exported, referenced NOWHERE ===');
for (const o of orphans) console.log('  ' + o.name + (o.exported ? '   [exported]' : ''));

internalOnly.sort((a, b) => a.name.localeCompare(b.name));
console.log('\n=== INTERNAL ONLY (' + internalOnly.length + '): used only inside agentInternals ===');
console.log(internalOnly.map(o => o.name).join(', '));
