const { app, BrowserWindow, BrowserView, ipcMain, session, clipboard, nativeImage, Menu, safeStorage, Tray, powerSaveBlocker, shell, screen, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { SessionBroker } = require('./mcp/sessionBroker.cjs');
const { BrowserViewController } = require('./mcp/browserViewController.cjs');
const { LocalMcpServer } = require('./mcp/localMcpServer.cjs');
const webBridge = require('./webBridge.cjs');
// Capture ipcMain registrations BEFORE anything registers, so the loopback
// web bridge can dispatch to the exact handlers the Electron renderer uses.
webBridge.installIpcCapture({ ipcMain });
const { DeviceEmulator } = require('./mcp/deviceEmulator.cjs');
const { AndroidDeviceManager } = require('./android/androidDeviceManager.cjs');
const nativeAndroidWindow = require('./android/windowsNativeWindow.cjs');
const { DebuggerLeaseManager } = require('./mcp/debuggerLeaseManager.cjs');
const { TerminalBrokerClient } = require('./terminal/terminalBrokerClient.cjs');
const { listDeviceProfiles, DESKTOP_ID } = require('../src/browser/deviceProfiles.cjs');
const { buildElementPickerExpression } = require('../src/browser/elementPicker.cjs');
const { buildTouchOverlayExpression } = require('../src/browser/touchOverlay.cjs');
const { DesktopChatAgent, defaultResearchAgent } = require('./agent/desktopChatAgent.cjs');
const { HcuSession } = require('./agent/hcuSession.cjs');
const { AgentPool, DesktopLease, leaseComputerTools, leaseHandoffNotices } = require('./agent/agentPool.cjs');
const { computeIdleSubagentCloses, computeIdleEmptyTabCloses } = require('./agent/idleSweeps.cjs');
const { Scheduler } = require('./schedule/scheduler.cjs');
const { SchedulerStore } = require('./schedule/schedulerStore.cjs');
const { createOllamaProvider, preflightOllama } = require('./agent/ollamaProvider.cjs');
const { createCloudProvider, redactKey } = require('./agent/cloudProvider.cjs');
const { createOpenAiCompatibleProvider } = require('./agent/openAiCompatibleProvider.cjs');
const { PROVIDER_LABELS, publicProviderStatus } = require('./agent/providers/descriptors.cjs');
const { CredentialStore } = require('./store/credentialStore.cjs');
const { runModelTask, inferModelKind, normalizeCustomModel, MODEL_KINDS } = require('./agent/mediaRouter.cjs');
const { compactModelEntry, catalogResponse } = require('./agent/modelCatalog.cjs');
const { probeModelsForCapability, loadProbeCache, probeCacheKey } = require('./agent/modelCapabilityProbe.cjs');
const { createVisionDescriber } = require('./agent/visionDelegate.cjs');
const { ChatHistoryStore } = require('./store/chatHistoryStore.cjs');
const { SkillStore } = require('./record/skills.cjs');
const { Recorder } = require('./record/recorder.cjs');
const { isSafeStaticHtml } = require('./agent/reportFilePolicy.cjs');
const { AgentPointerOverlay } = require('./pointer/agentPointerOverlay.cjs');
const { normalizeControlMode } = require('./computer/computerCatalog.cjs');
// Effort ladder for the chat agent (Auto/Minimal/Standard/Advanced pill).
const normalizeAgentEffort = (value) => ['auto', 'minimal', 'standard', 'advanced'].includes(value) ? value : 'auto';

// gen9 port (gen7 /cd): the agent-level DEFAULT working repo, set once via
// /cd in the app chat (browser-use:set-default-workspace) when no conversation
// is open. Applied as the workspace contract for the next conversation that
// names no path â€” the user pins the repo ONCE and never types it again. A
// FOCUS, never a boundary.
let defaultWorkspaceRoot = null;
function resolveWorkspaceContract(task = '') {
  // The workspace follows the TASK: an absolute directory named in the task
  // text becomes the run's DEFAULT scope from the first decision, so pointing
  // the agent at a new repo works immediately â€” no retarget ceremony and no
  // gate required (the default scope is a convenience, never an access
  // boundary; out-of-root paths always execute). The studio contract stays
  // only as the fallback for tasks that name no path.
  for (const raw of (String(task || '').match(/[A-Za-z]:[\\/][^\s"',;)\]]+/g) || [])) {
    const candidate = raw.replace(/[.,]+$/, '');
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return { root: path.resolve(candidate), target: path.resolve(candidate), url: null };
      }
    } catch { /* try the next mention */ }
  }
  // gen9 port: the pinned default from /cd (validated at set time) wins over
  // the studio fallback for tasks that name no directory of their own.
  if (defaultWorkspaceRoot) {
    try {
      if (fs.existsSync(defaultWorkspaceRoot) && fs.statSync(defaultWorkspaceRoot).isDirectory()) {
        return { root: defaultWorkspaceRoot, target: defaultWorkspaceRoot, url: null };
      }
    } catch { /* fall through to the studio fallback */ }
  }
  const repoRoot = path.resolve(__dirname, '../..');
  const studioTarget = path.join(repoRoot, 'studios', 'public', 'Apps', 'lorde-design-studio');
  if (!fs.existsSync(studioTarget)) return null;
  return {
    root: repoRoot,
    target: studioTarget,
    url: 'http://127.0.0.1:3001/Apps/lorde-design-studio/'
  };
}
const { normalizeUrl } = require('./urlUtils.cjs');
const { HistoryStore } = require('./historyStore.cjs');
let computerTools = null;
let hcuSession = null;
let agentPool = null;
let scheduler = null;
let schedulerStore = null;
let skillsStore = null;
let recorder = null;

// One skills view for the agent AND the Learned skills screen: recorded
// (learned) skills plus installed SKILL.md packages. Before this, the agent
// searched only the learned store and the UI listed only the learned store, so
// skills living in <app>/.claude/skills, ~/.browser-use-cli/skills or a pinned
// repo's .browser-use/skills never appeared anywhere.
function installedSkillsManager() {
  const { SkillsManager } = require('./agent/skillsManager.cjs');
  return new SkillsManager({
    userDir: path.join(os.homedir(), '.browser-use-cli', 'skills'),
    repoDir: defaultWorkspaceRoot ? path.join(defaultWorkspaceRoot, '.browser-use', 'skills') : null
  });
}
function mergedSkillsApi() {
  const { createMergedSkillsApi } = require('./agent/skillsManager.cjs');
  return createMergedSkillsApi({ learnedStore: skillsStore, manager: installedSkillsManager() });
}
// Installed skills mapped onto the learned-skill row shape the UI renders.
function installedSkillRows() {
  try {
    return installedSkillsManager().list().map((skill) => ({
      ...skill,
      installed: true,
      // Edited through skills-update (rewrites SKILL.md).
      readOnly: false,
      cannotDelete: false,
      status: skill.enabled ? 'active' : 'paused',
      // The body is one 6,000-character step; the list shows a summary instead.
      steps: [{ action: skill.description || 'Follow the skill instructions', detail: `${skill.bodyChars} characters${skill.hasScripts ? ' + scripts' : ''}` }]
    }));
  } catch { return []; }
}
// BUG FIX: Shared background tab for subagents to prevent involuntary tab spawns
let sharedBackgroundTabId = null;
// The provider config of the most recent chat run IS the application's active
// model; Record & Learn reasons through it, never a separate selector.
let lastRunProviderConfig = null;
// Reused named OAuth popup BrowserWindows can trigger did-create-window more
// than once. Keep listener ownership outside the Electron wrapper object;
// assigning a custom property is not reliable across Electron versions and
// caused MaxListenersExceededWarning during repeated Android/browser runs.
const closedListenerWiredWindows = new WeakSet();
// LORDE_BROWSERVIEW_CLOSED_LEAK_V370 â€” Electron installs a per-view 'closed'
// listener on the window every time a BrowserView is attached, and never
// removes it: not by removeBrowserView(), not when the view's webContents is
// destroyed. The shell re-attaches the same views constantly to force native
// z-order (drawer open/close, tab switch, device mode, background capture),
// so every one of those transitions parked another permanent listener on the
// window. Ten drawer toggles crossed Node's max-listeners threshold â€”
// "11 closed listeners added to [BrowserWindow]" â€” and the count then grew
// without bound, leaving a trail of stale detach handlers to run on every
// window teardown.
//
// The listener is captured when the view is attached and dropped the moment
// the view is detached, so the window carries exactly one listener per
// ATTACHED view â€” Electron's own invariant â€” instead of one per attach ever.
const viewClosedListeners = new WeakMap();

function attachBrowserView(win, view) {
  if (!win || win.isDestroyed() || !view) return false;
  if (win.getBrowserViews().includes(view)) return false;
  const before = new Set(win.listeners('closed'));
  win.addBrowserView(view);
  // Electron adds its per-view detach handler as a side effect of the attach.
  // Keep it: it is what detaches the view when the window closes. Electron
  // builds a fresh closure per attach, so the handler from a previous attach
  // of this view is a different object and must be dropped, not reused.
  for (const listener of win.listeners('closed')) {
    if (before.has(listener)) continue;
    const stale = viewClosedListeners.get(view);
    if (stale && stale.window === win && stale.listener && stale.listener !== listener) {
      win.removeListener('closed', stale.listener);
    }
    viewClosedListeners.set(view, { window: win, listener });
  }
  return true;
}

function detachBrowserView(win, view) {
  if (!win || win.isDestroyed() || !view) return false;
  const attached = win.getBrowserViews().includes(view);
  try { win.removeBrowserView(view); } catch { /* best effort */ }
  // The view is no longer a child of the window, so its detach handler has
  // nothing left to do. Dropping it here is what keeps the window's listener
  // count flat across attach/detach churn.
  const record = viewClosedListeners.get(view);
  if (record && record.window === win && record.listener) {
    win.removeListener('closed', record.listener);
    viewClosedListeners.set(view, { window: win, listener: null });
  }
  return attached;
}

const desktopLease = new DesktopLease();
let leasedComputerToolsInstance = null;
// Lazily-leased native backend: a Koffi child must not start at idle
// Browser-only startup, so the real tools resolve only on first use. Mutating
// native input takes the desktop lease; read-only tools pass through.
function getLeasedComputerTools() {
  if (!leasedComputerToolsInstance) {
    const backend = {
      execute: (name, input, owner, options) => getComputerTools().execute(name, input, owner, options),
      // Harness telemetry: the native-surface probe must not ride the model
      // tool-call entry point, so the backend exposes a dedicated scan.
      scanWindows: (...args) => getComputerTools().scanWindows(...args),
      observe: (...args) => getComputerTools().observe(...args),
      releaseInput: (...args) => getComputerTools().releaseInput?.(...args),
      releaseOwner: (...args) => getComputerTools().releaseOwner(...args),
      close: (...args) => getComputerTools().close?.(...args)
    };
    leasedComputerToolsInstance = leaseComputerTools(backend, desktopLease);
  }
  return leasedComputerToolsInstance;
}

// LORDE_NAMED_SUBAGENTS_V364 â€” subagents are named workers TIED to their
// spawning agent (Chat 1/2/3). Every agent can spawn as many as it likes;
// each spawn gets a real alias (john, mary, ...) that addresses it for
// agent_message while it runs, and its terminal findings are delivered back
// into the spawning conversation automatically. Subagents keep full tool
// access (browser + computer + files) exactly like any agent.
//
// LORDE_RESIDENT_SUBAGENTS_V365 â€” a finished subagent does NOT close. It
// becomes a RESIDENT worker: its instance, tab, and conversation stay alive,
// the spawning agent keeps assigning it follow-up tasks through agent_message
// (each assignment continues the SAME conversation, so context accumulates),
// and only an explicit subagent_close tears it down. The main agent manages
// its workers; the harness never closes them behind its back.
const SUBAGENT_NAME_POOL = ['john', 'mary', 'david', 'sara', 'peter', 'emma', 'paul', 'nina', 'mark', 'anna', 'tom', 'zara', 'omar', 'ivy', 'luke', 'rosa', 'hana', 'kofi', 'lena', 'tessa', 'raul'];
// spawnId -> { spawnId, alias, parentRunId, task, label, status, runId,
// instance, tabId, provider, settings }. Statuses: queued -> running ->
// resident (or terminal) -> closed. A resident holds its instance + tab.
const spawnRegistry = new Map();

function nextSubagentAlias() {
  const used = new Set();
  // LORDE_RESIDENT_SUBAGENTS_V365 â€” residents keep their names: only closed
  // records release an alias for reuse.
  for (const record of spawnRegistry.values()) {
    if (record.status !== 'closed') used.add(record.alias);
  }
  for (const entry of agentPool?.activeRuns || []) {
    if (entry.alias) used.add(entry.alias);
  }
  for (const entry of agentPool?.retained?.values() || []) {
    if (entry.alias) used.add(entry.alias);
  }
  const fresh = SUBAGENT_NAME_POOL.find((name) => !used.has(name));
  if (fresh) return fresh;
  const base = SUBAGENT_NAME_POOL[0];
  let counter = 2;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

// LORDE_SUBAGENT_WORKTREES_V365 â€” parallel file workers must not patch the
// same working tree: each spawned subagent gets its own git worktree + branch
// (Claude Code's isolation model). Two agents editing one file can no longer
// fight over the hash guard; every worker owns a private copy and commits to
// its branch. Graceful fallback: no git repo or git unavailable -> the shared
// tree, exactly as before.
const { execFile } = require('node:child_process');
function gitExec(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message || 'git failed').slice(0, 300)));
      else resolve(String(stdout || '').trim());
    });
  });
}

async function createSubagentWorktree(parentWorkspace, alias) {
  // Task-text-extracted roots can carry trailing punctuation ("...studio:")
  // â€” git fatalled on them. Trim to a real, existing directory or fall back.
  const root = String(parentWorkspace?.root || '').trim().replace(/[\s:.,;'"]+$/, '');
  if (!root || !require('node:fs').existsSync(root)) return null;
  try {
    const toplevel = await gitExec(['rev-parse', '--show-toplevel'], root);
    const branch = `subagent/${alias}`;
    const worktreePath = path.join(toplevel, '.browser-use-worktrees', `${alias}-${Date.now().toString(36)}`);
    await gitExec(['worktree', 'add', '-b', branch, worktreePath], toplevel);
    return { path: worktreePath, branch, toplevel };
  } catch (error) {
    addConsoleEntry({ kind: 'agent', level: 'info', message: `Subagent ${alias} runs on the shared tree (worktree unavailable: ${String(error.message || error).slice(0, 160)})` });
    return null;
  }
}

// Close-time teardown: a worktree with no changes is removed outright; a
// dirty one is kept with its branch so the work is never lost â€” the parent
// decides whether to merge it.
async function removeSubagentWorktree(worktree) {
  if (!worktree?.path || !worktree.toplevel) return { removed: false };
  try {
    const dirty = await gitExec(['status', '--porcelain'], worktree.path);
    if (String(dirty || '').trim()) return { removed: false, dirty: true, branch: worktree.branch, path: worktree.path };
    await gitExec(['worktree', 'remove', '--force', worktree.path], worktree.toplevel);
    return { removed: true };
  } catch (error) {
    return { removed: false, error: String(error.message || error).slice(0, 200) };
  }
}

function spawnRunContext(parentRunId) {
  const id = String(parentRunId || '');
  if (!id) return null;
  const instance = liveAgentInstances().find((candidate) => String(candidate?.state?.()?.id || '') === id) || null;
  return instance ? { instance, id } : null;
}

async function spawnBackgroundTask(input, run) {
  const task = String(input?.task || '').trim();
  if (!task) throw new Error('task_spawn requires task text for the background run.');
  if (!agentPool) throw new Error('Background agent runs are unavailable while the bridge is stopped.');
  // LORDE_SPAWN_SATURATION_V370 â€” a coordinator that keeps dumping spawns into
  // a saturated pool strands workers 20+ deep. Beyond cap queued spawns, the
  // spawn is refused: the model must work its own share or wait for findings.
  if (agentPool.queue.length >= agentPool.cap) {
    return {
      queued: false,
      refused: true,
      reason: 'pool-saturated',
      pool: `${agentPool.activeCount}/${agentPool.cap} slots busy, ${agentPool.queue.length} queued`,
      note: `Spawn REFUSED: the pool is saturated (${agentPool.activeCount}/${agentPool.cap} running, ${agentPool.queue.length} queued). Do NOT spawn more subagents â€” wait for findings to arrive, or do a share of the work yourself. Existing workers will report back automatically.`
    };
  }
  const spawnId = randomUUID();
  const alias = nextSubagentAlias();
  const label = String(input?.label || `subagent ${alias}`).slice(0, 80);
  const parentRunId = String(run?.id || '');
  const providerConfig = run?.provider ? { ...run.provider } : null;
  // MODEL SELECTION ON USER COMMAND: "spawn a subagent on <model>" must work.
  // An explicit connectionId wins; otherwise the model id is matched against
  // every connection's SAVED catalog (its selected model + custom models).
  // An unmatched model id stays on the resolved connection and fails honestly
  // at the gateway â€” never a silent fallback to the parent's model.
  const requestedModel = String(input?.model || '').trim();
  const requestedConnectionId = String(input?.connectionId || '').trim();
  let spawnProvider = providerConfig;
  if (requestedConnectionId || requestedModel) {
    const connections = normalizedConnections();
    const explicit = requestedConnectionId ? connections.find((item) => item.id === requestedConnectionId) : null;
    if (requestedConnectionId && !explicit) throw new Error(`Unknown provider connection "${requestedConnectionId}" â€” call model_catalog for the valid ids.`);
    let connection = explicit || null;
    if (!connection && requestedModel) {
      connection = connections.find((item) => item.model === requestedModel
        || (Array.isArray(item.customModels) && item.customModels.some((entry) => (typeof entry === 'object' ? entry?.id : entry) === requestedModel))) || null;
    }
    if (!connection && providerConfig?.connectionId) connection = connections.find((item) => item.id === providerConfig.connectionId) || null;
    if (connection && PROVIDER_LABELS[connection.provider]) {
      if (!credentialStore?.get(connectionCredentialKey(connection.id))) throw new Error(`The ${PROVIDER_LABELS[connection.provider]} connection has no API key configured â€” spawn refused.`);
      spawnProvider = { id: connection.provider, connectionId: connection.id, baseUrl: connection.baseUrl, model: requestedModel || connection.model || '' };
      if (!spawnProvider.model) throw new Error('The target connection has no model selected â€” pass model explicitly.');
    } else if (connection) {
      spawnProvider = { id: connection.provider, baseUrl: connection.baseUrl, model: requestedModel || connection.model || '' };
    } else if (requestedModel && spawnProvider) {
      spawnProvider = { ...spawnProvider, model: requestedModel };
    } else if (requestedModel) {
      spawnProvider = { id: 'ollama', baseUrl: settings.aiChatBaseUrl, model: requestedModel };
    }
  }
  const spawnSettings = { controlMode: run?.settings?.controlMode === 'agi' ? 'agi' : 'browser', vision: 'auto' };
  const worktree = await createSubagentWorktree(run?.workspace, alias);
  // An isolated worker must KNOW it is isolated: the worktree contract is
  // part of its task text (the only context it starts with â€” its conversation
  // is otherwise empty, never a copy of the parent's).
  const taskText = worktree ? `${task}\n\nYou are working in an isolated git worktree on branch ${worktree.branch} (${worktree.path}). Patch freely there â€” you cannot conflict with other agents. Commit your changes to that branch before finishing.` : task;
  spawnRegistry.set(spawnId, { spawnId, alias, parentRunId, task, label, status: 'queued', runId: null, instance: null, tabId: null, provider: spawnProvider, settings: spawnSettings, worktree, lastActivityAt: Date.now() });
  // LORDE_RESIDENT_SUBAGENTS_V365 â€” retain:true keeps the finished subagent
  // alive (instance + tab + conversation) instead of tearing it down; only an
  // explicit subagent_close ends its life.
  const tracked = agentPool.run({
    task: taskText,
    label,
    alias,
    retain: true,
    settings: spawnSettings,
    ...(worktree ? { workspace: { root: worktree.path } } : {}),
    ...(spawnProvider ? { provider: { ...spawnProvider } } : {}),
    onStart: (snapshot) => {
      const record = spawnRegistry.get(spawnId);
      if (record) { record.status = 'running'; record.runId = snapshot?.id || null; }
    }
  });
  // Findings delivery is shared by the first run and every follow-up
  // assignment (see deliverSubagentFindings below).
  const deliverFindings = (status, summary, error) => deliverSubagentFindings(spawnRegistry.get(spawnId), status, summary, error);
  tracked.then((result) => {
    const summary = result?.result?.summary || result?.summary || '';
    const status = result?.status || 'completed';
    const record = spawnRegistry.get(spawnId);
    // LORDE_RESIDENT_SUBAGENTS_V365 â€” the finished run becomes a resident
    // worker: instance, tab, and conversation stay alive for follow-up
    // assignments until subagent_close.
    const retainedEntry = agentPool?.retained?.get(String(result?.id || ''));
    if (record) {
      if (status !== 'failed') record.findings = String(summary || '').slice(0, 2000);
      if (retainedEntry) {
        record.status = 'resident';
        record.instance = retainedEntry.instance;
        record.tabId = retainedEntry.tabId;
        record.runId = retainedEntry.runId || result?.id || record.runId;
      } else record.status = 'terminal';
    }
    addConsoleEntry({ kind: 'agent', level: status === 'failed' ? 'error' : 'info', message: `Subagent ${alias} ${status}${record?.status === 'resident' ? ' (resident â€” assign follow-ups with agent_message, close with subagent_close)' : ''}: ${summary || task}` });
    broadcastAgentEvent({ type: 'spawn.finished', spawnId, alias, task, status, summary, runId: result?.id || null, parentRunId, resident: record?.status === 'resident' });
    deliverFindings(status, summary, null);
    publishState();
  }, (error) => {
    const record = spawnRegistry.get(spawnId);
    if (record && record.status === 'closed') {
      addConsoleEntry({ kind: 'agent', level: 'info', message: `Subagent ${alias} was closed while running; no findings were reported.` });
      publishState();
      return;
    }
    broadcastAgentEvent({ type: 'spawn.finished', spawnId, alias, task, status: 'failed', error: error.message, parentRunId });
    addConsoleEntry({ kind: 'agent', level: 'error', message: `Subagent ${alias} failed: ${error.message}` });
    deliverFindings('failed', '', error.message);
    publishState();
  });
  return {
    queued: true,
    spawnId,
    alias,
    task,
    ...(spawnProvider?.model ? { model: spawnProvider.model, ...(spawnProvider.connectionId ? { connectionId: spawnProvider.connectionId } : {}) } : {}),
    ...(worktree ? { worktree: worktree.branch } : {}),
    activeRuns: agentPool.activeCount,
    queuedRuns: agentPool.queue.length,
    note: `Queued as subagent ${alias} with full tools (pool: ${agentPool.activeCount}/${agentPool.cap} slots busy, ${agentPool.queue.length} queued â€” queued spawns start only when a slot frees, so spawn only as many workers as you use in parallel). It starts on its own tab and can observe any other open tab by tabId (browser_tabs lists them). Findings are delivered here automatically when each of its tasks finishes â€” never poll subagent_list. After finishing it stays resident with its tab and conversation: assign follow-ups with agent_message to '${alias}', close with subagent_close when done.`
  };
}

// LORDE_RESIDENT_SUBAGENTS_V365 â€” findings delivery for ANY run of a resident
// subagent (first task and every follow-up assignment). A subagent closed by
// request mid-run reports nothing. The spawned task text is deliberately NOT
// echoed â€” the parent wrote it.
function deliverSubagentFindings(record, status, summary, error) {
  if (!record || record.status === 'closed') return;
  touchSubagentRecord(record);
  const alias = record.alias;
  const findingsText = [
    `Subagent ${alias} â€” ${status}.`,
    summary ? `Findings:\n\n${String(summary).slice(0, 6000)}` : `No findings were produced.${error ? `\n\nFailure: ${String(error).slice(0, 600)}` : ''}`
  ].join('\n\n');
  const parent = spawnRunContext(record.parentRunId);
  const parentInstance = parent?.instance
    ? liveAgentInstances().find((candidate) => candidate === parent.instance) || null
    : null;
  if (parentInstance) {
    const delivered = parentInstance.receiveAgentMessage({ from: record.spawnId, fromLabel: `subagent ${alias}`, text: findingsText, reply: false });
    if (delivered?.delivered === true) return;
    // An idle primary can still report the findings: its coordination run
    // exists precisely for messages that arrive between turns.
    if (parentInstance === desktopChatAgent) {
      const started = startPrimaryChatForMessage({ from: record.spawnId, fromLabel: `subagent ${alias}`, text: findingsText, reply: false });
      if (started?.started === true) return;
    }
  }
  addConsoleEntry({ kind: 'agent', level: status === 'failed' ? 'error' : 'info', message: `Subagent ${alias} findings could not reach the spawning conversation: ${findingsText.slice(0, 300)}` });
}

// A resident subagent receives a new assignment from its spawning agent: the
// message becomes the run's objective on the SAME conversation (history,
// plan, and learned context carry over), so the worker accumulates knowledge
// across assignments instead of restarting cold.
function startSubagentFollowUp(record, message) {
  const instance = record?.instance;
  if (!instance) return { started: false, note: 'The subagent instance is no longer available.' };
  const alias = record.alias;
  const assignment = String(message?.text || '').slice(0, 4000);
  if (!assignment) return { started: false, note: 'The message body was empty; nothing was assigned.' };
  const current = instance.state?.();
  if (current?.status === 'awaiting_recovery') {
    void instance.resumeAfterRecovery?.(message).catch((error) => addConsoleEntry({ kind: 'agent', level: 'error', message: `Subagent ${alias} recovery resume failed: ${String(error?.message || error)}` }));
    return { started: true, resumed: true, note: `Subagent ${alias} resumed its preserved run with the message.` };
  }
  if (current && ['running', 'awaiting_approval', 'paused'].includes(current.status)) return { started: false, note: `Subagent ${alias} is already running; the message was queued for its next decision.` };
  const followUpMessage = { from: record.parentRunId || 'parent', fromLabel: String(message?.fromLabel || 'your spawning agent').slice(0, 120), text: assignment, reply: false };
  const startRequest = {
    task: assignment,
    continuation: true,
    agentIdentity: alias,
    ...(record.provider ? { provider: { ...record.provider } } : {}),
    ...(record.tabId ? { tabId: String(record.tabId) } : {}),
    settings: { ...(record.settings || {}), approvalMode: 'unattended' },
    initialAgentMessages: [followUpMessage]
  };
  const finish = (result, failed) => {
    record.status = 'resident';
    record.runId = result?.id || record.runId;
    touchSubagentRecord(record);
    const failure = failed ? String(result?.message || 'the follow-up run failed').slice(0, 600) : '';
    const summary = failed ? '' : (result?.result?.summary || result?.summary || '');
    if (!failed && summary) record.findings = String(summary).slice(0, 2000);
    const status = failed ? 'failed' : (result?.status || 'completed');
    broadcastAgentEvent({ type: 'spawn.finished', spawnId: record.spawnId, alias, task: assignment, status, ...(failed ? { error: failure } : { summary }), runId: record.runId, parentRunId: record.parentRunId, followUp: true });
    deliverSubagentFindings(record, status, summary, failed ? failure : null);
    publishState();
  };
  const track = (completion) => {
    record.status = 'running';
    record.runId = instance.state()?.id || record.runId;
    touchSubagentRecord(record);
    publishState();
    void completion.then((result) => finish(result, false), (error) => finish(error, true));
  };
  try {
    track(instance.start(startRequest));
    return { started: true, runId: record.runId, note: `New assignment started on resident subagent ${alias}: it continues its SAME conversation with full context and reports findings back when done.` };
  } catch (continuationError) {
    // A continuation fails when the prior run never reached a restorable
    // state. The resident stays useful: retry as a fresh conversation under
    // the same alias and tab rather than leaving a dead worker.
    try {
      track(instance.start({ ...startRequest, continuation: false, initialAgentMessages: [{ ...followUpMessage, text: `${assignment}\n\n(Your previous conversation could not be restored; this assignment starts fresh.)` }] }));
      return { started: true, runId: record.runId, note: `Subagent ${alias} took the assignment on a fresh conversation (its prior conversation could not be restored).` };
    } catch (error) {
      record.status = 'resident';
      return { started: false, note: `Could not start the follow-up on subagent ${alias}: ${String(error?.message || error).slice(0, 240)}` };
    }
  }
}

// LORDE_RESIDENT_SUBAGENTS_V365 â€” the worker-management API every agent gets
// through its run: inspect the roster, close workers explicitly.
const subagentApi = {
  list() {
    // LORDE_MULTITASK_ECONOMY_V365 â€” the field transcript showed the parent
    // calling subagent_list 25+ times, each listing ~140 lines of roster
    // flooding its context and slowing every decision. Compact rows only:
    // alias, status, short task, latest findings. Progress arrives as
    // automatic notifications, so polling is pure waste.
    const subagents = [...spawnRegistry.values()].filter(record => record.status !== 'closed').map(record => ({
      alias: record.alias,
      status: record.status,
      parentRunId: record.parentRunId || null,
      task: String(record.task || '').slice(0, 60),
      ...(record.provider?.model ? { model: record.provider.model } : {}),
      ...(record.worktree ? { worktreeBranch: record.worktree.branch } : {}),
      ...(record.findings ? { findings: String(record.findings).slice(0, 200) } : {})
    }));
    return { subagents, note: subagents.length ? 'Compact roster. You are notified here automatically when a subagent finishes â€” do NOT poll this list. Message an alias only to assign follow-up work or request a report; subagent_close when done.' : 'No subagents exist yet; spawn one with task_spawn.' };
  },
  async close(alias, reason = 'manual') {
    const wanted = normalizedAgentRecipient(alias);
    if (!wanted) return { closed: false, note: 'subagent_close requires the alias of the subagent to close (subagent_list shows the roster).' };
    const record = [...spawnRegistry.values()].reverse().find(candidate => normalizedAgentRecipient(candidate.alias) === wanted && candidate.status !== 'closed');
    if (!record) return { closed: false, note: `No subagent named '${String(alias || '').trim()}' exists. subagent_list shows the current roster.` };
    // Cancel an active run first; the tracked spawn settles as closed.
    if (record.status === 'running' && record.runId && agentPool) {
      try { agentPool.cancelRun(String(record.runId)); } catch { /* already terminal */ }
    }
    if (record.runId && agentPool?.retained?.has(String(record.runId))) {
      try { await agentPool.closeRetained(String(record.runId)); } catch { /* best effort */ }
    }
    record.status = 'closed';
    record.instance = null;
    // LORDE_SUBAGENT_WORKTREES_V365 â€” an untouched worktree is removed; a
    // dirty one is kept with its branch so no committed or uncommitted work
    // is ever destroyed by a close.
    const worktreeOutcome = await removeSubagentWorktree(record.worktree);
    record.worktree = worktreeOutcome.dirty ? record.worktree : null;
    addConsoleEntry({ kind: 'agent', level: 'info', message: `${reason === 'idle' ? `Subagent ${record.alias} was idle for 20 minutes and was closed automatically` : `Subagent ${record.alias} was closed by its spawning agent`}; its tab was released.${worktreeOutcome.dirty ? ` Its worktree survives on branch ${worktreeOutcome.branch} (${worktreeOutcome.path}).` : ''}` });
    broadcastAgentEvent({ type: 'spawn.closed', spawnId: record.spawnId, alias: record.alias, parentRunId: record.parentRunId, reason, ...(worktreeOutcome.dirty ? { worktreeBranch: worktreeOutcome.branch } : {}) });
    publishState();
    return { closed: true, alias: record.alias, ...(worktreeOutcome.dirty ? { worktreeBranch: worktreeOutcome.branch } : {}), note: `Subagent ${record.alias} is closed â€” its tab is released and it will no longer receive tasks or messages.${worktreeOutcome.dirty ? ` Its dirty worktree was kept on branch ${worktreeOutcome.branch} (${worktreeOutcome.path}); merge or discard it explicitly.` : ''}` };
  }
};

// LORDE_IDLE_SWEEPS_V366 â€” two pieces of automatic hygiene, swept every 60s:
// (1) a resident subagent with no activity for 20 minutes is closed through
// the SAME path as an explicit subagent_close (active run cancelled, tab
// released, worktree rules respected) and broadcasts spawn.closed with a
// reason; (2) an about:blank tab that is not the user's selected tab and not
// owned by any live or resident agent run / chat window is closed after 3
// minutes. Activity is touched on spawn start, run terminal/follow-up finish,
// findings delivery, user subagent-message IPC, and hub message deliveries.
const SUBAGENT_IDLE_CLOSE_MS = 20 * 60 * 1000;
const EMPTY_TAB_IDLE_CLOSE_MS = 3 * 60 * 1000;
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
let idleSweepTimer = null;
function touchSubagentRecord(record) {
  if (record && record.status !== 'closed') record.lastActivityAt = Date.now();
}
function agentOwnedTabIds() {
  const owned = new Set();
  for (const record of spawnRegistry.values()) {
    if (record.tabId) owned.add(String(record.tabId));
  }
  if (agentPool) {
    for (const entry of agentPool.entries.values()) if (entry.tabId) owned.add(String(entry.tabId));
    for (const entry of agentPool.retained.values()) if (entry.tabId) owned.add(String(entry.tabId));
  }
  for (const entry of chatAgentWindows.values()) {
    for (const tabId of entry.tabIds || []) owned.add(String(tabId));
  }
  return owned;
}
function sweepIdleAgentsAndTabs() {
  const now = Date.now();
  let changed = false;
  // (1) Idle residents close through the same subagentApi.close path as an
  // explicit subagent_close: active run cancelled, tab released, worktree
  // rules respected, spawn.closed broadcast with a reason.
  for (const alias of computeIdleSubagentCloses(spawnRegistry, { now, idleMs: SUBAGENT_IDLE_CLOSE_MS })) {
    void subagentApi.close(alias, 'idle').catch(() => { /* best effort */ });
    changed = true;
  }
  // (2) Idle empty tabs: not the user's selected tab, not owned by any live
  // or resident agent run / chat window entry.
  const dueTabs = computeIdleEmptyTabCloses(tabs, {
    owned: agentOwnedTabIds(),
    selectedTabId,
    now,
    idleMs: EMPTY_TAB_IDLE_CLOSE_MS,
    isTabAlive: (tab) => { try { return !tab.webContents?.isDestroyed?.(); } catch { return false; } },
    isTabEmpty: (tab) => {
      try {
        const url = String(tab.webContents?.getURL?.() || '');
        return !url || url === 'about:blank' || isHomeUrl(url);
      } catch { return false; }
    }
  });
  for (const tabId of dueTabs) {
    addConsoleEntry({ kind: 'navigation', level: 'info', message: `Closed idle empty tab (${tabId}) â€” about:blank with no agent owner for 3 minutes.` });
    try { closeTab(tabId); changed = true; } catch { /* best effort */ }
  }
  if (changed) publishState();
}
function startIdleSweeps() {
  if (idleSweepTimer) return;
  idleSweepTimer = setInterval(sweepIdleAgentsAndTabs, IDLE_SWEEP_INTERVAL_MS);
  idleSweepTimer.unref?.();
}
startIdleSweeps();

function getHcuSession() {
  if (!hcuSession) hcuSession = new HcuSession();
  return hcuSession;
}

function getHcuApi() {
  const session = getHcuSession();
  return {
    ensure: () => session.ensure(),
    tools: () => session.tools(),
    status: () => session.status(),
    execute: async (name, input, owner, options = {}) => {
      const signal = options.signal || null;
      await desktopLease.acquire(owner, signal);
      try { return await session.execute(name, input, options); }
      finally { desktopLease.release(owner); }
    }
  };
}

function getComputerTools() {
  if (!computerTools) {
    const { ComputerTools } = require('./computer/computerTools.cjs');
    computerTools = new ComputerTools({
      terminal: terminalManager,
      clipboard,
      capture: getDesktopCapture(),
      androidManager: androidDeviceManager,
      androidSurface: () => {
        if (!androidStreamWindow?.embedded || !androidStreamWindow.serial) return null;
        const bounds = androidStreamWindow.bounds || androidStreamBounds;
        return bounds ? { serial: androidStreamWindow.serial, width: bounds.width, height: bounds.height, deviceWidth: 1080, deviceHeight: 1920 } : { serial: androidStreamWindow.serial };
      }
    });
  }
  return computerTools;
}
// One shared DesktopCapture: its constructor registers IPC handlers, so a
// second instance would throw. Record & Learn reuses this same instance for
// selective evidence screenshots.
let sharedDesktopCapture = null;
function getDesktopCapture() {
  if (!sharedDesktopCapture) sharedDesktopCapture = new (require('./computer/desktopCapture.cjs').DesktopCapture)({ ...require('electron'), getBrowserWindow: () => mainWindow, getTab: (tabId) => tabs.get(String(tabId)) || null, onStateChange: () => publishState() });
  return sharedDesktopCapture;
}
function computerCleanup(promise) {
  promise?.catch(error => addConsoleEntry({ kind: 'computer', level: 'error', message: error.message }));
}

// One DesktopChatAgent per active run. Every instance shares the SAME
// BrowserViewController (per-tabId state keeps distinct tabs independent) and
// the same provider/checkpoint plumbing; only the native-tools lease and the
// emit destination differ. See desktop/agent/agentPool.cjs.

// Contained background research (desktop/research/researchPipeline_flow_chat.md):
// one shared MetaSearch instance so engine rate limits and health persist
// across runs. BROWSER_USE_RESEARCH=off disables the pipeline entirely; the
// composition root keeps it out of tests unless they inject their own runner.
const researchEnabled = process.env.BROWSER_USE_RESEARCH !== 'off';
let researchMetaSearch = null;
if (researchEnabled) {
  const { MetaSearch } = require('./research/metaSearch.cjs');
  researchMetaSearch = new MetaSearch();
}

// Durable cross-run knowledge (desktop/knowledge/knowledgeStore_flow_chat.md):
// created lazily on first agent construction, backed by userData/knowledge.json.
let sharedKnowledgeStore = null;
function getKnowledgeStore() {
  if (!sharedKnowledgeStore) {
    const { KnowledgeStore } = require('./knowledge/knowledgeStore.cjs');
    sharedKnowledgeStore = new KnowledgeStore({ file: path.join(app.getPath('userData'), 'knowledge.json') });
  }
  return sharedKnowledgeStore;
}

function createChatAgent({ computerTools: injectedTools = null, targetWindow = null, targetChatId = '' } = {}) {
  return new DesktopChatAgent({
    controller: browserViewController,
    // LORDE_AI_CHAT_TITLES_V1 — the agent asks for a short conversation name
    // as the chat evolves. One tiny non-streaming completion against the
    // ACTIVE provider; ollama's native /api/chat is the fallback when the
    // endpoint does not speak the OpenAI-compatible /chat/completions route.
    titleApi: async ({ connectionId = '', provider = 'ollama', model = '', prompt = '' } = {}) => {
      if (!prompt) throw new Error('Title prompt is empty.');
      const isOllama = String(provider || 'ollama') === 'ollama';
      const connection = connectionId ? connectionById(connectionId) : null;
      const base = String(connection?.baseUrl || (isOllama ? settings.aiChatBaseUrl : '') || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const key = connection ? (credentialStore?.get(connectionCredentialKey(connection.id)) || '') : '';
      const headers = { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) };
      const body = JSON.stringify({ model: model || connection?.model || settings.aiChatModel || '', messages: [{ role: 'user', content: prompt }], max_tokens: 32, temperature: 0.3, stream: false });
      const extract = (payload) => String(payload?.choices?.[0]?.message?.content ?? payload?.message?.content ?? '').trim();
      try {
        const response = await fetchWithBoundedRetry(`${base}/chat/completions`, { method: 'POST', headers, body }, { attempts: 1, timeoutMs: 15000 });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = extract(await response.json());
        if (!text) throw new Error('Empty title response.');
        return text;
      } catch (error) {
        if (!isOllama) throw error;
        // Ollama native route: POST /api/chat {model, messages, stream:false}.
        const response = await fetchWithBoundedRetry(`${base}/api/chat`, {
          method: 'POST', headers,
          body: JSON.stringify({ model: model || settings.aiChatModel || '', messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 32, temperature: 0.3 } })
        }, { attempts: 1, timeoutMs: 15000 });
        if (!response.ok) throw new Error(`Title request failed (${response.status}).`);
        const text = extract(await response.json());
        if (!text) throw new Error('Empty title response.');
        return text;
      }
    },
    modelTaskApi: (input) => runMediaTaskForConnection(input || {}),
    hcuApi: getHcuApi(),
    androidApi: {
      execute: async (name, input = {}) => {
        if (!androidDeviceManager) throw new Error('Android device manager is unavailable.');
        if (name === 'android_devices') {
          switch (String(input.action || 'list')) {
            case 'list': case 'refresh': return input.action === 'refresh' ? androidDeviceManager.refresh() : androidDeviceManager.snapshot();
            case 'pair': return androidDeviceManager.pair(input);
            case 'connect': return androidDeviceManager.connect(input);
            case 'disconnect': return androidDeviceManager.disconnect(input.serial);
            case 'remove': return androidDeviceManager.remove(input.serial);
            case 'select': return androidDeviceManager.select(input.serial);
            case 'programmatic-input': return androidDeviceManager.setProgrammaticTaps(input.serial, input.enabled);
            case 'stream-start': return androidDeviceManager.startStream(input);
            case 'stream-stop': return androidDeviceManager.stopStream(input.serial);
            default: throw new Error(`Unknown android_devices action: ${input.action}`);
          }
        }
        if (name === 'android_adb') return Array.isArray(input.commands) ? androidDeviceManager.batchCommand(input) : androidDeviceManager.command(input);
        throw new Error(`Unknown Android tool: ${name}`);
      }
    },
    // MODEL CATALOG (agent tool `model_catalog`): LIVE discovery per
    // connection, but TWO response modes â€” the 43KB full blob forced the
    // model to page through read_agent_result for EVERY question. Without
    // filters: a compact SUMMARY (facet counts + price/context extremes)
    // that answers "how many / which capabilities" instantly. With filters:
    // only the MATCHING models ride the wire.
    catalogApi: async (input = {}) => {
      const hostOf = (url) => { try { return new URL(url).host; } catch { return String(url || ''); } };
      const discover = async (connection) => {
        const key = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
        if (!key) return { discoveredRaw: [], liveError: 'no API key configured' };
        try {
          const response = await fetchWithBoundedRetry(`${String(connection.baseUrl || '').replace(/\/$/, '')}/models`, {
            headers: { accept: 'application/json', authorization: `Bearer ${key}` }
          }, { attempts: 1, timeoutMs: 6000 });
          if (!response.ok) return { discoveredRaw: [], liveError: `HTTP ${response.status}` };
          const payload = await response.json();
          const discoveredRaw = (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
            .filter((entry) => entry && typeof entry === 'object' && String(entry.id || entry.name || entry.model || '').trim())
            .map((entry) => ({ ...entry, id: String(entry.id || entry.name || entry.model || '').trim() }));
          return { discoveredRaw };
        } catch (error) {
          return { discoveredRaw: [], liveError: String(error?.message || error).slice(0, 120) };
        }
      };
      const connections = normalizedConnections();
      const rows = await Promise.all(connections.map(async (connection) => {
        const custom = (Array.isArray(connection.customModels) ? connection.customModels : [])
          .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
          .filter(Boolean);
        const { discoveredRaw, liveError } = await discover(connection);
        const byId = new Map();
        for (const entry of discoveredRaw) byId.set(entry.id, entry);
        const savedOnly = [];
        for (const id of [connection.model, ...custom.map((entry) => entry.id)].filter(Boolean)) {
          if (!byId.has(id)) { byId.set(id, { id }); savedOnly.push(id); }
        }
        const kindOf = (id) => (custom.find((entry) => entry.id === id) || {}).kind || inferModelKind(id);
        const models = [...byId.values()]
          .map((entry) => compactModelEntry(entry, kindOf(entry.id)))
          .filter(Boolean)
          .slice(0, 400);
        return {
          id: connection.id,
          provider: connection.provider,
          baseUrlHost: hostOf(connection.baseUrl),
          selectedModel: connection.model || '',
          modelsCount: models.length,
          models,
          savedOnlyCount: savedOnly.length,
          hasApiKey: Boolean(credentialStore?.get(connectionCredentialKey(connection.id))),
          isActive: connection.id === settings.aiChatConnectionId,
          ...(liveError
            ? { liveCatalog: `saved models only â€” live discovery failed (${liveError})` }
            : { liveCatalog: `${discoveredRaw.length} models discovered live from /models` })
        };
      }));
      const request = input && typeof input === 'object' ? input : {};
      // LIVE CAPABILITY PROBING (deliberate, narrow, provider-generic): the
      // capability-resolution ladder is knowledge â†’ web_search â†’ probe. The
      // probe runs ONLY when the agent explicitly passes probe:true AND has
      // narrowed the catalog with other filters â€” a handful of tiny requests
      // (max_tokens 1) against those models through the connection's OWN
      // endpoint, never a catalog-wide sweep. Conclusive positives merge into
      // caps and the filter re-runs; inconclusive probes stay unknown.
      let probeStats = null;
      if (request.probe && String(request.cap || '').trim() && normalizedConnections().length) {
        const capWanted = String(request.cap).trim().toLowerCase();
        const modality = capWanted === 'video-input' ? 'video' : (capWanted === 'vision' || capWanted === 'image-input' ? 'image' : null);
        if (modality) {
          const connection = (String(request.connectionId || '').trim() && normalizedConnections().find((item) => item.id === String(request.connectionId).trim()))
            || normalizedConnections().find((item) => item.id === settings.aiChatConnectionId)
            || normalizedConnections()[0];
          const apiKey = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
          if (apiKey && connection.baseUrl) {
            const candidates = rows.flatMap((row) => row.models.map((model) => ({ ...model, _connectionId: row.id })))
              .filter((model) => model._connectionId === connection.id)
              .filter((model) => !String(request.search || '').trim() || model.id.toLowerCase().includes(String(request.search).trim().toLowerCase()) || String(model.name || '').toLowerCase().includes(String(request.search).trim().toLowerCase()))
              .sort((a, b) => (a.usdPerM?.[0] ?? Infinity) - (b.usdPerM?.[0] ?? Infinity))
              .slice(0, 24);
            if (!global.__modelProbeCache) global.__modelProbeCache = loadProbeCache(path.join(app.getPath('userData'), 'model-capability-probes.json'));
            const probeOutcome = await probeModelsForCapability({
              models: candidates.map((model) => model.id),
              baseUrl: connection.baseUrl,
              apiKey,
              modality,
              cache: global.__modelProbeCache,
              cachePath: path.join(app.getPath('userData'), 'model-capability-probes.json')
            });
            for (const row of rows) {
              for (const model of row.models) {
                const outcome = probeOutcome.results[model.id];
                if (outcome?.conclusive && outcome.supported) {
                  model.caps = [...new Set([...(model.caps || []), capWanted])].sort();
                  model.capsSource = 'live-probe';
                }
              }
            }
            probeStats = { probed: probeOutcome.probed, deferred: probeOutcome.deferred, cap: capWanted, modality };
          }
        }
      }
      return catalogResponse({
        activeConnectionId: settings.aiChatConnectionId || '',
        cloud: { model: settings.browserUseCloudModel || '', configured: Boolean(credentialStore?.get('browserUseCloudApiKey')) },
        ollama: { baseUrl: settings.aiChatBaseUrl || '', model: settings.aiChatModel || '' },
        ...(probeStats ? { probe: probeStats } : {})
      }, rows, request);
    },
    // Production default: the REAL research subagent (LLM tool loop with its
    // own browser tab), falling back to the deterministic pipeline. Tests and
    // un-wired builds get the deterministic runner unless they inject one.
    researchRunner: researchEnabled ? defaultResearchAgent : null,
    researchMetaSearch,
    knowledgeStore: getKnowledgeStore(),
    // Jev credentials stay in Electron secure storage; never put the key in
    // run.settings, provider snapshots, IPC events, or persisted history.
    jevVerifierFactory: (opts) => require('./agent/jevProvider.cjs').createJevVerifier({
      ...opts,
      apiKey: credentialStore?.get('systemOneJevApiKey') || ''
    }),
    getComputerTools: injectedTools ? () => injectedTools : () => getLeasedComputerTools(),
    getControlMode: () => normalizeControlMode(settings.agentControlMode),
    getSelectedTabId: () => selectedTabId,
    // Agent-created/targeted tabs are background workspaces. Human UI selection
    // and the gated focusTab callback (sole tab owner only) are the only routes
    // through showTab(); plain background work never steals focus.
    createTab: async (url) => {
      const tab = createTab(url || '', false);
      await waitForTabReady(tab, url || '');
      return tabSummary(tab);
    },
    closeTab: (tabId) => {
      const id = String(tabId || '');
      const closed = closeTab(id);
      for (const entry of chatAgentWindows.values()) entry.tabIds?.delete(id);
      return closed;
    },
    selectTab: async (tabId) => {
      const tab = tabs.get(String(tabId));
      if (!tab || tab.webContents.isDestroyed()) throw new Error(`Tab ${tabId} is no longer available.`);
      return tabSummary(tab);
    },
    // The ONLY agent route to showTab(): brings a tab to the foreground as the
    // visible active tab. Gated: refused while any other live agent owns tabs,
    // so an agent can switch the human's view only when it is the sole owner.
    focusTab: async (tabId, runId) => {
      const { foregroundTabPermission, foregroundTabBlockReason } = require('./agent/tabFocusPolicy.cjs');
      const permission = foregroundTabPermission(liveAgentInstances(), runId);
      if (!permission.allowed) throw new Error(foregroundTabBlockReason(permission));
      const id = String(tabId || '');
      const tab = tabs.get(id);
      if (!tab || tab.webContents.isDestroyed()) throw new Error(`Tab ${id} is no longer available.`);
      if (!showTab(id)) throw new Error(`Tab ${id} could not be brought to the foreground.`);
      return tabSummary(tab);
    },
    writeReportFile,
    createResultStore: id => new (require('./agent/agentResultStore.cjs').AgentResultStore)(path.join(app.getPath('userData'), 'agent-results'), id),
    // GEN9: per-run notebook files live under userData/notebooks â€” one
    // markdown file per conversation, editable from the /notebook popup.
    notebookDir: path.join(app.getPath('userData'), 'notebooks'),
    scheduleApi: (input) => scheduler ? scheduler.manage(input) : Promise.reject(new Error('Scheduling is unavailable while the bridge is stopped.')),
    spawnTask: spawnBackgroundTask,
    messageApi: agentMessageHub,
    subagentApi,
    emit: (event) => {
      const chatEntry = targetChatId ? chatAgentWindows.get(String(targetChatId)) : null;
      const chatSurface = chatEntry?.pinned && chatEntry.dockView ? chatEntry.dockView : chatEntry?.window;
      const eventTargets = chatEntry
        ? [chatSurface]
        : [targetWindow && !targetWindow.isDestroyed() ? targetWindow : mainWindow,
           // The floating Chat 1 window mirrors the primary agent's live feed.
           ...(targetChatId ? [] : primaryChatWindow && !primaryChatWindow.isDestroyed() ? [primaryChatWindow] : [])];
      const sentContents = new Set();
      for (const eventTarget of eventTargets) {
        const contents = eventTarget?.webContents;
        if (!contents || contents.isDestroyed?.() || sentContents.has(contents)) continue;
        sentContents.add(contents);
        safeIpcSend(contents, 'browser-use:agent-event', event);
      }
      // Record & Learn taps: tool usage and run outcomes feed the recorder and
      // reinforce the skills a successful run relied on.
      if (event.type === 'tool.result' && event.run?.task) {
        recorder?.tapToolCall?.({ tool: event.tool || event.call?.name || '', summary: String(event.output?.summary || event.output?.error || '').slice(0, 100) });
      }
      // Per-decision phase breakdown: separates genuine provider latency
      // (time-to-first-token, generation) from programmatic latency (capture).
      if (event.type === 'decision.timing') {
        const seconds = (ms) => (ms == null ? ',' : ms < 1_000 ? `${ms}ms` : `${(ms / 1_000).toFixed(1)}s`);
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[Timing] observe ${seconds(event.observeMs)} Â· first token ${seconds(event.connectMs)} Â· generation ${seconds(event.streamMs)} Â· decision total ${seconds(event.totalMs)}` });
      }
      // Fast path: a decided non-destructive action executed while the model
      // was still generating. Visible in the console so the acceleration is
      // observable, never silent.
      if (event.type === 'agent.fastpath') {
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[FastPath] executed ${event.tool || 'action'} immediately â€” the model had already decided it.` });
      }
      // Laya engagement, per verify: brain, latency, and the typed answers.
      if (event.type === 'laya.verification') {
        const answers = Object.entries(event.answers || {})
          .map(([name, answer]) => `${name}=${answer.value} (${answer.confidence})`)
          .join(' Â· ') || 'nothing above the confidence gate';
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[System One] ${event.layer || 'laya'} / ${event.brain || 'bundled'} ${event.tookMs ?? '?'}ms, ${answers}` });
      }
      // Program Control skill: research starts or the brain cache answers.
      // Program Control skill: the brain cache answers instantly; an unknown
      // program only HINTS, the model decides whether to spend research.
      if (event.type === 'program.research.hinted') {
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[Brain] ${event.program} is not in the knowledge cache, the model may research it via research_task.` });
      }
      if (event.type === 'program.research.started') {
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[Brain] researching ${event.program} (official docs, user manual, tutorials, forums), findings feed this run and the knowledge cache.` });
      }
      if (event.type === 'program.research.cached') {
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[Brain] ${event.program} is already learnt, recalling from cache instead of researching.` });
      }
      // Background research needs the human only when a search engine shows a
      // verification challenge; the search itself waits and resumes.
      if (event.type === 'research.notice') {
        addConsoleEntry({ kind: 'agent', level: 'warn', message: `[Research] ${event.message || ''}` });
      }
      // Cross-session coordination traffic, visible in the console so the
      // human sees sessions negotiating.
      if (event.type === 'agent.message') {
        addConsoleEntry({ kind: 'agent', level: 'info', message: `[Agent message] ${event.reply ? 'reply from' : 'message from'} "${String(event.fromLabel || 'another session').slice(0, 60)}": ${String(event.text || '').slice(0, 140)}` });
      }
      if (event.type === 'run.completed' && event.run?.success === true && Array.isArray(event.run?.usedSkills)) {
        for (const skillId of event.run.usedSkills) { try { mergedSkillsApi().feedback(skillId, { success: true, note: null }); } catch { /* reinforcement is best-effort */ } }
      }
      // A run-level desktop lease is acquired on the first mutating native
      // call. Terminal PTY capability remains conversation-owned across
      // successful turns; agentOwnerActive releases only the panel write lock.
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type) && event.run?.computerOwner) {
        desktopLease.release(event.run.computerOwner);
        // Keep the conversation-to-PTY mapping so the next continuation can
        // read and drive the same interactive process. The inactive run makes
        // the panel writable until another continuation starts.
        if (computerTools?.retainedAgentSessions(event.run.computerOwner)) publishState();
      }
      if (['run.started', 'run.completed', 'run.failed', 'run.cancelled', 'approval.required', 'approval.resolved', 'plan.updated', 'user.input.required', 'user.input.received'].includes(event.type)) {
        // A handed-off live session reached a terminal state: drop it from the
        // registry so the sessions list stays live-only.
        if (event.type !== 'run.started' && event.run?.id && chatSessions.has(String(event.run.id))) {
          chatSessions.delete(String(event.run.id));
        }
        publishState();
      }
    },
    createProvider: (providerConfig) => {
      if (providerConfig?.model) lastRunProviderConfig = providerConfig;
      // Laya standalone mode (provider disable): the local System One sidecar
      // IS the planner. Loud failures, no silent degrade when it is the boss.
      if (providerConfig?.id === 'laya') {
        const { createLayaProvider } = require('./agent/layaProvider.cjs');
        // System One brain: Jev plans through the typed decision API when the
        // user selected it AND a key is securely configured; otherwise the
        // bundled engine answers. The key never leaves this closure.
        const jevKey = settings.layaBrain === 'jev' ? (credentialStore?.get(JEV_CREDENTIAL_KEY) || '') : '';
        const predictBrain = jevKey
          ? require('./agent/jevProvider.cjs').createJevPredictor({ baseUrl: settings.jevBaseUrl, modelId: settings.jevModelId, apiKey: jevKey })
          : null;
        return createLayaProvider({ endpoint: providerConfig.endpoint || settings.layaEndpoint, predictBrain });
      }
      return createAgentProvider(providerConfig);
    },
    // Built per call so a /cd repo pin and newly installed skills apply to the
    // next search without restarting. The run-start digest and skill_search both
    // need entry.skill + digest(), which the old inline literal never provided.
    skillsApi: {
      search: (input) => mergedSkillsApi().search(input),
      run: (skillId) => mergedSkillsApi().run(skillId),
      feedback: (skillId, outcome) => mergedSkillsApi().feedback(skillId, outcome),
      digest: (entry) => mergedSkillsApi().digest(entry)
    },
    onTerminal: () => computerCleanup(chatHistoryStore?.flush()),
    onCheckpoint: (run) => chatHistoryStore?.checkpoint({
      id: run.id,
      title: run.title || run.task,
      // The turn text and turn clock must survive checkpoints: a continuation
      // restored without `task` could not classify turn boundaries, so the
      // pinned objective and TURN BOUNDARY notice went stale (the model
      // resurrected a task fixed turns earlier instead of the newest message).
      task: run.task,
      turnStartedAt: run.turnStartedAt,
      provider: run.provider?.id,
      model: run.provider?.model,
      providerConfig: run.provider,
      target: run.lastObservedUrl,
      observationDomain: run.observationDomain,
      status: run.status,
      summary: run.result?.summary || run.result?.error || '',
      success: run.result?.success === true,
      verified: run.result?.verified === true,
      reason: run.result?.reason || '',
      createdAt: run.createdAt || Date.now(),
      updatedAt: run.completedAt || Date.now(),
      messages: run.messages,
      pendingUserMessages: run.pendingUserMessages,
      providerLedger: run.providerLedger,
      plan: run.plan,
      goals: run.goals,
      settings: run.settings,
      eventRevision: run.eventRevision,
      attemptId: run.attemptId,
      attemptSequence: run.attemptSequence,
      workingMemory: run.workingMemory,
      flowControl: run.flowControl,
      thinkingArchive: Array.isArray(run.thinkingArchive) ? run.thinkingArchive : [],
      // Native-surface awareness ledger (window ids already announced) must
      // survive checkpoints too: a continuation restored from disk re-seeds its
      // native baseline from the live window list when this is missing, and a
      // dialog that was open but never announced gets silently swallowed.
      nativeSurfaceSeen: Array.isArray(run.nativeSurfaceSeen) ? run.nativeSurfaceSeen : [],
      completedWork: run.coordinator?.completedWork,
      transcript: run.history?.map((entry) => ({
        at: entry.at,
        step: entry.step,
        tool: entry.tool,
        callId: entry.callId,
        input: entry.input,
        expect: entry.expect,
        repeat: entry.repeat === true,
        ...(entry.media ? { media: entry.media } : {}),
        output: entry.output
      })) || []
    })
  });
}

