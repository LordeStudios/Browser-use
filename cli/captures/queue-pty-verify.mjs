// cli/captures/queue-pty-verify.mjs
//
// LIVE PTY verification of the mid-run message queue (desktop parity):
// boots the REAL cli/tui.mjs in a real PTY (full-screen Ink tier, real TTY),
// starts a run with a slowed fake agent-cli (~2.5s), types a SECOND message
// mid-run, and captures the whole session to
//   cli/captures/queue-verify-20261013/pty-capture.txt   (raw, with ANSI)
//   cli/captures/queue-verify-20261013/pty-capture-plain.txt (ANSI-stripped)
// Assertions (results + exit code to files in the same dir):
//   - the dim queued card renders
//   - the footer shows "queued (1 total)"
//   - NO "already active" refusal
//   - the clean "▸ continuation — <task>" card renders when the first run ends
// All spawned trees are killed afterwards (taskkill /T /F).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pty = require('node-pty');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const OUT_DIR = path.join(HERE, 'queue-verify-20261013');
fs.mkdirSync(OUT_DIR, { recursive: true });

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-queue-pty-'));
const fakeAgentPath = path.join(HERE, 'fake-agent-queue-debug.mjs');

const shell = process.execPath;
const ptyProc = pty.spawn(shell, [path.join(TOOL_ROOT, 'cli', 'tui.mjs')], {
  name: 'xterm-256color',
  cols: 110,
  rows: 32,
  cwd: root,
  env: {
    ...process.env,
    XKIRO_API_KEY: 'sk-tui-queue-pty-fake-key',
    BROWSER_USE_TUI_AGENT_CLI: fakeAgentPath
  }
});

let raw = '';
ptyProc.onData((data) => { raw += data; });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// NOTE (node-pty 1.1.0 / ConPTY): the write() callback does not reliably fire
// on Windows ConPTY — awaiting it hangs the driver forever. Fire-and-forget
// the keystrokes and space them with sleeps instead.
const sendLine = async (line) => { ptyProc.write(line + '\r'); await sleep(120); };

const stripAnsi = (text) => String(text)
  .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '') // OSC
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI
  .replace(/\x1b[()][0B]/g, ''); // charset

const results = [];
const check = (name, ok) => { results.push({ name, ok }); console.error(`${ok ? 'PASS' : 'FAIL'} ${name}`); };

try {
  // Wait for the TUI's full-screen frame (the header brand line).
  const bootDeadline = Date.now() + 60000;
  while (Date.now() < bootDeadline && !stripAnsi(raw).includes('browser-use')) await sleep(200);
  check('TUI booted in a real PTY', stripAnsi(raw).includes('browser-use'));

  await sendLine(`/out ${root}`);
  await sendLine('first task');

  // Wait for the fake child to boot (started marker under the /out root).
  const startDeadline = Date.now() + 90000;
  let booted = false;
  while (Date.now() < startDeadline) {
    try {
      booted = fs.readdirSync(root).some((entry) => entry.startsWith('run-')
        && fs.existsSync(path.join(root, entry, 'started')));
    } catch { booted = false; }
    if (booted) break;
    await sleep(200);
  }
  check('run started (fake agent-cli child booted)', booted);
  await sleep(800); // let the run card settle on screen

  // THE OWNER ACTION: type a second message while the run is active.
  await sendLine('second task');
  await sleep(1500);

  // Wait for the fake to reach its terminal state and drain its queue.
  const doneDeadline = Date.now() + 30000;
  while (Date.now() < doneDeadline) {
    try {
      if (fs.readdirSync(root).some((entry) => fs.existsSync(path.join(root, entry, 'final-state.json')))) break;
    } catch { /* keep polling */ }
    await sleep(250);
  }
  await sleep(2500); // tailer + render settle

  const plain = stripAnsi(raw);
  check('queued card renders (▸ queued — delivers when the current run finishes)',
    plain.includes('▸ queued — delivers when the current run finishes'));
  check('footer shows queued (1 total)', plain.includes('queued (1 total)'));
  check('NO "already active" refusal on the mid-run submit', !plain.includes('already active'));
  check('continuation card renders (▸ continuation — second task)',
    plain.includes('▸ continuation') && plain.includes('second task'));
  check('run summary panel rendered (finished)', plain.includes('finished'));
} finally {
  fs.writeFileSync(path.join(OUT_DIR, 'pty-capture.txt'), raw);
  fs.writeFileSync(path.join(OUT_DIR, 'pty-capture-plain.txt'), stripAnsi(raw));
  // KILL ALL SPAWNED TREES: the PTY shell + the TUI + any child.
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(ptyProc.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    ptyProc.kill();
  } catch { /* already gone */ }
  await sleep(1000);
}

fs.writeFileSync(path.join(OUT_DIR, 'pty-results.json'), JSON.stringify(results, null, 2) + '\n');
const failed = results.filter((r) => !r.ok);
console.error(`\nPTY verify: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
