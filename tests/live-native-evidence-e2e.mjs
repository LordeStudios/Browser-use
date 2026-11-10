import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root=path.resolve(import.meta.dirname,'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bu-live-evidence-'));
const profile=path.join(directory,'profile'); fs.mkdirSync(profile);
const model=process.env.BROWSER_USE_EVAL_MODEL || 'openai/gpt-5.6-sol';
const configuredBase=process.env.ANTHROPIC_BASE_URL;
const baseUrl=configuredBase ? configuredBase.replace(/\/$/,'').replace(/(?:\/v1)?$/,'/v1') : '';
const secret=process.env.ANTHROPIC_AUTH_TOKEN || process.env.XKIRO_API_KEY;
if (!baseUrl || !secret) throw new Error('Existing xKiro endpoint/credential environment is required.');
const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile,BROWSER_USE_DESKTOP_MCP_PORT:'0',BROWSER_USE_START_URL:'about:blank'}; delete env.ELECTRON_RUN_AS_NODE;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message,timeout=30000){ const end=Date.now()+timeout; while(Date.now()<end){const value=await fn();if(value)return value;await wait(100);}throw new Error(message);}
let app,shell;
const reports=[];
console.log(`Evidence: ${directory}`);
try {
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${profile}`],cwd:root,env,timeout:40000});
  shell=await until(()=>app.windows().find(window=>window.url().endsWith('/desktop/renderer/index.html')),'Shell failed to load');
  await shell.waitForFunction(()=>document.documentElement.dataset.browserUseRendererReady==='true');
  await shell.evaluate(async ({baseUrl,model,secret})=>{
    const api=window.browserUseDesktop;
    const connection=await api.saveAiConnection({provider:'xkiro',name:'Real-model evidence verification',baseUrl,model});
    await api.setProviderCredential({provider:'xkiro',connectionId:connection.id,secret});
    await api.saveSettings({agentControlMode:'agi'});
  },{baseUrl,model,secret});
  await shell.reload();
  await shell.waitForFunction(model=>document.querySelector('#agent-model-label')?.textContent.includes(model),model,{timeout:30000});
  if(!await shell.locator('#agent-panel').isVisible()) await shell.locator('#agent-toggle').click();
  await shell.evaluate(()=>{
    window.evaluationEvents=[];
    window.browserUseDesktop.onAgentEvent(event=>{
      if(['tool.result','assistant.thinking.completed','run.completed','run.cancelled'].includes(event.type))window.evaluationEvents.push({at:Date.now(),type:event.type,tool:event.tool,elapsedMs:event.elapsedMs,ok:event.output?.ok});
    });
  });
  async function task(name,prompt){
    if(reports.length) await shell.locator('#agent-new-chat').click();
    const start=Date.now();
    await shell.locator('#agent-task').fill(prompt); await shell.locator('#agent-send').click();
    let run;
    try { run=await until(async()=>{const current=await shell.evaluate(()=>window.browserUseDesktop.agentState());return current&&['completed','failed','cancelled'].includes(current.status)&&current;},`${name} exceeded the evaluation deadline`,240000); }
    catch(error){const active=await shell.evaluate(()=>window.browserUseDesktop.agentState()); fs.writeFileSync(path.join(directory,`${name}-failed.json`),JSON.stringify({model,elapsedMs:Date.now()-start,run:active},null,2)); if(active?.id)await shell.evaluate(id=>window.browserUseDesktop.agentCancel(id),active.id); throw error;}
    const record={name,model,elapsedMs:Date.now()-start,result:run.result,providerCalls:run.coordinator?.metrics?.providerCalls,phaseMs:run.coordinator?.metrics?.phaseMs,
      tools:run.history.filter(entry=>!entry.tool.startsWith('agent_')).map(entry=>({tool:entry.tool,input:entry.input,output:entry.output})),events:await shell.evaluate(()=>window.evaluationEvents.splice(0))};
    reports.push(record); fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(reports,null,2));
    console.log(JSON.stringify({name,elapsedMs:record.elapsedMs,providerCalls:record.providerCalls,result:record.result,tools:record.tools.map(t=>({tool:t.tool,action:t.input?.action,ok:t.output?.ok}))}));
    assert.equal(run.status,'completed'); assert.equal(run.result?.success,true);
    return record;
  }
  const disk=await task('disk-capacity','What is the total space of the fixed drives on this PC? Report each drive and the aggregate capacity, with exact total bytes as well as human-readable units.');
  const commands=disk.tools.filter(t=>t.tool==='computer_terminal'&&t.input.action==='execute');
  assert.ok(commands.length<=2,`Disk query launched ${commands.length} commands`);
  const outputs=disk.tools.filter(t=>t.tool==='computer_terminal'&&t.output?.result?.state==='completed').map(t=>t.output.result.output||'');
  assert.ok(outputs.some(text=>text.length>20),'Completed system output must actually have been consumed');
  const referencePath=process.env.BROWSER_USE_DISK_REFERENCE;
  if(referencePath){
    const reference=JSON.parse(fs.readFileSync(referencePath,'utf8').replace(/^﻿/,''));
    assert.ok(disk.result.summary.replace(/[,\s]/g,'').includes(String(reference.TotalBytes)), 'Reported aggregate must match the independently queried capacity');
  }
  assert.ok(disk.providerCalls<=6,`Disk query required ${disk.providerCalls} decisions`);
  const target=path.join(directory,'AGI_testing');
  const page=await task('create-and-edit-html',`Create a new folder at ${JSON.stringify(target)} and a file webpage.html with an animated rainbow-colored page saying Success. Use actual files, check the saved contents, and finish with the exact path. Do not overwrite any existing files outside this new folder.`);
  const html=fs.readFileSync(path.join(target,'webpage.html'),'utf8');
  assert.match(html,/success/i);assert.match(html,/@keyframes/);assert.match(html,/gradient|hue-rotate/i);
  const browser=await app.evaluate(async({BrowserWindow},file)=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});try{await window.loadFile(file);return await window.webContents.executeJavaScript(`({text:document.body.innerText,animations:document.getAnimations().length,width:document.documentElement.scrollWidth})`);}finally{window.destroy();}},path.join(target,'webpage.html'));
  assert.match(browser.text,/success/i);assert.ok(browser.animations>0,'Saved page must actually animate');
  await shell.screenshot({path:path.join(directory,'chat.png')});
  console.log(JSON.stringify({ok:true,model,directory,verification:'REAL_PLAYWRIGHT_VERIFIED',page:browser}));
} catch(error){ console.error(error.stack||error.message); process.exitCode=1; }
finally {if(app)await app.close().catch(()=>{}); console.log(`Evidence: ${directory}`);}
