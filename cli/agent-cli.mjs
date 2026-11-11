#!/usr/bin/env node
// cli/agent-cli.mjs
//
// Headless composition root for the REAL DesktopChatAgent loop (no Electron).
// Spawns headless Chrome, adapts it to the Electron tab shape through
// cli/webContentsAdapter.cjs, wires desktop/mcp/browserViewController.cjs and
// desktop/agent/desktopChatAgent.cjs to a REAL OpenAI-compatible provider
// (xkiro by default), records every agent emit() event into out-dir/trace.jsonl
// and writes out-dir/final-state.json when the run reaches a terminal state.
//
// An EXTERNAL observer clock (--max-seconds, --max-steps, --max-recoveries)
// stops a run through the agent's own cancel() path — it is the experiment
// harness's clock, not an agent watchdog. Recovery stays unbounded inside the
// agent (owner directive).
//
// Exit codes: 0 completed | 2 cancelled/timed out/step budget | 1 failed/error.
//
// MID-RUN MESSAGE QUEUE (desktop parity): with stdio[0]='pipe' (the TUI's
// spawn shape) this process reads JSON control lines from stdin —
//   {"type":"queue","text":"..."}\n
// Each line queues the text; when the current run reaches its terminal state
// the text delivers as a CONTINUATION run of the same conversation
// (cli/agentRunQueue.mjs runWithQueue), chained until the queue drains. An
// observer-cancelled run (external budget clock) holds the queue.
//
// Example:
//   node cli/agent-cli.mjs --task-file task.txt --model z-ai/glm-5.3-flash \
//     --max-seconds 240 --system-file variant1.md \
//     --out-dir scratch/harness-campaign/runs/run001

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
// Mid-run message queue (desktop parity): the TUI writes {"type":"queue",
// "text"} control lines to this child's stdin while a run is active; the
// queue drains as TRUE continuations of the same conversation when the run
// reaches its terminal state (cli/agentRunQueue.mjs).
import { createMessageQueue, parseControlLine, runWithQueue } from './agentRunQueue.mjs';

const require = createRequire(import.meta.url);
const { launchHeadlessChrome, killChromeTree, connectTab } = require('./webContentsAdapter.cjs');
// GEN9 (desktop/skills_mcp_plan.md): the CLI agent gets the SAME merged
// skillsApi the desktop uses — learned skills plus INSTALLED skill packages
// (user + repo scopes), so skill_search/skill_run find installed skills here
// exactly as they do in the app.
const { SkillsManager, createMergedSkillsApi } = require('../desktop/agent/skillsManager.cjs');
const { loadInstructionFiles, instructionBlockForTask } = require('../desktop/agent/instructionLoader.cjs');
const { disabledResearchRunner } = require('./stubs.cjs');
// DIRECTIVE (2026-10-13): the CLI has NO computer-tool permission gates. The
// refusing headless stub (cli/stubs.cjs, which failed every computer_* call)
// is replaced by the REAL backend — in-process TerminalManager
// (node-pty), PowerShell clipboard/screenshot, and the desktop's nativeWorker
// fork (koffi) for pointer/keyboard/observe. See cli/computerToolsBackend.cjs.
const { createCliComputerTools } = require('./computerToolsBackend.cjs');
// GEN-8 (defect A): task_spawn used to be dead in the CLI (spawnTask: null ->
// "Background agent runs are not available in this session."). The CLI now
// runs subagents as nested in-process DesktopChatAgent instances through an
// Electron-free AgentPool — each with its own trace + tab + provider.
const { createCliSubagentRuntime } = require('./cliSubagents.cjs');
const { AgentResultStore } = require('../desktop/agent/agentResultStore.cjs');

// Optional provider-request ground truth (BROWSER_USE_CLI_LOG_REQUESTS=<dir>):
// wraps globalThis.fetch BEFORE the provider module loads so every wire
// request is captured with url, status, timing and the request body. Bodies
// are written sanitized (credentials/token strings are redacted by the
// caller's own sanitizer only — raw bodies here may contain task text).
const logRequestsDir = process.env.BROWSER_USE_CLI_LOG_REQUESTS || null;
if (logRequestsDir) {
  fs.mkdirSync(logRequestsDir, { recursive: true });
  const originalFetch = globalThis.fetch.bind(globalThis);
  let requestIndex = 0;
  globalThis.fetch = async (url, init = {}) => {
    const index = requestIndex;
    requestIndex += 1;
    const startedAt = Date.now();
    try {
      const response = await originalFetch(url, init);
      let responseTail = '';
      try {
        if (response.body?.getReader) {
          // Tee: keep the stream usable for the provider, capture a tail.
          const [streamA, streamB] = response.body.tee();
          Object.defineProperty(response, 'body', { value: streamA });
          const reader = streamB.getReader();
          const chunks = [];
          void (async () => {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(Buffer.from(value));
              if (chunks.reduce((total, chunk) => total + chunk.length, 0) > 8000) { reader.cancel().catch(() => {}); break; }
            }
          })().catch(() => {}).finally(() => { responseTail = Buffer.concat(chunks).toString('utf8').slice(0, 8000); });
        }
      } catch { /* tee unavailable */ }
      if (init?.body) {
        const bodyText = typeof init.body === 'string' ? init.body : '';
        if (bodyText) fs.writeFileSync(path.join(logRequestsDir, `request-${String(index).padStart(4, '0')}.json`), bodyText);
      }
      const record = { index, url: String(url), status: response.status, ms: Date.now() - startedAt, at: new Date().toISOString(), bodyBytes: typeof init?.body === 'string' ? init.body.length : 0 };
      fs.writeFileSync(path.join(logRequestsDir, `response-${String(index).padStart(4, '0')}.json`), JSON.stringify(record) + '\n' + responseTail);
      return response;
    } catch (error) {
      fs.writeFileSync(path.join(logRequestsDir, `response-${String(index).padStart(4, '0')}.json`), JSON.stringify({ index, url: String(url), transportError: String(error?.message || error), ms: Date.now() - startedAt }) + '\n');
      throw error;
    }
  };
}

