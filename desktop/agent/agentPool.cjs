'use strict';

const { randomUUID } = require('node:crypto');

// Only physical desktop input/focus needs serialization. Browser tab input is
// tab-scoped; file and terminal tools belong to their own run and must never
// block behind someone else's pointer or keyboard operation.
class DesktopLease {
  constructor({ onWait = null } = {}) { this.holder = null; this.waiters = []; this.onWait = onWait; }

  async acquire(owner, signal = null) {
    if (this.holder === owner) return;
    if (!this.holder && this.waiters.length === 0) { this.holder = owner; return; }
    if (signal?.aborted) throw new Error('Desktop focus request was cancelled.');
    this.onWait?.(owner, this.holder);
    await new Promise((resolve, reject) => {
      const waiter = { owner, resolve, reject };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Desktop focus request was cancelled.'));
      };
      waiter.abort = abort;
      if (signal) signal.addEventListener('abort', abort, { once: true });
      this.waiters.push(waiter);
    });
    if (signal?.aborted) { this.release(owner); throw new Error('Desktop focus request was cancelled.'); }
  }

  release(owner) {
    if (this.holder !== owner) return false;
    const previous = this.holder;
    const waiter = this.waiters.shift();
    this.holder = waiter?.owner || null;
    if (waiter) waiter.resolve();
    try { this.onRelease?.(previous, this.holder); } catch { /* coordination is advisory */ }
    return true;
  }
}

// Who should be told about a lease hand-off. Every physical action (a focus
// call, one keypress) acquires and releases the lease, so notifying on EVERY
// release told the agent "your focus was released, tell the requesting agent"
// twelve times in one run when no agent was requesting anything. Each message
// reached the model as an agentMessage and could interrupt its step, which sent
// it back to re-focus windows — a loop the harness created itself. A hand-off
// only exists when another agent was waiting (`next`); otherwise nothing is said.
function leaseHandoffNotices(previous, next) {
  if (!next) return [];
  const notices = [];
  if (previous && previous !== next) notices.push({ owner: previous, text: 'Your native desktop focus was released to another agent that was waiting for it. Tell that agent when your work is complete if needed.', reply: true });
  notices.push({ owner: next, text: 'Native desktop focus is now available to you. Continue your requested physical action; release it when done.', reply: true });
  return notices;
}

function needsPhysicalDesktopLease(name, input = {}) {
  if (name === 'computer_pointer' || name === 'computer_stroke' || name === 'computer_keyboard') return true;
  return name === 'computer_window' && input.action === 'focus'
    || name === 'computer_clipboard' && input.action === 'write';
}

function retainsPhysicalInput(name, input = {}) {
  return (name === 'computer_pointer' || name === 'computer_keyboard') && input.action === 'down';
}

// A single gesture/focus call owns physical input only while it executes.
// Deliberate down/up pairs retain the lease until the matching release; owner
// cleanup always releases it, including cancellation and backend failures.
function leaseComputerTools(backend, lease) {
  return new Proxy(backend, {
    get(target, property) {
      if (property === 'releaseOwner' || property === 'releaseInput') {
        return async (owner, ...args) => {
          try { return await target[property]?.(owner, ...args); }
          finally { lease.release(owner); }
        };
      }
      if (property !== 'execute') return Reflect.get(target, property);
      return async (name, input, owner, options = {}) => {
        if (!needsPhysicalDesktopLease(name, input || {})) return target.execute(name, input, owner, options);
        await lease.acquire(owner, options?.signal || null);
        try { return await target.execute(name, input, owner, options); }
        finally { if (!retainsPhysicalInput(name, input)) lease.release(owner); }
      };
    }
  });
}

