'use strict';

const { execFile } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 30_000;

function safeToken(value, name, { allowColon = false, allowWhitespace = false, allowOption = false } = {}) {
  const token = String(value || '').trim();
  if (!token || (!allowOption && token.startsWith('-')) || /[\u0000\r\n]/.test(token) || (!allowWhitespace && !allowColon && /[\s]/.test(token))) {
    throw new Error(`${name} must be a non-empty safe token.`);
  }
  return token;
}

function parseDeviceLine(line) {
  const text = String(line || '').trim();
  if (!text || text.startsWith('List of devices attached')) return null;
  const match = text.match(/^(\S+)\s+(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  const serial = match[1];
  const state = match[2];
  const details = {};
  for (const token of String(match[3] || '').split(/\s+/).filter(Boolean)) {
    const index = token.indexOf(':');
    if (index > 0) details[token.slice(0, index)] = token.slice(index + 1);
  }
  return {
    serial,
    state,
    model: details.model || null,
    product: details.product || null,
    device: details.device || null,
    transportId: details.transport_id || null,
    details
  };
}

function parseAdbCommandString(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  const tokens = [];
  let token = ''; let quote = null; let escaped = false;
  for (const char of text) {
    if (escaped) { token += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else token += char; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (/\s/.test(char)) { if (token) { tokens.push(token); token = ''; } continue; }
    token += char;
  }
  if (escaped) token += '\\';
  if (quote) throw new Error('ADB command string has an unclosed quote. Pass args[] instead.');
  if (token) tokens.push(token);
  return tokens;
}

class AdbClient {
  constructor({ adbPath = 'adb', execFileImpl = execFile, defaultTimeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
    this.adbPath = adbPath;
    this.execFile = execFileImpl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.env = env;
  }

  async run(args = [], { timeoutMs = this.defaultTimeoutMs, binary = false } = {}) {
    if (!Array.isArray(args)) throw new Error('ADB arguments must be an array.');
    const argv = args.map((arg) => safeToken(arg, 'ADB argument', { allowColon: true, allowWhitespace: true, allowOption: true }));
    return new Promise((resolve, reject) => {
      this.execFile(this.adbPath, argv, {
        windowsHide: true,
        timeout: Math.max(1_000, Number(timeoutMs) || this.defaultTimeoutMs),
        maxBuffer: 32 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        env: this.env
      }, (error, stdout, stderr) => {
        const out = binary ? Buffer.from(stdout || '') : String(stdout || '');
        const err = String(stderr || '');
        const result = { ok: !error, argv, stdout: out, stderr: err, exitCode: error ? (error.code ?? null) : 0 };
        if (error) {
          const message = error.code === 'ENOENT'
            ? `Integrated ADB runtime was not found at "${this.adbPath}". Reinstall Browser-use or choose an explicit Android SDK path in Android device settings.`
            : (err.trim() || error.message || `adb exited with ${String(error.code || 'unknown')}`);
          const wrapped = new Error(message);
          Object.assign(wrapped, result);
          reject(wrapped);
          return;
        }
        resolve(result);
      });
    });
  }

  async devices() {
    const result = await this.run(['devices', '-l']);
    return String(result.stdout).split(/\r?\n/).map(parseDeviceLine).filter(Boolean);
  }

  async pair(address, pairingCode) {
    const endpoint = safeToken(address, 'pair address', { allowColon: true });
    const code = safeToken(pairingCode, 'pairing code');
    return this.run(['pair', endpoint, code]);
  }

  async connect(address) {
    const endpoint = safeToken(address, 'connect address', { allowColon: true });
    return this.run(['connect', endpoint]);
  }

  async disconnect(serial) {
    return this.run(['disconnect', safeToken(serial, 'device serial', { allowColon: true })]);
  }

  async shell(serial, commandArgs = [], options = {}) {
    const device = safeToken(serial, 'device serial', { allowColon: true });
    if (!Array.isArray(commandArgs) || !commandArgs.length) throw new Error('adb shell requires an argument array.');
    return this.run(['-s', device, 'shell', ...commandArgs.map((arg) => safeToken(arg, 'shell argument', { allowColon: true, allowWhitespace: true, allowOption: true }))], options);
  }

  async execOut(serial, commandArgs = [], options = {}) {
    const device = safeToken(serial, 'device serial', { allowColon: true });
    if (!Array.isArray(commandArgs) || !commandArgs.length) throw new Error('adb exec-out requires an argument array.');
    return this.run(['-s', device, 'exec-out', ...commandArgs.map((arg) => safeToken(arg, 'exec-out argument', { allowColon: true, allowWhitespace: true, allowOption: true }))], { ...options, binary: true });
  }

  async command({ serial = '', args = [], timeoutMs } = {}) {
    args = Array.isArray(args) ? args : parseAdbCommandString(args);
    if (!args.length) throw new Error('android_adb requires args[] or a non-empty command string.');
    const prefix = serial ? ['-s', safeToken(serial, 'device serial', { allowColon: true })] : [];
    return this.run([...prefix, ...args], { timeoutMs });
  }
}

module.exports = { AdbClient, parseDeviceLine, parseAdbCommandString, safeToken, DEFAULT_TIMEOUT_MS };
