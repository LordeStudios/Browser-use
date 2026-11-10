'use strict';
// TVF/1 — TextVision Format: compact geometric primitives for text-only LLMs.
// Deterministic, token-lean, and decodable back to SVG. Mirrors the spec example:
//   TVF/1
//   IMAGE 1920x1080 sRGB
//   BACKGROUND #18243A
//   RECT R1 300,120 1200x800 #FFFFFF
//   TEXT R3 "Install" center=970,767 color=#FFFFFF
//   REL R2 inside R1
const { analyze, regions, gridCells } = require('./analyze');
const { rgbToHex, hexToRgb, luminance, deltaERgb } = require('./color');

// Progressive detail levels: coarser grid + higher thresholds = fewer primitives.
const MODES = {
  overview:  { cols: 8,  rows: 8,  tol: 40, minArea: 3.0, variance: 1500, maxRects: 8,  maxTexts: 8 },
  standard:  { cols: 16, rows: 16, tol: 24, minArea: 0.4, variance: 400,  maxRects: 64, maxTexts: 200 },
  detailed:  { cols: 24, rows: 24, tol: 16, minArea: 0.2, variance: 200,  maxRects: 200, maxTexts: 400 }
};

// Content-aware vectorization: flat-color rectangular regions from region analysis.
function vectorize(img, opts = {}) {
  const cols = opts.cols || 16, rows = opts.rows || 16, tol = opts.tol || 24;
  const regs = regions(img, cols, rows, tol);
  const minArea = opts.minArea || 0.4; // percent of cells
  return regs.filter(r => r.area_pct >= minArea).map((r, i) => ({
    id: 'R' + (i + 1),
    x: r.bbox[0], y: r.bbox[1], w: r.bbox[2] - r.bbox[0], h: r.bbox[3] - r.bbox[1],
    hex: r.hex, area_pct: r.area_pct
  }));
}

// Text-like cells: high variance (detail) within a small area -> typography hint.
function detectText(img, opts = {}) {
  const cols = opts.cols || 24, rows = opts.rows || 24;
  const cells = gridCells(img, cols, rows);
  const thr = opts.variance || 400;
  return cells.filter(c => c.variance > thr).map((c, i) => ({
    id: 'T' + (i + 1),
    x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0,
    hex: rgbToHex(...c.rgb), variance: c.variance
  }));
}

function encodeTVF(img, opts = {}) {
  const mode = MODES[opts.mode] ? opts.mode : 'standard';
  const o = Object.assign({}, MODES[mode], opts);
  let rects = vectorize(img, o);
  let texts = detectText(img, o);
  // Keep the most significant primitives so overview stays token-lean.
  rects = rects.sort((a, b) => b.area_pct - a.area_pct).slice(0, o.maxRects || 200);
  texts = texts.sort((a, b) => b.variance - a.variance).slice(0, o.maxTexts || 400);
  const an = analyze(img, { colors: 5, cols: 8, rows: 8 });
  const bg = an.dominant[0] ? an.dominant[0].hex : '#000000';
  const lines = ['TVF/1', `IMAGE ${img.width}x${img.height} sRGB`, `BACKGROUND ${bg}`, `MODE ${mode}`];
  for (const r of rects) lines.push(`RECT ${r.id} ${r.x},${r.y} ${r.w}x${r.h} ${r.hex}`);
  for (const t of texts) lines.push(`TEXT ${t.id} ${t.x},${t.y} ${t.w}x${t.h} ${t.hex}`);
  // REL: containment relationships (child fully inside parent).
  for (const r of rects) for (const s of rects) {
    if (r.id !== s.id && s.x >= r.x && s.y >= r.y && s.x + s.w <= r.x + r.w && s.y + s.h <= r.y + r.h) {
      lines.push(`REL ${s.id} inside ${r.id}`);
    }
  }
  lines.push('END');
  const text = lines.join('\n');
  return { text, tokensApprox: Math.ceil(text.length / 4), width: img.width, height: img.height, rects, texts, background: bg };
}

