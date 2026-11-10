import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { AgentPool, DesktopLease, leaseComputerTools } = require('../desktop/agent/agentPool.cjs');

function fakeAgent(id, { holdMs = 0, onState = null } = {}) {
  let state = { id, computerOwner: `chat:${id}`, status: 'running' };
  return {
    state: () => ({ ...state }),
    async start(request) {
      if (onState) onState(request, value => { state = { ...state, ...value }; });
      if (holdMs) await new Promise(resolve => setTimeout(resolve, holdMs));
      state = { ...state, status: 'completed' };
      return { ...state, result: { success: true, summary: 'done' } };
    },
    cancel() { state = { ...state, status: 'cancelled' }; }
  };
}

test('desktop lease is exclusive across owners and re-entrant for the holder', async () => {
  const lease = new DesktopLease();
  await lease.acquire('chat:a');
  assert.equal(lease.holder, 'chat:a');
  await lease.acquire('chat:a'); // same run re-acquiring is a no-op
  let released = false;
  const second = lease.acquire('chat:b').then(() => { released = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(released, false, 'a second owner waits while the desktop is leased');
  assert.equal(lease.release('chat:b'), false, 'a non-holder cannot release');
  lease.release('chat:a');
  await second;
  assert.equal(lease.holder, 'chat:b');
  assert.equal(lease.release('chat:b'), true);
});

test('a released waiter aborts instead of stealing the lease when its run is cancelled', async () => {
  const lease = new DesktopLease();
  await lease.acquire('chat:a');
  const abortController = new AbortController();
  const waiting = lease.acquire('chat:b', abortController.signal);
  await new Promise(resolve => setTimeout(resolve, 5));
  abortController.abort();
  await assert.rejects(waiting, /Desktop is in use|cancelled/);
  assert.equal(lease.holder, 'chat:a');
  lease.release('chat:a');
  assert.equal(lease.holder, null);
});

test('mutating native input takes the lease; read-only tools pass through', async () => {
  const lease = new DesktopLease();
  const calls = [];
  const backend = {
    execute: async (name, input, owner) => { calls.push([name, owner]); return { ok: true }; },
    observe: async () => ({ windows: [] })
  };
  const leased = leaseComputerTools(backend, lease);
  await leased.execute('computer_observe', {}, 'chat:a');
  await leased.execute('computer_screenshot', {}, 'chat:a');
  assert.equal(lease.holder, null, 'read-only tools never lease the desktop');
  await leased.execute('computer_pointer', { action: 'click', x: 1, y: 2 }, 'chat:a');
  assert.equal(lease.holder, null, 'a click releases the desktop after the gesture completes');
  await leased.execute('computer_pointer', { action: 'down', x: 1, y: 2 }, 'chat:a');
  assert.equal(lease.holder, 'chat:a', 'a retained pointer-down leases the desktop for the run');
  // A different owner now waits; the holder's run must end for it to proceed.
  let secondDone = false;
  const second = leased.execute('computer_pointer', { action: 'click', x: 3, y: 4 }, 'chat:b').then(() => { secondDone = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(secondDone, false);
  lease.release('chat:a');
  await second;
  assert.equal(secondDone, true);
});

test('pool admits at most cap concurrent runs and queues the rest', async () => {
  const created = [];
  const pool = new AgentPool({
    cap: 2,
    factory: () => { const agent = fakeAgent(`run-${created.length + 1}`, { holdMs: 60 }); created.push(agent); return agent; },
    publish: () => {}
  });
  const first = pool.run({ task: 'one' });
  const second = pool.run({ task: 'two' });
  const third = pool.run({ task: 'three' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(pool.activeCount, 2);
  assert.equal(pool.queue.length, 1);
  assert.equal((await first).result.success, true);
  await Promise.all([first, second, third]);
  assert.equal(pool.activeCount, 0);
  assert.equal(created.length, 3);
});

test('pool enforces tab exclusivity', async () => {
  const pool = new AgentPool({
    cap: 3,
    factory: () => fakeAgent(`run-${Math.random()}`, { holdMs: 40 }),
    publish: () => {}
  });
  const holder = pool.run({ task: 'owns tab', tabId: 'tab-7' });
  await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(pool.run({ task: 'same tab', tabId: 'tab-7' }), /already owned/);
  await holder;
  // After the run ends the tab is free again.
  await pool.run({ task: 'reuse tab', tabId: 'tab-7' });
});

test('pool releases the lease and the tab when a run terminates', async () => {
  const releasedTabs = [];
  const lease = new DesktopLease();
  const pool = new AgentPool({
    cap: 2,
    lease,
    factory: () => fakeAgent(`run-${Math.random()}`),
    allocateTab: async () => `tab-${Math.random()}`,
    releaseTab: async tabId => { releasedTabs.push(tabId); },
    publish: () => {}
  });
  pool.computerTools = leaseComputerTools({ execute: async () => ({ ok: true }) }, lease);
  await pool.run({ task: 'work' });
  assert.equal(lease.holder, null, 'terminal cleanup released any lease held by the run');
  assert.equal(releasedTabs.length, 1);
});

test('pool propagates a startup rejection instead of masking it with null.id', async () => {
  const lease = new DesktopLease();
  const releasedTabs = [];
  const pool = new AgentPool({
    lease,
    allocateTab: async () => 'tab-startup-failure',
    releaseTab: async (tabId) => releasedTabs.push(tabId),
    factory: () => ({
      state: () => null,
      start: async () => { throw new Error('Choose a Browser Use Cloud model before starting the agent.'); },
      cancel() {}
    }),
    publish: () => {}
  });
  await assert.rejects(
    pool.run({ task: 'background cloud task', provider: { id: 'cloud', model: '' } }),
    /Choose a Browser Use Cloud model/
  );
  assert.equal(pool.activeCount, 0);
  assert.deepEqual(releasedTabs, ['tab-startup-failure']);
  assert.equal(lease.holder, null);
});

test('pool threads the subagent alias into the run identity and pool events', async () => {
  const events = [];
  let received = null;
  const pool = new AgentPool({
    factory: () => ({
      state: () => ({ id: 'alias-run', agentIdentity: 'john', computerOwner: 'chat:alias-run', status: 'running' }),
      async start(request) { received = request; return { id: 'alias-run', status: 'completed', result: { success: true } }; },
      cancel() {}
    }),
    publish: (event) => events.push(event)
  });
  await pool.run({ task: 'research the folder', alias: 'john', label: 'folder research' });
  assert.equal(received.agentIdentity, 'john', 'the spawned run starts under its alias identity');
  const updated = events.find((event) => event.type === 'pool.updated');
  assert.equal(updated.active[0].alias, 'john', 'the pool publishes the alias so the parent can address it');
});

test('a failed tab allocation fails the spawn instead of sharing the selected tab', async () => {
  const started = [];
  const pool = new AgentPool({
    allocateTab: async () => null,
    factory: () => ({
      state: () => null,
      async start(request) { started.push(request); return { id: 'never', status: 'completed' }; },
      cancel() {}
    }),
    publish: () => {}
  });
  await assert.rejects(
    pool.run({ task: 'work that needs a tab' }),
    /could not allocate an isolated tab/
  );
  assert.equal(started.length, 0, 'the agent never starts on a tab it does not own');
});

test('pool passes the complete provider configuration to a spawned run', async () => {
  let received = null;
  const pool = new AgentPool({
    factory: () => ({
      state: () => ({ id: 'provider-pass', computerOwner: 'chat:provider-pass', status: 'running' }),
      async start(request) { received = request; return { id: 'provider-pass', status: 'completed', result: { success: true } }; },
      cancel() {}
    }),
    publish: () => {}
  });
  await pool.run({
    task: 'preserve provider fields',
    provider: { id: 'cloud', model: 'browser-use-model', connectionId: 'conn-1', endpoint: 'https://example.test' }
  });
  assert.deepEqual(received.provider, { id: 'cloud', model: 'browser-use-model', connectionId: 'conn-1', endpoint: 'https://example.test' });
});

test('a retained run keeps its instance and tab after termination until explicitly closed', async () => {
  const releasedTabs = [];
  const pool = new AgentPool({
    factory: () => fakeAgent('resident-run'),
    allocateTab: async () => 'tab-resident',
    releaseTab: async tabId => { releasedTabs.push(tabId); },
    publish: () => {}
  });
  const run = await pool.run({ task: 'research phase', retain: true });
  assert.equal(run.status, 'completed');
  assert.equal(releasedTabs.length, 0, 'the resident tab stays open after the run ends');
  assert.equal(pool.retained.size, 1);
  assert.equal(pool.activeCount, 0, 'the resident is no longer an active run');
  assert.equal(pool.ownsTab('tab-resident'), true, 'the retained tab stays exclusively owned');
  assert.equal(pool.listRetained()[0].id, 'resident-run');
  assert.equal(await pool.closeRetained('resident-run'), true, 'explicit close tears the resident down');
  assert.deepEqual(releasedTabs, ['tab-resident'], 'closing releases the tab');
  assert.equal(pool.retained.size, 0);
  assert.equal(pool.ownsTab('tab-resident'), false);
  assert.equal(await pool.closeRetained('resident-run'), false, 'closing twice is a no-op');
});

test('retain:false keeps the legacy teardown (tab released at terminal)', async () => {
  const releasedTabs = [];
  const pool = new AgentPool({
    factory: () => fakeAgent('legacy-run'),
    allocateTab: async () => 'tab-legacy',
    releaseTab: async tabId => { releasedTabs.push(tabId); },
    publish: () => {}
  });
  await pool.run({ task: 'work' });
  assert.deepEqual(releasedTabs, ['tab-legacy']);
  assert.equal(pool.retained.size, 0);
});

test('a run whose start throws is never retained', async () => {
  const releasedTabs = [];
  const pool = new AgentPool({
    allocateTab: async () => 'tab-throws',
    releaseTab: async tabId => { releasedTabs.push(tabId); },
    factory: () => ({
      state: () => null,
      start: async () => { throw new Error('provider misconfigured'); },
      cancel() {}
    }),
    publish: () => {}
  });
  await assert.rejects(pool.run({ task: 'doomed', retain: true }), /provider misconfigured/);
  assert.equal(pool.retained.size, 0, 'a never-started run never becomes a resident');
  assert.deepEqual(releasedTabs, ['tab-throws'], 'the failed spawn releases its tab');
});

test('retained residents are evicted FIFO beyond maxRetained, releasing their tabs', async () => {
  const releasedTabs = [];
  const pool = new AgentPool({
    maxRetained: 2,
    factory: () => fakeAgent(`run-${Math.random()}`),
    allocateTab: async () => `tab-${Math.random()}`,
    releaseTab: async tabId => { releasedTabs.push(tabId); },
    publish: () => {}
  });
  await pool.run({ task: 'one', retain: true });
  await pool.run({ task: 'two', retain: true });
  await pool.run({ task: 'three', retain: true });
  assert.equal(pool.retained.size, 2);
  assert.equal(releasedTabs.length, 1, 'the oldest resident was evicted and its tab released');
});

test('cancelRun cancels a tracked active run by id', async () => {
  let cancelled = false;
  let rejectRun = null;
  const pool = new AgentPool({
    factory: () => ({
      state: () => ({ id: 'cancel-me', status: 'running' }),
      start: () => new Promise((resolve, reject) => { rejectRun = reject; }),
      cancel() { cancelled = true; rejectRun(new Error('cancelled by test')); }
    }),
    publish: () => {}
  });
  const tracked = pool.run({ task: 'long work' });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(pool.cancelRun('cancel-me'), true);
  assert.equal(cancelled, true);
  await assert.rejects(tracked, /cancelled by test/);
  assert.equal(pool.cancelRun('cancel-me'), false, 'an unknown id cancels nothing');
});

test('pool forwards a per-worker workspace so each worker can run in its own worktree', async () => {
  let received = null;
  const pool = new AgentPool({
    factory: () => ({ state: () => ({ id: 'ws-run', status: 'running' }), async start(request) { received = request; return { id: 'ws-run', status: 'completed', result: { success: true } }; }, cancel() {} }),
    publish: () => {}
  });
  await pool.run({ task: 'file work', workspace: { root: 'E:/worker-worktree' } });
  assert.equal(received.workspace.root, 'E:/worker-worktree', 'the worker starts on its isolated workspace');
});

test('pool cap ceiling is 32 so large swarms are a deliberate choice, not a hard wall', () => {
  const pool = new AgentPool({ cap: 64, factory: () => fakeAgent('x'), publish: () => {} });
  assert.equal(pool.cap, 32);
  const tiny = new AgentPool({ cap: 0, factory: () => fakeAgent('y'), publish: () => {} });
  assert.equal(tiny.cap, 3, 'a falsy cap falls back to the legacy default');
});
