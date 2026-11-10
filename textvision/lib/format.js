'use strict';
// TEXTVISION/1.0 encoder/decoder, INSPECT, reconstruction + metrics.
const { analyze, gridCells, dominantColors } = require('./analyze');
const { rgbToHex, hexToRgb, deltaERgb, luminance } = require('./color');

const MODES = {
  overview: { cols: 8, rows: 8, colors: 8 },
  standard: { cols: 24, rows: 24, colors: 16 },
  detailed: { cols: 64, rows: 64, colors: 32 },
  exact: { cols: 0, rows: 0, colors: 0 } // cols/rows = full resolution
};
const SYM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

// Palette from the raw-pixel dominant-color quantizer, so bright/colored elements
// (white text, amber buttons, lime accents) are always represented instead of being
// drowned out by the dark background when only grid-cell means are used.
function buildPalette(img, max) {
  const dom = dominantColors(img, max);
  return { palette: dom.map(d => hexToRgb(d.hex)), quantized: dom.length >= max };
}

function nearest(palette, rgb) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < palette.length; i++) {
    const d = (palette[i][0] - rgb[0]) ** 2 + (palette[i][1] - rgb[1]) ** 2 + (palette[i][2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function rle(row) {
  let out = '', i = 0;
  while (i < row.length) { let j = i; while (j < row.length && row[j] === row[i]) j++; out += (j - i > 1 ? (j - i) : '') + row[i]; i = j; }
  return out;
}
function unrle(s) {
  let out = '', n = '';
  for (const ch of s) { if (ch >= '0' && ch <= '9' && !SYM.slice(0, 0)) { /* digits are symbols too */ } out += ch; }
  return out;
}

function encode(img, mode = 'standard', opts = {}) {
  const spec = MODES[mode]; if (!spec) throw new Error('Unknown mode ' + mode);
  const cols = mode === 'exact' ? img.width : Math.min(spec.cols, img.width);
  const rows = mode === 'exact' ? img.height : Math.min(spec.rows, img.height);
  const cells = gridCells(img, cols, rows);
  const maxColors = Math.min(mode === 'exact' ? 62 : spec.colors, SYM.length);
  const { palette, quantized } = buildPalette(img, maxColors);
  const idx = cells.map(c => nearest(palette, c.rgb));
  const an = analyze(img, { colors: 5, cols: 8, rows: 8 });
  const bright = cells.filter(c => luminance(...c.rgb) > 0.5).length;
  const texty = cells.filter(c => c.variance > 400).length;
  const lines = ['TEXTVISION/1.0', `SIZE ${img.width}x${img.height} MODE ${mode} GRID ${cols}x${rows}${quantized ? ' QUANTIZED' : ''}`,
    'PALETTE ' + palette.map((p, i) => SYM[i] + '=' + rgbToHex(...p)).join(' '),
    'SUMMARY dominant=' + an.dominant.slice(0, 5).map(d => d.hex + ':' + d.pct + '%').join(',') +
    ` edges=${an.edges.edge_density_pct}% gradient=${an.gradient.kind} lum=${an.quality.mean_luminance}` + (an.quality.flags.length ? ' flags=' + an.quality.flags.join(',') : '') +
    ` blocks bright=${bright} text=${texty}`,
    'GRID'];
  for (let y = 0; y < rows; y++) {
    let row = ''; for (let x = 0; x < cols; x++) row += SYM[idx[y * cols + x]];
    lines.push(opts.rle ? rle(row) : row);
  }
  lines.push('END');
  const text = lines.join('\n');
  return { text, tokensApprox: Math.ceil(text.length / 4), mode, cols, rows, palette: palette.map(p => rgbToHex(...p)) };
}

function decode(text) {
  const L = text.split(/\r?\n/);
  if (L[0] !== 'TEXTVISION/1.0') throw new Error('Not TEXTVISION/1.0');
  const m = /SIZE (\d+)x(\d+) MODE (\w+) GRID (\d+)x(\d+)/.exec(L[1]);
  if (!m) throw new Error('Bad header');
  const pal = {}; for (const t of L[2].replace('PALETTE ', '').split(' ')) { const [k, v] = t.split('='); pal[k] = hexToRgb(v); }
  const gi = L.indexOf('GRID'); const cols = +m[4], rows = +m[5];
  const grid = L.slice(gi + 1, gi + 1 + rows);
  return { width: +m[1], height: +m[2], mode: m[3], cols, rows, pal, grid };
}

function reconstruct(text) {
  const d = decode(text); const out = new Uint8Array(d.width * d.height * 4);
  for (let y = 0; y < d.height; y++) for (let x = 0; x < d.width; x++) {
    const gx = Math.min(d.cols - 1, Math.floor(x * d.cols / d.width)), gy = Math.min(d.rows - 1, Math.floor(y * d.rows / d.height));
    const c = d.pal[d.grid[gy][gx]] || [0, 0, 0]; const o = (y * d.width + x) * 4;
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255;
  }
  return { width: d.width, height: d.height, data: out };
}

function metrics(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Size mismatch');
  let se = 0, de = 0, n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) se += (a.data[i + k] - b.data[i + k]) ** 2;
    de += deltaERgb([a.data[i], a.data[i + 1], a.data[i + 2]], [b.data[i], b.data[i + 1], b.data[i + 2]]);
  }
  const mse = se / (n * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  // global SSIM on luminance
  const g = (img) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]; return o; };
  const ga = g(a), gb = g(b); let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += ga[i]; mb += gb[i]; } ma /= n; mb /= n;
  let va = 0, vb = 0, cv = 0; for (let i = 0; i < n; i++) { va += (ga[i] - ma) ** 2; vb += (gb[i] - mb) ** 2; cv += (ga[i] - ma) * (gb[i] - mb); }
  va /= n; vb /= n; cv /= n; const c1 = 6.5025, c2 = 58.5225;
  const ssim = ((2 * ma * mb + c1) * (2 * cv + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
  return { mse: +mse.toFixed(3), psnr: psnr === Infinity ? 'inf' : +psnr.toFixed(2), ssim: +ssim.toFixed(4), meanDeltaE: +(de / n).toFixed(3) };
}

// INSPECT: progressive detail. Query region [x0,y0,x1,y1] in source pixels, returns finer grid of just that area.
function inspect(img, region, cells = 8) {
  const [x0, y0, x1, y1] = region.map(Math.round);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const sub = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, x0 + x), sy = Math.min(img.height - 1, y0 + y);
    const s = (sy * img.width + sx) * 4, o = (y * w + x) * 4; for (let k = 0; k < 4; k++) sub.data[o + k] = img.data[s + k];
  }
  const e = encode(sub, 'standard'); const c = Math.min(cells, w, h);
  const cs = gridCells(sub, c, c);
  return { region: [x0, y0, x1, y1], cells: cs.map(q => ({ at: [x0 + q.x0, y0 + q.y0], hex: rgbToHex(...q.rgb), variance: q.variance })), text: e.text };
}

module.exports = { MODES, encode, decode, reconstruct, metrics, inspect };
