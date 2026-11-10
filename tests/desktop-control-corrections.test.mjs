import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
test('close remains until favicon and close can no longer fit',()=>{
 const js=read('desktop/renderer/app.js');
 assert.match(js,/is-compact', layout.tabWidth < 44/);
 assert.doesNotMatch(js,/is-compact', layout.tabWidth < 95/);
 assert.match(js,/kind: 'tab', tabId: tab.dataset.tabId/);
 assert.match(read('desktop/main.cjs'),/label: 'Close tab', click:/);
});
test('About uses the app themed overlay not an OS dialog',()=>{
 const main=read('desktop/main.cjs');
 assert.doesNotMatch(main,/app.showAboutPanel|app.setAboutPanelOptions/);
 assert.match(main,/label: 'About', click: \(\) => setAboutOpen\(true\)/);
 assert.match(read('desktop/renderer/overlay.html'),/id="about-popup" role="dialog"/);
 assert.match(read('desktop/renderer/chrome-theme.css'),/\.about-popup \{[^}]*background:var\(--bu-surface\)/);
 assert.match(main,/version: app.getVersion\(\)/);
 assert.match(main,/Copyright \$\{new Date\(\).getFullYear\(\)\} LORDE STUDIOS\. ALL RIGHTS RESERVED/);
});
test('main placeholders stay non-rendering while real overlay is open',()=>{
 const html=read('desktop/renderer/index.html');
 assert.match(html,/drawer settings drawers-placeholder/);
 assert.match(html,/drawer console drawers-placeholder/);
 assert.match(read('desktop/renderer/app.js'),/panel.hidden = name !== 'agent' \|\| !isOpen/);
});
test('Chat 1 tracks the same terminal dock height as native page and other chats',()=>{
 const js=read('desktop/renderer/app.js');
 assert.match(js,/setProperty\('--terminal-dock-height', `\$\{dockHeight\}px`\)/);
 assert.match(js,/const dockHeight = layout.docked/);
 const css=read('desktop/renderer/chrome-layout.css');
 assert.match(css,/height: calc\(100vh - var\(--app-chrome-height\) - var\(--terminal-dock-height, 0px\)\)/);
});
