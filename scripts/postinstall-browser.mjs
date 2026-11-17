// scripts/postinstall-browser.mjs
//
// Runs after `npm install -g lorde-browser-use`. It provisions the browser the
// package carries (the stripped headless shell) so the first run has something
// to drive. It never fails the install: a broken network, a proxy or a missing
// platform build must not leave the package half-installed.
//
// Skip it with BROWSER_USE_SKIP_BROWSER_DOWNLOAD=1.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

function say(line) {
  process.stdout.write(`browser-use: ${line}\n`);
}

async function main() {
  if (String(process.env.BROWSER_USE_SKIP_BROWSER_DOWNLOAD || '') === '1') {
    say('browser download skipped (BROWSER_USE_SKIP_BROWSER_DOWNLOAD=1)');
    return;
  }
  let provisioner;
  try {
    provisioner = await import(pathToFileURL(path.join(ROOT, 'cli', 'browserProvisioner.mjs')).href);
  } catch (error) {
    say(`provisioner unavailable, skipping: ${String(error?.message || error)}`);
    return;
  }
  const existing = provisioner.findProvisionedBrowser();
  if (existing) {
    say(`browser present: ${existing.path}`);
    return;
  }
  say(`provisioning the bundled browser for ${process.platform}/${process.arch} (one time)`);
  let lastPercent = -1;
  try {
    const found = await provisioner.ensureProvisionedBrowser({
      onLine: (line) => {
        const match = line.match(/(\d{1,3})%/);
        if (!match) return;
        const pct = Number(match[1]);
        if (pct >= lastPercent + 10 || pct === 100) {
          lastPercent = pct;
          process.stdout.write(`browser-use: ${pct}% downloaded\n`);
        }
      }
    });
    say(`browser ready: ${found.path}`);
  } catch (error) {
    // Deliberately non-fatal: `browser-use browser install` retries later, and
    // the first run provisions on demand.
    say(`browser download failed (${String(error?.message || error).slice(0, 160)})`);
    say('run `browser-use browser install` to retry, or set CHROME_PATH');
  }
}

main().catch((error) => {
  say(`postinstall error ignored: ${String(error?.message || error).slice(0, 160)}`);
}).finally(() => {
  process.exit(0);
});
