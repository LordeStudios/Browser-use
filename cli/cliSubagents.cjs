'use strict';

// cli/cliSubagents.cjs
//
// CLI subagent runtime (gen-8): wires task_spawn into the headless agent-cli
// composition root — the desktop injects spawnBackgroundTask from main.cjs,
// the CLI used to pass spawnTask: null, so every model call to task_spawn
// failed with "Background agent runs are not available in this session."
//
// Electron-free by construction: desktop/agent/agentPool.cjs is a pure module,
// and the child agents are NESTED in-process DesktopChatAgent instances that
// share the CLI's BrowserViewController and tab map (the adapter supports
// extra tabs — each child gets its own background CDP tab). Each child:
//   - writes its own trace at <outDir>/subagents/<NN>-<alias>/trace.jsonl,
//     whose FIRST line is {type:'harness.subagent.task', task} — Feature C:
//     every surface starts a subagent's visible stream with the spawning
//     prompt (the task text the main agent gave it);
//   - runs with the parent run's provider config (same credentials/model);
//   - gets the same tool surface (browser tools through the shared
//     controller, file/terminal tools native) with NO permission gates —
//     matching the desktop's unattended pool workers;
//   - can itself task_spawn (nested spawns share this pool; the cap bounds
//     concurrency exactly like the desktop pool).
//
// Lifecycle events are mirrored into the MAIN trace as harness.subagent.*
// (spawned/status/finished/findings) so the TUI's existing trace tailer can
// render live subagent cards. Findings are delivered back into the spawning
// conversation through DesktopChatAgent.receiveAgentMessage — the same path
// the desktop's deliverSubagentFindings uses.

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { AgentPool } = require('../desktop/agent/agentPool.cjs');

// Named workers tied to their conversation, closed names recycle (desktop
// parity — main.cjs SUBAGENT_NAME_POOL).
const SUBAGENT_NAME_POOL = ['john', 'mary', 'david', 'sara', 'peter', 'emma', 'paul', 'nina', 'mark', 'anna', 'tom', 'zara', 'omar', 'ivy', 'luke', 'rosa', 'hana', 'kofi', 'lena', 'tessa', 'raul'];

// How long agent-cli waits for spawned subagents after the MAIN run reaches
// its terminal state (a parent that finished while workers are still running
// must not orphan them mid-flight — nor wedge the CLI forever on a stuck
// worker). Override with BROWSER_USE_CLI_SUBAGENT_WAIT_MS (>= 10s).
const SUBAGENT_WAIT_CAP_MS = Math.max(10_000, Number(process.env.BROWSER_USE_CLI_SUBAGENT_WAIT_MS) || 10 * 60 * 1000);

