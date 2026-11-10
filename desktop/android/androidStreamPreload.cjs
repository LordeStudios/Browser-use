'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('androidStream', {
  onMeta: (handler) => { const listener = (_event, payload) => handler(payload); ipcRenderer.on('browser-use:android-stream-meta', listener); return () => ipcRenderer.removeListener('browser-use:android-stream-meta', listener); },
  onCodecConfig: (handler) => { const listener = (_event, payload) => handler(payload); ipcRenderer.on('browser-use:android-stream-codec-config', listener); return () => ipcRenderer.removeListener('browser-use:android-stream-codec-config', listener); },
  onFrame: (handler) => { const listener = (_event, payload) => handler(payload); ipcRenderer.on('browser-use:android-stream-frame', listener); return () => ipcRenderer.removeListener('browser-use:android-stream-frame', listener); },
  onState: (handler) => { const listener = (_event, payload) => handler(payload); ipcRenderer.on('browser-use:android-stream-state', listener); return () => ipcRenderer.removeListener('browser-use:android-stream-state', listener); },
  sendInput: (input) => ipcRenderer.send('browser-use:android-stream-input', input),
  reportStats: (stats) => ipcRenderer.send('browser-use:android-stream-stats', stats)
});
