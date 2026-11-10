'use strict';

const params = new URLSearchParams(location.search);
const canvas = document.querySelector('#screen');
const status = document.querySelector('#status');
const ctx = canvas.getContext('2d', { alpha: false });
let device = { width: 0, height: 0, name: params.get('serial') || 'Android device' };
let decoder = null;
let configured = false;
let decoded = 0;
let dropped = 0;
let firstFrameAt = 0;
let lastFrameAt = 0;
let lastReport = 0;
let inputPointer = 1;

function bytes(value) { return value instanceof Uint8Array ? value : new Uint8Array(value || []); }
function updateStatus(text) { status.textContent = text; }
function resizeCanvas() {
  if (!device.width || !device.height) return;
  const availableWidth = Math.max(1, document.documentElement.clientWidth);
  const availableHeight = Math.max(1, document.documentElement.clientHeight);
  const scale = Math.min(availableWidth / device.width, availableHeight / device.height);
  canvas.width = device.width; canvas.height = device.height;
  canvas.style.width = `${Math.max(1, Math.floor(device.width * scale))}px`;
  canvas.style.height = `${Math.max(1, Math.floor(device.height * scale))}px`;
}
function codecStringFromConfig(data) {
  const b = bytes(data);
  if (b.length >= 4 && b[0] === 1) return `avc1.${[b[1], b[2], b[3]].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  return 'avc1.42E01E';
}
function ensureDecoder(config) {
  if (!('VideoDecoder' in window)) throw new Error('This Electron build does not expose WebCodecs VideoDecoder.');
  const data = bytes(config.data);
  decoder?.close(); configured = false;
  decoder = new VideoDecoder({
    output: (frame) => { if (!firstFrameAt) firstFrameAt = performance.now(); lastFrameAt = performance.now(); ctx.drawImage(frame, 0, 0, canvas.width, canvas.height); frame.close(); decoded += 1; reportStats(); },
    error: (error) => { dropped += 1; updateStatus(`Decoder error: ${error.message || error}`); reportStats(); }
  });
  const codec = codecStringFromConfig(data);
  decoder.configure({ codec, description: data, optimizeForLatency: true, hardwareAcceleration: 'prefer-hardware' });
  configured = true;
  resizeCanvas(); updateStatus(`${device.name} · ${device.width}×${device.height} · ${codec}`);
}
function reportStats() {
  const now = performance.now(); if (now - lastReport < 500) return; lastReport = now;
  const elapsed = firstFrameAt ? Math.max(1, now - firstFrameAt) : 1;
  window.androidStream?.reportStats({ framesDecoded: decoded, dropped, fps: decoded * 1000 / elapsed, device });
}
function reportInput(event, action, extra = {}) {
  if (!device.width || !device.height) return;
  const rect = canvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * device.width / Math.max(1, rect.width);
  const y = (event.clientY - rect.top) * device.height / Math.max(1, rect.height);
  window.androidStream.sendInput({ type: 'touch', action, pointerId: inputPointer, x: Math.max(0, Math.min(device.width, Math.round(x))), y: Math.max(0, Math.min(device.height, Math.round(y))), width: device.width, height: device.height, pressure: event.pressure || 1, ...extra });
}
canvas.addEventListener('pointerdown', (event) => { event.preventDefault(); canvas.setPointerCapture?.(event.pointerId); reportInput(event, event.button === 0 ? 0 : 2, { actionButton: event.button === 0 ? 1 : 0, buttons: event.buttons || 1 }); });
canvas.addEventListener('pointermove', (event) => { if (event.buttons) { event.preventDefault(); reportInput(event, 2, { buttons: event.buttons || 1 }); } });
canvas.addEventListener('pointerup', (event) => { event.preventDefault(); reportInput(event, event.button === 0 ? 1 : 6, { actionButton: event.button === 0 ? 1 : 0, buttons: 0 }); });
window.addEventListener('keydown', (event) => { if (event.key.length === 1) window.androidStream.sendInput({ type: 'text', text: event.key }); else window.androidStream.sendInput({ type: 'key', action: 0, keycode: event.keyCode || 0, repeat: event.repeat ? 1 : 0, metaState: 0 }); });
window.addEventListener('resize', resizeCanvas);
window.__browserUseAndroidStats = () => ({ framesDecoded: decoded, dropped, fps: firstFrameAt && lastFrameAt ? decoded * 1000 / Math.max(1, lastFrameAt - firstFrameAt) : 0, device, configured });
window.androidStream.onMeta((meta) => { device = { ...device, ...meta }; resizeCanvas(); updateStatus(`${device.name || 'Android device'} · waiting for codec…`); });
window.androidStream.onCodecConfig((config) => { try { ensureDecoder(config); } catch (error) { updateStatus(`Stream unavailable: ${error.message}`); } });
window.androidStream.onFrame((frame) => {
  if (!configured || !decoder || decoder.state === 'closed') { dropped += 1; reportStats(); return; }
  try { decoder.decode(new EncodedVideoChunk({ type: frame.keyFrame ? 'key' : 'delta', timestamp: Number(frame.pts) || 0, data: bytes(frame.data) })); }
  catch (error) { dropped += 1; updateStatus(`Decode dropped: ${error.message}`); reportStats(); }
});
window.androidStream.onState((state) => { if (state?.state === 'failed') updateStatus(`Stream failed: ${state.lastError || 'unknown error'}`); else if (state?.state === 'stopped') updateStatus('Stream stopped.'); });