// ---------------------------------------------------------------- args ----
// Env-proof channel (BROWSER_USE_CLI_ENV_PROOF=<file>): writes whether the
// credential env variables survived into this child process. This is the
// capture-grade proof for the TUI's scrub contract — the TUI must pass the
// resolved key via --api-key and the child env must NOT carry the ambient
// shell credential variables.
const envProofPath = process.env.BROWSER_USE_CLI_ENV_PROOF || null;
if (envProofPath) {
  try {
    fs.writeFileSync(envProofPath, JSON.stringify({
      pid: process.pid,
      at: new Date().toISOString(),
      env: {
        XKIRO_API_KEY: 'XKIRO_API_KEY' in process.env,
        ANTHROPIC_AUTH_TOKEN: 'ANTHROPIC_AUTH_TOKEN' in process.env,
        XKIRO_BASE_URL: 'XKIRO_BASE_URL' in process.env
      }
    }, null, 2) + '\n');
  } catch { /* proof must never break the run */ }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

function parseNumber(value, label, { min = 0 } = {}) {
  if (value === undefined || value === '' || value === true) return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new Error(`--${label} must be a number >= ${min}.`);
  return parsed;
}

// ------------------------------------------------------- credentials ------
function readClaudeSettingsCredentials() {
  // xkiro credentials live in the user's Claude settings, never in source.
  const result = { baseUrl: null, apiKey: null, source: null };
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const env = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.env || {};
    if (env.ANTHROPIC_BASE_URL) result.baseUrl = String(env.ANTHROPIC_BASE_URL);
    if (env.ANTHROPIC_AUTH_TOKEN) { result.apiKey = String(env.ANTHROPIC_AUTH_TOKEN); result.source = 'claude-settings'; }
  } catch { /* absent settings fall through to explicit overrides */ }
  return result;
}

// ------------------------------------------------------------ sanitize ----
const SENSITIVE_KEYS = new Set(['apikey', 'api_key', 'authtoken', 'auth_token', 'authorization', 'xapikey', 'accesstoken', 'token', 'password']);
function sanitize(value, { maxString = 12_000, depth = 0 } = {}) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && value.length > maxString) return `[sanitized-string:${value.length}]`;
    return value;
  }
  if (depth > 12) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 400).map((item) => sanitize(item, { maxString, depth: depth + 1 }));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof item === 'string' && item.length > 0) {
      out[key] = '[redacted-credential]';
    } else {
      out[key] = sanitize(item, { maxString, depth: depth + 1 });
    }
  }
  return out;
}

// ---------------------------------------------------------------- main ----
// The boot-time Chrome launch promise lives at module scope so the top-level
// failure path can kill the browser if the run dies before awaiting it.
let bootLaunch = null;

