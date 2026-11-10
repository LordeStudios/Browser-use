import fs from 'node:fs';
import path from 'node:path';
const pairs=process.argv.slice(2);
if(!pairs.length)throw new Error('Pass result files from completed Browser-use and Claude Code trials.');
const rows=[];
for(const file of pairs){
  for(const record of JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''))){
    const agent=record.agent || 'browser-use';
    const tools=record.tools.filter(tool=>(tool.tool||tool.name)!=='browser_done');
    const source=path.dirname(file);
    const failures=agent==='claude-code'?record.toolErrors:tools.filter(tool=>tool.output?.ok===false).length;
    const expectedNotFound=agent==='browser-use'?tools.filter(tool=>tool.tool==='computer_file'&&tool.input?.action==='stat'&&/ENOENT/.test(tool.output?.error||'')).length:null;
    rows.push({agent,task:record.name,elapsedMs:record.elapsedMs,modelTurns:record.providerCalls??record.providerMessages,toolCalls:tools.length,failures,expectedNotFound,
      success:record.success??record.result?.success,allCallsSameModel:record.allCallsSameModel??null,duplicateExactCalls:tools.length-new Set(tools.map(tool=>JSON.stringify([tool.tool||tool.name,tool.input]))).size,
      sequence:tools.map(tool=>(tool.tool||tool.name)+(tool.input?.action?`:${tool.input.action}`:'')),source});
  }
}
const groups=[];
for(const key of [...new Set(rows.map(row=>`${row.agent}|${row.task}`))]){
  const sample=rows.filter(row=>`${row.agent}|${row.task}`===key),sorted=sample.map(row=>row.elapsedMs).sort((a,b)=>a-b),n=sorted.length;
  groups.push({agent:sample[0].agent,task:sample[0].task,n,successes:sample.filter(row=>row.success).length,medianMs:n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2,minMs:sorted[0],maxMs:sorted.at(-1),turnRange:[Math.min(...sample.map(row=>row.modelTurns)),Math.max(...sample.map(row=>row.modelTurns))],toolRange:[Math.min(...sample.map(row=>row.toolCalls)),Math.max(...sample.map(row=>row.toolCalls))]});
}
console.log(JSON.stringify({rows,groups,note:'Small local sample; no statistical generalization. Expected not-found checks are not automatically failed task execution. Harness prompts, context, API protocols and default reasoning/token settings differ.'},null,2));
