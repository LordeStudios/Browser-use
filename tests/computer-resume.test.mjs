import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { COMPUTER_TOOLS, isComputerTool } = require('../desktop/computer/computerCatalog.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { createDevRestartScheduler, DEFAULT_COOLDOWN_MS } = require('../desktop/devRestart.cjs');
const { toolDefinitions } = require('../desktop/agent/agentInternals.cjs');

// The agent used to restart itself by shelling out to the launcher. That
// command looked "still running" in its terminal, so it retried, and every
// retry queued another restart — the app restarted forever. computer_resume
// is the one supported way: it answers synchronously, schedules exactly one
// restart, and refuses a second one while the first is still fresh.

test('computer_resume exists as a computer tool with optional arguments', () => {
  const tool = COMPUTER_TOOLS.find((entry) => entry.name === 'computer_resume');
  assert.ok(tool, 'the tool is defined');
  assert.equal(isComputerTool('computer_resume'), true, 'it routes through the computer backend');
  assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['graceSeconds', 'reason']);
  assert.deepEqual(tool.inputSchema.required, [], 'nothing is required: the defaults are the safe path');
  assert.match(tool.description, /ONCE per change set/, 'the contract says once per change');
  assert.match(tool.description, /browser_done/, 'the contract says to end the turn');
});

test('the tool is offered exactly where a restart makes sense', () => {
  const coding = toolDefinitions('fix the bug in src/index.js and run the tests', 'agi', { workspace: true }).map((tool) => tool.name);
  assert.ok(coding.includes('computer_resume'), 'a coding run in agi mode can restart itself');
  const headless = toolDefinitions('fix the bug in src/index.js', 'agi', { workspace: true, headlessComputer: true }).map((tool) => tool.name);
  assert.ok(!headless.includes('computer_resume'), 'a headless run IS the process; it must not restart itself');
  const browser = toolDefinitions('fix the bug', 'browser', { workspace: true }).map((tool) => tool.name);
  assert.ok(!browser.includes('computer_resume'), 'browser mode has no host tools at all');
});

test('a scheduled restart is reported truthfully and immediately', async () => {
  const calls = [];
  const tools = new ComputerTools({ restartApp: (request) => { calls.push(request); return { ok: true, scheduled: true, graceSeconds: 5, note: 'end your turn' }; } });
  const result = await tools.execute('computer_resume', { reason: 'new drag fix' }, 'owner-1');
  assert.equal(result.ok, true);
  assert.equal(result.scheduled, true);
  assert.equal(calls.length, 1, 'the app scheduled exactly one restart');
  assert.deepEqual(calls[0], { graceSeconds: 5, reason: 'new drag fix' });
});

test('a second restart is refused, and the refusal tells the agent to keep working', async () => {
  // This is the loop breaker: the resumed run calls the tool again, and the
  // app answers "already restarted" instead of scheduling another kill.
  const tools = new ComputerTools({
    restartApp: () => ({ ok: false, alreadyRestarted: true, secondsLeft: 42, note: 'The app was already restarted 18s ago… Do NOT restart again — continue the work.' })
  });
  const result = await tools.execute('computer_resume', {}, 'owner-1');
  assert.equal(result.ok, false);
  assert.equal(result.alreadyRestarted, true);
  assert.match(result.note, /already restarted/i);
  assert.match(result.note, /Do NOT restart again/, 'the model is told, in words, not to loop');
});

test('a build without a restart hook says so instead of pretending', async () => {
  const tools = new ComputerTools({});
  const result = await tools.execute('computer_resume', {}, 'owner-1');
  assert.equal(result.ok, false);
  assert.match(result.note, /cannot restart itself/);
  assert.match(result.note, /do not retry/i, 'no retry, no loop');
});

