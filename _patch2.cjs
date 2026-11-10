const fs = require('fs');
const p = 'desktop/renderer/app.js';
let c = fs.readFileSync(0, 'utf8');
const lines = c.split('\n');
let patched = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].trim() === '} else {' && i > 0 && lines[i - 1].includes('chip.append(label, preview);')) {
    const indent = '      ';
    const newLines = [
      indent + '} else if (attachment.path && /\\.(html?|txt|md|csv|json|pdf|xml|svg)$/i.test(attachment.name)) {',
      indent + "  const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';",
      indent + "  preview.setAttribute('aria-label', 'Open ' + attachment.name);",
      indent + "  preview.addEventListener('click', () => openReportPreview({ path: attachment.path }));",
      indent + "  chip.append(label, preview);"
    ];
    lines.splice(i + 1, 0, ...newLines);
    patched = true;
    break;
  }
}
if (patched) {
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
  console.log('PATCHED OK');
} else {
  console.log('TARGET NOT FOUND');
}
