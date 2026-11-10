import { readFileSync, writeFileSync } from 'node:fs';

const file = 'cli/tui/App.mjs';
let s = readFileSync(file, 'utf8');

let changes = 0;

// 1. Fix header logo: replace the underscore variant
const oldHeader = "'\u25b8_ browser-use'";
const newHeader = "'\u25b8 browser-use'";
if (s.includes(oldHeader)) {
  s = s.replace(oldHeader, newHeader);
  changes++;
  console.log('[OK] Header logo fixed');
} else {
  console.log('[SKIP] Header logo already fixed or not found');
}

// 2. Replace '=' separator bars with box-drawing chars
const oldBar = "'='.repeat(Math.max(8, cols - 2))";
const newBar = "'\u2500'.repeat(Math.max(8, cols - 2))";
const barCount = s.split(oldBar).length - 1;
if (barCount > 0) {
  s = s.replaceAll(oldBar, newBar);
  changes++;
  console.log(`[OK] Replaced ${barCount} '=' bar(s) with '\u2500'`);
} else {
  console.log('[SKIP] No = bars found');
}

// 3. Change bar color from AccentDim to border.default
const oldBarColor = "h(Text, { color: theme.AccentDim }, '\u2500'.repeat(Math.max(8, cols - 2)))";
const newBarColor = "h(Text, { color: theme.border.default }, '\u2500'.repeat(Math.max(8, cols - 2)))";
const colorCount = s.split(oldBarColor).length - 1;
if (colorCount > 0) {
  s = s.replaceAll(oldBarColor, newBarColor);
  changes++;
  console.log(`[OK] Recolored ${colorCount} bar(s)`);
} else {
  console.log('[SKIP] No AccentDim bars to recolor');
}

writeFileSync(file, s);
console.log(`\nDone. ${changes} change(s) applied.`);
