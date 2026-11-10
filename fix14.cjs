const fs = require('fs');
const p = 'desktop/agent/desktopChatAgent.cjs';
let s = fs.readFileSync(p, 'utf8');
const from = `  record(run, call, output, storedOutput = output) {
    run.history = [...run.history, {`;
const to = `  record(run, call, output, storedOutput = output) {
    const priorEntries = call.name === 'browser_done' ? run.history.filter((entry) => entry.tool !== 'browser_done') : run.history;
    run.history = [...priorEntries, {`;
const count = s.split(from).length - 1;
if (count !== 1) { console.log('NOT-FOUND-OR-AMBIGUOUS count=' + count); process.exit(1); }
s = s.replace(from, to);
fs.writeFileSync(p, s);
const rb = fs.readFileSync(p, 'utf8');
const idx = rb.indexOf('record(run, call, output, storedOutput');
console.log('READBACK: ' + JSON.stringify(rb.slice(idx, idx + 300)));
console.log('REPLACED-OK');
