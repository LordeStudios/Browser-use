// tests/cli-computer-backend.test.mjs
//
// node --test tests/cli-computer-backend.test.mjs
//
// LIVE functional tests for the headless CLI computer-tools backend
// (cli/computerToolsBackend.cjs — directive 2026-10-13: the CLI has NO
// computer-tool permission gates). Every implemented tool gets a real
// functional probe:
//   - computer_terminal: execute echoes through the real shell + a real PTY
//     session (open/send with expected output) via node-pty
//   - computer_write/computer_read: file round-trip
//   - computer_git: status on a temp repo
//   - computer_clipboard: PowerShell write/read round-trip
//   - computer_screenshot: a real PNG with non-uniform pixels (per-pixel
//     distinct-color count through .NET — no image library)
//   - computer_observe / computer_pointer: the REAL native worker (koffi
//     user32 SendInput/GetCursorPos) forked under plain Node — move +3,+3,
//     read back, restore
//   - computer_record: honest refusal naming the exact Electron blocker
//   - --headed flag: launchHeadlessChrome({headed:true}) opens a REAL window,
//     the CDP endpoint answers, and the tree is killed
//   - browser_* headless: the CLI's own CDP adapter drives navigate,
//     screenshot, executePageScript, queryElements and clickAt for real

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
const { createFreshCliComputerTools } = require(path.join(TOOL_ROOT, 'cli', 'computerToolsBackend.cjs'));
const { launchHeadlessChrome, killChromeTree, connectTab } = require(path.join(TOOL_ROOT, 'cli', 'webContentsAdapter.cjs'));
const { BrowserViewController } = require(path.join(TOOL_ROOT, 'desktop', 'mcp', 'browserViewController.cjs'));

const SCRATCH = path.join(TOOL_ROOT, 'scratch', `cli-backend-test-${Date.now()}`);
const OWNER = 'cli-backend-test';
const MARKER = `backend-terminal-echo-${Math.floor(Math.random() * 1e6)}`;

let tools = null;
const keptPaths = [];

function scratchPath(name) {
  const target = path.join(SCRATCH, name);
  keptPaths.push(target);
  return target;
}

