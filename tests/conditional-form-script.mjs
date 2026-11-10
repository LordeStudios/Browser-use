import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/tools/toolExecutor.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'conditional-form.html').replace(/\\/g,'/')}`;

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
  await runTool('browser.assertVisible', { selector: '#account-type' });
  await runTool('browser.selectOption', { selector: '#account-type', value: 'Business' });
  await runTool('browser.assertVisible', { selector: '#company' });
  await runTool('browser.typeSelector', { selector: '#company', text: 'SnackCo' });
  await runTool('browser.typeSelector', { selector: '#tax-id', text: '123456789' });
  await runTool('browser.typeSelector', { selector: '#email', text: 'hello@snack.co' });
  await runTool('browser.clickSelector', { selector: '#pick-file' });
  await runTool('browser.clickSelector', { selector: '#submit-form' });
  await runTool('browser.assertText', { text: 'Submitted' });
  return { ok: true, fixture: 'conditional-form.html', totalMs: Date.now()-start, timings };
}