function createAgentProvider(provider) {
  if (provider?.id === 'cloud') {
    return createCloudProvider({
      apiKey: credentialStore?.get('browserUseCloudApiKey') || process.env.BROWSER_USE_API_KEY || '',
      model: provider?.model || settings.browserUseCloudModel
    });
  }
  if (PROVIDER_LABELS[provider?.id]) {
    const connection = connectionById(provider?.connectionId);
    const apiKey = provider?.apiKey || credentialStore?.get(connectionCredentialKey(provider?.connectionId)) || process.env.XKIRO_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || '';
    return createOpenAiCompatibleProvider({
      providerId: provider.id,
      baseUrl: provider?.baseUrl || connection?.baseUrl,
      model: provider?.model || connection?.model,
      apiKey,
      // VISION DELEGATE: a text-only run delegates image VIEWING to a
      // vision-capable model on the same connection instead of failing it.
      visionDelegate: createVisionDescriber({
        baseUrl: provider?.baseUrl || connection?.baseUrl,
        apiKey,
        excludeModel: provider?.model || connection?.model || ''
      })
    });
  }
  return createOllamaProvider({
    baseUrl: provider?.baseUrl || settings.aiChatBaseUrl,
    model: provider?.model || settings.aiChatModel
  });
}

const APP_CHROME_HEIGHT = 110;
const BROWSER_PARTITION = 'persist:browser-use-tabs-v2';
const AGENT_DRAWER_WIDTH = 500;
const MIN_AGENT_DRAWER_WIDTH = 320;
// LORDE_HOME_URL_V2 — the homepage is now a real hosted new-tab page on the
// studios domain (replaces the local homepage.html). It must stay hidden from
// the address bar and history exactly like the local file was; isHomeUrl()
// recognizes both so saved settings and already-open tabs keep working.
const HOME_URL = 'https://studios.lordemaximus.com/newtab';
const HOME_URL_LEGACY = `file://${path.join(__dirname, 'renderer', 'pages', 'homepage.html')}`;
function homeUrlWithVersion() {
  try {
    const url = new URL(HOME_URL);
    url.searchParams.set('browserUseVersion', app.getVersion());
    return url.toString();
  } catch { return HOME_URL; }
}
function isHomeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (raw.includes('homepage.html')) return true;
  try {
    const candidate = new URL(raw);
    const home = new URL(HOME_URL);
    return candidate.origin === home.origin && candidate.pathname === home.pathname;
  } catch { return false; }
}
const DEFAULT_URL = process.env.BROWSER_USE_START_URL
  || process.argv.slice(1).find(arg => /^https?:\/\//i.test(arg))
  || HOME_URL;
const SETTINGS_FILE = 'browser-use-settings.json';
const MIN_TERMINAL_HEIGHT = 120;
const MAX_TERMINAL_HEIGHT_RATIO = 0.75;
const SCREENSHOT_DIRECTORY = 'screenshots';
const REPORT_DIRECTORY = 'Browser-use Reports';
const DEFAULT_GPT_ACTION_PUBLIC_ORIGIN = process.env.BROWSER_USE_GPT_ACTION_PUBLIC_ORIGIN || 'https://gpt-browser.lordemaximus.com';
// V293: the desktop app OWNS 8790, the MCP endpoint MCP hosts (Claude Code)
// have configured from the start. The old Chrome CLI daemon no longer binds
// this port (the daemon watchdog now launches this app instead), so the
// desktop browser surface is what remote tool calls always reach. Tests can
// explicitly request port 0 for an isolated port.
const DEFAULT_DESKTOP_MCP_PORT = 8790;

function resolveDesktopMcpPort(value = process.env.BROWSER_USE_DESKTOP_MCP_PORT) {
  const raw = String(value ?? '').trim();
  if (!raw) return DEFAULT_DESKTOP_MCP_PORT;
  if (!/^\d+$/.test(raw)) throw new Error('BROWSER_USE_DESKTOP_MCP_PORT must be an integer from 0 through 65535.');
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('BROWSER_USE_DESKTOP_MCP_PORT must be an integer from 0 through 65535.');
  }
  return port;
}

