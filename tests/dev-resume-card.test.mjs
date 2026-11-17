import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildResumeCard, buildResumeCardFrom } = require('../desktop/devResumeCard.cjs');
const { createDevRestartScheduler, DEFAULT_COOLDOWN_MS, CHAIN_WINDOW_MS } = require('../desktop/devRestart.cjs');

// THE RESUME CARD — the proof that this app really restarted, with the
// timestamp. The agent restarts itself to make a change live, and when it
// comes back it used to have NO memory of the restart: the conversation it
// resumed looked exactly like the one it left, so it re-planned the same
// "restart the app" step. Nine restarts, one after another. The card is the
// evidence that closes that loop, and the marker is what makes it countable.

const BASE = 1_700_000_000_000;

test('a confirmed card states the restart, the timestamp and forbids another one', () => {
  const card = buildResumeCard({ resumedAt: BASE, restartedAt: BASE - 8_000, restartCount: 3, reason: 'make the drag fix live', confirmed: true });
  assert.equal(card.badge, 'app restart');
  assert.match(card.content, /RESTART RESUMED/, 'the card names what happened');
  assert.match(card.content, /restart #3 of this session/, 'the loop counter is visible to the model');
  assert.match(card.content, /resumed at 2023-11-14T22:13:20\.000Z/, 'the timestamp is in the card');
  assert.match(card.content, /The restart is DONE/, 'the restart is declared finished');
  assert.match(card.content, /do NOT call computer_resume again/, 'a second restart is forbidden');
  assert.match(card.content, /make the drag fix live/, 'the reason travels');
  assert.match(card.displayContent, /Resumed at 2023-11-14T22:13:20\.000Z/, 'the human-facing card carries the timestamp too');
});

test('an unconfirmed card tells the model to VERIFY instead of trusting the restart', () => {
  // The app was relaunched by hand: no restart marker backs it, so "the
  // change is live" is an assumption the model must not make.
  const card = buildResumeCard({ resumedAt: BASE, restartCount: 0, confirmed: false });
  assert.equal(card.confirmed, false);
  assert.match(card.content, /NO agent-scheduled restart backs it/, 'the card is honest about what it cannot prove');
  assert.match(card.content, /verify whether the change is actually live/, 'verification is demanded');
  assert.doesNotMatch(card.content, /The restart is DONE/, 'it does NOT claim the restart finished');
});

test('a FAILED restart says so: the app came back but nothing was restored', () => {
  const card = buildResumeCard({ resumedAt: BASE, restartCount: 2, confirmed: true, restored: false });
  assert.equal(card.restored, false);
  assert.match(card.content, /NO previous session was restored/, 'the failure is stated plainly');
  assert.match(card.content, /do NOT try to restore or replay anything/, 'the model is told to start fresh, not replay');
  assert.match(card.displayContent, /no previous conversation was restored/);
});

test('the card is built from the marker and the session record', () => {
  // CONFIRMED: the restart was scheduled at T, and the session was captured
  // right after (that is the order scheduleDevRestart uses: marker, then
  // session flush), so this process provably came back from that restart.
  const confirmed = buildResumeCardFrom({ record: { savedAt: BASE + 5_000, chat: { conversationId: 'c' } }, marker: { at: BASE, reason: 'r', count: 2 }, now: BASE + 20_000 });
  assert.equal(confirmed.confirmed, true, 'a session captured after the marker confirms the restart');
  assert.equal(confirmed.restartCount, 2, 'the chain count rides on the card');

  // UNCONFIRMED: no marker — the app was relaunched by hand.
  const manual = buildResumeCardFrom({ record: { savedAt: BASE, chat: { conversationId: 'c' } }, marker: null, now: BASE + 20_000 });
  assert.equal(manual.confirmed, false, 'no marker, no confirmed restart');

  // UNCONFIRMED: the session on disk predates the restart marker, so what was
  // restored does not prove this process came back from THAT restart.
  const stale = buildResumeCardFrom({ record: { savedAt: BASE - 60_000, chat: { conversationId: 'c' } }, marker: { at: BASE, reason: 'r', count: 2 }, now: BASE + 20_000 });
  assert.equal(stale.confirmed, false, 'a session older than the marker does not confirm the restart');

  // A restart with nothing restored is still a restart — the failed one.
  const failed = buildResumeCardFrom({ record: null, marker: { at: BASE, reason: 'r', count: 1 }, now: BASE + 20_000, restored: false });
  assert.equal(failed.confirmed, true, 'the restart itself is confirmed');
  assert.equal(failed.restored, false, 'but nothing came back with it');
  assert.match(failed.content, /NO previous session was restored/);
});

test('the runtime message keeps ONE card per kind: each restart replaces the last', () => {
  // The provider's runtime bundler keys notices on their leading label, so
  // the card's first line must produce a STABLE kind — otherwise nine
  // restarts would stack nine cards into the model's context.
  const labels = [1, 2, 3].map((n) => {
    const card = buildResumeCard({ resumedAt: BASE + n * 90_000, restartCount: n, confirmed: true });
    const head = String(card.content || '').split('\n')[0];
    return head.split(/[:—]/)[0].trim().toLowerCase();
  });
  assert.deepEqual(labels, ['restart resumed', 'restart resumed', 'restart resumed'],
    'the kind label is stable, so a newer card replaces an older one');
});

test('the restart marker counts the chain, so the loop is visible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-card-'));
  const timerScript = path.join(dir, 'timer.bat');
  fs.writeFileSync(timerScript, '@echo off\n');
  let clock = BASE;
  const scheduler = createDevRestartScheduler({
    userDataDir: dir, timerScript, repoRoot: dir, spawn: () => ({ unref() {} }), now: () => clock
  });
  const first = scheduler.schedule({ reason: 'change one' });
  assert.equal(first.ok, true);
  assert.equal(first.restartCount, 1, 'the first restart of a chain is #1');
  clock += DEFAULT_COOLDOWN_MS + 1_000;
  const second = scheduler.schedule({ reason: 'change one again' });
  assert.equal(second.ok, true);
  assert.equal(second.restartCount, 2, 'the next restart in the chain is #2');
  const record = scheduler.readMarkerRecord();
  assert.equal(record.count, 2, 'the marker carries the count');
  assert.match(record.reason, /change one again/, 'the marker carries the reason');

  // A chain that went quiet for longer than the chain window starts over.
  clock += CHAIN_WINDOW_MS + 60_000;
  const fresh = scheduler.schedule({ reason: 'a new change' });
  assert.equal(fresh.restartCount, 1, 'an old chain does not inflate the new count');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the wiring: the card is built in main, shown by the renderer, injected by the agent', () => {
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  const renderer = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  const agent = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/desktopChatAgent.cjs'), 'utf8');

  assert.match(main, /const resumeCard = resumeRequested\s*\r?\n?\s*\? buildResumeCardFrom\(\{/,
    'the card is built in the main process, the only place that knows the marker');
  assert.match(main, /marker: ensureDevRestart\(\)\?\.readMarkerRecord\?\.\(\) \|\| null/, 'the marker backs the card');
  assert.match(main, /pendingDevResume = resumeRecord\.chat \? \{ \.\.\.resumeRecord\.chat, \.\.\.\(resumeCard \? \{ resumeCard \} : \{\}\) \} : \(resumeCard \? \{ resumeCard \} : null\)/,
    'the card rides on the resume payload — and rides alone when nothing was restored');
  assert.match(renderer, /payload\.resumeCard \|\| null/, 'the renderer consumes the card');
  assert.match(renderer, /badge: 'app restart'/, 'the renderer shows the card with its badge');
  assert.match(agent, /appendConversationMessage\(run, 'user', String\(resumeCard\.content\)/,
    'the agent injects the card into its conversation');
});
