'use strict';

const fs = require('node:fs');

const { normalizeConversationPlan } = require('../agent/progressState.cjs');
const { normalizeLedgerSnapshot, normalizeObjectiveLedger, sanitizeLedgerValue } = require('../agent/providerTurnLedger.cjs');
const { normalizeDomAttachments } = require('../renderer/domAttachments.cjs');
const SCHEMA_VERSION = 5;
const MAX_TEXT = 8_000;

function clean(value, max = MAX_TEXT) {
  return String(value || '').replace(/\0/g, '').trim().slice(0, max);
}

function redact(value = '') {
  return clean(value)
    .replace(/\bbu_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]+/gi, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
}

function redactStructured(value) {
  if (value === undefined || value === null) return null;
  // A value can itself be a previous truncation envelope (a result that
  // already carries notice+preview). Re-wrapping one re-serializes the
  // embedded preview into ever-deeper escaped layers on every save (measured
  // live: dozens of nested copies accumulating per save). Envelopes pass
  // through untouched — they are already bounded and already say they are.
  if (typeof value === 'object' && !Array.isArray(value)
    && value.notice === 'Saved diagnostic was truncated.' && typeof value.preview === 'string') return value;
  try {
    const safe = JSON.stringify(value)
      .replace(/\bbu_[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\b(?:sk|rk|pk)_[A-Za-z0-9_-]+/gi, '[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]');
    if (safe.length > MAX_TEXT) return { notice: 'Saved diagnostic was truncated.', preview: safe.slice(0, MAX_TEXT) };
    return JSON.parse(safe);
  } catch { return redact(value); }
}

function normalizeMessage(message = {}, fallbackRole = 'user') {
  const role = message?.role === 'assistant' || fallbackRole === 'assistant' ? 'assistant' : 'user';
  const content = redact(message?.content ?? message?.text ?? '');
  if (!content) return null;
  const domAttachments = normalizeDomAttachments(message?.domAttachments).map(({ text, ...metadata }) => metadata);
  // The badge identifies the producer of a non-agent message (a subagent, a
  // research brief). It must survive a save/reload, or the transcript loses
  // the only signal that told those cards apart from the agent's own voice.
  const badge = clean(message?.badge, 40);
  // The display body is the user-facing half of a badged message; the main
  // content stays model-facing. Both must survive a reload.
  const displayContent = clean(message?.displayContent, 8_000);
  return {
    role,
    content,
    ...(message?.id ? { id: clean(message.id, 120) } : {}),
    ...(message?.source === 'runtime' ? { source: 'runtime' } : {}),
    ...(badge ? { badge } : {}),
    ...(displayContent ? { displayContent } : {}),
    ...(domAttachments.length ? { domAttachments } : {}),
    at: Number.isFinite(Number(message?.at)) ? Number(message.at) : Date.now()
  };
}

function normalizePlan(plan) {
  if (!Array.isArray(plan)) return [];
  return normalizeConversationPlan(plan);
}

function normalizeWorkingMemory(value) {
  return {
    previousReasoning: redact(value?.previousReasoning).slice(-4_000),
    strategyEpoch: Math.max(0, Math.min(10_000, Number(value?.strategyEpoch) || 0))
  };
}

function normalizeCompletedWork(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-48).map((entry) => ({
    action: clean(entry?.action, 80),
    target: redact(entry?.target).slice(0, 160),
    expectedOutcome: redact(entry?.expectedOutcome).slice(0, 500),
    effectObserved: entry?.effectObserved === true,
    observedRevision: Math.max(0, Number(entry?.observedRevision) || 0)
  })).filter((entry) => entry.action);
}

// Bounded generated-media provenance per transcript entry so image/tts/stt/
// video results survive history reloads. URLs are kept whole; a base64
// dataUrl is capped (short audio/small images fit, huge payloads are dropped
// and the card falls back to its URL).
const MEDIA_DATAURL_CAP = 4_000_000;
function normalizeMedia(media) {
  if (!media || typeof media !== 'object' || !['image', 'video', 'audio'].includes(media.kind)) return null;
  const url = clean(media.url, 2_000);
  const dataUrl = typeof media.dataUrl === 'string' && media.dataUrl.length <= MEDIA_DATAURL_CAP ? media.dataUrl : null;
  if (!url && !dataUrl) return null;
  return { kind: media.kind, ...(url ? { url } : {}), ...(dataUrl ? { dataUrl } : {}), model: clean(media.model, 200) };
}

