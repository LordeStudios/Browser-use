'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class DesktopCapture {
  constructor({ app, BrowserWindow, desktopCapturer, screen, ipcMain, session, getBrowserWindow = () => null, getTab = () => null, onStateChange = null }) {
    Object.assign(this, { app, BrowserWindow, desktopCapturer, screen, ipcMain, session, getBrowserWindow, getTab, onStateChange });
    this.window = null;
    this.current = null;
    this.last = null;
    // The capture renderer muxes fragmented MP4/WebM with mediabunny and
    // streams every completed fragment here; appending them directly keeps
    // the output file playable at all times, even after a crash.
    this.chunk = async (event, id, bytes) => {
      const record = this.requireSender(event, id);
      if (!ArrayBuffer.isView(bytes) && !(bytes instanceof ArrayBuffer)) throw new Error('Invalid recording chunk.');
      const data = Buffer.from(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes);
      // The muxer may batch several fragments into one write; at 4K the
      // realtime encoder can overshoot the target bitrate, so this guard only
      // rejects absurd payloads, not large legitimate fragments.
      if (data.length > 256_000_000) throw new Error('Recording chunk exceeds the streaming buffer.');
      await record.file.write(data);
      record.bytes += data.length;
      return true;
    };
    this.finished = async (event, id, error) => {
      const record = this.requireSender(event, id);
      await this.finish(record, error ? String(error).slice(0, 500) : null);
      return true;
    };
    ipcMain.handle('browser-use:computer-record-chunk', this.chunk);
    ipcMain.handle('browser-use:computer-record-finished', this.finished);
  }

  displays() {
    return this.screen.getAllDisplays().map(display => {
      const origin = process.platform === 'win32' ? this.screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y }) : display.bounds;
      return { id: String(display.id), primary: display.id === this.screen.getPrimaryDisplay().id, scaleFactor: display.scaleFactor,
        bounds: { x: origin.x, y: origin.y, width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) } };
    });
  }

  display(id) {
    const displays = this.displays(), display = id ? displays.find(d => d.id === String(id)) : displays.find(d => d.primary);
    if (!display) throw new Error('Display no longer exists; inspect computer_observe.');
    return display;
  }

  async source(display, thumbnailSize) {
    const sources = await this.desktopCapturer.getSources({ types: ['screen'], thumbnailSize, fetchWindowIcons: false });
    const source = sources.find(s => s.display_id === display.id);
    if (!source) throw new Error('The selected display cannot be captured.');
    return source;
  }


  async windowSource() {
    const browserWindow = this.getBrowserWindow();
    if (!browserWindow || browserWindow.isDestroyed()) throw new Error('Browser-use window is unavailable.');
    // Match the source by native window handle: getMediaSourceId() returns a
    // getUserMedia-scoped id that never appears in desktopCapturer results,
    // while a source id is "window:<hwnd>:<index>" with a varying index.
    const handle = browserWindow.getNativeWindowHandle();
    if (process.platform !== 'win32' || handle.length < 8) throw new Error('Window capture is only supported on Windows.');
    const hwnd = handle.readBigUInt64LE(0).toString();
    const sources = await this.desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 3840, height: 2160 }, fetchWindowIcons: false });
    const source = sources.find(item => item.id.startsWith(`window:${hwnd}:`));
    if (!source) throw new Error('The Browser-use window cannot be captured.');
    return source;
  }

  async screenshot(input = {}) {
    const display = this.display(input.displayId), width = Math.max(1, Math.min(4096, input.maxWidth || display.bounds.width, display.bounds.width));
    const height = Math.max(1, Math.round(width * display.bounds.height / display.bounds.width));
    const source = await this.source(display, { width, height });
    if (source.thumbnail.isEmpty()) throw new Error('Desktop capture returned an empty image.');
    const size = source.thumbnail.getSize(), bytes = source.thumbnail.toPNG();
    return { mimeType: 'image/png', data: bytes.toString('base64'), imageHash: crypto.createHash('sha256').update(bytes).digest('hex'), source: 'native-desktop', displayId: display.id,
      width: size.width, height: size.height, coordinateSpace: 'physical-desktop-pixels', origin: { x: display.bounds.x, y: display.bounds.y },
      scaleX: display.bounds.width / size.width, scaleY: display.bounds.height / size.height, capturedAt: Date.now() };
  }

  requireSender(event, id) {
    if (!this.current || event.sender !== this.window?.webContents || this.current.id !== id) throw new Error('Unknown recording sender or recording ID.');
    return this.current;
  }

  // Resolves the tab's live frame for tab capture; null when the tab cannot
  // be captured (closed, destroyed, or detached from the frame tree).
  tabFrame(tabId) {
    const tab = this.getTab(String(tabId || ''));
    const webContents = tab?.webContents;
    if (!tab || !webContents || webContents.isDestroyed?.()) return null;
    const frame = webContents.mainFrame;
    return frame && !frame.detached ? frame : null;
  }

  async ensureWindow() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const captureSession = this.session.fromPartition('browser-use-computer-capture');
    captureSession.setDisplayMediaRequestHandler(async (request, callback) => {
      const record = this.current;
      if (!record || request.frame !== this.window?.webContents.mainFrame || record.state !== 'starting') { callback({}); return; }
      try {
        let streams;
        if (record.mode === 'tab') {
          // WebFrameMain capture records exactly the selected tab, even when
          // it is not the visible one; frame audio keeps the tab audible
          // while recorded (enableLocalEcho).
          const frame = this.tabFrame(record.tabId);
          if (this.current !== record || record.state !== 'starting') { callback({}); return; }
          if (!frame) { callback({}); return; }
          streams = record.audio ? { video: frame, audio: frame, enableLocalEcho: true } : { video: frame };
        } else {
          const source = record.mode === 'window' ? await this.windowSource() : await this.source(this.display(record.displayId), { width: 0, height: 0 });
          if (this.current !== record || record.state !== 'starting') { callback({}); return; }
          // Windows loopback captures system audio alongside the video.
          streams = record.audio ? { video: source, audio: 'loopback' } : { video: source };
        }
        if (this.current !== record || record.state !== 'starting') { callback({}); return; }
        callback(streams);
      } catch { callback({}); }
    }, { useSystemPicker: false });
    this.window = new this.BrowserWindow({ show: false, width: 320, height: 240, skipTaskbar: true,
      webPreferences: { session: captureSession, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload: path.join(__dirname, 'capturePreload.cjs') } });
    this.window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.webContents.on('render-process-gone', () => { if (this.current) void this.finish(this.current, 'Recording renderer exited.'); });
    await this.window.loadFile(path.join(__dirname, 'capture.html'));
    return this.window;
  }

  snapshot(record) {
    if (!record) return { state: 'idle' };
    return { id: record.id, state: record.state, path: record.path, mode: record.mode, displayId: record.displayId, tabId: record.tabId || null, tabTitle: record.tabTitle || null,
      audio: record.audio ? (record.audioActive ? 'on' : 'unavailable') : 'off', bytes: record.bytes,
      durationMs: Math.max(0, (record.endedAt || Date.now()) - record.startedAt), fps: record.fps, width: record.width,
      ...(record.error ? { error: record.error } : {}) };
  }

  async record(input, owner, check = () => {}) {
    if (input.action === 'status') {
      const record = this.current || this.last;
      return record?.owner === owner ? this.snapshot(record) : { state: 'idle' };
    }
    if (input.action === 'stop') {
      const record = this.current;
      if (!record || record.owner !== owner) throw new Error('No recording is owned by this session.');
      record.state = 'stopping'; this.notify();
      // Fire and forget: the renderer finalizes in the background and reports
      // back over the finished IPC. Awaiting the script here would deadlock,
      // because finish() tears the capture window down while executeJavaScript
      // is still waiting for the script's promise, which never settles then.
      const window = this.window;
      if (window && !window.isDestroyed()) {
        void Promise.race([
          window.webContents.executeJavaScript('window.stopComputerRecording()', true),
          new Promise(resolve => setTimeout(resolve, 3000)),
        ]).catch(() => {});
      }
      let timer;
      try { await Promise.race([record.done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Recording finalization timed out.')), 15_000); })]); }
      catch { await this.finish(record, null); }
      finally { clearTimeout(timer); }
      return this.snapshot(record);
    }
    if (this.current) throw new Error('A screen recording is already active.');
    const mode = input.mode === 'window' || input.mode === 'screen' || input.mode === 'tab' ? input.mode : 'screen';
    // Resolve the target tab up front so "no tab selected" fails here with a
    // clear error instead of an empty stream from the display-media handler.
    const tab = mode === 'tab' ? this.getTab(String(input.tabId || '')) : null;
    if (mode === 'tab' && (!tab || !tab.webContents || tab.webContents.isDestroyed?.())) throw new Error('Select a browser tab to record.');
    const display = mode === 'screen' ? this.display(input.displayId) : null;
    const target = input.path || path.join(this.app.getPath('videos'), `Browser-use-${Date.now()}.mp4`);
    if (!path.isAbsolute(target) || !/\.(mp4|webm)$/i.test(target)) throw new Error('Recording requires an absolute .mp4 or .webm path.');
    const record = { id: crypto.randomUUID(), owner, state: 'starting', path: target, format: /\.webm$/i.test(target) ? 'webm' : 'mp4', displayId: display?.id || null, tabId: tab ? String(tab.id) : null, tabTitle: tab ? (tab.title || 'Tab') : null, audio: Boolean(input.audio), audioActive: false, bytes: 0, startedAt: Date.now(),
      mode, maxDuration: Number(input.maxDuration) || 0, speed: Math.max(1, Math.min(10, Number(input.speed) || 1)), fps: Math.max(5, Math.min(60, input.fps || 30)), width: Math.max(320, Math.min(3840, input.width || 1920, display?.bounds.width || 3840)) };
    this.current = record; record.done = new Promise(resolve => { record.resolve = resolve; });
    try {
      // Allocate a free file, auto-suffixing "name (2).mp4", "name (3).mp4",
      // ... so an existing or leftover recording can never be clobbered.
      const ext = path.extname(target), base = target.slice(0, target.length - ext.length);
      for (let n = 0; ; n++) {
        const candidate = n ? `${base} (${n})${ext}` : target;
        try { record.file = await fs.promises.open(candidate, 'wx'); record.path = candidate; break; }
        catch (openError) {
          if (openError.code !== 'EEXIST') throw openError;
          if (n >= 99) throw new Error('Could not allocate a free recording file name.');
        }
        check();
      }
      const window = await this.ensureWindow(); check();
      // Validate the capture source up front so an unusable source fails with
      // a clear error here instead of an opaque rejection from inside the
      // display-media handler.
      if (record.mode === 'window') await this.windowSource();
      else if (record.mode === 'tab') { if (!this.tabFrame(record.tabId)) throw new Error('The selected tab can no longer be recorded.'); }
      else await this.source(this.display(record.displayId), { width: 0, height: 0 });
      check();
      if (this.current !== record || record.state !== 'starting') throw new Error('Recording start cancelled.');
      const started = await window.webContents.executeJavaScript(`window.startComputerRecording(${JSON.stringify({ id: record.id, fps: record.fps, width: record.width, speed: record.speed, format: record.format, audio: record.audio })})`, true);
      check();
      // A start failure already reported itself over the finished IPC, which
      // finished the record; either way surface the real message.
      if (!started?.started) throw new Error(started?.error || record.error || 'Recording could not start.');
      if (this.current !== record) throw new Error(record.error || 'Recording ended during startup.');
      record.audioActive = record.audio && started.audioEnabled !== false;
      record.startedAt = Date.now(); record.state = 'recording'; this.notify(); return this.snapshot(record);
    } catch (error) {
      // Page exceptions arrive from executeJavaScript as plain objects; the
      // UI must always receive a real Error with the actual message.
      const message = error instanceof Error ? error.message : String(error?.message || error);
      await this.finish(record, message);
      throw error instanceof Error ? error : new Error(message);
    }
  }

  // Publishes recording state changes without ever breaking the caller; a
  // renderer push failure must not fail an in-flight recording operation.
  notify() { try { this.onStateChange?.(); } catch {} }

  async finish(record, error) {
    if (record.finished) return record.done;
    record.finished = true;
    record.error = error;
    try { await record.file?.close(); } catch (closeError) { record.error ||= closeError.message; }
    record.state = record.error || !record.bytes ? 'failed' : 'completed';
    if (!record.bytes && !record.error) record.error = 'Recording produced no video data.';
    record.endedAt = Date.now();
    if (this.current === record) { this.current = null; this.last = record; }
    record.resolve();
    this.notify();
    // Destroying the owned renderer also releases capture tracks on error.
    const window = this.window; this.window = null;
    setImmediate(() => { if (window && !window.isDestroyed()) window.destroy(); });
  }

  snapshotFor(owner) { const record = this.current || this.last; return record?.owner === owner ? this.snapshot(record) : { state: 'idle' }; }

  // VIDEO-TO-FRAMES (the agent's eyes for recordings): a vision model cannot
  // watch a video, so any .mp4/.webm can be decoded into N evenly-spaced
  // frames sized for vision consumption. Electron-native decode: a hidden
  // offscreen window seeks a <video> element across the timeline and draws
  // each position onto a canvas — no ffmpeg, no sidecar (bundled-engines rule).
  // webSecurity is disabled for THIS window only: it is a sandboxed page whose
  // sole input is a local recording the harness itself produced (file:// media
  // otherwise taints the canvas); it never loads remote content.
  async extractFrames(input = {}) {
    const source = path.resolve(String(input.path || ''));
    if (!/\.(mp4|webm)$/i.test(source)) throw new Error('Frame extraction requires a .mp4 or .webm file.');
    if (!fs.existsSync(source)) throw new Error(`No such recording: ${source}`);
    const count = Math.max(1, Math.min(30, Number(input.count) || 6));
    const width = Math.max(256, Math.min(2048, Number(input.width) || 1024));
    const outDir = path.resolve(String(input.outDir || path.join(this.app.getPath('userData'), 'agent-results', 'frames', `${Date.now()}`)));
    fs.mkdirSync(outDir, { recursive: true });
    const window = new this.BrowserWindow({
      show: false, width, height: Math.round(width * 9 / 16) + 40, frame: false,
      webPreferences: { offscreen: true, webSecurity: false, nodeIntegration: false, contextIsolation: true, sandbox: true }
    });
    try {
      const fileUrl = `file:///${source.replace(/\\/g, '/')}`;
      const script = `(async () => {
        const video = document.createElement('video');
        video.muted = true; video.preload = 'auto';
        video.src = ${JSON.stringify(fileUrl)};
        await new Promise((resolve, reject) => { video.onloadedmetadata = resolve; video.onerror = () => reject(new Error('The recording could not be decoded in the browser.')); setTimeout(() => reject(new Error('Video metadata timed out.')), 15000); });
        const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, ${width} / (video.videoWidth || ${width}));
        canvas.width = Math.max(1, Math.round((video.videoWidth || ${width}) * scale));
        canvas.height = Math.max(1, Math.round((video.videoHeight || Math.round(${width} * 9 / 16)) * scale));
        const frames = [];
        for (let k = 0; k < ${count}; k++) {
          const t = duration > 0 ? duration * (k + 0.5) / ${count} : 0;
          await new Promise((resolve) => {
            const onSeeked = () => { video.removeEventListener('seeked', onSeeked); resolve(); };
            video.addEventListener('seeked', onSeeked);
            video.currentTime = Math.min(t, Math.max(0, duration - 0.01));
            setTimeout(resolve, 4000); // a stuck seek must never hang the batch
          });
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          frames.push({ index: k, t: Math.round(t * 100) / 100, dataUrl: canvas.toDataURL('image/jpeg', 0.85) });
        }
        return { duration: Math.round(duration * 100) / 100, width: canvas.width, height: canvas.height, frames };
      })()`;
      const result = await Promise.race([
        window.webContents.executeJavaScript(script, true),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Frame extraction timed out.')), 60_000))
      ]);
      const saved = [];
      for (const frame of (result?.frames || [])) {
        const comma = String(frame.dataUrl || '').indexOf(',');
        if (comma <= 0) continue;
        const file = path.join(outDir, `frame-${String(frame.index).padStart(3, '0')}.jpg`);
        await fs.promises.writeFile(file, Buffer.from(frame.dataUrl.slice(comma + 1), 'base64'));
        // Keep the inline base64 too: providers cannot read local file:// URLs,
        // so a frame consumed as vision must travel as data, not as a path.
        saved.push({ index: frame.index, t: frame.t, path: file, dataUrl: frame.dataUrl, mimeType: 'image/jpeg' });
      }
      return { ok: saved.length > 0, video: source, durationSeconds: result?.duration ?? null, frameWidth: result?.width ?? null, outDir, frames: saved,
        note: 'Frames are evenly spaced across the recording; index 0 is the earliest. Each frame carries inline dataUrl/base64 for vision. Never send a client-local file://, content://, or blob: URL as an image part to a provider — inline base64 or a public https:// URL only.' };
    } finally {
      if (!window.isDestroyed()) window.destroy();
    }
  }


  async releaseOwner(owner) {
    const record = this.current;
    if (!record || record.owner !== owner) return;
    if (record.state === 'starting') { await this.finish(record, 'Recording start cancelled.'); return; }
    await this.record({ action: 'stop' }, owner);
  }

  async close() {
    if (this.current) await this.releaseOwner(this.current.owner);
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
    this.ipcMain.removeHandler('browser-use:computer-record-chunk');
    this.ipcMain.removeHandler('browser-use:computer-record-finished');
  }
}
module.exports = { DesktopCapture };
