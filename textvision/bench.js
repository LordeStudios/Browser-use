'use strict';
// TextVision benchmark suite: runs encode/decode/reconstruct across image types
// and reports token counts, timing, and reconstruction fidelity per mode.
const fs = require('fs');
const path = require('path');
const { encodeTVF, decodeTVF, toSVG, reconstructTVF, metricsTVF, MODES } = require('./lib/tvf');
const { encodePng, decodeImage } = require('./lib/png');

// --- Synthetic fixtures -----------------------------------------------------
function flat(w, h, r, g, b) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = 255; }
  return { width: w, height: h, data };
}
function gradient(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    data[o] = Math.round(255 * x / w); data[o + 1] = Math.round(255 * y / h); data[o + 2] = 128; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}
function twoColor(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    const left = x < w / 2;
    data[o] = left ? 255 : 0; data[o + 1] = left ? 0 : 255; data[o + 2] = 0; data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}
function textLike(w, h) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = 240; data[i + 1] = 240; data[i + 2] = 240; data[i + 3] = 255; }
  // Simulate a few dark glyph strokes.
  for (let y = 20; y < 40; y++) for (let x = 20; x < 200; x++) {
    const o = (y * w + x) * 4; data[o] = 20; data[o + 1] = 20; data[o + 2] = 20;
  }
  for (let y = 60; y < 80; y++) for (let x = 20; x < 160; x++) {
    const o = (y * w + x) * 4; data[o] = 20; data[o + 1] = 20; data[o + 2] = 20;
  }
  return { width: w, height: h, data };
}

// --- Benchmark one image ----------------------------------------------------
function benchImage(name, img) {
  const rows = [];
  for (const mode of Object.keys(MODES)) {
    const t0 = process.hrtime.bigint();
    const enc = encodeTVF(img, { mode });
    const t1 = process.hrtime.bigint();
    const dec = decodeTVF(enc.text);
    const svg = toSVG(dec);
    const rec = reconstructTVF(dec);
    const m = metricsTVF(img, rec);
    const ms = Number(t1 - t0) / 1e6;
    rows.push({
      mode, tokens: enc.tokensApprox, chars: enc.text.length,
      rects: dec.rects.length, texts: dec.texts.length,
      ms: +ms.toFixed(2), svgLen: svg.length,
      mse: m.mse, psnr: m.psnr, meanDeltaE: m.meanDeltaE
    });
  }
  return { name, width: img.width, height: img.height, rows };
}

// --- Main -------------------------------------------------------------------
const fixtures = [];
const shot = path.join(__dirname, 'shot.png');
if (fs.existsSync(shot)) {
  fixtures.push(['shot.png', decodeImage(fs.readFileSync(shot))]);
}
fixtures.push(['flat 64x64', flat(64, 64, 200, 30, 30)]);
fixtures.push(['gradient 64x64', gradient(64, 64)]);
fixtures.push(['two-color 64x64', twoColor(64, 64)]);
fixtures.push(['text-like 64x64', textLike(64, 64)]);

const results = fixtures.map(([n, img]) => benchImage(n, img));

// --- Report -----------------------------------------------------------------
console.log('TextVision benchmark');
console.log('====================');
for (const r of results) {
  console.log(`\n${r.name} (${r.width}x${r.height})`);
  console.log('  mode      tokens  chars  rects  texts    ms   svgLen   mse    psnr   dE');
  for (const row of r.rows) {
    console.log(
      `  ${row.mode.padEnd(9)} ${String(row.tokens).padStart(6)} ${String(row.chars).padStart(6)} ` +
      `${String(row.rects).padStart(5)} ${String(row.texts).padStart(5)} ${String(row.ms).padStart(6)} ` +
      `${String(row.svgLen).padStart(7)} ${String(row.mse).padStart(6)} ${String(row.psnr).padStart(6)} ${String(row.meanDeltaE).padStart(5)}`
    );
  }
}

// --- Summary assertions -----------------------------------------------------
let ok = true;
for (const r of results) {
  const ov = r.rows.find(x => x.mode === 'overview');
  if (ov && ov.tokens >= 200) { console.error(`FAIL: ${r.name} overview tokens ${ov.tokens} >= 200`); ok = false; }
  for (const row of r.rows) {
    if (!(row.svgLen > 0)) { console.error(`FAIL: ${r.name} ${row.mode} svg empty`); ok = false; }
    // psnr 'inf' means perfect reconstruction (zero MSE) — that is a PASS.
    if (row.psnr !== 'inf' && (typeof row.psnr !== 'number' || row.psnr < 0)) { console.error(`FAIL: ${r.name} ${row.mode} psnr ${row.psnr}`); ok = false; }
  }
}
console.log(ok ? '\nBENCH OK' : '\nBENCH FAIL');
process.exit(ok ? 0 : 1);
