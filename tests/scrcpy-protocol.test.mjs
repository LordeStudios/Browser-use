import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const p = require('../desktop/android/scrcpyProtocol.cjs');

test('Android stream opens a real Browser-use tab with a stream preload by default', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  assert.match(main, /androidStreamPageUrl/);
  assert.match(main, /androidStreamPreload\.cjs/);
  assert.match(main, /streamRenderer: settings\.androidStreamRenderer \|\| 'tab'/);
  assert.match(main, /onStreamTab: \(\{ serial, title \}\) => openAndroidStreamTab/);
  assert.match(main, /androidStreamRenderer \|\| 'tab'/);
  assert.match(require('node:fs').readFileSync(require('node:path').join(process.cwd(), 'desktop/android/scrcpyTunnel.cjs'), 'utf8'), /reverseName/);
  const html = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/androidStream.html'), 'utf8');
  assert.match(html, /<canvas[^>]*role="application"/);
});

test('scrcpy 5.0.1 protocol pins server argv and H264 flags', () => {
  const args = p.buildServerArgs({ scid: 0x1234, maxSize: 1280, maxFps: 30, bitrate: 8_000_000 });
  assert.equal(args[0], '5.0.1');
  assert.equal(args.includes('tunnel_forward=true'), false, 'default in-tab transport uses adb reverse and server socket connect');
  assert.ok(args.includes('scid=00001234'));
  assert.ok(args.includes('video_codec=h264'));
  assert.ok(args.includes('audio=false'));
  assert.equal(p.PACKET_FLAG_CONFIG, 1n << 62n);
  assert.equal(p.PACKET_FLAG_KEY_FRAME, 1n << 61n);
});

test('scrcpy metadata/frame parser consumes big-endian layout', () => {
  const name = Buffer.alloc(64); Buffer.from('SM-G991U').copy(name);
  assert.deepEqual(p.parseDeviceMeta(name), { name: 'SM-G991U', consumed: 64 });
  const stream = Buffer.alloc(12); stream.writeUInt32BE(0x80000001, 0); stream.writeUInt32BE(1080, 4); stream.writeUInt32BE(2400, 8);
  assert.deepEqual(p.parseStreamMeta(stream), { width: 1080, height: 2400, clientResize: true, consumed: 12 });
  const meta = Buffer.alloc(12); meta.writeBigUInt64BE((1n << 61n) | 123n, 0); meta.writeUInt32BE(4, 8);
  assert.deepEqual(p.parseFrameMeta(meta), { pts: 123, config: false, keyFrame: true, size: 4, consumed: 12 });
});

test('Annex-B config converts to WebCodecs AVC description and length-prefixed frames', () => {
  const sps = Buffer.from([0,0,0,1,0x67,0x42,0,0x1e,0x88]);
  const pps = Buffer.from([0,0,0,1,0x68,0xce,0x06,0xe2]);
  const config = p.avcDecoderConfigFromAnnexB(Buffer.concat([sps, pps]));
  assert.equal(config[0], 1);
  assert.deepEqual(p.splitAnnexB(Buffer.concat([sps, pps])).map((x) => x[0]), [0x67, 0x68]);
  const frame = p.annexBToLengthPrefixed(Buffer.from([0,0,1,0x65,1,2,3]));
  assert.equal(frame.readUInt32BE(0), 4);
  assert.deepEqual([...frame.subarray(4)], [0x65,1,2,3]);
});

test('scrcpy control messages encode exact v5.0.1 touch/key/text sizes', () => {
  const key = p.encodeKey({ action: 0, keycode: 66, repeat: 0, metaState: 0 });
  assert.equal(key.length, 14); assert.equal(key[0], 0);
  const text = p.encodeText('hello');
  assert.equal(text.readUInt32BE(1), 5); assert.equal(text.subarray(5).toString(), 'hello');
  const touch = p.encodeTouch({ action: p.TOUCH.DOWN, pointerId: 1, x: 10, y: 20, width: 1080, height: 2400, pressure: 1 });
  assert.equal(touch.length, 32); assert.equal(touch[0], 2); assert.equal(touch.readBigInt64BE(2), 1n);
});
