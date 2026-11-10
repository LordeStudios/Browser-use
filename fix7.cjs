const fs = require('fs');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const show = (label, file, re, max) => {
  const lines = fs.readFileSync(B + file, 'utf8').split('\n');
  console.log('=== ' + label + ' ===');
  let n = 0;
  lines.forEach((l, i) => { if (n < max && re.test(l)) { console.log((i + 1) + ': ' + l.trim().slice(0, 190)); n++; } });
  if (!n) console.log('NO MATCH');
};
show('f2 isDialog denylist (desktopChatAgent.cjs)', 'desktop/agent/desktopChatAgent.cjs', /own === true|browser-use\( agent pointer\)\?|function isDialog|isDialog = /, 8);
show('f4a lookupPlace stub (homepage.html)', 'desktop/renderer/pages/homepage.html', /lookupPlace|Promise\.resolve\(null\)|ipapi/, 8);
show('f4b fetchJson timeout (artworks-source.js)', 'desktop/renderer/pages/artworks-source.js', /Promise\.race|setTimeout|reject\('timeout'\)|AbortController|fetchJson/, 10);
console.log('READBACK-DONE');
