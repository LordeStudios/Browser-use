#!/usr/bin/env node
// DEV RESUME — relaunch the dev desktop build at the exact point it left.
//
//   npm run desktop:dev_resume     kill the running dev build, relaunch it
//                                  resuming the previous session (same tabs,
//                                  same chat, same model, chat open, an
//                                  unfinished run continues)
//   npm run desktop:dev_restart    same, but start a FRESH session
//   npm run desktop:dev_kill       only kill the running dev build
//
// Flags: --kill-only  --fresh  --attach (keep the console attached instead of
// detaching, for watching logs).
//
// The kill is scoped to THIS checkout: only electron.exe processes whose
// executable lives inside this repository are stopped. Other Electron apps on
// the machine (including the assistant you are talking to) are untouched.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = new Set(process.argv.slice(2));
const killOnly = argv.has('--kill-only');
const listOnly = argv.has('--list');
const fresh = argv.has('--fresh');
const attach = argv.has('--attach');

function listDevProcesses() {
  if (process.platform !== 'win32') return [];
  const marker = root.replace(/'/g, "''");
  const script = [
    `$marker = '${marker}'`,
    "$found = @()",
    "Get-CimInstance Win32_Process -Filter \"name='electron.exe'\" | ForEach-Object {",
    '  $exe = [string]$_.ExecutablePath',
    '  if ($exe -and $exe.StartsWith($marker, [System.StringComparison]::OrdinalIgnoreCase)) {',
    '    $found += ("{0}|{1}" -f $_.ProcessId, $exe)',
    '  }',
    '}',
    '$found -join "`n"'
  ].join('\n');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [pid, ...rest] = line.split('|');
      return { pid: Number(pid), path: rest.join('|') };
    })
    .filter((entry) => Number.isInteger(entry.pid) && entry.pid > 0);
}

function killDevProcesses() {
  if (process.platform !== 'win32') {
    console.log('Dev resume is Windows-only; skipping the process cleanup.');
    return 0;
  }
  const found = listDevProcesses();
  if (!found.length) return 0;
  const ids = found.map((entry) => entry.pid);
  console.log(`Stopping ${ids.length} dev process(es) from this checkout: ${ids.join(', ')}`);
  const script = [
    '$ids = @(' + ids.join(',') + ')',
    '$killed = 0',
    'foreach ($id in $ids) {',
    '  try { Stop-Process -Id $id -Force -ErrorAction Stop; $killed++ } catch {}',
    '}',
    '$killed'
  ].join('\n');
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
  return ids.length;
}

async function waitForExit(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!listDevProcesses().length) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !listDevProcesses().length;
}

if (listOnly) {
  const found = listDevProcesses();
  if (!found.length) {
    console.log('No dev build is running in this checkout.');
  } else {
    console.log(`Dev processes in this checkout (${found.length}):`);
    for (const entry of found) console.log(`  pid ${entry.pid}  ${entry.path}`);
  }
  process.exit(0);
}

// ── DEFERRED RESTART (for the agent itself) ───────────────────────────────
// An agent that runs this from inside the app cannot kill the app and then
// keep running: its own terminal dies with it, and so would any child it
// spawned there. With --defer the timer is handed to an EXTERNAL shell —
// `cmd /c start ...` gives scripts/dev-resume-deferred.bat its own console —
// so the wait lives outside the app's terminal and survives the kill.
const deferArg = [...argv].find((value) => value === '--defer' || value.startsWith('--defer='));
const graceArg = [...argv].find((value) => value.startsWith('--grace='));
const dryRun = argv.has('--dry-run');
const internalHelper = argv.has('--kill-and-launch');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function helperLogPath() {
  return path.join(root, 'scratch', 'dev-resume-helper.log');
}
function helperLog(message) {
  try {
    fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
    fs.appendFileSync(helperLogPath(), `[${new Date().toISOString()}] ${message}\n`);
  } catch { /* logging must never break the restart */ }
}

