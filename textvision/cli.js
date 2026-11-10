#!/usr/bin/env node
'use strict';
const fs = require('fs');
const png = require('./lib/png');
const f = require('./lib/format');
const tvf = require('./lib/tvf');

function load(p) {
  const buf = fs.readFileSync(p);
  return png.decodeImage(buf);
}
const [cmd, file, a, b, c, d] = process.argv.slice(2);
try {
  if (cmd === 'encode') {
    const e = f.encode(load(file), a || 'standard', { rle: false });
    console.log(e.text);
  } else if (cmd === 'inspect') {
    console.log(JSON.stringify(f.inspect(load(file), [a, b, c, d].map(Number)), null, 1));
  } else if (cmd === 'bench') {
    const img = load(file);
    for (const m of Object.keys(f.MODES)) {
      const e = f.encode(img, m);
      console.log(m, 'tokens~' + e.tokensApprox, JSON.stringify(f.metrics(img, f.reconstruct(e.text))));
    }
  } else if (cmd === 'tvf') {
    const img = load(file);
    const e = tvf.encodeTVF(img, { mode: a || 'standard' });
    console.log(e.text);
    console.error('// tokens~' + e.tokensApprox + ' rects=' + e.rects.length + ' texts=' + e.texts.length);
  } else if (cmd === 'svg') {
    const img = load(file);
    console.log(tvf.toSVG(tvf.decodeTVF(tvf.encodeTVF(img, { mode: a || 'standard' }).text)));
  } else {
    console.log('usage: cli.js encode|bench <png> [mode]  |  inspect <png> x0 y0 x1 y1  |  tvf|svg <png> [mode]');
    process.exit(1);
  }
} catch (e) { console.error('error:', e.message); process.exit(2); }
