'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const EventEmitter = require('node:events');

function reserveLocalPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}
const protocol = require('./scrcpyProtocol.cjs');

class ScrcpyTunnel extends EventEmitter {
  constructor({ adbClient, adbPath = null, serverPath, spawnImpl = spawn, onState = null } = {}) {
    super();
    this.adb = adbClient;
    this.adbPath = adbPath || adbClient?.adbPath || 'adb';
    this.serverPath = serverPath;
    this.spawnImpl = spawnImpl;
    this.onState = typeof onState === 'function' ? onState : () => {};
    this.server = null; this.video = null; this.control = null; this.forwardPort = null;
    this.netServer = null; this.reverseName = null;
    this.serial = null; this.state = 'idle'; this.meta = null; this.codec = null;
    this.videoBuffer = Buffer.alloc(0); this.expectedFrame = null; this.scid = null;
  }

  snapshot() { return { state: this.state, serial: this.serial, meta: this.meta, codec: this.codec, forwardPort: this.forwardPort, scid: this.scid }; }
  setState(state, extra = {}) { this.state = state; this.onState({ ...this.snapshot(), ...extra }); this.emit('state', { ...this.snapshot(), ...extra }); }

  async start({ serial, maxFps = 30, maxSize = 1280, bitrate = 8_000_000, codec = 'h264' } = {}) {
    const key = String(serial || '').trim(); if (!key) throw new Error('scrcpy tunnel requires a device serial.');
    if (!this.serverPath) throw new Error('scrcpy-server is not bundled.');
    await this.stop(); this.serial = key; this.scid = crypto.randomInt(0, 0x7fffffff); this.setState('starting');
    const remote = '/data/local/tmp/browser-use-scrcpy-server';
    await this.adb.run(['-s', key, 'push', this.serverPath, remote], { timeoutMs: 60_000 });
    const socketName = `${protocol.SOCKET_PREFIX}_${this.scid.toString(16).padStart(8, '0')}`;
    // Prefer adb reverse: the Node side listens first, the server connects to
    // it, and the two accepted sockets arrive in the exact server order
    // (video, then control). This avoids the forward-side startup race that
    // can leave the video socket with only the dummy byte on mDNS transports.
    this.forwardPort = await reserveLocalPort();
    this.netServer = net.createServer();
    this.acceptedSocketQueue = [];
    this.netServer.on('connection', (socket) => { this.acceptedSocketQueue.push(socket); });
    await new Promise((resolve, reject) => { this.netServer.once('error', reject); this.netServer.listen(this.forwardPort, '127.0.0.1', resolve); });
    this.reverseName = `localabstract:${socketName}`;
    await this.adb.run(['-s', key, 'reverse', this.reverseName, `tcp:${this.forwardPort}`]);
    const args = ['-s', key, 'shell', `CLASSPATH=${remote}`, 'app_process', '/', 'com.genymobile.scrcpy.Server', ...protocol.buildServerArgs({ scid: this.scid, maxSize, maxFps, bitrate, codec, tunnelForward: false })];
    this.server = this.spawnImpl(this.adbPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let serverReadyResolve;
    const serverReady = new Promise((resolve) => { serverReadyResolve = resolve; });
    const readyTimer = setTimeout(serverReadyResolve, 8_000);
    const handleServerLog = (data) => {
      const text = String(data);
      this.emit('log', text);
      if (/Device:\s|Server connected|Using video encoder/i.test(text)) serverReadyResolve();
    };
    this.server.stdout?.on('data', handleServerLog);
    this.server.stderr?.on('data', handleServerLog);
    this.server.on('error', (error) => this.fail(error));
    this.server.on('exit', (code, signal) => { serverReadyResolve(); if (!['stopping', 'stopped'].includes(this.state)) this.fail(new Error(`scrcpy server exited (${code ?? signal ?? 'unknown'})`)); });
    await serverReady;
    clearTimeout(readyTimer);
    // With adb reverse the client-side listener accepts the server's sockets
    // directly: video first, then control. No dummy byte is sent in reverse
    // mode; it is a forward-tunnel readiness mechanism only.
    this.video = await this.waitAcceptedSocket();
    this.control = await this.waitAcceptedSocket();
    this.netServer.close(); this.netServer = null;
    await this.readVideoHeaders();
    this.emit('meta', this.meta);
    // send_dummy_byte is consumed by the first/video socket; control has none.
    this.control.on('data', () => {}); // keep the duplex control socket drained
    this.setState('streaming');
    this.video.on('data', (data) => this.acceptVideoData(data));
    this.video.on('error', (error) => this.fail(error));
    this.video.on('close', () => { if (!['stopping', 'stopped'].includes(this.state)) this.fail(new Error('scrcpy video socket closed.')); });
    return this.snapshot();
  }

  waitAcceptedSocket() {
    if (this.acceptedSocketQueue?.length) return Promise.resolve(this.acceptedSocketQueue.shift());
    this.acceptedSocketQueue = this.acceptedSocketQueue || [];
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('scrcpy reverse socket timed out.')), 15_000);
      const poll = () => {
        if (this.acceptedSocketQueue.length) { clearTimeout(timer); resolve(this.acceptedSocketQueue.shift()); }
        else setTimeout(poll, 10);
      };
      poll();
    });
  }

  async connectSocket() {
    const deadline = Date.now() + 15_000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const socket = await new Promise((resolve, reject) => {
          const candidate = net.connect(this.forwardPort, '127.0.0.1');
          const timer = setTimeout(() => { candidate.destroy(); reject(new Error('socket timeout')); }, 1_500);
          candidate.once('connect', () => { clearTimeout(timer); resolve(candidate); });
          candidate.once('error', (error) => { clearTimeout(timer); reject(error); });
        });
        return socket;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw new Error(`scrcpy tunnel socket timed out: ${lastError?.message || 'server did not accept'}`);
  }

  readExact(socket, length) {
    return new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const onData = (chunk) => { buffer = Buffer.concat([buffer, chunk]); if (buffer.length >= length) { socket.removeListener('data', onData); const value = buffer.subarray(0, length); const rest = buffer.subarray(length); if (rest.length) socket.unshift(rest); resolve(value); } };
      socket.on('data', onData); socket.once('error', reject); socket.once('close', () => reject(new Error('scrcpy socket closed while reading.')));
    });
  }

  async readVideoHeaders() {
    const device = await this.readExact(this.video, protocol.DEVICE_NAME_BYTES); this.meta = protocol.parseDeviceMeta(device);
    const codecId = (await this.readExact(this.video, 4)).readUInt32BE(0); this.codec = protocol.parseCodecId(codecId);
    const sessionMeta = await this.readExact(this.video, 12); this.meta = { ...this.meta, ...protocol.parseStreamMeta(sessionMeta), codec: this.codec };
  }

  acceptVideoData(data) {
    this.videoBuffer = Buffer.concat([this.videoBuffer, Buffer.from(data)]);
    while (this.videoBuffer.length >= 12) {
      const frameMeta = protocol.parseFrameMeta(this.videoBuffer);
      if (frameMeta.size > 64 * 1024 * 1024) return this.fail(new Error('scrcpy frame exceeds the 64MB safety cap.'));
      if (this.videoBuffer.length < 12 + frameMeta.size) return;
      const payload = this.videoBuffer.subarray(12, 12 + frameMeta.size);
      this.videoBuffer = this.videoBuffer.subarray(12 + frameMeta.size);
      if (frameMeta.config) {
        const data = this.codec?.name === 'h264' ? protocol.avcDecoderConfigFromAnnexB(payload) : payload;
        this.emit('codec-config', { ...frameMeta, data });
      } else {
        const data = this.codec?.name === 'h264' ? protocol.annexBToLengthPrefixed(payload) : payload;
        this.emit('frame', { pts: frameMeta.pts, keyFrame: frameMeta.keyFrame, data });
      }
    }
  }

  send(buffer) { if (!this.control || !this.control.writable) throw new Error('scrcpy control channel is unavailable.'); this.control.write(buffer); }
  sendTouch(input) { this.send(protocol.encodeTouch(input)); }
  sendKey(input) { this.send(protocol.encodeKey(input)); }
  sendText(text) { this.send(protocol.encodeText(text)); }

  async stop() {
    this.setState('stopping');
    for (const socket of [this.video, this.control, ...(this.acceptedSocketQueue || [])]) { try { socket?.destroy(); } catch {} }
    this.acceptedSocketQueue = [];
    try { this.netServer?.close(); } catch {}
    this.netServer = null;
    this.video = null; this.control = null;
    try { this.server?.kill(); } catch {}
    this.server = null;
    // adb shell can leave the remote app_process/cleanup child alive after the
    // host adb process is killed. Remove only scrcpy-owned processes for this
    // selected device so a failed start cannot poison the next one.
    if (this.serial) await this.adb.shell(this.serial, ['pkill', '-f', 'com.genymobile.scrcpy']).catch(() => {});
    if (this.reverseName && this.serial) await this.adb.run(['-s', this.serial, 'reverse', '--remove', this.reverseName]).catch(() => {});
    if (this.forwardPort && this.serial && !this.reverseName) await this.adb.run(['-s', this.serial, 'forward', '--remove', `tcp:${this.forwardPort}`]).catch(() => {});
    this.reverseName = null; this.forwardPort = null; this.setState('stopped'); return this.snapshot();
  }

  fail(error) { this.emit('error', error); this.setState('failed', { lastError: String(error?.message || error).slice(0, 500) }); }
}

module.exports = { ScrcpyTunnel };
