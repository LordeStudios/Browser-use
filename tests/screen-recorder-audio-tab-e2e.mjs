// Real Electron verification for the screen recorder menu additions:
// 1. "Web tab" source with a tab dropdown populated from the live tab list.
// 2. "Record audio" checkbox, OFF by default, that locks speed to 1x and adds
//    a real audio track to the fragmented MP4.
// Drives the actual app: the dropdown must list real tabs, and a web-tab
// recording with audio must complete with bytes on disk and snapshot.audio 'on'.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-recorder-e2e-'));
const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-recorder-out-'));
const electronApp = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

async function mainRendererWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main renderer did not load within 30 seconds.');
}

try {
  const window = await mainRendererWindow(electronApp);
  window.setDefaultTimeout(20_000);
  await window.waitForSelector('#recording-toggle');
  await window.locator('#recording-toggle').click();

  const overlay = electronApp.windows().find((candidate) => candidate.url().endsWith('/overlay.html'));
  assert.ok(overlay, 'the overlay BrowserView renderer must exist');
  await overlay.waitForFunction(() => !document.querySelector('#recording-panel').hidden);

  // Source segment: three options now — window, screen, web tab.
  const modes = await overlay.$$eval('input[name="recording-mode"]', (radios) => radios.map((radio) => radio.value));
  assert.deepEqual(modes, ['window', 'screen', 'tab'], 'the source segment must offer window, screen, and web tab');

  // Audio checkbox exists and is OFF by default.
  assert.equal(await overlay.locator('#recording-audio').isChecked(), false, 'audio must be off by default');

  // Tab dropdown hidden for the default window source.
  const tabField = overlay.locator('#recording-tab-field');
  assert.equal(await tabField.isHidden(), true, 'tab dropdown must be hidden for window mode');

  // Selecting Web tab shows the dropdown, populated from the live tab list.
  // The radio itself is visually hidden behind its styled span, so click the
  // label the way a user does.
  await overlay.locator('.recorder-segment label:has(input[value="tab"])').click();
  await overlay.waitForFunction(() => !document.querySelector('#recording-tab-field').hidden);
  const optionCount = await overlay.$$eval('#recording-tab option', (options) => options.length);
  assert.ok(optionCount >= 1, `the tab dropdown must list the open tabs, got ${optionCount}`);
  const firstOption = await overlay.$eval('#recording-tab option', (option) => ({ value: option.value, label: option.textContent }));
  assert.ok(String(firstOption.value).length > 0, 'tab options must carry a real tab id');
  console.log(JSON.stringify({ tabDropdown: { options: optionCount, first: firstOption.label.slice(0, 60) } }));

  // Audio checkbox locks speed to 1x while enabled.
  await overlay.locator('#recording-audio').check();
  assert.equal(await overlay.locator('#recording-speed').isDisabled(), true, 'audio must disable the speed selector');
  assert.equal(await overlay.locator('#recording-speed').inputValue(), '1', 'audio must force 1x speed');
  await overlay.locator('#recording-audio').uncheck();
  assert.equal(await overlay.locator('#recording-speed').isDisabled(), false, 'unchecking audio must re-enable speed');
  await overlay.locator('#recording-audio').check();

  // Real recording: web tab + audio -> fragmented MP4 with an audio track.
  // The path input is readonly; the value is written directly like the browse
  // dialog would set it.
  const target = path.join(outputDirectory, 'tab-audio.mp4');
  await overlay.$eval('#recording-path', (input, value) => { input.value = value; }, target);
  await overlay.locator('#recording-start').click();
  await overlay.waitForFunction((targetPath) => {
    const status = document.querySelector('#recording-status').textContent;
    return status === 'Recording' || /select a browser tab|could not|failed/i.test(status);
  }, target);
  const startedStatus = await overlay.textContent('#recording-status');
  assert.equal(startedStatus, 'Recording', `recording must start, got: ${startedStatus}`);

  await new Promise((resolve) => setTimeout(resolve, 4000));
  await overlay.locator('#recording-start').click();

  // Stop reports the completed snapshot with the saved path and active audio.
  await overlay.waitForFunction((targetPath) => {
    const status = document.querySelector('#recording-status').textContent;
    return status.startsWith('Saved to') || /failed|error/i.test(status);
  }, target, { timeout: 20_000 });
  const finalStatus = await overlay.textContent('#recording-status');
  assert.match(finalStatus, /^Saved to /, `recording must complete, got: ${finalStatus}`);
  const snapshot = await overlay.evaluate(() => window.browserUseDesktop.recordingStatus());
  assert.equal(snapshot.state, 'completed', `snapshot must be completed, got ${JSON.stringify(snapshot)}`);
  assert.equal(snapshot.mode, 'tab', 'the snapshot must record the web-tab source');
  assert.equal(snapshot.audio, 'on', `audio must be active in the snapshot, got ${JSON.stringify(snapshot).slice(0, 300)}`);
  assert.equal(snapshot.path, target, 'the recording must save to the requested path');
  assert.ok(snapshot.bytes > 10_000, `the recording must contain real bytes, got ${snapshot.bytes}`);

  const file = fs.statSync(target);
  assert.ok(file.size > 10_000, `the file must exist on disk with content, got ${file.size} bytes`);
  const head = await fs.promises.readFile(target);
  assert.equal(head.subarray(4, 8).toString(), 'ftyp', 'the output must be a real MP4');
  // Track handler types live in the moov/trak boxes: 'soun' proves an audio
  // track was muxed, not merely an audio-less video encode.
  const raw = head.toString('latin1');
  assert.ok(raw.includes('soun'), 'the MP4 must contain an audio track (soun handler)');
  assert.ok(raw.includes('vide'), 'the MP4 must contain a video track (vide handler)');

  console.log(JSON.stringify({ ok: true, snapshot: { mode: snapshot.mode, audio: snapshot.audio, bytes: snapshot.bytes, path: snapshot.path } }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
  fs.rmSync(outputDirectory, { recursive: true, force: true });
}