// --- stdin control protocol (mid-run message queue) ------------------------
// The TUI spawns agent-cli with stdio ['pipe','pipe','pipe'] and writes one
// JSON control line per mid-run submission: {"type":"queue","text":"..."}\n.
// Headless harness callers that keep stdio[0]='ignore' simply have no
// readable stdin — the reader is optional and never fatal.
//
// FAST-FORWARD (steer the live run immediately — the desktop's other
// dropdown option) is a deliberate FOLLOW-UP, not implemented yet. Its
// delivery path IS this reader: a future {"type":"steer","text"} control
// line would route into the live run's pendingUserMessages
// (DesktopChatAgent.deliverSteering) at the next thinking turn.
function installControlStdin({ queue, writeTrace }) {
  try {
    if (!process.stdin || typeof process.stdin.on !== 'function') return null;
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += String(chunk);
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        const control = parseControlLine(line);
        if (!control) continue;
        const text = queue.push(control.text);
        if (text) writeTrace({ type: 'harness.queue.received', chars: text.length, pending: queue.size() });
      }
    });
    process.stdin.on('error', () => { /* a closed/ignored stdin must never break the run */ });
    process.stdin.on('end', () => { /* the controller closed the pipe — the run carries on */ });
    return process.stdin;
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { printUsage(); process.exit(0); }

  const task = String(args.task || (args['task-file'] ? fs.readFileSync(path.resolve(args['task-file']), 'utf8') : '')).trim();
  if (!task) throw new Error('A task is required: pass --task "..." or --task-file <path>.');

  const providerId = String(args['provider-id'] || 'xkiro');
  const model = String(args.model || 'z-ai/glm-5.3-flash');
  const claudeSettings = readClaudeSettingsCredentials();
  // Credential priority per the harness contract: explicit --api-key and
  // XKIRO_API_KEY override; the ~/.claude/settings.json token is the base.
  // A shell-inherited ANTHROPIC_AUTH_TOKEN (possibly stale, e.g. from a
  // harness wrapper) is the LAST fallback, never preferred over the file.
  const apiKey = String(args['api-key'] || process.env.XKIRO_API_KEY || claudeSettings.apiKey || process.env.ANTHROPIC_AUTH_TOKEN || '');
  // Default base URL: ANTHROPIC_BASE_URL carries the bare gateway host. The
  // provider's Anthropic route builds /v1/messages itself, but its OpenAI
  // route appends only /chat/completions — so the default (and any override
  // lacking /v1 unless the caller passed it verbatim) gets /v1 appended.
  // providerEndpoint() collapses a double /v1 for the Anthropic route, so one
  // default serves both protocols. An explicit --base-url is used verbatim.
  const rawBaseUrl = String(args['base-url'] || process.env.XKIRO_BASE_URL || claudeSettings.baseUrl || 'https://api.xkiro.com');
  const trimmedBaseUrl = rawBaseUrl.replace(/\/+$/, '');
  const baseUrl = args['base-url'] ? trimmedBaseUrl : (trimmedBaseUrl.endsWith('/v1') ? trimmedBaseUrl : `${trimmedBaseUrl}/v1`);
  if (!apiKey) throw new Error('No provider API key: pass --api-key, set XKIRO_API_KEY, or configure ~/.claude/settings.json env.ANTHROPIC_AUTH_TOKEN.');

  const maxSeconds = parseNumber(args['max-seconds'], 'max-seconds');
  const maxSteps = parseNumber(args['max-steps'], 'max-steps');
  const maxRecoveries = parseNumber(args['max-recoveries'], 'max-recoveries');
  const controlMode = String(args['control-mode'] || 'browser') === 'agi' ? 'agi' : 'browser';
  const systemMode = String(args['system-mode'] || 'agi') === 'coding' ? 'coding' : 'agi';
  const systemFile = args['system-file'] ? path.resolve(String(args['system-file'])) : null;
  const systemText = systemFile ? fs.readFileSync(systemFile, 'utf8') : null;
  const outDir = path.resolve(String(args['out-dir'] || `scratch/agent-cli-runs/run-${Date.now()}`));
  const runId = String(args['run-id'] || `run-${Date.now()}`);
  const headed = args.headed === true || process.env.BROWSER_USE_CLI_HEADED === '1';
  const quiet = args.quiet === true;
  // WORKING REPO (defect 4): --cwd roots the child (the caller's invocation
  // dir or a /cd override); --workspace declares it as the run's workspace
  // contract so the agent's file tools, terminals and scope checks operate
  // where the USER launched the CLI — never a hard-coded repo. Declared only
  // when explicitly passed: direct agent-cli callers keep the old
  // task-derived behavior untouched.
  const cwdDir = args.cwd ? path.resolve(String(args.cwd)) : null;
  const workspaceDir = args.workspace
    ? path.resolve(String(args.workspace))
    : (args.cwd ? cwdDir : null);

  // RESUME (--resume <out-dir>): continue a PREVIOUS run's conversation —
  // the /history row the user clicked (or /resume named). The old run's
  // final-state.json carries its full serialized conversation (state:
  // messages, history, providerLedger, notebookPath); restoreConversationSnapshot
  // rehydrates it in DesktopChatAgent.start and the new task text becomes the
  // conversation's next user turn. Fresh artifacts land in the NEW out-dir —
  // the resumed bundle stays untouched.
  let resumeConversation = null;
  const resumeDir = args.resume ? path.resolve(String(args.resume)) : null;
  if (resumeDir) {
    const resumeFinalStatePath = path.join(resumeDir, 'final-state.json');
    if (!fs.existsSync(resumeFinalStatePath)) {
      throw new Error(`--resume: no final-state.json under ${resumeDir} — nothing to resume.`);
    }
    const resumeState = JSON.parse(fs.readFileSync(resumeFinalStatePath, 'utf8'))?.state || null;
    if (!resumeState || !Array.isArray(resumeState.messages) || !resumeState.messages.length) {
      throw new Error(`--resume: ${resumeDir} carries no restorable conversation.`);
    }
    resumeConversation = resumeState;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const tracePath = path.join(outDir, 'trace.jsonl');
  fs.writeFileSync(tracePath, '');

  const startedAtMs = Date.now();
  const t0 = performance.now();

  // DEFECT 3a (2026-10-12): runs that exited without a terminal state (signal,
  // wedged model call, uncaught error, TUI taskkill) left NO final-state.json
  // — the TUI then showed "status unknown · failed · verified — · decisions —"
  // with no reason. Every exit path now finalizes through
  // writeFinalStateFileSync: the normal end path, the observer's force-exit
  // backstop, signals, uncaughtException, and a process 'exit' hook that
  // catches anything else synchronously.
  const meta = {
    runId,
    task,
    model,
    providerId,
    baseUrl,
    systemFile: null,
    systemMode: null,
    systemPromptChars: null,
    maxSeconds,
    maxSteps,
    maxRecoveries,
    controlMode,
    startUrl: null,
    headed,
    resumedFrom: resumeDir || null,
    startedAt: new Date(startedAtMs).toISOString()
  };
  let finalStateWritten = false;
  let lastUnhandled = null;
  let agent = null; // assigned below once the agent is constructed
  // Observer-clock state hoisted ABOVE writeFinalStateFileSync / the exit
  // hook: both read these, and they used to be declared ~260 lines later —
  // an early exit hit the temporal dead zone, crashed the crash handler, and
  // final-state.json was never written ("run died without a terminal state").
  let timedOut = false;
  let stopReason = null;
  let cancelIssued = false;
  let forceExitTimer = null;
  let observedState = null;
  const writeFinalStateFileSync = ({ status, exitCode, stopReasonExtra = '', result = null }) => {
    if (finalStateWritten) return;
    finalStateWritten = true;
    try {
      let best = null;
      try { best = agent ? agent.state() : null; } catch { /* agent gone */ }
      if (!best) best = observedState || {};
      const recoveryError = String(best?.recovery?.lastError || '').trim()
        || lastProviderFailureFromState(best) || '';
      const stopReason = [stopReasonExtra || stopReason || '', recoveryError ? `last connection error: ${recoveryError}` : '', lastUnhandled ? `last unhandled rejection: ${lastUnhandled}` : '']
        .filter(Boolean).join(' · ') || null;
      const counts = (() => {
        try {
          const lines = fs.readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
          return {
            decisionCount: Number(best?.decisionCount || 0),
            stepCount: Number(best?.step || 0),
            traceLines: lines.length,
            toolResultEvents: lines.filter((l) => l.includes('"tool.result"')).length
          };
        } catch {
          return { decisionCount: Number(best?.decisionCount || 0), stepCount: Number(best?.step || 0), traceLines: traceLines, toolResultEvents: 0 };
        }
      })();
      const payload = {
        meta: {
          ...meta,
          endedAt: new Date().toISOString(),
          elapsedMs: Date.now() - startedAtMs,
          timedOut,
          stopReason,
          lastConnectionError: recoveryError || null,
          startThrew: startError ? String(startError?.message || startError) : null,
          exitCode
        },
        counts,
        toolCallCount: 0,
        toolCalls: [],
        result: result || (status !== 'completed' && recoveryError ? { ok: false, summary: recoveryError } : null),
        status,
        state: null
      };
      fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify(payload, null, 2));
    } catch { /* a final-state write must never crash the exit path */ }
  };
  process.on('exit', () => {
    if (finalStateWritten) return;
    writeFinalStateFileSync({ status: timedOut ? 'cancelled' : 'failed', exitCode: timedOut ? 2 : 1, stopReasonExtra: 'process exited before a terminal state was reached' });
  });

  const traceStream = fs.createWriteStream(tracePath, { flags: 'a' });
  let traceLines = 0;
  const writeTrace = (event) => {
    try {
      const line = JSON.stringify({ ts: Date.now(), ms: Math.round(performance.now() - t0), ...sanitize(event) });
      traceStream.write(line + '\n');
      traceLines += 1;
    } catch { /* a trace write must never break the run */ }
  };

  // DEFECT 3 (startup latency): Chrome starts CONCURRENTLY with the module
  // loads below — require() is synchronous CPU work while the browser process
  // boots on its own; launching AFTER the requires (the old order) queued the
  // chrome spawn behind them for nothing. Timings land in the trace
  // (harness.boot.*) so the startup path stays measurable.
  const bootT0 = performance.now();
  bootLaunch = launchHeadlessChrome({ startPort: 9333, profileDir: args['profile-dir'] ? path.resolve(String(args['profile-dir'])) : null, headed });
  bootLaunch.catch(() => {}); // never unhandled if a require below throws first

  // PROMPT OVERRIDE: --system-file no longer monkey-patches a prompt
  // function — the text rides on the run request and the harness registers
  // it as a complete:true section (the whole-prompt replacement mode).
  require('../desktop/computer/computerCatalog.cjs');
  let promptOverride = null;
  if (systemText !== null) {
    promptOverride = { file: systemFile, mode: systemMode, chars: systemText.length };
  }
  const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
  const { createVisionDescriber } = require('../desktop/agent/visionDelegate.cjs');
  // CLI PARITY (project rule: agent improvements ship to both surfaces):
  // media generation (imagePath/saveTo) + the model_catalog backend with the
  // capability-resolution ladder — the same behavior desktop/main.cjs wires.
  const { createCliModelTaskApi, createCliCatalogApi } = require('./cliAgentApis.cjs');
