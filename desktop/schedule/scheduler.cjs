'use strict';

const cron = require('./cron.cjs');
const { externalProviderBlock } = require('../agent/desktopChatAgent.cjs');
const { SCHEDULE_RETRY_DELAYS_MS } = require('../agent/providers/retry.cjs');
const { PROGRAMMATIC_ACTIONS, normalizeJob, normalizeSchedule, normalizeExecution } = require('./schedulerStore.cjs');
const RETRY_DELAYS_MS = SCHEDULE_RETRY_DELAYS_MS;

// A task that completed with an honest success:false result is not retried:
// the model already spent its in-loop recoveries, and the next scheduled
// occurrence will try again. Provider/connection failures retry on the ladder.
function classifyOutcome(run) {
  if (!run) return { outcome: 'failed', retryable: true, error: 'The scheduled run never produced a result.' };
  const result = run.result || {};
  if (run.status === 'completed' && result.success === true) return { outcome: 'succeeded', retryable: false, error: '' };
  if (run.status === 'cancelled') return { outcome: 'cancelled', retryable: false, error: 'The run was cancelled.' };
  const message = String(result.summary || result.error || run.error || '').replace(/\s+/g, ' ').trim();
  if (externalProviderBlock({ message })) return { outcome: 'failed', retryable: false, error: message.slice(0, 1000) };
  if (run.status === 'failed') return { outcome: 'failed', retryable: true, error: message.slice(0, 1000) || 'The run failed.' };
  return { outcome: 'failed', retryable: false, error: message.slice(0, 1000) || 'The task reported failure.' };
}

// LORDE_SCHEDULE_PAST_ERROR_V1 — "no future fire time" told the user nothing.
// Explain WHY the schedule cannot fire and what to change, per schedule type.
function describeNoFireTime(job) {
  const schedule = job.schedule || {};
  const fmt = (ms) => { try { return new Date(Number(ms)).toLocaleString(); } catch { return String(ms); } };
  if (schedule.type === 'once') {
    const when = Number(schedule.startAt);
    if (Number.isFinite(when) && when <= Date.now()) {
      return `That one-time slot has already passed (it was set for ${fmt(when)}). Pick a time in the future — for example about 30 minutes from now — or switch the schedule to daily/weekly.`;
    }
    return 'This one-time schedule has no valid future time. Pick a future date and time.';
  }
  if (schedule.type === 'monthly') {
    return `Day ${String(schedule.dayOfMonth || '')} never occurs with the current settings (for example February 30). Choose a day that exists in every targeted month, or use a different schedule type.`;
  }
  if (schedule.type === 'cron') {
    return `The cron expression "${String(schedule.cron || '')}" never matches a future time. Check the minute/hour/day fields — every field combination must be able to occur.`;
  }
  return 'This schedule never matches a future time. Adjust the time or days so at least one upcoming occurrence exists.';
}

function nextJobDue(job, afterMs = Date.now()) {
  const schedule = job.schedule || normalizeSchedule({}, job);
  if (schedule.type === 'once') return Number(schedule.startAt) > afterMs ? Number(schedule.startAt) : null;
  if (schedule.type === 'interval') return afterMs + Number(schedule.intervalSeconds || job.everySeconds || 60) * 1000;
  const [hour, minute] = String(schedule.time || '00:00').split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) throw new Error('Schedule time must be HH:MM.');
  if (schedule.type === 'cron') {
    if (!schedule.cron) throw new Error('Advanced cron schedules require an expression.');
    return cron.nextDue(schedule.cron, afterMs);
  }
  const dayField = schedule.type === 'monthly'
    ? String(schedule.dayOfMonth || 1)
    : (schedule.type === 'weekdays' || schedule.type === 'weekly' ? (schedule.weekdays || []).join(',') : '*');
  const dow = schedule.type === 'weekdays' || schedule.type === 'weekly' ? dayField : '*';
  const dom = schedule.type === 'monthly' ? dayField : '*';
  return cron.nextDue(`${minute} ${hour} ${dom} * ${dow}`, afterMs);
}

function nextDuePreview(job, afterMs = Date.now(), count = 3) {
  const due = [];
  let cursor = afterMs;
  for (let index = 0; index < Math.max(1, Math.min(10, count)); index += 1) {
    const next = nextJobDue(job, cursor);
    if (!Number.isFinite(next)) break;
    due.push(next);
    cursor = next;
    if (job.schedule?.type === 'once') break;
  }
  return due;
}

