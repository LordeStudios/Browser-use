// Regression check for the s-stripping defect: inside the
// buildElementCollectorScript template literal, every regex class escape must
// be doubled (\\s) — a single \s in a template literal evaluates to a literal
// "s", turning .replace(/\s+/g) into .replace(/s+/g) and stripping the letter
// "s" from every observed element name and text.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, 'desktop', 'mcp', 'browserViewController.cjs'), 'utf8');
const start = src.indexOf('function buildElementCollectorScript');
const end = src.indexOf('module.exports', start);
const body = src.slice(start, end);
const offenders = [];
body.split('\n').forEach((line, index) => {
  if (line.includes('${')) return; // Node-side interpolation, not page code
  if (/(?<!\\)\\[sdwbDWB][+*?\]}]/.test(line)) offenders.push(`line ${index + 1}: ${line.trim().slice(0, 120)}`);
});
console.log(JSON.stringify({ offenders, templateLines: body.split('\n').length }, null, 2));
if (offenders.length) { console.error('FAIL: single-backslash regex escapes remain in the collector template'); process.exit(1); }
console.log('PASS: collector template escapes are correctly doubled');
