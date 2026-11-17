import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DevSessionStore, normalizeDevSession, devResumeRequested, RESUMABLE_STATUSES } = require('../desktop/devSession.cjs');

// "npm run desktop:dev_resume" must bring the dev build back at the EXACT
// point it left: same tabs, same chat, same model, chat open, and an
// unfinished run continuing. These tests pin the record and the wiring.

function makeStore(now = 1_700_000_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-resume-'));
  return { store: new DevSessionStore({ filePath: path.join(dir, 'dev-session.json'), now: () => now }), dir };
}

test('a capture keeps the tabs, the chat and the model', () => {
  const { store } = makeStore();
  const record = store.capture({
    tabs: [
      { url: 'https://lichess.org/training', title: 'Practice', active: true },
      { url: 'file:///C:/Users/london/Desktop/neon-dodge.html', title: 'Neon Dodge', active: false }
    ],
    drawer: 'agent',
    provider: { id: 'xkiro', connectionId: 'conn-1', model: 'sensenova/sensenova-6.8-flash-lite' },
    chat: { conversationId: 'run-42', title: 'Improve the game', task: 'Improve the game', status: 'running' }
  });
  assert.equal(record.tabs.length, 2, 'both tabs are kept');
  assert.deepEqual(record.tabs.map((tab) => tab.active), [true, false], 'the active tab is kept');
  assert.equal(record.chat.conversationId, 'run-42');
  assert.equal(record.chat.drawerOpen, true, 'the chat panel is restored open');
  assert.equal(record.chat.resumeRun, true, 'a running chat resumes its run');
  assert.deepEqual(record.provider, { id: 'xkiro', connectionId: 'conn-1', model: 'sensenova/sensenova-6.8-flash-lite' });
});

test('only runs cut off by the process dying are continued', () => {
  const { store } = makeStore();
  for (const status of ['completed', 'failed', 'cancelled']) {
    const record = store.capture({ tabs: [], chat: { conversationId: 'c', status } });
    assert.equal(record.chat.resumeRun, false, `${status} must not restart work`);
  }
  // A person owns these two: continuing them would skip the decision they are
  // waiting on (an approval) or override a deliberate pause.
  for (const status of ['paused', 'awaiting_approval']) {
    const record = store.capture({ tabs: [], chat: { conversationId: 'c', status } });
    assert.equal(record.chat.resumeRun, false, `${status} waits on a person, never on a restart`);
  }
  for (const status of RESUMABLE_STATUSES) {
    const record = store.capture({ tabs: [], chat: { conversationId: 'c', status } });
    assert.equal(record.chat.resumeRun, true, `${status} must continue where it stopped`);
  }
  assert.deepEqual([...RESUMABLE_STATUSES].sort(), ['interrupted', 'running', 'starting agent'],
    'the resumable set is exactly "the process died mid-work"');
});

test('the record survives a round trip and never leaks junk', () => {
  const { store, dir } = makeStore();
  const record = store.capture({
    tabs: [
      { url: 'https://example.com', title: 'Example', active: false },
      { url: 'javascript:alert(1)', title: 'nope' },
      { url: '', title: 'empty' }
    ],
    chat: { conversationId: 'run-7', title: 'T', task: 'T', status: 'paused' }
  });
  assert.equal(record.tabs.length, 1, 'only real pages are restorable');
  assert.equal(record.tabs[0].active, true, 'exactly one tab is active');
  assert.equal(store.save(record), true);
  const loaded = store.load();
  assert.equal(loaded.chat.conversationId, 'run-7');
  assert.equal(loaded.tabs[0].url, 'https://example.com');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an empty or corrupt file restores nothing instead of crashing', () => {
  const { store, dir } = makeStore();
  assert.equal(store.load(), null, 'no file, no session');
  fs.writeFileSync(path.join(dir, 'dev-session.json'), '{not json');
  assert.equal(store.load(), null, 'a corrupt session is ignored');
  assert.equal(normalizeDevSession({ tabs: [], chat: null }), null, 'nothing to restore is not a session');
});

test('the resume switch belongs to the launcher, not to a normal dev start', () => {
  assert.equal(devResumeRequested({}), false, 'a plain npm run desktop:dev must not resurrect a session');
  assert.equal(devResumeRequested({ BROWSER_USE_DEV_RESUME: '0' }), false);
  assert.equal(devResumeRequested({ BROWSER_USE_DEV_RESUME: '1' }), true);
});

