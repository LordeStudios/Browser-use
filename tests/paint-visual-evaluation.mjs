import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root=path.resolve(import.meta.dirname,'..');
const reference=process.env.BROWSER_USE_PAINT_REFERENCE || 'F:/download.jpg';
const sourceHash=()=>crypto.createHash('sha256').update(fs.readFileSync(reference)).digest('hex');
const originalHash=sourceHash();
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bu-paint-eval-'));
const profile=path.join(directory,'profile'); fs.mkdirSync(profile);
const model=process.env.BROWSER_USE_EVAL_MODEL || 'openai/gpt-5.6-sol';
const baseUrl=(process.env.ANTHROPIC_BASE_URL || '').replace(/\/$/,'').replace(/(?:\/v1)?$/,'/v1');
const secret=process.env.ANTHROPIC_AUTH_TOKEN || process.env.XKIRO_API_KEY;
if(!baseUrl.startsWith('https://')||!secret)throw Error('Existing provider configuration is required.');
const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile,BROWSER_USE_DESKTOP_MCP_PORT:'0',BROWSER_USE_START_URL:'about:blank'};delete env.ELECTRON_RUN_AS_NODE;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,message,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await fn();if(value)return value;await pause(100);}throw Error(message);}
let app,shell,tool,paint,viewer,startedAt,run,violation,deadlineReached=false;
const approvals=[];
console.log(`Paint evaluation evidence: ${directory}`);
try{
  app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${profile}`],cwd:root,env,timeout:40000});
  shell=await until(()=>app.windows().find(w=>w.url().endsWith('/desktop/renderer/index.html')),'App shell unavailable');
  await shell.waitForFunction(()=>document.documentElement.dataset.browserUseRendererReady==='true');
  await shell.evaluate(async({baseUrl,model,secret})=>{
    const api=window.browserUseDesktop;
    const connection=await api.saveAiConnection({provider:'xkiro',name:'Native Paint evaluation',baseUrl,model});
    await api.setProviderCredential({provider:'xkiro',connectionId:connection.id,secret});
    await api.saveSettings({agentControlMode:'agi',mcpControlMode:'agi',agentApprovalMode:'confirm-sensitive'});
  },{baseUrl,model,secret});
  await shell.reload();
  await shell.waitForFunction(model=>document.documentElement.dataset.browserUseRendererReady==='true'&&document.querySelector('#agent-model-label')?.textContent.includes(model),model);
  const config=await shell.evaluate(()=>window.browserUseDesktop.mcpConnectionConfiguration());
  const authentication=await fetch(config.authenticationEndpoint).then(r=>r.json());
  const initialize=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...authentication},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{clientInfo:{name:'paint-evaluation-observer',version:'1'}}})});
  const session=initialize.headers.get('mcp-session-id');if(!session)throw Error('MCP pairing failed.');
  let sequence=1;
  tool=async(name,input={})=>{
    const response=await fetch(config.endpoint,{method:'POST',headers:{'Content-Type':'application/json','Mcp-Session-Id':session},body:JSON.stringify({jsonrpc:'2.0',id:++sequence,method:'tools/call',params:{name,arguments:input}}),signal:AbortSignal.timeout(30000)}).then(r=>r.json());
    if(response.error||response.result?.isError)throw Error(JSON.stringify(response.error||response.result));
    return {...JSON.parse(response.result.content[0].text),image:response.result.content.find(c=>c.type==='image')};
  };
  const existing=new Set((await tool('computer_observe')).windows.map(w=>w.id));
  function launch(command,args,windowsVerbatimArguments=false){const child=spawn(command,args,{stdio:'ignore',windowsHide:false,windowsVerbatimArguments});child.on('error',error=>console.error(`Fixture launch: ${error.message}`));child.unref();return child;}
  // rundll32 needs the comma OUTSIDE the quoted DLL path. Node's default
  // argument quoting puts it inside when the DLL and comma are one argument.
  const viewerChild=launch('rundll32.exe',[`"C:\\Program Files\\Windows Photo Viewer\\PhotoViewer.dll", ImageView_Fullscreen "${path.win32.normalize(reference)}"`],true);
  const referenceTitle=path.parse(reference).name.toLowerCase();
  viewer=await until(async()=>{
    const owned=(await tool('computer_observe')).windows.filter(w=>!existing.has(w.id)&&w.pid===viewerChild.pid);
    if(owned.some(w=>w.title==='RunDLL'))throw Error('Reference launch produced a RunDLL error dialog; evaluation has not started.');
    return owned.find(w=>w.title.toLowerCase().includes(referenceTitle));
  },'Reference photograph did not appear in its new viewer');
  await tool('computer_window',{action:'focus',windowId:viewer.id});
  await tool('computer_keyboard',{action:'press',key:'Win+ArrowLeft'});await pause(400);await tool('computer_keyboard',{action:'press',key:'Escape'});
  const beforePaint=new Set((await tool('computer_observe')).windows.map(w=>w.id));
  launch('mspaint.exe',[]);
  paint=await until(async()=>(await tool('computer_observe')).windows.find(w=>!beforePaint.has(w.id)&&/paint/i.test(w.title)),'Fresh Paint window did not appear');
  await tool('computer_window',{action:'focus',windowId:paint.id});
  await tool('computer_keyboard',{action:'press',key:'Win+ArrowRight'});await pause(400);await tool('computer_keyboard',{action:'press',key:'Escape'});
  paint=await until(async()=>{const window=(await tool('computer_observe')).windows.find(w=>w.id===paint.id);return window?.bounds.width>=700&&window.bounds.height>=600&&window;},'Paint window did not finish opening');
  viewer=(await tool('computer_observe')).windows.find(w=>w.id===viewer.id);
  if(!viewer||viewer.title==='RunDLL')throw Error('Reference viewer became unavailable before the task.');
  if(!await shell.locator('#agent-panel').isVisible())await shell.locator('#agent-toggle').click();
  await shell.locator('#agent-permission').selectOption('confirm-sensitive');
  const prompt=`The reference photograph is open in the newly launched Windows image viewer (windowId ${viewer.id}), and a fresh blank Paint document is open beside it (windowId ${paint.id}). Redraw that picture in Paint as accurately as possible using ONLY Paint's pencil. No scripts, generated artwork, imports, clipboard paste, file tools, tracing programs, or working in another app. Use genuine screenshots and native input. All pointer input must target windowId ${paint.id} so it cannot land in the reference viewer; use the observed drawable region for strokes. You choose the composition and all points. Do not clear, save, close or replace any existing document. Leave your drawing visible. Report its actual quality and any unfinished features honestly, not merely that input was dispatched.`;
  await shell.locator('#agent-task').fill(prompt);
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/desktop/renderer/index.html'));window.minimize();});
  await tool('computer_window',{action:'focus',windowId:paint.id});
  const before=await tool('computer_screenshot',{maxWidth:1920});fs.writeFileSync(path.join(directory,'before.png'),Buffer.from(before.image.data,'base64'));
  startedAt=Date.now();
  await shell.locator('#agent-send').dispatchEvent('click');
  await until(async()=>Boolean((await shell.evaluate(()=>window.browserUseDesktop.agentState()))?.id),'Task did not start');
  await app.evaluate(({BrowserWindow})=>{const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/desktop/renderer/index.html'));window.hide();});
  await tool('computer_window',{action:'focus',windowId:paint.id});
  const deadline=startedAt+360000;
  while(Date.now()<deadline){
    run=await shell.evaluate(()=>window.browserUseDesktop.agentState());
    if(run&&['completed','failed','cancelled'].includes(run.status))break;
    const approval=run?.pendingApproval;
    if(approval){
      const input=approval.input||approval.args||{};
      const desktop=await tool('computer_observe');
      let allowed=false;
      if(['computer_pointer','computer_stroke'].includes(approval.tool))allowed=input.windowId===paint.id;
      if(approval.tool==='computer_window')allowed=input.action==='focus'&&input.windowId===paint.id;
      if(approval.tool==='computer_keyboard')allowed=input.action==='press'&&desktop.foregroundWindowId===paint.id&&!/\b(?:win|meta|command)\b|alt\+(?:tab|f4)|(?:control|ctrl)\+(?:n|o|v)\b/i.test(input.key||'');
      approvals.push({at:Date.now(),tool:approval.tool,input,allowed});
      if(!allowed){violation={tool:approval.tool,input,reason:'Prohibited method or input not bound to the owned Paint window'};await shell.evaluate(id=>window.browserUseDesktop.agentCancel(id),run.id);break;}
      await shell.evaluate(({runId,approvalId})=>window.browserUseDesktop.agentApprove({runId,approvalId,decision:'allow_once'}),{runId:run.id,approvalId:approval.id});
    }
    await pause(100);
  }
  run=await shell.evaluate(()=>window.browserUseDesktop.agentState());
  if(run&&!['completed','failed','cancelled'].includes(run.status)){deadlineReached=true;await shell.evaluate(id=>window.browserUseDesktop.agentCancel(id),run.id);await pause(300);run=await shell.evaluate(()=>window.browserUseDesktop.agentState());}
  const after=await tool('computer_screenshot',{maxWidth:1920});fs.writeFileSync(path.join(directory,'after.png'),Buffer.from(after.image.data,'base64'));
  const unchanged=originalHash===sourceHash();
  const result={model,directory,elapsedMs:Date.now()-startedAt,supervision:'Existing Ask; target-bound native input only',paint,viewer,deadlineReached,violation,sourceUnchanged:unchanged,screenChanged:before.imageHash!==after.imageHash,likeness:'Not independently graded',approvals,run};
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({model,directory,elapsedMs:result.elapsedMs,deadlineReached,violation,sourceUnchanged:unchanged,providerCalls:run?.coordinator?.metrics?.providerCalls,tools:run?.history?.map(h=>({tool:h.tool,action:h.input?.action,ok:h.output?.ok,completedStrokes:h.output?.result?.completedStrokes,error:h.output?.error})),result:run?.result,likeness:result.likeness}));
  if(!unchanged||violation||deadlineReached||run?.result?.success!==true)process.exitCode=1;
}catch(error){
  console.error(error.stack||error.message);process.exitCode=1;
  try{run=await shell?.evaluate(()=>window.browserUseDesktop.agentState());if(run?.id)await shell.evaluate(id=>window.browserUseDesktop.agentCancel(id),run.id);}catch{}
  fs.writeFileSync(path.join(directory,'failed.json'),JSON.stringify({error:error.message,paint,viewer,run,approvals},null,2));
}finally{
  await app?.close().catch(()=>{});
  console.log(`Evidence retained at ${directory}; newly launched Paint/viewer windows are left open.`);
}
