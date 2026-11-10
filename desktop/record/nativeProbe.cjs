'use strict';

// Record-mode native probe. A forked child (same isolation rationale as
// computer/nativeWorker.cjs: an FFI fault must never kill Electron main) that
// runs one cheap 30 Hz user32 poll loop and emits BATCHED input metadata:
//
//   - mouse click/scroll-button edges with pointer position (GetAsyncKeyState
//     edge detection — no low-level hooks, nothing injected)
//   - keystroke COUNTS only, plus a small set of named structural keys
//     (Enter/Tab/Escape). Typed content is never captured.
//   - foreground window/app changes (handle + title)
//
// Emission is batched every 400 ms so IPC cost stays flat regardless of input
// cadence. The parent protocol is one-way streaming ({ record: [...] }) with a
// single request: { start } / { stop }.

if (process.platform !== 'win32') process.exit(0);

const koffi = require('koffi');
const user = koffi.load('user32.dll');
const api = signature => user.func(signature);
const keyState = api('int16_t __stdcall GetAsyncKeyState(int key)');
const getCursor = api('bool __stdcall GetCursorPos(void *point)');
const getForeground = api('uintptr_t __stdcall GetForegroundWindow()');
const isVisible = api('bool __stdcall IsWindowVisible(uintptr_t window)');
const getText = api('int __stdcall GetWindowTextW(uintptr_t window, void *text, int length)');
koffi.struct('RecordPoint', { x: 'int32_t', y: 'int32_t' });
const windowFromPoint = api('uintptr_t __stdcall WindowFromPoint(RecordPoint point)');
try { api('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')(-4); } catch {}

const POLL_MS = 33;          // ~30 Hz: far below human event cadence needs.
const BATCH_MS = 400;

// Structural keys that carry intent on their own; everything else is counted.
const NAMED_KEYS = { 13: 'Enter', 9: 'Tab', 27: 'Escape' };
// 0x01..0x06 (mouse buttons + invalid), 0x07 undefined, 0x0A/0x0B reserved —
// scan the meaningful VK range only.
const KEY_SCAN_MIN = 8;
const KEY_SCAN_MAX = 254;
const TRACKED_BUTTONS = [
  { vk: 0x01, name: 'left' },
  { vk: 0x02, name: 'right' },
  { vk: 0x04, name: 'middle' },
  { vk: 0x05, name: 'x1' },
  { vk: 0x06, name: 'x2' }
];

const prevButtons = new Map();  // vk -> boolean held
const prevKeys = new Uint8Array(256); // 1 = held last sample
const pending = [];
let running = false;
let pollTimer = null;
let batchTimer = null;
let lastForeground = null;
let lastTitle = '';
const cursor = Buffer.alloc(8);
const titleBuffer = Buffer.alloc(1024);
const pidBuffer = Buffer.alloc(4);

function cursorPoint() {
  if (!getCursor(cursor)) return null;
  return { x: cursor.readInt32LE(), y: cursor.readInt32LE(4) };
}

function windowTitle(handle) {
  const length = getText(handle, titleBuffer, 512);
  return length > 0 ? titleBuffer.toString('utf16le', 0, length * 2) : '';
}

function foregroundEvent(now, point) {
  const handle = getForeground();
  const handleString = String(handle);
  if (handleString === lastForeground) return null;
  const previous = lastForeground;
  lastForeground = handleString;
  const title = isVisible(handle) ? windowTitle(handle) : '';
  const changed = { type: 'app_switch', windowId: handleString, title, at: now };
  if (point) changed.x = point.x;
  if (point) changed.y = point.y;
  void previous;
  return changed;
}

function titleEvent(now) {
  if (!lastForeground) return null;
  const handle = BigInt(lastForeground);
  if (!isVisible(handle)) return null;
  const title = windowTitle(handle);
  if (title === lastTitle) return null;
  lastTitle = title;
  return { type: 'window_title', title, at: now };
}

function sample(now) {
  const events = [];
  const point = cursorPoint();
  const foreground = foregroundEvent(now, point);
  if (foreground) {
    lastTitle = foreground.title;
    events.push(foreground);
  } else {
    const title = titleEvent(now);
    if (title) events.push(title);
  }

  for (const button of TRACKED_BUTTONS) {
    const state = keyState(button.vk);
    const held = (state & 0x8000) !== 0;
    const wasHeld = prevButtons.get(button.vk) === true;
    // GetAsyncKeyState LSB: the key was pressed after the previous call — this
    // catches click down+up inside one sample period.
    const pressedSinceLastCall = (state & 0x0001) !== 0;
    if ((held && !wasHeld) || pressedSinceLastCall) {
      const event = { type: 'click', button: button.name, at: now };
      if (point) { event.x = point.x; event.y = point.y; }
      events.push(event);
    }
    prevButtons.set(button.vk, held);
  }

  let keystrokes = 0;
  const named = [];
  for (let vk = KEY_SCAN_MIN; vk <= KEY_SCAN_MAX; vk += 1) {
    const state = keyState(vk);
    const held = (state & 0x8000) !== 0;
    const wasHeld = prevKeys[vk] === 1;
    if ((held && !wasHeld) || (state & 0x0001) !== 0) {
      keystrokes += 1;
      const name = NAMED_KEYS[vk];
      if (name) named.push(name);
    }
    prevKeys[vk] = held ? 1 : 0;
  }
  if (keystrokes > 0) {
    const event = { type: 'keys', count: keystrokes, at: now };
    if (named.length) event.keys = named;
    if (point) { event.x = point.x; event.y = point.y; }
    events.push(event);
  }
  return events;
}

function flush() {
  if (!pending.length) return;
  process.send({ record: pending.splice(0, pending.length) });
}

function start() {
  if (running) return;
  running = true;
  pollTimer = setInterval(() => {
    try {
      const events = sample(Date.now());
      if (events.length) pending.push(...events);
    } catch { /* a transient FFI error must not stop the loop */ }
  }, POLL_MS);
  batchTimer = setInterval(flush, BATCH_MS);
}

function stop() {
  running = false;
  clearInterval(pollTimer); clearInterval(batchTimer);
  pollTimer = batchTimer = null;
  flush();
  process.send({ recordStopped: true });
}

process.on('message', (message) => {
  if (message?.start) start();
  if (message?.stop) stop();
  if (message?.die) process.exit(0);
});
process.on('disconnect', () => process.exit(0));
