import { createRuntime } from './src/index.js';
import { createToolRegistry } from './src/tools/toolRegistry.js';
import { executeTool } from './src/tools/toolExecutor.js';

async function run() {
  const opts = { connect: 'http://127.0.0.1:9222', maxSeconds: 30 };
  const ctx = await createRuntime(opts);
  const registry = createToolRegistry();

  try {
    // First inspect the page to find rectangle-like nodes.
    const result = await executeTool(ctx, registry, 'browser.evaluate', {
      expression: `(() => {
        const nodes = [];
        for (const el of document.querySelectorAll('[data-node-id]')) {
          const r = el.getBoundingClientRect();
          if (r.width > 10 && r.height > 10) {
            nodes.push({ id: el.dataset.nodeId, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
          }
        }
        return nodes.sort((a, b) => a.y - b.y || a.x - b.x);
      })()`
    });

    console.log('Found nodes:', JSON.stringify(result, null, 2));
  } finally {
    await ctx.browser.close();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
