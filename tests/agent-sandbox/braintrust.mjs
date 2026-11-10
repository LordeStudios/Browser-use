import fs from 'node:fs/promises';
import path from 'node:path';
import {Eval} from 'braintrust';
// Score retained actual runs locally. This is not another provider execution.
// noSendLogs avoids hosted experiments; no remote datasets or model judges.
const directories=process.argv.slice(2);
if(!directories.length)throw Error('Pass one or more actual run directories.');
const rows=await Promise.all(directories.map(async directory=>{const r=JSON.parse(await fs.readFile(path.join(directory,'result.json'),'utf8'));return {input:{directory,label:r.label,family:r.family,level:r.level,seed:r.seed,split:r.split},expected:true,metadata:{model:r.model,protocol:r.protocol},result:r.score};}));
const evaluation=await Eval('Browser-use sandbox',{
  data:rows.map(({input,metadata})=>({input,metadata})),
  task:async input=>rows.find(r=>r.input.directory===input.directory).result,
  scores:[({output})=>({name:'Objective pass',score:output.passed?1:0}),({output})=>({name:'Efficiency',score:output.efficiency/100}),({output})=>({name:'Source and method compliance',score:output.compliant?1:0})]
},{noSendLogs:true,enableCache:false});
const output=path.join(path.dirname(directories[0]),'browser-use-braintrust-local-summary.json');
await fs.writeFile(output,JSON.stringify({source:'actual retained provider runs, locally rescored',sdk:'braintrust@3.32.0',noSendLogs:true,inputs:rows.map(r=>r.input),summary:evaluation.summary,results:evaluation.results},null,2));
console.log('Local Braintrust summary: '+output);
