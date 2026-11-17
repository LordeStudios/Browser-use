'use strict';
// FILE DIALOG BRIDGE — owner directive: agents must be able to open, save and
// attach files WITHOUT the native Open/Save dialog, in the desktop app, the CLI
// and over MCP.
//
// Chromium exposes everything needed over CDP, but only while the debugger is
// attached for the lifetime of the page:
//
//   Page.setInterceptFileChooserDialog { enabled: true }
//     → Page.fileChooserOpened { frameId, mode, backendNodeId }
//   DOM.setFileInputFiles { files, backendNodeId }        ← answer the dialog
//   Page.handleFileChooser { action: 'accept'|'cancel' }  ← fallback / cancel
//   Browser.setDownloadBehavior { behavior:'allow', downloadPath, eventsEnabled }
//     → Browser.downloadWillBegin / Browser.downloadProgress   ← save without a dialog
//
// The per-call `withDebugger` helper in browserViewController detaches after
// each command, so event streams cannot be observed through it. This bridge
// owns a persistent attachment instead, and every other CDP call reuses it.

const fs = require('node:fs');
const path = require('node:path');

const CHOOSER_EVENT = 'Page.fileChooserOpened';
const NAVIGATED_EVENT = 'Page.frameNavigated';
const DOWNLOAD_BEGIN = 'Browser.downloadWillBegin';
const DOWNLOAD_PROGRESS = 'Browser.downloadProgress';

class FileDialogBridge {
  constructor({ onEvent = null, logger = null } = {}) {
    this.onEvent = onEvent;
    this.logger = logger;
    this.webContents = null;
    this.attachedHere = false;
    this.ownsAttachment = false;
    this.armed = false;
    this.boundDebugger = null;
    this.listener = null;
    this.pending = null;
    this.downloadPath = null;
    this.downloads = new Map();
    this.sequence = 0;
    this.unsubscribe = [];
  }

  emit(type, detail = {}) {
    const event = { type, at: new Date().toISOString(), ...detail };
    try { this.onEvent?.(event); } catch { /* observers must never break the bridge */ }
    try { this.logger?.('file-dialog', event); } catch { /* ignore */ }
    return event;
  }

  /** Attaches once per WebContents and turns on chooser + download interception. */
  async attach(webContents) {
    if (!webContents || webContents.isDestroyed?.()) {
      throw new Error('The bound tab is not available, so the file dialog bridge cannot attach.');
    }
    const debuggerClient = webContents.debugger;
    if (!debuggerClient) throw new Error('This build has no CDP debugger available on the tab.');
    if (this.webContents !== webContents) {
      this.detach();
      this.webContents = webContents;
    }
    // LORDE_FILE_DIALOG_OWN: claim the attachment when nobody holds it, but do
    // NOT treat "already attached" as "not armed". The debugger lease manager
    // attaches per command; reporting attached:false there made `arm` look
    // inert while the OS dialog still opened.
    if (!debuggerClient.isAttached?.()) {
      debuggerClient.attach('1.3');
      this.ownsAttachment = true;
    }
    this.bindEvents(debuggerClient);
    // Page domain must be enabled for fileChooserOpened to be emitted.
    await this.send(debuggerClient, 'Page.enable', {});
    await this.send(debuggerClient, 'Page.setInterceptFileChooserDialog', { enabled: true });
    this.armed = true;
    this.enabled = true;
    this.emit('bridge.attached', { ownsAttachment: this.ownsAttachment });
    return this.state();
  }

  /**
   * Re-sends the interception flag after Chromium wiped it. Only runs once the
   * bridge has been armed at least once, so a page a human drives manually
   * keeps its normal native dialogs.
   */
  async rearm() {
    if (!this.enabled || !this.webContents?.debugger) return false;
    try {
      await this.send(this.webContents.debugger, 'Page.setInterceptFileChooserDialog', { enabled: true });
      this.armed = true;
      this.emit('bridge.rearmed');
      return true;
    }
    catch {
      this.armed = false;
      return false;
    }
  }

