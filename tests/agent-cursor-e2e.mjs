import assert from 'node:assert/strict';
import { createRuntime } from '../src/index.js';
import { parseArgs } from '../src/config.js';
import { createToolRegistry } from '../src/tools/toolRegistry.js';
import { executeTool } from '../src/tools/toolExecutor.js';
import { killBrowserTree } from '../src/browser/chromeLauncher.js';

const registry = createToolRegistry();
const options = {
  ...parseArgs(['--max-seconds', '45']),
  allowedRisks: ['read', 'browser-control'],
  nativePointer: false
};
let ctx;

try {
  ctx = await createRuntime(options);
  const html = 'data:text/html,' + encodeURIComponent('<button id="target">Target</button>');
  const navigated = await executeTool(ctx, registry, 'browser.navigate', { url: html });
  assert.equal(navigated.ok, true, navigated.error);

  const clicked = await executeTool(ctx, registry, 'browser.clickSelector', { selector: '#target' });
  assert.equal(clicked.ok, true, clicked.error);
  assert.equal(clicked.result.cursor.mode, 'cdp-native-input');
  assert.equal(clicked.result.cursor.pageMutation, false);

  const browserUseNodes = await ctx.browser.evaluate(`Array.from(document.querySelectorAll('[id^="__browser_use_"]')).map((node) => node.id)`);
  assert.deepEqual(browserUseNodes, [], 'native CDP input must not inject Browser-use nodes into the page');

  console.log(JSON.stringify({ ok: true, browserUseNodes }, null, 2));
} finally {
  await ctx?.browser.close().catch(() => {});
  await killBrowserTree(ctx?.launch).catch(() => {});
}
