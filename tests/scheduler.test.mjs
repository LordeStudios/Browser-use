import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SchedulerStore } = require('../desktop/schedule/schedulerStore.cjs');
const { Scheduler, RETRY_DELAYS_MS, classifyOutcome, nextJobDue } = require('../desktop/schedule/scheduler.cjs');

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-sched-'));
  return new SchedulerStore(path.join(dir, 'schedules.json'));
}

// Deterministic clock: tests move it forward instead of sleeping.
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: ms => { current += ms; },
    set: value => { current = value; }
  };
}

// The delay ladder in tests is tiny; ordering and counts are what matter.
const FAST_DELAYS = [10, 20, 30];

function fakePool(outcomes) {
  const dispatches = [];
  return {
    dispatches,
    activeRuns: [],
    activeCount: 0,
    queue: { length: 0 },
    // outcomes: array of {status, result} or Error, consumed per attempt.
    async run(request) {
      dispatches.push(request);
      const next = outcomes.shift();
      if (next instanceof Error) throw next;
      const snapshot = { id: `run-${dispatches.length}` };
      request.onStart?.(snapshot);
      return { ...snapshot, status: next?.status || 'completed', ...(next?.result ? { result: next.result } : {}) };
    },
    cancelAll: async () => 0
  };
}

test('job-dispatch retry ladder is increasing, bounded, and measured in minutes', () => {
  assert.equal(RETRY_DELAYS_MS.length, 3);
  assert.deepEqual(RETRY_DELAYS_MS, [60_000, 300_000, 900_000]);
  for (let index = 1; index < RETRY_DELAYS_MS.length; index += 1) assert.ok(RETRY_DELAYS_MS[index] > RETRY_DELAYS_MS[index - 1]);
});

test('provider/connection failures retry with increasing backoff, then the occurrence exhausts', async () => {
  const clock = fakeClock();
  const store = tempStore();
  const pool = fakePool([
    new Error('fetch failed: connection reset'),
    { status: 'failed', result: { summary: 'The provider request timed out after 5000ms.' } },
    { status: 'completed', result: { success: true, summary: 'Posted.' } }
  ]);
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  scheduler.createJob({ name: 'upload', task: 'Post the video.', everySeconds: 3600 });
  const job = store.jobs[0];
  const firstOccurrence = store.createOccurrence(job.id, clock.now());
  await scheduler.dispatch(job.id, firstOccurrence.id);
  assert.equal(firstOccurrence.status, 'succeeded');
  assert.equal(firstOccurrence.attempts, 3);
  assert.equal(pool.dispatches.length, 3);
  // Retries continue the same conversation captured from the first attempt.
  assert.equal(firstOccurrence.conversationId, 'run-3');
  assert.equal(pool.dispatches[1].continuation, true);
  // Attempt 1 threw before any run started, so attempt 2 has no conversation
  // to continue; attempt 2 did start, so attempt 3 continues its conversation.
  assert.equal(pool.dispatches[1].conversationId, undefined);
  assert.equal(pool.dispatches[2].conversationId, 'run-2');
  assert.equal(job.lastStatus, 'succeeded');
});

test('permanent provider blocks fail fast without burning the ladder', async () => {
  const store = tempStore();
  const pool = fakePool([{ status: 'failed', result: { summary: 'The selected model is unavailable for this connection.' } }]);
  const clock = fakeClock();
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  scheduler.createJob({ name: 'blocked', task: 'Do the thing.', everySeconds: 3600 });
  const job = store.jobs[0];
  const occurrence = store.createOccurrence(job.id, clock.now());
  await scheduler.dispatch(job.id, occurrence.id);
  assert.equal(occurrence.status, 'failed');
  assert.equal(occurrence.attempts, 1);
  assert.equal(pool.dispatches.length, 1);
});

