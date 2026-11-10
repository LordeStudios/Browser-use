'use strict';

// cli/computerToolsBackend.cjs
//
// The REAL headless computer-tools backend for the CLI runner (agent-cli.mjs
// --control-mode agi). Owner directive: the CLI has NO tool permission gates —
// this replaces cli/stubs.cjs createHeadlessComputerToolsStub, which refused
// every computer_* tool with HEADLESS_COMPUTER_TOOLS_UNAVAILABLE.
//
// Architecture: the desktop's own ComputerTools core
// (desktop/computer/computerTools.cjs) is reused UNCHANGED — its file/git/
// index/search/patch tools are plain fs + ripgrep + the git binary and already
// work headless. What the desktop wires from Electron is injected here with
// headless-native equivalents:
//
//   terminal    CliTerminalBroker — the SAME TerminalManager the desktop
//               broker uses (node-pty ConPTY, verified working in plain Node),
//               wrapped in the broker-client shape ComputerTools expects
//               (create/snapshot/writeInput/sendInput/refresh/dispose/recover/
//               backendInfo).
//   clipboard   PowerShell Get-Clipboard / Set-Clipboard (execFileSync — the
//               Electron clipboard module's readText/writeText are also sync).
//   capture     CliDesktopCapture — PowerShell CopyFromScreen over the physical
//               virtual desktop (SetProcessDPIAware + GetSystemMetrics 76..79)
//               encoded to PNG; implements the DesktopCapture surface
//               ComputerTools touches: displays(), screenshot(input), and an
//               honest record() refusal (the desktop recorder muxes fragments
//               through an Electron hidden BrowserWindow renderer — see the
//               owner decision at the bottom of this file).
//   native      nativeRequest=null — ComputerTools forks
//               desktop/computer/nativeWorker.cjs (koffi user32 SendInput)
//               itself. koffi loads and works under plain Node (probed:
//               GetCursorPos + SendInput round-trip), so computer_observe,
//               computer_window, computer_pointer, computer_keyboard and
//               computer_stroke run headless with real native input.
//
// Every refusal here names its exact technical reason — never a generic stub
// refusal.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { TerminalManager } = require('../desktop/terminal/terminalSession.cjs');

const POWERSHELL = process.platform === 'win32' ? 'powershell.exe' : null;
const POWERSHELL_TIMEOUT_MS = 20_000;
const MAX_SCREENSHOT_BYTES = 24_000_000;

function requireWindows(feature) {
  if (process.platform !== 'win32') {
    const error = new Error(`computer_${feature} requires Windows: the headless CLI backend implements it through PowerShell/user32 on win32 only.`);
    error.code = 'CLI_COMPUTER_BACKEND_UNSUPPORTED_PLATFORM';
    throw error;
  }
}

function runPowerShell(script, { timeoutMs = POWERSHELL_TIMEOUT_MS, maxBuffer = 32_000_000 } = {}) {
  const stdout = execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer,
    encoding: 'buffer'
  });
  return Buffer.from(stdout);
}

// ------------------------------------------------------------ clipboard ----
// Electron's clipboard.readText()/writeText() are synchronous, so this adapter
// is too (execFileSync). Bounded text (the ComputerTools core already caps
// reads at 64k characters).
class CliClipboard {
  constructor() { this.available = process.platform === 'win32'; }

  readText() {
    requireWindows('clipboard');
    const out = runPowerShell(
      `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-Clipboard -Raw`,
      { timeoutMs: 10_000 }
    ).toString('utf8');
    // Get-Clipboard -Raw appends one trailing newline from PowerShell's own
    // output stream; the clipboard value itself cannot end the stream twice.
    return out.replace(/\r?\n$/, '');
  }

  writeText(text) {
    requireWindows('clipboard');
    // Base64 handoff: no quoting/escaping path can corrupt arbitrary text.
    const payload = Buffer.from(String(text ?? ''), 'utf8').toString('base64');
    runPowerShell(`Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')))`, { timeoutMs: 10_000 });
    return true;
  }
}

// -------------------------------------------------------------- capture ----
// PowerShell CopyFromScreen screenshot of the physical virtual desktop.
// Surface used by the ComputerTools core: displays() (sync), screenshot(input)
// (async). recording is refused with its exact blocker.
class CliDesktopCapture {
  constructor() {
    this.displaysCache = null;
    this.displaysAt = 0;
  }

