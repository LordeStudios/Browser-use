import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
export const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function random(seed){let n=seed>>>0;return()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}
export async function generateCase(root,{family='reconcile',level=1,seed=17,split='dev'}={}){
  if(!['reconcile','repair'].includes(family)||!Number.isInteger(level)||level<1||level>3)throw Error('Unsupported case configuration');
  const rng=random(seed),sources=new Map();
  async function put(name,value){const data=typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2);await fs.mkdir(path.dirname(path.join(root,name)),{recursive:true});await fs.writeFile(path.join(root,name),data);sources.set(name,digest(data));}
  let objective,expected,mutable=new Set(),checks;
  for(let i=0;i<level*3;i++)await put(`archive/notes-${i}.txt`,`Obsolete fixture note ${Math.floor(rng()*100000)}. Not authoritative.\n`);
  await put('archive/sample.bin',Buffer.from([0,255,128,10,13,0,9]));
  if(family==='reconcile'){
    const rates={standard:2+Math.floor(rng()*4),priority:6+Math.floor(rng()*4)},rows=[];
    for(let i=0;i<4+level*3;i++){const row={id:`R${seed}-${i}`,category:i%2?'standard':'priority',units:1+Math.floor(rng()*8),status:level>1&&i%4===0?'cancelled':'paid'};rows.push(row);if(level===3&&i%3===0)rows.push({...row});}
    const expectedRows=[...new Map(rows.filter(r=>r.status==='paid').map(r=>[r.id,r])).values()];
    expected={count:expectedRows.length,total:expectedRows.reduce((n,r)=>n+r.units*rates[r.category],0),byCategory:Object.fromEntries(Object.keys(rates).map(c=>[c,expectedRows.filter(r=>r.category===c).reduce((n,r)=>n+r.units*rates[c],0)]))};
    const shardCount=level;
    for(let shard=0;shard<shardCount;shard++)await put(`current/batch-${shard}.csv`,'id,category,units,status\n'+rows.filter((_,i)=>i%shardCount===shard).map(r=>Object.values(r).join(',')).join('\n')+'\n');
    await put('current/rates.json',rates);
    await put('README.md','Authoritative data: current/batch-*.csv and current/rates.json. Ignore archives. Count paid rows only; deduplicate identical rows by id across all files. Amount = units * category rate. Preserve all source files.\n');
    objective='Read the authoritative inputs described by README.md. Write result.json with exact numeric fields count (unique paid IDs), total (sum of their amounts), and byCategory (amount totals for each category). Preserve every original file. Verify the saved result and report the total.';
    checks=async()=>{let result;try{result=JSON.parse(await fs.readFile(path.join(root,'result.json'),'utf8'));}catch{}return {validArtifact:Boolean(result),count:result?.count===expected.count,total:result?.total===expected.total,byCategory:JSON.stringify(Object.entries(result?.byCategory||{}).sort())===JSON.stringify(Object.entries(expected.byCategory).sort())};};
  }else{
    const region=['north','east','west'][seed%3],quota=20+Math.floor(rng()*80),port=7000+Math.floor(rng()*500);
    const original={service:{name:`fixture-${seed}`,region:'legacy',port:6000},limits:{quota:5,retries:3},enabled:false,metadata:{owner:'fixture-team',tag:`keep-${seed}`}};
    expected=structuredClone(original);expected.service.region=region;expected.limits.quota=quota;expected.enabled=true;
    if(level>1)expected.service.port=port;
    await put('app/config.json',original);
    const guide=`# Local service\nRegion: legacy\nQuota: 5\nPort: 6000\nKeep this footer: ${seed}\n`;
    await put('app/guide.md',guide);
    const instructions=`Required changes: enabled=true; service.region=${region}; limits.quota=${quota}. ${level>1?`Set service.port=${port}.`:'Keep service.port unchanged.'} ${level===3?'Update the Region, Quota and Port lines in app/guide.md to match the configuration. Preserve every other line.':'Do not modify app/guide.md.'} Preserve every unrelated field and file.\n`;
    await put('requirements.txt',instructions);mutable.add('app/config.json');if(level===3)mutable.add('app/guide.md');
    objective='Apply the changes in requirements.txt to the existing configuration/documentation. Preserve unrelated fields/files. Write change-summary.json with changedFiles listing the exact relative files modified (exclude change-summary.json itself). Verify the saved changes; do not create a replacement configuration elsewhere.';
    checks=async()=>{let result,summary,doc;try{result=JSON.parse(await fs.readFile(path.join(root,'app/config.json'),'utf8'));summary=JSON.parse(await fs.readFile(path.join(root,'change-summary.json'),'utf8'));doc=await fs.readFile(path.join(root,'app/guide.md'),'utf8');}catch{}
      const same=(a,b)=>{if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return a===b;const keys=Object.keys(a).sort();return JSON.stringify(keys)===JSON.stringify(Object.keys(b).sort())&&keys.every(k=>same(a[k],b[k]));};
      const expectedDoc=level===3?guide.replace('Region: legacy',`Region: ${region}`).replace('Quota: 5',`Quota: ${quota}`).replace('Port: 6000',`Port: ${port}`):guide;
      return {configuration:same(result,expected),documentation:doc===expectedDoc,changeSummary:JSON.stringify([...(summary?.changedFiles||[])].sort())===JSON.stringify([...mutable].sort())};};
  }
  return {family,level,seed,split,objective,expected,mutable:[...mutable],budgets:{seconds:35+level*20,tools:5+level*3,requests:3+level*2},
    async grade(){const result=await checks();for(const [name,hash]of sources)if(!mutable.has(name)){try{if(digest(await fs.readFile(path.join(root,name)))!==hash)result.sourcesPreserved=false;}catch{result.sourcesPreserved=false;}}result.sourcesPreserved??=true;return result;},
    manifest:{family,level,seed,split,sourceHashes:Object.fromEntries(sources),expected,mutable:[...mutable]}};
}
