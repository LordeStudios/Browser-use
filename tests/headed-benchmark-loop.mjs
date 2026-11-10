import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const stages = [
  { name: 'stage-1-simple-form', script: 'checkout-script.mjs' },
  { name: 'stage-2-conditional-ui', script: 'conditional-form-script.mjs' },
  { name: 'stage-3-spa-state', script: 'spa-todo-script.mjs' }
];

function runVisibleStage(stage, pass) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const processHandle = spawn('node', ['src/index.js', '--allow-dangerous', '--max-seconds', '60', '--script', path.join('tests', stage.script)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false
    });
    let stdout = '';
    let stderr = '';
    processHandle.stdout.on('data', (chunk) => { stdout += chunk; });
    processHandle.stderr.on('data', (chunk) => { stderr += chunk; });
    processHandle.on('close', (code) => resolve({ stage: stage.name, pass, code, elapsedMs: Date.now() - startedAt, stdout, stderr }));
  });
}

const results = [];
for (const stage of stages) {
  for (const pass of ['cold', 'reuse']) {
    const result = await runVisibleStage(stage, pass);
    assert.equal(result.code, 0, `${stage.name}/${pass} exited ${result.code}: ${result.stderr}`);
    assert.match(result.stdout, /"ok"\s*:\s*true/, `${stage.name}/${pass} did not return an OK result: ${result.stdout}`);
    results.push({ stage: result.stage, pass, elapsedMs: result.elapsedMs });
  }
}

console.log(JSON.stringify({
  ok: true,
  mode: 'headed-only',
  results,
  alternatingOrder: results.map((entry) => `${entry.stage}:${entry.pass}`)
}, null, 2));
