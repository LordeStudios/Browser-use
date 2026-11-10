import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'spa-todo.html').replace(/\\/g,'/')}`;
export async function run(ctx, registry){
  const { executeTool } = await import('../src/tools/toolExecutor.js');
  await executeTool(ctx, registry, 'browser.navigate', { url: fixtureUrl });
  await executeTool(ctx, registry, 'browser.typeSelector', { selector: '#todo-input', text: 'Buy snacks' });
  await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#add-btn' });
  await new Promise(r=>setTimeout(r,500));
  const html = await executeTool(ctx, registry, 'browser.evaluate', { expression: 'document.getElementById("todo-list").innerHTML' });
  const text = await executeTool(ctx, registry, 'browser.evaluate', { expression: 'document.body.innerText' });
  return { ok: true, html: html.result.value, text: text.result.value };
}
