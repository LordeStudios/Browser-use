// cli/tui/appConfig.mjs
//
// BROWSER-USE-CONFIG-ONLY provider resolution for the TUI. ~/.claude/settings.json
// is NOT consulted at all — the CLI reads only the browser-use desktop app's own
// configuration, the same stores (and the same fields) the app itself uses:
//
//   1. The browser-use app's settings store
//        %APPDATA%/browser-use/browser-use-settings.json   (Windows)
//        ~/Library/Application Support/browser-use/...      (macOS)
//        ~/.config/browser-use/...                          (Linux)
//      carries the connections catalog (`aiConnections`: id, provider, name,
//      baseUrl, model, customModels) and the ACTIVE connection selection
//      (aiChatProvider + aiChatConnectionId), plus shared agent settings
//      (agentControlMode). This mirrors desktop/main.cjs exactly:
//        - normalizedConnections()  -> aiConnections
//        - connectionById(settings.aiChatConnectionId)  (main.cjs:1557)
//        - activeProviderConfig()                       (main.cjs:1564)
//
//   1b. The app's secrets store (browser-use-secrets.json): the per-connection
//      API keys under `aiProvider:<connectionId>` — the exact lookup the app
//      does via connectionCredentialKey() (main.cjs:1554) +
//      credentialStore.get() (store/credentialStore.cjs). Electron 43 wraps
//      each key as a Chromium os_crypt_async "v10" AES-256-GCM blob whose key
//      is DPAPI-wrapped in Local State. A pure-Node reproduction of the
//      payload does NOT verify (every nonce/tag/AAD layout tried failed auth),
//      so the CLI decrypts through the REAL decryptor: the repo's own
//      electron.exe binary, run headless against a TEMP userData that holds
//      copies of Local State + the secrets file, calling safeStorage
//      .decryptString — the identical call the app makes. Proven live 2026-10-12:
//      the active connection's key decrypts and matches the app's working
//      credential (the NON-active connection's key is a DIFFERENT key — the
//      one an ambient XKIRO_API_KEY env export pointed at, whose wallet 402'd
//      and 429'd; live evidence cli-runs/run-2026-10-12-043641 + 043917).
//
//   2. The CLI's OWN config file (~/.browser-use-cli/config.json): an
//      explicitly owner-provided key (TUI /key <secret>). NOT claude-code,
//      NOT env — a deliberate per-machine store the owner controls, used when
//      the app's secrets store is unavailable.
//
//   3. Explicit env overrides (XKIRO_API_KEY, BROWSER_USE_API_KEY,
//      XKIRO_BASE_URL) — last, because an ambient/stale export is exactly what
//      shadowed the funded key and burned 402/429 runs (the drained-shell-key
//      defect).
//
//   4. Built-in defaults for model/baseUrl (documented constants, no store).
//
// CREDENTIAL SAFETY contract (the drained-shell-key defect): startRun passes
// the resolved key explicitly via --api-key and strips XKIRO_API_KEY /
// ANTHROPIC_AUTH_TOKEN / XKIRO_BASE_URL from the child env, so an ambient
// shell variable can never shadow the resolved key inside agent-cli (whose
// own priority is --api-key > XKIRO_API_KEY env > settings.json >
// ANTHROPIC_AUTH_TOKEN env — cli/agent-cli.mjs credential block). The key is
// never logged — only its source and last 4 characters.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const BUILTIN_DEFAULTS = Object.freeze({
  providerId: 'xkiro',
  // No built-in model. A phantom default silently overrode the model the user
  // picked, and every run then used a model their provider may not serve.
  model: '',
  baseUrl: 'https://api.xkiro.com/v1',
  models: Object.freeze([]),
  controlMode: 'browser'
});

/** The desktop app's userData directory (Electron app.getPath('userData')). */
export function appUserDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'browser-use');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'browser-use');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'browser-use');
}

export function appSettingsPath(userDataDir = appUserDataDir()) {
  return path.join(userDataDir, 'browser-use-settings.json');
}