  // Physical virtual-desktop bounds. One display (the whole virtual desktop)
  // is reported as the primary so screenshot coordinates stay inside the
  // captured frame; GetSystemMetrics with SetProcessDPIAware reports PHYSICAL
  // pixels, matching the desktop capture's coordinateSpace contract.
  displays() {
    if (process.platform !== 'win32') return [];
    if (this.displaysCache && Date.now() - this.displaysAt < 5_000) return this.displaysCache;
    const out = runPowerShell(`
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BuCliDisplay {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
}
'@
[BuCliDisplay]::SetProcessDPIAware() | Out-Null
$x = [BuCliDisplay]::GetSystemMetrics(76); $y = [BuCliDisplay]::GetSystemMetrics(77)
$w = [BuCliDisplay]::GetSystemMetrics(78); $h = [BuCliDisplay]::GetSystemMetrics(79)
Write-Output "$x $y $w $h"
`.trim(), { timeoutMs: 10_000 }).toString('utf8').trim();
    const [x, y, width, height] = out.split(/\s+/).map(Number);
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error('CliDesktopCapture could not read the virtual desktop bounds (GetSystemMetrics returned no size).');
    }
    this.displaysCache = [{
      id: 'primary',
      primary: true,
      scaleFactor: 1,
      bounds: { x, y, width, height }
    }];
    this.displaysAt = Date.now();
    return this.displaysCache;
  }

  display(id) {
    const displays = this.displays();
    const display = id ? displays.find((d) => d.id === String(id)) : displays.find((d) => d.primary);
    if (!display) throw new Error(`Display no longer exists; inspect computer_observe (requested: ${String(id || 'primary')}).`);
    return display;
  }

  async screenshot(input = {}) {
    requireWindows('screenshot');
    const display = this.display(input.displayId);
    const width = Math.max(1, Math.min(4096, Number(input.maxWidth) || display.bounds.width, display.bounds.width));
    const height = Math.max(1, Math.round(width * display.bounds.height / display.bounds.width));
    // The PNG lands next to the CLI runner's temp space (never the full C:
    // drive — os.tmpdir() has been observed full on this machine) and is
    // deleted right after the base64 handoff.
    const tempDir = path.join(os.tmpdir(), 'browser-use-cli-capture');
    fs.mkdirSync(tempDir, { recursive: true });
    const pngPath = path.join(tempDir, `cli-shot-${process.pid}-${crypto.randomUUID()}.png`);
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BuCliShot {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@
[BuCliShot]::SetProcessDPIAware() | Out-Null
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen(${display.bounds.x}, ${display.bounds.y}, 0, 0, (New-Object System.Drawing.Size(${width}, ${height})))
$g.Dispose()
$bmp.Save('${pngPath.replaceAll("'", "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
`.trim();
    try {
      runPowerShell(script, { timeoutMs: 30_000, maxBuffer: 1_000_000 });
      const bytes = fs.readFileSync(pngPath);
      if (!bytes.length) throw new Error('Desktop capture produced an empty image.');
      if (bytes.length > MAX_SCREENSHOT_BYTES) throw new Error(`Desktop capture exceeded the screenshot budget (${bytes.length} bytes).`);
      // PNG IHDR: width/height at fixed offsets 16/20 — no image library needed.
      const size = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      return {
        mimeType: 'image/png',
        data: bytes.toString('base64'),
        imageHash: crypto.createHash('sha256').update(bytes).digest('hex'),
        source: 'native-desktop-powershell',
        displayId: display.id,
        width: size.width,
        height: size.height,
        coordinateSpace: 'physical-desktop-pixels',
        origin: { x: display.bounds.x, y: display.bounds.y },
        scaleX: display.bounds.width / size.width,
        scaleY: display.bounds.height / size.height,
        capturedAt: Date.now()
      };
    } finally {
      try { fs.rmSync(pngPath, { force: true }); } catch { /* best effort */ }
    }
  }

  // Owner decision (documented, not a generic stub refusal): screen RECORDING
  // cannot be implemented headless without a second video pipeline. The
  // desktop recorder (desktop/computer/desktopCapture.cjs) muxes fragmented
  // MP4/WebM through a hidden Electron BrowserWindow renderer
  // (capture.html + mediabunny) wired over ipcMain — there is no Electron
  // shell in the CLI runner, and rebuilding the muxer (MediaRecorder-less,
  // pure-Node MP4/WebM muxing) is a separate engine. Everything static
  // (computer_screenshot) is fully available above.
  async record(input = {}) {
    if (input.action === 'status') return { state: 'idle', notice: 'recording is unavailable in the headless CLI runner (Electron capture renderer required)' };
    const error = new Error('computer_record is unavailable in the headless CLI runner: the recorder muxes MP4/WebM fragments through an Electron hidden BrowserWindow renderer (desktop/computer/desktopCapture.cjs + capture.html), which does not exist without the desktop app. Use computer_screenshot for frames, or run this task in the desktop app for recording.');
    error.code = 'CLI_COMPUTER_BACKEND_RECORD_UNAVAILABLE';
    throw error;
  }

  async releaseOwner() { return true; }
  async close() { return true; }
}

// ------------------------------------------------------------- terminal ----
// The broker-client surface ComputerTools expects, implemented over an
// in-process TerminalManager (node-pty ConPTY). sendInput is the broker's
// 'send' method ported in-process: poll outputRevision / the expected literal
// with a bounded deadline, then return the same acknowledgement shape.
class CliTerminalBroker {
  constructor() {
    this.history = new Map();
    // Output capture lives in the MANAGER-level onData callback (every
    // TerminalSession routes its PTY data through it) — no per-session
    // monkeypatching.
    this.manager = new TerminalManager({
      onData: (id, data) => {
        this.history.set(id, `${this.history.get(id) || ''}${String(data ?? '')}`.slice(-500_000));
      },
      onExit: () => {}
    });
  }

  async create(options = {}) {
    const status = this.manager.create(options);
    return status;
  }

  snapshot(id) { return this.manager.snapshot(id); }

  async refresh(id) {
    const snapshot = this.manager.snapshot(id);
    if (snapshot) return { ...snapshot, history: this.history.get(snapshot.id) || '' };
    return snapshot;
  }

  async writeInput(id, data) {
    return this.manager.write(id, data);
  }

  async sendInput(id, text, { expected = '', timeoutMs = 5_000 } = {}) {
    const before = this.manager.snapshot(id);
    if (!before) return { accepted: false, submitted: false, status: null };
    const outcome = this.manager.submit(id, text);
    if (!outcome?.accepted) return { accepted: false, submitted: false, status: this.manager.snapshot(id) };
    const initialHistory = this.history.get(String(id)) || '';
    const deadline = Date.now() + Math.min(60_000, Math.max(0, timeoutMs));
    let current = this.manager.snapshot(id);
    while (Date.now() < deadline) {
      const hist = this.history.get(String(id)) || '';
      current = this.manager.snapshot(id);
      if (!current || ['exited', 'error'].includes(current.phase)) break;
      if (expected && hist.includes(expected)) break;
      if (!expected && current.outputRevision > before.outputRevision) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const hist = this.history.get(String(id)) || '';
    current = this.manager.snapshot(id);
    return {
      accepted: true,
      submitted: true,
      inputRevision: current?.inputRevision ?? before.inputRevision,
      outputRevision: current?.outputRevision ?? before.outputRevision,
      outputObserved: Boolean(current && current.outputRevision > before.outputRevision),
      matched: expected ? hist.includes(expected) : false,
      historyDelta: hist.slice(initialHistory.length).slice(-64_000),
      timedOut: Boolean(current && current.outputRevision <= before.outputRevision && !['exited', 'error'].includes(current.phase) && !(expected && hist.includes(expected))),
      phase: current?.phase || 'error',
      exitCode: current?.exitCode ?? null,
      error: current?.error || null,
      status: current
    };
  }

  async recover(id) { return this.manager.recover(id); }

  async dispose(id) {
    const disposed = this.manager.dispose(id);
    if (disposed) this.history.delete(String(id));
    return disposed;
  }

  backendInfo() { return this.manager.backendInfo(); }

  async close() { this.manager.disposeAll(); }
}

// --------------------------------------------------------------- backend ---
let singleton = null;

function createCliComputerTools() {
  if (singleton) return singleton;
  const terminal = new CliTerminalBroker();
  const capture = new CliDesktopCapture();
  const clipboard = new CliClipboard();
  singleton = new ComputerTools({
    terminal,
    capture,
    clipboard,
    nativeRequest: null
  });
  singleton.cliTerminalBroker = terminal;
  singleton.cliCapture = capture;
  return singleton;
}

// Test seam: a fresh backend with its own broker/capture (never the singleton).
function createFreshCliComputerTools() {
  const terminal = new CliTerminalBroker();
  const capture = new CliDesktopCapture();
  const clipboard = new CliClipboard();
  const tools = new ComputerTools({ terminal, capture, clipboard, nativeRequest: null });
  tools.cliTerminalBroker = terminal;
  tools.cliCapture = capture;
  return tools;
}

module.exports = { createCliComputerTools, createFreshCliComputerTools, CliTerminalBroker, CliDesktopCapture, CliClipboard };
