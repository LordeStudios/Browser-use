import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SandboxEnvironment,scopedPath} from './environment.mjs';
import {generateCase} from './cases.mjs';
import {scoreRun} from './scoring.mjs';
test('file boundary rejects escaping reads and writes and accepts actual scoped IO',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-boundary-'));const env=new SandboxEnvironment(root);
  try{await assert.rejects(scopedPath(root,path.join(root,'..','outside.txt')),/outside/);
    await assert.rejects(env.execute('computer_file',{action:'copy',path:path.join(root,'x'),destination:path.join(root,'..','x')},'test'),/outside/);
    await env.execute('computer_file',{action:'write',path:path.join(root,'test.txt'),content:'actual file'},'test');
    assert.equal((await env.execute('computer_file',{action:'read',path:path.join(root,'test.txt')},'test')).content,'actual file');
    await assert.rejects(env.execute('computer_terminal',{action:'execute',command:'any command'},'test'),/No command or effect/);
    assert.equal(env.calls.at(-1).ok,false);
    await assert.rejects(env.execute('computer_file',{action:'delete',path:root,recursive:true},'test'),/workspace root/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('evaluator accepts independent expected artifact and detects changed source',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'bu-oracle-'));
  try{const fixture=await generateCase(root,{family:'reconcile',level:3,seed:17});assert.equal(Object.values(await fixture.grade()).every(Boolean),false);
    await fs.writeFile(path.join(root,'result.json'),JSON.stringify(fixture.expected));assert.equal(Object.values(await fixture.grade()).every(Boolean),true);
    await fs.writeFile(path.join(root,'README.md'),'damaged');assert.equal((await fixture.grade()).sourcesPreserved,false);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('incorrect fast runs receive no efficiency reward',()=>{
  const run={result:{success:true},history:[],coordinator:{metrics:{providerRequests:1,providerCalls:1}}};
  const score=scoreRun({checks:{correct:false},run,elapsedMs:1,environment:{calls:[],boundaryViolations:0},budgets:{seconds:10,tools:5,requests:2}});
  assert.equal(score.efficiency,0);assert.equal(score.honest,false);assert.equal(score.passed,false);
});