async function writeReportFile({ filename, format, content }) {
  const directory = path.join(app.getPath('documents'), REPORT_DIRECTORY);
  await fs.promises.mkdir(directory, { recursive: true });
  const extension = format === 'html' ? '.html' : '.txt';
  const requested = String(filename || 'browser-use-report');
  const stem = path.basename(requested, path.extname(requested)).slice(0, 80) || 'browser-use-report';
  for (let copy = 0; copy < 1_000; copy += 1) {
    const suffix = copy === 0 ? '' : ` (${copy + 1})`;
    const targetPath = path.join(directory, `${stem}${suffix}${extension}`);
    try {
      await fs.promises.writeFile(targetPath, content, { encoding: 'utf8', flag: 'wx' });
      return { path: targetPath, filename: path.basename(targetPath), format, characters: content.length };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique report filename.');
}

function managedReportPath(value) {
  const directory = path.resolve(app.getPath('documents'), REPORT_DIRECTORY);
  const target = path.resolve(String(value || ''));
  if (!target.startsWith(`${directory}${path.sep}`)) throw new Error('Only reports created by Browser-use can be previewed.');
  return target;
}

function previewPayload(preview = activePreview) {
  if (!preview) return null;
  const { sourcePath, ...publicPreview } = preview;
  return publicPreview;
}

function liveOverlayWebContents() {
  try {
    const contents = overlayView?.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  } catch {
    return null;
  }
}

function chatWindowEntryForAgentId(value) {
  const key = String(value || '');
  if (!key) return null;
  const direct = chatAgentWindows.get(key);
  if (direct) return { id: key, entry: direct };
  for (const [id, entry] of chatAgentWindows) {
    const snapshot = entry.instance?.state?.();
    if (snapshot?.id === key || snapshot?.agentIdentity === key) return { id, entry };
  }
  return null;
}

function contextMenuWindowFor(contents) {
  if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) return mainWindow;
  if (overlayView?.webContents && !overlayView.webContents.isDestroyed() && contents === overlayView.webContents) return mainWindow;
  if (terminalDetachedWindow && !terminalDetachedWindow.isDestroyed() && contents === terminalDetachedWindow.webContents) return terminalDetachedWindow;
  for (const entry of chatAgentWindows.values()) {
    if (entry.window?.webContents === contents) return entry.window;
    if (entry.dockView?.webContents === contents) return mainWindow;
  }
  return null;
}

function contextMenuText(value) {
  return String(value || '').slice(0, 1_000_000);
}

function showDesktopContextMenu(event, request = {}) {
  const contents = event.sender;
  const ownerWindow = contextMenuWindowFor(contents);
  if (!ownerWindow) throw new Error('Context menus are available only in Browser-use Desktop surfaces.');

  const kind = String(request.kind || 'shell');
  const selection = contextMenuText(request.selection);
  let template;
  if (kind === 'terminal') {
    const terminalId = String(request.terminalId || '');
    const canPaste = Boolean(terminalId && terminalId === activeTerminalSessionId && terminalManager?.snapshot(terminalId));
    template = [
      { label: 'Copy', enabled: Boolean(selection), click: () => clipboard.writeText(selection) },
      {
        label: 'Paste', enabled: canPaste,
        click: () => {
          const text = clipboard.readText();
          if (text && terminalId === activeTerminalSessionId) void terminalManager?.paste(terminalId, text).catch(() => {});
        }
      },
      { label: 'Select all', click: () => contents.send('browser-use:terminal-select-all') }
    ];
  } else if (kind === 'tab') {
    if (contents !== mainWindow?.webContents) throw new Error('Tab context menus require the main window.');
    const tabId = String(request.tabId || '');
    const tab = tabs.get(tabId);
    if (!tab || tab.webContents.isDestroyed()) return false;
    template = [
      { label: 'New Tab', click: () => createTab('', true) },
      { label: 'Reload tab', click: () => tabs.get(tabId)?.webContents.reload() },
      { type: 'separator' },
      { label: 'Close tab', click: () => { if (tabs.has(tabId)) closeTab(tabId); } }
    ];
  } else if (kind === 'shell') {
    const editable = request.editable === true;
    template = [
      { label: 'Copy', enabled: Boolean(selection), click: () => clipboard.writeText(selection) },
      { label: 'Paste', enabled: editable, click: () => { if (editable) contents.paste(); } },
      { label: 'Select all', click: () => contents.selectAll() }
    ];
  } else if (kind === 'agent-launch') {
    const entries = [...chatAgentWindows.entries()];
    template = [
      { label: 'New AI agent', enabled: chatAgentWindows.size < CHAT_WINDOW_LIMIT, click: () => openIndependentChatWindow() },
      ...(entries.length ? [{ type: 'separator' }, { label: 'Instances', enabled: false }] : []),
      ...entries.map(([id, entry], index) => ({ label: entry.label || `Chat ${index + 2}`, submenu: [
        { label: entry.minimized || entry.window.isMinimized() ? 'Restore / maximize' : 'Minimize', click: () => setChatWindowMinimized(id, !(entry.minimized || entry.window.isMinimized())) },
        { label: 'Close agent', click: () => closeIndependentChatWindow(id) }
      ] }))
    ];
  } else if (kind === 'agent-header') {
    const requestedId = String(request.agentId || '');
    const fromSurface = chatWindowEntryForContents(contents);
    const resolved = fromSurface || chatWindowEntryForAgentId(requestedId);
    const agentId = resolved?.id || requestedId;
    const entry = resolved?.entry || null;
    const primary = !fromSurface && !entry;
    const unknownChat = Boolean(requestedId && !primary && !entry);
    template = [
      { label: 'New AI agent', enabled: chatAgentWindows.size < CHAT_WINDOW_LIMIT, click: () => openIndependentChatWindow() },
      { type: 'separator' },
      { label: 'Minimize', enabled: unknownChat ? false : primary ? activeDrawer === 'agent' : !(entry.minimized || entry.window.isMinimized()), click: () => primary ? setActiveDrawer(null) : setChatWindowMinimized(agentId, true) },
      { label: 'Restore / maximize', enabled: unknownChat ? false : primary ? activeDrawer !== 'agent' : Boolean(entry), click: () => primary ? setActiveDrawer('agent') : setChatWindowMinimized(agentId, false) },
      { label: 'Close agent', enabled: !unknownChat, click: () => primary ? setActiveDrawer(null) : closeIndependentChatWindow(agentId) }
    ];
  } else {
    throw new Error('Unknown Desktop context menu surface.');
  }
  Menu.buildFromTemplate(template).popup({ window: ownerWindow });
  return true;
}

function sendPreviewPayload() {
  liveOverlayWebContents()?.send('browser-use:preview', previewPayload());
}

function openNativePreview(preview) {
  activePreview = preview;
  syncBrowserViewVisibility();
  sendPreviewPayload();
  publishState();
  return { opened: true, kind: preview.kind, filename: preview.filename };
}

async function openReportPreview(request = {}) {
  const sourcePath = managedReportPath(request.path);
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error('This report cannot be previewed safely.');
  const extension = path.extname(sourcePath).toLowerCase();
  const format = extension === '.html' ? 'html' : extension === '.txt' ? 'txt' : '';
  if (!format) throw new Error('Only TXT and HTML reports can be previewed.');
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  if (format === 'html' && !isSafeStaticHtml(content)) throw new Error('This HTML report no longer passes static preview safety checks.');
  return openNativePreview({ kind: 'report', filename: path.basename(sourcePath), format, content, sourcePath });
}

// LORDE_PREVIEW_IN_CHAT_V364 â€” report content for the in-chat preview modal:
// same safety checks as the overlay path, but the payload RETURNS to the
// calling renderer instead of opening the main-window overlay.
async function readReportPreview(request = {}) {
  const sourcePath = managedReportPath(request.path);
  const stat = await fs.promises.stat(sourcePath);
  if (!stat.isFile() || stat.size > 1_000_000) throw new Error('This report cannot be previewed safely.');
  const extension = path.extname(sourcePath).toLowerCase();
  const format = extension === '.html' ? 'html' : extension === '.txt' ? 'txt' : '';
  if (!format) throw new Error('Only TXT and HTML reports can be previewed.');
  const content = await fs.promises.readFile(sourcePath, 'utf8');
  if (format === 'html' && !isSafeStaticHtml(content)) throw new Error('This HTML report no longer passes static preview safety checks.');
  return { filename: path.basename(sourcePath), format, content, sourcePath };
}

function openScreenshotPreview(request = {}) {
  const data = String(request.data || '');
  const mimeType = String(request.mimeType || '').toLowerCase();
  if (!data || data.length > 32_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
    throw new Error('This screenshot cannot be previewed safely.');
  }
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return openNativePreview({
    kind: 'screenshot',
    filename: `browser-screenshot-${stamp}.${extension}`,
    mimeType,
    data,
    meta: [request.source, request.tabId ? `tab ${request.tabId}` : ''].filter(Boolean).join(' Â· ')
  });
}

async function uniqueDownload(filename, writer) {
  const directory = app.getPath('downloads');
  await fs.promises.mkdir(directory, { recursive: true });
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension).slice(0, 100) || 'browser-use-file';
  for (let copy = 0; copy < 1_000; copy += 1) {
    const suffix = copy === 0 ? '' : ` (${copy + 1})`;
    const targetPath = path.join(directory, `${stem}${suffix}${extension}`);
    try {
      await writer(targetPath);
      return { path: targetPath, filename: path.basename(targetPath) };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique download filename.');
}

// Media cards in chat (generated images/video/audio) open this preview: same
// overlay as screenshots, with playability for audio/video and URL sources.
function openMediaPreview(request = {}) {
  const kind = ['image', 'video', 'audio'].includes(request?.kind) ? request.kind : 'image';
  const dataUrl = String(request?.dataUrl || '');
  const url = String(request?.url || '');
  const fallbackExtension = kind === 'video' ? 'mp4' : kind === 'audio' ? 'mp3' : 'png';
  const extension = (url.match(/\.(mp4|webm|mp3|wav|png|jpe?g|webp)(?:\?|$)/i)?.[1] || fallbackExtension).toLowerCase();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = String(request?.filename || `${kind === 'image' ? 'generated-image' : kind}-${stamp}.${extension}`);
  if (dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    const mimeType = (dataUrl.match(/^data:([^;,]+)/) || [])[1] || (kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png');
    if (!base64 || base64.length > 32_000_000) throw new Error('This media cannot be previewed safely.');
    return openNativePreview({ kind: 'media', mediaKind: kind, filename, mimeType, data: base64, meta: request.meta || '' });
  }
  if (/^https?:\/\//i.test(url)) {
    return openNativePreview({ kind: 'media', mediaKind: kind, filename, mimeType: request.mimeType || '', url, meta: request.meta || '' });
  }
  throw new Error('This media cannot be previewed.');
}

async function downloadActivePreview() {
  if (!activePreview) throw new Error('Open a report or screenshot before downloading it.');
  if (activePreview.kind === 'report') {
    return uniqueDownload(activePreview.filename, (targetPath) => fs.promises.copyFile(activePreview.sourcePath, targetPath, fs.constants.COPYFILE_EXCL));
  }
  if (activePreview.kind === 'media' && activePreview.url) {
    const response = await fetch(activePreview.url);
    if (!response.ok) throw new Error(`Could not download the media (HTTP ${response.status}).`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return uniqueDownload(activePreview.filename, (targetPath) => fs.promises.writeFile(targetPath, bytes, { flag: 'wx' }));
  }
  const bytes = Buffer.from(activePreview.data, 'base64');
  return uniqueDownload(activePreview.filename, (targetPath) => fs.promises.writeFile(targetPath, bytes, { flag: 'wx' }));
}

// Save a chat media card directly (no preview round-trip): data URL or URL.
ipcMain.handle('browser-use:download-media', async (_event, request) => {
  const filename = String(request?.filename || 'media');
  const dataUrl = String(request?.dataUrl || '');
  const url = String(request?.url || '');
  let bytes = null;
  if (dataUrl) {
    const base64 = dataUrl.split(',')[1] || '';
    if (!base64) throw new Error('This media cannot be saved.');
    bytes = Buffer.from(base64, 'base64');
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not save the media (HTTP ${response.status}).`);
    bytes = Buffer.from(await response.arrayBuffer());
  } else throw new Error('This media cannot be saved.');
  const targetPath = uniqueDownload(filename, (target) => fs.promises.writeFile(target, bytes, { flag: 'wx' }));
  return { filename: path.basename(targetPath), path: targetPath };
});

// Browser downloads land directly in the OS Downloads folder with a unique
// name. No native save dialog: an unattended agent run must never block on a
// modal, and the renderer panel offers Open / Show in folder afterwards.
function reserveDownloadPath(filename) {
  const directory = app.getPath('downloads');
  fs.mkdirSync(directory, { recursive: true });
  const extension = path.extname(filename);
  const stem = path.basename(filename, extension).slice(0, 100) || 'browser-use-file';
  for (let copy = 0; copy < 1_000; copy += 1) {
    const suffix = copy === 0 ? '' : ` (${copy + 1})`;
    const targetPath = path.join(directory, `${stem}${suffix}${extension}`);
    if (!fs.existsSync(targetPath)) return targetPath;
  }
  throw new Error('Could not allocate a unique download filename.');
}

function downloadSummary(entry) {
  return {
    id: entry.id,
    filename: entry.filename,
    url: entry.url,
    path: entry.path,
    state: entry.state,
    receivedBytes: entry.receivedBytes,
    totalBytes: entry.totalBytes,
    startedAt: entry.startedAt
  };
}

function downloadsSnapshot() {
  return [...downloadItems.values()].slice(-30).map(downloadSummary).reverse();
}

function trackDownload(item) {
  const id = `dl-${++downloadCounter}`;
  let targetPath;
  try {
    targetPath = reserveDownloadPath(item.getFilename());
    item.setSavePath(targetPath);
  } catch (error) {
    addConsoleEntry({ kind: 'download', level: 'error', message: `Could not start download: ${error.message}` });
    item.cancel();
    return;
  }
  const entry = {
    id,
    filename: path.basename(targetPath),
    url: item.getURL(),
    path: targetPath,
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: item.getTotalBytes(),
    startedAt: Date.now(),
    lastPushAt: 0
  };
  downloadItems.set(id, entry);
  while (downloadItems.size > 30) downloadItems.delete(downloadItems.keys().next().value);
  addConsoleEntry({ kind: 'download', message: `Download started: ${entry.filename}` });
  publishState();
  item.on('updated', (_event, state) => {
    entry.receivedBytes = item.getReceivedBytes();
    entry.totalBytes = item.getTotalBytes() || entry.receivedBytes;
    if (state === 'interrupted') entry.state = 'interrupted';
    // Progress repaints are throttled; the renderer re-renders per push.
    const now = Date.now();
    if (now - entry.lastPushAt < 250 && entry.state === 'progressing') return;
    entry.lastPushAt = now;
    publishState();
  });
  item.once('done', (_event, state) => {
    entry.receivedBytes = item.getReceivedBytes();
    entry.state = state === 'completed' ? 'completed' : 'interrupted';
    addConsoleEntry({ kind: 'download', level: entry.state === 'completed' ? 'info' : 'error', message: entry.state === 'completed' ? `Download complete: ${entry.filename}` : `Download failed: ${entry.filename}` });
    publishState();
  });
}


const DEFAULT_SETTINGS = {
  homepage: DEFAULT_URL,
  gptActionEnabled: true,
  gptApiKey: '',
  gptActionPublicOrigin: DEFAULT_GPT_ACTION_PUBLIC_ORIGIN,
  connectionMode: 'secure',
  mcpControlMode: 'browser',
  agentControlMode: 'browser',
  showTouchIndicators: true,
  // Device-canvas zoom (Ctrl+Scroll) remembered per device profile,
  // profileId -> clamped factor (0.5..3). See deviceZoom_flow_chat.md.
  deviceZoomByProfile: {},
  androidDevices: [],
  androidAdbPath: '',
  androidScrcpyPath: '',
  androidStreamRenderer: 'tab',
  terminalHeight: 260,
  aiChatModel: process.env.OLLAMA_MODEL || 'minimax-m3:cloud',
  aiChatBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
  aiChatProvider: 'ollama',
  aiChatConnectionId: '',
  aiConnections: [],
  browserUseCloudModel: process.env.CLOUD_MODEL || '',
  agentApprovalMode: 'unattended',
  agentEffort: 'auto',
  // System One verifier brain: off by default. Legacy layaEnabled remains for
  // settings migration, while new UI values are off|laya|jev.
  layaBrain: 'off',
  layaEnabled: false,
  layaEndpoint: '',
  jevBaseUrl: 'https://api.typesafe.ai/v1',
  jevModelId: 'jev-latest',
  // Provider disable (Laya standalone): when false, agent commands go straight
  // to the bundled Laya engine instead of the strong API model.
  providerEnabled: true
};

let mainWindow = null;
let splashWindow = null;
let mainWindowDidFinishLoad = false;
let mainRendererReady = false;
let splashRevealTimer = null;
let splashStartedAt = 0;
const SPLASH_MIN_DISPLAY_MS = 3500;
let desktopTray = null;
let isQuitting = false;
let backgroundBlockerId = null;
let selectedTabId = null;
let nextTabId = 1;
let settings = { ...DEFAULT_SETTINGS };
let activeDrawer = 'agent';
let primaryAgentPinned = true;
let mainBoundsBeforePinnedChats = null;
let agentDrawerWidth = AGENT_DRAWER_WIDTH;
let deviceMenuOpen = false;
let downloadsOpen = false;
let downloadsAnchor = { left: 10, top: 0, width: 28 };
let activePreview = null;
let aboutOpen = false;
// Coordinates are relative to the overlay BrowserView (which starts directly
// below the 76px chrome), supplied by the chrome button when it opens the menu.
let deviceMenuAnchor = { left: 10, top: 0, width: 28 };
// The address history dropdown renders in the overlay BrowserView, not the
// chrome DOM: the page content is a native BrowserView that always paints
// above chrome markup, so a DOM dropdown was invisible over any real page.
let historyMenuOpen = false;
let historyMenuAnchor = { left: 10, top: 0, width: 420 };
let historyMenuEntries = [];
let sessionBroker = null;
let desktopMcpServer = null;
let browserViewController = null;
let deviceEmulator = null;
let androidDeviceManager = null;
let androidStreamWindow = null;
let androidStreamBounds = null;
let debuggerLeaseManager = null;
let agentPointerOverlay = null;
let terminalManager = null;
let desktopChatAgent = null;
// ChatGPT-style live sessions: conversations that keep RUNNING after the chat
// drawer moved on. conversationId -> DesktopChatAgent instance. The primary
// drawer agent is handed off here (not killed) when a new chat starts.
const chatSessions = new Map();
const CHAT_SESSION_LIMIT = 12;
function pruneChatSessions() {
  for (const [id, instance] of chatSessions) {
    const snapshot = instance?.state?.();
    if (!snapshot || !['running', 'awaiting_approval', 'paused'].includes(snapshot.status)) chatSessions.delete(id);
  }
  while (chatSessions.size > CHAT_SESSION_LIMIT) chatSessions.delete(chatSessions.keys().next().value);
}
// Every live agent surface: the drawer's primary, handed-off sessions, and
// pool runs. Used for tab arbitration and message routing.
// Broadcast a renderer agent event to the main window AND every chat
// window/dock, so notices (spawn results, pool changes) follow whichever
// window the conversation actually lives in.
function broadcastAgentEvent(event) {
  const targets = [];
  if (mainWindow && !mainWindow.isDestroyed()) targets.push(mainWindow.webContents);
  for (const entry of chatAgentWindows.values()) {
    for (const view of [entry.window?.webContents, entry.dockView?.webContents]) {
      if (view && !view.isDestroyed?.()) targets.push(view);
    }
  }
  const sent = new Set();
  for (const contents of targets) {
    if (sent.has(contents)) continue;
    sent.add(contents);
    safeIpcSend(contents, 'browser-use:agent-event', event);
  }
}

function liveAgentInstances() {
  const instances = [...chatSessions.values()];
  if (desktopChatAgent) instances.push(desktopChatAgent);
  for (const entry of chatAgentWindows.values()) if (entry.instance) instances.push(entry.instance);
  for (const entry of agentPool?.activeRuns || []) instances.push(entry.instance);
  return [...new Set(instances)];
}
// Route run-targeted IPC (steer/cancel/approve) to whichever agent instance
// actually owns the run id. The sender's window instance and the primary are
// checked first, but handed-off drawer conversations (chatSessions) and pool
// runs own runs too â€” routing straight to the primary made Stop fail with
// 'Unknown AI chat run' while the task kept running.
function findAgentForRunId(runId) {
  const id = String(runId || '').trim();
  if (!id) return null;
  return liveAgentInstances().find((instance) => String(instance?.state?.()?.id || '') === id) || null;
}

function liveRunSnapshot(instance) {
  const snapshot = instance?.state?.();
  if (!snapshot || !['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(snapshot.status)) return null;
  return { id: snapshot.id, agentIdentity: snapshot.agentIdentity || 'agent1', title: snapshot.title || 'Untitled session', status: snapshot.status, step: snapshot.step || 0, tabId: snapshot.tabId || null };
}
function findLiveTabOwner(tabId) {
  if (!tabId) return null;
  for (const instance of liveAgentInstances()) {
    const snapshot = liveRunSnapshot(instance);
    if (snapshot && String(snapshot.tabId) === String(tabId)) return snapshot;
  }
  return null;
}
// The cross-session message hub: routes agent_message calls between live
// sessions. Replies come back through the same hub and never auto-reply
// again (no ping-pong loops).
function normalizedAgentRecipient(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function chatAgentNumber(entry) {
  return Number(String(entry?.label || '').match(/(\d+)/)?.[1] || 0);
}

function agentMessageTargets() {
  const targets = [];
  if (desktopChatAgent) targets.push({ instance: desktopChatAgent, role: desktopChatAgent.state?.()?.agentIdentity || 'agent1', label: 'Chat 1', aliases: ['agent1', 'chat1', 'primary', '1'] });
  for (const [id, entry] of [...chatAgentWindows.entries()].sort((a, b) => chatAgentNumber(a[1]) - chatAgentNumber(b[1]))) {
    const number = chatAgentNumber(entry) || 2;
    targets.push({ instance: entry.instance, entry, id, role: entry.instance?.state?.()?.agentIdentity || `agent${number}`, label: entry.label || `Chat ${number}`, aliases: [`agent${number}`, `chat${number}`, String(number), normalizedAgentRecipient(entry.label || ''), normalizedAgentRecipient(id)] });
  }
  for (const entry of agentPool?.activeRuns || []) {
    const snapshot = liveRunSnapshot(entry.instance);
    if (snapshot && !targets.some(target => target.instance === entry.instance)) targets.push({ instance: entry.instance, role: snapshot.agentIdentity || snapshot.id, label: entry.alias ? (String(entry.label).includes(entry.alias) ? entry.label : `${entry.label} (subagent ${entry.alias})`) : snapshot.title, aliases: [normalizedAgentRecipient(snapshot.id), normalizedAgentRecipient(snapshot.agentIdentity || ''), normalizedAgentRecipient(entry.alias || ''), normalizedAgentRecipient(entry.label || '')] });
  }
  // LORDE_RESIDENT_SUBAGENTS_V365 â€” residents are addressable by alias even
  // when idle; messaging an idle resident starts its follow-up assignment.
  // liveRunSnapshot() here was the live-field defect from the field
  // transcript: it returns null for terminal runs, so idle residents vanished
  // from the hub ("No matching live agent received this message"). Residents
  // are SUPPOSED to be terminal â€” read the state snapshot directly.
  for (const record of spawnRegistry.values()) {
    if (!record.instance || record.status === 'closed') continue;
    if (targets.some(target => target.instance === record.instance)) continue;
    const snapshot = record.instance.state?.();
    if (!snapshot) continue;
    targets.push({ instance: record.instance, role: record.alias || snapshot.agentIdentity || snapshot.id, label: `subagent ${record.alias}`, aliases: [normalizedAgentRecipient(record.alias || ''), normalizedAgentRecipient(record.spawnId || ''), normalizedAgentRecipient(snapshot.id || '')], resident: record });
  }
  for (const instance of [...chatSessions.values()]) {
    const snapshot = liveRunSnapshot(instance);
    if (snapshot && !targets.some(target => target.instance === instance)) targets.push({ instance, role: snapshot.agentIdentity || snapshot.id, label: snapshot.title, aliases: [normalizedAgentRecipient(snapshot.id), normalizedAgentRecipient(snapshot.agentIdentity || '')] });
  }
  const seenRoles = new Set();
  const isLive = target => Boolean(target.instance?.state?.() && ['running', 'awaiting_approval', 'paused'].includes(target.instance.state().status));
  return targets
    .sort((left, right) => Number(isLive(right)) - Number(isLive(left)))
    .filter(target => target.instance && !seenRoles.has(target.role) && seenRoles.add(target.role));
}

function targetMatchesRecipient(target, wanted) {
  const normalized = normalizedAgentRecipient(wanted);
  const parts = String(wanted || '').split(/[\/|,]+/).map(normalizedAgentRecipient).filter(Boolean);
  return target.role === wanted
    || parts.some(part => target.aliases?.includes(part) || part === normalizedAgentRecipient(target.role) || part === normalizedAgentRecipient(target.label))
    || target.aliases?.includes(normalized)
    || normalized === normalizedAgentRecipient(target.role)
    || normalized === normalizedAgentRecipient(target.label);
}

function chatEntryForRecipient(value) {
  const wanted = normalizedAgentRecipient(value);
  return agentMessageTargets().find(target => target.entry && targetMatchesRecipient(target, wanted)) || null;
}

function emitChatWindowAgentEvent(id, event) {
  const entry = chatAgentWindows.get(String(id));
  if (!entry) return;
  const sent = new Set();
  for (const contents of [entry.window?.webContents, entry.dockView?.webContents]) {
    if (!contents || contents.isDestroyed?.() || sent.has(contents)) continue;
    sent.add(contents);
    safeIpcSend(contents, 'browser-use:agent-event', event);
  }
}

function startPrimaryChatForMessage(message) {
  const entry = desktopChatAgent;
  const current = entry?.state?.();
  if (!entry) return { started: false, note: 'Chat 1 is unavailable; the message remains queued.' };
  if (current?.status === 'awaiting_recovery') {
    void entry.resumeAfterRecovery?.(message).catch(error => addConsoleEntry({ kind: 'agent', level: 'error', message: `Chat 1 recovery resume failed: ${String(error?.message || error)}` }));
    return { started: true, resumed: true, note: 'Chat 1 resumed its preserved run.' };
  }
  if (current && ['running', 'awaiting_approval', 'paused'].includes(current.status)) return { started: false, note: 'Chat 1 is already running; its full-tool decision loop will receive the message.' };
  const provider = settings.providerEnabled === false ? { id: 'laya', endpoint: settings.layaEndpoint } : activeProviderConfig();
  if (!provider) return { started: false, note: 'The shared provider is not configured; the message remains queued.' };
  const selected = selectedTab();
  const selectedId = selected?.id || selectedTabId;
  const owner = findLiveTabOwner(selectedId);
  const rawUrl = selected && !selected.webContents.isDestroyed() ? selected.webContents.getURL() || '' : '';
  // LORDE_HOME_URL_V1 â€” the homepage file:// URL must never appear in the
  // address bar; it's the blank/home page. Show empty instead.
  const address = isHomeUrl(rawUrl) ? '' : rawUrl;
  const tabId = owner ? createTab(address, false).id : selectedId;
  const ownedTabIds = owner ? [String(tabId)] : [];
  try {
    const completion = entry.start({
      task: 'Coordinate the incoming agent message using the existing Chat 1 task and AI-controlled tab. Do not treat this as a human chat submission.',
      agentIdentity: 'agent1',
      tabId,
      ownedTabIds,
      provider,
      workspace: resolveWorkspaceContract(),
      settings: { controlMode: normalizeControlMode(settings.agentControlMode), approvalMode: settings.agentApprovalMode, effort: normalizeAgentEffort(settings.agentEffort), layaBrain: settings.layaBrain, layaEnabled: Boolean(settings.layaEnabled), layaEndpoint: settings.layaEndpoint, jevBaseUrl: settings.jevBaseUrl, jevModelId: settings.jevModelId, providerEnabled: settings.providerEnabled !== false },
      initialAgentMessages: [message]
    });
    void completion.catch(error => addConsoleEntry({ kind: 'agent', level: 'error', message: `Chat 1 coordination failed: ${String(error?.message || error)}` }));
    publishState();
    return { started: true, runId: entry.state()?.id || null, tabId, role: 'agent1', note: 'Chat 1 started with its full tools and received the message.' };
  } catch (error) {
    if (owner && tabId !== selectedTabId) closeTab(tabId);
    return { started: false, note: `Could not start Chat 1: ${String(error?.message || error).slice(0, 240)}` };
  }
}

const agentMessageRoundRobin = new Map();
const agentMessageHub = {
  hasLiveRecipient(from) {
    const senderId = String(from || '');
    return agentMessageTargets().some(target => {
      const state = target.instance?.state?.();
      return String(state?.id || '') !== senderId && ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(state?.status);
    });
  },
  async send({ from, fromLabel, to, text, isReply = false }) {
    const wanted = String(to || 'any').trim() || 'any';
    const message = { from: String(from || ''), fromLabel: String(fromLabel || 'another session').slice(0, 120), text: String(text || '').slice(0, 4000), reply: isReply === true, at: Date.now() };
    const allTargets = agentMessageTargets();
    const sender = allTargets.find(target => String(target.instance.state?.()?.id || '') === String(from));
    const targets = allTargets.filter(target => String(target.instance.state?.()?.id || '') !== String(from) && (!sender || target.role !== sender.role));
    let target = null;
    if (wanted.toLowerCase() === 'any') {
      // 'any' rotates LIVE targets only: waking an idle resident is a
      // deliberate named assignment (alias), never a round-robin side effect.
      const liveTargets = targets.filter(candidate => !candidate.resident);
      const key = String(from || 'anonymous');
      const cursor = Number(agentMessageRoundRobin.get(key) || 0);
      target = liveTargets[cursor % Math.max(1, liveTargets.length)] || null;
      agentMessageRoundRobin.set(key, cursor + 1);
    } else target = targets.find(candidate => targetMatchesRecipient(candidate, wanted)) || null;
    if (target?.instance) {
      if (target.resident) touchSubagentRecord(target.resident);
      const delivered = target.instance.receiveAgentMessage({ ...message, delivery: 'live-agent-message' });
      if (delivered?.delivered === true) return { sent: true, queued: false, delivered: true, to: target.label, toId: target.instance.state()?.id || target.role, role: target.role, note: `Delivered to ${target.role} (${target.label}) at its next full-tool decision.` };
      // LORDE_RESIDENT_SUBAGENTS_V365 â€” an idle resident subagent is woken by
      // the message: the text becomes its new assignment on the SAME
      // conversation (full prior context), like a professional agent keeping
      // its workers busy instead of discarding them.
      if (target.resident) {
        const started = startSubagentFollowUp(target.resident, message);
        return { sent: started.started === true, queued: false, delivered: started.started === true, to: target.label, toId: target.resident.runId || target.role, role: target.role, note: started.note };
      }
      if (delivered?.reason === 'sender-cooldown' || delivered?.reason === 'sender-capped') {
        return { sent: false, queued: true, delivered: false, rateLimited: true, to: target.label, toId: target.role, role: target.role, note: `Rate-limited by message damping (${delivered.reason}). Wait a few seconds and resend, or continue your own share - the message was refused before delivery, not lost.` };
      }
      return { sent: false, queued: false, delivered: false, to: target.label, toId: target.instance.state()?.id || target.role, role: target.role, note: `${target.label} did not receive the message. No hidden run was started.` };
    }
    if (target?.entry) {
      if (target.instance?.state?.()?.status === 'awaiting_recovery') {
        void target.instance.resumeAfterRecovery?.(message).catch(error => addConsoleEntry({ kind: 'agent', level: 'error', message: `${target.label} recovery resume failed: ${String(error?.message || error)}` }));
        return { sent: true, queued: false, resumed: true, delivered: true, to: target.label, toId: target.id, role: target.role, note: `${target.label} resumed its preserved run.` };
      }
      const status = target.instance?.state?.()?.status;
      if (['running', 'awaiting_approval', 'paused'].includes(status)) {
        const delivered = target.instance.receiveAgentMessage(message);
        return { sent: delivered?.delivered === true, queued: false, delivered: delivered?.delivered === true, to: target.label, toId: target.id, role: target.role, note: delivered?.delivered === true ? `${target.label} received a live coordination message.` : 'The target did not receive the message.' };
      }
      return { sent: false, queued: false, delivered: false, to: target.label, toId: target.id, role: target.role, note: `${target.label} is not running. No message was injected and no chat was started.` };
    }
    return { sent: false, queued: false, delivered: false, note: 'No matching live agent received this message. Do not claim delivery or a reply.' };
  }
};

let pendingLayout = false;
// Docked terminal geometry. Detaching moves the same session into its own
// window, so the dock collapses without the session being torn down.
let terminalDocked = false;
let terminalDetachedWindow = null;
const chatAgentWindows = new Map();
const CHAT_WINDOW_LIMIT = 2;
const PINNED_CHAT_GAP = 0;
const PINNED_CHAT_MIN_MAIN_WIDTH = 960;

function liveAgentForOwner(owner) {
  const wanted = String(owner || '');
  for (const instance of liveAgentInstances()) {
    const snapshot = instance?.state?.();
    if (snapshot?.id && (String(snapshot.id) === wanted || String(snapshot.computerOwner || '') === wanted)) return { instance, snapshot };
  }
  return null;
}

function notifyDesktopFocus(owner, text, reply = false) {
  const target = liveAgentForOwner(owner);
  if (target) target.instance.receiveAgentMessage({ from: 'browser-use-focus', fromLabel: 'Browser-use focus coordinator', text, reply });
}

desktopLease.onWait = (requester, holder) => {
  const requesterTarget = liveAgentForOwner(requester);
  const holderTarget = liveAgentForOwner(holder);
  if (!requesterTarget || !holderTarget) return;
  const requesterTitle = requesterTarget.snapshot.title || 'Another agent';
  const holderTitle = holderTarget.snapshot.title || 'another agent';
  notifyDesktopFocus(holder, `${requesterTitle} requests temporary native desktop focus. Finish your current physical action and release it when safe; the waiting agent will continue automatically.`);
  notifyDesktopFocus(requester, `Native desktop focus is currently held by ${holderTitle}. Your request is queued and will continue automatically when that action finishes.`);
};
desktopLease.onRelease = (previous, next) => {
  for (const notice of leaseHandoffNotices(previous, next)) notifyDesktopFocus(notice.owner, notice.text, notice.reply);
};
let terminalHeight = DEFAULT_SETTINGS.terminalHeight;
let activeTerminalSessionId = null;
let credentialStore = null;
let chatHistoryStore = null;
let historyStore = null;
// Session-scoped download registry: id -> summary. Completed/interrupted
// entries are kept for the session so the panel can offer Open / Show in
// folder; nothing is persisted to disk.
const downloadItems = new Map();
let downloadCounter = 0;
// sessionId -> last output timestamp; drives the terminal busy dot. A five
// minute window: shorter would flicker off during silent stretches of a
// working process, longer would keep stale sessions lit.
const TERMINAL_BUSY_WINDOW_MS = 5 * 60_000;
let terminalActivity = new Map();
const tabs = new Map();
let lastNonzeroStageBounds = null;
const consoleEntries = [];

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function appDataPath(...segments) {
  const target = path.join(app.getPath('userData'), ...segments);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

function loadSettings() {
  try {
    const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
    const legacyCloudKey = String(parsed.browserUseCloudApiKey || '').trim();
    delete parsed.browserUseCloudApiKey;
    if (legacyCloudKey && credentialStore?.available()) credentialStore.set('browserUseCloudApiKey', legacyCloudKey);
    // Migration: builds before the consent-gated Laya dialogue wrote the
    // sidecar endpoint as a default. An endpoint always-on made every decision
    // probe a dead HTTP sidecar before the engine fallback. Bundled-engine
    // first is the restored default; the settings dialogue opts back in.
    // Only when the checkpoint is genuinely absent though: a user who has
    // downloaded the weights and configured the sidecar brain must keep that
    // configuration across restarts, unconditionally wiping the endpoint
    // silently forced the bundled brain forever, even with the full model
    // sitting in the cache. When the endpoint is set and layaEnabled is on,
    // the runtime spawns the sidecar from the local cache itself and every
    // decision degrades fail-silent to bundled while it is unhealthy.
    if (String(parsed.layaEndpoint || '').trim() === 'http://127.0.0.1:8765'
      && !fs.existsSync(path.join(os.homedir(), '.laya-cache', 'models', 'laya', 'model.safetensors'))) {
      parsed.layaEndpoint = '';
    }
    const layaBrain = ['off', 'laya', 'jev'].includes(parsed.layaBrain)
      ? parsed.layaBrain
      : (parsed.layaEnabled ? 'laya' : 'off');
    parsed.layaBrain = layaBrain;
    parsed.layaEnabled = layaBrain === 'laya';
    parsed.jevBaseUrl = /^(https?:\/\/[^\s]+)$/.test(String(parsed.jevBaseUrl || '').trim())
      ? String(parsed.jevBaseUrl).trim()
      : DEFAULT_SETTINGS.jevBaseUrl;
    parsed.jevModelId = String(parsed.jevModelId || DEFAULT_SETTINGS.jevModelId).replace(/[\r\n]/g, '').trim().slice(0, 240) || DEFAULT_SETTINGS.jevModelId;
    // LORDE_HOME_MIGRATE_V1 â€” legacy settings persisted example.com as the
    // homepage. The real homepage is now the built-in dashboard; reset it
    // once so launch never opens example.com again.
    const savedHomepage = String(parsed.homepage || '').trim().replace(/\/+$/, '');
    if (savedHomepage === 'https://example.com' || savedHomepage === 'http://example.com' || savedHomepage === 'https://www.example.com' || savedHomepage.includes('homepage.html')) {
      // LORDE_HOME_MIGRATE_V2 — legacy example.com AND the old local
      // homepage.html file both migrate to the hosted new-tab page.
      parsed.homepage = DEFAULT_URL;
    }
    return { ...parsed, gptApiKey: String(parsed.gptApiKey || '').trim() || crypto.randomBytes(24).toString('base64url') };
  } catch {
    return { ...DEFAULT_SETTINGS, gptApiKey: crypto.randomBytes(24).toString('base64url') };
  }
}

function normalizedConnections() {
  return Array.isArray(settings.aiConnections) ? settings.aiConnections
    .filter((connection) => connection && typeof connection === 'object' && typeof connection.id === 'string')
    .map((connection) => {
      // customModels stay kind-tagged objects ({id, kind}); legacy strings
      // upgrade in place. A connection model corrupted by the historical
      // "[object Object]" renderer bug is repaired from the first real entry.
      const customModels = (Array.isArray(connection.customModels) ? connection.customModels : [])
        .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
        .filter(Boolean);
      let model = String(connection.model || '').trim();
      if (!model || model === '[object Object]') model = customModels[0]?.id || '';
      return {
        id: String(connection.id), provider: String(connection.provider || 'ollama'), name: String(connection.name || ''),
        baseUrl: String(connection.baseUrl || ''), model,
        enabled: connection.enabled !== false,
        customModels
      };
    }) : [];
}

function connectionCredentialKey(connectionId) { return `aiProvider:${String(connectionId || '')}`; }
function uniqueConnectionName(requested, connections, currentId = '') {
  const base = String(requested || 'Provider connection').trim() || 'Provider connection';
  const taken = new Set(connections.filter((item) => item.id !== currentId).map((item) => String(item.name || '').trim().toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let suffix = 1;
  while (taken.has(`${base}_${suffix}`.toLowerCase())) suffix += 1;
  return `${base}_${suffix}`;
}
const JEV_CREDENTIAL_KEY = 'systemOneJevApiKey';

function connectionById(connectionId) {
  return normalizedConnections().find((connection) => connection.id === String(connectionId || '')) || null;
}

// Resolve the same provider/model selected in the AI settings surface. Record
// & Learn must work before any chat run has happened, so it cannot rely on the
// last-run cache as its source of truth.
function activeProviderConfig() {
  const provider = String(settings.aiChatProvider || 'ollama');
  if (provider === 'cloud') return {
    id: 'cloud', model: String(settings.browserUseCloudModel || '').trim(),
    apiKey: credentialStore?.get('browserUseCloudApiKey') || process.env.BROWSER_USE_API_KEY || ''
  };
  if (provider !== 'ollama' && PROVIDER_LABELS[provider]) {
    const connection = connectionById(settings.aiChatConnectionId);
    if (!connection || connection.provider !== provider) return null;
    return {
      id: provider, connectionId: connection.id, baseUrl: connection.baseUrl,
      model: connection.model, apiKey: credentialStore?.get(connectionCredentialKey(connection.id)) || ''
    };
  }
  return { id: 'ollama', model: String(settings.aiChatModel || '').trim(), baseUrl: settings.aiChatBaseUrl };
}

function publicSettings() {
  const cloudCredential = credentialStore?.status('browserUseCloudApiKey') || { configured: Boolean(process.env.BROWSER_USE_API_KEY), display: '', secureStorageAvailable: false };
  const { gptApiKey, ...safe } = settings;
  const aiConnections = normalizedConnections().map((connection) => ({ ...connection, credential: connection.provider === 'cloud' ? cloudCredential : credentialStore?.status(connectionCredentialKey(connection.id)) || { configured: false, display: '', secureStorageAvailable: false } }));
  const jevCredential = credentialStore?.status(JEV_CREDENTIAL_KEY) || { configured: false, display: '', secureStorageAvailable: false };
  return { ...safe, aiConnections, cloudCredential, jevCredential, providers: publicProviderStatus({ settings, cloudCredential }) };
}

function saveSettings(nextSettings) {
  const next = { ...DEFAULT_SETTINGS, ...nextSettings };
  delete next.browserUseCloudApiKey;
  const homepage = normalizeUrl(next.homepage);
  const gptApiKey = String(next.gptApiKey || '').trim() || crypto.randomBytes(24).toString('base64url');
  const gptActionPublicOrigin = normalizeGptActionPublicOrigin(next.gptActionPublicOrigin);
  const connectionMode = 'secure';
  const settingsToSave = {
    ...next,
    homepage,
    gptActionEnabled: Boolean(next.gptActionEnabled),
    mcpControlMode: normalizeControlMode(next.mcpControlMode),
    agentControlMode: normalizeControlMode(next.agentControlMode),
    agentEffort: normalizeAgentEffort(next.agentEffort),
    layaBrain: ['off', 'laya', 'jev'].includes(next.layaBrain)
      ? next.layaBrain
      : (next.layaEnabled ? 'laya' : 'off'),
    layaEnabled: next.layaBrain === 'laya' || (next.layaBrain === undefined && Boolean(next.layaEnabled)),
    layaEndpoint: /^(https?:\/\/[^\s]+)?$/.test(String(next.layaEndpoint || '').trim()) ? String(next.layaEndpoint).trim() : '',
    jevBaseUrl: /^(https?:\/\/[^\s]+)$/.test(String(next.jevBaseUrl || '').trim()) ? String(next.jevBaseUrl).trim() : DEFAULT_SETTINGS.jevBaseUrl,
    jevModelId: String(next.jevModelId || DEFAULT_SETTINGS.jevModelId).replace(/[\r\n]/g, '').trim().slice(0, 240) || DEFAULT_SETTINGS.jevModelId,
    providerEnabled: next.providerEnabled !== false,
    connectionMode,
    gptApiKey,
    gptActionPublicOrigin
  };
  const temporaryPath = `${settingsPath()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(settingsToSave, null, 2));
  fs.renameSync(temporaryPath, settingsPath());
  const layaTurnedOn = Boolean(settingsToSave.layaEnabled) && !settings.layaEnabled;
  settings = settingsToSave;
  if (androidDeviceManager) androidDeviceManager.streamRenderer = settings.androidStreamRenderer === 'native' ? 'native' : 'tab';
  // Laya toggled on in the dropdown: auto-start the model when it is already
  // on disk. A first-time download still needs the settings-dialogue consent.
  if (layaTurnedOn) void getLayaRuntime().maybeAutoStart().catch(() => { });
  sessionBroker?.setConnectionMode?.(settings.connectionMode);
  return settings;
}

// Device-zoom persistence coalesces a wheel gesture's many notches into one
// settings write. Never persist NaN/garbage: clampZoom in the emulator already
// guarantees finite values, and the guard here keeps a corrupted callback from
// wiping the map.
let zoomPersistTimer = null;
function scheduleZoomPersist(zooms) {
  if (zoomPersistTimer) clearTimeout(zoomPersistTimer);
  zoomPersistTimer = setTimeout(() => {
    zoomPersistTimer = null;
    try {
      saveSettings({ ...settings, deviceZoomByProfile: zooms });
    } catch (error) {
      addConsoleEntry({ kind: 'error', level: 'warn', message: `Device zoom could not be saved: ${error?.message || error}` });
    }
  }, 600);
  if (typeof zoomPersistTimer.unref === 'function') zoomPersistTimer.unref();
}

// normalizeUrl is shared with the agent controller via desktop/urlUtils.cjs
// (search fallback, file:// and drive-path support live there).

function normalizeGptActionPublicOrigin(value) {
  const raw = String(value || DEFAULT_GPT_ACTION_PUBLIC_ORIGIN).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Public GPT Action origin must be a valid HTTPS origin.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw new Error('Public GPT Action origin must be an HTTPS origin without a path, query, or fragment.');
  }
  return parsed.origin;
}

// Discovery is a short, read-only readiness probe. A single socket hiccup
// should not make the chat settings look permanently broken, but credential
// and validation responses must remain immediate and transparent.
async function fetchWithBoundedRetry(url, options = {}, { attempts = 2, timeoutMs = 12_000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`Timed out after ${timeoutMs}ms.`)), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) return response;
      lastError = new Error(`Endpoint returned ${response.status}.`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw lastError || new Error('The provider endpoint could not be reached.');
}

// Shared non-language model runner (module scope: the chat composer's IPC
// handler AND every DesktopChatAgent instance's computer_model tool resolve it
// through the same closure). Resolves the connection, builds the same-kind
// catalogue (user-tagged custom models first, then kind-inferred discovery),
// and delegates to the media router â€” async job polling, lenient JSON
// recovery, and a fallback cycle across same-kind models.
async function runMediaTaskForConnection({ connectionId, kind, model, prompt, voice, fileBase64, filename, imagePath, saveTo }) {
  const connection = connectionById(connectionId || settings.aiChatConnectionId);
  if (!connection) throw new Error('Save this provider connection before generating.');
  const apiKey = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
  if (!apiKey) throw new Error('Add an API key to this provider connection before generating.');
  // The connection's saved TTS voice is the default; an explicit request voice wins.
  voice = String(voice || '').trim() || String(connection.ttsVoice || '').trim() || undefined;
  const base = String(connection.baseUrl || '').replace(/\/$/, '');
  const wantedKind = MODEL_KINDS.includes(kind) ? kind : 'image';
  const requestedModel = String(model || '').trim();
  const customEntries = (Array.isArray(connection.customModels) ? connection.customModels : [])
    .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
    .filter(Boolean);
  // Live catalogue for the fallback cycle; discovery failure must not block
  // the requested model itself, so this stays best-effort.
  let discovered = [];
  try {
    const response = await fetchWithBoundedRetry(base + '/models', { headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` } });
    if (response.ok) {
      const payload = await response.json();
      discovered = [...new Set((Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
        .map((entry) => String(entry?.id || entry?.name || entry?.model || '').trim()).filter(Boolean))];
    }
  } catch { /* the requested model can still succeed without discovery */ }
  const taggedKinds = new Map(customEntries.map((entry) => [entry.id, entry.kind]));
  const kindOf = (id) => taggedKinds.get(id) || inferModelKind(id);
  const primary = requestedModel
    || customEntries.find((entry) => entry.kind === wantedKind)?.id
    || connection.model && kindOf(connection.model) === wantedKind && connection.model
    || discovered.find((id) => kindOf(id) === wantedKind)
    || '';
  const fallbackModels = [
    ...customEntries.filter((entry) => entry.kind === wantedKind && entry.id !== primary).map((entry) => entry.id),
    ...discovered.filter((id) => id !== primary && kindOf(id) === wantedKind),
  ];
  if (!primary && !fallbackModels.length) throw new Error(`No ${wantedKind} model is available on this connection. Add one with the model picker.`);
  // IMAGE EDIT FROM A LOCAL FILE (run-forensics 2026-10-15): the model used
  // to need fileBase64 â€” forcing ~180KB of base64 through read â†’ reasoning â†’
  // next-call parameters, which burned ~10 decisions on re-encodes and
  // base64 splitting and then lost the bytes to compaction. imagePath lets
  // the HARNESS read and attach the file; nothing transits the model context.
  let imageBase64 = null;
  let imageFilename = null;
  if (wantedKind === 'image' && String(imagePath || '').trim()) {
    const source = path.resolve(String(imagePath).trim());
    const stat = fs.statSync(source); // throws honestly when absent
    if (!stat.isFile()) throw new Error(`imagePath is not a file: ${source}`);
    if (stat.size > 10 * 1024 * 1024) throw new Error(`imagePath exceeds the 10MB edit budget (${stat.size} bytes).`);
    if (!/\.(png|jpe?g|webp|gif)$/i.test(source)) throw new Error('imagePath must be a png/jpg/webp/gif file.');
    imageBase64 = fs.readFileSync(source).toString('base64');
    imageFilename = path.basename(source);
  }
  const outcome = await runModelTask({
    baseUrl: base, apiKey, kind: wantedKind, model: primary, prompt: String(prompt || '').trim().slice(0, 4000),
    voice, fileBase64, filename, imageBase64, imageFilename, fallbackModels, fetchImpl: fetch, timeoutMs: 180_000,
    onNote: (note) => addConsoleEntry({ kind: 'agent', level: 'info', message: `[Model task] ${note}` }),
  });
  // saveTo: land the finished asset on disk so the run gets a real file path
  // instead of having to echo a URL/data URL through more tool calls.
  const saveTarget = String(saveTo || '').trim();
  if (saveTarget && outcome?.ok) {
    const target = path.resolve(saveTarget);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (outcome.dataUrl) {
      const comma = outcome.dataUrl.indexOf(',');
      if (outcome.dataUrl.startsWith('data:') && comma > 0) {
        fs.writeFileSync(target, Buffer.from(outcome.dataUrl.slice(comma + 1), 'base64'));
        outcome.savedPath = target;
      }
    } else if (outcome.url) {
      const response = await fetch(outcome.url, { headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
      if (!response.ok) throw new Error(`saveTo download failed: HTTP ${response.status}`);
      fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      outcome.savedPath = target;
    }
  }
  // AUTO-SAVE: an image/video outcome that is only a data URL gets written to
  // the run's asset store, so the model always receives a real file path â€”
  // and never a reason to echo megabytes of base64 through more tool calls.
  if (outcome?.ok && !outcome.savedPath && outcome.dataUrl && (wantedKind === 'image' || wantedKind === 'video')) {
    try {
      const dir = path.join(app.getPath('userData'), 'agent-results');
      fs.mkdirSync(dir, { recursive: true });
      const target = path.join(dir, `${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${wantedKind === 'image' ? 'png' : 'webm'}`);
      const comma = outcome.dataUrl.indexOf(',');
      if (outcome.dataUrl.startsWith('data:') && comma > 0) {
        fs.writeFileSync(target, Buffer.from(outcome.dataUrl.slice(comma + 1), 'base64'));
        outcome.savedPath = target;
      }
    } catch { /* the URL/dataUrl still returns; saving is additive */ }
  }
  return outcome;
}

function installationIdPath() {
  return path.join(app.getPath('userData'), 'installation-id');
}

function installationId() {
  try {
    const existing = fs.readFileSync(installationIdPath(), 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const value = crypto.randomUUID();
  fs.writeFileSync(installationIdPath(), value, { mode: 0o600 });
  return value;
}

function desktopMcpStatus() {
  const localStatus = desktopMcpServer?.status() || { listening: false, endpoint: null, pairingEndpoint: null };
  const publicGptEndpoint = localStatus.gptEnabled ? `${settings.gptActionPublicOrigin}/gpt/openapi.json` : null;
  return {
    ...localStatus,
    gptLocalOpenApiEndpoint: localStatus.gptOpenApiEndpoint || null,
    gptOpenApiEndpoint: publicGptEndpoint,
    ...(sessionBroker?.status() || { pairing: { active: false }, sessions: [] }),
    connectionMode: 'secure'
  };
}

function terminalBrokerConfiguration() {
  const profile = crypto.createHash('sha256').update(installationId()).digest('hex').slice(0, 32);
  const secretPath = path.join(app.getPath('userData'), 'terminal-broker-secret');
  let secret = '';
  try { secret = fs.readFileSync(secretPath, 'utf8').trim(); } catch {}
  if (!secret) {
    secret = crypto.randomBytes(32).toString('base64url');
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
  }
  return {
    pipePath: process.platform === 'win32' ? `\\\\.\\pipe\\browser-use-terminal-${profile}` : path.join(app.getPath('userData'), `terminal-${profile}.sock`),
    secret,
    brokerPath: path.join(__dirname, 'terminal', 'terminalBroker.cjs'),
    executablePath: process.execPath
  };
}

function gptActionSchemaSnapshot() {
  const status = desktopMcpStatus();
  return {
    openApiUrl: status.gptOpenApiEndpoint,
    apiKey: status.gptEnabled ? settings.gptApiKey : null,
    authHeader: 'X-API-Key',
    schema: status.gptOpenApiEndpoint ? {
      schemaType: 'openapi-url',
      importUrl: status.gptOpenApiEndpoint,
      auth: { type: 'apiKey', in: 'header', name: 'X-API-Key', value: status.gptEnabled ? settings.gptApiKey : null },
      note: 'Import this URL into a custom GPT Action, then configure the displayed X-API-Key value in the Action authentication settings.'
    } : null
  };
}

function connectionConfiguration() {
  const status = desktopMcpStatus();
  return {
    endpoint: status.endpoint,
    pairingEndpoint: status.pairingEndpoint,
    authenticationEndpoint: status.authenticationEndpoint,
    instanceId: status.instanceId,
    gptEnabled: status.gptEnabled,
    gptOpenApiEndpoint: status.gptOpenApiEndpoint,
    gptApiKey: status.gptEnabled ? settings.gptApiKey : null,
    gptActionSchema: gptActionSchemaSnapshot().schema,
    connectionMode: 'secure',
    mcpControlMode: normalizeControlMode(settings.mcpControlMode),
    message: 'Secure Mode: bootstrap with a short-lived pairing header, retain the returned MCP session, then bind one tab for tab-scoped tools. Every Desktop MCP tool is available immediately after pairing.'
  };
}

function androidStreamPageUrl(serial) {
  const page = path.join(__dirname, 'renderer', 'androidStream.html');
  return `${pathToFileURL(page).href}?serial=${encodeURIComponent(String(serial || ''))}`;
}

async function openAndroidStreamTab({ serial, title } = {}) {
  const url = androidStreamPageUrl(serial);
  const tab = createTab(url, true);
  tab.androidStreamSerial = String(serial || '');
  tab.title = title || `Android ${serial}`;
  await new Promise((resolve) => {
    if (tab.webContents.isDestroyed()) return resolve();
    const timer = setTimeout(resolve, 5_000);
    tab.webContents.once('dom-ready', () => { clearTimeout(timer); resolve(); });
  });
  return { tabId: tab.id, url, title: tab.title };
}

async function closeAndroidStreamTab({ tabId } = {}) {
  if (tabId) closeTab(String(tabId));
}

async function embedAndroidStream({ serial, title, tab = null, bounds = null } = {}) {
  if (!nativeAndroidWindow.available || !mainWindow || mainWindow.isDestroyed()) return { embedded: false, reason: 'Native Windows embedding is unavailable; scrcpy remains in its managed window.' };
  const childHandle = await nativeAndroidWindow.findByTitle(title, { timeoutMs: 7_000 });
  if (!childHandle) return { embedded: false, reason: 'scrcpy window did not appear before the embed deadline.' };
  const content = mainWindow.getContentBounds();
  const tabBounds = tab?.tabId && tabs.get(String(tab.tabId))?.view?.getBounds?.();
  const target = bounds || tabBounds || androidStreamBounds || { x: 0, y: 0, width: Math.max(320, content.width), height: Math.max(240, content.height) };
  androidStreamWindow = { serial, title, tabId: tab?.tabId || null, childHandle, embedded: true, bounds: target };
  return nativeAndroidWindow.embed({ childHandle, parentHandle: mainWindow.getNativeWindowHandle(), ...target });
}

function setAndroidStreamBounds(bounds = {}) {
  if (!androidStreamWindow?.childHandle) return { embedded: false, reason: 'No native Android stream is active.' };
  const target = { x: Number(bounds.x) || 0, y: Number(bounds.y) || 0, width: Math.max(1, Number(bounds.width) || 1), height: Math.max(1, Number(bounds.height) || 1) };
  androidStreamBounds = target; androidStreamWindow.bounds = target;
  return nativeAndroidWindow.setBounds({ childHandle: androidStreamWindow.childHandle, ...target });
}

async function startDesktopMcp() {
  debuggerLeaseManager = new DebuggerLeaseManager({
    getTabs: () => [...tabs.values()],
    // A timed-out CDP command is user-visible evidence, not a silent stall:
    // without this line a hung DevTools command looks exactly like an agent
    // that stopped thinking.
    onOperationTimeout: ({ tabId, purpose }) => addConsoleEntry({ kind: 'browser', level: 'warn', tabId: String(tabId), message: `[CDP] "${purpose}" timed out and was reset; later commands on this tab continue.` })
  });
  const androidBinary = (configured, name) => {
    const sdkRoots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk')].filter(Boolean);
    const sdkCandidates = name.toLowerCase().startsWith('adb')
      ? sdkRoots.map((root) => path.join(root, 'platform-tools', name))
      : [];
    // Bundled binaries are authoritative: the packaged app must work on a
    // clean Windows host without Android SDK/scrcpy installed. Explicit user
    // paths override the bundle for development; system SDK is fallback only.
    const bundled = [
      path.join(process.resourcesPath || __dirname, 'app.asar.unpacked', 'desktop', 'android', 'bin', 'win32-x64', name),
      path.join(process.resourcesPath || __dirname, 'android', 'bin', 'win32-x64', name),
      path.join(__dirname, 'android', 'bin', 'win32-x64', name)
    ];
    const candidates = [String(configured || '').trim(), ...bundled, ...sdkCandidates, name].filter(Boolean);
    return candidates.find((candidate) => candidate === name || fs.existsSync(candidate)) || name;
  };
  androidDeviceManager = new AndroidDeviceManager({
    adbPath: androidBinary(settings.androidAdbPath, process.platform === 'win32' ? 'adb.exe' : 'adb'),
    scrcpyPath: androidBinary(settings.androidScrcpyPath, process.platform === 'win32' ? 'scrcpy.exe' : 'scrcpy'),
    serverPath: androidBinary('', 'scrcpy-server'),
    streamRenderer: settings.androidStreamRenderer || 'tab',
    records: settings.androidDevices,
    onChange: (event) => {
      if (event?.persist || !String(event?.event || '').startsWith('stream') && event?.event !== 'refresh') {
        try { saveSettings({ ...settings, androidDevices: (event?.state?.devices || []).map(({ session, ...record }) => record) }); } catch (error) { addConsoleEntry({ kind: 'android', level: 'warn', message: `Could not persist Android device state: ${error.message}` }); }
      }
      if (event?.event === 'stream' && ['stopped', 'failed'].includes(event?.session?.state) && androidStreamWindow?.serial === event.serial) {
        try { nativeAndroidWindow.detach({ childHandle: androidStreamWindow.childHandle }); } catch {}
        androidStreamWindow = null;
      }
      const streamTab = event?.tabId ? tabs.get(String(event.tabId)) : null;
      if (streamTab?.webContents && !streamTab.webContents.isDestroyed()) {
        try {
          if (event.event === 'stream-meta') streamTab.webContents.send('browser-use:android-stream-meta', event.meta);
          else if (event.event === 'stream-codec-config') streamTab.webContents.send('browser-use:android-stream-codec-config', { ...event.config, data: Uint8Array.from(event.config.data || []) });
          else if (event.event === 'stream-frame') streamTab.webContents.send('browser-use:android-stream-frame', { pts: event.frame.pts, keyFrame: event.frame.keyFrame, data: Uint8Array.from(event.frame.data || []) });
          else if (event.event === 'stream' || event.event === 'stream-error' || event.event === 'stream-started' || event.event === 'stream-stopped') streamTab.webContents.send('browser-use:android-stream-state', { state: event.event === 'stream-error' ? 'failed' : (event.session?.state || event.event.replace('stream-', '')), lastError: event.error || event.session?.lastError || null });
        } catch (error) { addConsoleEntry({ kind: 'android', level: 'warn', message: `Could not deliver Android stream frame: ${error.message}` }); }
      }
      publishState();
      try { liveOverlayWebContents()?.send('browser-use:android-device-event', event); } catch {}
    },
    onConsole: (entry) => addConsoleEntry(entry),
    onStreamTab: ({ serial, title }) => openAndroidStreamTab({ serial, title }),
    onStreamTabClose: (tab) => closeAndroidStreamTab(tab),
    onStreamWindow: ({ serial, title, session, tab }) => embedAndroidStream({ serial, title, tab, bounds: androidStreamBounds })
  });
  if (computerTools) computerTools.androidManager = androidDeviceManager;
  void androidDeviceManager.startPolling().catch((error) => addConsoleEntry({ kind: 'android', level: 'warn', message: `Android device discovery unavailable: ${error.message}` }));
  deviceEmulator = new DeviceEmulator({
    getTabs: () => [...tabs.values()],
    debuggerLeaseManager,
    // Ctrl+Scroll zoom persists per device profile: loaded once here, written
    // back debounced (a wheel gesture emits many events; one disk write lagging
    // 600ms behind the last notch is indistinguishable to the owner).
    initialZooms: settings.deviceZoomByProfile,
    onZoomPersist: (profileId, zoom) => {
      const zooms = { ...(settings.deviceZoomByProfile && typeof settings.deviceZoomByProfile === 'object' ? settings.deviceZoomByProfile : {}), [profileId]: zoom };
      scheduleZoomPersist(zooms);
    }
  });
  browserViewController = new BrowserViewController({
    getTabs: () => [...tabs.values()],
    getSelectedTabId: () => selectedTabId,
    getConsoleEntries: () => [...consoleEntries],
    normalizeUrl,
    createTab: (url, activate = false) => createTab(url || '', activate),
    closeTab: (tabId) => closeTab(String(tabId)),
    isTabPaintable,
    ensureTabPaintable: (tabId) => {
      if (selectedTabId !== tabId) return isTabBackgroundReady(tabId);
      syncBrowserViewVisibility();
      return isTabPaintable(tabId);
    },
    deviceEmulator,
    debuggerLeaseManager,
    // An AGENT-initiated device switch (browser_set_device_mode /
    // browser_rotate_device) must re-measure the stage exactly like the
    // renderer's own device IPC: the fitted device frame, the dark letterbox
    // and the published chrome state all follow from it.
    onDeviceModeChanged: () => {
      layoutSelectedTab();
      scheduleLayout();
      syncBrowserViewVisibility();
      publishState();
    },
    pointerVisualizer: {
      move: (tabId, point, options) => agentPointerOverlay?.move(tabId, point, options) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      press: (tabId, point, button, options) => agentPointerOverlay?.press(tabId, point, button, options) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      cancelPress: (tabId, sequence) => agentPointerOverlay?.cancelPress(tabId, sequence) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      cancelMotion: (tabId, operationId, reason) => agentPointerOverlay?.cancelMotion(tabId, operationId, reason) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      release: (tabId, point, button, options) => agentPointerOverlay?.release(tabId, point, button, options) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      activity: (tabId, point, options) => agentPointerOverlay?.activity(tabId, point, options) || { ignored: true, reason: 'pointer-overlay-not-ready' },
      forgetTab: (tabId) => agentPointerOverlay?.forgetTab(tabId)
    }
  });
  sessionBroker = new SessionBroker({
    installationId: installationId(),
    instanceId: crypto.randomUUID(),
    connectionMode: settings.connectionMode || 'secure',
    onSessionEnded: (sessionId) => {
      desktopMcpServer?.forgetBrokerSession(sessionId);
      browserViewController?.releaseSessionInput(sessionId);
      computerCleanup(computerTools?.releaseOwner(`mcp:${sessionId}`));
      const run = desktopChatAgent?.state();
      if (run?.computerOwner === `mcp:${sessionId}` && ['running', 'awaiting_approval', 'paused'].includes(run.status)) desktopChatAgent.cancel(run.id);
    },
    // Changing tabs releases held input, not the paired host's transport.
    onTabBindingChanged: (sessionId) => browserViewController?.releaseSessionInput(sessionId),
    // Pairing may originate from an HTTP MCP host rather than renderer IPC.
    // Keep the Settings session list current when a host connects over HTTP.
    onStateChanged: () => {
      publishMcpState();
    }
  });
  agentPool = new AgentPool({
    // LORDE_MULTITASK_ECONOMY_V365 â€” the pool cap is the concurrency budget.
    // The field transcript showed a parent spawning 15 workers into a 3-slot
    // pool: hours of queue time, "parallel" slower than serial. Keep the cap
    // small by default; make it deliberate via BROWSER_USE_POOL_CAP (2-8).
    cap: Math.max(2, Math.min(32, Number(process.env.BROWSER_USE_POOL_CAP) || 8)),
    // LORDE_LAUNCH_IDENTITY_V366 â€” the field saw a stale build report 3/3
    // slots while source said 8. Every launch now announces exactly which
    // code and which cap it is running.
    factory: ({ getComputerTools } = {}) => createChatAgent({ computerTools: getComputerTools?.() || null }),
    // BUG FIX: Subagents should NOT involuntarily spawn new tabs.
    // Instead, they share the selected tab (or a designated background tab) for observation.
    // This prevents the "subagent spawns with an involuntary new tab" issue.
    allocateTab: async () => {
      // Return the selected tab ID if available, otherwise use a shared background tab
      const selected = selectedTabId;
      if (selected) {
        return String(selected);
      }
      // Fallback: create a single shared background tab for all subagents
      if (!sharedBackgroundTabId) {
        const summary = tabSummary(createTab('', false));
        sharedBackgroundTabId = summary?.id ? String(summary.id) : null;
      }
      return sharedBackgroundTabId;
    },
    releaseTab: async (tabId) => {
      const tab = tabs.get(String(tabId));
      // A background workspace is closed when its run ends, unless the human
      // selected it or it is already gone.
      if (tab && !tab.webContents.isDestroyed() && String(tabId) !== selectedTabId) {
        try { closeTab(String(tabId)); } catch { /* tab teardown is best effort */ }
      }
    },
    cap: 3,
    lease: desktopLease,
    publish: (event) => {
      broadcastAgentEvent(event);
      if (event.type === 'pool.updated') publishState();
    }
  });
  addConsoleEntry({ kind: 'system', level: 'info', message: `Browser-use desktop starting from ${app.getAppPath()} (electron ${process.versions.electron}) â€” pool cap ${agentPool.cap}${process.env.BROWSER_USE_POOL_CAP ? ' (BROWSER_USE_POOL_CAP)' : ' (default)'}.` });
  agentPool.computerTools = getLeasedComputerTools();
  // Cold-start latency: fork the native helper and probe ripgrep at bridge
  // startup instead of stalling the agent's first pointer action / search.
  computerTools?.warmup?.();
  if (!schedulerStore) schedulerStore = new SchedulerStore(path.join(app.getPath('userData'), 'browser-use-schedules.json'));
  if (!scheduler) {
    scheduler = new Scheduler({
      store: schedulerStore,
      pool: agentPool,
      // Scheduled runs ride the provider selected in the AI settings surface
      // (the same resolution agent-start uses); a job-pinned providerId falls
      // back through its connection. Retries continue the first attempt's
      // checkpointed conversation, loaded from the chat history store.
      resolveProvider: (explicitProviderId) => {
        const pinned = explicitProviderId
          ? (connectionById(explicitProviderId) || normalizedConnections().find((item) => item.provider === explicitProviderId))
          : null;
        if (pinned) return { id: pinned.provider, connectionId: pinned.id, baseUrl: pinned.baseUrl, model: pinned.model };
        const active = activeProviderConfig();
        if (!active) throw new Error('No usable AI provider is configured for scheduled tasks. Choose a provider connection in AI settings.');
        if (active.id === 'ollama' && !active.model) throw new Error('Scheduled tasks need a model: choose one in the Ollama AI settings.');
        return active;
      },
      loadConversation: (conversationId) => chatHistoryStore?.get(String(conversationId || '')) || null,
      publish: (event) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-use:schedule-event', event);
      },
      executeProgrammatic: async (action) => {
        if (action === 'shutdown') {
          setTimeout(() => app.quit(), 0);
          return { status: 'completed', result: { success: true, summary: 'Browser-use is shutting down.' } };
        }
        throw new Error(`Unsupported scheduled programmatic action: ${action}`);
      }
    });
  }
  scheduler.start();
  desktopChatAgent = createChatAgent();
  desktopMcpServer = new LocalMcpServer({
    broker: sessionBroker,
    controller: browserViewController,
    agent: desktopChatAgent,
    getComputerTools,
    getControlMode: () => normalizeControlMode(settings.mcpControlMode),
    workspaceProvider: resolveWorkspaceContract,
    gptKey: settings.gptActionEnabled ? settings.gptApiKey : '',
    port: resolveDesktopMcpPort()
  });
  await desktopMcpServer.start();
}

async function stopDesktopMcp() {
  sessionBroker?.revokeAll();
  if (agentPool) await agentPool.cancelAll('The Browser-use bridge restarted; background runs were cancelled.');
  scheduler?.stop();
  const activeChatRun = desktopChatAgent?.state();
  if (activeChatRun && ['running', 'awaiting_approval', 'paused'].includes(activeChatRun.status)) desktopChatAgent.cancel(activeChatRun.id);
  if (desktopLease.holder) desktopLease.release(desktopLease.holder);
  if (primaryChatWindow && !primaryChatWindow.isDestroyed()) {
    try { primaryChatWindow.removeAllListeners('close'); primaryChatWindow.destroy(); } catch { /* best effort */ }
    primaryChatWindow = null;
  }
  desktopChatAgent = null;
  hcuSession?.close();
  hcuSession = null;
  browserViewController?.releaseAllInput();
  await desktopMcpServer?.stop();
  desktopMcpServer = null;
  sessionBroker = null;
  browserViewController = null;
  // Emulation outlives the MCP server on purpose: the human's chosen device
  // mode must survive a settings save that restarts the bridge.
}

function publishMcpState() {
  const status = { ...desktopMcpStatus(), ...connectionConfiguration() };
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-use:mcp-state', status);
  liveOverlayWebContents()?.send('browser-use:mcp-state', status);
}

function selectedTab() {
  return tabs.get(selectedTabId) || null;
}

function tabSummary(tab) {
  const webContents = tab?.webContents;
  if (!tab || webContents?.isDestroyed?.()) return null;
  return {
    id: tab.id,
    title: tab.title || 'New Tab',
    ...(tab.navigationError ? { navigationError: tab.navigationError } : {}),
    favicon: tab.favicon || null,
    url: isHomeUrl(webContents.getURL() || '') ? '' : webContents.getURL() || '',
    loading: webContents.isLoading(),
    active: String(tab.id) === String(selectedTabId),
    canGoBack: webContents.navigationHistory.canGoBack(),
    canGoForward: webContents.navigationHistory.canGoForward()
  };
}

function currentState(agentOverride = desktopChatAgent, chatWindowId = '') {
  const active = selectedTab();
  const chatEntry = chatWindowId ? chatAgentWindows.get(String(chatWindowId)) : null;
  return {
    tabs: [...tabs.values()].map(tabSummary).filter(Boolean),
    selectedTabId,
    active: tabSummary(active),
    agent: {
      status: agentOverride?.state()?.status || (sessionBroker?.status().sessions.length ? 'mcp-connected' : 'mcp-waiting'),
      detail: agentOverride?.state()?.result?.summary || 'Pair a local Streamable HTTP MCP host to control an explicitly bound Browser-use desktop tab.',
      chat: agentOverride?.state() || null,
      // ChatGPT-style live sessions: handed-off conversations still running.
      liveSessions: [
        ...[...chatSessions.values()].map(instance => liveRunSnapshot(instance)).filter(Boolean),
        ...[...chatAgentWindows.entries()].map(([id, entry], index) => ({ id, title: entry.label || `Chat ${index + 2}`, status: entry.minimized ? 'minimized' : entry.pinned ? 'docked' : entry.window.isMinimized() ? 'minimized' : 'visible', pinned: entry.pinned === true, step: 0, tabId: null }))
      ],
      backgroundRuns: (agentPool?.activeRuns || []).map((entry) => ({
        id: entry.instance?.state?.()?.id || null,
        label: entry.label,
        tabId: entry.tabId,
        status: entry.instance?.state?.()?.status || 'running'
      })),
      residentRuns: [...spawnRegistry.values()].filter(record => record.status === 'resident').map(record => ({ alias: record.alias, label: record.label, task: String(record.task || '').slice(0, 140), tabId: record.tabId, runId: record.runId })),
      // LORDE_SUBAGENT_TABS_V366 â€” the drawer renders one tab per subagent;
      // the roster drives the tab strip and the per-tab status dot.
      subagents: [...spawnRegistry.values()].filter(record => record.status !== 'closed').map(record => ({ alias: record.alias, status: record.status, task: String(record.task || '').slice(0, 140), tabId: record.tabId || null, runId: record.runId || null, model: record.provider?.model || null })),
      queuedRuns: agentPool ? agentPool.queue.length : 0,
      schedules: scheduler ? { jobs: scheduler.status().jobs.length, running: scheduler.status().inFlight.length } : null
    },
    device: selectedTabId && deviceEmulator ? deviceEmulator.state(selectedTabId) : null,
    android: androidDeviceManager?.snapshot() || { selectedSerial: null, devices: [] },
    downloads: downloadsSnapshot(),
    recording: sharedDesktopCapture?.snapshotFor?.('ui-recorder') || { state: 'idle' },
    downloadsOpen,
    downloadsAnchor,
    deviceProfiles: listDeviceProfiles(),
    terminal: mainWindow && !mainWindow.isDestroyed() ? terminalLayout() : null,
    activeDrawer: chatWindowId ? 'agent' : activeDrawer,
    primaryAgentPinned,
    chatWindowId: chatWindowId || null,
    chatWindowLabel: chatWindowId ? (chatEntry?.label || `Chat ${[...chatAgentWindows.keys()].indexOf(String(chatWindowId)) + 2}`) : null,
    chatWindowPinned: chatWindowId ? chatEntry?.pinned === true : primaryAgentPinned,
    chatDock: chatDockMetrics(),
    deviceMenuOpen,
    previewOpen: Boolean(activePreview),
    about: aboutOpen ? aboutSnapshot() : null,
    deviceMenuAnchor,
    historyMenuOpen,
    historyMenuAnchor,
    historyMenuEntries,
    settings: publicSettings()
  };
}

// IPC payloads must be structured-cloneable. Electron logs "Failed to
// serialize arguments" on a bad send EVEN WHEN CAUGHT, so probe first and fall
// back to a JSON-safe projection. Every send of a live state blob goes through
// here — a raw .send(currentState()) is what produced the serialize errors.
function ipcJsonProjection(payload) {
  // Electron structured-clone supports the same object reference appearing in
  // multiple fields. JSON.stringify's WeakSet does not: it calls the second
  // legitimate shared reference "[Circular]", which poisoned tool cards and
  // made renderer consumers treat successful results as missing. Track only
  // ancestors on the active recursion path, so aliases are preserved while
  // true cycles are still replaced safely.
  const ancestors = [];
  const project = (value) => {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'function' || typeof value === 'symbol') return undefined;
    if (typeof value === 'bigint') return String(value);
    if (value instanceof Error) return { message: value.message, name: value.name };
    if (!value || typeof value !== 'object') return value;
    if (ancestors.includes(value)) return '[Circular]';
    ancestors.push(value);
    let output;
    if (Array.isArray(value)) {
      output = value.map(project);
    } else {
      output = {};
      for (const [key, item] of Object.entries(value)) {
        const next = project(item);
        if (next !== undefined) output[key] = next;
      }
    }
    ancestors.pop();
    return output;
  };
  return project(payload);
}

function safeIpcValue(payload, fallback = null) {
  try { return ipcJsonProjection(payload); } catch (_) { return fallback; }
}

function safeIpcSend(contents, channel, payload) {
  if (!contents || typeof contents.send !== 'function') return;
  // Always send the JSON projection. Node's structuredClone accepts values
  // that Electron's renderer bridge still rejects, so probing first is not a
  // sufficient guarantee and was the source of the remaining cancel errors.
  try { contents.send(channel, safeIpcValue(payload)); } catch (_) { /* drop frame */ }
}

function publishState() {
  const state = currentState();
  const safeSend = safeIpcSend;
  if (mainWindow && !mainWindow.isDestroyed()) safeSend(mainWindow.webContents, 'browser-use:state', state);
  if (primaryChatWindow && !primaryChatWindow.isDestroyed()) safeSend(primaryChatWindow.webContents, 'browser-use:state', state);
  for (const [id, entry] of chatAgentWindows) {
    const state = currentState(entry.instance || desktopChatAgent, id);
    const targets = [entry.window?.webContents, entry.dockView?.webContents];
    const sentContents = new Set();
    for (const contents of targets) {
      if (!contents || contents.isDestroyed?.() || sentContents.has(contents)) continue;
      sentContents.add(contents);
      safeSend(contents, 'browser-use:state', state);
    }
  }
  // BrowserViews are separate renderers. Sending the same state directly to
  // the overlay avoids relying on the main renderer to relay it after native
  // z-order changes; that relay is what left the overlay transparent while the
  // page continued to paint above it.
  { const ov = liveOverlayWebContents(); if (ov) safeSend(ov, 'browser-use:overlay-state', state); }
}

// Width drags must not rebuild every transcript and control in every chat.
// Geometry is a separate, small signal so the main renderer can move Chat 1's
// right edge while Chat 2/3 are being resized without waiting for a click or
// a settled full-state publication.
function publishChatDockGeometry() {
  const geometry = chatDockMetrics();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-use:chat-dock-geometry', geometry);
  for (const entry of chatAgentWindows.values()) {
    const contents = entry.dockView?.webContents;
    if (contents && !contents.isDestroyed?.()) contents.send('browser-use:chat-dock-geometry', geometry);
  }
  return geometry;
}

function publishConsole() {
  liveOverlayWebContents()?.send('browser-use:console', consoleEntries);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-use:console', consoleEntries);
}

function addConsoleEntry(entry) {
  consoleEntries.unshift({ id: `${Date.now()}-${consoleEntries.length}`, time: new Date().toISOString(), ...entry });
  consoleEntries.splice(200);
  publishConsole();
}

// Laya full model (optional, USER-CONSENT gated): nothing provisions
// automatically. The settings-panel dialogue calls laya-status to show which
// dependencies are detected; its download button only becomes clickable when
// every dependency is present, and that click is the consent. Until the
// sidecar is healthy, and after any failure, the bundled engine answers.
let layaRuntime = null;
function getLayaRuntime() {
  if (!layaRuntime) {
    const { createLayaRuntime } = require('./agent/layaRuntime.cjs');
    layaRuntime = createLayaRuntime({
      endpoint: 'http://127.0.0.1:8765',
      // Laya stays wanted while the verify toggle is on or standalone mode is
      // active; a crashed sidecar restarts itself (bounded) until app restart.
      autoStartAllowed: () => Boolean(settings.layaEnabled) || settings.providerEnabled === false,
      log: (message) => addConsoleEntry({ kind: 'agent', level: 'info', message })
    });
  }
  return layaRuntime;
}
ipcMain.handle('browser-use:textvision', async (_event, request) => {
  try {
    const tv = require('../textvision/lib/format');
    const png = require('../textvision/lib/png');
    const img = png.decodeImage(require('fs').readFileSync(String(request?.path || '')));
    if (request?.region) return { ok: true, result: tv.inspect(img, request.region, request.grid || 8) };
    return { ok: true, result: tv.encode(img, String(request?.mode || 'standard')) };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
});
ipcMain.handle('browser-use:laya-status', async () => {
  const runtime = getLayaRuntime();
  const deps = await runtime.checkDependencies().catch((error) => ({ checks: [{ name: 'Detection', ok: false, detail: String(error?.message || error).slice(0, 200) }], allOk: false, serverReady: false, installCommand: '' }));
  return { ...deps, runtime: runtime.status(), canDownload: deps.allOk && !deps.serverReady };
});
ipcMain.handle('browser-use:laya-stop', () => {
  const runtime = getLayaRuntime();
  runtime.stop();
  // Stopped model: route Laya traffic back to the bundled engine.
  if (settings.layaEndpoint) {
    try { saveSettings({ ...settings, layaEndpoint: '' }); } catch { }
  }
  return { ok: true };
});
ipcMain.handle('browser-use:laya-install', async () => {
  const runtime = getLayaRuntime();
  const deps = await runtime.checkDependencies().catch(() => null);
  if (!deps?.allOk) return { ok: false, reason: 'Dependencies are missing, the download stays locked until they are detected.' };
  const result = await runtime.ensure();
  // Consent fulfilled and the model is healthy: route Laya traffic to it.
  if (result.ok && settings.layaEndpoint !== 'http://127.0.0.1:8765') {
    try { saveSettings({ ...settings, layaEndpoint: 'http://127.0.0.1:8765' }); } catch { }
  }
  return result;
});

function isAttached(tab) {
  return Boolean(mainWindow && mainWindow.getBrowserViews().includes(tab.view));
}

// A tab only produces compositor frames while it is attached to a window.
// Agent-created background tabs were never attached, so capturePage() and CDP
// Page.captureScreenshot hung until the lease reset on every observation â€”
// the run looked asleep for minutes. Attach them COVERED: the view joins the
// window's compositing tree (frames flow, background capture works) while the
// human's selected view and the overlay stay explicitly on top.
function attachBackgroundViewForCapture(tab) {
  if (!mainWindow || mainWindow.isDestroyed() || !tab || tab.webContents.isDestroyed?.() || isAttached(tab)) return;
  const selected = selectedTab();
  attachBrowserView(mainWindow, tab.view);
  // Stage bounds â€” the same surface contract the selected tab lives under.
  // The historical full-window bounds covered the titlebar, toolbar and agent
  // drawer with the new view's unpainted (white) surface until its renderer
  // booted and dom-ready re-ran layout: the agent tab creation flashed the
  // whole chrome white for as long as the page took to load. The stage strip
  // is fully covered by the human's selected view, so nothing shows through.
  setViewBoundsIfChanged(tab.view, viewportBoundsFor(tab.id));
  // With device emulation active on the selected tab, the dark letterbox must
  // sit back on top of this newly attached background view (below the
  // selected view), or the bezel would show this view's page instead.
  const letterboxAttached = deviceLetterboxView && !deviceLetterboxView.webContents.isDestroyed() && mainWindow.getBrowserViews().includes(deviceLetterboxView);
  if (letterboxAttached) {
    detachBrowserView(mainWindow, deviceLetterboxView);
    attachBrowserView(mainWindow, deviceLetterboxView);
  }
  if (selected && selected.view && !selected.view.webContents.isDestroyed() && isAttached(selected)) {
    try { mainWindow.setTopBrowserView(selected.view); } catch { /* z-order best effort */ }
  }
  // The selected view was raised above a visible zoom badge; restore it (the
  // overlay reorder below still finishes topmost).
  restackDeviceZoomBadge();
  // The overlay chrome must stay the topmost view â€” mirror the showTab pattern
  // (remove + re-add) so the covered background view never covers the UI.
  if (overlayView && !overlayView.webContents.isDestroyed()) {
    detachBrowserView(mainWindow, overlayView);
    attachBrowserView(mainWindow, overlayView);
  }
}

// Dark letterbox behind an emulated selected tab. Attached background tab
// views paint above the window's own renderer DOM, so with device mode active
// they showed through the bezel around the device frame (the bezel displayed
// a background tab's desktop-rendered page instead of dark chrome). A
// solid-dark BrowserView stacked between the background views and the
// selected view restores the dark bezel without shrinking any capture
// surface. Live evidence: output/desktop-bugfix-20261012/23 (white bezel with
// a background tab attached) vs 24 (dark bezel once it is closed).
let deviceLetterboxView = null;
function deviceLetterboxActive() {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && selectedTabId && deviceEmulator?.viewportFor(String(selectedTabId)));
}

function ensureDeviceLetterboxView() {
  if (deviceLetterboxView && !deviceLetterboxView.webContents.isDestroyed()) return deviceLetterboxView;
  deviceLetterboxView = new BrowserView({ webPreferences: { sandbox: true, backgroundThrottling: true } });
  deviceLetterboxView.setBackgroundColor('#060b0d');
  // A real document guarantees the view composites (an empty webContents may
  // never produce a frame). The document paints the chrome color itself AND
  // carries a recognizable URL so tests and probes can tell the letterbox
  // apart from a real tab view ("about:blank" would be ambiguous).
  const letterboxUrl = 'data:text/html,%3Ctitle%3Ebrowser-use-letterbox%3C%2Ftitle%3E%3Cbody%20style%3D%22margin%3A0%3Bbackground%3A%23060b0d%22%3E';
  deviceLetterboxView.webContents.loadURL(letterboxUrl).catch(() => {});
  return deviceLetterboxView;
}

function syncDeviceLetterbox() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const active = deviceLetterboxActive();
  const attached = Boolean(deviceLetterboxView && !deviceLetterboxView.webContents.isDestroyed() && mainWindow.getBrowserViews().includes(deviceLetterboxView));
  const selected = selectedTab();
  if (active && !attached) {
    ensureDeviceLetterboxView();
    // Stack it directly below the selected view: every already-attached
    // background tab view stays below it, and re-adding the selected view
    // last keeps the device frame on top. The overlay reorder further down
    // in syncBrowserViewVisibility then restores the overlay as topmost.
    if (selected && isAttached(selected)) detachBrowserView(mainWindow, selected.view);
    attachBrowserView(mainWindow, deviceLetterboxView);
    if (selected && !selected.view.webContents.isDestroyed()) attachBrowserView(mainWindow, selected.view);
    // The selected view was re-added ABOVE a visible zoom badge â€” restore the
    // badge to the top of the device stack (the overlay reorder below still
    // finishes above it).
    restackDeviceZoomBadge();
    overlayStackDirty = true;
  } else if (!active && attached) {
    detachBrowserView(mainWindow, deviceLetterboxView);
  }
  if (deviceLetterboxView && !deviceLetterboxView.webContents.isDestroyed()) {
    setViewBoundsIfChanged(deviceLetterboxView, active ? stageBounds() : { x: 0, y: 0, width: 0, height: 0 });
  }
}

// DEVICE CANVAS ZOOM indicator. A small pill BrowserView floating over the
// device frame's top-right corner while a Ctrl+Scroll gesture is changing the
// zoom. It is chrome (a separate view), never page content, so agent
// screenshots and element reads are untouched. Lifecycle: show on every zoom
// change, fade after 2s, then 0x0 â€” a hidden badge never intercepts input.
const ZOOM_BADGE_WIDTH = 92;
const ZOOM_BADGE_HEIGHT = 30;
const ZOOM_BADGE_FADE_AFTER_MS = 2000;
const ZOOM_BADGE_FADE_MS = 300;
let deviceZoomBadgeView = null;
let zoomBadgeShowing = false;
let zoomBadgeFadeTimer = null;
let zoomBadgeHideTimer = null;

function ensureDeviceZoomBadgeView() {
  if (deviceZoomBadgeView && !deviceZoomBadgeView.webContents.isDestroyed()) return deviceZoomBadgeView;
  deviceZoomBadgeView = new BrowserView({ webPreferences: { sandbox: true, backgroundThrottling: true } });
  deviceZoomBadgeView.setBackgroundColor('#101820');
  const badgeUrl = 'data:text/html,%3Ctitle%3Ebrowser-use-zoom-badge%3C%2Ftitle%3E%3Cstyle%3E'
    + 'html,body%7Bmargin%3A0%3Bheight%3A100%25%3Boverflow%3Ahidden%3Bbackground%3A%23101820%7D'
    + '%23badge%7Bbox-sizing%3Aborder-box%3Bwidth%3A100%25%3Bheight%3A100%25%3Bdisplay%3Aflex%3Balign-items%3Acenter%3Bjustify-content%3Acenter%3B'
    + 'border%3A1px%20solid%20%23263a44%3Bborder-radius%3A8px%3Bcolor%3A%23a7e34d%3Bfont%3A600%2013px%2F1%20system-ui%2Csans-serif%3B'
    + 'opacity%3A0%3Btransition%3Aopacity%20300ms%20ease%3B%7D'
    + '%23badge.show%7Bopacity%3A1%7D'
    + '%3C%2Fstyle%3E%3Cdiv%20id%3D%22badge%22%3E100%25%3C%2Fdiv%3E%3Cscript%3E'
    + 'window.__zoomBadge%3D%7Bset(text)%7Bconst%20el%3Ddocument.getElementById(%22badge%22)%3B'
    + 'el.textContent%3Dtext%3Bel.classList.add(%22show%22)%3B%7D%2C'
    + 'fade()%7Bdocument.getElementById(%22badge%22).classList.remove(%22show%22)%3B%7D%7D%3B'
    + '%3C%2Fscript%3E';
  deviceZoomBadgeView.webContents.loadURL(badgeUrl).catch(() => {});
  return deviceZoomBadgeView;
}

// The pill sits just inside the device frame's top-right corner, clamped into
// the stage so a 300% frame that overflows the window can never push the badge
// off-screen or over the chrome above the stage.
function zoomBadgeBounds() {
  const stage = stageBounds();
  const frame = viewportBoundsFor(selectedTabId);
  const x = Math.min(Math.max(frame.x + frame.width - ZOOM_BADGE_WIDTH - 10, stage.x + 8), Math.max(stage.x + 8, stage.x + stage.width - ZOOM_BADGE_WIDTH - 8));
  return { x, y: stage.y + 12, width: ZOOM_BADGE_WIDTH, height: ZOOM_BADGE_HEIGHT };
}

function hideDeviceZoomBadge() {
  if (zoomBadgeFadeTimer) { clearTimeout(zoomBadgeFadeTimer); zoomBadgeFadeTimer = null; }
  if (zoomBadgeHideTimer) { clearTimeout(zoomBadgeHideTimer); zoomBadgeHideTimer = null; }
  if (!zoomBadgeShowing) return;
  zoomBadgeShowing = false;
  if (deviceZoomBadgeView && !deviceZoomBadgeView.webContents.isDestroyed() && mainWindow && !mainWindow.isDestroyed() && mainWindow.getBrowserViews().includes(deviceZoomBadgeView)) {
    detachBrowserView(mainWindow, deviceZoomBadgeView);
  }
}

function showDeviceZoomBadge(tabId, zoom) {
  if (!mainWindow || mainWindow.isDestroyed() || String(tabId) !== String(selectedTabId)) return;
  if (!deviceEmulator?.viewportFor(String(tabId))) return;
  ensureDeviceZoomBadgeView();
  const bounds = zoomBadgeBounds();
  const attached = mainWindow.getBrowserViews().includes(deviceZoomBadgeView);
  if (!attached) {
    // Attaching last puts the badge above the device view; the overlay chrome
    // re-adds itself on its own visibility transitions and stays topmost.
    attachBrowserView(mainWindow, deviceZoomBadgeView);
  }
  setViewBoundsIfChanged(deviceZoomBadgeView, bounds);
  zoomBadgeShowing = true;
  const percent = `${Math.round(zoom * 100)}%`;
  deviceZoomBadgeView.webContents.executeJavaScript(`window.__zoomBadge && window.__zoomBadge.set(${JSON.stringify(percent)})`, true).catch(() => {});
  if (zoomBadgeFadeTimer) clearTimeout(zoomBadgeFadeTimer);
  if (zoomBadgeHideTimer) clearTimeout(zoomBadgeHideTimer);
  zoomBadgeFadeTimer = setTimeout(() => {
    zoomBadgeFadeTimer = null;
    if (deviceZoomBadgeView && !deviceZoomBadgeView.webContents.isDestroyed()) {
      deviceZoomBadgeView.webContents.executeJavaScript('window.__zoomBadge && window.__zoomBadge.fade()', true).catch(() => {});
    }
  }, ZOOM_BADGE_FADE_AFTER_MS);
  if (typeof zoomBadgeFadeTimer.unref === 'function') zoomBadgeFadeTimer.unref();
  zoomBadgeHideTimer = setTimeout(() => {
    zoomBadgeHideTimer = null;
    hideDeviceZoomBadge();
  }, ZOOM_BADGE_FADE_AFTER_MS + ZOOM_BADGE_FADE_MS + 50);
  if (typeof zoomBadgeHideTimer.unref === 'function') zoomBadgeHideTimer.unref();
}

// A visible badge must stay above the device frame. When the letterbox sync or
// a background-view attach re-adds the selected view (which lands it above the
// badge), this restores the badge to the top of the device stack; the overlay
// chrome re-adds itself after and stays topmost. No-op when nothing is showing.
function restackDeviceZoomBadge() {
  if (!zoomBadgeShowing || !deviceZoomBadgeView || deviceZoomBadgeView.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.getBrowserViews().includes(deviceZoomBadgeView)) return;
  detachBrowserView(mainWindow, deviceZoomBadgeView);
  attachBrowserView(mainWindow, deviceZoomBadgeView);
}

// One Ctrl+Scroll notch from the page watcher. Wheel events stream at input
// frequency (a fast wheel or trackpad emits dozens per second), so steps are
// debounced: one zoom notch per 120ms feels like the discrete notches the
// owner turns, and tames smooth-scrolling devices.
const ZOOM_WHEEL_DEBOUNCE_MS = 120;
const zoomWheelLastApplied = new Map();
function handleDeviceZoomWheel(tabId, direction) {
  if (!deviceEmulator || !deviceEmulator.viewportFor(String(tabId))) return;
  const key = String(tabId);
  const now = Date.now();
  if (now - (zoomWheelLastApplied.get(key) || 0) < ZOOM_WHEEL_DEBOUNCE_MS) return;
  zoomWheelLastApplied.set(key, now);
  try {
    const result = deviceEmulator.zoomBy(key, direction);
    if (result.changed) {
      layoutSelectedTab();
      scheduleLayout();
      showDeviceZoomBadge(tabId, result.zoom);
    }
  } catch {
    // Device mode may have ended mid-gesture; the next event re-checks.
  }
}

// Window resizes and terminal toggles move the stage (and with it the device
// frame) without a zoom gesture, so an already-visible badge re-anchors here.
function syncDeviceZoomBadge() {
  if (!zoomBadgeShowing || !deviceZoomBadgeView || deviceZoomBadgeView.webContents.isDestroyed()) return;
  if (!mainWindow || mainWindow.isDestroyed() || !deviceEmulator?.viewportFor(String(selectedTabId))) {
    hideDeviceZoomBadge();
    return;
  }
  setViewBoundsIfChanged(deviceZoomBadgeView, zoomBadgeBounds());
}

// A tab only produces compositor frames while it is attached and the window is
// neither minimised nor destroyed. Capture callers need this to fail fast instead
// of awaiting a frame that will never arrive.
function isTabPaintable(tabId) {
  const tab = tabs.get(tabId);
  if (!tab || tab.webContents.isDestroyed()) return false;
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  // A background tab is intentionally not compositor-visible, but it remains a
  // fully laid-out renderer and is paintable through its debugger surface.
  return isAttached(tab) && mainWindow.isVisible() && !mainWindow.isMinimized();
}

function isTabBackgroundReady(tabId) {
  const tab = tabs.get(String(tabId));
  if (!tab || tab.webContents.isDestroyed() || !mainWindow || mainWindow.isDestroyed()) return false;
  const bounds = tab.view.getBounds();
  return Number(bounds.width) > 0 && Number(bounds.height) > 0;
}

// The area between the chrome and the docked terminal. Everything the page can
// occupy is measured from here, so the terminal and a device frame cannot
// disagree about how much room is left.
function stageBounds() {
  const [width, height] = mainWindow.getContentSize();
  const dock = terminalDocked ? clampTerminalHeight(terminalHeight, height) : 0;
  // The native BrowserView always paints above the BrowserWindow renderer. Agent
  // chat therefore owns a real right-hand strip instead of trying to overlap it.
  const reservedAgentDrawerWidth = Math.min(chatDockMetrics().totalWidth, Math.max(0, width - 180));
  const next = {
    x: 0,
    y: APP_CHROME_HEIGHT,
    width: Math.max(0, width - reservedAgentDrawerWidth),
    height: Math.max(0, height - APP_CHROME_HEIGHT - dock)
  };
  if (next.width > 0 && next.height > 0) lastNonzeroStageBounds = next;
  return next.width > 0 && next.height > 0 ? next : (lastNonzeroStageBounds || next);
}

// A device profile shrinks the native surface to the emulated CSS viewport and
// centres it, so the page is bounded by the device rather than the window and
// the letterbox around it reads as the device's bezel. Without this the page
// would report a phone viewport while painting across a desktop-width surface.
function viewportBoundsFor(tabId) {
  const stage = stageBounds();
  const viewport = tabId ? deviceEmulator?.viewportFor(String(tabId)) : null;
  if (!viewport) return stage;
  const fitted = deviceEmulator?.displayViewportFor(String(tabId), stage.width, stage.height);
  if (!fitted) return stage;
  const width = fitted.width;
  const height = fitted.height;
  return {
    x: stage.x + Math.max(0, Math.round((stage.width - width) / 2)),
    y: stage.y + Math.max(0, Math.round((stage.height - height) / 2)),
    width,
    height
  };
}

function viewportBounds() {
  return viewportBoundsFor(selectedTabId);
}

function claudeCodeMcpInstallCommand(endpoint, authenticationEndpoint) {
  const url = String(endpoint || '');
  const authenticationUrl = String(authenticationEndpoint || '');
  if (!/^http:\/\/127\.0\.0\.1:\d+\/mcp$/.test(url)) throw new Error('Claude Code requires the active local Desktop MCP endpoint.');
  if (authenticationUrl !== `${url}/authenticate`) throw new Error('Claude Code requires the active local Desktop MCP authentication endpoint.');
  const definition = JSON.stringify({
    type: 'http',
    url,
    headersHelper: `curl.exe -fsS --max-time 5 ${authenticationUrl}`
  });
  // Escaped double quotes survive cmd.exe, Git Bash, and PowerShell 7 native
  // argument passing intact. The earlier PowerShell-only `--%` stop-parsing
  // token reached the Claude CLI as a literal, invalid argument in every
  // other shell, so it is no longer copied.
  const escapedDefinition = definition.replaceAll('"', '\\"');
  return `claude mcp add-json --scope user browser-use-desktop "${escapedDefinition}"`;
}

function pointerViewportBounds(tabId) {
  const tab = tabs.get(String(tabId));
  const nativeOverlayVisible = ['settings', 'console', 'recorder'].includes(activeDrawer) || deviceMenuOpen || historyMenuOpen || downloadsOpen || aboutOpen || Boolean(activePreview);
  if (!tab || tab.id !== selectedTabId || nativeOverlayVisible) return null;
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || !mainWindow.isVisible()) return null;
  if (tab.webContents.isDestroyed() || !isAttached(tab)) return null;
  return tab.view.getBounds();
}

function clampTerminalHeight(value, contentHeight) {
  const available = Math.max(0, (contentHeight ?? mainWindow?.getContentSize()[1] ?? 0) - APP_CHROME_HEIGHT);
  const ceiling = Math.max(MIN_TERMINAL_HEIGHT, Math.floor(available * MAX_TERMINAL_HEIGHT_RATIO));
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return MIN_TERMINAL_HEIGHT;
  return Math.min(ceiling, Math.max(MIN_TERMINAL_HEIGHT, Math.round(numeric)));
}

// The renderer draws the terminal into the strip the native view leaves free,
// so it needs the same numbers the layout used.
function terminalLayout() {
  const [, contentHeight] = mainWindow?.getContentSize() || [0, 0];
  return {
    docked: terminalDocked,
    detached: Boolean(terminalDetachedWindow && !terminalDetachedWindow.isDestroyed()),
    height: terminalDocked ? clampTerminalHeight(terminalHeight, contentHeight) : 0,
    minHeight: MIN_TERMINAL_HEIGHT,
    maxHeight: Math.max(MIN_TERMINAL_HEIGHT, Math.floor(Math.max(0, contentHeight - APP_CHROME_HEIGHT) * MAX_TERMINAL_HEIGHT_RATIO)),
    activeSession: activeTerminalSessionId ? terminalManager?.snapshot(activeTerminalSessionId) || null : null
  };
}

// Electron never resizes a BrowserView to match renderer chrome on its own, and
// setAutoResize() leaves the native surface holding stale width/height after a
// window transition, which crops pages at the left and bottom edges. Main-process
// bounds are the only authority, so every geometry change recomputes them here.
function setViewBoundsIfChanged(view, bounds) {
  if (!view || !bounds) return false;
  const current = view.getBounds();
  const changed = ['x', 'y', 'width', 'height'].some((key) => current[key] !== bounds[key]);
  if (changed) view.setBounds(bounds);
  return changed;
}

function layoutSelectedTab() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // All managed tabs keep a live nonzero surface. Only the selected tab is
  // attached to the visible window, but background agents use the same bounds
  // contract through CDP without waiting for a human focus change.
  layoutChatDockViews();
  const stage = stageBounds();
  for (const tab of tabs.values()) {
    if (!tab || tab.webContents.isDestroyed()) continue;
    if (deviceEmulator?.viewportFor(tab.id)) {
      void deviceEmulator.fitViewport(tab.id, stage.width, stage.height).catch(() => {});
    }
    setViewBoundsIfChanged(tab.view, viewportBoundsFor(tab.id));
  }
  // Keep the native compatibility fallback over the selected stream tab's
  // BrowserView bounds; it never uses the Settings Devices rectangle.
  if (androidStreamWindow?.embedded && androidStreamWindow.tabId) {
    const streamTab = tabs.get(String(androidStreamWindow.tabId));
    if (streamTab?.view) { const streamBounds = streamTab.view.getBounds(); setAndroidStreamBounds(streamBounds); }
  }
  // The letterbox tracks the stage on every layout (window resizes re-run
  // layoutSelectedTab without a visibility transition).
  if (deviceLetterboxView && !deviceLetterboxView.webContents.isDestroyed() && deviceLetterboxActive()) {
    setViewBoundsIfChanged(deviceLetterboxView, stage);
  }
  // An already-visible zoom badge re-anchors to the moved device frame; a
  // device mode that just turned off hides it here.
  syncDeviceZoomBadge();
  agentPointerOverlay?.syncBounds();
}

// Windows settles a window's content size after the shell has already reported its
// geometry, and that settle emits no further event. A view laid out against the
// pre-settle size keeps stale bounds and crops the page, so confirm the applied
// bounds still match the window and re-apply across a few frames until they agree.
// setImmediate alone resolves inside the same tick, long before the shell settles.
const LAYOUT_SETTLE_DELAYS_MS = [0, 16, 50, 120, 250, 500];

function boundsAreCurrent() {
  const tab = selectedTab();
  if (!tab || !mainWindow || mainWindow.isDestroyed()) return true;
  if (tab.webContents.isDestroyed() || !isAttached(tab)) return true;
  const applied = tab.view.getBounds();
  const target = viewportBounds();
  return ['x', 'y', 'width', 'height'].every((key) => applied[key] === target[key]);
}

// Matching bounds are not proof the layout is right. Before a window settles,
// getContentSize() over-reports the drawable area, so the computed bounds and the
// window agree with each other while both exceed what the shell will actually show
// and the page paints past the bottom edge. Keep re-reading until the reported size
// repeats, so a late correction is followed rather than latched.
function scheduleLayout() {
  if (pendingLayout) return;
  pendingLayout = true;
  let index = 0;
  let stableFor = 0;
  let lastSignature = '';
  const runPass = () => {
    layoutSelectedTab();
    layoutOverlayView();
    safeIpcSend(liveOverlayWebContents(), 'browser-use:overlay-state', currentState());
    const signature = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getContentSize().join('x') : '';
    stableFor = signature === lastSignature ? stableFor + 1 : 0;
    // LORDE_OVERLAY_CHURN_GUARD_V365 â€” dirty only on a REAL size change, not
    // on every layout pass (the settle loop runs this many times per resize;
    // marking here re-churned addBrowserView and leaked its internal
    // 'closed' listeners again).
    // LORDE_OVERLAY_RESIZE_CHURN_V370 â€” a size change does NOT reorder views.
    // Native stacking order comes from attachment order, so marking the
    // overlay stack dirty on every resize only tore the overlay's widget host
    // down and rebuilt it (one Chromium "Message rejected by
    // blink.mojom.WidgetHost" per pass) for a reorder that was never needed.
    // The stack only needs rebuilding when another view was attached above the
    // overlay, which is flagged at the attach sites themselves.
    lastSignature = signature;
    index += 1;
    const settled = stableFor >= 2 && boundsAreCurrent();
    if (index >= LAYOUT_SETTLE_DELAYS_MS.length || settled) {
      pendingLayout = false;
      return;
    }
    const timer = setTimeout(runPass, LAYOUT_SETTLE_DELAYS_MS[index]);
    if (typeof timer.unref === 'function') timer.unref();
  };
  setImmediate(runPass);
}

// The window's own renderer measures the drawable area the shell really granted,
// which is authoritative when getContentSize() has not settled. Nudging the window
// by a pixel and back forces Electron to re-read its frame, after which the
// reported content size and the visible area agree.
function reconcileWindowContentSize() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
  if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
  const [width, height] = mainWindow.getContentSize();
  mainWindow.setContentSize(width, height + 1);
  mainWindow.setContentSize(width, height);
  scheduleLayout();
}

// LORDE_OVERLAY_CHURN_GUARD_V365 â€” set by real layout/attach transitions;
// consumed by the overlay reorder in syncBrowserViewVisibility.
let overlayStackDirty = true;
function syncBrowserViewVisibility() {
  const tab = selectedTab();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!liveOverlayWebContents()) createOverlayView();
  if (tab && !tab.webContents.isDestroyed() && !isAttached(tab)) { attachBrowserView(mainWindow, tab.view); overlayStackDirty = true; }
  // Device-mode letterbox must establish its stacking position BEFORE the
  // overlay reorder below, so an open overlay (device menu, drawers) is
  // re-added on top of the letterbox.
  syncDeviceLetterbox();
  // Re-establish native stacking only for attach/detach transitions. Resize
  // frames use layoutSelectedTab() directly and never churn BrowserViews.
  syncChatDockViews({ reorder: true });
  if (overlayView && liveOverlayWebContents()) {
    const overlayVisible = ['settings', 'console', 'recorder'].includes(activeDrawer) || deviceMenuOpen || historyMenuOpen || downloadsOpen || aboutOpen || Boolean(activePreview);
    const overlayAttached = mainWindow.getBrowserViews().includes(overlayView);

    if (overlayVisible && overlayAttached) {
      // BrowserView.setTopBrowserView is unreliable after a view was resized to
      // 0x0 on Windows: Chromium can retain the page surface above it even when
      // the overlay has visible, correctly-rendered controls. Re-adding the
      // overlay last establishes native compositing order unambiguously.
      // LORDE_OVERLAY_CHURN_GUARD_V365 â€” Electron attaches an internal
      // 'closed' cleanup listener on every addBrowserView, so re-adding on
      // EVERY sync piled listeners onto mainWindow until the max-listeners
      // warning fired. Reorder only after a real layout change.
      // LORDE_BROWSERVIEW_CLOSED_LEAK_V370 â€” attachBrowserView/detachBrowserView
      // now drop that listener as the view leaves the window, so the reorder
      // below no longer grows mainWindow's listener list.
      if (overlayStackDirty) {
        detachBrowserView(mainWindow, overlayView);
        attachBrowserView(mainWindow, overlayView);
        overlayStackDirty = false;
      }
    } else if (overlayVisible && !overlayAttached) {
      attachBrowserView(mainWindow, overlayView);
    } else if (!overlayVisible && overlayAttached) {
      // A closed overlay cannot intercept page input. Remove it rather than
      // leaving a transparent native surface above the browsing view.
      detachBrowserView(mainWindow, overlayView);
    }
  }
  layoutSelectedTab();
  layoutOverlayView();
  // layoutOverlayView must run before this call: it gives a just-attached
  // overlay non-zero bounds before Windows commits z-order.
  if (overlayView && liveOverlayWebContents() && (['settings', 'console', 'recorder'].includes(activeDrawer) || deviceMenuOpen || historyMenuOpen || downloadsOpen || aboutOpen || activePreview) && mainWindow.getBrowserViews().includes(overlayView)) {
    mainWindow.setTopBrowserView(overlayView);
  }
  agentPointerOverlay?.setSelectedTab(selectedTabId);
  agentPointerOverlay?.syncBounds();
  scheduleLayout();
}

function setActiveDrawer(nextDrawer) {
  if (nextDrawer !== null && !['settings', 'console', 'recorder', 'agent'].includes(nextDrawer)) throw new Error('Unknown drawer');
  activeDrawer = nextDrawer;
  downloadsOpen = false;
  deviceMenuOpen = false;
  historyMenuOpen = false;
  syncBrowserViewVisibility();
  publishState();
  return { activeDrawer };
}

function sanitizeDeviceMenuAnchor(anchor) {
  if (!anchor || typeof anchor !== 'object') return deviceMenuAnchor;
  const [contentWidth] = mainWindow?.getContentSize() || [0];
  const left = Number(anchor.left);
  const top = Number(anchor.top);
  const width = Number(anchor.width);
  if (!Number.isFinite(left) || !Number.isFinite(top)) return deviceMenuAnchor;
  return {
    left: Math.max(8, Math.min(Math.max(8, contentWidth - 228), Math.round(left))),
    top: Math.max(0, Math.round(top)),
    width: Number.isFinite(width) ? Math.max(1, Math.round(width)) : 28
  };
}

function setDeviceMenuOpen(open, anchor) {
  if (anchor) deviceMenuAnchor = sanitizeDeviceMenuAnchor(anchor);
  deviceMenuOpen = typeof open === 'boolean' ? open : !deviceMenuOpen;
  if (deviceMenuOpen) { downloadsOpen = false; historyMenuOpen = false; }
  syncBrowserViewVisibility();
  publishState();
  return { deviceMenuOpen, deviceMenuAnchor };
}

function setDownloadsOpen(open, anchor) {
  if (anchor) downloadsAnchor = sanitizeDeviceMenuAnchor(anchor);
  downloadsOpen = typeof open === 'boolean' ? open : !downloadsOpen;
  if (downloadsOpen) { deviceMenuOpen = false; historyMenuOpen = false; }
  syncBrowserViewVisibility();
  publishState();
  return { downloadsOpen, downloadsAnchor };
}

function setHistoryMenuOpen(open, anchor) {
  if (anchor && typeof anchor === 'object') {
    const left = Number(anchor.left);
    const top = Number(anchor.top);
    if (Number.isFinite(left) || Number.isFinite(top)) {
      historyMenuAnchor = {
        left: Math.max(8, Math.round(Number.isFinite(left) ? left : 10)),
        top: Math.max(0, Math.round(Number.isFinite(top) ? top : 0)),
        width: Math.max(240, Math.min(560, Math.round(Number(anchor.width)) || 420))
      };
    }
  }
  historyMenuOpen = typeof open === 'boolean' ? open : !historyMenuOpen;
  if (historyMenuOpen) { downloadsOpen = false; deviceMenuOpen = false; }
  // The dropdown always lists recent history, the address bar value is not a
  // search filter (that made the list look empty on every real page).
  historyMenuEntries = historyMenuOpen ? (historyStore?.list({ limit: 12 }) || []) : [];
  syncBrowserViewVisibility();
  publishState();
  return { historyMenuOpen };
}

function showTab(id) {
  const tab = tabs.get(id);
  if (!tab || !mainWindow) return false;
  const current = selectedTab();
  if (current && current.id !== tab.id && isAttached(current)) detachBrowserView(mainWindow, current.view);
  selectedTabId = tab.id;
  agentPointerOverlay?.setSelectedTab(tab.id);
  recorder?.tapTabSwitch?.({ url: tab.webContents.getURL(), title: tab.title || '' });
  syncBrowserViewVisibility();
  publishState();
  return true;
}

// LORDE_RELOAD_SHORTCUTS_V368 - F5 reload, Shift/Ctrl+F5 force reload
// (reloadIgnoringCache). Wired on the window's own webContents AND on every
// tab's webContents, because whichever surface has keyboard focus receives
// the key: a tab BrowserView never sees the window's events.
function wireReloadShortcut(webContents, targetResolver = null) {
  if (!webContents) return;
  webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.key !== 'F5') return;
    event.preventDefault();
    const force = Boolean(input.control || input.shift || input.meta);
    const resolved = targetResolver ? targetResolver() : webContents;
    const wc = resolved?.webContents || resolved;
    if (!wc || wc.isDestroyed?.()) return;
    if (force) wc.reloadIgnoringCache();
    else wc.reload();
  });
}

function wireTab(tab) {
  wireReloadShortcut(tab.webContents);
  // DEVICE CANVAS ZOOM â€” Ctrl+Scroll over the device canvas zooms the emulated
  // device's DISPLAY size. The gesture is observed by a page-injected capture
  // wheel watcher (deviceEmulator.applyZoomWatcher), because Electron 43's
  // webContents 'input-event' does NOT emit wheel events (verified live: the
  // page receives a real Ctrl+wheel with ctrlKey true while main sees no
  // input-event at all). The watcher preventDefaults the event (the page must
  // neither scroll nor page-zoom while the owner zooms the canvas) and
  // signals through a console token routed in the console-message handler
  // below. Without device mode the watcher is never injected and ordinary
  // Ctrl+wheel page behaviour is untouched.
  // See desktop/mcp/deviceZoom_flow_chat.md for the mapping contract: the zoom
  // factor threads through the ONE screenâ†’device transform (the `scale` of
  // Emulation.setDeviceMetricsOverride), so agent taps in device CSS pixels
  // stay correct at every zoom level.
  // LORDE_IDLE_SWEEPS_V366 â€” every wired tab activity (navigation, load,
  // title/favicon updates) refreshes the tab's idle clock for the empty-tab
  // sweep.
  const update = () => { tab.lastTouched = Date.now(); publishState(); };
  // Device mode uses the v3 native touch indicator lifecycle. It is re-added
  // after every document swap because navigation replaces the page DOM. The
  // device-canvas zoom watcher rides the same injection points.
  const injectTouchOverlay = () => {
    deviceEmulator?.applyTouchOverlay(tab.id).catch(() => {});
    deviceEmulator?.applyZoomWatcher(tab.id).catch(() => {});
  };
  tab.webContents.on('dom-ready', () => { injectTouchOverlay(); scheduleLayout(); });
  tab.webContents.on('did-navigate-in-page', (_event, url) => { injectTouchOverlay(); addConsoleEntry({ kind: 'navigation', message: `Route changed to ${url}`, url }); recorder?.tapNavigation?.({ url, title: tab.title || '' }); update(); });
  tab.webContents.on('page-favicon-updated', (_event, favicons) => {
    tab.favicon = (favicons || []).find(url => /^https?:\/\//i.test(url) || /^data:image\//i.test(url)) || null;
    update();
  });
  tab.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) { tab.favicon = null; update(); }
  });
  tab.webContents.on('page-title-updated', (_event, title) => {
    const rawUrl = tab.webContents.getURL() || '';
    // LORDE_HOME_TITLE_V1 â€” the homepage is the blank/new tab; never show
    // "Lorde Browser" as the tab title. Always show "New Tab" for homepage.
    const isHomepage = isHomeUrl(rawUrl);
    tab.title = tab.androidStreamSerial ? `Android ${tab.androidStreamSerial}` : (isHomepage ? 'New Tab' : (title || 'New Tab'));
    // LORDE_HISTORY_TITLE_V2 â€” history is recorded HERE, when the page's real
    // title is known. Recording at did-navigate time wrote the PREVIOUS page's
    // title (often "New Tab" when leaving the homepage), so real pages showed
    // up in history named "New Tab".
    if (tab.pendingHistory && tab.pendingHistory === rawUrl && !isHomepage) {
      const pendingUrl = tab.pendingHistory;
      tab.pendingHistory = null;
      historyStore?.record(pendingUrl, tab.title || '');
      updateTaskbarRecents();
    }
    update();
  });
  tab.webContents.on('did-start-loading', update);
  // A page that reads its own viewport during load must not be left measuring a
  // pre-settle size, so confirm the bounds whenever a document finishes loading.
  tab.webContents.on('did-stop-loading', () => {
    injectTouchOverlay(); update(); scheduleLayout();
    // LORDE_HISTORY_TITLE_V2 â€” fallback: pages that never emit a title event
    // still get recorded once loading settles. A page with no <title> gets its
    // hostname as the label instead of a stale "New Tab".
    if (tab.pendingHistory) {
      const pendingUrl = tab.pendingHistory;
      tab.pendingHistory = null;
      const finalUrl = tab.webContents.getURL() || '';
      if (pendingUrl === finalUrl && !isHomeUrl(finalUrl)) {
        let label = tab.title || '';
        if (!label || label === 'New Tab') {
          try { label = new URL(finalUrl).hostname.replace(/^www\./, ''); } catch { label = finalUrl; }
        }
        historyStore?.record(finalUrl, label);
        updateTaskbarRecents();
      }
    }
  });
  tab.webContents.on('did-navigate', (_event, url) => {
    addConsoleEntry({ kind: 'navigation', message: `Navigated to ${url}`, url, tabId: tab.id, level: 'info' });
    // LORDE_HOME_HISTORY_V1 â€” never record the homepage (blank/new tab) URL
    // in history. The address bar shows empty for homepage; history should too.
    // LORDE_HISTORY_TITLE_V2 â€” defer the record until the real title arrives
    // (page-title-updated) or loading settles (did-stop-loading fallback).
    tab.pendingHistory = (!isHomeUrl(url) && !url.includes('error-')) ? url : null;
    recorder?.tapNavigation?.({ url, title: tab.title || '' });
    update();
  });
  tab.webContents.on('console-message', (details) => {
    // DEVICE CANVAS ZOOM: the page-injected Ctrl+wheel watcher signals through
    // a console token (src/browser/touchOverlay.cjs). Route it to the zoom
    // handler and keep it out of the console UI â€” it is chrome signalling, not
    // page output, and one wheel gesture emits many events.
    const zoomSignal = /^__browser_use_device_zoom__ (-?\d+)$/.exec(String(details?.message || '').trim());
    if (zoomSignal) {
      handleDeviceZoomWheel(tab.id, Number(zoomSignal[1]));
      return;
    }
    // Electron 39 supplies the details on the typed event object. Reading the
    // deprecated positional parameters logs a warning for every page message.
    const level = String(details?.level || 'info');
    addConsoleEntry({
      kind: level === 'error' ? 'error' : 'console',
      level,
      message: String(details?.message || ''),
      line: Number(details?.lineNumber || 0),
      sourceId: String(details?.sourceId || ''),
      url: String(details?.sourceId || tab.webContents.getURL() || ''),
      tabId: tab.id
    });
  });
  tab.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (errorCode === -3) return;
    addConsoleEntry({ kind: 'network', level: 'error', message: `${errorDescription} (${errorCode})`, url: validatedURL, isMainFrame, tabId: tab.id });
    // A transient connection failure must not leave a persistent production SPA
    // looking like an application crash. Retry only the main frame once, after
    // Chromium has released the failed navigation, and never retry DNS/invalid
    // destinations indefinitely.
    if (isMainFrame && shouldRetryNavigation(errorCode, validatedURL, tab)) {
      tab.navigationRetries = (tab.navigationRetries || 0) + 1;
      tab.lastFailedNavigationUrl = String(validatedURL || '');
      const timer = setTimeout(() => loadTabUrl(tab, validatedURL), 750 * tab.navigationRetries);
      if (typeof timer.unref === 'function') timer.unref();
      return;
    }
    // LORDE_ERROR_PAGES_V1 â€” load the polished error page when retries are
    // exhausted or the error is not retryable. The error page shows the URL,
    // error code, and a Try Again button.
    if (isMainFrame) {
      const failedUrl = String(validatedURL || '');
      // LORDE_ERROR_PAGES_V2 — never react to a failure OF the error page
      // itself (file:// hiccups), or the handler would loop on its own page.
      if (/[/\\]error-[a-z-]+\.html/i.test(failedUrl)) return;
      const errorPages = path.join(__dirname, 'renderer', 'pages');
      let errorFile;
      if (errorCode === -102 || errorCode === -105 || errorCode === -106) {
        // ERR_CONNECTION_REFUSED, ERR_NAME_NOT_RESOLVED, ERR_INTERNET_DISCONNECTED
        errorFile = errorCode === -106 ? 'error-no-internet.html' : 'error-cannot-connect.html';
      } else if (errorCode === -100 || errorCode === -101) {
        errorFile = 'error-cannot-connect.html';
      } else {
        errorFile = 'error-cannot-connect.html';
      }
      // pathToFileURL builds the correct file:///C:/... form — the old string
      // concat produced file://C:\... which Chromium can fail to commit,
      // leaving the tab on the plain chrome-error page.
      const errorUrl = new URL(pathToFileURL(path.join(errorPages, errorFile)).toString());
      errorUrl.searchParams.set('url', failedUrl);
      errorUrl.searchParams.set('code', String(errorCode));
      errorUrl.searchParams.set('message', errorDescription || '');
      errorUrl.searchParams.set('home', HOME_URL);
      addConsoleEntry({ kind: 'network', level: 'warning', message: `Showing error page for ${failedUrl}`, url: failedUrl, tabId: tab.id });
      loadTabUrl(tab, errorUrl.toString());
    }
  });
  tab.webContents.on('did-finish-load', () => {
    // LORDE_ERROR_PAGES_V2 — chrome-error:// itself fires did-finish-load, so
    // resetting the counter unconditionally let a dead host retry FOREVER
    // (each cycle: fail → retry → chrome-error "finishes" → counter reset →
    // retry …) and the polished error page was never reached.
    const committed = tab.webContents.getURL() || '';
    if (!committed.startsWith('chrome-error://')) tab.navigationRetries = 0;
  });
  tab.webContents.setWindowOpenHandler(({ url, disposition }) => {
    // OAuth callbacks use window.opener/postMessage. Turning the consent popup
    // into a separate managed tab destroys that opener relationship, which makes
    // providers such as Figma report that Google profile information is missing.
    // Allow standard HTTPS popups so Electron retains the secure opener/session
    // relationship; reject non-web schemes explicitly.
    if (!/^https?:\/\//i.test(url)) {
      addConsoleEntry({ kind: 'navigation', level: 'warning', message: `Blocked unsupported popup URL: ${url}`, tabId: tab.id });
      return { action: 'deny' };
    }
    // Plain link popups (target=_blank and friends) must open INSIDE the app as
    // managed tabs: a stray native child window has no bounds management and
    // renders cropped or invisible over the shell.
    if (disposition === 'foreground-tab' || disposition === 'background-tab') {
      addConsoleEntry({ kind: 'navigation', message: `Opened link in a new tab: ${url}`, url, tabId: tab.id });
      createTab(url, disposition === 'foreground-tab');
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  tab.webContents.on('did-create-window', (childWindow, details) => {
    // Keep OAuth popups tightly scoped to their parent and preserve the hardened
    // BrowserView preferences inherited by Electron's window.open flow.
    childWindow.setMenuBarVisibility(false);
    // LORDE_POPUP_LISTENER_GUARD_V365 â€” did-create-window fires again whenever
    // a page's window.open reuses an existing (named) popup, so a naive
    // handler leaked one 'closed' listener per call onto the SAME window
    // until Electron's max-listeners warning fired. Attach exactly once.
    if (!closedListenerWiredWindows.has(childWindow)) {
      closedListenerWiredWindows.add(childWindow);
      childWindow.once('closed', update);
    }
    addConsoleEntry({ kind: 'navigation', message: `Opened authentication popup: ${details.url}`, url: details.url, tabId: tab.id });
  });
  tab.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting) return;
    addConsoleEntry({ kind: 'error', level: 'error', message: `Tab renderer exited: ${details.reason}`, tabId: tab.id });
    if (tabs.get(tab.id) === tab) {
      browserViewController?.releaseTabInput(tab.id);
      deviceEmulator?.forgetTab(tab.id);
      debuggerLeaseManager?.forgetTab(tab.id);
      if (sessionBroker?.unbindTab(tab.id)) publishMcpState();
      tabs.delete(tab.id);
      if (selectedTabId === tab.id) {
        selectedTabId = null;
        const replacement = tabs.values().next().value || createTab('', false);
        showTab(replacement.id);
      } else publishState();
    }
  });
  tab.webContents.on('destroyed', () => {
    if (tabs.get(tab.id) !== tab) return;
    tabs.delete(tab.id);
    if (isQuitting) return;
    if (selectedTabId === tab.id) {
      selectedTabId = null;
      const replacement = tabs.values().next().value || createTab('', false);
      showTab(replacement.id);
    } else publishState();
  });
}

function shouldRetryNavigation(errorCode, url, tab) {
  if (!tab || tab.webContents.isDestroyed() || (tab.navigationRetries || 0) >= 1) return false;
  if (!/^https:\/\//i.test(String(url || ''))) return false;
  // Never retry the exact URL we already retried once — the did-finish-load
  // guard above keeps chrome-error from resetting the counter, but a second
  // failed attempt at the SAME destination must go straight to the error page.
  if (tab.lastFailedNavigationUrl === String(url || '')) return false;
  return [-2, -7, -21, -100, -101, -102, -103, -104, -105, -106, -118].includes(Number(errorCode));
}

function createTab(url = '', activate = true) {
  const isAndroidStream = /(?:^|[/\\])androidStream\.html(?:[?#]|$)/i.test(String(url || ''));
  const view = new BrowserView({
    // Use one named persistent partition for every managed tab. Without this,
    // Electron's implicit default partition can race itself when stale Desktop
    // processes survive a dev relaunch, corrupting cache/quota/service-worker
    // state and making complex SPAs render differently from Chrome.
    webPreferences: { partition: BROWSER_PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, backgroundThrottling: true, ...(isAndroidStream ? { preload: path.join(__dirname, 'android', 'androidStreamPreload.cjs') } : {}) }
  });
  // Pages with no background color (or transparent floating elements) must
  // render on white, not on whatever the system theme leaves behind, an
  // unpainted canvas turns "black text on black background".
  view.setBackgroundColor('#ffffff');
  // Detached tabs are allowed to yield compositor/timer work. Browser actions
  // still run through CDP when a tab is selected or explicitly targeted, while
  // inactive pages no longer consume a full renderer budget indefinitely.
  const tab = { id: `tab-${nextTabId++}`, view, webContents: view.webContents, title: 'New Tab', lastTouched: Date.now() };
  tabs.set(tab.id, tab);
  wireTab(tab);
  if (activate) showTab(tab.id);
  else attachBackgroundViewForCapture(tab);
  const destination = url === 'about:blank' || !url ? homeUrlWithVersion() : normalizeUrl(url);
  loadTabUrl(tab, destination);
  return tab;
}

function waitForTabReady(tab, requestedUrl, timeoutMs = 15_000) {
  if (!tab?.webContents || tab.webContents.isDestroyed()) return Promise.resolve(tab);
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const [event, listener] of listeners) tab.webContents.removeListener(event, listener);
      resolve(tab);
    };
    const listeners = [
      ['did-stop-loading', finish],
      ['did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (isMainFrame !== false) { tab.navigationError = { code: errorCode, message: errorDescription, url: validatedURL || requestedUrl }; finish(); }
      }],
      ['destroyed', finish]
    ];
    const timer = setTimeout(finish, timeoutMs);
    for (const [event, listener] of listeners) tab.webContents.once(event, listener);
  });
}

function loadTabUrl(tab, destination) {
  if (!tab || tab.webContents.isDestroyed()) return;
  tab.navigationError = null;
  tab.webContents.loadURL(destination).catch((error) => {
    // Navigation can be superseded by a SPA redirect or a selected replacement
    // tab. Do not overwrite a healthy page with a stale navigation error.
    if (error?.errno === -3 || tab.webContents.isDestroyed()) return;
    const loopback = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:[/?#]|$)/i.test(String(destination || ''));
    const refused = /ERR_CONNECTION_REFUSED|ECONNREFUSED/i.test(String(error?.message || error));
    tab.navigationError = { code: error?.errno ?? error?.code ?? null, message: String(error?.message || error), url: destination };
    if (loopback && refused) {
      tab.navigationRetries = 0;
      tab.title = 'New Tab';
      addConsoleEntry({ kind: 'network', level: 'warning', message: `Remembered local homepage is unavailable; opened a blank tab instead: ${destination}`, url: destination, tabId: tab.id });
      void tab.webContents.loadURL('about:blank').catch(() => {});
      publishState();
      return;
    }
    tab.title = 'Navigation error';
    addConsoleEntry({ kind: 'network', level: 'error', message: error.message, url: destination, tabId: tab.id });
    publishState();
  });
}

function closeTab(id) {
  // BUG FIX: Do NOT cancel runs when their attached tab is closed by the user.
  // Runs should only be canceled during deliberate teardown (closeIndependentChatWindow, subagent_close, etc.).
  // The user explicitly closing a tab should not terminate an active run.
  // Note: The run will fail on its next observation if it tries to use the destroyed webContents,
  // but this is better than immediately canceling the run without the user's intent.
  
  // Removed: automatic cancellation of runs when their tab is closed
  // const activeChatRun = desktopChatAgent?.state();
  // if (activeChatRun?.tabId === id && ['running', 'awaiting_approval', 'paused'].includes(activeChatRun.status)) desktopChatAgent.cancel(activeChatRun.id);
  // for (const entry of agentPool?.activeRuns || []) {
  //   const snapshot = entry.instance?.state?.();
  //   if (String(entry.tabId) === String(id) && ['running', 'awaiting_approval', 'paused'].includes(snapshot?.status)) {
  //     try { entry.instance.cancel(snapshot.id); } catch { /* already terminal */ }
  //   }
  // }
  
  for (const entry of chatAgentWindows.values()) entry.tabIds?.delete(String(id));
  const tab = tabs.get(id);
  if (!tab) return currentState();
  if (tab.androidStreamSerial && androidDeviceManager) void androidDeviceManager.stopStream(tab.androidStreamSerial, { closeTab: false }).catch(() => {});
  const wasSelected = id === selectedTabId;
  // Release any synthetic input this tab still holds and drop every paired
  // binding before the webContents disappears, so hosts fail closed instead of
  // addressing a destroyed view.
  browserViewController?.releaseTabInput(id);
  // Drop emulation bookkeeping before the webContents disappears, so a later
  // detach cannot address a destroyed debugger session.
  deviceEmulator?.forgetTab(id);
  debuggerLeaseManager?.forgetTab(id);
  if (sessionBroker?.unbindTab(id)) publishMcpState();
  if (mainWindow && !mainWindow.isDestroyed() && isAttached(tab)) detachBrowserView(mainWindow, tab.view);
  tabs.delete(id);
  if (!tab.webContents.isDestroyed()) tab.webContents.close();
  if (wasSelected) {
    const replacement = tabs.values().next().value || createTab('', false);
    showTab(replacement.id);
  } else publishState();
  return currentState();
}

// Captures the active tab, writes it next to the app's data, and puts the path
// on the clipboard. The path is the text flavour so pasting into a terminal or
// an agent prompt yields something referable, while the bitmap rides along so
// pasting into an image surface still works.
async function captureScreenshotToDisk() {
  const tab = selectedTab();
  if (!tab) throw new Error('No active tab is available.');
  if (!isTabPaintable(tab.id)) {
    throw new Error('The active tab is not currently painted, so it cannot be captured. Close any open drawer and retry.');
  }
  const image = await tab.webContents.capturePage();
  const directory = appDataPath(SCREENSHOT_DIRECTORY);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `browser-use-${stamp}.png`);
  const buffer = image.toPNG();
  fs.writeFileSync(file, buffer);
  clipboard.write({ text: file, image: nativeImage.createFromBuffer(buffer) });
  return { path: file, bytes: buffer.length, width: image.getSize().width, height: image.getSize().height };
}

// Runs the in-page picker and returns what the human chose. The promise
// resolves only when they click or press Escape, so the caller must not treat
// a long wait as a failure.
async function pickElement() {
  const tab = selectedTab();
  if (!tab) throw new Error('No active tab is available.');
  // Only drawers that COVER the page block picking. The agent drawer keeps the
  // page live in the strip beside the chat (stageBounds reserves it), so DOM
  // attachment mode picks elements while the conversation stays open.
  if (['settings', 'console', 'recorder'].includes(activeDrawer)) throw new Error('Close the open drawer before selecting an element.');
  // The picker reads keyboard input for Escape, and the native surface must own
  // focus for that to arrive. The injected script returns immediately and
  // writes its answer to a page-local slot; polling avoids holding an IPC call
  // open for the duration of the human's choice.
  tab.webContents.focus();
  const started = await tab.webContents.executeJavaScript(buildElementPickerExpression(), true);
  if (!started?.started) return { picked: false, reason: started?.reason || 'already-active' };
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await tab.webContents.executeJavaScript('window.__browserUsePickerResult || null', true);
    if (result) return result;
    await delay(50);
  }
  await tab.webContents.executeJavaScript(`(() => {
    const layer = document.getElementById('__browser_use_element_picker__');
    if (layer?.__browserUseTeardown) layer.__browserUseTeardown();
    window.__browserUsePickerActive = false;
    window.__browserUsePickerResult = { picked: false, reason: 'timeout' };
    return true;
  })()`, true).catch(() => {});
  // Sixty seconds with no pick is inactivity, not a failure: resolve quietly
  // so the DOM-selection mode can auto-exit instead of surfacing an error.
  return { picked: false, reason: 'timeout' };
}

// Reads the active tab's own Chromium selection for DOM attachment. Pure DOM
// state: works regardless of drawer or paint state, changes nothing about
// layout, focus, or the page's behavior.
async function readDomSelection() {
  const tab = selectedTab();
  if (!tab || tab.webContents.isDestroyed()) return { selected: false, reason: 'no-tab' };
  try {
    return await tab.webContents.executeJavaScript(`(() => {
      const selection = window.getSelection && window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return { selected: false };
      const holder = document.createElement('div');
      holder.appendChild(selection.getRangeAt(0).cloneContents());
      const html = holder.innerHTML.trim();
      if (!html) return { selected: false };
      return {
        selected: true,
        html: html.slice(0, 100000),
        truncated: html.length > 100000,
        text: String(selection).replace(/\\s+/g, ' ').trim().slice(0, 2000),
        url: String(location.href).slice(0, 500)
      };
    })()`, true);
  } catch (error) {
    return { selected: false, reason: String(error?.message || 'selection read failed').slice(0, 200) };
  }
}

async function cancelPickElement() {
  const tab = selectedTab();
  if (!tab || tab.webContents.isDestroyed()) return { cancelled: false };
  await tab.webContents.executeJavaScript(`(() => {
    const layer = document.getElementById('__browser_use_element_picker__');
    if (layer?.__browserUseTeardown) layer.__browserUseTeardown();
    window.__browserUsePickerActive = false;
    window.__browserUsePickerResult = { picked: false, reason: 'cancelled' };
    return true;
  })()`, true).catch(() => {});
  return { cancelled: true };
}

let overlayView = null;

function createOverlayView() {
  if (liveOverlayWebContents()) return overlayView;
  if (overlayView && mainWindow && !mainWindow.isDestroyed() && mainWindow.getBrowserViews().includes(overlayView)) {
    detachBrowserView(mainWindow, overlayView);
  }
  overlayView = new BrowserView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: true,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });
  overlayView.setBackgroundColor('#00000000');
  const view = overlayView;
  view.webContents.on('did-finish-load', () => {
    // The initial state can be published before this isolated BrowserView has
    // loaded. Send a fresh snapshot once it is ready so the first click opens
    // a real panel instead of a transparent input shield.
    if (overlayView !== view || !liveOverlayWebContents()) return;
    safeIpcSend(view.webContents, 'browser-use:overlay-state', currentState());
    view.webContents.send('browser-use:console', consoleEntries);
    sendPreviewPayload();
  });
  view.webContents.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  return view;
}

function layoutOverlayView() {
  if (!mainWindow || mainWindow.isDestroyed() || !overlayView || !liveOverlayWebContents()) return;
  const [width, height] = mainWindow.getContentSize();
  const dock = terminalDocked ? clampTerminalHeight(terminalHeight, height) : 0;
  const hasOverlay = ['settings', 'console', 'recorder'].includes(activeDrawer) || deviceMenuOpen || historyMenuOpen || downloadsOpen || aboutOpen || Boolean(activePreview);

  if (!hasOverlay) {
    overlayView.setBounds({ x: 0, y: APP_CHROME_HEIGHT, width: 0, height: 0 });
    return;
  }
  overlayView.setBounds(activePreview || aboutOpen ? {
    x: 0,
    y: 0,
    width: Math.max(0, width),
    height: Math.max(0, height)
  } : {
    x: 0,
    y: APP_CHROME_HEIGHT,
    width: Math.max(0, width),
    height: Math.max(0, height - APP_CHROME_HEIGHT - dock)
  });
  // Stacking is established in syncBrowserViewVisibility by re-attaching the
  // overlay last. Calling setTopBrowserView here is deliberately avoided: on
  // Windows it can be ignored after a 0x0-to-visible transition.
}

function aboutSnapshot() {
  return {
    name: 'Browser-use', version: app.getVersion(),
    copyright: `Copyright ${new Date().getFullYear()} LORDE STUDIOS. ALL RIGHTS RESERVED`
  };
}
function setAboutOpen(open) {
  aboutOpen = Boolean(open);
  if (aboutOpen) { downloadsOpen = false; deviceMenuOpen = false; historyMenuOpen = false; }
  syncBrowserViewVisibility();
  publishState();
  return aboutOpen ? aboutSnapshot() : null;
}

function closeOverlay() {
  // Transient menu dismissal must not close an unrelated chat drawer.
  if (['settings', 'console', 'recorder'].includes(activeDrawer)) activeDrawer = null;
  downloadsOpen = false;
  deviceMenuOpen = false;
  historyMenuOpen = false;
  activePreview = null;
  aboutOpen = false;
  syncBrowserViewVisibility();
  sendPreviewPayload();
  publishState();
  return { closed: true };
}

function closePreview() {
  activePreview = null;
  sendPreviewPayload();
  syncBrowserViewVisibility();
  publishState();
  return { closed: true };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pinnedChatEntries() {
  return [...chatAgentWindows.values()].filter(entry => entry.pinned && !entry.minimized && !entry.window.isDestroyed());
}

function dockViewAttached(view) {
  return Boolean(mainWindow && !mainWindow.isDestroyed() && view && mainWindow.getBrowserViews().includes(view));
}

function chatDockMetrics() {
  if (!mainWindow || mainWindow.isDestroyed()) return { paneCount: 0, paneWidth: 0, primaryWidth: 0, extraWidth: 0, totalWidth: 0, primaryVisible: false };
  const [width] = mainWindow.getContentSize();
  const primaryVisible = activeDrawer === 'agent' && primaryAgentPinned;
  const extras = [...chatAgentWindows.entries()].filter(([, entry]) => entry.pinned && !entry.minimized && !entry.window.isDestroyed());
  const paneCount = (primaryVisible ? 1 : 0) + extras.length;
  if (!paneCount) return { paneCount: 0, paneWidth: 0, primaryWidth: 0, extraWidth: 0, totalWidth: 0, primaryVisible: false, paneWidths: {} };
  const available = Math.max(0, width - 180);
  const minimum = 240;
  const desired = [
    ...(primaryVisible ? [{ id: null, width: Math.max(minimum, Math.round(agentDrawerWidth)) }] : []),
    ...extras.map(([id, entry]) => ({ id, width: Math.max(minimum, Math.round(entry.dockWidth || AGENT_DRAWER_WIDTH)) }))
  ];
  const desiredTotal = desired.reduce((sum, pane) => sum + pane.width, 0);
  const widths = desiredTotal <= available
    ? desired.map(pane => pane.width)
    : (() => {
      const minimumTotal = minimum * desired.length;
      if (available <= minimumTotal) return desired.map(() => Math.max(1, Math.floor(available / desired.length)));
      const spare = available - minimumTotal;
      const weighted = desired.reduce((sum, pane) => sum + Math.max(0, pane.width - minimum), 0);
      return desired.map(pane => minimum + (weighted ? Math.floor(spare * Math.max(0, pane.width - minimum) / weighted) : Math.floor(spare / desired.length)));
    })();
  const primaryWidth = primaryVisible ? widths[0] : 0;
  const paneWidths = Object.fromEntries(extras.map(([id], index) => [id, widths[index + (primaryVisible ? 1 : 0)]]));
  const paneRevisions = Object.fromEntries(extras.map(([id, entry]) => [id, entry.dockResizeRevision || 0]));
  const extraWidth = Object.values(paneWidths).reduce((sum, value) => sum + value, 0);
  return { paneCount, paneWidth: primaryWidth, primaryWidth, extraWidth, totalWidth: primaryWidth + extraWidth, primaryVisible, paneWidths, paneRevisions };
}

function ensureChatDockView(id, entry) {
  if (entry.dockView?.webContents && !entry.dockView.webContents.isDestroyed()) return entry.dockView;
  const dockView = new BrowserView({ webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') } });
  dockView.setBackgroundColor('#060b0d');
  entry.dockView = dockView;
  dockView.webContents.on('did-finish-load', () => {
    if (entry.dockView !== dockView || dockView.webContents.isDestroyed()) return;
    dockView.webContents.send('browser-use:state', currentState(entry.instance || desktopChatAgent, id));
    const run = entry.instance?.state?.();
    if (run) dockView.webContents.send('browser-use:agent-event', { type: 'run.snapshot', run });
  });
  dockView.webContents.on('destroyed', () => { if (entry.dockView === dockView) entry.dockView = null; });
  dockView.webContents.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { chatWindow: id } });
  return dockView;
}

function layoutChatDockViews() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const metrics = chatDockMetrics();
  const stage = stageBounds();
  let x = stage.x + stage.width + metrics.primaryWidth;
  for (const [id, entry] of chatAgentWindows) {
    if (!entry.pinned || entry.minimized || !dockViewAttached(entry.dockView)) continue;
    const width = metrics.paneWidths?.[id] || AGENT_DRAWER_WIDTH;
    setViewBoundsIfChanged(entry.dockView, { x, y: stage.y, width, height: stage.height });
    x += width;
  }
}

function syncChatDockViews({ reorder = false } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const activeEntries = [];
  for (const [id, entry] of chatAgentWindows) {
    if (!entry.pinned || entry.minimized || entry.window.isDestroyed()) continue;
    activeEntries.push({ id, entry, view: ensureChatDockView(id, entry) });
  }
  const activeViews = new Set(activeEntries.map(({ view }) => view));
  for (const entry of chatAgentWindows.values()) {
    if (entry.dockView && !activeViews.has(entry.dockView) && dockViewAttached(entry.dockView)) detachBrowserView(mainWindow, entry.dockView);
  }
  if (reorder) {
    // addBrowserView establishes native stacking order. Re-add only during a
    // visibility/ownership transition, never for a pointermove resize frame.
    for (const { view } of activeEntries) if (dockViewAttached(view)) detachBrowserView(mainWindow, view);
    for (const { view } of activeEntries) if (!dockViewAttached(view)) attachBrowserView(mainWindow, view);
  } else {
    for (const { view } of activeEntries) if (!dockViewAttached(view)) attachBrowserView(mainWindow, view);
  }
  layoutChatDockViews();
}

function openIndependentChatWindow() {
  if (chatAgentWindows.size >= CHAT_WINDOW_LIMIT) return null;
  const id = `chat-window-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const primaryBounds = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 40, y: 40, width: 1440, height: 940 };
  const display = screen.getDisplayMatching(primaryBounds);
  const work = display.workArea;
  const offset = (chatAgentWindows.size + 1) * 32;
  const x = Math.min(Math.max(work.x, primaryBounds.x + primaryBounds.width + offset), work.x + work.width - 620);
  const y = Math.min(Math.max(work.y, primaryBounds.y + offset), work.y + work.height - 820);
  const window = new BrowserWindow({ x, y, width: 420, height: 820, minWidth: 320, minHeight: 520, resizable: true, title: `Browser-use Chat ${chatAgentWindows.size + 2} · DSH`, backgroundColor: '#060b0d', parent: undefined, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') } });
  window.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { chatWindow: id } });
  const usedLabels = new Set([...chatAgentWindows.values()].map(entry => entry.label));
  const label = ['Chat 2', 'Chat 3'].find(candidate => !usedLabels.has(candidate)) || `Chat ${chatAgentWindows.size + 2}`;
  const entry = { window, label, closing: false, pinned: true, minimized: false, dockWidth: AGENT_DRAWER_WIDTH, dockResizeRevision: 0, tabIds: new Set(), dockView: null, instance: null, pendingMessages: [] };
  window.setAlwaysOnTop(false);
  chatAgentWindows.set(id, entry);
  window.setTitle(`Browser-use ${label}`);
  entry.instance = createChatAgent({ targetWindow: window, targetChatId: id });
  ensureChatDockView(id, entry);
  window.hide();
  syncBrowserViewVisibility();
  window.on('close', (event) => {
    if (!entry.closing) { event.preventDefault(); window.minimize(); }
  });
  window.on('minimize', () => { entry.minimized = true; publishState(); });
  window.on('restore', () => { entry.minimized = false; publishState(); });
  wireReloadShortcut(window.webContents);
  window.on('closed', () => {
    for (const tabId of entry.tabIds || []) if (tabs.has(String(tabId))) closeTab(String(tabId));
    entry.tabIds?.clear();
    if (entry.dockView && dockViewAttached(entry.dockView)) detachBrowserView(mainWindow, entry.dockView);
    chatAgentWindows.delete(id);
    publishState();
  });
  publishState();
  return id;
}

function setChatWindowMinimized(id, minimized) {
  const entry = chatAgentWindows.get(String(id || ''));
  if (!entry) return false;
  const nextMinimized = Boolean(minimized);
  entry.minimized = nextMinimized;
  if (entry.pinned) {
    entry.window.hide();
    syncBrowserViewVisibility();
  } else if (nextMinimized) {
    entry.window.minimize();
  } else {
    entry.window.restore();
  }
  publishState();
  return nextMinimized;
}

// LORDE_PRIMARY_UNPIN_V364 â€” unpinning Chat 1 used to only hide the drawer:
// the primary agent had no floating surface, so the chat disappeared with no
// way back (the pin button lived inside the hidden drawer). Unpinning now
// opens a floating window hosting the SAME primary agent; closing it re-pins
// the chat back into the drawer.
let primaryChatWindow = null;

function ensurePrimaryChatWindow() {
  if (primaryChatWindow && !primaryChatWindow.isDestroyed()) {
    primaryChatWindow.show();
    primaryChatWindow.focus();
    return primaryChatWindow;
  }
  const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : { x: 40, y: 40, width: 1440, height: 940 };
  const work = screen.getDisplayMatching(base).workArea;
  let x = base.x + base.width + PINNED_CHAT_GAP;
  if (x + 420 > work.x + work.width) x = work.x + work.width - 420;
  x = Math.max(work.x, Math.min(x, work.x + work.width - 420));
  const y = Math.max(work.y, Math.min(base.y, work.y + Math.max(0, work.height - 820)));
  primaryChatWindow = new BrowserWindow({
    x, y, width: 420, height: 820, minWidth: 320, minHeight: 520, resizable: true,
    title: 'Browser-use Chat 1 · DSH',
    backgroundColor: '#060b0d',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') }
  });
  primaryChatWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { chatWindow: 'primary' } });
  primaryChatWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      // Closing the floating Chat 1 returns it to the pinned drawer.
      try { primaryChatWindow.removeAllListeners('close'); } catch { /* best effort */ }
      setChatPinned('', true);
    }
  });
  wireReloadShortcut(primaryChatWindow.webContents);
  primaryChatWindow.on('closed', () => { primaryChatWindow = null; });
  return primaryChatWindow;
}

function setChatPinned(id, pinned) {
  let key = String(id || '');
  // The floating Chat 1 window identifies itself as 'primary'.
  if (key === 'primary') key = '';
  if (!key) {
    primaryAgentPinned = Boolean(pinned);
    if (primaryAgentPinned) {
      activeDrawer = 'agent';
      if (primaryChatWindow && !primaryChatWindow.isDestroyed()) {
        const closing = primaryChatWindow;
        primaryChatWindow = null;
        try { closing.removeAllListeners('close'); closing.close(); } catch { /* already gone */ }
      }
    } else {
      activeDrawer = null;
      ensurePrimaryChatWindow();
    }
    syncBrowserViewVisibility();
    publishState();
    return primaryAgentPinned;
  }
  const entry = chatAgentWindows.get(key);
  if (!entry || entry.window.isDestroyed()) return false;
  const nextPinned = Boolean(pinned);
  entry.pinned = nextPinned;
  entry.minimized = false;
  if (nextPinned) {
    ensureChatDockView(key, entry);
    entry.window.hide();
  } else {
    if (entry.dockView && dockViewAttached(entry.dockView)) detachBrowserView(mainWindow, entry.dockView);
    entry.window.show();
    entry.window.setAlwaysOnTop(false);
    // LORDE_CHAT_UNPIN_CLAMP_V364 â€” unpinning used to place the window
    // unconditionally to the right of the main window, so a main window near
    // the screen edge opened the chat off-screen with no way to recover it.
    // Prefer the right side, then clamp into the display work area.
    const base = mainWindow && !mainWindow.isDestroyed() ? mainWindow.getBounds() : entry.window.getBounds();
    const bounds = entry.window.getBounds();
    const work = screen.getDisplayMatching(base).workArea;
    let x = base.x + base.width + PINNED_CHAT_GAP;
    if (x + bounds.width > work.x + work.width) x = work.x + work.width - bounds.width;
    x = Math.max(work.x, Math.min(x, work.x + work.width - bounds.width));
    const y = Math.max(work.y, Math.min(base.y, work.y + Math.max(0, work.height - bounds.height)));
    entry.window.setPosition(x, y, false);
    entry.window.focus();
  }
  syncBrowserViewVisibility();
  publishState();
  return nextPinned;
}

function closeIndependentChatWindow(id) {
  const key = String(id || '');
  const entry = chatAgentWindows.get(key);
  if (!entry || entry.closing) return false;
  entry.closing = true;
  const snapshot = entry.instance?.state?.();
  if (snapshot && ['running', 'awaiting_approval', 'paused'].includes(snapshot.status)) {
    try { entry.instance.cancel(snapshot.id); } catch (error) {
      addConsoleEntry({ kind: 'agent', level: 'warn', message: `Chat cancellation during close was ignored: ${String(error?.message || error).slice(0, 160)}` });
    }
  }
  for (const tabId of entry.tabIds || []) {
    if (tabs.has(String(tabId))) closeTab(String(tabId));
  }
  entry.tabIds?.clear();
  if (entry.dockView) {
    if (dockViewAttached(entry.dockView)) detachBrowserView(mainWindow, entry.dockView);
    if (!entry.dockView.webContents.isDestroyed()) entry.dockView.webContents.close();
    entry.dockView = null;
  }
  chatAgentWindows.delete(key);
  try {
    if (!entry.window.isDestroyed()) {
      // The normal close handler minimizes an ordinary user close. A confirmed
      // agent removal must bypass that handler so no hidden owner window or
      // duplicate BrowserWindow can retain a stale browser surface.
      entry.window.removeAllListeners('close');
      entry.window.destroy();
    }
  } catch (error) {
    addConsoleEntry({ kind: 'agent', level: 'error', message: `Could not close ${entry.label || 'chat'}: ${String(error?.message || error).slice(0, 240)}` });
  }
  syncBrowserViewVisibility();
  publishState();
  return true;
}

function chatWindowEntryForContents(contents) {
  for (const [id, entry] of chatAgentWindows) {
    if (entry.window?.webContents === contents || entry.dockView?.webContents === contents) return { id, entry };
  }
  return null;
}

function openDetachedTerminal() {
  if (terminalDetachedWindow && !terminalDetachedWindow.isDestroyed()) {
    terminalDetachedWindow.focus();
    return terminalDetachedWindow;
  }
  // The terminal process belongs to TerminalManager, not a renderer. Detaching
  // must move its presentation only: disposing here killed the active shell and
  // made every detach look like a lost session.
  terminalDetachedWindow = new BrowserWindow({
    width: 900,
    height: 460,
    title: 'Browser-use Terminal',
    backgroundColor: '#060b0d',
    parent: mainWindow || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') }
  });
  terminalDetachedWindow.loadFile(path.join(__dirname, 'renderer', 'terminal.html'));
  wireReloadShortcut(terminalDetachedWindow.webContents);
  terminalDetachedWindow.on('closed', () => {
    terminalDetachedWindow = null;
    publishState();
  });
  // Detaching frees the dock; the session itself keeps running in the new window.
  terminalDocked = false;
  layoutSelectedTab();
  scheduleLayout();
  publishState();
  return terminalDetachedWindow;
}

// GEN9: the /notebook popup â€” a small always-simple monospace editor over the
// run's persistent notebook file (~600x700). Reopening an open notebook
// focuses the existing window and swaps the loaded file.
let notebookWindow = null;
function openNotebookWindow(notebookPath) {
  if (notebookWindow && !notebookWindow.isDestroyed()) {
    notebookWindow.webContents.send('browser-use:notebook-load', { path: String(notebookPath || '') });
    notebookWindow.focus();
    return notebookWindow;
  }
  notebookWindow = new BrowserWindow({
    width: 600,
    height: 700,
    minWidth: 420,
    minHeight: 420,
    title: 'Run Notebook',
    backgroundColor: '#060b0d',
    parent: mainWindow || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') }
  });
  notebookWindow.loadFile(path.join(__dirname, 'renderer', 'notebook.html'), { query: { notebookPath: String(notebookPath || '') } });
  wireReloadShortcut(notebookWindow.webContents);
  notebookWindow.on('closed', () => { notebookWindow = null; publishState(); });
  return notebookWindow;
}

// The notebook file a chat-window /notebook should open: the sender's chat
// agent's live run first, then the primary agent's live run.
function activeNotebookPath(sender) {
  const entry = chatWindowEntryForContents(sender);
  const instances = [];
  if (entry?.entry?.instance) instances.push(entry.entry.instance);
  if (desktopChatAgent) instances.push(desktopChatAgent);
  for (const instance of instances) {
    const candidate = String(instance?.run?.notebookPath || instance?.run?.notebook?.filePath || '');
    if (candidate) return candidate;
  }
  return null;
}

function showDesktopWindow() {  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (!mainWindowDidFinishLoad || !mainRendererReady) {
    createSplashWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  primaryAgentPinned = true;
  if (activeDrawer === null) activeDrawer = 'agent';
  mainWindow.show();
  mainWindow.focus();
}

function createDesktopTray() {
  // Port 0 denotes an isolated Electron test. Those tests historically close the
  // last window to end the process; opt into tray behavior only in the dedicated
  // background-lifecycle test so unrelated acceptance tests keep that contract.
  if (process.env.BROWSER_USE_DESKTOP_MCP_PORT === '0' && process.env.BROWSER_USE_DESKTOP_TRAY !== '1') return;
  try {
    // The real composited icon (Lorde Studios logo + plane pointer) when the
    // asset exists; the drawn fallback keeps tests and bare checkouts working.
    let trayImage = nativeImage.createFromPath(browserUseIcon(32));
    if (trayImage.isEmpty()) {
      const size = 32;
      const pixels = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const at = (y * size + x) * 4;
          const frame = x >= 4 && x <= 27 && y >= 6 && y <= 25;
          const inside = x >= 7 && x <= 24 && y >= 12 && y <= 22;
          if (!frame || inside) continue;
          pixels[at] = 220; pixels[at + 1] = 140; pixels[at + 2] = 50; pixels[at + 3] = 255;
        }
      }
      trayImage = nativeImage.createFromBitmap(pixels, { width: size, height: size });
    }
    desktopTray = new Tray(trayImage);
    desktopTray.setToolTip('Browser-use, running');
    desktopTray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Browser-use', click: showDesktopWindow },
      { type: 'separator' },
      { label: 'Quit Browser-use', click: () => app.quit() }
    ]));
    desktopTray.on('click', showDesktopWindow);
    desktopTray.on('double-click', showDesktopWindow);
  } catch (error) {
    desktopTray?.destroy();
    desktopTray = null;
    console.warn('Browser-use tray unavailable; closing the window will quit:', error.message);
  }
}

