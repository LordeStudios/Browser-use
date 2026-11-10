'use strict';

function clamp(value, min, max) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function displayToDevicePoint({ x, y, displayWidth, displayHeight, deviceWidth, deviceHeight } = {}) {
  const dw = Math.max(1, Number(displayWidth) || 1);
  const dh = Math.max(1, Number(displayHeight) || 1);
  const targetW = Math.max(1, Number(deviceWidth) || 1);
  const targetH = Math.max(1, Number(deviceHeight) || 1);
  return {
    x: Math.round(clamp(Number(x), 0, dw) * targetW / dw),
    y: Math.round(clamp(Number(y), 0, dh) * targetH / dh)
  };
}

class AndroidInputPolicy {
  constructor() { this.programmatic = new Map(); }
  isProgrammatic(serial) { return this.programmatic.get(String(serial)) === true; }
  setProgrammatic(serial, enabled) {
    const key = String(serial || '').trim();
    if (!key) throw new Error('Device serial is required.');
    this.programmatic.set(key, Boolean(enabled));
    return { serial: key, programmaticTaps: Boolean(enabled) };
  }
  clear(serial) { this.programmatic.delete(String(serial || '')); }
}

module.exports = { AndroidInputPolicy, displayToDevicePoint, clamp };