  /** Event wiring is idempotent: re-arming must not stack duplicate listeners. */
  bindEvents(debuggerClient) {
    if (this.boundDebugger === debuggerClient) return;
    if (this.boundDebugger && this.listener) {
      try { this.boundDebugger.removeListener?.('message', this.listener); } catch { /* ignore */ }
    }
    if (typeof debuggerClient.on === 'function') {
      // Electron debugger: one multiplexed 'message' channel.
      this.listener = (event, method, params) => this.handleEvent(method, params);
      debuggerClient.on('message', this.listener);
      debuggerClient.on('detach', () => {
        // A detach wipes Page.setInterceptFileChooserDialog; say so instead of
        // pretending the tab is still armed.
        this.armed = false;
        this.pending = null;
        this.emit('bridge.detached');
      });
    }
    else if (typeof debuggerClient.subscribe === 'function') {
      // CLI adapter: per-method subscription over a chrome-remote-interface client.
      for (const method of [CHOOSER_EVENT, DOWNLOAD_BEGIN, DOWNLOAD_PROGRESS, NAVIGATED_EVENT]) {
        this.unsubscribe.push(debuggerClient.subscribe(method, (params) => this.handleEvent(method, params)));
      }
    }
    else {
      throw new Error('This tab cannot deliver CDP events, so file dialog interception is unavailable.');
    }
    this.boundDebugger = debuggerClient;
  }

  detach() {
    for (const off of this.unsubscribe) { try { off(); } catch { /* ignore */ } }
    this.unsubscribe = [];
    if (this.boundDebugger && this.listener) {
      try { this.boundDebugger.removeListener?.('message', this.listener); } catch { /* ignore */ }
    }
    if (this.webContents?.debugger && this.ownsAttachment) {
      try { this.webContents.debugger.detach(); } catch { /* ignore */ }
    }
    this.webContents = null;
    this.listener = null;
    this.boundDebugger = null;
    this.ownsAttachment = false;
    this.armed = false;
    this.pending = null;
  }

  async send(debuggerClient, method, params) {
    return debuggerClient.sendCommand(method, params);
  }

  handleEvent(method, params = {}) {
    if (method === NAVIGATED_EVENT) {
      // LORDE_REARM_ON_NAV: Chromium drops Page.setInterceptFileChooserDialog on
      // navigation while the bridge kept reporting armed:true. The next click
      // then opened a REAL OS dialog that blocked the page. Re-arm silently.
      Promise.resolve().then(() => this.rearm()).catch(() => { /* next arm call retries */ });
      return;
    }
    if (method === CHOOSER_EVENT) {
      this.sequence += 1;
      this.pending = {
        id: this.sequence,
        backendNodeId: params.backendNodeId ?? null,
        frameId: params.frameId ?? null,
        mode: params.mode || 'selectSingle',
        multiple: params.mode === 'selectMultiple',
        openedAt: new Date().toISOString()
      };
      this.emit('fileChooser.opened', { pending: this.pending });
      return;
    }
    if (method === DOWNLOAD_BEGIN) {
      this.downloads.set(params.guid, {
        guid: params.guid,
        suggestedFilename: params.suggestedFilename || '',
        url: params.url || '',
        state: 'started',
        receivedBytes: 0,
        totalBytes: 0,
        path: this.downloadPath ? path.join(this.downloadPath, params.suggestedFilename || '') : null
      });
      this.emit('download.started', { guid: params.guid, filename: params.suggestedFilename });
      return;
    }
    if (method === DOWNLOAD_PROGRESS) {
      const entry = this.downloads.get(params.guid);
      if (!entry) return;
      entry.state = params.state || entry.state;
      entry.receivedBytes = params.receivedBytes ?? entry.receivedBytes;
      entry.totalBytes = params.totalBytes ?? entry.totalBytes;
      if (params.state === 'completed' || params.state === 'canceled') {
        this.emit(params.state === 'completed' ? 'download.completed' : 'download.canceled', { guid: params.guid });
      }
    }
  }

  state() {
    const attached = Boolean(this.webContents && this.webContents.debugger?.isAttached?.());
    return {
      // attached: the tab has a live debugger session right now.
      // armed: interception is on. They are independent — the lease manager may
      // hold the session while our arming has been wiped by a detach.
      attached,
      armed: Boolean(this.armed && attached),
      pending: this.pending,
      downloadPath: this.downloadPath,
      downloads: this.listDownloads()
    };
  }

  requirePending() {
    if (!this.pending) {
      const error = new Error('No file chooser is open. Trigger the picker first (click the file input) and retry.');
      error.code = 'NO_FILE_CHOOSER';
      error.recoverable = true;
      throw error;
    }
    return this.pending;
  }

