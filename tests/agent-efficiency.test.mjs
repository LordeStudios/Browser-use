import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const require=createRequire(import.meta.url);
const {DesktopChatAgent}=require('../desktop/agent/desktopChatAgent.cjs');
const {createCoordinatorState,measureProviderRequest}=require('../desktop/agent/desktopAgentCoordinator.cjs');
const {boundedRequestContext,createOllamaProvider}=require('../desktop/agent/ollamaProvider.cjs');
const {createOpenAiCompatibleProvider}=require('../desktop/agent/openAiCompatibleProvider.cjs');
const {ChatHistoryStore}=require('../desktop/store/chatHistoryStore.cjs');
const {COMPUTER_TOOLS}=require('../desktop/computer/computerCatalog.cjs');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const done={done:{summary:'Fixture inspected',success:true,verified:true}};
const desktop={foregroundWindowId:'42',virtualDesktop:{x:0,y:0,width:1920,height:1080},windows:[{id:'42',title:'Native fixture',pid:3,bounds:{x:0,y:0,width:800,height:600}}]};
function harness({complete=async()=>done}={}) {
  const contexts=[];let browserReads=0,captures=0,desktopReads=0;
  const controller={navigationState:()=>({url:'https://fixture.test',loading:false}),domSnapshot:()=>{browserReads++;return {elements:[]};},consoleEntries:()=>[],networkEntries:()=>[],listTabs:()=>[{id:'t'}],releaseSessionInput:()=>{}};
  const backend={observe:async()=>{desktopReads++;return structuredClone(desktop);},execute:async(name)=>{if(name==='computer_screenshot'){captures++;return {source:'native-desktop',data:'aW1n',mimeType:'image/png'};}return {dispatched:true};},releaseOwner:async()=>{},releaseInput:async()=>{}};
  const agent=new DesktopChatAgent({controller,getSelectedTabId:()=> 't',getControlMode:()=> 'agi',getComputerTools:()=>backend,emit:()=>{},createProvider:()=>({complete:async context=>{contexts.push(context);return complete(context,contexts.length);}})});
  return {agent,contexts,counts:()=>({browserReads,captures,desktopReads})};
}
test('recovery measures each decision independently from cumulative thought-card age',async()=>{
  const h=harness({complete:async(_context,n)=>{await pause(100);if(n===1)throw Error('recoverable fixture failure');return done;}});
  const start=performance.now();const result=await h.agent.start({task:'Inspect fixture'});const wall=performance.now()-start;
  assert.equal(result.coordinator.metrics.providerCalls,2);
  assert.ok(result.coordinator.metrics.phaseMs.model<=wall+10,`${result.coordinator.metrics.phaseMs.model} model ms exceeds ${wall} total ms`);
});
for(const vision of ['auto','always','off'])test(`fresh AGI uses desktop metadata first; vision=${vision}`,async()=>{
  const h=harness();await h.agent.start({task:'Inspect the current environment',settings:{controlMode:'agi',vision}});
  assert.equal(h.contexts[0].observation.desktop.foregroundWindowId,'42');
  assert.deepEqual(h.counts(),{browserReads:0,desktopReads:1,captures:vision==='always'?1:0});
});
test('Browser-only startup remains a browser observation',async()=>{
  const h=harness();await h.agent.start({task:'Inspect the page',settings:{controlMode:'browser'}});
  assert.deepEqual(h.counts(),{browserReads:1,desktopReads:0,captures:0});
});
test('history preserves explicit domain and old target supplies a restoration hint',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bu-domain-'));
  try{
    const store=new ChatHistoryStore({filePath:path.join(directory,'history.json')});
    store.checkpoint({id:'c',status:'completed',observationDomain:'computer',target:'computer://desktop'});await store.flush();
    assert.equal(store.get('c').observationDomain,'computer');
    for(const [conversation,mode,expected] of [
      [{id:'c',observationDomain:'computer'},'agi','computer'],
      [{id:'c',observationDomain:'browser'},'agi','browser'],
      [{id:'c',target:'computer://desktop'},'agi','computer'],
      [{id:'c',observationDomain:'computer'},'browser','browser']
    ]){
      const h=harness();await h.agent.start({task:'Continue',continuation:true,conversation,settings:{controlMode:mode}});
      assert.equal(Boolean(h.contexts[0].observation.desktop),expected==='computer');
    }
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
test('model desktop projection is foreground-first, retains identities and labels omitted geometry',()=>{
  const windows=Array.from({length:30},(_,i)=>({id:String(i),title:'Same title',pid:3,minimized:false,bounds:{x:i,y:0,width:100,height:100}}));
  const observation={desktop:{...desktop,foregroundWindowId:'29',windows}};const before=JSON.stringify(observation);
  const context=boundedRequestContext({observation,tools:[],history:[]});
  assert.equal(context.observation.desktop.windows[0].id,'29');
  assert.equal(new Set(context.observation.desktop.windows.map(w=>w.id)).size,30);
  assert.ok(context.observation.desktop.windows.at(-1).geometryOmitted);
  assert.ok(context.observation.desktop.windows[0].bounds);
  assert.equal(JSON.stringify(observation),before);
});
for(const providerId of ['openai','anthropic'])test(`${providerId} sends schemas once and measures actual repair requests`,async()=>{
  const requests=[],coordinator=createCoordinatorState();
  const provider=createOpenAiCompatibleProvider({providerId,baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'DO_NOT_LOG_SECRET',fetchImpl:async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    const text=requests.length===1?'malformed decision':JSON.stringify(done);
    return Response.json(providerId==='anthropic'?{content:[{type:'text',text}]}:{choices:[{message:{content:text}}]});
  }});
  await provider.complete({task:'Inspect fixture',observation:{dom:{elements:[]}},tools:COMPUTER_TOOLS,history:[],coordinator});
  assert.equal(requests.length,2);
  for(const request of requests){const user=request.messages.find(m=>m.role==='user');const text=typeof user.content==='string'?user.content:user.content.find(p=>p.type==='text').text;assert.equal(JSON.parse(text).tools,undefined);assert.ok(request.tools.length);}
  assert.equal(coordinator.metrics.providerRequests,2);assert.equal(coordinator.metrics.providerRequestKinds.repair,1);
  assert.equal(coordinator.metrics.providerRequestBytes,requests.reduce((sum,body)=>sum+Buffer.byteLength(JSON.stringify(body)),0));
  assert.equal(JSON.stringify(coordinator.metrics).includes('DO_NOT_LOG_SECRET'),false);
});
test('native-tool fallback retains textual schemas without adding a request',async()=>{
  const requests=[],coordinator=createCoordinatorState();
  const provider=createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return requests.length===1?Response.json({error:{message:'tools unsupported'}},{status:400}):Response.json({choices:[{message:{content:JSON.stringify(done)}}]});}});
  await provider.complete({task:'Inspect fixture',tools:COMPUTER_TOOLS,history:[],coordinator});
  assert.equal(requests.length,2);assert.ok(requests[0].tools);assert.equal(requests[1].tools,undefined);
  // The ledger wire leads with the pinned objective message; the user JSON
  // context is the final message.
  const fallbackUser=requests[1].messages.at(-1);
  const fallbackText=typeof fallbackUser.content==='string'?fallbackUser.content:fallbackUser.content.find(p=>p.type==='text').text;
  assert.equal(JSON.parse(fallbackText).tools.length,COMPUTER_TOOLS.length);
  assert.equal(coordinator.metrics.providerRequestKinds['capability-fallback'],1);
});
test('HTTP retry counts separately from its single outer decision',async()=>{
  let requests=0;
  const provider=createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async()=>++requests===1?Response.json({error:{message:'temporary'}},{status:503}):Response.json({choices:[{message:{content:JSON.stringify(done)}}]})});
  const h=harness({complete:context=>provider.complete(context)});const run=await h.agent.start({task:'Inspect fixture'});
  assert.equal(run.coordinator.metrics.providerCalls,1);assert.equal(run.coordinator.metrics.providerRequests,2);
  assert.equal(run.coordinator.metrics.providerRequestKinds['transport-retry'],1);
  assert.deepEqual(run.coordinator.metrics.providerRequestOutcomes,{failed:1,completed:1});
});
for(const kind of ['stream','abort'])test(`${kind} failure settles actual request once without replaying it`,async()=>{
  const controller=new AbortController(),coordinator=createCoordinatorState();let requests=0;
  const provider=createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async()=>{
    requests++;
    if(kind==='abort'){controller.abort();throw new DOMException('fixture abort','AbortError');}
    return new Response(new ReadableStream({start(stream){stream.error(Error('broken fixture stream'));}}),{headers:{'content-type':'text/event-stream'}});
  }});
  await assert.rejects(provider.complete({task:'Inspect fixture',history:[],coordinator,signal:controller.signal,onThought:()=>{}}));
  assert.equal(requests,1);assert.equal(coordinator.metrics.providerRequests,1);
  assert.equal(coordinator.metrics.providerRequestOutcomes[kind==='abort'?'aborted':'failed'],1);
});
test('request summaries are bounded and include body-read duration but no payload',async()=>{
  const coordinator=createCoordinatorState();
  for(let i=0;i<40;i++)await measureProviderRequest(coordinator,{body:'private input never logged'},async received=>{received({status:200,ok:true});if(i===0)await pause(30);return 'private output';});
  assert.equal(coordinator.metrics.providerRequests,40);assert.equal(coordinator.metrics.providerRequestHistory.length,32);
  assert.ok(coordinator.metrics.providerRequestMs>=25);
  assert.equal(JSON.stringify(coordinator.metrics).includes('private'),false);
});
test('first executable tool timings exclude plan updates and final replies',async()=>{
  const h=harness({complete:async(_context,n)=>n===1?{actions:[{name:'update_plan',input:{steps:['Inspect']}}]}:n===2?{actions:[{name:'computer_window',input:{action:'list'}}]}:done});
  const run=await h.agent.start({task:'Inspect fixture',settings:{controlMode:'agi'}});
  assert.ok(run.coordinator.metrics.firstToolStartedMs>=0);
  assert.ok(run.coordinator.metrics.firstToolSettledMs>=run.coordinator.metrics.firstToolStartedMs);
  assert.equal(run.attemptStartedClock,undefined);assert.doesNotThrow(()=>structuredClone(run));
  const h2=harness();const direct=await h2.agent.start({task:'Answer fixture'});assert.equal(direct.coordinator.metrics.firstToolStartedMs,null);
});
test('native schemas remove measurable duplicate request bytes',async()=>{
  let body;const provider=createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async(_url,init)=>{body=JSON.parse(init.body);return Response.json({choices:[{message:{content:JSON.stringify(done)}}]});}});
  await provider.complete({task:'Inspect fixture',tools:COMPUTER_TOOLS,history:[]});
  const duplicated=structuredClone(body);const user=duplicated.messages.find(m=>m.role==='user');user.content=JSON.stringify({...JSON.parse(user.content),tools:COMPUTER_TOOLS});
  const before=Buffer.byteLength(JSON.stringify(duplicated)),after=Buffer.byteLength(JSON.stringify(body));assert.ok(after<before);
  console.log(JSON.stringify({fixture:'native schema request bytes',before,after,saved:before-after}));
});

