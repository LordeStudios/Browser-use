// cli/tui/guiBackend.mjs
//
// Standalone backend for the web GUI — pure Node, NO Electron, NO desktop app.
//
// Design intent (owner's architecture rule): the GUI and the TUI complement
// each other, and either must work without the other. The GUI is the TUI's
// graphical layer (e.g. browser-use TUI in Termux, full experience in mobile
// Chrome). So this backend hosts the SAME runtime agent-cli.mjs uses:
//   launchHeadlessChrome + connectTab (cli/webContentsAdapter.cjs)  -> real tabs
//   BrowserViewController (desktop/mcp)                             -> agent tools
//   DesktopChatAgent (desktop/agent)                                -> real chat
//   resolveProviderConfig (cli/tui/appConfig.mjs)                   -> real key
// Events stream to the page over SSE (browser-use:agent-event, -state,
// -console, -gui-preview); invokes arrive as POST /ipc in guiServer.mjs.
//
// When the desktop app ALSO happens to be running, guiServer.mjs may forward
// channels this backend does not implement to its loopback bridge — but this
// backend never requires it.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import EventEmitter from 'node:events';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, '../..');
const require = createRequire(import.meta.url);

const { launchHeadlessChrome, killChromeTree, connectTab } = require(path.join(TOOL_ROOT, 'cli/webContentsAdapter.cjs'));
const { BrowserViewController } = require(path.join(TOOL_ROOT, 'desktop/mcp/browserViewController.cjs'));
const { DesktopChatAgent } = require(path.join(TOOL_ROOT, 'desktop/agent/desktopChatAgent.cjs'));
const { createOpenAiCompatibleProvider } = require(path.join(TOOL_ROOT, 'desktop/agent/openAiCompatibleProvider.cjs'));
const { createCliModelTaskApi, createCliCatalogApi } = require(path.join(TOOL_ROOT, 'cli/cliAgentApis.cjs'));
const {
  readAppSettings, readAppSecrets, readCliConfig, writeCliConfig, resolveProviderConfig, activeConnection,
} = await import('./appConfig.mjs');

const GUI_DIR = path.join(os.homedir(), '.browser-use-cli');
const SETTINGS_FILE = path.join(GUI_DIR, 'gui-settings.json');

// AI-related settings the GUI shares with the desktop app's store (the SAME
// connection entries and model lists the app's own UI shows, and the same
// source the TUI reads). The GUI's own file only stores local overrides.
const APP_SETTINGS_FIELDS = [
  'aiChatProvider', 'aiChatConnectionId', 'aiChatModel', 'aiChatBaseUrl',
  'aiConnections', 'agentControlMode', 'agentApprovalMode', 'agentEffort',
];

const DEFAULT_SETTINGS = Object.freeze({
  homepage: 'https://studios.lordemaximus.com/newtab',
  aiChatProvider: '',
  aiChatConnectionId: '',
  aiChatModel: '',
  aiChatBaseUrl: '',
  aiConnections: [],
  agentControlMode: 'browser',
  agentApprovalMode: 'auto',
  agentEffort: 'standard',
});

// LORDE_HOME_URL_V2 — legacy GUI homepages (google default, local file) all
// migrate to the hosted new-tab page, mirroring the desktop app.
const LEGACY_HOMEPAGES = new Set([
  'https://www.google.com/',
  'http://www.google.com/',
  'https://google.com/',
  'https://www.example.com',
]);

function normalizeHomepage(raw) {
  const url = String(raw || '').trim();
  if (!url) return DEFAULT_SETTINGS.homepage;
  if (LEGACY_HOMEPAGES.has(url.replace(/\/+$/, '') + '/') || LEGACY_HOMEPAGES.has(url)) return DEFAULT_SETTINGS.homepage;
  if (url.includes('homepage.html')) return DEFAULT_SETTINGS.homepage;
  return url;
}

function isHomeUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (raw === settings.homepage || raw === settings.homepage.replace(/\/+$/, '')) return true;
  return raw.includes('homepage.html');
}

const bus = new EventEmitter();
bus.setMaxListeners(50);
let terminalDocked = false; // page-local terminal panel toggle state

let runtime = null;          // { chrome, tabs, selectedTabId, controller, agent, provider }
let runtimeStarting = null;  // promise — single-flight boot
let appSecretsEntries = {};  // 'aiProvider:<connId>' -> { ok, key } (decrypted safeStorage)
let settings = loadSettings();
let resolvedProvider = null; // app/TUI credential resolution (used when no connection saved)
let credentialsReady = null; // promise — the slow safeStorage decrypt refinement
let loopbackBase = '';       // http://127.0.0.1:<port> — set by guiServer; backs the error pages

function loadAppAI() {
  try {
    const app = readAppSettings()?.settings || {};
    const picked = {};
    for (const field of APP_SETTINGS_FIELDS) {
      if (app[field] !== undefined) picked[field] = app[field];
    }
    return picked;
  } catch {
    return {};
  }
}

function loadSettings() {
  // Layered: defaults ← the desktop app's AI store ← the GUI's own overrides.
  let gui = {};
  try {
    gui = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {};
  } catch { /* first run */ }
  const merged = { ...DEFAULT_SETTINGS, ...loadAppAI(), ...gui };
  merged.homepage = normalizeHomepage(merged.homepage);
  return merged;
}

