import { createRuntime } from '../src/index.js';
import { parseArgs } from '../src/config.js';
const opts = parseArgs(['--allow-dangerous']);
const ctx = await createRuntime(opts);
try {
  const tab = await ctx.browser.createTab('about:blank');
  console.log('tab ok', JSON.stringify(tab));
} catch(e) {
  console.log('error', e.message, e.stack?.split('\n').slice(0,5).join('\n'));
}
await ctx.browser.close();
const { killBrowserTree } = await import('../src/browser/chromeLauncher.js');
await killBrowserTree(ctx.launch);
