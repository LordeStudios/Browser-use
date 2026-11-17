'use strict';

// Serializes DevTools-protocol work per managed tab. Electron exposes one
// debugger channel per WebContents, so input, emulation, and screenshots must
// share attachment ownership instead of attaching/detaching independently.

// A command can hang forever: a fromSurface screenshot awaits a compositor
// frame the target may never produce (detached view, throttled/occluded
// renderer), and an awaitPromise evaluate inherits whatever the page never
// resolves. Without a bound, one hung command silently blocks EVERY later
// operation on that tab — the run stalls with no errors and no tool results.
// The lease therefore force-releases its slot on timeout and resets the
// debugger channel so the next operation starts clean.
const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;

class DebuggerLeaseManager {
  constructor({ getTabs, operationTimeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, onOperationTimeout = null }) {
    this.getTabs = getTabs;
    this.operationTimeoutMs = Math.max(1_000, Number(operationTimeoutMs) || DEFAULT_OPERATION_TIMEOUT_MS);
    this.onOperationTimeout = typeof onOperationTimeout === 'function' ? onOperationTimeout : null;
    this.queues = new Map();
    this.owned = new Set();
    this.pins = new Map();
    // tabId -> attach generation. A lease that attached at epoch N may outlive
    // its slot (hung command force-released at the timeout) while a later
    // operation re-attaches at N+1; the epoch keeps that stale lease's cleanup
    // from detaching the fresh channel.
    this.attachEpoch = new Map();
    this.metrics = { operations: 0, commands: 0, batches: 0, attachments: 0, detaches: 0, timeouts: 0 };
  }

  requireTab(tabId) {
    const tab = this.getTabs().find((candidate) => candidate.id === String(tabId));
    if (!tab) throw new Error('The target tab is no longer available.');
    if (tab.webContents.isDestroyed?.()) throw new Error('The target tab has been closed.');
    return tab;
  }

  run(tabId, purpose, operation, { queueBudgetMs = null } = {}) {
    const id = String(tabId);
    this.metrics.operations += 1;
    const previous = this.queues.get(id) || Promise.resolve();
    const operationPromise = previous.then(() => this.withLease(id, purpose, operation));
    // The slot must settle even when the underlying command never does. The
    // caller receives `guarded` (rejects at the timeout) while the real
    // operation, if it ever settles late, only clears the timer and can no
    // longer influence the queue.
    let timer = null;
    const guarded = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.metrics.timeouts += 1;
        const error = new Error(`Timed out after ${this.operationTimeoutMs}ms while running ${purpose} for this tab; the DevTools command was reset so later work can proceed.`);
        error.code = 'debugger_lease_timeout';
        // Reset the channel: detaching makes the hung sendCommand settle (or
        // abandons it) and gives the next operation a clean debugger attach.
        this.detachOwned(id);
        try { this.onOperationTimeout?.({ tabId: id, purpose }); } catch { /* visibility is best effort */ }
        reject(error);
      }, this.operationTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      operationPromise.then(resolve, reject);
    });
    operationPromise.catch(() => undefined).finally(() => timer && clearTimeout(timer));
    const settled = guarded.catch(() => undefined);
    let tail = null;
    const advance = () => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    };
    if (Number(queueBudgetMs) > 0) {
      // A command whose REPLY is slow must not hold the tab's serialization
      // slot. Chromium can take seconds to acknowledge a synthetic mouse move
      // even though the event was already forwarded to the renderer, and CDP
      // processes commands in order on a session — so releasing the slot after
      // the command has been ISSUED preserves ordering, and only the reply is
      // late. The caller still receives the true outcome through `guarded`.
      let budgetTimer = null;
      const budget = new Promise((resolve) => {
        budgetTimer = setTimeout(resolve, Math.max(1, Number(queueBudgetMs)));
        if (typeof budgetTimer.unref === 'function') budgetTimer.unref();
      });
      tail = Promise.race([settled, budget]).then(() => {
        if (budgetTimer) clearTimeout(budgetTimer);
        advance();
      });
    } else {
      tail = settled.then(advance);
    }
    this.queues.set(id, tail);
    return guarded;
  }

  async send(tabId, purpose, method, params = {}, options = {}) {
    this.metrics.commands += 1;
    return this.run(tabId, purpose, (debuggerClient) => debuggerClient.sendCommand(method, params), options);
  }

  async sendBatch(tabId, purpose, commands = []) {
    if (!Array.isArray(commands) || commands.length === 0) return [];
    this.metrics.batches += 1;
    this.metrics.commands += commands.length;
    return this.run(tabId, purpose, async (debuggerClient) => {
      const results = [];
      for (const command of commands) {
        if (!command || typeof command.method !== 'string') throw new Error('Debugger batch command is invalid.');
        results.push(await debuggerClient.sendCommand(command.method, command.params || {}));
      }
      return results;
    });
  }

  pin(tabId, owner = 'persistent') {
    const id = String(tabId);
    const owners = this.pins.get(id) || new Set();
    owners.add(owner);
    this.pins.set(id, owners);
  }

  unpin(tabId, owner = 'persistent') {
    const id = String(tabId);
    const owners = this.pins.get(id);
    if (!owners) return;
    owners.delete(owner);
    if (owners.size) return;
    this.pins.delete(id);
    this.detachOwned(id);
  }

  async withLease(tabId, purpose, operation) {
    const tab = this.requireTab(tabId);
    const id = String(tabId);
    const debuggerClient = tab.webContents.debugger;
    let attachEpoch = this.attachEpoch.get(id) || 0;
    try {
      if (!debuggerClient.isAttached()) {
        debuggerClient.attach('1.3');
        this.metrics.attachments += 1;
        this.owned.add(tabId);
        attachEpoch = attachEpoch + 1;
        this.attachEpoch.set(id, attachEpoch);
      }
      return await operation(debuggerClient, tab);
    } catch (error) {
      throw new Error(`Could not run ${purpose} for this tab: ${error.message}. Close DevTools for this tab and retry.`);
    } finally {
      // Only the lease whose attach generation is still current may reset the
      // channel; a timed-out hung lease settling late must not detach a newer
      // operation's fresh attach.
      if (!this.pins.has(tabId) && attachEpoch === (this.attachEpoch.get(id) || 0)) {
        this.detachOwned(tabId, tab);
      }
    }
  }

  detachOwned(tabId, knownTab = null) {
    if (!this.owned.has(tabId)) return false;
    this.owned.delete(tabId);
    const tab = knownTab || this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.webContents.isDestroyed?.()) return false;
    try {
      if (tab.webContents.debugger.isAttached()) {
        tab.webContents.debugger.detach();
        this.metrics.detaches += 1;
      }
      return true;
    } catch {
      return false;
    }
  }

  forgetTab(tabId) {
    const id = String(tabId);
    this.queues.delete(id);
    this.pins.delete(id);
    this.attachEpoch.delete(id);
    this.detachOwned(id);
  }

  close() {
    for (const tabId of [...this.owned]) this.detachOwned(tabId);
    this.queues.clear();
    this.pins.clear();
    this.attachEpoch.clear();
  }
}

module.exports = { DebuggerLeaseManager };
