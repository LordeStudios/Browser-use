import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parseArgs, makeSessionId, toolRoot, repoRoot, dataRoot } from './config.js';
import { launchControlledBrowser, normalizeEndpoint, killBrowserTree } from './browser/chromeLauncher.js';
import { connectToBrowser } from './browser/cdpClient.js';
import { EventBus } from './server/eventBus.js';
import { createToolRegistry } from './tools/toolRegistry.js';
import { executeTool } from './tools/toolExecutor.js';
import { startWebSocketServer } from './server/websocketServer.js';
import { AgentLoop } from './ollama/agentLoop.js';
import { startMcpServer } from './mcp/mcpServer.js';
import { startHttpMcpServer } from './mcp/httpMcpServer.js';
import { PairingService } from './pairing/pairingService.js';
import crypto from 'node:crypto';

function makeRealtimeInstanceId() {
  return crypto.randomUUID();
}


export async function createRuntime(opts=parseArgs()){
  const sessionId=makeSessionId();
  const sessionDir=path.join(dataRoot,'logs',sessionId);
  const eventBus=new EventBus(sessionId,sessionDir);
  eventBus.emitEvent('session.start',{opts:{...opts,args:undefined}});
  let launch=null, endpoint=normalizeEndpoint(opts.connect);
  if(!endpoint){ launch=await launchControlledBrowser({...opts, sessionId}); endpoint=launch.endpoint; }
  const browser=await connectToBrowser(endpoint);
  const pairing = new PairingService({ instanceId: opts.instanceId || makeRealtimeInstanceId() });
  const ctx={browser,eventBus,sessionId,sessionDir,config:opts,repoRoot,toolRoot,launch,startTime:Date.now(),actionTrace:[],pairing};
  eventBus.emitEvent('browser.connect',{endpoint});
  if(opts.url && opts.url!=='about:blank') await browser.navigate(opts.url);
  return ctx;
}
function withTimeout(promise,ms,label){return new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(new Error(`Timeout after ${ms}ms: ${label}`)),ms); promise.then(r=>{clearTimeout(t);resolve(r);},e=>{clearTimeout(t);reject(e);});});}

async function smoke(ctx,registry){
  const html='data:text/html,'+encodeURIComponent('<title>browser-use smoke</title><button id="b" onclick="console.log(\'clicked\')">Click me</button><input id="i"/><main>Hello smoke page</main>');
  await executeTool(ctx,registry,'browser.navigate',{url:html});
  await executeTool(ctx,registry,'browser.listTabs',{});
  await executeTool(ctx,registry,'browser.screenshot',{});
  await executeTool(ctx,registry,'browser.domSnapshot',{});
  await executeTool(ctx,registry,'browser.consoleLogs',{});
  await executeTool(ctx,registry,'browser.clickSelector',{selector:'#b'});
  await executeTool(ctx,registry,'browser.typeSelector',{selector:'#i',text:'smoke'});
  await executeTool(ctx,registry,'browser.scroll',{deltaY:100});
  await executeTool(ctx,registry,'browser.drag',{fromX:10,fromY:10,toX:20,toY:20,steps:2});
  await executeTool(ctx,registry,'browser.evaluate',{expression:'document.title'});
  await executeTool(ctx,registry,'browser.waitForSelector',{selector:'#b',timeout:1000});
  await executeTool(ctx,registry,'browser.waitForTimeout',{ms:100});
  await executeTool(ctx,registry,'browser.mousemove',{selector:'#b',position:{x:5,y:5}});
  await executeTool(ctx,registry,'browser.mousedown',{selector:'#b'});
  await executeTool(ctx,registry,'browser.mouseup',{selector:'#b'});
  return {ok:true,sessionId:ctx.sessionId,events:ctx.eventBus.file};
}

