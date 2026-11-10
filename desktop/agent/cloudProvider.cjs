'use strict';

const { BrowserUse } = require('browser-use-sdk/v4');

const DEFAULT_TIMEOUT_MS = 14_400_000;
const POLL_INTERVAL_MS = 2_000;

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Remote Browser Use task cancelled.')); return; }
    const timer = setTimeout(() => { signal?.removeEventListener?.('abort', abort); resolve(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Remote Browser Use task cancelled.')); };
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function redactKey(key) {
  if (!key || typeof key !== 'string') return '';
  if (key.length <= 12) return '*'.repeat(key.length);
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

function buildRemoteTask(task, messages, recovery) {
  const current = String(task || '').trim();
  const normalized = Array.isArray(messages) ? messages.slice(-10).map((message) => ({
    role: message?.role === 'assistant' ? 'Assistant' : 'User',
    content: String(message?.content ?? message ?? '').replace(/\0/g, '').trim().slice(0, 1_200)
  })).filter((message) => message.content) : [];
  const last = normalized.at(-1);
  const prior = last?.role === 'User' && last.content === current ? normalized.slice(0, -1) : normalized;
  const conversation = prior.length
    ? `Continue the existing conversation and complete the latest request.\n\nConversation context:\n${prior.map((message) => `${message.role}: ${message.content}`).join('\n')}\n\nCurrent request:\n${current}`
    : current;
  const recoveryNote = Number(recovery?.attempts || 0) > 0 && recovery?.lastError
    ? `\n\nA prior browser decision failed with: ${String(recovery.lastError).slice(0, 1_000)}. Use that feedback with the newest evidence. If the target is already known, change approach or execute the next action; do not repeat observation merely because recovery occurred. Observe again only when the failed action could have changed the state.`
    : '';
  return `${conversation}${recoveryNote}`;
}

class CloudProvider {
  constructor({ apiKey, model, client = null, timeoutMs = DEFAULT_TIMEOUT_MS, pollIntervalMs = POLL_INTERVAL_MS, now = Date.now, delay = pause }) {
    if (!apiKey) throw new Error('Browser Use Cloud requires an API key configured in secure storage.');
    if (!String(model || '').trim()) throw new Error('Choose a Browser Use Cloud model before starting the agent.');
    this.apiKey = apiKey;
    this.model = String(model).trim();
    this.executionTarget = 'remote';
    this.timeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.pollIntervalMs = Math.max(1, Number(pollIntervalMs) || POLL_INTERVAL_MS);
    this.absoluteTimeoutMs = this.timeoutMs + 60_000;
    this.now = now;
    this.delay = delay;
    this.client = client || new BrowserUse({ apiKey, timeout: 30_000, maxRetries: 1 });
  }

  async complete({ task, messages, recovery, signal, onProgress }) {
    const created = await this.client.runs.create({ task: buildRemoteTask(task, messages, recovery), model: this.model });
    const startedAt = this.now();
    onProgress?.();
    let status = created.status;
    while (!['completed', 'failed', 'cancelled'].includes(status)) {
      if (signal?.aborted) {
        await this.client.runs.cancel(created.id).catch(() => {});
        throw new Error('Remote Browser Use task cancelled.');
      }
      if (this.now() - startedAt >= this.timeoutMs) {
        await this.client.runs.cancel(created.id).catch(() => {});
        throw new Error('Remote Browser Use task timed out before completion.');
      }
      try { await this.delay(this.pollIntervalMs, signal); }
      catch (error) {
        await this.client.runs.cancel(created.id).catch(() => {});
        throw new Error('Remote Browser Use task cancelled.');
      }
      status = (await this.client.runs.status(created.id)).status;
      onProgress?.();
    }
    const result = await this.client.runs.get(created.id);
    if (result.status !== 'completed') throw new Error(String(result.error || `Remote Browser Use task ${result.status}.`).slice(0, 600));
    return {
      assistantText: 'Remote Browser Use Cloud task completed.',
      toolCalls: [{ name: 'browser_done', input: { summary: String(result.result || 'Remote browser task finished.').slice(0, 4_000), success: true, verified: false } }],
      remoteRunId: created.id
    };
  }
}

function createCloudProvider(options = {}) { return new CloudProvider(options); }
module.exports = { CloudProvider, createCloudProvider, redactKey, buildRemoteTask, DEFAULT_TIMEOUT_MS, POLL_INTERVAL_MS };