// Supplied Browser-use icon, generated from desktop/assets/icon-source.png.
function browserUseIcon(size = 256) {
  const suffix = size === 256 ? '' : `-${size}`;
  return path.join(__dirname, 'assets', `browser-use-icon${suffix}.png`);
}

function closeSplashWindow() {
  if (splashRevealTimer) { clearTimeout(splashRevealTimer); splashRevealTimer = null; }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close();
  splashWindow = null;
}

function revealMainWindow(reason = 'renderer-ready') {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindowDidFinishLoad || !mainRendererReady) return false;
  const elapsed = Date.now() - splashStartedAt;
  if (elapsed < SPLASH_MIN_DISPLAY_MS) {
    if (!splashRevealTimer) splashRevealTimer = setTimeout(() => { splashRevealTimer = null; revealMainWindow(reason); }, SPLASH_MIN_DISPLAY_MS - elapsed);
    return false;
  }
  reconcileWindowContentSize();
  layoutSelectedTab();
  if (!mainWindow.isVisible()) mainWindow.show();
  closeSplashWindow();
  if (reason !== 'renderer-ready') addConsoleEntry({ kind: 'startup', level: 'warning', message: `Browser-use revealed after startup fallback: ${reason}.` });
  return true;
}

function createSplashWindow() {
  if (splashWindow && !splashWindow.isDestroyed()) return splashWindow;
  splashStartedAt = Date.now();
  splashWindow = new BrowserWindow({
    width: 760,
    height: 510,
    show: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    roundedCorners: false,
    center: true,
    skipTaskbar: true,
    backgroundColor: '#060b0d',
    title: 'Browser-use',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true }
  });
  splashWindow.on('closed', () => { splashWindow = null; });
  splashWindow.loadFile(path.join(__dirname, 'assets', 'splash-screen.html'));
  return splashWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#060b0d',
    show: false,
    title: 'Browser-use',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#080e10', symbolColor: '#edf2f2', height: 32 },
    icon: browserUseIcon(256),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: true, preload: path.join(__dirname, 'preload.cjs') }
  });
  mainWindow.setMenuBarVisibility(false);
  // Mirror every renderer-bound 'browser-use:*' event to the web GUI (SSE).
  webBridge.attachWebContents(mainWindow.webContents);
  createOverlayView();
  // The browsing surface is part of the shell, not a renderer afterthought.
  // Creating it only after did-finish-load left a visibly interactive agent
  // drawer with no selected tab for several seconds on a cold Electron start.
  // Bootstrap the neutral/home tab as soon as the native window exists so
  // agent actions always have a live target when the renderer accepts input.
  createTab(isHomeUrl(settings.homepage) ? homeUrlWithVersion() : settings.homepage, true);
  agentPointerOverlay = new AgentPointerOverlay({
    BrowserWindow,
    ipcMain,
    parentWindow: mainWindow,
    htmlPath: path.join(__dirname, 'renderer', 'agent-pointer.html'),
    preloadPath: path.join(__dirname, 'pointer', 'agentPointerPreload.cjs'),
    resolveViewport: pointerViewportBounds,
    onPressedSurfaceInvalidated: (tabId, reason) => browserViewController?.releaseTabPointerButtons(tabId, reason)
  });
  agentPointerOverlay.create();
  agentPointerOverlay.setSelectedTab(selectedTabId);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  for (const geometryEvent of ['resize', 'resized', 'move', 'moved', 'show', 'hide', 'minimize', 'maximize', 'unmaximize', 'restore', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(geometryEvent, () => {
      layoutSelectedTab();
      // The topmost overlay owns the device frame. Refresh its exact native
      // viewport rectangle after every window settle without reattaching the
      // BrowserView, so resizing cannot leave a detached outline behind.
      layoutOverlayView();
      safeIpcSend(liveOverlayWebContents(), 'browser-use:overlay-state', currentState());
      // layoutSelectedTab also recomputes the real BrowserView dock bounds.
      scheduleLayout();
    });
  }
  // Ordinary minimization remains a real taskbar minimization. Hiding here made
  // the app appear to quit even though its process, tabs, and MCP sessions lived.
  mainWindow.on('minimize', () => {
    if (primaryAgentPinned) activeDrawer = 'agent';
    publishState();
  });
  mainWindow.on('close', (event) => {
    if (!isQuitting && desktopTray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('restore', () => {
    primaryAgentPinned = true;
    if (activeDrawer === null) activeDrawer = 'agent';
    syncBrowserViewVisibility();
    publishState();
  });
  mainWindow.on('show', () => {
    if (primaryAgentPinned && activeDrawer === null) activeDrawer = 'agent';
    syncBrowserViewVisibility();
    publishState();
  });
  // OS shutdown/logoff is dismissal, not a request to remain in the tray.
  mainWindow.on('query-session-end', () => { isQuitting = true; });
  wireReloadShortcut(mainWindow.webContents, () => selectedTab()?.webContents);
  mainWindow.on('closed', () => {
    agentPointerOverlay?.dispose();
    agentPointerOverlay = null;
    mainWindow = null;
    mainWindowDidFinishLoad = false;
    mainRendererReady = false;
    overlayView = null;
    activePreview = null;
  });
  mainWindow.webContents.once('did-finish-load', () => {
    mainWindowDidFinishLoad = true;
    // The first reported content size is the one most likely to be stale, and
    // the already-created first page has just been laid out against it.
    reconcileWindowContentSize();
    revealMainWindow('renderer-ready');
  });
  splashRevealTimer = setTimeout(() => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    mainWindowDidFinishLoad = true;
    mainRendererReady = true;
    revealMainWindow('startup-timeout');
  }, 20_000);
}

// Terminal output is broadcast to every window that can host a terminal,
// because the same session is rendered by the dock and by the detached window
// and either may be the one currently showing it.
function broadcastTerminal(channel, payload) {
  for (const target of [mainWindow, terminalDetachedWindow]) {
    if (target && !target.isDestroyed()) target.webContents.send(channel, payload);
  }
}

// True while the agent run that owns a terminal session is still alive
// (foreground chat run or a pool/background run). Ownership, and with it the
// user's read-only restriction on that PTY, ends the moment the run does.
function agentOwnerActive(owner) {  if (!owner) return false;
  const runId = String(owner).replace(/^chat:/, '');
  const state = desktopChatAgent?.state();
  if (state?.id === runId && ['running', 'awaiting_approval', 'paused'].includes(state.status)) return true;
  return (agentPool?.activeRuns || []).some((entry) => {
    const snapshot = entry.instance?.state?.();
    return snapshot?.id === runId && ['running', 'awaiting_approval', 'paused'].includes(snapshot.status);
  });
}

// LORDE_TASKBAR_RECENTS_V1 — surface the 3 most recent pages in the Windows
// taskbar icon's jump list. Each entry relaunches the (single-instance) app
// with the URL as argv; second-instance routes it into a tab. Cheap to
// rebuild, so it refreshes on every recorded visit.
function updateTaskbarRecents() {
  if (process.platform !== 'win32' || !app.isReady() || !historyStore) return;
  try {
    const recents = historyStore.list({ limit: 3 })
      .filter(entry => entry && entry.url && /^https?:\/\//i.test(entry.url));
    if (!recents.length) return;
    app.setUserTasks(recents.map(entry => ({
      type: 'task',
      title: String(entry.title || entry.url).slice(0, 60),
      description: entry.url,
      program: process.execPath,
      args: entry.url,
      iconPath: process.execPath,
      iconIndex: 0
    })));
  } catch { /* jump list is cosmetic — never break navigation over it */ }
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // LORDE_TASKBAR_AUMID_V1 — Windows groups taskbar buttons by AppUserModelId.
  // Without an explicit id every top-level window (detached chat, terminal,
  // notebook, splash) could register its own ghost taskbar entry, so the
  // browser-use icon duplicated itself and the ghosts only vanished on hover.
  // Must match electron-builder.yml appId (com.lorde.browseruse).
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.lorde.browseruse'); } catch { /* cosmetic only */ }
  }
  createSplashWindow();
  // Cache failures are isolated to managed browsing tabs, not Electron's own
  // chrome. Keep the partition durable for normal sessions and log cache errors
  // rather than allowing stale browser state to present as a broken web app.
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  browserSession.on('will-download', (_event, item) => trackDownload(item));
  const networkEntry = (details, failed = false) => {
    const tab = [...tabs.values()].find(item => item.webContents.id === details.webContentsId);
    if (!tab || !/^https?:/.test(details.url)) return;
    addConsoleEntry({ kind: 'network', level: failed || details.statusCode >= 400 ? 'error' : 'info', tabId: tab.id,
      message: failed ? details.error : `${details.method} ${details.statusCode}`,
      url: details.url, method: details.method, statusCode: details.statusCode, resourceType: details.resourceType });
  };
  browserSession.webRequest.onCompleted(details => networkEntry(details));
  browserSession.webRequest.onErrorOccurred(details => networkEntry(details, true));

  historyStore = new HistoryStore({ filePath: path.join(app.getPath('userData'), 'browser-use-history.json'), onError: error => addConsoleEntry({ kind: 'history', level: 'error', message: `Could not save browser history: ${error.message}` }) });
  historyStore.load();
  updateTaskbarRecents();
  // LORDE_HISTORY_CLEAN_V2 â€” history must never show "New Tab": purge legacy
  // homepage rows and rows recorded before the real title was known. Revisits
  // re-record them with their real titles (LORDE_HISTORY_TITLE_V2).
  {
    const before = historyStore.entries.length;
    historyStore.entries = historyStore.entries.filter(entry =>
      entry && !isHomeUrl(entry.url) && String(entry.title || '').trim() !== 'New Tab');
    if (historyStore.entries.length !== before) historyStore.flush();
  }
  credentialStore = new CredentialStore({ safeStorage, filePath: path.join(app.getPath('userData'), 'browser-use-secrets.json') });
  chatHistoryStore = new ChatHistoryStore({ filePath: path.join(app.getPath('userData'), 'browser-use-chat-history.json'), onError: error => addConsoleEntry({ kind: 'history', level: 'error', message: `Could not save chat progress: ${error.message}` }) });
  chatHistoryStore.recoverInterrupted();
  settings = loadSettings();
  saveSettings(settings);
  // Startup Laya check, not deferred to the settings tab: the app learns
  // immediately whether an open-weight model is installed (or a sidecar is
  // already running) and auto-starts it when laya is wanted and the weights
  // are on disk. Fire and forget; the bundled engine covers every gap.
  void getLayaRuntime().maybeAutoStart().catch(() => { });
  // The window does not exist yet, so clamping against its zero-height stage
  // would collapse every saved height to the minimum. Clamp against the real
  // content height later, when terminalLayout() and viewportBounds() run.
  const savedTerminalHeight = Number(settings.terminalHeight);
  terminalHeight = Number.isFinite(savedTerminalHeight) && savedTerminalHeight >= MIN_TERMINAL_HEIGHT
    ? Math.round(savedTerminalHeight)
    : DEFAULT_SETTINGS.terminalHeight;
  // Last-output timestamp per terminal session: "the process is alive" is not
  // "the task is working", an idle claude session would false-positive a
  // busy indicator forever. Fresh output within TERMINAL_BUSY_WINDOW_MS is
  // the evidence of real work.
  terminalActivity = new Map();
  terminalManager = new TerminalBrokerClient({
    ...terminalBrokerConfiguration(),
    onData: (id, data, status) => {
      terminalActivity.set(id, status?.lastOutputAt || Date.now());
      broadcastTerminal('browser-use:terminal-data', { id, data, status });
    },
    onExit: (id, exitCode, status) => {
      terminalActivity.delete(id);
      if (status?.disposed) computerTools?.forgetTerminalSession?.(id);
      if (activeTerminalSessionId === id) activeTerminalSessionId = null;
      broadcastTerminal('browser-use:terminal-exit', { id, exitCode, status });
      publishState();
    }
  });
  try {
    await startDesktopMcp();
  } catch (error) {
    // MCP is an optional bridge. A stale/parallel listener must not reject the
    // Electron ready promise or produce an UnhandledPromiseRejectionWarning.
    // The browser UI and local agent remain available; the state surface tells
    // the user why the bridge is unavailable and settings retry can recover it.
    desktopMcpServer = null;
    addConsoleEntry({ kind: 'mcp', level: 'error', message: error.code === 'MCP_PORT_IN_USE' ? error.message : `Could not start the MCP bridge: ${error.message}` });
    publishMcpState();
  }

  // â”€â”€ Record & Learn / Skill Brain â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // The skill store is one plain, human-editable JSON file; the recorder owns
  // real-time capture. Both reason on the ACTIVE model only (lastRunProvider
  // is exactly the config chat runs use).
  skillsStore = new SkillStore(path.join(app.getPath('userData'), 'record-skills', 'skills.json'));
  recorder = new Recorder({
    userDataDir: app.getPath('userData'),
    emit: (event) => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('browser-use:record-event', event); },
    getProviderConfig: () => activeProviderConfig() || lastRunProviderConfig,
    // Reuse the existing capture system, one shared instance with
    // getComputerTools (its constructor registers IPC handlers).
    capture: getDesktopCapture()
  });
  recorder.attachSkillsStore(skillsStore);
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    // Grant no sensitive hardware/data permissions by default. Persisted web
    // applications still need the normal browser APIs that do not require this
    // handler (cookies, storage, service workers, OAuth redirects) to load.
    addConsoleEntry({ kind: 'permission', level: 'warning', message: `Denied browser permission request: ${permission}` });
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  ipcMain.on('browser-use:renderer-ready', (event) => {
    if (event.sender !== mainWindow?.webContents) return;
    mainRendererReady = true;
    revealMainWindow('renderer-ready');
  });
  ipcMain.handle('browser-use:state', (event) => { const context = chatWindowEntryForContents(event.sender); return safeIpcValue(currentState(context?.entry?.instance || desktopChatAgent, context?.id || '')); });
  ipcMain.handle('browser-use:agent-state', (event) => safeIpcValue(chatWindowEntryForContents(event.sender)?.entry?.instance?.state() || desktopChatAgent?.state() || null));
  // GEN9 persistent notebook: open the popup editor, read, and save (the save
  // merges user sections verbatim â€” user edits always win; agent sections
  // never lose their entries). The run re-reads the file from disk before
  // every decision, so a Save reaches the model without any notification.
  ipcMain.handle('browser-use:notebook-open', (event, payload) => {
    const target = String(payload?.path || '') || activeNotebookPath(event.sender);
    if (!target) return { ok: false, error: 'No notebook is active for this conversation.' };
    openNotebookWindow(target);
    return { ok: true, path: target };
  });
  ipcMain.handle('browser-use:notebook-read', (_event, payload) => {
    const target = String(payload?.path || '');
    if (!target) return { ok: false, error: 'notebook-read needs a path.', content: '' };
    try { return { ok: true, path: target, content: fs.readFileSync(target, 'utf8') }; }
    catch (error) { return { ok: false, error: String(error?.message || error), content: '' }; }
  });
  ipcMain.handle('browser-use:notebook-save', (_event, payload) => {
    const target = String(payload?.path || '');
    if (!target || typeof payload?.content !== 'string') return { ok: false, error: 'notebook-save needs a path and string content.' };
    try {
      require('./agent/runNotebook.cjs').createRunNotebook({ filePath: target }).applyUserEdit(payload.content);
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('browser-use:notebook-saved', { path: target });
      }
      return { ok: true, path: target };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  });
  // LORDE_SUBAGENT_TABS_V366 â€” the user talks to / stops a subagent from its
  // tab in the chat drawer. Modes: deliver (next decision boundary), queue
  // (same, explicit), fast (urgent: interrupts the current step NOW). A
  // resident is woken with the message as its next assignment on its own
  // conversation; queued messages ride along on the wake.
  ipcMain.handle('browser-use:subagent-message', async (_event, payload) => {
    const alias = String(payload?.alias || '').trim();
    const text = String(payload?.text || '').trim();
    const mode = ['deliver', 'queue', 'fast'].includes(String(payload?.mode)) ? String(payload.mode) : 'deliver';
    if (!alias || !text) return { sent: false, note: 'Pick a subagent tab and write a message first.' };
    const record = [...spawnRegistry.values()].reverse().find(candidate => normalizedAgentRecipient(candidate.alias) === normalizedAgentRecipient(alias) && candidate.status !== 'closed');
    if (!record) return { sent: false, note: `No subagent named '${alias}' exists.` };
    touchSubagentRecord(record);
    const message = { from: 'user', fromLabel: 'You', text: text.slice(0, 8000), reply: true, at: Date.now(), ...(mode === 'fast' ? { urgent: true } : {}) };
    const state = record.instance?.state?.();
    if (state && ['running', 'awaiting_approval', 'paused'].includes(state.status)) {
      const delivered = record.instance.receiveAgentMessage(message);
      if (delivered?.delivered === true) return { sent: true, mode, note: mode === 'fast' ? `Fast-forwarded to ${alias}: its current step was interrupted and it has the message now.` : `Queued for ${alias} â€” it gets this at its next decision.` };
      // Storm damping may refuse (cooldown/batch): hold it on the record for
      // the next wake instead of losing it.
      (record.queuedUserMessages ||= []).push(message);
      return { sent: true, queued: true, mode, note: `${alias} is mid-step; your message is queued and will be delivered at its next decision.` };
    }
    const queued = (record.queuedUserMessages || []).splice(0);
    const combined = queued.length ? { ...message, text: [message.text, ...queued.map(q => q.text)].join('\n\n') } : message;
    const started = startSubagentFollowUp(record, combined);
    return { sent: started.started === true, mode, note: started.note };
  });
  ipcMain.handle('browser-use:subagent-stop', async (_event, payload) => {
    const alias = String(payload?.alias || '').trim();
    const record = [...spawnRegistry.values()].reverse().find(candidate => normalizedAgentRecipient(candidate.alias) === normalizedAgentRecipient(alias) && candidate.status !== 'closed');
    if (!record) return { stopped: false, note: `No subagent named '${alias}' exists.` };
    const state = record.instance?.state?.();
    if (state && ['running', 'awaiting_approval', 'paused'].includes(state.status)) {
      try { record.instance.cancel(state.id); } catch (error) { return { stopped: false, note: String(error?.message || error).slice(0, 200) }; }
      touchSubagentRecord(record);
      // Authoritative: the cancel targeted the instance's CURRENT run id at
      // call time (state.id above); report the fresh post-cancel status and
      // push state so every renderer's action row updates instantly.
      publishState();
      const after = record.instance?.state?.();
      const freshStatus = String(after?.status || record.status || 'cancelling');
      return { stopped: true, status: freshStatus, note: `${alias} stop requested (now ${freshStatus}); it stays resident with its conversation intact.` };
    }
    return { stopped: false, status: String(record.instance?.state?.()?.status || record.status || 'idle'), note: `${alias} is not running (status: ${record.instance?.state?.()?.status || record.status || 'idle'}).` };
  });
  // LORDE_SUBAGENT_TABS_V366 â€” the Ã— on a subagent tab closes that subagent
  // entirely (cancels an active run, releases the tab, respects worktree
  // rules) through the same path as subagent_close.
  ipcMain.handle('browser-use:subagent-close', async (_event, payload) => {
    const alias = String(payload?.alias || '').trim();
    if (!alias) return { closed: false, note: 'Pick a subagent tab to close.' };
    const result = await subagentApi.close(alias, 'user');
    return { closed: result.closed === true, note: result.note };
  });
  ipcMain.handle('browser-use:agent-preflight', async (_event, request) => {
    const model = String(request?.model || settings.aiChatModel).trim();
    const baseUrl = String(request?.baseUrl || settings.aiChatBaseUrl).trim();
    return preflightOllama({ model, baseUrl });
  });
  ipcMain.handle('browser-use:agent-steer', (event, request) => {
    const agent = chatWindowEntryForContents(event.sender)?.entry?.instance
      || findAgentForRunId(request?.runId)
      || desktopChatAgent;
    if (!agent) throw new Error('The local AI chat agent is unavailable.');
    return agent.steer({
      runId: request?.runId,
      text: request?.text,
      plan: request?.plan,
      goals: request?.goals,
      attachments: request?.attachments,
      domAttachments: request?.domAttachments
    });
  });
  // gen9 port (gen7 /cd): validate and pin the agent-level default working
  // repo. The workspace stays a FOCUS, never an access boundary â€” this only
  // sets which repo LEADS the next conversation that names no path of its own
  // (resolveWorkspaceContract reads the pin after the task's own mentions).
  ipcMain.handle('browser-use:set-default-workspace', (_event, request) => {
    const requested = path.resolve(String(request?.path || '').trim().replace(/^["']+|["']+$/g, ''));
    if (!requested) return { ok: false, error: '/cd needs a directory path.' };
    let stat = null;
    try { stat = fs.statSync(requested); } catch { return { ok: false, error: `Path not found: ${requested}` }; }
    if (!stat.isDirectory()) return { ok: false, error: `Not a directory: ${requested}` };
    defaultWorkspaceRoot = requested;
    addConsoleEntry({ kind: 'agent', level: 'info', message: `[Workspace] Default working repo pinned to ${requested} (via /cd).` });
    return { ok: true, root: requested };
  });
  ipcMain.handle('browser-use:agent-start', async (event, request) => {
    const windowEntry = chatWindowEntryForContents(event.sender);
    const hostAgent = windowEntry?.entry?.instance || desktopChatAgent;
    if (!hostAgent) throw new Error('The local AI chat agent is unavailable.');
    if (request?.tabId && (!tabs.has(String(request.tabId)) || tabs.get(String(request.tabId))?.webContents.isDestroyed())) {
      throw new Error('The requested AI target tab is no longer available.');
    }
    // The Agent drawer reserves browser width rather than covering the native
    // page. Reassert its visible-tab layout without changing a background agent
    // target or forcing it into the foreground.
    syncBrowserViewVisibility();
    const providerId = request?.provider?.id || settings.aiChatProvider || 'ollama';
    // ChatGPT-style live sessions: starting a new chat NEVER kills the
    // previous one. A busy primary conversation is handed off to the live
    // session registry (it keeps running with its own tab and tools) and a
    // fresh instance takes the drawer.
    const primaryState = hostAgent?.state?.() || null;
    const continuation = request?.continuation === true;
    const conversationId = continuation ? String(request?.conversationId || '').trim() : '';
    const sameRunContinuation = continuation && Boolean(primaryState?.id && (!conversationId || conversationId === String(primaryState.id)));
    if (sameRunContinuation && ['running', 'awaiting_approval', 'paused'].includes(primaryState.status)) {
      return primaryState;
    }
    if (sameRunContinuation && primaryState.status === 'awaiting_recovery' && typeof hostAgent.resumeAfterRecovery === 'function') {
      void hostAgent.resumeAfterRecovery().catch(error => addConsoleEntry({ kind: 'agent', level: 'error', message: `Recovery resume failed: ${String(error?.message || error)}` }));
      return hostAgent.state();
    }
    const primaryBusy = !windowEntry && Boolean(primaryState && ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(primaryState.status));
    const continuesPrimary = sameRunContinuation;
    if (primaryBusy && !continuesPrimary) {
      chatSessions.set(primaryState.id, hostAgent);
      pruneChatSessions();
      desktopChatAgent = createChatAgent();
      addConsoleEntry({ kind: 'agent', level: 'info', message: `[Sessions] "${String(primaryState.title || 'Untitled').slice(0, 60)}" continues in the background, a new chat started independently.` });
      publishState();
    }
    // Tab ownership arbitration: a live session that owns the requested tab
    // keeps it. This run starts its OWN tab at the same address instead of
    // fighting for input, focus, and navigation.
    let targetTabId = request?.tabId ? String(request.tabId) : selectedTabId;
    const runOwnedTabIds = new Set();
    const requestedTab = tabs.get(String(targetTabId));
    const requestedAddress = requestedTab && !requestedTab.webContents.isDestroyed() ? requestedTab.webContents.getURL() : '';
    const tabOwner = findLiveTabOwner(targetTabId);
    if (windowEntry) {
      const existingOwnedTab = [...(windowEntry.entry.tabIds || [])].map(String).map(id => tabs.get(id)).find(tab => tab && !tab.webContents.isDestroyed());
      if (existingOwnedTab) {
        targetTabId = existingOwnedTab.id;
        for (const staleTabId of [...(windowEntry.entry.tabIds || [])].map(String)) {
          if (staleTabId === String(targetTabId)) continue;
          if (tabs.has(staleTabId)) closeTab(staleTabId);
          windowEntry.entry.tabIds.delete(staleTabId);
        }
      } else {
        const freshTab = createTab(requestedAddress || '', false);
        targetTabId = freshTab.id;
        runOwnedTabIds.add(String(targetTabId));
        windowEntry.entry.tabIds?.add(String(targetTabId));
        addConsoleEntry({ kind: 'navigation', message: `[Sessions] ${windowEntry.entry.label || 'independent chat'} created its dedicated AI tab.` });
      }
    } else if (tabOwner && String(tabOwner.id) !== String(request?.conversationId || '')) {
      const freshTab = createTab(requestedAddress || '', false);
      targetTabId = freshTab.id;
      runOwnedTabIds.add(String(targetTabId));
      addConsoleEntry({ kind: 'agent', level: 'info', message: `[Sessions] requested tab is owned by "${String(tabOwner.title || 'another session').slice(0, 60)}", this session started its own tab at the same address.` });
    }
    const conversation = conversationId ? chatHistoryStore?.get(conversationId) : null;
    if (conversationId && !conversation && hostAgent?.state()?.id !== conversationId) {
      throw new Error('This saved conversation is no longer available. Open History and choose it again.');
    }
    if (windowEntry?.entry?.tabIds && targetTabId) windowEntry.entry.tabIds.add(String(targetTabId));
    for (const tabId of windowEntry?.entry?.tabIds || []) runOwnedTabIds.add(String(tabId));
    const commonRequest = {
      task: request?.task,
      attachments: request?.attachments,
      domAttachments: request?.domAttachments,
      continuation,
      conversationId,
      conversation,
      tabId: targetTabId,
      ownedTabIds: [...runOwnedTabIds],
      workspace: request?.workspace || resolveWorkspaceContract(request?.task),
      settings: {
        ...(request?.settings || {}),
        controlMode: request?.settings?.controlMode === 'browser' || request?.settings?.controlMode === 'agi'
          ? normalizeControlMode(request.settings.controlMode)
          : normalizeControlMode(settings.agentControlMode),
        approvalMode: request?.settings?.approvalMode || settings.agentApprovalMode,
        effort: normalizeAgentEffort(request?.settings?.effort || settings.agentEffort),
        layaBrain: request?.settings?.layaBrain ?? settings.layaBrain,
        layaEnabled: request?.settings?.layaEnabled !== undefined ? Boolean(request.settings.layaEnabled) : Boolean(settings.layaEnabled),
        layaEndpoint: request?.settings?.layaEndpoint ?? settings.layaEndpoint,
        jevBaseUrl: request?.settings?.jevBaseUrl ?? settings.jevBaseUrl,
        jevModelId: request?.settings?.jevModelId ?? settings.jevModelId,
        providerEnabled: request?.settings?.providerEnabled !== undefined ? request.settings.providerEnabled !== false : settings.providerEnabled !== false
      }
    };
    // DesktopChatAgent creates a neutral task tab when a clean Electron profile
    // has not finished selecting its first visible tab yet. Do not duplicate
    // that startup race as an IPC-level hard stop.
    // `DesktopChatAgent.start()` resolves when the whole browser task ends.
    // Invoke it once, then return the freshly published run snapshot instead.
    // The renderer therefore has a real run id immediately for Stop, New chat,
    // and History while the completion continues through normal agent events.
    const beginAgentRun = (agentRequest) => {
      const queuedMessages = windowEntry?.entry?.pendingMessages || [];
      const identity = windowEntry ? `agent${chatAgentNumber(windowEntry.entry) || 2}` : 'agent1';
      const requestWithMessages = { ...agentRequest, agentIdentity: identity, ...(queuedMessages.length ? { initialAgentMessages: queuedMessages } : {}) };
      const previous = hostAgent.state();
      const completion = hostAgent.start(requestWithMessages);
      if (queuedMessages.length && windowEntry?.entry) windowEntry.entry.pendingMessages = [];
      const started = hostAgent.state();
      const alreadyRunning = ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(previous?.status);
      if (!started || alreadyRunning || !['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(started.status)) return completion;
      void completion.catch((error) => {
        addConsoleEntry({ kind: 'agent', level: 'error', message: `AI chat background task failed: ${String(error?.message || error)}` });
      });
      return started;
    };
    // Laya verify toggle on: keep the sidecar alive automatically (bundled
    // engine answers until it is ready, the run never waits on it).
    if (settings.layaEnabled) void getLayaRuntime().maybeAutoStart().catch(() => { });
    // Provider disable: Laya standalone mode, no provider resolution, no
    // credential gates; commands go straight to Laya (bundled engine, or the
    // full model if the user consented to download it and it is healthy).
    if (settings.providerEnabled === false) {
      // The sidecar self-heals: if laya is wanted and on disk, start it.
      void getLayaRuntime().maybeAutoStart().catch(() => { });
      return beginAgentRun({ ...commonRequest, provider: { id: 'laya', endpoint: settings.layaEndpoint } });
    }
    if (providerId === 'cloud') {
      const apiKey = credentialStore?.get('browserUseCloudApiKey') || process.env.BROWSER_USE_API_KEY || '';
      if (!apiKey) throw new Error('Browser Use Cloud requires a secure API key. Add it in Settings.');
      const model = String(request?.provider?.model || settings.browserUseCloudModel || '').trim();
      if (!model) throw new Error('Choose a Browser Use Cloud model in AI provider settings.');
      return beginAgentRun({
        ...commonRequest,
        provider: { id: 'cloud', model },
      });
    }
    if (PROVIDER_LABELS[providerId]) {
      const connectionId = String(request?.provider?.connectionId || settings.aiChatConnectionId || '');
      const connection = connectionById(connectionId);
      if (!connection || connection.provider !== providerId) throw new Error('Save this provider connection before starting an agent task.');
      const apiKey = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
      if (!apiKey) throw new Error(`Add an API key to the ${PROVIDER_LABELS[providerId]} connection before starting the agent.`);
      const model = String(request?.provider?.model || connection.model || '').trim();
      if (!model) throw new Error(`Choose a ${PROVIDER_LABELS[providerId]} model in AI provider settings.`);
      return beginAgentRun({
        ...commonRequest,
        provider: { id: providerId, connectionId: connection.id, baseUrl: connection.baseUrl, model },
      });
    }
    const model = String(request?.provider?.model || request?.model || settings.aiChatModel).trim();
    const baseUrl = String(request?.provider?.baseUrl || request?.baseUrl || settings.aiChatBaseUrl).trim();
    return beginAgentRun({
      ...commonRequest,
      provider: { id: 'ollama', model, baseUrl },
    });
  });
  ipcMain.handle('browser-use:agent-cancel', async (event, request) => {
    const agent = chatWindowEntryForContents(event.sender)?.entry?.instance || findAgentForRunId(request?.runId) || desktopChatAgent;
    try {
      // IPC handler return values are serialized by Electron separately from
      // agent-event sends. Always return a plain JSON projection here; a
      // non-cloneable run snapshot otherwise throws inside agent-cancel and
      // leaves the renderer unable to stop the runaway process.
      return safeIpcValue(await agent.cancel(request?.runId), { status: 'cancelled' });
    } catch (error) {
      // A stale renderer run id must never leave a live run un-stoppable:
      // Stop cancels whichever run is actually running.
      if (!/Unknown AI chat run/i.test(String(error?.message || ''))) throw error;
      const live = ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'];
      for (const instance of liveAgentInstances()) {
        const snapshot = instance?.state?.();
        if (live.includes(snapshot?.status)) return safeIpcValue(await instance.cancel(snapshot.id), { status: 'cancelled' });
      }
      throw error;
    }
  });
  ipcMain.handle('browser-use:agent-retire', async (_event, conversationId) => {
    const id = String(conversationId || '').trim();
    if (!id) return { retired: false };
    await computerTools?.releaseOwner(`chat:${id}`);
    publishState();
    return { retired: true };
  });
  ipcMain.handle('browser-use:agent-approve', (event, request) => (chatWindowEntryForContents(event.sender)?.entry?.instance || findAgentForRunId(request?.runId) || desktopChatAgent)?.approve(request || {}));
  ipcMain.handle('browser-use:settings', () => publicSettings());
  ipcMain.handle('browser-use:provider-status', () => publicSettings().providers);
  // â”€â”€ Record & Learn / Skill Brain IPC â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  ipcMain.handle('browser-use:record-start', () => recorder.start());
  ipcMain.handle('browser-use:record-stop', () => recorder.stop());
  ipcMain.handle('browser-use:record-status', () => recorder.status());
  ipcMain.handle('browser-use:record-recheck-model', () => recorder.recheckModel());
  ipcMain.handle('browser-use:record-proposal', (_event, proposalId) => recorder.proposal(proposalId));
  ipcMain.handle('browser-use:record-proposal-resolve', (_event, payload) => recorder.resolveProposal(payload?.proposalId, { keep: payload?.keep }));
  ipcMain.handle('browser-use:skills-list', () => [...(skillsStore?.list() || []), ...installedSkillRows()]);
  ipcMain.handle('browser-use:skills-save', (_event, skill) => {
    const installed = skill?.id ? require('./agent/skillsManager.cjs').parseSkillId(skill.id) : null;
    if (installed) {
      // Installed packages are toggled here through the manager's state file;
      // their text is edited through skills-update (which rewrites SKILL.md).
      const manager = installedSkillsManager();
      return skill.status === 'paused' ? manager.disable(skill.id) : manager.enable(skill.id);
    }
    return skill?.id ? skillsStore.update(skill.id, skill) : skillsStore.add(skill, {});
  });
  // VIEW: the full text of one skill, read from disk. The list endpoint only
  // carries a one-line summary of an installed skill's body, which is why the
  // screen could show a skill's name but never what it actually says.
  ipcMain.handle('browser-use:skills-read', (_event, skillId) => {
    const { parseSkillId, parseFrontmatter } = require('./agent/skillsManager.cjs');
    if (!parseSkillId(skillId)) {
      const learned = skillsStore?.get(skillId);
      return learned ? { ok: true, kind: 'learned', skill: learned } : { ok: false, error: 'That skill no longer exists.' };
    }
    const skill = installedSkillsManager().get(skillId);
    if (!skill) return { ok: false, error: 'That skill no longer exists.' };
    try {
      const parsed = parseFrontmatter(fs.readFileSync(skill.file, 'utf8'));
      return { ok: true, kind: 'installed', skill: { ...skill, steps: undefined, body: parsed.body.replace(/^\n+/, ''), meta: parsed.meta } };
    } catch (error) { return { ok: false, error: `Could not read ${skill.file}: ${error.message}` }; }
  });
  // EDIT: title, description, trigger phrases and instructions of an installed
  // skill. The SKILL.md on disk is rewritten, so the agent and the screen can
  // never disagree about what the skill says.
  ipcMain.handle('browser-use:skills-update', (_event, payload) => {
    try {
      const skill = installedSkillsManager().edit(String(payload?.id || ''), {
        name: payload?.name, description: payload?.description, triggers: payload?.triggers, body: payload?.body
      });
      return { ok: true, skill };
    } catch (error) { return { ok: false, error: error.message }; }
  });
  ipcMain.handle('browser-use:skills-delete', (_event, skillId) => {
    const installed = require('./agent/skillsManager.cjs').parseSkillId(skillId);
    if (installed) return installedSkillsManager().remove(skillId);
    return skillsStore.remove(skillId);
  });
  ipcMain.handle('browser-use:preflight-provider', async (_event, request) => {
    const provider = String(request?.provider || 'ollama');
    if (provider === 'cloud') {
      const configured = Boolean(credentialStore?.get('browserUseCloudApiKey') || process.env.BROWSER_USE_API_KEY);
      if (!configured) throw new Error('Set a Browser Use Cloud API key before checking this provider.');
      return { ok: true, provider: 'cloud', message: 'Cloud key is securely configured. A remote task will validate it when you run one.' };
    }
    if (PROVIDER_LABELS[provider]) {
      const connection = connectionById(request?.connectionId || settings.aiChatConnectionId);
      if (!connection || connection.provider !== provider) throw new Error('Save this provider connection before testing it.');
      const apiKey = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
      if (!apiKey) throw new Error(`Add an API key to ${PROVIDER_LABELS[provider]} before testing this connection.`);
      // Provider onboarding already discovers models through this authenticated
      // endpoint. Reuse that transport proof instead of asking an arbitrary
      // selected model to emit Browser-use JSON merely to say that its account
      // is reachable. A conversational formatting quirk must never make a
      // valid provider connection look broken before the agent can start.
      const response = await fetchWithBoundedRetry(`${String(connection.baseUrl || '').replace(/\/$/, '')}/models`, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` }
      });
      if (!response.ok) throw new Error(`${PROVIDER_LABELS[provider]} model discovery failed (${response.status}).`);
      const payload = await response.json();
      const models = [...new Set((Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []).map((entry) => String(entry?.id || entry?.name || entry?.model || '').trim()).filter(Boolean))];
      const requestedModel = String(request?.model || connection.model || '').trim();
      if (requestedModel && models.length && !models.includes(requestedModel)) {
        throw new Error(`The selected ${PROVIDER_LABELS[provider]} model is no longer available from this connection. Refresh the model list and choose an available model.`);
      }
      return { ok: true, provider, message: `${PROVIDER_LABELS[provider]} connection is ready.` };
    }
    return preflightOllama({ model: String(request?.model || settings.aiChatModel), baseUrl: String(request?.baseUrl || settings.aiChatBaseUrl) });
  });
  await terminalManager.connect();
  activeTerminalSessionId = terminalManager.list()[0]?.id || null;
  ipcMain.handle('browser-use:list-provider-models', async (_event, request) => {
    const provider = String(request?.provider || 'ollama');
    if (provider === 'cloud') return { provider, models: [], message: 'This legacy remote provider does not expose account model discovery through the Desktop app.' };
    if (PROVIDER_LABELS[provider]) {
      const connection = connectionById(request?.connectionId || settings.aiChatConnectionId);
      if (!connection) return { provider, models: [], message: 'Save this connection, then refresh its models.' };
      const headers = { accept: 'application/json' };
      const key = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
      if (key) headers.authorization = `Bearer ${key}`;
      let response;
      try {
        response = await fetchWithBoundedRetry(`${String(connection.baseUrl || '').replace(/\/$/, '')}/models`, { headers });
      } catch (error) {
        // LORDE_CATALOG_PRESERVE_V1 — failed:true lets the renderer keep the
        // previously discovered catalog instead of wiping it on a dead endpoint.
        return { provider, models: [], failed: true, message: `Model discovery failed: the provider endpoint is unreachable (${String(error?.cause?.code || error?.code || error?.message || error).slice(0, 120)}). Check the connection's base URL and network.` };
      }
      if (!response.ok) return { provider, models: [], failed: true, message: `Model discovery failed for this provider endpoint (${response.status}).` };
      const payload = await response.json();
      const discoveredRaw = [...new Set((Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []).map((model) => String(model?.id || model?.name || model?.model || '').trim()).filter(Boolean))];
      // User-added custom models (and an explicitly saved model) always appear,
      // even when the gateway omits them from /models (image-gen, preview ids).
      // Entries carry {id, kind}; legacy strings infer their kind from the id.
      const custom = (Array.isArray(connection.customModels) ? connection.customModels : [])
        .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
        .filter(Boolean);
      if (connection.model && !custom.some((entry) => entry.id === connection.model)) custom.unshift({ id: connection.model, kind: inferModelKind(connection.model) });
      const discovered = [...new Set([...custom.map((entry) => entry.id), ...discoveredRaw])]
        .map((id) => {
          // Pricing/context ride along when the gateway reports them (xkiro
          // /models does) â€” the renderer computes the run footer's COST from
          // the active model's usdPerM [input,output] per 1M tokens.
          const entry = (Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [])
            .find((item) => String(item?.id || item?.name || item?.model || '').trim() === id) || {};
          const pricing = entry.pricing || {};
          const meta = { id, kind: (custom.find((entry) => entry.id === id) || {}).kind || inferModelKind(id) };
          if (Number.isFinite(Number(pricing.input)) || Number.isFinite(Number(pricing.output))) {
            meta.usdPerM = [Number(pricing.input) || 0, Number(pricing.output) || 0];
          }
          if (Number.isFinite(Number(entry.context_length)) && Number(entry.context_length) > 0) meta.ctx = Number(entry.context_length);
          return meta;
        });
      return { provider, models: discovered };
    }
    const baseUrl = new URL(String(request?.baseUrl || settings.aiChatBaseUrl || 'http://127.0.0.1:11434'));
    if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Ollama base URL must use http or https.');
    const response = await fetchWithBoundedRetry(`${baseUrl.toString().replace(/\/$/, '')}/api/tags`);
    if (!response.ok) throw new Error(`Ollama model discovery failed (${response.status}).`);
    const payload = await response.json();
    const models = [...new Set((Array.isArray(payload?.models) ? payload.models : []).map((model) => String(model?.name || model?.model || '').trim()).filter(Boolean))];
    return { provider, models };
  });
  ipcMain.handle('browser-use:set-provider-credential', (_event, request) => {
    if (request?.provider === 'jev') return credentialStore.set(JEV_CREDENTIAL_KEY, String(request?.secret || ''));
    if (request?.provider === 'cloud') return credentialStore.set('browserUseCloudApiKey', String(request?.secret || ''));
    const connection = connectionById(request?.connectionId);
    if (!connection || connection.provider !== request?.provider) throw new Error('Unknown provider connection.');
    return credentialStore.set(connectionCredentialKey(connection.id), String(request?.secret || ''));
  });
  ipcMain.handle('browser-use:clear-provider-credential', (_event, provider) => {
    if (provider?.provider === 'jev' || provider === 'jev') return credentialStore.clear(JEV_CREDENTIAL_KEY);
    if (provider?.provider === 'cloud' || provider === 'cloud') return credentialStore.clear('browserUseCloudApiKey');
    const connection = connectionById(provider?.connectionId);
    if (!connection) throw new Error('Unknown provider connection.');
    return credentialStore.clear(connectionCredentialKey(connection.id));
  });
  ipcMain.handle('browser-use:save-ai-connection', (_event, request) => {
    const provider = String(request?.provider || 'ollama');
    if (!['ollama', 'cloud', ...Object.keys(PROVIDER_LABELS)].includes(provider)) throw new Error('Unknown AI provider.');
    const baseUrl = String(request?.baseUrl || '').trim();
    if (provider === 'ollama' && !baseUrl) throw new Error('Enter an Ollama gateway URL.');
    if (provider !== 'cloud' && provider !== 'ollama' && !baseUrl) throw new Error('Enter the provider base URL.');
    const id = String(request?.id || crypto.randomUUID());
    const existing = normalizedConnections();
    const previous = existing.find((connection) => connection.id === id);
    const model = String(request?.model === undefined ? previous?.model || '' : request.model || '').trim();
    // Preserve user-added custom models and enabled state across connection edits.
    const connection = {
      id,
      provider,
      name: uniqueConnectionName(request?.name || `${provider} connection`, existing, previous ? id : ''),
      baseUrl,
      model,
      enabled: request?.enabled === undefined ? previous?.enabled !== false : request.enabled !== false,
      customModels: Array.isArray(previous?.customModels) ? previous.customModels : []
    };
    const aiConnections = [...existing.filter((item) => item.id !== id), connection];
    const saved = saveSettings({ ...settings, aiConnections, aiChatConnectionId: id, aiChatProvider: provider, aiChatModel: provider === 'ollama' ? model : settings.aiChatModel, aiChatBaseUrl: provider === 'ollama' ? baseUrl : settings.aiChatBaseUrl, browserUseCloudModel: provider === 'cloud' ? model : settings.browserUseCloudModel });
    return { ...connection, settings: publicSettings(), saved };
  });
  // User-added custom model ids: gateways omit image-gen/preview models from
  // /models; a user-added id is persisted on the connection and merged into
  // every future discovery by list-provider-models.
  // Media models (image/video/TTS/STT) bypass the agent decision loop
  // entirely: they are called directly with the user's prompt and the
  // result renders in chat. An image model routed through the loop would
  // hang â€” image gateways never stream chat decisions.
  // Shared with the agent's computer_model tool: runMediaTaskForConnection
  // (module scope, below fetchWithBoundedRetry) resolves the connection,
  // builds the same-kind catalogue (user-tagged custom models first, then
  // kind-inferred discovery), and delegates to the media router (async job
  // polling, lenient JSON recovery, fallback cycle).
  ipcMain.handle('browser-use:generate-media', async (_event, request) => {
    return runMediaTaskForConnection({
      connectionId: request?.connectionId,
      kind: request?.kind || 'image',
      model: request?.model,
      prompt: request?.prompt,
      voice: request?.voice,
      fileBase64: request?.fileBase64,
      filename: request?.filename,
      imagePath: request?.imagePath,
      saveTo: request?.saveTo,
    });
  });
  // TTS VOICES (docs.xkiro.com/api/audio-voices/ â€” live-verified 200, 145
  // entries): the picker data for xkiro connections. Empty list on anything
  // else or on failure â€” the connection default voice still works.
  ipcMain.handle('browser-use:tts-voices', async (_event, request) => {
    const connection = connectionById(request?.connectionId || settings.aiChatConnectionId);
    if (!connection) return { voices: [] };
    const apiKey = credentialStore?.get(connectionCredentialKey(connection.id)) || '';
    const base = String(connection.baseUrl || '').replace(/\/$/, '');
    if (!apiKey || !/xkiro\./i.test(base)) return { voices: [] };
    try {
      const response = await fetchWithBoundedRetry(base + '/audio/voices', { headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` } });
      if (!response.ok) return { voices: [] };
      const payload = await response.json();
      const voices = (Array.isArray(payload?.voices) ? payload.voices : [])
        .map((entry) => ({ id: String(entry?.id || ''), name: String(entry?.name || entry?.id || '') }))
        .filter((entry) => entry.id)
        .slice(0, 300);
      return { voices };
    } catch { return { voices: [] }; }
  });
  ipcMain.handle('browser-use:set-tts-voice', (_event, request) => {
    const connection = connectionById(request?.connectionId);
    if (!connection) throw new Error('Unknown provider connection.');
    const voice = String(request?.voice || '').trim();
    const aiConnections = normalizedConnections().map((item) => item.id === connection.id ? { ...connection, ttsVoice: voice } : item);
    saveSettings({ ...settings, aiConnections });
    return { connectionId: connection.id, voice, ok: true };
  });
  ipcMain.handle('browser-use:set-model-kind', (_event, request) => {
    const connection = connectionById(request?.connectionId);
    if (!connection) throw new Error('Unknown provider connection.');
    const model = String(request?.model || '').trim();
    if (!model) throw new Error('A model id is required.');
    const kind = String(request?.kind || '').trim();
    if (!MODEL_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MODEL_KINDS.join(', ')}`);
    const entries = (Array.isArray(connection.customModels) ? connection.customModels : []).map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)));
    const existing = entries.find((entry) => entry.id === model);
    if (existing) existing.kind = kind;
    else entries.push({ id: model, kind });
    const aiConnections = normalizedConnections().map((item) => item.id === connection.id ? { ...connection, customModels: entries } : item);
    saveSettings({ ...settings, aiConnections });
    return { connectionId: connection.id, model, kind, models: entries };
  });
  ipcMain.handle('browser-use:add-provider-model', (_event, request) => {
    const id = String(request?.connectionId || '');
    const model = String(request?.model || '').trim().replace(/[\r\n]+/g, ' ');
    if (!model || model.length > 240) throw new Error('Enter a valid model id.');
    const kind = String(request?.kind || '').trim() || inferModelKind(model);
    if (!MODEL_KINDS.includes(kind)) throw new Error(`kind must be one of: ${MODEL_KINDS.join(', ')}`);
    const existing = normalizedConnections();
    const connection = existing.find((item) => item.id === id);
    if (!connection) throw new Error('Unknown provider connection.');
    // customModels entries are {id, kind}; legacy string entries normalize on
    // save so a kind can be attached to any model the user has added.
    const entries = (Array.isArray(connection.customModels) ? connection.customModels : [])
      .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
      .filter(Boolean);
    if (!entries.some((entry) => entry.id === model)) entries.push({ id: model, kind });
    const updated = { ...connection, customModels: entries, model: connection.model || model };
    const aiConnections = existing.map((item) => item.id === id ? updated : item);
    saveSettings({ ...settings, aiConnections });
    return { provider: connection.provider, connectionId: id, model, kind, models: entries };
  });
  ipcMain.handle('browser-use:remove-provider-model', (_event, request) => {
    const connection = connectionById(request?.connectionId);
    if (!connection) throw new Error('Unknown provider connection.');
    const model = String(request?.model || '').trim();
    if (!model) throw new Error('A model id is required.');
    const entries = (Array.isArray(connection.customModels) ? connection.customModels : [])
      .map((entry) => normalizeCustomModel(entry, inferModelKind(typeof entry === 'object' ? entry?.id : entry)))
      .filter(Boolean);
    const next = entries.filter((entry) => entry.id !== model);
    const aiConnections = normalizedConnections().map((item) => item.id === connection.id ? { ...connection, customModels: next, model: item.model === model ? '' : item.model } : item);
    saveSettings({ ...settings, aiConnections });
    return { connectionId: connection.id, removed: model, models: next };
  });
  // Direct-composer media generation bypasses the agent loop, so nothing
  // would otherwise persist it. This records the exchange as a conversation
  // with the bounded media payload on the transcript entry.
  ipcMain.handle('browser-use:record-media-history', (_event, request) => {
    if (!chatHistoryStore) return { recorded: false };
    const now = Date.now();
    const kind = String(request?.kind || 'image');
    const prompt = String(request?.prompt || '').trim();
    const model = String(request?.model || '').trim();
    const media = request?.media && typeof request.media === 'object' ? request.media : null;
    const connection = connectionById(request?.connectionId);
    const summary = kind === 'stt'
      ? String(request?.text || 'Transcription complete.')
      : `Generated ${kind}${model ? ` with ${model}` : ''}.`;
    chatHistoryStore.checkpoint({
      id: String(request?.id || `media-${now}-${Math.random().toString(36).slice(2, 7)}`),
      title: prompt.slice(0, 58) || `Generated ${kind}`,
      provider: connection?.provider || 'xkiro',
      model: model || connection?.model || '',
      status: 'completed',
      success: true,
      createdAt: now, updatedAt: now,
      messages: [
        { role: 'user', content: prompt || `Generate ${kind}.`, at: now - 1000 },
        { role: 'assistant', content: summary, at: now }
      ],
      transcript: [{
        type: 'computer_model', tool: 'computer_model', at: now, step: 1,
        input: { kind, prompt: prompt.slice(0, 500) },
        output: { ok: true, result: { ok: true, kind, model, url: media?.url || null } },
        ...(media ? { media } : {})
      }]
    });
    return { recorded: true };
  });
  ipcMain.handle('browser-use:set-ai-connection-model', (_event, request) => {
    const id = String(request?.connectionId || '');
    const model = String(request?.model || '').trim();
    if (!model || model.length > 240 || /[\r\n]/.test(model)) throw new Error('Choose a valid discovered model.');
    const existing = normalizedConnections();
    const connection = existing.find((item) => item.id === id);
    if (!connection) throw new Error('Unknown provider connection.');
    const updated = { ...connection, model };
    const aiConnections = existing.map((item) => item.id === id ? updated : item);
    saveSettings({
      ...settings,
      aiConnections,
      aiChatConnectionId: id,
      aiChatProvider: updated.provider,
      aiChatModel: updated.provider === 'ollama' ? model : settings.aiChatModel,
      browserUseCloudModel: updated.provider === 'cloud' ? model : settings.browserUseCloudModel
    });
    return publicSettings();
  });
  ipcMain.handle('browser-use:set-ai-connection-enabled', (_event, request) => {
    const id = String(request?.connectionId || '');
    const existing = normalizedConnections();
    const connection = existing.find((item) => item.id === id);
    if (!connection) throw new Error('Unknown provider connection.');
    const aiConnections = existing.map((item) => item.id === id ? { ...item, enabled: request?.enabled !== false } : item);
    saveSettings({ ...settings, aiConnections });
    return publicSettings();
  });
  ipcMain.handle('browser-use:remove-ai-connection', (_event, connectionId) => {
    const id = String(connectionId || '');
    const existing = normalizedConnections();
    if (!existing.some((connection) => connection.id === id)) return publicSettings();
    credentialStore?.clear(connectionCredentialKey(id));
    const aiConnections = existing.filter((connection) => connection.id !== id);
    saveSettings({ ...settings, aiConnections, aiChatConnectionId: settings.aiChatConnectionId === id ? '' : settings.aiChatConnectionId });
    return publicSettings();
  });
  ipcMain.handle('browser-use:chat-history-list', () => chatHistoryStore?.load() || []);
  ipcMain.handle('browser-use:chat-history-get', (_event, id) => chatHistoryStore?.get(id));
  ipcMain.handle('browser-use:chat-history-delete', async (_event, id) => {
    await computerTools?.releaseOwner(`chat:${String(id || '')}`);
    return chatHistoryStore?.remove(id) || [];
  });
  ipcMain.handle('browser-use:chat-history-clear', async () => {
    const ids = (chatHistoryStore?.load() || []).map((record) => record.id);
    await Promise.allSettled(ids.map((id) => computerTools?.releaseOwner(`chat:${id}`)));
    return chatHistoryStore?.clear() || [];
  });
  ipcMain.handle('browser-use:history-list', (_event, query) => historyStore?.list(query || {}) || []);
  ipcMain.handle('browser-use:history-delete', (_event, id) => historyStore?.remove(String(id || '')) || 0);
  ipcMain.handle('browser-use:history-clear', (_event, options) => historyStore?.clearBefore(options || {}) || 0);
  ipcMain.handle('browser-use:downloads-open', async (_event, id) => {
    const entry = downloadItems.get(String(id || ''));
    if (!entry || entry.state !== 'completed') throw new Error('That download is not complete.');
    const error = await shell.openPath(entry.path);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('browser-use:downloads-show', (_event, id) => {
    const entry = downloadItems.get(String(id || ''));
    if (!entry || entry.state !== 'completed') throw new Error('That download is not complete.');
    shell.showItemInFolder(entry.path);
    return true;
  });
  ipcMain.handle('browser-use:schedule-list', () => scheduler?.status() || { jobs: [], recentOccurrences: [], inFlight: [], queued: 0 });
  ipcMain.handle('browser-use:schedule-update', (_event, payload) => {
    if (!scheduler) throw new Error('The scheduler is not running.');
    return scheduler.manage({ action: payload?.action || 'update', ...payload });
  });
  ipcMain.handle('browser-use:schedule-preview', (_event, payload) => {
    if (!scheduler) throw new Error('The scheduler is not running.');
    return scheduler.manage({ action: 'preview', ...payload });
  });
  ipcMain.handle('browser-use:schedule-create', (_event, payload) => {
    if (!scheduler) throw new Error('The scheduler is not running.');
    return scheduler.manage({ action: 'create', ...payload });
  });
  ipcMain.handle('browser-use:schedule-remove', (_event, payload) => {
    if (!scheduler) throw new Error('The scheduler is not running.');
    return scheduler.manage({ action: 'remove', jobId: payload?.jobId });
  });
  ipcMain.handle('browser-use:save-settings', async (event, patch) => {
    if (![mainWindow?.webContents, liveOverlayWebContents()].includes(event.sender)) throw new Error('Settings require a trusted Browser-use window.');
    const previousMcpMode = settings.mcpControlMode;
    const previousAgentMode = settings.agentControlMode;
    const previousGptEnabled = settings.gptActionEnabled;
    const previousGptKey = settings.gptApiKey;
    const previousGptPublicOrigin = settings.gptActionPublicOrigin;
    const saved = saveSettings({ ...settings, ...patch });
    if (previousMcpMode === 'agi' && saved.mcpControlMode !== 'agi') {
      const run = desktopChatAgent?.state();
      if (run?.computerOwner?.startsWith('mcp:') && ['running', 'awaiting_approval', 'paused'].includes(run.status)) desktopChatAgent.cancel(run.id);
      await computerTools?.releasePrefix('mcp:');
    }
    if (previousAgentMode === 'agi' && saved.agentControlMode !== 'agi') {
      const run = desktopChatAgent?.state();
      if (run && !run.computerOwner?.startsWith('mcp:') && ['running', 'awaiting_approval', 'paused'].includes(run.status)) desktopChatAgent.cancel(run.id);
      await computerTools?.releasePrefix('chat:');
    }
    const restartGptBridge = saved.gptActionEnabled !== previousGptEnabled || saved.gptApiKey !== previousGptKey;
    if (restartGptBridge) {
      await stopDesktopMcp();
      await startDesktopMcp();
    }
    if (restartGptBridge || saved.gptActionPublicOrigin !== previousGptPublicOrigin || saved.mcpControlMode !== previousMcpMode) publishMcpState();
    // publicSettings(), not the raw settings object: the raw object still
    // carries gptApiKey (a renderer leak) and lacks the computed credential
    // statuses (aiConnections, jevCredential) the renderer's UI state
    // depends on â€” assigning it over publicSettings wiped Jev's configured
    // flag and re-disabled the option after every settings save.
    return publicSettings();
  });
  ipcMain.handle('browser-use:desktop-mcp-status', () => ({ ...desktopMcpStatus(), ...connectionConfiguration() }));
  ipcMain.handle('browser-use:create-pairing-offer', () => {
    if (!sessionBroker) throw new Error('The local MCP service is unavailable.');
    const offer = sessionBroker.createPairingOffer();
    const configuration = connectionConfiguration();
    publishMcpState();
    return {
      ...configuration,
      pairingCode: offer.pairingCode,
      expiresAt: offer.expiresAt,
      claudeCodeCommand: claudeCodeMcpInstallCommand(configuration.endpoint, configuration.authenticationEndpoint)
    };
  });
  ipcMain.handle('browser-use:cancel-pairing-offer', () => {
    const cancelled = sessionBroker?.cancelPairingOffer() || false;
    publishMcpState();
    return cancelled;
  });
  ipcMain.handle('browser-use:mcp-connection-configuration', () => connectionConfiguration());
  ipcMain.handle('browser-use:gpt-action-schema', () => gptActionSchemaSnapshot());
  ipcMain.handle('browser-use:mcp-sessions', () => desktopMcpStatus().sessions);
  ipcMain.handle('browser-use:revoke-mcp-session', (_event, sessionId) => {
    const revoked = sessionBroker?.revoke(String(sessionId)) || false;
    publishMcpState();
    return revoked;
  });
  ipcMain.handle('browser-use:revoke-all-mcp-sessions', () => {
    const count = sessionBroker?.revokeAll() || 0;
    publishMcpState();
    return count;
  });
  ipcMain.handle('browser-use:copy-text', (_event, text) => { clipboard.writeText(String(text || '')); return true; });
  ipcMain.handle('browser-use:save-pasted-text-attachment', async (_event, request = {}) => {
    // Large paste handling: read from the main-process clipboard and write it
    // straight to the app-owned attachments folder. The renderer never puts
    // the large string into the contenteditable DOM or sends it through the
    // agent request body.
    const text = clipboard.readText();
    if (!text) throw new Error('The clipboard has no text to attach.');
    const max = 50 * 1024 * 1024;
    if (Buffer.byteLength(text, 'utf8') > max) throw new Error('The pasted text exceeds the 50MB attachment limit.');
    const dir = path.join(app.getPath('userData'), 'attachments');
    await fs.promises.mkdir(dir, { recursive: true });
    const hint = String(request.name || 'pasted-text').replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'pasted-text';
    const name = `${hint}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.txt`;
    const target = path.join(dir, name);
    await fs.promises.writeFile(target, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return { id: crypto.randomUUID(), name, mimeType: 'text/plain', kind: 'path', path: target, size: Buffer.byteLength(text, 'utf8'), pasted: true };
  });
  ipcMain.handle('browser-use:show-app-menu', (event, name, anchor) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Application menu is available only to the main window.');
    const templates = {
      file: [ { label: 'New Tab', accelerator: 'CmdOrCtrl+T', click: () => createTab('', true) }, { type: 'separator' }, { role: 'quit' } ],
      edit: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ],
      view: [ { label: 'Reload page', accelerator: 'CmdOrCtrl+R', click: () => selectedTab()?.webContents.reload() }, { label: 'Developer tools', click: () => selectedTab()?.webContents.toggleDevTools() }, { type: 'separator' }, { role: 'togglefullscreen' }, { type: 'separator' }, { label: 'About', click: () => setAboutOpen(true) } ],
      window: [ { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { label: 'Settings', click: () => setActiveDrawer('settings') }, { label: 'Console', click: () => setActiveDrawer('console') }, { role: 'close' } ]
    };
    const template = templates[name];
    if (!template) throw new Error('Unknown application menu.');
    const [width] = mainWindow.getContentSize();
    return new Promise(resolve => Menu.buildFromTemplate(template).popup({ window: mainWindow, x: Math.max(0, Math.min(width - 1, Math.round(Number(anchor?.x) || 0))), y: 32, callback: () => resolve(true) }));
  });
  ipcMain.handle('browser-use:show-tab-group', (event, ids, anchor) => {
    if (event.sender !== mainWindow?.webContents) throw new Error('Tab groups are available only to the main window.');
    const hidden = [...new Set(Array.isArray(ids) ? ids.map(String) : [])].map(id => tabs.get(id)).filter(tab => tab && !tab.webContents.isDestroyed());
    if (!hidden.length) return false;
    const template = hidden.map(tab => ({ label: String(tab.title || 'New Tab').replaceAll('&', '&&'), type: 'checkbox', checked: tab.id === selectedTabId, click: () => showTab(tab.id) }));
    const [width] = mainWindow.getContentSize();
    return new Promise(resolve => Menu.buildFromTemplate(template).popup({ window: mainWindow,
      x: Math.max(0, Math.min(width - 1, Math.round(Number(anchor?.x) || 0))),
      y: Math.max(32, Math.min(APP_CHROME_HEIGHT, Math.round(Number(anchor?.y) || 66))),
      callback: () => resolve(true) }));
  });
  ipcMain.handle('browser-use:show-context-menu', (event, request) => showDesktopContextMenu(event, request));
  ipcMain.handle('browser-use:open-chat-window', () => openIndependentChatWindow());
  ipcMain.handle('browser-use:close-chat-window', (event, id) => {
    const owner = chatWindowEntryForContents(event.sender);
    // A renderer can only close its own extra chat. Ignore any supplied id
    // when the sender is not one of the managed chat surfaces, so a stale DOM
    // value cannot accidentally target Chat 1 or another pane.
    if (!owner?.id) return { closed: false };
    return { closed: Boolean(closeIndependentChatWindow(owner.id)) };
  });
  ipcMain.handle('browser-use:set-chat-pinned', (event, request) => {
    const windowEntry = chatWindowEntryForContents(event.sender);
    const id = request?.id || windowEntry?.id || '';
    return setChatPinned(id, request?.pinned !== false);
  });
  ipcMain.handle('browser-use:open-report-preview', (_event, request) => openReportPreview(request));
  ipcMain.handle('browser-use:open-screenshot-preview', (_event, request) => openScreenshotPreview(request));
  ipcMain.handle('browser-use:read-report-preview', (_event, request) => readReportPreview(request));
  // LORDE_CHAT_LINKS_V364 â€” links in chat come from model output: untrusted.
  // Only http(s) may leave the app, through shell.openExternal â€” the chat
  // window itself can never navigate to a model-authored URL.
  ipcMain.handle('browser-use:open-external', (_event, url) => {
    const value = String(url || '').trim();
    if (!/^https?:\/\//i.test(value)) throw new Error('Only http(s) links can be opened externally.');
    return shell.openExternal(value);
  });
  ipcMain.handle('browser-use:open-media-preview', (_event, request) => openMediaPreview(request));
  ipcMain.handle('browser-use:close-preview', () => closePreview());
  ipcMain.handle('browser-use:download-preview', () => downloadActivePreview());
  ipcMain.handle('browser-use:set-active-drawer', (_event, nextDrawer) => setActiveDrawer(nextDrawer));
  ipcMain.handle('browser-use:set-agent-drawer-width', (_event, request) => {
    const payload = request && typeof request === 'object' ? request : { width: request };
    const [contentWidth] = mainWindow?.getContentSize() || [AGENT_DRAWER_WIDTH];
    agentDrawerWidth = Math.min(Math.max(MIN_AGENT_DRAWER_WIDTH, Math.round(Number(payload.width) || AGENT_DRAWER_WIDTH)), Math.max(MIN_AGENT_DRAWER_WIDTH, contentWidth - 180));
    if (activeDrawer === 'agent' || pinnedChatEntries().length) {
      layoutSelectedTab();
      publishChatDockGeometry();
    }
    if (payload.emitState !== false) publishState();
    return agentDrawerWidth;
  });
  ipcMain.handle('browser-use:set-chat-window-width', (event, request) => {
    const context = chatWindowEntryForContents(event.sender);
    const id = String(context?.id || request?.id || '');
    const entry = chatAgentWindows.get(id);
    if (!entry) throw new Error('That chat window no longer exists.');
    const revision = Math.max(0, Math.round(Number(request?.revision) || 0));
    if (revision && revision <= entry.dockResizeRevision) return entry.dockWidth;
    if (revision) entry.dockResizeRevision = revision;
    const [contentWidth] = mainWindow?.getContentSize() || [AGENT_DRAWER_WIDTH];
    entry.dockWidth = Math.min(Math.max(240, Math.round(Number(request?.width) || AGENT_DRAWER_WIDTH)), Math.max(240, contentWidth - 180));
    if (entry.pinned) {
      // Match Chat 1's geometry authority. Resize in place, then publish only
      // the lightweight dock signal during a drag. The full state is reserved
      // for the final pointerup/keyboard commit.
      layoutSelectedTab();
      publishChatDockGeometry();
    }
    if (request?.emitState !== false) publishState();
    return entry.dockWidth;
  });
  // Geometry of the native browsing surface, so the desktop suite can assert the
  // page is not cropped instead of only checking renderer chrome.
  ipcMain.handle('browser-use:viewport-metrics', () => {
    const tab = selectedTab();
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    const [contentWidth, contentHeight] = mainWindow.getContentSize();
    return {
      chromeHeight: APP_CHROME_HEIGHT,
      content: { width: contentWidth, height: contentHeight },
      expected: viewportBounds(),
      // The stage is the page area before a device frame is centred inside it,
      // so a test can tell a letterboxed device apart from a cropped page.
      stage: stageBounds(),
      device: tab && deviceEmulator ? deviceEmulator.state(tab.id) : null,
      terminal: terminalLayout(),
      activeDrawer,
      selectedTabId,
      attached: Boolean(tab && isAttached(tab)),
      bounds: tab && isAttached(tab) ? tab.view.getBounds() : null
    };
  });
  ipcMain.handle('browser-use:device-profiles', () => listDeviceProfiles());
  ipcMain.handle('browser-use:device-state', () => (selectedTabId ? deviceEmulator.state(selectedTabId) : null));
  // Native Android devices (ADB + scrcpy), separate from CDP browser emulation.
  ipcMain.handle('browser-use:android-devices-list', () => androidDeviceManager?.snapshot() || { devices: [], selectedSerial: null });
  ipcMain.handle('browser-use:android-devices-refresh', async () => androidDeviceManager.refresh());
  ipcMain.handle('browser-use:android-devices-pair', async (_event, request) => androidDeviceManager.pair(request || {}));
  ipcMain.handle('browser-use:android-devices-connect', async (_event, request) => androidDeviceManager.connect(request || {}));
  ipcMain.handle('browser-use:android-devices-disconnect', async (_event, request) => androidDeviceManager.disconnect(request?.serial));
  ipcMain.handle('browser-use:android-devices-remove', async (_event, request) => androidDeviceManager.remove(request?.serial));
  ipcMain.handle('browser-use:android-devices-select', (_event, request) => androidDeviceManager.select(request?.serial));
  ipcMain.handle('browser-use:android-devices-programmatic-input', (_event, request) => androidDeviceManager.setProgrammaticTaps(request?.serial, request?.enabled));
  ipcMain.handle('browser-use:android-devices-adb', async (_event, request) => androidDeviceManager.command(request || {}));
  ipcMain.handle('browser-use:android-devices-stream-start', async (_event, request) => androidDeviceManager.startStream(request || {}));
  ipcMain.handle('browser-use:android-devices-stream-stop', async (_event, request) => androidDeviceManager.stopStream(request?.serial));
  ipcMain.handle('browser-use:android-devices-stream-bounds', (_event, bounds) => setAndroidStreamBounds(bounds || {}));
  ipcMain.on('browser-use:android-stream-input', (event, input = {}) => {
    const tab = [...tabs.values()].find((candidate) => candidate.webContents === event.sender);
    const serial = tab?.androidStreamSerial;
    const tunnel = serial ? androidDeviceManager?.sessions?.get(serial) : null;
    if (!tunnel || typeof tunnel.send !== 'function') return;
    try {
      if (input.type === 'touch' && androidDeviceManager.inputPolicy.isProgrammatic(serial)) void androidDeviceManager.handlePointer({ serial, action: input.action === 2 ? 'drag' : 'click', x: input.x, y: input.y, endX: input.x, endY: input.y, displayWidth: input.width, displayHeight: input.height, deviceWidth: input.width, deviceHeight: input.height }).catch((error) => addConsoleEntry({ kind: 'android', level: 'warn', message: `Programmatic stream input failed: ${error.message}` }));
      else if (input.type === 'touch') tunnel.sendTouch(input);
      else if (input.type === 'key') tunnel.sendKey(input);
      else if (input.type === 'text') tunnel.sendText(input.text);
      else if (input.type === 'scroll') tunnel.sendScroll?.(input);
    } catch (error) { addConsoleEntry({ kind: 'android', level: 'warn', message: `Android stream input failed: ${error.message}`, tabId: tab?.id || null }); }
  });
  ipcMain.on('browser-use:android-stream-stats', (event, stats) => {
    const tab = [...tabs.values()].find((candidate) => candidate.webContents === event.sender);
    if (tab) { tab.androidStreamStats = stats; publishState(); }
  });
  ipcMain.handle('browser-use:set-device-mode', async (_event, options) => {
    const tabId = selectedTabId;
    if (!tabId) throw new Error('No active tab is available.');
    const state = await deviceEmulator.setDeviceMode(tabId, {
      profileId: options?.profileId || DESKTOP_ID,
      orientation: options?.orientation || (options?.profileId === DESKTOP_ID ? 'landscape' : 'portrait'),
      showTouches: options?.showTouches ?? settings.showTouchIndicators
    });
    // The emulated viewport changes the size of the native surface, so the
    // stage has to be re-measured before the letterbox can be correct.
    layoutSelectedTab();
    scheduleLayout();
    syncBrowserViewVisibility();
    if (state.mode === 'desktop') hideDeviceZoomBadge();
    publishState();
    return state;
  });
  ipcMain.handle('browser-use:rotate-device', async () => {
    if (!selectedTabId) throw new Error('No active tab is available.');
    const state = await deviceEmulator.rotate(selectedTabId);
    layoutSelectedTab();
    scheduleLayout();
    syncBrowserViewVisibility();
    publishState();
    return state;
  });
  ipcMain.handle('browser-use:set-show-touches', async (_event, showTouches) => {
    if (!selectedTabId) throw new Error('No active tab is available.');
    const state = await deviceEmulator.setShowTouches(selectedTabId, showTouches !== false);
    publishState();
    return state;
  });
  // Device-canvas zoom (Ctrl+Scroll is the owner-facing path; this IPC is the
  // programmatic one used by tests and available to chrome UI). Setting the
  // zoom re-fits the native surface exactly like a mode change: display =
  // fitScale * zoom, layout viewport untouched.
  ipcMain.handle('browser-use:set-device-zoom', (_event, zoom) => {
    if (!selectedTabId) throw new Error('No active tab is available.');
    const result = deviceEmulator.setZoomFactor(selectedTabId, zoom);
    if (result.changed) {
      layoutSelectedTab();
      scheduleLayout();
    }
    showDeviceZoomBadge(selectedTabId, result.zoom);
    publishState();
    return deviceEmulator.state(selectedTabId);
  });
  ipcMain.handle('browser-use:terminal-layout', () => terminalLayout());
  ipcMain.handle('browser-use:terminal-backend', () => terminalManager.backendInfo());
  ipcMain.handle('browser-use:toggle-terminal', (_event, next) => {
    terminalDocked = typeof next === 'boolean' ? next : !terminalDocked;
    // A docked terminal and a detached window are the same session in two
    // places; showing the dock reclaims it from the detached window.
    if (terminalDocked && terminalDetachedWindow && !terminalDetachedWindow.isDestroyed()) {
      terminalDetachedWindow.close();
      terminalDetachedWindow = null;
    }
    layoutSelectedTab();
    scheduleLayout();
    publishState();
    return terminalLayout();
  });
  ipcMain.handle('browser-use:set-terminal-height', (_event, height) => {
    terminalHeight = clampTerminalHeight(height);
    saveSettings({ ...settings, terminalHeight });
    layoutSelectedTab();
    scheduleLayout();
    publishState();
    return terminalLayout();
  });
  ipcMain.handle('browser-use:detach-terminal', () => {
    openDetachedTerminal();
    return terminalLayout();
  });
  ipcMain.handle('browser-use:terminal-create', async (_event, options) => {
    if (activeTerminalSessionId) {
      const existing = terminalManager.snapshot(activeTerminalSessionId);
      if (existing) return existing;
      activeTerminalSessionId = null;
    }
    // Refresh the pushed environment (registry-backed, cached 30s) so Reset
    // and new terminals pick up a just-changed system-wide API key without
    // waiting for an app restart.
    await terminalManager.pushEnvironment({ maxAgeMs: 30_000 }).catch(() => {});
    const created = await terminalManager.create({
      cwd: options?.cwd,
      cols: options?.cols,
      rows: options?.rows
    });
    activeTerminalSessionId = created.id;
    publishState();
    return created;
  });
  ipcMain.handle('browser-use:terminal-active-session', async (_event, options) => {
    if (!activeTerminalSessionId) return null;
    const existing = terminalManager.snapshot(activeTerminalSessionId);
    if (!existing || ['exited', 'error'].includes(existing.phase)) return null;
    return terminalManager.setDimensions(activeTerminalSessionId, options?.cols, options?.rows);
  });
  // Every broker session, the user's own and agent-owned ones (badged), so
  // the docked panel can list and attach to an agent's long-running work.
  ipcMain.handle('browser-use:terminal-sessions', async () => {
    const brokerState = await terminalManager.state().catch(() => ({ sessions: terminalManager.list() }));
    return (brokerState.sessions || []).map((entry) => {
      const owner = computerTools?.agentSessionOwner(entry.id) || null;
      const lastOutputAt = entry.lastOutputAt || terminalActivity?.get(entry.id) || 0;
      return {
        ...entry,
        id: entry.id, cwd: entry.cwd || '', shell: entry.shell || '', disposed: Boolean(entry.disposed),
        agent: Boolean(owner), owner, agentActive: owner ? agentOwnerActive(owner) : false,
        lastOutputAt,
        working: Boolean(owner) && agentOwnerActive(owner) && entry.phase === 'running' && (Date.now() - lastOutputAt) < TERMINAL_BUSY_WINDOW_MS
      };
    });
  });
  ipcMain.handle('browser-use:terminal-attach', async (_event, id) => {
    const session = await terminalManager.refresh(String(id || '')).catch(() => terminalManager.snapshot(String(id || '')));
    if (!session) throw new Error('That terminal session is no longer available.');
    activeTerminalSessionId = ['exited', 'error'].includes(session.phase) ? null : String(id);
    publishState();
    return { ...session, id: session.id, history: String(session.history || '').slice(-64_000), agentActive: agentOwnerActive(computerTools?.agentSessionOwner(String(id))) };
  });
  ipcMain.handle('browser-use:terminal-write', (_event, id, data) => {
    if (agentOwnerActive(computerTools?.agentSessionOwner(id))) {
      addConsoleEntry({ kind: 'terminal', level: 'warning', message: 'This terminal is owned by a running agent task, input is read-only until it finishes.' });
      return { blocked: true };
    }
    return terminalManager.writeInput(id, data);
  });
  ipcMain.handle('browser-use:terminal-recover', async (_event, id) => {
    const owner = computerTools?.agentSessionOwner?.(String(id || '')) || null;
    if (owner && agentOwnerActive(owner)) return { blocked: true };
    const recovered = await terminalManager.recover(String(id || ''));
    if (!recovered) throw new Error('Only an exited Claude Code session can be recovered.');
    computerTools?.replaceTerminalSession?.(String(id), recovered.id);
    activeTerminalSessionId = recovered.id;
    publishState();
    return recovered;
  });
  ipcMain.handle('browser-use:terminal-resize', (_event, id, cols, rows) => terminalManager.resize(id, cols, rows));
  ipcMain.handle('browser-use:terminal-dispose', async (_event, id) => {
    const owner = computerTools?.agentSessionOwner?.(String(id || '')) || null;
    if (owner && agentOwnerActive(owner)) return { blocked: true };
    const disposed = await terminalManager.dispose(id);
    computerTools?.forgetTerminalSession?.(id);
    if (String(id) === activeTerminalSessionId) activeTerminalSessionId = null;
    publishState();
    return disposed;
  });
  ipcMain.handle('browser-use:terminal-screenshot', () => captureScreenshotToDisk());
  ipcMain.handle('browser-use:pick-element', () => pickElement());
  ipcMain.handle('browser-use:cancel-pick-element', () => cancelPickElement());
  ipcMain.handle('browser-use:dom-selection', () => readDomSelection());
  ipcMain.handle('browser-use:recording-pick-path', async () => {
    const result = await dialog.showSaveDialog(mainWindow, { title: 'Save screen recording', defaultPath: path.join(app.getPath('videos'), `Browser-use-${Date.now()}.mp4`), filters: [{ name: 'MP4 video', extensions: ['mp4'] }] });
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle('browser-use:recording-status', () => sharedDesktopCapture?.snapshotFor?.('ui-recorder') || { state: 'idle' });
  ipcMain.handle('browser-use:recording-stop', async () => { const result = await getDesktopCapture().record({ action: 'stop' }, 'ui-recorder'); publishState(); return result; });
  ipcMain.handle('browser-use:recording-start', async (_event, input = {}) => {
    const maxDuration = input.maxDuration === 'auto' ? 0 : Math.max(1, Math.min(24 * 60, Number(input.maxDuration) || 1));
    const result = await getDesktopCapture().record({ action: 'start', mode: input.mode === 'screen' ? 'screen' : input.mode === 'tab' ? 'tab' : 'window', tabId: String(input.tabId || ''), path: input.path, fps: Number(input.fps) || 30, width: Number(input.width) || 1920, speed: Math.max(1, Math.min(10, Number(input.speed) || 1)), maxDuration, audio: Boolean(input.audio) }, 'ui-recorder');
    if (maxDuration) setTimeout(() => getDesktopCapture().record({ action: 'stop' }, 'ui-recorder').then(publishState).catch(() => {}), maxDuration * 60_000);
    publishState(); return result;
  });
  ipcMain.handle('browser-use:close-about', () => setAboutOpen(false));
  ipcMain.handle('browser-use:close-overlay', () => closeOverlay());
  ipcMain.handle('browser-use:set-device-menu-open', (_event, open, anchor) => setDeviceMenuOpen(open, anchor));
  ipcMain.handle('browser-use:toggle-device-menu-open', (_event, anchor) => setDeviceMenuOpen(undefined, anchor));
  ipcMain.handle('browser-use:set-downloads-open', (_event, open, anchor) => setDownloadsOpen(open, anchor));
  ipcMain.handle('browser-use:set-history-menu-open', (_event, open, anchor) => setHistoryMenuOpen(open, anchor));
  ipcMain.handle('browser-use:console', () => consoleEntries);
  ipcMain.handle('browser-use:clear-console', () => { consoleEntries.length = 0; publishConsole(); return []; });
  ipcMain.handle('browser-use:toggle-dev-tools', () => { const tab = selectedTab(); if (tab) tab.webContents.toggleDevTools(); return Boolean(tab); });
  ipcMain.handle('browser-use:new-tab', (_event, url) => tabSummary(createTab(url || '', true)));
  // These handlers must never leak Electron Error objects back over IPC:
  // "An object could not be cloned" happens when a thrown Error is returned
  // unchanged. Wrap and return a plain clone-safe payload instead.
  ipcMain.handle('browser-use:select-tab', (_event, id) => {
    try {
      const changed = showTab(String(id));
      return { ok: true, changed, state: currentState() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || 'Could not select the tab.') };
    }
  });
  ipcMain.handle('browser-use:close-tab', (_event, id) => {
    try {
      const result = closeTab(String(id));
      return { ok: true, state: result && typeof result === 'object' ? result : currentState() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error || 'Could not close the tab.') };
    }
  });
  ipcMain.handle('browser-use:navigate', async (_event, value) => {
    const tab = selectedTab();
    if (!tab) throw new Error('No active tab is available.');
    const url = normalizeUrl(value);
    try {
      await tab.webContents.loadURL(url);
    } catch (error) {
      // ERR_ABORTED (-3): a redirect or a superseding navigation aborted this
      // one (Google Docs hops through accounts.google.com routinely). Not a
      // failure of the navigate request itself.
      if (String(error?.message || '').includes('ERR_ABORTED')) return currentState();
      throw error;
    }
    return currentState();
  });
  ipcMain.handle('browser-use:go-back', () => { const tab = selectedTab(); if (tab?.webContents.navigationHistory.canGoBack()) tab.webContents.navigationHistory.goBack(); return currentState(); });
  ipcMain.handle('browser-use:go-forward', () => { const tab = selectedTab(); if (tab?.webContents.navigationHistory.canGoForward()) tab.webContents.navigationHistory.goForward(); return currentState(); });
  ipcMain.handle('browser-use:reload', async () => {
    const tab = selectedTab();
    if (!tab || tab.webContents.isDestroyed()) return { ok: false, error: 'No active tab is available to reload.' };
    try {
      await tab.webContents.reloadIgnoringCache();
    } catch (error) {
      return { ok: false, error: String(error?.message || error || 'Reload failed.') };
    }
    // Invoke handlers return directly through Electron's structured clone
    // boundary; raw currentState() can contain non-cloneable runtime objects.
    return safeIpcValue({ ok: true, state: currentState() }, { ok: false, error: 'Reload state could not be serialized safely.' });
  });
  createDesktopTray();
  backgroundBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  createWindow();
  // Loopback control bridge for the web GUI (served by cli/tui/guiServer.mjs
  // at http://127.0.0.1:4200). Fire and forget: the desktop app must never
  // fail to start because the bridge port range is busy.
  webBridge.startServer().then((port) => {
    if (port) console.log('[webBridge] loopback control server listening on 127.0.0.1:' + port);
  }).catch(() => { });
  app.on('activate', showDesktopWindow);
  // LORDE_TASKBAR_RECENTS_V1 — a jump-list recent relaunches this executable
  // with the target URL as argv; route it into a tab of the running instance.
  app.on('second-instance', (_event, argv) => {
    showDesktopWindow();
    const argUrl = (argv || []).slice(1).find(arg => /^https?:\/\//i.test(arg));
    if (argUrl) {
      try { createTab(argUrl, true); } catch { /* window may still be warming up */ }
    }
  });
});

let computerShutdown = null;
let computerShutdownReady = false;
app.on('before-quit', (event) => {
  closeSplashWindow();
  if ((computerTools || chatHistoryStore) && !computerShutdownReady) {
    event.preventDefault();
    if (!computerShutdown) {
      isQuitting = true;
      const activeRun = desktopChatAgent?.state();
      if (activeRun && ['running', 'awaiting_approval', 'paused'].includes(activeRun.status)) desktopChatAgent.cancel(activeRun.id);
      agentPool?.cancelAll('Browser-use is quitting; background runs were cancelled.');
      scheduler?.stop();
      try { layaRuntime?.stop(); } catch {}
      // An active recording ends with the app: raw evidence stays on disk for
      // its retention window; the user can still record again after relaunch.
      try { if (recorder?.active) void recorder.stop(); } catch {}
      computerShutdown = Promise.all([computerTools?.close(), androidDeviceManager?.close(), chatHistoryStore?.flush(), schedulerStore?.flush(), historyStore?.flush()]).catch(error => console.error('Shutdown persistence/cleanup:', error.message)).finally(() => {
        computerShutdownReady = true;
        app.quit();
      });
    }
    return;
  }
  isQuitting = true;
  desktopTray?.destroy();
  desktopTray = null;
  if (backgroundBlockerId !== null) powerSaveBlocker.stop(backgroundBlockerId);
  backgroundBlockerId = null;
  // Release held input while the views still exist; server shutdown can finish async.
  browserViewController?.releaseAllInput();
  // The broker deliberately owns terminal processes outside Electron. Closing
  // Browser-use disconnects this client; Reset is the explicit kill action.
  terminalManager?.disconnect();
  debuggerLeaseManager?.close();
  stopDesktopMcp().catch(() => {});
});
app.on('window-all-closed', () => { if (isQuitting || (!desktopTray && process.platform !== 'darwin')) app.quit(); });

// ============================================================================
// GEN9 â€” /skills, /mcp, instruction files (desktop/skills_mcp_plan.md).
// APPEND-ONLY section: the desktop surface of the SAME shared modules the CLI
// /skills and /mcp commands use. Scopes are shared on disk, so a skill or MCP
// server installed here is immediately visible to the CLI and vice versa:
//   user scope:  ~/.browser-use-cli/skills/ + ~/.browser-use-cli/mcp.json
//   repo scope:  <repoRoot>/.browser-use/skills/ + <repoRoot>/.browser-use/mcp.json
// repoRoot is supplied by the renderer (the pinned working repo); when absent
// only the user scope applies. Nothing here gates or blocks a run.
// NOTE (STUB 1, plan doc Section 6): createChatAgent still passes the learned
// skillsApi; the follow-up replaces it with createMergedSkillsApi so installed
// packages reach skill_search/skill_run in desktop runs too.
// ============================================================================
(function registerGen9SkillsMcpIpc() {
  const { ipcMain } = require('electron');
  const { SkillsManager, createMergedSkillsApi } = require('./agent/skillsManager.cjs');
  const { McpConfigStore, McpRegistry } = require('./agent/mcpClient.cjs');
  const { loadInstructionFiles, notebookUserRules } = require('./agent/instructionLoader.cjs');

  const gen9UserCliDir = () => path.join(os.homedir(), '.browser-use-cli');
  const gen9RepoRoot = (root) => {
    const clean = String(root || '').trim();
    return clean;
  };
  const gen9SkillsManager = (repoRoot) => new SkillsManager({
    userDir: path.join(gen9UserCliDir(), 'skills'),
    repoDir: repoRoot ? path.join(repoRoot, '.browser-use', 'skills') : null
  });
  const gen9McpStore = (repoRoot) => new McpConfigStore({
    userFile: path.join(gen9UserCliDir(), 'mcp.json'),
    repoFile: repoRoot ? path.join(repoRoot, '.browser-use', 'mcp.json') : null
  });
  // Long-lived registry so connections (and their reconnect loops) persist for
  // the app session; config changes rebuild connections by signature.
  let gen9McpRegistryInstance = null;
  const gen9McpRegistry = (repoRoot) => {
    const userFile = path.join(gen9UserCliDir(), 'mcp.json');
    const repoFile = repoRoot ? path.join(repoRoot, '.browser-use', 'mcp.json') : null;
    // BUILT-IN: the xkiro-web MCP server (docs.xkiro.com/api/mcp/ â€” web
    // search + fetch as MCP tools at https://api.xkiro.com/mcp/web). Riding
    // the ACTIVE xkiro connection's CURRENT key, synthesized per call, never
    // persisted; a user's own xkiro-web entry would win over it.
    const builtins = [];
    try {
      const connection = connectionById(settings.aiChatConnectionId);
      const key = connection ? (credentialStore?.get(connectionCredentialKey(connection.id)) || '') : '';
      if (connection && key && /xkiro\./i.test(String(connection.baseUrl || ''))) {
        builtins.push({ name: 'xkiro-web', config: { url: 'https://api.xkiro.com/mcp/web', headers: { authorization: `Bearer ${key}` } } });
      }
    } catch { /* builtins are additive â€” never block the registry */ }
    if (!gen9McpRegistryInstance) {
      gen9McpRegistryInstance = new McpRegistry({ userFile, repoFile, connectTimeoutMs: 15000, builtins });
    } else {
      gen9McpRegistryInstance.configStore = new McpConfigStore({ userFile, repoFile });
      gen9McpRegistryInstance.builtins = builtins;
    }
    return gen9McpRegistryInstance;
  };

  ipcMain.handle('browser-use:skills-manage', async (_event, payload = {}) => {
    const op = String(payload.op || 'list');
    const repoRoot = gen9RepoRoot(payload.repoRoot);
    const manager = gen9SkillsManager(repoRoot);
    switch (op) {
      case 'list': return { ok: true, skills: manager.list() };
      case 'get': return { ok: true, skill: manager.get(String(payload.id || '')) };
      case 'search': return { ok: true, results: manager.search({ task: String(payload.task || ''), limit: Number(payload.limit) || 5 }) };
      case 'install':
        try {
          return { ok: true, skill: await manager.install({ source: payload.source, scope: payload.scope === 'repo' && repoRoot ? 'repo' : 'user' }) };
        } catch (error) { return { ok: false, error: error.message }; }
      case 'installFromRegistry':
        try {
          return { ok: true, skill: await manager.installFromRegistry({ registry: payload.registry, name: payload.name, scope: payload.scope === 'repo' && repoRoot ? 'repo' : 'user' }) };
        } catch (error) { return { ok: false, error: error.message }; }
      case 'enable': return { ok: true, skill: manager.enable(String(payload.id || '')) };
      case 'disable': return { ok: true, skill: manager.disable(String(payload.id || '')) };
      case 'remove': return { ok: true, removed: manager.remove(String(payload.id || '')) };
      case 'update':
        try { return { ok: true, skill: await manager.update(String(payload.id || '')) }; }
        catch (error) { return { ok: false, error: error.message }; }
      default: return { ok: false, error: `unknown skills op: ${op}` };
    }
  });

  ipcMain.handle('browser-use:mcp-manage', async (_event, payload = {}) => {
    const op = String(payload.op || 'status');
    const repoRoot = gen9RepoRoot(payload.repoRoot);
    try {
      switch (op) {
        case 'list': {
          const { merged } = gen9McpStore(repoRoot).load();
          return { ok: true, servers: merged };
        }
        case 'add': {
          const saved = gen9McpStore(repoRoot).addServer({ scope: payload.scope === 'repo' && repoRoot ? 'repo' : 'user', name: payload.name, config: payload.config });
          return { ok: true, server: saved };
        }
        case 'enable': case 'disable': {
          const result = gen9McpStore(repoRoot).setEnabled(String(payload.name || ''), op === 'enable');
          return result ? { ok: true, server: result } : { ok: false, error: `no such mcp server: ${payload.name}` };
        }
        case 'auth': {
          const result = gen9McpStore(repoRoot).setHeader(String(payload.name || ''), String(payload.header || ''), String(payload.value || ''));
          return result ? { ok: true, server: result } : { ok: false, error: `no such mcp server: ${payload.name}` };
        }
        case 'remove': return { ok: true, removed: gen9McpStore(repoRoot).removeServer(String(payload.name || '')) };
        case 'status': {
          const registry = gen9McpRegistry(repoRoot);
          if (payload.connect === true) await registry.connectAll();
          return { ok: true, servers: registry.status() };
        }
        case 'test': {
          const registry = gen9McpRegistry(repoRoot);
          const connection = await registry.ensureConnected(String(payload.name || ''));
          return { ok: true, status: connection.status(), tools: registry.listTools() };
        }
        case 'call': {
          const registry = gen9McpRegistry(repoRoot);
          return { ok: true, result: await registry.call(String(payload.tool || ''), payload.args || {}) };
        }
        case 'tools': {
          const registry = gen9McpRegistry(repoRoot);
          if (payload.connect === true) await registry.connectAll();
          return { ok: true, tools: registry.listTools() };
        }
        default: return { ok: false, error: `unknown mcp op: ${op}` };
      }
    } catch (error) { return { ok: false, error: error.message }; }
  });

  // Instruction files for the pinned repo (renderer preview + notebook
  // seeding). The agent-side injection itself is desktopChatAgent STUB 3.
  ipcMain.handle('browser-use:instructions-load', async (_event, payload = {}) => {
    try {
      const instructions = loadInstructionFiles({ repoRoot: gen9RepoRoot(payload.repoRoot), cwd: process.cwd() });
      return { ok: true, instructions, notebookRules: notebookUserRules(instructions) };
    } catch (error) { return { ok: false, error: error.message }; }
  });
})();
