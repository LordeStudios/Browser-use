const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';

const runFull = (f) => {
  let out = '', code = -1;
  try { out = cp.execSync('node --test tests/' + f, { cwd: B, encoding: 'utf8', stdio: 'pipe', timeout: 120000 }); code = 0; }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); code = e.status === undefined ? -2 : e.status; }
  return { out, code };
};

// --- triage: full failure detail for the two failing suites ---
for (const f of ['agent-coding-gating.test.mjs', 'agent-continuity-regressions.test.mjs']) {
  const { out, code } = runFull(f);
  console.log('### ' + f + ' EXIT ' + code);
  const lines = out.split('\n');
  const picked = lines.filter(l => /^not ok|Error:|AssertionError|expected |actual |operator:|\+ actual|- expected|at .*test\.mjs|message:/.test(l.trim())).slice(0, 40);
  picked.forEach(l => console.log(l.slice(0, 220)));
  // does the suite even touch batch/clip/break semantics my f3 change altered?
  const src = fs.readFileSync(B + 'tests/' + f, 'utf8').split('\n');
  const hits = src.map((l, i) => ({ l, i: i + 1 })).filter(h => /clipped|not executed|batch|loopIssue|scheduleRecovery|break the (batch|loop)|remaining call/i.test(h.l)).slice(0, 12);
  console.log('--- ' + f + ' batch/clip references ---');
  hits.forEach(h => console.log(h.i + ': ' + h.l.trim().slice(0, 200)));
}

// --- plan-scoped regression set (f5) ---
for (const f of ['enforcement-gen2.test.mjs', 'enforcement-gen3.test.mjs', 'enforcement-gen4.test.mjs', 'enforcement-gen5.test.mjs', 'enforcement-gen6.test.mjs', 'computer-patch.test.mjs', 'native-dialog-handling.test.mjs', 'provider-turn-ledger.test.mjs', 'evidence-streak-accounting.test.mjs', 'real-verification.test.mjs']) {
  const { out, code } = runFull(f);
  const counts = (out.match(/# (tests|pass|fail) \d+/g) || []).join(' ');
  console.log('SUITE ' + f + ' EXIT ' + code + ' :: ' + counts);
}
console.log('ALL-DONE');
