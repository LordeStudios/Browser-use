const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const readLines = (rel) => fs.readFileSync(B + rel, 'utf8').split('\n');
const show = (rel, from, to) => {
  const ls = readLines(rel);
  console.log('=== ' + rel + ' ' + from + '-' + to + ' ===');
  for (let i = from - 1; i < to && i < ls.length; i++) console.log((i + 1) + ': ' + ls[i]);
};

// --- discriminating discovery for f3: the dispatch loop head and its breaks ---
show('desktop/agent/desktopChatAgent.cjs', 2700, 2845);
{
  const ls = readLines('desktop/agent/desktopChatAgent.cjs');
  const hits = [];
  ls.forEach((l, i) => { if (/function normalizeToolCalls|maxActionsPerStep/.test(l)) hits.push((i + 1) + ': ' + l.trim()); });
  console.log('=== normalizeToolCalls / maxActionsPerStep hits ===');
  hits.slice(0, 30).forEach(h => console.log(h));
}

// --- targeted suites pinning f1 (patch matcher), f2 (dialog filter), ledger stub ---
const runSuite = (file) => {
  let code = -1;
  let out = '';
  try {
    out = cp.execSync('node --test tests/' + file, { cwd: B, encoding: 'utf8', stdio: 'pipe' });
    code = 0;
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
    code = e.status === undefined ? -2 : e.status;
  }
  const tail = out.split('\n').filter(l => /# (tests|pass|fail|suites)|not ok|^not ok/.test(l)).slice(-20).join(' | ');
  console.log('SUITE ' + file + ' EXIT ' + code + ' :: ' + tail);
};
for (const f of ['computer-patch.test.mjs', 'native-dialog-handling.test.mjs', 'provider-turn-ledger.test.mjs']) runSuite(f);
console.log('ALL-DONE');