const { createCliAndroidApi } = require('./cliAndroidApi.cjs');
  writeTrace({ type: 'harness.boot', phase: 'modules', ms: Math.round(performance.now() - bootT0) });

  // --- headless browser ----------------------------------------------------
  const launch = await bootLaunch;
  writeTrace({ type: 'harness.boot', phase: 'chrome', ms: Math.round(performance.now() - bootT0) });
  const tabs = new Map();
  let selectedTabId = null;

  const openTab = async (url) => {
    const { tab, adapter } = await connectTab({ host: '127.0.0.1', port: launch.port, targetId: null });
    tabs.set(tab.id, { tab, adapter });
    selectedTabId = tab.id;
    if (url && url !== 'about:blank') await adapter.loadURL(url).catch(() => {});
    return tab;
  };
  const initialTab = await openTab('about:blank');
  writeTrace({ type: 'harness.boot', phase: 'tab', ms: Math.round(performance.now() - bootT0) });
  // --url pre-opens the task's page in the selected tab, mirroring the desktop
  // app where the user already has the relevant page open before starting.
  const startUrl = args.url ? String(args.url) : null;
  if (startUrl) await initialTab.webContents.loadURL(startUrl).catch((error) => {
    writeTrace({ type: 'harness.start-url.load-failed', url: startUrl, error: String(error?.message || error) });
  });

  const controller = new BrowserViewController({
    getTabs: () => [...tabs.values()].map((entry) => entry.tab),
    getSelectedTabId: () => selectedTabId,
    getConsoleEntries: () => [...tabs.values()].flatMap((entry) => entry.adapter.getConsoleEntries()),
    normalizeUrl: (value) => {
      const raw = String(value ?? '').trim();
      if (/^(https?|file|about|data|chrome|view-source):/i.test(raw)) return raw;
      if (/^[\w-]+(\.[\w-]+)+/.test(raw)) return `https://${raw}`;
      return raw;
    },
    createTab: async (url) => {
      const previous = selectedTabId;
      const tab = await openTab(typeof url === 'string' ? url : 'about:blank');
      selectedTabId = previous; // Electron createTab does not steal selection
      return tab;
    },
    closeTab: async (tabId) => {
      const entry = tabs.get(String(tabId));
      if (!entry) return;
      tabs.delete(String(tabId));
      await entry.adapter.close().catch(() => {});
      const root = await (await import('chrome-remote-interface')).default({ host: '127.0.0.1', port: launch.port, target: (targets) => targets.find((t) => t.type === 'browser') || targets[0] });
      try { await root.Target.closeTarget({ targetId: String(tabId) }); } catch { /* already gone */ }
      await root.close().catch(() => {});
      if (selectedTabId === String(tabId)) selectedTabId = [...tabs.keys()][0] || null;
    },
    isTabPaintable: () => true,
    ensureTabPaintable: null,
    deviceEmulator: null,
    debuggerLeaseManager: null,
    pointerVisualizer: null
  });

  // --- agent + real provider ----------------------------------------------
  const providerConfig = { id: providerId, model, baseUrl, apiKey };
  const cliAndroidApi = createCliAndroidApi({
    adbPath: String(args['adb-path'] || process.env.ADB_PATH || 'adb'),
    scrcpyPath: String(args['scrcpy-path'] || process.env.SCRCPY_PATH || 'scrcpy'),
    onEvent: (event) => writeTrace({ type: 'harness.android.device', ...event })
  });

  // GEN-8 subagent runtime (defect A fix): nested in-process DesktopChatAgent
  // children behind an Electron-free AgentPool. Each child gets its own
  // background tab (never steals the selected tab), its own trace under
  // <outDir>/subagents/<NN>-<alias>/ whose FIRST line is the spawning task
  // text (Feature C), and the parent run's provider config. Lifecycle events
  // mirror into the main trace as harness.subagent.* for the TUI.
  const subagentRuntime = createCliSubagentRuntime({
    getAgent: () => agent,
    controller,
    getSelectedTabId: () => selectedTabId,
    setSelectedTabId: (tabId) => { if (tabs.has(String(tabId))) selectedTabId = String(tabId); },
    openSubagentTab: async (url) => {
      const { tab, adapter } = await connectTab({ host: '127.0.0.1', port: launch.port, targetId: null });
      tabs.set(tab.id, { tab, adapter });
      if (url && url !== 'about:blank') await tab.webContents.loadURL(url).catch(() => {});
      return { id: String(tab.id) };
    },
    closeTab: (tabId) => controller.closeTab(tabId),
    createProvider: (config) => createOpenAiCompatibleProvider({
      providerId: config.id,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey
    }),
    controlMode,
    createComputerTools: () => createCliComputerTools(),
    emitMain: writeTrace,
    sanitize,
    outDir
  });

  // GEN9-SKILLS: merged skillsApi — learned store (when one exists) plus the
  // installed skill packages in the SHARED scopes (~/.browser-use-cli/skills +
  // <pinned repo>/.browser-use/skills). Same shape the desktop passes.
  // DECLARED BEFORE the DesktopChatAgent factory below consumes it — this
  // block used to sit after the factory call, so every run died on
  // "Cannot access 'gen9SkillsApi' before initialization" right after boot.
  let gen9SkillsApi = null;
  try {
    const gen9LearnedPath = path.join(os.homedir(), '.browser-use-cli', 'learned-skills.json');
    const gen9Learned = fs.existsSync(gen9LearnedPath)
      ? new (require('../desktop/record/skills.cjs').SkillStore)(gen9LearnedPath)
      : null;
    const gen9Manager = new SkillsManager({
      userDir: path.join(os.homedir(), '.browser-use-cli', 'skills'),
      repoDir: workspaceDir ? path.join(workspaceDir, '.browser-use', 'skills') : null
    });
    if (gen9Learned || gen9Manager.list().length) {
      gen9SkillsApi = createMergedSkillsApi({ learnedStore: gen9Learned, manager: gen9Manager });
      meta.installedSkills = gen9Manager.list().length;
    }
  } catch { /* a missing skill store must never block a run */ }

  // GEN9-INSTRUCTIONS: the pinned repo's instruction file (lorde.md >
  // AGENTS.md > CLAUDE.md, 8KB cap, largest-first truncation + notice)
  // prepended to every run's task text as pinned context. SINGLE-INJECTION
  // RULE: when desktopChatAgent STUB 3 (in-agent run-start injection) lands,
  // this prepend is REMOVED in the same change — never both.
  let gen9Instructions = null;
  try {
    gen9Instructions = loadInstructionFiles({ repoRoot: workspaceDir || '', cwd: cwdDir || process.cwd() });
    if (gen9Instructions) {
      meta.instructions = gen9Instructions.files.map(file => ({ name: file.name, path: file.path, chars: file.chars, truncated: file.truncated }));
    }
  } catch { /* instructions must never block a run */ }
  const gen9TaskWithInstructions = (taskText) => instructionBlockForTask(taskText, gen9Instructions);

  agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => selectedTabId,
    createTab: (url) => openTab(url),
    closeTab: async (tabId) => controller.closeTab(tabId),
    selectTab: (tabId) => { if (tabs.has(String(tabId))) selectedTabId = String(tabId); },
    focusTab: null,
    writeReportFile: null,
    modelTaskApi: createCliModelTaskApi({
      baseUrl, apiKey, model, outDir,
      onNote: (note) => writeTrace({ type: 'harness.modelTask.note', note })
    }),
    catalogApi: createCliCatalogApi({ baseUrl, apiKey, model, providerId, fetchImpl: fetch, cacheDir: path.join(require('os').homedir(), '.browser-use') }),
    androidApi: cliAndroidApi,
    getComputerTools: controlMode === 'agi' ? () => createCliComputerTools() : null,
    getControlMode: () => controlMode,
    emit: writeTrace,
    createProvider: (config) => createOpenAiCompatibleProvider({
      providerId: config.id,
      baseUrl: config.baseUrl,
      model: config.model,
      apiKey: config.apiKey,
      // VISION DELEGATE (CLI parity): a text-only run delegates image
      // viewing to a vision-capable model on the same endpoint.
      visionDelegate: createVisionDescriber({ baseUrl: config.baseUrl, apiKey: config.apiKey, excludeModel: config.model })
    }),
    onTerminal: null,
    onCheckpoint: null,
    // LORDE_AI_CHAT_TITLES_V1 — TUI parity: the model names the conversation
    // as it evolves (surfaced through the run.title trace event).
    titleApi: async ({ model: titleModel = '', prompt = '' } = {}) => {
      if (!prompt) throw new Error('Title prompt is empty.');
      const base = String(baseUrl || '').replace(/\/$/, '');
      const headers = { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
      const chosenModel = titleModel || model || '';
      const extract = (payload) => String(payload?.choices?.[0]?.message?.content ?? payload?.message?.content ?? '').trim();
      try {
        const response = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: chosenModel, messages: [{ role: 'user', content: prompt }], max_tokens: 32, temperature: 0.3, stream: false }) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = extract(await response.json());
        if (!text) throw new Error('Empty title response.');
        return text;
      } catch (error) {
        if (providerId !== 'ollama') throw error;
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
    scheduleApi: null,
    // GEN-8 (defect A): subagents run for real — the same tool surface the
    // desktop injects, no permission gates.
    spawnTask: subagentRuntime.spawnTask,
    // GEN9-SKILLS: installed skill packages + learned skills, merged (null
    // when neither store has anything — identical to the old behavior).
    skillsApi: gen9SkillsApi,
    messageApi: subagentRuntime.messageApi,
    subagentApi: subagentRuntime.subagentApi,
    // CLI parity: large tool results get the same durable resultId store as
    // desktop, so read_agent_result can retrieve omitted Git/search output
    // instead of the agent re-running the original command.
    createResultStore: (conversationId) => new AgentResultStore(path.join(outDir, 'agent-results'), conversationId),
    researchRunner: disabledResearchRunner,
    researchMetaSearch: null,
    knowledgeStore: null,
    layaVerifierFactory: null,
    jevVerifierFactory: null,
    // GEN9: the run's persistent notebook lives IN the run's out-dir —
    // out-dir/notebook.md — so /notebook in the TUI (or any editor) reaches
    // it and the run dir is the single artifact bundle.
    notebookDir: outDir
  });

  // Launch-time fields attach to the meta base declared above (defect 3a —
  // the exit hook can run before this point and still needs a valid meta).
  meta.chromeProfile = launch.profile;
  meta.systemFile = promptOverride?.file || null;
  meta.systemMode = promptOverride ? systemMode : null;
  meta.systemPromptChars = promptOverride?.chars || null;
  meta.startUrl = startUrl;
  if (cwdDir) meta.cwd = cwdDir;
  if (workspaceDir) meta.workspace = workspaceDir;

  // --- external observer clock ---------------------------------------------
  // PER-RUN CLOCK (mid-run message queue): every run — the initial task AND
  // each queued-message continuation — gets its own full observer budget.
  // The clock only polices a LIVE run (`runActive`); between a terminal state
  // and the next continuation start the interval idles.
  let runActive = false;
  let runStartedAtMs = startedAtMs;
  const observer = setInterval(() => {
    if (!runActive || cancelIssued) return;
    try { observedState = agent.state(); } catch { return; }
    if (!observedState?.id) return;
    const elapsed = Date.now() - runStartedAtMs;
    if (maxSeconds > 0 && elapsed >= maxSeconds * 1000) {
      timedOut = true;
      stopReason = `external observer clock: elapsed ${Math.round(elapsed / 1000)}s >= max-seconds ${maxSeconds}`;
    } else if (maxSteps > 0 && Number(observedState.step || 0) >= maxSteps) {
      stopReason = `external observer: step ${observedState.step} >= max-steps ${maxSteps}`;
    } else if (maxRecoveries > 0 && Number(observedState.recovery?.attempts || 0) > maxRecoveries) {
      stopReason = `external observer: recovery attempts ${observedState.recovery.attempts} > max-recoveries ${maxRecoveries}`;
    } else if (observedState.status === 'awaiting_approval') {
      stopReason = 'external observer: run stuck awaiting_approval (unattended mode should auto-resolve)';
    } else {
      return;
    }
    cancelIssued = true;
    writeTrace({ type: 'harness.observer.cancel', run: { id: observedState.id }, reason: stopReason, timedOut });
    try { agent.cancel(observedState.id); } catch (error) {
      writeTrace({ type: 'harness.observer.cancel-error', error: String(error?.message || error) });
    }
    // FORCE-EXIT BACKSTOP: agent.cancel() cannot interrupt a wedged model call
    // or transport await — the run then hangs forever past the observer clock
    // (observed live: two runs hung ~3h). If the normal terminal path has not
    // finished within 20s of the cancel, finalize the minimal honest state and
    // exit hard so the caller's clock is never defeated.
    if (!forceExitTimer) {
      forceExitTimer = setTimeout(() => {
        try { writeTrace({ type: 'harness.observer.force-exit', reason: 'terminal path did not settle 20s after cancel' }); } catch { /* trace may be closed */ }
        try { void subagentRuntime.cancelAll('observer force-exit'); } catch { /* best effort */ }
        try {
          traceStream.end(() => {
            writeFinalStateFileSync({ status: 'cancelled', exitCode: 2, stopReasonExtra: (stopReason || '') + ' [force-exit]' });
            try { killChromeTree(launch); } catch { /* best effort */ }
            process.exit(2);
          });
        } catch {
          writeFinalStateFileSync({ status: 'cancelled', exitCode: 2, stopReasonExtra: (stopReason || '') + ' [force-exit]' });
          try { killChromeTree(launch); } catch { /* best effort */ }
          process.exit(2);
        }
      }, 20_000);
      if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();
    }
  }, 500);
  if (typeof observer.unref === 'function') observer.unref();

  const onSignal = (signal) => {
    writeTrace({ type: 'harness.signal', signal });
    try { if (observedState?.id) agent.cancel(observedState.id); } catch { /* terminal already */ }
    // GEN-8 process hygiene: spawned subagent children die with the parent.
    try { void subagentRuntime.cancelAll(`parent received ${signal}`); } catch { /* best effort */ }
    // Signal path: the cancel must settle the run within the same 20s window —
    // the same backstop the observer cancel uses (defect 3a).
    if (!forceExitTimer && !finalStateWritten) {
      forceExitTimer = setTimeout(() => {
        try { writeTrace({ type: 'harness.signal.force-exit', reason: `terminal path did not settle 20s after ${signal}` }); } catch { /* trace may be closed */ }
        writeFinalStateFileSync({ status: 'cancelled', exitCode: 2, stopReasonExtra: `${signal}: terminal path did not settle within 20s [force-exit]` });
        try { killChromeTree(launch); } catch { /* best effort */ }
        process.exit(2);
      }, 20_000);
      if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref();
    }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('uncaughtException', (error) => {
    writeTrace({ type: 'harness.uncaughtException', error: String(error?.stack || error) });
    // DEFECT 3a: an uncaught exception is not survivable state — finalize an
    // honest failed final-state.json, then exit 1 (never a silent death).
    writeFinalStateFileSync({ status: 'failed', exitCode: 1, stopReasonExtra: `uncaughtException: ${String(error?.message || error)}` });
    try { void subagentRuntime.cancelAll('parent uncaughtException'); } catch { /* best effort */ }
    try { killChromeTree(launch); } catch { /* best effort */ }
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    // The agent's own recovery owns rejections (indefinite recovery, owner
    // directive) — record the last one for the exit hook's stopReason, keep
    // running, and surface it if the process dies anyway.
    lastUnhandled = String((error && error.message) || error);
    writeTrace({ type: 'harness.unhandledRejection', error: String(error?.stack || error) });
  });

  // --- the real run (+ the mid-run message queue → continuation chain) -----
  // MID-RUN MESSAGES ARE QUEUED, NEVER LOST (desktop parity — the desktop
  // app's queueAgentMessage / maybeAutoSendQueued pair): while a run is
  // active, the TUI writes {"type":"queue","text"} control lines to this
  // process's stdin. When the run reaches its terminal state and the queue
  // is non-empty, runWithQueue starts a CONTINUATION run with the queued
  // text — the same in-process DesktopChatAgent instance, so the
  // conversation (history, plan, ledger) carries over through the SAME
  // continuation path the desktop app uses (request.continuation +
  // request.conversationId). After each continuation completes, the next
  // queued message delivers. Each continuation publishes fresh run.started /
  // run.completed events into the trace — the TUI's trace tail sees every
  // continuation as a new run.
  const queue = createMessageQueue();
  installControlStdin({ queue, writeTrace });

  const { startError, continuations, held } = await runWithQueue({
    initialTask: task,
    queue,
    agent,
    buildRequest: (taskText, conversationId) => ({
      // GEN9-INSTRUCTIONS: pinned repo conventions ride ahead of the task
      // (removed when the in-agent injection stub lands — see plan doc).
      task: gen9TaskWithInstructions(taskText),
      // CONTINUATION (desktop parity): a queued message becomes the next turn
      // of the SAME conversation — the agent restores the finished run
      // in-process. Different task text is a NEW user turn (turn clock
      // restarts, plan/goals reset); identical text would be a same-turn
      // resume — queued messages are new instructions, so new turn.
      // RESUME: the initial request with --resume carries the OLD run's
      // serialized conversation — restoreConversationSnapshot rehydrates it,
      // so the first message of this process continues that conversation.
      ...(conversationId
        ? { continuation: true, conversationId }
        : (resumeConversation
          ? { continuation: true, conversation: resumeConversation, conversationId: String(resumeConversation.id || '') }
          : {})),
      provider: providerConfig,
      settings: { controlMode, approvalMode: 'unattended' },
      // prompt override (--system-file): replaces the assembled prompt.
      ...(promptOverride ? { systemFile: systemText } : {}),
      // The workspace contract ONLY when the caller declared one (--cwd /
      // --workspace): the run's file tools and terminals root there.
      ...(workspaceDir ? { workspace: { root: workspaceDir } } : {})
    }),
    beforeRun: () => {
      // Per-run observer budget: reset the clock + the cancel flags so each
      // continuation gets its own full --max-seconds/--max-steps window.
      runActive = true;
      runStartedAtMs = Date.now();
      timedOut = false;
      stopReason = null;
      cancelIssued = false;
    },
    // Deliver queued messages only after a run that ended on its own terms
    // (completed | failed). An observer-cancelled run — the external budget
    // clock — HOLDS the queue (traced honestly as harness.queue.held) instead
    // of burning the user's queued instructions into a fresh continuation.
    canContinue: (finished) => ['completed', 'failed'].includes(String(finished?.status || '')),
    writeTrace
  });
  runActive = false;
  clearInterval(observer);
  meta.continuations = continuations;
  meta.queuedHeld = held;

  // GEN-8 keep-alive: the main run reached its terminal state, but explicitly
  // spawned subagents may still be working. Wait for them (bounded —
  // SUBAGENT_WAIT_CAP_MS, default 10 min) so their findings land in the trace
  // instead of dying with the parent; a wedged worker is cancelled, never a
  // hung CLI.
  if (subagentRuntime.hasActive()) {
    writeTrace({ type: 'harness.subagent.wait', active: subagentRuntime.activeCount() });
    const waitOutcome = await subagentRuntime.waitForAll();
    writeTrace({ type: 'harness.subagent.wait-done', ...waitOutcome });
    meta.subagentWait = waitOutcome;
  }

  const state = sanitize((() => { try { return agent.state(); } catch { return observedState; } })()) || {};
  const endedAtMs = Date.now();
  const elapsedMs = endedAtMs - startedAtMs;

  // Flush the trace BEFORE reading it back for tool-call pairing, so the last
  // buffered events are on disk (write streams buffer; the file is shorter
  // otherwise).
  await new Promise((resolve) => traceStream.end(resolve));

  const history = Array.isArray(state.history) ? state.history : [];
  const traceToolCalls = toolCallsFromTrace(tracePath);
  const toolCalls = traceToolCalls.length ? traceToolCalls : history
    .filter((entry) => entry && entry.tool && !String(entry.tool).startsWith('agent_'))
    .map((entry) => ({
      tool: entry.tool,
      ts: entry.at || null,
      durationMs: null,
      ok: entry.output ? (entry.output.ok === undefined ? null : Boolean(entry.output.ok)) : null
    }));
  const toolResultEvents = traceToolCalls.filter((call) => call.result === true).length;

  // DEFECT 3b (agent half): a non-completed run must carry its WHY — the last
  // connection error (state.recovery.lastError, e.g. "xKiro request failed
  // (402): …" / "429: Rate limit exceeded (ip, min)") goes into
  // meta.lastConnectionError, and when the run produced no result it becomes
  // result.summary so the TUI can print "✗ <error>" instead of a bare
  // "status unknown · failed · verified — · decisions —".
  const recoveryError = String(state?.recovery?.lastError || '').trim()
    || lastProviderFailureFromState(state) || '';
  const finalStatus = state.status || 'unknown';
  const finalResult = state.result
    || (finalStatus !== 'completed' && recoveryError ? { ok: false, summary: recoveryError } : null);
  const finalState = {
    meta: {
      ...meta,
      runId: state.id || runId,
      endedAt: new Date(endedAtMs).toISOString(),
      elapsedMs,
      timedOut,
      stopReason,
      lastConnectionError: recoveryError || null,
      startThrew: startError ? String(startError?.message || startError) : null,
      exitCode: exitCodeFor(state, startError, timedOut),
      // GEN9: where the run's persistent notebook landed.
      notebook: agent?.run?.notebookPath || path.join(outDir, 'notebook.md')
    },
    counts: {
      decisionCount: Number(state.decisionCount || 0),
      stepCount: Number(state.step || 0),
      traceLines,
      toolResultEvents
    },
    toolCallCount: toolCalls.length,
    toolCalls,
    result: finalResult,
    status: finalStatus,
    state
  };
  fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify(finalState, null, 2));
  finalStateWritten = true;

  if (!quiet) console.log(JSON.stringify({
    ok: finalState.exitCode === 0,
    runId: finalState.meta.runId,
    status: finalState.status,
    timedOut,
    continuations: meta.continuations || 0,
    queuedHeld: meta.queuedHeld || 0,
    elapsedMs,
    decisionCount: finalState.counts.decisionCount,
    toolCallCount: toolCalls.length,
    traceLines,
    resultSummary: state.result?.summary ? String(state.result.summary).slice(0, 500) : (recoveryError || finalState.meta.startThrew || null),
    outDir,
    trace: tracePath,
    finalState: path.join(outDir, 'final-state.json')
  }, null, 2));

  // --- teardown -------------------------------------------------------------
  try { await subagentRuntime.cancelAll('run teardown'); } catch { /* best effort */ }
  try { await cliAndroidApi.manager.close(); } catch { /* best effort */ }
  try { if (controlMode === 'agi') await require('./computerToolsBackend.cjs').createCliComputerTools().close(); } catch { /* best effort */ }
  try {
    const root = await (await import('chrome-remote-interface')).default({ host: '127.0.0.1', port: launch.port, target: (targets) => targets.find((t) => t.type === 'browser') || targets[0] });
    await root.close().catch(() => {});
  } catch { /* browser may already be gone */ }
  for (const [, entry] of tabs) await entry.adapter.close().catch(() => {});
  killChromeTree(launch);
  if (!process.env.BROWSER_USE_CLI_KEEP_PROFILE) {
    try { fs.rmSync(launch.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  process.exit(finalState.meta.exitCode);
}

// Pair tool.started / tool.result events from the trace into per-call records
// with wall-clock durations. Events are in order; each started pairs with the
// next result of the same tool.
function toolCallsFromTrace(tracePath) {
  const calls = [];
  try {
    let pending = [];
    for (const line of fs.readFileSync(tracePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'tool.started') {
        pending.push({ tool: event.tool || null, ms: event.ms, ts: event.ts });
      } else if (event.type === 'tool.result') {
        const started = pending.find((call) => !call.tool || call.tool === (event.tool || null)) || pending.shift() || null;
        pending = pending.filter((call) => call !== started);
        calls.push({
          tool: event.tool || started?.tool || null,
          ts: started?.ts ?? event.ts ?? null,
          durationMs: started?.ms != null && event.ms != null ? Math.max(0, event.ms - started.ms) : null,
          ok: event.output ? (event.output.ok === undefined ? null : Boolean(event.output.ok)) : null,
          result: true
        });
      }
    }
  } catch { /* missing trace falls back to history-derived calls */ }
  return calls;
}

// The last failed provider request straight from the run snapshot's
// coordinator metrics. recovery.lastError only fills AFTER the transport
// retry ladder exhausts (a run killed mid-ladder would otherwise carry no
// connection-error reason at all — the exact run-043641 symptom).
function lastProviderFailureFromState(state) {
  const history = state?.coordinator?.metrics?.providerRequestHistory;
  if (!Array.isArray(history)) return null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && (entry.outcome === 'failed' || entry.outcome === 'transport-retry-failed')) {
      return `provider ${String(entry.kind || 'request')} failed (HTTP ${entry.status ?? '—'})`;
    }
  }
  return null;
}

