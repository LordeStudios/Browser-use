import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('compact settings remove Startup and obsolete pairing controls', () => {
  const html = read('desktop/renderer/overlay.html');
  const js = read('desktop/renderer/overlay.js');
  assert.doesNotMatch(html, /data-settings-section="startup"|id="homepage"|id="copy-pairing-code"|id="cancel-pairing"/);
  for (const id of ['settings-panel', 'settings-form', 'mcp-control-mode', 'copy-mcp', 'mcp-sessions', 'gpt-action-enabled', 'gpt-action-public-origin', 'gpt-openapi-url', 'gpt-api-key', 'gpt-action-schema', 'open-devtools', 'close-settings']) assert.ok(html.includes(`id="${id}"`), id);
  assert.match(js, /function connectionPrompt\(\)/);
  assert.match(js, /copyText\(connectionPrompt\(\)\)/);
  assert.match(js, /browser_bind_tab/);
  assert.match(js, /Mcp-Session-Id/);
  assert.match(js, /X-Browser-Use-Pairing-Code/);
  assert.match(js, /saveSettingsButton/);
  assert.match(js, /settingsActionbar.hidden = state === 'saved'/);
});
test('chrome surfaces share offline icons and dark theme', () => {
  for (const name of ['index', 'overlay', 'terminal']) assert.match(read(`desktop/renderer/${name}.html`), /chrome-theme\.css/);
  for (const name of ['index', 'overlay']) assert.match(read(`desktop/renderer/${name}.html`), /vendor\/phosphor\.css/);
  assert.ok(fs.statSync(path.join(root, 'desktop/renderer/vendor/Phosphor.woff2')).size > 1000);
  assert.match(read('desktop/renderer/terminal.js'), /token\('--bu-canvas', '#060b0d'\)/);
  assert.match(read('desktop/renderer/chrome-layout.css'), /app-titlebar/);
  assert.match(read('desktop/renderer/index.html'), /data-app-menu="file"/);
  assert.match(read('desktop/renderer/index.html'), /<span>LORDE<\/span><b>STUDIOS<\/b>/);
});
test('downloads and real console events are delivered into the topmost overlay', () => {
  const main = read('desktop/main.cjs');
  assert.match(main, /set-downloads-open/);
  assert.match(main, /historyMenuOpen \|\| downloadsOpen/);
  assert.match(main, /liveOverlayWebContents\(\)\?\.send\('browser-use:console'/);
  assert.match(read('desktop/renderer/overlay.html'), /downloads-overlay/);
  assert.match(read('desktop/renderer/overlay.js'), /BrowserUseSurfaces.renderDownloads/);
  const controls = read('desktop/renderer/surfaceControls.js');
  assert.match(controls, /entry\.sourceId \|\| entry\.url/);
  assert.match(controls, /entry\.line/);
  assert.match(controls, /console-level/);
  assert.match(read('desktop/renderer/app.js'), /DRAWER_TOGGLES\[name\]\.classList.toggle\('is-active', isOpen\)/);
});
test('touched UI source contains no em dash', () => {
  for (const file of ['index.html','overlay.html','overlay.js','app.js','terminal.html','terminal.js','surfaceControls.js']) assert.equal(read(`desktop/renderer/${file}`).includes('—'), false, file);
});
