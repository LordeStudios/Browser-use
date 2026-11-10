// Fallback desktop bridge for browser preview (no Electron preload).
// Installs only when the real window.browserUseDesktop is absent, so the
// desktop app is unaffected. Unknown bridge methods become async no-ops,
// letting drawer/panel handlers run their local state updates.
(function installDesktopBridgeFallback() {
  if (typeof window === 'undefined' || window.browserUseDesktop) return;
  const asyncNoop = () => Promise.resolve(undefined);
  const bridge = {
    __browserUseDesktopFallback: true,
    __fallbackSettings: { aiConnections: [] },
    // Echo the requested drawer back so local activeDrawer state updates
    // without the Electron main process.
    setActiveDrawer: (name) => {
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('browseruse-fallback-drawer', { detail: name })));
      return Promise.resolve(undefined);
    },
    setDownloadsOpen: asyncNoop,
    setAgentDrawerWidth: asyncNoop,
    onScheduleEvent: () => asyncNoop,
    // Device menu: mirror open state onto the toolbar button locally.
    toggleDeviceMenuOpen: () => {
      const btn = document.querySelector('#device-toggle');
      const open = btn ? btn.getAttribute('aria-expanded') !== 'true' : true;
      btn?.setAttribute('aria-expanded', String(open));
      return Promise.resolve(undefined);
    },
    setDeviceMenuOpen: (open) => {
      document.querySelector('#device-toggle')?.setAttribute('aria-expanded', String(Boolean(open)));
      return Promise.resolve(undefined);
    },
    // Terminal: track docked state so renderTerminalLayout gets a real shape.
    toggleTerminal: (open) => {
      bridge.__terminalDocked = open === undefined ? !bridge.__terminalDocked : Boolean(open);
      return Promise.resolve({ docked: bridge.__terminalDocked, windowed: false });
    },
    rotateDevice: () => Promise.resolve({ mode: 'desktop', label: 'Desktop', orientation: 'landscape' }),
    layaStatus: () => Promise.resolve({ checks: [] }),
    // Provider settings: in-memory fallback so the Save & Test flow completes
    // with real shapes instead of Proxy-stub undefined results.
    settings: () => Promise.resolve(bridge.__fallbackSettings),
    saveAiConnection: (connection) => {
      const settings = bridge.__fallbackSettings;
      const id = String(connection?.id || '') || `conn-${Date.now()}`;
      const prior = (settings.aiConnections || []).find((item) => item.id === id);
      const saved = { ...(connection || {}), id, enabled: true };
      if (!saved.model) delete saved.model;
      // Keep a credential display on the saved connection so the connection
      // card shows the key state instead of "No key".
      const secret = String(saved.apiKey || saved.secret || prior?.credential?.secret || '');
      if (secret) saved.credential = { secret, display: `Key ••••${secret.slice(-4)}` };
      else if (prior?.credential) saved.credential = prior.credential;
      settings.aiConnections = (settings.aiConnections || []).filter((item) => item.id !== id).concat(saved);
      settings.aiChatConnectionId = id;
      return Promise.resolve(saved);
    },
    setProviderCredential: ({ provider, connectionId, secret } = {}) => {
      const settings = bridge.__fallbackSettings;
      const key = String(secret || '');
      const display = key ? `Key ••••${key.slice(-4)}` : 'Key saved';
      settings.aiConnections = (settings.aiConnections || []).map((item) =>
        item.id === connectionId || (!connectionId && item.provider === provider)
          ? { ...item, credential: { secret: key, display } }
          : item
      );
      return Promise.resolve(settings);
    },
    setAiConnectionModel: ({ connectionId, model } = {}) => {
      const settings = bridge.__fallbackSettings;
      settings.aiConnections = (settings.aiConnections || []).map((item) => (item.id === connectionId ? { ...item, model } : item));
      return Promise.resolve(settings);
    },
    setAiConnectionEnabled: ({ connectionId, enabled } = {}) => {
      const settings = bridge.__fallbackSettings;
      settings.aiConnections = (settings.aiConnections || []).map((item) => (item.id === connectionId ? { ...item, enabled: Boolean(enabled) } : item));
      return Promise.resolve(settings);
    },
    removeAiConnection: (connectionId) => {
      const settings = bridge.__fallbackSettings;
      settings.aiConnections = (settings.aiConnections || []).filter((item) => item.id !== connectionId);
      return Promise.resolve(settings);
    },
    loadConnection: ({ connectionId } = {}) => {
      const settings = bridge.__fallbackSettings;
      return Promise.resolve((settings.aiConnections || []).find((item) => item.id === connectionId) || null);
    },
    addProviderModel: ({ connectionId, model, kind } = {}) => {
      const settings = bridge.__fallbackSettings;
      const id = String(model || '').trim();
      if (!id) return Promise.resolve(settings);
      settings.aiConnections = (settings.aiConnections || []).map((item) => {
        if (item.id !== connectionId) return item;
        const kept = (item.customModels || []).filter((entry) => (typeof entry === 'string' ? entry : entry?.id) !== id);
        return { ...item, customModels: [...kept, { id, kind: kind || 'language', connectionId }] };
      });
      return Promise.resolve(settings);
    },
    removeProviderModel: ({ connectionId, model } = {}) => {
      const settings = bridge.__fallbackSettings;
      const id = String(model || '').trim();
      settings.aiConnections = (settings.aiConnections || []).map((item) =>
        item.id === connectionId
          ? { ...item, customModels: (item.customModels || []).filter((entry) => (typeof entry === 'string' ? entry : entry?.id) !== id) }
          : item
      );
      return Promise.resolve(settings);
    },
    // Per-connection discovery: return preview models tagged with the
    // requested connection id plus any custom models saved on the connection,
    // so the picker's connection filter keeps them and new APIs list models.
    listProviderModels: ({ connectionId } = {}) => {
      const settings = bridge.__fallbackSettings;
      const connection = (settings.aiConnections || []).find((item) => item.id === connectionId) || null;
      const custom = (connection?.customModels || []).map((entry) =>
        typeof entry === 'string'
          ? { id: entry, kind: 'language', connectionId }
          : { ...entry, connectionId: entry?.connectionId || connectionId }
      );
      return Promise.resolve({
        models: [...custom],
      });
    },
    // The browser preview has no live model connection: answer sends with a
    // real text reply instead of letting the composer fall through to the
    // "returned no media" fallback.
    generateMedia: ({ prompt, model } = {}) => Promise.resolve({
      kind: 'transcription',
      text: `Preview reply from ${model || 'the model'}: I received "${String(prompt || '').slice(0, 200)}". The browser preview has no live provider connection, so this is a local fallback response.`,
    }),
    preflightProvider: ({ model } = {}) => Promise.resolve({ ok: true, message: `${model || 'Model'} is ready.` }),
  };
  window.browserUseDesktop = new Proxy(bridge, {
    get(target, prop) {
      if (prop in target) return target[prop];
      target[prop] = () => Promise.resolve(undefined);
      return target[prop];
    },
  });
})();

// Real remote bridge for the browser GUI (no Electron preload).
// Every bridge method POSTs to /ipc, which cli/tui/guiServer.mjs proxies to
// the loopback control bridge inside the RUNNING desktop app — so the web GUI
// drives the same chat agent, settings store, and browser session as the
// desktop app instead of preview stubs. When the desktop backend is offline,
// calls fall back to the in-memory stub above so the page keeps working.
(function installWebRemoteBridge() {
  if (typeof window === 'undefined' || !window.browserUseDesktop) return;
  const stub = window.browserUseDesktop;
  if (!stub.__browserUseDesktopFallback) return; // real Electron preload — untouched
  if (typeof location === 'undefined' || location.protocol === 'file:') return; // no server to talk to

  const offline = stub; // previous stub proxy — used only when the backend is down
  const remote = {
    __browserUseDesktopFallback: true, // keep page-local drawer/downloads fallbacks
    __webBridge: true,
  };
  const listeners = new Map(); // channel -> Set<callback>

  function toChannel(name) {
    return 'browser-use:' + String(name)
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase();
  }

  let anySuccess = false;
  function markOnline(up) { anySuccess = anySuccess || up; }

  function isOfflineFailure(err) {
    return err && (err.__offline || /networkerror|failed to fetch|load failed|503|502/i.test(String(err.message || err)));
  }

  function invoke(method, args) {
    const channel = toChannel(method);
    return fetch('/ipc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args: Array.from(args || []) }),
    }).then((res) => {
      if (res.status === 503 || res.status === 502) {
        const err = new Error('backend offline'); err.__offline = true; throw err;
      }
      return res.json();
    }).then((j) => {
      markOnline(true);
      if (j && j.ok) return j.result;
      throw new Error((j && j.error) || 'bridge call failed');
    }).catch((err) => {
      if (isOfflineFailure(err)) {
        const fall = offline[method];
        return typeof fall === 'function' ? fall(...Array.from(args || [])) : undefined;
      }
      throw err;
    });
  }

  function subscribe(channel, listener) {
    if (typeof listener !== 'function') return () => { };
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(listener);
    return () => { const set = listeners.get(channel); if (set) set.delete(listener); };
  }

  function dispatch(channel, payload) {
    const set = listeners.get(channel);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try { listener(payload); } catch { /* one bad listener never blocks the rest */ }
    }
  }

  const eventStream = new EventSource('/events');
  eventStream.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data && data.channel) { markOnline(true); dispatch(data.channel, data.payload); }
    } catch { /* ignore malformed frames */ }
  };
  eventStream.onerror = () => { /* EventSource auto-reconnects; invokes handle offline per call */ };

  // Invoke-backed methods: mirrors every preload.cjs invoke.
  const INVOKE_METHODS = [
    'state', 'rendererReady', 'agentState', 'agentPreflight', 'agentStart', 'setDefaultWorkspace',
    'agentCancel', 'subagentMessage', 'subagentStop', 'subagentClose', 'agentRetire', 'agentApprove',
    'settings', 'layaStatus', 'layaInstall', 'layaStop', 'providerStatus', 'preflightProvider',
    'listProviderModels', 'addProviderModel', 'generateMedia', 'ttsVoices', 'setTtsVoice',
    'setProviderCredential', 'clearProviderCredential', 'saveAiConnection', 'setAiConnectionModel',
    'setAiConnectionEnabled', 'removeAiConnection', 'setModelKind', 'removeProviderModel',
    'recordMediaHistory', 'chatHistoryList', 'scheduleList', 'scheduleCreate', 'scheduleUpdate',
    'schedulePreview', 'scheduleRemove', 'chatHistoryGet', 'chatHistoryDelete', 'chatHistoryClear',
    'historyList', 'historyDelete', 'historyClear', 'downloadsOpen', 'downloadsShow', 'agentSteer',
    'saveSettings', 'consoleEntries', 'clearConsole', 'toggleDevTools', 'newTab', 'selectTab',
    'closeTab', 'navigate', 'goBack', 'goForward', 'reload', 'desktopMcpStatus', 'createPairingOffer',
    'cancelPairingOffer', 'mcpConnectionConfiguration', 'gptActionSchema', 'mcpSessions',
    'revokeMcpSession', 'revokeAllMcpSessions', 'copyText', 'savePastedTextAttachment',
    'showContextMenu', 'openChatWindow', 'closeChatWindow', 'setChatPinned', 'setChatWindowWidth',
    'openReportPreview', 'readReportPreview', 'openExternal', 'openScreenshotPreview',
    'openMediaPreview', 'downloadMedia', 'closePreview', 'downloadPreview', 'setActiveDrawer',
    'setAgentDrawerWidth', 'viewportMetrics', 'deviceProfiles', 'deviceState', 'setDeviceMode',
    'rotateDevice', 'setShowTouches', 'setDeviceZoom', 'terminalLayout', 'terminalBackend',
    'toggleTerminal', 'setTerminalHeight', 'detachTerminal', 'terminalCreate', 'terminalActiveSession',
    'terminalSessions', 'terminalAttach', 'terminalWrite', 'terminalRecover', 'terminalResize',
    'terminalDispose', 'terminalScreenshot', 'pickElement', 'cancelPickElement', 'domSelection',
    'closeAbout', 'closeOverlay', 'setDeviceMenuOpen', 'toggleDeviceMenuOpen', 'setDownloadsOpen',
    'showTabGroup', 'showAppMenu', 'setHistoryMenuOpen', 'recordingPickPath', 'recordingStatus',
    'recordingStart', 'recordingStop', 'recordStart', 'recordStop', 'recordStatus',
    'recordRecheckModel', 'recordProposal', 'recordResolveProposal', 'skillsList', 'skillsSave',
    'skillsDelete', 'skillsRead', 'skillsUpdate', 'skillsManage', 'mcpManage', 'instructionsLoad',
    'notebookOpen', 'notebookRead', 'notebookSave',
  ];
  for (const name of INVOKE_METHODS) {
    remote[name] = function (...args) { return invoke(name, args); };
  }

  // Event-backed methods: mirror preload.cjs ipcRenderer.on registrations.
  const LISTENER_METHODS = {
    onState: 'browser-use:state',
    onAgentEvent: 'browser-use:agent-event',
    onScheduleEvent: 'browser-use:schedule-event',
    onRecordEvent: 'browser-use:record-event',
    onConsole: 'browser-use:console',
    onMcpState: 'browser-use:mcp-state',
    onPreview: 'browser-use:preview',
    onChatDockGeometry: 'browser-use:chat-dock-geometry',
    onTerminalData: 'browser-use:terminal-data',
    onTerminalExit: 'browser-use:terminal-exit',
    onTerminalSelectAll: 'browser-use:terminal-select-all',
    onNotebookLoad: 'browser-use:notebook-load',
    onNotebookSaved: 'browser-use:notebook-saved',
  };
  for (const [name, channel] of Object.entries(LISTENER_METHODS)) {
    remote[name] = (listener) => subscribe(channel, listener);
  }

  // androidDevices mixes invokes with one event stream.
  remote.androidDevices = {
    list: (...a) => invoke('androidDevicesList', a),
    refresh: (...a) => invoke('androidDevicesRefresh', a),
    pair: (...a) => invoke('androidDevicesPair', a),
    connect: (...a) => invoke('androidDevicesConnect', a),
    disconnect: (...a) => invoke('androidDevicesDisconnect', a),
    remove: (...a) => invoke('androidDevicesRemove', a),
    select: (...a) => invoke('androidDevicesSelect', a),
    programmaticInput: (...a) => invoke('androidDevicesProgrammaticInput', a),
    adb: (...a) => invoke('androidDevicesAdb', a),
    streamStart: (...a) => invoke('androidDevicesStreamStart', a),
    streamStop: (...a) => invoke('androidDevicesStreamStop', a),
    streamBounds: (...a) => invoke('androidDevicesStreamBounds', a),
    onEvent: (handler) => subscribe('browser-use:android-device-event', handler),
  };

  // Browser pages cannot resolve a File to an on-disk path; return '' so the
  // composer uses its in-memory attachment fallback (see preload.cjs).
  remote.pathForFile = () => '';

  // Keep the stub's page-local echo behaviors working alongside the remote
  // call (drawer state, device menu aria) — the published state events win.
  const echoLocally = ['setActiveDrawer', 'toggleDeviceMenuOpen', 'setDeviceMenuOpen', 'setDownloadsOpen'];
  for (const name of echoLocally) {
    const remoteFn = remote[name];
    remote[name] = function (...args) {
      try { offline[name](...args); } catch { /* local echo is best-effort */ }
      return remoteFn(...args);
    };
  }

  window.browserUseDesktop = new Proxy(remote, {
    get(target, prop) {
      if (prop in target) return target[prop];
      target[prop] = function (...args) { return invoke(String(prop), args); };
      return target[prop];
    },
  });
})();

const tabs = document.querySelector('#tabs');
const address = document.querySelector('#address');
const form = document.querySelector('#navigation-form');
const back = document.querySelector('#back');
const forward = document.querySelector('#forward');
const reload = document.querySelector('#reload');
const newTab = document.querySelector('#new-tab');
// Keep the + control in the same flex row as the rendered tabs so it follows
// the last visible tab instead of occupying a separate fixed slot.
if (newTab && tabs && newTab.parentElement !== tabs) tabs.append(newTab);
const consoleToggle = document.querySelector('#console-toggle');
const recordingToggle = document.querySelector('#recording-toggle');
const settingsToggle = document.querySelector('#settings-toggle');
const consolePanel = document.querySelector('#console-panel');
const settingsPanel = document.querySelector('#settings-panel');
const consoleList = document.querySelector('#console-list');
const consoleEmpty = document.querySelector('#console-empty');
const agentIndicator = document.querySelector('#agent-state');
const agentState = document.querySelector('#agent-state span');
const clearConsole = document.querySelector('#clear-console');
const deviceToggle = document.querySelector('#device-toggle');
const deviceMenu = document.querySelector('#device-menu');
const rotateDevice = document.querySelector('#rotate-device');
const standaloneChatWindowId = new URLSearchParams(location.search).get('chatWindow') || '';
const agentToggle = document.querySelector('#agent-toggle');
const agentToggleBadge = document.querySelector('#agent-toggle-badge');
const agentPanel = document.querySelector('#agent-panel');
const agentForm = document.querySelector('#agent-form');
const agentTask = document.querySelector('#agent-task');
const agentConversationTitle = document.querySelector('#agent-conversation-title');
const agentNewChat = document.querySelector('#agent-new-chat');
const agentPin = document.querySelector('#agent-pin');
const agentDrawerResize = document.querySelector('#agent-drawer-resize');
const agentTranscript = document.querySelector('#agent-transcript');
// LORDE_SUBAGENT_TABS_V366 — feed-host indirection. Every transcript append
// routes through chatFeed() so a subagent tab can host its own feed element
// while the main conversation keeps rendering into the original transcript.
// chatFeedHost is null whenever the Main tab is active (the common case), so
// chatFeed() === agentTranscript and existing behavior is byte-identical.
let chatFeedHost = null;
function chatFeed() { return chatFeedHost || agentTranscript; }

// LORDE_CHAT_TIMELINE_V1 — a slim strip of dashes (one per transcript message)
// docked in the transcript's right gutter. Hovering the strip expands a window
// that lists every message with its label and an excerpt; clicking a dash or a
// row scrolls the conversation to that exact message. The strip mirrors
// whatever feed is active (main conversation or a subagent tab).
const chatTimeline = document.createElement('div');
chatTimeline.className = 'agent-timeline';
chatTimeline.id = 'agent-timeline';
const chatTimelineTrack = document.createElement('div');
chatTimelineTrack.className = 'agent-timeline-track';
const chatTimelineWindow = document.createElement('div');
chatTimelineWindow.className = 'agent-timeline-window';
chatTimeline.append(chatTimelineTrack, chatTimelineWindow);

let chatTimelineInitialized = false;
let chatTimelineObserver = null;
let chatTimelineObservedHost = null;
let chatTimelineRefreshQueued = false;

function chatTimelineExcerpt(item) {
  const paragraph = item.querySelector(':scope > p');
  const text = String(paragraph?.textContent || item.textContent || '').replace(/\s+/g, ' ').trim();
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function rebuildChatTimeline() {
  const feed = chatFeed();
  // Timeline = the user's turns only. Thoughts, tool calls and agent replies
  // stay out — the strip is a "where did I say what" map, not a full index.
  const messages = [...feed.querySelectorAll(':scope > .agent-message.is-user')];
  chatTimelineTrack.replaceChildren(...messages.map((item) => {
    const dash = document.createElement('button');
    dash.type = 'button';
    dash.className = 'agent-timeline-dash is-user';
    const excerpt = chatTimelineExcerpt(item);
    dash.title = `You: ${excerpt || '(empty)'}`;
    dash.setAttribute('aria-label', `Jump to your message: ${excerpt}`);
    dash.addEventListener('click', (event) => { event.stopPropagation(); jumpToTimelineMessage(item); });
    return dash;
  }));
  chatTimelineWindow.replaceChildren(...messages.map((item) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-timeline-row is-user';
    const excerpt = document.createElement('span');
    excerpt.textContent = chatTimelineExcerpt(item) || '(empty)';
    row.append(excerpt);
    row.title = 'Jump to this message';
    row.addEventListener('click', (event) => { event.stopPropagation(); jumpToTimelineMessage(item); });
    return row;
  }));
}

function scheduleTimelineRefresh() {
  if (chatTimelineRefreshQueued) return;
  chatTimelineRefreshQueued = true;
  setTimeout(() => {
    chatTimelineRefreshQueued = false;
    rebuildChatTimeline();
  }, 200);
}

function ensureChatTimelineObserver() {
  const host = chatFeed();
  if (chatTimelineObservedHost === host) return;
  chatTimelineObserver?.disconnect();
  chatTimelineObserver = new MutationObserver(scheduleTimelineRefresh);
  chatTimelineObserver.observe(host, { childList: true });
  chatTimelineObservedHost = host;
  scheduleTimelineRefresh();
}

function jumpToTimelineMessage(item) {
  item.scrollIntoView({ behavior: 'smooth', block: 'start' });
  item.classList.remove('is-timeline-flash');
  // Force a reflow so the highlight animation can restart on repeat jumps.
  void item.offsetWidth;
  item.classList.add('is-timeline-flash');
  setTimeout(() => item.classList.remove('is-timeline-flash'), 1600);
}

function initChatTimeline() {
  if (chatTimelineInitialized) return;
  const panel = document.querySelector('#agent-panel');
  if (!panel) return;
  panel.append(chatTimeline);
  chatTimeline.addEventListener('mouseenter', () => { ensureChatTimelineObserver(); rebuildChatTimeline(); });
  chatTimelineInitialized = true;
  ensureChatTimelineObserver();
}
setTimeout(initChatTimeline, 400);
// Stick-to-bottom, the way polished chat UIs do it: the transcript follows
// the live stream only while the user is already at the bottom. Scrolling up
// detaches the follow (nothing yanks the view), and a scroll-to-bottom
// button appears until they return. The stick decision is captured BEFORE
// any DOM mutation, because appended content grows scrollHeight and would
// otherwise read as "the user scrolled away".
const TRANSCRIPT_BOTTOM_SLACK = 56;
let transcriptStickToBottom = true;

function transcriptNearBottom() {
  const feed = chatFeed();
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight <= TRANSCRIPT_BOTTOM_SLACK;
}

agentTranscript.addEventListener('scroll', () => {
  transcriptStickToBottom = transcriptNearBottom();
  // Returning to the live stream clears the "new messages below" badge.
  if (transcriptStickToBottom) transcriptUnseenCount = 0;
  updateTranscriptJumpButton();
}, { passive: true });

// Messages that arrive while the user is scrolled away are counted on the
// scroll-to-bottom badge, so the affordance says what it is worth.
let transcriptUnseenCount = 0;
let agentMessageUnseenCount = 0;
// LORDE_SUBAGENT_TABS_V366 — factored so the subagent feed host gets the same
// unseen badge accounting as the main transcript.
function observeFeedMessages(host) {
  new MutationObserver((records) => {
    if (transcriptStickToBottom) return;
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        if (node.classList?.contains('agent-message') || node.querySelector?.('.agent-message')) transcriptUnseenCount += 1;
      }
    }
    if (transcriptUnseenCount) updateTranscriptJumpButton();
  }).observe(host, { childList: true, subtree: true });
}
observeFeedMessages(agentTranscript);

function updateTranscriptJumpButton() {
  const button = document.querySelector('#agent-scroll-bottom');
  if (!button) return;
  const progressStrip = document.querySelector('#agent-progress-strip');
  const progressHeight = progressStrip ? Math.ceil(progressStrip.getBoundingClientRect().height) : 0;
  document.documentElement.style.setProperty('--agent-progress-height', `${progressHeight}px`);
  button.hidden = transcriptStickToBottom || !chatFeed().children.length;
  const badge = button.querySelector('.agent-scroll-bottom-badge');
  if (badge) {
    badge.hidden = transcriptUnseenCount === 0;
    badge.textContent = transcriptUnseenCount > 99 ? '99+' : String(transcriptUnseenCount);
  }
  if (agentToggleBadge) {
    agentToggleBadge.hidden = agentMessageUnseenCount === 0 || activeDrawer === 'agent';
    agentToggleBadge.textContent = agentMessageUnseenCount > 99 ? '99+' : String(agentMessageUnseenCount);
  }
}

document.querySelector('#agent-scroll-bottom')?.addEventListener('click', () => {
  const feed = chatFeed();
  transcriptStickToBottom = true;
  transcriptUnseenCount = 0;
  agentMessageUnseenCount = 0;
  feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
  updateTranscriptJumpButton();
});

// Mutation wrapper: captures stickiness first, mutates, then follows only
// when the user had not scrolled away.
function withTranscriptStick(mutate) {
  const feed = chatFeed();
  const stick = transcriptNearBottom();
  mutate();
  if (stick) feed.scrollTop = feed.scrollHeight;
  updateTranscriptJumpButton();
}
const agentApproval = document.querySelector('#agent-approval');
const agentRunStatus = document.querySelector('#agent-run-status');
const agentTabScope = document.querySelector('#agent-tab-scope');
const agentCancel = document.querySelector('#agent-cancel');
const agentSend = document.querySelector('#agent-send');
const agentRunAction = document.querySelector('#agent-run-action');
const agentRunActionMenu = document.querySelector('#agent-run-action-menu');
const agentQueued = document.querySelector('#agent-queued');
const agentQueuedText = document.querySelector('#agent-queued-text');
const agentQueuedRemove = document.querySelector('#agent-queued-remove');
const agentGoalEdit = document.querySelector('#agent-goal-edit');
const agentGoalEditor = document.querySelector('#agent-goal-editor');
const agentGoalTextarea = document.querySelector('#agent-goal-textarea');
const agentGoalSave = document.querySelector('#agent-goal-save');
const agentGoalCancel = document.querySelector('#agent-goal-cancel');
const agentHistory = document.querySelector('#agent-history');
const agentSchedules = document.querySelector('#agent-schedules');
const agentSchedulesView = document.querySelector('#agent-schedules-view');
const agentSchedulesList = document.querySelector('#agent-schedules-list');
const agentSchedulesClose = document.querySelector('#agent-schedules-close');
const agentScheduleAdd = document.querySelector('#agent-schedule-add');
const agentCopyChat = document.querySelector('#agent-copy-chat');
const agentHistoryView = document.querySelector('#agent-history-view');
const agentHistoryList = document.querySelector('#agent-history-list');
const agentHistoryClose = document.querySelector('#agent-history-close');
const agentSkillAdd = document.querySelector('#agent-skill-add');
const agentPermission = document.querySelector('#agent-permission');
const agentEffort = document.querySelector('#agent-effort');
const agentControlMode = document.querySelector('#agent-control-mode');
let controlModeSave = Promise.resolve();
agentControlMode?.addEventListener('change', () => {
  const requested = agentControlMode.value;
  controlModeSave = controlModeSave.then(async () => {
    const saved = await window.browserUseDesktop.saveSettings({ agentControlMode: requested });
    publicSettings = { ...publicSettings, agentControlMode: saved.agentControlMode };
  }).catch(error => {
    agentControlMode.value = publicSettings.agentControlMode || 'browser';
    reportError(error, 'Could not change control mode.');
  });
});
const agentAttach = document.querySelector('#agent-attach');
const agentFileInput = document.querySelector('#agent-file-input');
const agentAttachments = document.querySelector('#agent-attachments');
const agentAttachmentStatus = document.querySelector('#agent-attachment-status');
const agentModelToggle = document.querySelector('#agent-model-toggle');
const agentModelMenu = document.querySelector('#agent-model-menu');
const agentModelLabel = document.querySelector('#agent-model-label');
const agentSettingsToggle = document.querySelector('#agent-settings-toggle');
const agentSettingsScreen = document.querySelector('#agent-settings-screen');
const agentSettingsClose = document.querySelector('#agent-settings-close');
const agentProviderSettingsForm = document.querySelector('#agent-provider-settings-form');
const agentAndroidRefresh = document.querySelector('#agent-android-refresh');
const agentAndroidPairToggle = document.querySelector('#agent-android-pair-toggle');
const agentAndroidPair = document.querySelector('#agent-android-pair');
const agentAndroidAddress = document.querySelector('#agent-android-address');
const agentAndroidPairingCode = document.querySelector('#agent-android-pairing-code');
const agentAndroidPairSubmit = document.querySelector('#agent-android-pair-submit');
const agentAndroidConnectSubmit = document.querySelector('#agent-android-connect-submit');
const agentAndroidDeviceList = document.querySelector('#agent-android-device-list');
const agentAndroidStreamHost = document.querySelector('#agent-android-stream-host');
const agentAndroidStreamRenderer = document.querySelector('#agent-android-stream-renderer');
const agentProviderSelect = document.querySelector('#agent-provider-select');
const agentProviderSelectTrigger = document.querySelector('#agent-provider-select-trigger');
const agentProviderSelectMenu = document.querySelector('#agent-provider-select-menu');
const agentProviderSelectLabel = document.querySelector('#agent-provider-select-label');
const agentProviderAuthNote = document.querySelector('#agent-provider-auth-note');
const agentProviderBrand = document.querySelector('#agent-provider-brand');
const agentProviderName = document.querySelector('#agent-provider-name');
const agentConnectionList = document.querySelector('#agent-connection-list');
const agentProviderDelete = document.querySelector('#agent-provider-delete');
const agentProviderBaseUrl = document.querySelector('#agent-provider-baseurl');
const agentProviderBaseUrlField = document.querySelector('#agent-provider-baseurl-field');
const agentProviderKey = document.querySelector('#agent-provider-key');
const agentProviderKeyField = document.querySelector('#agent-provider-key-field');
const agentProviderKeyToggle = document.querySelector('#agent-provider-key-toggle');
const agentProviderSignupLink = document.querySelector('#agent-provider-signup-link');
const agentProviderClear = document.querySelector('#agent-provider-clear');
const agentProviderTestStatus = document.querySelector('#agent-provider-test-status');
const systemOneBrain = document.querySelector('#system-one-brain');
const jevSettingsFields = document.querySelector('#jev-settings-fields');
const jevBaseUrl = document.querySelector('#jev-base-url');
const jevModelId = document.querySelector('#jev-model-id');
const jevApiKey = document.querySelector('#jev-api-key');
const jevApiKeyToggle = document.querySelector('#jev-api-key-toggle');
const jevApiKeyClear = document.querySelector('#jev-api-key-clear');
const jevSettingsSave = document.querySelector('#jev-settings-save');
const jevSettingsStatus = document.querySelector('#jev-settings-status');
const agentPlan = document.querySelector('#agent-plan');
const agentPlanToggle = document.querySelector('#agent-plan-toggle');
const agentPlanTitle = document.querySelector('#agent-plan-title');
const agentPlanCount = document.querySelector('#agent-plan-count');
const agentPlanList = document.querySelector('#agent-plan-list');
let publicSettings = {};
const terminalToggle = document.querySelector('#terminal-toggle');
const recordingBanner = document.querySelector('#recording-banner');
const recordingBannerTime = document.querySelector('#recording-banner-time');
const recordingBannerStop = document.querySelector('#recording-banner-stop');
let screenRecordingStartedAt = 0;
let screenRecordingTimer = null;
recordingBannerStop?.addEventListener('click', () => window.browserUseDesktop.recordingStop().catch(error => reportError(error, 'Could not stop recording.')));
function renderRecording(recording) {
  // The recorder is a main-window surface only: standalone chat windows share
  // this document and receive the same state broadcasts, and rendering the
  // banner here duplicated it across the chat headers.
  if (standaloneChatWindowId) return;
  const active = ['starting', 'recording', 'stopping'].includes(recording?.state);
  recordingBanner.hidden = !active;
  if (!active) { if (screenRecordingTimer) clearInterval(screenRecordingTimer); screenRecordingTimer = null; screenRecordingStartedAt = 0; return; }
  if (!screenRecordingStartedAt) screenRecordingStartedAt = Date.now();
  if (!screenRecordingTimer) screenRecordingTimer = setInterval(() => { const elapsed = Math.floor((Date.now() - screenRecordingStartedAt) / 1000); recordingBannerTime.textContent = `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`; }, 500);
}
const terminalPanel = document.querySelector('#terminal-panel');
const terminalSurface = document.querySelector('#terminal-surface');
const terminalResize = document.querySelector('#terminal-resize');
const terminalBackend = document.querySelector('#terminal-backend');
const terminalStateChip = document.querySelector('#terminal-state-chip');
const terminalRecover = document.querySelector('#terminal-recover');
const terminalScreenshot = document.querySelector('#terminal-screenshot');
const terminalSelect = document.querySelector('#terminal-select');
const terminalReset = document.querySelector('#terminal-reset');
const terminalDetach = document.querySelector('#terminal-detach');
const terminalClose = document.querySelector('#terminal-close');

function gptSchemaSnippet(status) {
  if (!status.gptActionSchema) return 'Disabled, enable and save settings.';
  return JSON.stringify(status.gptActionSchema, null, 2);
}

const DRAWER_PANELS = { agent: agentPanel, console: consolePanel, settings: settingsPanel };
const DRAWER_TOGGLES = { agent: agentToggle, console: consoleToggle, recorder: recordingToggle, settings: settingsToggle };
const COPY_FEEDBACK_MS = 1500;
// Mirrors APP_CHROME_HEIGHT in main.cjs and the .browser-chrome height in
// styles.css: the vertical offset where every native view begins.
const APP_CHROME_HEIGHT = 110;
function positionAppTitle() {
  const menu = document.querySelector('.chrome-menu');
  const title = document.querySelector('.app-title');
  if (!menu || !title) return;
  const leftLimit = menu.getBoundingClientRect().right + 6;
  const rightLimit = window.innerWidth - 140;
  const width = Math.max(0, Math.min(title.scrollWidth, rightLimit - leftLimit));
  const center = Math.max(leftLimit + width / 2, Math.min(window.innerWidth / 2, rightLimit - width / 2));
  title.style.width = `${width}px`;
  title.style.maxWidth = `${width}px`;
  title.style.left = `${center}px`;
}
window.addEventListener('resize', positionAppTitle);
requestAnimationFrame(positionAppTitle);

// Fallback: show a simple dropdown when browserUseDesktop is not available (browser preview)
const menuOptions = {
  file: ['New Tab', 'Open File…', 'Save Page…', 'separator', 'Settings', 'separator', 'Exit'],
  edit: ['Undo', 'Redo', 'separator', 'Cut', 'Copy', 'Paste', 'Delete', 'separator', 'Select All'],
  view: ['Reload', 'Zoom In', 'Zoom Out', 'Reset Zoom', 'separator', 'Full Screen', 'separator', 'Developer Tools'],
  window: ['Minimize', 'Maximize', 'Close Tab', 'separator', 'New Window']
};

function showFallbackMenu(menu, x, y) {
  const existing = document.getElementById('fallback-app-menu');
  if (existing) existing.remove();
  const ul = document.createElement('ul');
  ul.id = 'fallback-app-menu';
  ul.style.cssText = 'position:fixed;left:' + x + 'px;top:' + y + 'px;background:#0a1012;border:1px solid #344246;border-radius:4px;padding:4px 0;min-width:160px;z-index:99999;list-style:none;margin:0;';
  (menuOptions[menu] || []).forEach(item => {
    const li = document.createElement('li');
    if (item === 'separator') { li.style.cssText = 'border-top:1px solid #344246;margin:4px 0;'; }
    else { li.textContent = item; li.style.cssText = 'padding:6px 16px;cursor:pointer;color:#edf2f2;font-size:13px;'; li.onmouseenter = () => li.style.background = '#1a2024'; li.onmouseleave = () => li.style.background = 'transparent'; }
    ul.appendChild(li);
  });
  document.body.appendChild(ul);
  const close = (e) => { if (!ul.contains(e.target)) { ul.remove(); document.removeEventListener('click', close); } };
  setTimeout(() => document.addEventListener('click', close), 0);
}
document.querySelectorAll('[data-app-menu]').forEach(button => {
  button.addEventListener('click', async () => {
    const rect = button.getBoundingClientRect();
    button.classList.add('is-active');
    try {
      if (window.browserUseDesktop && window.browserUseDesktop.showAppMenu) {
        await window.browserUseDesktop.showAppMenu(button.dataset.appMenu, { x: rect.left, y: rect.bottom });
      } else {
        showFallbackMenu(button.dataset.appMenu, rect.left, rect.bottom);
      }
    } catch (error) { reportError(error, 'Could not open the application menu.'); }
    finally { button.classList.remove('is-active'); }
  });
});


let state = { tabs: [], selectedTabId: null, active: null };
let consoleEntries = [];
let consoleFilter = 'all';
let activeDrawer = 'agent';
let drawerQueue = Promise.resolve();
let mcpStatus = { listening: false, endpoint: null, pairingEndpoint: null, pairing: { active: false }, sessions: [] };
let pairingCode = '';
let pairingCodeExpiresAt = 0;
let deviceProfiles = [];
let deviceState = null;
let terminalController = null;
let terminalOpen = false;
let chatRun = null;
// The transcript may temporarily show a saved conversation while a different
// live run continues. Keep the live owner separate so its controls never lose
// their target during History or a delayed renderer event.
let activeChatRun = null;
// Plans and thought cards belong to the conversation currently painted in the
// chat. A cancelled conversation may still have queued IPC events, so do not
// let those events attach its work to a fresh or restored conversation.
let visibleConversationId = null;
const retiredConversationIds = new Set();
let selectedAgentModel = '';
let providerModelCatalog = {};
// Per-connection model pricing (usdPerM [input,output] per 1M tokens) when
// the gateway reports it — feeds the run footer's COST figure.
let providerModelPricing = {};
function pricingKeyForRun(run) {
  return String(run?.provider?.connectionId || activeConnection()?.id || '');
}
// Catalogue entry kinds by connection key: { modelId: kind }. Populated from
// list-provider-models alongside providerModelCatalog.
let providerModelKinds = {};
let selectedAgentConnectionId = '';
let selectedModelTargetConnectionId = '';
let modelPickerQuery = '';
// GEN9 xkiro wiring: the TTS voice list (cached per session) + the saved
// per-connection voice the composer's audio generation defaults to.
let agentTtsVoices = null;
let agentTtsVoice = '';
let pendingAgentAttachments = [];
const domAttachmentApi = window.BrowserUseDomAttachments || null;
const toolTargetApi = window.BrowserUseToolTarget || null;

const MAX_AGENT_TEXT_FILE_CHARS = 120_000;
const MAX_AGENT_TEXT_TOTAL_CHARS = 240_000;
const MAX_AGENT_IMAGE_BYTES = 8_000_000;
const AGENT_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
// Fuzzy model-search matching: tolerant of typos, spacing, punctuation and
// word order. Returns true when the query matches the target at >= 80%
// similarity (i.e. up to 20% of characters may differ after normalisation).
function normalizeForSearch(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/s+/g, ' ').trim();
}
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const row = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = row[0]; row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[n];
}
function fuzzyModelMatch(query, target) {
  const nq = normalizeForSearch(query);
  const nt = normalizeForSearch(target);
  if (!nq) return true;
  if (nt.includes(nq)) return true;
  // Word-order agnostic: every query word appears in some target word.
  const qWords = nq.split(' ').filter(Boolean);
  const tWords = nt.split(' ').filter(Boolean);
  if (qWords.length && qWords.every((qw) => tWords.some((tw) => { if (tw.includes(qw) || qw.includes(tw)) return true; const wl = Math.max(qw.length, tw.length); return wl > 0 && (1 - levenshteinDistance(qw, tw) / wl) >= 0.8; }))) return true;
  // Levenshtein similarity >= 0.8 on the full normalised strings.
  const a = nq.replace(/ /g, ''); const b = nt.replace(/ /g, '');
  const maxLen = Math.max(a.length, b.length);
  return maxLen > 0 && (1 - levenshteinDistance(a, b) / maxLen) >= 0.8;
}

function diagnosticText(value) {
  if (value === undefined || value === null) return 'No diagnostic value.';
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function icon(name = 'copy') {
  const element = document.createElement('i');
  element.className = `ph ph-${name}`;
  element.setAttribute('aria-hidden', 'true');
  return element;
}

// LORDE_TOOL_ICONS_V364 — each tool card carries an icon that matches what
// the tool actually does: robot for AI model/subagent calls, book for reads,
// pen for patches/writes, camera for screenshots, video for recordings, and
// the pointer stays for clicks. Unknown tools keep the pointer.
const TOOL_ICON_RULES = [
  [/^(computer_model|task_spawn|research_task|schedule_task)$/, 'robot'],
  [/^(computer_read|computer_search|computer_index|browser_console_entries|browser_network_entries|browser_navigation_state|browser_query|browser_extract|browser_fetch|browser_search|browser_tabs|skill_search|skill_feedback)$/, 'book-open'],
  [/^(computer_write|computer_patch|write_report_file|write_project_file|chat_compact)$/, 'pen'],
  [/^(browser_screenshot|computer_screenshot)$/, 'camera'],
  [/^computer_record$/, 'video-camera'],
  [/^computer_terminal$/, 'terminal-window'],
  [/^computer_git$/, 'git-branch'],
  [/^computer_clipboard$/, 'clipboard-text'],
  [/^computer_observe$/, 'eye'],
  [/^computer_fs/, 'folder-open'],
  [/^browser_navigate$/, 'globe'],
  [/^browser_wait$/, 'hourglass'],
  [/^(ask_user|create_plan|update_plan)$/, 'question'],
  [/^browser_set_device_mode$/, 'device-mobile'],
  [/^browser_(go_back|select_tab|focus_tab|new_tab)$/, 'browsers'],
  [/^agent_message$/, 'chat-circle-text'],
  [/^skill_run$/, 'lightning'],
  [/^(update_plan|finish|browser_done)$/, 'list-checks']
];

function toolIcon(toolName) {
  const name = String(toolName || '');
  for (const [pattern, iconName] of TOOL_ICON_RULES) {
    if (pattern.test(name)) return iconName;
  }
  return 'cursor-click';
}

function messageLabel(kind) {
  if (kind === 'user') return 'You';
  if (kind === 'tool') return 'Action';
  if (kind === 'stale') return 'Stale element';
  if (kind === 'error') return 'Action needs adjustment';
  if (kind === 'steps') return 'Steps';
  if (kind === 'agent-message') return 'Agent message';
  return 'Thought';
}

function fileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => resolve(String(reader.result || '')), { once: true });
    reader.addEventListener('error', () => reject(reader.error || new Error('The file could not be read.')), { once: true });
    reader.readAsDataURL(file);
  });
}

function setAttachmentStatus(message = '') {
  if (!agentAttachmentStatus) return;
  agentAttachmentStatus.textContent = message;
  agentAttachmentStatus.hidden = !message;
}

function renderPendingAttachments() {
  if (!agentAttachments) return;
  // DOM attachments are rendered as inline composer cards, not tray chips.
  const chips = pendingAgentAttachments.filter((attachment) => !attachment.inline).map((attachment, index) => {
    const chip = document.createElement('span'); chip.className = 'agent-attachment-chip';
    // Path attachments show WHERE the agent will read from; content
    // attachments keep showing just the name.
    chip.title = attachment.kind === 'path' ? `${attachment.name} — ${attachment.path}` : attachment.name;
    // The DOM surface name can be thousands of characters — the pill shows a
    // bounded label (~20ch) and never renders the whole surface text.
    const label = document.createElement('span');
    label.className = 'agent-attachment-label';
    label.textContent = attachment.name.length > 24 ? `${attachment.name.slice(0, 20)}…` : attachment.name;
    if (attachment.kind === 'image' && ['image/png', 'image/jpeg', 'image/webp'].includes(attachment.mimeType)) {
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Preview'; preview.setAttribute('aria-label', `Preview ${attachment.name}`);
      preview.addEventListener('click', () => openScreenshotPreview({ data: String(attachment.dataUrl || '').split(',')[1] || '', mimeType: attachment.mimeType }));
      chip.append(label, preview);
    } else if (attachment.path && /\.(html?|txt|md|csv|json|xml|svg)$/i.test(attachment.name)) {
      const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'agent-attachment-preview'; preview.textContent = 'Open';
      preview.setAttribute('aria-label', 'Open ' + attachment.name);
      preview.addEventListener('click', () => openReportPreviewInChat({ path: attachment.path }));
      chip.append(label, preview);
    } else {
      chip.append(label);
    }
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'agent-attachment-remove'; remove.setAttribute('aria-label', `Remove ${attachment.name}`); remove.append(icon('x'));
    remove.addEventListener('click', () => {
      setAttachmentStatus('');
      removeDomAttachment(attachment.id);
    });
    chip.append(remove);
    return chip;
  });
  agentAttachments.replaceChildren(...chips);
  agentAttachments.hidden = chips.length === 0;
}

// `source` — 'memory' (default): paste/DOM-capture files, legacy behavior,
// content is copied under the size budgets. 'filesystem': file picker and
// drag-drop; per the owner directive these attach as SOURCE PATHS (no content
// copy, no size/count budget) so the agent reads them with its own file tools
// — including whole folders. Only when the File has no resolvable on-disk path
// (a synthetic or in-memory File) does a filesystem-sourced file fall back to
// the legacy copy path. See desktop/attachments_path_flow_chat.md.
function addAgentPathAttachment(attachment) {
  pendingAgentAttachments.push({
    id: attachment.id || crypto.randomUUID(),
    name: String(attachment.name || 'pasted-text.txt'),
    mimeType: String(attachment.mimeType || 'text/plain'),
    kind: 'path',
    path: String(attachment.path || ''),
    size: Number(attachment.size) || 0,
    pasted: true
  });
  renderPendingAttachments();
}

async function addAgentFiles(files, { source = 'memory' } = {}) {
  setAttachmentStatus('');
  const incoming = [...(files || [])];
  if (!incoming.length) return;
  const additions = [];
  let textTotal = pendingAgentAttachments.filter((item) => item.kind === 'file').reduce((total, item) => total + item.text.length, 0);
  for (const file of incoming) {
    if (source === 'filesystem') {
      const classified = BrowserUseAttachments.classifyFile(file);
      if (classified.mode === 'path') { additions.push(classified.attachment); continue; }
    }
    const mimeType = String(file.type || '').toLowerCase();
    if (AGENT_IMAGE_TYPES.has(mimeType)) {
      if (file.size > MAX_AGENT_IMAGE_BYTES) throw new Error(`${file.name} is too large. Images must be under 8 MB.`);
      const dataUrl = await fileAsDataUrl(file);
      additions.push({ id: crypto.randomUUID(), name: file.name, mimeType, kind: 'image', size: file.size, dataUrl });
      continue;
    }
    // Match the connected Lorde AI composer: every non-image attachment is
    // read as text context rather than being excluded by a filename allow-list.
    const content = await file.text();
    if (content.length > MAX_AGENT_TEXT_FILE_CHARS) throw new Error(`${file.name} is too large. Text files must be under 120,000 characters.`);
    textTotal += content.length;
    if (textTotal > MAX_AGENT_TEXT_TOTAL_CHARS) throw new Error('The attached text is too large. Keep the combined text under 240,000 characters.');
    additions.push({ id: crypto.randomUUID(), name: file.name, mimeType: mimeType || 'application/octet-stream', kind: 'file', size: file.size, text: content });
  }
  pendingAgentAttachments.push(...additions);
  renderPendingAttachments();
}

function appendInlineRichText(parent, value) {
  const source = String(value || '');
  const tokenPattern = /(!\[[^\]\n]*\]\((?:data:image\/(?:png|jpeg|jpg|webp|gif);base64,|https?:\/\/)[^\s)]+\)|`[^`\n]+`|\*{4}[^*\n]+\*{4}|\*{3}[^*\n]+\*{3}|___[^_\n]+___|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/gi;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    let element;
    if (token.startsWith('![')) {
      const imageMatch = token.match(/^!\[([^\]]*)\]\(([^\s)]+)\)$/);
      if (imageMatch && (/^data:image\//.test(imageMatch[2]) || /^https?:\/\//.test(imageMatch[2]))) {
        const picture = document.createElement('img');
        picture.className = 'agent-media-image';
        picture.alt = imageMatch[1] || 'image';
        picture.src = imageMatch[2];
        picture.loading = 'lazy';
        parent.append(picture);
      } else {
        element = document.createElement('span');
        element.textContent = token;
        parent.append(element);
      }
      cursor = match.index + token.length;
      continue;
    } else if (token.startsWith('`')) {
      element = document.createElement('code');
      element.textContent = token.slice(1, -1);
    } else if (token.startsWith('****')) {
      element = document.createElement('strong');
      const emphasis = document.createElement('em');
      emphasis.textContent = token.slice(4, -4);
      element.append(emphasis);
    } else if (token.startsWith('***') || token.startsWith('___')) {
      element = document.createElement('strong');
      const emphasis = document.createElement('em');
      emphasis.textContent = token.slice(3, -3);
      element.append(emphasis);
    } else if (token.startsWith('**') || token.startsWith('__')) {
      element = document.createElement('strong');
      element.textContent = token.slice(2, -2);
    } else if (token.startsWith('~~')) {
      element = document.createElement('s');
      element.textContent = token.slice(2, -2);
    } else if (token.startsWith('*') || token.startsWith('_')) {
      element = document.createElement('em');
      element.textContent = token.slice(1, -1);
    } else {
      const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/i);
      element = document.createElement('a');
      element.textContent = link[1];
      element.href = link[2];
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    }
    parent.append(element);
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function richTextBlockStart(line) {
  return /^\s*(```|''')/.test(line)
    || /^\s{0,3}#{1,6}\s+/.test(line)
    || /^\s{0,3}>\s?/.test(line)
    || /^\s{0,3}([-+*]|\d+\.)\s+/.test(line)
    || /^\s{0,3}(?:\*\s*){3,}$/.test(line)
    || /^\s{0,3}(?:-\s*){3,}$/.test(line)
    || /^\s{0,3}(?:_\s*){3,}$/.test(line);
}

function taskDeliberatelyRequestsProtocolTerms() {
  const task = String(currentActiveChatRun()?.task || chatRun?.task || '');
  return /\b(?:json|response schema|tool calls?|protocol)\b/i.test(task);
}

function jsonObjectEnd(source, start) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hideProtocolPayloads(value) {
  const source = String(value || '');
  let output = '';
  let cursor = 0;
  while (cursor < source.length) {
    const start = source.indexOf('{', cursor);
    if (start < 0) { output += source.slice(cursor); break; }
    output += source.slice(cursor, start);
    // Suppress a streamed tool payload from its first partial token. A normal
    // prose object stays untouched; only declared agent-decision keys match.
    if (!/^\{\s*"(?:actions|toolCalls|done)"\s*:/i.test(source.slice(start))) {
      output += '{'; cursor = start + 1; continue;
    }
    const end = jsonObjectEnd(source, start);
    if (end < 0) break;
    cursor = end + 1;
  }
  return output;
}

function userFacingThought(value) {
  let text = hideProtocolPayloads(value);
  if (!taskDeliberatelyRequestsProtocolTerms()) {
    text = text
      .replace(/\bjson(?:-formatted)?\b/gi, 'response')
      .replace(/\b(?:response schema|response format|structured output|structured response|protocol)\b/gi, 'next response')
      .replace(/\btool ?calls?\b/gi, 'next action');
  }
  return stripHarnessMeta(text).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

// The thinking card is a user-facing surface, not a transcript of the model's
// private instructions. A model that narrates the harness's own rules ("the
// harness wants action NOW", "the constraint says ONE tool call per decision")
// is reasoning about its scaffolding, not about the task — and dumping that
// at the user is pure noise that also reads as the agent complaining about
// the harness instead of acting. Drop the meta-talk; keep the task reasoning.
//
// A clause is meta only when it names the scaffolding AND a verb that shows
// the scaffolding acting on the model. "the adb harness passes argv directly"
// is a technical fact and survives; "the harness executes calls in order" is
// the model talking about its own plumbing and goes.
const HARNESS_SCAFFOLD_WORDS = '(?:harness|runtime|system\\s+prompt|orchestrator|scaffolding|flow\\s+control|coordinator)';
const HARNESS_RULE_WORDS = '(?:constraint|constraints|rule|rules|directive|directives|instruction|instructions|policy|gate|notice|notices|recovery|reminder)';
const HARNESS_ACTING_VERBS = '(?:want(?:s|ed)?|need(?:s|ed)?|say(?:s|ing)?|said|demand(?:s|ed)?|require(?:s|d)?|allow(?:s|ed)?|permit(?:s|ted)?|insist(?:s|ed)?|expect(?:s|ed)?|push(?:es|ing)?|pushiness|pushed|tell(?:s|ing)?|told|urge(?:s|d)?|bounce(?:s|d)?|nudge(?:s|d)?|keep(?:s|ing)?|forbid(?:s|ding)?|refuse(?:s|d)?|clip(?:s|ped)?|reject(?:s|ed)?|complain(?:s|ed)?|pressure|chide(?:s|d)?|scream(?:s|ing)?|encourage(?:s|d)?|execute(?:s|d)?|prefer(?:s|red)?|ask(?:s|ed)?|warn(?:s|ed)?|hint(?:s|ed)?|remind(?:s|ed)?|offer(?:s|ed|ing)?|earlier|remedy|remedies|advice|suggests?|advises?|recommends?)';
const HARNESS_META_PATTERNS = [
  // "the harness wants/says/demands ...", "the runtime is screaming for ..."
  new RegExp(`\\b${HARNESS_SCAFFOLD_WORDS}\\b[^.!?\\n]{0,70}?\\b${HARNESS_ACTING_VERBS}\\b[^.!?\\n]{0,130}`, 'gi'),
  // "the constraint(s) say/require ...", "the gate literally offers ..."
  new RegExp(`\\b${HARNESS_RULE_WORDS}\\b[^.!?\\n]{0,55}?\\b(?:${HARNESS_ACTING_VERBS}|one\\s+tool\\s+call|one\\s+action|batch(?:ed)?\\s+calls?|co-emit|co-emitted)\\b[^.!?\\n]{0,130}`, 'gi'),
  // A rule-noun as the SUBJECT of its own sentence: the model is talking
  // about the scaffolding, not the task ("The constraint from the notebook
  // is strong", "The gate explicitly offers ...").
  /\bthe\s+(?:constraint|constraints|gate|notice|runtime\s+notice|harness\s+notice|recovery\s+notice|flow\s+notice|done\s+gate)\b[^.!?\n]{0,150}[.!?]?/gi,
  // "per the harness notice", "the runtime pressure"
  new RegExp(`\\b(?:per|by|under|from)\\s+(?:the\\s+)?(?:${HARNESS_SCAFFOLD_WORDS}|${HARNESS_RULE_WORDS})\\b[^.!?\\n]{0,130}`, 'gi'),
  // "the harness said batch independent calls", "the harness wants X"
  new RegExp(`\\b${HARNESS_SCAFFOLD_WORDS}\\b\\s+(?:said|wants?|needs?|demands?|requires?|allows?|insists?|pushes?|told|tells?|urges?|bounces?|clips?|rejects?|forbids?|refuses?|expects?|prefers?|chides?|screams?|encourages?|asks?|warns?|hints?|reminds?|execute(?:s|d)?|ran|runs|executed|offers?|offered)\\b[^.!?\\n]{0,130}`, 'gi'),
  // A quoted rule attributed to the scaffolding.
  new RegExp(`\\b${HARNESS_SCAFFOLD_WORDS}\\b\\s*["“][^"”\\n]{0,90}["”]`, 'gi'),
  // Quoted rules, whoever is speaking them.
  /["“][^"”\n]{0,70}(?:one\s+tool\s+call\s+per\s+decision|one\s+action\s+per\s+decision|batched\s+calls?\s+get\s+clipped|batch(?:ed)?\s+calls?\s+(?:get\s+|are\s+)?clipped|never\s+batch\s+a\s+submit|multi-call\s+batches\s+may\s+be\s+clipped)[^"”\n]{0,70}["”]/gi,
  // Bare rule phrasings with no subject at all.
  /\bone\s+tool\s+call\s+per\s+decision\b[^.!?\n]{0,80}/gi,
  /\bone\s+action\s+per\s+decision\b[^.!?\n]{0,80}/gi,
  /\bbatch(?:ed)?\s+calls?\s+(?:get\s+|are\s+|may\s+be\s+)?clipped\b[^.!?\n]{0,80}/gi
];

// Clause boundaries: a sentence end, or a connective that starts a new
// thought. Splitting here keeps the task reasoning and drops only the
// meta clause that rode along with it.
const CLAUSE_SPLIT = /(?<=[.!?])\s+|(?:\s*,\s+|\s+)(?:but|though|although|however|yet|so|then|actually|instead|anyway|still)\s+/gi;

function stripHarnessMeta(text) {
  const source = String(text || '');
  if (!source) return source;
  let output = source;
  for (const pattern of HARNESS_META_PATTERNS) output = output.replace(pattern, ' ');
  // Collapse the blank runs the removals leave behind.
  return output.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function renderRichText(value) {
  const fragment = document.createDocumentFragment();
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^\s*(```|''')\s*([^\s]*)\s*$/);
    if (fence) {
      const marker = fence[1];
      const codeLines = [];
      index += 1;
      while (index < lines.length && !new RegExp(`^\\s*${marker}\\s*$`).test(lines[index])) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[2]) code.dataset.language = fence[2].slice(0, 30);
      code.textContent = codeLines.join('\n');
      pre.append(code); fragment.append(pre); continue;
    }
    // Media answers: image-generation and multimodal models reply with
    // markdown images. Render them as the same interactive media cards the
    // composer uses — click opens the preview popup, save writes to Downloads.
    const image = line.match(/^\s{0,3}!\[([^\]]*)\]\((data:image\/(?:png|jpeg|jpg|webp|gif);base64,[^\s)]+|https?:\/\/[^\s)]+)\)\s*$/);
    if (image) {
      const dataUrl = image[2].startsWith('data:') ? image[2] : null;
      const url = dataUrl ? null : image[2];
      const card = buildMediaCard({ kind: 'image', url, dataUrl, filename: mediaFilename('image'), meta: image[1] || '' });
      if (card) fragment.append(card);
      else {
        const picture = document.createElement('img');
        picture.className = 'agent-media-image';
        picture.alt = image[1] || 'generated image';
        picture.src = image[2];
        picture.loading = 'lazy';
        fragment.append(picture);
      }
      index += 1; continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    if (heading) {
      const element = document.createElement(`h${heading[1].length}`);
      appendInlineRichText(element, heading[2]); fragment.append(element); index += 1; continue;
    }
    if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
      fragment.append(document.createElement('hr')); index += 1; continue;
    }
    if (/^\s{0,3}>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      while (index < lines.length) {
        const match = lines[index].match(/^\s{0,3}>\s?(.*)$/);
        if (!match) break;
        if (quote.childNodes.length) quote.append(document.createElement('br'));
        appendInlineRichText(quote, match[1]); index += 1;
      }
      fragment.append(quote); continue;
    }
    const statusRe = /^\s{0,3}(DONE|SKIPPED|FAILED|BLOCKED|PARTIAL)\s*:\s*(.+)$/;
    const isTableRow = (s) => /^\s*\|.*\|\s*$/.test(s || '');
    const isTableSep = (s) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s || '') && String(s).includes('-');
    if (isTableRow(line) && isTableSep(lines[index + 1])) {
      const cells = (s) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const wrap = document.createElement('div');
      wrap.className = 'agent-table-wrap';
      const table = document.createElement('table');
      table.className = 'agent-table';
      const aligns = cells(lines[index + 1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : ''));
      const thead = document.createElement('thead');
      const hr = document.createElement('tr');
      cells(line).forEach((c, i) => { const th = document.createElement('th'); if (aligns[i]) th.style.textAlign = aligns[i]; appendInlineRichText(th, c); hr.append(th); });
      thead.append(hr); table.append(thead);
      const tbody = document.createElement('tbody');
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        const tr = document.createElement('tr');
        cells(lines[index]).forEach((c, i) => { const td = document.createElement('td'); if (aligns[i]) td.style.textAlign = aligns[i]; appendInlineRichText(td, c); tr.append(td); });
        tbody.append(tr); index += 1;
      }
      table.append(tbody); wrap.append(table); fragment.append(wrap); continue;
    }
    if (statusRe.test(line)) {
      const statusStart = index;
      while (index < lines.length && statusRe.test(lines[index])) index += 1;
      let trailIndex = index;
      while (trailIndex < lines.length && /^\s*\|/.test(lines[trailIndex])) trailIndex += 1;
      const proseLines = [];
      while (trailIndex < lines.length && lines[trailIndex].trim() && !/^\s{0,3}([-+*]|\d+\.)\s+/.test(lines[trailIndex]) && !statusRe.test(lines[trailIndex]) && !/^\s*\|/.test(lines[trailIndex])) {
        proseLines.push(lines[trailIndex]); trailIndex += 1;
      }
      if (proseLines.length) {
        const summary = document.createElement('p');
        summary.className = 'agent-done-summary';
        proseLines.forEach((pl, i) => { if (i) summary.append(document.createElement('br')); appendInlineRichText(summary, pl); });
        fragment.append(summary);
      } else {
        const summary = document.createElement('p');
        summary.className = 'agent-done-summary';
        summary.textContent = 'Done.';
        fragment.append(summary);
      }
      index = statusStart;
      const list = document.createElement('ul');
      list.className = 'agent-status-list';
      while (index < lines.length) {
        const sm = lines[index].match(statusRe);
        if (!sm) break;
        const item = document.createElement('li');
        const kind = sm[1].toLowerCase();
        item.className = `agent-status-item is-${kind}`;
        const mark = document.createElement('span');
        mark.className = 'agent-status-mark';
        mark.textContent = kind === 'done' ? '✓' : kind === 'skipped' ? '–' : '✗';
        const body = document.createElement('span');
        body.className = 'agent-status-body';
        const sentences = sm[2].trim().split(/(?<=[.!?])\s+/);
        const title = document.createElement('strong');
        title.textContent = sentences.shift() || '';
        body.append(title);
        if (sentences.length) {
          const rest = document.createElement('span');
          rest.className = 'agent-status-detail';
          rest.textContent = sentences.join(' ');
          body.append(rest);
        }
        item.append(mark, body); list.append(item); index += 1;
      }
      fragment.append(list); continue;
    }
    const listMatch = line.match(/^\s{0,3}([-+*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const itemMatch = lines[index].match(/^\s{0,3}([-+*]|\d+\.)\s+(.+)$/);
        if (!itemMatch || /\d+\./.test(itemMatch[1]) !== ordered) break;
        const item = document.createElement('li');
        appendInlineRichText(item, itemMatch[2]); list.append(item); index += 1;
      }
      fragment.append(list); continue;
    }
    const paragraph = document.createElement('p');
    while (index < lines.length && lines[index].trim() && (index === 0 || !richTextBlockStart(lines[index]) || paragraph.childNodes.length === 0)) {
      if (paragraph.childNodes.length) paragraph.append(document.createElement('br'));
      appendInlineRichText(paragraph, lines[index]); index += 1;
      if (index < lines.length && (richTextBlockStart(lines[index]) || /^\s{0,3}(DONE|SKIPPED|FAILED|BLOCKED|PARTIAL)\s*:/.test(lines[index]))) break;
    }
    fragment.append(paragraph);
  }
  return fragment;
}

function screenshotDataUrl(preview) {
  const data = String(preview?.data || '');
  const mimeType = String(preview?.mimeType || '').toLowerCase();
  if (!data || data.length > 32_000_000 || !['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) return '';
  return `data:${mimeType};base64,${data}`;
}

// LORDE_POPUP_LAYER_V364b — EVERY chat popup mounts inside the .agent-drawer
// element, never on <body>: the browser area is an Electron BrowserView (a
// native layer above all window DOM), so fixed-position popups on <body>
// paint below it. The drawer is position:fixed itself, so it is the
// containing block; because it can scroll, absolutely-positioned overlays get
// their top/size pinned to the visible client area in JS.
function chatDrawerHost() {
  const drawer = document.querySelector('.agent-drawer');
  if (!drawer) return null;
  return {
    drawer,
    pinToVisibleArea(element) {
      element.style.top = `${drawer.scrollTop}px`;
      element.style.left = '0';
      element.style.right = '0';
      element.style.width = 'auto';
      element.style.height = `${drawer.clientHeight}px`;
    }
  };
}

// LORDE_PREVIEW_IN_CHAT_V364 — previews open as a modal INSIDE the current
// window, capped to the current width, so a DOM attachment can never paint
// at natural size across the main window and clip. Esc/backdrop closes.
function openInChatPreviewModal({ title, meta = '', body }) {
  const backdrop = document.createElement('div');
  backdrop.className = 'agent-preview-backdrop';
  const modal = document.createElement('div');
  modal.className = 'agent-preview-modal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-label', title || 'Preview');
  const header = document.createElement('header');
  const heading = document.createElement('div');
  heading.className = 'agent-preview-heading';
  const strong = document.createElement('strong'); strong.textContent = String(title || 'Preview');
  if (meta) { const small = document.createElement('small'); small.textContent = String(meta); heading.append(strong, small); }
  else heading.append(strong);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'agent-preview-close'; close.setAttribute('aria-label', 'Close preview');
  close.append(icon('x'));
  header.append(heading, close);
  const content = document.createElement('div');
  content.className = 'agent-preview-content';
  content.append(body);
  modal.append(header, content);
  backdrop.append(modal);
  const closeModal = () => { window.removeEventListener('keydown', onKey, true); backdrop.remove(); };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); closeModal(); } };
  close.addEventListener('click', closeModal);
  backdrop.addEventListener('pointerdown', (event) => { if (event.target === backdrop) closeModal(); });
  window.addEventListener('keydown', onKey, true);
  const host = chatDrawerHost();
  if (host) {
    host.pinToVisibleArea(backdrop);
    host.drawer.append(backdrop);
  } else {
    document.body.append(backdrop);
  }
  close.focus();
}

function previewDownloadButton(dataUrl, url, filename) {
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'agent-preview-download';
  save.append(icon('download-simple'), document.createTextNode(' Save to Downloads'));
  save.addEventListener('click', () => {
    save.disabled = true;
    window.browserUseDesktop.downloadMedia({ dataUrl, url, filename })
      .then(() => { save.replaceChildren(icon('check'), document.createTextNode(' Saved')); })
      .catch((error) => { save.disabled = false; reportError(error, 'Could not save the file.'); });
  });
  return save;
}

function openScreenshotPreview(preview) {
  const url = screenshotDataUrl(preview);
  if (!url) return;
  const image = document.createElement('img');
  image.src = url;
  image.alt = String(preview.source || 'Captured screenshot');
  openInChatPreviewModal({
    title: 'Screenshot preview',
    meta: String(preview.source || ''),
    body: image
  });
}

async function openReportPreviewInChat(report) {
  let payload;
  try { payload = await window.browserUseDesktop.readReportPreview({ path: report.path }); }
  catch (error) { reportError(error, 'Could not open the report preview.'); return; }
  let body;
  if (payload.format === 'html') {
    body = document.createElement('iframe');
    body.className = 'agent-preview-frame';
    body.setAttribute('sandbox', '');
    body.srcdoc = String(payload.content || '');
  } else {
    body = document.createElement('pre');
    body.className = 'agent-preview-text';
    body.textContent = String(payload.content || '');
  }
  openInChatPreviewModal({ title: payload.filename || 'Report preview', meta: payload.format === 'html' ? 'Formatted HTML report' : 'Formatted text report', body });
}

// ---- Generated media: cards (image/video), WhatsApp-style audio notes ----
// Cards match the screenshot cards: same size, clickable into the preview
// popup, and a save action straight to the Downloads folder.
function saveGeneratedMedia(media, button) {
  const restore = button.innerHTML;
  button.disabled = true;
  window.browserUseDesktop.downloadMedia({ dataUrl: media.dataUrl, url: media.url, filename: media.filename })
    .then(() => {
      button.innerHTML = '';
      button.append(icon('check'));
      setTimeout(() => { button.innerHTML = restore; button.disabled = false; }, 1600);
    })
    .catch((error) => { button.innerHTML = restore; button.disabled = false; reportError(error, 'Could not save the media.'); });
}

function buildMediaCard(media) {
  const source = media.dataUrl || media.url;
  if (!source) return null;
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'agent-screenshot-action agent-media-card';
  card.setAttribute('aria-label', media.kind === 'video' ? 'Open generated video' : 'Open generated image');
  if (media.kind === 'video') {
    const video = document.createElement('video');
    video.className = 'agent-media-thumb';
    video.src = source; video.muted = true; video.preload = 'metadata'; video.playsInline = true;
    card.append(video);
  } else {
    const thumb = document.createElement('img');
    thumb.src = source; thumb.alt = '';
    card.append(thumb);
  }
  const caption = document.createElement('span');
  caption.append(icon(media.kind === 'video' ? 'play-circle' : 'arrows-out-simple'), document.createTextNode(media.kind === 'video' ? ' Open video' : ' Open image'));
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'agent-media-save'; save.title = 'Save to Downloads'; save.setAttribute('aria-label', 'Save media');
  save.append(icon('download-simple'));
  save.addEventListener('click', (event) => { event.stopPropagation(); saveGeneratedMedia(media, save); });
  caption.append(save);
  card.append(caption);
  card.addEventListener('click', () => openGeneratedMedia(media));
  return card;
}

function buildAudioNote(media) {
  const note = document.createElement('div');
  note.className = 'agent-audio-note';
  const play = document.createElement('button');
  play.type = 'button'; play.className = 'agent-audio-play'; play.setAttribute('aria-label', 'Play audio');
  play.append(icon('play'));
  const bars = document.createElement('span'); bars.className = 'agent-audio-bars';
  for (let i = 0; i < 18; i += 1) {
    const bar = document.createElement('i');
    bar.style.setProperty('--h', `${28 + Math.round(Math.abs(Math.sin(i * 1.7)) * 72)}%`);
    bar.style.setProperty('--i', String(i));
    bars.append(bar);
  }
  const time = document.createElement('span'); time.className = 'agent-audio-time'; time.textContent = '0:00';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'agent-media-save'; save.title = 'Save audio'; save.setAttribute('aria-label', 'Save audio');
  save.append(icon('download-simple'));
  note.append(play, bars, time, save);
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  audio.src = media.dataUrl || media.url;
  const fmt = (value) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
  audio.addEventListener('loadedmetadata', () => { time.textContent = fmt(audio.duration || 0); });
  play.addEventListener('click', () => {
    if (audio.paused) audio.play().catch((error) => reportError(error, 'Could not play this audio.'));
    else audio.pause();
  });
  audio.addEventListener('play', () => { play.replaceChildren(icon('pause')); note.classList.add('is-playing'); });
  const stop = () => { play.replaceChildren(icon('play')); note.classList.remove('is-playing'); };
  audio.addEventListener('pause', stop);
  audio.addEventListener('ended', () => { stop(); time.textContent = fmt(audio.duration || 0); });
  audio.addEventListener('timeupdate', () => { time.textContent = fmt(audio.currentTime || 0); });
  save.addEventListener('click', () => saveGeneratedMedia({ ...media, filename: media.filename || 'generated-audio.mp3' }, save));
  return note;
}

function openGeneratedMedia(media) {
  const source = media.dataUrl || media.url || '';
  if (!source) { reportError(new Error('Nothing to preview.'), 'Could not open the media preview.'); return; }
  const kind = String(media.kind || 'image');
  let body;
  if (kind === 'video') {
    body = document.createElement('video');
    body.src = source; body.controls = true; body.playsInline = true; body.className = 'agent-preview-media';
  } else if (kind === 'audio') {
    body = document.createElement('audio');
    body.src = source; body.controls = true; body.className = 'agent-preview-media';
  } else {
    body = document.createElement('img');
    body.src = source; body.alt = String(media.title || 'Generated image'); body.className = 'agent-preview-media';
  }
  const wrap = document.createElement('div');
  wrap.className = 'agent-preview-media-wrap';
  const actions = document.createElement('div');
  actions.className = 'agent-preview-actions';
  actions.append(previewDownloadButton(media.dataUrl || '', media.url || '', media.filename || ''));
  wrap.append(body, actions);
  openInChatPreviewModal({
    title: kind === 'video' ? 'Video preview' : kind === 'audio' ? 'Audio preview' : 'Image preview',
    meta: String(media.filename || ''),
    body: wrap
  });
}

function renderMediaGeneratingCard(labelText) {
  const item = document.createElement('article');
  item.className = 'agent-message is-tool is-media-loading';
  const card = document.createElement('div');
  card.className = 'agent-screenshot-action agent-media-card is-loading';
  const shimmer = document.createElement('div'); shimmer.className = 'agent-media-shimmer';
  const caption = document.createElement('span'); caption.className = 'agent-media-caption';
  const spinner = document.createElement('span'); spinner.className = 'agent-media-spinner'; spinner.append(icon('circle-notch'));
  caption.append(spinner, document.createTextNode(` ${labelText}`));
  card.append(shimmer, caption);
  item.append(card);
  withTranscriptStick(() => chatFeed().append(item));
  return item;
}

function buildMediaMessage(actionText, media, buildCard) {
  const item = document.createElement('article');
  item.className = 'agent-message is-tool is-media';
  const header = document.createElement('header');
  const label = document.createElement('strong'); label.textContent = messageLabel('tool');
  // Generated media is the computer_model output — the robot (AI call) icon.
  const pointer = document.createElement('span'); pointer.className = 'agent-action-pointer'; pointer.append(icon('robot'));
  const actionName = document.createElement('span'); actionName.className = 'agent-action-name'; actionName.textContent = actionText;
  header.replaceChildren(pointer, label, actionName);
  item.append(header);
  const card = buildCard(media);
  if (card) item.append(card);
  return item;
}

function mediaFilename(kind) {
  const extension = { image: 'png', video: 'mp4', audio: 'mp3' }[kind] || 'bin';
  return `generated-${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
}

function openReportPreview(report) {
  if (!report?.path) return;
  window.browserUseDesktop.openReportPreview({ path: report.path }).catch((error) => reportError(error, 'Could not open the report preview.'));
}

function appendMessageHoverActions(item, text) {
  const controls = document.createElement('div'); controls.className = 'agent-message-hover-actions';
  const add = (label, iconName, handler) => {
    const button = document.createElement('button'); button.type = 'button'; button.title = label; button.setAttribute('aria-label', label);
    button.append(icon(iconName));
    button.addEventListener('click', (event) => { event.stopPropagation(); handler(button); });
    controls.append(button);
  };
  add('Helpful', 'thumbs-up', (button) => button.classList.toggle('is-selected'));
  add('Not helpful', 'thumbs-down', (button) => button.classList.toggle('is-selected'));
  add('Copy action', 'copy', (button) => window.browserUseDesktop.copyText(text).then(() => flashCopyIcon(button)).catch(() => {}));
  add('Copy page link', 'link', () => window.browserUseDesktop.copyText(state.active?.url || '').catch(() => {}));
  add('Read aloud', 'speaker-high', () => { if ('speechSynthesis' in window) { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } });
  const time = document.createElement('time'); time.dateTime = new Date().toISOString(); time.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); controls.append(time);
  item.append(controls);
}

// IDE-style diff view for computer_patch results: green added lines numbered
// in the new file, red removed lines numbered in the old file, the way
// Claude Code / Codex CLI show changes. Returns true when a diff was drawn.
function appendPatchDiffView(section, value) {
  // The executor wraps results as { ok, result: { applied, files } }; accept
  // either shape so the diff view never silently falls back to raw JSON.
  const files = Array.isArray(value?.files) ? value.files : Array.isArray(value?.result?.files) ? value.result.files : null;
  if (!Array.isArray(files)) return false;
  const diffFiles = files.filter((file) => Array.isArray(file?.diff) && file.diff.length);
  if (!diffFiles.length) return false;
  for (const file of diffFiles) {
    const label = document.createElement('div');
    label.className = 'patch-diff-path';
    const shortPath = String(file.path || '').split(/[\\/]/).pop() || String(file.path || '');
    label.textContent = file.live
      ? `computer_patch (${shortPath}) (+${file.addedLines || 0}) (−${file.removedLines || 0})`
      : `${file.action === 'add' ? 'Added' : file.action === 'delete' ? 'Deleted' : 'Modified'} ${file.path}  (+${file.addedLines || 0} / −${file.removedLines || 0})`;
    section.append(label);
    for (const chunk of file.diff) {
      for (const line of chunk.lines) {
        const row = document.createElement('div');
        row.className = `patch-line is-${line.kind}`;
        const oldNum = document.createElement('span');
        oldNum.className = 'patch-line-num';
        oldNum.textContent = line.kind === 'add' ? '' : String(line.oldLine ?? '');
        const newNum = document.createElement('span');
        newNum.className = 'patch-line-num';
        newNum.textContent = line.kind === 'del' ? '' : String(line.newLine ?? '');
        const code = document.createElement('span');
        code.className = 'patch-line-code';
        code.textContent = `${line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '} ${line.text}`;
        row.append(oldNum, newNum, code);
        section.append(row);
      }
    }
  }
  return true;
}

// DOM references in a sent user message render as real links, not plain
// text. The visible token is the captured element's stable frontend name
// (for example `exit_btn`), never a generated DOM 1/DOM 2 placeholder.
function renderDomReferenceLinks(body, text, domAttachments) {
  const attachments = domAttachmentApi?.normalizeDomAttachments?.(domAttachments) || [];
  const source = domAttachmentApi?.replaceDomReferences?.(text, attachments) || String(text || '');
  const matches = domAttachmentApi?.findDomReferences?.(source, attachments) || [];
  if (!matches.length) { body.textContent = source; return; }
  let cursor = 0;
  for (const match of matches) {
    if (match.index < cursor) continue;
    if (match.index > cursor) body.append(document.createTextNode(source.slice(cursor, match.index)));
    const attachment = match.attachment;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dom-ref-link';
    chip.textContent = attachment.name;
    chip.title = attachment.selector ? `${attachment.name} — ${attachment.selector}` : `Show the captured element for ${attachment.name}`;
    chip.setAttribute('aria-label', `Show captured element ${attachment.name}`);
    chip.addEventListener('click', (event) => { event.stopPropagation(); openDomAttachmentPreview(attachment); });
    body.append(chip);
    cursor = match.end;
  }
  if (cursor < source.length) body.append(document.createTextNode(source.slice(cursor)));
}

// Click-through preview of a DOM attachment: the same content the agent
// received (selector header + outerHTML), so the stable frontend name is a
// hyperlink to the actual captured item, not a dead label.
function openDomAttachmentPreview(attachment) {
  const existing = document.querySelector('.dom-ref-preview-overlay');
  if (existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.className = 'dom-ref-preview-overlay';
  const panel = document.createElement('div');
  panel.className = 'dom-ref-preview-panel';
  const head = document.createElement('div');
  head.className = 'dom-ref-preview-head';
  const title = document.createElement('strong');
  title.textContent = `${attachment.name || 'DOM'}, captured element`;
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'dom-ref-preview-close';
  close.textContent = '✕';
  close.setAttribute('aria-label', 'Close preview');
  head.append(title, close);
  const pre = document.createElement('pre');
  pre.textContent = String(attachment.text || [
    `Captured element: ${attachment.name || 'selected_element'}`,
    attachment.selector ? `Selector: ${attachment.selector}` : '',
    attachment.pageUrl ? `Page: ${attachment.pageUrl}` : '',
    attachment.previewText ? `Visible text: ${attachment.previewText}` : '',
    '',
    'Markup was intentionally not persisted with chat history.'
  ].filter(Boolean).join('\n'));
  panel.append(head, pre);
  overlay.append(panel);
  const dismiss = () => overlay.remove();
  close.addEventListener('click', dismiss);
  overlay.addEventListener('click', (event) => { if (event.target === overlay) dismiss(); });
  // Mount inside the chat drawer — on <body> it painted below the browser.
  const host = chatDrawerHost();
  if (host) {
    host.pinToVisibleArea(overlay);
    host.drawer.append(overlay);
  } else {
    document.body.append(overlay);
  }
}

// Assistant replies render a bounded rich subset instead of raw text:
// markdown images become the same interactive media cards the composer uses,
// bare URLs become links, and local file paths become copy chips. Everything
// else stays plain text (no HTML injection — every node is built, not parsed).
const URL_TEXT = /^https?:\/\/[^\s"'<>)]+$/i;
const FILE_PATH_TEXT = /^(?:[A-Za-z]:[\\/][^\s"<>]+|\/(?:Users|home|mnt|opt|var|etc|tmp)\/[^\s"<>]+)$/;
function appendRichAssistantText(target, text) {
  const tokens = String(text || '').split(/(\s+)/);
  for (const token of tokens) {
    const value = token.trim();
    if (!token) continue;
    if (/^\s+$/.test(token)) { target.append(document.createTextNode(token)); continue; }
    if (URL_TEXT.test(value)) {
      const link = document.createElement('a');
      link.href = value; link.textContent = value.length > 84 ? `${value.slice(0, 81)}…` : value;
      link.target = '_blank'; link.rel = 'noreferrer noopener';
      target.append(link);
      continue;
    }
    if (FILE_PATH_TEXT.test(value)) {
      const chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'agent-file-chip';
      chip.title = 'Copy path';
      chip.append(icon('copy'), document.createTextNode(value.length > 60 ? `${value.slice(0, 57)}…` : value));
      chip.addEventListener('click', () => {
        window.browserUseDesktop.copyText(value).then(() => flashCopyIcon(chip)).catch((error) => reportError(error, 'Could not copy the path.'));
      });
      target.append(chip);
      continue;
    }
    target.append(document.createTextNode(token));
  }
}
function appendRichAssistantContent(target, text) {
  // Markdown images: ![alt](url) — rendered as interactive media cards.
  const imagePattern = /!\[[^\]]*\]\((https?:\/\/[^)\s]+|data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+)\)/gi;
  let cursor = 0;
  let match;
  while ((match = imagePattern.exec(String(text || ''))) !== null) {
    if (match.index > cursor) appendRichAssistantText(target, String(text).slice(cursor, match.index));
    const card = buildMediaCard({ kind: 'image', url: match[1].startsWith('data:') ? null : match[1], dataUrl: match[1].startsWith('data:') ? match[1] : null, filename: mediaFilename('image') });
    if (card) { const wrap = document.createElement('div'); wrap.className = 'agent-message-media'; wrap.append(card); target.append(wrap); }
    cursor = match.index + match[0].length;
  }
  if (cursor < String(text || '').length) appendRichAssistantText(target, String(text).slice(cursor));
}

// ---- ask_user custom card rendering (run.txt 2026-10-29) -----------------
// The model may design a rich question card (tables, SVG flowcharts, icons,
// images). HTML is sanitized to prevent XSS; CSS is scoped to the card and
// inherits theme variables so the card obeys the app theme.

const ASK_SAFE_TAGS = new Set(['div','span','p','h1','h2','h3','h4','h5','h6','img','svg','path','circle','rect','line','polyline','polygon','text','g','defs','marker','table','thead','tbody','tfoot','tr','th','td','ul','ol','li','strong','em','b','i','u','code','pre','br','hr','button','input','select','option','details','summary','a','section','article','header','footer','nav','aside','figure','figcaption','dl','dt','dd','blockquote','mark','small','sub','sup','time','abbr','address','label','fieldset','legend','textarea','progress','meter']);
const ASK_SAFE_ATTRS = new Set(['class','id','title','alt','src','href','width','height','x','y','cx','cy','r','d','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin','transform','viewBox','xmlns','points','rx','ry','x1','y1','x2','y2','offset','stop-color','stop-opacity','type','value','min','max','step','disabled','checked','selected','placeholder','colspan','rowspan','scope','lang','dir','style']);
const ASK_URL_ATTRS = new Set(['src','href']);
function sanitizeAskHtml(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  for (const sel of ['script','iframe','object','embed','link','meta','form','frame','frameset','applet']) {
    tpl.content.querySelectorAll(sel).forEach((el) => el.remove());
  }
  const walker = document.createTreeWalker(tpl.content, NodeFilter.SHOW_ELEMENT);
  const toStrip = [];
  while (walker.nextNode()) {
    const el = walker.currentNode;
    const tag = el.tagName.toLowerCase();
    if (!ASK_SAFE_TAGS.has(tag)) { toStrip.push(el); continue; }
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = String(attr.value || '');
      if (!ASK_SAFE_ATTRS.has(name) || /^on/i.test(name) || /javascript:/i.test(val)) {
        el.removeAttribute(attr.name);
      } else if (ASK_URL_ATTRS.has(name) && !/^(https?:|data:image\/|\/)/i.test(val)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  for (const el of toStrip) {
    const frag = document.createDocumentFragment();
    while (el.firstChild) frag.append(el.firstChild);
    el.replaceWith(frag);
  }
  return tpl.content;
}

let askCardSeq = 0;
function renderAskUserCard(result) {
  askCardSeq += 1;
  const cardClass = "ask-card-" + askCardSeq;
  const wrap = document.createElement("div");
  wrap.className = "agent-ask-card " + cardClass;
  if (result.css) {
    const style = document.createElement("style");
    const scoped = String(result.css).replace(/(^|})\s*([^@{]+?)\s*{/g, function (match, brace, selector) {
      if (/^(?:from|to|[0-9]+%|\d+\.?\d*(?:s|ms)?)$/.test(selector.trim())) return match;
      const scopedSel = selector.split(",").map(function (s) {
        const trimmed = s.trim();
        return trimmed.startsWith("@") ? trimmed : "." + cardClass + " " + trimmed;
      }).join(", ");
      return brace + " " + scopedSel + " {";
    });
    style.textContent = scoped;
    wrap.append(style);
  }
  if (result.html) {
    const body = document.createElement("div");
    body.className = "agent-ask-html";
    body.append(sanitizeAskHtml(result.html));
    wrap.append(body);
  } else {
    const q = document.createElement("p");
    q.className = "agent-ask-question";
    q.textContent = result.question || "";
    wrap.append(q);
    if (result.options) {
      const opts = document.createElement("ul");
      opts.className = "agent-ask-options";
      for (const o of parseAskOptions(result.options)) { const li = document.createElement("li"); li.textContent = o; opts.append(li); }
      wrap.append(opts);
    }
    if (result.context) {
      const ctx = document.createElement("p");
      ctx.className = "agent-ask-context";
      ctx.textContent = result.context;
      wrap.append(ctx);
    }
  }
  return wrap;
}

// ---- ask_user live question ------------------------------------------------
// The run publishes user.input.required BEFORE it waits, so the question and
// its options are visible while the run is paused. Options become buttons;
// typing in the composer answers too (see answerPendingQuestion callers).
const pendingQuestionCards = new Map(); // runId -> article

function parseAskOptions(raw) {
  if (Array.isArray(raw)) return raw.map((o) => String(o).trim()).filter(Boolean).slice(0, 8);
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try { const arr = JSON.parse(text); if (Array.isArray(arr)) return arr.map((o) => String(o).trim()).filter(Boolean).slice(0, 8); } catch (_) { /* fall through */ }
  }
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const pieces = lines.length > 1 ? lines : text.split(/\s+(?=\d+[.)]\s)/).map((piece) => piece.trim()).filter(Boolean);
  return pieces
    .map((piece) => piece.replace(/^(?:[-*•]|\d+[.)]|[A-Za-z][.)])\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 8);
}

function answerPendingQuestion(runId, text) {
  const reply = String(text || '').trim();
  if (!runId || !reply) return Promise.resolve();
  return window.browserUseDesktop.agentSteer({ runId, text: reply })
    .catch((error) => { reportError(error, 'Could not send your answer.'); throw error; });
}

function renderPendingQuestion(event) {
  const runId = String(event.run?.id || chatRun?.id || '');
  const asked = event.card || event.question || {};
  const questions = (asked.questions || event.questions || []).map((question) => typeof question === 'string' ? { question } : question).filter((question) => question?.question);
  if (!questions.length) questions.push({ ...asked, question: asked.question || event.question?.question || '' });
  let current = 0;
  const answers = questions.map(() => '');
  const card = renderAskUserCard({ ...questions[0], options: questions[0].options || asked.options });
  const item = document.createElement('article');
  item.className = 'agent-message is-tool is-ask';
  const header = document.createElement('header');
  const label = document.createElement('strong'); label.textContent = 'Question';
  const pointer = document.createElement('span'); pointer.className = 'agent-action-pointer'; pointer.append(icon('question'));
  const actionName = document.createElement('span'); actionName.className = 'agent-action-name'; actionName.textContent = 'needs your answer';
  header.replaceChildren(pointer, label, actionName);
  item.append(header, card);
  const choicesWrap = document.createElement('div');
  choicesWrap.className = 'agent-ask-choices';
  item.append(choicesWrap);
  const hint = document.createElement('small');
  hint.className = 'agent-ask-hint';
  hint.textContent = parseAskOptions(questions[0].options || asked.options || event.question?.options).length ? 'Pick an option or type your own answer.' : 'Type your answer.';
  const form = document.createElement('form');
  form.className = 'agent-ask-form';
  const field = document.createElement('textarea');
  field.className = 'agent-ask-input'; field.placeholder = 'Type your own answer...'; field.rows = 2;
  field.addEventListener('input', () => { field.style.height = 'auto'; field.style.height = `${Math.min(field.scrollHeight, 78)}px`; });
  field.addEventListener('keydown', (keyEvent) => { if (keyEvent.key === 'Enter' && !keyEvent.shiftKey) { keyEvent.preventDefault(); form.requestSubmit(); } });
  const send = document.createElement('button');
  send.type = 'submit'; send.className = 'agent-ask-send'; send.setAttribute('aria-label', 'Send');
  send.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  form.append(field, send);
  const nav = document.createElement('div');
  nav.className = 'agent-ask-nav';
  const previous = document.createElement('button');
  previous.type = 'button'; previous.textContent = 'Previous';
  const progress = document.createElement('span'); progress.className = 'agent-ask-progress';
  const next = document.createElement('button');
  next.type = 'button';
  nav.append(previous, progress, next);
  const renderStep = () => {
    const question = questions[current];
    card.replaceWith(renderAskUserCard({ ...question, options: question.options || asked.options }));
    field.value = answers[current];
    choicesWrap.replaceChildren();
    const choices = parseAskOptions(question.options || asked.options || event.question?.options);
    choices.forEach((choice) => {
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'agent-ask-choice'; button.textContent = choice;
      button.addEventListener('click', () => { field.value = choice; field.focus(); });
      choicesWrap.append(button);
    });
    previous.disabled = current === 0;
    next.hidden = current === questions.length - 1;
    progress.textContent = `Question ${current + 1} of ${questions.length}`;
  };
  previous.addEventListener('click', () => { answers[current] = field.value.trim(); current -= 1; renderStep(); });
  next.addEventListener('click', () => { if (!field.value.trim()) return; answers[current] = field.value.trim(); current += 1; renderStep(); });
  form.addEventListener('submit', (submitEvent) => {
    submitEvent.preventDefault();
    const value = field.value.trim();
    if (!value) return;
    answers[current] = value;
    field.disabled = true; send.disabled = true; previous.disabled = true; next.disabled = true;
    const summary = questions.map((question, index) => `Q${index + 1} "${question.question}" — user answered "${answers[index] || '(no answer)'}"`).join('\n');
    void answerPendingQuestion(runId, summary).catch(() => { field.disabled = false; send.disabled = false; });
  });
  item.append(hint, form, nav);
  renderStep();
  pendingQuestionCards.set(runId, item);
  withTranscriptStick(() => chatFeed().append(item));
  const feedEl = chatFeed(); requestAnimationFrame(() => { feedEl.scrollTop = feedEl.scrollHeight; item.scrollIntoView({ block: 'end' }); });
  agentTask?.focus();
}

function settlePendingQuestion(event) {
  const runId = String(event.run?.id || chatRun?.id || '');
  const item = pendingQuestionCards.get(runId);
  pendingQuestionCards.delete(runId);
  if (!item?.isConnected) return;
  for (const button of item.querySelectorAll('button')) button.disabled = true;
  item.classList.add('is-answered');
  item.querySelector('.agent-ask-hint')?.remove();
  const answer = String(event.reply || '').trim();
  if (answer) renderChatMessage('user', answer);
}

// LORDE_MSG_PILL_V1 — in-place editing for a previously sent user message.
// Saving rewrites the bubble, stamps an "Edited" tag, and — when an agent run
// is active — steers the run with an explicit notice so the model knows the
// user revised that message and which version is authoritative.
function applyEditedTag(item) {
  if (!item || item.querySelector('.agent-message-edited-tag')) return;
  const tag = document.createElement('span');
  tag.className = 'agent-message-edited-tag';
  tag.textContent = 'Edited';
  const header = item.querySelector(':scope > header');
  if (header) header.append(tag);
  else item.append(tag);
}

function notifyAgentOfEdit(originalText, editedText) {
  const activeRun = currentActiveChatRun();
  if (!activeRun?.id || !['running', 'awaiting_approval', 'paused'].includes(activeRun.status)) return;
  const notice = '[User edited an earlier message] The user revised a message they sent earlier in this conversation. Treat the EDITED version below as authoritative wherever it applies.\n'
    + `Original: ${String(originalText || '').slice(0, 400)}\n`
    + `Edited: ${String(editedText || '').slice(0, 2000)}`;
  window.browserUseDesktop.agentSteer({ runId: activeRun.id, text: notice, attachments: [], domAttachments: [] })
    .then(() => showToast('The agent will see your edit at its next thinking turn.'))
    .catch(() => { /* the run may have ended between edit and save */ });
}

function startMessageEdit(item, body, originalText, options = {}) {
  if (!item || item.querySelector('.agent-msg-editor')) return;
  const domAttachments = domAttachmentApi?.normalizeDomAttachments?.(options.domAttachments || []) || [];
  const editor = document.createElement('div');
  editor.className = 'agent-msg-editor';
  const input = document.createElement('textarea');
  input.className = 'agent-msg-editor-input';
  input.value = String(item.dataset.editedText || originalText || '');
  input.rows = Math.min(10, Math.max(2, input.value.split('\n').length));
  const actions = document.createElement('div');
  actions.className = 'agent-msg-editor-actions';
  const save = document.createElement('button'); save.type = 'button'; save.className = 'agent-msg-editor-save'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'agent-msg-editor-cancel'; cancel.textContent = 'Cancel';
  actions.append(save, cancel);
  editor.append(input, actions);
  body.hidden = true;
  item.insertBefore(editor, body.nextSibling);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  const finish = (commit) => {
    const next = input.value.trim();
    const before = String(item.dataset.editedText || originalText || '');
    if (commit && next && next !== before) {
      item.dataset.editedText = next;
      item.dataset.isEdited = '1';
      if (domAttachments.length) renderDomReferenceLinks(body, next, domAttachments);
      else body.textContent = next;
      applyEditedTag(item);
      notifyAgentOfEdit(originalText || '', next);
    }
    editor.remove();
    body.hidden = false;
  };
  save.addEventListener('click', (event) => { event.stopPropagation(); finish(true); });
  cancel.addEventListener('click', (event) => { event.stopPropagation(); finish(false); });
  input.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); finish(true); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
}

function renderChatMessage(kind, text, detail = '', inspection = null, options = {}) {
  // "Action needs adjustment" cards are suppressed before they are ever attached, so they cannot paint.
  if (kind === 'error') { const ghost = document.createElement('article'); ghost.hidden = true; ghost.className = 'agent-message is-error'; return ghost; }
  const item = document.createElement('article'); item.className = `agent-message is-${kind}`;
  const header = document.createElement('header');
  if (kind === 'tool') {
    const askResult = options.output?.result || options.output;
    if (text === 'ask_user' && askResult?.asked && (askResult.html || askResult.css)) {
      const label = document.createElement('strong'); label.textContent = messageLabel(kind);
      const pointer = document.createElement('span'); pointer.className = 'agent-action-pointer'; pointer.append(icon(toolIcon(text)));
      const actionName = document.createElement('span'); actionName.className = 'agent-action-name'; actionName.textContent = 'question';
      header.replaceChildren(pointer, label, actionName);
      item.append(header);
      item.classList.add('is-ask');
      item.append(renderAskUserCard(askResult));
      withTranscriptStick(() => chatFeed().append(item));
      return item;
    }
    const label = document.createElement('strong'); label.textContent = messageLabel(kind);
    const pointer = document.createElement('span'); pointer.className = 'agent-action-pointer'; pointer.append(icon(toolIcon(text)));
    const actionName = document.createElement('span'); actionName.className = 'agent-action-name'; actionName.textContent = text;
    header.replaceChildren(pointer, label, actionName);
    // computer_* file tools name the file or folder they touched next to the
    // tool name; hovering reveals the full directory.
    const target = toolTargetApi?.describeToolTarget(text, inspection?.input, options.targetOutput ?? inspection?.output);
    if (target) {
      const targetLabel = document.createElement('span');
      targetLabel.className = `agent-action-target is-${target.kind}`;
      targetLabel.title = target.full;
      targetLabel.dataset.fullPath = target.full;
      if (target.kind !== 'unknown') targetLabel.append(icon(target.kind === 'folder' ? 'folder-simple' : 'file'));
      targetLabel.append(document.createTextNode(target.name));
      actionName.append(targetLabel);
      actionName.title = `${text} — ${target.full}`;
    }
    item.append(header);
    appendMessageHoverActions(item, text);
    const screenshotUrl = screenshotDataUrl(options.screenshotPreview);
    if (screenshotUrl) {
      item.classList.add('is-screenshot');
      const previewButton = document.createElement('button');
      previewButton.type = 'button'; previewButton.className = 'agent-screenshot-action';
      previewButton.setAttribute('aria-label', 'Open captured screenshot');
      const thumbnail = document.createElement('img'); thumbnail.src = screenshotUrl; thumbnail.alt = '';
      const caption = document.createElement('span'); caption.append(icon('arrows-out-simple'), document.createTextNode(' Open screenshot'));
      previewButton.append(thumbnail, caption);
      previewButton.addEventListener('click', (event) => { event.stopPropagation(); openScreenshotPreview(options.screenshotPreview); });
      item.append(previewButton);
    }
    if (options.reportPreview?.path) {
      const reportButton = document.createElement('button');
      reportButton.type = 'button'; reportButton.className = 'agent-report-action';
      reportButton.setAttribute('aria-label', `Open ${options.reportPreview.filename || 'saved report'}`);
      reportButton.append(
        icon(options.reportPreview.format === 'html' ? 'file-html' : 'file-text'),
        document.createTextNode(options.reportPreview.filename || 'Open saved report')
      );
      reportButton.addEventListener('click', (event) => { event.stopPropagation(); openReportPreviewInChat(options.reportPreview); });
      item.append(reportButton);
    }
    // Written/edited files surface as a copyable path chip — the agent can
    // hand the user files without the path hiding inside collapsed inspection.
    const writtenPath = options.output?.path || options.output?.result?.path;
    if (typeof writtenPath === 'string' && writtenPath && options.output?.ok !== false) {
      const chip = document.createElement('button');
      chip.type = 'button'; chip.className = 'agent-file-chip';
      chip.title = 'Copy file path';
      chip.append(icon('file'), document.createTextNode(writtenPath.length > 64 ? `${writtenPath.slice(0, 61)}…` : writtenPath));
      chip.addEventListener('click', (event) => {
        event.stopPropagation();
        window.browserUseDesktop.copyText(writtenPath).then(() => flashCopyIcon(chip)).catch((error) => reportError(error, 'Could not copy the path.'));
      });
      item.append(chip);
    }
    if (inspection) {
      const details = document.createElement('section'); details.className = 'agent-inspection'; details.hidden = true;
      for (const [labelText, value] of [['Input', inspection.input], ['Output', inspection.output]]) {
        const head = document.createElement('div'); head.className = 'agent-inspection-head';
        const sectionLabel = document.createElement('strong'); sectionLabel.textContent = labelText;
        const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'agent-inspection-copy'; copy.title = 'Copy diagnostics'; copy.setAttribute('aria-label', 'Copy diagnostics'); copy.append(icon('copy'));
        const output = diagnosticText(value);
        copy.addEventListener('click', (event) => { event.stopPropagation(); window.browserUseDesktop.copyText(output).then(() => flashCopyIcon(copy)).catch((error) => reportError(error, 'Could not copy diagnostics.')); });
        const pre = document.createElement('pre'); pre.textContent = output;
        head.append(sectionLabel, copy); details.append(head, pre);
        if (labelText === 'Output' && appendPatchDiffView(details, value)) pre.hidden = true;
      }
      item.append(details);
      item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-expanded', 'false');
      const toggle = () => { const open = item.getAttribute('aria-expanded') !== 'true'; item.setAttribute('aria-expanded', String(open)); details.hidden = !open; };
      item.addEventListener('click', (event) => { if (!event.target.closest('button')) toggle(); });
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    }
    // LORDE_SUBAGENT_TABS_V366 — leaf renderers append through chatFeed() so a
    // subagent tab's feed host receives the card instead of the hidden main
    // transcript (chatFeed() === agentTranscript on the Main tab).
    withTranscriptStick(() => chatFeed().append(item));
    return item;
  }
  const label = document.createElement('strong'); label.textContent = messageLabel(kind);
  // A badge names WHO produced a card that is not the main agent speaking:
  // a subagent's findings, a research brief. Without it those cards are
  // indistinguishable from the agent's own voice in the transcript. The badge
  // REPLACES the generic label rather than sitting beside it, so the header
  // reads as one producer name instead of "Agent message · research".
  if (options.badge) {
    const badge = document.createElement('span');
    badge.className = 'agent-message-badge';
    badge.textContent = String(options.badge).slice(0, 40);
    label.textContent = '';
    label.append(badge);
    // A badged card always shows its header. The generic "You"/"Thought"
    // labels are hidden by CSS, and without the header the badge — the only
    // thing that says who wrote this — would be invisible.
    item.classList.add('has-badge');
  }
  const controls = document.createElement('span'); controls.className = 'agent-message-controls';
  // Copying a user message preserves the stable frontend element name and
  // expands it with the selector. Legacy persisted DOM N tokens are upgraded
  // at the UI boundary, so the clipboard never reintroduces a placeholder.
  const copyText = (() => {
    const domAttachments = domAttachmentApi?.normalizeDomAttachments?.(options.domAttachments || []) || [];
    if (kind !== 'user' || !domAttachments.length) return text;
    let value = domAttachmentApi?.replaceDomReferences?.(text, domAttachments) || text;
    for (const attachment of domAttachments) {
      if (!attachment.selector) continue;
      const escaped = attachment.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      value = value.replace(new RegExp(`\\b${escaped}\\b`, 'g'), `${attachment.name} (${attachment.selector})`);
    }
    return value;
  })();
  if (kind === 'user') {
    // LORDE_MSG_PILL_V1 — user bubbles hide their header, so the hover
    // affordance is a pill on the bubble with Copy / Resend / Edit. Resend
    // submits the (edited) text through the composer pipeline; Edit swaps the
    // bubble into an in-place editor and tags the card "Edited" so the agent
    // is told the user revised that message.
    const effectiveText = () => String(item.dataset.editedText || copyText);
    const pill = document.createElement('span');
    pill.className = 'agent-msg-pill';
    const pillButton = (iconName, title) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'agent-msg-pill-btn';
      button.title = title;
      button.setAttribute('aria-label', title);
      button.append(icon(iconName));
      return button;
    };
    const pillCopy = pillButton('copy', 'Copy message');
    pillCopy.addEventListener('click', (event) => { event.stopPropagation(); window.browserUseDesktop.copyText(effectiveText()).then(() => flashCopyIcon(pillCopy)).catch(() => {}); });
    const pillResend = pillButton('arrow-clockwise', 'Resend this message');
    pillResend.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!agentTask || !agentForm) return;
      agentTask.value = effectiveText();
      agentForm.requestSubmit();
    });
    const pillEdit = pillButton('pencil-simple', 'Edit message');
    pillEdit.addEventListener('click', (event) => {
      event.stopPropagation();
      startMessageEdit(item, body, copyText, options);
    });
    pill.append(pillCopy, pillResend, pillEdit);
    item.classList.add('has-hover-copy');
    item.append(pill);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'agent-message-copy'; copy.title = 'Copy message'; copy.setAttribute('aria-label', 'Copy message'); copy.append(icon('copy'));
    copy.addEventListener('click', (event) => { event.stopPropagation(); window.browserUseDesktop.copyText(effectiveText()).then(() => flashCopyIcon(copy)).catch(() => {}); });
    controls.append(copy);
  }
  const expandable = Boolean(inspection || options.expandable);
  if (expandable) { const chevron = document.createElement('span'); chevron.className = 'agent-chevron'; chevron.append(icon('caret-right')); controls.append(chevron); }
  header.append(label, controls);
  const body = document.createElement('p');
  if (kind === 'user' && (options.domAttachments || []).length) {
    renderDomReferenceLinks(body, text, options.domAttachments);
  } else if ((kind === 'assistant' || kind === 'system') && text) {
    // Every assistant reply renders through the markdown renderer. The old gate
    // only matched images, **bold** and #-headings, so replies that used "- "
    // bullets, `code`, > quotes, numbered lists or *italics* showed raw
    // markdown characters. Plain prose still comes out as a single paragraph.
    body.classList.add('is-rich');
    body.replaceChildren(renderRichText(text));
  } else {
    body.textContent = text;
  }
  item.append(header, body);
  if (detail) { const code = document.createElement('code'); code.textContent = detail; item.append(code); }
  let details = null;
  if (inspection) {
    details = document.createElement('section'); details.className = 'agent-inspection'; details.hidden = true;
    for (const [labelText, value] of [['Input', inspection.input], ['Output', inspection.output]]) {
      const head = document.createElement('div'); head.className = 'agent-inspection-head';
      const sectionLabel = document.createElement('strong'); sectionLabel.textContent = labelText;
      const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'agent-inspection-copy'; copy.title = 'Copy diagnostics'; copy.setAttribute('aria-label', 'Copy diagnostics'); copy.append(icon('copy'));
      const output = diagnosticText(value);
      copy.addEventListener('click', (event) => { event.stopPropagation(); window.browserUseDesktop.copyText(output).then(() => flashCopyIcon(copy)).catch((error) => reportError(error, 'Could not copy diagnostics.')); });
      const pre = document.createElement('pre'); pre.textContent = output;
      head.append(sectionLabel, copy); details.append(head, pre);
      if (labelText === 'Output' && appendPatchDiffView(details, value)) pre.hidden = true;
    }
    item.append(details);
  }
  if (expandable) {
    item.tabIndex = 0; item.setAttribute('role', 'button'); item.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const open = item.getAttribute('aria-expanded') !== 'true';
      item.setAttribute('aria-expanded', String(open));
      if (details) details.hidden = !open;
      if (options.collapseBody) body.hidden = !open;
      item.querySelector('.agent-chevron')?.classList.toggle('is-open', open);
    };
    if (options.collapseBody) body.hidden = true;
    item.addEventListener('click', (event) => { if (!event.target.closest('button')) toggle(); });
    item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
  }
  withTranscriptStick(() => chatFeed().append(item));
  return item;
}

function positionAgentPlan() {
  // The progress strip is a normal flex child of the drawer now: the chat
  // area (transcript, flex:1) shrinks to make room for the pills instead of
  // them floating over the conversation. Nothing to compute here anymore.
}

const agentProgressStrip = document.querySelector('#agent-progress-strip');
const agentGoal = document.querySelector('#agent-goal');
let allowInitialChatSnapshot = true;
let chatSelectionRevision = 0;
function patchProgressList(container, items, running) {
  const existing = new Map([...container.children].map(row => [row.dataset.id, row]));
  items.forEach((item, index) => {
    const id = String(item.id || `${index}:${item.text}`);
    let row = existing.get(id);
    if (!row) {
      row = document.createElement('div'); row.dataset.id = id;
      const state = document.createElement('span'); state.className = 'agent-plan-state';
      const text = document.createElement('span'); text.className = 'agent-plan-text'; row.append(state, text);
    }
    existing.delete(id);
    const status = ['pending','current','done','skipped'].includes(item.status) ? item.status : 'pending';
    const className = `agent-plan-row is-${status}`;
    if (row.className !== className) row.className = className;
    row.dataset.running = String(running && status === 'current');
    row.setAttribute('aria-label', `${item.text}: ${status}${status === 'current' && !running ? ' (not running)' : ''}`);
    const glyph = status === 'done' ? '✓' : status === 'skipped' ? '−' : status === 'current' ? '' : '○';
    if (row.firstChild.textContent !== glyph) row.firstChild.textContent = glyph;
    if (row.lastChild.textContent !== item.text) row.lastChild.textContent = item.text || '';
    if (container.children[index] !== row) container.insertBefore(row, container.children[index] || null);
  });
  for (const row of existing.values()) row.remove();
}
function renderProgressSurface(surface, prefix, items, status, label) {
  if (!surface) return;
  const list = document.querySelector(`#${prefix}-list`), toggle = document.querySelector(`#${prefix}-toggle`);
  // The pill closes once its plan/goal is achieved, every item done or
  // skipped. A new plan (fresh pending/current item) reopens it.
  const achieved = Array.isArray(items) && items.length > 0 && items.every(item => item.status === 'done' || item.status === 'skipped');
  if (!Array.isArray(items) || !items.length || achieved) { surface.hidden = true; list.hidden = true; toggle.setAttribute('aria-expanded','false'); return; }
  surface.hidden = false;
  const current = items.filter(item => item.status === 'current'), done = items.filter(item => item.status === 'done').length;
  const running = status === 'running' && current.length > 0;
  surface.dataset.running = String(running);
  document.querySelector(`#${prefix}-title`).textContent = (label ? `${label}: ` : '') + (current[0] || items.find(item => item.status === 'pending') || items.at(-1)).text;
  const count = document.querySelector(`#${prefix}-count`); count.textContent = `${done}/${items.length}`; count.title = `${done} completed; ${current.length} current`;
  patchProgressList(list, items, running);
}
function renderPlan(plan = [], status = chatRun?.status) {
  renderProgressSurface(agentPlan, 'agent-plan', plan, status, ''); positionAgentPlan();
}
function renderGoals(goals = [], status = chatRun?.status) {
  renderProgressSurface(agentGoal, 'agent-goal', goals, status, 'Goal'); positionAgentPlan();
}
// The pen icon on the goal pill opens a one-goal-per-line editor. Saving
// rewrites the visible goals immediately; for an active run the edit is also
// delivered to the agent at its next model boundary, so it never keeps
// working toward goals the user already replaced. Closed pill: the pen shows
// on hover at the pill's right edge with a white circle on its own hover.
// Open pill: it sits always-visible at the pill's bottom-right corner.
function setGoalOpen(open) {
  agentGoalSurface?.classList.toggle('is-open', open);
}
const agentGoalSurface = document.querySelector('#agent-goal');
function closeGoalEditor() {
  agentGoalEditor.hidden = true;
  document.querySelector('#agent-goal-list').hidden = false;
  agentGoalEdit.hidden = false;
  setGoalOpen(false);
}
agentGoalEdit?.addEventListener('click', () => {
  const goals = Array.isArray(chatRun?.goals) ? chatRun.goals : [];
  agentGoalTextarea.value = goals.map((item) => item.text || '').join('\n');
  document.querySelector('#agent-goal-list').hidden = true;
  agentGoalEdit.hidden = true;
  agentGoalEditor.hidden = false;
  agentGoalTextarea.focus();
});
agentGoalCancel?.addEventListener('click', closeGoalEditor);
agentGoalSave?.addEventListener('click', () => { void (async () => {
  const lines = agentGoalTextarea.value.split('\n').map((line) => line.trim()).filter(Boolean);
  if (!lines.length) { closeGoalEditor(); return; }
  const current = Array.isArray(chatRun?.goals) ? chatRun.goals : [];
  // Unchanged goal texts keep their status; new lines start pending.
  const goals = lines.map((text) => current.find((item) => item.text === text) || { text, status: 'pending' });
  if (chatRun) chatRun.goals = goals;
  renderGoals(goals, chatRun?.status);
  closeGoalEditor();
  const activeRun = currentActiveChatRun();
  if (!activeRun?.id) return;
  try {
    await window.browserUseDesktop.agentSteer({ runId: activeRun.id, goals });
    showToast('Goals updated, the agent adopts them at its next thinking turn.');
  } catch (error) {
    reportError(error, 'Could not send the edited goals to the agent.');
  }
})(); });
document.querySelector('#agent-goal-toggle')?.addEventListener('click', () => {
  const list = document.querySelector('#agent-goal-list'); list.hidden = !list.hidden;
  document.querySelector('#agent-goal-toggle').setAttribute('aria-expanded', String(!list.hidden));
  setGoalOpen(!list.hidden);
});

// The agent loop is a text/tool-call conversation: it sends chat messages and
// parses text decisions + tool calls. Image-generation, TTS/STT, video, and
// embedding models cannot serve that loop — no rendering of generated images,
// no audio pipeline, no video playback. Selection is allowed (a gateway may
// proxy a multimodal chat variant) but the picker says so plainly.
function nonChatModelReason(modelId = '') {
  const id = String(modelId || '').toLowerCase();
  if (/(?:^|\/)gpt-image|dall-e|image-gen|stable-?diffusion|sora|midjourney|flux-/.test(id)) return 'image generation';
  if (/whisper|tts|stt|audio-|speech/.test(id)) return 'audio (TTS/STT)';
  if (/video|sora/.test(id)) return 'video generation';
  if (/embed|rerank/.test(id)) return 'embeddings';
  return null;
}

// The stored kind of a model on the active connection: user-tagged custom
// models win; everything else is inferred from the id. 'language' is the
// default for anything untagged.
function storedModelKind(modelId = '') {
  const id = String(modelId || '').trim();
  const catalogKey = (activeConnection() || (publicSettings.aiConnections || []).find((item) => item.id === publicSettings.aiChatConnectionId))?.id || `draft:${activeChatProvider()}`;
  const taggedKind = (providerModelKinds[catalogKey] || {})[id];
  if (taggedKind) return taggedKind;
  const connection = activeConnection() || (publicSettings.aiConnections || []).find((item) => item.id === publicSettings.aiChatConnectionId);
  const entries = Array.isArray(connection?.customModels) ? connection.customModels : [];
  const tagged = entries.find((entry) => (entry && typeof entry === 'object' ? entry.id : entry) === id);
  if (tagged && typeof tagged === 'object' && tagged.kind) return tagged.kind;
  const reason = nonChatModelReason(id);
  if (reason === 'image generation') return 'image';
  if (reason === 'video generation') return 'video';
  if (reason === 'audio (TTS/STT)') return /whisper|transcrib|stt|speech-to-text/.test(id.toLowerCase()) ? 'stt' : 'tts';
  return 'language';
}

function availableAgentModels() {
  const connections = (publicSettings.aiConnections || []).filter((connection) => connection.enabled !== false);
  if (!connections.length) {
    const provider = activeChatProvider();
    const catalogKey = `draft:${provider}`;
    const discovered = Array.isArray(providerModelCatalog[catalogKey]) ? providerModelCatalog[catalogKey] : [];
    return discovered.map((id) => ({ id, label: id, connectionId: '', connectionName: PROVIDER_CATALOG[provider]?.label || provider }));
  }
  const models = [];
  for (const connection of connections) {
    // Saved and custom models are always part of the group, so a slow, failed,
    // or not-yet-run discovery can never make them disappear after a restart.
    const saved = [connection.model, ...(connection.customModels || []).map((entry) => entry && typeof entry === 'object' ? entry.id : entry)];
    const discovered = Array.isArray(providerModelCatalog[connection.id]) ? providerModelCatalog[connection.id] : [];
    for (const id of [...new Set([...saved, ...discovered].map((value) => String(value || '').trim()).filter(Boolean))]) models.push({ id, label: id, connectionId: connection.id, connectionName: connection.name || PROVIDER_CATALOG[connection.provider]?.label || connection.provider });
  }
  return models;
}

// After "Add", a small popup asks which kind the new model is. The kind tags
// the model on the connection and decides which endpoint serves it (chat,
// images, speech, transcription, video). Nothing about the picker itself
// changes — the popup only appears after the button is pressed.
const MODEL_KIND_CHOICES = [
  { value: 'language', label: 'Language (chat)' },
  { value: 'image', label: 'Image generation' },
  { value: 'tts', label: 'Text to speech' },
  { value: 'stt', label: 'Speech to text' },
  { value: 'video', label: 'Video generation' }
];
function showModelKindPopup({ anchor, onPick, onCancel }) {
  document.querySelector('.agent-kind-popup')?.remove();
  const popup = document.createElement('div');
  popup.className = 'agent-kind-popup';
  const title = document.createElement('div');
  title.className = 'agent-kind-popup-title';
  title.textContent = 'Model type';
  const buttons = MODEL_KIND_CHOICES.map(({ value, label }) => {
    const choice = document.createElement('button');
    choice.type = 'button';
    choice.className = 'agent-kind-popup-choice';
    choice.textContent = label;
    choice.addEventListener('click', () => { close(); onPick(value); });
    return choice;
  });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'agent-kind-popup-cancel';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { close(); onCancel?.(); });
  const close = () => {
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    popup.remove();
  };
  const onOutside = (event) => { if (!popup.contains(event.target) && event.target !== anchor) { close(); onCancel?.(); } };
  const onKey = (event) => { if (event.key === 'Escape') { event.stopPropagation(); close(); onCancel?.(); } };
  popup.append(title, ...buttons, cancel);
  // Mount inside the chat drawer and convert viewport coordinates into
  // drawer coordinates (on <body> it painted below the browser area).
  const host = chatDrawerHost();
  const drawerRect = host ? host.drawer.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth };
  (host ? host.drawer : document.body).append(popup);
  const popupRect = popup.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  const relativeLeft = rect.left - drawerRect.left;
  const relativeTop = rect.top - drawerRect.top;
  popup.style.left = `${Math.max(8, Math.min(relativeLeft, drawerRect.width - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, relativeTop - popupRect.height - 6)}px`;
  document.addEventListener('mousedown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

function hydrateAiConnections() {
  if ((publicSettings.aiConnections || []).length) return publicSettings.aiConnections || [];
  try {
    const raw = localStorage.getItem('bu-fallback-settings');
    if (raw) {
      const saved = JSON.parse(raw);
      if (Array.isArray(saved && saved.aiConnections) && saved.aiConnections.length) publicSettings = Object.assign({}, publicSettings, { aiConnections: saved.aiConnections });
    }
  } catch (error) { /* ignore corrupt storage */ }
  if (!(publicSettings.aiConnections || []).length && window.browserUseDesktop && typeof window.browserUseDesktop.settings === 'function') {
    window.browserUseDesktop.settings().then((settings) => {
      if (settings && Array.isArray(settings.aiConnections) && settings.aiConnections.length && !(publicSettings.aiConnections || []).length) {
        publicSettings = Object.assign({}, publicSettings, { aiConnections: settings.aiConnections });
        try { renderAgentModelOptions(); } catch (error) { /* menu may be closed */ }
        try { if (typeof renderConnections === 'function') renderConnections(); } catch (error) { /* ignore */ }
      }
    }).catch(() => {});
  }
  return publicSettings.aiConnections || [];
}

function renderAgentModelOptions(models = availableAgentModels()) {
  const list = agentModelMenu?.querySelector('.agent-model-list');
  if (!list) return;
  const connections = hydrateAiConnections().filter((connection) => connection.enabled !== false);
  const customIdsByConnection = new Map(connections.map((connection) => [connection.id, new Set((Array.isArray(connection.customModels) ? connection.customModels : [])
    .map((entry) => (entry && typeof entry === 'object' ? entry.id : entry)).filter(Boolean))]));
  const query = modelPickerQuery.trim().toLowerCase();
  const options = [];
  for (const connection of connections) {
    const connectionModels = models.filter((model) => model.connectionId === connection.id && (!query || fuzzyModelMatch(query, model.label)));
    const heading = document.createElement('div');
    heading.className = `agent-model-group-heading${connectionModels.length ? '' : ' is-empty'}`;
    const brand = document.createElement('span'); brand.className = 'agent-provider-brand'; renderProviderBrand(brand, connection.provider);
    const title = document.createElement('strong'); title.textContent = connection.name || PROVIDER_CATALOG[connection.provider]?.label || connection.provider;
    const providerLabel = document.createElement('span'); providerLabel.className = 'agent-model-group-provider'; providerLabel.textContent = PROVIDER_CATALOG[connection.provider]?.label || connection.provider;
    const count = document.createElement('small'); count.textContent = connectionModels.length ? `${connectionModels.length} model${connectionModels.length === 1 ? '' : 's'}` : 'No models discovered';
    heading.append(brand, title, providerLabel, count); options.push(heading);
    for (const model of connectionModels) {
      const option = document.createElement('button'); option.type = 'button'; option.className = `agent-model-option${model.id === selectedAgentModel && model.connectionId === selectedAgentConnectionId ? ' is-active' : ''}`;
      const name = document.createElement('strong'); name.textContent = model.label; option.append(name);
      option.addEventListener('click', () => { void selectAgentModel(model.id, model.connectionId); });
      const modelKind = storedModelKind(model.id); const kindBadge = document.createElement('span'); kindBadge.className = 'agent-model-kind'; kindBadge.textContent = { language: 'lang', image: 'image', tts: 'voice', stt: 'voice', video: 'video' }[modelKind] || modelKind; option.append(kindBadge);
      if (customIdsByConnection.get(model.connectionId)?.has(model.id)) {
        const del = document.createElement('span'); del.className = 'agent-model-delete'; del.title = 'Delete this custom model'; del.setAttribute('role', 'button'); del.setAttribute('aria-label', `Delete ${model.id}`); del.append(icon('trash'));
        del.addEventListener('click', (event) => { event.stopPropagation(); void (async () => { await window.browserUseDesktop.removeProviderModel({ connectionId: model.connectionId, model: model.id }); if (selectedAgentModel === model.id && selectedAgentConnectionId === model.connectionId) selectedAgentModel = ''; publicSettings = await window.browserUseDesktop.settings(); await refreshAgentProviderModels({ quiet: true, connectionId: model.connectionId }); })().catch((error) => reportError(error, 'Could not delete the model.')); });
        option.append(del);
      }
      options.push(option);
    }
  }
  if (!connections.length) options.push(Object.assign(document.createElement('p'), { className: 'agent-model-picker-empty', textContent: 'No active connections.' }));
  else if (!options.some((node) => node.classList?.contains('agent-model-option')) && query) options.push(Object.assign(document.createElement('p'), { className: 'agent-model-picker-empty', textContent: 'No matching models.' }));
  // Custom-model row: gateways omit image-gen/preview ids from /models.
  const addRow = document.createElement('div');
  addRow.className = 'agent-model-add-row';
  const targetConnections = (publicSettings.aiConnections || []).filter((item) => item.enabled !== false);
  if (!targetConnections.some((item) => item.id === selectedModelTargetConnectionId)) selectedModelTargetConnectionId = selectedAgentConnectionId || targetConnections[0]?.id || '';
  const targetSelect = document.createElement('select');
  targetSelect.className = 'agent-model-target-select';
  targetSelect.setAttribute('aria-label', 'Connection for new model');
  for (const target of targetConnections) { const option = document.createElement('option'); option.value = target.id; option.textContent = target.name || PROVIDER_CATALOG[target.provider]?.label || target.provider; targetSelect.append(option); }
  targetSelect.value = selectedModelTargetConnectionId;
  targetSelect.hidden = targetConnections.length < 2;
  targetSelect.addEventListener('change', () => { selectedModelTargetConnectionId = targetSelect.value; });
  const addInput = document.createElement('input');
  addInput.type = 'text';
  addInput.placeholder = 'Add model id…';
  addInput.className = 'agent-model-add-input';
  addInput.setAttribute('aria-label', 'Add a custom model id');
  const addButton = document.createElement('button');
  addButton.type = 'button';
  addButton.className = 'agent-model-add-button';
  addButton.textContent = 'Add';
  addButton.disabled = !selectedModelTargetConnectionId;
  const submitCustom = () => {
    const custom = addInput.value.trim();
    const targetConnectionId = selectedModelTargetConnectionId;
    const targetConnection = targetConnections.find((item) => item.id === targetConnectionId);
    if (!custom || !targetConnectionId || !targetConnection) return;
    addButton.disabled = true;
    // After Add, a small popup asks for the model kind — it decides which
    // endpoint the model uses (chat, images, speech, transcription, video)
    // and whether the chat composer routes messages as direct media.
    showModelKindPopup({
      anchor: addButton,
      onPick: (kind) => {
        void (async () => {
          await window.browserUseDesktop.addProviderModel({ provider: targetConnection.provider, connectionId: targetConnectionId, model: custom, kind });
          modelPickerQuery = '';
          publicSettings = await window.browserUseDesktop.settings();
          await refreshAgentProviderModels({ quiet: true, connectionId: targetConnectionId });
          if (kind === 'language') await selectAgentModel(custom, targetConnectionId);
          addInput.value = '';
        })().catch((error) => { reportError(error, 'Could not add the custom model.'); })
          .finally(() => { addButton.disabled = !selectedModelTargetConnectionId; });
      },
      onCancel: () => { addButton.disabled = !selectedModelTargetConnectionId; }
    });
  };
  addButton.addEventListener('click', submitCustom);
  addInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); submitCustom(); } });
  addRow.append(targetSelect, addInput, addButton);
  options.push(addRow);
  list.replaceChildren(...options);
}

function renderAgentModelPicker() {
  if (!agentModelMenu || !agentModelLabel) return;
  const models = availableAgentModels();
  const selectedEntry = models.find((item) => item.id === selectedAgentModel && item.connectionId === selectedAgentConnectionId) || models.find((item) => item.id === selectedAgentModel);
  if (!selectedEntry) { selectedAgentModel = ''; }
  agentModelLabel.textContent = selectedEntry?.label || 'Choose model';
  let input = agentModelMenu.querySelector('.agent-model-menu-search input');
  if (!input) {
    const search = document.createElement('label'); search.className = 'agent-model-menu-search';
    search.append(icon('magnifying-glass'));
    input = document.createElement('input'); input.type = 'search'; input.placeholder = 'Search models…';
    input.addEventListener('input', () => { modelPickerQuery = input.value; renderAgentModelOptions(); });
    search.append(input);
    const list = document.createElement('div'); list.className = 'agent-model-list';
    agentModelMenu.replaceChildren(search, list);
  }
  const focused = document.activeElement === input;
  const selectionStart = input.selectionStart;
  const selectionEnd = input.selectionEnd;
  if (!focused && input.value !== modelPickerQuery) input.value = modelPickerQuery;
  renderAgentModelOptions(models);
  // TTS voice picker (xkiro /v1/audio/voices): shown in the menu only while a
  // TTS model is selected; the saved per-connection voice defaults the
  // composer's audio generation. Other connections / failures → empty list.
  const existingVoiceRow = agentModelMenu.querySelector('.agent-tts-voice-row');
  if (storedModelKind(selectedAgentModel) === 'tts' && selectedAgentConnectionId) {
    if (!existingVoiceRow) {
      const row = document.createElement('label');
      row.className = 'agent-tts-voice-row';
      row.append(Object.assign(document.createElement('span'), { textContent: 'Voice' }));
      const select = document.createElement('select');
      select.className = 'agent-tts-voice-select';
      select.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Connection default' }));
      if (Array.isArray(agentTtsVoices) && agentTtsVoices.length) {
        for (const voice of agentTtsVoices) select.append(Object.assign(document.createElement('option'), { value: voice.id, textContent: voice.name }));
        select.value = agentTtsVoice;
      }
      select.addEventListener('change', () => {
        agentTtsVoice = select.value;
        void window.browserUseDesktop.setTtsVoice(selectedAgentConnectionId, agentTtsVoice).catch(() => {});
      });
      row.append(select);
      agentModelMenu.append(row);
      if (!agentTtsVoices) {
        void window.browserUseDesktop.ttsVoices(selectedAgentConnectionId).then((result) => {
          agentTtsVoices = Array.isArray(result?.voices) ? result.voices : [];
          if (agentTtsVoices.length && !agentModelMenu.hidden) renderAgentModelPicker();
        }).catch(() => { agentTtsVoices = []; });
      }
    }
  } else if (existingVoiceRow) existingVoiceRow.remove();
  // State refreshes can arrive while the user is typing in the picker. Preserve
  // that focused control and caret instead of rebuilding it after every key.
  if (focused) {
    input.focus({ preventScroll: true });
    try { input.setSelectionRange(selectionStart, selectionEnd); } catch {}
  }
}

async function selectAgentModel(modelId, connectionId = '') {
  const next = String(modelId || '').trim();
  if (!next) return;
  const previous = selectedAgentModel;
  const targetConnection = connectionId ? (publicSettings.aiConnections || []).find((item) => item.id === connectionId) : activeConnection();
  if (connectionId && connectionId !== selectedAgentConnectionId) {
    selectedAgentConnectionId = connectionId;
    selectedModelTargetConnectionId = connectionId;
    if (targetConnection && agentProviderSelect) agentProviderSelect.value = targetConnection.provider;
  }
  const nonChat = nonChatModelReason(next);
  if (nonChat) {
    reportError(new Error(`${next} is a ${nonChat} model. The Browser-use agent runs on text/chat models — it cannot drive browser tasks or answer in this loop with it. Pick a chat model instead.`), 'Model not usable by the agent');
  }
  if (!availableAgentModels().some((model) => model.id === next && (!connectionId || model.connectionId === connectionId))) {
    reportError(new Error('Choose a model from this provider\'s discovered catalog.'), 'Could not select this model.');
    return;
  }
  selectedAgentModel = next;
  if (agentModelMenu) agentModelMenu.hidden = true;
  agentModelToggle?.setAttribute('aria-expanded', 'false');
  renderAgentModelPicker();
  const connection = targetConnection || activeConnection();
  if (!connection?.id) return;
  try {
    publicSettings = await window.browserUseDesktop.setAiConnectionModel({ connectionId: connection.id, model: next });
    selectedAgentConnectionId = connection.id;
    renderConnections();
  } catch (error) {
    selectedAgentModel = previous;
    renderAgentModelPicker();
    reportError(error, 'Could not select this model.');
  }
}

const PROVIDER_CATALOG = Object.freeze({
  ollama: { label: 'Ollama Local', baseUrl: 'http://127.0.0.1:11434', signup: '', key: false, auth: 'none' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', signup: 'https://platform.openai.com/signup', key: true, auth: 'api-key' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', signup: 'https://console.anthropic.com/', key: true, auth: 'api-key' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', signup: 'https://aistudio.google.com/', key: true, auth: 'api-key', oauth: 'google-oauth-available' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', signup: 'https://platform.deepseek.com/sign_up', key: true, auth: 'api-key' },
  grok: { label: 'xAI', baseUrl: 'https://api.x.ai/v1', signup: 'https://console.x.ai/', key: true, auth: 'api-key' },
  perplexity: { label: 'Perplexity', baseUrl: 'https://api.perplexity.ai', signup: 'https://www.perplexity.ai/account/details', key: true, auth: 'api-key' },
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', signup: 'https://openrouter.ai/sign-up', key: true, auth: 'api-key' },
  xkiro: { label: 'xKiro', baseUrl: 'https://api.xkiro.com/v1', signup: 'https://xkiro.com/register', key: true, auth: 'api-key' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', signup: 'https://console.groq.com/signup', key: true, auth: 'api-key' },
  cloud: { label: 'Browser Use Cloud', baseUrl: '', signup: 'https://cloud.browser-use.com/settings?tab=api-keys&new=1', key: true, auth: 'api-key' }
});
const PROVIDER_LOGOS = Object.freeze({
  ollama: 'https://ollama.com/public/icon-32x32.png', openai: 'https://cdn.oaistatic.com/assets/favicon-o20kmmos.svg',
  anthropic: 'https://cdn.prod.website-files.com/67ce28cfec624e2b733f8a52/681d52619fec35886a7f1a70_favicon.png', gemini: 'https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg',
  deepseek: 'https://www.deepseek.com/favicon.ico', grok: 'https://x.ai/favicon.ico', perplexity: 'https://cdn.simpleicons.org/perplexity',
  openrouter: 'https://openrouter.ai/brand/v2/openrouter-glyph-dark.svg', xkiro: 'https://xkiro.com/favicon.ico', groq: 'https://console.groq.com/favicon.ico', cloud: 'https://browser-use.com/favicon.ico'
});

function activeChatProvider() { return PROVIDER_CATALOG[agentProviderSelect?.value] ? agentProviderSelect.value : 'ollama'; }
function activeConnection() { return (publicSettings.aiConnections || []).find((connection) => connection.id === selectedAgentConnectionId) || null; }

function providerBrand(provider) {
  const item = PROVIDER_CATALOG[provider] || PROVIDER_CATALOG.ollama;
  if (agentProviderBrand) renderProviderBrand(agentProviderBrand, provider);
  if (agentProviderSelectLabel) agentProviderSelectLabel.textContent = item.label;
}

function renderProviderBrand(node, provider) {
  node.dataset.provider = provider; node.replaceChildren();
  const image = document.createElement('img'); image.alt = ''; image.src = PROVIDER_LOGOS[provider] || ''; image.addEventListener('error', () => node.classList.add('is-unavailable'), { once: true }); node.append(image);
}

function renderProviderChoices() {
  if (!agentProviderSelectMenu) return;
  agentProviderSelectMenu.replaceChildren(...Object.entries(PROVIDER_CATALOG).map(([id, item]) => {
    const option = document.createElement('button'); option.type = 'button'; option.role = 'option'; option.dataset.provider = id;
    const brand = document.createElement('span'); brand.className = 'agent-provider-brand'; renderProviderBrand(brand, id);
    const label = document.createElement('strong'); label.textContent = item.label;
    option.append(brand, label);
    option.addEventListener('click', () => { selectChatProvider(id); agentProviderSelectMenu.hidden = true; agentProviderSelectTrigger?.setAttribute('aria-expanded', 'false'); });
    return option;
  }));
}

function updateAgentProviderFieldVisibility() {
  const provider = activeChatProvider(); const item = PROVIDER_CATALOG[provider];
  if (agentProviderBaseUrlField) agentProviderBaseUrlField.hidden = provider === 'cloud';
  if (agentProviderKeyField) agentProviderKeyField.hidden = !item?.key;
  if (agentProviderClear) agentProviderClear.hidden = !item?.key || !(activeConnection()?.credential?.configured || (provider === 'cloud' && publicSettings.cloudCredential?.configured));
  if (agentProviderSignupLink) { agentProviderSignupLink.hidden = !item?.signup; if (item?.signup) agentProviderSignupLink.href = item.signup; }
  providerBrand(provider);
  if (agentProviderAuthNote) agentProviderAuthNote.textContent = item?.oauth === 'google-oauth-available' ? 'Google Cloud OAuth is available only with configured Google Cloud credentials; Gemini API-key access remains supported.' : item?.auth === 'api-key' ? 'API key connection. Consumer account login is not used for this provider.' : '';
}

function renderConnections() {
  if (!agentConnectionList) return;
  const connections = hydrateAiConnections();
  if (!connections.length && !renderConnections.__hydrated) {
    renderConnections.__hydrated = true;
    try {
      const bridgeSettings = window.browserUseDesktop && typeof window.browserUseDesktop.settings === 'function' ? window.browserUseDesktop.settings() : null;
      if (bridgeSettings && typeof bridgeSettings.then === 'function') {
        bridgeSettings.then((loaded) => {
          if (loaded && Array.isArray(loaded.aiConnections) && loaded.aiConnections.length) {
            publicSettings.aiConnections = loaded.aiConnections;
            if (loaded.aiChatConnectionId && !publicSettings.aiChatConnectionId) publicSettings.aiChatConnectionId = loaded.aiChatConnectionId;
          }
          renderConnections();
        }, () => renderConnections());
        return;
      }
      if (bridgeSettings && Array.isArray(bridgeSettings.aiConnections) && bridgeSettings.aiConnections.length) {
        publicSettings.aiConnections = bridgeSettings.aiConnections;
        if (bridgeSettings.aiChatConnectionId && !publicSettings.aiChatConnectionId) publicSettings.aiChatConnectionId = bridgeSettings.aiChatConnectionId;
        renderConnections();
        return;
      }
    } catch (e) {}
  }
  if (!connections.length) { agentConnectionList.replaceChildren(Object.assign(document.createElement('p'), { textContent: 'No saved connections yet. Set up a provider above and save.' })); return; }
  agentConnectionList.replaceChildren(...connections.map((connection) => {
    const row = document.createElement('div'); row.className = `agent-connection-item${connection.id === selectedAgentConnectionId ? ' is-active' : ''}${connection.enabled === false ? ' is-disabled' : ''}`;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-connection-main';
    const brand = document.createElement('span'); brand.className = 'agent-provider-brand'; renderProviderBrand(brand, connection.provider);
    const content = document.createElement('span'); content.className = 'agent-connection-copy';
    const label = document.createElement('strong'); label.textContent = connection.name || PROVIDER_CATALOG[connection.provider]?.label || connection.provider;
    const detail = document.createElement('small'); detail.textContent = `${PROVIDER_CATALOG[connection.provider]?.label || connection.provider} · ${connection.credential?.display || (connection.provider === 'ollama' ? 'Local' : 'No key')}`;
    content.append(label, detail); button.append(brand, content); button.addEventListener('click', () => loadConnection(connection));
    const controls = document.createElement('span'); controls.className = 'agent-connection-controls';
    const toggleLabel = document.createElement('label'); toggleLabel.className = 'agent-connection-switch'; toggleLabel.title = connection.enabled === false ? 'Enable connection' : 'Disable connection';
    const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = connection.enabled !== false; toggle.setAttribute('aria-label', `${toggle.checked ? 'Disable' : 'Enable'} ${connection.name || connection.provider}`);
    toggle.addEventListener('click', (event) => event.stopPropagation()); toggle.addEventListener('change', async () => { toggle.disabled = true; try { publicSettings = await window.browserUseDesktop.setAiConnectionEnabled({ connectionId: connection.id, enabled: toggle.checked }); if (toggle.checked) await refreshAgentProviderModels({ quiet: true, connectionId: connection.id }); renderConnections(); renderAgentModelPicker(); } catch (error) { toggle.checked = !toggle.checked; reportError(error, 'Could not toggle the connection.'); } finally { toggle.disabled = false; } }); toggleLabel.append(toggle);
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'agent-connection-delete'; remove.title = `Delete ${connection.name || connection.provider}`; remove.setAttribute('aria-label', remove.title); remove.innerHTML = '<i class="ph ph-trash"></i>'; remove.addEventListener('click', async (event) => { event.stopPropagation(); remove.disabled = true; try { publicSettings = await window.browserUseDesktop.removeAiConnection(connection.id); if (selectedAgentConnectionId === connection.id) { selectedAgentConnectionId = ''; selectChatProvider('ollama'); } renderConnections(); renderAgentModelPicker(); } catch (error) { reportError(error, 'Could not delete the connection.'); } }); controls.append(toggleLabel, remove); row.append(button, controls); return row;
  }));
}

function loadConnection(connection) {
  if (!connection) return;
  selectedAgentConnectionId = connection.id;
  selectedModelTargetConnectionId = connection.id;
  if (agentProviderSelect) agentProviderSelect.value = connection.provider;
  if (agentProviderName) agentProviderName.value = connection.name || '';
  if (agentProviderBaseUrl) agentProviderBaseUrl.value = connection.baseUrl || '';
  if (agentProviderKey) agentProviderKey.value = '';
  selectedAgentModel = connection.model || '';
  updateAgentProviderFieldVisibility(); renderConnections(); renderAgentModelPicker();
  void refreshAgentProviderModels({ quiet: true, connectionId: connection.id });
}

function selectChatProvider(provider) {
  const item = PROVIDER_CATALOG[provider] || PROVIDER_CATALOG.ollama;
  selectedAgentConnectionId = '';
  selectedModelTargetConnectionId = (publicSettings.aiConnections || []).find((connection) => connection.enabled !== false)?.id || '';
  if (agentProviderSelect) agentProviderSelect.value = provider;
  if (agentProviderName) agentProviderName.value = item.label;
  if (agentProviderBaseUrl) agentProviderBaseUrl.value = item.baseUrl;
  if (agentProviderKey) agentProviderKey.value = '';
  selectedAgentModel = '';
  updateAgentProviderFieldVisibility(); renderConnections(); void refreshAgentProviderModels({ quiet: true });
}

// LORDE_CATALOG_PRESERVE_V1 — persist the last good catalog per connection so
// a failed launch-time discovery can hydrate from disk instead of leaving the
// picker empty while every provider is fetched.
const CATALOG_CACHE_KEY = 'browser-use-model-catalog-cache-v1';

function loadCatalogCache() {
  try { return JSON.parse(localStorage.getItem(CATALOG_CACHE_KEY) || '{}') || {}; }
  catch { return {}; }
}

function persistCatalogCache(catalogKey) {
  try {
    const cache = loadCatalogCache();
    cache[catalogKey] = {
      models: providerModelCatalog[catalogKey] || [],
      kinds: providerModelKinds[catalogKey] || {},
      pricing: providerModelPricing[catalogKey] || {},
      at: Date.now()
    };
    localStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify(cache));
  } catch { /* storage unavailable — in-memory catalog still works */ }
}

function hydrateCatalogFromCache(catalogKey) {
  const cached = loadCatalogCache()[catalogKey];
  if (!cached || !Array.isArray(cached.models) || !cached.models.length) return false;
  providerModelCatalog[catalogKey] = cached.models.slice();
  if (cached.kinds && typeof cached.kinds === 'object') providerModelKinds[catalogKey] = { ...cached.kinds };
  if (cached.pricing && typeof cached.pricing === 'object') providerModelPricing[catalogKey] = { ...cached.pricing };
  return true;
}

async function refreshAgentProviderModels({ quiet = false, connectionId = '' } = {}) {
  const connection = (publicSettings.aiConnections || []).find((item) => item.id === connectionId)
    || activeConnection();
  const provider = connection?.provider || activeChatProvider();
  const catalogKey = connection?.id || `draft:${provider}`;
  try {
    const result = await window.browserUseDesktop.listProviderModels({
      provider,
      baseUrl: connection?.baseUrl || agentProviderBaseUrl?.value,
      connectionId: connection?.id || selectedAgentConnectionId
    });
    const entries = Array.isArray(result.models) ? result.models : [];
    // LORDE_CATALOG_PRESERVE_V1 — a failed discovery (dead endpoint, network
    // down) must NEVER wipe the user's existing catalog or strand them waiting
    // on providers. The previous list survives untouched, hydrated from the
    // persisted cache when this is the first fetch of the session; a SUCCESSFUL
    // fetch stays the source of truth (appends new ids, drops stale ones).
    const failedFetch = result.failed === true;
    const discovered = [...new Set(entries.map((model) => {
      const id = model && typeof model === 'object' ? String(model.id || '') : String(model || '');
      return id.trim();
    }).filter(Boolean))];
    if (!failedFetch) {
      providerModelKinds[catalogKey] = Object.fromEntries(entries.map((model) => (
        model && typeof model === 'object' ? [String(model.id || ''), String(model.kind || '')] : [String(model || ''), '']
      )).filter(([id]) => id));
      providerModelPricing[catalogKey] = Object.fromEntries(entries
        .filter((model) => model && typeof model === 'object' && Array.isArray(model.usdPerM))
        .map((model) => [String(model.id || ''), model.usdPerM]));
      providerModelCatalog[catalogKey] = discovered;
      persistCatalogCache(catalogKey);
    } else if (!Object.prototype.hasOwnProperty.call(providerModelCatalog, catalogKey)) {
      hydrateCatalogFromCache(catalogKey);
    }
    if (connection?.id === selectedAgentConnectionId) {
      const previous = String(selectedAgentModel || connection.model || '').trim();
      if (previous && (discovered.includes(previous) || failedFetch)) selectedAgentModel = previous;
      else if (!failedFetch && !discovered.length) selectedAgentModel = '';
      else if (!previous && !failedFetch) selectedAgentModel = discovered[0];
    }
    renderAgentModelPicker();
    return { ...result, models: discovered, connectionId: connection?.id || '' };
  } catch (error) {
    // Keep the connection group visible with its saved/custom models even when
    // discovery is unavailable; the next lazy refresh can try again.
    if (!Object.prototype.hasOwnProperty.call(providerModelCatalog, catalogKey)) providerModelCatalog[catalogKey] = [];
    if (!quiet) reportError(error, 'Model discovery failed.');
    renderAgentModelPicker();
    return null;
  }
}

async function refreshAllAgentProviderModels({ quiet = true } = {}) {
  const connections = (publicSettings.aiConnections || []).filter((connection) => connection.enabled !== false);
  for (const connection of connections) {
    if (!Object.prototype.hasOwnProperty.call(providerModelCatalog, connection.id)) providerModelCatalog[connection.id] = [];
  }
  await Promise.allSettled(connections.map((connection) => refreshAgentProviderModels({ quiet, connectionId: connection.id })));
  renderAgentModelPicker();
}

function syncAgentProviderOnboarding() {
  if (!agentProviderSelect) return;
  const saved = (publicSettings.aiConnections || []).find((connection) => connection.id === publicSettings.aiChatConnectionId && connection.enabled !== false)
    || (publicSettings.aiConnections || []).find((connection) => connection.enabled !== false);
  if (saved) loadConnection(saved);
  else selectChatProvider(publicSettings.aiChatProvider || 'ollama');
  renderProviderChoices(); renderConnections();
  if (agentProviderTestStatus) { agentProviderTestStatus.textContent = 'Save the connection to discover its available models.'; agentProviderTestStatus.dataset.state = 'idle'; }
}

async function saveAndTestAgentProvider() {
  const provider = activeChatProvider();
  const baseUrl = String(agentProviderBaseUrl?.value || '').trim();
  if (!baseUrl && provider !== 'cloud') throw new Error('Enter a provider base URL.');
  if (agentProviderTestStatus) { agentProviderTestStatus.textContent = 'Saving provider…'; agentProviderTestStatus.dataset.state = 'checking'; }
  const savedConnection = await window.browserUseDesktop.saveAiConnection({ id: selectedAgentConnectionId, provider, name: agentProviderName?.value, baseUrl });
  selectedAgentConnectionId = savedConnection.id;
  if (agentProviderKey?.value.trim()) await window.browserUseDesktop.setProviderCredential({ provider, connectionId: selectedAgentConnectionId, secret: agentProviderKey.value.trim() });
  publicSettings = await window.browserUseDesktop.settings();
  updateAgentProviderFieldVisibility();
  if (agentProviderTestStatus) { agentProviderTestStatus.textContent = 'Testing connection…'; agentProviderTestStatus.dataset.state = 'checking'; }
  renderConnections();
  if (agentProviderTestStatus) { agentProviderTestStatus.textContent = 'Discovering models…'; agentProviderTestStatus.dataset.state = 'checking'; }
  const discovery = await refreshAgentProviderModels({ quiet: true, connectionId: selectedAgentConnectionId });
  const discovered = Array.isArray(discovery?.models) ? discovery.models : [];
  const retained = String(selectedAgentModel || savedConnection.model || '').trim();
  const model = discovered.includes(retained) ? retained : discovered[0] || retained;
  if (!model) {
    renderAgentModelPicker();
    if (agentProviderTestStatus) {
      agentProviderTestStatus.textContent = discovery?.message || 'The provider returned no available models.';
      agentProviderTestStatus.dataset.state = 'error';
    }
    return;
  }
  publicSettings = await window.browserUseDesktop.setAiConnectionModel({ connectionId: selectedAgentConnectionId, model });
  selectedAgentModel = model;
  renderAgentModelPicker();
  const result = await window.browserUseDesktop.preflightProvider({ provider, model, baseUrl, connectionId: selectedAgentConnectionId });
  if (agentProviderTestStatus) { agentProviderTestStatus.textContent = result.message || `${model} is ready.`; agentProviderTestStatus.dataset.state = 'ok'; }
  if (recordActive) void window.browserUseDesktop.recordRecheckModel?.();
}

function copyWholeChat() {
  // textContent deliberately includes collapsed thought/details and hidden tool
  // inspections, so Copy whole chat is a complete textual audit rather than a
  // copy of only what happens to be expanded on screen.
  const transcript = [...agentTranscript.querySelectorAll('.agent-message')].map((item) => item.textContent.trim()).filter(Boolean).join('\n\n');
  return window.browserUseDesktop.copyText(transcript);
}

const ACTIVE_AGENT_STATUSES = new Set(['starting agent', 'running', 'awaiting_approval', 'awaiting_input', 'paused']);
const ACTIVE_RUN_ID_WAIT_MS = 1_500;
const ACTIVE_RUN_ID_POLL_MS = 50;

function isActiveAgentRun(run) {
  return Boolean(run && ACTIVE_AGENT_STATUSES.has(run.status));
}

function currentActiveChatRun() {
  if (isActiveAgentRun(activeChatRun)) return activeChatRun;
  return isActiveAgentRun(chatRun) ? chatRun : null;
}

async function resolveActiveChatRun() {
  let current = currentActiveChatRun();
  if (current?.id || !current) return current;
  // `agent-start` now returns the real run immediately. This small state
  // refresh also covers the first paint while an existing desktop profile is
  // creating its initial neutral tab. Keep a header control actionable during
  // that tiny handoff rather than making a user wait for the next UI event.
  const deadline = Date.now() + ACTIVE_RUN_ID_WAIT_MS;
  do {
    const latest = await window.browserUseDesktop.agentState();
    if (isActiveAgentRun(latest)) activeChatRun = latest;
    current = currentActiveChatRun();
    if (current?.id || !current) return current;
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, ACTIVE_RUN_ID_POLL_MS));
  } while (Date.now() < deadline);
  return current;
}

// A message typed while a task runs can either wait for it (queue) or slip
// into the run at its next thinking turn (fast-forward). The queued message
// auto-sends as the next conversation turn once the active run ends.
let queuedAgentMessage = '';
let queuedAgentAttachments = [];

function renderQueuedMessage() {
  agentQueued.hidden = !queuedAgentMessage;
  if (!queuedAgentMessage) { agentQueuedText.replaceChildren(); return; }
  const domAttachments = domAttachmentApi?.normalizeDomAttachments?.(queuedAgentAttachments
    .filter((item) => item?.inline === true && item?.selector)
    .map((item) => ({ name: item.name, text: item.text, selector: item.selector, previewText: item.previewText, pageUrl: item.pageUrl }))) || [];
  agentQueuedText.replaceChildren();
  if (domAttachments.length) renderDomReferenceLinks(agentQueuedText, queuedAgentMessage, domAttachments);
  else agentQueuedText.textContent = queuedAgentMessage;
  if (queuedAgentAttachments.length) agentQueuedText.append(document.createTextNode(` (+${queuedAgentAttachments.length} attached)`));
}

function updateAgentRunButtons() {
  const activeRun = currentActiveChatRun();
  const running = Boolean(activeRun?.id);
  const typed = agentTask.value.trim().length > 0;
  // While a task runs and the composer has text, the single delivery button
  // eases out of the stop column; it opens a dropdown offering queue or
  // fast-forward instead of exposing two always-separate buttons.
  const showActions = running && typed;
  agentRunAction?.classList.toggle('is-visible', showActions);
  agentRunAction?.setAttribute('aria-hidden', String(!showActions));
  if (agentRunAction) agentRunAction.tabIndex = showActions ? 0 : -1;
  if (!showActions) setAgentRunActionMenuOpen(false);
}
function setAgentRunActionMenuOpen(open) {
  if (!agentRunActionMenu || !agentRunAction) return;
  agentRunActionMenu.hidden = !open;
  agentRunAction.setAttribute('aria-expanded', String(open));
}

function queueAgentMessage(text, attachments = []) {
  queuedAgentMessage = text;
  queuedAgentAttachments = Array.isArray(attachments) ? attachments : [];
  renderQueuedMessage();
  showToast('Message queued, it will send when the current task finishes.');
}

// Delivers the queued message as the next turn once the active run reaches a
// terminal status. Guarded to the visible conversation so background run
// snapshots do not steal the composer.
function maybeAutoSendQueued(previousStatus) {
  if (!queuedAgentMessage) return;
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'];
  if (!chatRun?.status || !terminal.includes(chatRun.status)) return;
  if (previousStatus && terminal.includes(previousStatus)) return;
  if (chatRun.id && chatRun.id !== visibleConversationId) return;
  const text = queuedAgentMessage;
  const restoredAttachments = queuedAgentAttachments;
  queuedAgentMessage = '';
  queuedAgentAttachments = [];
  renderQueuedMessage();
  agentTask.value = text;
  pendingAgentAttachments = restoredAttachments;
  renderPendingAttachments();
  updateAgentRunButtons();
  setTimeout(() => { if (!currentActiveChatRun()) agentForm.requestSubmit(); }, 350);
}

function renderChatControls() {
  // LORDE_SUBAGENT_TABS_V369 — on a subagent tab the ORIGINAL Stop button
  // targets the active subagent: visible/enabled while it runs, hidden when
  // idle (Send stays visible and routes the message).
  if (activeSubagentTab !== 'main') {
    const entry = activeSubagentEntry();
    const cachedBusy = entry ? subagentBusyByAlias.get(String(entry.alias)) : undefined;
    const running = typeof cachedBusy === 'boolean' ? cachedBusy : String(entry?.status || '') === 'running';
    agentCancel.hidden = !running;
    agentCancel.disabled = !running;
    agentSend.hidden = false;
    agentSend.disabled = false;
    agentRunStatus.textContent = running ? `running · subagent ${entry.alias}` : `resident · subagent ${entry.alias}`;
    return;
  }
  const activeRun = currentActiveChatRun();
  const active = Boolean(activeRun);
  // While a task runs the send slot is the stop column: send gets out of the
  // way entirely (queueing happens through the queue button), so the row
  // shows three controls at most, stop, queue, fast-forward.
  agentSend.hidden = active;
  agentSend.disabled = active;
  agentSend.title = active ? 'Queue an instruction for the active task' : 'Send message';
  agentCancel.hidden = !active;
  // Stop itself resolves the just-created run ID when necessary. Disabling the
  // button during that handoff makes the whole chat look frozen after Send.
  agentCancel.disabled = !active;
  const statusRun = activeRun || chatRun;
  agentRunStatus.textContent = statusRun ? `${statusRun.status.replaceAll('_', ' ')} · step ${statusRun.step}` : 'Ready for a task';
  agentTabScope.textContent = state.active ? `Active tab · ${state.active.title || 'New Tab'}` : 'No active tab';
  updateAgentRunButtons();
}

function olderChatSnapshot(run, previous) {
  if (!run?.id || run.id !== previous?.id) return false;
  const oldAttempt = Number(previous.attemptSequence) || 0;
  const attempt = run.attemptSequence === undefined ? oldAttempt : Number(run.attemptSequence) || 0;
  const revision = run.eventRevision === undefined ? Number(previous.eventRevision) || 0 : Number(run.eventRevision) || 0;
  return attempt < oldAttempt || attempt === oldAttempt && revision < Number(previous.eventRevision || 0);
}
function renderChatSnapshot(run) {
  // No active run in main does not erase the saved conversation being viewed.
  if (!run) { renderChatControls(); return; }
  if (renderChatState(run) !== false) renderChatApproval(chatRun?.pendingApproval);
}
function renderChatState(run, { select = false } = {}) {
  if (run?.id) {
    if (select) { visibleConversationId = run.id; retiredConversationIds.delete(run.id); allowInitialChatSnapshot = false; }
    if (retiredConversationIds.has(run.id)) return false;
    const terminalSnapshot = ['completed', 'failed', 'cancelled'].includes(run.status) && Boolean(run.result?.summary || run.result?.error);
    if (visibleConversationId && run.id !== visibleConversationId || !visibleConversationId && !allowInitialChatSnapshot && !select && !terminalSnapshot) {
      if (activeChatRun?.id === run.id && !olderChatSnapshot(run, activeChatRun)) { activeChatRun = { ...activeChatRun, ...run }; renderChatControls(); }
      return false;
    }
    if (chatRun?.id === run.id) {
      if (olderChatSnapshot(run, chatRun)) return false;
      run = { ...chatRun, ...run };
    }
    if (!visibleConversationId) { visibleConversationId = run.id; allowInitialChatSnapshot = false; }
  } else if (run) { activeChatRun = run; renderChatControls(); return true; }
  const previousChatStatus = chatRun?.status;
  chatRun = run || null;
  if (!chatRun) { renderPlan([]); renderGoals([]); }
  // A terminal run has nothing left to wait for: any live connection strip
  // from the retry ladder is stale the moment the run ends.
  if (['completed', 'failed', 'cancelled'].includes(chatRun?.status)) hideConnectionNotice();
  if (isActiveAgentRun(chatRun)) activeChatRun = chatRun;
  else if (activeChatRun && (!activeChatRun.id || chatRun?.id === activeChatRun.id)) activeChatRun = null;
  if (agentConversationTitle && chatRun?.title) {
    const label = standaloneChatWindowId && window.browserUseDesktopState?.chatWindowLabel ? `${window.browserUseDesktopState.chatWindowLabel} · ` : '';
    agentConversationTitle.textContent = `${label}${chatRun.title}`;
  }
  if (agentConversationTitle && standaloneChatWindowId && window.browserUseDesktopState?.chatWindowLabel && !chatRun?.title) agentConversationTitle.textContent = window.browserUseDesktopState.chatWindowLabel;
  if (Array.isArray(chatRun?.plan)) renderPlan(chatRun.plan, chatRun.status);
  if (Array.isArray(chatRun?.goals)) renderGoals(chatRun.goals, chatRun.status);
  renderChatControls();
  maybeAutoSendQueued(previousChatStatus);
  // State is a durable fallback for the terminal IPC event. A completed run
  // must paint its natural-language result even if the immediate event arrived
  // while the renderer was busy updating the drawer. This fallback belongs to
  // the MAIN conversation, so it always renders into the main transcript even
  // while a subagent tab hosts the visible feed (LORDE_SUBAGENT_TABS_V366).
  if (chatRun?.status === 'completed' && chatRun.result?.summary) {
    settleLiveThought();
    const previousHost = chatFeedHost;
    chatFeedHost = null;
    try { renderAssistantReply(chatRun.result.summary, chatRun.id); }
    finally { chatFeedHost = previousHost; }
  }
  return true;
}

function truncateHistoryTitle(value, limit = 58) {
  const title = String(value || 'Untitled conversation').trim();
  return title.length > limit ? `${title.slice(0, limit - 3).trimEnd()}...` : title;
}

async function renderAgentHistory() {
  const entries = await window.browserUseDesktop.chatHistoryList();
  agentHistoryView.hidden = false;
  syncAgentOverlayScreenState();
  // ChatGPT-style live sessions first: conversations still running in the
  // background as independent instances. Clicking one jumps into its live
  // transcript (the persisted snapshot plus every event from now on).
  const liveSessions = state.agent?.liveSessions || [];
  const sections = [];
  if (liveSessions.length) {
    const head = Object.assign(document.createElement('p'), { className: 'agent-history-section-label', textContent: 'Live sessions' });
    sections.push(head);
    for (const session of liveSessions) {
      const item = document.createElement('button'); item.type = 'button'; item.className = 'agent-history-item is-live';
      const title = document.createElement('strong'); title.textContent = truncateHistoryTitle(session.title);
      const status = document.createElement('small'); status.textContent = `running · step ${session.step || 0}`;
      item.append(title, status);
      item.addEventListener('click', () => { void openConversation(session.id); });
      sections.push(item);
    }
    const divider = Object.assign(document.createElement('p'), { className: 'agent-history-section-label', textContent: 'History' });
    sections.push(divider);
  }
  const savedItems = entries.length ? entries.map((entry) => {
    const item = document.createElement('button'); item.type = 'button'; item.className = 'agent-history-item';
    const title = document.createElement('strong'); title.textContent = truncateHistoryTitle(entry.title);
    item.append(title);
    item.addEventListener('click', () => { void openConversation(entry.id); });
    return item;
  }) : [Object.assign(document.createElement('p'), { className: 'agent-empty', textContent: 'No saved conversations yet.' })];
  agentHistoryList.replaceChildren(...sections, ...savedItems);
}

// Opens a conversation (saved OR live) into the transcript: persisted
// snapshot now, live events from here on (handleAgentEvent routes by
// visibleConversationId).
async function openConversation(conversationId) {
  const conversation = await window.browserUseDesktop.chatHistoryGet(conversationId);
  if (!conversation) return;
  // Saved/live conversations are main-tab surfaces: opening one returns the
  // drawer to the Main tab so the rebuilt transcript is actually visible.
  if (activeSubagentTab !== 'main') selectSubagentTab('main');
  visibleConversationId = conversation.id;
  chatSelectionRevision += 1;
  discardLiveThought();
  agentTranscript.replaceChildren(); transcriptStickToBottom = true;
  lastAssistantReplyByRun.delete(conversation.id);
  lastAssistantCardByRun.delete(conversation.id);
  const timeline = [
    ...(conversation.messages || []).map((message, order) => ({ kind: 'message', at: Number(message.at) || 0, order, value: message })),
    ...(conversation.thinkingArchive || []).map((record, order) => ({ kind: 'thinking', at: Number(record.at) || 0, order: 5_000 + order, value: record })),
    ...(conversation.transcript || []).map((record, order) => ({ kind: 'tool', at: Number(record.at) || 0, order: 10_000 + order, value: record }))
  ].sort((left, right) => left.at - right.at || left.order - right.order);
  let hasAssistant = false;
  for (const entry of timeline) {
    if (entry.kind === 'thinking') {
      renderHistoricalThought(entry.value);
      continue;
    }
    if (entry.kind === 'message') {
      // Runtime messages are model-facing context and stay out of the
      // transcript — UNLESS they carry a producer badge (a research brief, a
      // subagent's findings). Those are content the user asked to be able to
      // tell apart from the agent's own voice, so they render, badged.
      if (entry.value.source === 'runtime' && !entry.value.badge) continue;
      const role = entry.value.role === 'assistant' ? 'assistant' : 'user';
      const terminalFailure = role === 'assistant' && (conversation.success === false || conversation.status === 'failed')
        && entry.value === (conversation.messages || []).filter((message) => message.role === 'assistant').at(-1)
        && String(entry.value.content || '').trim() === String(conversation.summary || '').trim();
      renderChatMessage(terminalFailure ? 'error' : role, entry.value.displayContent || entry.value.content || '', '', null,
        {
          ...(entry.value.domAttachments?.length ? { domAttachments: entry.value.domAttachments } : {}),
          ...(entry.value.badge ? { badge: entry.value.badge } : {})
        });
      if (role === 'assistant') {
        hasAssistant = true;
        if (!terminalFailure) lastAssistantReplyByRun.set(conversation.id, String(entry.value.content || '').trim());
      }
      continue;
    }
    const record = entry.value;
    const output = record.output ?? 'No output recorded.';
    // Match the live feed: recoverable hiccups and rejected done attempts
    // are internal bookkeeping, not user-facing outcomes.
    const isDone = record.tool === 'browser_done';
    const guardAdvisory = !isDone && /^computer_(patch|write|fs|fs_batch|read|search)$/.test(String(record.tool || '')) && (output?.ok === false || Boolean(output?.error) || typeof output === 'string') && /Pre-existing working-tree|expectedHash|not found in the current file|Read the file again|regenerate the patch/i.test(typeof output === 'string' ? output : JSON.stringify(output || ''));
    const recoverableOnly = !isDone && ((output?.recoverable === true && output?.ok !== true) || guardAdvisory);
    if (isDone && output?.ok !== true) continue;
    if (recoverableOnly) continue;
    const stale = output?.state === 'stale' && output?.recoverable;
    const failed = !stale && (output?.ok === false || Boolean(output?.error));
    // Parity with the live feed: plan bookkeeping renders in the floating
    // plan surface, never as transcript rows.
    if (['update_plan', 'create_plan', 'agent_advisory', 'agent_recovery'].includes(record.tool)) continue;
    // Generated media (computer_model + direct composer) rebuilds as the same
    // interactive cards used live, so history survives agent close/reopen.
    const media = record.media && ['image', 'video', 'audio'].includes(record.media.kind) ? record.media : null;
    if (media) {
      const actionText = media.kind === 'video' ? 'generated a video' : media.kind === 'audio' ? 'generated audio' : 'generated an image';
      const item = buildMediaMessage(actionText, { ...media, filename: media.filename || mediaFilename(media.kind) }, media.kind === 'audio' ? buildAudioNote : buildMediaCard);
      withTranscriptStick(() => agentTranscript.append(item));
      continue;
    }
    // Parity with the live feed: saved reports render their content preview,
    // not a generic tool row.
    if (!failed && record.tool === 'write_report_file' && output?.result) {
      renderChatMessage('tool', 'write_report_file', '', { input: record.input ?? null, output }, { reportPreview: output.result });
      continue;
    }
    renderChatMessage(stale ? 'stale' : failed ? 'error' : 'tool', record.tool || 'Browser action', stale ? 'The page changed; a fresh observation is ready for the next action.' : failed ? output.error || '' : '', { input: record.input ?? null, output }, { targetOutput: output });
  }
  if (!hasAssistant && conversation.summary) {
    renderChatMessage(conversation.success === false || conversation.status === 'failed' ? 'error' : 'assistant', conversation.summary);
    if (conversation.success !== false && conversation.status !== 'failed') lastAssistantReplyByRun.set(conversation.id, conversation.summary);
  }
  const restoredRun = {
    id: conversation.id,
    title: conversation.title || 'Saved conversation',
    status: conversation.status,
    step: 0,
    plan: Array.isArray(conversation.plan) ? conversation.plan : [],
    goals: Array.isArray(conversation.goals) ? conversation.goals : [],
    attemptId: conversation.attemptId,
    attemptSequence: conversation.attemptSequence,
    provider: conversation.providerConfig || { id: conversation.provider, model: conversation.model },
    messages: conversation.messages || [],
    result: { summary: conversation.summary || '', success: conversation.success === true, verified: conversation.verified === true, reason: conversation.reason || '' },
    eventRevision: conversation.eventRevision || 0
  };
  chatRun = null;
  renderChatState(restoredRun, { select: true });
  agentHistoryView.hidden = true;
  syncAgentOverlayScreenState();
}

// Saved conversations keep a bounded tail of every thinking card so a reopened
// transcript still shows what the agent was thinking, collapsed like the live
// card after it settled.
function renderHistoricalThought(record) {
  const item = document.createElement('article');
  item.className = 'agent-message is-assistant is-thought-history';
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  const rawElapsed = Number(record?.elapsedMs);
  const safeElapsed = Number.isFinite(rawElapsed) && rawElapsed >= 0 && rawElapsed <= MAX_ELAPSED_DISPLAY_MS ? rawElapsed : 0;
  summary.textContent = `Thought for ${Math.round(safeElapsed / 1000)}s`;
  const body = document.createElement('div');
  body.className = 'agent-thinking-content';
  // The archived card is the same user-facing surface as the live one: the
  // harness meta-talk must not reappear when a saved transcript is reopened.
  body.textContent = stripHarnessMeta(String(record?.text || '')).trim();
  details.append(summary, body);
  item.append(details);
  withTranscriptStick(() => agentTranscript.append(item));
}

function renderChatApproval(approval) {
  agentApproval.hidden = !approval;
  agentApproval.replaceChildren();
  if (!approval) return;
  const title = document.createElement('strong'); title.textContent = 'Approval required';
  const reason = document.createElement('p'); reason.textContent = approval.reason;
  const actions = document.createElement('div');
  for (const [decision, label] of [['deny', 'Deny'], ['allow_once', 'Allow once']]) {
    const button = document.createElement('button'); button.type = 'button'; button.className = decision === 'deny' ? 'plain-button is-danger' : 'save-button'; button.textContent = label;
    button.addEventListener('click', () => {
      const runId = currentActiveChatRun()?.id || chatRun?.id;
      if (!runId) return;
      window.browserUseDesktop.agentApprove({ runId, approvalId: approval.id, decision }).catch((error) => reportError(error, 'Could not resolve agent approval.'));
    });
    actions.append(button);
  }
  agentApproval.append(title, reason, actions);
}

function failureInspection(event) {
  return event.inspection || {
    input: event.args || event.run?.history?.at(-1)?.input || { notice: 'No command input was available.' },
    output: event.output || { ok: false, error: event.result?.summary || event.error || 'The agent run failed before it returned an action result.' }
  };
}

let activeThoughtMessage = null;
let activeThoughtTimer = null;
let emptyThoughtCardStreak = 0;
const lastAssistantReplyByRun = new Map();

function formatRunDuration(run) {
  // "Worked for" measures the CURRENT turn: the turn clock restarts when the
  // user sends a new command and carries across same-turn recovery. Falling
  // back to createdAt kept measuring from the conversation's first message.
  const startedAt = Number(run?.turnStartedAt || run?.createdAt || Date.now());
  const ms = Math.max(0, Number(run?.completedAt || Date.now()) - startedAt);
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor(ms / 1000) % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
// Run-footer usage: per-turn tokens IN/OUT (the ledger-lifetime counters are
// conversation-cumulative and live in usageLifetime), plus COST when the
// gateway prices the model. Every piece is omitted when unavailable — never
// a placeholder.
function formatRunUsage(run) {
  const usage = run?.usage || {};
  const format = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value);
  const parts = [];
  if (Number(usage.inputTokens) > 0) parts.push(`${format(Number(usage.inputTokens))} in`);
  if (Number(usage.outputTokens) > 0) parts.push(`${format(Number(usage.outputTokens))} out`);
  const cached = Number(usage.cachedTokens || 0);
  if (cached > 0) parts.push(`${format(cached)} cached`);
  const modelId = String(run?.provider?.model || '').trim();
  const price = modelId ? (providerModelPricing[pricingKeyForRun(run)]?.[modelId] || null) : null;
  if (price && Number(usage.inputTokens) > 0) {
    const cost = (Number(usage.inputTokens) * Number(price[0]) + Number(usage.outputTokens) * Number(price[1])) / 1_000_000;
    if (cost > 0) parts.push(`$${cost >= 1 ? cost.toFixed(2) : cost.toFixed(4)}`);
  }
  if (Number(usage.requests) > 0) parts.push(`${Number(usage.requests)} ${Number(usage.requests) === 1 ? 'request' : 'requests'}`);
  return parts.join(' · ');
}
function formatTokenCount(run) {
  const total = Number(run?.usage?.totalTokens || 0);
  if (!total) return '';
  const format = value => value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
    : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}K` : String(value);
  const cached = Number(run?.usage?.cachedTokens || 0);
  const breakdown = cached > 0 && cached < total ? ` (${format(cached)} cached)` : '';
  return `${format(total)}${breakdown}`;
}
function formatRunTime(run) {
  return new Date(run?.completedAt || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The completion event renders the summary with a telemetry suffix while the
// state fallback renders it bare; comparing on the stripped text keeps the
// terminal message from being submitted twice. The tail carries a variable
// number of "·" segments (tokens disappear when the provider reports no
// usage), so cut at the LAST " Worked for " marker instead of matching an
// exact three-segment shape.
function stripRunMetadata(text) {
  const raw = String(text || '');
  const at = raw.lastIndexOf(' Worked for ');
  if (at === -1 || !/^\s*Worked for .+\.\s*$/.test(raw.slice(at))) return raw.trim();
  return raw.slice(0, at).trim();
}
const lastAssistantCardByRun = new Map();
function appendRunMetadataOnce(card, run) {
  if (!card?.isConnected || card.querySelector('.agent-run-meta')) return;
  const workload = formatRunUsage(run);
  const meta = document.createElement('footer');
  meta.className = 'agent-run-meta';
  meta.textContent = `Worked for ${formatRunDuration(run)}${workload ? ` · ${workload}` : ''} · ${formatRunTime(run)}`;
  card.append(meta);
}

function renderAssistantReply(text, runId = chatRun?.id, kind = 'assistant') {
  const reply = String(text || '').trim();
  if (!reply) return;
  const conversationId = String(runId || '');
  // A run can deliver the same answer through assistant.message, browser_done,
  // run.completed, and the durable renderChatState fallback. The first real
  // card owns the reply; terminal/fallback paths must never append a second
  // assistant bubble for that conversation.
  const existingCard = conversationId ? lastAssistantCardByRun.get(conversationId) : null;
  if (existingCard && !existingCard.isConnected) lastAssistantCardByRun.delete(conversationId);
  if (lastAssistantReplyByRun.get(runId) === stripRunMetadata(reply)) {
    // The same terminal message re-delivered (done-tool summary, completion
    // event, durable state fallback). Upgrade the existing card in place to
    // the fullest variant instead of appending a duplicate submission card.
    const card = lastAssistantCardByRun.get(runId);
    const body = card?.isConnected ? card.querySelector(':scope > p') : null;
    if (body && reply.length > body.textContent.length) {
      // Re-render with markdown: assigning textContent here flattened the
      // formatted card back to raw "**" and "-" characters.
      body.classList.add('is-rich');
      body.replaceChildren(renderRichText(reply));
    }
    return;
  }
  const card = renderChatMessage(kind === 'system' ? 'system' : 'assistant', reply);
  lastAssistantReplyByRun.set(runId, stripRunMetadata(reply));
  lastAssistantCardByRun.set(runId, card);
}

// ---- Live connection strip -------------------------------------------
// Transport retry notices are transient: they live in a dedicated strip
// above the composer and clear themselves the moment the model is producing
// again (first streamed thought, a tool result, or a real reply), they are
// never permanent transcript entries.
const connectionNotice = document.querySelector('#connection-notice');
let connectionNoticeTimer = null;

function showConnectionNotice(text) {
  if (!connectionNotice) return;
  connectionNotice.textContent = text;
  connectionNotice.hidden = false;
  clearInterval(connectionNoticeTimer);
  connectionNoticeTimer = setInterval(() => {
    if (connectionNotice.hidden) return clearInterval(connectionNoticeTimer);
    connectionNotice.classList.add('is-pulsing');
    setTimeout(() => connectionNotice.classList.remove('is-pulsing'), 700);
  }, 4000);
}

function hideConnectionNotice() {
  if (!connectionNotice || connectionNotice.hidden) return;
  connectionNotice.hidden = true;
  clearInterval(connectionNoticeTimer);
}

function discardLiveThought() {
  if (activeThoughtTimer) clearInterval(activeThoughtTimer);
  activeThoughtTimer = null;
  activeThoughtMessage = null;
}

const MAX_ELAPSED_DISPLAY_MS = 24 * 60 * 60_000; // 24h
function liveThoughtElapsed(item, elapsedMs) {
  const startedAt = Number(item?.dataset.startedAt || Date.now());
  const previous = Number(item?.dataset.elapsedMs || 0);
  const supplied = Number(elapsedMs);
  // Guard: reject epoch-sized or negative values that would poison the card.
  const safePrevious = Number.isFinite(previous) && previous >= 0 && previous <= MAX_ELAPSED_DISPLAY_MS ? previous : 0;
  const safeSupplied = Number.isFinite(supplied) && supplied >= 0 && supplied <= MAX_ELAPSED_DISPLAY_MS ? supplied : 0;
  const elapsed = Math.max(
    0,
    safePrevious,
    safeSupplied,
    Math.min(Date.now() - startedAt, MAX_ELAPSED_DISPLAY_MS)
  );
  item.dataset.elapsedMs = String(elapsed);
  return elapsed;
}

function paintLiveThoughtElapsed(item, elapsedMs) {
  if (!item?.isConnected) return;
  const summary = item.querySelector('summary');
  if (!summary) return;
  summary.textContent = `Thinking… ${Math.floor(liveThoughtElapsed(item, elapsedMs) / 1000)}s`;
}

// LORDE_SUBAGENT_TABS_V366 (field fix) — card construction split from the
// main feed's card lifecycle so a subagent feed can host its OWN live card
// (one per run) instead of contending for the single global card.
function buildLiveThoughtCard(elapsedMs = 0, thoughtId = '') {
  const item = document.createElement('article');
  item.className = 'agent-message is-assistant is-thinking';
  if (thoughtId) item.dataset.thoughtId = String(thoughtId);
  const initialElapsed = Math.max(0, Number(elapsedMs) || 0);
  item.dataset.startedAt = String(Date.now() - initialElapsed);
  item.dataset.elapsedMs = String(initialElapsed);
  const details = document.createElement('details');
  details.open = true;
  const summary = document.createElement('summary'); summary.textContent = 'Thinking…';
  const body = document.createElement('div'); body.className = 'agent-thinking-content';
  details.append(summary, body); item.append(details);
  return item;
}

function liveThoughtCard(elapsedMs = 0, thoughtId = '') {
  const item = buildLiveThoughtCard(elapsedMs, thoughtId);
  withTranscriptStick(() => chatFeed().append(item));
  activeThoughtTimer = setInterval(() => {
    if (activeThoughtMessage === item && item.classList.contains('is-thinking')) paintLiveThoughtElapsed(item);
  }, 250);
  return item;
}

function updateLiveThought(text, elapsedMs, thoughtId = '') {
  // The thinking card grows in place; stickiness is judged before the growth
  // so a user who scrolled up is never dragged back down mid-stream.
  const stick = transcriptNearBottom();
  if (activeThoughtMessage && !activeThoughtMessage.isConnected) discardLiveThought();
  if (activeThoughtMessage && thoughtId && activeThoughtMessage.dataset.thoughtId && activeThoughtMessage.dataset.thoughtId !== thoughtId) settleLiveThought();
  if (!activeThoughtMessage) activeThoughtMessage = liveThoughtCard(elapsedMs, thoughtId);
  const body = activeThoughtMessage.querySelector('.agent-thinking-content');
  const actualThought = userFacingThought(text);
  if (actualThought) {
    body.replaceChildren(renderRichText(actualThought));
    body.dataset.hasThought = 'true';
    emptyThoughtCardStreak = 0;
    hideConnectionNotice();
  }
  paintLiveThoughtElapsed(activeThoughtMessage, elapsedMs);
  if (stick) { const feed = chatFeed(); feed.scrollTop = feed.scrollHeight; }
  updateTranscriptJumpButton();
}

function settleLiveThought(thinkingMs) {
  if (!activeThoughtMessage) return;
  if (activeThoughtTimer) clearInterval(activeThoughtTimer);
  activeThoughtTimer = null;
  const body = activeThoughtMessage.querySelector('.agent-thinking-content');
  const hasThought = body?.dataset.hasThought === 'true';
  if (!hasThought) {
    emptyThoughtCardStreak += 1;
    activeThoughtMessage.remove();
    activeThoughtMessage = null;
    // Some local/non-reasoning models emit no visible thought at all. Keep the
    // user informed without manufacturing an empty "Thought for Ns" card.
    if (emptyThoughtCardStreak >= 4) {
      renderChatMessage('assistant', 'Still working — this model is not streaming reasoning text.');
      emptyThoughtCardStreak = 0;
    }
    return;
  }
  const measuredMs = liveThoughtElapsed(activeThoughtMessage, thinkingMs);
  const seconds = Math.max(0, Math.round(measuredMs / 1000));
  const details = activeThoughtMessage.querySelector('details');
  const summary = activeThoughtMessage.querySelector('summary');
  details.open = false;
  summary.textContent = `Thought for ${seconds}s`;
  activeThoughtMessage.classList.remove('is-thinking');
  activeThoughtMessage = null;
}

// ---- LORDE_SUBAGENT_TABS_V366 — subagent tabs --------------------------
// The chat drawer gains a tab strip: a "Main" tab (the existing conversation,
// untouched) plus one tab per pool subagent published on state.agent.subagents
// ({ alias, status, task, tabId, runId }). A subagent tab shows THAT
// subagent's live feed, rendered with the exact same event renderers the main
// transcript uses, and the composer reroutes to subagentMessage/subagentStop.
const subagentBuffers = new Map();   // alias -> bounded event[] replay buffer
const subagentAliasSet = new Set();  // aliases currently published by state
const subagentRunIdAlias = new Map(); // roster runId -> alias (event claim fallback)
// FEATURE C (subagent task first): aliases whose feed buffer already carries
// the synthetic spawn.task first entry (seeded once per alias from the roster).
const subagentTaskSeeded = new Set();
let mainRunIdentity = '';            // agentIdentity carried by the coordinating run
let activeSubagentTab = 'main';
let subagentTabStrip = null;
let subagentFeedHost = null;
let subagentTabsKey = '';
const SUBAGENT_BUFFER_LIMIT = 500;
const SUBAGENT_TAB_STORAGE_PREFIX = 'lu-subagent-tab-';
const DEFAULT_TASK_PLACEHOLDER = agentTask?.dataset.placeholder || 'Reply to continue this session';

function subagentTabStorageKey() {
  return `${SUBAGENT_TAB_STORAGE_PREFIX}${standaloneChatWindowId || 'primary'}`;
}
function readStoredSubagentTab() {
  try { return localStorage.getItem(subagentTabStorageKey()) || 'main'; } catch { return 'main'; }
}
function writeStoredSubagentTab(alias) {
  try { localStorage.setItem(subagentTabStorageKey(), alias); } catch { /* storage unavailable */ }
}
activeSubagentTab = readStoredSubagentTab() || 'main';

function subagentEntries() {
  const list = Array.isArray(state?.agent?.subagents) ? state.agent.subagents : [];
  return list.filter((entry) => entry && String(entry.alias || '').trim());
}
function activeSubagentEntry() {
  if (activeSubagentTab === 'main') return null;
  return subagentEntries().find((entry) => String(entry.alias) === activeSubagentTab) || null;
}

function buildSubagentTabButton(entry, isActive) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `agent-subagent-tab${isActive ? ' is-active' : ''}`;
  button.dataset.subagentTab = String(entry.alias);
  button.setAttribute('role', 'tab');
  button.setAttribute('aria-selected', String(isActive));
  if (entry.alias === 'main') {
    button.title = 'Main conversation';
    button.append(document.createTextNode('Main'));
    return button;
  }
  const dot = document.createElement('span');
  dot.className = 'agent-subagent-dot';
  dot.dataset.status = String(entry.status || 'queued');
  const label = document.createElement('span');
  label.className = 'agent-subagent-tab-label';
  label.textContent = String(entry.alias);
  const close = document.createElement('span');
  close.className = 'agent-subagent-tab-close';
  close.setAttribute('role', 'button');
  close.setAttribute('aria-label', `Close subagent ${entry.alias}`);
  close.setAttribute('title', `Close ${entry.alias} (cancels its run, releases its tab)`);
  close.append(icon('x'));
  close.addEventListener('click', (event) => {
    // The × must not act as a tab-body click: stop the bubbling before the
    // tab strip's selection delegation sees it.
    event.stopPropagation();
    event.preventDefault();
    closeSubagentFromTab(String(entry.alias));
  });
  // The subagent's MODEL is visible at a glance — a model-targeted spawn
  // must be confirmable without opening anything (a spawn on gpt-6.1-sol
  // must never look like it silently ran on the parent's model).
  let modelBadge = null;
  if (entry.model) {
    modelBadge = document.createElement('span');
    modelBadge.className = 'agent-subagent-tab-model';
    modelBadge.textContent = String(entry.model).split('/').pop();
    modelBadge.title = `Running on ${entry.model}`;
  }
  button.title = `${entry.alias} · ${entry.status || 'queued'}${entry.model ? ` · ${entry.model}` : ''}`;
  button.append(dot, label, ...(modelBadge ? [modelBadge] : []), close);
  return button;
}


function ensureSubagentDom() {
  if (subagentTabStrip && subagentFeedHost && !agentForm) {
    return { strip: subagentTabStrip, feed: subagentFeedHost };
  }
  if (!subagentTabStrip) {
    subagentTabStrip = document.createElement('div');
    subagentTabStrip.className = 'agent-subagent-tabs';
    subagentTabStrip.id = 'agent-subagent-tabs';
    subagentTabStrip.setAttribute('role', 'tablist');
    subagentTabStrip.setAttribute('aria-label', 'Agent feeds');
    subagentTabStrip.hidden = true;
    subagentTabStrip.addEventListener('click', (event) => {
      const tab = event.target.closest('[data-subagent-tab]');
      if (tab) selectSubagentTab(tab.dataset.subagentTab);
    });
    agentTranscript.before(subagentTabStrip);
  }
  if (!subagentFeedHost) {
    subagentFeedHost = document.createElement('div');
    subagentFeedHost.className = 'agent-transcript agent-subagent-transcript';
    subagentFeedHost.id = 'agent-subagent-transcript';
    subagentFeedHost.setAttribute('aria-live', 'polite');
    subagentFeedHost.hidden = true;
    // Same stick-to-bottom accounting as the main transcript.
    subagentFeedHost.addEventListener('scroll', () => {
      if (chatFeed() !== subagentFeedHost) return;
      transcriptStickToBottom = transcriptNearBottom();
      if (transcriptStickToBottom) transcriptUnseenCount = 0;
      updateTranscriptJumpButton();
    }, { passive: true });
    observeFeedMessages(subagentFeedHost);
    agentTranscript.after(subagentFeedHost);
  }
  return { strip: subagentTabStrip, feed: subagentFeedHost };
}

function renderSubagentTabs() {
  const entries = subagentEntries();
  subagentAliasSet.clear();
  subagentRunIdAlias.clear();
  for (const entry of entries) {
    subagentAliasSet.add(String(entry.alias));
    const rosterRunId = String(entry.runId || '').trim();
    if (rosterRunId) subagentRunIdAlias.set(rosterRunId, String(entry.alias));
  }
  // FEATURE C — a subagent's feed ALWAYS starts with the spawning task text
  // (what the main agent asked it to do), never with a bare tool call or
  // thinking card. The roster entry carries the task (main.cjs publishes it);
  // seed each new alias's buffer with a synthetic spawn.task event BEFORE any
  // run events. If events raced ahead of the roster poll, unshift keeps the
  // task first and the active feed replays.
  for (const entry of entries) {
    const alias = String(entry.alias);
    const task = String(entry.task || '').trim();
    if (!task || subagentTaskSeeded.has(alias)) continue;
    subagentTaskSeeded.add(alias);
    const synthetic = { type: 'spawn.task', alias, task, at: Date.now() };
    const buffer = subagentBuffers.get(alias);
    if (buffer) {
      buffer.unshift(synthetic);
      if (buffer.length > SUBAGENT_BUFFER_LIMIT) buffer.splice(0, buffer.length - SUBAGENT_BUFFER_LIMIT);
      if (activeSubagentTab === alias) replaySubagentFeed(alias);
    } else {
      subagentBuffers.set(alias, [synthetic]);
    }
  }
  const dom = ensureSubagentDom();
  if (activeSubagentTab !== 'main' && !entries.some((entry) => String(entry.alias) === activeSubagentTab)) {
    activeSubagentTab = 'main';
    writeStoredSubagentTab('main');
  }
  dom.strip.hidden = entries.length === 0;
  const key = JSON.stringify([entries.map((entry) => [String(entry.alias), String(entry.status || '')]), activeSubagentTab, dom.strip.hidden]);
  if (key !== subagentTabsKey) {
    subagentTabsKey = key;
    const buttons = [buildSubagentTabButton({ alias: 'main' }, activeSubagentTab === 'main')];
    for (const entry of entries) buttons.push(buildSubagentTabButton({ alias: String(entry.alias), status: entry.status }, String(entry.alias) === activeSubagentTab));
    dom.strip.replaceChildren(...buttons);
  }
  const isSub = activeSubagentTab !== 'main';
  dom.feed.hidden = !isSub;
  agentTranscript.hidden = isSub;
  chatFeedHost = isSub ? dom.feed : null;
  updateSubagentComposer();
}

function selectSubagentTab(alias) {
  const next = alias || 'main';
  const changed = next !== activeSubagentTab;
  activeSubagentTab = next;
  writeStoredSubagentTab(next);
  if (changed) {
    // Any live thinking card belongs to the feed being left behind.
    settleLiveThought();
    transcriptStickToBottom = true;
    transcriptUnseenCount = 0;
    if (next !== 'main') replaySubagentFeed(next);
  }
  renderSubagentTabs();
  updateTranscriptJumpButton();
}

function replaySubagentFeed(alias) {
  const dom = ensureSubagentDom();
  const buffer = subagentBuffers.get(alias) || [];
  resetSubagentFeedState(alias);
  dom.feed.replaceChildren();
  const previousHost = chatFeedHost;
  chatFeedHost = dom.feed;
  try {
    for (const event of buffer) renderSubagentEvent(alias, event);
  } finally { chatFeedHost = previousHost; }
  dom.feed.scrollTop = dom.feed.scrollHeight;
}

// LORDE_SUBAGENT_TABS_V366 (field fix) — per-feed live-thought state. The
// main feed's live card is a single global; subagent feeds get their OWN
// card per alias so concurrent thinkers never settle/replace each other's
// cards (that contention was appending a new row on every ~750ms tick).
const subagentFeedState = new Map(); // alias -> { thoughtCard, thoughtTimer }
const subagentBusyByAlias = new Map(); // alias -> boolean (fresher than state polls)
function subagentFeedStateFor(alias) {
  let feedState = subagentFeedState.get(alias);
  if (!feedState) { feedState = {}; subagentFeedState.set(alias, feedState); }
  return feedState;
}
function resetSubagentFeedState(alias) {
  const feedState = subagentFeedState.get(alias);
  if (!feedState) return;
  if (feedState.thoughtTimer) { clearInterval(feedState.thoughtTimer); feedState.thoughtTimer = null; }
  feedState.thoughtCard = null;
}
function settleSubagentThought(alias, thinkingMs) {
  const feedState = subagentFeedStateFor(alias);
  if (!feedState.thoughtCard) return;
  if (feedState.thoughtTimer) { clearInterval(feedState.thoughtTimer); feedState.thoughtTimer = null; }
  const measuredMs = liveThoughtElapsed(feedState.thoughtCard, thinkingMs);
  const seconds = Math.max(0, Math.round(measuredMs / 1000));
  const details = feedState.thoughtCard.querySelector('details');
  const summary = feedState.thoughtCard.querySelector('summary');
  if (details) details.open = false;
  if (summary) summary.textContent = `Thought for ${seconds}s`;
  feedState.thoughtCard.classList.remove('is-thinking');
  feedState.thoughtCard = null;
}
function updateSubagentThought(alias, text, elapsedMs, thoughtId = '') {
  const feedState = subagentFeedStateFor(alias);
  const dom = ensureSubagentDom();
  const previousHost = chatFeedHost;
  chatFeedHost = dom.feed;
  try {
    // A replayed feed detaches the old card; a new thought id starts a new
    // decision. Both settle the previous card before (re)using the slot.
    if (feedState.thoughtCard && !feedState.thoughtCard.isConnected) {
      if (feedState.thoughtTimer) { clearInterval(feedState.thoughtTimer); feedState.thoughtTimer = null; }
      feedState.thoughtCard = null;
    }
    if (feedState.thoughtCard && thoughtId && feedState.thoughtCard.dataset.thoughtId && feedState.thoughtCard.dataset.thoughtId !== String(thoughtId)) {
      settleSubagentThought(alias);
    }
    if (!feedState.thoughtCard) {
      const item = buildLiveThoughtCard(0, thoughtId);
      withTranscriptStick(() => dom.feed.append(item));
      feedState.thoughtCard = item;
      feedState.thoughtTimer = setInterval(() => {
        if (feedState.thoughtCard && feedState.thoughtCard.isConnected && feedState.thoughtCard.classList.contains('is-thinking')) paintLiveThoughtElapsed(feedState.thoughtCard);
      }, 250);
    }
    const body = feedState.thoughtCard.querySelector('.agent-thinking-content');
    const actualThought = userFacingThought(text);
    if (body && actualThought) {
      body.replaceChildren(renderRichText(actualThought));
      body.dataset.hasThought = 'true';
    }
    paintLiveThoughtElapsed(feedState.thoughtCard, elapsedMs);
  } finally { chatFeedHost = previousHost; }
  updateTranscriptJumpButton();
}
function noteSubagentActivity(alias, runStatus) {
  subagentBusyByAlias.set(String(alias), ['running', 'awaiting_approval', 'paused', 'awaiting_recovery'].includes(String(runStatus)));
}

function bufferSubagentEvent(alias, event) {
  if (!alias) return;
  let buffer = subagentBuffers.get(alias);
  if (!buffer) { buffer = []; subagentBuffers.set(alias, buffer); }
  // Live-thought ticks collapse: consecutive 'assistant.thinking' events
  // update ONE live card, so the buffer keeps only the first of a run of
  // ticks (replay fidelity without hundreds of ticks crowding out real
  // events). Rendering is untouched: live ticks still render every time.
  const isConsecutiveTick = event?.type === 'assistant.thinking'
    && buffer.length > 0
    && buffer[buffer.length - 1]?.type === 'assistant.thinking';
  if (!isConsecutiveTick) {
    buffer.push(event);
    if (buffer.length > SUBAGENT_BUFFER_LIMIT) buffer.splice(0, buffer.length - SUBAGENT_BUFFER_LIMIT);
  }
  if (event?.run?.status) noteSubagentActivity(alias, event.run.status);
  if (event?.type === 'spawn.finished') subagentBusyByAlias.set(String(alias), false);
  if (event?.type === 'spawn.closed') subagentBusyByAlias.delete(String(alias));
  if (activeSubagentTab === alias) {
    const dom = ensureSubagentDom();
    const previousHost = chatFeedHost;
    chatFeedHost = dom.feed;
    try { renderSubagentEvent(alias, event); }
    finally { chatFeedHost = previousHost; }
    // The action row's button states follow the freshest signal available
    // (event run status), not just the last state poll.
    updateSubagentComposer();
  }
}

// An agent event belongs to a subagent feed when its run carries an
// agentIdentity that state publishes as a pool alias (or that already owns a
// buffer), OR when its run id matches a roster entry's runId. Identity strings
// belonging to the coordinating conversation are recorded, never buffered.
function eventSubagentAlias(event) {
  const identity = String(event?.run?.agentIdentity || '').trim();
  if (!identity) return '';
  if (subagentAliasSet.has(identity) || subagentBuffers.has(identity)) return identity;
  const runId = String(event?.run?.id || '');
  // Roster runId match: a subagent's events are claimed for its alias even if
  // the run's agentIdentity was not preserved on this particular event.
  if (runId && subagentRunIdAlias.has(runId)) return subagentRunIdAlias.get(runId);
  if (runId && (runId === visibleConversationId || runId === chatRun?.id || runId === currentActiveChatRun()?.id)) {
    mainRunIdentity = identity;
    return '';
  }
  // A run.started with an UNKNOWN identity is never lazily claimed as a
  // subagent: misrouting the coordinating run's start would steal the main
  // feed. Only state-published aliases may claim it.
  if (event?.type === 'run.started') return '';
  if (mainRunIdentity && identity !== mainRunIdentity) return identity;
  return '';
}

function updateSubagentComposer() {
  const dom = ensureSubagentDom();
  const entry = activeSubagentEntry();
  const isSub = Boolean(entry);
  // LORDE_SUBAGENT_TABS_V369 — the extra action strip is GONE: the subagent
  // composer is identical to the main one. The ORIGINAL controls carry the
  // function instead: submit routes to the active subagent, and the main
  // Stop button stops the active subagent (state refreshed right below).
  if (isSub) {
    const cachedBusy = subagentBusyByAlias.get(String(entry.alias));
    const running = typeof cachedBusy === 'boolean' ? cachedBusy : String(entry.status || '') === 'running';
    subagentBusyByAlias.set(String(entry.alias), running);
    if (agentTask) agentTask.dataset.placeholder = `Message ${entry.alias}…`;
  } else {
    if (dom.actions) dom.actions.classList.remove('is-running');
    if (agentTask) agentTask.dataset.placeholder = DEFAULT_TASK_PLACEHOLDER;
  }
}

// Subagent composer: the typed text routes through subagentMessage with the
// mode carried by the button that submitted it (Enter = deliver).
function submitSubagentMessage(mode = 'deliver') {
  if (activeSubagentTab === 'main') return;
  const alias = activeSubagentTab;
  const text = agentTask.value.trim();
  if (!text) return;
  agentTask.value = '';
  const dom = ensureSubagentDom();
  const previousHost = chatFeedHost;
  chatFeedHost = dom.feed;
  try { renderChatMessage('user', text); }
  finally { chatFeedHost = previousHost; }
  void (async () => {
    try {
      const result = await window.browserUseDesktop.subagentMessage({ alias, text, mode });
      if (result?.note) showToast(result.note, 3600);
    } catch (error) {
      reportError(error, `Could not message ${alias}.`);
      // Put the text back so nothing the user typed is lost on a failure.
      agentTask.value = agentTask.value ? `${text}\n${agentTask.value}` : text;
    }
  })();
}

function stopActiveSubagent() {
  if (activeSubagentTab === 'main') return;
  const alias = activeSubagentTab;
  void (async () => {
    try {
      const result = await window.browserUseDesktop.subagentStop(alias);
      if (result?.note) showToast(result.note, 3600);
      // Stop accepted: the busy cache clears immediately so the row flips to
      // its idle shape even before the state broadcast lands.
      if (result?.stopped !== false) subagentBusyByAlias.set(String(alias), false);
      // (d) Re-poll immediately so the action row updates instantly instead
      // of waiting for the next background state push.
      const fresh = await window.browserUseDesktop.state().catch(() => null);
      if (fresh) render(fresh);
      else updateSubagentComposer();
    } catch (error) {
      reportError(error, `Could not stop ${alias}.`);
      updateSubagentComposer();
    }
  })();
}

// × on a subagent tab: closes that subagent entirely through the same main
// path as subagent_close (active run cancelled, tab released, worktree rules
// respected). Never triggered by clicking the tab body.
function closeSubagentFromTab(alias) {
  void (async () => {
    try {
      const result = await window.browserUseDesktop.subagentClose(alias);
      if (result?.note) showToast(result.note, 3600);
      subagentBusyByAlias.delete(String(alias));
      const fresh = await window.browserUseDesktop.state().catch(() => null);
      if (fresh) render(fresh);
    } catch (error) {
      reportError(error, `Could not close ${alias}.`);
    }
  })();
}

// Subagent feed renderer: mirrors the main feed's event branches with the SAME
// leaf renderers (thinking cards, assistant replies, tool rows, media cards,
// run metadata) so formatting is identical. Run-state bookkeeping
// (renderChatState, plans, approvals) stays main-run-only.
function renderSubagentEvent(alias, event) {
  switch (event?.type) {
    case 'spawn.task': {
      // FEATURE C — the spawning prompt renders as the feed's first entry, in
      // the user-message style: the always-visible answer to "why does this
      // worker exist".
      settleSubagentThought(alias);
      renderChatMessage('user', String(event.task || '').slice(0, 4000));
      return;
    }
    case 'spawn.finished': {
      settleSubagentThought(alias, event.thinkingMs);
      const firstLine = String(event.error || event.summary || '').trim().split('\n')[0].slice(0, 200);
      renderChatMessage('agent-message', `Subagent ${String(event.alias || '')} ${String(event.status || 'finished')}`, firstLine,
        null, { badge: 'subagent' });
      return;
    }
    case 'agent.message': {
      const fromLabel = String(event.fromLabel || 'another session');
      const header = fromLabel.startsWith('subagent ')
        ? fromLabel.slice(0, 60)
        : `${event.reply ? 'Reply to' : 'From'} "${fromLabel.slice(0, 60)}"`;
      renderChatMessage('agent-message', header, String(event.text || ''),
        null, { badge: fromLabel.startsWith('subagent ') ? 'subagent' : 'agent' });
      return;
    }
    // Live-thought events collapse into ONE card per feed (this alias's own
    // card), never appending rows — the exact bug the main feed never had.
    case 'assistant.thinking':
      if (Number(event.elapsedMs) === 0) settleSubagentThought(alias);
      updateSubagentThought(alias, '', event.elapsedMs, event.thoughtId);
      return;
    case 'assistant.thought':
      updateSubagentThought(alias, event.text, event.elapsedMs, event.thoughtId);
      return;
    case 'assistant.thinking.completed':
      settleSubagentThought(alias, event.elapsedMs);
      return;
    case 'assistant.thought.stamp': {
      if (event.run?.telemetryDetailed === false) return;
      const stamp = document.createElement('time');
      stamp.className = 'agent-thought-stamp';
      stamp.textContent = `Thought for ${Math.max(0, Math.round(Number(event.elapsedMs || 0) / 1000))}s · ${new Date(event.at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
      withTranscriptStick(() => chatFeed().append(stamp));
      return;
    }
    case 'assistant.message':
      if (event.transient) return;
      settleSubagentThought(alias, event.thinkingMs);
      renderAssistantReply(event.text, event.run?.id, event.kind);
      return;
    case 'tool.result': {
      settleSubagentThought(alias);
      if (event.tool === 'browser_done') {
        if (event.output?.ok) renderAssistantReply(event.output?.summary, event.run?.id);
        return;
      }
      if (event.tool === 'update_plan' || event.tool === 'create_plan' || event.tool === 'agent_advisory' || event.tool === 'agent_recovery') return;
      const stale = event.output?.state === 'stale' && event.output?.recoverable;
      if (stale) return;
      if (event.output?.ok !== true) {
        // FORENSIC VISIBILITY (run-forensics 2026-10-15, audit A): failed and
        // recoverable tool results used to VANISH here — 8+ patch attempts
        // and 2 done-rejections appeared nowhere in an exported run, so every
        // visible patch read "applied: true" and no audit could see the
        // failure storm. Render a compact failure row; collapse exact
        // consecutive repeats so a recovery storm stays one visible line.
        const errorText = String(event.output?.error || event.output?.result?.error || 'failed').replace(/\s+/g, ' ').trim().slice(0, 300);
        const key = `${event.tool}:${errorText}`;
        const last = chatFeed()?.lastElementChild;
        if (last?.dataset?.failureKey !== key) {
          const item = renderChatMessage('error', `${event.tool} failed`, errorText);
          if (item?.dataset) item.dataset.failureKey = key;
        }
        return;
      }
      const screenshotPreview = ['browser_screenshot', 'computer_screenshot'].includes(event.tool) ? event.screenshotPreview : null;
      const reportPreview = event.tool === 'write_report_file' ? event.output?.result : null;
      const liveMedia = event.output?.media && ['image', 'video', 'audio'].includes(event.output.media.kind) ? event.output.media : null;
      if (liveMedia) {
        const actionText = liveMedia.kind === 'video' ? 'generated a video' : liveMedia.kind === 'audio' ? 'generated audio' : 'generated an image';
        const item = buildMediaMessage(actionText, { ...liveMedia, filename: liveMedia.filename || mediaFilename(liveMedia.kind) }, liveMedia.kind === 'audio' ? buildAudioNote : buildMediaCard);
        withTranscriptStick(() => chatFeed().append(item));
        return;
      }
      // ask_user renders as a visible question card, not a generic tool row.
      // The question and options are shown inline so the user can read them.
      if (event.tool === 'ask_user') {
        const askResult = event.output?.result || event.output;
        if (askResult && askResult.asked) {
          const item = document.createElement('article');
          item.className = 'agent-message is-tool is-ask';
          const header = document.createElement('header');
          const label = document.createElement('strong'); label.textContent = 'Question';
          const pointer = document.createElement('span'); pointer.className = 'agent-action-pointer'; pointer.append(icon('question'));
          const actionName = document.createElement('span'); actionName.className = 'agent-action-name'; actionName.textContent = 'needs your answer';
          header.replaceChildren(pointer, label, actionName);
          item.append(header);
          item.append(renderAskUserCard(askResult));
          withTranscriptStick(() => chatFeed().append(item));
          return;
        }
      }
      renderChatMessage('tool', event.tool, event.output?.error || '', event.inspection || null, { screenshotPreview, reportPreview, targetOutput: event.output });
      return;
    }
    case 'run.failed':
      settleSubagentThought(alias);
      renderChatMessage('error', 'Agent run failed', event.result?.summary || event.error || 'The agent stopped with an actionable provider or cancellation error.', failureInspection(event));
      return;
    case 'run.completed': {
      settleSubagentThought(alias);
      const workload = formatRunUsage(event.run);
      if (event.result?.summary) renderAssistantReply(event.result?.summary, event.run?.id);
      if (event.run?.telemetryDetailed !== false) {
        const card = lastAssistantCardByRun.get(event.run?.id);
        if (card?.isConnected) {
          const meta = document.createElement('footer');
          meta.className = 'agent-run-meta';
          meta.textContent = `Worked for ${formatRunDuration(event.run)}${workload ? ` · ${workload}` : ''} · ${formatRunTime(event.run)}`;
          card.append(meta);
        }
      }
      return;
    }
    case 'run.cancelled':
      settleSubagentThought(alias);
      return;
    case 'run.title': {
      // LORDE_AI_CHAT_TITLES_V1 — the model renamed the conversation as the
      // chat evolved. Update the header + history silently (no chat card).
      const nextTitle = String(event.title || '').trim();
      if (nextTitle) {
        if (activeChatRun?.id && event.run?.id === activeChatRun.id) {
          activeChatRun.title = nextTitle;
          renderChatState(activeChatRun);
        }
        if (!agentHistoryView.hidden) void renderAgentHistory();
      }
      return;
    }
    default: {
      // LORDE_SUBAGENT_TABS_V366 — never silent: a matched subagent event with
      // no dedicated branch (run.started, plan.updated, decision.*, approval.*,
      // user.message.*) still renders a compact card so the tab always shows
      // progress.
      const detail = [event.summary, event.note, event.text, event.message, event.error]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
        .join(' — ')
        .slice(0, 400);
      renderChatMessage('tool', String(event.type || 'event'), detail);
      return;
    }
  }
}

// LORDE_WAIT_LIVE_V369 — a browser_wait publishes tool.started up to 15
// minutes before its result: render a live card with an elapsed timer so the
// chat never looks dead. One card per run; cleared by the wait's tool.result
// or any terminal event. Not buffered (replay shows the real result).
// LORDE_TOOL_HEARTBEAT — generalized: ANY long tool now streams tool.progress
// (computer_model generation, computer_index, computer_search, terminal jobs),
// so the run shows a live elapsed card whenever a tool runs long. The user
// must never wonder whether a silent run crashed.
const liveWaitCards = new Map(); // runId -> { el, timer }
function showProgressCard(runId, toolName, note) {
  const runIdStr = String(runId || 'run');
  clearWaitCard(runIdStr);
  const el = document.createElement('div');
  el.className = 'agent-wait-card';
  const spinner = document.createElement('span');
  spinner.className = 'agent-wait-spinner';
  const text = document.createElement('span');
  text.className = 'agent-wait-text';
  el.append(spinner, text);
  const started = Date.now() - Math.max(0, Number(note?.elapsedMs) || 0);
  const tick = () => { text.textContent = note?.label || `Working ${Math.round((Date.now() - started) / 1000)}s — ${toolName} still running (the run is alive)`; };
  tick();
  const timer = setInterval(tick, 1000);
  liveWaitCards.set(runIdStr, { el, timer });
  chatFeed().append(el);
  chatFeed().scrollTop = chatFeed().scrollHeight;
}
function showWaitCard(event) {
  showProgressCard(event.run?.id, 'browser_wait', {});
}
function clearWaitCard(runId) {
  const card = liveWaitCards.get(String(runId));
  if (!card) return;
  clearInterval(card.timer);
  card.el.remove();
  liveWaitCards.delete(String(runId));
}

function handleAgentEvent(event) {
  // GEN9: /notebook (agent slash) publishes notebook.open — show the editable
  // popup over the run's persistent notebook file.
  if (event.type === 'notebook.open' && event.path) {
    window.browserUseDesktop.notebookOpen(event.path).catch(() => { /* the popup is best-effort; the path is already in the chat */ });
    return;
  }
  if (event.type === 'tool.started' && event.tool === 'browser_wait') {
    const alias = eventSubagentAlias(event);
    const viewing = activeSubagentTab === 'main' ? !alias : alias === activeSubagentTab;
    if (viewing) showWaitCard(event);
    return;
  }
  // TOOL HEARTBEAT: any tool running >4s keeps the run visibly alive.
  if (event.type === 'tool.progress') {
    const alias = eventSubagentAlias(event);
    const viewing = activeSubagentTab === 'main' ? !alias : alias === activeSubagentTab;
    if (viewing && event.tool === 'computer_patch' && event.live) {
      const file = String(event.path || '').split(/[\\/]/).pop() || 'file';
      showProgressCard(event.run?.id, `computer_patch (${file}) (+${Number(event.addedLines || 0)}) (−${Number(event.removedLines || 0)})`, { label: `Writing line ${event.line || '…'} · op ${event.op || '…'}/${event.totalOps || '…'}` });
      return;
    }
    if (viewing && Number(event.elapsedMs) >= 3000) showProgressCard(event.run?.id, String(event.tool || 'tool'), { elapsedMs: event.elapsedMs });
    return;
  }
  if (event.type === 'tool.result' && event.tool === 'browser_wait') clearWaitCard(event.run?.id);
  if (event.type === 'tool.result') clearWaitCard(event.run?.id);
  if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) clearWaitCard(event.run?.id);
  if (event.type === 'spawn.finished') {
    settleLiveThought();
    // LORDE_SUBAGENT_TABS_V366 — the terminal event also lands in that
    // subagent's tab feed (buffered, and rendered live if its tab is open).
    const finishedAlias = String(event.alias || '').trim();
    if (finishedAlias) bufferSubagentEvent(finishedAlias, event);
    // A short pill only — the full findings arrive as a structured
    // agent.message card; a toast carrying the whole report overflowed
    // the window and read as an unformatted wall.
    const firstLine = String(event.error || event.summary || '').trim().split('\n')[0].slice(0, 120);
    showToast(`Subagent ${String(event.alias || '').trim()} ${String(event.status || 'finished')}${firstLine ? ` — ${firstLine}` : ''}`, 3600);
    void renderSchedules();
    return;
  }
  if (event.type === 'spawn.closed') {
    // Carries `alias` with no run object: still lands in that subagent's feed
    // (the tab itself disappears on the next state refresh).
    const closedAlias = String(event.alias || '').trim();
    if (closedAlias) bufferSubagentEvent(closedAlias, event);
    return;
  }
  // Coordination events belong to the visible chat surface, not to the
  // currently selected conversation filter. A closed/idle Chat 1 must still
  // show the bubble and increment its toolbar badge when another agent writes.
  if (event.type === 'agent.message') {
    // LORDE_SUBAGENT_TABS_V366 — a coordination message authored by a pool
    // subagent also lands in that subagent's tab feed. The main card below
    // always renders into the MAIN transcript, even while a subagent tab
    // hosts the visible feed.
    const messageAlias = eventSubagentAlias(event);
    if (messageAlias) bufferSubagentEvent(messageAlias, event);
    const previousHost = chatFeedHost;
    chatFeedHost = null;
    try {
      settleLiveThought(event.thinkingMs);
      if (activeDrawer !== 'agent') agentMessageUnseenCount = Math.min(100, agentMessageUnseenCount + 1);
      const fromLabel = String(event.fromLabel || 'another session');
      const header = fromLabel.startsWith('subagent ')
        ? fromLabel.slice(0, 60)
        : `${event.reply ? 'Reply to' : 'From'} "${fromLabel.slice(0, 60)}"`;
      renderChatMessage('agent-message', header, String(event.text || ''),
        null, { badge: fromLabel.startsWith('subagent ') ? 'subagent' : 'agent' });
      updateTranscriptJumpButton();
    } finally { chatFeedHost = previousHost; }
    return;
  }
  // LORDE_SUBAGENT_TABS_V366 — events carrying a pool subagent's identity
  // belong to that subagent's tab: buffer them (and render live when its tab
  // is open), then stop. They never touch main-run state or the main feed.
  const subagentAlias = eventSubagentAlias(event);
  if (subagentAlias) {
    bufferSubagentEvent(subagentAlias, event);
    return;
  }
  // Main-run event: every transcript append below belongs to the main feed,
  // even while a subagent tab is showing (that feed ignores them per spec).
  chatFeedHost = null;
  const eventConversationId = String(event?.run?.id || '');
  if (eventConversationId && retiredConversationIds.has(eventConversationId)) return;
  if (eventConversationId && visibleConversationId && eventConversationId !== visibleConversationId) {
    // The visible transcript may be a saved conversation while another run is
    // active. Keep that run controllable without attaching its tasks or thought
    // stream to the conversation the user is reading.
    if (currentActiveChatRun()?.id === eventConversationId && !olderChatSnapshot({ ...event.run, eventRevision: event.revision }, activeChatRun)) {
      activeChatRun = { ...(activeChatRun || {}), ...(event.run || {}), eventRevision: event.revision || activeChatRun?.eventRevision || 0 };
      renderChatControls();
    }
    return;
  }
  // If the renderer missed run.started during a drawer/window remount, do not
  // drop the subsequent live tool/thought events. Claim the first main-run
  // event as the visible conversation when no saved conversation is selected;
  // otherwise the action cards exist in history but appear only after reload.
  if (eventConversationId && !visibleConversationId) {
    visibleConversationId = eventConversationId;
    allowInitialChatSnapshot = false;
  }
  // LORDE_SUBAGENT_TABS_V366 — remember the coordinating run's agentIdentity
  // so identities that were never published as pool aliases are still
  // recognized as main-run identities (not subagent feeds).
  if (event.run?.agentIdentity && eventConversationId && eventConversationId === visibleConversationId) {
    mainRunIdentity = String(event.run.agentIdentity);
  }
  const eventTargetsActiveRun = Boolean(eventConversationId && currentActiveChatRun()?.id === eventConversationId);
  if (event?.revision && chatRun?.eventRevision && event.revision < chatRun.eventRevision && Number(event.run?.attemptSequence || 0) <= Number(chatRun.attemptSequence || 0)) return;
  const eventBase = eventTargetsActiveRun ? currentActiveChatRun() : chatRun;
  const eventRun = event.run ? { ...(eventBase || {}), ...event.run, eventRevision: event.revision || eventBase?.eventRevision || 0 } : eventBase;
  if (renderChatState(eventRun, { select: event.type === 'run.started' && !visibleConversationId }) === false) return;
  if (event.type === 'assistant.thinking') {
    // elapsed 0 is the explicit start of a provider decision. Recovery can
    // begin a new decision without an intervening tool result, so preserve and
    // settle any prior live card instead of letting the new stream replace it.
    if (Number(event.elapsedMs) === 0 && activeThoughtMessage) settleLiveThought();
    updateLiveThought('', event.elapsedMs, event.thoughtId);
    return;
  }
  if (event.type === 'assistant.thought') { hideConnectionNotice(); updateLiveThought(event.text, event.elapsedMs, event.thoughtId); return; }
  if (event.type === 'user.message.delivered') {
    // A BADGED delivery is content from another producer (a research brief,
    // a subagent's findings), not something the user typed. It renders as a
    // marked card so it can be told apart from the agent's own voice.
    if (event.badge && event.content) {
      settleLiveThought(event.thinkingMs);
      renderChatMessage('agent-message', '', String(event.content), null, { badge: String(event.badge) });
      updateTranscriptJumpButton();
    }
    return;
  }
  if (event.type === 'assistant.thinking.completed') { hideConnectionNotice(); settleLiveThought(event.elapsedMs); return; }
  if (event.type === 'assistant.progress') {
    hideConnectionNotice();
    settleLiveThought();
    renderChatMessage('assistant', String(event.text || 'Still working…'));
    return;
  }
  if (event.type === 'user.input.required') { hideConnectionNotice(); settleLiveThought(); renderPendingQuestion(event); return; }
  if (event.type === 'user.input.received') { settlePendingQuestion(event); return; }
  if (event.type === 'assistant.thought.stamp') {
    if (event.run?.telemetryDetailed === false) return;
    const stamp = document.createElement('time');
    stamp.className = 'agent-thought-stamp';
    stamp.textContent = `Thought for ${Math.max(0, Math.round(Number(event.elapsedMs || 0) / 1000))}s · ${new Date(event.at || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
    withTranscriptStick(() => agentTranscript.append(stamp));
    return;
  }
  if (event.type === 'assistant.message') {
    // A transient connection notice replaces itself in the strip above the
    // composer and never lands in the transcript.
    if (event.transient) { showConnectionNotice(event.text); return; }
    hideConnectionNotice();
    settleLiveThought(event.thinkingMs);
    renderAssistantReply(event.text, event.run?.id, event.kind);
  }
  if (event.type === 'tool.result') {
    // The model produced and executed a decision: any connection strip is
    // stale, the connection is demonstrably working again.
    hideConnectionNotice();
    // A decision-complete event normally arrives first. This is a defensive
    // boundary for delayed/dropped IPC so a tool can never inherit a live
    // thinking card from an earlier phase.
    settleLiveThought();
    if (event.tool === 'browser_done') {
      // Only an executor-accepted terminal summary is a user-facing reply. A
      // rejected done attempt (completion review) is internal recovery
      // context: the thinking stream simply continues, and no error card
      // belongs in the user feed. The next decision or run outcome speaks.
      if (event.output?.ok) renderAssistantReply(event.output?.summary, event.run?.id);
      return;
    }
    // The live question card (user.input.required) already showed this ask_user
    // and its answer; a second generic tool row would duplicate it.
    if (event.tool === 'ask_user' && event.output?.ok) return;
    // Task bookkeeping lives in the floating plan surface. Rendering every
    // update_plan call as a transcript action duplicates the plan and breaks a
    // single planning phase into noisy micro-beats.
    if (event.tool === 'update_plan' || event.tool === 'create_plan' || event.tool === 'agent_advisory' || event.tool === 'agent_recovery') return;
    const stale = event.output?.state === 'stale' && event.output?.recoverable;
    // Recoverable hiccups (stale element, interrupted pointer, duplicate
    // suppression, action timeouts) are agent bookkeeping, not user-facing
    // outcomes: the live thinking card already communicates that work
    // continues. Only non-recoverable failures render an error card.
    if (event.output?.recoverable === true && event.output?.ok !== true) return;
    const failed = !stale && !event.output?.ok;
    // Mid-run failures and stale-observation notices are internal recovery
    // context: the agent receives the full error and adjusts; the user has
    // no control over them, so they never bleed into the transcript. The
    // run's terminal outcome (run.completed / run.failed) is the user-facing
    // signal, and every entry stays visible in the console panel.
    if (stale || failed) return;
    // Both screenshot surfaces render the real image in chat: the desktop
    // capture (computer_screenshot) belongs in the transcript exactly like a
    // browser tab capture, text-only previews hid what the agent saw.
    const screenshotPreview = !failed && ['browser_screenshot', 'computer_screenshot'].includes(event.tool) ? event.screenshotPreview : null;
    const reportPreview = !failed && event.tool === 'write_report_file' ? event.output?.result : null;
    // Generated media (computer_model) renders as the SAME interactive card
    // live that history rebuild shows — without this branch the image only
    // appeared after the agent was closed and reopened (history rebuild had
    // a media path; the live feed fell through to a generic tool row).
    const liveMedia = !failed && event.output?.media && ['image', 'video', 'audio'].includes(event.output.media.kind) ? event.output.media : null;
    if (liveMedia) {
      const actionText = liveMedia.kind === 'video' ? 'generated a video' : liveMedia.kind === 'audio' ? 'generated audio' : 'generated an image';
      const item = buildMediaMessage(actionText, { ...liveMedia, filename: liveMedia.filename || mediaFilename(liveMedia.kind) }, liveMedia.kind === 'audio' ? buildAudioNote : buildMediaCard);
      withTranscriptStick(() => agentTranscript.append(item));
      return;
    }
    renderChatMessage(
      stale ? 'stale' : failed ? 'error' : 'tool',
      event.tool,
      stale ? 'The page changed; a fresh observation is ready for the next action.' : event.output?.error || '',
      screenshotPreview ? null : stale || failed ? failureInspection(event) : event.inspection || null,
      { screenshotPreview, reportPreview }
    );
  }
  // Recovery is internal control flow. It updates run state and console,
  // but never becomes a plan, assistant message, or transcript card. Continue
  // through the normal state merge so awaiting_recovery becomes resumable.
  if (event.type === 'run.failed') {
    settleLiveThought();
    renderChatMessage('error', 'Agent run failed', event.result?.summary || event.error || 'The agent stopped with an actionable provider or cancellation error.', failureInspection(event));
  }
  if (event.type === 'run.completed') {
    settleLiveThought();
    if (event.result?.summary) renderAssistantReply(event.result.summary, event.run?.id);
    // LORDE_RUN_META_FOOTER_V364 — time/tokens/requests render once on the
    // reply card, even when completion and state fallback arrive together.
    if (event.run?.telemetryDetailed !== false) appendRunMetadataOnce(lastAssistantCardByRun.get(event.run?.id || chatRun?.id), event.run);
  }
  if (event.type === 'run.cancelled') settleLiveThought();
  renderChatApproval(event.approval || event.run?.pendingApproval);
}

function reportError(error, fallback) {
  renderConsole([{ time: new Date().toISOString(), kind: 'error', level: 'error', message: error?.message || fallback }, ...consoleEntries]);
}

function flashLabel(button, label, restore) {
  button.textContent = label;
  setTimeout(() => { button.textContent = restore; }, COPY_FEEDBACK_MS);
}

function flashCopyIcon(button) {
  button.classList.add('is-copied');
  setTimeout(() => button.classList.remove('is-copied'), COPY_FEEDBACK_MS);
}

function syncAgentOverlayScreenState() {
  const drawer = agentPanel;
  if (!drawer) return;
  // Full-screen child screens (settings/history/schedules/record/skills)
  // own the drawer surface. Chat-only overlays must not paint or receive
  // pointer input above them, even if a plan/error/scroll state remains live.
  const screenIds = ['agent-settings-screen', 'agent-history-view', 'agent-schedules-view', 'agent-record-view', 'agent-skills-view'];
  const screenOpen = screenIds.some((id) => {
    const node = document.querySelector(`#${id}`);
    return node && !node.hidden;
  });
  drawer.classList.toggle('is-overlay-screen-open', screenOpen);
  // Keep the notice's live state intact while a full-screen child screen is
  // open; CSS suppresses its paint/pointer surface and closing the screen
  // restores the same error instead of losing it.
  updateTranscriptJumpButton();
}

function renderDrawers() {
  for (const [name, panel] of Object.entries(DRAWER_PANELS)) {
    const isOpen = activeDrawer === name;
    panel.hidden = name !== 'agent' || !isOpen;
    DRAWER_TOGGLES[name].setAttribute('aria-expanded', String(isOpen));
    DRAWER_TOGGLES[name].classList.toggle('is-active', isOpen);
    if (name === 'agent' && !isOpen && agentSettingsScreen) {
      agentSettingsScreen.hidden = true;
      agentSettingsToggle?.setAttribute('aria-expanded', 'false');
    }
  }
  const recorderOpen = activeDrawer === 'recorder';
  recordingToggle?.setAttribute('aria-expanded', String(recorderOpen));
  recordingToggle?.classList.toggle('is-active', recorderOpen);
  document.body.classList.toggle('has-drawer', activeDrawer !== null);
  syncAgentOverlayScreenState();
}

// Preview fallback: the shimmed bridge echoes drawer requests back as an
// event so direct setActiveDrawer callers update local state too.
window.addEventListener('browseruse-fallback-drawer', (event) => {
  if (activeDrawer === event.detail) return;
  activeDrawer = event.detail;
  renderDrawers();
});

async function applyDrawer(nextDrawer) {
  if (nextDrawer === activeDrawer) return;
  await window.browserUseDesktop.setActiveDrawer(nextDrawer);
  activeDrawer = nextDrawer;
  renderDrawers();
}

function requestDrawer(nextDrawer) {
  drawerQueue = drawerQueue
    .then(() => applyDrawer(nextDrawer))
    .catch((error) => reportError(error, 'Could not update the browser view.'));
  return drawerQueue;
}

function toggleDrawer(name) {
  return requestDrawer(activeDrawer === name ? null : name);
}

function renderConsole(entries) {
  consoleEntries = entries || [];
  window.BrowserUseSurfaces.renderConsole(consoleList, consoleEmpty, consoleEntries, consoleFilter, state?.tabs || []);
}

function agentLabel(nextState) {
  if (nextState.active?.loading) return 'Loading';
  if (nextState.agent?.status === 'mcp-connected') return 'MCP connected';
  if (mcpStatus.pairing?.active) return 'Pairing open';
  if (mcpStatus.listening) return 'Local MCP waiting';
  return 'Local MCP offline';
}

function applyChatDockGeometry(geometry) {
  if (!geometry || typeof geometry !== 'object') return;
  if (standaloneChatWindowId) {
    const revision = Number(geometry.paneRevisions?.[standaloneChatWindowId] || 0);
    if (revision < lastAppliedChatPaneRevision) return;
    lastAppliedChatPaneRevision = revision;
    const width = Number(geometry.paneWidths?.[standaloneChatWindowId]);
    if (Number.isFinite(width) && width > 0) { document.documentElement.style.setProperty('--agent-drawer-width', `${Math.round(width)}px`); fitModelMenu(); }
    document.documentElement.style.setProperty('--agent-dock-offset', '0px');
    return;
  }
  const primaryWidth = Number(geometry.primaryWidth);
  if (geometry.primaryVisible && Number.isFinite(primaryWidth) && primaryWidth > 0) {
    document.documentElement.style.setProperty('--agent-drawer-width', `${Math.round(primaryWidth)}px`);
  }
  const offset = Number(geometry.extraWidth || 0);
  document.documentElement.style.setProperty('--agent-dock-offset', `${Math.max(0, Math.round(offset))}px`);
}

let tabStripRenderKey = '';
function tabSiteIcon(tab) {
  const image = document.createElement('img');
  image.className = 'tab-favicon';
  image.alt = '';
  image.referrerPolicy = 'no-referrer';
  image.src = tab.favicon || 'tab-fallback.svg';
  image.addEventListener('error', () => { if (!image.src.endsWith('/tab-fallback.svg')) image.src = 'tab-fallback.svg'; });
  return image;
}
function renderTabStrip() {
  if (standaloneChatWindowId || !window.BrowserUseTabStrip || !state) return;
  // The plus button is now a child of the tab strip. Reserve its width while
  // calculating tab widths so it never becomes a fixed control detached from
  // the last tab or squeezes the tab labels unpredictably.
  const plusWidth = newTab ? Math.max(26, Math.ceil(newTab.getBoundingClientRect().width || 26)) : 0;
  const width = Math.max(40, Math.floor(tabs.getBoundingClientRect().width - plusWidth));
  const layout = window.BrowserUseTabStrip.layout(state.tabs || [], state.selectedTabId, width);
  const key = JSON.stringify([layout.visible.map(tab => [tab.id, tab.title, tab.favicon]), layout.hidden.map(tab => tab.id), state.selectedTabId, width]);
  if (key === tabStripRenderKey) return;
  tabStripRenderKey = key;
  const buttons = layout.visible.map(tab => {
    const button = document.createElement('button');
    button.type = 'button'; button.role = 'tab';
    button.className = `tab${tab.id === state.selectedTabId ? ' is-active' : ''}`;
    button.dataset.tabId = tab.id;
    button.style.width = `${layout.tabWidth}px`;
    button.classList.toggle('is-icon-only', layout.tabWidth < 60);
    button.classList.toggle('is-compact', layout.tabWidth < 44);
    button.setAttribute('aria-selected', String(tab.id === state.selectedTabId));
    button.setAttribute('aria-label', tab.title || 'New Tab');
    button.title = tab.title || 'New Tab';
    const label = document.createElement('span');
    label.className = 'tab-label'; label.textContent = tab.title || 'New Tab';
    const close = document.createElement('span');
    close.className = 'tab-close'; close.append(icon('x'));
    close.setAttribute('aria-label', 'Close tab');
    button.append(tabSiteIcon(tab), label, close);
    return button;
  });
  if (layout.hidden.length) {
    const group = document.createElement('button');
    group.type = 'button'; group.id = 'tab-overflow'; group.className = 'tab tab-group';
    group.style.width = `${layout.groupWidth}px`;
    group.setAttribute('aria-haspopup', 'menu'); group.setAttribute('aria-expanded', 'false');
    group.setAttribute('aria-label', `${layout.hidden.length} grouped tabs`);
    group.title = `${layout.hidden.length} more tabs`;
    const badge = document.createElement('span');
    badge.className = 'tab-group-count'; badge.textContent = String(layout.hidden.length);
    group.append(tabSiteIcon(layout.hidden[0]), badge);
    group.addEventListener('click', async () => {
      const rect = group.getBoundingClientRect();
      group.setAttribute('aria-expanded', 'true');
      try { await window.browserUseDesktop.showTabGroup(layout.hidden.map(tab => tab.id), { x: rect.left, y: rect.bottom }); }
      catch (error) { reportError(error, 'Could not open grouped tabs.'); }
      finally { group.setAttribute('aria-expanded', 'false'); }
    });
    buttons.push(group);
  }
  tabs.replaceChildren(...buttons);
  if (newTab) tabs.append(newTab);
}
new ResizeObserver(() => renderTabStrip()).observe(tabs);

function render(nextState) {
  // A state push can arrive as undefined (the onState bridge or a direct
  // render call racing the main process). Guard the whole render so a missing
  // state never throws on state.recording and kills the chrome.
  if (!nextState) return;
  state = nextState;
  window.browserUseDesktopState = state;
  renderRecording(state.recording);
  const isEditingAddress = document.activeElement === address;
  renderTabStrip();
  // The address always mirrors the active tab, and a blank/new tab starts
  // with a clean input instead of keeping the previous tab's URL text.
  if (!isEditingAddress) address.value = state.active?.url && state.active.url !== 'about:blank' ? state.active.url : '';
  back.disabled = !state.active?.canGoBack;
  forward.disabled = !state.active?.canGoForward;
  // Indeterminate load bar: tabSummary reports loading on every state push,
  // so the chrome can reflect the active tab's navigation without any new
  // lifecycle plumbing.
  loadBar.hidden = !state.active?.loading;
  // Downloads: badge shows in-flight transfers; an open panel re-renders live.
  downloadEntries = Array.isArray(state.downloads) ? state.downloads : downloadEntries;
  const activeDownloads = downloadEntries.filter((entry) => entry.state === 'progressing').length;
  downloadBadge.hidden = activeDownloads === 0;
  downloadBadge.textContent = String(activeDownloads);
  downloadsOpen = Boolean(state?.downloadsOpen);
  downloadsToggle.classList.toggle('is-active', downloadsOpen);
  downloadsToggle.setAttribute('aria-expanded', String(downloadsOpen));
  agentState.textContent = agentLabel(state);
  agentIndicator.dataset.status = state.agent?.status || 'mcp-waiting';
  renderDeviceState(state);
  if (state.android) renderAndroidDevices(state.android);
  if (agentAndroidStreamRenderer && state.settings?.androidStreamRenderer) agentAndroidStreamRenderer.value = state.settings.androidStreamRenderer === 'native' ? 'native' : 'tab';
  renderTerminalLayout(state.terminal);
  if (typeof nextState.activeDrawer !== 'undefined') activeDrawer = nextState.activeDrawer;
  updateTranscriptJumpButton();
  if (agentPin) {
    const pinned = standaloneChatWindowId ? nextState.chatWindowPinned === true : nextState.primaryAgentPinned === true;
    agentPin.classList.toggle('is-active', pinned);
    agentPin.title = pinned ? 'Unpin chat' : 'Pin chat';
    agentPin.setAttribute('aria-label', pinned ? 'Unpin chat' : 'Pin chat');
    document.body.classList.toggle('is-chat-docked', Boolean(standaloneChatWindowId && pinned));
  }
  // Geometry arrives independently from full chat state so a pane resize does
  // not rebuild the transcript. A stale full-state snapshot cannot overwrite a
  // newer live geometry revision.
  applyChatDockGeometry(nextState.chatDock);
  if (standaloneChatWindowId && nextState.chatWindowLabel && agentConversationTitle && !chatRun?.title) agentConversationTitle.textContent = nextState.chatWindowLabel;
  renderDrawers();
  // LORDE_SUBAGENT_TABS_V366 — tab strip follows every state refresh: new
  // pool subagents gain tabs, finished ones dim, stale active tabs fall back.
  renderSubagentTabs();
  if (typeof nextState.deviceMenuOpen === 'boolean') setDeviceMenuOpen(nextState.deviceMenuOpen);
}

// The live device menu is owned by overlay.html, a topmost native BrowserView.
// Keeping a second copy in the chrome renderer caused two menus: this one sat
// under the browser tab surface and showed stale controls while the overlay
// copy was interactive but lacked the button's x-coordinate.
function renderDeviceMenu() {
  deviceMenu.replaceChildren();
}

function renderDeviceState(nextState) {
  deviceState = nextState?.device || null;
  if (Array.isArray(nextState?.deviceProfiles) && nextState.deviceProfiles.length) deviceProfiles = nextState.deviceProfiles;
  const isEmulating = Boolean(deviceState && deviceState.mode !== 'desktop');
  deviceToggle.classList.toggle('is-active', isEmulating);
  // Rotation is meaningless without a device, so the control is absent rather
  // than present-but-dead.
  rotateDevice.hidden = false;
  rotateDevice.disabled = !nextState?.selectedTabId;
  rotateDevice.classList.toggle('is-active', deviceState?.orientation === 'portrait' && Boolean(deviceState?.viewport));
  deviceToggle.title = isEmulating ? `${deviceState.label} · ${deviceState.orientation}` : 'Device mode';
  document.body.classList.toggle('is-emulating', isEmulating);
  renderDeviceMenu();
}

function deviceMenuAnchor() {
  const rect = deviceToggle.getBoundingClientRect();
  const menuWidth = 220;
  return {
    left: Math.round(rect.right - menuWidth),
    // The overlay BrowserView is already offset to start below the chrome, so
    // its y=0 is the chrome's bottom edge. Passing the button's window-relative
    // bottom would add that offset a second time and leave the menu floating a
    // chrome-height below the button.
    top: Math.max(0, Math.round(rect.bottom - APP_CHROME_HEIGHT)),
    width: Math.round(rect.width)
  };
}

function setDeviceMenuOpen(open) {
  // The menu is rendered only in the topmost overlay BrowserView. This local
  // chrome renderer merely reflects the expanded state for accessibility.
  const isOpen = Boolean(open);
  deviceMenu.hidden = true;
  deviceToggle.setAttribute('aria-expanded', String(isOpen));
  deviceToggle.classList.toggle('is-active', isOpen || Boolean(deviceState && deviceState.mode !== 'desktop'));
}

function renderTerminalLayout(layout) {
  if (!layout) return;
  const dockHeight = layout.docked ? Math.max(0, Number(layout.height) || 0) : 0;
  document.documentElement.style.setProperty('--terminal-dock-height', `${dockHeight}px`);
  terminalOpen = Boolean(layout.docked);
  terminalPanel.hidden = !layout.docked;
  terminalToggle.setAttribute('aria-expanded', String(layout.docked));
  terminalToggle.classList.toggle('is-active', layout.docked);
  if (layout.docked) {
    terminalPanel.style.height = `${layout.height}px`;
    // The panel only has a box once it is visible, so xterm is re-measured
    // after the height lands rather than while it is still hidden.
    terminalController?.scheduleFit();
  }
}

// A dead shell has to be visible in the chrome, not only in the scrollback the
// user may have scrolled away from. Reset stays enabled either way so it can
// also be used to recover a wedged but technically live shell.
const TERMINAL_PHASE_LABELS = {
  starting: 'Starting', ready: 'Ready for input', running: 'Running', quiet: 'Quiet · process alive',
  exited: 'Exited', error: 'Error', recovering: 'Recovering'
};

function renderTerminalSession(session) {
  const phase = session?.phase || (session?.alive === false ? 'exited' : 'ready');
  const alive = session?.alive !== false && !['exited', 'error'].includes(phase);
  terminalPanel.classList.toggle('is-terminal-dead', !alive);
  terminalReset.classList.toggle('is-attention', !alive);
  if (terminalStateChip) {
    terminalStateChip.dataset.phase = phase;
    terminalStateChip.textContent = TERMINAL_PHASE_LABELS[phase] || phase;
  }
  if (terminalRecover) terminalRecover.hidden = !(session?.profile === 'claude-code' && session?.recoveryAvailable);
  if (!alive && (session?.error || session?.reason)) {
    terminalBackend.textContent = `shell stopped, ${session.error || session.reason}`;
    terminalBackend.title = 'The shell is no longer running. Recover Claude or use Reset for a new shell.';
  }
}

async function openTerminal() {
  if (!terminalController) {
    terminalController = new window.BrowserUseTerminal.TerminalController({
      surface: terminalSurface,
      onStatus: (status) => {
        const credential = status.profile === 'claude-code' && status.credentialSource && status.credentialSource !== 'none' ? ` · ${status.credentialSource}` : '';
        terminalBackend.textContent = `${status.backend === 'pty' ? `${status.shell} · PTY` : `${status.shell} · reduced`}${credential}`;
        renderTerminalSession(status);
        terminalBackend.title = status.backend === 'pty'
          ? 'Full TTY: colours, history, and interactive programs are supported.'
          : 'Reduced shell: commands run, but full-screen interactive programs are not supported.';
      },
      onSessionChange: renderTerminalSession,
      // Read-only state lives in the header, never inside the xterm view:
      // writing into the terminal corrupts full-screen TUI rendering.
      onReadOnlyChange: (readOnly) => {
        const note = document.querySelector('#terminal-mode-note');
        if (note) note.hidden = !readOnly;
      }
    });
    window.browserUseDesktop.onTerminalData(({ id, data, status }) => { terminalController.write(id, data); if (status && id === terminalController.sessionId) renderTerminalSession(status); });
    window.browserUseDesktop.onTerminalExit(({ id, exitCode, status }) => { terminalController.notifyExit(id, exitCode, status); if (status) renderTerminalSession(status); void refreshTerminalSessions(); });
    // Keep the session picker and the terminal busy dot current even while
    // the panel is closed (the dot must work when the panel is hidden). Light
    // polling only, one small IPC per interval.
    setInterval(() => void refreshTerminalSessions(), 5_000);
  }
  await terminalController.open();
  await refreshTerminalSessions();
  terminalController.focus();
}

// ---- Terminal session picker -------------------------------------------
// Lists every broker session: the panel's own shells and agent-owned PTYs
// (badged). Attaching to an agent session is watch-only while its task runs.
const terminalSessionSelect = document.querySelector('#terminal-session-select');
const terminalSessionClose = document.querySelector('#terminal-session-close');

function sessionLabel(session) {
  const short = String(session.id || '').slice(-6);
  const cwdName = (() => {
    const parts = String(session.cwd || '').split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || '';
  })();
  const shellName = String(session.shell || '').replace(/\.exe$/i, '').split(/[\\/]/).pop();
  const place = cwdName ? ` · ${cwdName}` : '';
  // Virtual sessions are the agent's execute mirror: a view-only transcript,
  // not a shell the user could type into.
  const phaseLabel = TERMINAL_PHASE_LABELS[session.phase] || session.phase || 'Ready';
  if (session.virtual) return `Agent activity · ${phaseLabel}${place} · ${short}`;
  if (session.agent) return `Agent · ${phaseLabel} · ${shellName || 'shell'}${place} · ${short}`;
  return `Yours · ${phaseLabel} · ${shellName || 'shell'}${place} · ${short}`;
}

async function refreshTerminalSessions() {
  if (!terminalSessionSelect) return;
  let sessions = [];
  try { sessions = await window.browserUseDesktop.terminalSessions(); } catch { return; }
  const live = (Array.isArray(sessions) ? sessions : []).filter((session) => !session.disposed);
  terminalSessionSelect.replaceChildren(...live.map((session) => {
    const option = document.createElement('option');
    option.value = session.id;
    const isCurrent = session.id === terminalController?.sessionId;
    option.textContent = `${isCurrent ? '▶ ' : ''}${sessionLabel(session)}`;
    if (isCurrent) option.selected = true;
    return option;
  }));
  terminalSessionSelect.hidden = live.length === 0;
  // Close affordance: any listed session can be closed, including ones this
  // panel is not attached to, a dead detached-shell session otherwise lingers
  // until the app quits.
  if (terminalSessionClose) terminalSessionClose.hidden = live.length === 0;
  // Red dot on the terminal icon: an agent task is demonstrably working in a
  // terminal session (owned run alive + fresh output), not merely an
  // idle-but-alive process.
  const activityDot = document.querySelector('#terminal-activity-dot');
  if (activityDot) activityDot.hidden = !live.some((session) => session.working);
  const current = live.find((session) => session.id === terminalController?.sessionId);
  if (current) renderTerminalSession(current);
}

terminalSessionClose?.addEventListener('click', async () => {
  const id = terminalSessionSelect?.value || terminalController?.sessionId;
  if (!id) return;
  const sessions = await window.browserUseDesktop.terminalSessions().catch(() => []);
  const target = sessions.find((session) => session.id === id);
  if (target?.agentActive) {
    showToast('That terminal belongs to a running agent task, it closes when the task finishes.');
    return;
  }
  try {
    const outcome = await window.browserUseDesktop.terminalDispose(id);
    if (outcome?.blocked) {
      showToast('That terminal belongs to a running agent task, it closes when the task finishes.');
      return;
    }
    if (terminalController?.sessionId === id) terminalController.markExited('session closed');
    showToast('Terminal session closed.');
    void refreshTerminalSessions();
  } catch (error) {
    reportError(error, 'Could not close that terminal session.');
    void refreshTerminalSessions();
  }
});

terminalSessionSelect?.addEventListener('change', async () => {
  const id = terminalSessionSelect.value;
  if (!id || id === terminalController?.sessionId) return;
  try {
    const attached = await window.browserUseDesktop.terminalAttach(id);
    await terminalController.adopt(attached.id, { history: attached.history, readOnly: attached.agentActive, status: attached });
    terminalController.fit();
    showToast(attached.agentActive
      ? 'Watching an agent-owned session, read-only until its task finishes.'
      : 'Attached to terminal session.');
    void refreshTerminalSessions();
  } catch (error) {
    reportError(error, 'Could not attach to that terminal session.');
    showToast(String(error?.message || 'That session is gone.'), 3000);
    void refreshTerminalSessions();
  }
});

function connectionSnippet() {
  if (!mcpStatus.endpoint) return 'Starting local MCP service…';
  if (!pairingCode) return 'Create a pairing code, then configure it as the short-lived MCP bootstrap header.';
  return JSON.stringify({
    mcpEndpoint: mcpStatus.endpoint,
    headers: { 'X-Browser-Use-Pairing-Code': pairingCode },
    next: 'Send this header when initializing the MCP connection. Retain the returned Mcp-Session-Id for later requests; the same header safely retries interrupted setup for this pairing code’s remaining lifetime.'
  }, null, 2);
}

function expiryLabel(expiresAt) {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return 'expired';
  return `expires in ${Math.max(1, Math.round(remainingMs / 60_000))} min`;
}

function renderMcp(status) {
  mcpStatus = { ...mcpStatus, ...status };
  render(state);
}

async function run(action) {
  try {
    const result = await action();
    if (result?.ok === false) throw new Error(result.error || 'Browser action failed.');
    if (result?.tabs) render(result);
    if (result?.state?.tabs) render(result.state);
  } catch (error) {
    // A failed navigation or browser action is reported in the chrome without
    // taking over the screen. The Console is diagnostic UI that only opens when
    // the person explicitly requests it.
    reportError(error, 'Browser action failed.');
  }
}

async function refreshMcp() {
  try {
    renderMcp(await window.browserUseDesktop.desktopMcpStatus());
  } catch (error) {
    reportError(error, 'Could not read the local MCP status.');
  }
}

form.addEventListener('submit', (event) => { event.preventDefault(); closeHistoryMenu(); run(() => window.browserUseDesktop.navigate(address.value)); });

// ---- Address-bar history dropdown (rendered in the overlay layer) ------
// The page content is a native BrowserView that always paints above chrome
// DOM, so the dropdown lives in the topmost overlay BrowserView (overlay.html),
// anchored from the address input's rect converted to overlay coordinates
// (the overlay starts directly below the 76px chrome).
const addressWrap = address.closest('.address-wrap');

function historyMenuAnchor() {
  const rect = address.getBoundingClientRect();
  return {
    left: Math.round(rect.left),
    top: Math.max(0, Math.round(rect.bottom + 5 - 78)),
    width: Math.max(300, Math.min(520, Math.round(rect.width + 140)))
  };
}

function closeHistoryMenu() {
  if (state?.historyMenuOpen) window.browserUseDesktop.setHistoryMenuOpen(false).catch(() => {});
}

// Opening on `focus` made the history dropdown pop open every time the user
// switched back to the app window: restoring webContents focus re-fired the
// focus event on the still-active address element. Open it only on a real
// pointer interaction with the bar; the keyboard route (Ctrl+L) opens it
// explicitly right after focusing.
address.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  window.browserUseDesktop.setHistoryMenuOpen(true, historyMenuAnchor()).catch(() => {});
});
address.addEventListener('keydown', (event) => { if (event.key === 'Escape') address.blur(); });
document.querySelector('#address-history-toggle')?.addEventListener('click', () => {
  window.browserUseDesktop.setHistoryMenuOpen(!state?.historyMenuOpen, historyMenuAnchor()).catch(() => {});
});
document.addEventListener('click', (event) => {
  // Clicks on the page itself are captured by the overlay backdrop (which
  // closes the menu); this covers clicks on the surrounding chrome.
  if (state?.historyMenuOpen && addressWrap && !addressWrap.contains(event.target)) closeHistoryMenu();
  if (downloadsOpen && downloadControl && !downloadControl.contains(event.target)) setDownloadsOpen(false);
});

// ---- Downloads panel --------------------------------------------------
const downloadControl = document.querySelector('.download-control');
const downloadsToggle = document.querySelector('#downloads-toggle');
const downloadsPanel = document.querySelector('#downloads-panel');
const downloadBadge = document.querySelector('#download-badge');
let downloadsOpen = false;
let downloadEntries = [];

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(1)} MB`;
  if (value >= 1_024) return `${Math.round(value / 1_024)} KB`;
  return `${value} B`;
}

function setDownloadsOpen(next) {
  const rect = downloadsToggle.getBoundingClientRect();
  if (window.browserUseDesktop?.__browserUseDesktopFallback) {
    downloadsOpen = Boolean(next);
    if (downloadsPanel) downloadsPanel.hidden = !downloadsOpen;
    if (downloadsToggle) downloadsToggle.setAttribute('aria-expanded', String(downloadsOpen));
    return;
  }
  window.browserUseDesktop.setDownloadsOpen(Boolean(next), {
    left: Math.max(8, Math.round(rect.right - 340)),
    top: Math.max(0, Math.round(rect.bottom - APP_CHROME_HEIGHT)), width: rect.width
  }).catch(error => reportError(error, 'Could not open downloads.'));
}

downloadsToggle?.addEventListener('click', () => setDownloadsOpen(!downloadsOpen));
tabs.addEventListener('contextmenu', event => {
  const tab = event.target.closest('[data-tab-id]');
  if (!tab) return;
  event.preventDefault();
  event.stopPropagation();
  window.browserUseDesktop.showContextMenu({ kind: 'tab', tabId: tab.dataset.tabId })
    .catch(error => reportError(error, 'Could not open the tab menu.'));
});
tabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-tab-id]');
  if (!button) return;
  const id = button.dataset.tabId;
  if (event.target.closest('.tab-close')) run(() => window.browserUseDesktop.closeTab(id));
  else run(() => window.browserUseDesktop.selectTab(id));
});
newTab.addEventListener('click', () => {
  run(() => window.browserUseDesktop.newTab());
  // A new tab starts with a clean address bar, even if the old tab's URL
  // was still sitting in the input.
  address.value = '';
});
back.addEventListener('click', () => run(() => window.browserUseDesktop.goBack()));
forward.addEventListener('click', () => run(() => window.browserUseDesktop.goForward()));
reload.addEventListener('click', () => run(() => window.browserUseDesktop.reload()));
const loadBar = document.querySelector('#load-bar');
agentToggle.addEventListener('contextmenu', (event) => { event.preventDefault(); window.browserUseDesktop.showContextMenu({ kind: 'agent-launch' }).catch(() => {}); });
agentToggle.addEventListener('click', () => {
  const next = activeDrawer === 'agent' ? null : 'agent';
  window.browserUseDesktop.setActiveDrawer(next).then(() => {
    if (next === 'agent') {
      agentHistoryView.hidden = true;
      syncAgentOverlayScreenState();
      agentMessageUnseenCount = 0;
      updateTranscriptJumpButton();
      agentTask.focus();
    }
  }).catch((error) => reportError(error, 'Could not open AI chat.'));
});
if (standaloneChatWindowId) agentPanel?.classList.add('is-chat-instance');
agentPin?.addEventListener('click', () => { void (async () => {
  const pinned = !agentPin.classList.contains('is-active');
  const id = isPrimaryChatWindow ? 'primary' : standaloneChatWindowId;
  const next = await window.browserUseDesktop.setChatPinned({ id, pinned });
  agentPin.classList.toggle('is-active', Boolean(next));
  agentPin.title = next ? 'Unpin chat' : 'Pin chat';
  agentPin.setAttribute('aria-label', next ? 'Unpin chat' : 'Pin chat');
 })().catch(error => reportError(error, 'Could not change chat docking.')); });
agentHistory?.addEventListener('click', () => { void renderAgentHistory().catch((error) => reportError(error, 'Could not load chat history.')); });
agentCopyChat?.addEventListener('click', () => { copyWholeChat().then(() => flashCopyIcon(agentCopyChat)).catch((error) => reportError(error, 'Could not copy the chat.')); });
let savedAgentDrawerWidth = NaN;
try {
  savedAgentDrawerWidth = Number(localStorage.getItem('browser-use:agent-drawer-width'));
  if (Number.isFinite(savedAgentDrawerWidth)) {
    document.documentElement.style.setProperty('--agent-drawer-width', `${Math.max(240, Math.round(savedAgentDrawerWidth))}px`);
  }
} catch {}

document.querySelector('.agent-shell-head')?.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.browserUseDesktop.showContextMenu({ kind: 'agent-header', agentId: standaloneChatWindowId || chatRun?.id || activeChatRun?.id || '' }).catch(() => {});
});

// The floating Chat 1 window is 'primary': it hosts the primary agent, so
// pin actions must address the primary (empty id), not a chat-window entry.
const isPrimaryChatWindow = standaloneChatWindowId === 'primary';
if (new URLSearchParams(location.search).has('chatWindow')) {
  document.querySelector('.browser-chrome')?.setAttribute('hidden', '');
  document.querySelectorAll('main > *:not(#agent-panel), #console-panel, #settings-panel').forEach(node => node.setAttribute('hidden', ''));
  document.querySelector('#recording-banner')?.setAttribute('hidden', '');
  agentPanel.hidden = false;
  document.body.classList.add('standalone-chat-window');
}

let lastChatPaneWidth = null;
let chatPaneResizeRevision = 0;
let lastAppliedChatPaneRevision = 0;
let paneResizeFrame = 0;
let pendingPaneResize = null;
function normalizePaneWidth(width) {
  const minimum = standaloneChatWindowId ? 240 : 320;
  const requested = Number(width);
  const next = Number.isFinite(requested) ? Math.round(requested) : minimum;
  if (standaloneChatWindowId) return Math.max(minimum, next);
  return Math.min(Math.max(minimum, next), Math.max(minimum, window.innerWidth - 180));
}
function sendPaneWidth(width, publish) {
  const next = normalizePaneWidth(width);
  lastChatPaneWidth = next;
  document.documentElement.style.setProperty('--agent-drawer-width', `${next}px`);
  const request = standaloneChatWindowId
    ? window.browserUseDesktop.setChatWindowWidth({ id: standaloneChatWindowId, width: next, revision: ++chatPaneResizeRevision, emitState: publish })
    : window.browserUseDesktop.setAgentDrawerWidth({ width: next, emitState: publish });
  request.catch((error) => reportError(error, standaloneChatWindowId ? 'Could not resize this chat pane.' : 'Could not resize the browsing view.'));
}
function queuePaneWidth(width, publish = false) {
  const next = normalizePaneWidth(width);
  document.documentElement.style.setProperty('--agent-drawer-width', `${next}px`);
  pendingPaneResize = { width: next, publish: Boolean(publish) || Boolean(pendingPaneResize?.publish) };
  if (paneResizeFrame) return;
  paneResizeFrame = requestAnimationFrame(() => {
    paneResizeFrame = 0;
    const pending = pendingPaneResize;
    pendingPaneResize = null;
    if (pending) sendPaneWidth(pending.width, pending.publish);
  });
}
function flushPaneWidth(publish = true) {
  if (paneResizeFrame) cancelAnimationFrame(paneResizeFrame);
  paneResizeFrame = 0;
  const pending = pendingPaneResize;
  pendingPaneResize = null;
  const width = pending?.width ?? lastChatPaneWidth;
  if (width !== null && width !== undefined) sendPaneWidth(width, Boolean(publish) || Boolean(pending?.publish));
  if (!standaloneChatWindowId && width !== null && width !== undefined) {
    try { localStorage.setItem('browser-use:agent-drawer-width', String(lastChatPaneWidth)); } catch {}
  }
}
function setAgentDrawerWidth(width, publish = true) {
  queuePaneWidth(width, publish);
}

if (!standaloneChatWindowId && Number.isFinite(savedAgentDrawerWidth)) setAgentDrawerWidth(savedAgentDrawerWidth);

agentDrawerResize?.addEventListener('pointerdown', (event) => {
  if (window.innerWidth <= 700 && !standaloneChatWindowId) return;
  event.preventDefault();
  agentDrawerResize.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startWidth = agentPanel.getBoundingClientRect().width;
  const move = (moveEvent) => queuePaneWidth(startWidth + startX - moveEvent.clientX, false);
  const stop = () => {
    flushPaneWidth(true);
    agentDrawerResize.removeEventListener('pointermove', move);
    agentDrawerResize.removeEventListener('pointerup', stop);
    agentDrawerResize.removeEventListener('pointercancel', stop);
  };
  agentDrawerResize.addEventListener('pointermove', move);
  agentDrawerResize.addEventListener('pointerup', stop);
  agentDrawerResize.addEventListener('pointercancel', stop);
});
agentDrawerResize?.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  const current = agentPanel.getBoundingClientRect().width;
  const delta = event.key === 'ArrowLeft' ? 24 : -24;
  queuePaneWidth(current + delta, true);
  flushPaneWidth(true);
});
agentHistoryClose?.addEventListener('click', () => { agentHistoryView.hidden = true; syncAgentOverlayScreenState(); agentTask.focus(); });

const agentScheduleEditorHost = document.querySelector('#agent-schedule-editor-host');

function scheduleDateTime(value) {
  return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'not scheduled';
}

function describeSchedule(job) {
  const schedule = job.schedule || {};
  if (schedule.type === 'once') return `once · ${scheduleDateTime(schedule.startAt || job.nextRunAt)}`;
  if (schedule.type === 'interval') return `every ${schedule.intervalSeconds >= 3600 ? `${Math.round(schedule.intervalSeconds / 3600)}h` : `${Math.round(schedule.intervalSeconds / 60)}m`}`;
  if (schedule.type === 'cron') return `advanced · ${schedule.cron}`;
  if (schedule.type === 'monthly') return `monthly · day ${schedule.dayOfMonth}`;
  if (schedule.type === 'weekdays') return 'weekdays';
  if (schedule.type === 'weekly') return `weekly · ${(schedule.weekdays || []).map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ')}`;
  return 'daily';
}

function scheduleRequestId() {
  try { return crypto.randomUUID(); } catch { return `schedule-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function scheduleField(labelText, control) {
  const label = document.createElement('label'); label.className = 'agent-schedule-field';
  const text = document.createElement('span'); text.textContent = labelText; label.append(text, control); return label;
}

function scheduleEditor(existing = null) {
  agentScheduleEditorHost.hidden = false;
  agentScheduleEditorHost.replaceChildren();
  const card = document.createElement('form'); card.className = 'agent-schedule-editor';
  const title = document.createElement('div'); title.className = 'agent-schedule-editor-title';
  const heading = document.createElement('strong'); heading.textContent = existing ? 'Edit task' : 'New task';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'agent-icon-button'; close.setAttribute('aria-label', 'Cancel task'); close.innerHTML = '<i class="ph ph-x"></i>';
  title.append(heading, close);
  const name = document.createElement('input'); name.type = 'text'; name.value = existing?.name || ''; name.placeholder = 'Task name'; name.required = true;
  const prompt = document.createElement('textarea'); prompt.rows = 4; prompt.value = existing?.prompt || existing?.task || ''; prompt.placeholder = 'What should the agent do when this task runs?';
  const kind = document.createElement('select');
  [['once', 'Once'], ['daily', 'Every day'], ['weekdays', 'Weekdays'], ['weekly', 'Selected days'], ['monthly', 'Monthly'], ['interval', 'Every interval'], ['cron', 'Advanced cron']].forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; kind.append(option); });
  kind.value = existing?.schedule?.type || (existing?.cron ? 'cron' : existing?.everySeconds ? 'interval' : 'daily');
  const dateTime = document.createElement('input'); dateTime.type = 'datetime-local';
  if (existing?.schedule?.startAt) dateTime.value = new Date(existing.schedule.startAt).toISOString().slice(0, 16);
  else { const next = new Date(Date.now() + 3600000); next.setSeconds(0, 0); dateTime.value = new Date(next.getTime() - next.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
  const time = document.createElement('input'); time.type = 'time'; time.value = existing?.schedule?.time || '09:00';
  const interval = document.createElement('input'); interval.type = 'number'; interval.min = '60'; interval.step = '60'; interval.value = existing?.schedule?.intervalSeconds || '3600';
  const dayOfMonth = document.createElement('input'); dayOfMonth.type = 'number'; dayOfMonth.min = '1'; dayOfMonth.max = '31'; dayOfMonth.value = existing?.schedule?.dayOfMonth || '1';
  const cron = document.createElement('input'); cron.type = 'text'; cron.placeholder = '0 9 * * 1-5'; cron.value = existing?.schedule?.cron || existing?.cron || '';
  const weekdays = document.createElement('div'); weekdays.className = 'agent-schedule-weekdays';
  const selectedDays = existing?.schedule?.weekdays || [1, 2, 3, 4, 5];
  ['S', 'M', 'T', 'W', 'T', 'F', 'S'].forEach((label, day) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-schedule-day'; button.textContent = label; button.dataset.day = day; button.setAttribute('aria-pressed', String(selectedDays.includes(day))); button.addEventListener('click', () => { const pressed = button.getAttribute('aria-pressed') === 'true'; button.setAttribute('aria-pressed', String(!pressed)); button.classList.toggle('is-selected', !pressed); }); button.classList.toggle('is-selected', selectedDays.includes(day)); weekdays.append(button); });
  const execution = document.createElement('select'); [['agent', 'Agent prompt (recommended)'], ['programmatic', 'Built-in action']].forEach(([value, text]) => { const option = document.createElement('option'); option.value = value; option.textContent = text; execution.append(option); }); execution.value = existing?.execution?.type || 'agent';
  const programmatic = document.createElement('select'); const shutdown = document.createElement('option'); shutdown.value = 'shutdown'; shutdown.textContent = 'Shut down Browser-use'; programmatic.append(shutdown); programmatic.value = existing?.execution?.action || 'shutdown';
  const advanced = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Advanced'; advanced.append(summary, scheduleField('Cron expression', cron));
  const preview = document.createElement('output'); preview.className = 'agent-schedule-preview'; preview.setAttribute('aria-live', 'polite');
  const error = document.createElement('p'); error.className = 'agent-schedule-error'; error.hidden = true;
  const actionRow = document.createElement('div'); actionRow.className = 'agent-schedule-actions'; const save = document.createElement('button'); save.type = 'submit'; save.className = 'save-button'; save.textContent = existing ? 'Save changes' : 'Start task'; const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'plain-button'; cancel.textContent = 'Cancel'; actionRow.append(save, cancel);
  const fields = document.createElement('div'); fields.className = 'agent-schedule-fields'; fields.append(scheduleField('Name', name), scheduleField('Agent instruction', prompt), scheduleField('Repeat', kind));
  const dateField = scheduleField('Date and time', dateTime); const timeField = scheduleField('Time', time); const intervalField = scheduleField('Interval seconds', interval); const monthField = scheduleField('Day of month', dayOfMonth); const dayField = scheduleField('Days', weekdays); fields.append(dateField, timeField, intervalField, monthField, dayField, scheduleField('Execution', execution), scheduleField('Built-in action', programmatic));
  card.append(title, fields, advanced, preview, error, actionRow); agentScheduleEditorHost.append(card);

  const syncVisibility = () => { const value = kind.value; dateField.hidden = value !== 'once'; timeField.hidden = value === 'once' || value === 'interval' || value === 'cron'; intervalField.hidden = value !== 'interval'; monthField.hidden = value !== 'monthly'; dayField.hidden = !['weekdays', 'weekly'].includes(value); execution.parentElement.hidden = false; programmatic.parentElement.hidden = execution.value !== 'programmatic'; prompt.closest('label').hidden = execution.value === 'programmatic'; };
  const buildPayload = () => { const type = kind.value; const schedule = { type }; if (type === 'once') schedule.startAt = new Date(dateTime.value).getTime(); else if (type === 'interval') schedule.intervalSeconds = Number(interval.value); else if (type === 'monthly') { schedule.dayOfMonth = Number(dayOfMonth.value); schedule.time = time.value; } else if (type === 'cron') schedule.cron = cron.value.trim(); else { schedule.time = time.value; if (['weekdays', 'weekly'].includes(type)) schedule.weekdays = [...weekdays.querySelectorAll('[aria-pressed="true"]')].map(button => Number(button.dataset.day)); } return { name: name.value.trim(), prompt: prompt.value.trim(), schedule, execution: execution.value === 'programmatic' ? { type: 'programmatic', action: programmatic.value } : { type: 'agent' }, clientRequestId: scheduleRequestId(), ...(existing ? { jobId: existing.id, action: 'update' } : {}) }; };
  const refreshPreview = async () => {
    if (!prompt.value.trim() && execution.value !== 'programmatic') {
      preview.textContent = 'Enter the task to preview its next run.';
      error.hidden = true;
      return;
    }
    try {
      const result = await window.browserUseDesktop.schedulePreview(buildPayload());
      preview.textContent = `Next run: ${scheduleDateTime(result.nextRunAt)}`;
      error.hidden = true;
    } catch (reason) {
      preview.textContent = 'Choose a valid future time.';
      error.textContent = reason?.message || 'This task schedule is not valid.';
      error.hidden = false;
    }
  };
  [kind, dateTime, time, interval, dayOfMonth, cron, execution, programmatic, prompt].forEach(node => node.addEventListener('input', () => { syncVisibility(); void refreshPreview(); }));
  close.addEventListener('click', () => { agentScheduleEditorHost.hidden = true; void renderSchedules(); }); cancel.addEventListener('click', () => { agentScheduleEditorHost.hidden = true; void renderSchedules(); });
  card.addEventListener('submit', async event => { event.preventDefault(); if (save.disabled) return; save.disabled = true; try { const result = existing ? await window.browserUseDesktop.scheduleUpdate(buildPayload()) : await window.browserUseDesktop.scheduleCreate(buildPayload()); if (result?.duplicate) showToast('That alarm is already scheduled.'); agentScheduleEditorHost.hidden = true; await renderSchedules(); } catch (reason) { error.textContent = reason?.message || 'Could not save the alarm.'; error.hidden = false; save.disabled = false; } });
  syncVisibility(); void refreshPreview(); name.focus();
}

async function renderSchedules() {
  const status = await window.browserUseDesktop.scheduleList().catch(() => null);
  if (!status || agentSchedulesView.hidden) return;
  agentSchedulesList.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'agent-kicker'; heading.textContent = 'TASKS'; agentSchedulesList.append(heading);
  if (!status.jobs.length) { const empty = document.createElement('p'); empty.className = 'drawer-empty'; empty.textContent = 'No tasks yet. Add one and the agent will execute its instruction at the scheduled time.'; agentSchedulesList.append(empty); return; }
  for (const job of status.jobs) {
    const row = document.createElement('div'); row.className = `agent-history-item agent-alarm-row${job.enabled ? '' : ' is-paused'}`; row.dataset.jobId = job.id;
    const title = document.createElement('strong'); title.textContent = truncateHistoryTitle(job.name || job.prompt); const meta = document.createElement('span'); meta.className = 'agent-kicker'; meta.textContent = `${job.enabled ? '' : 'Paused · '}${describeSchedule(job)} · ${job.execution?.type === 'programmatic' ? 'built-in action' : 'agent prompt'}`; const next = document.createElement('small'); next.textContent = job.nextRunAt ? `Next: ${scheduleDateTime(job.nextRunAt)}` : 'No future run'; const instruction = document.createElement('p'); instruction.textContent = job.execution?.type === 'programmatic' ? job.execution.action : job.prompt; instruction.className = 'agent-alarm-prompt';
    const actions = document.createElement('div'); actions.className = 'agent-alarm-actions'; const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'plain-button'; edit.textContent = 'Edit'; edit.addEventListener('click', () => scheduleEditor(job)); const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'plain-button'; toggle.textContent = job.enabled ? 'Pause' : 'Resume'; toggle.addEventListener('click', async () => { toggle.disabled = true; await window.browserUseDesktop.scheduleUpdate({ jobId: job.id, action: job.enabled ? 'pause' : 'resume' }).catch(reason => reportError(reason, 'Could not update the alarm.')); void renderSchedules(); }); const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'plain-button is-danger'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => { remove.disabled = true; await window.browserUseDesktop.scheduleRemove({ jobId: job.id }).catch(reason => reportError(reason, 'Could not delete the alarm.')); void renderSchedules(); }); actions.append(edit, toggle, remove); row.append(title, meta, next, instruction, actions); agentSchedulesList.append(row);
  }
}

agentSchedules?.addEventListener('click', () => { agentHistoryView.hidden = true; agentSchedulesView.hidden = false; agentScheduleEditorHost.hidden = true; syncAgentOverlayScreenState(); void renderSchedules().catch((error) => reportError(error, 'Could not load schedules.')); });
agentSchedulesClose?.addEventListener('click', () => { agentSchedulesView.hidden = true; agentScheduleEditorHost.hidden = true; syncAgentOverlayScreenState(); agentTask.focus(); });
agentScheduleAdd?.addEventListener('click', () => scheduleEditor());
window.browserUseDesktop.onScheduleEvent?.(() => { if (!agentSchedulesView.hidden) void renderSchedules(); });

// ---- Record & Learn / Skill Brain -----------------------------------------
// Real-time observation with a hard human gate: nothing is remembered until
// the user checks it in the proposal review. Keyboard content is never
// captured anywhere in this pipeline, only counts and structural keys.
const agentRecord = document.querySelector('#agent-record');
const agentSkills = document.querySelector('#agent-skills');
const recordView = document.querySelector('#agent-record-view');
const recordKicker = document.querySelector('#record-kicker');
const recordViewTitle = document.querySelector('#record-view-title');
const recordStatusBody = document.querySelector('#record-status-body');
const recordProposalBody = document.querySelector('#record-proposal-body');
const skillsView = document.querySelector('#agent-skills-view');
const agentSkillsList = document.querySelector('#agent-skills-list');
let recordActive = false;
let recordingStartedAt = null;

function recordStatusLine(text) {
  recordStatusBody.replaceChildren();
  const line = document.createElement('p');
  line.className = 'record-status-line';
  line.textContent = text;
  recordStatusBody.append(line);
}

function openRecordView() {
  agentHistoryView.hidden = true;
  agentSchedulesView.hidden = true;
  skillsView.hidden = true;
  recordView.hidden = false;
  syncAgentOverlayScreenState();
}

function renderRecordStatus(status) {
  recordActive = Boolean(status?.recording);
  agentRecord?.classList.toggle('is-recording', recordActive);
  if (!recordActive) return;
  recordKicker.textContent = 'RECORDING';
  recordViewTitle.textContent = 'Recording…';
  const episode = status.episode;
  const parts = [`${status.events} events observed`];
  if (episode?.apps?.length) parts.push(`in ${episode.apps.join(', ')}`);
  if (episode?.actions) parts.push(`${episode.actions} actions this episode`);
  const modelNote = status.modelState === 'failed'
    ? ` Model check failed: ${status.modelError || 'the active model is unavailable.'} Open AI settings to change model; recording continues.`
    : status.modelState === 'checking' ? ' Checking the active model…' : status.model ? ` Using ${status.model}.` : '';
  recordStatusLine(`● Recording, ${parts.join(' · ')}.${modelNote} Keep working normally; nothing is remembered until you approve it.`);
  if (status.modelState === 'failed' && !recordStatusBody.querySelector('[data-change-model]')) {
    const change = document.createElement('button'); change.type = 'button'; change.className = 'plain-button'; change.dataset.changeModel = 'true'; change.textContent = 'Change model';
    change.addEventListener('click', () => { recordView.hidden = true; agentSettingsScreen.hidden = false; syncAgentOverlayScreenState(); syncAgentProviderOnboarding(); });
    recordStatusBody.append(change);
  }
}

function skillDraftCard(draft, index) {
  const card = document.createElement('div');
  card.className = 'agent-history-item record-skill-draft';
  const head = document.createElement('label');
  head.style.cssText = 'display:flex;gap:8px;align-items:center;';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = true;
  check.dataset.draft = String(index);
  const name = document.createElement('input');
  name.type = 'text';
  name.value = draft.name || '';
  name.dataset.field = 'name';
  name.dataset.draft = String(index);
  name.style.cssText = 'flex:1;font-weight:600;';
  head.append(check, name);
  const when = document.createElement('input');
  when.type = 'text';
  when.value = draft.when || '';
  when.placeholder = 'When should the agent use this skill?';
  when.dataset.field = 'when';
  when.dataset.draft = String(index);
  const steps = document.createElement('textarea');
  steps.rows = Math.min(10, Math.max(3, (draft.steps || []).length));
  steps.value = (draft.steps || []).map(step => step.detail ? `${step.action}, ${step.detail}` : step.action).join('\n');
  steps.dataset.field = 'steps';
  steps.dataset.draft = String(index);
  const grounding = document.createElement('small');
  grounding.textContent = draft.grounding ? `Grounded in: ${draft.grounding}` : 'Observed steps only';
  card.append(head, when, steps, grounding);
  return card;
}

function renderRecordProposal(proposal) {
  openRecordView();
  recordKicker.textContent = 'PROPOSAL';
  recordViewTitle.textContent = `Learned ${proposal.skills?.length || 0} candidate skill(s)`;
  recordStatusBody.replaceChildren();
  const summary = document.createElement('p');
  summary.className = 'record-status-line';
  summary.textContent = proposal.error
    ? proposal.error
    : `${proposal.tasks?.length || 0} task(s) reconstructed on ${proposal.model} across ${proposal.episodes} episode(s). Check the skills you want to keep, only those are remembered.`;
  recordStatusBody.append(summary);
  recordProposalBody.hidden = false;
  recordProposalBody.replaceChildren();
  recordProposalBody.dataset.proposalId = proposal.sessionId ? `prop-${proposal.sessionId}` : '';
  for (const task of proposal.tasks || []) {
    const row = document.createElement('div');
    row.className = 'agent-history-item';
    const title = document.createElement('strong');
    title.textContent = task.title;
    const intent = document.createElement('small');
    intent.textContent = task.intent || '';
    const relevant = document.createElement('small');
    relevant.textContent = `Relevant: ${(task.relevantActions || []).join(' · ') || ','}${(task.casualActions || []).length ? ` | Casual (discarded): ${(task.casualActions || []).slice(0, 3).join(' · ')}` : ''}`;
    row.append(title, intent, relevant);
    recordProposalBody.append(row);
  }
  const keepButton = document.createElement('button');
  keepButton.type = 'button';
  keepButton.className = 'agent-send';
  keepButton.textContent = `Save checked skills (${proposal.skills?.length || 0})`;
  keepButton.addEventListener('click', async () => {
    keepButton.disabled = true;
    try {
      const keep = [];
      for (const card of recordProposalBody.querySelectorAll('.record-skill-draft')) {
        const index = Number(card.querySelector('input[type=checkbox]')?.dataset.draft);
        if (!card.querySelector('input[type=checkbox]')?.checked) continue;
        const draft = { ...(proposal.skills?.[index] || {}) };
        for (const field of card.querySelectorAll('[data-field]')) {
          if (field.dataset.field === 'name') draft.name = field.value.trim();
          if (field.dataset.field === 'when') draft.when = field.value.trim();
          if (field.dataset.field === 'steps') {
            draft.steps = field.value.split('\n').map(line => line.trim()).filter(Boolean)
              .map(line => { const split = line.split(', ');
                return { action: split[0].trim(), detail: split.slice(1).join(', ').trim() }; });
          }
        }
        if (draft.name && draft.steps?.length) keep.push(draft);
      }
      const saved = await window.browserUseDesktop.recordResolveProposal(recordProposalBody.dataset.proposalId, keep);
      recordProposalBody.hidden = true;
      recordStatusLine(saved.length
        ? `Saved ${saved.length} skill(s) to the Skill Brain. The agent will match them automatically in future tasks.`
        : 'No skills kept, the recording was discarded.');
      void renderSkills();
    } catch (error) {
      reportError(error, 'Could not save the skills.');
      keepButton.disabled = false;
    }
  });
  recordProposalBody.append(keepButton);
}

agentRecord?.addEventListener('click', async () => {
  try {
    if (!recordActive) {
      const status = await window.browserUseDesktop.recordStart();
      recordingStartedAt = Date.now();
      openRecordView();
      renderRecordStatus(status);
    } else {
      recordStatusLine('■ Stopped. Reconstructing the task on the active model…');
      recordKicker.textContent = 'RECONSTRUCTING';
      agentRecord?.classList.remove('is-recording');
      const previous = recordActive;
      recordActive = false;
      void previous;
      await window.browserUseDesktop.recordStop();
    }
  } catch (error) {
    recordActive = false;
    agentRecord?.classList.remove('is-recording');
    reportError(error, 'Record mode failed.');
  }
});
document.querySelector('#agent-record-close')?.addEventListener('click', () => { recordView.hidden = true; syncAgentOverlayScreenState(); agentTask.focus(); });
window.browserUseDesktop.onRecordEvent?.((event) => {
  if (event?.type === 'record.status') renderRecordStatus(event.status);
  if (event?.type === 'record.model-error') renderRecordStatus(event.status);
  if (event?.type === 'record.model-ready') renderRecordStatus(event.status);
  if (event?.type === 'record.stopped') recordStatusLine('■ Stopped. Reconstructing the task on the active model…');
  if (event?.type === 'record.proposal') renderRecordProposal(event.proposal);
});

// ---- Skills screen ----------------------------------------------------------
// One screen, four states: the list, one skill's detail, the editor, and the
// new-skill form. Every piece of skill text is user-authored (or came from a
// downloaded SKILL.md), so it only ever enters the DOM through textContent /
// value, never innerHTML.
const skillsSummary = document.querySelector('#skills-summary');
const skillsSearch = document.querySelector('#skills-search');
const skillsFilters = document.querySelector('#skills-filters');
const skillsToolbar = document.querySelector('#skills-toolbar');
const skillsTitle = document.querySelector('#skills-title');
const skillsBack = document.querySelector('#skills-back');
const SKILL_FILTERS = [
  ['all', 'All'],
  ['learned', 'Learned'],
  ['installed', 'Installed'],
  ['attention', 'Needs attention']
];
let skillsData = [];
let skillsFilter = 'all';
let skillsQuery = '';
let skillsLoadState = 'idle'; // idle | loading | error
let skillsError = '';

function skillEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function skillButton(label, className, iconName, onClick) {
  const button = skillEl('button', className);
  button.type = 'button';
  if (iconName) button.append(icon(iconName));
  if (label) button.append(skillEl('span', '', label));
  button.addEventListener('click', onClick);
  return button;
}

// Where a skill came from, in words a person would use.
const skillOrigin = BrowserUseSkillsView.skillOrigin;
// The verdict the Skills screen leads with.
const skillHealth = BrowserUseSkillsView.skillHealth;
const skillState = BrowserUseSkillsView.skillState;

function renderSkillsSummary() {
  if (skillsLoadState === 'loading') { skillsSummary.textContent = 'Loading skills…'; return; }
  if (skillsLoadState === 'error') { skillsSummary.textContent = 'Skills could not be loaded'; return; }
  skillsSummary.textContent = BrowserUseSkillsView.skillsSummary(skillsData);
}

function renderSkillFilters() {
  skillsFilters.replaceChildren();
  for (const { key, label, count } of BrowserUseSkillsView.filterCounts(skillsData, SKILL_FILTERS)) {
    const chip = skillEl('button', `skills-filter${skillsFilter === key ? ' is-active' : ''}`);
    chip.type = 'button';
    chip.setAttribute('role', 'tab');
    chip.setAttribute('aria-selected', String(skillsFilter === key));
    chip.append(skillEl('span', '', label), skillEl('b', '', String(count)));
    chip.addEventListener('click', () => { skillsFilter = key; renderSkillsList(); });
    skillsFilters.append(chip);
  }
}

function skillCard(skill) {
  const state = skillState(skill);
  const card = skillEl('article', `skill-card is-${state.key}`);
  const open = skillEl('button', 'skill-card-main');
  open.type = 'button';
  open.setAttribute('aria-label', `Open ${skill.name}`);
  const top = skillEl('div', 'skill-card-top');
  top.append(skillEl('strong', 'skill-card-name', skill.name || 'Untitled skill'), skillEl('span', `skill-badge is-${state.key}`, state.label));
  open.append(top, skillEl('p', 'skill-card-desc', BrowserUseSkillsView.skillDescription(skill) || 'No description yet.'), skillEl('p', 'skill-card-meta', BrowserUseSkillsView.skillFacts(skill).join(', ')));
  if (state.key === 'attention') open.append(skillEl('p', 'skill-card-issue', state.health.problems[0]));
  open.addEventListener('click', () => void showSkillDetail(skill.id));
  card.append(open);
  return card;
}

function skillsMessage(kind, title, body, action) {
  const box = skillEl('div', `skills-message is-${kind}`);
  box.append(skillEl('strong', '', title), skillEl('p', '', body));
  if (action) box.append(action);
  return box;
}

function renderSkillsList() {
  skillsTitle.textContent = 'Skills';
  skillsBack.hidden = true;
  skillsToolbar.hidden = false;
  agentSkillsList.replaceChildren();
  renderSkillsSummary();
  renderSkillFilters();
  if (skillsLoadState === 'loading') { agentSkillsList.append(skillsMessage('loading', 'Loading skills', 'Reading your learned and installed skills.')); return; }
  if (skillsLoadState === 'error') {
    agentSkillsList.append(skillsMessage('error', 'Skills could not be loaded', skillsError || 'The skill store did not respond.', skillButton('Try again', 'skills-action', 'arrow-clockwise', () => void loadSkills())));
    return;
  }
  if (!skillsData.length) {
    agentSkillsList.append(skillsMessage('empty', 'No skills yet', 'Record a task once and approve it, or add a skill by hand. The agent uses a skill when a task matches its description.',
      skillButton('New skill', 'skills-action is-primary', 'plus', () => showSkillForm(null))));
    return;
  }
  const visible = BrowserUseSkillsView.visibleSkills(skillsData, { filter: skillsFilter, query: skillsQuery });
  if (!visible.length) {
    agentSkillsList.append(skillsMessage('empty', 'Nothing matches', skillsQuery ? `No skill matches "${skillsQuery}" in this filter.` : 'No skills are in this filter.',
      skillButton('Show all', 'skills-action', 'x', () => { skillsQuery = ''; skillsSearch.value = ''; skillsFilter = 'all'; renderSkillsList(); })));
    return;
  }
  const list = skillEl('div', 'skills-list');
  for (const skill of visible) list.append(skillCard(skill));
  agentSkillsList.append(list);
}

async function loadSkills() {
  skillsLoadState = 'loading';
  skillsError = '';
  renderSkillsList();
  try {
    const rows = await window.browserUseDesktop.skillsList();
    skillsData = (Array.isArray(rows) ? rows : []).filter((row) => row && row.id);
    skillsLoadState = 'idle';
  } catch (error) {
    skillsLoadState = 'error';
    skillsError = String(error?.message || error || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
  }
  renderSkillsList();
}

// A detail/editor/form view replaces the list and the toolbar, with a back
// control beside the title so there is always one clear way out. The back
// control is a sibling of the heading, not a child of it: a button inside the
// heading would become the heading's own name.
function openSkillSubview(title, onBack) {
  skillsToolbar.hidden = true;
  agentSkillsList.replaceChildren();
  skillsTitle.textContent = title;
  skillsBack.hidden = false;
  skillsBack.onclick = onBack;
}

function skillFact(label, value) {
  const row = skillEl('div', 'skill-fact');
  row.append(skillEl('dt', '', label), skillEl('dd', '', value));
  return row;
}

async function showSkillDetail(skillId) {
  const row = skillsData.find((skill) => skill.id === skillId);
  openSkillSubview(row?.name || 'Skill', () => void loadSkills());
  agentSkillsList.append(skillsMessage('loading', 'Opening skill', 'Reading it from disk.'));
  let result;
  try { result = await window.browserUseDesktop.skillsRead(skillId); }
  catch (error) { result = { ok: false, error: String(error?.message || error) }; }
  if (!result?.ok) {
    agentSkillsList.replaceChildren(skillsMessage('error', 'This skill could not be opened', result?.error || 'It may have been removed.', skillButton('Back to skills', 'skills-action', 'caret-left', () => void loadSkills())));
    return;
  }
  const skill = { ...row, ...result.skill };
  const state = skillState(skill);
  agentSkillsList.replaceChildren();
  const view = skillEl('div', 'skill-detail');

  const head = skillEl('div', 'skill-detail-head');
  head.append(skillEl('span', `skill-badge is-${state.key}`, state.label));
  const actions = skillEl('div', 'skill-detail-actions');
  actions.append(skillButton('Edit', 'skills-action is-primary', 'pencil-simple', () => showSkillForm(skill)));
  if (state.key !== 'attention') {
    actions.append(skillButton(skill.status === 'paused' ? 'Resume' : 'Pause', 'skills-action', skill.status === 'paused' ? 'play' : 'pause', async () => {
      await window.browserUseDesktop.skillsSave({ id: skill.id, status: skill.status === 'paused' ? 'active' : 'paused' });
      await loadSkills();
    }));
  } else if (skill.status !== 'paused') {
    actions.append(skillButton('Pause', 'skills-action', 'pause', async () => { await window.browserUseDesktop.skillsSave({ id: skill.id, status: 'paused' }); await loadSkills(); }));
  }
  if (!skill.cannotDelete) {
    const remove = skillButton('Delete', 'skills-action is-danger', 'trash', () => {
      if (remove.dataset.armed !== 'true') {
        remove.dataset.armed = 'true';
        remove.querySelector('span').textContent = 'Click again to delete';
        setTimeout(() => { remove.dataset.armed = ''; const label = remove.querySelector('span'); if (label) label.textContent = 'Delete'; }, 4000);
        return;
      }
      void (async () => { await window.browserUseDesktop.skillsDelete(skill.id); showToast(`Deleted ${skill.name}`); await loadSkills(); })();
    });
    actions.append(remove);
  }
  head.append(actions);
  view.append(head);

  // Health first: it answers "is this a real, usable skill?"
  const health = state.health;
  const healthBox = skillEl('section', `skill-health is-${health.ok ? 'ok' : 'bad'}`);
  healthBox.append(skillEl('h3', '', health.ok ? 'The agent can find and follow this skill' : 'The agent may not be able to use this skill'));
  const notes = [...health.problems.map((text) => ({ text, bad: true })), ...health.notes.map((text) => ({ text, bad: false }))];
  if (notes.length) {
    const list = skillEl('ul', 'skill-health-list');
    for (const note of notes) list.append(skillEl('li', note.bad ? 'is-problem' : 'is-note', note.text));
    healthBox.append(list);
  } else healthBox.append(skillEl('p', '', 'It has a name, a description and instructions.'));
  view.append(healthBox);

  const facts = skillEl('dl', 'skill-facts');
  facts.append(skillFact('Source', skillOrigin(skill)));
  facts.append(skillFact('Use it when', BrowserUseSkillsView.skillDescription(skill) || 'Not set'));
  const phrases = skill.trigger?.phrases;
  if (phrases?.length) facts.append(skillFact('Trigger phrases', phrases.join(', ')));
  if (skill.installed && skill.file) facts.append(skillFact('File', skill.file));
  if (skill.usage?.runs) facts.append(skillFact('Track record', `Worked ${skill.usage.successes} of ${skill.usage.runs} times`));
  view.append(facts);

  const text = skillEl('section', 'skill-text');
  text.append(skillEl('h3', '', skill.installed ? 'Instructions' : 'Steps'));
  if (skill.installed) text.append(skillEl('pre', 'skill-body', String(skill.body || '').trim() || 'This skill has no instructions.'));
  else {
    const list = skillEl('ol', 'skill-steps');
    for (const step of skill.steps || []) list.append(skillEl('li', '', step.detail ? `${step.action}: ${step.detail}` : step.action));
    text.append(list);
  }
  view.append(text);
  agentSkillsList.append(view);
}

function skillField(label, control, hint) {
  const wrap = skillEl('label', 'skill-field');
  wrap.append(skillEl('span', 'skill-field-label', label), control);
  if (hint) wrap.append(skillEl('small', 'skill-field-hint', hint));
  return wrap;
}

// Create (skill === null) or edit. Installed skills edit their SKILL.md:
// title, description, trigger phrases and the instructions. Learned skills edit
// title, trigger sentence and steps, one per line.
function showSkillForm(skill) {
  const editing = Boolean(skill);
  const fields = BrowserUseSkillsView.formFields(skill);
  const installed = fields.installed;
  openSkillSubview(editing ? `Edit ${skill.name}` : 'New skill', () => (editing ? void showSkillDetail(skill.id) : void loadSkills()));
  const form = skillEl('form', 'skill-form');
  form.noValidate = true;
  const name = skillEl('input'); name.type = 'text'; name.value = skill?.name || ''; name.placeholder = 'Short, specific title'; name.maxLength = 120; name.autocomplete = 'off';
  const when = skillEl(installed ? 'textarea' : 'input');
  if (!installed) when.type = 'text'; else when.rows = 3;
  // A NEW skill has no record yet: `skill` is null, so the learned-skill
  // branch must not read it. Reading skill.when here threw and left the
  // "New skill" button dead — the form never opened.
  when.value = (installed ? skill.description : skill?.when) || '';
  when.placeholder = 'When should the agent use this skill?';
  const triggers = skillEl('input'); triggers.type = 'text'; triggers.value = (skill?.trigger?.phrases || []).join(', '); triggers.placeholder = 'weekly update, publish post'; triggers.autocomplete = 'off';
  const body = skillEl('textarea');
  body.rows = 14;
  body.spellcheck = false;
  if (installed) { body.value = String(skill.body || '').trim(); body.placeholder = 'The instructions the agent follows'; }
  else {
    body.rows = 8;
    body.value = BrowserUseSkillsView.stepsToText(skill?.steps || []);
    body.placeholder = 'One step per line';
  }
  form.append(
    skillField('Title', name),
    skillField(fields.whenLabel, when, fields.whenHint)
  );
  if (fields.showTriggers) form.append(skillField('Trigger phrases', triggers, 'Optional. Comma-separated words that should always bring this skill up.'));
  form.append(skillField(fields.bodyLabel, body, fields.bodyHint));
  const error = skillEl('p', 'skill-form-error');
  error.hidden = true;
  error.setAttribute('role', 'alert');
  const save = skillEl('button', 'skills-action is-primary', editing ? 'Save changes' : 'Add skill');
  save.type = 'submit';
  const cancel = skillButton('Cancel', 'skills-action', '', () => (editing ? void showSkillDetail(skill.id) : void loadSkills()));
  const bar = skillEl('div', 'skill-form-bar');
  bar.append(save, cancel);
  form.append(error, bar);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const fail = (message, field) => { error.textContent = message; error.hidden = false; field?.focus(); };
    error.hidden = true;
    const title = name.value.trim();
    const text = body.value.trim();
    const problem = BrowserUseSkillsView.validateSkillForm({ title, when: when.value.trim(), body: text, installed });
    if (problem) {
      if (!title) return fail(problem, name);
      if (!text) return fail(problem, body);
      return fail(problem, when);
    }
    save.disabled = true;
    save.textContent = 'Saving…';
    void (async () => {
      try {
        if (installed) {
          const result = await window.browserUseDesktop.skillsUpdate({
            id: skill.id, name: title, description: when.value.trim(),
            triggers: BrowserUseSkillsView.parseTriggers(triggers.value), body: text
          });
          if (!result?.ok) throw new Error(result?.error || 'The skill could not be saved.');
        } else {
          const phrases = BrowserUseSkillsView.parseTriggers(triggers.value);
          await window.browserUseDesktop.skillsSave({
            ...(editing ? { id: skill.id } : {}), name: title, when: when.value.trim(), steps: BrowserUseSkillsView.parseSteps(text),
            ...(phrases.length ? { trigger: { phrases, apps: skill?.trigger?.apps || [], domains: skill?.trigger?.domains || [] } } : {})
          });
        }
        showToast(editing ? 'Skill saved' : 'Skill added');
        await loadSkills();
        if (editing) { const fresh = skillsData.find((row) => row.id === skill.id); if (fresh) await showSkillDetail(fresh.id); }
      } catch (caught) {
        save.disabled = false;
        save.textContent = editing ? 'Save changes' : 'Add skill';
        fail(String(caught?.message || caught).replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ''));
      }
    })();
  });
  agentSkillsList.append(form);
  name.focus();
}

function renderSkills() { return loadSkills(); }
function addSkill() { showSkillForm(null); }
skillsSearch?.addEventListener('input', () => { skillsQuery = skillsSearch.value; renderSkillsList(); });
skillsSearch?.addEventListener('keydown', (event) => { if (event.key === 'Escape' && skillsSearch.value) { event.stopPropagation(); skillsSearch.value = ''; skillsQuery = ''; renderSkillsList(); } });

agentSkills?.addEventListener('click', () => {
  agentHistoryView.hidden = true;
  agentSchedulesView.hidden = true;
  recordView.hidden = true;
  skillsView.hidden = false;
  syncAgentOverlayScreenState();
  void renderSkills();
});
document.querySelector('#agent-skills-close')?.addEventListener('click', () => { skillsView.hidden = true; syncAgentOverlayScreenState(); agentTask.focus(); });
agentSkillAdd?.addEventListener('click', addSkill);
agentNewChat?.addEventListener('click', () => { void (async () => {
  // New chat rebuilds the MAIN transcript: return to the Main tab first so
  // the fresh conversation is the visible one.
  if (activeSubagentTab !== 'main') selectSubagentTab('main');
  agentNewChat.disabled = true;
  try {
    const activeRun = await resolveActiveChatRun();
    if (activeRun?.id) {
      const retiringId = activeRun.id;
      const cancelled = await window.browserUseDesktop.agentCancel(retiringId);
      settleLiveThought();
      renderChatState(cancelled);
      retiredConversationIds.add(retiringId);
      renderChatApproval(null);
    } else if (activeRun) {
      throw new Error('The agent is still starting. Please try New chat again in a moment.');
    }
    if (visibleConversationId) {
      retiredConversationIds.add(visibleConversationId);
      await window.browserUseDesktop.agentRetire(visibleConversationId);
    }
    visibleConversationId = null;
    chatSelectionRevision += 1;
    allowInitialChatSnapshot = false;
    activeChatRun = null;
    chatRun = null;
    agentTask.value = '';
    pendingAgentAttachments = [];
    setAttachmentStatus('');
    renderPendingAttachments();
    discardLiveThought();
    agentTranscript.replaceChildren(); transcriptStickToBottom = true;
    renderPlan([]);
    renderChatApproval(null);
    if (agentConversationTitle) agentConversationTitle.textContent = 'New conversation';
    renderChatState(null);
    agentTask.focus();
  } catch (error) {
    reportError(error, 'Could not start a new chat.');
  } finally {
    agentNewChat.disabled = false;
  }
})(); });
agentPermission?.addEventListener('change', () => renderChatState(chatRun));
// Merged mode + permission control: one compact pill backed by the hidden
// #agent-control-mode / #agent-permission selects. The selects keep every
// existing settings/run-start read and change event; the pill only renders
// their state and forwards choices back through real change events.
const AGENT_MODE_LABELS = { browser: 'Browser', agi: 'Web & PC' };
// Effort pill label: short tier word so the pill stays compact.
const AGENT_EFFORT_LABELS = { auto: 'Auto', minimal: 'Fast', standard: 'Balanced', advanced: 'Deep' };
// Permission glyphs are inline SVGs (not font icons) so the fog glow is
// precise: full access = red glowing hazard triangle (the construction sign),
// always ask = golden glowing question badge. Static glow, no blinking.
const AGENT_PERMISSION_ICONS = {
  unattended: '<svg class="agent-perm-svg is-full" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.4 14.2 13.2H1.8L8 2.4z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.3v3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".9" fill="currentColor"/></svg>',
  'confirm-sensitive': '<svg class="agent-perm-svg is-ask" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 6.3c.15-1.05.95-1.75 1.95-1.75 1.1 0 1.9.75 1.9 1.7 0 1.55-1.9 1.5-1.9 3.05" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8.15" cy="11.4" r=".95" fill="currentColor"/></svg>'
};
const agentModeToggle = document.querySelector('#agent-mode-toggle');
const agentModeMenu = document.querySelector('#agent-mode-menu');
const agentModeLabel = document.querySelector('#agent-mode-label');
const agentPermissionBadge = document.querySelector('#agent-permission-badge');
function normalizeSystemOneBrain(value) {
  return ['off', 'laya', 'jev'].includes(value) ? value : 'off';
}
function jevConfigured() {
  return publicSettings?.jevCredential?.configured === true;
}
function syncSystemOneSettings() {
  const brain = normalizeSystemOneBrain(systemOneBrain?.value || publicSettings?.layaBrain || (publicSettings?.layaEnabled ? 'laya' : 'off'));
  if (systemOneBrain && systemOneBrain.value !== brain) systemOneBrain.value = brain;
  // Each brain shows only its own config block; Jev is always selectable —
  // without a key it simply falls back to the local engine at run time.
  if (jevSettingsFields) jevSettingsFields.hidden = brain !== 'jev';
  const layaFields = document.querySelector('#laya-settings-fields');
  if (layaFields) layaFields.hidden = brain !== 'laya';
  if (jevBaseUrl && publicSettings?.jevBaseUrl && document.activeElement !== jevBaseUrl) jevBaseUrl.value = publicSettings.jevBaseUrl;
  if (jevModelId && publicSettings?.jevModelId && document.activeElement !== jevModelId) jevModelId.value = publicSettings.jevModelId;
  if (jevSettingsStatus) {
    const configured = jevConfigured();
    jevSettingsStatus.textContent = brain === 'jev'
      ? (configured ? `Key saved${publicSettings.jevCredential.display ? ` (${publicSettings.jevCredential.display})` : ''}` : 'No key saved — Jev falls back to the local engine until a key is saved.')
      : '';
    jevSettingsStatus.dataset.state = configured ? 'ok' : 'idle';
  }
}
function syncAgentModePill() {
  const mode = agentControlMode?.value || 'browser';
  const permission = agentPermission?.value || 'unattended';
  const effort = agentEffort?.value || 'auto';
  if (agentModeLabel) agentModeLabel.textContent = AGENT_MODE_LABELS[mode] || AGENT_MODE_LABELS.browser;
  const effortLabel = document.querySelector('#agent-effort-label');
  if (effortLabel) effortLabel.textContent = AGENT_EFFORT_LABELS[effort] || AGENT_EFFORT_LABELS.auto;
  if (agentPermissionBadge) agentPermissionBadge.innerHTML = AGENT_PERMISSION_ICONS[permission] || AGENT_PERMISSION_ICONS.unattended;
  // The dropdown's static badges carry their own data-perm-icon, fill them
  // here too or the menu options render without their glyphs.
  agentModeMenu?.querySelectorAll('.agent-permission-badge[data-perm-icon]').forEach((badge) => {
    badge.innerHTML = AGENT_PERMISSION_ICONS[badge.dataset.permIcon] || '';
  });
  agentModeMenu?.querySelectorAll('[data-agent-mode]').forEach((option) => option.setAttribute('aria-checked', String(option.dataset.agentMode === mode)));
  agentModeMenu?.querySelectorAll('[data-agent-permission]').forEach((option) => option.setAttribute('aria-checked', String(option.dataset.agentPermission === permission)));
  agentModeMenu?.querySelectorAll('[data-agent-effort]').forEach((option) => option.setAttribute('aria-checked', String(option.dataset.agentEffort === effort)));
  // System One brain state lives in the hidden input, seeded from saved settings.
  const layaState = normalizeSystemOneBrain(document.querySelector('#agent-laya-state')?.value || publicSettings?.layaBrain || (publicSettings?.layaEnabled ? 'laya' : 'off'));
  agentModeMenu?.querySelectorAll('[data-laya]').forEach((option) => {
    option.setAttribute('aria-checked', String(option.dataset.laya === layaState));
  });
  if (systemOneBrain && systemOneBrain.value !== layaState) systemOneBrain.value = layaState;
  syncSystemOneSettings();
  // Provider disable (Laya standalone) state mirrors the same pattern.
  const providerState = document.querySelector('#agent-provider-state')?.value || 'on';
  agentModeMenu?.querySelectorAll('[data-provider]').forEach((option) => option.setAttribute('aria-checked', String(option.dataset.provider === providerState)));
  const layaBadge = document.querySelector('#agent-laya-badge');
  if (layaBadge) {
    layaBadge.hidden = layaState === 'off' && providerState !== 'off';
    layaBadge.textContent = layaState === 'jev' ? 'J' : '⚡';
    layaBadge.title = providerState === 'off' ? 'System One is driving (provider off)' : layaState === 'jev' ? 'Jev System One verify on' : layaState === 'laya' ? 'Laya System One verify on' : '';
  }
}
function setAgentModeMenuOpen(open) {
  if (!agentModeMenu || !agentModeToggle) return;
  agentModeMenu.hidden = !open;
  agentModeToggle.setAttribute('aria-expanded', String(open));
}
agentModeToggle?.addEventListener('click', () => setAgentModeMenuOpen(agentModeMenu.hidden));
document.addEventListener('click', (event) => {
  if (agentModeMenu?.hidden || event.target.closest?.('#agent-mode-control')) return;
  setAgentModeMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && agentModeMenu && !agentModeMenu.hidden) { setAgentModeMenuOpen(false); agentModeToggle?.focus(); }
});
agentModeMenu?.addEventListener('click', (event) => {
  const modeOption = event.target.closest('[data-agent-mode]');
  const permissionOption = event.target.closest('[data-agent-permission]');
  const effortOption = event.target.closest('[data-agent-effort]');
  if (modeOption && agentControlMode && agentControlMode.value !== modeOption.dataset.agentMode) {
    agentControlMode.value = modeOption.dataset.agentMode;
    agentControlMode.dispatchEvent(new Event('change'));
  }
  if (permissionOption && agentPermission && agentPermission.value !== permissionOption.dataset.agentPermission) {
    agentPermission.value = permissionOption.dataset.agentPermission;
    agentPermission.dispatchEvent(new Event('change'));
  }
  if (effortOption && agentEffort && agentEffort.value !== effortOption.dataset.agentEffort) {
    agentEffort.value = effortOption.dataset.agentEffort;
    agentEffort.dispatchEvent(new Event('change'));
    // Persist so the next session and the next run start with this tier.
    void window.browserUseDesktop.saveSettings({ agentEffort: agentEffort.value })
      .then((saved) => { publicSettings = { ...publicSettings, agentEffort: saved.agentEffort }; })
      .catch((error) => reportError(error, 'Could not change reasoning effort.'));
  }
  const layaOption = event.target.closest('[data-laya]');
  if (layaOption) {
    const next = normalizeSystemOneBrain(layaOption.dataset.laya);
    const layaState = document.querySelector('#agent-laya-state');
    if (layaState && layaState.value !== next) {
      layaState.value = next;
      if (systemOneBrain) systemOneBrain.value = next;
      syncAgentModePill();
      void window.browserUseDesktop.saveSettings({ layaBrain: next, layaEnabled: next === 'laya' })
        .then((saved) => { publicSettings = saved; syncSystemOneSettings(); })
        .catch((error) => reportError(error, 'Could not change the System One brain.'));
    }
  }
  const providerOption = event.target.closest('[data-provider]');
  if (providerOption) {
    const providerState = document.querySelector('#agent-provider-state');
    const next = providerOption.dataset.provider;
    if (providerState && providerState.value !== next) {
      providerState.value = next;
      syncAgentModePill();
      void window.browserUseDesktop.saveSettings({ providerEnabled: next === 'on' })
        .then((saved) => { publicSettings = { ...publicSettings, providerEnabled: saved.providerEnabled !== false }; })
        .catch((error) => reportError(error, 'Could not toggle the provider.'));
    }
  }
  if (modeOption || permissionOption || effortOption || layaOption || providerOption) setAgentModeMenuOpen(false);
});
agentControlMode?.addEventListener('change', syncAgentModePill);
agentPermission?.addEventListener('change', syncAgentModePill);
agentEffort?.addEventListener('change', syncAgentModePill);
syncAgentModePill();
// DOM-selection mode: pressing the crosshair enters the mode. Each selected
// element gets a stable frontend name derived from its id, test id, accessible
// name, text, or selector (for example `exit_btn`), never a DOM 1/DOM 2
// placeholder. The name is the only token inserted into the composer and is
// the same token later rendered as a frontend-only hyperlink.
const agentDomSelect = document.querySelector('#agent-dom-select');
let domAttachMode = false;
let domPickGeneration = 0;

// The composer is a rich (contenteditable) editor: plain text nodes plus
// non-editable inline DOM-attachment cards. The `value` shim keeps every
// existing reader/writer working, and the getter serializes cards to their
// stable frontend element name so the model receives real names.
function composerPlainText() {
  let out = '';
  const walk = (node) => {
    if (node.nodeType === Node.TEXT_NODE) { out += node.nodeValue; return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node.dataset?.attachmentId) {
      // DOM references must survive as standalone stable-name tokens: never
      // glue them to the surrounding words or serialize a generated index.
      const label = node.dataset.name || '';
      if (out && !/\s$/.test(out)) out += ' ';
      out += label;
      return;
    }
    if (node.tagName === 'BR') { out += '\n'; return; }
    const block = node.tagName === 'DIV' || node.tagName === 'P';
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const child of node.childNodes) walk(child);
    if (block && !out.endsWith('\n')) out += '\n';
  };
  for (const child of agentTask.childNodes) walk(child);
  return out.replace(/[ \t]+/g, ' ').replace(/\n+$/, '');
}

if (agentTask && !Object.prototype.hasOwnProperty.call(agentTask, 'value')) {
  Object.defineProperty(agentTask, 'value', {
    configurable: true,
    get() { return composerPlainText(); },
    set(text) {
      agentTask.replaceChildren(document.createTextNode(String(text ?? '')));
      agentTask.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
}

// Removes an attachment everywhere at once: the tray chip AND any inline card
// in the composer that references it.
function removeDomAttachment(attachmentId) {
  const index = pendingAgentAttachments.findIndex((item) => item.id === attachmentId);
  if (index !== -1) pendingAgentAttachments.splice(index, 1);
  for (const card of [...agentTask.querySelectorAll(`[data-attachment-id="${attachmentId}"]`)]) {
    const next = card.nextSibling;
    if (next && next.nodeType === Node.TEXT_NODE && /^\s$/.test(next.nodeValue || '')) next.remove();
    card.remove();
  }
  renderPendingAttachments();
  agentTask.dispatchEvent(new Event('input', { bubbles: true }));
}

// Inserts a stable-name DOM attachment pill inline at the caret, a real card
// in the sentence rather than text, then leaves the caret right after it.
function insertDomCardAtCaret(label, attachmentId, previewText = '') {
  const chip = document.createElement('span');
  chip.className = 'dom-attach-card';
  chip.contentEditable = 'false';
  chip.dataset.attachmentId = attachmentId;
  chip.dataset.name = label;
  const text = document.createElement('span');
  text.textContent = label;
  // The element's actual paintable first words (or {empty}) — gradient
  // truncated to the window width, never word-wrapped.
  const preview = document.createElement('span');
  preview.className = 'dom-attach-preview';
  preview.textContent = previewText.trim() ? previewText.trim() : '{empty}';
  preview.title = previewText.trim() || '{empty}';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'dom-attach-card-remove';
  remove.textContent = '✕';
  remove.setAttribute('aria-label', `Remove ${label}`);
  remove.addEventListener('click', (event) => { event.stopPropagation(); removeDomAttachment(attachmentId); });
  chip.append(text, preview, remove);
  agentTask.focus();
  const selection = window.getSelection();
  const caretInside = selection && selection.rangeCount > 0 && agentTask.contains(selection.getRangeAt(0).commonAncestorContainer);
  if (caretInside) {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.collapse(true);
    range.insertNode(chip);
    const space = document.createTextNode(' ');
    chip.after(space);
    range.setStartAfter(space);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    agentTask.append(chip, document.createTextNode(' '));
  }
  agentTask.dispatchEvent(new Event('input', { bubbles: true }));
}

function attachDomElement(element) {
  const html = String(element?.outerHTML || '').trim();
  if (!html) { setAttachmentStatus('The selected element had no content to attach.'); return; }
  const selector = String(element?.selector || element?.tag || 'element');
  const label = domAttachmentApi?.uniqueDomName?.(
    domAttachmentApi?.deriveDomName?.(element) || 'selected_element',
    pendingAgentAttachments
  ) || 'selected_element';
  const pageUrl = state.active?.url || 'unknown';
  // This is the model attachment payload. It names the real element and never
  // contains a generated DOM N alias. The hyperlink itself is frontend-only.
  const text = `<!-- attached element: ${label}; selector: ${selector}; page: ${pageUrl} -->\n${html}`;
  if (text.length > MAX_AGENT_TEXT_FILE_CHARS) { setAttachmentStatus('The selected element is too large to attach (over 120,000 characters). Select a smaller element.'); return; }
  const previewText = String(element?.text || '').trim();
  const attachment = {
    id: crypto.randomUUID(), name: label, mimeType: 'text/html', kind: 'file', inline: true,
    size: text.length, text, selector, previewText, pageUrl,
    href: String(element?.href || ''), tag: String(element?.tag || ''), role: String(element?.role || ''),
    classes: String(element?.classes || '')
  };
  pendingAgentAttachments.push(attachment);
  insertDomCardAtCaret(label, attachment.id, previewText);
  setAttachmentStatus('');
}

// One picker invocation per loop turn; the picker re-arms after each pick so
// selections chain while the mode stays on. The generation counter retires a
// loop whose mode was left while a pick was still pending.
async function runDomPickLoop() {
  const generation = ++domPickGeneration;
  while (domAttachMode && generation === domPickGeneration) {
    try {
      const result = await window.browserUseDesktop.pickElement();
      if (generation !== domPickGeneration || !domAttachMode) return;
      if (result?.picked && result.element) {
        attachDomElement(result.element);
        continue; // re-arm for the next selection
      }
      // Cancelled (Escape in the page) or 60s of inactivity: end quietly ,
      // never an error, and the icon un-highlights.
      setDomAttachMode(false);
      if (result?.reason === 'timeout') showToast('DOM selection ended after 60 seconds of inactivity.');
      return;
    } catch (error) {
      if (generation !== domPickGeneration || !domAttachMode) return;
      setDomAttachMode(false);
      setAttachmentStatus(error.message || 'Element selection failed.');
      return;
    }
  }
}

function setDomAttachMode(on) {
  domAttachMode = on;
  domPickGeneration += 1;
  if (agentDomSelect) {
    agentDomSelect.classList.toggle('is-active', on);
    agentDomSelect.setAttribute('aria-pressed', String(on));
    agentDomSelect.title = on ? 'Exit DOM selection (Esc)' : 'Select elements in the page to attach them as cards';
  }
  if (on) {
    runDomPickLoop();
  } else {
    // Leaving the mode ALWAYS disarms the in-page picker, no matter which
    // exit path (icon toggle, Escape, timeout), so it cannot keep
    // swallowing page clicks after the icon has un-highlighted.
    void window.browserUseDesktop.cancelPickElement?.().catch(() => {});
  }
}

function exitDomAttachMode() {
  if (!domAttachMode) return;
  setDomAttachMode(false);
  // Disarm the in-page picker so it cannot keep swallowing page clicks after
  // the mode is gone.
  void window.browserUseDesktop.cancelPickElement?.().catch(() => {});
}

agentAttach?.addEventListener('click', () => agentFileInput?.click());
agentDomSelect?.addEventListener('click', () => setDomAttachMode(!domAttachMode));
document.addEventListener('keydown', (event) => {
  // Escape in DOM-selection mode exits ONLY the selection mode, it must not
  // also fall through to the global Escape that closes the whole drawer.
  if (event.key === 'Escape' && domAttachMode) {
    event.stopImmediatePropagation();
    exitDomAttachMode();
  }
});
agentFileInput?.addEventListener('change', async () => {
  // Picker = filesystem source: attachments ride as paths (no content copy).
  try { await addAgentFiles(agentFileInput.files, { source: 'filesystem' }); } catch (error) { setAttachmentStatus(error.message || 'The selected file could not be attached.'); }
  agentFileInput.value = '';
});
agentTask?.addEventListener('paste', (event) => {
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter(Boolean);
  if (files.length) {
    event.preventDefault();
    void addAgentFiles(files).catch((error) => setAttachmentStatus(error.message || 'The pasted file could not be attached.'));
    return;
  }
  // The rich composer must not paste rich HTML (it would inject markup and
  // foreign styles); every text paste lands as plain text.
  const text = event.clipboardData?.getData('text/plain');
  if (typeof text === 'string' && text) {
    // Large paste: never insert the payload into the contenteditable DOM. That
    // blocks the renderer and duplicates the entire string into the task,
    // history, provider context, and IPC. The main process reads the current
    // clipboard and writes an app-owned text attachment asynchronously.
    const LARGE_PASTE_CHARS = 16_000;
    if (text.length >= LARGE_PASTE_CHARS) {
      event.preventDefault();
      setAttachmentStatus('Packaging large paste as a text attachment…');
      void window.browserUseDesktop.savePastedTextAttachment({ name: 'pasted-text' })
        .then((attachment) => { addAgentPathAttachment(attachment); setAttachmentStatus(`Attached ${attachment.name}; send to let the agent read it.`); })
        .catch((error) => setAttachmentStatus(error?.message || 'The large paste could not be attached.'));
      return;
    }
    event.preventDefault();
    document.execCommand('insertText', false, text);
  }
});
agentForm?.addEventListener('dragover', (event) => { event.preventDefault(); agentForm.classList.add('is-drag-over'); });
agentForm?.addEventListener('dragleave', (event) => { if (!agentForm.contains(event.relatedTarget)) agentForm.classList.remove('is-drag-over'); });
agentForm?.addEventListener('drop', (event) => {
  event.preventDefault();
  agentForm.classList.remove('is-drag-over');
  // Drop = filesystem source: files AND folders ride as paths (no content
  // copy — a folder has nothing meaningful to copy and many files would
  // blow every budget).
  void addAgentFiles(event.dataTransfer?.files, { source: 'filesystem' }).catch((error) => setAttachmentStatus(error.message || 'The dropped file could not be attached.'));
});
function toggleAgentModelMenu() {
  const open = agentModelMenu.hidden;
  if (open) { modelPickerQuery = ''; renderAgentModelPicker(); }
  agentModelMenu.hidden = !open;
  agentModelToggle.setAttribute('aria-expanded', String(open));
  if (open) {
    fitModelMenu();
    agentModelMenu.querySelector('input')?.focus();
    // Lazy catalog refresh: every enabled connection is queried when the picker
    // opens, and each group updates as its own response arrives.
    void refreshAllAgentProviderModels({ quiet: true });
  }
}

// The model picker must always fit the agent drawer. Its anchor (the model
// control) flexes to near-zero on a narrow window, so sizing from the anchor
// collapses the menu; size from the DRAWER instead, and shift the anchored
// position if the 280px cap would overflow the drawer's right edge.
function fitModelMenu() {
  if (!agentModelMenu || agentModelMenu.hidden) return;
  const drawer = agentModelMenu.closest('.agent-drawer') || document.body;
  const drawerRect = drawer.getBoundingClientRect();
  const anchorRect = agentModelMenu.parentElement.getBoundingClientRect();
  const width = Math.max(180, Math.min(280, drawerRect.width - 16));
  agentModelMenu.style.width = `${width}px`;
  let left = 0;
  const overflowRight = anchorRect.left + width - (drawerRect.right - 8);
  if (overflowRight > 0) left = -overflowRight;
  if (anchorRect.left + left < drawerRect.left + 8) left = drawerRect.left + 8 - anchorRect.left;
  agentModelMenu.style.left = `${left}px`;
}
window.addEventListener('resize', fitModelMenu, { passive: true });
agentModelToggle?.addEventListener('click', toggleAgentModelMenu);
function setAgentSettingsTab(tab = 'providers') {
  const selected = tab === 'devices' ? 'devices' : 'providers';
  document.querySelectorAll('[data-agent-settings-tab]').forEach((button) => {
    const active = button.dataset.agentSettingsTab === selected;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const deviceSection = document.querySelector('#agent-android-section');
  const providerSections = document.querySelectorAll('#agent-provider-settings-form > .agent-settings-section:not(#agent-android-section)');
  if (deviceSection) deviceSection.hidden = selected !== 'devices';
  providerSections.forEach((section) => { section.hidden = selected !== 'providers'; });
}
document.querySelectorAll('[data-agent-settings-tab]').forEach((button) => button.addEventListener('click', () => setAgentSettingsTab(button.dataset.agentSettingsTab)));
setAgentSettingsTab('providers');
agentAndroidStreamRenderer?.addEventListener('change', () => void window.browserUseDesktop.saveSettings({ androidStreamRenderer: agentAndroidStreamRenderer.value }).catch((error) => reportError(error, 'Could not save stream surface.')));

function renderAndroidDevices(snapshot = { devices: [] }) {
  if (!agentAndroidDeviceList) return;
  const devices = Array.isArray(snapshot?.devices) ? snapshot.devices : [];
  const activeStream = devices.find((device) => device.session?.state === 'running' || device.session?.state === 'starting');
  // The Android surface belongs to the selected Browser-use tab. This settings
  // screen owns controls only; it never becomes the stream viewport.
  if (agentAndroidStreamHost) agentAndroidStreamHost.hidden = true;
  agentAndroidDeviceList.replaceChildren();
  if (!devices.length) { agentAndroidDeviceList.append(Object.assign(document.createElement('p'), { textContent: 'No Android devices discovered.' })); return; }
  for (const device of devices) {
    const card = document.createElement('div'); card.className = 'agent-android-device-card';
    const head = document.createElement('div'); head.className = 'agent-android-device-head';
    const strong = document.createElement('strong'); strong.textContent = device.label || device.serial;
    const state = document.createElement('span'); state.className = `agent-android-device-state${device.lastState === 'device' || device.lastState === 'online' ? ' is-online' : device.lastState === 'reconnect-advisory' ? ' is-advisory' : ''}`; state.textContent = device.lastState || 'unknown';
    head.append(strong, state); card.append(head);
    const detail = document.createElement('small'); detail.textContent = `${device.serial}${device.model ? ` · ${device.model}` : ''}${device.session?.state ? ` · stream ${device.session.state}` : ''}`; card.append(detail);
    if (device.lastState === 'reconnect-advisory') { const notice = document.createElement('small'); notice.textContent = 'Device appears reachable. Reconnect to resume.'; card.append(notice); }
    const actions = document.createElement('div'); actions.className = 'agent-android-device-actions';
    const action = (label, glyph, fn) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'agent-device-icon-action'; button.title = label; button.setAttribute('aria-label', label); button.innerHTML = `<i class="ph ph-${glyph}" aria-hidden="true"></i>`; button.addEventListener('click', () => void fn().catch((error) => reportError(error, `Could not ${label.toLowerCase()} device.`))); actions.append(button); };
    action('Select device', 'check-circle', async () => { await window.browserUseDesktop.androidDevices.select({ serial: device.serial }); renderAndroidDevices(await window.browserUseDesktop.androidDevices.list()); });
    if (device.lastState === 'reconnect-advisory' || device.lastState === 'disconnected') action('Reconnect device', 'arrow-clockwise', async () => { await window.browserUseDesktop.androidDevices.connect({ address: device.address || device.serial, label: device.label }); renderAndroidDevices(await window.browserUseDesktop.androidDevices.list()); });
    action(device.session?.state === 'running' ? 'Stop stream' : 'Start stream', device.session?.state === 'running' ? 'stop-circle' : 'play-circle', async () => { const next = device.session?.state === 'running' ? await window.browserUseDesktop.androidDevices.streamStop({ serial: device.serial }) : await window.browserUseDesktop.androidDevices.streamStart({ serial: device.serial }); void next; renderAndroidDevices(await window.browserUseDesktop.androidDevices.list()); });
    action(device.programmaticTaps ? 'Disable native taps' : 'Enable native taps', 'hand', async () => { await window.browserUseDesktop.androidDevices.programmaticInput({ serial: device.serial, enabled: !device.programmaticTaps }); renderAndroidDevices(await window.browserUseDesktop.androidDevices.list()); });
    action('Remove device', 'trash', async () => { await window.browserUseDesktop.androidDevices.remove({ serial: device.serial }); renderAndroidDevices(await window.browserUseDesktop.androidDevices.list()); });
    card.append(actions); agentAndroidDeviceList.append(card);
  }
}
async function refreshAndroidDevices() { renderAndroidDevices(await window.browserUseDesktop.androidDevices.refresh()); }
agentAndroidRefresh?.addEventListener('click', () => void refreshAndroidDevices().catch((error) => reportError(error, 'Could not refresh Android devices.')));
agentAndroidPairToggle?.addEventListener('click', () => { agentAndroidPair.hidden = !agentAndroidPair.hidden; });
agentAndroidPairSubmit?.addEventListener('click', () => void (async () => { const snapshot = await window.browserUseDesktop.androidDevices.pair({ address: agentAndroidAddress.value, pairingCode: agentAndroidPairingCode.value }); agentAndroidAddress.value = ''; agentAndroidPairingCode.value = ''; agentAndroidPair.hidden = true; renderAndroidDevices(snapshot); })().catch((error) => reportError(error, 'Could not pair Android device.')));
agentAndroidConnectSubmit?.addEventListener('click', () => void (async () => { const snapshot = await window.browserUseDesktop.androidDevices.connect({ address: agentAndroidAddress.value }); agentAndroidAddress.value = ''; agentAndroidPair.hidden = true; renderAndroidDevices(snapshot); })().catch((error) => reportError(error, 'Could not connect Android device.')));
window.browserUseDesktop.androidDevices?.onEvent?.((event) => renderAndroidDevices(event?.state));

agentSettingsToggle?.addEventListener('click', () => {
  if (!agentSettingsScreen) return;
  agentSettingsScreen.hidden = false;
  syncAgentOverlayScreenState();
  agentSettingsToggle.setAttribute('aria-expanded', 'true');
  syncAgentProviderOnboarding();
  void refreshAllAgentProviderModels({ quiet: true });
  // The Laya full-model dialogue lives in the chat agent settings screen;
  // refresh its dependency checklist every time the user opens it.
  void refreshLayaDeps();
  agentProviderSelect?.focus();
});
agentSettingsClose?.addEventListener('click', () => {
  if (!agentSettingsScreen) return;
  agentSettingsScreen.hidden = true;
  syncAgentOverlayScreenState();
  agentSettingsToggle?.setAttribute('aria-expanded', 'false');
  agentTask.focus();
});

// Laya full-model dialogue (chat agent settings screen): dependency checklist
// and the consent-gated download button. Module scope so every caller sees it.
const layaDepsList = document.querySelector('#laya-deps-list');
const layaDepsHint = document.querySelector('#laya-deps-hint');
const layaModelDownload = document.querySelector('#laya-model-download');
const layaModelStatus = document.querySelector('#laya-model-status');
let layaInstallInFlight = false;
let layaRefreshTimer = null;

async function refreshLayaDeps() {
  if (!layaDepsList) return;
  let status;
  try { status = await window.browserUseDesktop.layaStatus(); }
  catch { layaDepsList.replaceChildren(document.createTextNode('Could not read dependency status.')); return; }
  layaDepsList.replaceChildren(...(status?.checks || []).map((check) => {
    const item = document.createElement('li');
    const icon = document.createElement('i');
    // Advisory rows (e.g. CUDA torch on a CPU-only build) warn, never gate.
    icon.className = check.ok ? 'ph ph-check-circle' : (check.advisory ? 'ph ph-warning' : 'ph ph-x-circle');
    icon.setAttribute('aria-hidden', 'true');
    item.append(icon, document.createTextNode(` ${check.name}, ${check.detail}`));
    return item;
  }));
  if (status.serverReady) {
    // Model installed and running: the button becomes the stop control.
    layaModelDownload.disabled = layaInstallInFlight;
    layaModelDownload.textContent = layaInstallInFlight ? 'Stopping…' : 'Stop the full model';
    layaModelStatus.textContent = 'Full model active — decisions route through the checkpoint.';
  } else if (status.canDownload) {
    layaModelDownload.disabled = layaInstallInFlight;
    const runtimeState = status.runtime || {};
    const progress = runtimeState.progress;
    const mb = (bytes) => Math.round((bytes || 0) / 1_048_576);
    if (runtimeState.status === 'downloading' && progress) {
      layaModelDownload.textContent = `Downloading (${progress.percent}%)`;
      layaModelStatus.textContent = `${progress.percent}%, ${mb(progress.downloadedBytes)} / ${mb(progress.totalBytes)} MB${progress.file ? `, ${progress.file}` : ''}`;
    } else if (runtimeState.status === 'starting') {
      layaModelDownload.textContent = 'Starting…';
      layaModelStatus.textContent = 'Loading the checkpoint into memory…';
    } else if (runtimeState.status === 'failed' && runtimeState.reason) {
      layaModelDownload.textContent = status.weightsCached ? 'Start the full model' : 'Download the full model (~850MB)';
      layaModelStatus.textContent = `Not started: ${runtimeState.reason} The built-in engine answers meanwhile.`;
    } else {
      layaModelDownload.textContent = status.weightsCached ? 'Start the full model' : 'Download the full model (~850MB)';
      layaModelStatus.textContent = '';
    }
  } else {
    layaModelDownload.disabled = true;
    // The weights do not vanish when a dependency is missing, say so.
    layaModelDownload.textContent = status.weightsCached ? 'Start the full model' : 'Download the full model (~850MB)';
    layaModelStatus.textContent = '';
    layaDepsHint.hidden = false;
    layaDepsHint.textContent = `Install missing dependencies, then reopen settings: ${status.installCommand}`;
  }
}

layaModelDownload?.addEventListener('click', () => {
  if (layaModelDownload.disabled) return;
  const stopping = layaModelDownload.textContent.startsWith('Stop');
  layaInstallInFlight = true;
  void refreshLayaDeps();
  if (layaRefreshTimer) clearInterval(layaRefreshTimer);
  layaRefreshTimer = setInterval(() => void refreshLayaDeps(), 1_500);
  const action = stopping ? window.browserUseDesktop.layaStop() : window.browserUseDesktop.layaInstall();
  action.catch(() => {}).finally(() => {
    layaInstallInFlight = false;
    if (layaRefreshTimer) { clearInterval(layaRefreshTimer); layaRefreshTimer = null; }
    void refreshLayaDeps();
  });
});
agentProviderSelect?.addEventListener('change', () => {
  selectChatProvider(activeChatProvider());
});
agentProviderSelectTrigger?.addEventListener('click', () => {
  const open = agentProviderSelectMenu?.hidden;
  if (agentProviderSelectMenu) agentProviderSelectMenu.hidden = !open;
  agentProviderSelectTrigger.setAttribute('aria-expanded', String(open));
});
agentProviderKeyToggle?.addEventListener('click', () => {
  if (!agentProviderKey) return;
  agentProviderKey.type = agentProviderKey.type === 'password' ? 'text' : 'password';
});
systemOneBrain?.addEventListener('change', async () => {
  const next = normalizeSystemOneBrain(systemOneBrain.value);
  try {
    const hidden = document.querySelector('#agent-laya-state');
    if (hidden) hidden.value = next;
    publicSettings = await window.browserUseDesktop.saveSettings({ layaBrain: next, layaEnabled: next === 'laya' });
    syncSystemOneSettings();
    syncAgentModePill();
  } catch (error) { reportError(error, 'Could not change the System One brain.'); }
});
jevApiKeyToggle?.addEventListener('click', () => {
  if (jevApiKey) jevApiKey.type = jevApiKey.type === 'password' ? 'text' : 'password';
});
jevSettingsSave?.addEventListener('click', async () => {
  try {
    const baseUrl = String(jevBaseUrl?.value || '').trim();
    const modelId = String(jevModelId?.value || '').trim();
    if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) throw new Error('Enter a valid Jev base URL.');
    if (!modelId || /[\r\n]/.test(modelId)) throw new Error('Enter a valid Jev model id.');
    await window.browserUseDesktop.saveSettings({ jevBaseUrl: baseUrl, jevModelId: modelId });
    if (jevApiKey?.value.trim()) {
      await window.browserUseDesktop.setProviderCredential({ provider: 'jev', secret: jevApiKey.value.trim() });
      jevApiKey.value = '';
    }
    publicSettings = await window.browserUseDesktop.settings();
    syncSystemOneSettings();
    syncAgentModePill();
  } catch (error) {
    if (jevSettingsStatus) { jevSettingsStatus.textContent = error.message || 'Could not save Jev settings.'; jevSettingsStatus.dataset.state = 'error'; }
  }
});
jevApiKeyClear?.addEventListener('click', async () => {
  try {
    await window.browserUseDesktop.clearProviderCredential('jev');
    publicSettings = await window.browserUseDesktop.settings();
    syncSystemOneSettings();
    syncAgentModePill();
  } catch (error) { reportError(error, 'Could not remove the Jev key.'); }
});
agentProviderClear?.addEventListener('click', async () => {
  try {
    await window.browserUseDesktop.clearProviderCredential({ provider: activeChatProvider(), connectionId: selectedAgentConnectionId });
    publicSettings = await window.browserUseDesktop.settings();
    updateAgentProviderFieldVisibility();
    if (agentProviderTestStatus) { agentProviderTestStatus.textContent = 'Cloud API key cleared.'; agentProviderTestStatus.dataset.state = 'idle'; }
  } catch (error) { reportError(error, 'Could not clear the cloud API key.'); }
});
agentProviderDelete?.addEventListener('click', async () => {
  if (!selectedAgentConnectionId) return;
  try {
    publicSettings = await window.browserUseDesktop.removeAiConnection(selectedAgentConnectionId);
    selectedAgentConnectionId = '';
    selectChatProvider('ollama');
  } catch (error) { reportError(error, 'Could not delete this provider connection.'); }
});
agentProviderSettingsForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await saveAndTestAgentProvider(); } catch (error) {
    if (agentProviderTestStatus) { agentProviderTestStatus.textContent = error.message || 'Connection test failed.'; agentProviderTestStatus.dataset.state = 'error'; }
  }
});
agentPlanToggle?.addEventListener('click', () => {
  const open = agentPlanList.hidden;
  agentPlanList.hidden = !open;
  agentPlanToggle.setAttribute('aria-expanded', String(open));
});
if (agentForm && typeof ResizeObserver === 'function') new ResizeObserver(positionAgentPlan).observe(agentForm);
document.addEventListener('click', (event) => {
  if (agentModelMenu?.hidden || event.target.closest('.agent-model-control')) return;
  agentModelMenu.hidden = true;
  agentModelToggle?.setAttribute('aria-expanded', 'false');
});
// ── Slash command picker (gen7, Issue 2 — gen9 port) ────────────────────────
// Typing "/" opens a dropdown of every chat command (SuggestionsDisplay
// pattern ported from cli/tui/App.mjs): typing filters, arrows move, Enter
// executes zero-arg commands (and inserts argument commands for editing),
// Tab accepts into the buffer, Escape closes, click selects.
const slashCommands = window.BrowserUseChatCommands || null;
const agentSlashMenu = document.querySelector('#agent-slash-menu');
let slashState = { active: false, matches: [], selectedIndex: 0 };

function closeSlashMenu() {
  slashState = { active: false, matches: [], selectedIndex: 0 };
  if (agentSlashMenu) {
    agentSlashMenu.hidden = true;
    agentSlashMenu.replaceChildren();
  }
  agentTask?.setAttribute('aria-expanded', 'false');
}

function renderSlashMenu() {
  if (!agentSlashMenu || !slashCommands) return;
  if (!slashState.active) { closeSlashMenu(); return; }
  const rows = slashState.matches.map((command, index) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'agent-slash-option' + (index === slashState.selectedIndex ? ' is-active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(index === slashState.selectedIndex));
    const name = document.createElement('span');
    name.className = 'agent-slash-name';
    name.textContent = `/${command.name}`;
    row.append(name);
    if (command.args) {
      const args = document.createElement('span');
      args.className = 'agent-slash-args';
      args.textContent = command.args;
      row.append(args);
    }
    const description = document.createElement('span');
    description.className = 'agent-slash-desc';
    description.textContent = command.description;
    row.append(description);
    row.addEventListener('mousedown', (event) => { event.preventDefault(); applySlashAccept(command); });
    row.addEventListener('mousemove', () => {
      if (slashState.selectedIndex !== index) {
        slashState = { ...slashState, selectedIndex: index };
        renderSlashMenu();
      }
    });
    return row;
  });
  agentSlashMenu.replaceChildren(...rows);
  agentSlashMenu.hidden = false;
  agentTask?.setAttribute('aria-expanded', 'true');
}

function updateSlashSuggestions() {
  if (!slashCommands || !agentSlashMenu) return;
  const next = slashCommands.suggestionsFor(agentTask.value);
  if (!next.active) { closeSlashMenu(); return; }
  // A closed picker stays closed until the user re-arms it: typing more text
  // re-opens only when the buffer still looks like a command.
  slashState = next;
  renderSlashMenu();
}

// ── gen9: /skills and /mcp (desktop surface of the CLI's shared stores) ─────
// The CLI implements these commands in cli/tui.mjs against the same modules;
// the desktop renderer reaches the identical on-disk stores through the
// skills-manage / mcp-manage IPC (desktop/main.cjs). Subcommand parsing
// mirrors the CLI line-for-line so the two surfaces behave the same, and the
// harness never sees any of this text. Repo scope rides the pinned working
// repo (/cd); without one, only the user scope applies.
let pinnedWorkspaceRoot = '';
function gen9SplitTokens(text) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}
function gen9Transcript(text) {
  withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', text)));
}
function gen9RepoScopeBlocked(scope) {
  if (scope !== 'repo' || pinnedWorkspaceRoot) return false;
  gen9Transcript('No working repo pinned — /cd <path> first, or drop --repo to use the user scope.');
  return true;
}

async function runSkillsCommand(text) {
  const tokens = gen9SplitTokens(text).slice(1); // drop the leading "/skills"
  const sub = (tokens.shift() || '').toLowerCase();
  const scope = tokens.includes('--repo') ? 'repo' : 'user';
  const idOf = () => tokens.filter((token) => token !== '--repo')[0];
  const repoRoot = pinnedWorkspaceRoot || undefined;
  const call = (payload) => window.browserUseDesktop.skillsManage({ ...payload, repoRoot });
  try {
    if (!sub || sub === 'list') {
      const result = await call({ op: 'list' });
      if (!result?.ok) { gen9Transcript(`/skills failed: ${result?.error || 'unknown error'}`); return; }
      const skills = Array.isArray(result.skills) ? result.skills : [];
      const lines = [`Installed skills (${skills.length}) — user: ~/.browser-use-cli/skills${repoRoot ? ` · repo: ${repoRoot}/.browser-use/skills` : ''}`];
      if (!skills.length) lines.push('None yet — /skills install <folder-or-git-url>');
      for (const skill of skills) {
        lines.push(`${skill.enabled ? '[on] ' : '[off]'} ${skill.id} — ${skill.name || ''}${skill.usage?.runs ? ` (${skill.usage.successes}/${skill.usage.runs} ok)` : ''}`);
      }
      gen9Transcript(lines.join('\n'));
      return;
    }
    if (sub === 'install') {
      if (gen9RepoScopeBlocked(scope)) return;
      const source = idOf();
      if (!source) { gen9Transcript('Usage: /skills install <path-or-git-url> [--repo]'); return; }
      const payload = /^https?:\/\//i.test(source) ? { kind: 'git', url: source } : { kind: 'local', path: source };
      const result = await call({ op: 'install', source: payload, scope });
      gen9Transcript(result?.ok
        ? `Installed ${result.skill?.name || source} as ${result.skill?.id || '?'} (${result.skill?.scope || scope} scope)${result.skill?.hasScripts ? ' + scripts/' : ''} — searchable by skill_search in every run, on both surfaces.`
        : `/skills install failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (sub === 'registry') {
      if (gen9RepoScopeBlocked(scope)) return;
      const rest = tokens.filter((token) => token !== '--repo');
      const [registryFile, name] = rest;
      if (!registryFile || !name) { gen9Transcript('Usage: /skills registry <registry-file> <name> [--repo]'); return; }
      const result = await call({ op: 'installFromRegistry', registry: registryFile, name, scope });
      gen9Transcript(result?.ok
        ? `Installed ${result.skill?.name || name} as ${result.skill?.id || '?'} from registry (${result.skill?.scope || scope} scope)`
        : `/skills registry failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (sub === 'show') {
      const result = await call({ op: 'get', id: idOf() || '' });
      const skill = result?.skill;
      if (!result?.ok || !skill) { gen9Transcript(`No such skill: ${idOf() || '(none given)'}`); return; }
      const from = skill.source ? (skill.source.url || skill.source.path || skill.source.kind) : '—';
      gen9Transcript([
        `${skill.id} — ${skill.name} [${skill.enabled ? 'enabled' : 'disabled'}] (${skill.scope} scope, rev ${skill.revision ?? '?'})`,
        `from: ${from}`,
        `when: ${skill.when || '—'}`,
        `body: ${skill.bodyChars ?? '?'} chars${skill.hasScripts ? ', has scripts/' : ''}`
      ].join('\n'));
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const result = await call({ op: sub, id: idOf() || '' });
      gen9Transcript(result?.ok
        ? `${result.skill?.id || idOf()} is now ${result.skill?.enabled ? 'enabled' : 'disabled'}`
        : `No such skill: ${idOf()}`);
      return;
    }
    if (sub === 'remove') {
      const result = await call({ op: 'remove', id: idOf() || '' });
      gen9Transcript(result?.ok && result.removed ? `Removed ${idOf()}` : `No such skill: ${idOf()}`);
      return;
    }
    if (sub === 'update') {
      const result = await call({ op: 'update', id: idOf() || '' });
      gen9Transcript(result?.ok
        ? `Updated ${result.skill?.id || idOf()} (rev ${result.skill?.revision ?? '?'})`
        : `/skills update failed: ${result?.error || `no such skill: ${idOf()}`}`);
      return;
    }
    if (sub === 'search') {
      const result = await call({ op: 'search', task: tokens.join(' ') });
      if (!result?.ok) { gen9Transcript(`/skills search failed: ${result?.error || 'unknown error'}`); return; }
      const results = Array.isArray(result.results) ? result.results : [];
      if (!results.length) { gen9Transcript('No installed skill matches'); return; }
      gen9Transcript(results.map((entry) => `${Number(entry.score ?? 0).toFixed(2)}  ${entry.skill?.id} — ${entry.skill?.name || ''}`).join('\n'));
      return;
    }
    gen9Transcript(`Unknown /skills subcommand '${sub}'.`);
  } catch (error) {
    gen9Transcript(`/skills failed: ${error?.message || error}`);
  }
}

async function runMcpCommand(text) {
  const tokens = gen9SplitTokens(text).slice(1); // drop the leading "/mcp"
  const sub = (tokens.shift() || '').toLowerCase();
  const repoRoot = pinnedWorkspaceRoot || undefined;
  const call = (payload) => window.browserUseDesktop.mcpManage({ ...payload, repoRoot });
  try {
    if (!sub || sub === 'list') {
      const result = await call({ op: 'list' });
      if (!result?.ok) { gen9Transcript(`/mcp failed: ${result?.error || 'unknown error'}`); return; }
      const servers = result.servers && typeof result.servers === 'object' ? result.servers : {};
      const names = Object.keys(servers);
      const lines = [`MCP servers (${names.length}) — user: ~/.browser-use-cli/mcp.json${repoRoot ? ` · repo: ${repoRoot}/.browser-use/mcp.json` : ''}`];
      if (!names.length) lines.push('None yet — /mcp add <name> <command-or-url>');
      for (const name of names) {
        const server = servers[name] || {};
        const where = server.url || `${server.command || ''} ${(server.args || []).join(' ')}`.trim();
        lines.push(`${server.enabled === false ? '[off]' : '[on] '} ${name} (${server.scope || 'user'}, ${server.kind || (server.url ? 'http' : 'stdio')}) ${where}`);
      }
      gen9Transcript(lines.join('\n'));
      return;
    }
    if (sub === 'add') {
      let scope = 'user';
      const headers = {};
      const rest = [];
      for (let i = 0; i < tokens.length; i += 1) {
        const token = tokens[i];
        if (token === '--repo') scope = 'repo';
        else if (token === '--header') {
          const value = tokens[i + 1] || '';
          const colon = value.indexOf(':');
          if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
          i += 1;
        } else rest.push(token);
      }
      const [name, ...target] = rest;
      if (!name || !target.length) { gen9Transcript('Usage: /mcp add <name> <command...>|<url> [--repo] [--header "K: V"]'); return; }
      if (gen9RepoScopeBlocked(scope)) return;
      const isUrl = /^https?:\/\//i.test(target[0]);
      const config = isUrl
        ? { url: target[0], ...(Object.keys(headers).length ? { headers } : {}) }
        : { command: target[0], args: target.slice(1), ...(Object.keys(headers).length ? { headers } : {}) };
      const result = await call({ op: 'add', name, config, scope });
      gen9Transcript(result?.ok
        ? `Added MCP server "${result.server?.name || name}" (${scope} scope, ${isUrl ? 'http' : 'stdio'}) — /mcp test ${name} connects and lists its tools.`
        : `/mcp add failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (sub === 'auth') {
      const [name, ...headerParts] = tokens;
      const headerText = headerParts.join(' ');
      const colon = headerText.indexOf(':');
      if (!name || colon <= 0) { gen9Transcript('Usage: /mcp auth <name> <Header: value>'); return; }
      const result = await call({ op: 'auth', name, header: headerText.slice(0, colon).trim(), value: headerText.slice(colon + 1).trim() });
      gen9Transcript(result?.ok
        ? `Header stored for "${result.server?.name || name}" (${Object.keys(result.server?.headers || {}).join(', ')})`
        : `/mcp auth failed: ${result?.error || 'unknown error'}`);
      return;
    }
    if (sub === 'enable' || sub === 'disable') {
      const name = tokens[0] || '';
      const result = await call({ op: sub, name });
      gen9Transcript(result?.ok
        ? `${result.server?.name || name} is now ${result.server?.enabled ? 'enabled' : 'disabled'} (${result.server?.scope || 'user'} scope)`
        : `No such MCP server: ${name}`);
      return;
    }
    if (sub === 'remove') {
      const name = tokens[0] || '';
      const result = await call({ op: 'remove', name });
      gen9Transcript(result?.ok && result.removed ? `Removed ${name}` : `No such MCP server: ${name}`);
      return;
    }
    if (sub === 'status' || sub === 'test') {
      if (sub === 'test' && !tokens[0]) { gen9Transcript('Usage: /mcp test <name>'); return; }
      // Real handshakes take up to the 15s connect timeout — say so up front
      // so the silent wait reads as work, not a hang.
      gen9Transcript(sub === 'test' ? `Connecting to ${tokens[0]}…` : 'Connecting to every enabled MCP server…');
      const result = sub === 'test'
        ? await call({ op: 'test', name: tokens[0] })
        : await call({ op: 'status', connect: true });
      if (!result?.ok) { gen9Transcript(`/mcp ${sub} failed: ${result?.error || 'unknown error'}`); return; }
      if (sub === 'test') {
        const status = result.status || {};
        const toolList = (Array.isArray(status.tools) && status.tools.length ? status.tools : (Array.isArray(result.tools) ? result.tools : []))
          .map((tool) => (typeof tool === 'string' ? tool : (tool?.name || String(tool))));
        gen9Transcript([
          `${tokens[0]}: ${status.state || '?'} (${status.kind || '?'}${status.handshakeMs != null ? `, handshake ${status.handshakeMs}ms` : ''})`,
          ...toolList.map((tool) => `tool: mcp__${tokens[0]}__${tool}`)
        ].join('\n'));
        return;
      }
      const servers = Array.isArray(result.servers) ? result.servers : [];
      const lines = [`MCP servers (${servers.length}):`];
      for (const row of servers) {
        const detail = row.state === 'ready'
          ? `${row.toolCount ?? 0} tools`
          : row.state === 'disabled' ? 'disabled' : `error: ${String(row.error || row.lastError || 'unknown').slice(0, 90)}`;
        lines.push(`${row.name}  ${row.state}  ${detail}`);
      }
      gen9Transcript(lines.join('\n'));
      return;
    }
    gen9Transcript(`Unknown /mcp subcommand '${sub}'.`);
  } catch (error) {
    gen9Transcript(`/mcp failed: ${error?.message || error}`);
  }
}

// Local commands never reach the harness — the renderer answers them itself
// (shared by the picker's Enter path and the submit router).
function runLocalCommand(name, argText = '') {
  if (name === 'model') { agentModelToggle?.click(); return; }
  if (name === 'help') {
    const list = (window.BrowserUseChatCommands?.COMMANDS || []).map((command) => `/${command.name} ${command.args || ''} — ${command.description}`).join('\n');
    withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', `Chat commands:\n${list}`)));
  }
  if (name === 'status') {
    // gen9: the current agent has no /status handler, so the renderer answers
    // from its own run state (no model decision is ever spent on this).
    const run = currentActiveChatRun() || chatRun;
    if (!run?.id) {
      withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', 'No active conversation — /status shows the live conversation state after you send a task.')));
      return;
    }
    const planItems = Array.isArray(run.plan) ? run.plan : [];
    const done = planItems.filter((item) => item?.status === 'done' || item?.status === 'completed').length;
    const lines = [
      `status: ${run.status}${run.step ? ` · step ${run.step}` : ''}`,
      `task: ${String(run.task || '').slice(0, 120) || '(none)'}`,
      `plan: ${done}/${planItems.length} done`,
      queuedAgentMessage ? `queued message: ${String(queuedAgentMessage).slice(0, 80)}` : null
    ].filter(Boolean).join('\n');
    withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', lines)));
  }
  if (name === 'skills') { void runSkillsCommand(argText); return; }
  if (name === 'mcp') { void runMcpCommand(argText); return; }
}

function applySlashAccept(commandOverride) {
  // The CLICKED row's command wins over whatever the buffer carries — a
  // filtered picker means "/no" can have /notebook selected, and submitting
  // the buffer used to send "/no" to the model as a task.
  const action = commandOverride
    ? slashCommands.acceptActionFor(commandOverride)
    : slashCommands.acceptAction?.(slashState);
  if (!action) { closeSlashMenu(); return; }
  closeSlashMenu();
  if (action.type === 'local') {
    runLocalCommand(action.command.name, agentTask.value);
    return;
  }
  if (action.type === 'insert') {
    // Argument command: put "/cd " in the buffer for the user's own argument;
    // the next Enter submits through the normal path. The caret must sit at
    // the END — the contenteditable value setter resets it to the start, and
    // the user's argument would otherwise land BEFORE the command.
    agentTask.value = action.text;
    try {
      const range = document.createRange();
      range.selectNodeContents(agentTask);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch { /* caret placement is best effort */ }
    agentTask.focus();
    return;
  }
  // Zero-arg command: write the SELECTED command into the buffer (the picker
  // may have been filtered — the buffer can read "/no" while /notebook is
  // selected) and submit it through the normal path (queue while running,
  // start/steer otherwise). Same value-setter/caret care as the insert path.
  agentTask.value = action.text;
  try {
    const range = document.createRange();
    range.selectNodeContents(agentTask);
    range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch { /* caret placement is best effort */ }
  agentForm.requestSubmit();
}

agentTask?.addEventListener('input', updateSlashSuggestions);
agentTask?.addEventListener('blur', () => { setTimeout(closeSlashMenu, 120); });

agentTask.addEventListener('keydown', (event) => {
  if (slashState.active) {
    if (event.key === 'ArrowDown') { event.preventDefault(); slashState = slashCommands.moveSelection(slashState, 1); renderSlashMenu(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); slashState = slashCommands.moveSelection(slashState, -1); renderSlashMenu(); return; }
    // Escape with the picker open closes ONLY the picker — the document-level
    // Escape handler (close the drawer / stop the run) must not also fire.
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSlashMenu(); return; }
    if (event.key === 'Tab') { event.preventDefault(); applySlashAccept(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); applySlashAccept(); return; }
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  // Enter always delivers: the submit handler queues while a task runs
  // (text, attachments, or both) and starts otherwise. The agentSend
  // disabled state only guards the start handoff, not delivery.
  agentForm.requestSubmit();
});

agentForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  // LORDE_SUBAGENT_TABS_V366 — while a subagent tab is active the composer
  // belongs to that subagent: Enter delivers (mode 'deliver'); the explicit
  // Queue / Fast-forward buttons in the composer footer choose the other
  // modes. The Main-tab path below is untouched.
  if (activeSubagentTab !== 'main') { submitSubagentMessage('deliver'); return; }
  const typedTask = agentTask.value.trim();
  const attachments = pendingAgentAttachments.map((attachment) => ({ ...attachment }));
  const domMessageAttachments = domAttachmentApi?.normalizeDomAttachments?.(attachments
    .filter((item) => item.kind === 'file' && item.inline === true && item.selector)
    .map((item) => ({
      id: item.id, name: item.name, text: item.text, selector: item.selector, previewText: item.previewText,
      pageUrl: item.pageUrl, href: item.href, tag: item.tag, role: item.role, classes: item.classes
    }))) || [];
  if (!typedTask && !attachments.length) return;
  const activeRun = currentActiveChatRun();
  // ── gen9 slash routing (ported from gen7-arch2, Issue 2) ───────────────────
  // The slash picker produced "/..." text. Route it BEFORE the media and task
  // paths: a fresh chat must never feed "/compact" to the model as a task.
  const slashApi = window.BrowserUseChatCommands || null;
  if (slashApi && typedTask.startsWith('/')) {
    const route = slashApi.routeSubmission(typedTask, { hasConversation: Boolean(activeRun?.id || chatRun?.id) });
    if (route.type === 'local') {
      agentTask.value = '';
      runLocalCommand(route.command.name, typedTask);
      return;
    }
    if (route.type === 'needs-conversation') {
      agentTask.value = '';
      withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', `/${route.command.name} needs an active conversation — send a task first. The slash menu marks conversation-only commands.`)));
      return;
    }
    if (route.type === 'chat' && route.command.name === 'cd') {
      // /cd pins the agent-level DEFAULT working repo through the
      // set-default-workspace IPC in BOTH fresh and live conversations (gen9
      // adaptation: the arena's conversation-time pinWorkingRepo handler in
      // desktopChatAgent.cjs is the deferred follow-up). The pinned root
      // feeds resolveWorkspaceContract for the next conversation that names
      // no path of its own.
      agentTask.value = '';
      const arg = typedTask.trim().split(/\s+/).slice(1).join(' ').replace(/^["']+|["']+$/g, '');
      if (!arg) {
        withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', 'No working repo pinned yet. Use /cd <path>.')));
      } else {
        try {
          const result = await window.browserUseDesktop.setDefaultWorkspace({ path: arg });
          if (result?.ok) pinnedWorkspaceRoot = result.root; // repo-scope /skills & /mcp ride this
          withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', result?.ok
            ? `Working repo pinned to ${result.root}. It is the default workspace for your next conversation; the agent's searches, patches, and terminal commands will lead from there.`
            : `/cd failed: ${String(result?.error || 'unknown error')}`)));
        } catch (error) {
          withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', `/cd failed: ${error?.message || error}`)));
        }
      }
      return;
    }
    if (route.type === 'chat' && !activeRun?.id && !chatRun?.id && route.command.conversation === 'both') {
      agentTask.value = '';
      const hasArgs = /\s/.test(typedTask.trim());
      if (route.command.name === 'plan' && !hasArgs) {
        withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', 'No conversation yet — the plan starts empty. Send a task, then /plan inspects it (add steps after /plan to set it).')));
        return;
      }
      withTranscriptStick(() => agentTranscript.append(renderChatMessage('assistant', `/${route.command.name} needs an active conversation — send a task first.`)));
      return;
    }
    // 'chat' routes with a live/idle conversation and 'task' routes fall
    // through to the normal queue/start flow below — the harness intercepts
    // "/..." without burning a model decision.
  }
  // Media models (image/TTS) bypass the agent loop: they are called directly
  // with the prompt and the result renders in chat — exactly how those
  // models are designed to be used. Routing them through the decision loop
  // hangs forever (image gateways never stream chat decisions).
  const mediaKind = nonChatModelReason(selectedAgentModel);
  const storedKind = storedModelKind(selectedAgentModel);
  const directKind = storedKind && storedKind !== 'language' ? storedKind : (mediaKind ? (mediaKind.includes('image') ? 'image' : 'tts') : null);
  if (directKind && !activeRun?.id) {
    const mediaPrompt = typedTask || 'Review the attached file or files.';
    const connection = activeConnection();
    const kindLabel = { image: 'Generating image…', tts: 'Generating audio…', stt: 'Transcribing audio…', video: 'Generating video…' }[directKind] || 'Generating media…';
    const renderedUserCard = renderChatMessage('user', typedTask, '', null, domMessageAttachments.length ? { domAttachments: domMessageAttachments } : {});
    void renderedUserCard;
    // Animated placeholder card: the asset renders inside this same card slot
    // (image/video cards, WhatsApp-style audio note) when generation finishes.
    const pending = renderMediaGeneratingCard(kindLabel);
    agentTask.value = '';
    pendingAgentAttachments = [];
    renderPendingAttachments();
    void (async () => {
      try {
        const result = await window.browserUseDesktop.generateMedia({ provider: activeChatProvider(), connectionId: selectedAgentConnectionId || connection?.id, model: selectedAgentModel, prompt: mediaPrompt, kind: directKind, voice: agentTtsVoice || undefined, fileBase64: undefined, filename: undefined });
        let replacement = null;
        let mediaForHistory = null;
        if (result && result.ok === false) {
          const detail = (result.errors || []).map((e) => `${e.model}: ${String(e.error).slice(0, 160)}`).join('\n');
          replacement = renderChatMessage('assistant', `Media generation failed on every same-kind model:\n${detail}`);
        } else if ((result?.kind === 'image' || directKind === 'image') && (result?.url || result?.dataUrl)) {
          mediaForHistory = { kind: 'image', url: result.url || null, dataUrl: result.dataUrl || null, model: result.model || selectedAgentModel };
          replacement = buildMediaMessage('generated an image', { kind: 'image', url: result.url || null, dataUrl: result.dataUrl || null, filename: mediaFilename('image'), meta: result.model ? `model ${result.model}` : '' }, buildMediaCard);
        } else if ((result?.kind === 'video' || directKind === 'video') && (result?.url || result?.dataUrl)) {
          mediaForHistory = { kind: 'video', url: result.url || null, dataUrl: result.dataUrl || null, model: result.model || selectedAgentModel };
          replacement = buildMediaMessage('generated a video', { kind: 'video', url: result.url || null, dataUrl: result.dataUrl || null, filename: mediaFilename('video'), meta: result.model ? `model ${result.model}` : '' }, buildMediaCard);
        } else if ((result?.kind === 'audio' || directKind === 'tts') && (result?.dataUrl || result?.url)) {
          mediaForHistory = { kind: 'audio', url: result.url || null, dataUrl: result.dataUrl || null, model: result.model || selectedAgentModel };
          replacement = buildMediaMessage('generated audio', { dataUrl: result.dataUrl || null, url: result.url || null, filename: mediaFilename('audio') }, buildAudioNote);
        } else if (result?.kind === 'transcription') {
          replacement = renderChatMessage('assistant', String(result.text || '').slice(0, 4000));
        } else {
          const reason = result?.errors?.length ? ` (${String(result.errors[0].error || '').slice(0, 200)})` : '';
          replacement = renderChatMessage('assistant', `The provider returned no media${reason}.`);
        }
        if (replacement) pending.replaceWith(replacement);
        // Persist the exchange so it survives the agent/chat closing.
        if (mediaForHistory) {
          window.browserUseDesktop.recordMediaHistory({
            connectionId: selectedAgentConnectionId || connection?.id,
            kind: directKind, model: result?.model || selectedAgentModel,
            prompt: mediaPrompt,
            media: { ...mediaForHistory, dataUrl: mediaForHistory.dataUrl && mediaForHistory.dataUrl.length <= 4_000_000 ? mediaForHistory.dataUrl : null }
          }).catch(() => { /* history is best-effort */ });
        }
      } catch (error) {
        try { pending.replaceWith(renderChatMessage('assistant', `Media generation failed: ${error?.message || error}`)); }
        catch { reportError(error, 'Media generation failed.'); }
      }
    })();
    return;
  }
  if (activeRun?.id && (activeRun.status === 'awaiting_input' || chatRun?.status === 'awaiting_input') && typedTask) {
    // The run is paused on ask_user: typing IS the answer. Queueing it would
    // wait for a run that is itself waiting on this message.
    agentTask.value = '';
    updateAgentRunButtons();
    try { await answerPendingQuestion(activeRun.id, typedTask); }
    catch { agentTask.value = typedTask; updateAgentRunButtons(); }
    return;
  }
  if (activeRun?.id) {
    // A message typed while the agent is working is a STEERING message, and it
    // must reach the running task NOW.
    //
    // It used to be held in a local queue that was only flushed when the run
    // reached a terminal status — so a direct instruction sent mid-task was
    // delivered minutes later, after the agent had already done the thing the
    // user was correcting. The agent has had live steering for a long time
    // (steer -> pendingUserMessages -> delivered at the next model boundary,
    // folded in as an ADDITION to the running work); the composer simply
    // never used it. Falling through to agentStart would surface an 'already
    // active' error modal.
    const steerText = typedTask || 'Review the attached file or files and respond to the user.';
    const steerAttachments = attachments.map((attachment) => ({ ...attachment }));
    agentTask.value = '';
    pendingAgentAttachments = [];
    setAttachmentStatus('');
    renderPendingAttachments();
    updateAgentRunButtons();
    try {
      await window.browserUseDesktop.agentSteer({
        runId: activeRun.id,
        text: steerText,
        attachments: steerAttachments,
        domAttachments: domMessageAttachments
      });
      // The steered message is shown as the user's own turn so the transcript
      // reads in order; the agent folds it into the running work.
      const steerLabel = steerAttachments.length ? `\n\nAttached: ${steerAttachments.map((item) => item.name).join(', ')}` : '';
      withTranscriptStick(() => agentTranscript.append(renderChatMessage('user', `${steerText}${steerLabel}`, '', null, domMessageAttachments.length ? { domAttachments: domMessageAttachments } : {})));
      showToast('Message delivered to the running task.');
    } catch (error) {
      // The run ended between the click and the delivery: fall back to the
      // queue, which sends it as the next turn.
      queueAgentMessage(steerText, steerAttachments);
    }
    return;
  }
  const task = typedTask || 'Review the attached file or files and respond to the user.';
  const continuation = Boolean(chatRun?.id && ['completed', 'failed', 'cancelled', 'interrupted', 'awaiting_recovery'].includes(chatRun.status));
  const conversationId = continuation ? chatRun.id : '';
  const previousRun = chatRun;
  const submissionSelection = chatSelectionRevision;
  agentTask.value = '';
  pendingAgentAttachments = [];
  setAttachmentStatus('');
  renderPendingAttachments();
  if (!continuation) {
    discardLiveThought();
    agentTranscript.replaceChildren(); transcriptStickToBottom = true;
    renderPlan([]);
    renderGoals([]);
  }
  const attachmentLabel = attachments.length ? `\n\nAttached: ${attachments.map((item) => item.name).join(', ')}` : '';
  const renderedUserCard = renderChatMessage('user', `${typedTask || 'Review the attached file or files.'}${attachmentLabel}`, '', null, domMessageAttachments.length ? { domAttachments: domMessageAttachments } : {});
  renderChatApproval(null);
  try {
    renderChatState({ status: 'starting agent', step: 0, tabId: state.selectedTabId });
    await controlModeSave;
    const started = await window.browserUseDesktop.agentStart({
      task,
      attachments,
      domAttachments: domMessageAttachments,
      chatWindowId: standaloneChatWindowId || undefined,
      continuation,
      conversationId,
      tabId: state.selectedTabId,
      provider: { id: publicSettings.aiChatProvider || 'ollama', connectionId: publicSettings.aiChatConnectionId || '', model: selectedAgentModel || activeConnection()?.model || '' },
      settings: { approvalMode: agentPermission?.value || 'unattended', effort: agentEffort?.value || 'auto', controlMode: agentControlMode?.value || publicSettings.agentControlMode || 'browser', layaBrain: normalizeSystemOneBrain(publicSettings.layaBrain || (publicSettings.layaEnabled ? 'laya' : 'off')), layaEnabled: Boolean(publicSettings.layaEnabled), jevBaseUrl: publicSettings.jevBaseUrl, jevModelId: publicSettings.jevModelId }
    });
    if (!retiredConversationIds.has(started?.id)) {
      if (submissionSelection === chatSelectionRevision) renderChatState(started, { select: true });
      else if (isActiveAgentRun(started) && !olderChatSnapshot(started, activeChatRun)) { activeChatRun = started; renderChatControls(); }
    }
    renderChatApproval(chatRun?.pendingApproval);
  } catch (error) {
    // The renderer can briefly miss an active run (state refresh races). If
    // the main process reports the task as already active, queue the message
    // instead of surfacing an error modal — Enter while running must always
    // deliver as a queued turn.
    if (/already active/i.test(String(error?.message || ''))) {
      agentTask.value = '';
      pendingAgentAttachments = [];
      renderPendingAttachments();
      renderedUserCard?.remove();
      queueAgentMessage(task, attachments.map((attachment) => ({ ...attachment })));
      renderChatState(previousRun);
      return;
    }
    agentTask.value = typedTask;
    pendingAgentAttachments = attachments;
    renderPendingAttachments();
    renderChatMessage('error', error.message || 'Could not start the AI chat task.');
    if (!activeChatRun?.id) activeChatRun = null;
    renderChatState(previousRun);
  }
});
agentCancel.addEventListener('click', () => { void (async () => {
  if (activeSubagentTab !== 'main') { await stopActiveSubagent(); renderChatControls(); return; }
  const activeRun = await resolveActiveChatRun();
  if (!activeRun?.id) {
    reportError(new Error('The agent did not expose a cancellable run ID in time.'), 'Could not stop the AI chat task.');
    return;
  }
  agentCancel.disabled = true;
  try {
    const cancelled = await window.browserUseDesktop.agentCancel(activeRun.id);
    settleLiveThought();
    renderChatState(cancelled);
    renderChatApproval(null);
  } catch (error) {
    reportError(error, 'Could not stop the AI chat task.');
  } finally {
    agentCancel.disabled = !currentActiveChatRun();
  }
})(); });

// Delivery menu: the typed message either waits and auto-sends as the next
// conversation turn once the active run reaches a terminal status, or is
// fast-forwarded into the running task at its next thinking turn.
function queueTypedMessage() {
  const activeRun = currentActiveChatRun();
  const typedTask = agentTask.value.trim();
  const attachments = pendingAgentAttachments.map((attachment) => ({ ...attachment }));
  if (!activeRun?.id || (!typedTask && !attachments.length)) return;
  agentTask.value = '';
  pendingAgentAttachments = [];
  renderPendingAttachments();
  updateAgentRunButtons();
  queueAgentMessage(typedTask || 'Review the attached file or files.', attachments);
}
function fastForwardTypedMessage() { void (async () => {
  const activeRun = currentActiveChatRun();
  const typedTask = agentTask.value.trim();
  const attachments = pendingAgentAttachments.map((attachment) => ({ ...attachment }));
  const domMessageAttachments = domAttachmentApi?.normalizeDomAttachments?.(attachments
    .filter((item) => item.kind === 'file' && item.inline === true && item.selector)
    .map((item) => ({
      id: item.id, name: item.name, text: item.text, selector: item.selector, previewText: item.previewText,
      pageUrl: item.pageUrl, href: item.href, tag: item.tag, role: item.role, classes: item.classes
    }))) || [];
  if (!activeRun?.id || (!typedTask && !attachments.length)) return;
  const messageText = typedTask || 'Review the attached DOM element or file and respond to the user.';
  agentTask.value = '';
  pendingAgentAttachments = [];
  renderPendingAttachments();
  updateAgentRunButtons();
  renderChatMessage('user', messageText, '', null, domMessageAttachments.length ? { domAttachments: domMessageAttachments } : {});
  try {
    await window.browserUseDesktop.agentSteer({
      runId: activeRun.id, text: messageText, attachments, domAttachments: domMessageAttachments
    });
    showToast('Fast-forwarded, the agent receives it at its next thinking turn.');
  } catch (error) {
    reportError(error, 'Could not fast-forward the message.');
    agentTask.value = typedTask;
    pendingAgentAttachments = attachments;
    renderPendingAttachments();
    updateAgentRunButtons();
  }
})(); }
agentRunAction?.addEventListener('click', () => setAgentRunActionMenuOpen(agentRunActionMenu.hidden));
document.addEventListener('click', (event) => {
  if (agentRunActionMenu?.hidden || event.target.closest?.('#agent-run-action, #agent-run-action-menu')) return;
  setAgentRunActionMenuOpen(false);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && agentRunActionMenu && !agentRunActionMenu.hidden) { setAgentRunActionMenuOpen(false); agentRunAction?.focus(); }
});
agentRunActionMenu?.addEventListener('click', (event) => {
  const option = event.target.closest('[data-run-action]');
  if (!option) return;
  setAgentRunActionMenuOpen(false);
  if (option.dataset.runAction === 'fast-forward') fastForwardTypedMessage();
  else queueTypedMessage();
});

agentQueuedRemove.addEventListener('click', () => {
  queuedAgentMessage = '';
  renderQueuedMessage();
});

agentTask.addEventListener('input', updateAgentRunButtons);
consoleToggle.addEventListener('click', () => {
  const next = activeDrawer === 'console' ? null : 'console';
  // Await the native view transition: back-to-back clicks otherwise race the
  // renderer state against the overlay BrowserView's z-order update.
  window.browserUseDesktop.setActiveDrawer(next).catch((error) => reportError(error, 'Could not open the console.'));
});
recordingToggle?.addEventListener('click', () => {
  const next = activeDrawer === 'recorder' ? null : 'recorder';
  window.browserUseDesktop.setActiveDrawer(next).catch((error) => reportError(error, 'Could not open screen recorder.'));
});
settingsToggle.addEventListener('click', () => {
  const next = activeDrawer === 'settings' ? null : 'settings';
  window.browserUseDesktop.setActiveDrawer(next).catch((error) => reportError(error, 'Could not open settings.'));
});
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.close === 'agent' && standaloneChatWindowId) {
    window.browserUseDesktop.closeChatWindow(standaloneChatWindowId)
      .catch((error) => reportError(error, 'Could not close this chat.'));
    return;
  }
  requestDrawer(null);
}));
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  consoleFilter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
  renderConsole(consoleEntries);
}));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !deviceMenu.hidden) { setDeviceMenuOpen(false); return; }
  // Escape inside the agent chat stops the active run; only when nothing is
  // running does it close the drawer.
  if (event.key === 'Escape' && activeDrawer === 'agent' && isActiveAgentRun(chatRun) && !agentCancel.disabled) {
    event.preventDefault();
    agentCancel.click();
    return;
  }
  if (event.key === 'Escape' && activeDrawer) requestDrawer(null);
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
    event.preventDefault();
    address.focus();
    address.select();
    window.browserUseDesktop.setHistoryMenuOpen(true, historyMenuAnchor()).catch(() => {});
  }
  if ((event.ctrlKey || event.metaKey) && event.key === '`') { event.preventDefault(); terminalToggle.click(); }
});

document.addEventListener('contextmenu', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  const target = event.target instanceof Element ? event.target : null;
  const editableTarget = target?.closest('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]');
  const inputSelection = editableTarget instanceof HTMLInputElement || editableTarget instanceof HTMLTextAreaElement
    ? editableTarget.value.slice(editableTarget.selectionStart ?? 0, editableTarget.selectionEnd ?? 0)
    : '';
  void window.browserUseDesktop.showContextMenu({
    kind: 'shell',
    editable: Boolean(editableTarget),
    selection: inputSelection || window.getSelection?.().toString() || ''
  }).catch((error) => reportError(error, 'Could not open the context menu.'));
});
clearConsole.addEventListener('click', () => run(() => window.browserUseDesktop.clearConsole().then(renderConsole)));

function showToast(message, duration = 2400) {
  // Same BrowserView rule as the preview modal: a fixed toast on <body>
  // paints below the browser area. Keep one toast container per chat drawer
  // (absolute inside it) and fall back to the body container when no drawer
  // exists.
  let container = document.querySelector('.agent-drawer .toast-container');
  if (!container) {
    const drawer = document.querySelector('.agent-drawer');
    if (drawer) {
      container = document.createElement('div');
      container.className = 'toast-container';
      container.id = 'toast-container';
      container.setAttribute('aria-live', 'polite');
      drawer.append(container);
    }
  }
  if (!container) container = document.querySelector('#toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.append(toast);
  requestAnimationFrame(() => toast.classList.add('is-visible'));
  setTimeout(() => {
    toast.classList.remove('is-visible');
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

deviceToggle.addEventListener('click', () => {
  window.browserUseDesktop.toggleDeviceMenuOpen(deviceMenuAnchor())
    .catch((error) => reportError(error, 'Could not open the device menu.'));
});
// Device profile selection happens in overlay.html so it cannot fall behind the
// native browsing view. There is intentionally no chrome-side menu listener.
document.addEventListener('click', (event) => {
  if (deviceToggle.getAttribute('aria-expanded') !== 'true') return;
  if (event.target.closest('.device-control')) return;
  window.browserUseDesktop.setDeviceMenuOpen(false).catch(() => {});
});
rotateDevice.addEventListener('click', async () => {
  try {
    deviceState = await window.browserUseDesktop.rotateDevice();
    renderDeviceState({ ...state, device: deviceState });
  } catch (error) {
    reportError(error, 'Could not rotate the device.');
  }
});
terminalToggle.addEventListener('click', async () => {
  try {
    const layout = await window.browserUseDesktop.toggleTerminal();
    renderTerminalLayout(layout);
    if (layout.docked) await openTerminal();
  } catch (error) {
    reportError(error, 'Could not toggle the terminal.');
  }
});
terminalClose.addEventListener('click', async () => {
  try {
    renderTerminalLayout(await window.browserUseDesktop.toggleTerminal(false));
  } catch (error) {
    reportError(error, 'Could not close the terminal.');
  }
});
terminalRecover?.addEventListener('click', async () => {
  if (!terminalController?.sessionId) return;
  terminalRecover.disabled = true;
  renderTerminalSession({ ...terminalController.status, phase: 'recovering', alive: true });
  try {
    const recovered = await window.browserUseDesktop.terminalRecover(terminalController.sessionId);
    if (recovered?.blocked) { showToast('That terminal is still owned by a running agent task.'); return; }
    await terminalController.adopt(recovered.id, { history: recovered.history, readOnly: false, status: recovered });
    renderTerminalSession(recovered);
    showToast('Claude session recovery started.');
    void refreshTerminalSessions();
  } catch (error) { reportError(error, 'Could not recover the Claude session.'); }
  finally { terminalRecover.disabled = false; }
});

terminalReset.addEventListener('click', async () => {
  terminalReset.disabled = true;
  try {
    // Opening covers the case where the panel was never started; the
    // controller itself decides whether that means a first start or a restart.
    if (!terminalController) await openTerminal();
    else await terminalController.restart();
  } catch (error) {
    reportError(error, 'Could not restart the terminal.');
  } finally {
    terminalReset.disabled = false;
  }
});
terminalDetach.addEventListener('click', async () => {
  try {
    // The detached renderer adopts the main-owned shell. Stop the docked view
    // from issuing later resize/input calls, but do not dispose the session.
    terminalController?.releaseView();
    renderTerminalLayout(await window.browserUseDesktop.detachTerminal());
  } catch (error) {
    reportError(error, 'Could not detach the terminal.');
  }
});
terminalScreenshot.addEventListener('click', async () => {
  try {
    const shot = await window.browserUseDesktop.terminalScreenshot();
    showToast('📷 Image path copied to clipboard');
    if (terminalController?.isOpen) {
      terminalController.insert(`"${shot.path}"`);
    }
  } catch (error) {
    showToast(`Screenshot failed: ${error.message}`);
    reportError(error, 'Could not capture a screenshot.');
  }
});

let isSelectingElement = false;

terminalSelect.addEventListener('click', async () => {
  if (isSelectingElement) {
    try {
      await window.browserUseDesktop.cancelPickElement();
    } catch {}
    isSelectingElement = false;
    terminalSelect.classList.remove('is-active');
    showToast('Selection cancelled');
    return;
  }
  isSelectingElement = true;
  terminalSelect.classList.add('is-active');
  showToast('🎯 Click an element in page to select (Esc to cancel)');
  try {
    const result = await window.browserUseDesktop.pickElement();
    isSelectingElement = false;
    terminalSelect.classList.remove('is-active');
    if (!result?.picked) {
      showToast('Selection cancelled');
      return;
    }
    const sel = result.element.selector;
    if (terminalController?.isOpen) {
      terminalController.insert(`"${sel}"`);
    }
    await window.browserUseDesktop.copyText(sel);
    showToast(`Selected ${result.element.tag}: ${sel}`);
  } catch (error) {
    isSelectingElement = false;
    terminalSelect.classList.remove('is-active');
    showToast(`Select failed: ${error.message}`);
  }
});

// Dragging the divider resizes the dock. Pointer capture keeps the drag alive
// when the pointer crosses the native browser surface, which does not forward
// events back to this renderer.
terminalResize.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  terminalResize.setPointerCapture(event.pointerId);
  const startY = event.clientY;
  const startHeight = terminalPanel.getBoundingClientRect().height;
  let latest = startHeight;

  const onMove = (moveEvent) => {
    latest = startHeight + (startY - moveEvent.clientY);
    terminalPanel.style.height = `${Math.max(120, latest)}px`;
    terminalController?.scheduleFit();
  };
  const onUp = async () => {
    terminalResize.removeEventListener('pointermove', onMove);
    terminalResize.removeEventListener('pointerup', onUp);
    try {
      terminalResize.releasePointerCapture(event.pointerId);
    } catch {}
    try {
      renderTerminalLayout(await window.browserUseDesktop.setTerminalHeight(Math.round(latest)));
    } catch (error) {
      reportError(error, 'Could not resize the terminal.');
    }
  };
  terminalResize.addEventListener('pointermove', onMove);
  terminalResize.addEventListener('pointerup', onUp);
});

window.browserUseDesktop.onChatDockGeometry(applyChatDockGeometry);
window.browserUseDesktop.onState((nextState) => { render(nextState); renderChatSnapshot(nextState.agent?.chat); });
window.browserUseDesktop.onAgentEvent(handleAgentEvent);
window.browserUseDesktop.onConsole(renderConsole);
window.browserUseDesktop.onMcpState(renderMcp);
// A renderer can exist before its IPC subscriptions are installed. Exposing a
// readiness marker lets the real-Electron acceptance harness start through the
// same event path a person uses, rather than accidentally testing a dropped
// early event.
document.documentElement.dataset.browserUseRendererReady = 'true';
renderDrawers();
Promise.all([
  window.browserUseDesktop.state(),
  window.browserUseDesktop.settings(),
  window.browserUseDesktop.consoleEntries(),
  window.browserUseDesktop.desktopMcpStatus(),
  window.browserUseDesktop.deviceProfiles()
]).then(([nextState, currentSettings, entries, status, profiles]) => {
  deviceProfiles = profiles;
  render(nextState);
  renderChatSnapshot(nextState.agent?.chat);
  publicSettings = currentSettings;
  // Seed the System One brain from saved settings so the pill and settings
  // selector reflect reality. Legacy layaEnabled values migrate to laya.
  const layaStateInput = document.querySelector('#agent-laya-state');
  if (layaStateInput) {
    layaStateInput.value = normalizeSystemOneBrain(publicSettings.layaBrain || (publicSettings.layaEnabled ? 'laya' : 'off'));
    syncSystemOneSettings();
    syncAgentModePill();
  }
  // Seed the provider (Laya standalone) toggle the same way.
  const providerStateInput = document.querySelector('#agent-provider-state');
  if (providerStateInput) {
    providerStateInput.value = publicSettings.providerEnabled === false ? 'off' : 'on';
    syncAgentModePill();
  }
  const activeConnection = (currentSettings.aiConnections || []).find((item) => item.id === currentSettings.aiChatConnectionId && item.enabled !== false)
    || (currentSettings.aiConnections || []).find((item) => item.enabled !== false);
  selectedAgentConnectionId = activeConnection?.id || '';
  selectedModelTargetConnectionId = activeConnection?.id || '';
  selectedAgentModel = activeConnection?.model || '';
  renderAgentModelPicker();
  if (agentPermission) agentPermission.value = currentSettings.agentApprovalMode || 'unattended';
  if (agentControlMode) agentControlMode.value = currentSettings.agentControlMode || 'browser';
  if (agentEffort) agentEffort.value = currentSettings.agentEffort || 'auto';
  syncAgentModePill();
  syncAgentProviderOnboarding();
  void refreshAllAgentProviderModels({ quiet: true });
  renderChatSnapshot(nextState.agent?.chat);
  renderConsole(entries);
  renderMcp(status);
}).catch((error) => reportError(error, 'Browser-use could not start.'));
window.browserUseDesktop.rendererReady();

/* ===== browser-preview bridge hardening: persistent settings + working stubs ===== */
(function () {
  try {
    if (window.__bridgeHardened) return;
    // Skip entirely when the real remote bridge is active: its fake
    // "Preview reply" overrides would mask genuine agent/chat results.
    if (window.browserUseDesktop && window.browserUseDesktop.__webBridge) return;
    window.__bridgeHardened = true;
    var KEY = 'bu-fallback-settings';
    var orig = window.browserUseDesktop;
    if (!orig) return;
    var shim = {};
    function call(name, args) {
      try {
        var fn = orig[name];
        if (typeof fn === 'function') return fn.apply(orig, args || []);
      } catch (e) {}
      return undefined;
    }
    function load() {
      try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
    }
    var savedState = load() || {};
    try {
      (Array.isArray(savedState.aiConnections) ? savedState.aiConnections : []).forEach(function (c) {
        if (c && typeof c === 'object' && /^mimo-preview-/.test(String(c.model || ''))) delete c.model;
      });
    } catch (e) {}
    function mergeSaved(v) {
      if (!v || typeof v !== 'object') v = {};
      for (var k in savedState) {
        if (Object.prototype.hasOwnProperty.call(savedState, k) && v[k] == null && k !== 'aiConnections') v[k] = savedState[k];
      }
      if (!Array.isArray(v.aiConnections) || !v.aiConnections.length) {
        if (Array.isArray(savedState.aiConnections) && savedState.aiConnections.length) v.aiConnections = savedState.aiConnections.slice();
      }
      if (!Array.isArray(v.aiConnections)) v.aiConnections = [];
      return v;
    }
    function settings() {
      var s = call('settings', []);
      if (s && typeof s.then === 'function') {
        return s.then(function (v) { return mergeSaved(v); }, function () { return mergeSaved({}); });
      }
      return mergeSaved(s);
    }
    function withSettings(fn) {
      var s = settings();
      if (s && typeof s.then === 'function') return s.then(function (v) { return fn(v); }, function () { return fn(mergeSaved({})); });
      return fn(s);
    }
    function persist() {
      try {
        withSettings(function (s) {
          savedState = s;
          localStorage.setItem(KEY, JSON.stringify(s));
        });
      } catch (e) {}
    }
    settings();
    function refreshAll() {
      try {
        if (typeof window.refreshAllAgentProviderModels === 'function') window.refreshAllAgentProviderModels();
        else if (typeof window.refreshAgentProviderModels === 'function') window.refreshAgentProviderModels();
      } catch (e) {}
    }
    shim.settings = settings;
    ['setProviderCredential', 'setAiConnectionEnabled', 'deleteAiConnection', 'removeAiConnection'].forEach(function (name) {
      shim[name] = function () {
        var r = call(name, arguments);
        persist();
        refreshAll();
        return r;
      };
    });
    shim.saveAiConnection = function () {
      var input = (arguments[0] && typeof arguments[0] === 'object') ? arguments[0] : {};
      var r = call('saveAiConnection', arguments);
      try {
        withSettings(function (s) {
          var rid = (r && typeof r === 'object' && r.id) ? r.id : null;
          var rec = null;
          for (var i = 0; i < s.aiConnections.length; i++) {
            if (s.aiConnections[i] && (!rid || s.aiConnections[i].id === rid)) { rec = s.aiConnections[i]; break; }
          }
          if (rec && !input.model && rec.model === 'mimo-preview-1') delete rec.model;
          savedState = s;
          localStorage.setItem(KEY, JSON.stringify(s));
          refreshAll();
        });
      } catch (e) {}
      return r;
    };
    shim.addProviderModel = function (opts) {
      opts = opts || {};
      var model = opts.model || opts.id;
      return withSettings(function (s) {
        var conn = null;
        for (var i = 0; i < s.aiConnections.length; i++) {
          if (s.aiConnections[i] && s.aiConnections[i].id === opts.connectionId) { conn = s.aiConnections[i]; break; }
        }
        if (conn && model) {
          var list = Array.isArray(conn.customModels) ? conn.customModels.slice() : [];
          var exists = list.some(function (m) {
            var id = m && typeof m === 'object' ? (m.id || m.model) : m;
            return id === model;
          });
          if (!exists) {
            list.push({ id: model, model: model, name: model, kind: opts.kind || 'language', connectionId: conn.id });
          }
          conn.customModels = list;
          if (!conn.model) conn.model = model;
          savedState = s;
          localStorage.setItem(KEY, JSON.stringify(s));
        }
        refreshAll();
        return { ok: true, model: model };
      });
    };
    shim.removeProviderModel = function (opts) {
      opts = opts || {};
      return withSettings(function (s) {
        for (var i = 0; i < s.aiConnections.length; i++) {
          var conn = s.aiConnections[i];
          if (conn && conn.id === opts.connectionId && Array.isArray(conn.customModels)) {
            conn.customModels = conn.customModels.filter(function (m) {
              var id = m && typeof m === 'object' ? (m.id || m.model) : m;
              return id !== opts.model;
            });
          }
        }
        savedState = s;
        localStorage.setItem(KEY, JSON.stringify(s));
        refreshAll();
        return { ok: true };
      });
    };
    shim.listProviderModels = function (args) {
      args = args || {};
      var cid = args.connectionId || '';
      function entry(id, kind) {
        return { id: id, model: id, name: id, kind: kind || 'language', connectionId: cid };
      }
      var models = [];
      try {
        var live = call('settings', []);
        var s = mergeSaved((live && typeof live.then === 'function') ? {} : live);
        for (var i = 0; i < s.aiConnections.length; i++) {
          var conn = s.aiConnections[i];
          if (conn && conn.id === cid && Array.isArray(conn.customModels)) {
            conn.customModels.forEach(function (m) {
              var id = m && typeof m === 'object' ? (m.id || m.model) : m;
              if (id) models.push(entry(id, (m && m.kind) || 'language'));
            });
          }
        }
        var cached = (savedState && savedState.__catalog && savedState.__catalog[cid]) || [];
        cached.forEach(function (id) {
          if (id && !models.some(function (m) { return m.id === id; })) models.push(entry(id));
        });
        var baseUrl = args.baseUrl || '';
        var rawKey = args.apiKey || args.key || '';
        if (baseUrl && typeof fetch === 'function') {
          var directUrl = String(baseUrl).replace(/\/+$/, '') + '/models';
          var proxyUrl = '/__models-proxy?target=' + encodeURIComponent(directUrl) + (rawKey ? '&key=' + encodeURIComponent(rawKey) : '');
          var fetchJson = function (url, opts) {
            return fetch(url, opts || {}).then(function (res) {
              if (!res || !res.ok) throw new Error('catalog http ' + (res && res.status));
              return res.json();
            });
          };
          fetchJson(proxyUrl).catch(function () {
            return fetchJson(directUrl, { headers: rawKey ? { Authorization: 'Bearer ' + rawKey } : {} });
          }).then(function (data) {
            var ids = data && Array.isArray(data.data) ? data.data.map(function (d) { return d && (d.id || d); }).filter(Boolean) : [];
            if (ids.length) {
              savedState.__catalog = savedState.__catalog || {};
              savedState.__catalog[cid] = ids;
              localStorage.setItem(KEY, JSON.stringify(savedState));
              refreshAll();
            }
          }).catch(function (err) { try { console.warn('model catalog fetch failed:', err); } catch (e) {} });
        }
      } catch (e) {}
      return { models: models };
    };
    shim.generateMedia = function (args) {
      args = args || {};
      var prompt = args.prompt || args.task || 'your message';
      var model = args.model || 'the model';
      return Promise.resolve({
        kind: 'transcription',
        text: 'Preview reply from ' + model + ': "' + prompt + '" was received. A connected provider would answer here with full text, images, or audio.'
      });
    };
    function fakeRun(req) {
      req = req || {};
      var task = req.task || 'your message';
      var model = (req.provider && req.provider.model) || 'the model';
      var reply = 'Preview reply from ' + model + ': "' + task + '" was received. A connected provider would answer here with full text, images, or audio.';
      try {
        var box = document.getElementById('agent-transcript');
        if (box) {
          var art = document.createElement('article');
          art.className = 'agent-message is-assistant';
          var head = document.createElement('header');
          var strong = document.createElement('strong');
          strong.textContent = 'Assistant';
          head.appendChild(strong);
          var p = document.createElement('p');
          p.className = 'is-rich';
          p.textContent = reply;
          art.appendChild(head);
          art.appendChild(p);
          box.appendChild(art);
          box.scrollTop = box.scrollHeight;
        }
      } catch (e) {}
      return {
        id: 'run-' + Date.now(),
        status: 'completed',
        task: task,
        steps: [],
        messages: [
          { role: 'user', text: task },
          { role: 'assistant', text: reply }
        ],
        createdAt: Date.now(),
        updatedAt: Date.now()
      };
    }
    shim.agentStart = function (req) {
      var r = call('agentStart', [req]);
      if (r && typeof r.then === 'function') {
        return r.then(function (value) {
          return value && value.id ? value : fakeRun(req);
        }).catch(function () { return fakeRun(req); });
      }
      if (r && r.id) return r;
      return Promise.resolve(fakeRun(req));
    };
    shim.getState = function () {
      return call('getState', []) || { active: null, tabs: [], selectedTabId: null };
    };
    for (var key in orig) {
      try {
        if (!(key in shim)) {
          var val = orig[key];
          shim[key] = typeof val === 'function' ? val.bind(orig) : val;
        }
      } catch (e) {}
    }
    window.browserUseDesktop = new Proxy(shim, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        return function () { return undefined; };
      }
    });
    window.addEventListener('pagehide', persist);
    setInterval(persist, 1500);
  } catch (e) {
    try { console.warn('bridge hardening skipped', e); } catch (e2) {}
  }
})();
