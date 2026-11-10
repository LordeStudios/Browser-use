import { assertPermission } from './permissions.js';
import { verifyCommand } from './verification.js';

const MAX_ACTION_TRACE = 300;

function appendActionTrace(ctx, action) {
  const actions = ctx.actionTrace || [];
  const next = [...actions, action].slice(-MAX_ACTION_TRACE);
  ctx.actionTrace = next;
  return next;
}

export async function executeTool(ctx, registry, name, args = {}) {
  const tool = registry.get(name);
  if (!tool) return { ok: false, result: null, error: `Unknown tool: ${name}` };

  const startedAt = Date.now();
  const diagnosticsBefore = ctx.browser.diagnostics.snapshot();
  const infoBefore = await ctx.browser.getCurrentInfo().catch(() => null);

  try {
    assertPermission(tool, ctx.config);
    ctx.eventBus?.emitEvent('command.received', { command: name, args });
    const result = await tool.run(ctx, args || {});
    const verification = await verifyCommand(ctx, name, result, diagnosticsBefore);
    const elapsedMs = Date.now() - startedAt;
    const infoAfter = await ctx.browser.getCurrentInfo().catch(() => null);
    const evidence = {
      command: name,
      args,
      elapsedMs,
      before: infoBefore,
      after: infoAfter,
      consoleDelta: ctx.browser.diagnostics.consoleSince(diagnosticsBefore.console),
      networkDelta: ctx.browser.diagnostics.networkSince(diagnosticsBefore.network)
    };
    appendActionTrace(ctx, { ...evidence, ok: result.ok, error: result.error || null });
    const output = { ...result, verification, evidence };
    ctx.eventBus?.emitEvent('command.result', { command: name, args, result: output });
    return output;
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const evidence = {
      command: name,
      args,
      elapsedMs,
      before: infoBefore,
      after: await ctx.browser.getCurrentInfo().catch(() => null),
      consoleDelta: ctx.browser.diagnostics.consoleSince(diagnosticsBefore.console),
      networkDelta: ctx.browser.diagnostics.networkSince(diagnosticsBefore.network)
    };
    appendActionTrace(ctx, { ...evidence, ok: false, error: error.message });
    const output = { ok: false, result: null, error: error.message, verification: { ok: false, error: error.message }, evidence };
    ctx.eventBus?.emitEvent('command.error', { command: name, args, error: error.message });
    return output;
  }
}
