'use strict';
const assert = require('assert');
const png = require('./lib/png');
const f = require('./lib/format');
const color = require('./lib/color');
const tvf = require('./lib/tvf');
const inc = require('./lib/incremental');
const canvas = require('./lib/canvas');
const fallback = require('./lib/fallback');

function mk(w, h, fn) { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y), o = (y * w + x) * 4; d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255; } return { width: w, height: h, data: d }; }
let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('hex', () => assert.strictEqual(color.rgbToHex(40, 120, 255), '#2878FF'));
t('png roundtrip', () => { const i = mk(8, 8, (x, y) => [x * 30, y * 30, 7]); const r = png.decodeImage(png.encodePng(i)); assert.deepStrictEqual(Buffer.from(r.data), Buffer.from(i.data)); });
t('flat image exact', () => { const i = mk(20, 20, () => [10, 20, 30]); const e = f.encode(i, 'overview'); assert.strictEqual(f.metrics(i, f.reconstruct(e.text)).mse, 0); });
t('two-color split', () => { const i = mk(40, 40, (x) => x < 20 ? [255, 0, 0] : [0, 0, 255]); const e = f.encode(i, 'standard'); assert.ok(/AAAA/.test(e.text) || /BBBB/.test(e.text)); assert.strictEqual(f.metrics(i, f.reconstruct(e.text)).mse, 0); });
t('exact mode lossless', () => { const i = mk(16, 16, (x, y) => [(x % 6) * 50, (y % 6) * 50, 90]); assert.strictEqual(f.metrics(i, f.reconstruct(f.encode(i, 'exact').text)).mse, 0); });
t('token budget grows with mode', () => { const i = mk(64, 64, (x, y) => [x * 4, y * 4, 0]); assert.ok(f.encode(i, 'overview').tokensApprox < f.encode(i, 'detailed').tokensApprox); });
t('decode header', () => { const e = f.encode(mk(10, 10, () => [1, 2, 3]), 'overview'); assert.strictEqual(f.decode(e.text).width, 10); });
t('inspect region', () => { const i = mk(40, 40, (x) => x < 20 ? [255, 0, 0] : [0, 0, 255]); const r = f.inspect(i, [0, 0, 20, 20], 4); assert.strictEqual(r.cells.length, 16); assert.ok(r.cells.every(c => c.hex === '#FF0000')); });
t('tvf header + primitives', () => { const i = mk(40, 40, (x) => x < 20 ? [255, 0, 0] : [0, 0, 255]); const e = tvf.encodeTVF(i, {}); assert.ok(e.text.startsWith('TVF/1\n')); assert.ok(/IMAGE 40x40/.test(e.text)); assert.ok(/RECT /.test(e.text)); assert.ok(e.text.endsWith('END')); });
t('tvf decode roundtrip', () => { const i = mk(40, 40, (x) => x < 20 ? [255, 0, 0] : [0, 0, 255]); const d = tvf.decodeTVF(tvf.encodeTVF(i, {}).text); assert.strictEqual(d.width, 40); assert.strictEqual(d.height, 40); assert.ok(d.rects.length >= 1); });
t('tvf to svg valid', () => { const i = mk(40, 40, (x) => x < 20 ? [255, 0, 0] : [0, 0, 255]); const svg = tvf.toSVG(tvf.decodeTVF(tvf.encodeTVF(i, {}).text)); assert.ok(svg.startsWith('<svg')); assert.ok(svg.endsWith('</svg>')); assert.ok(/<rect/.test(svg)); });
t('tvf rel containment', () => { const i = mk(40, 40, (x, y) => (x >= 10 && x < 30 && y >= 10 && y < 30) ? [0, 0, 255] : [255, 0, 0]); const e = tvf.encodeTVF(i, {}); assert.ok(/REL /.test(e.text)); });
t('incremental diff detects change', () => { const a = mk(20, 20, () => [10, 20, 30]); const b = mk(20, 20, (x, y) => (x >= 5 && x < 10 && y >= 5 && y < 10) ? [255, 0, 0] : [10, 20, 30]); const d = inc.diff(a, b); assert.strictEqual(d.changed, true); assert.deepStrictEqual(d.bbox, [5, 5, 10, 10]); });
t('incremental diff unchanged', () => { const a = mk(20, 20, () => [10, 20, 30]); const d = inc.diff(a, mk(20, 20, () => [10, 20, 30])); assert.strictEqual(d.changed, false); assert.strictEqual(d.bbox, null); });
t('incremental region index', () => { const i = mk(32, 32, (x) => x < 16 ? [255, 0, 0] : [0, 0, 255]); const r = inc.regionIndex(i, 16); assert.strictEqual(r.cols, 2); assert.strictEqual(r.rows, 2); assert.strictEqual(r.cells.length, 4); assert.strictEqual(r.cells[0].hex, '#FF0000'); assert.strictEqual(r.cells[1].hex, '#0000FF'); });
t('canvas raster<->viewBox roundtrip', () => { const p = canvas.rasterToViewBox(10, 20, 100, 200); const q = canvas.viewBoxToRaster(p.x, p.y, 100, 200); assert.strictEqual(q.x, 10); assert.strictEqual(q.y, 20); });
t('canvas raster<->display roundtrip', () => { const p = canvas.rasterToDisplay(50, 50, 100, 100, 200, 200); const q = canvas.displayToRaster(p.x, p.y, 100, 100, 200, 200); assert.strictEqual(q.x, 50); assert.strictEqual(q.y, 50); });
t('canvas rect to viewBox', () => { const r = canvas.rectToViewBox({ x: 0, y: 0, w: 50, h: 50 }, 100, 100); assert.strictEqual(r.x, 0); assert.strictEqual(r.y, 0); assert.strictEqual(r.w, 50); assert.strictEqual(r.h, 50); });
t('fallback activates for text-only model', () => { assert.strictEqual(fallback.supportsNativeVision({ vision: false }), false); const d = fallback.shouldUseTextVision({ vision: false }, { type: 'image' }); assert.strictEqual(d.useTextVision, true); });
t('fallback skips native vision model', () => { assert.strictEqual(fallback.supportsNativeVision({ vision: true }), true); const d = fallback.shouldUseTextVision({ vision: true }, { type: 'image' }); assert.strictEqual(d.useTextVision, false); });
t('fallback wraps tvf block', () => { const b = fallback.toTextVisionBlock('TVF/1\nEND', { width: 10, height: 10, mode: 'overview' }); assert.strictEqual(b.type, 'text'); assert.ok(b.text.startsWith('TEXTVISION/1\n')); assert.strictEqual(b.meta.textvision, true); });
console.log(n + ' tests passed');

