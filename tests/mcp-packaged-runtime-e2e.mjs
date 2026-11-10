import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageRoot = path.join(root, 'desktop-release', 'win-unpacked');
const electronExecutable = path.join(packageRoot, 'Browser-use.exe');
const runtimeEntry = path.join(packageRoot, 'resources', 'app.asar', 'src', 'index.js');
const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-packaged-mcp-'));

assert.ok(fs.existsSync(electronExecutable), `Packaged executable is missing: ${electronExecutable}`);
assert.ok(fs.existsSync(path.join(packageRoot, 'resources', 'app.asar')), 'Packaged application archive is missing');

const processHandle = spawn(electronExecutable, [runtimeEntry, '--mcp'], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    BROWSER_USE_DATA_DIR: dataDirectory,
    BROWSER_USE_PROFILE_DIR: path.join(dataDirectory, 'browser-profiles')
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
  const initialize = await request(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'browser-use-packaged-e2e', version: '1' } });
  assert.equal(initialize.result.serverInfo.name, 'browser-use');
  processHandle.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const tools = await request(2, 'tools/list');
  assert.ok(tools.result.tools.length > 0);
  console.log(JSON.stringify({ ok: true, tools: tools.result.tools.length, runtime: 'packaged-electron-node-mode' }));
} finally {
  processHandle.stdin.end();
  processHandle.kill();
  fs.rmSync(dataDirectory, { recursive: true, force: true });
}
