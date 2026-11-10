import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDeviceLine, safeToken } = require('../desktop/android/adbClient.cjs');
const { displayToDevicePoint, AndroidInputPolicy } = require('../desktop/android/androidInputPolicy.cjs');
const { AndroidDeviceManager } = require('../desktop/android/androidDeviceManager.cjs');
const { ScrcpySession } = require('../desktop/android/scrcpySession.cjs');
const { createCliAndroidApi } = require('../cli/cliAndroidApi.cjs');
const { toolDefinitions, executeAction } = require('../desktop/agent/desktopChatAgent.cjs');
const { openAiToolSchemas } = require('../desktop/agent/providers/wire.cjs');

function fakeAdb() {
  return {
    devices: async () => [{ serial: '192.168.1.8:5555', state: 'device', model: 'Pixel_8', product: 'husky', device: 'husky' }],
    pair: async () => ({ stdout: 'Successfully paired', stderr: '', exitCode: 0 }),
    connect: async () => ({ stdout: 'connected to 192.168.1.8:5555', stderr: '', exitCode: 0 }),
    disconnect: async () => ({ stdout: 'disconnected', stderr: '', exitCode: 0 }),
    command: async ({ serial, args }) => ({ ok: true, serial, argv: args, stdout: 'ok', stderr: '', exitCode: 0 })
  };
}

test('the Windows runtime bundle ships adb, scrcpy, and licensing metadata', () => {
  const fs = require('fs');
  const path = require('path');
  const root = path.join(process.cwd(), 'desktop', 'android', 'bin', 'win32-x64');
  assert.equal(fs.existsSync(path.join(root, 'adb.exe')), true);
  assert.equal(fs.existsSync(path.join(root, 'scrcpy.exe')), true);
  assert.equal(fs.existsSync(path.join(root, 'scrcpy-server')), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'BROWSER_USE_ANDROID_RUNTIME.json'), 'utf8'));
  assert.equal(manifest.integrated, true);
  assert.equal(manifest.externalInstallRequired, false);
  assert.equal(manifest.scrcpy.version, '5.0.1');
  assert.equal(fs.existsSync(path.join(root, 'LICENSE.txt')), true);
  assert.equal(fs.existsSync(path.join(root, 'PLATFORM-TOOLS-NOTICE.txt')), true);
});

test('adb missing executable returns an actionable setup error', async () => {
  const { AdbClient } = require('../desktop/android/adbClient.cjs');
  const client = new AdbClient({ adbPath: 'missing-adb.exe', execFileImpl: (_path, _args, _opts, callback) => callback(Object.assign(new Error('spawn missing-adb.exe ENOENT'), { code: 'ENOENT' }), '', '') });
  await assert.rejects(() => client.devices(), /Integrated ADB runtime was not found/);
});

test('adb device parsing handles usb and wireless records', () => {
  assert.deepEqual(parseDeviceLine('0123456789ABCDEF\tdevice product:husky model:Pixel_8 device:husky transport_id:1'), {
    serial: '0123456789ABCDEF', state: 'device', model: 'Pixel_8', product: 'husky', device: 'husky', transportId: '1', details: { product: 'husky', model: 'Pixel_8', device: 'husky', transport_id: '1' }
  });
  assert.equal(parseDeviceLine('192.168.1.8:5555 device product:husky model:Pixel_8 device:husky').serial, '192.168.1.8:5555');
  assert.equal(parseDeviceLine('List of devices attached'), null);
  assert.throws(() => safeToken('--bad', 'arg'));
  assert.throws(() => safeToken('a\nb', 'arg'));
});

test('android_adb command forwards option flags into argv instead of rejecting them', async () => {
  const { AdbClient } = require('../desktop/android/adbClient.cjs');
  let spawned = null;
  const client = new AdbClient({
    adbPath: 'adb',
    execFileImpl: (_path, args, _opts, callback) => { spawned = args; callback(null, 'OK', ''); }
  });
  const result = await client.command({ serial: 'emulator-5554', args: ['shell', 'dumpsys', '--top'] });
  assert.equal(result.ok, true);
  assert.deepEqual(spawned, ['-s', 'emulator-5554', 'shell', 'dumpsys', '--top'], 'flags reach adb as literal argv entries');
});

