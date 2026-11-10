'use strict';

const { execFileSync } = require('child_process');

// Prefer PowerShell 7 (pwsh) when installed: UTF-8 without a BOM by default,
// && / || pipeline chains, and a side-by-side install that can never break
// the Windows built-in. powershell.exe (5.1) remains the fallback so the
// terminal and the agent's commands never depend on an optional install.
// Same language either way — the agent prompt contract is unchanged.
function detectPwsh() {
  try {
    const found = execFileSync('where.exe', ['pwsh'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString();
    return found.split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
  } catch {
    return '';
  }
}

let cached = null;

// Pure so tests can pin the resolution without touching PATH or where.exe.
function resolveWindowsShell(resolver = detectPwsh) {
  const found = String(resolver() || '').trim();
  if (found) return found;
  const comspec = String(process.env.COMSPEC || '');
  if (comspec.toLowerCase().includes('powershell')) return comspec;
  return 'powershell.exe';
}

function defaultShell() {
  if (process.platform !== 'win32') return process.env.SHELL || '/bin/bash';
  if (!cached) cached = resolveWindowsShell();
  return cached;
}

module.exports = { defaultShell, resolveWindowsShell };
