import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/tools/toolExecutor.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'wizard.html').replace(/\\/g,'/')}`;

export async function run(ctx, registry){
  const start = Date.now();
  const timings = [];
  async function runTool(name, args){
    const t0 = Date.now();
    const r = await executeTool(ctx, registry, name, args);
    timings.push({ name, elapsed: Date.now()-t0, ok: r.ok, error: r.error });
    if(!r.ok) throw new Error(`${name} failed: ${r.error}`);
    return r;
  }
  await runTool('browser.navigate', { url: fixtureUrl });
  await runTool('browser.typeSelector', { selector: '#project-name', text: 'AcmeRocket' });
  await runTool('browser.clickSelector', { selector: '#next-1' });
  await runTool('browser.assertVisible', { selector: '#region' });
  await runTool('browser.typeSelector', { selector: '#region', text: 'EU West' });
  await runTool('browser.clickSelector', { selector: '#analytics' });
  await runTool('browser.clickSelector', { selector: '#next-2' });
  await runTool('browser.assertText', { text: 'AcmeRocket' });
  await runTool('browser.assertText', { text: 'EU' });
  await runTool('browser.clickSelector', { selector: '#finish' });
  await runTool('browser.assertText', { text: 'Project "AcmeRocket" created in EU' });
  return { ok: true, fixture: 'wizard.html', totalMs: Date.now()-start, timings };
}
