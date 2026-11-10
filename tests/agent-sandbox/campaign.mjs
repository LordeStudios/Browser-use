import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {runTrial} from './run.mjs';
// Sequential real-provider campaign. One argument: JSON matrix file with
// {label, cases:[{family,level,seed,split,requests,seconds}]}. Writes a
// campaign summary with per-case score lines and no fabricated data.
const matrixPath=process.argv[2];
if(!matrixPath)throw Error('Pass a campaign matrix JSON path.');
const matrix=JSON.parse(await fs.readFile(matrixPath,'utf8'));
const directory=await fs.mkdtemp(path.join(os.tmpdir(),'bu-campaign-'));
const results=[];
for(const config of matrix.cases){
  const outcome=await runTrial({...config,label:matrix.label,directory}).catch(error=>({error:error.message,directory:null,...config}));
  results.push({config,outcome:{...outcome,run:undefined,events:undefined,requests:undefined,environmentCalls:undefined},score:outcome.score,error:outcome.error});
  await fs.writeFile(path.join(directory,'summary.json'),JSON.stringify({label:matrix.label,directory,results},null,2));
}
const passed=results.filter(r=>r.score?.passed).length;
console.log(JSON.stringify({event:'campaign-complete',label:matrix.label,directory,passed,total:results.length,
  scores:results.map(r=>({family:r.config.family,level:r.config.level,seed:r.config.seed,split:r.config.split,efficiency:r.score?.efficiency,passed:r.score?.passed,stopped:r.score?.stoppedReason,error:r.error}))}));
