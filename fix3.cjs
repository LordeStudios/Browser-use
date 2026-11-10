const fs = require('fs');
const cp = require('child_process');
const B = 'C:/Users/london/Desktop/browser-use/browser-use/';
const readLines = (rel) => fs.readFileSync(B + rel, 'utf8').split('\n');
const show = (rel, from, to) => {
  const ls = readLines(rel);
  console.log('=== ' + rel + ' ' + from + '-' + to + ' ===');
  for (let i = from - 1; i < to && i < ls.length; i++) console.log((i + 1) + ': ' + ls[i]);
};

// --- discovery for f3 (the call loop that drops calls after a failure) ---
show('desktop/agent/desktopChatAgent.cjs', 2358, 2420);
show('desktop/agent/desktopChatAgent.cjs', 2840, 2930);

// --- PATCH (f4b): the timeout becomes a UI race, never a cancellation ---
{
  const rel = 'desktop/renderer/pages/artworks-source.js';
  const ls = readLines(rel);
  const start = ls.findIndex(l => l.includes('async function fetchJson(doFetch, url, headers, timeoutMs) {'));
  if (start < 0) { console.log('F4b MARKER NOT FOUND'); process.exit(1); }
  let end = -1;
  for (let i = start + 1; i < ls.length; i++) { if (ls[i] === '  }') { end = i; break; } }
  if (end < 0) { console.log('F4b END NOT FOUND'); process.exit(1); }
  const repl = [
    '  async function fetchJson(doFetch, url, headers, timeoutMs) {',
    '    // The timeout is a UI race, not a cancellation: aborting the request is',
    '    // what surfaced every slow catalog call as net::ERR_ABORTED console noise.',
    '    // The request is left to finish quietly in the background and a late',
    '    // failure is swallowed, so it can never break the caller or the console.',
    '    let timer = null;',
    '    const slow = new Promise((resolve, reject) => {',
    '      timer = setTimeout(() => reject(new Error(\'timeout\')), timeoutMs);',
    '    });',
    '    try {',
    '      const response = await Promise.race([',
    '        doFetch(url, { headers: headers || {} }).catch(() => new Promise(() => {})),',
    '        slow',
    '      ]);',
    '      if (!response || !response.ok) throw new Error(\'HTTP \' + (response ? response.status : \'no response\'));',
    '      return await response.json();',
    '    } finally {',
    '      clearTimeout(timer);',
    '    }',
    '  }'
  ];
  ls.splice(start, end - start + 1, ...repl);
  fs.writeFileSync(B + rel, ls.join('\n'));
  console.log('F4b PATCHED lines', start + 1, '-', end + 1);
  for (let i = start; i < start + 21; i++) console.log((i + 1) + ': ' + ls[i]);
  cp.execSync('node --check "' + B + rel + '"', { stdio: 'inherit' });
  console.log('F4b SYNTAX-OK');
}
console.log('ALL-DONE');
