const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const readLines = (rel) => fs.readFileSync(B + rel, 'utf8').split('\n');
const show = (rel, from, to) => {
  const ls = readLines(rel);
  console.log('=== ' + rel + ' ' + from + '-' + to + ' ===');
  for (let i = from - 1; i < to && i < ls.length; i++) console.log((i + 1) + ': ' + ls[i]);
};

// --- discovery first so it survives any patch failure ---
show('desktop/renderer/pages/artworks-source.js', 165, 200);
show('desktop/renderer/pages/homepage.html', 625, 670);
const grepShow = (rel, rx, label, max) => {
  const ls = readLines(rel);
  console.log('=== ' + label + ' (' + rel + ') ===');
  let n = 0;
  ls.forEach((l, i) => { if (rx.test(l) && n < (max || 25)) { n++; console.log((i + 1) + ': ' + l.trim().slice(0, 150)); } });
};
for (const f of ['desktop/agent/desktopChatAgent.cjs', 'desktop/agent/desktopAgentCoordinator.cjs', 'desktop/agent/providerTurnLedger.cjs']) {
  grepShow(f, /for \(const (call|action|entry|item) of|\bbreak;|output\.ok|result\.ok|\.ok === false/i, 'BATCH LOOP CANDIDATES');
}

// --- PATCH A (f2): harness-own panels must never count as native dialogs ---
{
  const rel = 'desktop/agent/desktopChatAgent.cjs';
  const ls = readLines(rel);
  const start = ls.findIndex(l => l.includes('const isDialog = (w) => {'));
  const titleLine = ls.findIndex((l, i) => i > start && l.includes('const title = String(w?.title'));
  if (start < 0 || titleLine < 0) { console.log('F2 MARKER NOT FOUND', start, titleLine); process.exit(1); }
  const guard = [
    '      // Harness-owned panels (the agent pointer overlay and the app\'s own',
    '      // window) trip the broad heuristics below (\'browser\' contains \'browse\';',
    '      // the Chromium frame class is in DIALOG_CLASSES) but are the harness',
    '      // itself, never a dialog to resolve. Genuine own-PID dialogs (Open,',
    '      // Save As) still surface: tests pin that behavior.',
    '      if (w?.own === true) return false;',
    '      if (/^browser-use( agent pointer)?$/.test(title)) return false;'
  ];
  ls.splice(titleLine + 1, 0, ...guard);
  fs.writeFileSync(B + rel, ls.join('\n'));
  console.log('F2 PATCHED after line', titleLine + 1);
  for (let i = start; i < start + 12; i++) console.log((i + 1) + ': ' + ls[i]);
  cp.execSync('node --check "' + B + rel + '"', { stdio: 'inherit' });
  console.log('F2 SYNTAX-OK');
}

// --- PATCH B (f4a): stop calling ipapi.co — the request itself is the console error ---
{
  const rel = 'desktop/renderer/pages/homepage.html';
  const ls = readLines(rel);
  const start = ls.findIndex(l => l.includes('function lookupPlace() {'));
  if (start < 0) { console.log('F4a MARKER NOT FOUND'); process.exit(1); }
  let end = -1;
  for (let i = start + 1; i < ls.length; i++) { if (ls[i] === '  }') { end = i; break; } }
  if (end < 0) { console.log('F4a END NOT FOUND'); process.exit(1); }
  const repl = [
    '  function lookupPlace() {',
    '    // ipapi.co reliably answers 403 from this network (and often hangs), so',
    '    // the request itself is the console error and no catch can hide it. The',
    '    // forecast already ships with the default place; the city label now keeps',
    '    // it instead of guessing through a service that rejects us.',
    '    return Promise.resolve(null);',
    '  }'
  ];
  ls.splice(start, end - start + 1, ...repl);
  fs.writeFileSync(B + rel, ls.join('\n'));
  console.log('F4a PATCHED lines', start + 1, '-', end + 1);
  for (let i = start; i < start + 8; i++) console.log((i + 1) + ': ' + ls[i]);
}
console.log('ALL-DONE');
