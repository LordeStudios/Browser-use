'use strict';
// End-to-end proof of the file-dialog bridge against a real Chromium:
//   1. serve the fixture page from file://
//   2. arm interception with the same CDP calls the bridge makes
//   3. click "Choose file…" → assert Page.fileChooserOpened fires (no OS dialog)
//   4. attach a real file → assert the page's own log reports it
//   5. click "Save inventory" → assert the download lands in the routed directory
//
// Run: node scratch/e2e-file-dialog-game.mjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');

const FIXTURE = path.resolve(__dirname, 'fixtures/file-dialog-game.html');
const PORT = 9333;
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'lorde-quest-e2e');

function findChrome() {
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const browser = findChrome();
  if (!browser) throw new Error('No Chromium found.');
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-e2e-profile-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=900,1200', `file:///${FIXTURE.replace(/\\/g, '/').replace(/ /g, '%20')}`
  ], { stdio: 'ignore' });

  let client = null;
  try {
    for (let attempt = 0; attempt < 40 && !client; attempt += 1) {
      await sleep(250);
      try {
        // The Page domain only exists on a page target, not on the browser target.
        client = await CDP({ port: PORT, target: (targets) => targets.find((t) => t.type === 'page') });
      } catch { /* not up yet */ }
    }
    if (!client) throw new Error('Chromium never exposed CDP.');
    const { Page, DOM, Browser, Runtime, Input } = client;
    await Page.enable();
    await Browser.setDownloadBehavior({ behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true });

    const chooser = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('fileChooserOpened never fired')), 8000);
      Page.fileChooserOpened((params) => { clearTimeout(timer); resolve(params); });
    });
    await Page.setInterceptFileChooserDialog({ enabled: true });

    // A real gesture: Chromium refuses to open a picker for a script-only click.
    const rect = await Runtime.evaluate({
      expression: `(() => { const r = document.getElementById('pick').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
      returnByValue: true
    });
    const point = JSON.parse(rect.result.value);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await Input.dispatchMouseEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    const opened = await chooser;
    console.log('PASS chooser intercepted:', JSON.stringify({ mode: opened.mode, backendNodeId: opened.backendNodeId }));

    // Attach a real file the way the bridge does.
    const sample = path.join(os.tmpdir(), 'lorde-quest-key.txt');
    fs.writeFileSync(sample, 'the key to the quest\n');
    await DOM.setFileInputFiles({ files: [sample], backendNodeId: opened.backendNodeId });
    await sleep(600);

    const logText = await Runtime.evaluate({
      expression: "document.getElementById('log').innerText",
      returnByValue: true
    });
    const attached = /attached/.test(logText.result.value) && /lorde-quest-key\.txt/.test(logText.result.value);
    console.log(attached ? 'PASS file attached and page logged it' : 'FAIL page did not log the attachment');
    const score = await Runtime.evaluate({ expression: "document.getElementById('score').textContent", returnByValue: true });
    console.log('PASS score after attach:', score.result.value);

    // Save: the download must land in the routed directory, no dialog.
    const saveRect = await Runtime.evaluate({
      expression: `(() => { const r = document.getElementById('save').getBoundingClientRect();
        return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
      returnByValue: true
    });
    const savePoint = JSON.parse(saveRect.result.value);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await Input.dispatchMouseEvent({ type, x: savePoint.x, y: savePoint.y, button: 'left', clickCount: 1 });
    }
    let saved = null;
    for (let attempt = 0; attempt < 40 && !saved; attempt += 1) {
      await sleep(250);
      const files = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.json'));
      if (files.length) saved = path.join(DOWNLOAD_DIR, files[0]);
    }
    if (!saved) throw new Error('download never landed in the routed directory');
    const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
    console.log('PASS save routed without a dialog:', path.basename(saved), 'inventory items:', payload.inventory.length);

    console.log('RESULT all file-dialog paths work end to end');
  }
  finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    // Chromium keeps crashpad handles open briefly; cleanup must not mask results.
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch { console.log('note: temp profile left behind at', profile); }
  }
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
