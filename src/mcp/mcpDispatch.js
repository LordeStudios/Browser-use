import { mcpToolMap, prompts, resources, getPrompt } from './mcpAdapter.js';
import { executeTool } from '../tools/toolExecutor.js';

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export { getPrompt };

export function toolDefinition(registry, name) {
  const tool = registry.get(mcpToolMap[name]);
  return {
    name,
    description: tool?.description || name,
    inputSchema: tool?.schema || { type: 'object', properties: {} }
  };
}

export function listToolDefinitions(registry) {
  return Object.keys(mcpToolMap)
    .filter((name) => mcpToolMap[name].startsWith('browser.'))
    .map((name) => toolDefinition(registry, name));
}

export async function readResource(ctx, uri = '') {
  if (uri.endsWith('/console')) return ctx.browser.diagnostics.console;
  if (uri.endsWith('/network')) return ctx.browser.diagnostics.network;
  if (uri.endsWith('/actions')) return ctx.actionTrace || [];
  if (uri.endsWith('/events')) return ctx.eventBus.recent(100);
  if (uri.endsWith('/state')) {
    return { info: await ctx.browser.getCurrentInfo(), diagnostics: ctx.browser.diagnostics.snapshot() };
  }
  return ctx.browser.getCurrentInfo().catch((error) => ({ error: error.message }));
}

// Shared tools/call semantics for stdio and HTTP transports. Returns the MCP
// result body ({ content, isError }) or an { error } shape for unknown tools.
export async function callMcpTool(ctx, registry, name, args = {}) {
  const internal = mcpToolMap[name];
  if (!internal) return { error: { code: -32601, message: 'Unknown MCP tool' } };
  if (internal === 'session.getEvents') {
    return { result: { content: [{ type: 'text', text: JSON.stringify(ctx.eventBus.recent(100)) }] } };
  }
  if (internal === 'session.stop') {
    return { result: { content: [{ type: 'text', text: JSON.stringify({ stopped: true }) }] } };
  }
  const output = await executeTool(ctx, registry, internal, args || {});
  return { result: { content: [{ type: 'text', text: JSON.stringify(output) }], isError: !output.ok } };
}

export { mcpToolMap, prompts, resources };
