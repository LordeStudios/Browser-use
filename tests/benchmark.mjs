import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(__dirname, '..');

const fixtureUrl = `file:///${path.join(toolRoot,'tests','checkout.html').replace(/\\/g,'/')}`;

function runBenchScript(){
  const src = `
    import { executeTool } from '../src/tools/toolExecutor.js';
    export async function run(ctx, registry){
      const fixture = ${JSON.stringify(fixtureUrl)};
      const t = async(name,args)=>{
        const r=await executeTool(ctx,registry,name,args);
        if(!r.ok) throw new Error(name+': '+r.error);
        return r;
      };
      await t('browser.navigate',{url:fixture});
      await t('browser.assertVisible',{selector:'#to-shipping'});
      await t('browser.clickSelector',{selector:'#to-shipping'});
      await t('browser.typeSelector',{selector:'#name',text:'Name'});
      await t('browser.typeSelector',{selector:'#address',text:'Addr'});
      await t('browser.typeSelector',{selector:'#city',text:'City'});
      await t('browser.typeSelector',{selector:'#country',text:'Uganda'});
      await t('browser.clickSelector',{selector:'#to-payment'});
      const snap = await t('browser.evaluate',{expression:'({body: document.body.innerText.slice(0,200), paymentActive: document.getElementById("payment").classList.contains("active"), shippingActive: document.getElementById("shipping").classList.contains("active"), cardOffset: document.getElementById("card").offsetParent !== null, cardDisplay: getComputedStyle(document.getElementById("card")).display})'});
      console.log('BENCH_SNAP '+JSON.stringify(snap.result));
      return {ok:true};
    }
  `;
  const scriptPath = path.join(toolRoot, 'logs', 'bench-script.mjs');
  fs.mkdirSync(path.dirname(scriptPath), {recursive:true});
  fs.writeFileSync(scriptPath, src, 'utf-8');
  return new Promise((resolve)=>{
    const cp = spawn('node', ['src/index.js','--allow-dangerous','--max-seconds','60','--script',scriptPath], { cwd: toolRoot, stdio: ['pipe','pipe','pipe'] });
    let stdout='',stderr='';
    cp.stdout.on('data', d=>stdout+=d.toString());
    cp.stderr.on('data', d=>stderr+=d.toString());
    cp.on('exit', ()=>{
      const line = stdout.split('\n').find(l=>l.startsWith('BENCH_SNAP '));
      const snap = line ? JSON.parse(line.replace('BENCH_SNAP ','')) : null;
      resolve({snap,stderr});
    });
    cp.on('error', e=>resolve({snap:null,stderr:e.message}));
  });
}

const r = await runBenchScript();
console.log('SNAP:', JSON.stringify(r.snap));
if(r.stderr) console.log('STDERR:', r.stderr.slice(0,300));
