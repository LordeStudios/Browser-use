import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRuntime } from '../src/index.js';
import { parseArgs } from '../src/config.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import { executeTool } from '../src/tools/toolExecutor.js';
import { killBrowserTree } from '../src/browser/chromeLauncher.js';

const registry = createToolRegistry();
const options = {
  ...parseArgs(['--max-seconds', '180']),
  allowedRisks: ['read', 'browser-control'],
  nativePointer: false
};

let ctx;

async function runVector20Test() {
  console.log('🚀 Launching Browser-use runtime for Vector 20 benchmark test...');
  ctx = await createRuntime(options);

  const indexPath = path.resolve('C:/Users/Administrator/Desktop/New folder (9)/index.html');
  const targetUrl = pathToFileURL(indexPath).href;
  console.log(`🌐 Navigating to ${targetUrl}...`);

  const navigated = await executeTool(ctx, registry, 'browser.navigate', { url: targetUrl });
  assert.equal(navigated.ok, true, navigated.error);

  console.log('▶️ Clicking Begin 20-stage benchmark button...');
  const startClicked = await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#startButton' });
  assert.equal(startClicked.ok, true, startClicked.error);

  console.log('🎯 Running through all 20 benchmark stages dynamically...');

  let lastReportedStage = -1;
  const startTime = Date.now();

  while (Date.now() - startTime < 120_000) {
    const pageState = await ctx.browser.evaluate(`(() => {
      const results = document.getElementById('resultsView');
      if (results && !results.classList.contains('hidden')) return { done: true };
      const arena = document.getElementById('arena');
      if (!arena || arena.dataset.state !== 'active') return { waiting: true };
      const target = arena.querySelector('.target');
      if (!target) return { waiting: true };
      const rect = target.getBoundingClientRect();
      const state = window.__v20State;
      return {
        done: false,
        stageIndex: state ? state.stageIndex : 0,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        label: target.getAttribute('aria-label')
      };
    })()`);

    if (pageState.done) {
      console.log('🏆 All 20 stages completed successfully!');
      break;
    }

    if (pageState.waiting || !pageState.x || !pageState.y) {
      await new Promise(r => setTimeout(r, 120));
      continue;
    }

    const currentStage = pageState.stageIndex + 1;
    if (currentStage !== lastReportedStage) {
      console.log(`  ➔ Active Stage ${currentStage}/20 [Target: ${pageState.label}]`);
      lastReportedStage = currentStage;
    }

    await executeTool(ctx, registry, 'browser.click', { x: pageState.x, y: pageState.y });
    await new Promise(r => setTimeout(r, 1050));
  }

  // Verify final results view
  const resultsState = await ctx.browser.evaluate(`(() => {
    const results = document.getElementById('resultsView');
    const desc = document.getElementById('resultsDescription');
    const rows = document.querySelectorAll('#resultRows tr');
    return {
      visible: results && !results.classList.contains('hidden'),
      description: desc ? desc.textContent : '',
      completedRows: rows ? rows.length : 0
    };
  })()`);

  console.log('\n📊 Vector 20 Final Results Summary:');
  console.log(`   - Results View Visible: ${resultsState.visible}`);
  console.log(`   - Summary: ${resultsState.description}`);
  console.log(`   - Completed Rows: ${resultsState.completedRows}/20`);

  assert.equal(resultsState.visible, true, 'Results view should be visible at end of run');
  assert.equal(resultsState.completedRows, 20, 'All 20 stages should have completed result rows');

  console.log('\n✅ Vector 20 Target Acquisition Benchmark test PASSED 100% with perfection!');
}

try {
  await runVector20Test();
} catch (error) {
  console.error('\n❌ Vector 20 Benchmark Test Failed:', error);
  process.exitCode = 1;
} finally {
  await ctx?.browser.close().catch(() => {});
  await killBrowserTree(ctx?.launch).catch(() => {});
}
