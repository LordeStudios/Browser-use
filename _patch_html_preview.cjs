const fs = require('fs');
const path = require('path');

const target = path.join(process.cwd(), 'desktop', 'renderer', 'app.js');
const source = fs.readFileSync(target, 'utf8');
const startMarker = "    if (attachment.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType)) {";
const endMarker = "    } else {\n      chip.append(label);\n    }";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker, start);
if (start < 0 || end < 0 || end < start) {
  throw new Error(`Attachment preview block not found in ${target}`);
}

const canonical = [
  startMarker,
  "      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Preview'; preview.setAttribute('aria-label', `Preview ${attachment.name}`);",
  "      preview.addEventListener('click', () => openScreenshotPreview({ data: String(attachment.dataUrl || '').split(',')[1] || '', mimeType: attachment.mimeType }));",
  '      chip.append(label, preview);',
  "    } else if (attachment.path && /\\.(html?|txt)$/i.test(attachment.name)) {",
  "      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';",
  "      preview.setAttribute('aria-label', 'Open ' + attachment.name);",
  "      preview.addEventListener('click', () => openReportPreviewInChat({ path: attachment.path }));",
  '      chip.append(label, preview);',
  endMarker
].join('\n');

const currentBlock = source.slice(start, end + endMarker.length);
if (currentBlock === canonical) {
  console.log('ALREADY PATCHED');
  process.exit(0);
}

const updated = source.slice(0, start) + canonical + source.slice(end + endMarker.length);
fs.writeFileSync(target, updated, 'utf8');
console.log('PATCHED OK');
