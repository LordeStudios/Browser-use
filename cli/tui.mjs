#!/usr/bin/env node
// cli/tui.mjs — bootstrap for the Ink browser-use TUI.
//
// This module keeps ALL of the old readline TUI's behavior — session state,
// the 23 slash commands with identical semantics, the run lifecycle (spawn
// cli/agent-cli.mjs, tail out-dir/trace.jsonl, badge summary at the end),
// doctor, the .history file, the exit flow — but instead of printing to
// stdout it drives an observable store that cli/tui/App.mjs renders with Ink
// (the Claude Code / Qwen Code graphics tier: Static history, lime prompt,
// completion popup, live tool stream, spinner, status footer).
//
// Keyboard: Escape during a run cancels the run (the /cancel code path); at
// idle Escape clears the input. Ctrl+C during a run cancels the run (notice
// shown); at idle the first press arms an exit notice, the second exits.
// /exit and /quit cancel a run first, then confirm y/n through the same
// input line.
//
// PROVIDER RESOLUTION ORDER (cli/tui/appConfig.mjs — browser-use config ONLY;
// ~/.claude/settings.json is never read):
//   base url / model / custom models / control mode:
//     1. the browser-use desktop app's settings store
//        (%APPDATA%/browser-use/browser-use-settings.json: aiChatProvider +
//        aiChatConnectionId select the ACTIVE aiConnections entry — the same
//        connection entries and model lists the app's own UI shows;
//        agentControlMode is the shared control-mode default)
//     2. explicit env overrides (XKIRO_BASE_URL)
//     3. built-in defaults (https://api.xkiro.com/v1, z-ai/glm-5.3-flash)
//   api key:
//     1. the app's own secrets store (userData/browser-use-secrets.json,
//        entry `aiProvider:<activeConnectionId>` — the EXACT lookup
//        desktop/main.cjs activeProviderConfig does). The keys are Electron
//        safeStorage "v10" blobs; pure-Node GCM does not verify headless, so
//        the CLI decrypts through the REAL decryptor — the repo's electron
//        binary run against a temp userData copy (cli/tui/appConfig.mjs,
//        readAppSecrets). Proven 2026-10-12: this yields the app's working
//        credential (····eb72), NOT the ambient env key (····13f9) that 402'd.
//     2. the CLI's own config file (~/.browser-use-cli/config.json) — an
//        explicitly owner-provided key via /key <secret> (never claude-code,
//        never env)
//     3. the user's explicit env exports (XKIRO_API_KEY / BROWSER_USE_API_KEY)
//        — last, because an ambient/stale export is what burned the runs.
//   startRun awaits the resolution, passes the key explicitly as --api-key,
//   and SCRUBS XKIRO_API_KEY / ANTHROPIC_AUTH_TOKEN / XKIRO_BASE_URL from the
//   child env, so an ambient shell variable can never shadow the resolved key
//   inside agent-cli (whose own priority is --api-key > XKIRO_API_KEY env >
//   settings.json > ANTHROPIC_AUTH_TOKEN env). /doctor prints the credential
//   parity report (masked key tails per connection). NO process plumbing ever
//   reaches user-visible content: no pid lines, no spawn lines — the live run
//   panel is the ONE card per run (the four-pids duplicate-start race is fixed
//   by a synchronous start guard). /doctor's gateway probe tests the resolved
//   key's funding directly (1-token POST).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { render } from 'ink';
import { createCommandRegistry, makeCompleter, parseCommand } from './tui/registry.mjs';
import { createTuiStore, pushHistory } from './tui/store.mjs';
import { theme, formatElapsed } from './tui/theme.mjs';
import { App } from './tui/App.mjs';
import { detectScreenMode, MOUSE_ENABLE, MOUSE_DISABLE, MOTION_ENABLE, MOTION_DISABLE } from './tui/screen.mjs';
import { traceErrorForEvent } from './tui/errorView.mjs';
import {
  BUILTIN_DEFAULTS,
  readAppSettings,
  readAppSecrets,
  readCliConfig,
  writeCliConfig,
  cliConfigPath,
  resolveProviderConfig,
  scrubCredentialEnv,
  maskKey,
  pricingHint,
  mergeModelCatalog,
  parseModelsPayload
} from './tui/appConfig.mjs';
import { startServer, getServerUrl, isServerRunning } from './tui/guiServer.mjs';

const h = React.createElement;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..');
// GEN9 (desktop/skills_mcp_plan.md): /skills and /mcp ride the SAME shared
// modules the desktop app's IPC uses — a skill or MCP server installed here is
// immediately visible to the desktop app and vice versa (shared scopes:
// ~/.browser-use-cli/ and <pinned repo>/.browser-use/).
const gen9Require = createRequire(import.meta.url);
const { SkillsManager } = gen9Require('../desktop/agent/skillsManager.cjs');
const { McpConfigStore, McpRegistry } = gen9Require('../desktop/agent/mcpClient.cjs');
// GEN9 persistent notebook: the SAME module the desktop app and the agent use
// — one append helper, one merge semantics, one file format.
const { appendUserLine: notebookAppendLine } = gen9Require('../desktop/agent/runNotebook.cjs');
// TEST HOOK (cli/tui/tui.test.mjs): the queueing E2E boots the REAL TUI with
// a fake agent-cli (no Chrome) — the hook is resolved before any other use.
const AGENT_CLI = process.env.BROWSER_USE_TUI_AGENT_CLI
  ? path.resolve(process.env.BROWSER_USE_TUI_AGENT_CLI)
  : path.join(HERE, 'agent-cli.mjs');
const TUI_DIR = path.join(HERE, 'tui');
const HISTORY_FILE = path.join(TUI_DIR, '.history');
const HISTORY_LIMIT = 200;
const DEFAULT_MODEL = BUILTIN_DEFAULTS.model;
const MODEL_SUGGESTIONS = BUILTIN_DEFAULTS.models;
const KNOWN_PROVIDERS = ['xkiro', 'anthropic', 'openai'];

// ------------------------------------------------- browser-use config only ---
// Resolution order (cli/tui/appConfig.mjs): the browser-use app's own stores
// first (settings store -> active connection baseUrl/model/customModels +
// agentControlMode; secrets store -> the ACTIVE connection's API key decrypted
// through the app's own decryptor), then the CLI's own config file (owner key
// via /key), then explicit env overrides, then the built-in defaults.
// ~/.claude/settings.json is NOT consulted at all.
//
// CREDENTIAL PARITY (defect 1, 2026-10-12): the app's working key lives in
// safeStorage under aiProvider:<aiChatConnectionId>. The TUI previously fell
// back to ambient env (····13f9 — a DIFFERENT key than the app's active
// connection, whose wallet 402'd/429'd). Resolution is now async (electron
// decrypt helper) and every consumer awaits `credentialsReady` first.
const APP_SETTINGS_READ = readAppSettings();
const APP_CONNECTION = (function () {
  const provider = String(APP_SETTINGS_READ.settings?.aiChatProvider || '').trim();
  const id = String(APP_SETTINGS_READ.settings?.aiChatConnectionId || '').trim();
  const connections = Array.isArray(APP_SETTINGS_READ.settings?.aiConnections) ? APP_SETTINGS_READ.settings.aiConnections : [];
  const connection = connections.find((entry) => String(entry?.id || '') === id) || null;
  return connection && provider && connection.provider === provider ? String(connection.id) : null;
})();

let APP_SECRETS_READ = { status: 'pending', path: '', connectionId: APP_CONNECTION, entries: {} };
let RESOLVED_PROVIDER = resolveProviderConfig({
  appSettings: APP_SETTINGS_READ.settings,
  appSecrets: null,
  cliConfig: readCliConfig().config,
  env: process.env
});

const credentialsReady = (async () => {
  try {
    APP_SECRETS_READ = await readAppSecrets({ connectionId: APP_CONNECTION });
  } catch (error) {
    APP_SECRETS_READ = {
      status: 'electron-decrypt-failed',
      path: APP_SECRETS_READ.path,
      connectionId: APP_CONNECTION,
      entries: {},
      detail: String((error && error.message) || error)
    };
  }
  RESOLVED_PROVIDER = resolveProviderConfig({
    appSettings: APP_SETTINGS_READ.settings,
    appSecrets: APP_SECRETS_READ,
    cliConfig: readCliConfig().config,
    env: process.env
  });
  return RESOLVED_PROVIDER;
})();

function readVersion() {
  try {
    // Keep the TUI banner/version command aligned with the package entrypoint;
    // Windows-written package.json files can begin with a UTF-8 BOM.
    const text = fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8').replace(/^﻿/, '');
    return String(JSON.parse(text).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}
const VERSION = readVersion();

// ------------------------------------------------------------- store ------
const store = createTuiStore({
  history: [],
  session: {
    task: '',
    url: null,
    // WORKING REPO (defect 4): the CLI defaults its working repo to the
    // directory it was INVOKED from (process.cwd() at boot) — never the tool
    // root, never a hard-coded repo. Runs spawn with this cwd and pass it to
    // agent-cli (--cwd/--workspace) so the agent's workspace contract, file
    // tools and terminals are rooted here. /cd re-pins it; the header and
    // footer show it at all times.
    cwd: process.cwd(),
    cwdPinned: false,
    // App-config first: the model and control mode default to the ACTIVE
    // connection in the browser-use app's own settings store (falling back to
    // the built-in defaults) — the same values the app's UI shows.
    model: RESOLVED_PROVIDER.model,
    providerId: RESOLVED_PROVIDER.connection?.provider || BUILTIN_DEFAULTS.providerId,
    controlMode: RESOLVED_PROVIDER.controlMode,
    systemFile: null,
    // Browser window mode for runs (directive 2026-10-13): headless by
    // default, headed whenever the user asks — /headed toggles, and the flag
    // passes through to agent-cli --headed (which the webContentsAdapter's
    // launcher already honors as a real visible Chrome window).
    headed: false,
    maxSeconds: 0,
    maxSteps: 0,
    maxRecoveries: 0,
    outRoot: path.join(TOOL_ROOT, 'cli-runs'),
    lastRun: null // outDir of the most recently finished run
  },
  run: null,        // live run view for the live pane
  subagents: [],    // gen-8 subagent cards: [{alias,label,task,status,tracePath,startedAt,finishedAt,summary,tail}]
  activeSubagent: null, // pane switch: null = main run card, alias = that subagent's stream
  hover: null,      // UPGRADE 4: hovered clickable row { key, row, type, alias, index } | null
  notice: null,     // { text, tone, at }
  pendingAsk: null, // question string routed to the next submitted line
  exiting: false
});

function patchSession(patch) {
  store.set((state) => ({ ...state, session: { ...state.session, ...patch } }));
}

function setNotice(text, tone = 'warn') {
  store.set((state) => ({ ...state, notice: text ? { text, tone, at: Date.now() } : null }));
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    store.set((state) => (state.notice && Date.now() - state.notice.at >= 4500
      ? { ...state, notice: null }
      : state));
  }, 5000);
}
let noticeTimer = null;

function out(text, tone) {
  pushHistory(store, { kind: 'out', text, tone });
}

// -------------------------------------------------------- history file ----
function loadHistory() {
  try {
    return fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean).slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}
function appendHistory(line) {
  const text = String(line ?? '').trim();
  if (!text) return;
  try {
    fs.mkdirSync(TUI_DIR, { recursive: true });
    let lines = [];
    try { lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean); } catch { /* first write */ }
    lines.push(text);
    fs.writeFileSync(HISTORY_FILE, lines.slice(-HISTORY_LIMIT).join('\n') + '\n');
  } catch { /* history must never break the REPL */ }
}

