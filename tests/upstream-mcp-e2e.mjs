import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(testDirectory, '..');
const processHandle = spawn('node', ['scripts/run-upstream-browser-use.mjs'], {
  cwd: toolRoot,
  env: {
    ...process.env,
    BROWSER_USE_LOGGING_LEVEL: 'critical',
    BROWSER_USE_SETUP_LOGGING: 'false'
  },
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
      reject(new Error(`Timed out waiting for upstream ${method}; stderr=${stderr}`));
    }, 120_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  const initialize = await request(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'uganda-art-pulse-upstream-e2e', version: '1' }
  });
  assert.equal(initialize.result.serverInfo.name, 'browser-use');

  processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const toolList = await request(2, 'tools/list');
  const names = toolList.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('browser_navigate'), 'Official upstream navigation tool is missing');
  assert.ok(names.includes('retry_with_browser_use_agent'), 'Official upstream Agent retry tool is missing');
  console.log(JSON.stringify({ ok: true, upstreamTools: names.length }, null, 2));
} finally {
  processHandle.stdin.end();
  processHandle.kill();
}
