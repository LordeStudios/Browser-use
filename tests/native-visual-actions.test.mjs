import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { validateComputerInput, normalizeComputerInput, COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { createOllamaProvider } = require('../desktop/agent/ollamaProvider.cjs');
const { mapPointerInput, pointerGuard, runStrokes } = require('../desktop/computer/pointerGesture.cjs');

const image = { source:'native-desktop', displayId:'one', width:1600, height:900, origin:{x:0,y:0}, scaleX:1.2, scaleY:1.2, data:'aW1hZ2U=', mimeType:'image/png' };
const gesture = () => ({ action:'stroke', windowId:'42', region:{x:1000,y:200,width:500,height:600}, strokes:[{points:[{x:1100,y:300},{x:1200,y:310},{x:1150,y:500}]}] });
function backendHarness(overrides = {}) {
  const calls=[];
  const capture={screenshot:async()=>({...image}), displays:()=>[{id:'one',bounds:{x:0,y:0,width:1920,height:1080}}], ...overrides};
  const backend=new ComputerTools({capture,nativeRequest:async(name,input,owner)=>{calls.push({name,input,owner});return {dispatched:true};}});
  return {backend,calls,capture};
}

test('ordinary pointer schema does not ask the model for drawing payloads',()=>{
  const pointer=COMPUTER_TOOLS.find(t=>t.name==='computer_pointer').inputSchema;
  assert.equal(pointer.properties.strokes,undefined);
  assert.equal(pointer.properties.region,undefined);
  assert.equal(pointer.properties.action.enum.includes('stroke'),false);
  const drawing=COMPUTER_TOOLS.find(t=>t.name==='computer_stroke');
  assert.ok(drawing);assert.deepEqual(drawing.inputSchema.required,['windowId','region','strokes']);
});
test('optional nulls and empty optional identities normalize without erasing meaningful input',()=>{
  const input={action:'click',x:129,y:1008,endX:null,endY:null,button:'left',deltaX:null,deltaY:null,durationMs:null,coordinateSpace:'desktop',screenshotId:'',windowId:'65880'};
  const normalized=normalizeComputerInput('computer_pointer',input);
  assert.deepEqual(normalized,{action:'click',x:129,y:1008,button:'left',coordinateSpace:'desktop',windowId:'65880'});
  assert.equal(input.endX,null,'the caller input must remain unchanged');
  assert.doesNotThrow(()=>validateComputerInput('computer_pointer',normalized));
  assert.throws(()=>pointerGuard(normalized,{x:0,y:0,width:1920,height:1080},{windowInfo:()=>({pid:7812,bounds:{x:0,y:1040,width:48,height:40}})}),/outside the target window/);
  assert.throws(()=>validateComputerInput('computer_pointer',normalizeComputerInput('computer_pointer',{action:null,x:1,y:2})),/Invalid|required/);
  assert.throws(()=>validateComputerInput('computer_stroke',normalizeComputerInput('computer_stroke',{windowId:'42',region:null,strokes:null})),/Invalid|required/);
});
test('separate stroke tool delegates to the existing guarded native executor',async()=>{
  const {backend,calls}=backendHarness();const input=gesture();delete input.action;
  await backend.execute('computer_stroke',input,'owner');
  assert.equal(calls[0].name,'computer_pointer');assert.equal(calls[0].input.action,'stroke');
  assert.deepEqual(calls[0].input.strokes,input.strokes);
});
test('reported cross-action stroke payload remains invalid rather than silently drawing or dropping a guard',()=>{
  const input={action:'click',x:129,y:1008,endX:0,endY:0,button:'left',deltaX:0,deltaY:0,durationMs:100,coordinateSpace:'desktop',screenshotId:'',windowId:'65880',region:{x:0,y:0,width:0,height:0},strokes:[{points:[{x:0,y:0},{x:0,y:0}],durationMs:100}]};
  assert.throws(()=>validateComputerInput('computer_pointer',input),/strokes requires action=stroke/);
});

test('nested stroke input rejects malformed points, properties and excessive work',()=>{
  for (const mutate of [
    input=>{input.region=null;}, input=>{input.windowId='';}, input=>{input.strokes[0].points[1].x=NaN;},
    input=>{input.strokes[0].points[1].x=999;}, input=>{input.strokes[0].points[1].extra=true;},
    input=>{input.strokes[0].durationMs=-1;}, input=>{input.strokes[0].durationMs=10001;},
    input=>{input.strokes=Array.from({length:33},()=>input.strokes[0]);},
    input=>{input.strokes[0].points=Array(513).fill({x:1100,y:300});}, input=>{input.durationMs=100;}
  ]) { const input=gesture(); mutate(input); assert.throws(()=>validateComputerInput('computer_pointer',input)); }
});
test('mapping handles negative origins, 2x DPI and complete stroke regions',()=>{
  const shot={...image,screenshotId:'s',origin:{x:-3200,y:-1800},scaleX:2,scaleY:2};
  const input={action:'stroke',windowId:'42',coordinateSpace:'screenshot',screenshotId:'s',region:{x:100,y:100,width:200,height:200},strokes:[{points:[{x:150,y:150},{x:200,y:200}],durationMs:100}]};
  const mapped=mapPointerInput(input,shot,[{id:'one',bounds:{x:-3200,y:-1800,width:3200,height:1800}}]);
  assert.deepEqual(mapped.region,{x:-3000,y:-1600,width:400,height:400});
  assert.deepEqual(mapped.strokes[0].points,[{x:-2900,y:-1500},{x:-2800,y:-1400}]);
  assert.equal(mapped.screenshotId,undefined); assert.equal(input.strokes[0].points[0].x,150,'input is not modified');
});
test('target guards reject complete batch before movement and detect changed focus, occlusion and geometry',()=>{
  const args=gesture(), desktop={x:0,y:0,width:1920,height:1080};
  let live={id:'42',pid:3,bounds:{x:960,y:0,width:960,height:1040}},front='42',hit='42';
  const adapters={windowInfo:()=>structuredClone(live),foregroundWindowId:()=>front,windowAt:()=>hit};
  const guard=pointerGuard(args,desktop,adapters);
  assert.doesNotThrow(()=>guard({x:1100,y:300}));
  assert.throws(()=>guard({x:925,y:300}),/outside/,'guarded scroll without an explicit position must check the actual cursor');
  front='43'; assert.throws(()=>guard({x:1100,y:300}),/foreground/); front='42';
  hit='43'; assert.throws(()=>guard({x:1100,y:300}),/covers/); hit='42';
  live.bounds.x++; assert.throws(()=>guard({x:1100,y:300}),/changed/); live.bounds.x--;
  args.strokes[0].points.push({x:925,y:300}); assert.throws(()=>pointerGuard(args,desktop,adapters),/outside/);
});
test('stroke execution preserves planned vertices, pen lifts and partial cancellation',async()=>{
  const args=gesture(); args.strokes.push({points:[{x:1300,y:400},{x:1320,y:480}],durationMs:0});
  const events=[];
  const result=await runStrokes(args,{check:()=>{},move:p=>events.push(['move',p]),button:down=>events.push(['button',down]),pause:async()=>{}});
  assert.equal(result.completedStrokes,2); assert.deepEqual(events.filter(e=>e[0]==='button'),[['button',true],['button',false],['button',true],['button',false]]);
  for(const stroke of args.strokes) for(const point of stroke.points) assert.ok(events.some(e=>e[0]==='move'&&e[1].x===point.x&&e[1].y===point.y));
  const released=[]; let checks=0, moves=0;
  await assert.rejects(runStrokes(args,{check:()=>{if(++checks===3)throw Error('cancelled');},move:()=>{moves++;},button:down=>released.push(down),pause:async()=>{}}),/0\/2.*partial.*cancelled/);
  assert.deepEqual(released,[true,false]); assert.equal(moves,2);
});
test('invalid last stroke point causes zero movement and button events',async()=>{
  const args=gesture(); args.strokes[0].points.push({x:925,y:300}); let events=0;
  await assert.rejects(runStrokes(args,{check:()=>{},move:()=>events++,button:()=>events++}),/outside/); assert.equal(events,0);
});

test('pointer catalog accepts bounded multi-point native strokes',()=>{
  assert.doesNotThrow(()=>validateComputerInput('computer_pointer',gesture()));
});
test('screenshot coordinates map once to physical pixels, not into the other window',async()=>{
  const {backend,calls}=backendHarness();
  const shot=await backend.execute('computer_screenshot',{},'owner');
  assert.ok(shot.screenshotId,'capture must issue an owner-bound coordinate reference');
  await backend.execute('computer_pointer',{action:'drag',coordinateSpace:'screenshot',screenshotId:shot.screenshotId,x:925,y:250,endX:950,endY:270},'owner');
  assert.equal(calls[0].input.x,1110); assert.equal(calls[0].input.endX,1140); assert.equal(calls[0].input.y,300);
});
test('cross-owner and superseded screenshot mappings reject before input',async()=>{
  const {backend,calls}=backendHarness();
  const shot=await backend.execute('computer_screenshot',{},'owner');
  const input={action:'click',coordinateSpace:'screenshot',screenshotId:shot.screenshotId,x:925,y:250};
  await assert.rejects(backend.execute('computer_pointer',input,'other'),/screenshot/i);
  await backend.execute('computer_screenshot',{},'owner');
  await assert.rejects(backend.execute('computer_pointer',input,'owner'),/screenshot/i);
  assert.equal(calls.length,0);
});
test('display geometry changes and image-external points reject before input',async()=>{
  const {backend,calls,capture}=backendHarness();
  const shot=await backend.execute('computer_screenshot',{},'owner');
  const input={action:'click',coordinateSpace:'screenshot',screenshotId:shot.screenshotId,x:1600,y:250};
  await assert.rejects(backend.execute('computer_pointer',input,'owner'),/outside|bounds/i);
  capture.displays=()=>[{id:'one',bounds:{x:-1920,y:0,width:1920,height:1080}}];
  await assert.rejects(backend.execute('computer_pointer',{...input,x:925},'owner'),/display|geometry/i);
  assert.equal(calls.length,0);
});

async function nativeDecision(calls,{failPointer=false,providerError=null,initialBrowser=false}={}) {
  const contexts=[]; let captures=0;
  const desktop={foregroundWindowId:'42',virtualDesktop:{x:0,y:0,width:1920,height:1080},windows:[{id:'42',title:'Owned fixture',bounds:{x:960,y:0,width:960,height:1040}}]};
  const backend={observe:async()=>desktop,execute:async name=>{
    if(name==='computer_pointer'&&failPointer)throw Error('Stopped after a partial stroke');
    return name==='computer_screenshot'?{...image,data:`image-${++captures}`}:{dispatched:true};
  },releaseOwner:async()=>{},releaseInput:async()=>{}};
  const controller={navigationState:()=>({url:'about:blank',loading:false}),domSnapshot:()=>({elements:[]}),consoleEntries:()=>[],networkEntries:()=>[],listTabs:()=>[{id:'t'}],releaseSessionInput:()=>{}};
  const agent=new DesktopChatAgent({controller,getSelectedTabId:()=> 't',getControlMode:()=> 'agi',getComputerTools:()=>backend,emit:()=>{},createProvider:()=>({complete:async context=>{
    contexts.push(structuredClone({...context,signal:undefined,onThought:undefined,onStream:undefined,onProgress:undefined}));
    if(providerError)throw providerError;
    return contexts.length===1?{actions:calls}:{done:{summary:'Fixture inspected.',success:true,verified:true}};
  }})});
  const run=await agent.start({task:'Inspect the owned native fixture',settings:{controlMode:'agi',vision:'auto'},...(initialBrowser?{continuation:true,conversation:{id:'browser-fixture',observationDomain:'browser'}}:{})});
  return {contexts,captures,run};
}
test('separate stroke action refreshes native evidence through the normal chat loop',async()=>{
  const input=gesture();delete input.action;
  const {contexts,captures}=await nativeDecision([{name:'computer_stroke',input}]);
  assert.equal(captures,1);assert.equal(contexts[1].observation.screenshot.source,'native-desktop');
});
test('a partially failed native action still requests fresh pixels',async()=>{
  const {contexts,captures}=await nativeDecision([{name:'computer_pointer',input:{action:'drag',x:1100,y:300,endX:1200,endY:400}}],{failPointer:true});
  assert.equal(captures,1);assert.equal(contexts[1].observation.screenshot.data,'image-1');
});
test('native vision rejection settles unverified without a model retry loop',async()=>{
  const providerError=Object.assign(Error('Native image unavailable'),{code:'NATIVE_VISION_UNAVAILABLE'});
  const {contexts,run}=await nativeDecision([],{providerError});
  assert.equal(contexts.length,1);assert.equal(run.result.success,false);assert.equal(run.result.verified,false);
});
for (const read of [{name:'computer_observe',input:{}},{name:'computer_window',input:{action:'list'}}]) test(`fresh image remains pending across ${read.name} after native mutation`,async()=>{
  const {contexts,captures}=await nativeDecision([{name:'computer_pointer',input:{action:'drag',x:1100,y:300,endX:1200,endY:400}},read]);
  assert.equal(captures,1); assert.equal(contexts[1].observation.screenshot.data,'image-1');
});
test('first native inspection obtains native pixels rather than browser evidence',async()=>{
  const {contexts,captures}=await nativeDecision([{name:'computer_observe',input:{}}],{initialBrowser:true});
  assert.equal(captures,1); assert.equal(contexts[1].observation.screenshot.source,'native-desktop');
});
test('explicit native screenshot satisfies pending image without redundant recapture',async()=>{
  const {contexts,captures}=await nativeDecision([{name:'computer_pointer',input:{action:'click',x:1100,y:300}},{name:'computer_screenshot',input:{}},{name:'computer_observe',input:{}}]);
  assert.equal(captures,1); assert.equal(contexts[1].observation.screenshot.data,'image-1');
});
for (const kind of ['openai','ollama']) test(`${kind} structural repair retains native pixels and coordinate metadata`,async()=>{
  const requests=[];
  const fetchImpl=async(_url,init)=>{
    requests.push(JSON.parse(init.body));
    const content=requests.length===1?'not a valid executable decision':JSON.stringify({done:{summary:'Inspected native fixture',success:true}});
    return Response.json(kind==='ollama'?{message:{content},done:true}:{choices:[{message:{content}}]});
  };
  const provider=kind==='ollama'?createOllamaProvider({baseUrl:'http://localhost:11434',model:'fixture',fetchImpl}):createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl});
  await provider.complete({task:'Use only the native pencil. No scripts or imports.',observation:{desktop:{foregroundWindowId:'42'},screenshot:{...image,screenshotId:'repair-shot'}},tools:COMPUTER_TOOLS,history:[]});
  assert.equal(requests.length,2);
  // The provider splits the original objective (string context) from the
  // observation evidence, which rides on the image-carrying user message.
  const message=kind==='ollama'?requests[1].messages.find(m=>m.role==='user'):[...requests[1].messages].reverse().find(m=>Array.isArray(m.content));
  const context=JSON.parse(typeof message.content==='string'?message.content:message.content.find(p=>p.type==='text').text);
  assert.equal(context.observation.screenshot.screenshotId,'repair-shot');
  assert.equal(context.observation.desktop.foregroundWindowId,'42');
  assert.ok(kind==='ollama'?message.images.includes(image.data):message.content.some(p=>p.type==='image_url'));
});
for (const kind of ['openai','ollama']) test(`${kind} does not silently replace rejected native images with empty DOM evidence`,async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;return new Response(JSON.stringify({error:{message:'Image input is not supported'}}),{status:415});};
  const provider=kind==='ollama'?createOllamaProvider({baseUrl:'http://localhost:11434',model:'fixture',fetchImpl}):createOpenAiCompatibleProvider({providerId:'openai',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl});
  await assert.rejects(provider.complete({task:'Draw with native input',observation:{desktop:{},screenshot:image},tools:COMPUTER_TOOLS,history:[]}),error=>error.code==='NATIVE_VISION_UNAVAILABLE');
  assert.equal(calls,1,'Do not spend another decision executing without native pixels');
});
for (const providerId of ['openai','anthropic']) test(`${providerId} carries actual image and matching coordinate identity`,async()=>{
  let body;
  const provider=createOpenAiCompatibleProvider({providerId,baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async(_url,init)=>{
    body=JSON.parse(init.body); const text=JSON.stringify({done:{summary:'Fixture',success:true}});
    return Response.json(providerId==='anthropic'?{content:[{type:'text',text}]}:{choices:[{message:{content:text}}]});
  }});
  await provider.complete({task:'Only the pencil in the target app. No scripts or imports.',observation:{desktop:{},screenshot:{...image,screenshotId:'coordinate-ref-1'}},tools:COMPUTER_TOOLS});
  const content=[...body.messages].reverse().find(m=>Array.isArray(m.content)).content;
  const context=JSON.parse(content.find(p=>p.type==='text').text);
  assert.equal(context.observation.screenshot.screenshotId,'coordinate-ref-1');
  assert.equal(context.observation.screenshot.scaleX,1.2);
  assert.equal(providerId==='anthropic'?content[1].source.data:content[1].image_url.url,providerId==='anthropic'?image.data:`data:image/png;base64,${image.data}`);
  assert.match(context.task,/No scripts or imports/);
});