// ------------------------------------------------------ model catalog -----
// Defect fix: /model used to offer only the two hard-coded suggestions. The
// session catalog now merges (1) the ACTIVE app-store connection's
// customModels, (2) a live GET {base-url}/v1/models with the funded key —
// fetched ONCE per session and cached — and (3) the built-in defaults.
// Completion is synchronous, so it always reads the cache: until the fetch
// lands it serves the built-ins/union, and after it the full gateway catalog.
const modelCatalog = {
  state: 'idle',   // idle | loading | ready | failed
  models: [],      // [{ id, source, pricing|null }]
  notice: null,    // dim notice shown by /models + /model on fallback
  fetchedAt: null
};

function catalogModelIds() {
  return (modelCatalog.models.length ? modelCatalog.models : [])
    .map((entry) => entry.id)
    .concat(modelCatalog.models.length ? [] : MODEL_SUGGESTIONS);
}

function modelsEndpoint(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/models` : `${base}/v1/models`;
}

async function loadModelCatalog() {
  if (modelCatalog.state === 'loading' || modelCatalog.state === 'ready') return modelCatalog;
  modelCatalog.state = 'loading';
  await credentialsReady; // the gateway probe must use the FINAL resolved key
  const connection = RESOLVED_PROVIDER.connection;
  const headers = RESOLVED_PROVIDER.apiKey
    ? {
      Authorization: `Bearer ${RESOLVED_PROVIDER.apiKey}`,
      'x-api-key': RESOLVED_PROVIDER.apiKey,
      accept: 'application/json'
    }
    : { accept: 'application/json' };
  try {
    const response = await fetchWithTimeout(modelsEndpoint(RESOLVED_PROVIDER.baseUrl), { headers }, 8000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    const discovered = parseModelsPayload(payload);
    modelCatalog.models = mergeModelCatalog({ connection, discovered, defaults: MODEL_SUGGESTIONS });
    modelCatalog.state = 'ready';
    modelCatalog.fetchedAt = new Date().toISOString();
  } catch (error) {
    // Fetch failure falls back to the app customModels + built-in defaults
    // with an honest dim notice — never a hard error.
    modelCatalog.models = mergeModelCatalog({ connection, discovered: [], defaults: MODEL_SUGGESTIONS });
    modelCatalog.state = 'failed';
    modelCatalog.notice = `gateway catalog unavailable (${String(error?.message || error)}) — showing app custom models + built-in defaults`;
  }
  return modelCatalog;
}

// Kick the one-per-session fetch off at boot; a slow or failing gateway must
// never block or crash the REPL (the cache starts on the built-ins).
void loadModelCatalog().catch(() => {});

// ----------------------------------------------------- run helpers --------
function clockLabel() {
  return store.get().session.maxSeconds > 0 ? `${store.get().session.maxSeconds}s` : 'untimed';
}

function tailToolFromTrace(tracePath) {
  try {
    const stat = fs.statSync(tracePath);
    const readBytes = Math.min(stat.size, 16_000);
    const fd = fs.openSync(tracePath, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, stat.size - readBytes);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      let event;
      try { event = JSON.parse(lines[i]); } catch { continue; }
      if (event.type === 'tool.started' && event.tool) return { tool: event.tool, done: false };
      if (event.type === 'tool.result' && event.tool) return { tool: event.tool, done: true };
    }
  } catch { /* trace absent or unreadable */ }
  return null;
}

function readFinalState(outDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(outDir, 'final-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function summaryFromBuffer(buf) {
  try {
    const index = String(buf).lastIndexOf('{\n  "ok"');
    if (index === -1) return null;
    return JSON.parse(String(buf).slice(index));
  } catch {
    return null;
  }
}

function patchRun(patch) {
  store.set((state) => {
    if (!state.run) return state;
    const next = typeof patch === 'function' ? patch(state.run) : patch;
    return { ...state, run: { ...state.run, ...next } };
  });
}

// ------------------------------------------------------- subagent cards ----
// FEATURE B: a spawned subagent renders as its own card below the main run
// card; its live stream (its OWN trace tail) is one click / pane-switch away.
const SUBAGENT_TAIL_LINES = 30;
const subagentTailers = new Map(); // alias -> stop()

function addSubagentCard(event) {
  const alias = String(event.alias || '');
  if (!alias) return;
  const existed = store.get().subagents.some((sub) => sub.alias === alias);
  if (!existed) {
    const status = String(event.status || 'queued');
    store.set((state) => ({
      ...state,
      subagents: [...state.subagents, {
        alias,
        label: String(event.label || `subagent ${alias}`),
        task: String(event.task || ''),
        status,
        tracePath: event.tracePath || null,
        startedAt: Date.now(),
        finishedAt: null,
        summary: null,
        // FEATURE C (CLI): the task text is the card's first visible content —
        // it is what the subagent was asked to do.
        tail: { inFlight: null, thinking: null, lastError: null, lastTool: null, tools: [] }
      }]
    }));
    // UPGRADE 3: the spawn ALSO becomes a PERSISTENT history card (below the
    // user's `===` sandwich that started the run — spawn events arrive after
    // the submit). The card renders from the LIVE subagents record, so its
    // status updates while the run is active and it survives run end as a
    // completed record instead of vanishing with the live roster.
    pushHistory(store, { kind: 'subagent', alias, status });
  }
  if (event.tracePath && !subagentTailers.has(alias)) {
    subagentTailers.set(alias, startSubagentTail(alias, event.tracePath));
  }
}

function patchSubagent(alias, patch) {
  const key = String(alias || '');
  if (!key) return;
  store.set((state) => ({
    ...state,
    subagents: state.subagents.map((sub) => (sub.alias === key
      ? { ...sub, ...(typeof patch === 'function' ? patch(sub) : patch) }
      : sub))
  }));
}

// FEATURE B pane switch: the live run-card region renders the ACTIVE pane —
// the main run, or one subagent's stream (its trace tail, tool lines,
// thinking). Escape or clicking the main card switches back.
function selectSubagentPane(alias) {
  store.set((state) => ({ ...state, activeSubagent: String(alias || '') || null }));
}
function selectMainPane() {
  store.set((state) => ({ ...state, activeSubagent: null }));
}

// Per-subagent trace tailer: same 250ms byte-tail as the main trace, but it
// patches THAT subagent's tail fields instead of the main run view.
function startSubagentTail(alias, tracePath) {
  let pos = 0;
  let carry = '';
  const pendingStarts = [];
  const poll = () => {
    let stat;
    try { stat = fs.statSync(tracePath); } catch { return; }
    if (stat.size <= pos) {
      if (stat.size < pos) pos = 0;
      else return;
    }
    let chunk;
    try {
      const fd = fs.openSync(tracePath, 'r');
      const buf = Buffer.alloc(stat.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
      pos += buf.length;
    } catch {
      return;
    }
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      switch (event.type) {
        case 'tool.started':
          if (event.tool) {
            pendingStarts.push(event);
            patchSubagent(alias, (sub) => ({ tail: { ...sub.tail, inFlight: String(event.tool), lastTool: String(event.tool) } }));
          }
          break;
        case 'tool.result': {
          const started = pendingStarts.find((s) => !s.tool || s.tool === (event.tool || null)) || pendingStarts.shift() || null;
          const index = pendingStarts.indexOf(started);
          if (index !== -1) pendingStarts.splice(index, 1);
          const durationMs = started?.ms != null && event.ms != null ? Math.max(0, event.ms - started.ms) : null;
          const ok = event.output ? (event.output.ok === undefined ? null : Boolean(event.output.ok)) : null;
          patchSubagent(alias, (sub) => ({
            tail: {
              ...sub.tail,
              inFlight: null,
              thinking: null,
              lastTool: String(event.tool || started?.tool || '—'),
              tools: [...(sub.tail.tools || []), {
                tool: event.tool || started?.tool || null,
                ok,
                durationMs,
                ts: started?.ts ?? event.ts ?? null
              }].slice(-SUBAGENT_TAIL_LINES)
            }
          }));
          break;
        }
        case 'assistant.thinking':
          patchSubagent(alias, (sub) => ({
            tail: {
              ...sub.tail,
              thinking: String(event.text ?? event.content ?? event.snippet ?? '').replace(/\s+/g, ' ').slice(0, 100) || null,
              inFlight: 'deciding'
            }
          }));
          break;
        case 'assistant.message': {
          const lastError = String(event.run?.recovery?.lastError || '').trim();
          if (lastError) patchSubagent(alias, (sub) => ({ tail: { ...sub.tail, lastError } }));
          break;
        }
        default:
          break;
      }
    }
  };
  const timer = setInterval(poll, 250);
  // Final drain on stop: last-window events must still land (same race the
  // main tailer's stop() fixes).
  return () => {
    clearInterval(timer);
    try { poll(); } catch { /* final drain is best effort */ }
  };
}

/**
 * Tail outDir/trace.jsonl while the run is active: a 250ms poll reads new
 * bytes and parses each complete JSON line. Live-pane mapping:
 *   tool.started  -> spinner in flight for that tool
 *   tool.result   -> one-line entry (icon + tool + ms + ok/fail badge)
 *   assistant.thinking / decision.* -> spinner keeps turning on the decision
 */
function startTraceTailer(outDir) {
  const tracePath = path.join(outDir, 'trace.jsonl');
  let pos = 0;
  let carry = '';
  let lastErrorSeen = '';
  let firstEventSeen = false;
  const pendingStarts = [];
  const poll = () => {
    let stat;
    try { stat = fs.statSync(tracePath); } catch { return; }
    if (stat.size <= pos) {
      if (stat.size < pos) pos = 0; // truncated/rotated — start over
      else return;
    }
    let chunk;
    try {
      const fd = fs.openSync(tracePath, 'r');
      const buf = Buffer.alloc(stat.size - pos);
      fs.readSync(fd, buf, 0, buf.length, pos);
      fs.closeSync(fd);
      chunk = buf.toString('utf8');
      pos += buf.length;
    } catch {
      return;
    }
    const lines = (carry + chunk).split('\n');
    carry = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      // DEFECT 3: the first trace event proves the child is alive and past
      // its boot — clear the startup phase so the card flips to live output.
      if (!firstEventSeen) {
        firstEventSeen = true;
        patchRun({ phase: null, firstEventAt: Date.now() });
      }
      // The desktop surface derives connection feedback from every agent
      // event. Do the same here: provider errors may arrive as a terminal,
      // escalation, or non-recoverable tool event rather than assistant.message.
      const eventError = traceErrorForEvent(event);
      if (eventError && eventError !== lastErrorSeen) {
        lastErrorSeen = eventError;
        patchRun({ lastError: eventError, lastErrorAt: Date.now() });
      }
      switch (event.type) {
        case 'tool.started':
          if (event.tool) {
            pendingStarts.push(event);
            patchRun({ inFlight: String(event.tool), lastTool: String(event.tool), lastError: null });
          }
          break;
        case 'tool.result': {
          const started = pendingStarts.find((s) => !s.tool || s.tool === (event.tool || null)) || pendingStarts.shift() || null;
          const index = pendingStarts.indexOf(started);
          if (index !== -1) pendingStarts.splice(index, 1);
          const durationMs = started?.ms != null && event.ms != null
            ? Math.max(0, event.ms - started.ms)
            : null;
          const ok = event.output ? (event.output.ok === undefined ? null : Boolean(event.output.ok)) : null;
          patchRun((run) => ({
            inFlight: null,
            thinking: null,
            lastError: event.output?.ok === true ? null : run.lastError,
            lastTool: String(event.tool || started?.tool || '—'),
            tools: [...(run.tools || []), {
              tool: event.tool || started?.tool || null,
              ok,
              durationMs,
              ts: started?.ts ?? event.ts ?? null
            }]
          }));
          break;
        }
        case 'assistant.thinking':
          patchRun({
            thinking: String(event.text ?? event.content ?? event.snippet ?? '').replace(/\s+/g, ' ').slice(0, 100) || null,
            inFlight: 'deciding'
          });
          break;
        case 'assistant.message':
          // Error text was normalized above for both transient connection
          // notices and recovery snapshots. Keep this branch as a lifecycle
          // boundary so a recovered decision clears stale in-flight state.
          if (event.transient) patchRun({ inFlight: 'retrying' });
          break;
        case 'decision.timing':
          patchRun({ inFlight: null });
          break;
        case 'harness.queue.received':
          // The CHILD confirmed the queued control line — its pending count is
          // authoritative (the TUI patched its own count optimistically on
          // submit; take the max so a race never under-counts).
          patchRun((run) => ({
            queuedCount: Math.max(Number(run.queuedCount || 0), Number(event.pending || 0))
          }));
          break;
        case 'harness.continuation.started': {
          // CONTINUATION RUN CARD (desktop parity): the queued message now
          // runs as the next turn of the SAME conversation. Reset the live
          // pane for the new run, show the remaining queue count, and
          // announce it in history — a clean card (NO pid, NO spawn plumbing).
          lastErrorSeen = '';
          pushHistory(store, { kind: 'contStart', text: String(event.task || '') });
          patchRun((run) => ({
            task: String(event.task || run.task || ''),
            startedAt: Date.now(),
            phase: null,
            inFlight: null,
            thinking: null,
            lastTool: null,
            lastError: null,
            lastErrorAt: null,
            tools: [],
            queuedCount: Number.isFinite(Number(event.remaining))
              ? Number(event.remaining)
              : Number(run.queuedCount || 0)
          }));
          break;
        }
        // GEN-8 subagent lifecycle (emitted by cli/cliSubagents.cjs into the
        // main trace): each event updates that subagent's card. The card also
        // starts its OWN trace tailer so its stream streams live.
        case 'harness.subagent.spawned':
          addSubagentCard(event);
          break;
        case 'harness.subagent.status':
          patchSubagent(event.alias, { status: String(event.status || 'running') });
          break;
        case 'harness.subagent.finished':
          patchSubagent(event.alias, {
            status: String(event.status || 'completed'),
            summary: String(event.summary || event.error || '').slice(0, 300) || null,
            finishedAt: Date.now()
          });
          break;
        case 'harness.subagent.closed':
          patchSubagent(event.alias, { status: 'closed', finishedAt: Date.now() });
          break;
        default:
          break; // harness.* and other events stay out of the live pane
      }
    }
  };
  const timer = setInterval(poll, 250);
  // Final drain on stop: events written in the last 250ms window before the
  // child exited must still land (the queueing E2E exposed this race — the
  // continuation card could lose its race against finishRun's stopTail).
  return () => {
    clearInterval(timer);
    try { poll(); } catch { /* final drain is best effort */ }
  };
}

// ------------------------------------------------- run lifecycle ----------
let child = null;
let activeRun = null; // { outDir, startedAt, pid, task, stopTail }
let exiting = false;
// DEFECT 2 ROOT CAUSE (the four-pids-one-run bug): startRun is async and used
// to check the `if (child)` guard only AFTER `await credentialsReady` (the
// electron safeStorage decrypt — seconds). Every submission queued in that
// window passed the guard, spawned its own agent-cli within the same second
// (identical run-id timestamp stamp), and pushed its own run-start line:
// four start lines, four pids, one run id. The guard now spans the ENTIRE
// async start (gen8-arch3 port): `runStarting` is set synchronously before
// any await, an identical task dispatched inside that window is silently
// DEDUPED (key-repeat Enter, a paste delivered in chunks), and a burst of the
// same task right after a start failure cannot machine-gun the same error.
let runStarting = false;
let startingTask = '';   // dedupe key while starting
let failedTask = '';     // last task that failed to start (dedupe window below)
let failedTaskAt = 0;
// RESUME (clickable /history): the run the user picked to continue. Set by
// controller.resumeRun (a /history row click or /resume <name>), consumed by
// the NEXT startRun (spawned with --resume), cleared on use.
let resumeTarget = null;

// RESUME: mark a previous run for continuation. Called from App.mjs when the
// user CLICKS a /history row, and from /resume <name>. The next submitted
// message starts agent-cli with --resume <dir> — the old conversation is
// restored and the message becomes its next turn.
function resumeRun(name) {
  const wanted = String(name || '').trim();
  if (child || runStarting) { out('error: a run is active — finish or /cancel it before resuming another', 'err'); return; }
  const run = listRuns().find((entry) => entry.name === wanted);
  if (!run) { out(`error: no run named ${wanted}`, 'err'); return; }
  if (!fs.existsSync(path.join(run.dir, 'final-state.json'))) { out(`error: ${wanted} has no final-state.json — nothing to resume`, 'err'); return; }
  resumeTarget = { name: run.name, dir: run.dir };
  out(` ↻ ${run.name} selected — type your next message to continue that conversation (Esc or /resume clear to pick a different one)`, 'dim');
}

async function startRun(task) {
  if (child) {
    out('error: a run is already active — /cancel it first or wait for it to finish', 'err');
    return;
  }
  if (runStarting) {
    if (task === startingTask) return; // duplicate dispatch of the same task — drop silently
    out('error: a run is already starting — /cancel it first or wait a moment', 'err');
    return;
  }
  // A burst of the same task right after a start failure (no key, spawn
  // error) must not machine-gun the same error — one honest line per burst.
  if (task === failedTask && Date.now() - failedTaskAt < 2500) return;
  runStarting = true;
  startingTask = task;
  const session = store.get().session;
  const stamp = new Date().toISOString().replace(/[:]/g, '').replace(/\..*$/, '').replace('T', '-');
  // Collision-proof the run id: two runs in the same second never share a dir.
  // (The dir itself is created only once the run actually spawns — a refused
  // start must not litter the out root with empty run dirs.)
  let outDir = path.resolve(session.outRoot, `run-${stamp}`);
  for (let n = 2; fs.existsSync(outDir); n += 1) outDir = path.resolve(session.outRoot, `run-${stamp}-${n}`);

  // DEFECT 3 (startup latency): the run card renders IMMEDIATELY, before the
  // credential resolution and the spawn — the owner sees the run start the
  // moment they submit, with the honest startup phase named, instead of a
  // dead up-to-5s gap (electron decrypt + chrome boot) with no feedback.
  activeRun = { outDir, startedAt: Date.now(), pid: null, task };
  store.set((state) => ({
    ...state,
    run: {
      name: path.basename(outDir),
      outDir,
      pid: null,
      task,
      startedAt: activeRun.startedAt,
      phase: 'resolving credentials…',
      inFlight: null,
      thinking: null,
      lastTool: null,
      lastError: null,
      lastErrorAt: null,
      tools: [],
      queuedCount: 0 // mid-run message queue size (desktop parity)
    }
  }));

  try {
    await credentialsReady; // runs must use the FINAL resolved credential (app parity)
  } catch (error) {
    store.set((state) => ({ ...state, run: null }));
    activeRun = null;
    runStarting = false;
    startingTask = '';
    failedTask = task;
    failedTaskAt = Date.now();
    out(`error: credential resolution failed: ${String((error && error.message) || error)}`, 'err');
    return;
  }

  const args = [
    AGENT_CLI,
    '--task', task,
    '--model', session.model,
    '--provider-id', session.providerId,
    '--out-dir', outDir,
    '--run-id', path.basename(outDir),
    // WORKING REPO (defect 4): the child runs IN the invocation dir (/cd
    // override) and declares it as its workspace contract, so file tools and
    // terminals are rooted where the user launched the CLI.
    '--cwd', session.cwd,
    '--workspace', session.cwd
  ];
  if (session.url) args.push('--url', session.url);
  if (session.headed) args.push('--headed');
  // RESUME: the user clicked a /history row (or /resume <name>) — the child
  // restores that run's conversation and this task becomes its next turn.
  // Fresh artifacts land in the new out-dir; the resumed bundle is untouched.
  const resumedFrom = resumeTarget ? resumeTarget.name : null;
  if (resumeTarget) args.push('--resume', resumeTarget.dir);
  if (session.systemFile) args.push('--system-file', session.systemFile);
  if (session.maxSeconds > 0) args.push('--max-seconds', String(session.maxSeconds));
  if (session.maxSteps > 0) args.push('--max-steps', String(session.maxSteps));
  if (session.maxRecoveries > 0) args.push('--max-recoveries', String(session.maxRecoveries));
  if (session.controlMode) args.push('--control-mode', session.controlMode);

  // CREDENTIAL FIX (the "spins forever with no reply" root cause): the TUI
  // used to spawn agent-cli with env: process.env, so a DRAINED shell
  // XKIRO_API_KEY shadowed the funded ~/.claude/settings.json key inside
  // agent-cli's priority chain (--api-key > XKIRO_API_KEY env > settings.json)
  // and every run burned 402/429s with zero tool calls. The funded key
  // (and base url) are resolved up front and passed EXPLICITLY on the spawn
  // args, and the shell credential variables are scrubbed from the child env
  // so they can never shadow anything. The key itself is never logged — only
  // its source and last 4 characters.
  if (!RESOLVED_PROVIDER.apiKey) {
    store.set((state) => ({ ...state, run: null }));
    activeRun = null;
    runStarting = false;
    startingTask = '';
    failedTask = task;
    failedTaskAt = Date.now();
    out('error: no provider API key resolved — /doctor for the resolution report', 'err');
    return;
  }
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* agent-cli recreates */ }
  args.push('--api-key', RESOLVED_PROVIDER.apiKey);
  args.push('--base-url', RESOLVED_PROVIDER.baseUrl);
  const childEnv = scrubCredentialEnv(process.env);

  patchRun({ phase: 'launching browser…' });
  try {
    // stdio[0] is a PIPE (not 'ignore'): the mid-run message queue writes
    // JSON control lines to the child's stdin ({"type":"queue","text"} —
    // agent-cli reads them and drains the queue as continuations after the
    // run's terminal state; desktop parity with the app's queue button).
    child = spawn(process.execPath, args, {
      cwd: session.cwd, // the invocation dir (or /cd override) — NEVER the tool root
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    child = null;
    store.set((state) => ({ ...state, run: null }));
    activeRun = null;
    runStarting = false;
    startingTask = '';
    failedTask = task;
    failedTaskAt = Date.now();
    out(`error: run spawn failed: ${String(error?.message || error)}`, 'err');
    return;
  }
  // The child can exit between a queue submit and the stdin write — an EPIPE
  // here must never crash the TUI (the run summary explains what happened).
  try { child.stdin.on('error', () => { /* the run is ending anyway */ }); } catch { /* gone */ }
  activeRun.pid = child.pid;
  patchRun({ pid: child.pid });
  runStarting = false; // the child guard (`if (child)`) takes over from here
  startingTask = '';
  if (resumedFrom) {
    // The run card shows the NEW out-dir; this one line names the lineage.
    resumeTarget = null; // consumed — the next submit starts fresh
    out(` ↻ continuing ${resumedFrom} — this run carries its conversation`, 'dim');
  }
  // DEFECT 2 (one clean run card): NO run-start history line at all — the pid
  // and out-dir plumbing lines are gone from user-visible content. The live
  // run panel IS the one card for the active run; history gets the user's
  // line, then the completion panel when the run finishes.
  activeRun.stopTail = startTraceTailer(outDir);

  let outBuffer = '';
  child.stdout.on('data', (chunk) => { outBuffer += String(chunk); });
  child.stderr.on('data', () => { /* captured in trace; stderr stays out of the frame */ });
  child.on('error', (error) => {
    child = null; // 'exit' may never fire after a spawn error — never deadlock
    store.set((state) => ({ ...state, run: null }));
    activeRun = null;
    out(`error: run spawn failed: ${String(error?.message || error)}`, 'err');
  });
  child.on('exit', (code) => {
    const run = activeRun;
    const buffer = outBuffer;
    child = null;
    activeRun = null;
    patchSession({ lastRun: run?.outDir || store.get().session.lastRun });
    finishRun(code, run, buffer);
  });
}

// ------------------------------------------------- mid-run message queue ---
// DESKTOP PARITY (desktop/renderer/app.js queueAgentMessage): text typed
// while a run is active is NEVER lost and NEVER rejected — it is queued
// (rendered as the dim "▸ queued" card), counted in the footer/live card as
// "queued (k total)", written to the child's stdin as a JSON control line,
// and delivered as a continuation run when the current run reaches its
// terminal state (agent-cli's runWithQueue chain). The 'already active'
// error remains ONLY for the true double-submit race (the synchronous
// runStarting guard below in startRun).
function queueMessage(text) {
  if (!child) { startRun(text); return; } // the run ended mid-dispatch — start instead
  const run = store.get().run;
  const nextCount = Number(run?.queuedCount || 0) + 1;
  pushHistory(store, { kind: 'queued', text });
  try {
    child.stdin.write(`${JSON.stringify({ type: 'queue', text })}\n`);
  } catch (error) {
    out(`error: could not queue the message (the run may be ending): ${String(error?.message || error)}`, 'err');
    return;
  }
  patchRun({ queuedCount: nextCount });
}

// The SINGLE entry point for a task submission (plain text and /run): at
// idle it starts a run; mid-run it queues. Duplicate dispatches of the same
// task inside the starting window are silently deduped inside startRun
// (gen8-arch3 port); a different task during that window gets the honest
// refusal there.
function submitTask(task) {
  if (child) { queueMessage(task); return; }
  startRun(task);
}

async function finishRun(code, run, outBuffer) {
  if (!run) return;
  if (run.stopTail) run.stopTail();
  // GEN-8: stop the per-subagent trace tailers and settle any subagent still
  // marked running (the child tree is gone — honest terminal state).
  for (const [, stop] of subagentTailers) { try { stop(); } catch { /* gone */ } }
  subagentTailers.clear();
  store.set((state) => ({
    ...state,
    subagents: state.subagents.map((sub) => (['queued', 'running'].includes(sub.status)
      ? { ...sub, status: 'failed', summary: sub.summary || 'the run ended before this subagent settled', finishedAt: Date.now() }
      : sub))
  }));
  // agent-cli now ALWAYS writes final-state.json on every exit path (defect
  // 3a), but the child's exit event can beat the last FS flush by a tick —
  // retry briefly before declaring the file missing.
  let finalState = null;
  for (let attempt = 0; attempt < 4 && !finalState; attempt += 1) {
    finalState = readFinalState(run.outDir);
    if (!finalState && attempt < 3) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  const summary = summaryFromBuffer(outBuffer);
  const status = finalState?.status ?? summary?.status ?? null;
  const exitCode = finalState?.meta?.exitCode ?? (code === null || code === undefined ? 1 : code);
  const elapsedMs = finalState?.meta?.elapsedMs ?? (run.startedAt ? Date.now() - run.startedAt : null);
  const decisions = finalState?.counts?.decisionCount ?? summary?.decisionCount ?? null;
  const tools = finalState?.toolCallCount ?? summary?.toolCallCount ?? null;
  // DEFECT (2026-10-12): the agent's reply lives in finalState.result.summary
  // (an object) — the old code only rendered it when result was a string, so
  // the model's actual ANSWER was silently dropped from every completed run
  // (the owner's "no response" report). Extract the reply as a first-class
  // field; the error path keeps its own extraction for non-completed runs.
  const result = typeof finalState?.result?.summary === 'string'
    ? finalState.result.summary
    : (typeof finalState?.result === 'string' ? finalState.result : (summary?.resultSummary ?? null));
  const verifiedRaw = finalState?.result?.verified ?? finalState?.state?.result?.verified ?? null;

  // DEFECT 3b: a run that exits without a final result must show WHY — the
  // last connection error (agent-cli now records it in meta.lastConnectionError
  // and result.summary on failed runs), then the observer stopReason, then the
  // start error, then an honest "no terminal state" line. Never a bare
  // "status unknown · failed · verified — · decisions —" with no reason.
  let error = null;
  if (status !== 'completed' || finalState?.result?.ok === false) {
    const resultSummary = finalState?.result && finalState.result.ok === false && finalState.result.summary
      ? String(finalState.result.summary)
      : null;
    error = resultSummary
      || (finalState?.meta?.lastConnectionError ? String(finalState.meta.lastConnectionError) : null)
      || (finalState?.meta?.stopReason ? String(finalState.meta.stopReason) : null)
      || (finalState?.meta?.startThrew ? String(finalState.meta.startThrew) : null)
      || (finalState ? null : 'run died without a terminal state — no final-state.json written');
  }

  store.set((state) => ({ ...state, run: null }));
  const calls = Array.isArray(finalState?.toolCalls) ? finalState.toolCalls : [];
  pushHistory(store, {
    kind: 'runSummary',
    summary: {
      name: path.basename(run.outDir),
      outDir: run.outDir,
      status,
      exitCode,
      verified: typeof verifiedRaw === 'boolean' ? verifiedRaw : null,
      decisions,
      tools,
      elapsedMs,
      reply: typeof result === 'string' ? result : null,
      result: typeof result === 'string' ? result.slice(0, 300) : null,
      error
    },
    calls: calls.length ? calls : null
  });
}

function cancelRun({ announce = true } = {}) {
  if (!child) {
    if (announce) out('no active run to cancel', 'dim');
    return false;
  }
  const pid = child.pid;
  if (announce) setNotice('cancelling run (killing the process tree)…', 'warn');
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } catch (error) {
      out(`error: taskkill failed: ${String(error?.message || error)}`, 'err');
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  } else {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  }
  return true;
}

// ------------------------------------------------------------- doctor -----
async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function runDoctor() {
  const session = store.get().session;
  await credentialsReady; // report the FINAL resolution (post electron decrypt)
  out('doctor', 'accent');
  out('config source: browser-use app stores ONLY — ~/.claude/settings.json is NOT consulted', 'accent');

  // Resolution report: which store every spawn value came from.
  if (!APP_SETTINGS_READ.available) {
    out(`app store   [WARN] not found at ${APP_SETTINGS_READ.path} — built-in defaults apply`, 'warn');
  } else {
    out(`app store   ${APP_SETTINGS_READ.path}`, 'dim');
  }
  const connection = RESOLVED_PROVIDER.connection;
  out(connection
    ? `connection  ${connection.provider}/${connection.name || connection.id} — ${connection.baseUrl} (custom models: ${connection.customModels.length})`
    : 'connection  none active in the app store — using fallbacks', connection ? 'ok' : 'dim');
  for (const step of RESOLVED_PROVIDER.resolution) out(`  ${step}`, 'dim');
  out(`resolved    base ${RESOLVED_PROVIDER.baseUrl} · model ${RESOLVED_PROVIDER.model} · control ${RESOLVED_PROVIDER.controlMode}`, 'dim');

  // Secrets store status (honest): the app's per-connection keys are Electron
  // safeStorage blobs, decrypted through the app's OWN decryptor (the repo's
  // electron binary against a temp userData copy). Any failure names itself —
  // never faked — and the owner always has /key <secret> (CLI config file).
  const secretsLabels = {
    'pending': 'resolution still in flight',
    'no-secrets-file': 'secrets store absent',
    'no-entry': 'no key stored for the active connection',
    'electron-unavailable': 'electron binary not found (set BROWSER_USE_ELECTRON)',
    'electron-timeout': 'decrypt helper did not exit in time',
    'electron-decrypt-failed': 'safeStorage.decryptString failed',
    'decrypted': 'ACTIVE connection key decrypted with the app\'s own decryptor'
  };
  out(`app secrets [${APP_SECRETS_READ.status === 'decrypted' ? 'PASS' : 'INFO'}] ${APP_SECRETS_READ.path} — ${secretsLabels[APP_SECRETS_READ.status] || APP_SECRETS_READ.status}${APP_SECRETS_READ.detail ? ` (${APP_SECRETS_READ.detail})` : ''}`, APP_SECRETS_READ.status === 'decrypted' ? 'ok' : 'info');
  // CREDENTIAL PARITY (defect 1): show the masked tail of every stored
  // connection key so the owner can verify the resolved credential IS the
  // app's active-connection credential (the app's UI shows the same masks).
  const storedConnections = Array.isArray(APP_SETTINGS_READ.settings?.aiConnections)
    ? APP_SETTINGS_READ.settings.aiConnections
    : [];
  if (APP_SECRETS_READ.status === 'decrypted' && storedConnections.length) {
    out('credential parity vs the app (masked key tails, same store fields):', 'accent');
    for (const entry of storedConnections) {
      const decrypted = APP_SECRETS_READ.entries?.[`aiProvider:${entry.id}`];
      if (!decrypted?.ok) continue;
      const activeMark = String(entry.id) === APP_CONNECTION ? ' [ACTIVE — what the app uses]' : ' (not active)';
      out(`  ${entry.name || 'connection'} ${String(entry.id).slice(0, 8)} ····${String(decrypted.key).slice(-4)}${activeMark}`, String(entry.id) === APP_CONNECTION ? 'ok' : 'dim');
    }
  }

  const envKeys = [
    ['XKIRO_API_KEY', process.env.XKIRO_API_KEY],
    ['BROWSER_USE_API_KEY', process.env.BROWSER_USE_API_KEY]
  ].filter(([, value]) => Boolean(value));
  const cliConfigRead = readCliConfig();
  if (!RESOLVED_PROVIDER.apiKey) {
    out('api key     [FAIL] none resolved — /key <secret> to store one in the CLI config, or store the key in the app', 'err');
  } else if (RESOLVED_PROVIDER.apiKeySource.startsWith('env')) {
    out(`api key     [WARN] ${RESOLVED_PROVIDER.apiKeySource} (${maskKey(RESOLVED_PROVIDER.apiKey)}) — explicit env export; the app-secrets key was not readable. This may be a DIFFERENT credential than the app's — verify the tails above, or /key <secret> to pin one.`, 'warn');
  } else {
    out(`api key     [PASS] ${RESOLVED_PROVIDER.apiKeySource} (${maskKey(RESOLVED_PROVIDER.apiKey)})`, 'ok');
  }
  if (cliConfigRead.available) {
    out(`cli config  ${cliConfigRead.path}${cliConfigRead.config.apiKey ? ` (stored key ····${String(cliConfigRead.config.apiKey).slice(-4)})` : ' (no key stored)'}`, 'dim');
  }
  if (envKeys.length > 1) {
    out(`env keys    [WARN] ${envKeys.map(([name]) => name).join(' + ')} both set — XKIRO_API_KEY takes precedence`, 'warn');
  }

  // Gateway probe: tests the RESOLVED key's funding directly — a drained or
  // wrong key shows up here as 401/402/429, which is exactly how the old
  // "spins forever" runs failed silently.
  const apiKey = RESOLVED_PROVIDER.apiKey;
  const base = String(RESOLVED_PROVIDER.baseUrl || '').replace(/\/+$/, '');
  if (!base || !apiKey) {
    out('gateway     [FAIL] skipped — credentials incomplete', 'err');
    return;
  }

  const authHeaders = {
    Authorization: `Bearer ${apiKey}`,
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01'
  };

  let modelsStatus = null;
  try {
    const response = await fetchWithTimeout(modelsEndpoint(base), { headers: authHeaders }, 8000);
    modelsStatus = response.status;
    if (response.ok) {
      out(`gateway     [PASS] ${modelsEndpoint(base)} -> ${modelsStatus}`, 'ok');
      return;
    }
  } catch (error) {
    out(`${modelsEndpoint(base)} unreachable (${String(error?.cause?.code || error?.message || error)}) — probing /v1/messages`, 'dim');
  }

  const messagesEndpoint = base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  try {
    const response = await fetchWithTimeout(messagesEndpoint, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ model: session.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] })
    }, 15000);
    const ok = response.status === 200 || response.status === 400; // 400 = reached the gateway, payload rejected
    out(`gateway     ${ok ? '[PASS]' : '[FAIL]'} ${messagesEndpoint} -> ${response.status}${modelsStatus ? ` (models probe: ${modelsStatus})` : ''}`, ok ? 'ok' : 'err');
  } catch (error) {
    out(`gateway     [FAIL] ${String(error?.cause?.code || error?.message || error)}`, 'err');
  }
}