async function shutdown(ctx,ws){
  try{ws?.close?.();}catch{}
  try{await ctx.browser.close();}catch{}
  try{await killBrowserTree(ctx.launch);}catch{}
}
export function sessionTimeoutMs(opts){return Number(opts.maxSeconds||process.env.BROWSER_USE_MAX_SECONDS||60)*1000;}
async function runWithTimeout(ctx,fn,label='session'){const ms=sessionTimeoutMs(ctx.config); try{const result=await withTimeout(fn(),ms,label); return result;}catch(e){ctx.eventBus.emitEvent('session.timeout',{error:e.message,limitMs:ms}); throw e;}}
async function runCommandTool(ctx,registry,command,args,label){
  const start=Date.now();
  const result=await runWithTimeout(ctx,()=>executeTool(ctx,registry,command,args),label);
  ctx.eventBus.emitEvent('command.timing',{command,args,tookMs:Date.now()-start});
  return result;
}
async function runScript(ctx,registry,scriptPath){
  const mod = await import(path.isAbsolute(scriptPath) ? pathToFileURL(scriptPath).href : pathToFileURL(path.resolve(process.cwd(), scriptPath)).href);
  if(typeof mod.run !== 'function') throw new Error('Script module must export an async run(ctx, registry) function');
  return await mod.run(ctx, registry);
}
export async function main(){
  const opts=parseArgs();
  const registry=createToolRegistry();
  const isPiped=!process.stdin.isTTY;
  const explicitMode=opts.mcp||opts.mcpHttp||opts.smoke||opts.command||opts.script||opts.agent||opts.connect||opts.replay||(opts.url && opts.url!=='about:blank');
  const stdioMcp=opts.mcp || (isPiped && !explicitMode);
  const ctx=await createRuntime(opts);
  // stdio MCP mode must never bind local ports: each MCP host spawns its own
  // process, and a shared control-center port crashes the second spawn with
  // EADDRINUSE. The HTTP daemon replaces that model with one shared session.
  if(stdioMcp){startMcpServer(ctx,registry); return;}
  if(opts.mcpHttp){
    const mcpHttp=await startHttpMcpServer(ctx,registry,{host:opts.mcpHost,port:opts.mcpPort,secret:opts.mcpSecret,gptKey:opts.gptKey});
    const status=mcpHttp.status();
    console.log(JSON.stringify({ok:true,mode:'mcp-http',sessionId:ctx.sessionId,...status,secretGenerated:mcpHttp.secretWasGenerated?mcpHttp.secret:undefined},null,2));
    const onStop=async(signal)=>{ctx.eventBus.emitEvent('session.stop',{signal}); await mcpHttp.stop().catch(()=>{}); await shutdown(ctx,null); process.exit(0);};
    process.on('SIGINT',()=>onStop('SIGINT'));
    process.on('SIGTERM',()=>onStop('SIGTERM'));
    return;
  }
  const ws=await startWebSocketServer(ctx,registry,{port:opts.serverPort});
  if (!opts.script && !opts.command && !opts.smoke) {
    await ctx.browser.createTab(ws.controlCenterUrl);
  }
  if(opts.smoke){ try{ console.log(JSON.stringify(await runWithTimeout(ctx,()=>smoke(ctx,registry),'smoke'),null,2)); }catch(e){ console.error(JSON.stringify({ok:false,error:e.message,sessionId:ctx.sessionId},null,2)); } await shutdown(ctx,ws); return; }
  if(opts.script){
    try{
      const r=await runWithTimeout(ctx,()=>runScript(ctx,registry,opts.script),`script:${opts.script}`);
      console.log(JSON.stringify(r,null,2));
    }catch(e){
      console.error(JSON.stringify({ok:false,error:e.message,script:opts.script},null,2));
    }
    await shutdown(ctx,ws);
    return;
  }
  if(opts.command){
    try{
      const r=await runCommandTool(ctx,registry,opts.command,opts.args,`command:${opts.command}`);
      console.log(JSON.stringify(r,null,2));
    }catch(e){
      console.error(JSON.stringify({ok:false,error:e.message,command:opts.command},null,2));
    }
    await shutdown(ctx,ws);
    return;
  }
  let agent=null;
  if(opts.agent){agent=new AgentLoop(ctx,registry,opts); agent.start(opts.goal||'Inspect the current page.');}
  console.log(JSON.stringify({ok:true,sessionId:ctx.sessionId,websocketPort:ws.actualPort,controlCenter:ws.controlCenterUrl,endpoint:ctx.launch?.endpoint||opts.connect,mode:'headed-only'},null,2));
  const onShutdown=async(signal)=>{ctx.eventBus.emitEvent('session.stop',{signal}); await agent?.stop?.(); await shutdown(ctx,ws); process.exit(0);};
  process.on('SIGINT',()=>onShutdown('SIGINT'));
  process.on('SIGTERM',()=>onShutdown('SIGTERM'));
  process.on('uncaughtException',(e)=>{console.error('uncaughtException',e); onShutdown('uncaughtException').catch(()=>process.exit(1));});
  process.on('unhandledRejection',(e)=>{console.error('unhandledRejection',e); onShutdown('unhandledRejection').catch(()=>process.exit(1));});
}
if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) main().catch(e=>{console.error(e);process.exit(1)});