function saveSettingsFile() {
  try {
    fs.mkdirSync(GUI_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  } catch { /* settings persistence is best effort */ }
  // Every settings write also projects the provider setup into the CLI config.
  // The provider flow saves through browser-use:save-ai-connection and
  // set-provider-credential, which never touched the config file, so the
  // terminal and the runner stayed disconnected from the interface.
  syncCliConfig();
}

// ONE PROVIDER SETUP FOR BOTH SURFACES. A provider added in the web interface
// used to land only in gui-settings.json, so the terminal and `browser-use run`
// never saw it and every message failed with "no provider API key". The active
// connection is now projected into the CLI's own config file, which the TUI and
// the runner already read.
function syncCliConfig() {
  try {
    const connections = Array.isArray(settings.aiConnections) ? settings.aiConnections : [];
    if (!connections.length) return;
    const active = connections.find((item) => item && item.id === settings.aiChatConnectionId) || connections[0];
    if (!active) return;
    const existing = readCliConfig().config || {};
    const secret = String(
      active.credential?.secret || active.apiKey || active.secret || existing.apiKey || ''
    );
    writeCliConfig({
      ...existing,
      connectionId: active.id || existing.connectionId,
      providerId: active.provider || active.providerId || existing.providerId,
      baseUrl: active.baseUrl || settings.aiChatBaseUrl || existing.baseUrl,
      // The connection the user just saved owns the model; the global chat
      // model can be stale from an earlier selection.
      model: active.model || settings.aiChatModel || existing.model,
      apiKey: secret || existing.apiKey,
      updatedAt: new Date().toISOString()
    });
  } catch { /* a failed projection must never break a settings save */ }
}

// Credential for a saved connection, resolved from the decrypted app secrets
// store (entry key 'aiProvider:<connectionId>' — the same lookup the desktop
// main.cjs credentialStore.get uses).
function credentialFor(connectionId) {
  const entry = appSecretsEntries['aiProvider:' + String(connectionId || '')];
  return entry?.ok ? String(entry.key || '') : '';
}

function emitEvent(channel, payload) {
  bus.emit('event', { channel, payload });
}

function addConsole(kind, level, message) {
  emitEvent('browser-use:console', [{ kind, level, message, at: Date.now() }]);
}

function normalizeUrl(value) {
  const raw = String(value ?? '').trim();
  if (/^(https?|file|about|data|chrome|view-source):/i.test(raw)) return raw;
  if (/^[\w-]+(\.[\w-]+)+/.test(raw)) return `https://${raw}`;
  return raw;
}

function tabSummaries() {
  if (!runtime) return [];
  return [...runtime.tabs.values()].map((entry) => ({
    id: String(entry.tab.id),
    title: entry.tab.webContents.getTitle() || entry.tab.webContents.getURL() || 'New tab',
    // The homepage URL is hidden from the address bar (shows empty), exactly
    // like the desktop app's LORDE_HOME_URL_V2 behavior.
    url: isHomeUrl(entry.tab.webContents.getURL()) ? '' : entry.tab.webContents.getURL(),
    loading: entry.tab.webContents.isLoading(),
    active: entry.tab.id === runtime.selectedTabId,
    canGoBack: entry.tab.webContents.navigationHistory?.canGoBack?.() || false,
    canGoForward: entry.tab.webContents.navigationHistory?.canGoForward?.() || false,
  }));
}

function buildState() {
  return {
    tabs: tabSummaries(),
    selectedTabId: runtime ? String(runtime.selectedTabId || '') : '',
    agent: runtime?.agent ? runtime.agent.state() : null,
    consoleEntries: [],
    downloads: downloadsItems(), // renderer expects a plain array (state.downloads)
    device: { ...deviceState },
    mcp: {
      running: false,
      status: 'unavailable',
      reason: 'The web GUI runs standalone — desktop MCP pairing is only in the desktop app.',
      sessions: [],
      tools: [],
    },
    settings,
    terminal: { docked: terminalDocked, windowed: false },
  };
}

function publishState() {
  emitEvent('browser-use:state', buildState());
}

function resolvedProviderInfo() {
  if (resolvedProvider) return resolvedProvider;
  try {
    // The EXACT credential chain the TUI uses (cli/tui.mjs credentialsReady):
    // app settings select the active connection, the app secrets store is
    // decrypted through the repo's electron binary (pure-Node safeStorage
    // GCM does not verify headless), then CLI config / env fill the gaps.
    const appRead = readAppSettings();
    const appSettings = appRead?.settings || null;
    const provider = String(appSettings?.aiChatProvider || '').trim();
    const connId = String(appSettings?.aiChatConnectionId || '').trim();
    const connections = Array.isArray(appSettings?.aiConnections) ? appSettings.aiConnections : [];
    const connection = connections.find((entry) => String(entry?.id || '') === connId) || null;
    const appConnectionId = connection && provider && connection.provider === provider ? connId : null;
    // Fast first resolution (env / cli config / app connection values), then
    // the slow safeStorage decrypt refines it — the TUI awaits this before
    // any run; the GUI does the same inside startAgentRun.
    resolvedProvider = resolveProviderConfig({
      appSettings,
      appSecrets: null,
      cliConfig: readCliConfig()?.config || null,
      env: process.env,
    });
    credentialsReady = readAppSecrets({ connectionId: appConnectionId })
      .then((secrets) => {
        appSecretsEntries = secrets?.entries || {};
        resolvedProvider = resolveProviderConfig({
          appSettings,
          appSecrets: secrets,
          cliConfig: readCliConfig()?.config || null,
          env: process.env,
        });
        addConsole('agent', 'info', `[GUI] Credential resolution: ${secrets?.status || 'no secrets'} (key ${resolvedProvider.apiKey ? 'resolved' : 'absent'}).`);
      })
      .catch(() => { /* env/cli-config key still applies */ });
  } catch (error) {
    resolvedProvider = { baseUrl: 'https://api.xkiro.com/v1', model: '', apiKey: process.env.XKIRO_API_KEY || process.env.BROWSER_USE_API_KEY || '', providerId: 'xkiro', source: 'defaults' };
    console.error('[guiBackend] credential resolution failed:', error?.message || error);
  }
  return resolvedProvider;
}

async function ensureRuntime() {
  if (runtime) return runtime;
  if (runtimeStarting) return runtimeStarting;
  runtimeStarting = (async () => {
    addConsole('agent', 'info', '[GUI] Booting standalone runtime (headless Chrome + chat agent)…');
    let chrome;
    try {
      // Auto-install when missing: an interrupted install, a cleared cache or a
      // first run must not leave the interface dead. Provisioning happens here,
      // the first time a message is sent, and reports progress in the console.
      try {
        const provisioner = await import('../browserProvisioner.mjs');
        if (!provisioner.findProvisionedBrowser()) {
          addConsole('agent', 'info', 'Browser missing. Downloading the bundled headless shell (one time).');
          await provisioner.ensureProvisionedBrowser({
            onLine: (line) => {
              const pct = line.match(/(\d{1,3})%/);
              if (pct && Number(pct[1]) % 25 === 0) addConsole('agent', 'info', `Browser download ${pct[1]}%`);
            }
          });
          addConsole('agent', 'info', 'Browser ready.');
        }
      } catch (provisionError) {
        addConsole('agent', 'error', `Browser download failed: ${String(provisionError?.message || provisionError).slice(0, 200)}`);
      }
      chrome = await launchHeadlessChrome({ startPort: 9401, profileDir: null, headed: false });
    } catch (launchError) {
      // The common failure on a fresh machine (and on Android/Termux) is no
      // Chromium binary at all. Say that once, clearly, instead of surfacing a
      // wall of navigation errors on every action.
      const reason = String(launchError?.message || launchError);
      throw new Error(
        `No usable Chromium browser on this machine. ${reason}. ` +
        'Install Chrome, Chromium or Edge, or point CHROME_PATH at a Chromium binary, then retry. ' +
        'Run `browser-use doctor` for the exact check.'
      );
    }
    const tabs = new Map();
    let selectedTabId = null;

    const openTab = async (url) => {
      const { tab, adapter } = await connectTab({ host: '127.0.0.1', port: chrome.port, targetId: null });
      tabs.set(tab.id, { tab, adapter });
      selectedTabId = tab.id;
      // LORDE_GUI_ERROR_PAGES_V1 — main-frame load failures (DNS failure, no
      // network, refused connection...) navigate to the loopback error page.
      // Loopback always works, even with no internet. Guarded against
      // re-triggering on the error page itself and rapid repeat failures.
      let lastErrorNav = { url: '', at: 0 };
      adapter.on('did-fail-load', (_event, errorCode, errorDescription, failedUrl, isMainFrame) => {
        try {
          if (!isMainFrame || errorCode === -3) return;
          const target = String(failedUrl || '');
          if (!/^https?:\/\//i.test(target)) return;
          if (loopbackBase && target.startsWith(loopbackBase + '/error')) return;
          const now = Date.now();
          if (target === lastErrorNav.url && now - lastErrorNav.at < 3000) return;
          lastErrorNav = { url: target, at: now };
          if (loopbackBase) {
            const page = loopbackBase + '/error/?url=' + encodeURIComponent(target)
              + '&message=' + encodeURIComponent(String(errorDescription || ''))
              + '&code=' + encodeURIComponent(errorCode)
              + '&home=' + encodeURIComponent(settings.homepage);
            tab.webContents.loadURL(page).catch(() => { });
          }
        } catch { /* error pages are best effort */ }
      });
      if (url && url !== 'about:blank') await tab.webContents.loadURL(url).catch(() => { });
      publishState();
      return tab;
    };

    await openTab(settings.homepage || 'about:blank');

    const controller = new BrowserViewController({
      getTabs: () => [...tabs.values()].map((entry) => entry.tab),
      getSelectedTabId: () => selectedTabId,
      getConsoleEntries: () => [...tabs.values()].flatMap((entry) => entry.adapter.getConsoleEntries()),
      normalizeUrl,
      createTab: async (url) => {
        const previous = selectedTabId;
        const tab = await openTab(typeof url === 'string' ? url : 'about:blank');
        selectedTabId = previous;
        return tab;
      },
      closeTab: async (tabId) => {
        const entry = tabs.get(String(tabId));
        if (!entry) return;
        tabs.delete(String(tabId));
        await entry.adapter.close().catch(() => { });
        if (selectedTabId === String(tabId)) {
          selectedTabId = [...tabs.keys()][0] || null;
          if (!selectedTabId) await openTab('about:blank');
        }
        publishState();
      },
      isTabPaintable: () => true,
      ensureTabPaintable: null,
      deviceEmulator: null,
      debuggerLeaseManager: null,
      pointerVisualizer: null,
    });

    const provider = resolvedProviderInfo();
    const outRoot = path.join(GUI_DIR, 'gui-runs');

    const agent = new DesktopChatAgent({
      controller,
      getSelectedTabId: () => selectedTabId,
      createTab: (url) => openTab(url),
      closeTab: async (tabId) => controller.closeTab(tabId),
      selectTab: (tabId) => {
        if (tabs.has(String(tabId))) selectedTabId = String(tabId);
        publishState();
      },
      focusTab: null,
      writeReportFile: null,
      modelTaskApi: createCliModelTaskApi({
        baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: provider.model,
        outDir: outRoot,
      }),
      catalogApi: createCliCatalogApi({ baseUrl: provider.baseUrl, apiKey: provider.apiKey }),
      // LORDE_AI_CHAT_TITLES_V1 — AI-driven evolving chat names work in the
      // web GUI too: one tiny completion against the active provider.
      titleApi: async ({ model = '', prompt = '' } = {}) => {
        if (!prompt) throw new Error('Title prompt is empty.');
        const base = String(provider.baseUrl || '').replace(/\/$/, '');
        const headers = { 'content-type': 'application/json', ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}) };
        const chosenModel = model || provider.model || '';
        const extract = (payload) => String(payload?.choices?.[0]?.message?.content ?? payload?.message?.content ?? '').trim();
        try {
          const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: chosenModel, messages: [{ role: 'user', content: prompt }], max_tokens: 32, temperature: 0.3, stream: false }) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = extract(await response.json());
          if (!text) throw new Error('Empty title response.');
          return text;
        } catch (error) {
          if (provider.id !== 'ollama') throw error;
          const response = await fetch(`${base}/api/chat`, {
            method: 'POST', headers,
            body: JSON.stringify({ model: chosenModel, messages: [{ role: 'user', content: prompt }], stream: false, options: { num_predict: 32, temperature: 0.3 } })
          });
          if (!response.ok) throw new Error(`Title request failed (${response.status}).`);
          const text = extract(await response.json());
          if (!text) throw new Error('Empty title response.');
          return text;
        }
      },
      getComputerTools: null,
      getControlMode: () => settings.agentControlMode || 'browser',
      emit: (event) => {
        emitEvent('browser-use:agent-event', event);
      },
      // REAL chat history: checkpoint on every turn boundary with the SAME
      // payload the desktop main.cjs wires — the store record is what the
      // renderer's History drawer restores (messages/thinking/transcript).
      onCheckpoint: (run) => {
        try {
          chatHistoryStore.checkpoint({
            id: run.id,
            title: run.title || run.task,
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
            nativeSurfaceSeen: Array.isArray(run.nativeSurfaceSeen) ? run.nativeSurfaceSeen : [],
            transcript: Array.isArray(run.history) ? run.history.map((entry) => ({
              at: entry.at,
              step: entry.step,
              tool: entry.tool,
              ms: entry.ms,
              ok: entry.ok,
            })) : [],
          });
        } catch { /* history is best effort */ }
      },
      createProvider: (config) => createOpenAiCompatibleProvider({
        providerId: config.id,
        baseUrl: config.baseUrl,
        model: config.model,
        apiKey: config.apiKey,
      }),
      onTerminal: null,
      scheduleApi: null,
      spawnTask: null,
      skillsApi: null,
      messageApi: null,
      subagentApi: null,
      createResultStore: null,
      researchRunner: null,
      researchMetaSearch: null,
      knowledgeStore: null,
      layaVerifierFactory: null,
      jevVerifierFactory: null,
      notebookDir: null,
    });

    runtime = { chrome, tabs, controller, agent, get selectedTabId() { return selectedTabId; }, set selectedTabId(v) { selectedTabId = v; }, openTab };
    addConsole('agent', 'info', `[GUI] Standalone runtime ready — headless Chrome on 127.0.0.1:${chrome.port}.`);
    publishState();

    // Real download capture (CDP browser-level events → managed folder).
    ensureDownloadsWatcher().catch((error) => {
      addConsole('downloads', 'error', `[GUI] Download capture unavailable: ${String((error && error.message) || error)}`);
    });

    // Tab-content preview for the web GUI: a slow screenshot loop for the
    // selected tab while at least one browser page is listening. The page's
    // injected web-shell draws it behind the chrome — a real view of the
    // controlled browser without Electron webviews.
    setInterval(async () => {
      if (!bus.listenerCount('event')) return;
      const entry = tabs.get(String(selectedTabId));
      if (!entry || entry.tab.webContents.isDestroyed() || entry.tab.webContents.isLoading()) return;
      try {
        const image = await entry.tab.webContents.capturePage();
        // The adapter returns { toPNG() } (CDP captureScreenshot), while
        // Electron's capturePage returns a NativeImage — support both.
        let dataUrl = null;
        if (typeof image?.toDataURL === 'function') dataUrl = image.toDataURL();
        else if (typeof image?.toPNG === 'function') dataUrl = 'data:image/png;base64,' + image.toPNG().toString('base64');
        if (dataUrl) emitEvent('browser-use:gui-preview', { tabId: String(selectedTabId), dataUrl });
      } catch { /* preview is best effort */ }
    }, 1600);

    return runtime;
  })();
  try {
    return await runtimeStarting;
  } finally {
    runtimeStarting = null;
  }
}

