import { createRuntime } from './src/index.js';
import { createToolRegistry } from './src/tools/toolRegistry.js';
import { executeTool } from './src/tools/toolExecutor.js';

const BENCHMARK_URL = 'http://127.0.0.1:8009/';

async function getState(ctx, registry) {
  const output = await executeTool(ctx, registry, 'browser.evaluate', {
    expression: `window.__v20State ? { phase: window.__v20State.phase, stageIndex: window.__v20State.stageIndex, cue: document.getElementById('cueText')?.textContent } : null`,
    returnByValue: true
  });
  return output?.result?.value ?? output?.result ?? output;
}

async function findTarget(ctx, registry) {
  const output = await executeTool(ctx, registry, 'browser.evaluate', {
    expression: `(() => {
      const cue = document.getElementById('cueText')?.textContent || '';
      const match = cue.match(/Activate the ([a-z]+) ([a-z]+)/i);
      if (!match) return null;
      const [_, color, shape] = match;
      const targets = document.querySelectorAll('.arena .target');
      for (const el of targets) {
        if (el.dataset.color === color && el.classList.contains(shape)) {
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), color, shape };
        }
      }
      return null;
    })()`,
    returnByValue: true
  });
  return output?.result?.value ?? output?.result ?? output;
}

async function waitFor(ctx, registry, predicate, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getState(ctx, registry);
    if (predicate(state)) return state;
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 120 });
  }
  throw new Error('Timeout waiting for state: ' + predicate.toString());
}

async function run() {
  const ctx = await createRuntime({ connect: 'http://127.0.0.1:9222', maxSeconds: 120 });
  const registry = createToolRegistry();

  try {
    await executeTool(ctx, registry, 'browser.navigate', { url: BENCHMARK_URL });
    await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 500 });
    await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#startButton' });

    while (true) {
      await waitFor(ctx, registry, (s) => s?.phase === 'target-visible');
      const target = await findTarget(ctx, registry);
      if (!target) {
        console.log('No target found for cue, waiting...');
        await executeTool(ctx, registry, 'browser.waitForTimeout', { ms: 200 });
        continue;
      }
      await executeTool(ctx, registry, 'browser.mousemove', { x: target.x, y: target.y });
      await executeTool(ctx, registry, 'browser.click', { x: target.x, y: target.y });

      const state = await getState(ctx, registry);
      if (state?.phase === 'final-results') break;
    }

    const reportOut = await executeTool(ctx, registry, 'browser.evaluate', {
      expression: `(() => {
        const s = window.__v20State;
        const correct = s.results.filter(r => r.outcome === 'correct').length;
        return { completedStages: s.results.length, correct, totalErrors: s.results.reduce((a, r) => a + r.errors, 0), results: s.results };
      })()`,
      returnByValue: true
    });
    const report = reportOut?.result?.value ?? reportOut?.result ?? reportOut;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await ctx.browser.close();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