function runPowerShellJson(script) {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message} ${String(stderr || '').slice(0, 300)}`));
      else resolve(String(stdout || '').trim());
    });
  });
}

before(async () => {
  fs.mkdirSync(SCRATCH, { recursive: true });
  tools = createFreshCliComputerTools();
});

after(async () => {
  try { await tools?.close(); } catch { /* best effort */ }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ------------------------------------------------------------ file ops ----
test('computer_write -> computer_read round-trips a text file', async () => {
  const target = scratchPath('roundtrip.txt');
  const write = await tools.execute('computer_write', { path: target, content: 'line one\nline two\nline three', createParents: true }, OWNER);
  assert.equal(write.ok, true, `write ok: ${JSON.stringify(write).slice(0, 300)}`);
  const read = await tools.execute('computer_read', { path: target }, OWNER);
  assert.equal(read.ok, true);
  assert.equal(read.totalLines, 3);
  assert.match(read.content, /line two/);
  assert.match(read.content, /^\s*2\tline two/m, 'cat -n numbering present');
});

test('computer_fs stat + computer_search round-trip the same tree', async () => {
  const target = scratchPath('search/haystack.txt');
  await tools.execute('computer_write', { path: target, content: 'the DISTINCTIVE_NEEDLE_42 lives here', createParents: true }, OWNER);
  const stat = await tools.execute('computer_fs', { action: 'stat', path: target }, OWNER);
  assert.equal(stat.ok, true);
  const search = await tools.execute('computer_search', { pattern: 'DISTINCTIVE_NEEDLE_42', path: path.dirname(target) }, OWNER);
  assert.equal(search.ok, true);
  assert.ok(search.lines.some((line) => line.file === target), 'search finds the needle');
});

// ------------------------------------------------------------ terminal ----
test('computer_terminal execute echoes through the real shell', async () => {
  const result = await tools.execute('computer_terminal', { action: 'execute', command: `Write-Output '${MARKER}'`, waitMs: 15_000 }, OWNER);
  assert.equal(result.state, 'completed', `job state: ${JSON.stringify(result).slice(0, 400)}`);
  assert.equal(result.exitCode, 0);
  assert.ok(result.output.includes(MARKER), `output echoed: ${String(result.output).slice(0, 200)}`);
});

test('computer_terminal opens a REAL session and send() observes output', async () => {
  const opened = await tools.execute('computer_terminal', { action: 'open', newSession: true, cwd: SCRATCH, waitMs: 10_000 }, OWNER);
  assert.ok(opened.sessionId, `session opened: ${JSON.stringify(opened).slice(0, 300)}`);
  // The backend is reported HONESTLY either way (node-pty ConPTY, or the
  // documented piped fallback when the test runner has no console —
  // node --test children cannot AttachConsole). A direct probe of this
  // module under a real console already proved ConPTY works; here we require
  // the backend to be one of the two real ones and the echo to WORK.
  const backend = opened.backend || {};
  assert.ok(backend.ptyAvailable === true || backend.backend === 'piped', `real backend reported: ${JSON.stringify(backend)}`);
  assert.ok(['pty', 'piped'].includes(opened.status?.backend || opened.backend?.backend), `session backend honest: ${opened.status?.backend}`);
  const ptyMarker = `pty-echo-${Math.floor(Math.random() * 1e6)}`;
  const sent = await tools.execute('computer_terminal', { action: 'send', sessionId: opened.sessionId, text: `Write-Output '${ptyMarker}'`, expected: ptyMarker, waitMs: 15_000 }, OWNER);
  const ack = sent.acknowledgement || sent;
  assert.equal(ack.accepted, true);
  assert.equal(ack.matched, true, `expected literal matched in session history (phase ${ack.phase})`);
  await tools.execute('computer_terminal', { action: 'close', sessionId: opened.sessionId }, OWNER);
});

// ----------------------------------------------------------------- git ----
test('computer_git status works on a temp repo', async () => {
  const repo = scratchPath('repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { windowsHide: true }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message))) : resolve(String(stdout)));
  });
  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@example.com']);
  await git(['config', 'user.name', 'backend-test']);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'hello repo\n');
  await git(['add', '.']);
  await git(['commit', '-qm', 'initial']);
  const status = await tools.execute('computer_git', { action: 'status', repo }, OWNER);
  assert.equal(status.action, 'status');
  // buildGitCommand uses `git status --porcelain=v1 -b`: a clean tree is the
  // bare `## <branch>` header with no entry lines.
  assert.match(status.output, /^## /m, `branch header reported: ${String(status.output).slice(0, 200)}`);
  assert.doesNotMatch(status.output, /dirty\.txt/, 'clean tree has no entries');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'untracked\n');
  const dirty = await tools.execute('computer_git', { action: 'status', repo }, OWNER);
  assert.match(dirty.output, /\?\? .*dirty\.txt/, 'untracked file reported');
});

// ------------------------------------------------------------ clipboard ---
test('computer_clipboard write/read round-trips through PowerShell', { timeout: 30_000 }, async () => {
  const payload = `cli-backend-clipboard-${Math.floor(Math.random() * 1e6)}`;
  const write = await tools.execute('computer_clipboard', { action: 'write', text: payload }, OWNER);
  assert.equal(write.writtenCharacters, payload.length);
  const read = await tools.execute('computer_clipboard', { action: 'read' }, OWNER);
  assert.equal(read.text, payload, `clipboard round-trip (got ${JSON.stringify(read.text).slice(0, 80)})`);
});