function connectionById(id) {
  return (settings.aiConnections || []).find((item) => item.id === id) || null;
}

// Resolve the effective provider config for a run: explicit request ->
// saved connection (key via the decrypted app secrets store) -> the app/TUI
// credential resolution (xkiro defaults).
function providerForRequest(request) {
  const requestedId = String(request?.provider?.id || settings.aiChatProvider || '').trim();
  const connectionId = String(request?.provider?.connectionId || settings.aiChatConnectionId || '');
  const connection = connectionById(connectionId);
  if (connection) {
    return {
      id: connection.provider || requestedId || 'xkiro',
      connectionId: connection.id,
      baseUrl: String(request?.provider?.baseUrl || connection.baseUrl || resolvedProviderInfo().baseUrl),
      model: String(request?.provider?.model || connection.model || ''),
      apiKey: String(connection.credential?.secret || connection.apiKey || credentialFor(connection.id) || ''),
    };
  }
  const fallback = resolvedProviderInfo();
  return {
    id: requestedId || fallback.providerId || 'xkiro',
    baseUrl: String(request?.provider?.baseUrl || settings.aiChatBaseUrl || fallback.baseUrl),
    model: String(request?.provider?.model || request?.model || settings.aiChatModel || fallback.model),
    apiKey: String(fallback.apiKey || ''),
  };
}