function normalizeTranscript(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript.slice(-80).map((entry) => {
    const tool = clean(entry?.tool || (!['user', 'assistant'].includes(entry?.type) ? entry?.type : ''), 80);
    if (!tool) return null;
    // Media provenance is stored outside the redacted output: a base64 asset
    // would exceed the diagnostic cap and be lost to a truncation envelope.
    const media = normalizeMedia(entry?.media);
    let outputSource = entry?.output;
    if (media?.dataUrl && outputSource && typeof outputSource === 'object' && outputSource.result && typeof outputSource.result === 'object' && outputSource.result.dataUrl) {
      outputSource = { ...outputSource, result: { ...outputSource.result, dataUrl: '[stored in media]' } };
    }
    return {
      at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now(),
      step: Number.isFinite(Number(entry?.step)) ? Number(entry.step) : 0,
      tool,
      ...(entry?.callId ? { callId: clean(entry.callId, 200) } : {}),
      input: redactStructured(entry?.input),
      expect: clean(entry?.expect, 500),
      repeat: entry?.repeat === true,
      ...(media ? { media } : {}),
      output: redactStructured(outputSource)
    };
  }).filter(Boolean);
}

// Bounded per-card reasoning tails so saved conversations keep the agent's
// "Thought for Ns" cards. Display-only: never re-enters the model context.
function normalizeThinkingArchive(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-60).map((entry) => ({
    at: Number.isFinite(Number(entry?.at)) ? Number(entry.at) : Date.now(),
    elapsedMs: Math.max(0, Number(entry?.elapsedMs) || 0),
    text: redact(entry?.text).slice(-2_000)
  })).filter((entry) => entry.text);
}

function normalize(record = {}) {
  let messages = Array.isArray(record.messages)
    ? record.messages.map((message) => normalizeMessage(message, message?.role)).filter(Boolean).slice(-40)
    : [];
  if (!messages.length && Array.isArray(record.transcript)) {
    messages = record.transcript
      .filter((entry) => entry?.type === 'user' || entry?.type === 'assistant')
      .map((entry) => normalizeMessage(entry, entry.type))
      .filter(Boolean)
      .slice(-40);
  }
  const providerConfig = redactStructured(record.providerConfig);
  return {
    id: clean(record.id, 120),
    title: clean(record.title, 160) || 'Browser task',
    // The turn text must survive checkpoints: a continuation whose snapshot
    // lost `task` could not classify turn boundaries (previous.task read as
    // empty), so the pinned objective and the TURN BOUNDARY notice went stale
    // and the model resurrected a task fixed turns earlier.
    task: clean(record.task, 2_000),
    provider: clean(record.provider || providerConfig?.id, 80),
    model: clean(record.model || providerConfig?.model, 120),
    providerConfig: providerConfig && typeof providerConfig === 'object' ? providerConfig : null,
    target: clean(record.target, 500),
    observationDomain: ['browser', 'computer'].includes(record.observationDomain) ? record.observationDomain : undefined,
    status: ['running', 'paused', 'awaiting_approval', 'interrupted', 'completed', 'failed', 'cancelled'].includes(record.status) ? record.status : 'failed',
    eventRevision: Math.max(0, Number(record.eventRevision) || 0),
    attemptSequence: Math.max(0, Number(record.attemptSequence) || 0),
    attemptId: clean(record.attemptId, 120),
    settings: record.settings ? redactStructured(record.settings) : undefined,
    summary: redact(record.summary),
    success: typeof record.success === 'boolean' ? record.success : record.status === 'completed',
    verified: record.verified === true,
    reason: clean(record.reason, 120),
    createdAt: Number.isFinite(Number(record.createdAt)) ? Number(record.createdAt) : Date.now(),
    turnStartedAt: Number.isFinite(Number(record.turnStartedAt)) ? Number(record.turnStartedAt) : undefined,
    updatedAt: Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : Date.now(),
    messages,
    providerLedger: normalizeLedgerSnapshot(record.providerLedger),
    objectiveLedger: normalizeObjectiveLedger(record.objectiveLedger),
    pendingUserMessages: Array.isArray(record.pendingUserMessages) ? record.pendingUserMessages.map(m => normalizeMessage(m)).filter(Boolean).slice(-20) : [],
    plan: normalizePlan(record.plan),
    goals: normalizePlan(record.goals),
    workingMemory: normalizeWorkingMemory(record.workingMemory),
    flowControl: record.flowControl && typeof record.flowControl === 'object' ? {
      phase: clean(record.flowControl.phase, 20),
      taskFingerprint: clean(record.flowControl.taskFingerprint, 40),
      decisionNumber: Math.max(0, Number(record.flowControl.decisionNumber) || 0),
      planPrompted: record.flowControl.planPrompted === true,
      planPromptCount: Math.max(0, Math.min(3, Number(record.flowControl.planPromptCount) || 0)),
      planMissingStreak: Math.max(0, Math.min(50, Number(record.flowControl.planMissingStreak) || 0)),
      lowYieldStreak: Math.max(0, Math.min(50, Number(record.flowControl.lowYieldStreak) || 0)),
      evidenceEpoch: Math.max(0, Number(record.flowControl.evidenceEpoch) || 0),
      bounceEpoch: Number(record.flowControl.bounceEpoch),
      touchedPaths: Array.isArray(record.flowControl.touchedPaths) ? record.flowControl.touchedPaths.slice(-24).map(item => clean(item, 300)) : [],
      evidence: Array.isArray(record.flowControl.evidence) ? record.flowControl.evidence.slice(-64).map(item => redactStructured(item)) : [],
      noticeLog: Array.isArray(record.flowControl.noticeLog) ? record.flowControl.noticeLog.slice(-24).map(item => ({ key: clean(item?.key, 80), decision: Number(item?.decision) || 0 })) : []
    } : undefined,
    thinkingArchive: normalizeThinkingArchive(record.thinkingArchive),
    // Native-surface awareness ledger: window ids the run already announced.
    // Persisted as a plain array so a conversation restored from disk never
    // re-nudges a dialog it already surfaced (and never swallows one it did not).
    nativeSurfaceSeen: Array.isArray(record.nativeSurfaceSeen)
      ? record.nativeSurfaceSeen.map((id) => clean(id, 120)).filter(Boolean).slice(-200)
      : [],
    completedWork: normalizeCompletedWork(record.completedWork),
    transcript: normalizeTranscript(record.transcript)
  };
}

