import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';
const root=path.resolve(import.meta.dirname,'..');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'bu-claude-comparison-'));
const model=process.env.BROWSER_USE_EVAL_MODEL || 'openai/gpt-5.6-sol';
const executable=process.env.CLAUDE_CODE_EXE || path.join(os.homedir(),'.local/bin/claude.exe');
const env={...process.env,TEMP:os.tmpdir(),TMP:os.tmpdir(),CLAUDE_CODE_TMPDIR:os.tmpdir(),ANTHROPIC_DEFAULT_HAIKU_MODEL:model,ANTHROPIC_SMALL_FAST_MODEL:model};
// A separately invoked benchmark must not attach itself to this controlling session.
delete env.CLAUDECODE; delete env.CLAUDE_CODE_ENTRYPOINT; delete env.ELECTRON_RUN_AS_NODE;
if(!env.ANTHROPIC_AUTH_TOKEN || !env.ANTHROPIC_BASE_URL) throw new Error('Existing xKiro auth/base URL are required.');
const toolSet='Bash,PowerShell,Read,Write,Edit,Glob,Grep';
const records=[];
console.log(`Evidence: ${directory}`);
async function trial(name,prompt){
  const args=['--name',`Sol benchmark ${name}`,'--safe-mode','--strict-mcp-config','--no-session-persistence','--no-chrome','--model',model,'--tools',toolSet,'--allowedTools',toolSet,'--permission-mode','acceptEdits','--permission-prompts','none','--output-format','stream-json','--verbose','--print',prompt];
  const events=[]; let buffer='',stderr='',timedOut=false,initAt=null;
  const startedAt=Date.now();
  const child=spawn(executable,args,{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const output=fs.createWriteStream(path.join(directory,`${name}.jsonl`));
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    output.write(chunk); buffer+=chunk;
    const lines=buffer.split('\n');buffer=lines.pop();
    for(const line of lines){try{const event=JSON.parse(line);events.push({...event,observedAt:Date.now()}); if(event.type==='system'&&event.subtype==='init')initAt??=Date.now();}catch{}}
  });
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-16000);});
  const timer=setTimeout(()=>{
    timedOut=true;
    // Terminate only the process tree this test launched.
    if(process.platform==='win32')spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
    else child.kill('SIGTERM');
  },240000);
  let code;
  try{code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});}
  finally{clearTimeout(timer); await new Promise(resolve=>output.end(resolve));}
  if(buffer.trim()){try{events.push({...JSON.parse(buffer),observedAt:Date.now()});}catch{}}
  const result=events.findLast(event=>event.type==='result');
  const assistantMessages=events.filter(event=>event.type==='assistant');
  const seenTools=new Set();
  const tools=assistantMessages.flatMap(event=>(event.message?.content||[]).filter(part=>part.type==='tool_use').map(part=>({id:part.id,name:part.name,input:part.input}))).filter(tool=>{if(seenTools.has(tool.id))return false;seenTools.add(tool.id);return true;});
  const toolErrors=events.filter(event=>event.type==='user').flatMap(event=>event.message?.content||[]).filter(part=>part.type==='tool_result'&&part.is_error===true);
  const finalAt=result?.observedAt || Date.now();
  const record={name,agent:'claude-code',model,reportedModel:events.find(event=>event.type==='system'&&event.subtype==='init')?.model,elapsedMs:finalAt-startedAt,startupMs:initAt?initAt-startedAt:null,exitCode:code,timedOut,
    providerMessages:new Set(assistantMessages.map(event=>event.message?.id).filter(Boolean)).size,reportedTurns:result?.num_turns,tools,toolErrors:toolErrors.length,result:result?.result,success:code===0&&result?.is_error===false,usage:result?.usage,modelUsage:result?.modelUsage,permissionDenials:result?.permission_denials,allCallsSameModel:Object.keys(result?.modelUsage || {}).every(id=>id===model),stderr};
  records.push(record);fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(records,null,2));
  console.log(JSON.stringify({name,elapsedMs:record.elapsedMs,startupMs:record.startupMs,success:record.success,providerMessages:record.providerMessages,reportedTurns:record.reportedTurns,tools:tools.map(t=>t.name),toolErrors:record.toolErrors,result:record.result,stderr}));
  return record;
}
try{
  const disk=await trial('disk-capacity','What is the total space of the fixed drives on this PC? Report each drive and the aggregate capacity, with exact total bytes as well as human-readable units.');
  const referencePath=process.env.BROWSER_USE_DISK_REFERENCE;
  if(referencePath){const reference=JSON.parse(fs.readFileSync(referencePath,'utf8').replace(/^﻿/,''));disk.answerVerified=String(disk.result).replace(/[,\s]/g,'').includes(String(reference.TotalBytes));}
  const target=path.join(directory,'AGI_testing');
  const htmlTrial=await trial('create-and-edit-html',`Create a new folder at ${JSON.stringify(target)} and a file webpage.html with an animated rainbow-colored page saying Success. Use actual files, check the saved contents, and finish with the exact path. Do not overwrite any existing files outside this new folder.`);
  const file=path.join(target,'webpage.html');
  htmlTrial.fileExists=fs.existsSync(file);
  if(htmlTrial.fileExists){
    const html=fs.readFileSync(file,'utf8'); htmlTrial.sourceVerified=/success/i.test(html)&&/@keyframes/.test(html)&&/gradient|hue-rotate/i.test(html);
    // Rendering here verifies the model's saved file; it does not author or repair it.
    const profile=path.join(directory,'verify-profile');fs.mkdirSync(profile);
    const app=await electron.launch({executablePath:path.join(root,'node_modules/electron/dist/electron.exe'),args:['.',`--user-data-dir=${profile}`],cwd:root,env:{...env,APPDATA:profile,LOCALAPPDATA:profile,BROWSER_USE_DESKTOP_MCP_PORT:'0'},timeout:40000});
    try{htmlTrial.rendered=await app.evaluate(async({BrowserWindow},file)=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true}});try{await window.loadFile(file);return await window.webContents.executeJavaScript('({text:document.body.innerText,animations:document.getAnimations().length})');}finally{window.destroy();}},file);}
    finally{await app.close();}
    htmlTrial.renderVerified=/success/i.test(htmlTrial.rendered.text)&&htmlTrial.rendered.animations>0;
  }
  fs.writeFileSync(path.join(directory,'results.json'),JSON.stringify(records,null,2));
  console.log(JSON.stringify({directory,diskVerified:disk.answerVerified,htmlVerified:htmlTrial.renderVerified}));
  if(!disk.success||disk.answerVerified===false||!htmlTrial.success||!htmlTrial.renderVerified)process.exitCode=1;
}catch(error){console.error(error.stack||error.message);process.exitCode=1;}
