'use strict';
// Incremental updates: frame differencing + region index.
// Detects the changed bounding region between two frames without full reprocessing.

// Compare two RGBA images; return { changed, bbox, changedPixels, pct }.
// bbox is [x0, y0, x1, y1] in original pixel coords, or null when unchanged.
function diff(a, b, tolerance = 0) {
  if (a.width !== b.width || a.height !== b.height) {
    return { changed: true, bbox: [0, 0, Math.max(a.width, b.width), Math.max(a.height, b.height)], changedPixels: -1, pct: 1, sizeChanged: true };
  }
  let minX = a.width, minY = a.height, maxX = -1, maxY = -1, changedPixels = 0;
  const da = a.data, db = b.data;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const o = (y * a.width + x) * 4;
      if (Math.abs(da[o] - db[o]) > tolerance || Math.abs(da[o + 1] - db[o + 1]) > tolerance || Math.abs(da[o + 2] - db[o + 2]) > tolerance || Math.abs(da[o + 3] - db[o + 3]) > tolerance) {
        changedPixels++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (changedPixels === 0) return { changed: false, bbox: null, changedPixels: 0, pct: 0 };
  return { changed: true, bbox: [minX, minY, maxX + 1, maxY + 1], changedPixels, pct: changedPixels / (a.width * a.height) };
}

// Region index: divide an image into a grid of cells; each cell records its dominant color.
// Returns cells with original pixel coords so a changed region can be re-encoded locally.
function regionIndex(img, cellSize = 16) {
  const cells = [];
  const cols = Math.ceil(img.width / cellSize), rows = Math.ceil(img.height / cellSize);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cellSize, y0 = cy * cellSize;
      const x1 = Math.min(x0 + cellSize, img.width), y1 = Math.min(y0 + cellSize, img.height);
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const o = (y * img.width + x) * 4;
        r += img.data[o]; g += img.data[o + 1]; b += img.data[o + 2]; n++;
      }
      cells.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, hex: '#' + [r, g, b].map(v => Math.round(v / n).toString(16).padStart(2, '0')).join('').toUpperCase() });
    }
  }
  return { cellSize, cols, rows, cells };
}

module.exports = { diff, regionIndex };
