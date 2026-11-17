// DEV RESUME E2E — launches the real desktop app against a throwaway profile
// and checks the three resume outcomes:
//   A. a finished chat  -> the chat reopens and NOTHING restarts ('restored')
//   B. an interrupted chat -> the run is CONTINUED, not left idle
//   C. no resume switch -> nothing is restored
// Run: env -u ELECTRON_RUN_AS_NODE node tests/dev-resume-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-resume-'));
const pageA = path.join(profile, 'alpha.html');
const pageB = path.join(profile, 'beta.html');
fs.writeFileSync(pageA, '<title>Alpha page</title><h1>alpha</h1>');
fs.writeFileSync(pageB, '<title>Beta page</title><h1>beta</h1>');

const USER_MESSAGE = 'Improve the game on the desktop';
const REPLY = 'I added a combo meter and shields.';

function seed({ conversationStatus, sessionChatStatus }) {
  fs.writeFileSync(path.join(profile, 'dev-session.json'), JSON.stringify({
    schemaVersion: 1,
    savedAt: Date.now() - 60_000,
    tabs: [
      { url: `file:///${pageA.replace(/\\/g, '/')}`, title: 'Alpha page', active: false },
      { url: `file:///${pageB.replace(/\\/g, '/')}`, title: 'Beta page', active: true }
    ],
    chat: {
      conversationId: 'resume-fixture',
      title: 'Resume fixture',
      task: USER_MESSAGE,
      status: sessionChatStatus,
      drawerOpen: true
    },
    provider: { id: 'ollama', connectionId: '', model: 'fixture-model' }
  }), 'utf8');

  fs.writeFileSync(path.join(profile, 'browser-use-chat-history.json'), JSON.stringify({
    schemaVersion: 5,
    conversations: [{
      id: 'resume-fixture',
      task: USER_MESSAGE,
      title: 'Resume fixture',
      status: conversationStatus,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 60_000,
      providerConfig: { id: 'ollama', model: 'fixture-model' },
      settings: { controlMode: 'browser', vision: 'off' },
      messages: [
        { role: 'user', content: USER_MESSAGE, at: Date.now() - 110_000 },
        { role: 'assistant', content: REPLY, at: Date.now() - 100_000 }
      ],
      transcript: []
    }]
  }), 'utf8');
}

async function launch({ resume }) {
  const app = await electron.launch({
    executablePath: electronExecutable,
    args: ['.', `--user-data-dir=${profile}`],
    cwd: root,
    env: {
      ...process.env,
      APPDATA: profile,
      LOCALAPPDATA: profile,
      BROWSER_USE_DESKTOP_MCP_PORT: '0',
      ...(resume ? { BROWSER_USE_DEV_RESUME: '1' } : { BROWSER_USE_DEV_RESUME: '' })
    }
  });
  const window = await mainRendererWindow(app);
  await window.waitForSelector('#settings-toggle');
  await window.waitForTimeout(2500);
  return { app, window };
}

async function mainRendererWindow(app) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of app.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('renderer did not load');
}

// Closing the window is not quitting: this app keeps a tray, so a plain close
// leaves the instance (and its single-instance lock) alive. Tests must exit
// the process itself.
async function shutdown(app) {
  try { await app.evaluate(({ app: electronApp }) => electronApp.exit(0)); } catch { /* already gone */ }
  try { await app.close(); } catch { /* already gone */ }
}

const summary = (window) => window.evaluate(() => ({
  tabs: document.querySelectorAll('[data-tab-id]').length,
  titles: [...document.querySelectorAll('[data-tab-id]')].map((tab) => tab.textContent.replace(/\s+/g, ' ').trim()),
  active: [...document.querySelectorAll('[data-tab-id].is-active, [data-tab-id][aria-selected="true"]')].map((tab) => tab.textContent.replace(/\s+/g, ' ').trim()),
  drawerVisible: !document.querySelector('#agent-panel')?.hidden,
  transcript: document.querySelector('#agent-transcript')?.innerText || '',
  resume: document.documentElement.dataset.devResume || ''
}));

let failures = 0;
try {
  // ── A. finished chat: reopen, never restart ─────────────────────────────
  {
    seed({ conversationStatus: 'completed', sessionChatStatus: 'completed' });
    const { app, window } = await launch({ resume: true });
    try {
      const state = await summary(window);
      console.log('A completed:', state.resume, JSON.stringify(state.titles));
      assert.equal(state.tabs, 2, 'both previous tabs come back');
      assert.ok(state.active.some((title) => /Beta page/.test(title)), 'the previous ACTIVE tab is selected again');
      assert.equal(state.drawerVisible, true, 'the chat panel is open');
      assert.match(state.transcript, new RegExp(USER_MESSAGE), 'the exact previous conversation is on screen');
      assert.equal(state.resume, 'restored', 'a finished chat is reopened, not restarted');
    } finally { await shutdown(app); }
  }

  // ── B. interrupted chat: continue it without being asked ───────────────
  {
    seed({ conversationStatus: 'interrupted', sessionChatStatus: 'running' });
    const { app, window } = await launch({ resume: true });
    try {
      const state = await summary(window);
      console.log('B interrupted:', state.resume);
      assert.match(state.transcript, new RegExp(USER_MESSAGE), 'the conversation is on screen');
      assert.notEqual(state.resume, 'restored',
        'an interrupted run must be continued, not left idle waiting for the user to type "continue"');
      // 'continuing' when a provider answers, 'failed' when none is configured
      // (this throwaway profile has no model) — both prove the attempt.
      assert.ok(['continuing', 'failed'].includes(state.resume), `unexpected resume state: ${state.resume}`);
    } finally { await shutdown(app); }
  }

  // ── C. no switch: nothing is restored ──────────────────────────────────
  {
    seed({ conversationStatus: 'interrupted', sessionChatStatus: 'running' });
    const { app, window } = await launch({ resume: false });
    try {
      const state = await summary(window);
      console.log('C plain:', JSON.stringify(state.resume), JSON.stringify(state.titles));
      assert.equal(state.tabs, 1, 'a plain dev start opens one tab');
      assert.ok(!state.titles.some((title) => /Beta page/.test(title)), 'no previous tab is restored without the switch');
      assert.doesNotMatch(state.transcript, new RegExp(REPLY), 'no previous chat is restored without the switch');
      assert.equal(state.resume, '', 'the resume handler never ran');
    } finally { await shutdown(app); }
  }
} catch (error) {
  failures += 1;
  console.error('FAILED:', error?.message || error);
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
if (failures) process.exit(1);
console.log(JSON.stringify({ ok: true, resume: 'finished reopens, interrupted continues, plain start untouched' }));
