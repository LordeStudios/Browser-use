'use strict';

// scrcpy 5.0.1 server protocol pins. Sources: Server.java, Options.java,
// DesktopConnection.java, Streamer.java, ControlMessage.java,
// ControlMessageReader.java, VideoCodec.java at Genymobile/scrcpy v5.0.1.
const SERVER_VERSION = '5.0.1';
const SOCKET_PREFIX = 'scrcpy';
const DEVICE_NAME_BYTES = 64;
const PACKET_FLAG_SESSION = 1n << 63n;
const PACKET_FLAG_CONFIG = 1n << 62n;
const PACKET_FLAG_KEY_FRAME = 1n << 61n;
const CODECS = Object.freeze({
  0x68323634: { name: 'h264', mime: 'video/avc' },
  0x68323635: { name: 'h265', mime: 'video/hevc' },
  0x00617631: { name: 'av1', mime: 'video/av01' },
  0x00767038: { name: 'vp8', mime: 'video/vp8' },
  0x00767039: { name: 'vp9', mime: 'video/vp09' }
});
const CONTROL = Object.freeze({ KEYCODE: 0, TEXT: 1, TOUCH: 2, SCROLL: 3, BACK_OR_SCREEN_ON: 4, SET_DISPLAY_POWER: 10, RESET_VIDEO: 17, RESIZE_DISPLAY: 21 });
const TOUCH = Object.freeze({ DOWN: 0, UP: 1, MOVE: 2, POINTER_DOWN: 5, POINTER_UP: 6, CANCEL: 3 });

function buildServerArgs({ scid, maxSize = 1280, maxFps = 30, bitrate = 8_000_000, codec = 'h264', tunnelForward = false } = {}) {
  if (!Number.isInteger(scid) || scid < 0 || scid > 0x7fffffff) throw new Error('scrcpy scid must be a non-negative 31-bit integer.');
  const options = [
    ...(tunnelForward ? ['tunnel_forward=true'] : []), `scid=${scid.toString(16).padStart(8, '0')}`,
    'video=true', 'audio=false', 'control=true', `video_codec=${codec}`,
    `max_size=${Math.max(0, Math.floor(Number(maxSize) || 0))}`,
    `max_fps=${Math.max(0, Number(maxFps) || 0)}`,
    `video_bit_rate=${Math.max(1, Math.floor(Number(bitrate) || 8_000_000))}`,
    'send_device_meta=true', 'send_frame_meta=true', 'send_dummy_byte=true',
    'send_stream_meta=true', 'cleanup=true', 'power_on=true', 'stay_awake=false'
  ];
  return [SERVER_VERSION, ...options];
}

function parseDeviceMeta(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < DEVICE_NAME_BYTES) throw new Error('Incomplete scrcpy device metadata.');
  const end = buffer.indexOf(0);
  return { name: buffer.subarray(0, end < 0 ? DEVICE_NAME_BYTES : end).toString('utf8'), consumed: DEVICE_NAME_BYTES };
}

function parseCodecId(id) {
  const codec = CODECS[Number(id)];
  if (!codec) throw new Error(`Unsupported scrcpy codec id: 0x${Number(id).toString(16)}`);
  return { id: Number(id), ...codec };
}

function parseStreamMeta(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('Incomplete scrcpy stream metadata.');
  const flags = buffer.readUInt32BE(0);
  if ((flags & 0x80000000) === 0) throw new Error('Invalid scrcpy session metadata flag.');
  return { width: buffer.readUInt32BE(4), height: buffer.readUInt32BE(8), clientResize: Boolean(flags & 1), consumed: 12 };
}

function parseFrameMeta(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('Incomplete scrcpy frame metadata.');
  const ptsAndFlags = buffer.readBigUInt64BE(0);
  const size = buffer.readUInt32BE(8);
  return { pts: Number(ptsAndFlags & ((1n << 61n) - 1n)), config: Boolean(ptsAndFlags & PACKET_FLAG_CONFIG), keyFrame: Boolean(ptsAndFlags & PACKET_FLAG_KEY_FRAME), size, consumed: 12 };
}

