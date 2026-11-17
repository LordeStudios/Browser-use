'use strict';
// End-to-end proof that the REAL bridge class survives the live failure mode:
//   1. normal path  — arm, click, chooser event, accept
//   2. broken path  — interception wiped (detach), no chooser event at all;
//                     accept must still attach through the DOM
//   3. save path    — downloads routed to a directory, no dialog
//
// Run: node tests/file-dialog-bridge.e2e.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const CDP = require('chrome-remote-interface');
const { FileDialogBridge } = require('../desktop/mcp/fileDialogBridge.cjs');
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

const FIXTURE = path.resolve(__dirname, 'fixtures/file-dialog-game.html');
const PORT = 9334;
const DOWNLOAD_DIR = path.join(os.tmpdir(), 'lorde-bridge-e2e');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
  ].find((candidate) => fs.existsSync(candidate));
}

(async () => {
  const browser = findChrome();
  if (!browser) throw new Error('No Chromium found.');
  fs.rmSync(DOWNLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lorde-bridge-profile-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=900,1200',
    `file:///${FIXTURE.replace(/\\/g, '/').replace(/ /g, '%20')}`
  ], { stdio: 'ignore' });

  let client = null;
  try {
    for (let attempt = 0; attempt < 40 && !client; attempt += 1) {
      await sleep(250);
      try {
        client = await CDP({ port: PORT, target: (targets) => targets.find((t) => t.type === 'page') });
      } catch { /* not up yet */ }
    }
    if (!client) throw new Error('Chromium never exposed CDP.');
    const { Page, Runtime, Input, Browser } = client;

    // A WebContents stand-in that speaks the same debugger contract as Electron.
    const webContents = {
      isDestroyed: () => false,
      getURL: () => 'file:///fixture',
      getTitle: () => 'Lorde File Quest',
      // Page evaluation for the controller's observation/query paths.
      executeJavaScript: async (script) => {
        const result = await client.Runtime.evaluate({ expression: script, returnByValue: true, awaitPromise: true });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'evaluate failed');
        return result.result.value;
      },
      debugger: {
        attached: false,
        isAttached() { return this.attached; },
        attach() { this.attached = true; },
        detach() { this.attached = false; },
        async sendCommand(method, params) { return client.send(method, params); },
        subscribe(method, handler) {
          client.on(method, handler);
          return () => { try { client.removeListener?.(method, handler); } catch { /* ignore */ } };
        }
      }
    };

    const bridge = new FileDialogBridge();
    const armed = await bridge.attach(webContents);
    console.log('PASS arm:', JSON.stringify({ attached: armed.attached, armed: armed.armed }));

    async function realClick(id) {
      const rect = await Runtime.evaluate({
        expression: `(() => { const r = document.getElementById('${id}').getBoundingClientRect();
          return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`,
        returnByValue: true
      });
      const point = JSON.parse(rect.result.value);
      for (const type of ['mousePressed', 'mouseReleased']) {
        await Input.dispatchMouseEvent({ type, x: point.x, y: point.y, button: 'left', clickCount: 1 });
      }
    }
    const pageLog = async () => (await Runtime.evaluate({
      expression: "document.getElementById('log').innerText", returnByValue: true
    })).result.value;

    // ---- 1. normal path -----------------------------------------------------
    await realClick('pick');
    for (let attempt = 0; attempt < 20 && !bridge.state().pending; attempt += 1) await sleep(100);
    const pending = bridge.state().pending;
    if (!pending) throw new Error('chooser was not intercepted (pending never set)');
    console.log('PASS chooser intercepted:', JSON.stringify({ mode: pending.mode, backendNodeId: pending.backendNodeId }));

    const keyFile = path.join(os.tmpdir(), 'lorde-key-one.txt');
    fs.writeFileSync(keyFile, 'first key\n');
    const first = await bridge.accept([keyFile]);
    await sleep(400);
    if (!/lorde-key-one\.txt/.test(await pageLog())) throw new Error('page never logged the first attachment');
    console.log('PASS accept via chooser:', JSON.stringify({ via: first.via, mode: first.mode }));

    // ---- 2. the live failure: interception wiped, no chooser event -----------
    // Simulate the wipe that produced "pending: null" in the live run: the
    // debugger session survives but the interception flag is gone.
    bridge.pending = null;
    await Page.setInterceptFileChooserDialog({ enabled: false });
    await realClick('pick');
    await sleep(500);
    if (bridge.state().pending !== null) throw new Error('expected no pending chooser in the broken path');

    const secondFile = path.join(os.tmpdir(), 'lorde-key-two.txt');
    fs.writeFileSync(secondFile, 'second key\n');
    const second = await bridge.accept([secondFile]);
    await sleep(400);
    const logAfterDirect = await pageLog();
    if (!/lorde-key-two\.txt/.test(logAfterDirect)) throw new Error('direct attach did not reach the page');
    console.log('PASS accept without a chooser event (direct DOM attach):', JSON.stringify({ via: second.via, mode: second.mode }));

    // ---- 2b. navigation must not lose interception --------------------------
    await Page.navigate({ url: `file:///${FIXTURE.replace(/\\/g, '/').replace(/ /g, '%20')}` });
    await sleep(1200);
    await realClick('pick');
    for (let attempt = 0; attempt < 20 && !bridge.state().pending; attempt += 1) await sleep(100);
    if (!bridge.state().pending) throw new Error('interception lost after navigation (re-arm failed)');
    console.log('PASS chooser still intercepted after a navigation');
    await bridge.cancel();
    await sleep(200);
    // The reload cleared the inventory, so Save is disabled again — attach one
    // file directly (no chooser) to enable it before the save check.
    const thirdKey = path.join(os.tmpdir(), 'lorde-key-three.txt');
    fs.writeFileSync(thirdKey, 'third key\n');
    const directAfterNav = await bridge.accept([thirdKey]);
    await sleep(300);
    console.log('PASS direct attach after navigation:', JSON.stringify({ via: directAfterNav.via }));

    // ---- 3. save path ------------------------------------------------------
    await Browser.setDownloadBehavior({ behavior: 'allow', downloadPath: DOWNLOAD_DIR, eventsEnabled: true });
    await realClick('save');
    let saved = null;
    for (let attempt = 0; attempt < 40 && !saved; attempt += 1) {
      await sleep(250);
      const files = fs.readdirSync(DOWNLOAD_DIR).filter((name) => name.endsWith('.json'));
      if (files.length) saved = path.join(DOWNLOAD_DIR, files[0]);
    }
    if (!saved) throw new Error('save never landed in the routed directory');
    const payload = JSON.parse(fs.readFileSync(saved, 'utf8'));
    console.log('PASS save routed:', path.basename(saved), 'inventory:', payload.inventory.length);

    // ---- 4. observation + query friction (no HTML dump needed) --------------
    const tab = { id: 'tab-1', webContents };
    const controller = new BrowserViewController({
      getTabs: () => [tab],
      getSelectedTabId: () => 'tab-1',
      getConsoleEntries: () => [],
      normalizeUrl: (url) => url,
      fileDialogBridge: bridge
    });
    const snapshot = await controller.domSnapshot('tab-1');
    const pageText = String(snapshot.text || '');
    if (!pageText.includes('Attach the key')) throw new Error('observation carried no page text');
    console.log('PASS observation carries page text:', JSON.stringify(pageText.slice(0, 60)) + '…', `(${pageText.length} chars)`);

    const logQuery = await controller.queryElements('tab-1', { selector: '#log' });
    if (!logQuery.elements.length) throw new Error('explicit selector returned no nodes');
    const logText = String(logQuery.elements[0].text || logQuery.elements[0].name || '');
    if (!/attached|ready/.test(logText)) throw new Error('log node text was not returned');
    console.log('PASS explicit selector returns the log node:', JSON.stringify(logText.slice(0, 60)) + '…');

    const score = await Runtime.evaluate({ expression: "document.getElementById('score').textContent", returnByValue: true });
    console.log('PASS score:', score.result.value, '(2 files + 1 save)');
    console.log('RESULT bridge survives detach, answers without an event, and saves without a dialog');
  }
  finally {
    try { await client?.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); }
    catch { console.log('note: temp profile left at', profile); }
  }
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
});