async function startAgentRun(request) {
  const rt = await ensureRuntime();
  if (credentialsReady) { try { await credentialsReady; } catch { /* env key still applies */ } }
  if (!rt.agent) throw new Error('The GUI chat agent is unavailable.');
  const provider = providerForRequest(request);
  if (!provider.model) throw new Error('No model configured — add a connection in Settings.');
  if (!provider.apiKey) throw new Error('No API key resolved — set one via the TUI (/key) or Settings.');

  const targetTabId = request?.tabId ? String(request.tabId) : String(rt.selectedTabId || '');
  const payload = {
    task: request?.task,
    attachments: request?.attachments,
    domAttachments: request?.domAttachments,
    continuation: request?.continuation === true,
    conversationId: request?.conversationId || '',
    conversation: request?.conversation,
    tabId: targetTabId,
    ownedTabIds: [],
    workspace: request?.workspace || TOOL_ROOT,
    settings: {
      ...(request?.settings || {}),
      controlMode: request?.settings?.controlMode === 'agi' ? 'agi' : (settings.agentControlMode || 'browser'),
      approvalMode: request?.settings?.approvalMode || settings.agentApprovalMode,
      effort: request?.settings?.effort || settings.agentEffort,
    },
    provider,
  };
  const completion = rt.agent.start(payload);
  const started = rt.agent.state();
  publishState();
  if (started && ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(started.status)) {
    void completion.catch((error) => {
      addConsole('agent', 'error', `AI chat run failed: ${String(error?.message || error)}`);
    });
    return started;
  }
  return completion;
}

// ---------------------------------------------------------------------------
// Bridge channel handlers. Every entry: async (args[]) => result (thrown
// Error -> { ok:false, error } in guiServer). Returning `undefined` means
// "not handled here" so guiServer can try the desktop bridge, then 503.
// ---------------------------------------------------------------------------
const handlers = {
  'browser-use:renderer-ready': async () => null,
  'browser-use:state': async () => (runtime ? buildState() : { tabs: [], selectedTabId: '', agent: null, settings, mcp: { running: false }, downloads: { items: [] } }),
  'browser-use:agent-state': async () => (runtime?.agent ? runtime.agent.state() : null),
  'browser-use:agent-start': async (request) => {
    // A failure here used to reject the IPC call and leave the transcript
    // stale with no error at all. Every failure now lands in the console and
    // in the event stream, so the interface can show what happened.
    try {
      return await startAgentRun(request);
    } catch (error) {
      const message = String(error?.message || error);
      addConsole('agent', 'error', `AI chat run failed: ${message}`);
      emitEvent('browser-use:agent-event', {
        type: 'error', status: 'failed', message,
        runId: String(request?.runId || ''), at: new Date().toISOString()
      });
      publishState();
      throw error;
    }
  },
  'browser-use:agent-cancel': async (request) => {
    if (!runtime?.agent) return { status: 'cancelled' };
    return runtime.agent.cancel(request?.runId);
  },
  'browser-use:agent-approve': async (request) => {
    if (!runtime?.agent) throw new Error('Agent not started.');
    return runtime.agent.approve(request || {});
  },
  'browser-use:agent-steer': async (request) => {
    if (!runtime?.agent) throw new Error('Agent not started.');
    return runtime.agent.steer(request || {});
  },
  'browser-use:agent-retire': async (conversationId) => {
    // Retiring a conversation: the web GUI keeps at most the primary agent.
    publishState();
    return { ok: true, id: String(conversationId || '') };
  },
  'browser-use:settings': async () => settings,
  'browser-use:save-settings': async (patch) => {
    settings = { ...settings, ...(patch && typeof patch === 'object' ? patch : {}) };
    saveSettingsFile();
    syncCliConfig();
    publishState();
    return settings;
  },
  'browser-use:chat-history-list': async () => chatHistoryStore.load() || [],
  'browser-use:chat-history-get': async (id) => chatHistoryStore.get(id),
  'browser-use:chat-history-delete': async (id) => {
    await chatHistoryStore.remove(id);
    return { ok: true };
  },
  'browser-use:chat-history-clear': async () => {
    await chatHistoryStore.clear();
    return { ok: true };
  },
  'browser-use:new-tab': async (url) => {
    const rt = await ensureRuntime();
    const previous = rt.selectedTabId;
    // Empty/blank new tabs open the homepage (the hosted new-tab page).
    const target = typeof url === 'string' && url && url !== 'about:blank' ? url : settings.homepage;
    const tab = await rt.openTab(target);
    rt.selectedTabId = previous;
    publishState();
    return buildState();
  },
  'browser-use:select-tab': async (id) => {
    const rt = await ensureRuntime();
    if (rt.tabs.has(String(id))) rt.selectedTabId = String(id);
    publishState();
    return buildState();
  },
  'browser-use:close-tab': async (id) => {
    const rt = await ensureRuntime();
    await rt.controller.closeTab(String(id));
    publishState();
    return buildState();
  },
  'browser-use:navigate': async (url) => {
    const rt = await ensureRuntime();
    const entry = rt.tabs.get(String(rt.selectedTabId));
    if (!entry) throw new Error('No active tab.');
    await entry.tab.webContents.loadURL(normalizeUrl(url));
    publishState();
    return buildState();
  },
  'browser-use:go-back': async () => {
    const rt = await ensureRuntime();
    const entry = rt.tabs.get(String(rt.selectedTabId));
    const wc = entry?.tab.webContents;
    if (wc?.navigationHistory?.canGoBack?.()) await wc.navigationHistory.goBack();
    publishState();
    return buildState();
  },
  'browser-use:go-forward': async () => {
    const rt = await ensureRuntime();
    const entry = rt.tabs.get(String(rt.selectedTabId));
    const wc = entry?.tab.webContents;
    if (wc?.navigationHistory?.canGoForward?.()) await wc.navigationHistory.goForward();
    publishState();
    return buildState();
  },
  'browser-use:reload': async () => {
    const rt = await ensureRuntime();
    const entry = rt.tabs.get(String(rt.selectedTabId));
    if (!entry) throw new Error('No active tab to reload.');
    await entry.tab.webContents.reloadIgnoringCache?.() ?? entry.tab.webContents.loadURL(entry.tab.webContents.getURL());
    publishState();
    return buildState();
  },
  'browser-use:console': async () => {
    const rt = runtime;
    if (!rt) return [];
    return [...rt.tabs.values()].flatMap((entry) => entry.adapter.getConsoleEntries());
  },
  'browser-use:clear-console': async () => ({ ok: true }),
  // Mobile split view: map taps/drags/wheel on the web preview <img> to real
  // CDP input on the controlled tab. The renderer sends NORMALIZED viewport
  // coordinates (0..1 within the preview image); this resolves them against
  // the live Page.getLayoutMetrics visual viewport, so device emulation and
  // zoom are respected automatically.
  'browser-use:gui-pointer': async (request) => {
    const rt = runtime;
    const entry = rt?.tabs.get(String(rt.selectedTabId));
    if (!entry) throw new Error('No active tab for pointer input.');
    const client = entry.adapter.client;
    const metrics = await client.send('Page.getLayoutMetrics').catch(() => null);
    const vv = metrics?.cssVisualViewport || metrics?.layoutViewport || { clientWidth: 1280, clientHeight: 720 };
    const type = String(request?.type || '');
    const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));
    const x = Math.round(clamp01(request?.x) * (vv.clientWidth || 1280));
    const y = Math.round(clamp01(request?.y) * (vv.clientHeight || 720));
    const common = { x, y };
    switch (type) {
      case 'down':
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, ...common });
        break;
      case 'move':
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', buttons: request?.pressed ? 1 : 0, ...common });
        break;
      case 'up':
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, ...common });
        break;
      case 'wheel': {
        const factor = 120; // normalized wheel ticks -> pixel scroll
        await client.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          deltaX: Math.round((Number(request?.dx) || 0) * factor),
          deltaY: Math.round((Number(request?.dy) || 0) * factor),
          ...common,
        });
        break;
      }
      default:
        throw new Error('Unknown pointer type: ' + type);
    }
    return { ok: true, type, x, y, viewport: { width: vv.clientWidth || 1280, height: vv.clientHeight || 720 } };
  },
  'browser-use:desktop-mcp-status': async () => ({ running: false, status: 'unavailable', reason: 'Standalone web GUI — desktop MCP pairing lives in the desktop app.' }),
  'browser-use:mcp-connection-configuration': async () => ({ ok: false, reason: 'Standalone web GUI — configure MCP clients in the desktop app or TUI.' }),
  'browser-use:mcp-sessions': async () => [],
  'browser-use:gpt-action-schema': async () => null,
  'browser-use:provider-status': async () => {
    const provider = resolvedProviderInfo();
    return {
      ok: true,
      providerId: provider.providerId || '',
      model: provider.model || '',
      baseUrl: provider.baseUrl || '',
      hasKey: Boolean(provider.apiKey),
      keySource: provider.source || '',
      connections: (settings.aiConnections || []).map((c) => ({ id: c.id, provider: c.provider, label: c.label || c.provider, model: c.model || '', hasKey: Boolean(c.credential?.secret || c.apiKey || credentialFor(c.id)) })),
    };
  },
  'browser-use:preflight-provider': async (request) => {
    const provider = providerForRequest(request || {});
    if (!provider.model) return { ok: false, message: 'No model configured.' };
    if (!provider.apiKey) return { ok: false, message: 'No API key resolved.' };
    return { ok: true, message: `${provider.model} is ready.` };
  },
  'browser-use:list-provider-models': async (request) => {
    const provider = providerForRequest(request || {});
    const base = String(request?.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
    const key = String(request?.apiKey || provider.apiKey || '');
    if (!base) return { models: [] };
    const res = await fetch(base + '/models', { headers: { accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } }).catch(() => null);
    if (!res || !res.ok) return { models: [], liveError: res ? `HTTP ${res.status}` : 'fetch failed' };
    const payload = await res.json().catch(() => null);
    const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
    const connectionId = String(request?.connectionId || '');
    return {
      models: raw.map((item) => {
        const id = typeof item === 'string' ? item : (item?.id || item?.model || '');
        return { id, model: id, name: typeof item === 'object' ? (item?.name || id) : id, kind: 'language', connectionId };
      }).filter((m) => m.id),
    };
  },
  'browser-use:viewport-metrics': async () => {
    if (!runtime) return { width: 1280, height: 800 };
    const entry = runtime.tabs.get(String(runtime.selectedTabId));
    if (!entry) return { width: 1280, height: 800 };
    try {
      return await entry.tab.webContents.executeJavaScript('({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio })', false);
    } catch {
      return { width: 1280, height: 800 };
    }
  },
  'browser-use:device-profiles': async () => [],
  'browser-use:device-state': async () => ({ mode: 'desktop', label: 'Desktop', orientation: 'landscape', zoom: 1, showTouches: false }),
  'browser-use:terminal-layout': async () => ({ docked: false, windowed: false }),
  'browser-use:terminal-backend': async () => ({ available: false, reason: 'Terminals are a desktop-app feature.' }),
  'browser-use:toggle-terminal': async () => ({ docked: false, windowed: false }),
  'browser-use:schedule-list': async () => [],
  'browser-use:skills-list': async () => {
    try {
      const { SkillsManager } = require(path.join(TOOL_ROOT, 'desktop/agent/skillsManager.cjs'));
      const manager = new SkillsManager({ userDir: path.join(GUI_DIR, 'skills'), repoDir: null });
      return manager.list();
    } catch {
      return [];
    }
  },
  'browser-use:downloads-list': async () => ({ items: downloadsItems() }),
  'browser-use:history-list': async () => ({ items: [] }),
};

