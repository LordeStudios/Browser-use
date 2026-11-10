// Compare two _sweep_result.json files -> per-suite regression/improvement table.
const fs = require('fs');
const path = require('path');

const forkRoot = process.argv[2];
const baseRoot = process.argv[3];

const load = (root, name) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  } catch (error) {
    console.error(`cannot read ${name} in ${root}: ${error.message}`);
    process.exit(1);
  }
};

const fork = load(forkRoot, '_sweep_result.json');
const base = load(baseRoot, '_sweep_result.json');
const baseByName = new Map(base.map((s) => [s.file, s]));
const forkByName = new Map(fork.map((s) => [s.file, s]));

const rows = [];
for (const s of fork) {
  const b = baseByName.get(s.file);
  if (!b) { rows.push({ file: s.file, kind: 'NEW', fork: s.pass, base: '-', detail: s.failed }); continue; }
  const fp = s.pass ?? -1;
  const bp = b.pass ?? -1;
  const ft = s.tests ?? -1;
  const bt = b.tests ?? -1;
  if (fp > bp) rows.push({ file: s.file, kind: 'FIXED', fork: `${fp}/${ft}`, base: `${bp}/${bt}`, detail: s.failed });
  else if (fp < bp) rows.push({ file: s.file, kind: 'REGRESSED', fork: `${fp}/${ft}`, base: `${bp}/${bt}`, detail: s.failed });
  else rows.push({ file: s.file, kind: 'same', fork: `${fp}/${ft}`, base: `${bp}/${bt}`, detail: s.failed });
}

const order = { REGRESSED: 0, same: 1, FIXED: 2, NEW: 3 };
rows.sort((a, b) => (order[a.kind] - order[b.kind]) || a.file.localeCompare(b.file));

const regressed = rows.filter((r) => r.kind === 'REGRESSED');
const fixed = rows.filter((r) => r.kind === 'FIXED');

console.log('===== REGRESSED (fork worse than baseline) =====');
for (const r of regressed) console.log(`  ${r.file.padEnd(38)} fork ${r.fork.padStart(6)}  baseline ${r.base.padStart(6)}  :: ${(r.detail || []).join(' | ')}`);
console.log('\n===== FIXED (fork better than baseline) =====');
for (const r of fixed) console.log(`  ${r.file.padEnd(38)} fork ${r.fork.padStart(6)}  baseline ${r.base.padStart(6)}`);
console.log('\n===== SAME =====');
for (const r of rows.filter((x) => x.kind === 'same')) console.log(`  ${r.file.padEnd(38)} fork ${r.fork.padStart(6)}  baseline ${r.base.padStart(6)}  ${r.fork !== r.base ? '' : (r.detail && r.detail.length ? ':: ' + r.detail.join(' | ') : '')}`);

const totals = (list) => list.reduce((acc, r) => {
  const [p, t] = String(r.fork).split('/');
  const [bp] = String(r.base).split('/');
  acc.forkPass += Number(p) || 0; acc.basePass += Number(bp) || 0; acc.forkTests += Number(t) || 0;
  return acc;
}, { forkPass: 0, basePass: 0, forkTests: 0 });

const t = totals(regressed);
console.log(`\nREGRESSED total: fork ${t.forkPass}/${t.forkTests} pass vs baseline ${t.basePass} pass  (${regressed.length} suites)`);
console.log(`FIXED total: ${fixed.length} suites`);
console.log(`Overall: fork ${fork.filter((s) => s.fail === 0).length} green / ${fork.length} suites; baseline ${base.filter((s) => s.fail === 0).length} green / ${base.length} suites`);
fs.writeFileSync(path.join(forkRoot, '_sweep_diff.json'), JSON.stringify(rows, null, 2));
