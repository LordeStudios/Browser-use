const fixtureUrl = `file:///E:/Users/maximus/Documents/GitHub/uganda-art-pulse/tools/browser-use/tests/spa-todo.html`;
export async function run(ctx, registry){
  const { executeTool } = await import('../src/tools/toolExecutor.js');
  await executeTool(ctx, registry, 'browser.navigate', { url: fixtureUrl });
  await executeTool(ctx, registry, 'browser.typeSelector', { selector: '#todo-input', text: 'Buy snacks' });
  await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#add-btn' });
  const r = await executeTool(ctx, registry, 'browser.evaluate', { expression: 'JSON.stringify({bodyText: document.body.innerText, list: document.getElementById("todo-list").innerHTML, count: document.getElementById("todo-count").textContent})' });
  const r2 = await executeTool(ctx, registry, 'browser.evaluate', { expression: '({bodyText: document.body.innerText, list: document.getElementById("todo-list").innerHTML, count: document.getElementById("todo-count").textContent})' });
  return { ok:true, r1: r.result, r2: r2.result };
}
