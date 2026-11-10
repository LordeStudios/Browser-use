import { strict as assert } from 'node:assert';
import { executeTool } from '../src/tools/toolExecutor.js';

const studioUrl = process.env.LORDE_STUDIO_URL || 'http://127.0.0.1:3001/Apps/lorde-design-studio/';

async function runTool(ctx, registry, command, args = {}) {
  const result = await executeTool(ctx, registry, command, args);
  assert.equal(result.ok, true, `${command} failed: ${result.error}`);
  return result;
}

export async function run(ctx, registry) {
  await runTool(ctx, registry, 'browser.navigate', { url: studioUrl });
  await runTool(ctx, registry, 'browser.waitForSelector', { selector: '#lorde-design-tab-lorde-ai', timeout: 15_000 });
  await runTool(ctx, registry, 'browser.clickSelector', { selector: '#lorde-design-tab-lorde-ai' });
  await runTool(ctx, registry, 'browser.wait', { ms: 500 });
  const panelState = await runTool(ctx, registry, 'browser.evaluate', { expression: `(() => ({ activeTab: document.querySelector('[data-left-tab].is-active')?.dataset.leftTab || null, panelActive: document.querySelector('[data-left-panel="lorde-ai"]')?.classList.contains('is-active') || false, annotationButton: Boolean(document.querySelector('#lorde-ai-annotate-btn')) }))()` });
  assert.equal(panelState.result.activeTab, 'lorde-ai', `Lorde AI tab did not activate: ${JSON.stringify(panelState.result)}`);
  assert.equal(panelState.result.annotationButton, true, `Lorde AI controls did not render: ${JSON.stringify(panelState.result)}`);
  await runTool(ctx, registry, 'browser.clickSelector', { selector: '#lorde-ai-annotate-btn' });
  await runTool(ctx, registry, 'browser.waitForSelector', { selector: 'canvas.lds-lorde-ai-annotation-overlay', timeout: 5_000 });

  const overlay = await runTool(ctx, registry, 'browser.inspectElement', { selector: 'canvas.lds-lorde-ai-annotation-overlay' });
  const rect = overlay.result.rect;
  assert.ok(rect.width > 80 && rect.height > 80, `Overlay is not drawable: ${JSON.stringify(rect)}`);

  await runTool(ctx, registry, 'browser.drag', {
    fromX: rect.x + 48,
    fromY: rect.y + 48,
    toX: rect.x + Math.min(220, rect.width - 32),
    toY: rect.y + Math.min(180, rect.height - 32),
    steps: 16
  });
  await runTool(ctx, registry, 'browser.waitForSelector', { selector: '.lds-lorde-ai-annotation-bar', timeout: 5_000 });
  await runTool(ctx, registry, 'browser.clickSelector', { selector: '.lds-lorde-ai-annotation-color' });
  await runTool(ctx, registry, 'browser.waitForSelector', { selector: '.lds-lorde-ai-annotation-palette', timeout: 5_000 });
  await runTool(ctx, registry, 'browser.clickSelector', { selector: '.lds-lorde-ai-annotation-bar [data-action="save"]' });
  await runTool(ctx, registry, 'browser.waitForSelector', { selector: '#lorde-ai-pending-annotation:not([hidden])', timeout: 15_000 });
  const screenshot = await runTool(ctx, registry, 'browser.screenshot');

  return {
    ok: true,
    fixture: 'live-lorde-design-studio-annotation-ui',
    studioUrl,
    screenshot: screenshot.result.path,
    overlay: rect,
    actionCount: (await runTool(ctx, registry, 'browser.actionTrace')).result.actions.length
  };
}
