// Fix duplicate registry.register({ in tui.mjs
import { readFileSync, writeFileSync } from 'fs';

const file = 'C:\\Users\\london\\Desktop\\browser-use\\browser-use\\cli\\tui.mjs';
const content = readFileSync(file, 'utf8');
const lines = content.split('\n');

// Find the duplicate registry.register({ near the browser command
let fixed = false;
const result = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  // Skip the duplicate 'registry.register({' that immediately follows another
  if (l.trim() === 'registry.register({' && 
      i > 0 && lines[i-1].trim() === 'registry.register({') {
    // This is the duplicate - skip it
    fixed = true;
    continue;
  }
  result.push(l);
}

if (fixed) {
  writeFileSync(file, result.join('\n'));
  console.log('Fixed: removed duplicate registry.register({');
} else {
  console.log('Pattern not found. Looking for browser command...');
  const idx = lines.findIndex(l => l.includes("name: 'browser'"));
  if (idx >= 0) {
    for (let j = Math.max(0,idx-5); j < Math.min(lines.length, idx+8); j++) {
      console.log((j+1) + ': ' + lines[j]);
    }
  } else {
    console.log('No browser command found');
  }
}