if (deferArg && !internalHelper) {
  const seconds = Math.max(0, Math.min(120, Number(deferArg.split('=')[1] ?? 5) || 5));
  const timerScript = path.join(root, 'scripts', 'dev-resume-deferred.bat');
  if (!fs.existsSync(timerScript)) {
    console.error(`Missing ${timerScript}; cannot schedule the restart.`);
    process.exit(1);
  }
  // `start` is a cmd builtin that launches the batch file in its OWN console,
  // outside this process tree. The app's terminal can be torn down with the
  // app; this timer cannot.
  const timer = spawn('cmd.exe', ['/c', 'start', '', '/min', 'cmd.exe', '/c', timerScript], {
    cwd: root,
    env: {
      ...process.env,
      DEV_RESUME_GRACE: String(seconds),
      ...(fresh ? { DEV_RESUME_FRESH: '1' } : {}),
      ...(dryRun ? { DEV_RESUME_DRY: '1' } : {})
    },
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  timer.unref();
  console.log(`Restart scheduled in ${seconds}s by an external timer (cmd pid ${timer.pid}).`);
  console.log('End your turn now: the external timer kills the app after the grace period and relaunches it resuming THIS session.');
  console.log(`Trace: ${helperLogPath()}`);
  process.exit(0);
}

if (internalHelper) {
  // The wait belongs to the external timer; only an explicit --grace waits here.
  const seconds = graceArg ? Math.max(0, Math.min(120, Number(graceArg.split('=')[1]) || 0)) : 0;
  helperLog(`helper started; waiting ${seconds}s before the restart`);
  await sleep(seconds * 1000);
  helperLog('grace elapsed; restarting');
}

// A dry run must decide BEFORE touching anything: checking after the kill
// stopped the app while claiming it would not.
if (dryRun) {
  const found = listDevProcesses();
  const plan = `would stop ${found.length} dev process(es) and relaunch ${fresh ? 'fresh' : 'resuming'}${internalHelper ? ' (helper)' : ''}`;
  console.log(`DRY RUN: ${plan}.`);
  helperLog(`dry run: ${plan}`);
  process.exit(0);
}

const killed = killDevProcesses();
helperLog(`stopped ${killed} dev process(es)`);
if (killOnly) {
  console.log(killed ? 'Dev build stopped.' : 'No dev build was running.');
  process.exit(0);
}
if (killed) {
  if (!(await waitForExit())) {
    console.error('The previous dev build did not exit in time; refusing to start a second instance (the single-instance lock would make it quit silently).');
    helperLog('ERROR: previous dev build did not exit');
    process.exit(1);
  }
  console.log('Previous dev build stopped.');
}

const env = { ...process.env, BROWSER_USE_DEV_RESUME: fresh ? '0' : '1' };
// The agent shell exports ELECTRON_RUN_AS_NODE=1, which makes electron.exe run
// as plain Node and crash at ipcMain. Always launch as a real app.
delete env.ELECTRON_RUN_AS_NODE;

console.log(fresh
  ? 'Starting a FRESH dev session (previous session ignored).'
  : 'Starting the dev build and resuming the previous session (tabs + chat).');
helperLog(`launching electron (resume=${fresh ? '0' : '1'})`);

// A copy of this repo otherwise shares %APPDATA%\browser-use with the original
// and its single-instance lock, so the second build quits on launch. Setting
// BROWSER_USE_USER_DATA_DIR gives a copy its own profile (chats, settings,
// session) and lets both run side by side.
const userDataDir = String(env.BROWSER_USE_USER_DATA_DIR || '').trim();
const electronArgs = ['.', ...(userDataDir ? [`--user-data-dir=${userDataDir}`] : [])];
if (userDataDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`Profile: ${userDataDir}`);
  helperLog(`user data dir: ${userDataDir}`);
}

const child = spawn(electronPath, electronArgs, {
  cwd: root,
  env,
  detached: !attach,
  stdio: attach ? 'inherit' : 'ignore',
  windowsHide: false
});
if (!attach) {
  child.unref();
  console.log(`Dev build launched (pid ${child.pid}).`);
  console.log('The window reopens with the previous tabs and chat; an unfinished run continues where it stopped.');
  helperLog(`launched pid ${child.pid}`);
  process.exit(0);
}
child.on('exit', (code) => process.exit(code ?? 0));
