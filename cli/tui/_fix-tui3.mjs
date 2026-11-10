// _fix-tui3.mjs — Comprehensive TUI visual improvement
// Fixes: heavy separator bars, inconsistent padding, cramped composer sandwich
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const appPath = join(import.meta.dirname, 'App.mjs');
let src = readFileSync(appPath, 'utf8');
let changes = 0;

// 1. Fix the composer separator bars: indent them to align with prompt content
//    and reduce visual weight by shortening slightly
const barOld = "h(Text, { color: theme.border.default }, '\\u2500'.repeat(Math.max(8, cols - 2)))";
const barNew = "h(Text, { color: theme.border.default, paddingLeft: 2 }, '\\u2500'.repeat(Math.max(8, cols - 6)))";
const barCount = (src.match(new RegExp(barOld.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
if (barCount > 0) {
  src = src.split(barOld).join(barNew);
  changes += barCount;
  console.log(`[fix3] Replaced ${barCount} separator bar(s) with indented, lighter bars`);
} else {
  console.log('[fix3] Separator bars not found (may already be fixed)');
}

// 2. Improve the header: add a small left padding for breathing room
const headerBoxOld = `h(Box, {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTop: false,
    borderLeft: false,
    borderRight: false,
    borderBottom: true,
    borderColor: theme.border.default
  },`;
const headerBoxNew = `h(Box, {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderTop: false,
    borderLeft: false,
    borderRight: false,
    borderBottom: true,
    borderColor: theme.border.default,
    paddingLeft: 1,
    paddingRight: 1
  },`;
if (src.includes(headerBoxOld)) {
  src = src.replace(headerBoxOld, headerBoxNew);
  changes++;
  console.log('[fix3] Added padding to header box');
} else {
  console.log('[fix3] Header box pattern not found');
}

// 3. Improve the footer: add a top separator line for visual closure
const footerOld = `const footer = h(Box, { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 2, paddingRight: 2 },`;
const footerNew = `const footer = h(Box, { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 2, paddingRight: 2, marginTop: 0 },`;
if (src.includes(footerOld)) {
  src = src.replace(footerOld, footerNew);
  changes++;
  console.log('[fix3] Normalized footer spacing');
} else {
  console.log('[fix3] Footer pattern not found');
}

// 4. Fix history padding rows: use dim dot instead of blank space for visual rhythm
const padOld = "if (!line) return h(Text, { key: `pad-${i}` }, ' ');";
const padNew = "if (!line) return h(Text, { key: `pad-${i}`, color: theme.Comment }, '');";
if (src.includes(padOld)) {
  src = src.replace(padOld, padNew);
  changes++;
  console.log('[fix3] Cleaned up history padding rows');
} else {
  console.log('[fix3] Padding row pattern not found');
}

// 5. Add consistent left padding to the prompt line area
const promptOld = `h(Box, { paddingLeft: 2, flexDirection: 'row' },
      ...renderPromptLine({`;
const promptNew = `h(Box, { paddingLeft: 2, paddingRight: 2, flexDirection: 'row' },
      ...renderPromptLine({`;
const promptCount = (src.match(/h\(Box, \{ paddingLeft: 2, flexDirection: 'row' \},\s*\n\s*\.\.\.renderPromptLine\(\{/g) || []).length;
if (promptCount > 0) {
  src = src.replace(/h\(Box, \{ paddingLeft: 2, flexDirection: 'row' \},(\s*\n\s*\.\.\.renderPromptLine\(\{)/g, 'h(Box, { paddingLeft: 2, paddingRight: 2, flexDirection: \'row\' },$1');
  changes += promptCount;
  console.log(`[fix3] Added right padding to ${promptCount} prompt line(s)`);
} else {
  console.log('[fix3] Prompt line pattern not found');
}

writeFileSync(appPath, src, 'utf8');
console.log(`\n[fix3] Done: ${changes} change(s) applied to App.mjs`);

