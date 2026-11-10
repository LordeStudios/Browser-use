import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { boundedRequestContext, createOllamaProvider } = require('../desktop/agent/ollamaProvider.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
const base = { task: 'Use the returned evidence', observation: { navigation: { url:'about:blank' }, dom:{elements:[]} }, messages:[], tools:COMPUTER_TOOLS, coordinator:{}, plan:[] };
const entry = (tool, input, result) => ({ tool, input, output: { ok:true, result } });
function reduced(...history) { return boundedRequestContext({...base,history}).history; }

test('completed terminal job evidence survives exactly, including zero exit and null signal', () => {
  const result = {jobId:'job-1',state:'completed',exitCode:0,signal:null,output:'TOTAL_BYTES=1907954487296\n',offset:0,nextOffset:26,truncated:false};
  assert.deepEqual(reduced(entry('computer_terminal',{action:'read',jobId:'job-1'},result))[0].output.result,result);
});
test('running, failed and completed states stay distinct and chronological', () => {
  const inputs = ['running','failed','completed'].map((state,i)=>entry('computer_terminal',{action:'read',jobId:`job-${i}`},{jobId:`job-${i}`,state,exitCode:state==='running'?null:state==='failed'?1:0,output:state==='failed'?'actual failure':''}));
  assert.deepEqual(reduced(...inputs).map(h=>h.output.result),inputs.map(h=>h.output.result));
});
test('file content and observed Desktop paths reach the next decision', () => {
  const result={path:'C:/Users/Administrator/Desktop/AGI_testing/webpage.html',content:'<!doctype html><h1>Success</h1>',encoding:'utf8',offset:0,bytesRead:29,nextOffset:null,size:29};
  assert.deepEqual(reduced(entry('computer_file',{action:'read',path:result.path},result))[0].output.result,result);
});
test('scan-limited search and native collections are not converted into missing evidence', () => {
  const results=[
    entry('computer_search',{pattern:'AGI_testing',path:'C:/Users',output:'files'},{tool:'computer_search',engine:'ripgrep',root:'C:/Users',pattern:'AGI_testing',outputMode:'files',matches:0,totalFiles:5000,truncated:true,files:[],notice:'5000 files matched — the pattern is broad. Work down this list by match count, or narrow with a more specific pattern, glob, or deeper path.'}),
    entry('computer_terminal',{action:'list'},{jobs:[{jobId:'one',state:'completed',exitCode:0}],sessions:[]}),
    entry('computer_window',{action:'list'},{windows:[{id:'window-1',title:'Exact observed title',pid:100,bounds:{x:-1920,y:0,width:500,height:400}}]}),
    entry('computer_record',{action:'stop'},{state:'completed',path:'I:/fixture.webm',bytes:12345,durationMs:1200})
  ];
  assert.deepEqual(reduced(...results).map(h=>h.output.result),results.map(h=>h.output.result));
});
test('image bytes are excluded while native coordinate metadata remains', () => {
  const [result]=reduced(entry('computer_screenshot',{}, {data:'IMAGE_BYTES_NOT_CONTEXT',mimeType:'image/png',source:'native-desktop',origin:{x:-1920,y:0},width:1280,height:720,scaleX:1.5,scaleY:1.5}));
  assert.equal(JSON.stringify(result).includes('IMAGE_BYTES_NOT_CONTEXT'),false);
  assert.deepEqual(result.output.result.origin,{x:-1920,y:0});
  assert.equal(result.output.result.scaleX,1.5);
});
test('large native payloads are bounded with explicit context-only truncation', () => {
  const result={jobId:'large-job',state:'completed',exitCode:0,offset:10,nextOffset:100010,totalCharacters:100000,truncated:false,output:'x'.repeat(100000)};
  const [compact]=reduced(entry('computer_terminal',{action:'read',jobId:'large-job'},result));
  assert.ok(compact.output.result.output.length>=1000);
  assert.ok(JSON.stringify(compact.output).length<40000);
  assert.equal(compact.output.result.truncated,false,'do not alter the tool reported truncation');
  assert.ok(compact.output.contextTruncation?.length,'context loss must be explicit');
  assert.equal(compact.output.result.jobId,'large-job');
});
test('browser result projection is unchanged by native support', () => {
  const [browser] = reduced(entry('browser_tabs',{},[{id:'tab',title:'Browser',url:'https://example.test',loading:false,secretNoise:'omit'}]));
  assert.deepEqual(browser.output.result,[{id:'tab',title:'Browser',url:'https://example.test',loading:false}]);
});

test('streamed tool argument fragments preserve repeated code tokens, digits and characters exactly', async () => {
  const fragments=['{"action":"execute","command":"ctypes.c_ulong','long','; scale=100','000','000','0','; repeated=','aa','aa','"}'];
  let requests=0;
  const provider=createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async()=>{
    requests++;
    const stream=fragments.map((argumentsPart,index)=>`data: ${JSON.stringify({choices:[{delta:{tool_calls:[{index:0,...(index===0?{id:'call-1',type:'function'}:{}),function:{...(index===0?{name:'computer_terminal'}:{}),arguments:argumentsPart}}]}}]})}`).join('\n\n')+'\n\ndata: [DONE]\n\n';
    return new Response(stream,{headers:{'content-type':'text/event-stream'}});
  }});
  const result=await provider.complete({...base,history:[],onThought:()=>{}});
  assert.equal(result.toolCalls[0].input.command,JSON.parse(fragments.join('')).command);
  assert.equal(requests,1,'valid streamed code must not trigger repair');
});
test('streamed content and reasoning retain legitimate repeated fragments', async () => {
  const thoughts=[];
  const chunks=[{reasoning_content:'Compare '},{reasoning_content:'very '},{reasoning_content:'very '},{reasoning_content:'carefully.'},{content:'{"done":{"summary":"'},{content:'ha'},{content:'ha'},{content:'!!'},{content:'!!'},{content:'","success":true}}'}];
  const provider=createOpenAiCompatibleProvider({providerId:'xkiro',baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture',fetchImpl:async()=>new Response(chunks.map(delta=>`data: ${JSON.stringify({choices:[{delta}]})}`).join('\n\n')+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})});
  const result=await provider.complete({...base,history:[],onThought:value=>thoughts.push(value)});
  assert.equal(result.done.summary,'haha!!!!');
  assert.equal(thoughts.at(-1),'Compare very very carefully.');
});

for (const providerId of ['openai','anthropic']) test(`${providerId} request body contains actual native tool evidence`, async () => {
  let body;
  const provider=createOpenAiCompatibleProvider({providerId,baseUrl:'https://fixture.invalid',model:providerId==='anthropic'?'claude-fixture':'fixture',apiKey:'fixture',fetchImpl:async(_url,init)=>{
    body=JSON.parse(init.body);
    const value=JSON.stringify({done:{summary:'Evidence consumed',success:true}});
    return new Response(JSON.stringify(providerId==='anthropic'?{content:[{type:'text',text:value}]}:{choices:[{message:{content:value}}]}),{headers:{'content-type':'application/json'}});
  }});
  const history=[entry('computer_terminal',{action:'read',jobId:'completed-42'},{jobId:'completed-42',state:'completed',exitCode:0,output:'EXACT_RESULT_4287'})];
  await provider.complete({...base,history});
  const messages=body.messages || body.input || [];
  const message=[...messages].reverse().find(m=>m.role==='user');
  const userText=typeof message.content==='string'?message.content:message.content.find(part=>part.type==='text').text;
  const context=JSON.parse(userText);
  assert.equal(context.history[0].output.result.output,'EXACT_RESULT_4287');
  assert.equal(context.history[0].output.result.state,'completed');
});
