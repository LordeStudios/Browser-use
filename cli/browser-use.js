#!/usr/bin/env node
// cli/browser-use.js — thin ESM entry for the browser-use CLI.
//
// package.json has "type": "module", so a plain .js file with import syntax
// works directly as the npm "bin" target for browser-use / browser / lorde.
//
//   browser-use              -> interactive TUI (cli/tui.mjs)
//   browser-use tui          -> same
//   browser-use run [--flags] [task text...]  -> one-shot headless run via cli/agent-cli.mjs
//   browser-use help         -> command list
//   browser-use version      -> package version
//   anything else            -> treated as `run`

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const AGENT_CLI = path.join(HERE, 'agent-cli.mjs');
const TUI = path.join(HERE, 'tui.mjs');

function readVersion() {
  try {
    // package.json may carry a UTF-8 BOM on Windows; JSON.parse does not
    // accept it even though npm itself does. Strip it so the globally linked
    // lorde/browser-use command reports the real package version.
    const text = fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8').replace(/^﻿/, '');
    return String(JSON.parse(text).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function printHelp() {
  const version = readVersion();
  process.stdout.write(`browser-use v${version} — headless browser agent runner + TUI

  Interactive session:
    browser-use                 open the TUI (slash commands; /help inside)

  One-shot run (streams cli/agent-cli.mjs output, prints the JSON summary):
    browser-use run [--flags] [task text...]
    browser-use [--flags] [task text...]

    Common flags (passed through to agent-cli.mjs):
      --url <url>             pre-open this page (file:/// works)
      --model <id>            default z-ai/glm-5.3-flash
      --provider-id <id>      xkiro | anthropic | openai | ...
      --max-seconds <n>       observer clock (0 = untimed)
      --max-steps <n>         external step budget (0 = unlimited)
      --max-recoveries <n>    external recovery budget (0 = unlimited)
      --system-file <path>    variant system prompt file
      --out-dir <dir>         trace.jsonl + final-state.json destination
      --control-mode <m>      browser | agi
      --cwd <dir>             working repo (default: the invocation dir)
      --workspace <dir>       run workspace contract (default: --cwd)
      --headed                visible Chrome window
      --quiet                 suppress the final JSON summary

  Other:
    browser-use help          this command list
    browser-use version       print the version

  Exit codes (run): 0 completed | 2 cancelled/clock | 1 failed
`);
}

/** Partition argv into { flags: string[], positionals: string[] }. */
function partitionArgv(argv) {
  const flags = [];
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.push(arg, next);
        i += 1;
      } else {
        flags.push(arg);
      }
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

async function runHeadless(argv) {
  // Strip the optional `run` keyword, pass --flags through, join positionals.
  const rest = argv[0] === 'run' ? argv.slice(1) : argv.slice();
  const { flags, positionals } = partitionArgv(rest);
  const hasTaskFlag = flags.some((flag, index) => flag === '--task' || flag === '--task-file');
  if (positionals.length > 0 && !hasTaskFlag) {
    flags.push('--task', positionals.join(' '));
  }

  // WORKING REPO (defect 4): one-shot runs root at the INVOCATION directory —
  // the child spawns there and declares it as its workspace contract, so the
  // agent works where the user launched the CLI, never a hard-coded repo.
  // Explicit --cwd/--workspace from the caller always win.
  const invocationCwd = process.cwd();
  if (!flags.includes('--cwd')) flags.push('--cwd', invocationCwd);
  if (!flags.includes('--workspace')) flags.push('--workspace', invocationCwd);

  const child = spawn(process.execPath, [AGENT_CLI, ...flags], {
    stdio: 'inherit',
    cwd: invocationCwd,
    env: process.env
  });
  child.on('error', (error) => {
    process.stderr.write(`browser-use: failed to spawn agent-cli: ${String(error?.message || error)}\n`);
    process.exitCode = 1;
  });
  child.on('close', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') process.exit(130);
    process.exit(code === null || code === undefined ? 1 : code);
  });
  // Forward Ctrl+C to the child (Windows delivers SIGINT to the child group
  // already; this covers shims that detach the child).
  process.on('SIGINT', () => {
    try { child.kill('SIGINT'); } catch { /* already gone */ }
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first === undefined || first === 'tui' || first === 'TUI') {
    await import(pathToFileURL(TUI).href);
    return;
  }
  if (first === 'help' || first === '--help' || first === '-h' || first === '/help') {
    printHelp();
    return;
  }
  if (first === 'version' || first === '--version' || first === '-v') {
    process.stdout.write(`browser-use v${readVersion()}\n`);
    return;
  }
  await runHeadless(argv);
}

main().catch((error) => {
  process.stderr.write(`browser-use: ${String(error?.stack || error)}\n`);
  process.exit(1);
});
