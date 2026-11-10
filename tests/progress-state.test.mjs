import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {applyProgressUpdate,normalizeConversationPlan}=require('../desktop/agent/progressState.cjs');
const {ChatHistoryStore}=require('../desktop/store/chatHistoryStore.cjs');
const {boundedRequestContext}=require('../desktop/agent/ollamaProvider.cjs');
const {DesktopChatAgent}=require('../desktop/agent/desktopChatAgent.cjs');
const plan=Array.from({length:12},(_,i)=>({id:`task-${i}`,text:`Task ${i}`,status:i===0?'done':'current',verification:''}));

test('progress remains optional and goals/task mutations are independent',()=>{
  const goal={id:'g',text:'Model-authored goal',status:'current',verification:''};
  assert.deepEqual(normalizeConversationPlan(undefined),[]);
  const added=applyProgressUpdate(plan,[],{goals:[goal]});
  assert.deepEqual(added.plan,plan); assert.deepEqual(added.goals,[goal]);
  const update=applyProgressUpdate(added.plan,added.goals,{operations:[{op:'update',id:'task-2',status:'done'}]});
  assert.equal(update.plan[2].status,'done'); assert.deepEqual(update.goals,[goal]);
  const clear=applyProgressUpdate(update.plan,update.goals,{goals:[]});
  assert.equal(clear.plan.length,12); assert.deepEqual(clear.goals,[]);
});
test('duplicate text normalizes to unique stable identities',()=>{
  const normalized=normalizeConversationPlan([{id:'same',text:'one'},{id:'same',text:'one'},'one']);
  assert.equal(new Set(normalized.map(x=>x.id)).size,3);
  assert.deepEqual(normalizeConversationPlan(normalized),normalized);
});
test('more than eight tasks and all goal IDs survive checkpoints and interrupted recovery',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-progress-store-'));
  try{
    const store=new ChatHistoryStore({filePath:path.join(root,'history.json')});
    const record={id:'c',title:'Progress',status:'running',plan,goals:[{id:'g',text:'Goal',status:'current'}],attemptSequence:2,attemptId:'attempt-2',eventRevision:4};
    store.checkpoint(record); assert.equal(store.get('c').plan.length,12);
    await store.flush();
    const reopened=new ChatHistoryStore({filePath:store.filePath}); reopened.recoverInterrupted();
    const restored=reopened.get('c');
    assert.deepEqual(restored.plan,plan); assert.equal(restored.goals[0].id,'g'); assert.equal(restored.status,'interrupted');
    assert.equal(restored.attemptSequence,2); assert.equal(restored.eventRevision,4);
    const context=boundedRequestContext({task:'Continue',history:[],tools:[],plan:restored.plan,goals:restored.goals});
    assert.equal(context.state.plan.length,12); assert.equal(context.state.plan[11].id,'task-11'); assert.equal(context.state.goals[0].id,'g');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('older pending revisions cannot replace the newest progress',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-progress-order-'));
  try{
    const store=new ChatHistoryStore({filePath:path.join(root,'history.json')});
    store.checkpoint({id:'c',status:'running',attemptSequence:2,eventRevision:8,plan});
    store.checkpoint({id:'c',status:'running',attemptSequence:1,eventRevision:100,plan:[]});
    store.checkpoint({id:'c',status:'running',attemptSequence:2,eventRevision:7,plan:[]});
    await store.flush(); assert.equal(store.get('c').plan.length,12);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('deleting or clearing history cannot be undone by an outstanding checkpoint',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-progress-delete-'));
  try{
    const store=new ChatHistoryStore({filePath:path.join(root,'history.json')});
    store.checkpoint({id:'c',status:'running',attemptSequence:1,eventRevision:5,plan});
    await store.remove('c'); await store.flush(); assert.equal(store.get('c'),null);
    store.checkpoint({id:'d',status:'running',attemptSequence:1,eventRevision:6,plan});
    await store.clear(); await store.flush(); assert.deepEqual(store.load(),[]);
    store.checkpoint({id:'e',status:'running',attemptSequence:1,eventRevision:7,plan});
    const writing=store.flush(); await store.remove('e'); await writing; assert.equal(store.get('e'),null);
    store.checkpoint({id:'f',status:'running',attemptSequence:1,eventRevision:8,plan});
    const secondWrite=store.flush(); await store.clear(); await secondWrite; assert.deepEqual(store.load(),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('stale updates after a flushed checkpoint cannot roll back saved tasks',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-progress-flushed-'));
  try{
    const store=new ChatHistoryStore({filePath:path.join(root,'history.json')});
    store.checkpoint({id:'c',status:'running',attemptSequence:2,eventRevision:9,plan}); await store.flush();
    store.checkpoint({id:'c',status:'running',attemptSequence:1,eventRevision:99,plan:[]}); await store.flush();
    assert.equal(store.get('c').plan.length,12);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('model-authored goals survive the agent loop without automatic task completion',async()=>{
  const contexts=[],checkpoints=[];
  const controller={navigationState:()=>({url:'about:blank',loading:false}),domSnapshot:()=>({url:'about:blank',elements:[]}),consoleEntries:()=>[],networkEntries:()=>[],releaseSessionInput:()=>{},listTabs:()=>[{id:'t'}]};
  const agent=new DesktopChatAgent({controller,getSelectedTabId:()=> 't',emit:()=>{},onCheckpoint:run=>checkpoints.push(run),createProvider:()=>({complete:async context=>{
    contexts.push(context);
    return contexts.length===1?{actions:[{name:'update_plan',input:{goals:[{id:'goal',text:'Inspect the fixture',status:'current'}],steps:[{id:'task',text:'Model leaves this current',status:'current'}]}}]}:{actions:[{name:'browser_done',input:{summary:'Fixture described.',verified:true}}]};
  }})});
  const result=await agent.start({task:'Describe fixture'});
  assert.equal(result.goals[0].id,'goal'); assert.equal(result.plan[0].status,'current');
  assert.equal(contexts[1].goals[0].text,'Inspect the fixture');
  assert.ok(checkpoints.some(c=>c.goals[0]?.id==='goal')); assert.doesNotThrow(()=>structuredClone(result));
});