// ---------------------------------------------------------- run lists -----
function listRuns() {
  const runs = [];
  const root = store.get().session.outRoot;
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return runs; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const finalState = readFinalState(dir);
    if (!finalState) continue;
    runs.push({
      dir,
      name: entry.name,
      status: finalState.status ?? 'unknown',
      elapsedMs: finalState.meta?.elapsedMs ?? null,
      model: finalState.meta?.model ?? null,
      endedAt: finalState.meta?.endedAt ?? null
    });
  }
  runs.sort((a, b) => String(b.endedAt || b.name).localeCompare(String(a.endedAt || a.name)));
  return runs;
}

// ------------------------------------------------------------ registry ----
const registry = createCommandRegistry();
const completer = makeCompleter(registry);

registry.register({
  name: 'run',
  args: '[task]',
  description: 'start a headless agent run (streams live; no task -> prompts)',
  detail: [
    'Spawns cli/agent-cli.mjs with the current session settings (model, provider,',
    'url, system prompt, budgets, out root). Tool calls stream live in the run',
    'pane; the TUI stays responsive. On completion a badge summary prints: status',
    '/ success / verified / decisions / tools / elapsed. /cancel stops the tree.'
  ],
  handler: async (argString) => {
    let task = argString.trim();
    if (!task && store.get().session.task) task = store.get().session.task;
    if (!task) task = (await ask('task> ')).trim();
    if (!task) { out('error: no task given', 'err'); return; }
    patchSession({ task });
    submitTask(task);
  }
});

