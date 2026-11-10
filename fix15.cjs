// fix15.cjs — a verified, accepted browser_done must END the run: the run loop
// currently re-decides (extra provider calls) after run.result/run.status are
// terminal. Guards are self-locating and fail-safe (no anchor -> no change).
const fs = require('fs');
const p = 'desktop/agent/desktopChatAgent.cjs';
let src = fs.readFileSync(p, 'utf8');
const orig = src;
const notes = [];

// Transform A: never start another provider decision once the run is terminal.
{
  const re = /^(\s*)const completed = await Promise\.resolve\(this\.withDecisionWatchdog\(/gm;
  const hits = [...src.matchAll(re)];
  if (hits.length === 1) {
    const indent = hits[0][1];
    src = src.replace(re,
      indent + 'if (run.result || run.status !== \'running\') break; // fix15: an accepted done is terminal - never re-decide after it\n' +
      indent + 'const completed = await Promise.resolve(this.withDecisionWatchdog(');
    notes.push('APPLIED A x1 (guard before provider decision)');
  } else {
    notes.push('SKIPPED A: anchor count ' + hits.length + ' (need exactly 1)');
  }
}

// Transform B: the post-decision check must also honor an already-set result.
{
  const re2 = /^(\s*)if \(run\.status !== 'running'\) break;/gm;
  const hits2 = [...src.matchAll(re2)];
  if (hits2.length >= 1) {
    src = src.replace(re2, "$1if (run.status !== 'running' || run.result) break;");
    notes.push('APPLIED B x' + hits2.length);
  } else {
    notes.push('SKIPPED B: no anchor');
  }
}

if (src === orig) {
  console.log('NO-CHANGE');
  console.log(notes.join('\n'));
  process.exit(1);
}
fs.writeFileSync(p, src);
// READ-BACKS FIRST
const lines = src.split(/\r?\n/);
const show = (frag) => {
  const i = lines.findIndex((l) => l.includes(frag));
  console.log(i >= 0 ? (i + 1) + ': ' + lines[i] : 'MISSING: ' + frag);
};
show('fix15: an accepted done is terminal');
show('|| run.result) break;');
console.log(notes.join('\n'));
console.log('WROTE ' + p);
