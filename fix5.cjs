const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const p = B + 'desktop/agent/desktopChatAgent.cjs';
let src = fs.readFileSync(p, 'utf8');
const ls = src.split('\n');

// --- marker check: the five call-level break sites, exactly as read in fix4 ---
const expect = { 2728: 'break;', 2752: 'break;', 2781: 'break;', 2790: 'break;', 2822: 'break;' };
let ok = true;
for (const [n, want] of Object.entries(expect)) {
  const got = ls[n - 1].trim();
  if (got !== want) { console.log('MARKER MISS line ' + n + ': [' + got + ']'); ok = false; }
}
if (!String(ls[2811]).includes('isMessageInterrupt')) { console.log('MARKER MISS line 2812 (message-interrupt break must stay)'); ok = false; }
if (!ok) { console.log('ABORT'); process.exit(1); }

// --- PATCH f3: recoverable call failures continue the batch instead of clipping it ---
for (const n of Object.keys(expect).map(Number)) ls[n - 1] = ls[n - 1].replace('break;', 'continue;');
src = ls.join('\n');
fs.writeFileSync(p, src);

try { cp.execSync('node --check "' + p + '"', { stdio: 'pipe' }); console.log('SYNTAX-OK'); }
catch (e) { console.log('SYNTAX-FAIL ' + String(e.stderr).slice(0, 400)); process.exit(1); }

// --- read-backs FIRST to beat truncation: each patched site with context ---
const out = src.split('\n');
for (const n of Object.keys(expect).map(Number)) {
  console.log('--- f3 site line ' + n + ' ---');
  for (let i = n - 3; i <= n + 1 && i < out.length; i++) console.log((i + 1) + ': ' + out[i]);
}

console.log('=== normalizeToolCalls body 6231-6258 ===');
for (let i = 6230; i < 6258 && i < out.length; i++) console.log((i + 1) + ': ' + out[i]);

// --- full regression net after the behavior change ---
const files = fs.readdirSync(B + 'tests').filter(f => /\.test\.mjs$/.test(f)).sort();
console.log('TEST FILES: ' + files.join(' '));
for (const f of files) {
  let code = -1, outt = '';
  try { outt = cp.execSync('node --test tests/' + f, { cwd: B, encoding: 'utf8', stdio: 'pipe', timeout: 120000 }); code = 0; }
  catch (e) { outt = String(e.stdout || '') + String(e.stderr || ''); code = e.status === undefined ? -2 : e.status; }
  const counts = (outt.match(/# (tests|pass|fail) \d+/g) || []).join(' ');
  console.log('SUITE ' + f + ' EXIT ' + code + ' :: ' + counts);
}
console.log('ALL-DONE');