// One next-due timer, claim-before-dispatch, missed ticks coalesced on load.
class Scheduler {
  constructor({ store, pool, now = () => Date.now(), publish = () => {}, maxConcurrentJobs = 3, retryDelaysMs = RETRY_DELAYS_MS, executeProgrammatic = null, resolveProvider = null, loadConversation = null }) {
    this.store = store;
    this.pool = pool;
    this.now = now;
    this.publish = publish;
    this.maxConcurrentJobs = maxConcurrentJobs;
    this.retryDelaysMs = retryDelaysMs;
    this.executeProgrammatic = executeProgrammatic;
    // Scheduled runs ride the provider selected in the chat settings; retries
    // continue the first attempt's checkpointed conversation (loaded by id).
    this.resolveProvider = resolveProvider;
    this.loadConversation = loadConversation;
    this.timer = null;
    this.inFlight = new Map(); // occurrenceId -> true
    this.stopped = false;
  }

  // Scheduled runs must ride the SAME fully-resolved provider config a chat
  // run gets (id + model + baseUrl/connectionId). The old bare {id} fell
  // through to the agent's empty-model default and the run died before the
  // prompt was ever delivered to a model. A resolver error propagates to the
  // dispatch catch and lands in the occurrence's lastError.
  resolveJobProvider(job) {
    const explicitId = String(job.execution?.providerId || job.providerId || '').trim();
    if (typeof this.resolveProvider === 'function') {
      const resolved = this.resolveProvider(explicitId || null);
      if (resolved && resolved.id) return resolved;
    }
    return explicitId ? { id: explicitId } : null;
  }

