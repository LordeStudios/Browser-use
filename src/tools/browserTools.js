import { screenshot } from '../browser/screenshot.js';
import { domSnapshot } from '../browser/domSnapshot.js';
import * as input from '../browser/input.js';

const ok = (result) => ({ ok: true, result, error: null });
const readSchema = (properties = {}, required = []) => ({ type: 'object', properties, required });
const string = (description) => ({ type: 'string', description });
const number = (description) => ({ type: 'number', description });

async function inspectElement(ctx, selector) {
  const client = await ctx.browser.ensure();
  const response = await client.Runtime.evaluate({
    expression: `(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        tag: element.tagName.toLowerCase(), id: element.id || null, role: element.getAttribute('role'),
        text: (element.innerText || element.value || element.getAttribute('aria-label') || '').trim().slice(0, 500),
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
        disabled: Boolean(element.disabled), html: element.outerHTML.slice(0, 2_000)
      };
    })()`,
    returnByValue: true
  });
  return response.result?.value || null;
}

function actionTrace(ctx) {
  return ctx.actionTrace || [];
}

export function browserTools() {
  return [
    { name: 'browser.listTabs', description: 'List open browser tabs.', risk: 'read', schema: readSchema(), run: async (ctx) => ok(await ctx.browser.listTabs()) },
    { name: 'browser.selectTab', description: 'Select an existing tab by target ID.', risk: 'browser-control', schema: readSchema({ id: string('Chrome DevTools target ID.') }, ['id']), run: async (ctx, args) => ok(await ctx.browser.selectTab(args.id)) },
    { name: 'browser.createTab', description: 'Create and select a new tab.', risk: 'browser-control', schema: readSchema({ url: string('Initial URL. Defaults to about:blank.') }), run: async (ctx, args) => ok(await ctx.browser.createTab(args.url || 'about:blank')) },
    { name: 'browser.navigate', description: 'Navigate the current tab to a URL.', risk: 'browser-control', schema: readSchema({ url: string('Absolute URL or data URL.') }, ['url']), run: async (ctx, args) => ok(await ctx.browser.navigate(args.url)) },
    { name: 'browser.info', description: 'Read current URL, title, ready state, and focused element.', risk: 'read', schema: readSchema(), run: async (ctx) => ok(await ctx.browser.getCurrentInfo()) },
    { name: 'browser.screenshot', description: 'Capture a PNG screenshot and return its session artifact path.', risk: 'read', schema: readSchema(), run: async (ctx) => ok(await screenshot(ctx)) },
    { name: 'browser.domSnapshot', description: 'Read a compact summary of visible page landmarks and controls.', risk: 'read', schema: readSchema(), run: async (ctx) => ok(await domSnapshot(ctx)) },
    { name: 'browser.inspectElement', description: 'Read bounded semantic, geometry, and visibility details for a CSS selector.', risk: 'read', schema: readSchema({ selector: string('CSS selector.') }, ['selector']), run: async (ctx, args) => ok(await inspectElement(ctx, args.selector)) },
    { name: 'browser.getState', description: 'Read current page state, DOM summary, and diagnostic counts in one call.', risk: 'read', schema: readSchema(), run: async (ctx) => ok({ info: await ctx.browser.getCurrentInfo(), dom: await domSnapshot(ctx), diagnostics: ctx.browser.diagnostics.snapshot() }) },
    { name: 'browser.consoleLogs', description: 'Read captured browser console, exception, and DevTools Log records.', risk: 'read', schema: readSchema(), run: async (ctx) => ok({ logs: ctx.browser.diagnostics.console }) },
    { name: 'browser.clearConsoleLogs', description: 'Clear captured console diagnostics.', risk: 'browser-control', schema: readSchema(), run: async (ctx) => { ctx.browser.clearConsole(); return ok({ cleared: true }); } },
    { name: 'browser.networkLogs', description: 'Read normalized network request records, including in-flight requests.', risk: 'read', schema: readSchema(), run: async (ctx) => { ctx.browser.diagnostics.flushPending(); return ok({ requests: ctx.browser.diagnostics.network }); } },
    { name: 'browser.failedRequests', description: 'Read HTTP error and transport-failure request records.', risk: 'read', schema: readSchema(), run: async (ctx) => { ctx.browser.diagnostics.flushPending(); return ok({ requests: ctx.browser.diagnostics.failedRequests() }); } },
    { name: 'browser.clearNetworkLogs', description: 'Clear captured network diagnostics.', risk: 'browser-control', schema: readSchema(), run: async (ctx) => { ctx.browser.clearNetwork(); return ok({ cleared: true }); } },
    { name: 'browser.actionTrace', description: 'Read bounded action evidence from this browser session.', risk: 'read', schema: readSchema(), run: async (ctx) => ok({ actions: actionTrace(ctx) }) },
    { name: 'browser.assertNoConsoleErrors', description: 'Fail if captured console contains error or assertion events.', risk: 'read', schema: readSchema(), run: async (ctx) => { const errors = ctx.browser.diagnostics.console.filter((entry) => ['error', 'assert'].includes(entry.type)); return { ok: errors.length === 0, result: { errorCount: errors.length, errors }, error: errors.length ? `Found ${errors.length} console errors` : null }; } },
    { name: 'browser.assertVisible', description: 'Assert a selector resolves to a visible element.', risk: 'read', schema: readSchema({ selector: string('CSS selector.') }, ['selector']), run: async (ctx, args) => { const element = await inspectElement(ctx, args.selector); return element?.visible ? ok(element) : { ok: false, result: element, error: `Selector not visible: ${args.selector}` }; } },
    { name: 'browser.assertText', description: 'Assert text exists in the rendered document body.', risk: 'read', schema: readSchema({ text: string('Expected text.') }, ['text']), run: async (ctx, args) => { const found = await ctx.browser.evaluate(`document.body?.innerText?.includes(${JSON.stringify(args.text)})`); return found ? ok({ found: true }) : { ok: false, result: { found: false }, error: `Text not found: ${args.text}` }; } },
    { name: 'browser.click', description: 'Click viewport coordinates through Chromium CDP input.', risk: 'browser-control', schema: readSchema({ x: number('Viewport X.'), y: number('Viewport Y.') }, ['x', 'y']), run: async (ctx, args) => ok(await input.click(ctx, args)) },
    { name: 'browser.clickSelector', description: 'Scroll to and click a visible CSS selector through CDP input.', risk: 'browser-control', schema: readSchema({ selector: string('CSS selector.') }, ['selector']), run: async (ctx, args) => ok(await input.clickSelector(ctx, args)) },
    { name: 'browser.typeFast', description: 'Insert text at the focused element through CDP Input.insertText.', risk: 'browser-edit', schema: readSchema({ text: string('Text to insert.') }, ['text']), run: async (ctx, args) => ok(await input.insertText(ctx, args)) },
    { name: 'browser.type', description: 'Insert text at the focused element through CDP Input.insertText.', risk: 'browser-edit', schema: readSchema({ text: string('Text to insert.') }, ['text']), run: async (ctx, args) => ok(await input.typeText(ctx, args)) },
    { name: 'browser.typeSelector', description: 'Focus a visible editable selector and replace its value using CDP keyboard/input events.', risk: 'browser-edit', schema: readSchema({ selector: string('CSS selector.'), text: string('Replacement text.') }, ['selector', 'text']), run: async (ctx, args) => ok(await input.typeSelector(ctx, args)) },
    { name: 'browser.selectOption', description: 'Select an option by its value or visible label.', risk: 'browser-edit', schema: readSchema({ selector: string('Select CSS selector.'), value: string('Option value or label.') }, ['selector', 'value']), run: async (ctx, args) => ok(await input.selectOption(ctx, args)) },
    { name: 'browser.key', description: 'Press a key or simple modifier chord.', risk: 'browser-control', schema: readSchema({ key: string('Key name, such as Enter or Control+A.') }, ['key']), run: async (ctx, args) => ok(await input.key(ctx, args)) },
    { name: 'browser.scroll', description: 'Scroll browser viewport by pixel deltas.', risk: 'browser-control', schema: readSchema({ deltaX: number('Horizontal delta.'), deltaY: number('Vertical delta.') }), run: async (ctx, args) => ok(await input.scroll(ctx, args)) },
    { name: 'browser.hover', description: 'Move Chromium input to viewport coordinates.', risk: 'browser-control', schema: readSchema({ x: number('Viewport X.'), y: number('Viewport Y.') }, ['x', 'y']), run: async (ctx, args) => ok(await input.hover(ctx, args)) },
    { name: 'browser.drag', description: 'Drag using Chromium mouse events.', risk: 'browser-control', schema: readSchema({ fromX: number('Start X.'), fromY: number('Start Y.'), toX: number('End X.'), toY: number('End Y.'), steps: number('Optional interpolation count.') }, ['fromX', 'fromY', 'toX', 'toY']), run: async (ctx, args) => ok(await input.drag(ctx, args)) },
    { name: 'browser.wait', description: 'Wait for one explicit bounded duration; prefer observable page conditions over repeated sleeps.', risk: 'read', schema: readSchema({ ms: number('Required positive milliseconds, capped at 10000.') }, ['ms']), run: async (ctx, args) => ok(await input.wait(ctx, args)) },
    { name: 'browser.evaluate', description: 'Evaluate JavaScript in the current page context. This is explicit and may mutate the page.', risk: 'browser-control', schema: readSchema({ expression: string('JavaScript expression.') }, ['expression']), run: async (ctx, args) => ok(await ctx.browser.evaluate(args.expression)) },
    { name: 'browser.waitForSelector', description: 'Wait for a selector to become visible.', risk: 'read', schema: readSchema({ selector: string('CSS selector.'), timeout: number('Timeout milliseconds; defaults to 5000.') }, ['selector']), run: async (ctx, args) => { const deadline = Date.now() + Math.min(Math.max(Number(args.timeout) || 5_000, 1), 30_000); while (Date.now() < deadline) { const element = await inspectElement(ctx, args.selector); if (element?.visible) return ok({ found: true, selector: args.selector, element }); await new Promise((resolve) => setTimeout(resolve, 100)); } return { ok: false, result: null, error: `Timeout waiting for visible selector: ${args.selector}` }; } },
    { name: 'browser.waitForTimeout', description: 'Wait for one explicit bounded duration; prefer browser.waitForSelector when readiness is observable.', risk: 'read', schema: readSchema({ ms: number('Required positive milliseconds, capped at 10000.') }, ['ms']), run: async (ctx, args) => ok(await input.wait(ctx, args)) },
    { name: 'browser.mousemove', description: 'Move mouse to a selector or coordinate.', risk: 'browser-control', schema: readSchema({ x: number('Viewport X.'), y: number('Viewport Y.'), selector: string('Optional CSS selector.'), position: { type: 'object', description: 'Optional offset inside selector.' } }), run: async (ctx, args) => ok(await input.mousemove(ctx, args)) },
    { name: 'browser.mousedown', description: 'Press mouse button at selector or coordinate.', risk: 'browser-control', schema: readSchema({ x: number('Viewport X.'), y: number('Viewport Y.'), selector: string('Optional CSS selector.'), button: string('Mouse button.') }), run: async (ctx, args) => ok(await input.mousedown(ctx, args)) },
    { name: 'browser.mouseup', description: 'Release mouse button at selector or coordinate.', risk: 'browser-control', schema: readSchema({ x: number('Viewport X.'), y: number('Viewport Y.'), selector: string('Optional CSS selector.'), button: string('Mouse button.') }), run: async (ctx, args) => ok(await input.mouseup(ctx, args)) }
  ];
}