// ===========================================================================
// REAL FEATURES: terminals (node-pty), device emulation (CDP), downloads
// (CDP capture), connections/settings CRUD, schedules.
// ===========================================================================
import { randomUUID } from 'node:crypto';
import { exec as childExec, spawn as childSpawn } from 'node:child_process';

const CDP = require('chrome-remote-interface');
const { listDeviceProfiles } = require(path.join(TOOL_ROOT, 'src/browser/deviceProfiles.cjs'));
// REAL conversation store — the exact module the desktop app uses, so
// chatHistoryGet returns records the renderer's history view can restore
// (messages + thinkingArchive + tool transcript), not ad-hoc snapshots.
const { ChatHistoryStore } = require(path.join(TOOL_ROOT, 'desktop/store/chatHistoryStore.cjs'));
const chatHistoryStore = new ChatHistoryStore({ filePath: path.join(GUI_DIR, 'gui-conversations.json') });
try { chatHistoryStore.recoverInterrupted(); } catch { /* fresh install */ }

// --- terminal manager ------------------------------------------------------
const TERMINAL_HISTORY_MAX = 200_000;
const terminalSessionsMap = new Map(); // id -> session

// Set when the native module cannot load, so the session can say why it fell back.
let ptyLoadError = null;

function ptyModule() {
  // node-pty ships native prebuilds for desktop platforms. In a stripped Linux
  // container or on Android the require throws. Returning null (instead of
  // throwing) lets the terminal fall back to a pipe-backed shell, so the panel
  // stays usable rather than failing on every keystroke.
  // BROWSER_USE_FORCE_PIPE_TERMINAL=1 exercises the fallback on any platform.
  if (String(process.env.BROWSER_USE_FORCE_PIPE_TERMINAL || '') === '1') {
    ptyLoadError = 'forced by BROWSER_USE_FORCE_PIPE_TERMINAL';
    return null;
  }
  try {
    return require('node-pty');
  } catch (error) {
    ptyLoadError = String(error?.message || error);
    return null;
  }
}

function terminalStatus(session) {
  return {
    id: session.id,
    backend: session.backend || 'pty',
    shell: session.shell,
    profile: session.profile,
    cwd: session.cwd,
    alive: !session.disposed,
    disposed: session.disposed,
    working: session.working,
    agentActive: session.agentActive,
    agent: session.agent,
    phase: session.disposed ? 'exited' : 'idle',
    lastOutputAt: session.lastOutputAt,
    error: session.error || null,
    reason: session.reason || null,
  };
}

