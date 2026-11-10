import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {generateCase,digest} from './cases.mjs';
import {SandboxEnvironment,sandboxController} from './environment.mjs';
import {scoreRun} from './scoring.mjs';
const require=createRequire(import.meta.url);
const {DesktopChatAgent}=require('../../desktop/agent/desktopChatAgent.cjs');
const {createOpenAiCompatibleProvider}=require('../../desktop/agent/openAiCompatibleProvider.cjs');
const root=path.resolve(import.meta.dirname,'../..');
function arg(name,fallback){const index=process.argv.indexOf('--'+name);return index<0?fallback:process.argv[index+1];}
export async function runTrial({family='reconcile',level=1,seed=17,split='dev',label='baseline',directory,requestLimit=18,actionLimit=48,deadlineMs=180000}={}){
  const baseUrl=(process.env.ANTHROPIC_BASE_URL||'').replace(/\/$/,'').replace(/(?:\/v1)?$/,'/v1'),apiKey=process.env.ANTHROPIC_AUTH_TOKEN;
  const model=process.env.BROWSER_USE_EVAL_MODEL||'openai/gpt-6-astra';
  if(!baseUrl.startsWith('https://')||!apiKey)throw Error('Existing xKiro environment is required; no stub-provider fallback exists.');
  directory||=await fs.mkdtemp(path.join(os.tmpdir(),'bu-sandbox-'));
  const workspace=path.join(directory,'workspace');await fs.mkdir(workspace,{recursive:true});
  let fixture,visual;
  if(family==='visual'){const {createVisualCase}=await import('./visual.mjs');({fixture,visual}=await createVisualCase({directory,level,seed,split}));}
  else fixture=await generateCase(workspace,{family,level,seed,split});
  await fs.writeFile(path.join(directory,'oracle.json'),JSON.stringify(fixture.manifest,null,2));
  const sources={};for(const name of ['desktopChatAgent.cjs','openAiCompatibleProvider.cjs','responsesProvider.cjs','ollamaProvider.cjs','desktopAgentCoordinator.cjs'])sources[name]=digest(await fs.readFile(path.join(root,'desktop/agent',name)));
  const environment=new SandboxEnvironment(workspace,{visual}),events=[],requests=[];
  let stoppedReason=null,requestCount=0,actions=0,provider,agent,run;
  const protocol=process.env.BROWSER_USE_EVAL_PROTOCOL||'chat-completions';
  const metadata={family,level,seed,split,label,model,baseUrl,protocol,sources,requestLimit,actionLimit,deadlineMs};
  await fs.writeFile(path.join(directory,'metadata.json'),JSON.stringify(metadata,null,2));
  const fetchImpl=async(url,init)=>{
    if(requestCount>=requestLimit){stoppedReason='request-limit';agent?.cancel(agent.state().id);throw Error('Evaluation request limit reached');}
    requestCount++;const body=JSON.parse(init.body),at=Date.now();
    await fs.appendFile(path.join(directory,'wire-requests.jsonl'),JSON.stringify({n:requestCount,url,body})+'\n');
    const response=await fetch(url,init);
    requests.push({n:requestCount,status:response.status,at,requestBytes:Buffer.byteLength(init.body)});
    const content=await response.text();
    await fs.appendFile(path.join(directory,'wire-responses.jsonl'),JSON.stringify({n:requestCount,status:response.status,body:content})+'\n');
    return new Response(content,{status:response.status,headers:response.headers});
  };
  provider=createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl,model,apiKey,fetchImpl,protocol});
  agent=new DesktopChatAgent({controller:sandboxController(),getSelectedTabId:()=> 'sandbox',getControlMode:()=> 'agi',getComputerTools:()=>environment,emit:event=>{
    if(['tool.started','tool.result','run.completed','run.cancelled'].includes(event.type))events.push({at:Date.now(),type:event.type,tool:event.tool,ok:event.output?.ok});
    if(event.type==='tool.started'&&!['browser_done','update_plan'].includes(event.tool)&&++actions>actionLimit){stoppedReason='action-limit';agent.cancel(agent.state().id);}
  },createProvider:()=>provider});
  const task=`You are in an isolated evaluation workspace. All data is generated. ${visual?'Native computer tools operate a stateful simulated drawing application and screenshots show its actual state. No host programs or files exist in this lane.':'Use computer_file for actual files within '+workspace+'. Host shell, browser, network, clipboard, and native input are unavailable; do not try to work outside this directory.'} Perform this objective without asking the evaluator for help: ${fixture.objective}`;
  const started=performance.now();
  const timer=setTimeout(()=>{stoppedReason='deadline';if(agent.state()?.id)agent.cancel(agent.state().id);},deadlineMs);
  console.log(JSON.stringify({event:'trial-start',...metadata,directory}));
  try{run=await agent.start({task,provider:{id:'xkiro',model},settings:{controlMode:'agi',approvalMode:'unattended',vision:'auto'}});}
  catch(error){stoppedReason=stoppedReason||error.message;run=agent.state();}
  finally{clearTimeout(timer);}
  const elapsedMs=performance.now()-started,checks=await fixture.grade();
  const score=scoreRun({checks,run,elapsedMs,environment,budgets:fixture.budgets,stoppedReason,httpRequests:requestCount});
  const result={...metadata,directory,score,run,events,requests,environmentCalls:environment.calls};
  if(visual)await visual.save(directory);
  await fs.writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2));await environment.close();
  console.log(JSON.stringify({event:'trial-result',directory,...metadata,score:{...score,requestMetrics:undefined}}));
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===import.meta.filename){
  await runTrial({family:arg('family','reconcile'),level:Number(arg('level','1')),seed:Number(arg('seed','17')),split:arg('split','dev'),label:arg('label','baseline'),requestLimit:Number(arg('requests','18')),deadlineMs:Number(arg('seconds','180'))*1000}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
}
