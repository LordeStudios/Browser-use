import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { FileDialogBridge } = require('../desktop/mcp/fileDialogBridge.cjs');
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

// Owner directive: agents must complete Open/Save dialogs without the native
// dialog. The bridge is the only thing that knows a chooser is waiting, so its
// state machine and its CDP calls are what these tests pin.

function fakeWebContents() {
  const calls = [];
  const listeners = new Map();
  const debuggerClient = {
    attached: false,
    isAttached() { return this.attached; },
    attach() { this.attached = true; },
    detach() { this.attached = false; },
    async sendCommand(method, params) {
      calls.push({ method, params });
      if (method === 'Page.handleFileChooser' && params?.action === 'cancel') return {};
      return {};
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(handler);
    },
    removeListener(event, handler) {
      listeners.get(event)?.delete(handler);
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) || []) handler(...args);
    }
  };
  return {
    calls,
    debugger: debuggerClient,
    isDestroyed: () => false,
    // Simulate Chromium telling us a picker opened.
    openChooser(params = {}) {
      debuggerClient.emit('message', {}, 'Page.fileChooserOpened', {
        frameId: 'FRAME',
        mode: 'selectSingle',
        backendNodeId: 42,
        ...params
      });
    },
    downloadEvent(method, params) {
      debuggerClient.emit('message', {}, method, params);
    }
  };
}

test('attach arms chooser interception and stays attached', async () => {
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  const state = await bridge.attach(webContents);
  assert.equal(state.attached, true);
  assert.deepEqual(
    webContents.calls.map((call) => call.method),
    ['Page.enable', 'Page.setInterceptFileChooserDialog']
  );
  assert.deepEqual(webContents.calls[1].params, { enabled: true });
  // Re-arming is deliberate: a detach by the lease manager wipes the flag, so a
  // second attach must re-send it — but it must never stack duplicate listeners.
  await bridge.attach(webContents);
  assert.equal(webContents.debugger.listenerCount?.('message') ?? 1, 1);
  assert.equal(bridge.state().armed, true);
});

test('fileChooserOpened is reported as pending state', async () => {
  const webContents = fakeWebContents();
  const events = [];
  const bridge = new FileDialogBridge({ onEvent: (event) => events.push(event) });
  await bridge.attach(webContents);
  webContents.openChooser({ mode: 'selectMultiple', backendNodeId: 7 });
  const state = bridge.state();
  assert.equal(state.pending.backendNodeId, 7);
  assert.equal(state.pending.multiple, true);
  assert.ok(events.some((event) => event.type === 'fileChooser.opened'));
});

test('accept answers with absolute paths through DOM.setFileInputFiles', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-dialog-'));
  const file = path.join(dir, 'photo.png');
  fs.writeFileSync(file, 'x');
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  webContents.openChooser();
  const result = await bridge.accept([file]);
  assert.deepEqual(result.accepted, [file]);
  const call = webContents.calls.find((entry) => entry.method === 'DOM.setFileInputFiles');
  assert.deepEqual(call.params.files, [file]);
  assert.equal(call.params.backendNodeId, 42);
  assert.equal(bridge.state().pending, null);
});

test('accept rejects missing files and single-file pickers with several paths', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-dialog-'));
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  webContents.openChooser();
  await assert.rejects(() => bridge.accept([path.join(dir, 'missing.txt')]), /File not found/);
  await assert.rejects(() => bridge.accept([a, b]), /single file/);
});

test('accept with no pending chooser falls back to direct DOM attach', async () => {
  // The live failure: a detach wiped interception, no chooser event arrived, and
  // accept refused to do anything. Attachment must not depend on the event.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-direct-'));
  const file = path.join(dir, 'direct.txt');
  fs.writeFileSync(file, 'x');
  const webContents = fakeWebContents();
  webContents.debugger.sendCommand = async (method, params) => {
    webContents.calls.push({ method, params });
    if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
    if (method === 'DOM.querySelector') return { nodeId: 77 };
    return {};
  };
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  const result = await bridge.accept([file]);
  assert.equal(result.via, 'dom');
  assert.equal(result.mode, 'direct');
  const call = webContents.calls.find((entry) => entry.method === 'DOM.setFileInputFiles');
  assert.equal(call.params.nodeId, 77);
  assert.deepEqual(call.params.files, [file]);
});

