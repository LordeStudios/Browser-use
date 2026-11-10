import readline from 'node:readline';
import { killBrowserTree } from '../browser/chromeLauncher.js';
import { MCP_PROTOCOL_VERSION, listToolDefinitions, readResource, callMcpTool, prompts, resources, getPrompt } from './mcpDispatch.js';

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

export function startMcpServer(ctx, registry) {
  const lines = readline.createInterface({ input: process.stdin, terminal: false });
  let initialized = false;

  lines.on('line', async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const id = message.id ?? null;
    if (message.method === 'initialize') {
      initialized = true;
      send({
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
          serverInfo: { name: 'browser-use', version: '0.4.0' }
        }
      });
      return;
    }
    if (message.method === 'notifications/initialized') return;
    if (!initialized) {
      send({ id, error: { code: -32001, message: 'Server not initialized' } });
      return;
    }

    if (message.method === 'tools/list') {
      send({ id, result: { tools: listToolDefinitions(registry) } });
      return;
    }
    if (message.method === 'resources/list') {
      send({ id, result: { resources } });
      return;
    }
    if (message.method === 'prompts/list') {
      send({ id, result: { prompts } });
      return;
    }
    if (message.method === 'prompts/get') {
      const name = message.params?.name;
      const prompt = await getPrompt(name);
      if (!prompt) {
        send({ id, error: { code: -32602, message: `Unknown prompt: ${name}` } });
        return;
      }
      send({ id, result: { description: prompt.description, messages: prompt.messages } });
      return;
    }
    if (message.method === 'tools/call') {
      const outcome = await callMcpTool(ctx, registry, message.params?.name, message.params?.arguments || {});
      if (outcome.error) {
        send({ id, error: outcome.error });
        return;
      }
      send({ id, result: outcome.result });
      return;
    }
    if (message.method === 'resources/read') {
      const uri = message.params?.uri || '';
      const resource = await readResource(ctx, uri);
      send({ id, result: { contents: [{ uri, text: JSON.stringify(resource) }] } });
      return;
    }

    send({ id, error: { code: -32601, message: 'Unknown method' } });
  });

  lines.on('close', async () => {
    await ctx.browser.close().catch(() => {});
    await killBrowserTree(ctx.launch).catch(() => {});
  });
  ctx.eventBus.emitEvent('mcp.listen', { transport: 'stdio' });
  return lines;
}
