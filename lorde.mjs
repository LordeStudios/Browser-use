#!/usr/bin/env node
// lorde.mjs — entry point so `node lorde` works from any directory.
//
// The package.json bin/lorde already points to cli/browser-use.js, but
// `node lorde` (bare command, no path) only works if lorde.mjs exists in
// the CWD or is on NODE_PATH. This file bridges that gap by delegating to
// the real CLI entry point.
//
// Usage:
//   node lorde                 -> interactive TUI
//   node lorde run "task text"  -> one-shot headless run
//   node lorde --help          -> help

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI  = path.join(HERE, 'cli', 'browser-use.js');

// Forward everything to the real entry point.
const { spawn } = await import('node:child_process');
const child = spawn(process.execPath, [CLI, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: process.cwd(),
  env: process.env,
});
child.on('error', (err) => {
  process.stderr.write(`lorde: failed to launch: ${err.message}\n`);
  process.exit(1);
});
child.on('close', (code, signal) => {
  if (signal === 'SIGINT' || signal === 'SIGTERM') process.exit(130);
  process.exit(code ?? 1);
});
process.on('SIGINT', () => { try { child.kill('SIGINT'); } catch {} });
