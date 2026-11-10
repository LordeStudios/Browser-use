import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

test('startup shows the supplied splash before revealing the main window', () => {
  const source = read('desktop/main.cjs');
  assert.match(source, /let splashWindow = null/);
  assert.match(source, /function createSplashWindow\(\)/);
  assert.match(source, /loadFile\(path\.join\(__dirname, 'assets', 'splash-screen\.html'\)\)/);
  assert.match(source, /show: true/);
  assert.match(source, /frame: false/);
  assert.match(source, /mainWindowDidFinishLoad = true/);
  assert.match(source, /show: false/);
  assert.match(source, /function revealMainWindow\(reason = 'renderer-ready'\)/);
  assert.match(source, /mainWindowDidFinishLoad/);
  assert.match(source, /mainRendererReady/);
  assert.match(source, /setTimeout\(\(\) => \{/);
  assert.match(source, /startup-timeout/);
  assert.match(source, /SPLASH_MIN_DISPLAY_MS = 3500/);
  assert.match(source, /ipcMain\.on\('browser-use:renderer-ready'/);
  assert.match(source, /createSplashWindow\(\);/);
});

test('renderer exposes and sends the readiness signal', () => {
  const preload = read('desktop/preload.cjs');
  const renderer = read('desktop/renderer/app.js');
  assert.match(preload, /rendererReady: \(\) => ipcRenderer\.send\('browser-use:renderer-ready'\)/);
  assert.match(renderer, /window\.browserUseDesktop\.rendererReady\(\)/);
});

test('supplied splash and icon assets are packaged and selected', () => {
  const builder = read('electron-builder.yml');
  const splash = read('desktop/assets/splash-screen.html');
  assert.ok(fs.statSync(path.join(root, 'desktop/assets/splash-screen.svg')).size > 1000);
  assert.ok(fs.statSync(path.join(root, 'desktop/assets/splash-screen.html')).size > 1000);
  assert.ok(fs.statSync(path.join(root, 'desktop/assets/icon-source.png')).size > 100);
  assert.ok(fs.statSync(path.join(root, 'desktop/assets/browser-use-icon.ico')).size > 100);
  assert.match(splash, /<svg[\s\S]*splash-status/);
  assert.doesNotMatch(splash, /<img|class=\"progress\"|@keyframes loading/);
  assert.equal((splash.match(/splash-progress-clip/g) || []).length, 2);
  assert.match(splash, /splash-progress-track/);
  assert.match(splash, /fullWidth = 1215.66/);
  assert.match(splash, /INITIALIZING 0%/);
  assert.doesNotMatch(splash, /values="0;1208;1208;0"/);
  assert.match(splash, /<tspan class="st0 st3 st4">use<\/tspan>/);
  assert.match(splash, />by Lorde Studios<\/text>/);
  assert.doesNotMatch(splash, /letter-spacing:12/);
  assert.match(splash, /letter-spacing:6/);
  assert.match(splash, /letter-spacing:7/);
  assert.match(splash, /INITIALIZING \$\{percent\}%/);
  assert.match(splash, /requestAnimationFrame\(tick\)/);
  assert.match(builder, /icon: desktop\/assets\/browser-use-icon\.ico/);
  assert.match(builder, /- desktop\/\*\*\/\*/);
});
