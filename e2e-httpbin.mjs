import { createRuntime } from './src/index.js';
import { executeTool } from './src/tools/toolExecutor.js';
import { createToolRegistry } from './src/tools/toolRegistry.js';

async function main() {
  const registry = createToolRegistry();
  const ctx = await createRuntime({ url: 'https://httpbin.org/forms/post', allowDangerous: true });
  try {
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 2000 });
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: 'input[name=\"custname\"]' });
    await executeTool(ctx, registry, 'browser.typeSelector', { selector: 'input[name=\"custname\"]', text: 'browser use' });
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: 'input[name=\"custtel\"]' });
    await executeTool(ctx, registry, 'browser.typeSelector', { selector: 'input[name=\"custtel\"]', text: '12345' });
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: 'button:has-text(\'Submit order\')' });
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 3000 });
    const after = await executeTool(ctx, registry, 'browser.screenshot', {});
    const info = await executeTool(ctx, registry, 'browser.info', {});
    const hasValue = await executeTool(ctx, registry, 'browser.evaluate', { expression: 'document.querySelector(\'input[name=\\\"custname\\\"]\').value' });
    console.log(JSON.stringify({ ok: true, url: info.result.url, value: hasValue.result, screenshot: after }, null, 2));
  } finally {
    try { await ctx.browser.close(); } catch {}
    try { const { killBrowserTree } = await import('./src/browser/chromeLauncher.js'); await killBrowserTree(ctx.launch); } catch {}
  }
}
main().catch(e => { console.error(e); process.exit(1); });