function createTerminalSession({ cols = 80, rows = 24 } = {}) {
  const pty = ptyModule();
  // The candidate list used to be Windows-only, so on Linux the terminal tried
  // to launch cmd.exe and reported a PTY problem that was really a shell
  // problem. Pick the shell for the platform that is actually running.
  const isWindows = process.platform === 'win32';
  const shellCandidates = isWindows
    ? [
        'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        process.env.ComSpec || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'),
      ]
    : [process.env.SHELL || '', '/bin/bash', '/bin/sh', '/system/bin/sh'].filter(Boolean);
  const shell = shellCandidates.find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } })
    || shellCandidates[shellCandidates.length - 1];
  const session = {
    id: randomUUID(),
    shell: path.basename(shell).replace(/\.exe$/i, ''),
    profile: 'shell',
    cwd: TOOL_ROOT,
    backend: 'pty',
    history: '',
    disposed: false,
    working: false,
    agentActive: false,
    agent: false,
    cols, rows,
    lastOutputAt: Date.now(),
    error: null,
    reason: null,
  };
  if (!pty) {
    // No native PTY available. Run the shell over pipes: no full TTY semantics,
    // but commands execute and output streams, so the terminal panel works
    // instead of refusing every keystroke.
    const child = childSpawn(shell, isWindows ? [] : ['-i'], {
      cwd: TOOL_ROOT,
      env: { ...process.env, TERM: 'dumb' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.pty = {
      write: (data) => { try { child.stdin.write(data); } catch { /* shell closed */ } },
      resize: () => { /* a pipe has no window size */ },
      kill: () => { try { child.kill(); } catch { /* gone */ } },
    };
    session.child = child;
    session.backend = 'pipe';
    session.reason = `native PTY module unavailable, using a pipe-backed shell (${String(ptyLoadError || '').slice(0, 90)})`;
    const push = (chunk) => {
      const text = String(chunk);
      session.lastOutputAt = Date.now();
      if (session.history.length > TERMINAL_HISTORY_MAX) session.history = session.history.slice(-TERMINAL_HISTORY_MAX / 2);
      session.history += text;
      emitEvent('browser-use:terminal-data', { id: session.id, data: text, status: terminalStatus(session) });
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('exit', (code) => {
      session.disposed = true;
      emitEvent('browser-use:terminal-exit', { id: session.id, exitCode: code, status: terminalStatus(session) });
    });
    terminalSessionsMap.set(session.id, session);
    addConsole('terminal', 'warn', session.reason);
    return session;
  }
  const term = pty.spawn(shell, shell.endsWith('cmd.exe') ? [] : ['-NoLogo'], {
    name: 'xterm-color',
    cols, rows,
    cwd: TOOL_ROOT,
    env: { ...process.env },
  });
  session.pty = term;
  term.onData((data) => {
    session.lastOutputAt = Date.now();
    if (session.history.length > TERMINAL_HISTORY_MAX) session.history = session.history.slice(-TERMINAL_HISTORY_MAX / 2);
    session.history += data;
    emitEvent('browser-use:terminal-data', { id: session.id, data, status: terminalStatus(session) });
  });
  term.onExit(({ exitCode }) => {
    session.disposed = true;
    emitEvent('browser-use:terminal-exit', { id: session.id, exitCode, status: terminalStatus(session) });
  });
  terminalSessionsMap.set(session.id, session);
  return session;
}

// --- device emulation (CDP) ------------------------------------------------
let deviceState = { mode: 'desktop', label: 'Desktop', orientation: 'landscape', zoom: 1, showTouches: false, profileId: 'desktop', width: null, height: null, touch: false, deviceScaleFactor: null };

async function applyDeviceOverride() {
  const rt = runtime;
  const entry = rt?.tabs.get(String(rt.selectedTabId));
  if (!entry) return;
  const client = entry.adapter.client;
  if (deviceState.mode === 'desktop') {
    await client.send('Emulation.clearDeviceMetricsOverride').catch(() => { });
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => { });
    await client.send('Emulation.setEmitTouchEventsForMouse', { enabled: false }).catch(() => { });
    // Zoom stays meaningful in desktop mode too.
    if (deviceState.zoom && deviceState.zoom !== 1) {
      await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: deviceState.zoom }).catch(() => { });
    }
    return;
  }
  const portrait = deviceState.orientation === 'portrait';
  const width = portrait ? Math.min(deviceState.width, deviceState.height) : Math.max(deviceState.width, deviceState.height);
  const height = portrait ? Math.max(deviceState.width, deviceState.height) : Math.min(deviceState.width, deviceState.height);
  await client.send('Emulation.setDeviceMetricsOverride', {
    width, height,
    deviceScaleFactor: deviceState.deviceScaleFactor || 2,
    mobile: deviceState.mode === 'mobile',
    screenWidth: width, screenHeight: height,
  }).catch(() => { });
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: Boolean(deviceState.touch), maxTouchPoints: 5 }).catch(() => { });
  await client.send('Emulation.setEmitTouchEventsForMouse', { enabled: Boolean(deviceState.touch), configuration: 'mobile' }).catch(() => { });
  if (deviceState.zoom && deviceState.zoom !== 1) {
    await client.send('Emulation.setPageScaleFactor', { pageScaleFactor: deviceState.zoom }).catch(() => { });
  }
}

// --- downloads (CDP capture to a managed folder) ---------------------------
const DOWNLOADS_DIR = path.join(GUI_DIR, 'gui-downloads');
let downloadsWatcher = null;
const downloadsMap = new Map(); // guid -> item

function downloadsItems() {
  return [...downloadsMap.values()].sort((a, b) => b.at - a.at);
}

async function ensureDownloadsWatcher() {
  const rt = await ensureRuntime();
  if (downloadsWatcher) return downloadsWatcher;
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const root = await CDP({ host: '127.0.0.1', port: rt.chrome.port, target: (targets) => targets.find((t) => t.type === 'browser') || targets[0] });
  await root.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DOWNLOADS_DIR, eventsEnabled: true });
  root.on('Browser.downloadWillBegin', (event) => {
    downloadsMap.set(event.guid, {
      id: event.guid,
      url: event.url,
      filename: event.suggestedFilename,
      path: path.join(DOWNLOADS_DIR, event.suggestedFilename),
      state: 'in-progress',
      at: Date.now(),
    });
    publishState();
  });
  root.on('Browser.downloadProgress', (event) => {
    const item = downloadsMap.get(event.guid);
    if (!item) return;
    item.state = event.state === 'canceled' ? 'canceled' : event.state === 'completed' ? 'completed' : 'in-progress';
    if (event.receivedBytes != null) item.receivedBytes = event.receivedBytes;
    if (event.totalBytes != null) item.totalBytes = event.totalBytes;
    if (item.state !== 'in-progress') item.at = Date.now();
    publishState();
  });
  root.on('disconnect', () => { downloadsWatcher = null; });
  downloadsWatcher = root;
  return root;
}

// --- schedules --------------------------------------------------------------
const SCHEDULES_FILE = path.join(GUI_DIR, 'gui-schedules.json');
let scheduleJobs = loadSchedules();

function loadSchedules() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SCHEDULES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveSchedules() {
  try {
    fs.mkdirSync(GUI_DIR, { recursive: true });
    fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(scheduleJobs, null, 2));
  } catch { /* best effort */ }
}

// Compact 5-field cron match (minute hour dom month dow; * , - / supported).
function cronMatches(cron, date) {
  const fields = String(cron || '').trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const values = [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()];
  const expand = (field, min, max, isDow) => {
    const out = [];
    for (const part of field.split(',')) {
      const [range, stepRaw] = part.split('/');
      const step = Number(stepRaw) || 1;
      let lo = min, hi = max;
      if (range !== '*' && range !== '?') {
        const [a, b] = range.split('-');
        lo = Number(a); hi = b === undefined ? lo : Number(b);
      }
      for (let v = lo; v <= hi; v += step) out.push(v);
    }
    return isDow ? out.map((v) => (v === 7 ? 0 : v)) : out;
  };
  const ranges = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
  return fields.every((field, i) => expand(field, ranges[i][0], ranges[i][1], i === 4).includes(values[i]));
}

function scheduleDue(job, now) {
  const schedule = job.schedule || {};
  if (job.enabled === false) return false;
  const lastRun = Number(job.lastRunAt || 0);
  switch (schedule.type) {
    case 'once': return !job.done && Number(schedule.startAt || 0) <= now;
    case 'interval': return now - lastRun >= Math.max(30, Number(schedule.intervalSeconds || 0)) * 1000;
    case 'daily': {
      if (cronMatches('0 ' + schedule.time, now)) return false; // placeholder, replaced below
      return false;
    }
    case 'weekly': return false;
    case 'monthly': return false;
    case 'cron': return cronMatches(schedule.cron, now) && now - lastRun >= 60_000;
    default: return false;
  }
}

// Daily/weekly/monthly matching via cron-style windows checked once a minute.
function dailyWeeklyMonthlyDue(job, now) {
  const schedule = job.schedule || {};
  const lastRun = Number(job.lastRunAt || 0);
  if (now - lastRun < 60_000) return false;
  const date = new Date(now);
  const minuteOfDay = date.getHours() * 60 + date.getMinutes();
  const [hh, mm] = String(schedule.time || '09:00').split(':').map(Number);
  const target = (Number(hh) || 0) * 60 + (Number(mm) || 0);
  if (minuteOfDay < target || minuteOfDay - target >= 30) return false;
  if (schedule.type === 'weekly') {
    const weekdays = Array.isArray(schedule.weekdays) ? schedule.weekdays : [1];
    return weekdays.includes(date.getDay());
  }
  if (schedule.type === 'monthly') return Number(schedule.dayOfMonth || date.getDate()) === date.getDate();
  return true; // daily
}