registry.register({
  name: 'task',
  args: '<text>',
  description: 'set the task for the next run; alone shows it',
  handler: async (argString) => {
    if (!argString.trim()) {
      out(store.get().session.task ? ` task: ${store.get().session.task}` : ' no task set — /task <text> or /run <task>', store.get().session.task ? undefined : 'dim');
      return;
    }
    patchSession({ task: argString.trim() });
    out(` task set (${argString.trim().length} chars)`, 'ok');
  }
});

registry.register({
  name: 'url',
  args: '<url>',
  description: 'start URL for the next run (--url passthrough)',
  handler: async (argString) => {
    const value = argString.trim();
    if (!value) {
      out(store.get().session.url ? ` url: ${store.get().session.url}` : ' no start url set', store.get().session.url ? undefined : 'dim');
      return;
    }
    patchSession({ url: value });
    out(` url set: ${value}`, 'ok');
  }
});

registry.register({
  name: 'model',
  args: '[id]',
  description: 'open the model picker (no arg) or set the model directly',
  // Full session catalog (app customModels + cached gateway /v1/models +
  // built-ins); before the one-per-session fetch lands this serves the
  // built-ins, after it the whole gateway list. BARE '/model' opens the
  // selectable picker in App.mjs (the completion-menu UI) — this handler
  // runs only when an id is given, or in piped mode.
  completeArg: (last) => catalogModelIds().filter((m) => m.startsWith(last)),
  handler: async (argString) => {
    const value = argString.trim();
    if (!value) {
      out(` model: ${store.get().session.model} — type /model for the picker, /models for the full list`, 'accent');
      if (modelCatalog.notice) out(` ${modelCatalog.notice}`, 'dim');
      return;
    }
    patchSession({ model: value });
    out(` model set to ${value}`, 'ok');
  }
});

