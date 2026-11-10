import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {createOpenAiCompatibleProvider}=require('../desktop/agent/openAiCompatibleProvider.cjs');
const {DesktopChatAgent}=require('../desktop/agent/desktopChatAgent.cjs');
const {COMPUTER_TOOLS}=require('../desktop/computer/computerCatalog.cjs');
const {createCoordinatorState}=require('../desktop/agent/desktopAgentCoordinator.cjs');
const call=(id,name,input)=>({type:'function_call',id:'item-'+id,call_id:id,name,arguments:JSON.stringify(input),status:'completed'});
function providerHarness(outputs){const bodies=[];const provider=createOpenAiCompatibleProvider({protocol:'responses',providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'private-key',fetchImpl:async(_url,init)=>{bodies.push(JSON.parse(init.body));return Response.json({status:'completed',output:outputs[bodies.length-1],usage:{input_tokens:20,output_tokens:10}});}});return {provider,bodies};}
const base={task:'Perform fixture operations',tools:COMPUTER_TOOLS,history:[],coordinator:createCoordinatorState()};
test('native IDs and actual tool results survive an end-to-end agent decision',async()=>{
  const {provider,bodies}=providerHarness([[call('c1','computer_file',{action:'read',path:'I:/fixture.txt'})],[call('c2','browser_done',{summary:'Read the observed value',success:true,verified:true})]]);
  const backend={observe:async()=>({windows:[],virtualDesktop:{x:0,y:0,width:800,height:600}}),execute:async()=>({path:'I:/fixture.txt',content:'ACTUAL_RESULT'}),releaseOwner:async()=>{},releaseInput:async()=>{}};
  const controller={listTabs:()=>[{id:'t'}],releaseSessionInput:()=>{}};
  const agent=new DesktopChatAgent({controller,getSelectedTabId:()=> 't',getControlMode:()=> 'agi',getComputerTools:()=>backend,emit:()=>{},createProvider:()=>provider});
  const run=await agent.start({task:'Read fixture',settings:{controlMode:'agi',approvalMode:'unattended'}});
  assert.equal(run.result.success,true);assert.equal(run.history[0].callId,'c1');
  const result=bodies[1].input.find(item=>item.type==='function_call_output');assert.equal(result.call_id,'c1');assert.equal(JSON.parse(result.output).result.content,'ACTUAL_RESULT');
  assert.equal(bodies[1].input.filter(item=>item.type==='function_call').length,1);
  assert.equal(JSON.stringify(run).includes('private-key'),false);assert.doesNotThrow(()=>structuredClone(run));
});
test('clipped or skipped tool calls are never represented as successful execution',async()=>{
  const {provider,bodies}=providerHarness([[call('a','computer_observe',{}),call('b','computer_observe',{})],[call('end','browser_done',{summary:'Observed',success:true})]]);
  await provider.complete(base);
  await provider.complete({...base,history:[{callId:'a',tool:'computer_observe',input:{},output:{ok:true,result:{windows:[]}}}]});
  const results=bodies[1].input.filter(item=>item.type==='function_call_output').map(item=>JSON.parse(item.output));
  assert.equal(results[0].ok,true);assert.equal(results[1].executed,false);assert.equal(results[1].ok,false);
});
test('provider-native opaque reasoning and phase metadata replay unchanged',async()=>{
  const item={type:'reasoning',id:'r',encrypted_content:'opaque-fixture',summary:[]};
  const message={type:'message',id:'m',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Checking the next item'}]};
  const {provider,bodies}=providerHarness([[item,message,call('a','computer_observe',{})],[call('end','browser_done',{summary:'Observed',success:true})]]);
  await provider.complete(base);await provider.complete({...base,history:[{callId:'a',tool:'computer_observe',input:{},output:{ok:true,result:{windows:[]}}}]});
  assert.deepEqual(bodies[1].input.find(x=>x.id==='r'),item);assert.deepEqual(bodies[1].input.find(x=>x.id==='m'),message);
  assert.equal(bodies[1].store,false);
});
test('incomplete responses are rejected without exposing partial actions',async()=>{
  const provider=createOpenAiCompatibleProvider({protocol:'responses',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'key',fetchImpl:async()=>Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[call('x','computer_observe',{})]})});
  await assert.rejects(provider.complete(base),/max_output_tokens/);
});

test('Astra selects Responses without changing the model; compatible models keep their route', async () => {
  const requests=[];
  const fetchImpl=async(url,init)=>{requests.push({url,body:JSON.parse(init.body)});return Response.json({status:'completed',output:[call('end','browser_done',{summary:'Inspected',success:true})]});};
  const provider=createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'openai/gpt-6-astra',apiKey:'key',fetchImpl});
  await provider.complete(base);
  assert.equal(requests[0].url,'https://fixture.invalid/v1/responses');
  assert.equal(requests[0].body.model,'openai/gpt-6-astra');
  // Reasoning summaries are requested explicitly; without this the thought
  // channel stays empty because Responses emits no summary deltas by default.
  assert.deepEqual(requests[0].body.reasoning,{summary:'auto'});
  assert.deepEqual(requests[0].body.include,['reasoning.encrypted_content']);
  assert.equal(createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'compatible-fixture',apiKey:'key',fetchImpl}).constructor.name,'OpenAiCompatibleProvider');
});

test('Responses commentary phase is not promoted to a completed task', async () => {
  const message={type:'message',id:'m',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'I will inspect the next control.'}]};
  const {provider,bodies}=providerHarness([[message],[call('next','computer_observe',{})]]);
  const first=await provider.complete(base);
  assert.equal(first.done,undefined);
  assert.deepEqual(first.actions,[]);
  await provider.complete({...base,recovery:{attempts:1,source:'empty_decision',lastError:'Issue the next grounded action.'}});
  assert.deepEqual(bodies[1].input.find(item=>item.id==='m'),message);
});

test('Responses stream keeps public commentary out of the thought channel', async () => {
  const thoughts=[];
  const payload={status:'completed',output:[call('end','browser_done',{summary:'Inspected',success:true})]};
  const events=[{type:'response.output_text.delta',delta:'Public progress.'},{type:'response.reasoning_summary_text.delta',delta:'Provider summary.'},{type:'response.completed',response:payload}];
  const provider=createOpenAiCompatibleProvider({protocol:'responses',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'key',fetchImpl:async()=>new Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}})});
  await provider.complete({...base,onThought:text=>thoughts.push(text)});
  assert.deepEqual(thoughts,['Provider summary.']);
});

test('unsupported Responses endpoint stops once without a silent legacy fallback', async () => {
  let requests=0;
  const provider=createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'openai/gpt-6-astra',apiKey:'key',fetchImpl:async()=>{requests++;return Response.json({error:{message:'Route not available'}},{status:404});}});
  const agent=new DesktopChatAgent({controller:{listTabs:()=>[{id:'t'}],releaseSessionInput(){}},getSelectedTabId:()=> 't',getControlMode:()=> 'agi',
    getComputerTools:()=>({observe:async()=>({windows:[],virtualDesktop:{x:0,y:0,width:800,height:600}}),releaseOwner:async()=>{}}),createProvider:()=>provider,emit(){}});
  const run=await agent.start({task:'Inspect the current environment',settings:{controlMode:'agi'}});
  assert.equal(requests,1); assert.equal(run.result.success,false); assert.equal(run.result.verified,false);
  assert.match(run.result.summary,/Responses tool-calling contract/);
});