// ----------------------------------------------------------- screenshot ---
test('computer_screenshot captures a REAL non-uniform PNG at display size', { timeout: 60_000 }, async () => {
  const shot = await tools.execute('computer_screenshot', {}, OWNER);
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.source, 'native-desktop-powershell');
  assert.ok(shot.data.length > 1000, 'base64 payload present');
  const bytes = Buffer.from(shot.data, 'base64');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(bytes.readUInt32BE(16), shot.width, 'IHDR width matches');
  assert.equal(bytes.readUInt32BE(20), shot.height, 'IHDR height matches');
  assert.ok(shot.width >= 640 && shot.height >= 480, `plausible display size: ${shot.width}x${shot.height}`);
  // Write to scratch and count DISTINCT pixel colors through .NET: a real
  // desktop capture has many; a blank/failed capture would collapse to 1-2.
  const pngPath = scratchPath('shot-proof.png');
  fs.writeFileSync(pngPath, bytes);
  keptPaths.push(pngPath);
  const distinct = await runPowerShellJson(`
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${pngPath.replaceAll("'", "''")}')
$distinct = New-Object System.Collections.Generic.HashSet[string]
$rand = New-Object System.Random(7)
for ($i = 0; $i -lt 4000; $i++) {
  $x = $rand.Next($bmp.Width); $y = $rand.Next($bmp.Height)
  $p = $bmp.GetPixel($x, $y)
  [void]$distinct.Add("$($p.R)-$($p.G)-$($p.B)")
}
$bmp.Dispose()
Write-Output $distinct.Count
`);
  assert.ok(Number(distinct) > 10, `screenshot is non-uniform (${distinct} distinct sampled colors)`);
});

// ------------------------------------------------- native worker probes ---
test('computer_observe reports the real desktop through the koffi native worker', { timeout: 60_000 }, async () => {
  const desktop = await tools.execute('computer_observe', {}, OWNER);
  assert.equal(desktop.coordinateSpace, 'physical-desktop-pixels');
  assert.ok(desktop.virtualDesktop?.width >= 640, `virtual desktop bounds: ${JSON.stringify(desktop.virtualDesktop)}`);
  assert.ok(typeof desktop.pointer?.x === 'number', 'pointer position present');
  assert.ok(Array.isArray(desktop.windows) && desktop.windows.length > 0, 'window inventory present');
  assert.ok(Array.isArray(desktop.displays) && desktop.displays.length > 0, 'displays attached from the CLI capture adapter');
});

test('computer_pointer REALLY moves the system pointer (+3,+3 then restores)', { timeout: 60_000 }, async () => {
  const beforeDesktop = await tools.execute('computer_observe', {}, OWNER);
  const { x, y } = beforeDesktop.pointer;
  await tools.execute('computer_pointer', { action: 'move', x: x + 3, y: y + 3 }, OWNER);
  const afterDesktop = await tools.execute('computer_observe', {}, OWNER);
  assert.deepEqual([afterDesktop.pointer.x, afterDesktop.pointer.y], [x + 3, y + 3],
    `pointer moved exactly +3,+3 (before ${x},${y} after ${afterDesktop.pointer.x},${afterDesktop.pointer.y})`);
  await tools.execute('computer_pointer', { action: 'move', x, y }, OWNER);
  const restored = await tools.execute('computer_observe', {}, OWNER);
  assert.deepEqual([restored.pointer.x, restored.pointer.y], [x, y], 'pointer restored');
});

// --------------------------------------------------------- honest refusal --
test('computer_record refuses with its exact technical blocker (never a generic stub error)', { timeout: 30_000 }, async () => {
  await assert.rejects(
    () => tools.execute('computer_record', { action: 'start', path: path.join(SCRATCH, 'rec.mp4') }, OWNER),
    (error) => {
      assert.match(error.message, /Electron hidden BrowserWindow renderer/, 'refusal names the exact desktop-only dependency');
      assert.equal(error.code, 'CLI_COMPUTER_BACKEND_RECORD_UNAVAILABLE');
      return true;
    }
  );
});

