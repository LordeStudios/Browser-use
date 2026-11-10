'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SCHEMA_VERSION = 2;
const MAX_JOBS = 100;
const MAX_OCCURRENCES = 200;
const MAX_PROMPT_LENGTH = 8000;
const SCHEDULE_TYPES = Object.freeze(['once', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron']);
const PROGRAMMATIC_ACTIONS = Object.freeze(['shutdown']);

const OCCURRENCE_STATUSES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'missed', 'exhausted', 'cancelled']);

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeTime(value, fallbackMs = Date.now()) {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (match) return `${String(Math.min(23, Number(match[1]))).padStart(2, '0')}:${String(Math.min(59, Number(match[2]))).padStart(2, '0')}`;
  const date = new Date(Number(fallbackMs));
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function normalizeWeekdays(value, fallback = []) {
  const values = Array.isArray(value) ? value : fallback;
  return [...new Set(values.map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6))].sort((a, b) => a - b);
}

function normalizeSchedule(schedule = {}, legacy = {}) {
  const raw = schedule && typeof schedule === 'object' ? schedule : {};
  const legacyEvery = Number(legacy.everySeconds);
  let type = SCHEDULE_TYPES.includes(raw.type) ? raw.type : '';
  if (!type && Number.isFinite(legacyEvery) && legacyEvery >= 60) type = 'interval';
  if (!type && legacy.cron) type = 'cron';
  if (!type && finiteOrNull(raw.startAt || legacy.startAt)) type = 'once';
  if (!type) type = 'daily';

  const startAt = finiteOrNull(raw.startAt || legacy.startAt);
  const time = normalizeTime(raw.time, startAt || Date.now());
  if (type === 'once') return { type, startAt: startAt || Date.now(), time };
  if (type === 'interval') {
    const intervalSeconds = Number(raw.intervalSeconds ?? legacyEvery);
    return { type, intervalSeconds: Number.isFinite(intervalSeconds) && intervalSeconds >= 60 ? Math.round(intervalSeconds) : 60, time };
  }
  if (type === 'cron') return { type, cron: String(raw.cron || legacy.cron || '').trim().slice(0, 120), time };
  if (type === 'monthly') {
    const dayOfMonth = Number(raw.dayOfMonth || new Date(startAt || Date.now()).getDate());
    return { type, dayOfMonth: Math.max(1, Math.min(31, Math.round(dayOfMonth))), time };
  }
  const weekdays = normalizeWeekdays(raw.weekdays, type === 'weekdays' ? [1, 2, 3, 4, 5] : [new Date(startAt || Date.now()).getDay()]);
  return { type, weekdays: weekdays.length ? weekdays : [1], time };
}

function normalizeExecution(execution = {}, job = {}) {
  const raw = execution && typeof execution === 'object' ? execution : {};
  const type = raw.type === 'programmatic' && PROGRAMMATIC_ACTIONS.includes(String(raw.action || '')) ? 'programmatic' : 'agent';
  return {
    type,
    ...(type === 'programmatic' ? { action: String(raw.action) } : {}),
    approvalMode: ['unattended', 'ask'].includes(raw.approvalMode ?? job.approvalMode) ? (raw.approvalMode ?? job.approvalMode) : 'unattended',
    controlMode: raw.controlMode === 'agi' || job.controlMode === 'agi' ? 'agi' : 'browser',
    providerId: raw.providerId ? String(raw.providerId).slice(0, 120) : (job.providerId ? String(job.providerId).slice(0, 120) : null)
  };
}

