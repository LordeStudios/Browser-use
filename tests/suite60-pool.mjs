import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BrowserPool } from '../src/browser/browserPool.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, '..');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

async function runTestWithPool(pool, name, scriptName, check, timeoutMs=60000){
  const browser = pool.acquire();
  if(!browser) throw new Error('no browser available in pool');
  const start = Date.now();
  let ok=false, error=null, elapsed=0, parsed=null;
  try{
    const ctx = { browser, eventBus:{emitEvent:()=>{}}, config:{allowDangerous:true,maxSeconds:60} };
    const registry = createToolRegistry();
    const mod = await import(pathToFileURL(path.resolve(__dirname, scriptName)).href);
    const result = await Promise.race([
      mod.run(ctx, registry),
      new Promise((_,reject)=>setTimeout(()=>reject(new Error('timeout')), timeoutMs))
    ]);
    elapsed = Date.now()-start;
    parsed = result;
    ok = check(result);
    if(!ok) error = 'check failed';
  }catch(e){
    elapsed = Date.now()-start;
    error = e.message;
  }
  await pool.reset(browser);
  return { name, ok, elapsed, error, parsed };
}

async function runTest(pool, name, scriptName, check, retries=3){
  const runs=[];
  for(let i=0;i<=retries;i++){
    console.log(`[RUN ${i+1}/${retries+1}] ${name}`);
    const r = await runTestWithPool(pool, name, scriptName, check);
    runs.push(r);
    if(r.ok) return { name, ok:true, run:i+1, elapsed:r.elapsed, parsed:r.parsed, runs };
    console.log(`  failed: ${r.error} elapsed=${r.elapsed}ms`);
    if(i<retries) await sleep(200);
  }
  return { name, ok:false, runs };
}

function report(results, wallMs){
  const out = { createdAt: new Date().toISOString(), mode:'pool', results, allOk: results.every(r=>r.ok), wallMs };
  const p = path.join(toolRoot, 'logs', 'suite60-pool-report.json');
  fs.mkdirSync(path.dirname(p), {recursive:true});
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log('\n=== SUITE60 POOL REPORT ===');
  for(const r of results){
    const status = r.ok ? 'PASS' : 'FAIL';
    const slowest = r.ok && r.parsed?.timings?.length ? r.parsed.timings.reduce((a,b)=>a.elapsed>b.elapsed?a:b) : null;
    console.log(`${status} ${r.name} ${r.elapsed}ms retries=${r.runs.length-1}${slowest?` slowest=${slowest.name}(${slowest.elapsed}ms)`:''}`);
    if(slowest) for(const t of r.parsed.timings) console.log(`    ${t.name} ${t.elapsed}ms`);
  }
  console.log(`wallMs=${wallMs} allOk=${out.allOk} report=${p}`);
}

const pool = new BrowserPool({poolSize:3});
await pool.start();

const tests = [
  { name:'multi-step-checkout', script:'checkout-script.mjs', check:r=>r?.ok && r.fixture==='checkout.html' },
  { name:'dynamic-spa-todo', script:'spa-todo-script.mjs', check:r=>r?.ok && r.fixture==='spa-todo.html' },
  { name:'conditional-form-validation', script:'conditional-form-script.mjs', check:r=>r?.ok && r.fixture==='conditional-form.html' }
];

const start = Date.now();
const results=[];
for(const t of tests){
  results.push(await runTest(pool, t.name, t.script, t.check));
}
report(results, Date.now()-start);
await pool.stop();