setInterval(() => {
  const now = Date.now();
  for (const job of scheduleJobs) {
    const due = scheduleDue(job, now) || dailyWeeklyMonthlyDue(job, now);
    if (!due) continue;
    job.lastRunAt = now;
    if (job.schedule?.type === 'once') job.done = true;
    saveSchedules();
    emitEvent('browser-use:schedule-event', { kind: 'started', jobId: job.id, name: job.name, prompt: job.prompt, at: now });
    startAgentRun({ task: job.prompt }).catch((error) => {
      emitEvent('browser-use:schedule-event', { kind: 'failed', jobId: job.id, name: job.name, error: String((error && error.message) || error) });
    });
  }
}, 30_000).unref();

Object.assign(handlers, {
  // --- STOP: the renderer passes a BARE run id string (agentCancel(id)) —
  // accept both shapes and always stop whichever run is actually live.
  'browser-use:agent-cancel': async (request) => {
    const runId = typeof request === 'string' ? request : request?.runId;
    const agent = runtime?.agent;
    if (!agent) return { status: 'cancelled' };
    try {
      return await agent.cancel(runId);
    } catch (error) {
      // A stale/absent run id must never leave a live run un-stoppable:
      // cancel whichever run is actually running.
      if (/Unknown AI chat run/i.test(String(error?.message || ''))) {
        const state = agent.state();
        if (state?.id && ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(state.status)) {
          return await agent.cancel(state.id);
        }
        return { status: 'cancelled' };
      }
      throw error;
    }
  },

  // --- window/drawer cosmetics the renderer handles page-locally ----------
  'browser-use:set-active-drawer': async () => ({ ok: true }),
  'browser-use:set-agent-drawer-width': async () => ({ ok: true }),
  'browser-use:set-downloads-open': async () => ({ ok: true }),
  'browser-use:set-device-menu-open': async () => ({ ok: true }),
  'browser-use:toggle-device-menu-open': async () => ({ ok: true }),
  'browser-use:set-history-menu-open': async () => ({ ok: true }),
  'browser-use:show-tab-group': async () => ({ ok: true }),
  'browser-use:show-app-menu': async () => ({ ok: true }),

  // --- AI connections / provider settings (persisted, real) ---------------
  'browser-use:save-ai-connection': async (connection) => {
    const saved = { ...(connection || {}) };
    saved.id = String(saved.id || randomUUID());
    saved.enabled = saved.enabled !== false;
    settings.aiConnections = [...(settings.aiConnections || []).filter((item) => item.id !== saved.id), saved];
    settings.aiChatConnectionId = saved.id;
    settings.aiChatProvider = saved.provider || settings.aiChatProvider;
    saveSettingsFile();
    publishState();
    return saved;
  },
  'browser-use:set-provider-credential': async ({ connectionId, secret } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => (
      item.id === connectionId
        ? { ...item, credential: { secret: String(secret || ''), display: secret ? `Key ••••${String(secret).slice(-4)}` : 'Key saved' } }
        : item
    ));
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:clear-provider-credential': async (connectionId) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => (
      item.id === connectionId ? { ...item, credential: undefined } : item
    ));
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:remove-ai-connection': async (id) => {
    settings.aiConnections = (settings.aiConnections || []).filter((item) => item.id !== id);
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:set-ai-connection-model': async ({ connectionId, model } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => (item.id === connectionId ? { ...item, model } : item));
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:set-ai-connection-enabled': async ({ connectionId, enabled } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => (item.id === connectionId ? { ...item, enabled: Boolean(enabled) } : item));
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:add-provider-model': async ({ connectionId, model, kind } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => {
      if (item.id !== connectionId) return item;
      const custom = Array.isArray(item.customModels) ? item.customModels : [];
      return { ...item, customModels: [...custom.filter((entry) => (typeof entry === 'string' ? entry : entry?.id) !== model), { id: model, kind: kind || 'language', connectionId }] };
    });
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:remove-provider-model': async ({ connectionId, model } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => {
      if (item.id !== connectionId) return item;
      const custom = Array.isArray(item.customModels) ? item.customModels : [];
      return { ...item, customModels: custom.filter((entry) => (typeof entry === 'string' ? entry : entry?.id) !== model) };
    });
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:set-model-kind': async ({ connectionId, model, kind } = {}) => {
    settings.aiConnections = (settings.aiConnections || []).map((item) => {
      if (item.id !== connectionId) return item;
      const custom = Array.isArray(item.customModels) ? item.customModels : [];
      return { ...item, customModels: custom.map((entry) => (typeof entry === 'object' && entry?.id === model ? { ...entry, kind } : entry)) };
    });
    saveSettingsFile();
    publishState();
    return settings;
  },
  'browser-use:copy-text': async (text) => {
    await clipboardWrite(String(text ?? ''));
    return { ok: true };
  },

  // --- device mode (CDP emulation — real) ---------------------------------
  'browser-use:device-profiles': async () => listDeviceProfiles(),
  'browser-use:device-state': async () => deviceState,
  'browser-use:set-device-mode': async (options = {}) => {
    await ensureRuntime();
    const profileId = String(options.profile || options.profileId || options.id || 'desktop');
    const profile = listDeviceProfiles().find((p) => p.id === profileId) || { id: 'desktop', label: 'Desktop', mode: 'desktop', touch: false, width: null, height: null, deviceScaleFactor: null };
    deviceState = {
      mode: profile.mode,
      label: profile.label,
      orientation: options.orientation || deviceState.orientation || 'landscape',
      zoom: deviceState.zoom || 1,
      showTouches: deviceState.showTouches || false,
      profileId: profile.id,
      width: profile.width,
      height: profile.height,
      touch: Boolean(profile.touch),
      deviceScaleFactor: profile.deviceScaleFactor,
    };
    await applyDeviceOverride();
    publishState();
    return deviceState;
  },
  'browser-use:rotate-device': async () => {
    deviceState.orientation = deviceState.orientation === 'portrait' ? 'landscape' : 'portrait';
    await applyDeviceOverride();
    publishState();
    return deviceState;
  },
  'browser-use:set-show-touches': async (value) => {
    deviceState.showTouches = Boolean(value);
    await applyDeviceOverride();
    publishState();
    return deviceState;
  },
  'browser-use:set-device-zoom': async (zoom) => {
    deviceState.zoom = Number(zoom) || 1;
    await applyDeviceOverride();
    publishState();
    return deviceState;
  },

  // --- terminals (real node-pty shells) -----------------------------------
  'browser-use:terminal-layout': async () => ({ docked: false, windowed: false }),
  'browser-use:terminal-backend': async () => ({ available: true, backend: 'pty' }),
  'browser-use:toggle-terminal': async (next) => {
    terminalDocked = next === undefined ? !terminalDocked : Boolean(next);
    return { docked: terminalDocked, windowed: false };
  },
  'browser-use:set-terminal-height': async () => ({ ok: true }),
  'browser-use:detach-terminal': async () => ({ docked: terminalDocked, windowed: false }),
  'browser-use:terminal-create': async (options = {}) => {
    const session = createTerminalSession(options);
    return { ...terminalStatus(session), history: '' };
  },
  'browser-use:terminal-active-session': async () => null,
  'browser-use:terminal-sessions': async () => [...terminalSessionsMap.values()].map(terminalStatus),
  'browser-use:terminal-attach': async (id) => {
    const session = terminalSessionsMap.get(String(id));
    if (!session) throw new Error('That terminal session is gone.');
    return { ...terminalStatus(session), history: session.history };
  },
  'browser-use:terminal-write': async (id, data) => {
    const session = terminalSessionsMap.get(String(id));
    if (session?.pty) session.pty.write(String(data ?? ''));
    return { ok: true };
  },
  'browser-use:terminal-resize': async (id, cols, rows) => {
    const session = terminalSessionsMap.get(String(id));
    if (session?.pty) { try { session.pty.resize(Number(cols) || 80, Number(rows) || 24); } catch { /* already gone */ } }
    return { ok: true };
  },
  'browser-use:terminal-recover': async (id) => {
    const session = terminalSessionsMap.get(String(id));
    if (session?.pty) { try { session.pty.kill(); } catch { /* gone */ } }
    const fresh = createTerminalSession({ cols: session?.cols, rows: session?.rows });
    return { ...terminalStatus(fresh), history: '' };
  },
  'browser-use:terminal-dispose': async (id) => {
    const session = terminalSessionsMap.get(String(id));
    if (!session) return { ok: true };
    if (session.agentActive) return { blocked: true };
    try { session.pty.kill(); } catch { /* gone */ }
    terminalSessionsMap.delete(String(id));
    return { ok: true };
  },
  'browser-use:terminal-screenshot': async () => {
    const rt = await ensureRuntime();
    const entry = rt.tabs.get(String(rt.selectedTabId));
    if (!entry) throw new Error('No active tab to capture.');
    const image = await entry.tab.webContents.capturePage();
    const png = typeof image?.toPNG === 'function' ? image.toPNG() : (typeof image?.toDataURL === 'function' ? Buffer.from(String(image.toDataURL()).split(',')[1] || '', 'base64') : null);
    if (!png || !png.length) throw new Error('Capture returned no image data.');
    const dir = path.join(GUI_DIR, 'gui-screenshots');
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `capture-${Date.now()}.png`);
    fs.writeFileSync(filePath, png);
    return { ok: true, path: filePath };
  },

  // --- downloads (CDP capture) --------------------------------------------
  'browser-use:downloads-open': async (id) => {
    const item = downloadsMap.get(String(id));
    if (item?.path && fs.existsSync(item.path)) childExec(`explorer.exe "${path.dirname(item.path)}"`, { windowsHide: true });
    return { ok: true };
  },
  'browser-use:downloads-show': async (id) => {
    const item = downloadsMap.get(String(id));
    if (item?.path && fs.existsSync(item.path)) childExec(`explorer.exe /select,"${item.path}"`, { windowsHide: true });
    return { ok: true };
  },
  'browser-use:downloads-clear': async () => {
    downloadsMap.clear();
    publishState();
    return { ok: true };
  },

  // --- schedules (real: stored jobs drive agent runs) ---------------------
  'browser-use:schedule-list': async () => scheduleJobs,
  'browser-use:schedule-create': async (payload = {}) => {
    const action = String(payload.action || 'create');
    let job;
    if (action === 'update' && payload.jobId) {
      job = scheduleJobs.find((item) => item.id === payload.jobId);
      if (job) Object.assign(job, { name: payload.name ?? job.name, prompt: payload.prompt ?? job.prompt, schedule: payload.schedule ?? job.schedule, execution: payload.execution ?? job.execution });
    } else {
      job = {
        id: payload.clientRequestId || randomUUID(),
        name: String(payload.name || 'Scheduled task'),
        prompt: String(payload.prompt || ''),
        schedule: payload.schedule || { type: 'once', startAt: Date.now() + 60_000 },
        execution: payload.execution || { type: 'agent' },
        createdAt: Date.now(),
        lastRunAt: 0,
        done: false,
      };
      scheduleJobs.push(job);
    }
    saveSchedules();
    publishState();
    return { ok: true, job };
  },
  'browser-use:schedule-update': async (payload = {}) => {
    const job = scheduleJobs.find((item) => item.id === payload?.jobId);
    if (job) {
      Object.assign(job, payload.job || {});
      saveSchedules();
    }
    publishState();
    return { ok: Boolean(job) };
  },
  'browser-use:schedule-remove': async (payload = {}) => {
    scheduleJobs = scheduleJobs.filter((item) => item.id !== payload?.jobId);
    saveSchedules();
    publishState();
    return { ok: true };
  },
  'browser-use:schedule-preview': async (payload = {}) => ({ runs: [], next: null, ...payload }),

  // --- skills --------------------------------------------------------------
  'browser-use:skills-save': async (skill) => {
    const { SkillsManager } = require(path.join(TOOL_ROOT, 'desktop/agent/skillsManager.cjs'));
    const manager = new SkillsManager({ userDir: path.join(GUI_DIR, 'skills'), repoDir: null });
    manager.save(skill);
    return { ok: true };
  },
  'browser-use:skills-delete': async (skillId) => {
    const { SkillsManager } = require(path.join(TOOL_ROOT, 'desktop/agent/skillsManager.cjs'));
    const manager = new SkillsManager({ userDir: path.join(GUI_DIR, 'skills'), repoDir: null });
    manager.delete(skillId);
    return { ok: true };
  },
  'browser-use:skills-read': async (skillId) => {
    const { SkillsManager } = require(path.join(TOOL_ROOT, 'desktop/agent/skillsManager.cjs'));
    const manager = new SkillsManager({ userDir: path.join(GUI_DIR, 'skills'), repoDir: null });
    return manager.read(skillId);
  },

  // --- recording: honest unavailability (buttons are hidden in the page) --
  'browser-use:recording-status': async () => ({ active: false, reason: 'Recording & Learn runs in the desktop app.' }),
  'browser-use:recording-start': async () => { throw new Error('Recording & Learn runs in the desktop app.'); },
  'browser-use:recording-stop': async () => ({ active: false }),
  'browser-use:record-start': async () => { throw new Error('Recording & Learn runs in the desktop app.'); },
  'browser-use:record-stop': async () => ({ active: false }),
  'browser-use:record-status': async () => ({ active: false, reason: 'desktop-only' }),
  'browser-use:record-recheck-model': async () => ({ ok: false }),
});

