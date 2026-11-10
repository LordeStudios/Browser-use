export function verifyNoConsoleErrors(ctx) {
  const errors = ctx.browser.diagnostics.console.filter((entry) => ['error', 'assert'].includes(entry.type));
  return { ok: errors.length === 0, consoleErrorCount: errors.length, errors: errors.slice(-5) };
}

export async function verifySelector(ctx, selector) {
  const found = await ctx.browser.evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
  return { ok: Boolean(found), selector };
}

export async function verifyVisibleText(ctx, text) {
  const found = await ctx.browser.evaluate(`document.body?.innerText?.includes(${JSON.stringify(text)})`);
  return { ok: Boolean(found), text };
}

export function verifyScreenshotCaptured(result) {
  return { ok: Boolean(result?.path), path: result?.path || null };
}

export function verifyDomChanged(before, after) {
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  return { ok: changed, changed };
}

export function verifyCommand(ctx, name, result, diagnosticsBefore = { console: 0, network: 0 }) {
  const consoleDelta = ctx.browser.diagnostics.consoleSince(diagnosticsBefore.console);
  const networkDelta = ctx.browser.diagnostics.networkSince(diagnosticsBefore.network);
  return {
    command: name,
    ok: Boolean(result?.ok),
    noConsoleErrors: verifyNoConsoleErrors(ctx).ok,
    consoleErrorCount: ctx.browser.diagnostics.console.filter((entry) => ['error', 'assert'].includes(entry.type)).length,
    consoleDelta,
    networkDelta,
    failedRequestDelta: networkDelta.filter((entry) => entry.failed || (entry.status != null && entry.status >= 400)),
    proof: result?.result?.path || null
  };
}