export function appSecretsPath(userDataDir = appUserDataDir()) {
  return path.join(userDataDir, 'browser-use-secrets.json');
}

/** The CLI's OWN config file (owner-provided key storage — never claude-code, never env). */
export function cliConfigPath() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'browser-use-cli', 'config.json');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'browser-use-cli', 'config.json');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'browser-use-cli', 'config.json');
}

/** Read the CLI's own config file. Never throws; { available, path, config }. */
export function readCliConfig(filePath = cliConfigPath()) {
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { available: true, path: filePath, config: config && typeof config === 'object' ? config : {} };
  } catch {
    return { available: false, path: filePath, config: {} };
  }
}

/** Write the CLI's own config file (0600 on the file, recursive mkdir on the dir). */
export function writeCliConfig(config, filePath = cliConfigPath()) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, filePath);
  return { available: true, path: filePath, config };
}

/** Read the desktop app's settings store. Never throws. */
export function readAppSettings(filePath = appSettingsPath()) {
  try {
    const settings = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return { available: true, path: filePath, settings };
  } catch {
    return { available: false, path: filePath, settings: null };
  }
}

/**
 * The ACTIVE connection the app's UI would use (desktop/main.cjs
 * activeProviderConfig / normalizedConnections semantics): aiChatProvider
 * selects the family; aiChatConnectionId names the stored connection and its
 * provider must match. Returns null when the app store is absent or the
 * active selection points at nothing.
 */
export function activeConnection(settings) {
  if (!settings) return null;
  const provider = String(settings.aiChatProvider || '').trim();
  if (!provider || provider === 'ollama' || provider === 'cloud') return null;
  const id = String(settings.aiChatConnectionId || '').trim();
  const connections = Array.isArray(settings.aiConnections) ? settings.aiConnections : [];
  const connection = connections.find((entry) => String(entry?.id || '') === id) || null;
  if (!connection || String(connection.provider || '') !== provider) return null;
  return {
    id: String(connection.id),
    provider: String(connection.provider || 'ollama'),
    name: String(connection.name || ''),
    baseUrl: String(connection.baseUrl || ''),
    model: String(connection.model || ''),
    customModels: (Array.isArray(connection.customModels) ? connection.customModels : [])
      .map((entry) => (typeof entry === 'object' ? String(entry?.id || '') : String(entry || '')).trim())
      .filter(Boolean)
  };
}

// ----------------------------------------------------- secrets store ------
// The app's connection keys live in userData/browser-use-secrets.json as
// Electron safeStorage "v10" blobs (os_crypt_async AES-256-GCM; the AES key
// is DPAPI-wrapped in Local State). The pure-Node GCM reproduction does not
// verify headless (see module header), so decryption goes through the REAL
// decryptor — the repo's electron binary — via readAppSecrets below.

/** The credential key name the app itself uses (main.cjs connectionCredentialKey). */
export function connectionCredentialKey(connectionId) {
  return `aiProvider:${String(connectionId || '')}`;
}

/**
 * Locate the electron binary the repo ships (the app's decryptor binary).
 * Override with BROWSER_USE_ELECTRON. Returns null when absent.
 */
export function electronBinaryPath(explicit = process.env.BROWSER_USE_ELECTRON) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'electron', 'dist');
  const relative = process.platform === 'win32'
    ? ['electron.exe']
    : process.platform === 'darwin'
      ? ['Electron.app/Contents/MacOS/Electron']
      : ['electron'];
  for (const candidate of relative) {
    const full = path.join(dist, ...candidate.split('/'));
    if (fs.existsSync(full)) return full;
  }
  return null;
}