function createCliSubagentRuntime({
  getAgent = null,               // () => the main DesktopChatAgent (findings delivery)
  controller,                    // shared BrowserViewController
  getSelectedTabId = () => null, // () => selected tab id
  setSelectedTabId = () => {},   // (tabId) => void
  openSubagentTab,               // async (url) => { id } — background tab, never steals selection
  closeTab,                      // async (tabId) => void
  createProvider,                // (providerConfig) => provider instance
  controlMode = 'browser',       // 'browser' | 'agi'
  createComputerTools = null,    // () => backend (controlMode === 'agi')
  emitMain = () => {},           // (event) => void — the MAIN run's trace writer
  sanitize = (v) => v,           // trace sanitizer shared with agent-cli
  outDir,                        // the run's out-dir root
  createAgent = null,            // optional factory override ({ tabId, alias, emit }) => agent instance (tests)
  cap = Math.max(1, Math.min(8, Number(process.env.BROWSER_USE_CLI_POOL_CAP) || 3))
}) {
  if (!outDir) throw new Error('cliSubagents requires outDir.');
  if (typeof openSubagentTab !== 'function') throw new Error('cliSubagents requires openSubagentTab.');
  if (typeof closeTab !== 'function') throw new Error('cliSubagents requires closeTab.');

  // spawnId -> { spawnId, alias, parentRunId, task, label, status, runId,
  // tracePath, endTrace, findings }. Statuses: queued -> running ->
  // completed | failed | closed.
  const spawnRegistry = new Map();
  let spawnCounter = 0;

  function nextSubagentAlias() {
    const used = new Set();
    for (const record of spawnRegistry.values()) {
      if (record.status !== 'closed') used.add(record.alias);
    }
    for (const entry of pool.activeRuns) {
      if (entry.alias) used.add(entry.alias);
    }
    const fresh = SUBAGENT_NAME_POOL.find((name) => !used.has(name));
    if (fresh) return fresh;
    const base = SUBAGENT_NAME_POOL[0];
    let counter = 2;
    while (used.has(`${base}-${counter}`)) counter += 1;
    return `${base}-${counter}`;
  }

  // Per-subagent trace stream. The FIRST line is always the task text
  // (harness.subagent.task) — Feature C for the CLI surface.
  function openSubagentTrace(alias) {
    const index = String(++spawnCounter).padStart(2, '0');
    const dir = path.join(outDir, 'subagents', `${index}-${alias}`);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best effort */ }
    const tracePath = path.join(dir, 'trace.jsonl');
    let stream = null;
    try { stream = fs.createWriteStream(tracePath, { flags: 'a' }); } catch { /* trace writes must never break the run */ }
    let started = false;
    const write = (event) => {
      if (!stream) return;
      try {
        if (!started) {
          started = true;
          // Sanity: guarantee the task line is first even if a caller raced.
        }
        stream.write(JSON.stringify({ ts: Date.now(), ...sanitize(event) }) + '\n');
      } catch { /* trace writes must never break the run */ }
    };
    const end = () => new Promise((resolve) => {
      if (!stream) return resolve();
      const s = stream;
      stream = null;
      try { s.end(resolve); } catch { resolve(); }
    });
    return { tracePath, write, end };
  }

  function findInstanceByRunId(runId) {
    const id = String(runId || '');
    if (!id) return null;
    try {
      const main = typeof getAgent === 'function' ? getAgent() : null;
      if (main && String(main.state?.()?.id || '') === id) return main;
    } catch { /* main agent gone */ }
    for (const entry of pool.activeRuns) {
      try {
        if (String(entry.instance?.state?.()?.id || '') === id) return entry.instance;
      } catch { /* instance gone */ }
    }
    return null;
  }

  // Findings delivery (desktop parity — deliverSubagentFindings): the
  // spawned task text is deliberately NOT echoed; the parent wrote it.
  function deliverFindings(record, status, summary, error) {
    if (!record || record.status === 'closed') return;
    const findingsText = [
      `Subagent ${record.alias} — ${status}.`,
      summary ? `Findings:\n\n${String(summary).slice(0, 6000)}` : `No findings were produced.${error ? `\n\nFailure: ${String(error).slice(0, 600)}` : ''}`
    ].join('\n\n');
    let delivered = false;
    const parent = findInstanceByRunId(record.parentRunId);
    if (parent) {
      try {
        const result = parent.receiveAgentMessage({ from: record.spawnId, fromLabel: `subagent ${record.alias}`, text: findingsText, reply: false });
        delivered = result?.delivered === true;
      } catch { /* delivery is best effort */ }
    }
    emitMain({ type: 'harness.subagent.findings', alias: record.alias, status, delivered, summary: String(summary || '').slice(0, 300), error: String(error || '').slice(0, 300) });
  }

  const runtime = {};

  // ---------------------------------------------------------------- pool ----
  // Bind a freshly created child instance to its spawn record so the child's
  // emit() can route events into the record's trace. Safe: AgentPool.pump
  // dispatches strictly serially, so at factory time exactly one record is
  // 'queued' without an instance.
  function bindInstance(instance) {
    const pending = [...spawnRegistry.values()].reverse()
      .find((candidate) => !candidate.instance && candidate.status === 'queued');
    if (pending) pending.instance = instance;
  }

  const pool = new AgentPool({
    cap,
    factory: ({ tabId } = {}) => {
      // The child's emit routes into the registry record created for it —
      // records register their instance as soon as the factory returns.
      const instanceRef = { current: null };
      const emit = (event) => {
        const record = [...spawnRegistry.values()].reverse()
          .find((candidate) => candidate.instance === instanceRef.current);
        if (record) record.trace.write(event);
      };
      if (typeof createAgent === 'function') {
        // Test/override path: the override owns the whole instance.
        const instance = createAgent({ tabId, emit });
        instanceRef.current = instance;
        bindInstance(instance);
        return instance;
      }
      // Default: a real nested DesktopChatAgent sharing the CLI's controller.
      const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
      const { disabledResearchRunner } = require('./stubs.cjs');
      const instance = new DesktopChatAgent({
        controller,
        getSelectedTabId,
        createTab: async (url) => openSubagentTab(typeof url === 'string' ? url : 'about:blank'),
        closeTab: async (tabId) => { try { await closeTab(tabId); } catch { /* best effort */ } },
        selectTab: (tabId) => { setSelectedTabId(String(tabId)); },
        focusTab: null,
        writeReportFile: null,
        modelTaskApi: null,
        getComputerTools: controlMode === 'agi' && typeof createComputerTools === 'function' ? () => createComputerTools() : null,
        getControlMode: () => controlMode,
        emit,
        createProvider,
        onTerminal: null,
        onCheckpoint: null,
        scheduleApi: null,
        spawnTask: (input, run) => runtime.spawnTask(input, run), // nested spawns share this runtime (cap-bounded)
        skillsApi: null,
        messageApi: runtime.messageApi,
        subagentApi: runtime.subagentApi,
        createResultStore: null,
        researchRunner: disabledResearchRunner,
        researchMetaSearch: null,
        knowledgeStore: null,
        layaVerifierFactory: null,
        jevVerifierFactory: null
      });
      instanceRef.current = instance;
      bindInstance(instance);
      return instance;
    },
    allocateTab: async () => {
      const tab = await openSubagentTab('about:blank');
      return tab && tab.id ? String(tab.id) : null;
    },
    releaseTab: async (tabId) => {
      try { await closeTab(String(tabId)); } catch { /* tab teardown is best effort */ }
    },
    publish: (event) => {
      // Pool lifecycle lands in the main trace; the TUI can show saturation.
      emitMain({ type: 'harness.pool', active: event.active, queued: event.queued });
    }
  });

  runtime.pool = pool;

  // ------------------------------------------------------------ spawn ------
  runtime.spawnTask = async function spawnTask(input, run) {
    const task = String(input?.task || '').trim();
    if (!task) throw new Error('task_spawn requires task text for the background run.');
    // LORDE_SPAWN_SATURATION_V370 parity — beyond cap queued spawns the spawn
    // is refused; the model must do its share or wait for findings.
    if (pool.queue.length >= pool.cap) {
      return {
        queued: false,
        refused: true,
        reason: 'pool-saturated',
        pool: `${pool.activeCount}/${pool.cap} slots busy, ${pool.queue.length} queued`,
        note: `Spawn REFUSED: the pool is saturated (${pool.activeCount}/${pool.cap} running, ${pool.queue.length} queued). Do NOT spawn more subagents — wait for findings to arrive, or do a share of the work yourself. Existing workers will report back automatically.`
      };
    }
    const spawnId = randomUUID();
    const alias = nextSubagentAlias();
    const label = String(input?.label || `subagent ${alias}`).slice(0, 80);
    const parentRunId = String(run?.id || '');
    const providerConfig = run?.provider ? { ...run.provider } : null;
    // MODEL SELECTION ON USER COMMAND (parity with desktop spawnBackgroundTask):
    // the CLI runs on a SINGLE connection, so resolution reduces to — a named
    // model overrides the parent's model (an unmatched id fails honestly at
    // the gateway, never a silent fallback); a connectionId other than this
    // single connection is refused honestly. No model named → the parent's
    // provider config passes through unchanged.
    const requestedModel = String(input?.model || '').trim();
    const requestedConnectionId = String(input?.connectionId || '').trim();
    if (requestedConnectionId && requestedConnectionId !== 'cli' && (!providerConfig || requestedConnectionId !== providerConfig.connectionId)) {
      throw new Error(`Unknown provider connection "${requestedConnectionId}" — the CLI runs on a single connection; call model_catalog for the valid id.`);
    }
    let spawnProvider = providerConfig;
    if (requestedModel) {
      if (!spawnProvider) throw new Error('No provider config on this run — cannot honor a model override.');
      spawnProvider = { ...spawnProvider, model: requestedModel };
    }
    const spawnSettings = { controlMode: run?.settings?.controlMode === 'agi' ? 'agi' : controlMode, vision: 'auto' };
    const trace = openSubagentTrace(alias);
    // FEATURE C (CLI): the FIRST trace line is the spawning prompt.
    trace.write({ type: 'harness.subagent.task', alias, label, task });
    const record = { spawnId, alias, parentRunId, task, label, status: 'queued', runId: null, trace, provider: spawnProvider, settings: spawnSettings, findings: '' };
    spawnRegistry.set(spawnId, record);
    emitMain({ type: 'harness.subagent.spawned', spawnId, alias, label, task, parentRunId, tracePath: trace.tracePath, status: 'queued' });
    const tracked = pool.run({
      task,
      label,
      alias,
      retain: false,
      settings: spawnSettings,
      ...(spawnProvider ? { provider: { ...spawnProvider } } : {}),
      onStart: (snapshot) => {
        const rec = spawnRegistry.get(spawnId);
        if (rec) {
          rec.status = 'running';
          rec.runId = snapshot?.id || null;
          emitMain({ type: 'harness.subagent.status', spawnId, alias, status: 'running', runId: rec.runId });
        }
      }
    });
    void tracked.then(async (result) => {
      const rec = spawnRegistry.get(spawnId);
      const status = result?.status || 'completed';
      const summary = result?.result?.summary || result?.summary || '';
      if (rec) {
        rec.status = status;
        rec.findings = String(summary || '').slice(0, 2000);
      }
      emitMain({ type: 'harness.subagent.finished', spawnId, alias, task, status, summary: String(summary || '').slice(0, 300), runId: result?.id || rec?.runId || null, parentRunId });
      deliverFindings(rec, status, summary, null);
      await trace.end();
    }, async (error) => {
      const rec = spawnRegistry.get(spawnId);
      const status = rec && rec.status === 'closed' ? 'closed' : 'failed';
      if (rec) rec.status = status;
      emitMain({ type: 'harness.subagent.finished', spawnId, alias, task, status, error: String(error?.message || error).slice(0, 300), runId: rec?.runId || null, parentRunId });
      if (status !== 'closed') deliverFindings(rec, 'failed', '', error);
      await trace.end();
    });
    return {
      queued: true,
      ...(spawnProvider?.model ? { model: spawnProvider.model, ...(spawnProvider.connectionId ? { connectionId: spawnProvider.connectionId } : {}) } : {}),
      spawnId,
      alias,
      task,
      activeRuns: pool.activeCount,
      queuedRuns: pool.queue.length,
      tracePath: trace.tracePath,
      note: `Queued as subagent ${alias} with full tools (pool: ${pool.activeCount}/${pool.cap} slots busy, ${pool.queue.length} queued). It runs on its own tab with its own context window — only the task text you wrote. Findings are delivered back into THIS conversation automatically when it finishes; never poll subagent_list.`
    };
  };

  // --------------------------------------------------- subagentApi ---------
  runtime.subagentApi = {
    list() {
      const subagents = [...spawnRegistry.values()]
        .filter((record) => record.status !== 'closed')
        .map((record) => ({
          alias: record.alias,
          status: record.status,
          parentRunId: record.parentRunId || null,
          task: String(record.task || '').slice(0, 60),
          ...(record.findings ? { findings: String(record.findings).slice(0, 200) } : {})
        }));
      return {
        subagents,
        note: subagents.length
          ? 'Compact roster. Findings arrive automatically when a subagent finishes — do NOT poll this list.'
          : 'No subagents exist yet; spawn one with task_spawn.'
      };
    },
    async close(alias) {
      const wanted = String(alias || '').trim().toLowerCase();
      if (!wanted) return { closed: false, note: 'subagent_close requires the alias of the subagent to close (subagent_list shows the roster).' };
      const record = [...spawnRegistry.values()].reverse()
        .find((candidate) => candidate.alias.toLowerCase() === wanted && candidate.status !== 'closed');
      if (!record) return { closed: false, note: `No subagent named '${String(alias || '').trim()}' exists. subagent_list shows the current roster.` };
      if (record.status === 'running' && record.runId) {
        try { pool.cancelRun(String(record.runId)); } catch { /* already terminal */ }
      }
      record.status = 'closed';
      emitMain({ type: 'harness.subagent.closed', spawnId: record.spawnId, alias: record.alias, parentRunId: record.parentRunId });
      try { await record.trace.end(); } catch { /* best effort */ }
      return { closed: true, alias: record.alias, note: `Subagent ${record.alias} is closed — it will no longer receive tasks or messages.` };
    }
  };

  // ------------------------------------------------------ messageApi -------
  // Minimal cross-session hub (desktop parity of agent_message): route to a
  // live run by id or alias, deliver through receiveAgentMessage.
  runtime.messageApi = {
    hasLiveRecipient(from) {
      const senderId = String(from || '');
      const candidates = [];
      try {
        const main = typeof getAgent === 'function' ? getAgent() : null;
        if (main) candidates.push(main);
      } catch { /* gone */ }
      for (const entry of pool.activeRuns) candidates.push(entry.instance);
      return candidates.some((instance) => {
        const state = instance?.state?.();
        return String(state?.id || '') !== senderId && ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(state?.status);
      });
    },
    async send({ from, fromLabel, to, text }) {
      const wanted = String(to || 'any').trim().toLowerCase() || 'any';
      const message = { from: String(from || ''), fromLabel: String(fromLabel || 'another session').slice(0, 120), text: String(text || '').slice(0, 4000), reply: false };
      const candidates = [];
      try {
        const main = typeof getAgent === 'function' ? getAgent() : null;
        if (main) candidates.push({ instance: main, label: 'main' });
      } catch { /* gone */ }
      for (const entry of pool.activeRuns) candidates.push({ instance: entry.instance, label: entry.alias || entry.label || 'subagent' });
      let target = null;
      if (wanted === 'any') {
        target = candidates.find((candidate) => String(candidate.instance?.state?.()?.id || '') !== String(from)
          && ['running', 'awaiting_approval', 'paused'].includes(candidate.instance?.state?.()?.status)) || null;
      } else {
        target = candidates.find((candidate) => String(candidate.instance?.state?.()?.id || '') === wanted
          || String(candidate.label || '').toLowerCase() === wanted) || null;
      }
      if (!target) return { sent: false, queued: false, delivered: false, note: 'No matching live agent received this message. Do not claim delivery or a reply.' };
      try {
        const delivered = target.instance.receiveAgentMessage({ ...message, delivery: 'live-agent-message' });
        return { sent: delivered?.delivered === true, queued: false, delivered: delivered?.delivered === true, to: target.label, note: delivered?.delivered === true ? `Delivered to ${target.label}.` : `${target.label} did not receive the message.` };
      } catch (error) {
        return { sent: false, queued: false, delivered: false, note: `Delivery failed: ${String(error?.message || error).slice(0, 200)}` };
      }
    }
  };

  // ---------------------------------------------------------- lifecycle ----
  function activeRecords() {
    return [...spawnRegistry.values()].filter((record) => ['queued', 'running'].includes(record.status));
  }
  runtime.hasActive = () => activeRecords().length > 0;
  runtime.activeCount = () => activeRecords().length;
  runtime.roster = () => runtime.subagentApi.list().subagents;

  // Wait for spawned subagents to settle after the main run ends. Bounded —
  // a wedged worker is cancelled, never a hung CLI.
  runtime.waitForAll = async function waitForAll() {
    const startedAt = Date.now();
    let cancelled = 0;
    while (runtime.hasActive() && Date.now() - startedAt < SUBAGENT_WAIT_CAP_MS) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (runtime.hasActive()) {
      cancelled = runtime.activeCount();
      await runtime.cancelAll('the wait cap elapsed');
    }
    return { cancelled, waitedMs: Date.now() - startedAt };
  };

  runtime.cancelAll = async function cancelAll(reason = 'cancelled') {
    const active = activeRecords();
    try { await pool.cancelAll(`Subagent runs ${reason}.`); } catch { /* best effort */ }
    for (const record of active) {
      record.status = record.status === 'queued' ? 'closed' : 'failed';
      emitMain({ type: 'harness.subagent.finished', spawnId: record.spawnId, alias: record.alias, task: record.task, status: record.status, error: reason, runId: record.runId, parentRunId: record.parentRunId });
      try { await record.trace.end(); } catch { /* best effort */ }
    }
    return active.length;
  };

  return runtime;
}

module.exports = { createCliSubagentRuntime, SUBAGENT_NAME_POOL, SUBAGENT_WAIT_CAP_MS };
