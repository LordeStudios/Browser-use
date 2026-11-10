import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildUpstreamCommand, resolveUpstreamRuntime } from '../src/upstream/runtime.js';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const toolRoot = path.resolve(scriptDirectory, '..');
const cliMode = process.argv.includes('--cli-mcp');
const mode = cliMode ? 'cli' : 'agent';

// The reference checkout is the original browser-use repo outside the UAP tree.
// Defaults to F:/browser-use so it can be tested side-by-side without Docker.
const referenceDir = process.env.BROWSER_USE_REFERENCE_DIR || 'F:/browser-use';

const runtime = resolveUpstreamRuntime({ toolRoot, sourceDir: referenceDir });
const { command, args } = buildUpstreamCommand({ ...runtime, mode });
const child = spawn(command, args, {
  cwd: runtime.sourceDir,
  env: {
    ...process.env,
    BROWSER_USE_LOGGING_LEVEL: process.env.BROWSER_USE_LOGGING_LEVEL || 'critical',
    BROWSER_USE_SETUP_LOGGING: process.env.BROWSER_USE_SETUP_LOGGING || 'false'
  },
  stdio: 'inherit',
  windowsHide: true
});

child.once('error', (error) => {
  console.error(`Unable to start reference Browser Use: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