// The helper app staged into the temp dir. It decrypts EVERY entry in the
// copied secrets store via safeStorage.decryptString (the app's own call,
// store/credentialStore.cjs:35) and writes the result to $BU_DECRYPT_OUT —
// never to stdout — then exits.
const DECRYPT_HELPER_MAIN = `const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
app.whenReady().then(() => {
  const ud = app.getPath('userData');
  const out = { available: safeStorage.isEncryptionAvailable(), entries: {} };
  try {
    const sec = JSON.parse(fs.readFileSync(path.join(ud, 'browser-use-secrets.json'), 'utf8'));
    for (const [name, value] of Object.entries(sec)) {
      try {
        out.entries[name] = { ok: true, key: safeStorage.decryptString(Buffer.from(value, 'base64')) };
      } catch (error) {
        out.entries[name] = { ok: false, error: String((error && error.message) || error) };
      }
    }
  } catch (error) {
    out.error = String((error && error.message) || error);
  }
  try { fs.writeFileSync(process.env.BU_DECRYPT_OUT, JSON.stringify(out)); } catch (error) { out.error = String((error && error.message) || error); }
  app.exit(0);
});
`;

/**
 * Decrypt the app's secrets store with the REAL decryptor (the repo's electron
 * binary run against a temp userData holding COPIES of Local State + the
 * secrets file — the live app's userData is never opened or locked).
 *
 * Returns { status, key, path, connectionId, entries, detail? } with statuses:
 *   'no-secrets-file'        — the store does not exist / unreadable
 *   'no-entry'               — store exists, this connection has no key
 *   'electron-unavailable'   — no electron binary found (BROWSER_USE_ELECTRON?)
 *   'electron-decrypt-failed'— helper ran but the target entry did not decrypt
 *   'electron-timeout'       — helper did not exit within timeoutMs
 *   'decrypted'              — full success (key returned)
 *
 * The plaintext key exists only in this return value and the short-lived temp
 * result file, which is deleted before returning.
 */
export async function readAppSecrets({
  userDataDir = appUserDataDir(),
  connectionId = null,
  timeoutMs = 30_000,
  electronPath = null
} = {}) {
  const secretsPath = appSecretsPath(userDataDir);
  const result = { status: 'no-secrets-file', key: null, path: secretsPath, connectionId: connectionId || null, entries: {} };
  let entries;
  try {
    entries = JSON.parse(fs.readFileSync(secretsPath, 'utf8'));
  } catch {
    return result;
  }
  if (!entries || typeof entries !== 'object') return result;
  const targetKey = connectionCredentialKey(connectionId);
  if (!connectionId || !entries[targetKey]) {
    result.status = 'no-entry';
    return result;
  }

  const exe = electronPath || electronBinaryPath();
  if (!exe) {
    result.status = 'electron-unavailable';
    result.detail = 'no electron binary found — set BROWSER_USE_ELECTRON to the app dist binary';
    return result;
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-cli-decrypt-'));
  const outPath = path.join(stage, 'result.json');
  try {
    const stageUserData = path.join(stage, 'userData');
    fs.mkdirSync(stageUserData, { recursive: true });
    // COPIES only — the live app's store is never touched or locked.
    for (const name of ['Local State', 'browser-use-secrets.json']) {
      fs.copyFileSync(path.join(userDataDir, name), path.join(stageUserData, name));
    }
    fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'bu-cli-decrypt', version: '1.0.0', main: 'main.js' }));
    fs.writeFileSync(path.join(stage, 'main.js'), DECRYPT_HELPER_MAIN);

    await new Promise((resolve) => {
      // ARG ORDER FIX (proven 2026-11-05): electron.exe rejects Chromium
      // switches placed BEFORE the app path ("bad option: --user-data-dir",
      // exit 9). The app path comes first, then the switch — Chromium then
      // consumes it and the helper main runs.
      // ELECTRON_RUN_AS_NODE scrub: hosts that themselves run inside an
      // Electron app (e.g. WorkBuddy) export ELECTRON_RUN_AS_NODE=1, which
      // makes the helper electron.exe boot as plain Node — 'electron' module
      // unresolvable, safeStorage gone. The helper must always boot as a real
      // Electron app.
      const childEnv = { ...process.env, BU_DECRYPT_OUT: outPath };
      delete childEnv.ELECTRON_RUN_AS_NODE;
      const child = spawn(exe, [stage, `--user-data-dir=${stageUserData}`], {
        cwd: stage,
        env: childEnv,
        stdio: 'ignore',
        windowsHide: true
      });
      let settled = false;
      const done = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { result.status = 'electron-timeout'; try { child.kill(); } catch { /* gone */ } done(); }, timeoutMs);
      child.on('exit', done);
      child.on('error', done);
    });
    if (result.status === 'electron-timeout') return result;

    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(outPath, 'utf8')); } catch { /* helper never wrote */ }
    result.entries = payload?.entries || {};
    const target = result.entries[targetKey];
    if (target?.ok) {
      result.status = 'decrypted';
      result.key = String(target.key);
    } else if (payload) {
      result.status = 'electron-decrypt-failed';
      result.detail = String(target?.error || payload.error || 'safeStorage.decryptString failed');
    } else {
      result.status = 'electron-decrypt-failed';
      result.detail = 'decrypt helper produced no result file';
    }
    return result;
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Resolve the provider config in the browser-use-config-only order:
 * app stores > CLI config file > explicit env overrides > built-in defaults.
 * Pure (all inputs injectable) so tests can stage fixture stores. NEVER
 * returns a raw key to callers that would print it — callers mask.
 */
