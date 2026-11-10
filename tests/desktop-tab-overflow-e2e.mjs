import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const workRoot=process.env.BROWSER_USE_TEST_ROOT || os.tmpdir();
const profile=fs.mkdtempSync(path.join(workRoot,'browser-use-tab-strip-'));
const favicon='<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#c8ff00"/></svg>';
const server=createServer((req,res)=>{
 if(req.url==='/favicon.svg'){res.writeHead(200,{'content-type':'image/svg+xml'});res.end(favicon);}
 else {res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><title>Favicon test page</title><link rel="icon" href="/favicon.svg"><p>Responsive tab fixture</p>');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${profile}`],cwd:root,env:{...process.env,APPDATA:profile,LOCALAPPDATA:profile,BROWSER_USE_DESKTOP_MCP_PORT:'0',BROWSER_USE_START_URL:'about:blank'},timeout:45000});
try{
 let shell;
 const deadline=Date.now()+30000;
 while(!shell&&Date.now()<deadline){shell=app.context().pages().find(page=>page.url().endsWith('/desktop/renderer/index.html'));if(!shell)await new Promise(resolve=>setTimeout(resolve,50));}
 assert.ok(shell);
 const errors=[];shell.on('pageerror',error=>errors.push(error.message));
 await shell.waitForFunction(()=>document.documentElement.dataset.browserUseRendererReady==='true');
 await shell.evaluate(url=>window.browserUseDesktop.navigate(url),`http://127.0.0.1:${server.address().port}/`);
 await shell.waitForFunction(()=>document.querySelector('.tab-favicon')?.src.includes('/favicon.svg'));
 await shell.waitForFunction(()=>document.querySelector('.tab-favicon')?.naturalWidth>0);
 for(let i=0;i<7;i++)await shell.evaluate(()=>window.browserUseDesktop.newTab('about:blank'));
 await shell.waitForFunction(()=>document.querySelectorAll('[data-tab-id]').length===8);
 const originalIds=await shell.evaluate(()=>window.browserUseDesktop.state().then(value=>value.tabs.map(tab=>tab.id)));
 await shell.evaluate(()=>{const strip=document.querySelector('#tabs');strip.style.flex='0 0 256px';strip.style.width='256px';});
 await shell.waitForFunction(()=>document.querySelectorAll('.tab.is-icon-only').length>0 || document.querySelector('#tab-overflow'));
 let metrics=await shell.evaluate(()=>({width:document.querySelector('#tabs').clientWidth,scroll:document.querySelector('#tabs').scrollWidth,icons:[...document.querySelectorAll('.tab-favicon')].map(icon=>({mask:getComputedStyle(icon).maskImage,width:icon.getBoundingClientRect().width})),active:getComputedStyle(document.querySelector('.tab.is-active')).backgroundColor,other:getComputedStyle(document.querySelector('.tab:not(.is-active)')).backgroundColor}));
 assert.equal(metrics.width,metrics.scroll);assert.ok(metrics.icons.every(icon=>icon.mask==='none'&&icon.width===16));
 assert.equal(metrics.active,'rgb(27, 39, 42)');assert.equal(metrics.other,'rgba(0, 0, 0, 0)');
 await shell.evaluate(()=>{const strip=document.querySelector('#tabs');strip.style.flex='0 0 200px';strip.style.width='200px';});
 await shell.waitForFunction(()=>document.querySelector('#tab-overflow .tab-group-count')?.textContent==='3');
 const selected=await shell.evaluate(()=>window.browserUseDesktop.state().then(value=>value.selectedTabId));
 assert.ok(await shell.locator(`[data-tab-id="${selected}"]`).isVisible());
 // Inspect native menu templates without displaying OS popups during the test.
 await app.evaluate(({Menu,app})=>{
  const original=Menu.buildFromTemplate;
  globalThis.__tabMenus=[];globalThis.__aboutShown=false;
  globalThis.__nativeMenuBuilder=original;
  Menu.buildFromTemplate=template=>({popup:options=>{
   globalThis.__tabMenus.push(template.map(item=>({label:item.label,type:item.type})));
   if(template.some(item=>item.label==='About')){template.find(item=>item.label==='About').click();}
   else if(template[0]?.type==='checkbox'){template[0].click();}
   options.callback?.();
  }});
  app.showAboutPanel=()=>{globalThis.__aboutShown=true;};
 });
 await shell.locator('#tab-overflow').click();
 await shell.waitForFunction(previous=>window.browserUseDesktop.state().then(value=>value.selectedTabId!==previous),selected);
 const grouped=await app.evaluate(()=>globalThis.__tabMenus.at(-1));assert.equal(grouped.length,3);
 const after=await shell.evaluate(()=>window.browserUseDesktop.state());assert.deepEqual(after.tabs.map(tab=>tab.id),originalIds);
 await shell.locator('[data-app-menu="view"]').click();
 assert.equal(await app.evaluate(()=>globalThis.__aboutShown),true);
 assert.ok((await app.evaluate(()=>globalThis.__tabMenus.at(-1))).some(item=>item.label==='About'));
 await shell.evaluate(()=>{const strip=document.querySelector('#tabs');strip.style.flex='';strip.style.width='';});
 await shell.waitForFunction(()=>!document.querySelector('#tab-overflow'));
 assert.deepEqual(errors,[]);
 console.log(JSON.stringify({ok:true,checks:['actual page favicon','dividers not outlines','active grey rectangle','favicon-only shrinking','no scrolling','counted overflow group','native dropdown selects same tabs','View About wiring']}));
}finally{await app.close();await new Promise(resolve=>server.close(resolve));fs.rmSync(profile,{recursive:true,force:true});}