  /**
   * Answers the open dialog with real files, without any OS dialog appearing.
   * When interception never fired (a detach wiped it, or the page opened the
   * picker before arming), it attaches straight to the file input instead —
   * attachment must not depend on having observed the chooser event.
   */
  async accept(files, { selector = null } = {}) {
    const pending = this.pending;
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error('Pass at least one absolute file path to answer the file chooser.');
    }
    const resolved = files.map((file) => path.resolve(String(file)));
    const missing = resolved.filter((file) => !fs.existsSync(file));
    if (missing.length) throw new Error(`File not found: ${missing.join(', ')}`);
    if (pending && !pending.multiple && resolved.length > 1) {
      throw new Error('This picker accepts a single file; pass exactly one path.');
    }
    if (!this.webContents?.debugger) throw new Error('The file dialog bridge is not attached to a tab.');
    const debuggerClient = this.webContents.debugger;

    if (pending && pending.backendNodeId != null) {
      try {
        await this.send(debuggerClient, 'DOM.setFileInputFiles', {
          files: resolved,
          backendNodeId: pending.backendNodeId
        });
      } catch (error) {
        // Older Chromium: the experimental chooser handler is the only way.
        await this.send(debuggerClient, 'Page.handleFileChooser', { action: 'accept', files: resolved });
      }
      this.emit('fileChooser.accepted', { files: resolved, pending });
      this.pending = null;
      return { accepted: resolved, mode: pending.mode, via: 'chooser' };
    }

    // Direct attach: no chooser was observed, so target the input itself.
    const doc = await this.send(debuggerClient, 'DOM.getDocument', { depth: 0 });
    const found = await this.send(debuggerClient, 'DOM.querySelector', {
      nodeId: doc?.root?.nodeId,
      selector: selector || 'input[type=file]'
    });
    if (!found?.nodeId) {
      const error = new Error('No file input matched on this page. Pass selector for a custom control, or trigger the picker first.');
      error.code = 'NO_FILE_INPUT';
      error.recoverable = true;
      throw error;
    }
    await this.send(debuggerClient, 'DOM.setFileInputFiles', { files: resolved, nodeId: found.nodeId });
    this.emit('file.attached', { files: resolved, nodeId: found.nodeId });
    return { accepted: resolved, mode: 'direct', via: 'dom' };
  }

  /** Dismisses the dialog the way a person would press Cancel. */
  async cancel() {
    if (!this.pending) return { canceled: false, reason: 'no file chooser open' };
    const pending = this.pending;
    try {
      await this.send(this.webContents.debugger, 'Page.handleFileChooser', { action: 'cancel' });
    } catch {
      // DOM has no cancel; clearing the input is the closest equivalent.
      try {
        await this.send(this.webContents.debugger, 'DOM.setFileInputFiles', { files: [], backendNodeId: pending.backendNodeId ?? undefined });
      } catch { /* ignore */ }
    }
    this.pending = null;
    this.emit('fileChooser.canceled', { pending });
    return { canceled: true };
  }

  /** Routes every download to a directory so no Save dialog is ever shown. */
  async setDownloadPath(directory) {
    if (!directory) throw new Error('Pass a directory for downloads.');
    const target = path.resolve(String(directory));
    fs.mkdirSync(target, { recursive: true });
    // Electron answers downloads through session.will-download, not this CDP
    // call, so a protocol-level failure must not fail the tool: main.cjs reads
    // downloadPath directly when it reserves a save path.
    try {
      await this.send(this.webContents.debugger, 'Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: target,
        eventsEnabled: true
      });
    }
    catch (error) {
      this.emit('downloads.path.cdp-unavailable', { message: error.message });
    }
    this.downloadPath = target;
    this.emit('downloads.path', { directory: target });
    return { directory: target };
  }

  /** Mirrors a host (Electron) download entry so downloads_list tells the truth. */
  noteDownload(entry) {
    if (!entry?.id) return;
    this.downloads.set(entry.id, {
      guid: entry.id,
      suggestedFilename: entry.filename || '',
      url: entry.url || '',
      state: entry.state || 'started',
      receivedBytes: entry.receivedBytes || 0,
      totalBytes: entry.totalBytes || 0,
      path: entry.path || null
    });
    return this.downloads.get(entry.id);
  }

  listDownloads() {
    return [...this.downloads.values()].map((entry) => ({ ...entry }));
  }

  /** Writes agent-provided content to disk without any dialog. */
  saveFile(target, { text = null, base64 = null } = {}) {
    if (!target) throw new Error('Pass an absolute destination path.');
    const file = path.resolve(String(target));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (typeof base64 === 'string' && base64.length) fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    else fs.writeFileSync(file, typeof text === 'string' ? text : '', 'utf8');
    const bytes = fs.statSync(file).size;
    this.emit('file.saved', { path: file, bytes });
    return { path: file, bytes };
  }
}

module.exports = { FileDialogBridge };