// True parallel multi-agent: one DesktopChatAgent instance per active run,
// each on its own background tab, sharing ONE unmodified BrowserViewController
// (all controller state is per-tabId; background tabs never satisfy
// getSelectedTabId, so input uses the CDP background path). desktopChatAgent.cjs
// is not modified by parallelism.
class AgentPool {
  constructor({ factory, allocateTab = null, releaseTab = null, cap = 3, lease = new DesktopLease(), publish = () => {}, maxRetained = 8 }) {
    if (typeof factory !== 'function') throw new Error('AgentPool requires an agent factory.');
    this.factory = factory;
    this.allocateTab = allocateTab;
    this.releaseTab = releaseTab;
    // LORDE_PARALLEL_SCALE_V365 — the ceiling is 32, not 8: the user's
    // providers support real concurrency (the same APIs power multi-agent
    // coding tools), rate limits are visible to the model, and the model can
    // tone down spawning on its own. Serializing browser-tab work behind a
    // tiny cap was the measured "more agents = slower" cause.
    this.cap = Math.max(1, Math.min(32, Number(cap) || 3));
    this.lease = lease;
    this.publish = publish;
    this.entries = new Map(); // runId -> {instance, tabId, owner, label, startedAt}
    this.queue = [];
    // LORDE_RESIDENT_SUBAGENTS_V365 — runs completed with retain:true stay
    // here (instance + tab + conversation intact) until closeRetained removes
    // them. Residents are woken for follow-up assignments, not torn down.
    this.retained = new Map(); // runId -> {instance, tabId, label, alias, runId, finishedAt}
    this.maxRetained = Math.max(1, Math.min(32, Number(maxRetained) || 8));
  }

  get activeRuns() { return [...this.entries.values()]; }
  get activeCount() { return this.entries.size; }
  ownsTab(tabId) {
    const id = String(tabId);
    return [...this.entries.values()].some(entry => entry.tabId === id)
      || [...this.retained.values()].some(entry => entry.tabId === id);
  }

  /** Run a task as an isolated background agent. Resolves with the terminal run snapshot. */
  run({ task, label = 'task', alias = null, settings = {}, provider, tabId = null, continuation = false, conversationId = null, conversation = null, onStart = null, retain = false, workspace = null }) {
    return new Promise((resolve, reject) => {
      // queuedAt: the "Worked for" clock must measure the run's WALL time —
      // queue stalling included — not just the time after a slot freed.
      this.queue.push({ task, label, alias, settings, provider, tabId, continuation, conversationId, conversation, onStart, retain, workspace, queuedAt: Date.now(), resolve, reject });
      this.pump();
    });
  }

  async pump() {
    if (!this.queue.length || this.entries.size >= this.cap) return;
    const request = this.queue.shift();
    try {
      const result = await this.dispatch(request);
      request.resolve(result);
    } catch (error) {
      request.reject(error);
    }
    this.pump();
  }

  async dispatch({ task, label, alias, settings, provider, tabId, continuation, conversationId, conversation = null, onStart, retain = false, workspace = null, queuedAt = null }) {
    let allocatedTab = null;
    let ownedTab = tabId && !this.ownsTab(tabId) ? String(tabId) : null;
    if (!ownedTab && this.allocateTab) {
      allocatedTab = await this.allocateTab();
      ownedTab = allocatedTab ? String(allocatedTab) : null;
      // LORDE_SPAWN_TAB_GUARD_V364 — a failed allocation must never fall back
      // to the selected tab: the subagent would observe and act on the tab the
      // human is using. Fail the spawn loudly instead.
      if (!ownedTab) throw new Error('Background agent run could not allocate an isolated tab.');
    }
    if (tabId && this.ownsTab(tabId) && !allocatedTab) throw new Error(`Tab ${tabId} is already owned by another active agent run.`);
    let entryOwner = null;
    let instance = null;
    let runSettled = false;
    try {
      instance = this.factory({
        tabId: ownedTab,
        getComputerTools: () => this.computerTools
      });
      const started = instance.start({
        task,
        ...(queuedAt ? { queuedAt } : {}),
        ...(alias ? { agentIdentity: alias } : {}),
        ...(provider ? { provider } : {}),
        ...(conversationId ? { conversationId } : {}),
        // A continuation is only real with its restorable snapshot; the agent
        // throws on continuation:true without one.
        ...(conversation ? { conversation } : {}),
        ...(continuation ? { continuation: true } : {}),
        ...(ownedTab ? { tabId: ownedTab } : {}),
        ...(workspace ? { workspace } : {}),
        settings: { approvalMode: 'unattended', ...settings }
      });
      // start() can reject before DesktopChatAgent assigns its live run. Read
      // only for the owner, then await the promise so the real provider error
      // propagates instead of becoming a masked null.id TypeError.
      const snapshot = instance.state();
      const runId = snapshot?.id || `pool-run-${randomUUID()}`;
      entryOwner = snapshot?.computerOwner || `pool:${runId}`;
      this.entries.set(runId, { instance, tabId: ownedTab, owner: entryOwner, label, alias: alias || null, startedAt: Date.now() });
      if (typeof onStart === 'function') { try { onStart(snapshot); } catch { /* tracking must not break the run */ } }
      this.publish({ type: 'pool.updated', active: this.activeRuns.map(entry => ({ id: entry.instance.state()?.id, label: entry.label, alias: entry.alias || null, tabId: entry.tabId, startedAt: entry.startedAt })), queued: this.queue.length });
      const run = await started;
      runSettled = true;
      return run;
    } finally {
      const entry = [...this.entries.entries()].find(([, value]) => value.instance === instance);
      if (entry) {
        this.entries.delete(entry[0]);
        if (entry[1].owner) this.lease.release(entry[1].owner);
        // LORDE_RESIDENT_SUBAGENTS_V365 — a retained run keeps its instance,
        // tab, and conversation alive after the terminal snapshot: the
        // spawning agent keeps assigning it work until it closes it
        // explicitly with closeRetained. Only the physical-input lease ends.
        // A run that never started (provider throw, cancelled) never retains.
        if (retain && runSettled) {
          this.retained.set(entry[0], { instance, tabId: ownedTab, label, alias: entry[1].alias || alias || null, runId: entry[0], finishedAt: Date.now() });
          this.evictRetained();
        }
        this.publish({ type: 'pool.updated', active: this.activeRuns.map(entry2 => ({ id: entry2.instance.state()?.id, label: entry2.label, alias: entry2.alias || null, tabId: entry2.tabId, startedAt: entry2.startedAt })), retained: this.listRetained(), queued: this.queue.length });
      }
      if (!(retain && runSettled) && allocatedTab && this.releaseTab) { try { await this.releaseTab(allocatedTab); } catch { /* tab release is best effort */ } }
    }
  }

