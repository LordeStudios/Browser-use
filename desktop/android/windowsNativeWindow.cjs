'use strict';

const koffi = require('koffi');

if (process.platform !== 'win32') {
  module.exports = { available: false, findByTitle: async () => null, embed: () => ({ embedded: false, reason: 'Windows only' }), setBounds: () => ({ embedded: false, reason: 'Windows only' }), detach: () => ({ embedded: false, reason: 'Windows only' }) };
} else {
  const user = koffi.load('user32.dll');
  const api = (signature) => user.func(signature);
  const FindWindowW = api('uintptr_t __stdcall FindWindowW(const wchar_t *className, const wchar_t *windowName)');
  const SetParent = api('uintptr_t __stdcall SetParent(uintptr_t child, uintptr_t parent)');
  const GetWindowLongPtrW = api('intptr_t __stdcall GetWindowLongPtrW(uintptr_t window, int index)');
  const SetWindowLongPtrW = api('intptr_t __stdcall SetWindowLongPtrW(uintptr_t window, int index, intptr_t value)');
  const SetWindowPos = api('bool __stdcall SetWindowPos(uintptr_t window, uintptr_t insertAfter, int x, int y, int width, int height, uint32_t flags)');
  const ShowWindow = api('bool __stdcall ShowWindow(uintptr_t window, int command)');
  const IsWindow = api('bool __stdcall IsWindow(uintptr_t window)');
  const SW_SHOW = 5;
  const SWP_NOACTIVATE = 0x0010;
  const SWP_SHOWWINDOW = 0x0040;
  const GWL_STYLE = -16;
  const WS_CHILD = 0x40000000;
  const WS_CAPTION = 0x00c00000;
  const WS_THICKFRAME = 0x00040000;
  const WS_SYSMENU = 0x00080000;
  const WS_MINIMIZEBOX = 0x00020000;
  const WS_MAXIMIZEBOX = 0x00010000;
  const WS_POPUP = 0x80000000;
  const NULL = 0;

  function handleFromElectron(windowHandle) {
    if (Buffer.isBuffer(windowHandle)) return windowHandle.length >= 8 ? windowHandle.readBigUInt64LE(0) : BigInt(windowHandle.readUInt32LE(0));
    return BigInt(String(windowHandle || '0'));
  }

  async function findByTitle(title, { timeoutMs = 5_000, pollMs = 50 } = {}) {
    const target = String(title || '');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const handle = FindWindowW(null, target);
      if (handle && IsWindow(handle)) return String(handle);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return null;
  }

  function embed({ childHandle, parentHandle, x = 0, y = 0, width = 1, height = 1 }) {
    const child = BigInt(String(childHandle));
    const parent = handleFromElectron(parentHandle);
    if (!IsWindow(child) || !IsWindow(parent)) throw new Error('Cannot embed Android stream: native window handle is no longer valid.');
    const priorStyle = Number(GetWindowLongPtrW(child, GWL_STYLE));
    const nextStyle = (priorStyle | WS_CHILD) & ~(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_POPUP);
    SetWindowLongPtrW(child, GWL_STYLE, nextStyle);
    SetParent(child, parent);
    SetWindowPos(child, NULL, Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), SWP_NOACTIVATE | SWP_SHOWWINDOW);
    ShowWindow(child, SW_SHOW);
    return { embedded: true, childHandle: String(child), parentHandle: String(parent), bounds: { x, y, width, height } };
  }

  function setBounds({ childHandle, x = 0, y = 0, width = 1, height = 1 }) {
    const child = BigInt(String(childHandle));
    if (!IsWindow(child)) return { embedded: false, reason: 'Android stream window has exited.' };
    SetWindowPos(child, NULL, Math.round(x), Math.round(y), Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), SWP_NOACTIVATE | SWP_SHOWWINDOW);
    return { embedded: true, childHandle: String(child), bounds: { x, y, width, height } };
  }

  function detach({ childHandle }) {
    const child = BigInt(String(childHandle));
    if (!IsWindow(child)) return { detached: false };
    SetParent(child, NULL);
    return { detached: true, childHandle: String(child) };
  }

  module.exports = { available: true, findByTitle, embed, setBounds, detach };
}