export function resolveProviderConfig({ appSettings = null, appSecrets = null, cliConfig = null, env = process.env } = {}) {
  const steps = [];
  const connection = activeConnection(appSettings);

  // Base URL: app connection > env override > builtin.
  let baseUrl = BUILTIN_DEFAULTS.baseUrl;
  let baseUrlSource = 'builtin default';
  if (env.XKIRO_BASE_URL) {
    baseUrl = `${String(env.XKIRO_BASE_URL).replace(/\/+$/, '')}/v1`;
    baseUrlSource = 'env XKIRO_BASE_URL';
    steps.push(`base url <- ${baseUrlSource}`);
  }
  if (connection?.baseUrl) {
    baseUrl = String(connection.baseUrl).replace(/\/+$/, '');
    baseUrlSource = `app-store connection "${connection.name || connection.id}"`;
    steps.push(`base url <- ${baseUrlSource}`);
  }
  // The owner's /auth-stored base URL is the CLI's explicit current intent —
  // it outranks the app connection and env for TUI-spawned runs.
  if (cliConfig?.baseUrl) {
    baseUrl = String(cliConfig.baseUrl).replace(/\/+$/, '');
    baseUrlSource = 'CLI config file (owner /auth)';
    steps.push(`base url <- ${baseUrlSource}`);
  }

  // API key: the app's secrets store first (per-connection key of the ACTIVE
  // connection — the exact credential the desktop app uses), then the CLI's
  // own config file (explicit owner-provided key), then the user's explicit
  // env exports. ~/.claude/settings.json is NOT consulted.
  let apiKey = appSecrets?.status === 'decrypted' ? String(appSecrets.key) : null;
  let apiKeySource = apiKey ? `app-store secrets (${connection?.name || connection?.id})` : null;
  if (apiKey) {
    steps.push('api key <- app-store secrets (ACTIVE connection key, same lookup as desktop/main.cjs activeProviderConfig)');
  } else if (cliConfig?.apiKey) {
    apiKey = String(cliConfig.apiKey);
    apiKeySource = 'CLI config file (~/.browser-use-cli/config.json, owner-provided)';
    steps.push('api key <- CLI config file (owner-provided key)');
  } else if (env.XKIRO_API_KEY) {
    apiKey = String(env.XKIRO_API_KEY);
    apiKeySource = 'env XKIRO_API_KEY';
    steps.push('api key <- env XKIRO_API_KEY (explicit export)');
  } else if (env.BROWSER_USE_API_KEY) {
    apiKey = String(env.BROWSER_USE_API_KEY);
    apiKeySource = 'env BROWSER_USE_API_KEY';
    steps.push('api key <- env BROWSER_USE_API_KEY (explicit export)');
  }

  // Model: app active connection > CLI config file > builtin.
  let model = BUILTIN_DEFAULTS.model;
  let modelSource = 'builtin default';
  if (connection?.model) {
    model = connection.model;
    modelSource = `app-store connection "${connection.name || connection.id}"`;
    steps.push(`model <- ${modelSource}`);
  }
  // The web interface and `browser-use gui` write the chosen model here. Without
  // this branch a provider onboarded in the browser never reached the terminal,
  // and every message ran against the built-in default model instead.
  if (cliConfig?.model) {
    model = String(cliConfig.model);
    modelSource = 'CLI config file (web interface or /model)';
    steps.push(`model <- ${modelSource}`);
  }

  // Provider id: the same config file carries the provider the user chose.
  let providerId = String(connection?.provider || cliConfig?.providerId || 'xkiro');
  if (cliConfig?.providerId && cliConfig.providerId !== connection?.provider) {
    steps.push('provider <- CLI config file');
  }

  // Control mode: app shared agent setting > builtin.
  const controlMode = ['browser', 'agi'].includes(String(appSettings?.agentControlMode || ''))
    ? String(appSettings.agentControlMode)
    : BUILTIN_DEFAULTS.controlMode;
  if (appSettings?.agentControlMode) steps.push(`control mode <- app-store agentControlMode (${controlMode})`);

  return { connection, providerId, apiKey, apiKeySource, baseUrl, baseUrlSource, model, modelSource, controlMode, resolution: steps };
}

