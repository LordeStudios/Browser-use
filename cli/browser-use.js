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

  Browser:
    browser-use browser install   download the bundled headless shell (~120 MB, once)
    browser-use browser status    what the agent will drive, and where it lives
    browser-use browser path      print the executable path only

  Other:
    browser-use gui [--port <n>] [--open]
                              serve the GUI on http://127.0.0.1:<n> (default 4200)
                              and keep running. No desktop app needed: the web UI
                              talks to the CLI's own headless backend.
    browser-use help          this command list
    browser-use version       print the version

  Exit codes (run): 0 completed | 2 cancelled/clock | 1 failed
`);
}

/** Opens a URL in the OS default browser, best-effort. */
function openInBrowser(url) {
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => { /* headless shell: the URL is printed anyway */ });
    child.unref();
  } catch { /* the printed URL is the contract */ }
}

/**
 * browser-use browser <install|status|path> — the browser this package carries.
 * A stripped headless shell with only what CDP and rendering need, so a clean
 * machine, arm64 Linux and Android all behave the same.
 */
async function runBrowser(argv) {
  const action = String(argv[0] || 'status');
  const provisioner = await import(pathToFileURL(path.join(HERE, 'browserProvisioner.mjs')).href);
  if (action === 'path') {
    const info = provisioner.provisionedBrowserInfo();
    process.stdout.write(`${info.available ? info.path : ''}\n`);
    return;
  }
  if (action === 'install') {
    process.stdout.write('Provisioning the bundled browser (headless shell, one time)\n');
    let last = 0;
    try {
      const found = await provisioner.ensureProvisionedBrowser({
        onLine: (line) => {
          // The installer prints a percentage bar; keep it to one updating line.
          const pct = line.match(/(\d{1,3})%/);
          if (pct) {
            const now = Date.now();
            if (now - last > 250) { last = now; process.stdout.write(`\r  ${pct[1]}% downloaded`); }
            return;
          }
          if (/downloaded to|browser installed/i.test(line)) process.stdout.write(`\n  ${line}\n`);
        }
      });
      process.stdout.write(`\n  ready: ${found.path}\n`);
    } catch (error) {
      process.stderr.write(`\nbrowser provisioning failed: ${String(error?.message || error)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  const info = provisioner.provisionedBrowserInfo();
  if (!info.available) {
    process.stdout.write('No bundled browser yet.\n  run: browser-use browser install\n');
    return;
  }
  process.stdout.write(`bundled browser: ${info.kind}\n  path:  ${info.path}\n  cache: ${info.cacheRoot}\n`);
}

/**
 * browser-use doctor — one screen that answers "why is nothing working?":
 * node/npm versions, which browser would be driven, whether its CDP endpoint
 * answers, and where the GUI/CLI expect their files.
 */
async function runDoctor() {
  const lines = [];
  const ok = (label, detail) => lines.push(`  ok    ${label.padEnd(22)} ${detail}`);
  const bad = (label, detail) => lines.push(`  FAIL  ${label.padEnd(22)} ${detail}`);
  const info = (label, detail) => lines.push(`  ..    ${label.padEnd(22)} ${detail}`);

  lines.push(`browser-use doctor — v${readVersion()}`);
  lines.push('');
  lines.push('runtime');
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 20) ok('node', `v${process.versions.node}`);
  else bad('node', `v${process.versions.node} (20+ required)`);
  ok('platform', `${process.platform} ${process.arch}`);
  ok('package root', TOOL_ROOT);

  lines.push('');
  lines.push('browser (CDP target)');
  let chromePath = null;
  try {
    const adapter = await import(pathToFileURL(path.join(HERE, 'webContentsAdapter.cjs')).href);
    const resolved = (await adapter.findChromePath?.()) || null;
    chromePath = resolved;
    if (resolved) ok('binary', resolved);
    else bad('binary', 'no Chrome/Chromium/Edge found — set CHROME_PATH');
  } catch (error) {
    info('binary', `resolver unavailable: ${String(error?.message || error).slice(0, 80)}`);
  }
  if (chromePath) {
    try {
      const { launchHeadlessChrome, killChromeTree } = await import(pathToFileURL(path.join(HERE, 'webContentsAdapter.cjs')).href);
      const started = Date.now();
      const chrome = await Promise.race([
        launchHeadlessChrome({ startPort: 9419, profileDir: null, headed: false }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timed out after 45s')), 45_000))
      ]);
      ok('cdp launch', `port ${chrome.port} in ${Date.now() - started} ms`);
      try { killChromeTree?.(chrome); } catch { /* best effort */ }
    } catch (error) {
      bad('cdp launch', String(error?.message || error).slice(0, 120));
      info('hint', 'close other browser instances, or set CHROME_PATH to a Chrome binary');
    }
  }

  lines.push('');
  lines.push('gui');
  info('default url', 'http://127.0.0.1:4200  (browser-use gui --open)');
  info('backend', 'headless (cli/tui/guiBackend.mjs) — no desktop app required');

  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * browser-use gui — serves the renderer over HTTP with the CLI's headless
 * backend behind it (cli/tui/guiBackend.mjs). This is the "ships with the GUI,
 * no desktop app" path: no Electron process, no native window.
 */
async function runGui(argv) {
  const portIndex = argv.indexOf('--port');
  const requested = portIndex >= 0 ? Number(argv[portIndex + 1]) : NaN;
  const port = Number.isFinite(requested) && requested > 0 ? requested : 4200;
  const shouldOpen = argv.includes('--open');
  // Make sure the interface has a browser to drive before it serves anything.
  try {
    const provisioner = await import(pathToFileURL(path.join(HERE, 'browserProvisioner.mjs')).href);
    if (!provisioner.findProvisionedBrowser()) {
      process.stdout.write('Provisioning the bundled browser (one time, about 120 MB)\n');
      await provisioner.ensureProvisionedBrowser({
        onLine: (line) => {
          const pct = line.match(/(\d{1,3})%/);
          if (pct) process.stdout.write(`\r  ${pct[1]}% downloaded`);
        }
      });
      process.stdout.write('\n');
    }
  } catch (error) {
    process.stderr.write(`browser provisioning failed: ${String(error?.message || error)}\n`);
  }
  const modulePath = pathToFileURL(path.join(HERE, 'tui', 'guiServer.mjs')).href;
  const { startServer } = await import(modulePath);
  const { url } = await startServer(port);
  process.stdout.write(`browser-use GUI v${readVersion()} — ${url}\n`);
  process.stdout.write('  headless backend (no desktop app); Ctrl+C to stop\n');
  if (shouldOpen) openInBrowser(url);
  const shutdown = () => {
    process.stdout.write('\nbrowser-use GUI stopped\n');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // Keep the event loop alive for the server; nothing else to do.
  await new Promise(() => {});
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
  if (first === 'gui' || first === 'web' || first === 'serve') {
    await runGui(argv.slice(1));
    return;
  }
  if (first === 'doctor') {
    await runDoctor();
    return;
  }
  if (first === 'browser') {
    await runBrowser(argv.slice(1));
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
