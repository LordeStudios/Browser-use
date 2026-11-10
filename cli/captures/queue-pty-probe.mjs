// Bounded PTY probe of the REAL TUI: does typed input reach the composer?
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const FAKE = path.join(HERE, 'fake-agent-queue-debug.mjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-pty-probe-'));
const p = pty.spawn(process.execPath, [path.join(TOOL_ROOT, 'cli', 'tui.mjs')], {
  name: 'xterm-256color', cols: 110, rows: 32, cwd: root,
  env: { ...process.env, XKIRO_API_KEY: 'sk-pty-probe', BROWSER_USE_TUI_AGENT_CLI: FAKE }
});
let raw = '';
p.onData((d) => { raw += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (t) => String(t).replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][0B]/g, '');
const boot = Date.now() + 45000;
while (Date.now() < boot && !strip(raw).includes('browser-use')) await sleep(200);
console.error('booted:', strip(raw).includes('browser-use'));
await sleep(1000);
p.write('/help\r');
await sleep(2500);
const s1 = strip(raw);
console.error('help rendered:', s1.includes('/help') && s1.includes('command'));
p.write('first task\r');
await sleep(6000);
console.error('run card rendered:', strip(raw).includes('▸ run run-'));
console.error('run dirs under cwd:', (() => { try { return fs.readdirSync(root).join(','); } catch { return 'ERR'; } })());
console.error('--- screen tail ---');
console.error(s1.slice(-1500));
try { p.kill(); } catch {}
try { if (process.platform === 'win32') require('node:child_process').spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
process.exit(0);