test('evidence-backed verified completion settles in one turn; unevidenced claims are corrected, not bounced',async()=>{
  let observedChanges=0;
  const observed=async()=>{observedChanges++;return {foregroundWindowId:'42',virtualDesktop:{x:0,y:0,width:800,height:600},windows:[{id:'42',title:'Fixture',bounds:{x:observedChanges,y:0,width:800,height:600}}]};};
  const controller={listTabs:()=>[{id:'t'}],releaseSessionInput:()=>{}};
  const make=done=>{const backend={observe:observed,execute:async(name,input)=>name==='computer_screenshot'?{source:'native-desktop',data:'aW1n',mimeType:'image/png'}:{dispatched:true},releaseOwner:async()=>{},releaseInput:async()=>{}};
    let calls=0;return new DesktopChatAgent({controller,getSelectedTabId:()=> 't',getControlMode:()=> 'agi',getComputerTools:()=>backend,emit:()=>{},createProvider:()=>({complete:async()=>{calls++;if(calls===1)return {actions:[1,2,3].map(n=>({name:'computer_pointer',input:{action:'click',x:100+n*10,y:100},expect:`fixture mutation ${n}`}))};if(done.done?.verified===false)return calls===2?done:{done:{summary:'Verified after review',success:true,verified:true}};return done;}})});};
  const settled=await make({done:{summary:'All observed changes reconcile with the goal',success:true,verified:true}}).start({task:'Fixture',settings:{controlMode:'agi'}});
  assert.equal(settled.result.success,true);
  assert.equal(settled.history.filter(h=>h.tool==='browser_done').length,1,'evidence-backed verified done must not bounce');
  // Owner policy (2026-11-02): verification never blocks a genuine run. The
  // unverified claim is still corrected (its concern rides the result), but
  // the run closes instead of demanding another review round trip.
  const closed=await make({done:{summary:'Claiming completion',success:true,verified:false}}).start({task:'Fixture',settings:{controlMode:'agi'}});
  assert.equal(closed.status,'completed','an unverified honest report must still close the run');
  assert.equal(closed.history.filter(h=>h.tool==='browser_done').length,1,'no bounce: verification never blocks a genuine run');
});
test('batched native mutations settle only against subsequent native evidence',async()=>{
  const {createCoordinatorState,recordObservation,recordAction}=require('../desktop/agent/desktopAgentCoordinator.cjs');
  const state=createCoordinatorState();
  const observation=(title='Fixture')=>({desktop:{foregroundWindowId:'42',windows:[{id:'42',title,bounds:{x:0,y:0,width:800,height:600}}]},navigation:{url:'computer://desktop'},dom:{elements:[]}});
  recordObservation(state,observation());
  for(const n of [1,2,3])recordAction(state,{hash:`computer_pointer:click${n}`,mutates:true,output:{ok:true},expectation:`m${n}`,call:{name:'computer_pointer',input:{action:'click',x:n,y:n}},observation:observation()});
  assert.equal(state.completedWork.length,3);
  assert.equal(state.completedWork.every(w=>w.effectObserved===false),true);
  recordObservation(state,observation('Changed native fixture'));
  assert.equal(state.completedWork.length,3,'a changed observation must confirm every pending batch member');
  assert.equal(state.completedWork.every(w=>w.effectObserved===true),true);
  const unchanged=createCoordinatorState();
  recordObservation(unchanged,observation());
  for(const n of [1,2])recordAction(unchanged,{hash:`computer_pointer:click${n}`,mutates:true,output:{ok:true},call:{name:'computer_pointer',input:{action:'click',x:n,y:n}},observation:observation()});
  recordObservation(unchanged,{...observation(),dom:{elements:[{name:'Unrelated browser content changed'}]}});
  assert.equal(unchanged.completedWork.length,0,'an unchanged observation must not confirm unproven mutations');
});
test('Ollama has one computer schema catalog and measures stream plus repair',async()=>{
  const requests=[],coordinator=createCoordinatorState();
  const provider=createOllamaProvider({baseUrl:'http://localhost:11434',model:'fixture',fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));return Response.json({message:{content:requests.length===1?'malformed decision':JSON.stringify(done)},done:true});}});
  await provider.complete({task:'Inspect fixture',tools:COMPUTER_TOOLS,history:[],coordinator});
  assert.equal(requests.length,2);assert.equal(requests[0].messages[0].content.includes('Computer tool schemas:'),false);
  // The ledger wire leads with the pinned objective message; the user JSON
  // context is the final message.
  const ollamaUser=requests[0].messages.at(-1);
  assert.equal(JSON.parse(ollamaUser.content).tools.length,COMPUTER_TOOLS.length);
  assert.equal(coordinator.metrics.providerRequests,2);assert.equal(coordinator.metrics.providerRequestKinds.repair,1);
});