function splitAnnexB(data) {
  const buffer = Buffer.from(data || '');
  const starts = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 1) starts.push([i, 3]);
    else if (i + 4 < buffer.length && buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) starts.push([i, 4]);
  }
  if (!starts.length) return [buffer];
  return starts.map(([offset, prefix], index) => buffer.subarray(offset + prefix, index + 1 < starts.length ? starts[index + 1][0] : buffer.length)).filter((nal) => nal.length);
}

function annexBToLengthPrefixed(data) {
  const nals = splitAnnexB(data);
  const total = nals.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const out = Buffer.alloc(total); let offset = 0;
  for (const nal of nals) { out.writeUInt32BE(nal.length, offset); offset += 4; nal.copy(out, offset); offset += nal.length; }
  return out;
}

function avcDecoderConfigFromAnnexB(data) {
  const nals = splitAnnexB(data);
  const sps = nals.find((nal) => (nal[0] & 0x1f) === 7);
  const pps = nals.find((nal) => (nal[0] & 0x1f) === 8);
  if (!sps || !pps || sps.length < 4) throw new Error('H.264 config packet has no SPS/PPS.');
  const config = Buffer.alloc(11 + sps.length + pps.length);
  let offset = 0;
  config[offset++] = 1; config[offset++] = sps[1]; config[offset++] = sps[2]; config[offset++] = sps[3];
  config[offset++] = 0xff; config[offset++] = 0xe1; config.writeUInt16BE(sps.length, offset); offset += 2; sps.copy(config, offset); offset += sps.length;
  config[offset++] = 1; config.writeUInt16BE(pps.length, offset); offset += 2; pps.copy(config, offset);
  return config;
}

function writeU16Fixed(value) { return Math.max(0, Math.min(0xffff, Math.round(Number(value || 0) * 0xffff))); }
function writeU32String(value) { const data = Buffer.from(String(value || ''), 'utf8'); const out = Buffer.alloc(4 + data.length); out.writeUInt32BE(data.length, 0); data.copy(out, 4); return out; }
function writePosition({ x, y, width, height } = {}) { const out = Buffer.alloc(12); out.writeInt32BE(Math.round(Number(x) || 0), 0); out.writeInt32BE(Math.round(Number(y) || 0), 4); out.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(Number(width) || 0))), 8); out.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(Number(height) || 0))), 10); return out; }
function encodeKey({ action = 0, keycode = 0, repeat = 0, metaState = 0 } = {}) { const out = Buffer.alloc(14); out[0] = CONTROL.KEYCODE; out[1] = action; out.writeInt32BE(keycode, 2); out.writeInt32BE(repeat, 6); out.writeInt32BE(metaState, 10); return out; }
function encodeText(text) { return Buffer.concat([Buffer.from([CONTROL.TEXT]), writeU32String(text)]); }
function encodeTouch({ action = TOUCH.DOWN, pointerId = 0, x = 0, y = 0, width, height, pressure = 1, actionButton = 0, buttons = 0 } = {}) { const out = Buffer.alloc(32); out[0] = CONTROL.TOUCH; out[1] = action; out.writeBigInt64BE(BigInt(pointerId), 2); writePosition({ x, y, width, height }).copy(out, 10); out.writeUInt16BE(writeU16Fixed(pressure), 22); out.writeInt32BE(actionButton, 24); out.writeInt32BE(buttons, 28); return out; }
function encodeScroll({ x = 0, y = 0, width, height, hScroll = 0, vScroll = 0, buttons = 0 } = {}) { const out = Buffer.alloc(21); out[0] = CONTROL.SCROLL; writePosition({ x, y, width, height }).copy(out, 1); out.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(Number(hScroll || 0) / 16 * 32768))), 13); out.writeInt16BE(Math.max(-32768, Math.min(32767, Math.round(Number(vScroll || 0) / 16 * 32768))), 15); out.writeInt32BE(buttons, 17); return out; }

module.exports = { SERVER_VERSION, SOCKET_PREFIX, DEVICE_NAME_BYTES, PACKET_FLAG_SESSION, PACKET_FLAG_CONFIG, PACKET_FLAG_KEY_FRAME, CODECS, CONTROL, TOUCH, buildServerArgs, parseDeviceMeta, parseCodecId, parseStreamMeta, parseFrameMeta, splitAnnexB, annexBToLengthPrefixed, avcDecoderConfigFromAnnexB, encodeKey, encodeText, encodeTouch, encodeScroll, writePosition };