registry.register({
  name: 'models',
  args: '',
  description: 'list every available model (gateway catalog + app connection + built-ins, pricing tiers when the gateway ships them)',
  handler: async () => {
    await loadModelCatalog();
    const models = modelCatalog.models.length
      ? modelCatalog.models
      : MODEL_SUGGESTIONS.map((id) => ({ id, source: 'builtin default', pricing: null }));
    out(` models (${models.length}) — resolved base ${RESOLVED_PROVIDER.baseUrl}`, 'accent');
    if (modelCatalog.notice) out(` ${modelCatalog.notice}`, 'dim');
    const idWidth = Math.max(...models.map((entry) => entry.id.length)) + 1;
    const srcWidth = Math.max(...models.map((entry) => entry.source.length)) + 2;
    for (const entry of models) {
      const pricing = pricingHint(entry.pricing);
      out(`  ${entry.id.padEnd(idWidth)}${entry.source.padEnd(srcWidth)}${pricing}`, entry.source === 'gateway catalog' ? undefined : 'dim');
    }
  }
});

registry.register({
  name: 'provider',
  args: '<id>',
  description: 'provider id: xkiro | anthropic | openai',
  completeArg: (last) => KNOWN_PROVIDERS.filter((p) => p.startsWith(last)),
  handler: async (argString) => {
    const value = argString.trim().toLowerCase();
    if (!value) {
      out(` provider: ${store.get().session.providerId}`, 'accent');
      out(` known: ${KNOWN_PROVIDERS.join('  ')}`, 'dim');
      return;
    }
    if (!KNOWN_PROVIDERS.includes(value)) out(` note: '${value}' is not a known provider (${KNOWN_PROVIDERS.join(', ')}) — set anyway`, 'warn');
    patchSession({ providerId: value });
    out(` provider set to ${value}`, 'ok');
  }
});

registry.register({
  name: 'browser',
  args: '',
  description: 'open the browser-use GUI in your default browser',
  detail: [
    'Starts a local HTTP server on port 4200 (if not already running) and opens',
    'the browser-use desktop renderer at http://localhost:4200'
  ],
  handler: async () => {
    if (isServerRunning()) {
      const url = getServerUrl();
      out(" GUI server already running at " + url, 'accent');
    } else {
      try {
        const { url } = await startServer();
        out(" GUI server started at " + url, 'ok');
      } catch (error) {
        out(" error: could not start GUI server (" + String(error?.message || error) + ")", 'err');
        return;
      }
    }
    const url = getServerUrl();
    // Open in default browser
    try {
      const { exec } = await import('node:child_process');
      exec(`start "${url}"`, { windowsHide: true });
      out(" opening " + url + " in your browser", 'ok');
    } catch (error) {
      out(" error: could not open browser (" + String(error?.message || error) + ")", 'err');
    }
  }
});

registry.register({
  name: 'headed',
  args: '[on|off]',
  description: 'toggle headed Chrome for the next runs (a real visible window; default headless)',
  detail: [
    'Headless is the default and what the CLI runner is built for. /headed on',
    '(or bare /headed) makes every subsequent run launch Chrome with a VISIBLE',
    'window — the agent still drives it through the same CDP adapter, you just',
    'watch it work. /headed off returns to headless. The state is session-only',
    '(not persisted) and shows in /config.'
  ],
  handler: async (argString) => {
    const value = String(argString || '').trim().toLowerCase();
    const current = store.get().session.headed === true;
    let next;
    if (!value || value === 'on' || value === 'true') next = !current ? true : true;
    else if (value === 'off' || value === 'false') next = false;
    else { out(`error: /headed takes on|off (got '${value}')`, 'err'); return; }
    patchSession({ headed: next });
    out(next
      ? ' headed ON — the next run launches a VISIBLE Chrome window'
      : ' headed OFF — runs are headless again', 'ok');
  }
});

// GEN9: the current run's notebook file — the LIVE run's out-dir first, then
// the most recent run (the file survives the run by design).
function notebookFileForView() {
  const outDir = activeRun?.outDir || store.get().session.lastRun;
  return outDir ? path.join(path.resolve(outDir), 'notebook.md') : null;
}

registry.register({
  name: 'notebook',
  args: '[text]',
  description: 'open the run\'s persistent notebook (/notebook <text> appends a note)',
  detail: [
    'The notebook (out-dir/notebook.md) is durable session state: user rules,',
    'working repos, credentials, commands, project facts, requirements, and',
    'the write trail. It survives compaction, restart, and continuation — the',
    'agent re-reads it before EVERY decision. Bare /notebook prints the path',
    'and the current content; /notebook <text> appends a note (NOTES section)',
    'even mid-run — the next model decision sees it.'
  ],
  handler: async (argString) => {
    const text = argString.trim();
    const file = notebookFileForView();
    if (!file) { out(' no run yet — /run starts one (the notebook is created with the run)', 'dim'); return; }
    if (text) {
      const result = notebookAppendLine(file, text);
      if (!result.ok) { out(`error: ${result.error || 'append failed'}`, 'err'); return; }
      out(` noted in ${file} (NOTES — the agent reads it before its next decision)`, 'ok');
      return;
    }
    // OPEN IN NOTEPAD — a popup editor, not a path dump: the file survives
    // compaction/restart and the agent re-reads it before every decision,
    // so user edits land in the very next model decision.
    try { if (!fs.existsSync(file)) fs.writeFileSync(file, '', { flag: 'wx' }); } catch { /* Notepad shows the error for a bad path */ }
    out(` opening notebook in Notepad: ${file}`, 'accent');
    try {
      const child = spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' });
      child.unref();
    } catch (error) {
      out(`error: could not open Notepad (${String(error?.message || error)}) — the notebook is at ${file}`, 'err');
    }
  }
});

registry.register({
  name: 'config',
  args: '',
  description: 'show all current session settings',
  handler: async () => {
    const session = store.get().session;
    const rows = [
      ['task', session.task ? `${session.task.slice(0, 60)}${session.task.length > 60 ? '…' : ''}` : '(none)'],
      ['url', session.url || '(none)'],
      ['working repo', `${session.cwd}${session.cwdPinned ? ' (pinned — /cd <dir> to change)' : ' (invocation dir — /cd <dir> to pin)'}`],
      ['model', session.model],
      ['provider', session.providerId],
      ['control mode', session.controlMode || 'browser'],
      ['browser window', session.headed ? 'headed (visible Chrome)' : 'headless (default)'],
      ['system file', session.systemFile || '(none)'],
      ['max-seconds', `${session.maxSeconds} (${clockLabel()})`],
      ['max-steps', `${session.maxSteps} (${session.maxSteps > 0 ? 'budgeted' : 'unlimited'})`],
      ['max-recoveries', `${session.maxRecoveries} (${session.maxRecoveries > 0 ? 'budgeted' : 'unlimited'})`],
      ['out root', session.outRoot],
      ['last run', session.lastRun || '(none)'],
      ['notebook', notebookFileForView() || '(no run yet — /run starts one)'],
      ['run active', child ? 'yes' : 'no']
    ];
    pushHistory(store, { kind: 'rows', rows });
  }
});