test('android_adb accepts model-friendly command strings and structured batches', async () => {
  const { AdbClient } = require('../desktop/android/adbClient.cjs');
  let calls = [];
  const client = new AdbClient({ adbPath: 'adb', execFileImpl: (_path, args, _opts, callback) => { calls.push(args); callback(null, 'OK', ''); } });
  const one = await client.command({ serial: 'd', args: 'shell echo "hello world"' });
  assert.equal(one.ok, true);
  assert.deepEqual(calls[0], ['-s', 'd', 'shell', 'echo', 'hello world']);
  const { AndroidDeviceManager } = require('../desktop/android/androidDeviceManager.cjs');
  const manager = new AndroidDeviceManager({ records: [{ serial: 'd', lastState: 'device' }] });
  manager.adb = client;
  const batch = await manager.batchCommand({ serial: 'd', commands: [{ args: ['shell', 'echo', 'one'] }, { args: 'shell echo two' }] });
  assert.equal(batch.ok, true);
  assert.equal(batch.count, 2);
  assert.equal(batch.results.length, 2);
});

test('android_adb keeps rejecting tokens that carry newlines or NULs', async () => {
  const { AdbClient } = require('../desktop/android/adbClient.cjs');
  const client = new AdbClient({ adbPath: 'adb', execFileImpl: (_path, _args, _opts, callback) => callback(null, '', '') });
  await assert.rejects(() => client.command({ args: ['shell', 'input\ntap 1 2'] }), /safe token/, 'allowOption never reopens the newline gate');
  await assert.rejects(() => client.command({ args: [] }), /requires args/);
});

test('programmatic input policy converts display coordinates exactly and toggles per device', () => {
  assert.deepEqual(displayToDevicePoint({ x: 500, y: 250, displayWidth: 1000, displayHeight: 500, deviceWidth: 1080, deviceHeight: 1920 }), { x: 540, y: 960 });
  const policy = new AndroidInputPolicy();
  assert.equal(policy.isProgrammatic('d'), false);
  assert.deepEqual(policy.setProgrammatic('d', true), { serial: 'd', programmaticTaps: true });
  assert.equal(policy.isProgrammatic('d'), true);
  policy.clear('d'); assert.equal(policy.isProgrammatic('d'), false);
});

test('AndroidDeviceManager routes exactly one programmatic tap and leaves native mode untouched', async () => {
  const manager = new AndroidDeviceManager({ records: [{ serial: 'd', lastState: 'device' }] });
  const calls = [];
  manager.adb = { shell: async (serial, args) => { calls.push({ serial, args }); return { stdout: '', stderr: '', exitCode: 0 }; } };
  const native = await manager.handlePointer({ serial: 'd', action: 'click', x: 10, y: 20, displayWidth: 100, displayHeight: 200, deviceWidth: 1000, deviceHeight: 2000 });
  assert.equal(native.routed, 'native-scrcpy');
  assert.equal(calls.length, 0);
  manager.setProgrammaticTaps('d', true);
  const adb = await manager.handlePointer({ serial: 'd', action: 'click', x: 10, y: 20, displayWidth: 100, displayHeight: 200, deviceWidth: 1000, deviceHeight: 2000 });
  assert.equal(adb.routed, 'adb');
  assert.deepEqual(calls, [{ serial: 'd', args: ['input', 'tap', '100', '200'] }]);
});

