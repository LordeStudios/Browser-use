import { spawn } from 'node:child_process';

const POWERSHELL_TIMEOUT_MS = 1_000;

function powershellScript(x, y) {
  return `Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class BrowserUsePointer {
  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);
}
'@
[BrowserUsePointer]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`;
}

function invokePowerShell(script) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, POWERSHELL_TIMEOUT_MS);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    child.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function moveNativePointer(browser, viewportX, viewportY) {
  if (process.platform !== 'win32') return { attempted: false, moved: false, reason: 'Native host pointer bridge is currently Windows-only.' };

  const metrics = await browser.evaluate(`({
    screenX: window.screenX,
    screenY: window.screenY,
    outerHeight: window.outerHeight,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    innerWidth: window.innerWidth
  })`).catch(() => null);
  if (!metrics) return { attempted: true, moved: false, reason: 'Browser window metrics are unavailable.' };

  const chromeTop = Math.max(0, metrics.outerHeight - metrics.innerHeight);
  const chromeLeft = Math.max(0, Math.round((metrics.outerWidth - metrics.innerWidth) / 2));
  const screenX = Math.round(metrics.screenX + chromeLeft + viewportX);
  const screenY = Math.round(metrics.screenY + chromeTop + viewportY);
  const moved = await invokePowerShell(powershellScript(screenX, screenY));
  return { attempted: true, moved, viewport: { x: viewportX, y: viewportY }, screen: { x: screenX, y: screenY } };
}
