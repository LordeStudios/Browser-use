'use strict';
// Systematic "lost functionality" detector: compares the SET of recovery
// sources (and the guards/advisories) that each tree can emit. Any source the
// baseline emits but the fork cannot is a dropped gate.
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

const roots = {
  fork: 'C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork',
  base: 'C:/Users/london/Desktop/browser-use/browser-use'
};

function collect(root, subdir) {
  const dir = path.join(root, subdir);
  const files = fs.existsSync(dir) ? walk(dir) : [];
  const sources = new Map(); // source -> [files]
  const patterns = [
    /recoverySource:\s*'([a-z_]+)'/g,
    /recoverySource\s*=\s*'([a-z_]+)'/g,
    /source:\s*'([a-z_]+)'/g,
  ];
  const advisory = /recoverySource:\s*'([a-z_]+)'/g;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!sources.has(m[1])) sources.set(m[1], []);
        const list = sources.get(m[1]);
        if (!list.includes(path.relative(root, f))) list.push(path.relative(root, f));
      }
    }
  }
  return sources;
}

const fork = collect(roots.fork, 'desktop');
const base = collect(roots.base, 'desktop');

const onlyBase = [...base.keys()].filter(k => !fork.has(k)).sort();
const onlyFork = [...fork.keys()].filter(k => !base.has(k)).sort();
const both = [...fork.keys()].filter(k => base.has(k)).sort();

console.log('=== recovery sources ONLY IN BASELINE (dropped by the fork) ===');
for (const k of onlyBase) console.log(`  ${k}\n      ${base.get(k).join('\n      ')}`);
console.log('\n=== recovery sources ONLY IN FORK (added) ===');
for (const k of onlyFork) console.log(`  ${k}\n      ${fork.get(k).join('\n      ')}`);
console.log(`\n=== SHARED: ${both.length} ===`);
console.log(both.join(', '));
console.log(`\nbaseline=${base.size} fork=${fork.size} dropped=${onlyBase.length}`);
