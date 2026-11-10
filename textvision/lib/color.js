'use strict';
// TextVision color engine: exact conversions + perceptual difference.
// All functions are deterministic and side-effect free.

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(function (x) {
    return clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  }).join('').toUpperCase();
}

function hexToRgb(hex) {
  let h = String(hex).replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// h in [0,360), s/v in [0,1]
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: h, s: max ? d / max : 0, v: max };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  const d = max - min;
  if (d > 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h: h, s: s, l: l };
}

function srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// WCAG relative luminance
function luminance(r, g, b) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(l1, l2) {
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// CIE Lab (D65)
function rgbToLab(r, g, b) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  let X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  let Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750);
  let Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = function (t) { return t > 0.008856 ? Math.cbrt(t) : (7.787 * t + 16 / 116); };
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}

// CIE76 Delta E. <1 imperceptible, <3 small, >10 clearly different.
function deltaE(lab1, lab2) {
  const dl = lab1[0] - lab2[0], da = lab1[1] - lab2[1], db = lab1[2] - lab2[2];
  return Math.sqrt(dl * dl + da * da + db * db);
}

function deltaERgb(rgb1, rgb2) {
  return deltaE(rgbToLab(rgb1[0], rgb1[1], rgb1[2]), rgbToLab(rgb2[0], rgb2[1], rgb2[2]));
}

function colorInfo(r, g, b, a) {
  const info = {
    hex: rgbToHex(r, g, b),
    rgb: [r, g, b],
    hsv: rgbToHsv(r, g, b),
    hsl: rgbToHsl(r, g, b),
    lab: rgbToLab(r, g, b),
    luminance: luminance(r, g, b)
  };
  if (a !== undefined) info.alpha = a;
  return info;
}

// Gradient stops: n evenly-spaced interpolated colors between two hex colors.
function gradientStops(hex1, hex2, n = 5) {
  const a = hexToRgb(hex1), b = hexToRgb(hex2);
  const stops = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    stops.push(rgbToHex(Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)));
  }
  return stops;
}

module.exports = {
  clamp: clamp,
  rgbToHex: rgbToHex,
  hexToRgb: hexToRgb,
  rgbToHsv: rgbToHsv,
  rgbToHsl: rgbToHsl,
  rgbToLab: rgbToLab,
  luminance: luminance,
  contrastRatio: contrastRatio,
  deltaE: deltaE,
  deltaERgb: deltaERgb,
  colorInfo: colorInfo,
  gradientStops: gradientStops
};
