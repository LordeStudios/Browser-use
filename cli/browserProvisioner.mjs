// cli/browserProvisioner.mjs
//
// The package carries its own browser. Instead of hoping a system Chrome exists
// (or that Android has a launchable Chromium, which it does not), Browser-use
// provisions the stripped headless shell that Playwright publishes: a Chromium
// build containing exactly what CDP and page rendering need, nothing else.
//
// It is fetched once per machine into the normal Playwright cache and then
// resolved by findChrome() ahead of any system browser, so `browser-use run`
// and `browser-use gui` work on a clean install and on Linux arm64.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Where Playwright keeps downloaded browsers on this platform. */
export function browserCacheRoot() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

/** Candidate executable names inside a downloaded build directory. */
function executableNames() {
  if (process.platform === 'win32') return ['chrome-headless-shell.exe', 'headless_shell.exe', 'chrome.exe'];
  return ['chrome-headless-shell', 'headless_shell', 'chrome'];
}

/**
 * Locate an already provisioned headless shell. Prefers the headless-shell
 * build (smallest, CDP-complete) and falls back to a full Chromium build.
 */
export function findProvisionedBrowser() {
  const root = browserCacheRoot();
  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return null;
  }
  const rank = (name) => (name.startsWith('chromium_headless_shell-') ? 0 : name.startsWith('chromium-') ? 1 : 9);
  const builds = entries
    .filter((name) => name.startsWith('chromium_headless_shell-') || name.startsWith('chromium-'))
    .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a, undefined, { numeric: true }));

  for (const build of builds) {
    const buildDir = path.join(root, build);
    let children;
    try {
      children = fs.readdirSync(buildDir);
    } catch {
      continue;
    }
    for (const child of children) {
      if (!/^chrome|^headless/.test(child)) continue;
      const childDir = path.join(buildDir, child);
      let stat;
      try {
        stat = fs.statSync(childDir);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      for (const exe of executableNames()) {
        const candidate = path.join(childDir, exe);
        if (fs.existsSync(candidate)) {
          return { path: candidate, build, root, kind: build.startsWith('chromium_headless_shell') ? 'headless-shell' : 'chromium' };
        }
      }
    }
  }
  return null;
}

/** Path of the Playwright CLI that performs the download. */
function playwrightCli() {
  const pkg = require.resolve('playwright-core/package.json');
  return path.join(path.dirname(pkg), 'cli.js');
}

/**
 * Download the bundled browser for this platform. Streams the installer output
 * so the caller can show real progress instead of a silent wait.
 */
export function installProvisionedBrowser({ onLine } = {}) {
  return new Promise((resolve, reject) => {
    let cli;
    try {
      cli = playwrightCli();
    } catch (error) {
      reject(new Error(`playwright-core is missing from this install: ${error?.message || error}`));
      return;
    }
    const child = spawn(process.execPath, [cli, 'install', 'chromium-headless-shell'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserCacheRoot() }
    });
    const feed = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed && onLine) onLine(trimmed);
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (error) => reject(new Error(`browser installer failed: ${error?.message || error}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`browser installer exited with code ${code}`));
        return;
      }
      const found = findProvisionedBrowser();
      if (!found) {
        reject(new Error('installer finished but no browser binary was found in the cache'));
        return;
      }
      resolve(found);
    });
  });
}

/** Ensure a browser exists, installing it when missing. */
export async function ensureProvisionedBrowser({ onLine, onInstallStart } = {}) {
  const existing = findProvisionedBrowser();
  if (existing) return { ...existing, installed: false };
  if (onInstallStart) onInstallStart();
  const installed = await installProvisionedBrowser({ onLine });
  return { ...installed, installed: true };
}

/**
 * Directory of runtime libraries bundled for this platform, if any.
 * A stripped Linux container (Android, minimal rootfs) has no NSS/NSPR/ATK/GBM,
 * so the packaged Chromium cannot load without these.
 */
export function bundledLibDir() {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'browser-runtime', `${process.platform}-${process.arch}`, 'lib');
  try {
    return fs.existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/**
 * Debian ships every library as a real file plus SONAME symlinks
 * (libatk-1.0.so.0 -> libatk-1.0.so.0.24609.1). The tarball only carries the
 * real files, so the loader cannot resolve the SONAME and reports the library
 * as missing even though it is right there. Create the aliases at runtime.
 */
export function materializeLibAliases(dir = bundledLibDir()) {
  if (!dir || process.platform === 'win32') return 0;
  let created = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const match = name.match(/^(lib.+?\.so)(\.(\d+))?(\..+)?$/);
    if (!match) continue;
    const [, stem, , major] = match;
    const source = path.join(dir, name);
    const aliases = new Set();
    if (name !== `${stem}`) aliases.add(stem);
    if (major && name !== `${stem}.${major}`) aliases.add(`${stem}.${major}`);
    for (const alias of aliases) {
      const target = path.join(dir, alias);
      try {
        if (fs.existsSync(target)) continue;
        fs.symlinkSync(name, target);
        created += 1;
      } catch { /* a read-only cache still works if the alias exists */ }
    }
  }
  return created;
}

/** Summary for `browser-use doctor` and `browser-use browser status`. */export function provisionedBrowserInfo() {
  const found = findProvisionedBrowser();
  if (!found) return { available: false, cacheRoot: browserCacheRoot() };
  let size = 0;
  try {
    size = fs.statSync(found.path).size;
  } catch { /* size is informational */ }
  return { available: true, ...found, size, cacheRoot: browserCacheRoot() };
}
