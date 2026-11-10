// Debug driver for the queueing E2E — mimics the test and dumps the captured
// TUI output tail so we can see exactly what rendered.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-queue-dbg-'));
const fakeAgentPath = path.join(root, 'fake-agent-cli.mjs');
fs.writeFileSync(fakeAgentPath, fs.readFileSync(path.join(HERE, 'fake-agent-queue-debug.mjs'), 'utf8'));
const childEnv = { ...process.env };
childEnv.XKIRO_API_KEY = 'sk-tui-queue-dbg-fake-key';
childEnv.BROWSER_USE_TUI_AGENT_CLI = fakeAgentPath;
childEnv.BROWSER_USE_TUI_FULL = '0';
const tui = spawn(process.execPath, [path.join(TOOL_ROOT, 'cli', 'tui.mjs')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: childEnv
});
let out = '';
tui.stdout.on('data', (c) => { out += String(c); });
tui.stderr.on('data', (c) => { out += String(c); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (line) => new Promise((r) => tui.stdin.write(line + '\n', r));

await send(`/out ${root}`);
await send('first task');
// wait for the fake to boot
const deadline = Date.now() + 90000;
for (;;) {
  let booted = false;
  try {
    booted = fs.readdirSync(root).some((e) => e.startsWith('run-') && fs.existsSync(path.join(root, e, 'started')));
  } catch {}
  if (booted || Date.now() > deadline) break;
  await sleep(200);
}
console.error('[dbg] fake booted');
await send('second task');
await sleep(6000); // fake exits at 2.5s + tailer settle
try { tui.stdin.end(); } catch {}
await new Promise((r) => { tui.on('exit', r); setTimeout(r, 8000); });
fs.writeFileSync(path.join(HERE, 'queue-e2e-debug-output.txt'), out);
const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
console.error('[dbg] contains queued card:', plain.includes('queued — delivers when the current run finishes'));
console.error('[dbg] contains queued (1 total):', plain.includes('queued (1 total)'));
console.error('[dbg] contains already active:', plain.includes('already active'));
console.error('[dbg] contains continuation:', plain.includes('▸ continuation'));
console.error('[dbg] contains finished:', plain.includes('finished'));
console.error('[dbg] --- tail (ansi-stripped, last 3000 chars) ---');
console.error(plain.slice(-3000));
