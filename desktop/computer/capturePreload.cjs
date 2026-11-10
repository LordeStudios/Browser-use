'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('computerRecordingBridge', {
  chunk: (id, bytes) => ipcRenderer.invoke('browser-use:computer-record-chunk', id, bytes),
  finished: (id, error) => ipcRenderer.invoke('browser-use:computer-record-finished', id, error)
});