test('the app writes the session, restores the tabs and hands the chat to the renderer', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  assert.match(main, /new DevSessionStore\(\{/, 'the main process owns the session file');
  assert.match(main, /captureDevSession\(\);\s*\r?\n\s*const state = currentState\(\);/, 'every state publish refreshes the session');
  assert.match(main, /devResumeRequested\(\) \? devSession\.load\(\) : null/, 'the resume only happens when the launcher asked for it');
  assert.match(main, /pendingDevResume = resumeRecord\.chat/, 'the chat rides the resume');
  assert.match(main, /safeIpcSend\(event\.sender, 'browser-use:dev-resume'/, 'the renderer receives the resume payload when it is ready');
  assert.match(main, /captureDevSession\(\{ force: true \}\)/, 'quitting flushes the final state');

  const preload = fs.readFileSync(path.join(process.cwd(), 'desktop/preload.cjs'), 'utf8');
  assert.match(preload, /onDevResume: \(listener\) => ipcRenderer\.on\('browser-use:dev-resume'/, 'the bridge exposes the resume event');

  const renderer = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  assert.match(renderer, /async function applyDevResume\(payload\)/, 'the renderer has a resume handler');
  assert.match(renderer, /await openConversation\(conversationId\)/, 'the SAME conversation is reopened');
  assert.match(renderer, /continuation: true,\s*\r?\n\s*conversationId,/, 'an unfinished run continues on that conversation');
  assert.match(renderer, /onDevResume\?\./, 'the handler is wired to the bridge');
});

test('the launcher scripts exist and kill only this checkout', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(pkg.scripts['desktop:dev_resume'], 'node scripts/dev-resume.mjs');
  assert.equal(pkg.scripts['desktop:dev_restart'], 'node scripts/dev-resume.mjs --fresh');
  assert.equal(pkg.scripts['desktop:dev_kill'], 'node scripts/dev-resume.mjs --kill-only');
  const launcher = fs.readFileSync(path.join(process.cwd(), 'scripts/dev-resume.mjs'), 'utf8');
  assert.match(launcher, /BROWSER_USE_DEV_RESUME/, 'the launcher sets the resume switch');
  assert.match(launcher, /delete env\.ELECTRON_RUN_AS_NODE/, 'electron must launch as an app, not as Node');
  assert.match(launcher, /StartsWith\(\$marker/, 'the kill is scoped to this checkout');
  assert.ok(fs.existsSync(path.join(process.cwd(), 'scripts/dev-resume.bat')), 'a one-click / agent-runnable wrapper exists');
  // A copy of the repo shares %APPDATA%\browser-use with the original unless it
  // is given its own profile; two builds then fight over the instance lock.
  assert.match(launcher, /BROWSER_USE_USER_DATA_DIR/, 'a copy can run on its own profile');
  assert.match(launcher, /--user-data-dir=/, 'the profile override reaches Electron');
});

test('the restart timer runs in an EXTERNAL shell, not in the app terminal', () => {
  // The agent lives inside the app: anything it spawns from the app's terminal
  // dies with the app. The timer therefore has to be handed to an outside
  // shell (`cmd /c start ...`), which is exactly what a .bat with a timer is.
  const launcher = fs.readFileSync(path.join(process.cwd(), 'scripts/dev-resume.mjs'), 'utf8');
  assert.match(launcher, /spawn\('cmd\.exe', \['\/c', 'start', '', '\/min', 'cmd\.exe', '\/c', timerScript\]/,
    'the deferred restart is launched through an external cmd');
  assert.doesNotMatch(launcher, /spawn\(process\.execPath, \[fileURLToPath\(import\.meta\.url\), '--kill-and-launch'/,
    'the timer must never be a child of the app terminal');

  const timerScript = fs.readFileSync(path.join(process.cwd(), 'scripts/dev-resume-deferred.bat'), 'utf8');
  assert.match(timerScript, /Start-Sleep -Seconds %SECS%/, 'the wait is a real external sleep');
  assert.doesNotMatch(timerScript, /^timeout \/t/m,
    'the wait must not be the console-bound timeout command (it exits at once when stdin is redirected)');
  assert.match(timerScript, /ping -n %PING%/, 'a console-free fallback exists');
  assert.match(timerScript, /--kill-and-launch/, 'the timer finishes by running the restart worker');
  assert.match(timerScript, /dev-resume-helper\.log/, 'the external timer leaves a trace');
});

