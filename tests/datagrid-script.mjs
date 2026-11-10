import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/tools/toolExecutor.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'datagrid.html').replace(/\\/g,'/')}`;

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
  await runTool('browser.waitForSelector', { selector: '#rows tr', timeout: 5000 });
  await runTool('browser.clickSelector', { selector: '#sort-total' });
  await runTool('browser.clickSelector', { selector: '#next-page' });
  await runTool('browser.assertText', { text: 'Page 2 of 7' });
  await runTool('browser.typeSelector', { selector: '#search', text: 'Customer 10' });
  await runTool('browser.waitForTimeout', { ms: 20 });
  await runTool('browser.assertText', { text: 'Customer 10' });
  await runTool('browser.assertText', { text: 'Showing 1 of 1 orders' });
  return { ok: true, fixture: 'datagrid.html', totalMs: Date.now()-start, timings };
}