test('AndroidDeviceManager persists device state and emits reconnect advisory only for reachable wireless devices', async () => {
  const manager = new AndroidDeviceManager({ records: [{ serial: '192.168.1.8:5555', address: '192.168.1.8:5555', transport: 'wireless', lastState: 'device' }] });
  manager.adb = fakeAdb();
  manager.probeEndpoint = async () => true;
  const events = []; manager.on('state', (event) => events.push(event.event));
  const state = await manager.refresh();
  assert.equal(state.devices[0].lastState, 'device');
  // Simulate disappearance and let the same manager's discovery return empty.
  manager.adb.devices = async () => [];
  const disconnected = await manager.refresh();
  assert.equal(disconnected.devices[0].lastState, 'reconnect-advisory');
  assert.ok(events.includes('reconnect-advisory'));
  await manager.connect({ address: '192.168.1.8:5555' });
  assert.equal(manager.selectedSerial, '192.168.1.8:5555');
});

test('scrcpy session builds a bounded Windows command and stops cleanly', async () => {
  let command = null; let exited = null;
  const session = new ScrcpySession({
    scrcpyPath: 'scrcpy.exe',
    spawnImpl: (_path, args) => { command = args; const child = { pid: 1, stderr: { on() {} }, once(event, cb) { if (event === 'error') this.error = cb; if (event === 'exit') this.exit = cb; }, on() {}, kill() { exited = true; setImmediate(() => this.exit?.(0, null)); } }; return child; }
  });
  const started = await session.start({ serial: 'd', maxFps: 60, maxSize: 1920, audio: false });
  assert.equal(started.state, 'running');
  assert.ok(command.includes('--serial') && command.includes('d'));
  assert.ok(command.includes('--max-fps') && command.includes('60'));
  assert.ok(command.includes('--no-audio'));
  await session.stop(); assert.equal(exited, true);
});

test('agent exposes typed android tools, batching, and CLI parity', async () => {
  const defs = toolDefinitions('test the Android app on a connected phone', 'browser', {});
  assert.ok(defs.some((tool) => tool.name === 'android_devices'));
  assert.ok(defs.some((tool) => tool.name === 'android_adb'));
  const adbSchema = openAiToolSchemas(defs).find((tool) => tool.function.name === 'android_adb').function.parameters;
  assert.equal(adbSchema.properties.args.type, 'array', 'the model receives args[] as an array instead of a prose string');
  assert.equal(adbSchema.properties.commands.maxItems, 32, 'the model can batch up to 32 ordered ADB commands');
  const api = createCliAndroidApi({ records: [{ serial: 'd', label: 'Test phone', lastState: 'device' }] });
  const state = await api.execute('android_devices', { action: 'list' });
  assert.equal(state.devices[0].serial, 'd');
  await api.manager.close();
});

test('Android batches reject oversized input and report unexecuted tails', async () => {
  const { AndroidDeviceManager } = require('../desktop/android/androidDeviceManager.cjs');
  const manager = new AndroidDeviceManager();
  await assert.rejects(() => manager.batchCommand({ commands: Array.from({ length: 33 }, () => ({ args: ['devices'] })) }), /at most 32/);
  manager.adb = { command: async () => ({ ok: false, exitCode: 1, stderr: 'failed' }) };
  const result = await manager.batchCommand({ commands: [{ args: ['bad'] }, { args: ['never'] }] });
  assert.equal(result.ok, false);
  assert.equal(result.unexecuted.length, 1);
  assert.equal(result.stopReason, 'command failed');
});

test('failed Android batches propagate as failed outer tool results', async () => {
  const controller = { listTabs: () => [{ id: 't' }], getSelectedTabId: () => 't', requireTab: (id) => ({ id: id || 't' }) };
  const run = { tabId: 't', loopState: { consecutiveWaits: 0, lastWaitedMs: 0 }, androidApi: { execute: async () => ({ ok: false, count: 1, results: [{ ok: false, error: 'failed command' }], unexecuted: [] }) } };
  const result = await executeAction(controller, run, { name: 'android_adb', input: { commands: [{ args: ['shell', 'false'] }] } });
  assert.equal(result.ok, false);
  assert.match(result.error, /failed command|Android android_adb failed/);
});
