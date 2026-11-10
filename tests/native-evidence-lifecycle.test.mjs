import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {DesktopChatAgent}=require('../desktop/agent/desktopChatAgent.cjs');
const done={done:{summary:'Lifecycle fixture inspected',success:true,verified:true}};
async function scenario(sequence,{vision='always',closeTab=false}={}){
  let revision=1,browserReads=0,desktopReads=0,captures=0;
  const contexts=[];
  const inventory=()=>({foregroundWindowId:String(revision),virtualDesktop:{x:0,y:0,width:800,height:600},windows:[{id:String(revision),title:`Fixture ${revision}`,bounds:{x:0,y:0,width:800,height:600}}]});
  const backend={observe:async()=>{desktopReads++;return inventory();},execute:async(name,input)=>{
    if(name==='computer_screenshot'){captures++;return {source:'native-desktop',data:`pixels-${revision}`,mimeType:'image/png',screenshotId:`shot-${revision}`};}
    if(name==='computer_observe'||name==='computer_window'&&input.action==='list')return inventory();
    revision++;return {dispatched:true};
  },releaseOwner:async()=>{},releaseInput:async()=>{}};
  const controller={navigationState:()=>({url:'https://fixture.test',loading:false}),domSnapshot:()=>{browserReads++;return {elements:[]};},screenshot:async()=>({source:'browser',data:'browser-pixels',mimeType:'image/png'}),consoleEntries:()=>[],networkEntries:()=>[],listTabs:()=>closeTab?[]:[{id:'t'}],releaseSessionInput:()=>{},wait:async()=>{revision++;}};
  const agent=new DesktopChatAgent({controller,getSelectedTabId:()=> 't',getControlMode:()=> 'agi',getComputerTools:()=>backend,emit:()=>{},createProvider:()=>({complete:async context=>{
    contexts.push(structuredClone({...context,signal:undefined,onThought:undefined,onStream:undefined,onProgress:undefined}));
    return sequence(contexts.length,()=>revision++);
  }})});
  const run=await agent.start({task:'Inspect the changing native fixture',settings:{controlMode:'agi',vision}});
  return {run,contexts,browserReads,desktopReads,captures};
}
test('a wait in a native task keeps the domain and replaces pre-wait pixels',async()=>{
  // The scene changes around the wait; the wait itself invalidates the
  // pre-wait pixels so the next observation re-captures native evidence.
  const result=await scenario((n,advance)=>n===1?(advance(),{actions:[{name:'browser_wait',input:{ms:500}}]}):done);
  assert.equal(result.browserReads,0);
  assert.equal(result.contexts[1].observation.desktop.foregroundWindowId,'2');
  assert.equal(result.contexts[1].observation.screenshot.data,'pixels-2');
  assert.equal(result.run.observationDomain,'computer');
});
test('a native action breaks the consecutive-wait backoff streak',async()=>{
  const result=await scenario(n=>n===1||n===3?{actions:[{name:'browser_wait',input:{ms:500}}]}:n===2?{actions:[{name:'computer_pointer',input:{action:'move',x:100,y:100}}]}:done);
  const waits=result.run.history.filter(h=>h.tool==='browser_wait');
  assert.deepEqual(waits.map(h=>h.output.result.consecutiveWaits),[1,1]);
});
test('native wait works when the structural browser tab has closed',async()=>{
  const result=await scenario((n,advance)=>n===1?(advance(),{actions:[{name:'browser_wait',input:{ms:500}}]}):done,{closeTab:true});
  assert.equal(result.run.history.find(h=>h.tool==='browser_wait').output.ok,true);
  assert.equal(result.contexts[1].observation.desktop.foregroundWindowId,'2');
});
for(const tool of [{name:'computer_observe',input:{}},{name:'computer_window',input:{action:'list'}},{name:'computer_screenshot',input:{}}])test(`${tool.name} replaces stale top-level native evidence`,async()=>{
  const result=await scenario((n,advance)=>{if(n===1){advance();return {actions:[tool]};}return done;});
  assert.equal(result.contexts[1].observation.desktop.foregroundWindowId,'2');
  assert.equal(result.contexts[1].observation.screenshot.data,'pixels-2');
  assert.equal(result.browserReads,0);
  assert.equal(result.captures,2,'initial capture plus requested/refresh capture, not a duplicate');
});
test('switching to a browser read does not attach the old native image',async()=>{
  const result=await scenario(n=>n===1?{actions:[{name:'computer_screenshot',input:{}}]}:n===2?{actions:[{name:'browser_tabs',input:{}}]}:done,{vision:'auto'});
  assert.equal(result.run.observationDomain,'browser');
  assert.equal(result.contexts[2].observation.desktop,undefined);
  assert.notEqual(result.contexts[2].observation.screenshot?.source,'native-desktop');
});
test('refresh markers do not split an already-planned native batch',async()=>{
  const result=await scenario((n,advance)=>{if(n===1){advance();return {actions:[{name:'computer_observe',input:{}},{name:'computer_screenshot',input:{}}]};}return done;});
  assert.equal(result.run.coordinator.metrics.providerCalls,2);
  assert.deepEqual(result.run.history.slice(0,2).map(h=>h.tool),['computer_observe','computer_screenshot']);
  assert.equal(result.contexts[1].observation.desktop.foregroundWindowId,'2');
  assert.equal(result.captures,2);
});