registry.register({
  name: 'system',
  args: '<file|off>',
  description: 'variant system prompt file for the next run',
  handler: async (argString) => {
    const value = argString.trim();
    if (!value) {
      out(store.get().session.systemFile ? ` system file: ${store.get().session.systemFile}` : ' no system file set (agent default prompt)', store.get().session.systemFile ? undefined : 'dim');
      return;
    }
    if (value === 'off') {
      patchSession({ systemFile: null });
      out(' system file off — agent default prompt', 'ok');
      return;
    }
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved)) { out(`error: no such file: ${resolved}`, 'err'); return; }
    patchSession({ systemFile: resolved });
    out(` system file set: ${resolved}`, 'ok');
  }
});

function parseBudget(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text || text === 'off' || text === '0') return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) throw new Error(`'${value}' is not a non-negative integer, off, or 0`);
  return n;
}

function budgetCommand(name, description, key) {
  registry.register({
    name,
    args: '<n|off>',
    description,
    handler: async (argString) => {
      const value = parseBudget(argString);
      patchSession({ [key]: value });
      out(` ${name} set to ${value}${value > 0 ? '' : ' (unlimited)'}`, 'ok');
    }
  });
}
budgetCommand('max-seconds', 'observer clock for the run (0/off = untimed)', 'maxSeconds');
budgetCommand('steps', 'external step budget (0/off = unlimited)', 'maxSteps');
budgetCommand('recoveries', 'external recovery budget (0/off = unlimited)', 'maxRecoveries');

registry.register({
  name: 'out',
  args: '<dir>',
  description: 'out-dir root for runs (default cli-runs/ under the tool root)',
  handler: async (argString) => {
    const value = argString.trim();
    if (!value) {
      out(` out root: ${store.get().session.outRoot}`);
      return;
    }
    const resolved = path.resolve(value);
    try { fs.mkdirSync(resolved, { recursive: true }); } catch { /* agent-cli recreates */ }
    patchSession({ outRoot: resolved });
    out(` out root set to ${resolved}`, 'ok');
  }
});

registry.register({
  name: 'cd',
  args: '[<dir>]',
  description: 'pin the working repo for runs (no arg: show it) — defaults to the invocation dir',
  detail: [
    'The working repo defaults to the directory the CLI was INVOKED from',
    '(process.cwd() at boot) — the defect where every run was rooted at the',
    'tool repo regardless of where you launched it is fixed. /cd <dir> pins a',
    'different repo (relative paths, ~ and %USERPROFILE% expand); /cd .',
    're-pins to the current directory. The pinned repo shows in the header,',
    'the footer and /config, and every run spawns with it as its cwd and',
    'workspace contract.'
  ],
  handler: async (argString) => {
    const value = argString.trim();
    const session = store.get().session;
    if (!value) {
      out(` working repo: ${session.cwd}${session.cwdPinned ? ' (pinned)' : ' (invocation dir)'}`, 'accent');
      out(' /cd <dir> to pin a different repo — runs spawn there', 'dim');
      return;
    }
    const expanded = value === '~'
      ? os.homedir()
      : value.replace(/^~[/\\]/, `${os.homedir()}${path.sep}`);
    const resolved = path.resolve(expanded);
    let stat = null;
    try { stat = fs.statSync(resolved); } catch { /* reported below */ }
    if (!stat || !stat.isDirectory()) {
      out(`error: not a directory: ${resolved}`, 'err');
      return;
    }
    patchSession({ cwd: resolved, cwdPinned: true });
    out(` working repo pinned: ${resolved}`, 'ok');
  }
});

// --------------------------- GEN9: /skills and /mcp (shared modules) -------
// Scope helpers: BOTH surfaces read/write the same on-disk stores, so what is
// installed here the desktop app sees and vice versa. The repo scope always
// follows the pinned working repo (/cd).
function gen9RepoRoot() {
  return store.get().session.cwd || process.cwd();
}
function gen9UserCliDir() {
  return path.join(os.homedir(), '.browser-use-cli');
}
function gen9SkillsManager() {
  return new SkillsManager({
    userDir: path.join(gen9UserCliDir(), 'skills'),
    repoDir: path.join(gen9RepoRoot(), '.browser-use', 'skills')
  });
}
function gen9McpStore() {
  return new McpConfigStore({
    userFile: path.join(gen9UserCliDir(), 'mcp.json'),
    repoFile: path.join(gen9RepoRoot(), '.browser-use', 'mcp.json')
  });
}
function gen9McpRegistry() {
  return new McpRegistry({
    userFile: path.join(gen9UserCliDir(), 'mcp.json'),
    repoFile: path.join(gen9RepoRoot(), '.browser-use', 'mcp.json'),
    connectTimeoutMs: 15000
  });
}
// Shell-like tokenizer for /mcp add (quotes honored).
function gen9SplitTokens(text) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(text || ''))) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

registry.register({
  name: 'skills',
  args: '[install <path|git-url> [--repo] | registry <file> <name> [--repo] | list | show <id> | enable|disable|remove|update <id> | search <text>]',
  description: 'install/manage skill packages (SKILL.md) — user scope ~/.browser-use-cli/skills, repo scope <pinned repo>/.browser-use/skills; installed skills are found by skill_search in every run',
  detail: [
    'A skill package is a folder with SKILL.md (frontmatter: name, description,',
    'triggers, apps, domains + a body of instructions) and optional scripts/.',
    'Sources: a local folder, a git URL (cloned depth 1), or a marketplace-style',
    'registry file ({ "skills": [{ "name", "url"|"path" }] }). Installed skills',
    'merge with learned skills in the same skillsApi the agent already uses, so',
    'skill_search/skill_run surface them with no per-run wiring. Shared scopes:',
    'the desktop app reads the same stores.'
  ],
  handler: async (argString) => {
    const tokens = gen9SplitTokens(argString);
    const sub = (tokens.shift() || '').toLowerCase();
    const manager = gen9SkillsManager();
    const scope = tokens.includes('--repo') ? 'repo' : 'user';
    const idOf = () => tokens.filter(t => t !== '--repo')[0];
    try {
      if (!sub || sub === 'list') {
        const all = manager.list();
        out(` installed skills (${all.length}) — user: ${manager.userDir}${manager.repoDir ? ` · repo: ${manager.repoDir}` : ''}`, 'accent');
        if (!all.length) out(' none — /skills install <folder-or-git-url>', 'dim');
        for (const skill of all) {
          out(`  ${skill.enabled ? '[on] ' : '[off]'} ${skill.id.padEnd(34)} ${skill.name}${skill.usage.runs ? ` (${skill.usage.successes}/${skill.usage.runs} ok)` : ''}`);
          if (skill.when) out(`      ${skill.when.slice(0, 100)}`, 'dim');
        }
        return;
      }
      if (sub === 'install') {
        const source = idOf();
        if (!source) { out('usage: /skills install <path-or-git-url> [--repo]', 'err'); return; }
        const isUrl = /^https?:\/\//i.test(source);
        const skill = await manager.install({ source: isUrl ? { kind: 'git', url: source } : { kind: 'local', path: source }, scope });
        out(` installed ${skill.name} as ${skill.id} (${scope} scope)${skill.hasScripts ? ' + scripts/' : ''}`, 'ok');
        out(' it is now searchable by skill_search in every run (both surfaces)', 'dim');
        return;
      }
      if (sub === 'registry') {
        const rest = tokens.filter(t => t !== '--repo');
        const [registryFile, name] = rest;
        if (!registryFile || !name) { out('usage: /skills registry <registry-file> <name> [--repo]', 'err'); return; }
        const skill = await manager.installFromRegistry({ registry: registryFile, name, scope });
        out(` installed ${skill.name} as ${skill.id} from registry (${scope} scope)`, 'ok');
        return;
      }
      if (sub === 'show') {
        const skill = manager.get(idOf() || '');
        if (!skill) { out(`error: no such skill: ${idOf()}`, 'err'); return; }
        out(` ${skill.id} — ${skill.name} [${skill.enabled ? 'enabled' : 'disabled'}] (${skill.scope} scope, rev ${skill.revision})`, 'accent');
        out(` from: ${skill.source.kind}${skill.source.url ? ` ${skill.source.url}` : skill.source.path ? ` ${skill.source.path}` : ''}`, 'dim');
        out(` when: ${skill.when || '—'}`, 'dim');
        out(` body: ${skill.bodyChars} chars${skill.hasScripts ? ', has scripts/' : ''}`, 'dim');
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        const skill = sub === 'enable' ? manager.enable(idOf() || '') : manager.disable(idOf() || '');
        if (!skill) { out(`error: no such skill: ${idOf()}`, 'err'); return; }
        out(` ${skill.id} is now ${skill.enabled ? 'enabled' : 'disabled'}`, 'ok');
        return;
      }
      if (sub === 'remove') {
        const removed = manager.remove(idOf() || '');
        out(removed ? ` removed ${idOf()}` : `error: no such skill: ${idOf()}`, removed ? 'ok' : 'err');
        return;
      }
      if (sub === 'update') {
        const skill = await manager.update(idOf() || '');
        if (!skill) { out(`error: no such skill: ${idOf()}`, 'err'); return; }
        out(` updated ${skill.id} (rev ${skill.revision})`, 'ok');
        return;
      }
      if (sub === 'search') {
        const text = tokens.join(' ');
        const results = manager.search({ task: text, limit: 5 });
        if (!results.length) { out(' no installed skill matches', 'dim'); return; }
        for (const entry of results) out(`  ${entry.score.toFixed(2)}  ${entry.skill.id} — ${entry.skill.name}`);
        return;
      }
      out(`error: unknown /skills subcommand '${sub}'`, 'err');
    } catch (error) {
      out(`error: ${error.message}`, 'err');
    }
  }
});

