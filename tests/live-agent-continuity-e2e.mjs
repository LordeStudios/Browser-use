// Opt-in live-provider check. Uses an isolated Electron profile and a local
// fixture, never an existing browser tab or saved conversation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { _electron as electron } from 'playwright-core';
const root = path.resolve(import.meta.dirname, '..');
const model = 'z-ai/glm-5.3-flash';
const secret = process.env.XKIRO_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN;
const configuredBase = process.env.ANTHROPIC_BASE_URL;
if (!secret || !configuredBase) throw new Error('Existing provider endpoint and credential environment required.');
const baseUrl = configuredBase.replace(/\/$/, '').replace(/(?:\/v1)?$/, '/v1');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-continuity-live-'));
const profile = path.join(directory, 'profile');
fs.mkdirSync(profile);
let submits = 0;
const fixture = `<!doctype html><html><body style="font:18px system-ui;padding:40px"><h1>Continuity fixture</h1><p>Read both codes, then submit them separated by a space.</p><button id="a" onclick="document.querySelector('#first').hidden=false">Reveal first code</button><p id="first" hidden>First code: KITE</p><button id="b" onclick="document.querySelector('#second').hidden=false">Reveal second code</button><p id="second" hidden>Second code: MOSS</p><form onsubmit="event.preventDefault(); const v=document.querySelector('#answer').value.trim(); document.querySelector('#receipt').textContent=v==='KITE MOSS'?'Verified receipt: KITE MOSS':'Incorrect'; if(v==='KITE MOSS') fetch('/submitted',{method:'POST'});"><label>Combined codes <input id="answer" name="answer"></label><button type="submit">Submit codes</button></form><p id="receipt" role="status"></p></body></html>`;
const server = http.createServer((req, res) => { if (req.url === '/submitted' && req.method === 'POST') submits++; res.setHeader('content-type', 'text/html'); res.end(req.url === '/submitted' ? 'ok' : fixture); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_START_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
let app, page;
console.log('Evidence directory:', directory);
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${profile}`], cwd: root, env, timeout: 40000 });
  page = await app.firstWindow();
  await page.waitForFunction(() => document.documentElement.dataset.browserUseRendererReady === 'true', { timeout: 30000 });
  await page.evaluate(async ({ baseUrl, model, secret, url }) => {
    const api = window.browserUseDesktop;
    const connection = await api.saveAiConnection({ provider: 'xkiro', name: 'Isolated continuity check', baseUrl, model });
    await api.setProviderCredential({ provider: 'xkiro', connectionId: connection.id, secret });
    await api.saveSettings({ agentControlMode: 'browser', aiChatProvider: 'xkiro', aiChatConnectionId: connection.id, aiChatModel: model, aiChatBaseUrl: baseUrl });
    await api.navigate(url);
  }, { baseUrl, model, secret, url });
  await page.reload();
  await page.waitForSelector('#agent-toggle', { timeout: 30000 });
  if (!await page.locator('#agent-panel').isVisible()) await page.locator('#agent-toggle').click();
  const started = Date.now();
  await page.locator('#agent-task').fill('On the current local fixture, reveal the first and second codes, enter them separated by a space in Combined codes, and submit exactly once. Verify the receipt and report its text. Stay on this fixture.');
  await page.locator('#agent-send').click();
  let result;
  const deadline = Date.now() + 240000;
  for (;;) {
    // Keep polling and the final snapshot in the same read; a separate wait
    // can observe an older completed snapshot during the IPC start handoff.
    result = await page.evaluate(async () => {
      const run = await window.browserUseDesktop.agentState();
      if (!run) return null;
      return { status: run.status, result: run.result, decisions: run.decisionCount, calls: run.coordinator?.metrics?.providerCalls,
        tools: (run.history || []).filter(e => !e.tool.startsWith('agent_')).map(e => ({ name: e.tool, ok: e.output?.ok })) };
    });
    if (result?.calls > 0 && ['completed', 'failed', 'cancelled'].includes(result.status)) break;
    if (Date.now() >= deadline) throw new Error('Live fixture exceeded the 240-second verification deadline.');
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const evidence = { model, elapsedMs: Date.now() - started, submits, ...result };
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(evidence, null, 2));
  await page.screenshot({ path: path.join(directory, 'chat.png') });
  console.log(JSON.stringify(evidence));
  assert.equal(result.result?.success, true);
  assert.equal(submits, 1);
  assert.match(result.result.summary, /KITE MOSS/);
  assert.ok(result.decisions <= 10, `Fixture needed ${result.decisions} decisions`);
  console.log('REAL_PLAYWRIGHT_VERIFIED with live provider');
} catch (error) {
  const safeMessage = String(error.message || error).split(secret).join('[credential redacted]');
  console.error(safeMessage);
  process.exitCode = 1;
  if (page) {
    await page.evaluate(async () => { const api = window.browserUseDesktop, run = await api.agentState(); if (run?.id && ['running', 'awaiting_approval', 'paused'].includes(run.status)) await api.agentCancel(run.id); }).catch(() => {});
    await page.screenshot({ path: path.join(directory, 'failed.png') }).catch(() => {});
  }
} finally {
  if (app) await app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
