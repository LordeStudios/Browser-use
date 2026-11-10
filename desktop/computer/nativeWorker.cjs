'use strict';

// Native calls live outside Electron main so a driver/FFI fault cannot kill it.
const koffi = require('koffi');
const { pointerGuard, runStrokes } = require('./pointerGesture.cjs');
if (process.platform !== 'win32') throw new Error('Native computer input currently requires Windows.');
const user = koffi.load('user32.dll');
const api = signature => user.func(signature);
const metric = api('int __stdcall GetSystemMetrics(int)');
const getCursor = api('bool __stdcall GetCursorPos(void *point)');
const sendInput = api('uint32_t __stdcall SendInput(uint32_t count, void *inputs, int size)');
const getForeground = api('uintptr_t __stdcall GetForegroundWindow()');
koffi.struct('ComputerPoint', { x: 'int32_t', y: 'int32_t' });
const windowFromPoint = api('uintptr_t __stdcall WindowFromPoint(ComputerPoint point)');
const getAncestor = api('uintptr_t __stdcall GetAncestor(uintptr_t window, uint32_t flags)');
const getWindow = api('uintptr_t __stdcall GetWindow(uintptr_t window, uint32_t command)');
const keyState = api('int16_t __stdcall GetAsyncKeyState(int key)');
const isWindow = api('bool __stdcall IsWindow(uintptr_t window)');
const isVisible = api('bool __stdcall IsWindowVisible(uintptr_t window)');
const getText = api('int __stdcall GetWindowTextW(uintptr_t window, void *text, int length)');
// LORDE_NATIVE_SURFACE_AWARENESS_V365 — the window class is the OS's own
// generic dialog signal: file open/save, print, and common dialogs are all
// #32770. No app names, purely window semantics.
const getClassName = api('int __stdcall GetClassNameW(uintptr_t window, void *text, int length)');
const getRect = api('bool __stdcall GetWindowRect(uintptr_t window, void *rect)');
const getPid = api('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t window, void *pid)');
const enumChildWindows = api('bool __stdcall EnumChildWindows(uintptr_t window, void *callback, intptr_t data)');
const foreground = api('bool __stdcall SetForegroundWindow(uintptr_t window)');
const attachInput = api('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)');
const currentThread = koffi.load('kernel32.dll').func('uint32_t __stdcall GetCurrentThreadId()');
const show = api('bool __stdcall ShowWindow(uintptr_t window, int command)');
const minimized = api('bool __stdcall IsIconic(uintptr_t window)');
// The harness's OWN windows. This worker is forked by the Electron main
// process, so process.ppid IS that process, and every BrowserWindow the app
// owns is created in it — the app's own window and the agent-pointer overlay
// both report that pid (verified: the app window showed pid == the Electron
// main pid).
//
// The harness is not a target. A key sent to it is read by the harness UI,
// and the app binds Escape to "stop the active run" — so a model that focused
// the harness's own pointer panel and pressed ESC to close it STOPPED THE RUN
// it was working in (2026-10-31). The model cannot tell the harness from an
// app: the window inventory lists both, side by side.
const OWN_PID = Number(process.ppid) || 0;
function ownWindow(handle) {
  if (!OWN_PID || !handle) return false;
  const pid = Buffer.alloc(4);
  try { getPid(handle, pid); } catch { return false; }
  return pid.readUInt32LE(0) === OWN_PID;
}
function ownWindowTitle(handle) {
  const title = Buffer.alloc(512);
  try { getText(handle, title, 512); } catch { return ''; }
  return title.toString('utf16le').replace(/\0.*$/, '').trim();
}
// DWMWA_CLOAKED: shell/UWP infrastructure windows (input experience, shell
// hosts, suspended apps) report IsWindowVisible=true while being invisible on
// screen. The cloak attribute is the OS's own generic signal — no app names,
// purely window semantics. Filtering them keeps the window inventory focused
// on real, perceivable app surfaces.
const dwmGetWindowAttribute = koffi.load('dwmapi.dll').func('int32_t __stdcall DwmGetWindowAttribute(uintptr_t window, uint32_t attribute, void *value, uint32_t size)');
const cloakValue = Buffer.alloc(4);
function isCloaked(handle) {
  try {
    if (dwmGetWindowAttribute(handle, 14, cloakValue, 4) === 0) return cloakValue.readUInt32LE(0) !== 0;
  } catch { /* pre-Vista path or driver refusal: treat as not cloaked */ }
  return false;
}
try { api('intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)')(-4); } catch {}
const callbackType = koffi.proto('bool __stdcall ComputerWindowCallback(uintptr_t window, intptr_t data)');
const enumerate = api('bool __stdcall EnumWindows(ComputerWindowCallback *callback, intptr_t data)');
const stride = process.arch === 'ia32' ? 28 : 40;
const unionOffset = process.arch === 'ia32' ? 4 : 8;
const generations = new Map();
const heldKeys = new Map();
const heldButtons = new Map();
let queue = Promise.resolve();
let queued = 0;
const generation = owner => generations.get(owner) || 0;
function current(owner, epoch) { if (generation(owner) !== epoch) throw new Error('Computer operation cancelled.'); }
function input(type, values) {
  const b = Buffer.alloc(stride); b.writeUInt32LE(type);
  if (type === 1) {
    b.writeUInt16LE(values.vk || 0, unionOffset); b.writeUInt16LE(values.scan || 0, unionOffset + 2); b.writeUInt32LE(values.flags || 0, unionOffset + 4);
  } else {
    b.writeInt32LE(values.x || 0, unionOffset); b.writeInt32LE(values.y || 0, unionOffset + 4);
    b.writeUInt32LE((values.data || 0) >>> 0, unionOffset + 8); b.writeUInt32LE(values.flags, unionOffset + 12);
  }
  return b;
}
function send(events) {
  if (!events.length) return;
  const count = sendInput(events.length, Buffer.concat(events), stride);
  if (count !== events.length) throw new Error(`Windows accepted ${count}/${events.length} input events. Check desktop focus and OS integrity permissions.`);
}
function bounds() { return { x: metric(76), y: metric(77), width: metric(78), height: metric(79) }; }
function move(x, y, preserveVertex = false) {
  const b = bounds();
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < b.x || y < b.y || x >= b.x + b.width || y >= b.y + b.height) throw new Error('Pointer coordinates must be inside the physical virtual desktop.');
  send([input(0, { x: Math.round((x - b.x) * 65535 / Math.max(1, b.width - 1)), y: Math.round((y - b.y) * 65535 / Math.max(1, b.height - 1)), flags: 0xC001 | (preserveVertex ? 0x2000 : 0) })]);
}
const BUTTONS = { left: [2, 4], right: [8, 16], middle: [32, 64] };
function button(owner, name, down) {
  if (!BUTTONS[name]) throw new Error('Unknown mouse button.');
  const holder = heldButtons.get(name);
  if (holder && holder !== owner) throw new Error('Another computer session holds this mouse button.');
  if (down && holder === owner) return;
  if (down && !holder && (keyState({ left: 1, right: 2, middle: 4 }[name]) & 0x8000)) throw new Error('The mouse button is already held outside this session.');
  if (!down && !holder) return;
  send([input(0, { flags: BUTTONS[name][down ? 0 : 1] })]);
  if (down) heldButtons.set(name, owner); else heldButtons.delete(name);
}
const KEYS = { control: 17, ctrl: 17, shift: 16, alt: 18, win: 91, meta: 91, command: 91, enter: 13, return: 13, tab: 9, escape: 27, esc: 27, backspace: 8, delete: 46, insert: 45, space: 32, home: 36, end: 35, pageup: 33, pagedown: 34, arrowleft: 37, left: 37, arrowup: 38, up: 38, arrowright: 39, right: 39, arrowdown: 40, down: 40, capslock: 20, printscreen: 44, pause: 19, numlock: 144, scrolllock: 145, plus: 187, minus: 189, comma: 188, period: 190, slash: 191, backslash: 220, semicolon: 186, quote: 222, bracketleft: 219, bracketright: 221, backquote: 192 };
function keyCode(name) {
  const k = String(name || '').toLowerCase();
  if (KEYS[k]) return KEYS[k];
  if (/^[a-z0-9]$/.test(k)) return k.toUpperCase().charCodeAt(0);
  if (/^f(?:[1-9]|1\d|2[0-4])$/.test(k)) return 111 + Number(k.slice(1));
  if (/^numpad\d$/.test(k)) return 96 + Number(k.at(-1));
  throw new Error(`Unknown key ${name}; use action=text for arbitrary Unicode text.`);
}
function key(owner, vk, down) {
  const holder = heldKeys.get(vk);
  if (holder && holder !== owner) throw new Error('Another computer session holds this key.');
  if (down && holder === owner || !down && !holder) return;
  if (down && !holder && (keyState(vk) & 0x8000)) throw new Error('This key is already held outside the computer session.');
  const extended = [33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 91, 92].includes(vk) ? 1 : 0;
  send([input(1, { vk, flags: extended | (down ? 0 : 2) })]);
  if (down) heldKeys.set(vk, owner); else heldKeys.delete(vk);
}
function release(owner) {
  generations.set(owner, generation(owner) + 1);
  const errors = [];
  for (const [vk, holder] of heldKeys) if (holder === owner) { try { key(owner, vk, false); } catch (e) { errors.push(e.message); } }
  for (const [name, holder] of heldButtons) if (holder === owner) { try { button(owner, name, false); } catch (e) { errors.push(e.message); } }
  if (errors.length) throw new Error(errors.join('; '));
  return { released: true };
}
function windowInfo(handle) {
  const text = Buffer.alloc(1024), rect = Buffer.alloc(16), pid = Buffer.alloc(4), cls = Buffer.alloc(512);
  const length = getText(handle, text, 512);
  if (!length || !getRect(handle, rect)) return null;
  getPid(handle, pid);
  const classLength = getClassName(handle, cls, 256);
  return { id: String(handle), title: text.toString('utf16le', 0, length * 2), className: classLength > 0 ? cls.toString('utf16le', 0, classLength * 2) : '', pid: pid.readUInt32LE(), bounds: { x: rect.readInt32LE(0), y: rect.readInt32LE(4), width: rect.readInt32LE(8) - rect.readInt32LE(0), height: rect.readInt32LE(12) - rect.readInt32LE(4) }, minimized: minimized(handle), own: ownWindow(handle) };
}
// LORDE_NATIVE_WINDOW_CONTRACT_STOP: an active popup (native menu, Electron
// menu, dropdown) is a separate HWND owned by its target window, not a foreign
// app. Accept a hit whose owner chain reaches the target, whatever its class.
// Chromium hosts its popups as children of a shared hidden window, so the
// covering root itself may be owned by nothing; its visible children decide.
function ownsActiveMenu(targetId, hitId) {
  // Koffi may return uintptr_t values as Number or BigInt depending on the
  // value; compare handles as strings, never by identity across types.
  const target = String(targetId), hit = BigInt(hitId);
  const owner = String(getAncestor(hit, 3) || getWindow(hit, 4));
  if (owner === target || String(getWindow(BigInt(owner), 4)) === target) return true;
  let owned = false;
  const cb = koffi.register(child => {
    if (String(getWindow(child, 4)) === target || String(getAncestor(child, 3)) === target) owned = true;
    return !owned;
  }, koffi.pointer(callbackType));
  try { enumChildWindows(hit, cb, 0); } finally { koffi.unregister(cb); }
  return owned;
}
function observe() {
  const windows = [];
  const cb = koffi.register(handle => { if (isVisible(handle) && !isCloaked(handle)) { const info = windowInfo(handle); if (info) windows.push(info); } return windows.length < 150; }, koffi.pointer(callbackType));
  try { enumerate(cb, 0); } finally { koffi.unregister(cb); }
  const point = Buffer.alloc(8); getCursor(point);
  return { coordinateSpace: 'physical-desktop-pixels', virtualDesktop: bounds(), foregroundWindowId: String(getForeground()), pointer: { x: point.readInt32LE(), y: point.readInt32LE(4) }, windows };
}
async function execute(name, args, owner, epoch) {
  current(owner, epoch);
  if (name === 'computer_observe' || name === 'computer_window' && args.action === 'list') return observe();
  if ([...heldKeys.values(), ...heldButtons.values()].some(holder => holder !== owner)) throw new Error('Another computer session has an unfinished input sequence.');
  if (name === 'computer_pointer' && args.action === 'drag' && (!Number.isFinite(args.endX) || !Number.isFinite(args.endY))) throw new Error('Drag requires finite endX and endY.');
  if (name === 'computer_window') {
    if (!/^\d+$/.test(args.windowId || '')) throw new Error('Use a windowId returned by computer_observe.');
    const handle = BigInt(args.windowId);
    if (!isWindow(handle)) throw new Error('The requested window no longer exists.');
    // Focusing the harness's own window brings the harness UI to the
    // foreground, where the NEXT key press is read by the app instead of the
    // target app. That is how a model closing "the pointer panel" stopped its
    // own run. The harness is never a target window.
    if (ownWindow(handle)) {
      const title = ownWindowTitle(handle);
      throw new Error(`Window ${args.windowId}${title ? ` ("${title}")` : ''} is the Browser-use harness itself, not an app to drive. Do not focus it and do not send it keys — the harness reads its own keys (Escape stops the run). Focus the app you actually mean with computer_window, using a windowId from computer_observe that is not Browser-use.`);
    }
    if (minimized(handle)) show(handle, 9);
    foreground(handle);
    // Foreground activation is delivered through another thread's queue. Never
    // equate the immediate return with the target already receiving keyboard input.
    if (String(getForeground()) !== String(handle) && !heldKeys.size && !heldButtons.size) {
      const own = currentThread(), attached = [];
      try {
        for (const thread of new Set([getPid(getForeground(), null), getPid(handle, null)])) {
          if (thread && thread !== own && attachInput(own, thread, true)) attached.push(thread);
        }
        foreground(handle);
      } finally { for (const thread of attached.reverse()) attachInput(own, thread, false); }
    }
    for (let attempt = 0; attempt < 10 && String(getForeground()) !== String(handle); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 30)); current(owner, epoch);
    }
    if (String(getForeground()) !== String(handle)) throw new Error('Windows did not grant foreground focus to this window. Use a visible native click to focus it or check OS permissions.');
    return { focused: true, window: windowInfo(handle) };
  }
  if (name === 'computer_keyboard') {
    // A key press goes to the FOREGROUND window. If that window is the
    // harness itself, the app reads the key as its own: Escape stops the
    // active run, and typing lands in the agent's own composer. That is not
    // a target the model meant to reach, so refuse it and say why.
    {
      const front = getForeground();
      if (ownWindow(front)) {
        const title = ownWindowTitle(front);
        throw new Error(`The foreground window${title ? ` ("${title}")` : ''} is the Browser-use harness itself. Keys sent there are read by the harness (Escape stops the run). Focus the app you mean first with computer_window, then send the key.`);
      }
    }
    if (args.action === 'text') {
      if (typeof args.text !== 'string') throw new Error('Text is required.');
      for (let offset = 0; offset < args.text.length; offset += 128) {
        current(owner, epoch);
        const events = [];
        for (let i = offset; i < Math.min(args.text.length, offset + 128); i++) {
          const scan = args.text.charCodeAt(i); events.push(input(1, { scan, flags: 4 }), input(1, { scan, flags: 6 }));
        }
        send(events); await new Promise(r => setImmediate(r));
      }
      return { insertedCharacters: args.text.length };
    }
    const codes = String(args.key || '').split('+').map(keyCode);
    if (codes.length > 8) throw new Error('A key chord supports at most eight keys.');
    const acquired = [];
    try {
      for (const vk of args.action === 'up' ? [...codes].reverse() : codes) {
        const alreadyHeld = heldKeys.get(vk) === owner;
        key(owner, vk, args.action !== 'up');
        if (!alreadyHeld && args.action !== 'up') acquired.push(vk);
      }
    } catch (error) {
      for (const vk of acquired.reverse()) { try { key(owner, vk, false); } catch {} }
      throw error;
    } finally {
      if (args.action === 'press') for (const vk of acquired.reverse()) key(owner, vk, false);
    }
    return { dispatched: true, action: args.action };
  }
  const nameButton = args.button || 'left';
  const guard = pointerGuard(args, bounds(), {
    windowInfo: id => windowInfo(BigInt(id)),
    foregroundWindowId: () => String(getForeground()),
    ownsActiveMenu,
    windowAt: point => String(getAncestor(windowFromPoint({ x: Math.round(point.x), y: Math.round(point.y) }), 2))
  });
  const guardedMove = (x, y, preserveVertex = false) => { current(owner, epoch); guard({ x, y }); move(x, y, preserveVertex); };
  guard();
  if (args.action === 'stroke') {
    if (heldButtons.size) throw new Error('Release held mouse buttons before a stroke batch.');
    return runStrokes(args, {
      check: point => { current(owner, epoch); guard(point); },
      move: point => move(point.x, point.y, true),
      button: down => button(owner, nameButton, down)
    });
  }
  if (args.action === 'scroll') {
    if (args.x !== undefined || args.y !== undefined) guardedMove(args.x, args.y);
    else if (args.windowId) {
      const point = Buffer.alloc(8);
      if (!getCursor(point)) throw new Error('Windows could not report the pointer position.');
      guard({ x: point.readInt32LE(), y: point.readInt32LE(4) });
    }
    const events = [];
    if (args.deltaY) events.push(input(0, { data: -Math.round(args.deltaY), flags: 0x800 }));
    if (args.deltaX) events.push(input(0, { data: Math.round(args.deltaX), flags: 0x1000 }));
    send(events); return { dispatched: true };
  }
  guardedMove(args.x, args.y);
  if (args.action === 'move') return { dispatched: true, x: args.x, y: args.y };
  if (args.action === 'up' || args.action === 'down') { button(owner, nameButton, args.action === 'down'); return { dispatched: true }; }
  if (heldButtons.has(nameButton)) throw new Error('Release the held button before a click or drag.');
  button(owner, nameButton, true);
  try {
    if (args.action === 'drag') {
      const duration = Math.min(10_000, Math.max(0, args.durationMs ?? 300)), steps = Math.max(1, Math.ceil(duration / 16));
      for (let i = 1; i <= steps; i++) {
        await new Promise(r => setTimeout(r, duration / steps)); current(owner, epoch);
        guardedMove(args.x + (args.endX - args.x) * i / steps, args.y + (args.endY - args.y) * i / steps);
      }
    }
  } finally { button(owner, nameButton, false); }
  return { dispatched: true, action: args.action };
}
function reply(id, result, error) { if (process.connected) process.send({ id, ...(error ? { error: error.message } : { result }) }); }
process.on('message', ({ id, name, input: args = {}, owner = '' }) => {
  if (name === 'release') { try { reply(id, release(owner)); } catch (error) { reply(id, null, error); } return; }
  if (queued >= 64) { reply(id, null, new Error('Native input queue is full; wait for outstanding actions.')); return; }
  const epoch = generation(owner); queued++;
  queue = queue.then(() => execute(name, args, owner, epoch)).then(result => reply(id, result), error => reply(id, null, error)).finally(() => { queued--; });
});
process.on('disconnect', () => {
  for (const owner of new Set([...heldKeys.values(), ...heldButtons.values()])) { try { release(owner); } catch {} }
  process.exit(0);
});