test('direct attach explains when the page has no file input', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-none-'));
  const file = path.join(dir, 'x.txt');
  fs.writeFileSync(file, 'x');
  const bridge = new FileDialogBridge();
  const webContents = fakeWebContents();
  await bridge.attach(webContents);
  await assert.rejects(() => bridge.accept([file]), /No file input matched/);
});

test('an already-attached debugger still reports attached and armed', async () => {
  // The lease manager holds the session; arm must not look inert (the live run
  // read attached:false six times while the OS dialog kept opening).
  const webContents = fakeWebContents();
  webContents.debugger.attach();
  const bridge = new FileDialogBridge();
  const state = await bridge.attach(webContents);
  assert.equal(state.attached, true);
  assert.equal(state.armed, true);
  assert.equal(webContents.calls.filter((c) => c.method === 'Page.setInterceptFileChooserDialog').length, 1);
});

test('cancel dismisses through Page.handleFileChooser', async () => {
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  webContents.openChooser();
  const result = await bridge.cancel();
  assert.equal(result.canceled, true);
  const call = webContents.calls.find((entry) => entry.method === 'Page.handleFileChooser');
  assert.deepEqual(call.params, { action: 'cancel' });
  assert.equal(bridge.state().pending, null);
});

test('downloads are routed to a directory and tracked to completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-downloads-'));
  const target = path.join(dir, 'saved');
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  const result = await bridge.setDownloadPath(target);
  assert.equal(result.directory, target);
  assert.ok(fs.statSync(target).isDirectory());
  const behavior = webContents.calls.find((entry) => entry.method === 'Browser.setDownloadBehavior');
  assert.equal(behavior.params.behavior, 'allow');
  assert.equal(behavior.params.eventsEnabled, true);

  webContents.downloadEvent('Browser.downloadWillBegin', {
    guid: 'g1', suggestedFilename: 'report.pdf', url: 'https://example.test/report.pdf'
  });
  let downloads = bridge.listDownloads();
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].state, 'started');
  assert.equal(downloads[0].path, path.join(target, 'report.pdf'));

  webContents.downloadEvent('Browser.downloadProgress', {
    guid: 'g1', state: 'completed', receivedBytes: 10, totalBytes: 10
  });
  downloads = bridge.listDownloads();
  assert.equal(downloads[0].state, 'completed');
});

test('saveFile writes text and base64 without any dialog', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-save-'));
  const bridge = new FileDialogBridge();
  const textPath = path.join(dir, 'nested', 'note.txt');
  const textResult = bridge.saveFile(textPath, { text: 'hello' });
  assert.equal(fs.readFileSync(textPath, 'utf8'), 'hello');
  assert.equal(textResult.bytes, 5);

  const binaryPath = path.join(dir, 'blob.bin');
  bridge.saveFile(binaryPath, { base64: Buffer.from([1, 2, 3]).toString('base64') });
  assert.deepEqual([...fs.readFileSync(binaryPath)], [1, 2, 3]);
});

test('controller exposes the bridge through the MCP-facing methods', async () => {
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  const tab = { id: 'tab-1', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => 'tab-1',
    getConsoleEntries: () => [],
    normalizeUrl: (url) => url,
    fileDialogBridge: bridge
  });
  const armed = await controller.fileDialogArm('tab-1');
  assert.equal(armed.attached, true);
  webContents.openChooser({ backendNodeId: 11 });
  const state = await controller.fileDialogState('tab-1');
  assert.equal(state.pending.backendNodeId, 11);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-ctl-'));
  const file = path.join(dir, 'doc.txt');
  fs.writeFileSync(file, 'doc');
  const accepted = await controller.fileDialogAccept('tab-1', { files: [file] });
  assert.deepEqual(accepted.accepted, [file]);
});

