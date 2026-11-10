import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureUrl = `file:///${path.join(__dirname,'spa-todo.html').replace(/\\/g,'/')}`;

export async function run(ctx, registry){
  const { executeTool } = await import('../src/tools/toolExecutor.js');
  async function runTool(name,args){ const r=await executeTool(ctx,registry,name,args); if(!r.ok) throw new Error(`${name}: ${r.error}`); return r; }
  await runTool('browser.navigate', { url: fixtureUrl });
  await runTool('browser.evaluate', { expression: 'sessionStorage.clear()' });
  await runTool('browser.waitForSelector', { selector: '#todo-input', timeout: 5000 });
  await runTool('browser.typeSelector', { selector: '#todo-input', text: 'Buy snacks' });
  await runTool('browser.clickSelector', { selector: '#add-btn' });
  await runTool('browser.typeSelector', { selector: '#todo-input', text: 'Build browser tool' });
  await runTool('browser.clickSelector', { selector: '#add-btn' });
  const before = await runTool('browser.evaluate',{expression:'Array.from(document.querySelectorAll("li")).map(li=>({id:li.id,text:li.textContent,done:li.classList.contains("done")}))'});
  const clickRes = await runTool('browser.clickSelector', { selector: 'li:has-text("Buy snacks")' });
  const after = await runTool('browser.evaluate',{expression:'Array.from(document.querySelectorAll("li")).map(li=>({id:li.id,text:li.textContent,done:li.classList.contains("done")}))'});
  return { ok:true, before: before.result, click: clickRes.result, after: after.result };
}