  listRetained() {
    return [...this.retained.entries()].map(([runId, entry]) => ({ id: runId, alias: entry.alias || null, label: entry.label, tabId: entry.tabId, finishedAt: entry.finishedAt }));
  }

  // Explicit teardown: only the owning agent's subagent_close reaches this.
  async closeRetained(runId) {
    const id = String(runId || '');
    const entry = this.retained.get(id);
    if (!entry) return false;
    this.retained.delete(id);
    if (entry.tabId && this.releaseTab) { try { await this.releaseTab(entry.tabId); } catch { /* tab release is best effort */ } }
    this.publish({ type: 'pool.updated', active: this.activeRuns.map(active => ({ id: active.instance.state()?.id, label: active.label, alias: active.alias || null, tabId: active.tabId, startedAt: active.startedAt })), retained: this.listRetained(), queued: this.queue.length });
    return true;
  }

  cancelRun(runId) {
    const id = String(runId || '');
    const entry = this.entries.get(id)
      || [...this.entries.values()].find(candidate => String(candidate.instance?.state?.()?.id || '') === id);
    if (!entry) return false;
    try { entry.instance.cancel(id); return true; } catch { return false; }
  }

  // Oldest residents give way first (their tabs release); the roster never
  // grows unbounded when an agent forgets to close its workers.
  evictRetained() {
    while (this.retained.size > this.maxRetained) {
      const oldest = [...this.retained.entries()].sort((left, right) => left[1].finishedAt - right[1].finishedAt)[0];
      if (!oldest) break;
      this.retained.delete(oldest[0]);
      if (oldest[1].tabId && this.releaseTab) { try { void this.releaseTab(oldest[1].tabId); } catch { /* tab release is best effort */ } }
    }
  }

  async cancelAll(reason = 'Pool cancelled by the user.') {
    const entries = [...this.entries.values()];
    for (const entry of entries) { try { entry.instance.cancel(entry.instance.state()?.id); } catch { /* already terminal */ } }
    const queued = this.queue.splice(0);
    for (const request of queued) request.reject(new Error(reason));
    this.publish({ type: 'pool.updated', active: [], queued: 0 });
    return entries.length;
  }

  // Injected by main: the leased backend shared by every pool instance (and
  // by the primary interactive agent, so manual runs cannot fight a lease).
  set computerTools(backend) { this._computerTools = backend; }
  get computerTools() { return this._computerTools; }
}

module.exports = { AgentPool, DesktopLease, leaseComputerTools, leaseHandoffNotices };
