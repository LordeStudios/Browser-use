'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');

class ScrcpySession {
  constructor({ scrcpyPath = 'scrcpy', spawnImpl = spawn, onState = null } = {}) {
    this.scrcpyPath = scrcpyPath;
    this.spawnImpl = spawnImpl;
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.process = null;
    this.state = 'idle';
    this.serial = null;
    this.title = null;
    this.lastError = null;
    this.startedAt = null;
  }

  snapshot() {
    return { state: this.state, serial: this.serial, title: this.title, pid: this.process?.pid || null, startedAt: this.startedAt, lastError: this.lastError };
  }

  async start({ serial, title = null, maxFps = 30, maxSize = 1920, bitrate = '8M', codec = null, audio = false, extraArgs = [] } = {}) {
    if (this.process) await this.stop();
    const device = String(serial || '').trim();
    if (!device) throw new Error('scrcpy requires a device serial.');
    const sessionTitle = String(title || `Browser-use Android ${device} ${crypto.randomUUID().slice(0, 8)}`).slice(0, 180);
    const args = ['--serial', device, '--window-title', sessionTitle, '--max-fps', String(Math.max(5, Math.min(60, Number(maxFps) || 30))), '--max-size', String(Math.max(320, Math.min(4096, Number(maxSize) || 1920))), '--video-bit-rate', String(bitrate || '8M')];
    if (!audio) args.push('--no-audio');
    if (codec) args.push('--video-codec', String(codec));
    for (const arg of (Array.isArray(extraArgs) ? extraArgs : [])) args.push(String(arg));
    const child = this.spawnImpl(this.scrcpyPath, args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    this.process = child; this.serial = device; this.title = sessionTitle; this.state = 'starting'; this.lastError = null; this.startedAt = Date.now(); this.onState(this.snapshot());
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-4_000); });
    child.on('error', (error) => {
      this.lastError = error?.code === 'ENOENT'
        ? `Integrated scrcpy runtime was not found at "${this.scrcpyPath}". Reinstall Browser-use or choose an explicit scrcpy path in Android device settings.`
        : String(error?.message || error);
      this.state = 'failed'; this.onState(this.snapshot());
    });
    child.on('exit', (code, signal) => {
      if (this.process !== child) return;
      if (this.state !== 'stopping') this.lastError = code === 0 ? null : (stderr.trim() || `scrcpy exited with ${code ?? signal ?? 'unknown'}`);
      this.state = this.state === 'stopping' || code === 0 ? 'stopped' : 'failed';
      this.process = null; this.onState(this.snapshot());
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.state === 'starting') { this.state = 'running'; this.onState(this.snapshot()); } resolve(); }, 500);
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    if (this.state === 'starting') { this.state = 'running'; this.onState(this.snapshot()); }
    return this.snapshot();
  }

  async stop() {
    const child = this.process;
    if (!child) return this.snapshot();
    this.state = 'stopping'; this.onState(this.snapshot());
    child.kill();
    await new Promise((resolve) => { const timer = setTimeout(resolve, 5_000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
    if (this.process === child) { this.process = null; this.state = 'stopped'; this.onState(this.snapshot()); }
    return this.snapshot();
  }
}

module.exports = { ScrcpySession };
