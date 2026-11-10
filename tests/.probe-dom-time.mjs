import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bu-dom-probe-'));
const app = await electron.launch({ executablePath: exe, args:['.'], cwd: root, env:{...process.env, APPDATA:dir, LOCALAPPDATA:dir, BROWSER_USE_START_URL:'http://127.0.0.1:3001/Apps/lorde-design-studio/'} });
const win = await app.firstWindow();
await win.waitForSelector('#settings-toggle');
const result = await app.evaluate(async ({BrowserWindow}, payload) => {
  const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
  const view = shell?.getBrowserViews()[0];
  if (!view) throw new Error('Browser-use page view is unavailable.');
  const started = Date.now();
  try {
    const out = await view.webContents.executeJavaScript(payload, true);
    return { ok:true, took: Date.now()-started, out };
  } catch (error) {
    return { ok:false, took: Date.now()-started, error: String(error.message||error) };
  }
}, `(() => {
 const INTERACTIVE_SELECTOR = 'a[href],button,input,select,textarea,[onclick],[contenteditable=""],[contenteditable="true"],[data-tool],[data-add-type],[data-testid],[data-test-id],[data-node-id],[data-transform-target-id],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="option"],[role="switch"],[tabindex]:not([tabindex="-1"])';
 const scope = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
 return { count: scope.length, title: document.title, href: location.href, first: scope.slice(0,5).map(e => ({tag:e.tagName, text:(e.textContent||'').trim().slice(0,40), id:e.id||'', dt:e.getAttribute('data-add-type')||''})) };
})()`);
console.log(JSON.stringify(result));
await app.close(); fs.rmSync(dir,{recursive:true,force:true});