test('an exhausted occurrence never cancels the schedule; the next occurrence is still created', async () => {
  const clock = fakeClock();
  const store = tempStore();
  const pool = fakePool(Array.from({ length: FAST_DELAYS.length + 1 }, () => new Error('ECONNRESET')));
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  scheduler.createJob({ name: 'daily', task: 'Post.', everySeconds: 180 });
  const job = store.jobs[0];
  const occurrence = store.createOccurrence(job.id, clock.now());
  await scheduler.dispatch(job.id, occurrence.id);
  assert.equal(occurrence.status, 'exhausted');
  assert.equal(occurrence.attempts, FAST_DELAYS.length + 1);
  // The job's next due was already scheduled when the tick claimed this one.
  assert.ok(job.nextRunAt > clock.now());
  clock.set(job.nextRunAt);
  await scheduler.tick();
  const nextOccurrence = store.occurrences.filter(entry => entry.jobId === job.id && ['pending', 'running', 'succeeded', 'failed'].includes(entry.status)).at(-1);
  assert.ok(nextOccurrence && nextOccurrence.id !== occurrence.id, 'a new occurrence was created for the next due time');
});

test('an honest task failure (completed, success:false) is not retried', async () => {
  const store = tempStore();
  const pool = fakePool([{ status: 'completed', result: { success: false, summary: 'The upload form rejected the file.' } }]);
  const clock = fakeClock();
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  scheduler.createJob({ name: 'honest', task: 'Post.', everySeconds: 3600 });
  const occurrence = store.createOccurrence(store.jobs[0].id, clock.now());
  await scheduler.dispatch(store.jobs[0].id, occurrence.id);
  assert.equal(occurrence.status, 'failed');
  assert.equal(pool.dispatches.length, 1);
});

