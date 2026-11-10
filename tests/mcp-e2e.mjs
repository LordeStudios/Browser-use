import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const processHandle = spawn('node', ['src/index.js', '--mcp'], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe']
});

const pending = new Map();
let stdoutBuffer = '';
let stderr = '';

processHandle.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  }
});
processHandle.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function request(id, method, params = undefined) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}; stderr=${stderr}`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const initialize = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browser-use-e2e', version: '1' } });
  assert.equal(initialize.result.serverInfo.name, 'browser-use');

  processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const toolList = await request(2, 'tools/list');
  const networkTool = toolList.result.tools.find((tool) => tool.name === 'browser_network_logs');
  const typeSelectorTool = toolList.result.tools.find((tool) => tool.name === 'browser_type_selector');
  assert.ok(networkTool, 'Network diagnostics MCP tool is missing');
  assert.deepEqual(networkTool.inputSchema.required, []);
  assert.ok(typeSelectorTool, 'Typing MCP tool is missing');
  assert.deepEqual(typeSelectorTool.inputSchema.required, ['selector', 'text']);

  const state = await request(3, 'tools/call', { name: 'browser_get_state', arguments: {} });
  assert.equal(state.result.isError, false);
  console.log(JSON.stringify({ ok: true, tools: toolList.result.tools.length, state: JSON.parse(state.result.content[0].text).ok }, null, 2));
} finally {
  processHandle.stdin.end();
  processHandle.kill();
}