// Clipboard via PowerShell Set-Clipboard (the GUI server process is plain Node).
function clipboardWrite(text) {
  return new Promise((resolve, reject) => {
    const child = childExec('powershell.exe -NoProfile -Command $input | Set-Clipboard', { windowsHide: true }, (error) => (error ? reject(error) : resolve()));
    child.stdin.write(text);
    child.stdin.end();
  });
}

/**
 * Handle a bridge invocation. Returns { handled: true, result } when this
 * backend owns the channel, { handled: false } otherwise.
 * @param {string} channel
 * @param {unknown[]} args
 */
export async function handle(channel, args) {
  const handler = handlers[channel];
  if (!handler) return { handled: false };
  try {
    const result = await handler(...(Array.isArray(args) ? args : []));
    return { handled: true, result: result === undefined ? null : result };
  } catch (error) {
    return { handled: true, error: String((error && error.message) || error) };
  }
}

/** Subscribe to backend events ({channel, payload}). @returns {() => void} */
export function onEvent(listener) {
  bus.on('event', listener);
  return () => bus.off('event', listener);
}

/** Called by guiServer once listening, so error pages have a loopback base. */
export function setLoopbackBase(base) {
  loopbackBase = String(base || '').replace(/\/+$/, '');
}

/** Boot eagerly (used at server start so the first page load is fast). */
export async function warmup() {
  try { await ensureRuntime(); } catch (error) {
    const message = String((error && error.message) || error);
    console.error('[guiBackend] runtime boot failed:', message);
    addConsole('agent', 'error', `[GUI] Runtime boot failed: ${message}`);
  }
}