test('the app owns the restart: dev-only, single timer, cooldown that survives the restart', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  assert.match(main, /restartApp: scheduleDevRestart,/, 'the computer backend is wired to the app scheduler');
  assert.match(main, /createDevRestartScheduler\(\{/, 'the scheduling rules live in the tested module');
  assert.match(main, /if \(result\?\.ok\) captureDevSession\(\{ force: true \}\);/, 'the session is flushed before the kill');
  const scheduler = fs.readFileSync(path.join(process.cwd(), 'desktop/devRestart.cjs'), 'utf8');
  assert.match(scheduler, /const DEFAULT_COOLDOWN_MS = 60_000;/, 'there is a cooldown');
  assert.match(scheduler, /dev-restart\.json/, 'the cooldown marker is persisted, so it survives the restart');
  assert.match(scheduler, /if \(isPackaged\)/, 'a packaged build never restarts itself');
  assert.match(scheduler, /spawn\('cmd\.exe', \['\/c', 'start', '', '\/min', 'cmd\.exe', '\/c', timerScript\]/,
    'the restart runs in an external timer, not in the app terminal');
});

test('a restart is scheduled once, then refused until the cooldown expires', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-restart-'));
  const timerScript = path.join(dir, 'timer.bat');
  fs.writeFileSync(timerScript, '@echo off\n');
  let clock = 1_000_000;
  const spawned = [];
  const makeScheduler = () => createDevRestartScheduler({
    userDataDir: dir,
    timerScript,
    repoRoot: dir,
    spawn: (...args) => { spawned.push(args); return { unref() {} }; },
    now: () => clock
  });

  const scheduler = makeScheduler();
  const first = scheduler.schedule({ graceSeconds: 5, reason: 'fix the drag loop' });
  assert.equal(first.ok, true);
  assert.equal(first.scheduled, true);
  assert.equal(spawned.length, 1, 'exactly one timer is spawned');
  assert.match(first.note, /End your turn NOW with browser_done/);

  // The agent retries immediately (this is what produced the loop).
  const second = scheduler.schedule({});
  assert.equal(second.ok, false);
  assert.equal(second.alreadyRestarted, true);
  assert.equal(spawned.length, 1, 'a retry must never queue another restart');
  assert.match(second.note, /Do NOT restart again/);

  // A FRESH scheduler (the app after the restart) still refuses: the marker
  // is on disk, which is what stops the loop across the restart itself.
  clock += 10_000;
  const afterRestart = makeScheduler();
  const third = afterRestart.schedule({});
  assert.equal(third.ok, false, 'the cooldown survives the restart');
  assert.equal(spawned.length, 1);

  // After the cooldown a new change may restart again.
  clock += DEFAULT_COOLDOWN_MS + 1_000;
  const fourth = afterRestart.schedule({ reason: 'second change' });
  assert.equal(fourth.ok, true, 'a genuinely new change can restart once the cooldown passed');
  assert.equal(spawned.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a packaged build and a missing timer are refused, never faked', () => {
  const existing = path.join(process.cwd(), 'package.json');
  const packaged = createDevRestartScheduler({ isPackaged: true, timerScript: existing, spawn: () => { throw new Error('must not spawn'); } });
  const packagedResult = packaged.schedule({});
  assert.equal(packagedResult.ok, false);
  assert.match(packagedResult.note, /packaged build cannot restart itself/);

  const missing = createDevRestartScheduler({ timerScript: path.join(os.tmpdir(), 'nope-does-not-exist.bat'), spawn: () => { throw new Error('must not spawn'); } });
  const missingResult = missing.schedule({});
  assert.equal(missingResult.ok, false);
  assert.match(missingResult.note, /timer is missing/);
});

test('the resumed run is told the restart already happened', () => {
  const renderer = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  const agent = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/desktopChatAgent.cjs'), 'utf8');
  // The renderer hands the CARD the main process built to the run, as an
  // opening notice AND as a card to inject into the conversation.
  assert.match(renderer, /initialAgentMessages: resumeNotice/, 'the continuation carries the notice from the card');
  assert.match(renderer, /resumeCard,\n      provider:/, 'the card itself is forwarded into the run');
  assert.match(renderer, /renderChatMessage\('agent-message', 'App resumed'/, 'the card is drawn in the transcript for the user');
  // main.cjs used to DROP the opening notices (they never reached the agent):
  // that drop is the reason the resumed run kept replanning its own restart.
  assert.match(main, /initialAgentMessages: Array\.isArray\(request\?\.initialAgentMessages\)/,
    'the opening notices are forwarded, not dropped');
  assert.match(main, /resumeCard: request\?\.resumeCard \|\| null/, 'the card rides to the agent');
  // The agent puts the card in its CONVERSATION (runtime + badge), so it stays
  // in context for every decision — not just the first one — and is saved
  // with the conversation, so the next restart knows about this one too.
  assert.match(agent, /const resumeCard = request\?\.resumeCard;/, 'the agent reads the card');
  assert.match(agent, /appendConversationMessage\(run, 'user', String\(resumeCard\.content\)\.slice\(0, 2000\), \{\s*\r?\n\s*source: 'runtime',/,
    'the card is injected into the conversation as a runtime message');
  assert.match(agent, /badge: String\(resumeCard\.badge \|\| 'app restart'\)/, 'the card carries the badge');
});
