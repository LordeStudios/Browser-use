import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-computer-e2e-'));
const pause = ms => new Promise(r => setTimeout(r, ms));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_START_URL: 'about:blank' };
delete env.ELECTRON_RUN_AS_NODE;
let app, fixture, providerServer;
const providerRequests = [];
async function until(fn, message, timeout = 20_000) { const end = Date.now() + timeout; while (Date.now() < end) { const value = await fn(); if (value) return value; await pause(100); } throw new Error(message); }
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${profile}`], cwd: root, env, timeout: 40_000 });
  const shell = await until(() => app.windows().find(w => w.url().endsWith('/desktop/renderer/index.html')), 'Shell did not appear');
  await shell.waitForSelector('#settings-toggle');
  const config = await shell.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  const authentication = await fetch(config.authenticationEndpoint).then(r => r.json());
  const initial = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authentication }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'computer-e2e', version: '1' } } }) });
  const session = initial.headers.get('mcp-session-id'); assert.ok(session);
  let sequence = 1;
  async function rpc(method, params = {}) {
    const r = await fetch(config.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': session }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(30_000) });
    return r.json();
  }
  async function tool(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    assert.equal(r.error, undefined, `${name}: ${JSON.stringify(r.error)}`);
    assert.notEqual(r.result?.isError, true, `${name}: ${JSON.stringify(r.result)}`);
    return { ...JSON.parse(r.result.content[0].text), image: r.result.content.find(c => c.type === 'image') };
  }
  assert.ok((await rpc('tools/call', { name: 'computer_observe' })).error, 'Browser-only must reject native calls');
  await shell.locator('#settings-toggle').click();
  await app.evaluate(async ({ webContents }) => {
    const overlay = webContents.getAllWebContents().find(w => w.getURL().endsWith('/desktop/renderer/overlay.html'));
    await overlay.executeJavaScript(`(() => { const select=document.querySelector('#mcp-control-mode'); select.value='agi'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  });
  await until(async () => (await shell.evaluate(() => window.browserUseDesktop.settings())).mcpControlMode === 'agi', 'MCP mode did not save');
  await shell.evaluate(() => window.browserUseDesktop.closeOverlay());
  console.log('PASS actual MCP Settings selector; existing pairing retained');
  const desktop = await tool('computer_observe'); assert.ok(desktop.displays.length); assert.ok(desktop.virtualDesktop.width > 0);
  const title = `Browser-use Native Fixture ${Date.now()}`;
  let fixtureOutput = '', fixtureError = '';
  fixture = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-File', path.join(root, 'tests/fixtures/computer-window.ps1'), '-WindowTitle', title], { env, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
  fixture.stdout.setEncoding('utf8'); fixture.stderr.setEncoding('utf8');
  fixture.stdout.on('data', data => { fixtureOutput += data; }); fixture.stderr.on('data', data => { fixtureError += data; });
  const ready = await until(() => { const line = fixtureOutput.split(/\r?\n/).find(l => l.includes('"ready"')); return line && JSON.parse(line); }, 'Native Windows Forms fixture did not start');
  await tool('computer_window', { action: 'focus', windowId: ready.handle });
  await tool('computer_pointer', { action: 'click', ...ready.field });
  await tool('computer_keyboard', { action: 'text', text: 'Native tools verified 123 — café' });
  await tool('computer_pointer', { action: 'click', ...ready.button });
  await until(() => fixtureOutput.includes('Native tools verified 123 — café'), `Native input did not arrive: ${fixtureError}`);
  console.log('PASS native Windows Forms focus, system mouse and Unicode keyboard');
  const strokeShot = await tool('computer_screenshot', { maxWidth: 1280 });
  const imagePoint = p => ({ x: (p.x - strokeShot.origin.x) / strokeShot.scaleX, y: (p.y - strokeShot.origin.y) / strokeShot.scaleY });
  const r = ready.region;
  const planned = [[{x:r.x+25,y:r.y+25},{x:r.x+180,y:r.y+25},{x:r.x+110,y:r.y+140}], [{x:r.x+250,y:r.y+45},{x:r.x+360,y:r.y+170}]];
  const strokes = planned.map(points => ({ points:points.map(imagePoint), durationMs:400 }));
  const region = { ...imagePoint(r), width:r.width/strokeShot.scaleX, height:r.height/strokeShot.scaleY };
  const strokeArgs = {action:'stroke',windowId:ready.handle,coordinateSpace:'screenshot',screenshotId:strokeShot.screenshotId,region,strokes};
  const strokeInput = { ...strokeArgs }; delete strokeInput.action;
  const dispatched = await tool('computer_stroke',{...strokeInput,button:null});
  assert.equal(dispatched.completedStrokes,2);
  const strokeEvents = () => fixtureOutput.split(/\r?\n/).filter(line=>line.includes('"event":"stroke"')).map(line=>JSON.parse(line));
  await until(()=>strokeEvents().length===2,'Native multi-point strokes did not reach the fixture');
  for (const [index,points] of planned.entries()) for (const p of points) {
    assert.ok(strokeEvents()[index].points.some(q=>Math.abs(q.x-p.x)<=2&&Math.abs(q.y-p.y)<=2),`Native stroke lost a planned vertex ${JSON.stringify(p)}`);
  }
  const rejected = await rpc('tools/call',{name:'computer_pointer',arguments:{...strokeArgs,strokes:[...strokes,{points:[{x:0,y:0},{x:10,y:10}]}]}});
  assert.ok(rejected.error||rejected.result?.isError,'A batch with a later outside-region stroke must be rejected before input');
  assert.equal(strokeEvents().length,2,'Invalid batch must not replay earlier valid strokes');
  console.log('PASS separate computer_stroke tool, nullable optional input, native vertices, pen lifts, mapping and legacy all-points prevalidation');
  const pty = await tool('computer_terminal', { action: 'open', cwd: profile });
  await tool('computer_terminal', { action: 'input', sessionId: pty.sessionId, text: "Write-Output ('native-pty-' + 'verified')\r" });
  await until(async () => (await tool('computer_terminal', { action: 'read', sessionId: pty.sessionId })).history.includes('native-pty-verified'), 'Interactive PTY did not produce command output');
  await tool('computer_terminal', { action: 'close', sessionId: pty.sessionId });
  console.log('PASS owner-specific interactive terminal command and close');
  const screenshot = await tool('computer_screenshot', { maxWidth: 1280 });
  assert.ok(screenshot.image?.data); assert.ok(screenshot.width > 0 && screenshot.origin); assert.ok(screenshot.scaleX > 0);
  fs.writeFileSync(path.join(profile, 'native.png'), Buffer.from(screenshot.image.data, 'base64'));
  const pixels = await app.evaluate(({ nativeImage }, data) => {
    const image = nativeImage.createFromBuffer(Buffer.from(data, 'base64')); const bitmap = image.toBitmap();
    return { size: image.getSize(), colors: new Set(Array.from({ length: Math.min(10000, bitmap.length / 4) }, (_, i) => bitmap.readUInt32LE(i * 4))).size };
  }, screenshot.image.data);
  assert.ok(pixels.colors > 5, 'Screenshot must contain real nonblank desktop pixels');
  const video = path.join(profile, 'native-recording.webm');
  // Give screen capture a guaranteed changing, visible fixture. Desktop capture
  // may emit only a few early frames when the underlying desktop is static.
  await app.evaluate(async ({ BrowserWindow }) => {
    const window = new BrowserWindow({ title: 'Native recording fixture', width: 480, height: 320, alwaysOnTop: true, webPreferences: { sandbox: true, backgroundThrottling: false } });
    await window.loadURL('data:text/html,<title>Native recording fixture</title><style>@keyframes pulse{from{background:%23e33}to{background:%2333e}}body{animation:pulse .4s infinite alternate}</style><h1>Recording fixture</h1>');
    window.show(); window.focus();
  });
  const recording = await tool('computer_record', { action: 'start', path: video, fps: 10, width: 960 }); assert.equal(recording.state, 'recording');
  await pause(2500);
  const stopped = await tool('computer_record', { action: 'stop' }); assert.equal(stopped.state, 'completed'); assert.ok(stopped.bytes > 1000);
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Native recording fixture')?.destroy(); });
  await tool('computer_window', { action: 'focus', windowId: ready.handle });
  const playback = await app.evaluate(async ({ BrowserWindow }, base64) => {
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    try {
      await window.loadURL('data:text/html,<video muted src="data:video/webm;base64,' + base64 + '"></video>');
      return await window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const video=document.querySelector('video'); const t=setTimeout(()=>reject(new Error('Playback timed out: '+video.error?.message)),8000); video.onerror=()=>{clearTimeout(t);reject(new Error(video.error.message));}; video.play().then(()=>{video.ontimeupdate=()=>{if(video.currentTime>.4){clearTimeout(t);resolve({width:video.videoWidth,height:video.videoHeight,time:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames});}}}).catch(reject);})`);
    } finally { window.destroy(); }
  }, fs.readFileSync(video).toString('base64'));
  assert.ok(playback.width > 0 && playback.time > .4);
  console.log(`PASS desktop screenshot and playable streamed WebM ${stopped.bytes} bytes`);
  await tool('computer_keyboard', { action: 'press', key: 'Alt+F4' });
  await until(() => fixture.exitCode !== null, 'Owned native fixture did not close'); fixture = null;

  await app.evaluate(({ BrowserWindow }) => { const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/desktop/renderer/index.html')); w.show(); w.focus(); });
  await shell.locator('#agent-toggle').click();
  await shell.locator('#agent-mode-toggle').click();
  await shell.locator('#agent-mode-menu [data-agent-mode="agi"]').click();
  await until(async () => (await shell.evaluate(() => window.browserUseDesktop.settings())).agentControlMode === 'agi', 'Chat scope did not persist');
  assert.equal(await shell.locator('#agent-mode-label').textContent(), 'Web & PC');
  assert.equal(await shell.locator('#agent-permission').inputValue(), 'unattended');
  await shell.evaluate(() => window.browserUseDesktop.setAgentDrawerWidth(320));
  const geometry = await shell.evaluate(() => {
    const panel=document.querySelector('#agent-panel').getBoundingClientRect(), button=document.querySelector('#agent-send').getBoundingClientRect();
    return { panel:{left:panel.left,right:panel.right}, button:{left:button.left,right:button.right}, modes:document.querySelectorAll('#agent-control-mode').length };
  });
  assert.ok(geometry.button.right <= geometry.panel.right); assert.ok(geometry.button.left >= geometry.panel.left); assert.equal(geometry.modes, 1);
  await shell.screenshot({ path: path.join(profile, 'agi-composer.png') });
  const chatFile = path.join(profile, 'chat-created.txt');
  let lifecycleStage = 0;
  const lifecycleEvidence = [];
  async function showLifecycleFixture(title) {
    await app.evaluate(async ({ BrowserWindow }, title) => {
      let fixture = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().startsWith('data:text/html,') && window.getTitle().startsWith('Native lifecycle '));
      if (!fixture) fixture = new BrowserWindow({ width: 420, height: 260, webPreferences: { sandbox: true, contextIsolation: true } });
      await fixture.loadURL(`data:text/html,<title>${title}</title><h1>${title}</h1>`);
      fixture.show(); fixture.focus();
    }, title);
  }
  providerServer = http.createServer(async (req, res) => {
    if (req.url.endsWith('/models')) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'computer-fixture' }] })); return; }
    let body = ''; for await (const part of req) body += part;
    const request = JSON.parse(body); providerRequests.push(request);
    if (providerRequests.length === 1) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'One deterministic transient failure' } })); return;
    }
    let response;
    if (lifecycleStage) {
      const content = request.messages.find(message => message.role === 'user').content;
      const context = JSON.parse(typeof content === 'string' ? content : content.find(part => part.type === 'text').text);
      lifecycleEvidence.push({ desktop: context.observation?.desktop, screenshot: context.observation?.screenshot });
      if (lifecycleStage === 1) {
        await showLifecycleFixture('Native lifecycle A');
        response = { actions: [{ name: 'computer_screenshot', input: {} }] };
      } else if (lifecycleStage === 2) {
        await showLifecycleFixture('Native lifecycle B');
        response = { actions: [{ name: 'browser_wait', input: { ms: 500 } }] };
      } else response = { done: { summary: 'Native lifecycle fixture inspected.', success: true, verified: true } };
      lifecycleStage++;
    } else response = providerRequests.length === 2
      ? { actions: [{ name: 'computer_write', input: { path: chatFile, content: 'created through actual chat' } }] }
      : { actions: [{ name: 'browser_done', input: { summary: 'Created the fixture file.', success: true, verified: true } }] };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(response) }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
  const providerUrl = `http://127.0.0.1:${providerServer.address().port}/v1`;
  await shell.evaluate(async url => {
    const api = window.browserUseDesktop;
    const connection = await api.saveAiConnection({ provider: 'openai', name: 'Local scripted verification', baseUrl: url, model: 'computer-fixture' });
    await api.setProviderCredential({ provider: 'openai', connectionId: connection.id, secret: 'local-fixture-only' });
  }, providerUrl);
  await shell.reload(); await shell.waitForSelector('#agent-toggle');
  await shell.waitForFunction(() => document.documentElement.dataset.browserUseRendererReady === 'true' && document.querySelector('#agent-control-mode')?.value === 'agi' && document.querySelector('#agent-model-label')?.textContent.includes('computer-fixture'));
  if (!(await shell.locator('#agent-panel').isVisible())) await shell.locator('#agent-toggle').click();
  await shell.locator('#agent-task').fill('Create the fixture file requested by the local verification provider.');
  await shell.locator('#agent-send').click();
  await until(() => fs.existsSync(chatFile), 'Chat did not execute the real file tool');
  const chatRun = await until(async () => { const run=await shell.evaluate(()=>window.browserUseDesktop.agentState()); return run?.status==='completed' && run; }, 'Chat did not settle');
  assert.equal(fs.readFileSync(chatFile, 'utf8'), 'created through actual chat');
  assert.equal(providerRequests.length, 3, 'Two decisions and the existing single transient retry');
  assert.equal(chatRun.coordinator.metrics.providerCalls, 2);
  assert.equal(chatRun.coordinator.metrics.providerRequests, 3);
  assert.equal(chatRun.coordinator.metrics.providerRequestKinds['transport-retry'], 1);
  assert.deepEqual(chatRun.coordinator.metrics.providerRequestHistory.map(request => request.status), [503, 200, 200]);
  assert.ok(chatRun.coordinator.metrics.firstToolStartedMs >= 0);
  assert.ok(chatRun.coordinator.metrics.firstToolSettledMs >= chatRun.coordinator.metrics.firstToolStartedMs);
  const initialContext = JSON.parse(providerRequests[0].messages.find(message => message.role === 'user').content);
  assert.ok(initialContext.observation.desktop, 'First model decision receives native evidence without an observe tool call');
  assert.equal(initialContext.observation.screenshot, undefined, 'Auto mode avoids an unconditional startup image');
  assert.equal(initialContext.tools, undefined, 'Native schemas are not repeated in the user context');
  assert.ok(['computer_read', 'computer_write', 'computer_search', 'computer_fs'].every(name => providerRequests[0].tools.some(tool => tool.function.name === name)));
  assert.ok(providerRequests[0].tools.every(tool => tool.function.name !== 'computer_file'), 'the retired everything-tool must not be model-facing');
  assert.equal(chatRun.pendingApproval, null);
  console.log('PASS actual chat: desktop-first evidence, one schema channel, two decisions/three measured requests, native file write and unchanged permissions');
  lifecycleStage = 1;
  await shell.locator('#agent-new-chat').click();
  await shell.locator('#agent-task').fill('Inspect the native lifecycle fixture after its title changes.');
  await shell.locator('#agent-send').click();
  const lifecycleRun = await until(async () => { const run=await shell.evaluate(()=>window.browserUseDesktop.agentState()); return run?.id!==chatRun.id&&run?.status==='completed'&&run; }, 'Native lifecycle task did not settle');
  assert.equal(lifecycleRun.result?.success,true);
  assert.equal(lifecycleRun.coordinator.metrics.providerCalls,3);
  assert.equal(lifecycleEvidence.length,3);
  assert.ok(lifecycleEvidence[1].desktop.windows.some(window=>window.title==='Native lifecycle A'),'Explicit screenshot must refresh the top-level window list');
  assert.ok(lifecycleEvidence[2].desktop.windows.some(window=>window.title==='Native lifecycle B'),'Wait must return current native metadata rather than browser DOM');
  assert.equal(lifecycleEvidence[2].screenshot.source,'native-desktop');
  assert.notEqual(lifecycleEvidence[2].screenshot.screenshotId,lifecycleEvidence[1].screenshot.screenshotId,'Wait must not reuse pre-wait pixels');
  console.log('PASS actual native screenshot -> changed window -> wait -> current native evidence in three decisions');
  await shell.locator('#agent-mode-toggle').click();
  await shell.locator('#agent-mode-menu [data-agent-mode="browser"]').click();
  await shell.evaluate(() => window.browserUseDesktop.saveSettings({ mcpControlMode: 'browser' }));
  assert.ok((await rpc('tools/call', { name: 'computer_observe' })).error);
  assert.ok((await rpc('tools/list')).result.tools.some(t => t.name === 'computer_observe'), 'cached stable catalog does not bypass execution scope');
  console.log('PASS chat mode, unchanged Full access control, compact width and cached-call downgrade');
  console.log(JSON.stringify({ ok: true, verification: 'REAL_PLAYWRIGHT_VERIFIED', profile, screenshot: pixels, recording: stopped, playback }));
} finally {
  if (fixture && fixture.exitCode === null) fixture.kill();
  if (app) await app.close().catch(() => {});
  if (providerServer) await new Promise(resolve => providerServer.close(resolve));
  console.log(`Evidence profile: ${profile}`);
}