/**
 * Child env for the agent-cli spawn: the shell's credential variables are
 * scrubbed so an ambient/stale key can NEVER shadow the explicitly-passed
 * --api-key inside agent-cli's own priority chain.
 */
export function scrubCredentialEnv(env = process.env) {
  const child = { ...env };
  delete child.XKIRO_API_KEY;
  delete child.ANTHROPIC_AUTH_TOKEN;
  delete child.XKIRO_BASE_URL;
  return child;
}

/** Mask a key for display: keep only its last 4 characters. */
export function maskKey(key) {
  const text = String(key || '');
  return text ? `····${text.slice(-4)}` : '(absent)';
}

/**
 * Merge the session model catalog: app connection customModels first (the
 * entries the app's own UI lists for this connection), then live /v1/models
 * discovery, then the built-in defaults. Deduped, order-stable.
 */
export function mergeModelCatalog({ connection = null, discovered = [], defaults = BUILTIN_DEFAULTS.models } = {}) {
  const out = [];
  const seen = new Set();
  const push = (id, source, pricing = null) => {
    const value = String(id || '').trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push({ id: value, source, pricing: pricing || null });
  };
  for (const id of (connection?.customModels || [])) push(id, 'app custom model');
  for (const entry of discovered) push(entry?.id ?? entry, 'gateway catalog', entry?.pricing ?? null);
  for (const id of defaults) push(id, 'builtin default');
  return out;
}

/**
 * Parse a gateway /v1/models payload (OpenAI shape: {data:[{id, pricing?}]},
 * or {models:[...]}). Returns [{ id, pricing }] — pricing kept only when the
 * gateway actually ships it (never invented).
 */
export function parseModelsPayload(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : [];
  const out = [];
  for (const entry of rows) {
    const id = String(entry?.id || entry?.name || entry?.model || '').trim();
    if (!id) continue;
    const pricing = entry?.pricing && typeof entry.pricing === 'object' ? entry.pricing : null;
    out.push(pricing ? { id, pricing } : { id, pricing: null });
  }
  return out;
}

/** Compact one-line pricing hint for picker options (empty when absent). */
export function pricingHint(pricing) {
  if (!pricing || typeof pricing !== 'object') return '';
  if (pricing.input != null || pricing.output != null) {
    return `in ${pricing.input ?? '?'} / out ${pricing.output ?? '?'}${pricing.unit ? ` ${pricing.unit}` : ''}`;
  }
  return Object.entries(pricing).map(([key, val]) => `${key}=${String(val)}`).join(' ');
}