function exitCodeFor(state, startError, timedOut) {
  if (startError) return 1;
  const status = state?.status;
  if (status === 'completed') return 0;
  if (status === 'cancelled' || timedOut) return 2;
  return 1;
}

function printUsage() {
  console.log(`Usage: node cli/agent-cli.mjs --task "..." | --task-file <path> [options]

  --model <id>          provider model (default z-ai/glm-5.3-flash)
  --provider-id <id>    xkiro | anthropic | openai | ... (default xkiro)
  --base-url <url>      provider base URL override
  --api-key <key>       provider API key override (else XKIRO_API_KEY /
                        ANTHROPIC_AUTH_TOKEN / ~/.claude/settings.json)
  --system-file <path>  replace agiPromptForTask output with the file's text
  --system-mode <mode>  which original prompt family the variant replaces
                        (coding|agi, metadata; default agi)
  --max-seconds <n>     external observer clock (0 = untimed)
  --max-steps <n>       external step budget (0 = unlimited)
  --max-recoveries <n>  external recovery budget (0 = unlimited)
  --control-mode <m>    browser | agi (default browser)
  --cwd <dir>           root the child here (default: the caller's cwd)
  --workspace <dir>     declare the run's workspace contract (file tools +
                        terminals root here; implies the invocation dir when
                        --cwd was passed without --workspace)
  --url <url>           pre-open this page in the selected tab before the run
  --out-dir <dir>       trace.jsonl + final-state.json destination
  --run-id <id>         run identifier (default run-<timestamp>)
  --resume <out-dir>    continue that run's conversation — its final-state.json
                        state is restored and the new task becomes the next
                        user turn (the /history click path)
  --headed              run Chrome with a visible window
  --profile-dir <dir>   persistent Chrome profile
  --quiet               suppress the stdout summary JSON
`);
}

main().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.stack || error) }, null, 2));
  // The boot kicks Chrome off CONCURRENTLY with the module loads — if the run
  // fails before the launch is awaited, the browser must not leak.
  try { if (typeof bootLaunch !== 'undefined' && bootLaunch) killChromeTree(await bootLaunch); } catch { /* already gone */ }
  process.exit(1);
});