test('CLI adapter style: per-method subscribe delivers chooser events', async () => {
  const handlers = new Map();
  const calls = [];
  const webContents = {
    isDestroyed: () => false,
    debugger: {
      attached: false,
      isAttached() { return this.attached; },
      attach() { this.attached = true; },
      detach() { this.attached = false; },
      async sendCommand(method, params) { calls.push({ method, params }); return {}; },
      subscribe(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      }
    }
  };
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  assert.ok(handlers.has('Page.fileChooserOpened'));
  handlers.get('Page.fileChooserOpened')({ backendNodeId: 5, mode: 'selectSingle' });
  assert.equal(bridge.state().pending.backendNodeId, 5);
  handlers.get('Browser.downloadWillBegin')({ guid: 'g', suggestedFilename: 'x.zip', url: 'u' });
  assert.equal(bridge.listDownloads()[0].suggestedFilename, 'x.zip');
  bridge.detach();
  assert.equal(handlers.size, 0);
});

test('Electron downloads are mirrored into the bridge list', () => {
  // The live run showed downloads:[] while the page had saved two files —
  // Electron answers will-download itself, so the CDP events never fire.
  const bridge = new FileDialogBridge();
  bridge.noteDownload({ id: 'dl-1', filename: 'quest.json', url: 'blob:x', state: 'progressing', path: 'C:/out/quest.json' });
  assert.equal(bridge.listDownloads()[0].suggestedFilename, 'quest.json');
  bridge.noteDownload({ id: 'dl-1', filename: 'quest.json', state: 'completed', path: 'C:/out/quest.json', receivedBytes: 253 });
  assert.equal(bridge.listDownloads()[0].state, 'completed');
  assert.equal(bridge.listDownloads().length, 1);
});

test('setDownloadPath still records the directory when CDP rejects it', async () => {
  // Electron ignores Browser.setDownloadBehavior; the tool must not fail, and
  // main.cjs reads downloadPath when it reserves the save path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-path-'));
  const webContents = fakeWebContents();
  webContents.debugger.sendCommand = async (method, params) => {
    if (method === 'Browser.setDownloadBehavior') throw new Error("'Browser.setDownloadBehavior' wasn't found");
    webContents.calls.push({ method, params });
    return {};
  };
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  const result = await bridge.setDownloadPath(path.join(dir, 'saves'));
  assert.equal(result.directory, path.join(dir, 'saves'));
  assert.equal(bridge.downloadPath, path.join(dir, 'saves'));
  assert.ok(fs.statSync(path.join(dir, 'saves')).isDirectory());
});

test('navigation re-arms interception after a detach wiped it', async () => {
  // Live failure: after browser_navigate, armed stayed true, no chooser event
  // fired, and the click opened a real OS dialog that blocked the page.
  const webContents = fakeWebContents();
  const bridge = new FileDialogBridge();
  await bridge.attach(webContents);
  webContents.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'file:///next' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const armedCalls = webContents.calls.filter((c) => c.method === 'Page.setInterceptFileChooserDialog');
  assert.equal(armedCalls.length, 2, 'navigation must re-send the interception flag');
  assert.equal(bridge.state().armed, true);

  // After a detach, the same navigation event restores the flag again.
  bridge.armed = false;
  webContents.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'file:///third' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(webContents.calls.filter((c) => c.method === 'Page.setInterceptFileChooserDialog').length, 3);
  assert.equal(bridge.state().armed, true);
});

test('a bridge that was never armed leaves navigation alone', async () => {
  const bridge = new FileDialogBridge();
  const webContents = fakeWebContents();
  await bridge.attach(webContents);
  bridge.enabled = false; // simulate "human drives this page" state
  webContents.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { url: 'file:///x' } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(webContents.calls.filter((c) => c.method === 'Page.setInterceptFileChooserDialog').length, 1);
});
