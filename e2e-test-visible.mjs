import { createRuntime } from './src/index.js';
import { executeTool } from './src/tools/toolExecutor.js';
import { createToolRegistry } from './src/tools/toolRegistry.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const url = 'file:///' + path.join(__dirname, 'e2e-test.html').replace(/\\/g, '/');

async function main() {
  const registry = createToolRegistry();
  const ctx = await createRuntime({ url, allowDangerous: true });
  try {
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 800 });
    await executeTool(ctx, registry, 'browser.screenshot', {});
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#field' });
    await executeTool(ctx, registry, 'browser.typeSelector', { selector: '#field', text: 'this is working' });
    await executeTool(ctx, registry, 'browser.screenshot', {});
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#btn' });
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 500 });
    const after = await executeTool(ctx, registry, 'browser.screenshot', {});
    const text = await executeTool(ctx, registry, 'browser.assertText', { text: 'You typed: this is working' });
    console.log(JSON.stringify({ ok: true, url, text, screenshot: after }, null, 2));
  } finally {
    try { await ctx.browser.close(); } catch {}
    try { const { killBrowserTree } = await import('./src/browser/chromeLauncher.js'); await killBrowserTree(ctx.launch); } catch {}
  }
}
main().catch(e => { console.error(e); process.exit(1); });


