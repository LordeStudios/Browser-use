'use strict';

const net = require('node:net');
const EventEmitter = require('node:events');
const { AdbClient } = require('./adbClient.cjs');
const { ScrcpySession } = require('./scrcpySession.cjs');
const { ScrcpyTunnel } = require('./scrcpyTunnel.cjs');
const { AndroidInputPolicy } = require('./androidInputPolicy.cjs');
const { mergeDeviceRecord, normalizeDeviceRecord } = require('./androidDevicePersistence.cjs');

function transportFor(serial) { return String(serial || '').includes(':') ? 'wireless' : 'usb'; }

class AndroidDeviceManager extends EventEmitter {
  constructor({ adbPath = 'adb', scrcpyPath = 'scrcpy', serverPath = '', streamRenderer = 'tab', records = [], execFileImpl, spawnImpl, onChange = null, onConsole = null, onStreamWindow = null, onStreamTab = null, onStreamTabClose = null } = {}) {
    super();
    this.adb = new AdbClient({ adbPath, execFileImpl });
    this.scrcpyPath = scrcpyPath;
    this.serverPath = serverPath;
    this.streamRenderer = streamRenderer === 'native' ? 'native' : 'tab';
    this.records = (Array.isArray(records) ? records : []).map(normalizeDeviceRecord);
    this.selectedSerial = null;
    this.inputPolicy = new AndroidInputPolicy();
    this.sessions = new Map();
    this.onChange = typeof onChange === 'function' ? onChange : () => {};
    this.onConsole = typeof onConsole === 'function' ? onConsole : () => {};
    this.onStreamWindow = typeof onStreamWindow === 'function' ? onStreamWindow : () => {};
    this.onStreamTab = typeof onStreamTab === 'function' ? onStreamTab : async () => null;
    this.onStreamTabClose = typeof onStreamTabClose === 'function' ? onStreamTabClose : async () => {};
    this.streamTabs = new Map();
    this.refreshTimer = null;
  }

  snapshot() {
    return { selectedSerial: this.selectedSerial, devices: this.records.map((record) => ({ ...record, session: this.sessions.get(record.serial)?.snapshot() || null, programmaticTaps: this.inputPolicy.isProgrammatic(record.serial) })) };
  }

  emitState(event, payload = {}) {
    const value = { event, ...payload, state: this.snapshot() };
    this.emit('state', value); this.onChange(value);
    return value;
  }

  remember(record) {
    this.records = mergeDeviceRecord(this.records, record);
    return this.records.find((item) => item.serial === String(record.serial));
  }