  start() {
    this.stopped = false;
    this.store.load();
    for (const job of this.store.jobs) {
      if (job.enabled && !Number.isFinite(job.nextRunAt)) this.store.updateJobRun(job.id, { nextRunAt: nextJobDue(job, this.now()) });
    }
    this.coalesceMissed();
    this.arm();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  createJob(input) {
    const normalized = normalizeJob({
      ...input,
      prompt: input.prompt ?? input.task,
      schedule: input.schedule || normalizeSchedule(input, input),
      execution: input.execution || normalizeExecution(input, input)
    });
    const duplicate = this.store.jobs.find(job =>
      (normalized.clientRequestId && job.clientRequestId === normalized.clientRequestId)
      || job.dedupeKey === normalized.dedupeKey
    );
    if (duplicate) return { ...duplicate, duplicate: true, nextRunAt: duplicate.nextRunAt };
    const due = nextJobDue(normalized, this.now());
    if (!Number.isFinite(due)) throw new Error(describeNoFireTime(normalized));
    const job = this.store.upsertJob({ ...normalized, nextRunAt: due });
    this.arm();
    this.publish({ type: 'schedule.changed' });
    return { ...job, nextRunAt: due, duplicate: false };
  }

  coalesceMissed() {
    const now = this.now();
    for (const job of this.store.jobs.filter(entry => entry.enabled)) {
      const missed = this.store.occurrences
        .filter(occurrence => occurrence.jobId === job.id && occurrence.status === 'pending' && occurrence.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt);
      if (!missed.length) continue;
      for (const occurrence of missed.slice(0, -1)) this.store.updateOccurrence(occurrence.id, { status: 'missed', finishedAt: now });
      if (!this.inFlight.has(missed.at(-1).id)) this.dispatch(job.id, missed.at(-1).id);
    }
  }

  arm() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.stopped) return;
    const dueTimes = this.store.jobs.filter(job => job.enabled && Number.isFinite(job.nextRunAt)).map(job => job.nextRunAt);
    if (!dueTimes.length) return;
    const next = Math.min(...dueTimes);
    const delay = Math.max(0, Math.min(next - this.now(), 24 * 60 * 60 * 1000));
    this.timer = setTimeout(() => this.tick(), delay);
    if (this.timer.unref) this.timer.unref();
  }

  async tick() {
    this.timer = null;
    const now = this.now();
    const due = this.store.jobs.filter(job => job.enabled && Number.isFinite(job.nextRunAt) && job.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
    for (const job of due) {
      const dueAt = job.nextRunAt;
      const nextDue = nextJobDue(job, Math.max(now, dueAt));
      this.store.updateJobRun(job.id, { nextRunAt: nextDue, lastRunAt: now });
      const occurrence = this.store.createOccurrence(job.id, dueAt);
      this.store.updateOccurrence(occurrence.id, {
        prompt: job.prompt,
        executionType: job.execution?.type,
        executionAction: job.execution?.action || null
      });
      if (job.schedule?.type === 'once') this.store.updateJobRun(job.id, { nextRunAt: null });
      this.dispatch(job.id, occurrence.id);
    }
    this.arm();
  }

  // Fire-and-forget: occurrence execution never blocks the timer. Retries
  // resume the same occurrence with continuation so checkpoints carry over.
  dispatch(jobId, occurrenceId) {
    const run = (async () => {
      const retries = this.retryDelaysMs.length;
      for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
        if (this.stopped) return;
        const job = this.store.job(jobId);
        const occurrence = this.store.occurrences.find(entry => entry.id === occurrenceId);
        if (!job || !occurrence || job.id !== occurrence.jobId) return;
        if (!job.enabled || ['cancelled', 'succeeded', 'missed'].includes(occurrence.status)) return;
        if (attempt > 1) await new Promise(resolve => setTimeout(resolve, this.retryDelaysMs[attempt - 2]));
        const claimed = this.store.claimOccurrence(occurrenceId);
        if (!claimed) return;
        // Claim-before-dispatch is real: the running status reaches disk
        // before any agent work starts.
        await this.store.flush();
        this.inFlight.set(occurrenceId, true);
        this.publish({ type: 'schedule.changed' });
        let runSnapshot = null;
        try {
          if (job.execution?.type === 'programmatic') {
            if (!PROGRAMMATIC_ACTIONS.includes(job.execution.action) || typeof this.executeProgrammatic !== 'function') throw new Error(`Unsupported scheduled programmatic action: ${job.execution?.action || '(missing)'}`);
            runSnapshot = await this.executeProgrammatic(job.execution.action, { job, occurrence, attempt });
          } else {
            // A retry continues the first attempt's conversation — but only
            // when that conversation is actually restorable. The old bare
            // continuation:true with no snapshot made the agent throw "could
            // not be restored" on every retry after the first.
            const conversationId = occurrence.conversationId || null;
            const conversation = conversationId && typeof this.loadConversation === 'function'
              ? this.loadConversation(conversationId)
              : null;
            const continues = attempt > 1 && (conversation || typeof this.loadConversation !== 'function');
            runSnapshot = await this.pool.run({
              task: job.prompt,
              label: `schedule:${job.name || job.id}`,
              settings: { controlMode: job.execution?.controlMode || job.controlMode, approvalMode: job.execution?.approvalMode || job.approvalMode, vision: 'auto', scheduled: true, scheduleId: job.id, occurrenceId },
              provider: this.resolveJobProvider(job),
              ...(conversationId ? { conversationId } : {}),
              ...(conversation ? { conversation } : {}),
              ...(continues ? { continuation: true } : {}),
              onStart: snapshot => { if (snapshot?.id) this.store.updateOccurrence(occurrenceId, { conversationId: snapshot.id, runId: snapshot.id }); }
            });
          }
        } catch (error) {
          runSnapshot = { status: 'failed', result: { error: String(error?.message || error) } };
        } finally {
          this.inFlight.delete(occurrenceId);
        }
        // Backstop: onStart can fire before the agent assigns its run object
        // (start() awaits attachment normalization first), leaving the
        // occurrence without a conversation id — which made every retry a
        // fresh orphan instead of a continuation. The terminal snapshot always
        // carries the real id; record it so the next attempt can continue it.
        if (runSnapshot?.id) this.store.updateOccurrence(occurrenceId, { conversationId: runSnapshot.id, runId: runSnapshot.id });
        const classified = classifyOutcome(runSnapshot);
        if (classified.outcome === 'succeeded') {
          this.store.updateOccurrence(occurrenceId, { status: 'succeeded', finishedAt: Date.now(), lastError: '', attempts: attempt });
          this.store.updateJobRun(jobId, { lastStatus: 'succeeded', lastSummary: String(runSnapshot?.result?.summary || '').slice(0, 2000) });
          this.publish({ type: 'schedule.changed' });
          return;
        }
        if (classified.outcome === 'cancelled') {
          this.store.updateOccurrence(occurrenceId, { status: 'cancelled', finishedAt: Date.now(), lastError: classified.error, attempts: attempt });
          this.publish({ type: 'schedule.changed' });
          return;
        }
        this.store.updateOccurrence(occurrenceId, { lastError: classified.error, attempts: attempt });
        const retriesLeft = retries - (attempt - 1);
        if (!classified.retryable || retriesLeft <= 0) {
          this.store.updateOccurrence(occurrenceId, { status: retriesLeft <= 0 ? 'exhausted' : 'failed', finishedAt: Date.now() });
          this.store.updateJobRun(jobId, { lastStatus: retriesLeft <= 0 ? 'exhausted' : 'failed', lastSummary: classified.error });
          this.publish({ type: 'schedule.changed' });
          return;
        }
        this.store.updateJobRun(jobId, { lastStatus: 'running', lastSummary: `Retry ${attempt} of ${retries} scheduled: ${classified.error}` });
        this.publish({ type: 'schedule.changed' });
      }
    })();
    return run;
  }

  status() {
    return {
      jobs: this.store.jobs.map(job => ({ ...job })),
      recentOccurrences: this.store.occurrences.slice(-40),
      inFlight: [...this.inFlight.keys()],
      queued: this.pool.activeCount
    };
  }

  // Shared by the chat tool and the renderer IPC surface.
  async manage(input = {}) {
    const action = String(input.action || 'list').toLowerCase();
    if (action === 'list') {
      return {
        jobs: this.status().jobs.map(job => ({
          ...job,
          task: job.prompt.slice(0, 500),
          prompt: job.prompt.slice(0, 500),
          nextRunAt: job.nextRunAt,
          nextRuns: nextDuePreview(job, this.now(), 3)
        })),
        recentOccurrences: this.status().recentOccurrences.slice(-15).map(({ id, jobId, dueAt, status, attempts, lastError, prompt, executionType, executionAction, startedAt, finishedAt }) => ({ id, jobId, dueAt, status, attempts, lastError, prompt, executionType, executionAction, startedAt, finishedAt }))
      };
    }
    if (action === 'preview') {
      const prompt = String(input.prompt ?? input.task ?? '').trim();
      // Preview is allowed while the task draft is still empty; creation remains strict.
      const candidate = normalizeJob({ ...input, prompt, task: prompt, schedule: input.schedule || input, execution: input.execution || input });
      const nextRuns = nextDuePreview(candidate, this.now(), Number(input.count) || 3);
      if (!nextRuns.length) throw new Error(describeNoFireTime(candidate));
      return { schedule: candidate.schedule, execution: candidate.execution, nextRuns, nextRunAt: nextRuns[0] };
    }
    if (action === 'create') {
      const prompt = String(input.prompt ?? input.task ?? '').trim();
      const execution = input.execution || normalizeExecution(input, input);
      const hasSchedule = Boolean(input.schedule || input.cron || input.everySeconds || input.startAt || input.type);
      if (!hasSchedule) throw new Error('schedule_task create requires a schedule or task time (cron/everySeconds are also accepted).');
      if (!prompt && execution.type !== 'programmatic') throw new Error('Create a task with an instruction for the agent.');
      if (input.execution?.type === 'programmatic' && !PROGRAMMATIC_ACTIONS.includes(String(input.execution.action || ''))) throw new Error('Only supported built-in actions may run programmatically.');
      return this.createJob({
        ...input,
        name: String(input.name || prompt.slice(0, 60) || execution.action || 'Scheduled task').slice(0, 120),
        prompt,
        task: prompt,
        schedule: input.schedule || input,
        execution,
        clientRequestId: input.clientRequestId,
        enabled: true
      });
    }
    const jobId = String(input.jobId || '');
    const job = this.store.job(jobId);
    if (!job) throw new Error(`No scheduled job with id ${jobId || '(missing)'}; use action=list to get job ids.`);
    if (action === 'update') {
      const prompt = String(input.prompt ?? input.task ?? job.prompt).trim();
      const updated = normalizeJob({ ...job, ...input, id: job.id, prompt, task: prompt, schedule: input.schedule || (input.type ? input : job.schedule), execution: input.execution || job.execution, updatedAt: Date.now() });
      const due = nextJobDue(updated, this.now());
      const saved = this.store.upsertJob({ ...updated, nextRunAt: due });
      this.arm();
      this.publish({ type: 'schedule.changed' });
      return { ...saved, nextRunAt: due };
    }
    if (action === 'pause') {
      this.store.upsertJob({ ...job, enabled: false });
      this.publish({ type: 'schedule.changed' });
      return { ...job, enabled: false };
    }
    if (action === 'resume') {
      this.store.upsertJob({ ...job, enabled: true, nextRunAt: Number.isFinite(job.nextRunAt) ? job.nextRunAt : nextJobDue(job, this.now()) });
      this.arm();
      this.publish({ type: 'schedule.changed' });
      return { ...job, enabled: true };
    }
    if (action === 'remove') {
      this.cancelJobRuns(jobId);
      this.store.removeJob(jobId);
      this.arm();
      this.publish({ type: 'schedule.changed' });
      return { removed: true, jobId };
    }
    throw new Error(`Unsupported schedule_task action: ${action}`);
  }

  cancelJobRuns(jobId) {
    const running = this.store.occurrences.filter(occurrence => occurrence.jobId === jobId && occurrence.status === 'running');
    for (const occurrence of running) {
      const entry = this.pool.activeRuns.find(candidate => candidate.instance?.state?.()?.id === occurrence.conversationId);
      if (entry) { try { entry.instance.cancel(occurrence.conversationId); } catch { /* already terminal */ } }
    }
    return running.length;
  }
}

module.exports = { Scheduler, RETRY_DELAYS_MS, classifyOutcome, nextJobDue, nextDuePreview };