registry.register({
  name: 'mcp',
  args: '[add <name> <command...>|<url> [--repo] [--header "K: V"] | list | status | test <name> | auth <name> <Header: value> | enable|disable|remove <name>]',
  description: 'add/manage EXTERNAL MCP servers (client side) — stdio command or http url; their tools are exposed to the agent as mcp__<server>__<tool>; config: ~/.browser-use-cli/mcp.json + <pinned repo>/.browser-use/mcp.json',
  detail: [
    'The app already SERVES MCP (desktop/mcp/localMcpServer.cjs); this is the',
    'client side: the agent calling external servers. /mcp add registers a',
    'server (stdio: a command line; http: an URL, auth via --header or /mcp',
    'auth). /mcp status connects every enabled server and reports health +',
    'tool counts; discovery is MCP tools/list. Repo-scope config overrides',
    'user-scope entries by server name. Shared scopes: the desktop app reads',
    'the same files. Reconnect policy: an unexpected drop retries with capped',
    'exponential backoff indefinitely while the server stays enabled.'
  ],
  handler: async (argString) => {
    const tokens = gen9SplitTokens(argString);
    const sub = (tokens.shift() || '').toLowerCase();
    const store9 = gen9McpStore();
    try {
      if (!sub || sub === 'list') {
        const { merged } = store9.load();
        const names = Object.keys(merged);
        out(` mcp servers (${names.length}) — user: ${store9.userFile}${store9.repoFile ? ` · repo: ${store9.repoFile}` : ''}`, 'accent');
        if (!names.length) out(' none — /mcp add <name> <command-or-url>', 'dim');
        for (const name of names) {
          const server = merged[name];
          const where = server.url || `${server.command} ${(server.args || []).join(' ')}`.trim();
          out(`  ${server.enabled === false ? '[off]' : '[on] '} ${name.padEnd(20)} ${server.scope.padEnd(5)} ${String(server.kind || (server.url ? 'http' : 'stdio')).padEnd(6)} ${where.slice(0, 90)}`);
        }
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
        if (!name || !target.length) { out('usage: /mcp add <name> <command...>|<url> [--repo] [--header "K: V"]', 'err'); return; }
        const isUrl = /^https?:\/\//i.test(target[0]);
        const config = isUrl
          ? { url: target[0], ...(Object.keys(headers).length ? { headers } : {}) }
          : { command: target[0], args: target.slice(1), ...(Object.keys(headers).length ? { headers } : {}) };
        const saved = store9.addServer({ scope, name, config });
        out(` added mcp server "${saved.name}" (${scope} scope, ${isUrl ? 'http' : 'stdio'})`, 'ok');
        out(' /mcp test <name> to connect and list its tools', 'dim');
        return;
      }
      if (sub === 'auth') {
        const [name, ...headerParts] = tokens;
        const headerText = headerParts.join(' ');
        const colon = headerText.indexOf(':');
        if (!name || colon <= 0) { out('usage: /mcp auth <name> <Header: value>', 'err'); return; }
        const result = store9.setHeader(name, headerText.slice(0, colon).trim(), headerText.slice(colon + 1).trim());
        out(` header stored for "${result.name}" (${Object.keys(result.headers).join(', ')})`, 'ok');
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        const name = tokens[0];
        const result = store9.setEnabled(name || '', sub === 'enable');
        if (!result) { out(`error: no such mcp server: ${name}`, 'err'); return; }
        out(` ${result.name} is now ${result.enabled ? 'enabled' : 'disabled'} (${result.scope} scope)`, 'ok');
        return;
      }
      if (sub === 'remove') {
        const name = tokens[0];
        const removed = store9.removeServer(name || '');
        out(removed ? ` removed ${name}` : `error: no such mcp server: ${name}`, removed ? 'ok' : 'err');
        return;
      }
      if (sub === 'status' || sub === 'test') {
        const registry = gen9McpRegistry();
        try {
          if (sub === 'test') {
            const name = tokens[0];
            if (!name) { out('usage: /mcp test <name>', 'err'); return; }
            const connection = await registry.ensureConnected(name);
            const status = connection.status();
            out(` ${name}: ${status.state} (${status.kind}, handshake ${status.handshakeMs ?? '?'}ms)`, 'ok');
            for (const tool of status.tools) out(`   tool: mcp__${name}__${tool}`, 'dim');
          } else {
            const results = await registry.connectAll();
            out(` mcp servers (${results.length}):`, 'accent');
            for (const row of results) {
              const detail = row.state === 'ready' ? `${row.toolCount} tools` : row.state === 'disabled' ? 'disabled' : `error: ${String(row.error || row.lastError || 'unknown').slice(0, 90)}`;
              out(`  ${row.name.padEnd(20)} ${String(row.state).padEnd(12)} ${detail}`);
            }
          }
        } finally {
          registry.stopAll();
        }
        return;
      }
      out(`error: unknown /mcp subcommand '${sub}'`, 'err');
    } catch (error) {
      out(`error: ${error.message}`, 'err');
    }
  }
});

registry.register({
  name: 'status',
  args: '',
  description: 'live state of the active run (elapsed + last tool from trace)',
  handler: async () => {
    const session = store.get().session;
    if (!child || !activeRun) {
      out(' no run active', 'dim');
      if (session.lastRun) out(` last run: ${session.lastRun} — /trace for its tool calls, /history for all runs`, 'dim');
      return;
    }
    const elapsed = formatElapsed(Date.now() - activeRun.startedAt);
    const tail = tailToolFromTrace(path.join(activeRun.outDir, 'trace.jsonl'));
    pushHistory(store, {
      kind: 'rows',
      rows: [
        [`run ${path.basename(activeRun.outDir)}`, 'active'],
        [`elapsed ${elapsed}`, tail ? `last tool ${tail.tool}${tail.done ? ' (done)' : ''}` : 'no tool events yet'],
        ['task', activeRun.task.slice(0, 80) + (activeRun.task.length > 80 ? '…' : '')]
      ]
    });
  }
});

registry.register({
  name: 'cancel',
  args: '',
  description: 'cancel the active run (kills the child process tree) — Escape does the same during a run',
  handler: async () => {
    if (!child) { out(' no active run to cancel', 'dim'); return; }
    cancelRun();
  }
});

registry.register({
  name: 'trace',
  args: '',
  description: "list the last run's tool calls (tool, durationMs, ok)",
  handler: async () => {
    const lastRun = store.get().session.lastRun;
    if (!lastRun) { out(' no run yet — /run starts one', 'dim'); return; }
    const finalState = readFinalState(lastRun);
    if (!finalState) { out(`error: no final-state.json in ${lastRun}`, 'err'); return; }
    const calls = Array.isArray(finalState.toolCalls) ? finalState.toolCalls : [];
    out(` tools in ${path.basename(lastRun)} (${calls.length})`, 'accent');
    if (!calls.length) { out(' no tool calls recorded', 'dim'); return; }
    for (const call of calls.slice(0, 60)) {
      const okBadge = call.ok === true ? '[ok]' : call.ok === false ? '[FAIL]' : '[—]';
      out(`  ${String(call.tool || '—').padEnd(28)} ${String(call.durationMs != null ? `${call.durationMs}ms` : '—').padStart(10)}  ${okBadge}`);
    }
    if (calls.length > 60) out(`  … and ${calls.length - 60} more`, 'dim');
  }
});

registry.register({
  name: 'history',
  args: '',
  description: 'list previous run dirs with status/elapsed (click a row to resume it)',
  handler: async () => {
    const session = store.get().session;
    const runs = listRuns();
    if (!runs.length) { out(` no finished runs under ${session.outRoot}`, 'dim'); return; }
    out(` runs under ${session.outRoot} (${runs.length})`, 'accent');
    pushHistory(store, {
      kind: 'runHistory',
      runs: runs.slice(0, 20).map((run) => ({
        name: run.name,
        status: String(run.status),
        elapsed: run.elapsedMs != null ? formatElapsed(run.elapsedMs) : '—',
        model: run.model || ''
      })),
      tips: 'click a row (or /resume <name>) to continue that conversation with your next message'
    });
    if (runs.length > 20) out(`  … and ${runs.length - 20} older`, 'dim');
  }
});

registry.register({
  name: 'resume',
  args: '[<run-name>|clear]',
  description: 'continue a previous conversation — click a /history row or name the run; your next message becomes its next turn',
  handler: async (argString) => {
    const arg = String(argString || '').trim();
    if (arg.toLowerCase() === 'clear') {
      if (!resumeTarget) { out(' no resume target selected', 'dim'); return; }
      resumeTarget = null;
      out(' resume target cleared', 'dim');
      return;
    }
    if (!arg) {
      // Bare /resume = the same clickable list as /history.
      const runs = listRuns();
      if (!runs.length) { out(' no finished runs yet', 'dim'); return; }
      pushHistory(store, {
        kind: 'runHistory',
        runs: runs.slice(0, 20).map((run) => ({
          name: run.name,
          status: String(run.status),
          elapsed: run.elapsedMs != null ? formatElapsed(run.elapsedMs) : '—',
          model: run.model || ''
        })),
        tips: 'click a row to continue that conversation with your next message'
      });
      return;
    }
    resumeRun(arg);
  }
});

registry.register({
  name: 'doctor',
  args: '',
  description: 'credential + gateway connectivity check (PASS/FAIL per check)',
  handler: runDoctor
});

registry.register({
  name: 'key',
  args: '[<secret>|clear]',
  description: 'store/inspect/clear the provider API key in the CLI config file (~/.browser-use-cli/config.json)',
  detail: [
    'The key resolution order is: app-store secrets (the ACTIVE connection key',
    'decrypted with the app\'s own decryptor) > this CLI config file > explicit',
    'env exports. /key with no argument shows the current source + masked tail;',
    '/key <secret> stores an owner-provided key (0600 file, never logged — only',
    'its last 4 characters); /key clear removes it. This is the sanctioned',
    'fallback when the app\'s secrets store cannot be decrypted — it is the',
    'CLI\'s own store, NOT claude-code, NOT env.'
  ],
  handler: async (argString) => {
    const value = argString.trim();
    const current = readCliConfig();
    if (!value) {
      if (current.available && current.config.apiKey) {
        out(` cli config key: ${maskKey(current.config.apiKey)} (${current.path})`, 'accent');
      } else {
        out(` no key stored in the CLI config (${current.path}) — /key <secret> to store one`, 'dim');
      }
      return;
    }
    if (value.toLowerCase() === 'clear') {
      if (!current.available || !current.config.apiKey) { out(' no key stored in the CLI config', 'dim'); return; }
      const { apiKey, ...rest } = current.config;
      void apiKey;
      writeCliConfig(rest, current.path);
      out(' cli config key cleared', 'ok');
      return;
    }
    const { apiKey: _drop, ...rest } = current.config;
    void _drop;
    writeCliConfig({ ...rest, apiKey: value, savedAt: new Date().toISOString() }, current.path);
    // Re-resolve immediately so the next run uses the new key (it outranks env).
    APP_SECRETS_READ = APP_SECRETS_READ.status === 'decrypted'
      ? APP_SECRETS_READ
      : { ...APP_SECRETS_READ, status: APP_SECRETS_READ.status === 'pending' ? 'pending' : APP_SECRETS_READ.status };
    RESOLVED_PROVIDER = resolveProviderConfig({
      appSettings: APP_SETTINGS_READ.settings,
      appSecrets: APP_SECRETS_READ,
      cliConfig: readCliConfig().config,
      env: process.env
    });
    out(` key stored in ${current.path} (${maskKey(value)}) — used when the app store is not decrypted`, 'ok');
  }
});

registry.register({
  name: 'clear',
  args: '',
  description: 'clear the screen',
  handler: async () => {
    store.set((state) => ({ ...state, history: [] }));
  }
});

