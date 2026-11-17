'use strict';

// Preload for the floating working bubble (bottom-right, always on top).
//
// The bubble is a SEPARATE always-on-top window, so it must be told what the
// run is doing without sharing the main renderer's scope. Only four messages
// cross the boundary: the current state, hover in/out (the window is
// click-through until the pointer is over the bubble), and a click to restore
// the app.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('workingBubble', {
  onState: (listener) => {
    ipcRenderer.on('browser-use:bubble-state', (_event, state) => listener(state));
  },
  // Hover drives BOTH the visual expansion and the click-through toggle: a
  // large transparent window must not block the desktop behind it.
  hover: (inside) => ipcRenderer.send('browser-use:bubble-hover', inside === true),
  activate: () => ipcRenderer.send('browser-use:bubble-activate')
});
