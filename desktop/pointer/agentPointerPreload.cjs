'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browserUseAgentPointer', {
  onCommand: (listener) => ipcRenderer.on('browser-use:agent-pointer-command', (_event, command) => listener(command)),
  acknowledge: (payload) => ipcRenderer.send('browser-use:agent-pointer-ack', payload)
});
