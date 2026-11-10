import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeTool } from '../src/tools/toolExecutor.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'spa-todo.html').replace(/\\/g,'/')}`;

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
  await runTool('browser.evaluate', { expression: 'sessionStorage.clear()' });
  await runTool('browser.waitForSelector', { selector: '#todo-input', timeout: 5000 });
  await runTool('browser.typeSelector', { selector: '#todo-input', text: 'Buy snacks' });
  await runTool('browser.clickSelector', { selector: '#add-btn' });
  await runTool('browser.waitForSelector', { selector: '#todo-list li', timeout: 5000 });
  await runTool('browser.typeSelector', { selector: '#todo-input', text: 'Build browser tool' });
  await runTool('browser.clickSelector', { selector: '#add-btn' });
  await runTool('browser.clickSelector', { selector: 'li:has-text("Buy snacks")' });
  await runTool('browser.clickSelector', { selector: '#filter-completed' });
  await runTool('browser.waitForTimeout', { ms: 30 });
  await runTool('browser.assertText', { text: '1 items' });
  await runTool('browser.clickSelector', { selector: '#filter-active' });
  await runTool('browser.waitForTimeout', { ms: 30 });
  await runTool('browser.assertText', { text: '1 items' });
  await runTool('browser.clickSelector', { selector: '#nav-about' });
  await runTool('browser.assertText', { text: 'browser-use automation testing' });
  return { ok: true, fixture: 'spa-todo.html', totalMs: Date.now()-start, timings };
}