  async refresh({ advisory = true } = {}) {
    const before = JSON.stringify(this.records);
    let connected;
    try { connected = await this.adb.devices(); }
    catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      this.emitState('error', { error: message });
      return { ...this.snapshot(), error: message };
    }
    const seen = new Set(connected.map((device) => device.serial));
    for (const device of connected) {
      const record = this.remember({ ...device, serial: device.serial, transport: transportFor(device.serial), lastSeenAt: Date.now(), lastState: device.state, address: device.serial.includes(':') ? device.serial : '' });
      record.model = device.model || record.model; record.product = device.product || record.product;
    }
    for (const record of this.records) {
      if (seen.has(record.serial)) { record.lastState = 'device'; record.lastSeenAt = Date.now(); continue; }
      if (record.lastState === 'device' || record.lastState === 'online' || record.lastState === 'reconnect-advisory') {
        record.lastState = 'disconnected';
        if (advisory && record.transport === 'wireless' && record.address) {
          const reachable = await this.probeEndpoint(record.address);
          if (reachable) { record.lastState = 'reconnect-advisory'; this.emitState('reconnect-advisory', { serial: record.serial, address: record.address }); }
        }
      }
    }
    this.emitState('refresh', { connected: connected.length, persist: before !== JSON.stringify(this.records) });
    return this.snapshot();
  }

  probeEndpoint(address, timeoutMs = 500) {
    const text = String(address || ''); const index = text.lastIndexOf(':');
    const host = index > 0 ? text.slice(0, index) : text; const port = index > 0 ? Number(text.slice(index + 1)) : 5555;
    return new Promise((resolve) => {
      const socket = net.connect({ host, port, timeout: timeoutMs }, () => { socket.destroy(); resolve(true); });
      socket.on('timeout', () => { socket.destroy(); resolve(false); }); socket.on('error', () => resolve(false));
    });
  }

  async pair({ address, pairingCode, label = '' } = {}) {
    const result = await this.adb.pair(address, pairingCode);
    const serial = String(address).trim();
    this.remember({ serial, address: serial, label: label || serial, transport: 'wireless', pairedAt: Date.now(), lastState: 'paired' });
    await this.refresh({ advisory: false });
    this.emitState('paired', { serial, address, output: result.stdout });
    return this.snapshot();
  }

  async connect({ address, label = '' } = {}) {
    const result = await this.adb.connect(address);
    const serial = String(address).trim();
    this.remember({ serial, address: serial, label: label || serial, transport: 'wireless', lastState: 'online', lastSeenAt: Date.now() });
    await this.refresh({ advisory: false });
    this.selectedSerial = serial;
    this.emitState('connected', { serial, address, output: result.stdout });
    return this.snapshot();
  }

  async disconnect(serial = this.selectedSerial) {
    const key = String(serial || '').trim(); if (!key) throw new Error('A device serial is required.');
    await this.sessions.get(key)?.stop(); this.sessions.delete(key); await this.adb.disconnect(key).catch(() => {});
    const record = this.records.find((item) => item.serial === key); if (record) record.lastState = 'disconnected';
    if (this.selectedSerial === key) this.selectedSerial = null;
    this.emitState('disconnected', { serial: key }); return this.snapshot();
  }

  async remove(serial) {
    const key = String(serial || '').trim(); if (!key) throw new Error('A device serial is required.');
    await this.disconnect(key).catch(() => {}); this.records = this.records.filter((item) => item.serial !== key); this.inputPolicy.clear(key); this.emitState('removed', { serial: key }); return this.snapshot();
  }

  select(serial) {
    const key = String(serial || '').trim(); if (!this.records.some((item) => item.serial === key)) throw new Error(`Unknown Android device: ${key}`);
    this.selectedSerial = key; this.emitState('selected', { serial: key }); return this.snapshot();
  }

  setProgrammaticTaps(serial, enabled) {
    const normalized = enabled === true || enabled === 'true' || enabled === 1 || enabled === '1';
    const result = this.inputPolicy.setProgrammatic(serial || this.selectedSerial, normalized);
    const record = this.records.find((item) => item.serial === result.serial);
    if (record) record.programmaticTaps = result.programmaticTaps;
    this.emitState('input-policy', result);
    return result;
  }

  async handlePointer({ serial = this.selectedSerial, action = 'click', x, y, endX, endY, displayWidth, displayHeight, deviceWidth, deviceHeight } = {}) {
    const key = String(serial || '').trim();
    if (!this.inputPolicy.isProgrammatic(key)) return { routed: 'native-scrcpy', serial: key, action };
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('Programmatic Android input requires finite x/y.');
    let resolvedWidth = Number(deviceWidth) || 0;
    let resolvedHeight = Number(deviceHeight) || 0;
    if (!resolvedWidth || !resolvedHeight) {
      try {
        const sizeResult = await this.adb.shell(key, ['wm', 'size']);
        const match = String(sizeResult.stdout || '').match(/Physical size:\s*(\d+)x(\d+)/i);
        if (match) { resolvedWidth = Number(match[1]); resolvedHeight = Number(match[2]); }
      } catch {}
    }
    const size = { width: resolvedWidth || 1080, height: resolvedHeight || 1920 };
    const { displayToDevicePoint } = require('./androidInputPolicy.cjs');
    const point = displayToDevicePoint({ x, y, displayWidth, displayHeight, deviceWidth: size.width, deviceHeight: size.height });
    const endPoint = displayToDevicePoint({ x: Number(endX) || x, y: Number(endY) || y, displayWidth, displayHeight, deviceWidth: size.width, deviceHeight: size.height });
    const command = action === 'drag' ? ['input', 'swipe', String(point.x), String(point.y), String(endPoint.x), String(endPoint.y), '300'] : ['input', 'tap', String(point.x), String(point.y)];
    const result = await this.adb.shell(key, command);
    return { routed: 'adb', serial: key, action, point, result: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode } };
  }

  async command({ serial = this.selectedSerial, args = [], command = '', timeoutMs } = {}) {
    const key = String(serial || '').trim();
    const commandArgs = Array.isArray(args) ? (args.length ? args : command) : (args || command);
    const result = await this.adb.command({ serial: key, args: commandArgs, timeoutMs });
    this.onConsole({ kind: 'android', level: 'info', message: `adb -s ${key} ${(Array.isArray(args) ? args : String(args)).toString().replace(/\r?\n/g, ' ')}`, result });
    return { commandId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, serial: key || null, ...result, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
  }

  async batchCommand({ serial = this.selectedSerial, commands = [], stopOnError = true, totalTimeoutMs = 180_000, signal } = {}) {
    if (!Array.isArray(commands) || !commands.length) throw new Error('android_adb batch requires commands[].');
    if (commands.length > 32) throw new Error('android_adb batch accepts at most 32 commands; split the batch explicitly.');
    const startedAt = Date.now(); const results = []; let stopReason = null;
    for (let index = 0; index < commands.length; index += 1) {
      const command = commands[index];
      const remaining = Math.max(0, Number(totalTimeoutMs) - (Date.now() - startedAt));
      if (signal?.aborted || remaining <= 0) { stopReason = signal?.aborted ? 'cancelled' : 'batch timeout'; break; }
      try {
        const result = await this.command({ serial: command?.serial || serial, args: command?.args, command: command?.command, timeoutMs: Math.min(Number(command?.timeoutMs) || 30_000, remaining) });
        results.push({ ok: result.ok !== false && result.exitCode === 0, ...result, index });
        if ((result.ok === false || result.exitCode !== 0) && stopOnError) { stopReason = 'command failed'; break; }
      } catch (error) {
        const failure = { ok: false, index, error: String(error?.message || error), exitCode: error?.exitCode ?? null, stderr: String(error?.stderr || '') };
        results.push(failure);
        if (stopOnError) { stopReason = 'command failed'; break; }
      }
    }
    const unexecuted = commands.slice(results.length).map((command, tailIndex) => ({ index: results.length + tailIndex, serial: command?.serial || serial, args: command?.args ?? command?.command ?? null }));
    return { ok: results.length === commands.length && results.every((result) => result.ok), serial: serial || null, count: results.length, requested: commands.length, results, unexecuted, ...(stopReason ? { stopReason } : {}) };
  }

  async startStream({ serial = this.selectedSerial, maxFps = 30, maxSize = 1280, bitrate = '8M', codec = 'h264' } = {}) {
    const key = String(serial || '').trim(); if (!key) throw new Error('Select an Android device first.');
    if (this.sessions.has(key)) await this.stopStream(key);
    if (this.streamRenderer === 'tab') {
      const tab = await this.onStreamTab({ serial: key, title: `Android ${key}` });
      if (!tab?.tabId) throw new Error('Could not create the Android stream tab.');
      const tunnel = new ScrcpyTunnel({ adbClient: this.adb, adbPath: this.adb.adbPath, serverPath: this.serverPath, spawnImpl: this.spawnImpl, onState: (state) => this.emitState('stream', { serial: key, session: state }) });
      tunnel.on('frame', (frame) => this.emitState('stream-frame', { serial: key, tabId: tab.tabId, frame }));
      tunnel.on('codec-config', (config) => this.emitState('stream-codec-config', { serial: key, tabId: tab.tabId, config }));
      tunnel.on('error', (error) => this.emitState('stream-error', { serial: key, tabId: tab.tabId, error: String(error?.message || error) }));
      this.sessions.set(key, tunnel); this.streamTabs.set(key, tab);
      tunnel.on('meta', (meta) => this.emitState('stream-meta', { serial: key, tabId: tab.tabId, meta }));
      try {
        const result = await tunnel.start({ serial: key, maxFps, maxSize, bitrate, codec });
        const final = { ...result, tabId: tab.tabId, url: tab.url };
        this.emitState('stream-started', { serial: key, session: final }); return final;
      } catch (error) {
        await tunnel.stop().catch(() => {});
        this.sessions.delete(key); this.streamTabs.delete(key); await this.onStreamTabClose(tab).catch(() => {}); throw error;
      }
    }
    const tab = await this.onStreamTab({ serial: key, title: `Android ${key}` });
    if (!tab?.tabId) throw new Error('Could not create the Android compatibility stream tab.');
    const session = this.sessions.get(key) || new ScrcpySession({ scrcpyPath: this.scrcpyPath, onState: (state) => this.emitState('stream', { serial: key, session: state }) });
    this.sessions.set(key, session); this.streamTabs.set(key, tab);
    const result = await session.start({ serial: key, maxFps, maxSize, bitrate, codec });
    const windowResult = await Promise.resolve(this.onStreamWindow({ serial: key, title: result.title, session: result, tab })).catch((error) => ({ embedded: false, reason: error.message }));
    const final = { ...result, window: windowResult, tabId: tab.tabId, url: tab.url };
    this.emitState('stream-started', { serial: key, session: final }); return final;
  }

  async stopStream(serial = this.selectedSerial, { closeTab = true } = {}) {
    const key = String(serial || '').trim(); const session = this.sessions.get(key); if (!session) return { state: 'idle', serial: key };
    const result = await session.stop(); this.sessions.delete(key); this.emitState('stream-stopped', { serial: key, session: result });
    const tab = this.streamTabs.get(key); this.streamTabs.delete(key);
    if (closeTab && tab) await this.onStreamTabClose(tab).catch(() => {});
    return result;
  }

  startPolling(intervalMs = 5_000) { this.stopPolling(); this.refreshTimer = setInterval(() => this.refresh().catch((error) => this.onConsole({ kind: 'android', level: 'warn', message: error.message })), Math.max(1_000, Number(intervalMs) || 5_000)); return this.refresh(); }
  stopPolling() { if (this.refreshTimer) clearInterval(this.refreshTimer); this.refreshTimer = null; }
  async close() { this.stopPolling(); for (const session of this.sessions.values()) await session.stop().catch(() => {}); this.sessions.clear(); }
}

module.exports = { AndroidDeviceManager, transportFor };