class ChatHistoryStore {
  constructor({ filePath, now = Date.now, onError = null }) { this.filePath = filePath; this.now = now; this.onError = onError; this.pending = new Map(); this.versions = new Map(); this.deleted = new Set(); this.timer = null; this.writing = null; this.corruptReported = false; }
  checkpoint(record) {
    const next = normalize(record), current = this.versions.get(next.id);
    if (this.deleted.has(next.id) || current && (next.attemptSequence < current.attemptSequence || next.attemptSequence === current.attemptSequence && next.eventRevision < current.eventRevision)) return;
    this.versions.set(next.id, { attemptSequence: next.attemptSequence, eventRevision: next.eventRevision });
    this.pending.set(next.id, next);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush().catch(error => this.onError?.(error)); }, 250);
  }
  // Corruption-tolerant read. A single unreadable blob used to poison the
  // whole store: load() silently returned only unsaved in-memory records
  // (every saved conversation gone) and flush() threw on every later write,
  // so history stopped being saved at all until the file was deleted by hand.
  // Now: a corrupt main file is quarantined (kept on disk for recovery), the
  // last known-good backup (.bak) is preferred, and writes continue.
  readStoreFile() {
    const tryParse = (filePath) => {
      try { return { ok: true, parsed: JSON.parse(fs.readFileSync(filePath, 'utf8')) }; }
      catch (error) { return { ok: false, error }; }
    };
    const main = tryParse(this.filePath);
    if (main.ok) return Array.isArray(main.parsed?.conversations) ? main.parsed.conversations : [];
    // Absent main (first run, or quarantined after a corruption) still falls
    // back to the backup, so a quarantined blob never means lost conversations.
    const backup = tryParse(`${this.filePath}.bak`);
    if (!backup.ok && main.error?.code === 'ENOENT') return [];
    if (backup.ok) {
      this.reportCorruption(`chat history file was corrupt (${main.error?.message || 'unreadable'}); recovered from backup`);
      this.quarantineCorruptFile();
      return Array.isArray(backup.parsed?.conversations) ? backup.parsed.conversations : [];
    }
    this.reportCorruption(`chat history file was corrupt (${main.error?.message || 'unreadable'}); no readable backup was available and the corrupt file was kept for manual recovery`);
    this.quarantineCorruptFile();
    return [];
  }
  reportCorruption(message) {
    if (this.corruptReported) return;
    this.corruptReported = true;
    try { this.onError?.(new Error(message)); } catch { /* reporting must never break the store */ }
  }
  quarantineCorruptFile() {
    try {
      const quarantined = `${this.filePath}.corrupt-${Date.now()}`;
      fs.renameSync(this.filePath, quarantined);
      this.corruptFileKept = quarantined;
    } catch { /* if the file cannot be moved it simply stays; writes use tmp+rename */ }
  }
  maintainBackup() {
    try { fs.copyFileSync(this.filePath, `${this.filePath}.bak`); } catch { /* best-effort backup */ }
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.writing) { await this.writing; if (this.pending.size) return this.flush(); return; }
    if (!this.pending.size) return;
    const batch = new Map(this.pending); this.pending.clear(); this.inFlight = batch;
    this.writing = (async () => {
      const previous = this.readStoreFile();
      const merged = new Map(previous.map(record => [record.id, record]));
      for (const [id, record] of batch) {
        const saved = merged.get(id);
        if (!saved || record.attemptSequence > Number(saved.attemptSequence || 0) || record.attemptSequence === Number(saved.attemptSequence || 0) && record.eventRevision >= Number(saved.eventRevision || 0)) merged.set(id, record);
      }
      for (const id of this.deleted) merged.delete(id);
      const conversations = this.prune([...merged.values()]);
      const temporary = `${this.filePath}.checkpoint.tmp`;
      await fs.promises.writeFile(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, conversations }), { mode: 0o600 });
      await fs.promises.rename(temporary, this.filePath);
      this.maintainBackup();
    })();
    try { await this.writing; }
    catch (error) { for (const [id, record] of batch) if (!this.pending.has(id) && !this.deleted.has(id)) this.pending.set(id, record); throw error; }
    finally { this.writing = null; this.inFlight = null; }
  }
  recoverInterrupted() {
    const records = this.load(); let changed = false;
    for (const record of records) if (['running', 'paused', 'awaiting_approval'].includes(record.status)) { record.status = 'interrupted'; changed = true; }
    if (changed) this.save(records);
  }
  load() {
    try {
      const records = new Map(this.readStoreFile().map(record => [record.id, record]));
      for (const [id, record] of this.inFlight || []) records.set(id, record);
      for (const [id, record] of this.pending) records.set(id, record);
      for (const id of this.deleted) records.delete(id);
      const conversations = this.prune([...records.values()]).map(normalize);
      for (const record of conversations) if (!this.versions.has(record.id)) this.versions.set(record.id, { attemptSequence: record.attemptSequence, eventRevision: record.eventRevision });
      return conversations;
    } catch { return this.prune([...new Map([...(this.inFlight || []), ...this.pending]).values()].filter(record => !this.deleted.has(record.id))); }
  }
  // Deliberately UNBOUNDED: no count cap and no age cutoff. Both used to drop
  // old conversations (100 newest, 30 days), which silently deleted history
  // the owner expected to survive every restart forever.
  prune(items) {
    return (Array.isArray(items) ? items : [])
      .map(normalize)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  save(items) {
    const conversations = this.prune(items);
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ schemaVersion: SCHEMA_VERSION, conversations }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
    this.maintainBackup();
    return conversations;
  }
  append(record) {
    const normalized = normalize(record);
    return this.save([normalized, ...this.load().filter((item) => item.id !== normalized.id)]);
  }
  get(id) { return this.load().find((item) => item.id === String(id || '')) || null; }
  async remove(id) {
    const key = String(id || ''); this.deleted.add(key); this.pending.delete(key);
    if (this.writing) await this.writing;
    return this.save(this.load().filter(item => item.id !== key));
  }
  async clear() {
    for (const record of this.load()) this.deleted.add(record.id);
    for (const id of this.versions.keys()) this.deleted.add(id);
    this.pending.clear();
    if (this.writing) await this.writing;
    return this.save([]);
  }
}

module.exports = { ChatHistoryStore, normalize, redact, redactStructured, SCHEMA_VERSION };
