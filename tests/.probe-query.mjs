import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-query-probe-'));
const app = await electron.launch({ executablePath: exe, args: ['.'], cwd: root, env: { ...process.env, APPDATA: dir, LOCALAPPDATA: dir, BROWSER_USE_START_URL: 'http://127.0.0.1:3001/Apps/lorde-design-studio/' } });
const win = await app.firstWindow();
await win.waitForSelector('#settings-toggle');
const result = await app.evaluate(async ({ BrowserWindow }) => {
  const shell = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL().endsWith('/desktop/renderer/index.html'));
  const view = shell?.getBrowserViews()[0];
  if (!view) throw new Error('Browser-use page view is unavailable.');
  const script = `(() => {
    const INTERACTIVE_SELECTOR = 'a[href],button,input,select,textarea,[onclick],[contenteditable=""],[contenteditable="true"],[data-tool],[data-add-type],[data-testid],[data-test-id],[data-node-id],[data-transform-target-id],[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="checkbox"],[role="radio"],[role="option"],[role="switch"],[tabindex]:not([tabindex="-1"])';
    const scope = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR));
    const rows = [];
    for (const element of scope) {
      const text = String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      const searchable = [
        element.id || '',
        element.getAttribute('aria-label') || '',
        element.getAttribute('title') || '',
        element.getAttribute('alt') || '',
        element.getAttribute('placeholder') || '',
        element.getAttribute('data-tool') || '',
        element.getAttribute('data-add-type') || '',
        element.getAttribute('data-testid') || '',
        element.getAttribute('data-test-id') || '',
        element.getAttribute('role') || '',
        text
      ].join(' ').toLowerCase();
      if (searchable.includes('ellipse')) {
        rows.push({
          id: element.id || '',
          tag: element.tagName,
          text,
          title: element.getAttribute('title') || '',
          dataAdd: element.getAttribute('data-add-type') || '',
          aria: element.getAttribute('aria-label') || ''
        });
      }
    }
    return { total: scope.length, rows };
  })()`;
  return view.webContents.executeJavaScript(script, true);
});
console.log(JSON.stringify(result));
await app.close();
fs.rmSync(dir, { recursive: true, force: true });
