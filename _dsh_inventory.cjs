'use strict';
// instruction-surface inventory.
// Walks the the reference harness repo and measures every instruction string that
// reaches the model: system-prompt section texts, tool descriptions, and the
// big standalone guidance literals. Usage: node _dsh_inventory.cjs <dshRoot>

const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2] || 'C:/Users/london/Desktop/deepseek/the reference harness';
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'build', 'coverage'].includes(entry.name)) continue;
      walk(p);
    } else if (/\.(ts|mjs|cjs|js)$/.test(entry.name) && !/\.(spec|test)\./.test(entry.name)) {
      files.push(p);
    }
  }
};
for (const top of ['packages', 'apps']) {
  const abs = path.join(root, top);
  if (fs.existsSync(abs)) walk(abs);
}

const sections = [];   // { pkg, file, name, chars }
const toolDescs = [];  // { pkg, file, chars, text }
const guidance = [];   // long instruction literals not caught above

for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const pkg = rel.split('/')[1] || rel;
  const src = fs.readFileSync(file, 'utf8');

  // .section({ name: 'x', order: ..., text: '...' }) — string-literal text.
  const sectionRe = /\.section\(\{\s*name:\s*['"`]([^'"`]+)['"`]([\s\S]{0,400}?text:\s*)(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  let m;
  while ((m = sectionRe.exec(src)) !== null) {
    const text = m[3] ?? m[4] ?? m[5] ?? '';
    if (!text) continue;
    sections.push({ pkg, file: rel, name: m[1], chars: text.length, text });
  }

  // Tool descriptions (>= 40 chars to skip trivial one-word labels).
  const descRe = /description:\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  while ((m = descRe.exec(src)) !== null) {
    const text = m[1] ?? m[2] ?? m[3] ?? '';
    if (text.length >= 40) toolDescs.push({ pkg, file: rel, chars: text.length, text });
  }
}

// Long standalone guidance literals (const X = '...long...' or GUIDANCE = `...`).
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const pkg = rel.split('/')[1] || rel;
  const src = fs.readFileSync(file, 'utf8');
  const re = /(?:const|let)\s+([A-Z_][A-Z0-9_]{2,})\s*=\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const text = m[2] ?? m[3] ?? m[4] ?? '';
    if (text.length >= 300) guidance.push({ pkg, file: rel, name: m[1], chars: text.length, text });
  }
}

const sum = (list) => list.reduce((a, x) => a + x.chars, 0);
const byPkg = (list) => {
  const map = new Map();
  for (const item of list) map.set(item.pkg, (map.get(item.pkg) || 0) + item.chars);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
};

console.log('=== INSTRUCTION SURFACE ===');
console.log(`section texts      : ${sections.length.toString().padStart(4)} strings  ${sum(sections).toLocaleString('en-US').padStart(9)} chars`);
console.log(`tool descriptions  : ${toolDescs.length.toString().padStart(4)} strings  ${sum(toolDescs).toLocaleString('en-US').padStart(9)} chars`);
console.log(`guidance constants : ${guidance.length.toString().padStart(4)} strings  ${sum(guidance).toLocaleString('en-US').padStart(9)} chars`);
console.log(`TOTAL              : ${(sum(sections) + sum(toolDescs) + sum(guidance)).toLocaleString('en-US')} chars`);

console.log('\n=== SECTION TEXT BY PACKAGE ===');
for (const [pkg, chars] of byPkg(sections).slice(0, 12)) console.log(`  ${pkg.padEnd(22)} ${chars.toLocaleString('en-US')}`);

console.log('\n=== TOP 15 LONGEST GUIDANCE CONSTANTS ===');
for (const g of guidance.slice().sort((a, b) => b.chars - a.chars).slice(0, 15)) {
  console.log(`  ${String(g.chars).padStart(6)}  ${g.pkg.padEnd(14)} ${g.name}`);
}

console.log('\n=== TOP 15 LONGEST SECTION TEXTS ===');
for (const s of sections.slice().sort((a, b) => b.chars - a.chars).slice(0, 15)) {
  console.log(`  ${String(s.chars).padStart(6)}  ${s.name.padEnd(38)} ${s.file}`);
}

fs.writeFileSync(path.join(__dirname, 'scratch/dsh-inventory.json'), JSON.stringify({ sections, toolDescs, guidance }, null, 1));
console.log('\nfull detail -> scratch/dsh-inventory.json');
