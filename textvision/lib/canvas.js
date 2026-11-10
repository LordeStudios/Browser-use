'use strict';
// Coordinate transforms for graphical application compatibility.
// Maps between raster pixel coords, SVG viewBox coords, and display coords.

// Raster pixel -> SVG viewBox coords (viewBox is 0..w, 0..h by default).
function rasterToViewBox(x, y, imgW, imgH, viewBox) {
  const vb = viewBox || { x: 0, y: 0, w: imgW, h: imgH };
  return { x: vb.x + (x / imgW) * vb.w, y: vb.y + (y / imgH) * vb.h };
}

// SVG viewBox -> raster pixel coords.
function viewBoxToRaster(x, y, imgW, imgH, viewBox) {
  const vb = viewBox || { x: 0, y: 0, w: imgW, h: imgH };
  return { x: Math.round(((x - vb.x) / vb.w) * imgW), y: Math.round(((y - vb.y) / vb.h) * imgH) };
}

// Raster pixel -> display coords (CSS pixels within a rendered element of size dispW x dispH).
function rasterToDisplay(x, y, imgW, imgH, dispW, dispH) {
  return { x: (x / imgW) * dispW, y: (y / imgH) * dispH };
}

// Display coords -> raster pixel coords.
function displayToRaster(x, y, imgW, imgH, dispW, dispH) {
  return { x: Math.round((x / dispW) * imgW), y: Math.round((y / dispH) * imgH) };
}

// A rect in raster coords -> SVG rect in viewBox coords.
function rectToViewBox(rect, imgW, imgH, viewBox) {
  const a = rasterToViewBox(rect.x, rect.y, imgW, imgH, viewBox);
  const b = rasterToViewBox(rect.x + rect.w, rect.y + rect.h, imgW, imgH, viewBox);
  return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
}

module.exports = { rasterToViewBox, viewBoxToRaster, rasterToDisplay, displayToRaster, rectToViewBox };
