const { spawnSync } = require('child_process');
const tests = [
  'tests/provider-turn-ledger.test.mjs',
  'tests/agent-continuity-regressions.test.mjs',
  'tests/enforcement-gen2.test.mjs',
  'tests/enforcement-gen3.test.mjs',
  'tests/enforcement-gen4.test.mjs',
  'tests/enforcement-gen5.test.mjs',
  'tests/enforcement-gen6.test.mjs',
  'tests/computer-patch.test.mjs',
  'tests/native-dialog-handling.test.mjs'
];
const results = [];
for (const t of tests) {
  const r = spawnSync(process.execPath, [t], { cwd: 'C:/Users/london/Desktop/browser-use/browser-use', encoding: 'utf8' });
  results.push(t.replace('tests/', '') + ' EXIT ' + r.status);
  if (r.status !== 0) {
    results.push('--- FAILTAIL ' + t + ' ---');
    results.push(((r.stdout || '') + (r.stderr || '')).slice(-1200));
  }
}
console.log(results.join('\n'));
