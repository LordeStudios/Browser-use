import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/tools/toolExecutor.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'checkout.html').replace(/\\/g,'/')}`;

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
  await runTool('browser.assertVisible', { selector: '#to-shipping' });
  await runTool('browser.clickSelector', { selector: '#to-shipping' });
  await runTool('browser.typeSelector', { selector: '#name', text: 'Max Test' });
  await runTool('browser.typeSelector', { selector: '#address', text: '123 Main St' });
  await runTool('browser.typeSelector', { selector: '#city', text: 'Kampala' });
  await runTool('browser.selectOption', { selector: '#country', value: 'Uganda' });
  await runTool('browser.clickSelector', { selector: '#to-payment' });
  await runTool('browser.typeSelector', { selector: '#card', text: '4111111111111111' });
  await runTool('browser.typeSelector', { selector: '#expiry', text: '12/28' });
  await runTool('browser.typeSelector', { selector: '#cvv', text: '123' });
  await runTool('browser.clickSelector', { selector: '#place-order' });
  await runTool('browser.assertText', { text: 'Order confirmed' });
  return { ok: true, fixture: 'checkout.html', totalMs: Date.now()-start, timings };
}
