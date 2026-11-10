import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const context={module:{exports:{}}};
vm.runInNewContext(read('desktop/renderer/tabStrip.js'),context);
const {layout,MIN_TAB_WIDTH}=context.module.exports;
const tabs=Array.from({length:40},(_,index)=>({id:`tab-${index}`,title:`Page ${index}`}));
test('dedicated tabs have only dividers and an active grey rectangle',()=>{
 const html=read('desktop/renderer/index.html');
 const css=read('desktop/renderer/chrome-layout.css');
 assert.match(html, /class="tabs-row"[\s\S]*?id="tabs"[\s\S]*?class="chrome-workspace"/);
 assert.match(css, /\.tabs-row \.tab \{[^}]*border:0;[^}]*border-radius:0;[^}]*background:transparent/);
 assert.match(css, /\.tabs-row \.tab::after \{[^}]*width:1px/);
 assert.match(css, /\.tabs-row \.tab\.is-active \{[^}]*background:#1b272a/);
 assert.match(css, /\.tabs-row \.tabs \{[^}]*overflow:hidden/);
 assert.match(css, /\.tabs-row \.tab-favicon \{[^}]*mask-image:none/);
 assert.match(css, /\.tabs-row \.tab > \.tab-label \{[^}]*text-overflow:clip;[^}]*mask-image:linear-gradient/);
 const main=/APP_CHROME_HEIGHT = (\d+)/.exec(read('desktop/main.cjs'))[1];
 assert.equal(main,/APP_CHROME_HEIGHT = (\d+)/.exec(read('desktop/renderer/app.js'))[1]);
 assert.equal(main,/--app-chrome-height: (\d+)px/.exec(css)[1]);
});
test('tabs shrink evenly to favicon-only widths before any grouping',()=>{
 const result=layout(tabs.slice(0,10),'tab-5',10*MIN_TAB_WIDTH);
 assert.equal(result.visible.length,10); assert.equal(result.hidden.length,0); assert.equal(result.tabWidth,44);
 const wide=layout(tabs.slice(0,3),'tab-1',3000); assert.equal(wide.tabWidth,220);
});
test('overflow reserves one counted final group and keeps the selected tab visible',()=>{
 const result=layout(tabs,'tab-39',340);
 assert.equal(result.visible.length,6); assert.equal(result.hidden.length,34);
 assert.equal(result.visible.at(-1).id,'tab-39');
 assert.ok(result.tabWidth*result.visible.length+result.groupWidth<=340);
 assert.equal(new Set([...result.visible,...result.hidden].map(tab=>tab.id)).size,40);
});
test('narrow and zero-width strips retain all tab IDs in the group without overflow',()=>{
 for(const width of [0,20,32,65]) {
  const result=layout(tabs,'tab-39',width);
  assert.equal(result.visible.length+result.hidden.length,40);
  assert.ok(result.tabWidth*result.visible.length+result.groupWidth<=width);
 }
});
test('favicon updates and native group menu keep tab actions authoritative',()=>{
 const main=read('desktop/main.cjs');
 assert.match(main, /page-favicon-updated/); assert.match(main,/favicon: tab.favicon/);
 assert.match(main,/browser-use:show-tab-group/);
 assert.match(read('desktop/renderer/app.js'),/showTabGroup\(layout.hidden.map/);
 assert.match(read('desktop/renderer/app.js'),/new ResizeObserver\(\(\) => renderTabStrip\(\)\)/);
});
test('View About shows current app metadata and current-year copyright',()=>{
 const main=read('desktop/main.cjs');
 assert.match(main,/name: 'Browser-use', version: app.getVersion\(\)/);
 assert.match(main,/Copyright \$\{new Date\(\).getFullYear\(\)\} LORDE STUDIOS\. ALL RIGHTS RESERVED/);
 assert.match(main,/label: 'About', click: \(\) => setAboutOpen\(true\)/);
});