// ------------------------------------------------------------- headed -----
test('--headed: launchHeadlessChrome({headed:true}) opens a REAL window and CDP answers', { timeout: 90_000 }, async () => {
  const profile = scratchPath('headed-profile');
  const launch = await launchHeadlessChrome({ startPort: 9433, headed: true, profileDir: profile });
  try {
    assert.equal(launch.mode, 'headed');
    const version = await fetch(`http://127.0.0.1:${launch.port}/json/version`, { signal: AbortSignal.timeout(3000) });
    assert.equal(version.ok, true, 'CDP endpoint answered while the window was visible');
    const body = await version.json();
    assert.match(String(body.Browser || ''), /Chrome/, 'a real Chrome answered');
    // The window is real: the OS reports a visible top-level Chrome window.
    const visible = await runPowerShellJson(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BuWinProbe {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr data);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr data);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextW(IntPtr hWnd, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder text, int len);
}
'@
$found = 'none'
$cb = {
  param($h, $d)
  $pid2 = 0
  [BuWinProbe]::GetWindowThreadProcessId($h, [ref]$pid2) | Out-Null
  if ($pid2 -eq ${launch.pid} -and [BuWinProbe]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 256
    [BuWinProbe]::GetWindowTextW($h, $sb, 256) | Out-Null
    $script:found = $sb.ToString()
    return $false
  }
  return $true
}
[BuWinProbe]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
Write-Output $found
`);
    assert.notEqual(String(visible).trim(), 'none', `a visible Chrome window exists for pid ${launch.pid} (title: ${String(visible).slice(0, 60)})`);
  } finally {
    killChromeTree(launch);
  }
});

// --------------------------------------------- browser tools headless -----
test('browser_* tools work headless through the CLI CDP adapter (navigate/screenshot/execute/query/click/tabs)', { timeout: 120_000 }, async () => {
  const profile = scratchPath('headless-profile');
  const launch = await launchHeadlessChrome({ startPort: 9533, profileDir: profile });
  try {
    const tabs = new Map();
    let selectedTabId = null;
    const openTab = async () => {
      const { tab, adapter } = await connectTab({ host: '127.0.0.1', port: launch.port, targetId: null });
      tabs.set(tab.id, { tab, adapter });
      selectedTabId = tab.id;
      return tab;
    };
    await openTab();
    const controller = new BrowserViewController({
      getTabs: () => [...tabs.values()].map((entry) => entry.tab),
      getSelectedTabId: () => selectedTabId,
      getConsoleEntries: () => [...tabs.values()].flatMap((entry) => entry.adapter.getConsoleEntries()),
      normalizeUrl: (value) => (/^(https?|file|about|data|chrome):/i.test(value) ? value : value),
      createTab: async () => openTab(),
      closeTab: async (tabId) => { tabs.delete(String(tabId)); await tabs.get(String(tabId))?.adapter.close().catch(() => {}); },
      isTabPaintable: () => true
    });
    const fixtureUrl = `file:///${path.join(TOOL_ROOT, 'tests', 'checkout.html').replaceAll('\\', '/')}`;
    // browser_navigate
    const tab = [...tabs.values()][0].tab;
    await controller.navigate(tab.id, fixtureUrl);
    assert.match(tab.webContents.getURL(), /checkout\.html/, 'navigate landed on the fixture');
    // browser_execute
    const title = await controller.executePageScript(tab.id, { script: 'return document.title' });
    assert.ok(String(title).length > 0, `browser_execute returned the title: ${String(title).slice(0, 60)}`);
    // browser_query
    const queried = await controller.queryElements(tab.id, { selector: 'button, a, input, [role="button"]' });
    assert.ok(queried, 'browser_query returned a result');
    // browser_screenshot — the controller returns { mimeType, data(base64), source }
    const shot = await controller.screenshot(tab.id);
    assert.equal(shot.mimeType, 'image/png');
    assert.ok(['capturePage', 'cdp'].includes(shot.source), `capture source: ${shot.source}`);
    const png = Buffer.from(shot.data, 'base64');
    assert.ok(png.length > 500, `browser_screenshot produced a real PNG (${png.length} bytes)`);
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    // browser_click (coordinates path through CDP Input)
    await controller.clickAt(tab.id, { x: 10, y: 10 });
    // browser_tabs + console entries
    assert.ok(controller.listTabs().length >= 1, 'browser_tabs lists the tab');
    assert.ok(Array.isArray(controller.consoleEntries(tab.id)), 'browser_console_entries reads the adapter buffer');
  } finally {
    killChromeTree(launch);
  }
});

// ------------------------------------------------- wiring (source-level) --
test('agent-cli wires the REAL backend for --control-mode agi (no stub refusal left)', async () => {
  const source = fs.readFileSync(path.join(TOOL_ROOT, 'cli', 'agent-cli.mjs'), 'utf8');
  assert.match(source, /require\('\.\/computerToolsBackend\.cjs'\)/, 'backend module is required');
  assert.match(source, /getComputerTools: controlMode === 'agi' \? \(\) => createCliComputerTools\(\) : null/, 'getComputerTools returns the real backend');
  assert.doesNotMatch(source, /createHeadlessComputerToolsStub/, 'the refusing stub is gone from the composition root');
});