function scheduleSignature(job) {
  const prompt = String(job.prompt || job.task || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const schedule = JSON.stringify(job.schedule || {});
  const execution = JSON.stringify(job.execution || { type: 'agent' });
  return `${prompt}|${schedule}|${execution}`.slice(0, 12000);
}

function normalizeJob(job = {}) {
  const prompt = String(job.prompt ?? job.task ?? '').replace(/\0/g, '').slice(0, MAX_PROMPT_LENGTH);
  const schedule = normalizeSchedule(job.schedule, job);
  const execution = normalizeExecution(job.execution, job);
  const now = Date.now();
  const normalized = {
    id: String(job.id || randomUUID()),
    name: String(job.name || prompt.slice(0, 60) || 'Scheduled task').slice(0, 120),
    prompt,
    task: prompt,
    schedule,
    execution,
    // Legacy fields remain readable by older callers and tests.
    cron: schedule.type === 'cron' ? schedule.cron : (job.cron ? String(job.cron).slice(0, 120) : null),
    everySeconds: schedule.type === 'interval' ? schedule.intervalSeconds : null,
    enabled: job.enabled !== false,
    controlMode: execution.controlMode,
    approvalMode: execution.approvalMode,
    providerId: execution.providerId,
    clientRequestId: job.clientRequestId ? String(job.clientRequestId).slice(0, 160) : null,
    createdAt: Number(job.createdAt) || now,
    updatedAt: Number(job.updatedAt) || now,
    nextRunAt: finiteOrNull(job.nextRunAt),
    lastRunAt: finiteOrNull(job.lastRunAt),
    lastStatus: OCCURRENCE_STATUSES.includes(job.lastStatus) ? job.lastStatus : null,
    lastSummary: String(job.lastSummary || '').slice(0, 2000)
  };
  normalized.dedupeKey = String(job.dedupeKey || scheduleSignature(normalized)).slice(0, 12000);
  return normalized;
}

function normalizeOccurrence(occurrence = {}) {
  return {
    id: String(occurrence.id || randomUUID()),
    jobId: String(occurrence.jobId || ''),
    dueAt: Number(occurrence.dueAt) || Date.now(),
    status: OCCURRENCE_STATUSES.includes(occurrence.status) ? occurrence.status : 'pending',
    attempts: Number(occurrence.attempts) || 0,
    lastError: String(occurrence.lastError || '').slice(0, 1000),
    prompt: String(occurrence.prompt || '').slice(0, MAX_PROMPT_LENGTH),
    executionType: occurrence.executionType === 'programmatic' ? 'programmatic' : 'agent',
    executionAction: occurrence.executionAction ? String(occurrence.executionAction).slice(0, 80) : null,
    runId: occurrence.runId ? String(occurrence.runId).slice(0, 120) : null,
    conversationId: occurrence.conversationId ? String(occurrence.conversationId).slice(0, 120) : null,
    startedAt: finiteOrNull(occurrence.startedAt),
    finishedAt: finiteOrNull(occurrence.finishedAt),
    claimed: Boolean(occurrence.claimed)
  };
}

class SchedulerStore {
  constructor(filePath = path.join(process.env.BROWSER_USE_PROFILE_DIR || '.', 'schedules.json')) {
    this.filePath = filePath;
    this.data = { schemaVersion: SCHEMA_VERSION, jobs: [], occurrences: [] };
    this.flushTimer = null;
    this.flushing = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
      const occurrences = Array.isArray(raw?.occurrences) ? raw.occurrences : [];
      this.data = {
        schemaVersion: SCHEMA_VERSION,
        jobs: jobs.slice(-MAX_JOBS).map(normalizeJob),
        occurrences: occurrences.slice(-MAX_OCCURRENCES).map(normalizeOccurrence)
      };
    } catch {
      this.data = { schemaVersion: SCHEMA_VERSION, jobs: [], occurrences: [] };
    }
    return this.data;
  }

  get jobs() { return this.data.jobs; }
  get occurrences() { return this.data.occurrences; }

  job(jobId) { return this.data.jobs.find(job => job.id === jobId) || null; }

  upsertJob(job) {
    const normalized = normalizeJob(job);
    const index = this.data.jobs.findIndex(entry => entry.id === normalized.id);
    if (index >= 0) this.data.jobs[index] = { ...this.data.jobs[index], ...normalized };
    else this.data.jobs.push(normalized);
    if (this.data.jobs.length > MAX_JOBS) this.data.jobs.splice(0, this.data.jobs.length - MAX_JOBS);
    this.scheduleFlush();
    return normalized;
  }

  removeJob(jobId) {
    this.data.jobs = this.data.jobs.filter(job => job.id !== jobId);
    for (const occurrence of this.data.occurrences) {
      if (occurrence.jobId === jobId && (occurrence.status === 'pending' || occurrence.status === 'running')) occurrence.status = 'cancelled';
    }
    this.scheduleFlush();
  }

  // Claim-before-dispatch: the running status reaches disk before any agent starts.
  createOccurrence(jobId, dueAt) {
    const occurrence = normalizeOccurrence({ jobId, dueAt, status: 'pending', claimed: true });
    this.data.occurrences.push(occurrence);
    if (this.data.occurrences.length > MAX_OCCURRENCES) this.data.occurrences.splice(0, this.data.occurrences.length - MAX_OCCURRENCES);
    this.scheduleFlush();
    return occurrence;
  }

  claimOccurrence(occurrenceId, runId = null) {
    const occurrence = this.data.occurrences.find(entry => entry.id === occurrenceId);
    // Running re-claims happen on each retry attempt of the same occurrence.
    if (!occurrence || !['pending', 'running'].includes(occurrence.status)) return null;
    occurrence.status = 'running';
    occurrence.claimed = true;
    occurrence.startedAt = Date.now();
    if (runId) occurrence.runId = String(runId).slice(0, 120);
    this.scheduleFlush();
    return occurrence;
  }

  updateOccurrence(occurrenceId, patch) {
    const occurrence = this.data.occurrences.find(entry => entry.id === occurrenceId);
    if (!occurrence) return null;
    Object.assign(occurrence, normalizeOccurrence({ ...occurrence, ...patch, claimed: true }));
    this.scheduleFlush();
    return occurrence;
  }

  findJobByRequestId(requestId) {
    const id = String(requestId || '').trim();
    return id ? this.data.jobs.find(job => job.clientRequestId === id) || null : null;
  }

  updateJobRun(jobId, { lastRunAt, lastStatus, lastSummary, nextRunAt }) {
    const job = this.job(jobId);
    if (!job) return null;
    if (Number.isFinite(lastRunAt)) job.lastRunAt = lastRunAt;
    if (OCCURRENCE_STATUSES.includes(lastStatus)) job.lastStatus = lastStatus;
    if (lastSummary !== undefined) job.lastSummary = String(lastSummary || '').slice(0, 2000);
    if (nextRunAt === null || Number.isFinite(nextRunAt)) job.nextRunAt = nextRunAt;
    job.updatedAt = Date.now();
    this.scheduleFlush();
    return job;
  }

  scheduleFlush() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 100);
  }

  async flush() {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
        await fs.promises.rename(tmp, this.filePath);
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}

module.exports = { SchedulerStore, normalizeJob, normalizeOccurrence, normalizeSchedule, normalizeExecution, scheduleSignature, OCCURRENCE_STATUSES, PROGRAMMATIC_ACTIONS, SCHEDULE_TYPES };
