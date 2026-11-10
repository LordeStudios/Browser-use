'use strict';

const { AndroidDeviceManager } = require('../desktop/android/androidDeviceManager.cjs');

function createCliAndroidApi({ adbPath = 'adb', scrcpyPath = 'scrcpy', records = [], execFileImpl, spawnImpl, onEvent = null } = {}) {
  const manager = new AndroidDeviceManager({ adbPath, scrcpyPath, records, execFileImpl, spawnImpl, onChange: onEvent });
  return {
    manager,
    execute: async (name, input = {}) => {
      if (name === 'android_devices') {
        switch (String(input.action || 'list')) {
          case 'list': return manager.snapshot();
          case 'refresh': return manager.refresh();
          case 'pair': return manager.pair(input);
          case 'connect': return manager.connect(input);
          case 'disconnect': return manager.disconnect(input.serial);
          case 'remove': return manager.remove(input.serial);
          case 'select': return manager.select(input.serial);
          case 'programmatic-input': return manager.setProgrammaticTaps(input.serial, input.enabled);
          case 'stream-start': return { ok: false, reason: 'no-display', note: 'CLI can control the Android device through ADB, but it has no Browser-use tab renderer for live scrcpy video.' };
          case 'stream-stop': return manager.stopStream(input.serial);
          default: throw new Error(`Unknown android_devices action: ${input.action}`);
        }
      }
      if (name === 'android_adb') return Array.isArray(input.commands) ? manager.batchCommand(input) : manager.command(input);
      throw new Error(`Unknown Android tool: ${name}`);
    }
  };
}

module.exports = { createCliAndroidApi };
