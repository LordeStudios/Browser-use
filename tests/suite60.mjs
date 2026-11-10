import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, '..');

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

function parseLastJson(stdout){
  const lines = stdout.split('\n').map(l=>l.trim()).filter(Boolean);
  for(let i=lines.length-1;i>=0;i--){
    if(lines[i]==='}'){
      let j=i;
      let depth=0;
      while(j>=0){
        for(let k=lines[j].length-1;k>=0;k--){
          const ch=lines[j][k];
          if(ch==='}') depth++;
          if(ch==='{'){
            depth--;
            if(depth===0){
              try{ return JSON.parse(lines.slice(j,i+1).join('')); }catch{}
            }
          }
        }
        j--;
      }
    }
  }
  try{ return JSON.parse(stdout); }catch{ return null; }
}

function runScript(scriptName, timeoutMs=60000){
  const scriptPath = path.resolve(__dirname, scriptName);
  return new Promise((resolve)=>{
    const start = Date.now();
    const cp = spawn('node', ['src/index.js','--allow-dangerous','--max-seconds','60','--script',scriptPath], { cwd: toolRoot, env: process.env, stdio: ['pipe','pipe','pipe'] });
    let stdout = '', stderr = '';
    cp.stdout.on('data', d=>stdout+=d.toString());
    cp.stderr.on('data', d=>stderr+=d.toString());
    let done=false;
    const finish = (status, reason)=>{
      if(done) return;
      done=true;
      try{ cp.kill('SIGKILL'); }catch{}
      resolve({ status, reason, elapsed: Date.now()-start, stdout, stderr, pid: cp.pid });
    };
    const t = setTimeout(()=>finish('timeout','exceeded 60s'), timeoutMs);
    cp.on('exit', (code)=>{ clearTimeout(t); finish(code===0?'pass':'fail', `exit code ${code}`); });
    cp.on('error', (e)=>{ clearTimeout(t); finish('fail', e.message); });
  });
}

async function runTest(name, scriptName, check, retries=3){
  const runs=[];
  let lastResult=null;
  for(let i=0;i<=retries;i++){
    console.log(`\n[RUN ${i+1}/${retries+1}] ${name}`);
    const r = await runScript(scriptName);
    const parsed = parseLastJson(r.stdout);
    runs.push({...r, parsed});
    lastResult={...r, parsed};
    const passed = r.status==='pass' && check(r, parsed);
    if(passed){
      if(i>0) console.log(`  passed on retry ${i+1} elapsed=${r.elapsed}ms`);
      return { name, ok:true, run: i+1, elapsed:r.elapsed, parsed, runs };
    }
    console.log(`  failed: ${r.status} ${r.reason} elapsed=${r.elapsed}ms parsed=${JSON.stringify(parsed??{}).slice(0,200)}`);
    if(r.stderr.trim()) console.log('  stderr:', r.stderr.trim().slice(0,400));
    if(i<retries) await sleep(500);
  }
  return { name, ok:false, runs, last: lastResult };
}

function report(results){
  const out = { createdAt: new Date().toISOString(), results, allOk: results.every(r=>r.ok) };
  const p = path.join(toolRoot, 'logs', 'suite60-report.json');
  fs.mkdirSync(path.dirname(p), {recursive:true});
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log('\n=== SUITE60 REPORT ===');
  for(const r of results){
    const status = r.ok ? 'PASS' : 'FAIL';
    const elapsed = r.ok ? r.elapsed : (r.last?.elapsed || 0);
    const slowest = r.ok && r.parsed?.timings?.length ? r.parsed.timings.reduce((a,b)=>a.elapsed>b.elapsed?a:b) : null;
    console.log(`${status} ${r.name} ${elapsed}ms retries=${r.runs.length-1}${slowest?` slowest=${slowest.name}(${slowest.elapsed}ms)`:''}`);
    if(slowest){
      for(const t of r.parsed.timings) console.log(`    ${t.name} ${t.elapsed}ms`);
    }
  }
  console.log(`allOk=${out.allOk} report=${p}`);
}

const results=[];
results.push(await runTest('multi-step-checkout', 'checkout-script.mjs', (r,p)=>p?.ok && p.fixture==='checkout.html'));
results.push(await runTest('dynamic-spa-todo', 'spa-todo-script.mjs', (r,p)=>p?.ok && p.fixture==='spa-todo.html'));
results.push(await runTest('conditional-form-validation', 'conditional-form-script.mjs', (r,p)=>p?.ok && p.fixture==='conditional-form.html'));
report(results);