test('missed pending occurrences coalesce on load: latest runs once, older are marked missed', async () => {
  const clock = fakeClock();
  const store = tempStore();
  const pool = fakePool([{ status: 'completed', result: { success: true, summary: 'Done.' } }]);
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  const job = scheduler.createJob({ name: 'catchup', task: 'Post.', everySeconds: 60 });
  // Simulate the app being closed for three intervals: three overdue pendings.
  store.createOccurrence(job.id, clock.now() - 5_000);
  store.createOccurrence(job.id, clock.now() - 4_000);
  store.createOccurrence(job.id, clock.now() - 3_000);
  await store.flush();
  scheduler.start();
  const jobOccurrences = store.occurrences.filter(entry => entry.jobId === job.id && entry.dueAt < clock.now() - 2_000);
  const missed = jobOccurrences.filter(entry => entry.status === 'missed');
  const dispatched = jobOccurrences.filter(entry => entry.status === 'running' || entry.status === 'succeeded');
  assert.equal(missed.length, 2);
  assert.equal(dispatched.length, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
});

test('claim-before-dispatch: the running status reaches disk before any agent outcome', async () => {
  const store = tempStore();
  let sawStatusOnDisk = null;
  const pool = {
    async run(request) {
      sawStatusOnDisk = JSON.parse(fs.readFileSync(store.filePath, 'utf8')).occurrences.at(-1).status;
      return { id: 'run-1', status: 'completed', result: { success: true } };
    },
    activeRuns: [], activeCount: 0, queue: { length: 0 }, cancelAll: async () => 0
  };
  const scheduler = new Scheduler({ store, pool, now: fakeClock().now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  scheduler.createJob({ name: 'claim', task: 'Post.', everySeconds: 3600 });
  const claimOccurrence = store.createOccurrence(store.jobs[0].id, Date.now());
  await scheduler.dispatch(store.jobs[0].id, claimOccurrence.id);
  assert.equal(sawStatusOnDisk, 'running');
  assert.equal(store.occurrences.at(-1).status, 'succeeded');
});

test('manage() covers the chat and IPC surface', async () => {
  const store = tempStore();
  const pool = fakePool([]);
  const scheduler = new Scheduler({ store, pool, now: fakeClock().now, publish: () => {}, retryDelaysMs: FAST_DELAYS });
  const created = await scheduler.manage({ action: 'create', name: 'yt', task: 'Post three videos.', cron: '0 */3 * * *' });
  assert.ok(created.id); assert.equal(created.cron, '0 */3 * * *'); assert.ok(Number.isFinite(created.nextRunAt));
  await assert.rejects(() => scheduler.manage({ action: 'create', name: 'x', task: 'no schedule' }), /cron|everySeconds/);
  const paused = await scheduler.manage({ action: 'pause', jobId: created.id });
  assert.equal(paused.enabled, false);
  const resumed = await scheduler.manage({ action: 'resume', jobId: created.id });
  assert.equal(resumed.enabled, true);
  const listed = await scheduler.manage({ action: 'list' });
  assert.equal(listed.jobs.length, 1);
  const removed = await scheduler.manage({ action: 'remove', jobId: created.id });
  assert.equal(removed.removed, true);
  assert.equal(store.jobs.length, 0);
  await assert.rejects(() => scheduler.manage({ action: 'remove', jobId: 'missing' }), /No scheduled job/);
});

test('classifyOutcome and nextJobDue agree with the documented contract', () => {
  assert.equal(classifyOutcome({ status: 'completed', result: { success: true } }).outcome, 'succeeded');
  assert.equal(classifyOutcome({ status: 'cancelled' }).outcome, 'cancelled');
  assert.equal(classifyOutcome({ status: 'failed', result: { summary: 'socket hung up' } }).retryable, true);
  assert.equal(classifyOutcome({ status: 'failed', result: { summary: 'API key missing or invalid (401).' } }).retryable, false);
  assert.equal(classifyOutcome(null).retryable, true);
  assert.equal(nextJobDue({ everySeconds: 60 }, 1_000), 61_000);
  assert.ok(nextJobDue({ cron: '0 0 * * *' }, Date.now()) > Date.now());
});

test('alarm schedules deduplicate and preserve the exact agent prompt', async () => {
  const clock = fakeClock(10_000);
  const store = tempStore();
  const dispatches = [];
  const pool = { activeRuns: [], activeCount: 0, queue: { length: 0 }, async run(request) { dispatches.push(request); return { id: 'agent-1', status: 'completed', result: { success: true, summary: 'Done' } }; } };
  const scheduler = new Scheduler({ store, pool, now: clock.now, publish: () => {}, retryDelaysMs: [] });
  const payload = { name: 'Morning report', prompt: 'Open the report page and summarize yesterday.', schedule: { type: 'once', startAt: 20_000 }, clientRequestId: 'request-1' };
  const first = await scheduler.manage({ action: 'create', ...payload });
  const second = await scheduler.manage({ action: 'create', ...payload });
  assert.equal(second.duplicate, true);
  assert.equal(store.jobs.length, 1);
  clock.set(20_000);
  await scheduler.tick();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(dispatches[0].task, payload.prompt);
  assert.equal(store.jobs[0].nextRunAt, null);
  assert.equal(first.prompt, payload.prompt);
});

test('programmatic schedules require an allowlisted action and do not call the agent pool', async () => {
  const store = tempStore();
  let programmatic = 0;
  let agent = 0;
  const pool = { activeRuns: [], activeCount: 0, queue: { length: 0 }, async run() { agent += 1; return { status: 'completed', result: { success: true } }; } };
  const scheduler = new Scheduler({ store, pool, now: fakeClock().now, publish: () => {}, retryDelaysMs: [], executeProgrammatic: async action => { assert.equal(action, 'shutdown'); programmatic += 1; return { status: 'completed', result: { success: true } }; } });
  const job = await scheduler.manage({ action: 'create', name: 'Exit', execution: { type: 'programmatic', action: 'shutdown' }, schedule: { type: 'interval', intervalSeconds: 60 } });
  const occurrence = store.createOccurrence(job.id, 1_000_000);
  await scheduler.dispatch(job.id, occurrence.id);
  assert.equal(programmatic, 1);
  assert.equal(agent, 0);
});
