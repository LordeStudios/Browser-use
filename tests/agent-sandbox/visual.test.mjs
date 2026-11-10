import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVisualCase} from './visual.mjs';
test('visual evaluator renders its state and grades colors/geometry independently',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bu-visual-evaluator-'));
  const {visual,fixture}=await createVisualCase({directory,level:1,seed:17,split:'evaluator-unit'});
  try{
    const shot=await visual.execute('computer_screenshot',{},'unit',()=>{});assert.ok(Buffer.from(shot.data,'base64').subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])));
    assert.equal((await fixture.grade()).portrait,false);
    const click=(x,y)=>visual.execute('computer_pointer',{action:'click',x,y},'unit',()=>{});
    await click(440,80);await click(410,320);await click(60,80);await click(165,80);
    const strokes=fixture.manifest.target.map(s=>({points:s.points.map(p=>({x:380+p.x*280,y:150+p.y*420}))}));
    await visual.execute('computer_stroke',{windowId:'100',region:{x:380,y:150,width:280,height:420},strokes},'unit',()=>{});
    assert.equal(Object.values(await fixture.grade()).every(Boolean),true);
    const changed=await visual.execute('computer_screenshot',{},'unit',()=>{});assert.notEqual(changed.imageHash,shot.imageHash);
    await assert.rejects(visual.execute('computer_stroke',{windowId:'100',region:{x:0,y:0,width:1000,height:700},strokes:[{points:[{x:0,y:0},{x:1,y:1}]}]},'unit',()=>{}),/leaves/);
    await visual.save(directory);console.log('Evaluator-unit images: '+directory);
  }finally{await visual.close();}
});
