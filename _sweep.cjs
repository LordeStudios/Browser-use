// Test sweep: runs every suite that touches the rewritten modules and prints
// one line per suite. Used to capture an accurate handoff status.
// Usage: node _sweep.cjs [rootDir]
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = process.argv[2] || process.cwd();
const testsDir = path.join(root, 'tests');
const needles = ['desktopChatAgent', 'agentInternals', 'harness/', 'computerCatalog', 'openAiCompatibleProvider', 'agent-cli', 'promptBuilder', 'providerTurnLedger'];
const files = fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.mjs'));
const targets = files.filter((f) => {
  const text = fs.readFileSync(path.join(testsDir, f), 'utf8');
  return needles.some((n) => text.includes(n));
});

const summary = [];
for (const file of targets) {
  const started = Date.now();
  let out = '';
  try {
    out = execFileSync('node', ['--test', '--test-force-exit', path.join(testsDir, file)], {
      encoding: 'utf8', timeout: 120000, cwd: root, stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    out = `${error.stdout || ''}${error.stderr || ''}`;
  }
  const pick = (label) => {
    const m = out.match(new RegExp(`^# ${label} (\\d+)`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const tests = pick('tests');
  const pass = pick('pass');
  const fail = pick('fail');
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].slice(0, 70));
  const secs = Math.round((Date.now() - started) / 1000);
  const status = fail === 0 ? 'GREEN' : 'RED';
  summary.push({ file: file.replace(/\.test\.mjs$/, ''), tests, pass, fail, status, secs, failed });
  console.log(`${status.padEnd(5)} ${String(pass).padStart(3)}/${String(tests).padEnd(3)} ${String(secs).padStart(3)}s  ${file.replace(/\.test\.mjs$/, '')}${failed.length ? '  << ' + failed.join(' | ') : ''}`);
}

const red = summary.filter((s) => s.fail > 0);
console.log('\n===== SWEEP SUMMARY =====');
console.log(`suites: ${summary.length}   green: ${summary.length - red.length}   red: ${red.length}`);
for (const s of red) console.log(`  RED ${s.file}: ${s.pass}/${s.tests} :: ${s.failed.join(' | ')}`);
fs.writeFileSync(path.join(root, '_sweep_result.json'), JSON.stringify(summary, null, 2));