registry.register({
  name: 'help',
  args: '[command]',
  description: 'list every command, or detailed help for one',
  completeArg: (last) => registry.names().filter((n) => n.startsWith(last)).map((n) => `/${n}`),
  handler: async (argString) => {
    const name = argString.trim().replace(/^\//, '').toLowerCase();
    if (name) {
      const cmd = registry.get(name);
      if (!cmd) { out(`error: no such command '/${name}' — /help for the list`, 'err'); return; }
      pushHistory(store, {
        kind: 'rows',
        rows: [[`/${cmd.name} ${cmd.args || ''}`, cmd.description]],
        tips: cmd.detail ? cmd.detail.join('\n ') : null
      });
      return;
    }
    const width = Math.max(...registry.list().map((cmd) => `/${cmd.name} ${cmd.args || ''}`.length)) + 2;
    const rows = registry.list().map((cmd) => [
      `/${cmd.name} ${cmd.args || ''}`.padEnd(width),
      cmd.description
    ]);
    pushHistory(store, {
      kind: 'rows',
      rows,
      tips: 'tips: /model opens the picker · / + TAB filters commands · /cd pins the working repo · Escape cancels an active run (clears input at idle) · Ctrl+C cancels/exits · full-screen: mouse wheel scrolls history, click a menu row to run it'
    });
  }
});

registry.register({
  name: 'about',
  args: '',
  description: 'what this TUI is',
  handler: async () => {
    out(` browser-use TUI v${VERSION}`, 'accent');
    out(' an interactive console over cli/agent-cli.mjs: headless Chrome + the real');
    out(' DesktopChatAgent loop. Configure the session with slash commands, /run to');
    out(' launch, /status to watch, /trace and /history to inspect what happened.', 'dim');
  }
});

registry.register({
  name: 'version',
  args: '',
  description: 'print the version',
  handler: async () => {
    out(` browser-use v${VERSION}`, 'accent');
  }
});

// ---------------------------------------------------------- exit flow -----
let exitConfirmPending = false; // Ctrl+C armed within the grace window

function exitNow() {
  exiting = true;
  store.set((state) => ({ ...state, exiting: true }));
  try { instance.unmount(); } catch { /* already unmounted */ }
  if (SCREEN_MODE === 'full') { try { process.stdout.write(MOUSE_DISABLE + (HOVER_ENABLED ? MOTION_DISABLE : '')); } catch { /* gone */ } }
  process.exit(0);
}

async function exitFlow() {
  if (child) {
    out(' cancelling the active run first...', 'warn');
    cancelRun({ announce: false });
  }
  const answer = (await ask('exit browser-use? (y/n)')).trim().toLowerCase();
  if (answer.startsWith('y')) exitNow();
  else {
    out(' staying', 'dim');
  }
}

registry.register({
  name: 'auth',
  args: '',
  description: 'interactively set the gateway base URL and API key (stored 0600 in the CLI config file)',
  detail: [
    'Asks for the base URL (Enter keeps the current one) and the API key',
    '(stored in the CLI\'s own config file ~/.browser-use-cli/config.json —',
    'browser-use config only, NOT claude-code, NOT env). Both values',
    'outrank the app-store connection for TUI-spawned runs; /doctor shows',
    'the resolved sources afterwards.'
  ],
  handler: async () => {
    const current = readCliConfig();
    const currentBase = RESOLVED_PROVIDER?.baseUrl || 'builtin default';
    const currentKey = current.config.apiKey ? maskKey(current.config.apiKey) : 'none';
    out(` current base url: ${currentBase}`, 'dim');
    out(` current key: ${currentKey} (${current.path})`, 'dim');
    const base = (await ask(`Base URL (Enter = keep ${currentBase}): `)).trim().replace(/\/+$/, '');
    const key = (await ask('API key (stored 0600 in the CLI config; visible while typing): ')).trim();
    if (!base && !key) { out(' nothing entered — config unchanged', 'dim'); return; }
    const next = { ...current.config };
    if (base) next.baseUrl = base;
    if (key) next.apiKey = key;
    writeCliConfig({ ...next, savedAt: new Date().toISOString() }, current.path);
    RESOLVED_PROVIDER = resolveProviderConfig({
      appSettings: APP_SETTINGS_READ.settings,
      appSecrets: APP_SECRETS_READ,
      cliConfig: readCliConfig().config,
      env: process.env
    });
    out(` auth updated — base url: ${RESOLVED_PROVIDER.baseUrl} (${RESOLVED_PROVIDER.baseUrlSource})`, 'ok');
    out(` key: ${RESOLVED_PROVIDER.apiKey ? `${maskKey(RESOLVED_PROVIDER.apiKey)} (${RESOLVED_PROVIDER.apiKeySource})` : 'unchanged'}`, 'ok');
  }
});

registry.register({
  name: 'exit',
  args: '',
  description: 'graceful exit (cancels an active run first, y/n confirm)',
  handler: () => exitFlow()
});
registry.register({
  name: 'quit',
  args: '',
  description: 'alias of /exit',
  handler: () => exitFlow()
});

// ---------------------------------------------------------------- ask -----
// The Ink input routes the next submitted line to an open question (task
// prompt, exit confirm) — the same serialized-ask contract the readline TUI
// had (a question opened by a handler consumes the next Enter).
let pendingAskResolve = null;

function ask(question) {
  if (pendingAskResolve) return Promise.resolve('');
  store.set((state) => ({ ...state, pendingAsk: question }));
  return new Promise((resolve) => {
    pendingAskResolve = (answer) => {
      pendingAskResolve = null;
      store.set((state) => ({ ...state, pendingAsk: null }));
      resolve(String(answer ?? ''));
    };
  });
}

function answerAsk(text) {
  if (pendingAskResolve) pendingAskResolve(text);
}

// ----------------------------------------------------------- dispatch -----
let lineChain = Promise.resolve();

function handleSubmit(text) {
  appendHistory(text);
  pushHistory(store, { kind: 'user', text });
  // Serialize handlers so a question opened by one command (e.g. /run's task
  // prompt, /exit's confirm) cannot interleave with the next line.
  lineChain = lineChain.then(() => handleLine(text)).catch((error) => {
    out(`error: ${String((error && error.message) || error)}`, 'err');
  });
}

async function handleLine(text) {
  const trimmed = String(text ?? '').trim();
  if (pendingAskResolve) {
    // Lines queued behind a handler that opened a question land here —
    // route them to the open ask, same as fresh answers.
    answerAsk(trimmed);
    return;
  }
  if (!trimmed) return;
  if (!trimmed.startsWith('/')) {
    // Plain text IS the task — agent-first semantics: typed text starts a run
    // with the current session settings (model, url, clock), exactly like
    // /run <text>. This matches Claude Code / Qwen Code behavior. MID-RUN the
    // text QUEUES instead (desktop parity) — submitTask never loses it.
    submitTask(trimmed);
    return;
  }
  const parsed = parseCommand(trimmed);
  // A bare '/' acts as the command list (same as /help with no arg).
  const lookupName = parsed && parsed.name === '' ? 'help' : parsed?.name;
  const cmd = lookupName ? registry.get(lookupName) : null;
  if (!cmd) {
    out(`error: Unknown command /${parsed ? parsed.name : trimmed} — /help for the list`, 'err');
    return;
  }
  try {
    await cmd.handler(parsed.argString);
  } catch (error) {
    out(`error: ${String(error?.message || error)}`, 'err');
  }
}

// ----------------------------------------------------------- ctrl+c -------
function onCtrlC() {
  if (exiting) return;
  if (child) {
    cancelRun(); // first press during a run: cancel + notice
    return;
  }
  if (pendingAskResolve) {
    // A question is open — Ctrl+C answers it negatively.
    answerAsk('');
    return;
  }
  if (exitConfirmPending) {
    exitNow();
    return;
  }
  exitConfirmPending = true;
  setNotice('press Ctrl+C again to exit', 'warn');
  setTimeout(() => { exitConfirmPending = false; }, 2500);
}

// ------------------------------------------------------------- mount ------
// ---------------------------------------------------- screen mode ---------
// FULL ('full') when a real interactive TTY of usable size hosts us — Ink 7
// renders the app in the alternate screen (one framed layout: header /
// windowed history / live run card / composer / footer, SGR mouse reporting).
// INLINE otherwise (piped, CI, dumb term, tiny windows, BROWSER_USE_TUI_FULL=0)
// — the classic Static layout, which the tests cover.
const SCREEN_MODE = detectScreenMode({
  interactive: Boolean(process.stdin.isTTY),
  stdout: process.stdout,
  env: process.env
});

const controller = {
  store,
  registry,
  completer,
  version: VERSION,
  screenMode: SCREEN_MODE,
  handleSubmit,
  answerAsk,
  // The cached session catalog for the bare-/model picker UI (App.mjs).
  // Before the one-per-session gateway fetch lands this serves the built-ins.
  getModelCatalog: () => (modelCatalog.models.length
    ? modelCatalog.models
    : MODEL_SUGGESTIONS.map((id) => ({ id, source: 'builtin default', pricing: null }))),
  onCtrlC,
  // Escape during an active run = /cancel (same confirm-free code path —
  // App.mjs routes the keypress here only while state.run is live).
  // Escape priority (FEATURE B): a subagent pane is open -> switch back to
  // the main run card; otherwise Escape during a run cancels it.
  onEscape: () => {
    if (store.get().activeSubagent) {
      selectMainPane();
      return;
    }
    if (child) cancelRun();
    // No run live and a /history row was clicked: Escape un-picks it.
    if (resumeTarget) {
      resumeTarget = null;
      out(' resume target cleared', 'dim');
    }
  },
  // FEATURE B pane switching (click-to-switch lives in App.mjs frame math).
  selectSubagentPane,
  selectMainPane,
  // Clickable /history rows (App.mjs frame math): clicking a previous run
  // marks it for resume — the next submitted message continues that
  // conversation via agent-cli --resume.
  resumeRun,
  hasResumeTarget: () => Boolean(resumeTarget),
  getLineHistory: () => loadHistory(),
  // NOTE: no per-render mouse-mode hook. Any-motion (?1003h) tracking is
  // enabled ONCE below (before ink mounts) and disabled ONCE on every exit
  // path — per-render toggling interleaved raw control bytes with ink's
  // frame stream (owner-reported banner corruption + constant repaints).
  // The hover feature works entirely within the always-on motion stream.
  // False for piped stdin: ink's raw-mode toggle would throw, so the App
  // disables useInput and the line reader below drives the same dispatch.
  interactive: Boolean(process.stdin.isTTY)
};

// SGR button/wheel reporting is enabled ONCE before Ink mounts. Hover motion
// is on for the interactive full-screen TUI so clickable rows visibly respond;
// set BROWSER_USE_TUI_HOVER=0 to disable it on terminals that emit noisy motion.
const HOVER_ENABLED = SCREEN_MODE === 'full' && String(process.env.BROWSER_USE_TUI_HOVER || '').trim() !== '0';
if (SCREEN_MODE === 'full') {
  try { process.stdout.write(MOUSE_ENABLE + (HOVER_ENABLED ? MOTION_ENABLE : '')); } catch { /* not a real terminal */ }
}

const instance = render(h(App, { controller }), {
  exitOnCtrlC: false,
  patchConsole: true,
  // Full-screen tier: Ink 7's native alternate-screen mode (vim/htop-style).
  // Ink itself ignores this in non-interactive environments, and the App
  // renders the inline layout whenever controller.screenMode is 'inline'.
  alternateScreen: SCREEN_MODE === 'full'
});

if (!controller.interactive) {
  // Piped usage (tests, scripts): read \r/\n-terminated lines and route them
  // through the SAME dispatch the keyboard path uses. EOF exits, taking an
  // active run down with us.
  let piped = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    piped += String(chunk);
    let index;
    while ((index = piped.search(/[\r\n]/)) !== -1) {
      const line = piped.slice(0, index);
      piped = piped.slice(index + 1);
      if (line) handleSubmit(line);
    }
  });
}

// stdin closed (piped/EOF): take a run down with us and exit.
process.stdin.on('end', () => {
  if (child) cancelRun({ announce: false });
  exiting = true;
  try { instance.unmount(); } catch { /* already unmounted */ }
  if (SCREEN_MODE === 'full') { try { process.stdout.write(MOUSE_DISABLE + (HOVER_ENABLED ? MOTION_DISABLE : '')); } catch { /* gone */ } }
  process.exit(0);
});

// Last-resort terminal-state restore (mouse reporting) on any other exit.
process.on('exit', () => {
  if (SCREEN_MODE === 'full') { try { process.stdout.write(MOUSE_DISABLE + (HOVER_ENABLED ? MOTION_DISABLE : '')); } catch { /* gone */ } }
});

process.on('uncaughtException', (error) => {
  try { out(`uncaught: ${String(error?.message || error)}`, 'err'); } catch { /* store gone */ }
});
process.on('unhandledRejection', (error) => {
  try { out(`unhandled: ${String((error && error.message) || error)}`, 'err'); } catch { /* store gone */ }
});

// Exported for tests (ink-testing-library mounts its own App instance with a
// fake controller; this module's singleton only boots under the real bin).
export { controller, registry, store, theme as tuiTheme };
