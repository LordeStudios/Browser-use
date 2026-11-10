const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const P = B + 'desktop/computer/applyPatch.cjs';
const lines = fs.readFileSync(P, 'utf8').split('\n');

// --- discovery (read-only, first so it survives a fix failure) ---
console.log('=== EXPORT LINES ===');
lines.forEach((l, i) => { if (/module\.exports|exports\./.test(l)) console.log((i + 1) + ': ' + l.trim()); });
const testFiles = [];
const walkT = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = d + '/' + e.name;
    if (e.isDirectory()) { if (!/node_modules|\.git/.test(e.name)) walkT(fp); }
    else if (/\.mjs$/.test(e.name)) {
      const t = fs.readFileSync(fp, 'utf8');
      if (/applyPatch|applyToLines|computer_patch/.test(t)) testFiles.push(fp);
    }
  }
};
walkT(B + 'tests');
console.log('=== PATCH-TOUCHING TESTS ===');
testFiles.forEach(f => console.log(f.replace(B, '')));

const show = (rel, from, to) => {
  const ls = fs.readFileSync(B + rel, 'utf8').split(/\r?\n/);
  console.log('=== ' + rel + ' ' + from + '-' + to + ' ===');
  for (let i = from - 1; i < to && i < ls.length; i++) console.log((i + 1) + ': ' + ls[i]);
};
const grepShow = (rel, rx, label) => {
  const ls = fs.readFileSync(B + rel, 'utf8').split(/\r?\n/);
  console.log('=== ' + label + ' (' + rel + ') ===');
  let n = 0;
  ls.forEach((l, i) => { if (rx.test(l) && n < 30) { n++; console.log((i + 1) + ': ' + l.trim().slice(0, 160)); } });
};
grepShow('tests/native-dialog-handling.test.mjs', /own|pointer|Chrome_Widget|328008|title|isDialog/i, 'DIALOG TEST');
grepShow('tests/provider-turn-ledger.test.mjs', /clip|not executed|settle|prior action/i, 'LEDGER TEST');
grepShow('desktop/agent/desktopAgentCoordinator.cjs', /if \(!?.*\.ok.*\) break|break;|batch|clipped/i, 'COORD BREAK/BATCH');
show('desktop/renderer/pages/homepage.html', 575, 625);
grepShow('desktop/renderer/pages/artworks-source.js', /function fetchJson|withTimeout|AbortController|retry|chunk|doFetch/i, 'ARTWORKS FETCH');

// --- the fix ---
let i71 = -1, i73 = -1;
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (i71 === -1 && l.indexOf('if (raw.startsWith') !== -1 && l.indexOf("raw.startsWith('-')") !== -1 && l.indexOf('raw ===') !== -1) i71 = i;
  if (i73 === -1 && l.indexOf('hunk.lines.push({ kind:') !== -1) i73 = i;
}
if (i71 < 0 || i73 < 0) { console.log('MARKER-NOT-FOUND', i71, i73); process.exit(1); }
const ind71 = lines[i71].match(/^ */)[0];
const ind73 = lines[i73].match(/^ */)[0];
lines[i71] = ind71 + "if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ') || raw === '' || raw === '\\r') {";
lines[i73] = ind73 + "hunk.lines.push({ kind: raw.startsWith('+') ? 'add' : raw.startsWith('-') ? 'del' : 'ctx', text: raw.slice(1).replace(/\\r$/, '') });";
fs.writeFileSync(P, lines.join('\n'));
console.log('WROTE lines', i71 + 1, i73 + 1);
console.log('L71: ' + lines[i71]);
console.log('L73: ' + lines[i73]);
cp.execSync('node --check "' + P + '"', { stdio: 'inherit' });
console.log('SYNTAX-OK');
