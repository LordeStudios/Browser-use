'use strict';
// TextVision analysis: dominant colors, regions (flat-color blocks), edges, gradient, quality flags.
const { rgbToHex, luminance } = require('./color');

function px(img, x, y) { const o = (y * img.width + x) * 4; const d = img.data; return [d[o], d[o + 1], d[o + 2], d[o + 3]]; }

function dominantColors(img, k = 8, quant = 32) {
  const m = new Map(); const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    const key = ((d[i] / quant | 0) << 16) | ((d[i + 1] / quant | 0) << 8) | (d[i + 2] / quant | 0);
    let e = m.get(key); if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; m.set(key, e); }
    e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2];
  }
  const total = img.width * img.height;
  return [...m.values()].sort((a, b) => b.n - a.n).slice(0, k).map(e => ({
    hex: rgbToHex(Math.round(e.r / e.n), Math.round(e.g / e.n), Math.round(e.b / e.n)),
    pct: +(100 * e.n / total).toFixed(2)
  }));
}

// Grid of cells, each with mean color + variance; adjacent similar cells merge into regions.
function gridCells(img, cols, rows) {
  const cells = [];
  for (let gy = 0; gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    const x0 = Math.floor(gx * img.width / cols), x1 = Math.floor((gx + 1) * img.width / cols);
    const y0 = Math.floor(gy * img.height / rows), y1 = Math.floor((gy + 1) * img.height / rows);
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(img, x, y); r += p[0]; g += p[1]; b += p[2]; n++; }
    n = n || 1; const mr = r / n, mg = g / n, mb = b / n;
    let v = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = px(img, x, y); v += (p[0] - mr) ** 2 + (p[1] - mg) ** 2 + (p[2] - mb) ** 2; }
    cells.push({ gx, gy, x0, y0, x1, y1, rgb: [Math.round(mr), Math.round(mg), Math.round(mb)], variance: +(v / n / 3).toFixed(1) });
  }
  return cells;
}

function regions(img, cols = 16, rows = 16, tol = 24) {
  const cells = gridCells(img, cols, rows); const seen = new Array(cells.length).fill(false); const out = [];
  const near = (a, b) => Math.abs(a.rgb[0] - b.rgb[0]) + Math.abs(a.rgb[1] - b.rgb[1]) + Math.abs(a.rgb[2] - b.rgb[2]) <= tol;
  for (let i = 0; i < cells.length; i++) {
    if (seen[i]) continue; seen[i] = true;
    const st = [i], members = [];
    while (st.length) {
      const c = cells[st.pop()]; members.push(c);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = c.gx + dx, ny = c.gy + dy; if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx; if (!seen[j] && near(cells[i], cells[j])) { seen[j] = true; st.push(j); }
      }
    }
    const x0 = Math.min(...members.map(c => c.x0)), y0 = Math.min(...members.map(c => c.y0));
    const x1 = Math.max(...members.map(c => c.x1)), y1 = Math.max(...members.map(c => c.y1));
    out.push({ hex: rgbToHex(...cells[i].rgb), bbox: [x0, y0, x1, y1], cells: members.length, area_pct: +(100 * members.length / cells.length).toFixed(1) });
  }
  return out.sort((a, b) => b.cells - a.cells);
}

function edgeMap(img) {
  const { width: w, height: h } = img; let strong = 0, sum = 0;
  const gray = (x, y) => { const p = px(img, x, y); return 0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]; };
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const gx = gray(x + 1, y) - gray(x - 1, y), gy = gray(x, y + 1) - gray(x, y - 1);
    const m = Math.hypot(gx, gy); sum += m; if (m > 48) strong++;
  }
  const n = Math.max(1, (w - 2) * (h - 2));
  return { edge_density_pct: +(100 * strong / n).toFixed(2), mean_gradient: +(sum / n).toFixed(2) };
}

function gradientDirection(img) {
  const { width: w, height: h } = img; let L = 0, R = 0, T = 0, B = 0, nl = 0, nt = 0;
  const lum = (x, y) => { const p = px(img, x, y); return luminance(p[0], p[1], p[2]); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = lum(x, y); if (x < w / 2) L += v; else R += v; if (y < h / 2) T += v; else B += v; }
  const half = Math.max(1, w * h / 2);
  const dx = (R - L) / half, dy = (B - T) / half;
  return { horizontal: +dx.toFixed(3), vertical: +dy.toFixed(3), kind: Math.abs(dx) < 0.02 && Math.abs(dy) < 0.02 ? 'none' : Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'dark-to-light left-to-right' : 'light-to-dark left-to-right') : (dy > 0 ? 'dark-to-light top-to-bottom' : 'light-to-dark top-to-bottom') };
}

function quality(img, dom) {
  const flags = []; const d = img.data; let sum = 0, tr = 0, n = img.width * img.height;
  for (let i = 0; i < d.length; i += 4) { sum += luminance(d[i], d[i + 1], d[i + 2]); if (d[i + 3] < 255) tr++; }
  const mean = sum / n;
  if (mean < 0.08) flags.push('very-dark'); if (mean > 0.92) flags.push('very-bright');
  if (dom.length && dom[0].pct > 95) flags.push('nearly-uniform');
  if (tr > 0) flags.push('has-transparency');
  if (n < 64) flags.push('tiny-image');
  return { mean_luminance: +mean.toFixed(3), flags };
}

function analyze(img, opts = {}) {
  const dominant = dominantColors(img, opts.colors || 8);
  return {
    width: img.width, height: img.height, aspect: +(img.width / img.height).toFixed(3),
    dominant, regions: regions(img, opts.cols || 16, opts.rows || 16, opts.tol || 24),
    edges: edgeMap(img), gradient: gradientDirection(img), quality: quality(img, dominant)
  };
}

module.exports = { analyze, dominantColors, gridCells, regions, edgeMap, gradientDirection, quality };