// ---- Diagnosis convergence (2026-10-01) --------------------------------------

test('a diagnosis task gets an answer-now nudge, not the coding nudge', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const contexts = [];
  let decision = 0;
  const agent = new DesktopChatAgent({
    controller: {
      async domSnapshot(tabId) { return { tabId, url: 'https://fixture.test', title: 'F', viewport: { width: 1280, height: 720 }, elements: [{ index: 0, tag: 'div', name: 'overlay', text: 'overlay', enabled: true }], truncated: false }; },
      navigationState(t) { return { tabId: t, url: 'https://fixture.test', loading: false }; },
      consoleEntries() { return []; }, networkEntries() { return []; },
      async clickElement(t, a) { return { tabId: t, ...a }; }, async navigate(t, u) { return { tabId: t, url: u }; },
      type() { return { length: 0 }; }, async scroll() { return {}; }, key() { return {}; },
      async screenshot() { return { data: 'img' }; }, releaseSessionInput() { return { released: true }; }
    },
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(context) {
        contexts.push(context);
        decision += 1;
        if (decision < 4) return { toolCalls: [{ name: 'browser_query', input: { selector: `[data-x="${decision}"]` } }] };
        return { done: { summary: 'The border is offset because the overlay ignores canvas zoom.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Find out why some elements transformation border is offset the buttons', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  // Decision 4 (streak 3) must carry the DIAGNOSIS convergence nudge.
  const nudge = contexts[3].messages.filter((m) => m.source === 'runtime' && /Evidence-phase check/.test(m.content)).at(-1)?.content || '';
  assert.match(nudge, /diagnosis task/);
  assert.match(nudge, /ANSWER NOW/);
  assert.doesNotMatch(nudge, /computer_patch/, 'the coding nudge must not leak into a browser-mode diagnosis run');
  assert.match(nudge, /transformation border is offset/i, 'the nudge quotes the question to answer');
});
