import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync('D:/browser-use-controls-test-');
const errors = [];
const app = await electron.launch({ executablePath: path.join(root,'node_modules/electron/dist/electron.exe'), args: ['.',`--user-data-dir=${profile}`], cwd: root,
  env: {...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT:'0', BROWSER_USE_START_URL:'about:blank'}, timeout:45000 });
async function pageFor(suffix) {
  const deadline = Date.now()+30000;
  while(Date.now()<deadline) {
    const page = app.context().pages().find(page=>page.url().endsWith(suffix));
    if(page) { page.on('pageerror',error=>errors.push(error.message)); return page; }
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error(`Missing renderer ${suffix}`);
}
async function active(shell,id,expected) { assert.equal(await shell.locator(id).evaluate(node=>node.classList.contains('is-active')),expected,id); }
try {
  const shell = await pageFor('/desktop/renderer/index.html');
  const overlay = await pageFor('/desktop/renderer/overlay.html');
  await shell.waitForFunction(()=>document.documentElement.dataset.browserUseRendererReady==='true');
  await overlay.waitForFunction(()=>!document.querySelector('#copy-mcp').disabled);
  const initialTabs = await shell.locator('[data-tab-id]').count();
  await shell.locator('#new-tab').click();
  await shell.waitForFunction(count=>document.querySelectorAll('[data-tab-id]').length===count+1,initialTabs);
  const tabLayout = await shell.evaluate(()=>{
    const row=document.querySelector('.tabs-row').getBoundingClientRect();
    const toolbar=document.querySelector('.toolbar').getBoundingClientRect();
    return { rowBottom:row.bottom,toolbarTop:toolbar.top,tabs:[...document.querySelectorAll('.tabs-row .tab')].map(tab=>({border:getComputedStyle(tab).borderLeftWidth,style:getComputedStyle(tab).borderLeftStyle,close:getComputedStyle(tab.querySelector('.tab-close')).display})) };
  });
  assert.ok(tabLayout.rowBottom<=tabLayout.toolbarTop,'Tabs must occupy their own row');
  assert.ok(tabLayout.tabs.every(tab=>tab.border==='0px'&&tab.style==='none'&&tab.close==='grid'),'Each tab must remain outline-free with a close control');
  await shell.locator('.tabs-row .tab-close').last().click();
  await shell.waitForFunction(count=>document.querySelectorAll('[data-tab-id]').length===count,initialTabs);
  await shell.locator('#settings-toggle').click();
  await overlay.locator('#settings-panel').waitFor({state:'visible'});
  await active(shell,'#settings-toggle',true);
  assert.equal(await overlay.locator('[data-settings-section="startup"]').count(),0);
  assert.equal(await overlay.locator('#copy-pairing-code, #cancel-pairing').count(),0);
  assert.equal(await overlay.locator('.settings-actionbar').isVisible(),false);
  await overlay.evaluate(()=>document.fonts.ready);
  const icons = await overlay.locator('.settings-nav-item .ph').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node,'::before').content));
  assert.ok(icons.every(value=>value && value!=='none' && value!=='normal'),JSON.stringify(icons));
  await overlay.locator('#copy-mcp').click();
  await overlay.waitForFunction(()=>document.querySelector('#copy-mcp').textContent.includes('Copied'));
  const prompt = await app.evaluate(({clipboard})=>clipboard.readText());
  assert.match(prompt,/Connect to my running Browser-use Desktop/);
  assert.match(prompt,/Mcp-Session-Id/);
  assert.match(prompt,/browser_bind_tab/);
  const endpoint = /MCP endpoint: (\S+)/.exec(prompt)[1];
  const code = /Bootstrap header: X-Browser-Use-Pairing-Code: (\S+)/.exec(prompt)[1];
  const response = await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream','X-Browser-Use-Pairing-Code':code},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'settings-ui-test',version:'1'}}})});
  assert.equal(response.status,200);
  assert.ok(response.headers.get('mcp-session-id'));
  await overlay.waitForFunction(()=>document.querySelector('#mcp-sessions').textContent.includes('settings-ui-test'));
  await overlay.locator('#mcp-sessions [data-revoke]').click();
  await overlay.waitForFunction(()=>!document.querySelector('#mcp-sessions').textContent.includes('settings-ui-test'));
  await overlay.locator('[data-settings-section="gpt"]').click();
  await overlay.locator('#gpt-action-public-origin').fill('https://actions.example.test');
  await overlay.locator('[form="settings-form"]').click();
  await overlay.waitForFunction(()=>document.querySelector('#gpt-openapi-url').textContent==='https://actions.example.test/gpt/openapi.json');
  assert.equal(await overlay.locator('.settings-actionbar').isVisible(),false);
  await overlay.locator('#close-settings').click();
  await overlay.locator('#settings-panel').waitFor({state:'hidden'});
  await active(shell,'#settings-toggle',false);
  await shell.locator('#console-toggle').click();
  await overlay.locator('#console-panel').waitFor({state:'visible'});
  await app.evaluate(async({BrowserWindow})=>{
    const win = BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = win.getBrowserViews().find(view=>!view.webContents.getURL().includes('/desktop/renderer/'));
    await view.webContents.executeJavaScript('console.warn("BROWSER_USE_REAL_CONSOLE_TEST")');
  });
  await overlay.waitForFunction(()=>document.querySelector('#console-list').textContent.includes('BROWSER_USE_REAL_CONSOLE_TEST'));
  await overlay.locator('[data-filter="warning"]').click();
  assert.match(await overlay.locator('#console-list').innerText(),/BROWSER_USE_REAL_CONSOLE_TEST/);
  assert.equal(await overlay.locator('#console-panel').evaluate(node=>getComputedStyle(node).backgroundColor),'rgb(10, 16, 18)');
  await active(shell,'#console-toggle',true);
  await overlay.locator('#close-console').click();
  await shell.locator('#downloads-toggle').click();
  await overlay.locator('#downloads-panel').waitFor({state:'visible'});
  await active(shell,'#downloads-toggle',true);
  assert.match(await overlay.locator('#downloads-panel').innerText(),/No downloads yet/);
  const stacked = await app.evaluate(({BrowserWindow})=>{
    const win=BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    return win.getBrowserViews().at(-1).webContents.getURL().endsWith('/overlay.html');
  });
  assert.ok(stacked,'Downloads must be above the native page');
  await overlay.locator('#downloads-panel button').click();
  await overlay.locator('#downloads-panel').waitFor({state:'hidden'});
  await active(shell,'#downloads-toggle',false);
  await shell.locator('#rotate-device').click();
  await shell.waitForFunction(()=>window.browserUseDesktop.deviceState().then(value=>value?.mode==='desktop'&&value?.viewport));
  assert.equal((await shell.evaluate(()=>window.browserUseDesktop.deviceState())).touch,false);
  await shell.locator('#rotate-device').click();
  await shell.waitForFunction(()=>window.browserUseDesktop.deviceState().then(value=>!value?.viewport));
  const layout = await shell.evaluate(()=>({ header:document.querySelector('.browser-chrome').getBoundingClientRect().height,title:document.querySelector('.app-titlebar').getBoundingClientRect().height,titleBox:document.querySelector('.app-title').getBoundingClientRect().toJSON(),menu:document.querySelector('.chrome-menu').getBoundingClientRect().toJSON(),color:getComputedStyle(document.querySelector('.brand b')).backgroundColor,ink:getComputedStyle(document.querySelector('.brand b')).color }));
  assert.equal(layout.header,110); assert.equal(layout.title,32);
  assert.ok(layout.titleBox.left>=layout.menu.right+4);
  assert.equal(layout.color,'rgb(200, 255, 0)'); assert.equal(layout.ink,'rgb(7, 16, 18)');
  // Exercise renderer at minimum supported native width without touching another app.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().endsWith('/desktop/renderer/index.html')).setSize(960,680));
  await shell.waitForFunction(()=>innerWidth<=960);
  const small = await shell.evaluate(()=>({title:document.querySelector('.app-title').getBoundingClientRect().left,menu:document.querySelector('.chrome-menu').getBoundingClientRect().right,overflow:document.querySelector('.chrome-workspace').scrollWidth>document.querySelector('.chrome-workspace').clientWidth}));
  assert.ok(small.title>=small.menu+4); assert.equal(small.overflow,false);
  await shell.locator('#settings-toggle').click();
  await overlay.locator('#settings-panel').waitFor({state:'visible'});
  fs.mkdirSync('D:/BrowserUse-controls-evidence',{recursive:true});
  await overlay.screenshot({path:'D:/BrowserUse-controls-evidence/settings.png'});
  await shell.screenshot({path:'D:/BrowserUse-controls-evidence/chrome.png'});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({ok:true,checks:['compact settings','offline icons','real MCP prompt bootstrap','session revoke','GPT save','live console warning','overlay downloads','desktop rotation','single title row','brand colors','narrow non-overlap'],evidence:'D:/BrowserUse-controls-evidence'}));
} finally { await app.close(); fs.rmSync(profile,{recursive:true,force:true}); }
