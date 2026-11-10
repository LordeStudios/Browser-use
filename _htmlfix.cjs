const fs = require('fs');
const p = 'desktop/renderer/app.js';
let c = fs.readFileSync(0, 'utf8');
const lines = c.split('\n');
const idx = lines.findIndex((l, i) => i >= 185 && i <= 195 && l.trim() === '} else {');
if (idx < 0) { console.log('NOT_FOUND'); process.exit(1); }
const indent = '      ';
const ins = [
  indent + '} else if (attachment.path && /\\.(html?|txt|md|csv|json|xml|svg)$/i.test(attachment.name)) {',
  indent + "  const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';",
  indent + "  preview.setAttribute('aria-label', 'Open ' + attachment.name);",
  indent + "  preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));",
  indent + '  chip.append(label, preview);'
];
lines.splice(idx, 0, ...ins);
fs.writeFileSync(p, lines.join('\n'), 'utf8');
console.log('PATCHED_AT_LINE_' + idx);