function decodeTVF(text) {
  const L = text.split(/\r?\n/);
  if (L[0] !== 'TVF/1') throw new Error('Not TVF/1');
  const m = /IMAGE (\d+)x(\d+)/.exec(L[1]);
  if (!m) throw new Error('Bad IMAGE header');
  const width = +m[1], height = +m[2];
  const bgm = /BACKGROUND (#\w+)/.exec(L[2]);
  const background = bgm ? bgm[1] : '#000000';
  const rects = [], texts = [], rels = [];
  for (const line of L.slice(3)) {
    let mm;
    if ((mm = /^RECT (\S+) (\d+),(\d+) (\d+)x(\d+) (#\w+)/.exec(line))) {
      rects.push({ id: mm[1], x: +mm[2], y: +mm[3], w: +mm[4], h: +mm[5], hex: mm[6] });
    } else if ((mm = /^TEXT (\S+) (\d+),(\d+) (\d+)x(\d+) (#\w+)/.exec(line))) {
      texts.push({ id: mm[1], x: +mm[2], y: +mm[3], w: +mm[4], h: +mm[5], hex: mm[6] });
    } else if ((mm = /^REL (\S+) inside (\S+)/.exec(line))) {
      rels.push({ child: mm[1], parent: mm[2] });
    }
  }
  return { width, height, background, rects, texts, rels };
}

// Deterministic decoder: TVF/1 -> SVG.
function toSVG(tvf) {
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${tvf.width}" height="${tvf.height}" viewBox="0 0 ${tvf.width} ${tvf.height}">`];
  parts.push(`<rect x="0" y="0" width="${tvf.width}" height="${tvf.height}" fill="${tvf.background}"/>`);
  for (const r of tvf.rects) parts.push(`<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${r.hex}"/>`);
  for (const t of tvf.texts) parts.push(`<rect x="${t.x}" y="${t.y}" width="${t.w}" height="${t.h}" fill="${t.hex}" opacity="0.5"/>`);
  parts.push('</svg>');
  return parts.join('\n');
}

// Incremental: frame differencing. Compares two same-size images and reports the
// changed bounding region so only that area needs re-encoding.
function diff(prev, next, tol = 12) {
  if (prev.width !== next.width || prev.height !== next.height) return { changed: true, full: true, bbox: [0, 0, next.width, next.height], changedPixels: next.width * next.height, pct: 100 };
  let x0 = next.width, y0 = next.height, x1 = -1, y1 = -1, changed = 0;
  for (let y = 0; y < next.height; y++) for (let x = 0; x < next.width; x++) {
    const i = (y * next.width + x) * 4;
    const d = Math.abs(prev.data[i] - next.data[i]) + Math.abs(prev.data[i + 1] - next.data[i + 1]) + Math.abs(prev.data[i + 2] - next.data[i + 2]);
    if (d > tol) { changed++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  const n = next.width * next.height;
  if (!changed) return { changed: false, bbox: null, changedPixels: 0, pct: 0 };
  return { changed: true, full: false, bbox: [x0, y0, x1 + 1, y1 + 1], changedPixels: changed, pct: +(100 * changed / n).toFixed(2) };
}

// Progressive detail: crop a region in source pixels and re-encode it at a finer
// grid, returning cells in ORIGINAL image coordinates.
function inspectTVF(img, region, cells = 8) {
  const [x0, y0, x1, y1] = region.map(Math.round);
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const sub = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, x0 + x), sy = Math.min(img.height - 1, y0 + y);
    const s = (sy * img.width + sx) * 4, o = (y * w + x) * 4;
    for (let k = 0; k < 4; k++) sub.data[o + k] = img.data[s + k];
  }
  const c = Math.min(cells, w, h);
  const cs = gridCells(sub, c, c);
  return {
    region: [x0, y0, x1, y1],
    cells: cs.map(q => ({ at: [x0 + q.x0, y0 + q.y0], hex: rgbToHex(...q.rgb), variance: q.variance })),
    tvf: encodeTVF(sub, { mode: 'detailed' })
  };
}

// Reconstruction: rasterize TVF primitives back to pixels (background + rects + texts).
function reconstructTVF(tvf) {
  const out = new Uint8Array(tvf.width * tvf.height * 4);
  const bg = hexToRgb(tvf.background);
  for (let i = 0; i < out.length; i += 4) { out[i] = bg[0]; out[i + 1] = bg[1]; out[i + 2] = bg[2]; out[i + 3] = 255; }
  const fill = (r) => { const c = hexToRgb(r.hex); for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) { if (x < 0 || y < 0 || x >= tvf.width || y >= tvf.height) continue; const o = (y * tvf.width + x) * 4; out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = 255; } };
  for (const r of tvf.rects) fill(r);
  for (const t of tvf.texts) fill(t);
  return { width: tvf.width, height: tvf.height, data: out };
}

// Verification metrics between two reconstructed rasters.
function metricsTVF(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('Size mismatch');
  let se = 0, de = 0; const n = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    for (let k = 0; k < 3; k++) se += (a.data[i + k] - b.data[i + k]) ** 2;
    de += deltaERgb([a.data[i], a.data[i + 1], a.data[i + 2]], [b.data[i], b.data[i + 1], b.data[i + 2]]);
  }
  const mse = se / (n * 3);
  const psnr = mse === 0 ? Infinity : 10 * Math.log10(255 * 255 / mse);
  return { mse: +mse.toFixed(3), psnr: psnr === Infinity ? 'inf' : +psnr.toFixed(2), meanDeltaE: +(de / n).toFixed(3) };
}

// Coordinate transforms for graphical-app compatibility: raster <-> viewBox <-> display.
function transforms(width, height, viewBox = { w: width, h: height }, display = { w: width, h: height }) {
  const sx = viewBox.w / width, sy = viewBox.h / height;
  const dx = display.w / viewBox.w, dy = display.h / viewBox.h;
  return {
    rasterToViewBox: (x, y) => [x * sx, y * sy],
    viewBoxToRaster: (x, y) => [x / sx, y / sy],
    rasterToDisplay: (x, y) => [x * sx * dx, y * sy * dy],
    displayToRaster: (x, y) => [x / (sx * dx), y / (sy * dy)]
  };
}

// Automatic fallback: capability detection. A model that cannot accept native image
// inputs gets TextVision; a native-vision model does not.
function capabilities(model = {}) {
  const nativeVision = !!(model.vision || model.multimodal || model.inputs && model.inputs.includes('image'));
  return { nativeVision, useTextVision: !nativeVision, reason: nativeVision ? 'native vision available' : 'no native image input' };
}

module.exports = { vectorize, detectText, encodeTVF, decodeTVF, toSVG, MODES, diff, inspectTVF, reconstructTVF, metricsTVF, transforms, capabilities };
