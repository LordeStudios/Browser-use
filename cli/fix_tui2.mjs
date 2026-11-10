// Fix remaining syntax errors in tui.mjs
import { readFileSync, writeFileSync } from 'fs';

const file = 'C:\\Users\\london\\Desktop\\browser-use\\browser-use\\cli\\tui.mjs';
const content = readFileSync(file, 'utf8');
const lines = content.split('\n');

// Fix 1: Line 1283 - broken exec string with empty "" literals
// Fix 2: Line 1291 - orphaned 'name: headed' (missing registry.register({)

let fixed = 0;
const result = [];
for (let i = 0; i < lines.length; i++) {
  let l = lines[i];
  
  // Fix: exec("start "" "" + url + """, ...) -> exec(`start "${url}"`, ...)
  if (l.includes('exec("start "" "" + url + """')) {
    l = l.replace('exec("start "" "" + url + """, { windowsHide: true });', 'exec(`start "${url}"`, { windowsHide: true });');
    fixed++;
  }
  
  // Fix: orphaned 'name: headed' at line 1291 - wrap in registry.register({
  // Lines 1291-1298 look like a broken registry entry
  if (l.trim() === "name: 'headed'," && i > 0 && !lines[i-1].includes('registry.register')) {
    // This is orphaned - prefix with registry.register({
    l = 'registry.register({' + '\n  ' + l;
    fixed++;
  }
  
  result.push(l);
}

writeFileSync(file, result.join('\n'));
console.log('Fixed ' + fixed + ' issue(s)');
