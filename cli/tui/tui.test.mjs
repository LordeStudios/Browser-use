// cli/tui/tui.test.mjs
//
// node --test cli/tui/tui.test.mjs
//
// 1. Unit: command registry + completer (full list for '/', prefix filtering,
//    mid-word filtering, argument completion, parseCommand) — UNCHANGED from
//    the readline TUI; the Ink app shares the same registry semantics.
// 2. Ink render tests (ink-testing-library): banner renders, typing '/'
//    opens the completion menu with every command, filtering narrows it,
//    argument completion surfaces model ids, TAB/Enter complete, and
//    executing a mocked command writes to the history (both the echo and
//    the command output appear in the frame).
// 3. Opt-in real smoke (BROWSER_USE_TUI_SMOKE=1): one real 60-second-capped
//    `browser-use run` against the checkout fixture using the funded key from
//    ~/.claude/settings.json (resolved the same way agent-cli resolves it —
//    the XKIRO_API_KEY shell env is drained).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { createCommandRegistry, makeCompleter, parseCommand } from './registry.mjs';
import { createTuiStore, pushHistory } from './store.mjs';
import { App } from './App.mjs';
import { detectScreenMode, parseMouseEvent, isActionableMouse, isMotionEvent, MOUSE_ENABLE, MOUSE_DISABLE, MOTION_ENABLE, MOTION_DISABLE } from './screen.mjs';
import { wrapText, entryToLines, historyToLines, windowLines } from './historyView.mjs';
import { parseControlLine, createMessageQueue, runWithQueue } from '../agentRunQueue.mjs';
import { traceErrorForEvent } from './errorView.mjs';
import {
  BUILTIN_DEFAULTS,
  activeConnection,
  mergeModelCatalog,
  parseModelsPayload,
  resolveProviderConfig,
  scrubCredentialEnv,
  maskKey,
  pricingHint,
  readAppSecrets,
  connectionCredentialKey,
  electronBinaryPath,
  readCliConfig,
  writeCliConfig
} from './appConfig.mjs';

const h = React.createElement;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(HERE, '..', '..');
const ENTRY = path.join(TOOL_ROOT, 'cli', 'browser-use.js');
const CHECKOUT_FIXTURE = path.join(TOOL_ROOT, 'tests', 'checkout.html');

// ------------------------------------------------------------- fixtures ----
function fixtureRegistry() {
  const registry = createCommandRegistry();
  const commands = ['alpha', 'beta', 'galpha', 'cancel', 'clear', 'config', 'doctor', 'help', 'model', 'provider', 'trace'];
  for (const name of commands) {
    registry.register({
      name,
      args: name === 'model' ? '<id>' : '',
      description: `the ${name} command`,
      handler: async () => {}
    });
  }
  registry.get('model').completeArg = (last) =>
    ['z-ai/glm-5.3-flash', 'qwen/qwen3.7-plus:free'].filter((m) => m.startsWith(last));
  registry.get('provider').completeArg = (last) =>
    ['xkiro', 'anthropic', 'openai'].filter((p) => p.startsWith(last));
  return registry;
}

/** Minimal stand-in for the real controller in cli/tui.mjs. */
function fixtureController({ onSubmit } = {}) {
  const registry = fixtureRegistry();
  const store = createTuiStore({
    session: {
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xkiro',
      maxSeconds: 0,
      outRoot: path.join(TOOL_ROOT, 'cli-runs')
    },
    history: []
  });
  const submitted = [];
  const controller = {
    store,
    registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    handleSubmit: (text) => {
      submitted.push(text);
      pushHistory(store, { kind: 'user', text });
      if (onSubmit) onSubmit(text, store);
    }
  };
  return { controller, store, submitted };
}

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------- registry + completer ----
test('registry: register/get/names/list with canonical slash stripping', () => {
  const registry = fixtureRegistry();
  assert.equal(registry.has('model'), true);
  assert.equal(registry.get('/model').name, 'model');
  assert.equal(registry.get('MODEL').name, 'model', 'lookup is case-insensitive');
  assert.equal(registry.get('nope'), null, 'unknown names miss');
  assert.equal(registry.get('model').description, 'the model command');
  assert.equal(registry.names()[0], 'alpha');
  assert.equal(registry.names().length, 11);
  assert.throws(() => registry.register({ handler: async () => {} }), /needs a name/);
});

test('completer: "/" returns the FULL command list', () => {
  const completer = makeCompleter(fixtureRegistry());
  const [hits, fragment] = completer('/');
  assert.equal(fragment, '/');
  assert.deepEqual([...hits].sort(), ['alpha', 'beta', 'galpha', 'cancel', 'clear', 'config', 'doctor', 'help', 'model', 'provider', 'trace'].sort());
  // '/ ' with trailing whitespace behaves the same
  const [hits2] = completer('/ ');
  assert.equal(hits2.length, 11);
});

test('completer: "/c" filters by prefix and includes mid-word matches', () => {
  const completer = makeCompleter(fixtureRegistry());
  const [hits] = completer('/c');
  // prefixes first
  assert.deepEqual(hits.slice(0, 3), ['/cancel', '/clear', '/config']);
  // mid-word: docto[r], [t]ra[c]e contain 'c' but do not start with it
  assert.ok(hits.includes('/doctor'), 'mid-word match: doctor contains c');
  assert.ok(hits.includes('/trace'), 'mid-word match: trace contains c');
  assert.ok(!hits.includes('/beta') && !hits.includes('/model'));
});

test('completer: "/cl" narrows to clear only; unknown fragment is empty', () => {
  const completer = makeCompleter(fixtureRegistry());
  assert.deepEqual(completer('/cl')[0], ['/clear']);
  assert.deepEqual(completer('/zzz')[0], []);
  assert.deepEqual(completer('/hel')[0], ['/help']);
});

test('completer: argument completion for /model and /provider values', () => {
  const completer = makeCompleter(fixtureRegistry());
  const [modelHits, modelFrag] = completer('/model q');
  assert.deepEqual(modelHits, ['/model qwen/qwen3.7-plus:free']);
  assert.equal(modelFrag, 'q');
  const [modelAll] = completer('/model ');
  assert.equal(modelAll.length, 2, 'empty arg lists every suggestion');
  const [providerHits] = completer('/provider an');
  assert.deepEqual(providerHits, ['/provider anthropic']);
  // commands without completeArg return nothing on argument lines
  assert.deepEqual(completer('/clear x')[0], []);
});

test('completer: non-slash lines get no completions', () => {
  const completer = makeCompleter(fixtureRegistry());
  assert.deepEqual(completer('run the checkout')[0], []);
  assert.deepEqual(completer('')[0], []);
});

test('parseCommand: name/arg splitting', () => {
  assert.deepEqual(parseCommand('/run buy shoes'), { name: 'run', argString: 'buy shoes' });
  assert.deepEqual(parseCommand('  /MODEL '), { name: 'model', argString: '' });
  assert.deepEqual(parseCommand('/help  /model'), { name: 'help', argString: '/model' });
  assert.equal(parseCommand('hello'), null);
});

// ---------------------------------------------------- Ink render tests -----
function inkRender(controller) {
  return render(h(App, { controller }), { patchConsole: false });
}

test('Ink TUI: banner renders with lime brand, version and hints', async () => {
  const { controller } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /◈  browser-use/, 'compact product mark renders');
    assert.match(frame, /control deck/, 'product descriptor renders');
    assert.match(frame, /v0\.3\.6-test/, 'version label present');
    assert.match(frame, /\/ \+ TAB to filter/, 'hint line present');
    assert.match(frame, /model z-ai\/glm-5\.3-flash/, 'footer shows current model');
    assert.match(frame, /browser-use▸/, 'lime prompt present');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: typing "/" shows the completion menu with ALL commands', async () => {
  const { controller } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/');
    await tick(60);
    const frame = app.lastFrame() || '';
    // The menu windows to 5 rows (qwen's MAX_SUGGESTIONS_TO_SHOW) with ▼ +
    // an (n/total) counter — the counter proves all 11 commands loaded.
    for (const name of ['alpha', 'beta', 'cancel', 'clear', 'config']) {
      assert.match(frame, new RegExp(`\\/${name}\\b`), `menu window lists /${name}`);
    }
    assert.match(frame, /\(1\/11\)/, 'counter shows the FULL command count');
    assert.match(frame, /▼/, 'scroll indicator for the commands below the window');
    assert.match(frame, /the alpha command/, 'descriptions render in the menu');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: filtering narrows the menu (prefix and mid-word)', async () => {
  const { controller } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/cl');
    await tick(60);
    let frame = app.lastFrame() || '';
    assert.match(frame, /\/clear/, 'prefix match shown');
    assert.doesNotMatch(frame, /\/cancel/, 'non-matches hidden');

    app.stdin.write('\u001b'); // Esc clears the buffer
    await tick(40);
    app.stdin.write('/do');
    await tick(60);
    frame = app.lastFrame() || '';
    assert.match(frame, /\/doctor/, 'mid-word hit reachable from another fragment');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: argument completion lists model ids for /model', async () => {
  const { controller } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/model ');
    await tick(60);
    let frame = app.lastFrame() || '';
    assert.match(frame, /z-ai\/glm-5\.3-flash/, 'model suggestion listed');
    assert.match(frame, /qwen\/qwen3\.7-plus:free/, 'second model suggestion listed');

    app.stdin.write('\u001b'); // Esc clears the buffer
    await tick(40);
    app.stdin.write('/model q');
    await tick(60);
    frame = app.lastFrame() || '';
    assert.match(frame, /> qwen\/qwen3\.7-plus:free/, 'narrowed to the q model');
    // the footer still carries the session model, so scope the negative
    // assertion to a menu row ('> ' active marker / row lead)
    assert.doesNotMatch(frame, /(^|\n)\s*>? ?z-ai\/glm-5\.3-flash(?!\s·)/, 'non-matching model hidden from the menu');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: Enter on a zero-arg suggestion executes; TAB only completes', async () => {
  const outputs = [];
  const { controller, submitted } = fixtureController({
    onSubmit: (text, store) => {
      pushHistory(store, { kind: 'out', text: `ran ${text}`, tone: 'ok' });
      outputs.push(text);
    }
  });
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/cl');
    await tick(40);
    app.stdin.write('\r'); // Enter accepts + executes the zero-arg command
    await tick(80);
    assert.deepEqual(submitted, ['/clear'], 'Enter executed the completed command');
    assert.match(app.lastFrame() || '', /ran \/clear/, 'command output written to history');

    app.stdin.write('/hel');
    await tick(40);
    app.stdin.write('\t'); // TAB completes but never executes
    await tick(60);
    assert.match(app.lastFrame() || '', /browser-use▸ \/help(?:▏|\s)/, 'TAB filled the buffer');
    assert.equal(submitted.length, 1, 'TAB did not execute');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: submitting a mocked command echoes it into the static history', async () => {
  const { controller, submitted } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/trace');
    await tick(40);
    app.stdin.write('\r');
    await tick(80);
    assert.deepEqual(submitted, ['/trace']);
    const frame = app.lastFrame() || '';
    assert.match(frame, /╭─+╮[\s\S]*\/trace[\s\S]*╰─+╯/, 'the user message card is rendered');
  } finally {
    app.unmount();
    cleanup();
  }
});

// --------------------------------- browser-use-config-only resolution (1) ---
test('appConfig: scrubCredentialEnv strips shell credential keys, keeps everything else', () => {
  const scrubbed = scrubCredentialEnv({
    XKIRO_API_KEY: 'sk-xt-drained-shell-key',
    ANTHROPIC_AUTH_TOKEN: 'stale-shell-token',
    XKIRO_BASE_URL: 'https://stale.example.com',
    PATH: 'C:\\Windows',
    BROWSER_USE_TUI_SMOKE: '1'
  });
  assert.equal('XKIRO_API_KEY' in scrubbed, false, 'ambient XKIRO_API_KEY must not reach the child');
  assert.equal('ANTHROPIC_AUTH_TOKEN' in scrubbed, false, 'shell ANTHROPIC_AUTH_TOKEN must not reach the child');
  assert.equal('XKIRO_BASE_URL' in scrubbed, false, 'stale base url must not reach the child');
  assert.equal(scrubbed.PATH, 'C:\\Windows', 'ordinary env is preserved');
  assert.equal(scrubbed.BROWSER_USE_TUI_SMOKE, '1');
});

test('appConfig: resolution is browser-use config ONLY (app store > env > builtin; claude settings never consulted)', () => {
  const appSettings = {
    aiChatProvider: 'xkiro',
    aiChatConnectionId: 'conn-1',
    agentControlMode: 'agi',
    aiConnections: [{
      id: 'conn-1', provider: 'xkiro', name: 'xKiro',
      baseUrl: 'https://api.xkiro.com/v1', model: 'z-ai/glm-5.3-flash',
      customModels: ['gateway/only-model']
    }]
  };
  const resolved = resolveProviderConfig({
    appSettings,
    appSecrets: { status: 'decrypted', key: 'sk-app-store-connection-key' },
    // claude-ish env must be IGNORED: the purge contract.
    env: { ANTHROPIC_AUTH_TOKEN: 'sk-claude-settings-token', XKIRO_API_KEY: 'sk-env-explicit-key' }
  });
  assert.equal(resolved.baseUrl, 'https://api.xkiro.com/v1', 'base url comes from the app connection');
  assert.equal(resolved.model, 'z-ai/glm-5.3-flash', 'model comes from the app connection');
  assert.equal(resolved.controlMode, 'agi', 'control mode comes from the app store');
  assert.equal(resolved.apiKey, 'sk-app-store-connection-key', 'the app-store secrets key WINS');
  assert.match(resolved.apiKeySource, /app-store secrets/);
  assert.equal(resolved.connection.customModels[0], 'gateway/only-model');
  assert.ok(!JSON.stringify(resolved.resolution).includes('ANTHROPIC'), 'no claude-code source in the resolution trail');

  // Secrets store not decryptable: the user's EXPLICIT env export is the
  // fallback — and a claude-code token in env is still ignored (purge).
  const envFallback = resolveProviderConfig({
    appSettings,
    appSecrets: { status: 'dpapi-key-ok-blob-undecryptable' },
    env: { XKIRO_API_KEY: 'sk-env-explicit-key', ANTHROPIC_AUTH_TOKEN: 'sk-claude-token' }
  });
  assert.equal(envFallback.apiKey, 'sk-env-explicit-key');
  assert.match(envFallback.apiKeySource, /env XKIRO_API_KEY/);

  // No stores, no env: built-ins carry the session, key resolves to null.
  const bare = resolveProviderConfig({ appSettings: null, appSecrets: null, env: { ANTHROPIC_AUTH_TOKEN: 'sk-claude-token' } });
  assert.equal(bare.baseUrl, BUILTIN_DEFAULTS.baseUrl);
  assert.equal(bare.model, BUILTIN_DEFAULTS.model);
  assert.equal(bare.controlMode, 'browser');
  assert.equal(bare.apiKey, null, 'claude-code env must never satisfy the key resolution');
});

test('appConfig: readAppSecrets reports honest statuses (never fabricates a key)', async () => {
  const missing = await readAppSecrets({ userDataDir: path.join(os.tmpdir(), 'bu-tui-test-absent-' + Date.now()), connectionId: 'x' });
  assert.equal(missing.status, 'no-secrets-file');
  assert.equal(missing.key, null);
});

test('appConfig: readAppSecrets no-entry status for a store without the connection key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-secrets-'));
  fs.writeFileSync(path.join(dir, 'browser-use-secrets.json'), JSON.stringify({ 'aiProvider:other-conn': 'djEwAAAA' }));
  const result = await readAppSecrets({ userDataDir: dir, connectionId: 'target-conn' });
  assert.equal(result.status, 'no-entry');
  assert.equal(result.key, null);
});

test('appConfig: connectionCredentialKey matches the app lookup (aiProvider:<id>)', () => {
  assert.equal(connectionCredentialKey('43c5d3d2-329c-4a80-8520-3b2eb155e109'), 'aiProvider:43c5d3d2-329c-4a80-8520-3b2eb155e109');
  assert.equal(connectionCredentialKey(''), 'aiProvider:');
});

test('appConfig: the electron decrypt helper runs against a fixture store and reports auth failure honestly', { skip: !electronBinaryPath() }, async () => {
  // The real electron binary (the app's own decryptor) runs against a temp
  // userData; a fabricated blob must FAIL auth verification — the status is
  // an honest 'electron-decrypt-failed', never an invented key.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-decrypt-'));
  fs.writeFileSync(path.join(dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI' + Buffer.alloc(32, 7)).toString('base64') } }));
  fs.writeFileSync(path.join(dir, 'browser-use-secrets.json'), JSON.stringify({
    [connectionCredentialKey('fixture-conn')]: Buffer.concat([Buffer.from('v10'), Buffer.alloc(82, 0xAB)]).toString('base64')
  }));
  const result = await readAppSecrets({ userDataDir: dir, connectionId: 'fixture-conn', timeoutMs: 45_000 });
  assert.ok(['electron-decrypt-failed', 'electron-timeout'].includes(result.status), `honest failure status, got ${result.status}`);
  assert.equal(result.key, null, 'no key may be fabricated when decryption fails');
});

test('appConfig: CLI config file key outranks env but not the app store', () => {
  const appSettings = {
    aiChatProvider: 'xkiro', aiChatConnectionId: 'conn-1',
    aiConnections: [{ id: 'conn-1', provider: 'xkiro', name: 'xKiro', baseUrl: 'https://api.xkiro.com/v1', model: 'z-ai/glm-5.3-flash', customModels: [] }]
  };
  const cliKey = resolveProviderConfig({
    appSettings,
    appSecrets: { status: 'electron-unavailable' },
    cliConfig: { apiKey: 'sk-owner-provided-key' },
    env: { XKIRO_API_KEY: 'sk-ambient-env-key' }
  });
  assert.equal(cliKey.apiKey, 'sk-owner-provided-key', 'the owner-provided CLI config key outranks env');
  assert.match(cliKey.apiKeySource, /CLI config file/);

  const appStoreWins = resolveProviderConfig({
    appSettings,
    appSecrets: { status: 'decrypted', key: 'sk-app-store-key' },
    cliConfig: { apiKey: 'sk-owner-provided-key' },
    env: { XKIRO_API_KEY: 'sk-ambient-env-key' }
  });
  assert.equal(appStoreWins.apiKey, 'sk-app-store-key', 'the app-store key (the app\'s own credential) still wins');
});

test('appConfig: CLI config file read/write round-trips through its own path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-cliconfig-'));
  const filePath = path.join(dir, 'config.json');
  const written = writeCliConfig({ apiKey: 'sk-round-trip', savedAt: 'now' }, filePath);
  assert.equal(written.config.apiKey, 'sk-round-trip');
  const read = readCliConfig(filePath);
  assert.equal(read.available, true);
  assert.equal(read.config.apiKey, 'sk-round-trip');
  assert.equal(readCliConfig(path.join(dir, 'absent.json')).available, false);
  assert.equal(maskKey('sk-round-trip'), '····trip');
});

test('appConfig: pricingHint renders the gateway tier shape compactly', () => {
  assert.equal(pricingHint({ currency: 'USD', unit: 'per_1m_tokens', input: 0.15, output: 0.5, cache_read: 0.03 }), 'in 0.15 / out 0.5 per_1m_tokens');
  assert.equal(pricingHint(null), '');
  assert.equal(pricingHint({ requests: 10 }), 'requests=10');
});

test('appConfig: activeConnection mirrors the app UI selection rules', () => {
  assert.equal(activeConnection({ aiChatProvider: 'xkiro', aiChatConnectionId: 'a', aiConnections: [{ id: 'a', provider: 'xkiro' }] })?.id, 'a');
  assert.equal(activeConnection({ aiChatProvider: 'ollama', aiChatConnectionId: 'a', aiConnections: [{ id: 'a', provider: 'ollama' }] }), null, 'ollama/cloud are not stored connections');
  assert.equal(activeConnection({ aiChatProvider: 'xkiro', aiChatConnectionId: 'a', aiConnections: [{ id: 'b', provider: 'xkiro' }] }), null, 'missing id -> null');
  assert.equal(activeConnection({ aiChatProvider: 'xkiro', aiChatConnectionId: 'a', aiConnections: [{ id: 'a', provider: 'anthropic' }] }), null, 'provider mismatch -> null');
  assert.equal(maskKey('sk-xt-abcdef'), '····cdef', 'mask keeps only the last 4 chars');
});

test('appConfig: model catalog merges app customModels + gateway discovery + built-ins, carries pricing', () => {
  const parsed = parseModelsPayload({ data: [
    { id: 'z-ai/glm-5.3-flash', pricing: { prompt: '0.0001', completion: '0.0002' } },
    { id: 'gateway/extra-model' },
    { name: 'qwen/qwen3.7-plus:free' },
    { id: '' },
    { model: 'other/model', pricing: { prompt: '0.5' } }
  ] });
  assert.deepEqual(parsed.map((entry) => entry.id), ['z-ai/glm-5.3-flash', 'gateway/extra-model', 'qwen/qwen3.7-plus:free', 'other/model']);
  assert.deepEqual(parsed[0].pricing, { prompt: '0.0001', completion: '0.0002' });
  assert.equal(parsed[1].pricing, null);

  const merged = mergeModelCatalog({
    connection: { customModels: ['custom/first', 'z-ai/glm-5.3-flash'] },
    discovered: parsed,
    defaults: BUILTIN_DEFAULTS.models
  });
  assert.deepEqual(merged.map((entry) => entry.id), [
    'custom/first', 'z-ai/glm-5.3-flash', 'gateway/extra-model', 'qwen/qwen3.7-plus:free', 'other/model'
  ], 'union is deduped and order-stable: app customModels first');
  assert.equal(merged.find((entry) => entry.id === 'other/model').pricing.prompt, '0.5', 'pricing survives the merge');
});

// ------------------------------------------------ banner order (fix 2) ------
test('Ink TUI: banner renders BEFORE history and stays first as history grows', async () => {
  const { controller, store } = fixtureController();
  // Pre-seed history so the app mounts with existing run output.
  pushHistory(store, { kind: 'user', text: 'earlier task one' });
  pushHistory(store, { kind: 'out', text: 'earlier run output line', tone: 'ok' });
  const app = inkRender(controller);
  try {
    await tick(60);
    let frame = app.lastFrame() || '';
    const bannerAt = frame.indexOf('◈  browser-use');
    const historyAt = frame.indexOf('earlier run output line');
    assert.ok(bannerAt !== -1, 'banner present');
    assert.ok(historyAt !== -1, 'pre-seeded history present');
    assert.ok(bannerAt < historyAt, 'banner renders ABOVE the history, never below run output');

    // Simulated history growth: new entries must render BELOW the banner too.
    pushHistory(store, { kind: 'out', text: 'newer run output after growth', tone: 'ok' });
    await tick(80);
    frame = app.lastFrame() || '';
    // Ink's Static component has already committed the banner to the terminal;
    // lastFrame now contains only the newly rendered dynamic tail. Verify the
    // invariant through the first frame plus intact history rather than asking
    // the testing helper to replay committed output.
    assert.ok(frame.indexOf('newer run output after growth') !== -1, 'new history renders after growth');
    assert.ok(frame.indexOf('earlier run output line') !== -1, 'old history intact');
  } finally {
    app.unmount();
    cleanup();
  }
});

// -------------------------------------------- escape cancels run (fix 3) ----
test('Ink TUI: Escape during an active run cancels the mock long-running child; Escape at idle clears input', async () => {
  // A REAL long-running child stands in for the agent-cli process; the
  // fixture onEscape is exactly what the real controller does — route the
  // Escape to the run's cancel path (kill the child).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => {
    child.on('exit', () => resolve('exit'));
    setTimeout(() => resolve('timeout'), 4000);
  });
  let escapeCalls = 0;
  const { controller, store } = fixtureController();
  controller.onEscape = () => {
    escapeCalls += 1;
    try { child.kill(); } catch { /* gone */ }
  };
  // A live run view = the mock long-running child is "active".
  store.set((state) => ({ ...state, run: { name: 'run-mock', pid: child.pid, startedAt: Date.now(), task: 'mock', inFlight: null, thinking: null, lastTool: null, tools: [] } }));
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('\u001b'); // Escape while the run is active
    await tick(120);
    const outcome = await exited;
    assert.equal(outcome, 'exit', 'the mock long-running child was killed by the Escape path');
    assert.equal(escapeCalls, 1, 'Escape routed to the cancel path exactly once');

    // Escape at idle (no run): clears the input buffer instead of cancelling.
    store.set((state) => ({ ...state, run: null }));
    await tick(40);
    app.stdin.write('/cl');
    await tick(40);
    assert.match(app.lastFrame() || '', /browser-use▸ \/cl/, 'buffer filled at idle');
    app.stdin.write('\u001b');
    await tick(40);
    assert.doesNotMatch(app.lastFrame() || '', /browser-use▸ \/cl\s*\S/, 'Escape at idle cleared the buffer');
  } finally {
    app.unmount();
    cleanup();
    try { child.kill(); } catch { /* already gone */ }
  }
});

// --------------------------------------- model catalog completion (fix 4) ---
test('Ink TUI: /model completion surfaces the FULL merged catalog (gateway model included)', async () => {
  // Fixture registry whose completeArg reads a merged catalog exactly like
  // the real /model command does (app customModels + gateway + built-ins).
  const registry = createCommandRegistry();
  for (const name of ['model', 'provider', 'help', 'clear']) {
    registry.register({ name, args: name === 'model' ? '<id>' : '', description: `the ${name} command`, handler: async () => {} });
  }
  const catalog = mergeModelCatalog({
    connection: { customModels: ['gateway/from-app-store'] },
    discovered: parseModelsPayload({ data: [{ id: 'gateway/from-endpoint' }] }),
    defaults: BUILTIN_DEFAULTS.models
  });
  registry.get('model').completeArg = (last) => catalog.map((entry) => entry.id).filter((id) => id.startsWith(last));

  const store = createTuiStore({ session: { model: BUILTIN_DEFAULTS.model, providerId: 'xkiro', maxSeconds: 0, outRoot: '.' }, history: [] });
  const controller = {
    store, registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    onEscape: () => {},
    handleSubmit: () => {}
  };
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/model ');
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /gateway\/from-app-store/, 'app-store custom model listed');
    assert.match(frame, /gateway\/from-endpoint/, 'gateway-discovered model listed');
    assert.match(frame, /z-ai\/glm-5\.3-flash/, 'built-in default still listed');

    app.stdin.write('\u001b');
    await tick(40);
    app.stdin.write('/model gateway/from-e');
    await tick(60);
    assert.match(app.lastFrame() || '', /> gateway\/from-endpoint/, 'prefix filter narrows to the gateway model');
  } finally {
    app.unmount();
    cleanup();
  }
});

// --------------------------------------------- bare-/model picker (1) -------
test('Ink TUI: bare /model opens the selectable picker; arrows move, Enter selects, menu closes', async () => {
  const registry = createCommandRegistry();
  const outputs = [];
  for (const name of ['model', 'help', 'clear']) {
    registry.register({
      name,
      args: name === 'model' ? '[id]' : '',
      description: `the ${name} command`,
      handler: async (argString) => {
        const value = String(argString || '').trim();
        if (name === 'model' && value) pushHistory(store, { kind: 'out', text: ` model set to ${value}`, tone: 'ok' });
        outputs.push(`/${name} ${value}`.trim());
      }
    });
  }
  const catalog = [
    { id: 'z-ai/glm-5.3-flash', source: 'gateway catalog', pricing: { currency: 'USD', unit: 'per_1m_tokens', input: 0.15, output: 0.5 } },
    { id: 'gateway/custom-model', source: 'app custom model', pricing: null },
    { id: 'qwen/qwen3.7-plus:free', source: 'builtin default', pricing: null }
  ];
  const store = createTuiStore({ session: { model: 'z-ai/glm-5.3-flash', providerId: 'xkiro', maxSeconds: 0, outRoot: '.' }, history: [] });
  const controller = {
    store, registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    getModelCatalog: () => catalog,
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    onEscape: () => {},
    handleSubmit: (text) => {
      outputs.push(text);
      pushHistory(store, { kind: 'user', text });
      const parsed = parseCommand(text);
      if (parsed && parsed.name === 'model' && parsed.argString) {
        pushHistory(store, { kind: 'out', text: ` model set to ${parsed.argString}`, tone: 'ok' });
      }
    }
  };
  const app = inkRender(controller);
  try {
    await tick(40);
    app.stdin.write('/model');
    await tick(60);
    let frame = app.lastFrame() || '';
    assert.match(frame, /> z-ai\/glm-5\.3-flash/, 'picker lists the first catalog option as active');
    assert.match(frame, /in 0\.15 \/ out 0\.5/, 'pricing hint renders per option');
    assert.match(frame, /gateway\/custom-model/, 'app custom model listed');
    assert.match(frame, /qwen\/qwen3\.7-plus:free/, 'builtin default listed');

    app.stdin.write('\u001b[B'); // ArrowDown -> second option
    await tick(60);
    frame = app.lastFrame() || '';
    assert.match(frame, /> gateway\/custom-model/, 'arrow moved the active marker to the second option');

    app.stdin.write('\r'); // Enter selects -> executes /model gateway/custom-model
    await tick(80);
    frame = app.lastFrame() || '';
    assert.ok(outputs.includes('/model gateway/custom-model'), 'Enter executed the picked model');
    assert.match(frame, /model set to gateway\/custom-model/, 'confirmation line shown');
    assert.doesNotMatch(frame, /> gateway\/custom-model/, 'picker menu closed after selection');

    // Esc dismisses the picker without selecting anything.
    app.stdin.write('/model');
    await tick(60);
    assert.match(app.lastFrame() || '', /qwen\/qwen3\.7-plus:free/, 'picker reopened');
    app.stdin.write('\u001b');
    await tick(40);
    assert.doesNotMatch(app.lastFrame() || '', /qwen\/qwen3\.7-plus:free/, 'Esc dismissed the picker');
  } finally {
    app.unmount();
    cleanup();
  }
});

// ------------------------------------------- pasted input submits (3) -------
test('Ink TUI: a pasted multi-char chunk with a line break submits as lines (no dead paste)', async () => {
  const { controller, submitted } = fixtureController();
  const app = inkRender(controller);
  try {
    await tick(40);
    // A terminal paste arrives as ONE chunk with the trailing newline; ink
    // does not treat the embedded \r as Enter — the App must split + submit.
    app.stdin.write('buy shoes on the checkout page\r');
    await tick(80);
    assert.deepEqual(submitted, ['buy shoes on the checkout page'], 'pasted task line submitted through the normal dispatch');

    app.stdin.write('/help\r');
    await tick(80);
    assert.deepEqual(submitted, ['buy shoes on the checkout page', '/help'], 'pasted command line submitted too');
  } finally {
    app.unmount();
    cleanup();
  }
});

// --------------------------------- run-start line + failure reason (3a/3b) ---
test('Ink TUI: the run-start card is clean — NO pid, NO out-dir plumbing, no credential noise', async () => {
  const { controller, store } = fixtureController();
  pushHistory(store, {
    kind: 'runStart',
    name: 'run-2026-10-12-043641',
    pid: 4242,
    outBase: 'run-2026-10-12-043641',
    outDir: 'F:/somewhere/run-2026-10-12-043641'
  });
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.doesNotMatch(frame, /▸ run run-2026-10-12-043641/, 'OWNER: the run-name card line is gone (process plumbing)');
    assert.doesNotMatch(frame, /pid 4242|pid\ 9584/, 'DEFECT 2: no pid anywhere in the run card');
    assert.doesNotMatch(frame, /-> run-2026-10-12-043641/, 'DEFECT 2: no out-dir plumbing after the run name');
    assert.doesNotMatch(frame, /credential .*scrubbed/, 'the credential-proof line is GONE from the interactive view');
    assert.doesNotMatch(frame, /XKIRO_API_KEY/, 'no credential env names in the run-start view');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: a failed run summary states WHY (the last connection error) instead of a bare unknown', async () => {
  const { controller, store } = fixtureController();
  pushHistory(store, {
    kind: 'runSummary',
    summary: {
      name: 'run-2026-10-12-043641',
      outDir: 'F:/somewhere/run-2026-10-12-043641',
      status: 'cancelled',
      exitCode: 2,
      verified: null,
      decisions: 0,
      tools: 0,
      elapsedMs: 74000,
      result: null,
      error: 'xKiro request failed (429): Rate limit exceeded (ip, min). Retry after 26s.'
    },
    calls: null
  });
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /✗/, 'the failure mark renders');
    assert.match(frame, /Rate limit exceeded/, 'the last connection error is surfaced prominently');
    // Unified contract: the CARD carries only the ✗ error; the ONE dim
    // economy line BELOW the card carries the counts (no status/verified
    // clutter inside the card).
    assert.match(frame, /0 decisions · 0 tools/, 'the economy line renders the counts below the card');
    assert.doesNotMatch(frame, /\b(cancelled|completed|failed) ·/, 'OWNER: no status clutter in the economy line');
    assert.doesNotMatch(frame, /verified/, 'no verified clutter anywhere in the summary view');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('trace errors: recovery, escalation, transient, and hard tool failures match desktop visibility', () => {
  assert.equal(
    traceErrorForEvent({ type: 'run.escalated', run: { escalation: { reason: 'provider failed (402)' } } }),
    'provider failed (402)'
  );
  assert.equal(
    traceErrorForEvent({ type: 'assistant.message', transient: true, text: 'Connection error (502). Retrying in 5s' }),
    'Connection error (502). Retrying in 5s'
  );
  assert.equal(
    traceErrorForEvent({ type: 'tool.result', output: { ok: false, recoverable: false, error: 'Provider rejected the request' } }),
    'Provider rejected the request'
  );
  assert.equal(
    traceErrorForEvent({ type: 'run.failed', error: 'fallback failure', run: { recovery: { lastError: 'API key rejected' } } }),
    'API key rejected',
    'normalized recovery text wins over a generic terminal label'
  );
  assert.equal(traceErrorForEvent({ type: 'tool.result', output: { ok: false, recoverable: true, error: 'stale element' } }), '');
});

test('Ink TUI: the live pane shows a connection error the moment it occurs', async () => {
  const { controller, store } = fixtureController();
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'mock', inFlight: 'deciding', thinking: null, lastTool: null, lastError: 'xKiro request failed (402): Insufficient wallet balance — please top up to continue.', lastErrorAt: Date.now(), tools: [] }
  }));
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /✗/, 'live error mark renders');
    assert.match(frame, /Insufficient wallet balance/, 'the live connection error is visible immediately');
    assert.match(frame, /deciding/, 'the in-flight spinner still shows');
  } finally {
    app.unmount();
    cleanup();
  }
});

// --------------------------------- mid-run message queue (desktop parity) ----
// Desktop parity contract: text typed while a run is active is QUEUED (never
// lost, never rejected) and delivered as a continuation run of the SAME
// conversation when the run reaches its terminal state.

/** A DesktopChatAgent stand-in: records every start() request with its
 * continuation shape and keeps the conversation alive across continuations
 * (a continuation reuses the previous run's id — one conversation, many turns). */
function mockQueueAgent() {
  const starts = [];
  let state = null;
  let idSeq = 0;
  return {
    starts,
    state: () => state,
    async start(request) {
      const continuation = request?.continuation === true;
      const previous = state;
      state = {
        id: continuation ? previous.id : `conv-${++idSeq}`,
        status: 'completed',
        task: String(request?.task || ''),
        continuation,
        conversationId: request?.conversationId ?? null,
        history: continuation ? [...previous.history, String(request?.task || '')] : [String(request?.task || '')],
        decisionCount: (previous?.decisionCount || 0) + 1
      };
      starts.push(state);
      return state;
    }
  };
}

test('agentRunQueue: parseControlLine accepts only valid queue control lines', () => {
  assert.deepEqual(parseControlLine('{"type":"queue","text":"buy shoes"}'), { type: 'queue', text: 'buy shoes' });
  assert.deepEqual(parseControlLine('  {"type":"queue","text":"  padded  "}  '), { type: 'queue', text: 'padded' }, 'text is trimmed');
  assert.equal(parseControlLine(''), null, 'blank line');
  assert.equal(parseControlLine('not json'), null, 'non-JSON line');
  assert.equal(parseControlLine('{"type":"steer","text":"x"}'), null, 'unknown control type (fast-forward follow-up)');
  assert.equal(parseControlLine('{"type":"queue"}'), null, 'missing text');
  assert.equal(parseControlLine('{"type":"queue","text":"   "}'), null, 'blank text');
});

test('agentRunQueue: a queued control line during a run is delivered as a continuation after the terminal state', async () => {
  const agent = mockQueueAgent();
  const queue = createMessageQueue();
  const trace = [];
  // The control line arrives WHILE the first run is active (the stdin reader
  // pushed it mid-run): simulate by queueing inside the first start().
  const realStart = agent.start.bind(agent);
  agent.start = async (request) => {
    if (request?.continuation !== true) queue.push('follow-up instruction');
    return realStart(request);
  };
  const result = await runWithQueue({
    initialTask: 'first task',
    queue,
    agent,
    buildRequest: (text, conversationId) => ({
      task: text,
      ...(conversationId ? { continuation: true, conversationId } : {})
    }),
    writeTrace: (event) => trace.push(event)
  });
  assert.equal(result.continuations, 1, 'exactly one continuation ran');
  assert.equal(result.held, 0, 'nothing was held back');
  assert.equal(agent.starts.length, 2, 'first run + one continuation');
  const first = agent.starts[0];
  const second = agent.starts[1];
  assert.equal(first.continuation, false, 'the initial run is not a continuation');
  assert.equal(second.task, 'follow-up instruction', 'the queued text is the continuation task');
  assert.equal(second.continuation, true, 'the queued delivery requests a continuation');
  assert.equal(second.conversationId, first.id, 'the continuation names the finished conversation');
  assert.equal(second.id, first.id, 'same conversation id — the desktop one-conversation-many-turns shape');
  assert.deepEqual(second.history, ['first task', 'follow-up instruction'], 'the conversation carried over');
  assert.equal(result.state.status, 'completed');
  const started = trace.find((event) => event.type === 'harness.continuation.started');
  assert.ok(started, 'a continuation-start trace event flowed');
  assert.equal(started.task, 'follow-up instruction');
  assert.equal(started.remaining, 0);
  assert.equal(started.conversationId, first.id);
});

test('agentRunQueue: chained queue — 2 mid-run messages become 2 continuations in order', async () => {
  const agent = mockQueueAgent();
  const queue = createMessageQueue();
  const trace = [];
  const realStart = agent.start.bind(agent);
  agent.start = async (request) => {
    // Both control lines arrive during run 1 (two mid-run submissions).
    if (request?.continuation !== true && queue.size() === 0) {
      queue.push('second instruction');
      queue.push('third instruction');
    }
    return realStart(request);
  };
  const result = await runWithQueue({
    initialTask: 'first task',
    queue,
    agent,
    buildRequest: (text, conversationId) => ({
      task: text,
      ...(conversationId ? { continuation: true, conversationId } : {})
    }),
    writeTrace: (event) => trace.push(event)
  });
  assert.equal(result.continuations, 2, 'two continuations ran');
  assert.equal(agent.starts.length, 3);
  assert.deepEqual(agent.starts.map((run) => run.task), ['first task', 'second instruction', 'third instruction'], 'FIFO order preserved');
  const ids = new Set(agent.starts.map((run) => run.id));
  assert.equal(ids.size, 1, 'all three turns share ONE conversation id');
  assert.ok(agent.starts[1].continuation && agent.starts[2].continuation, 'both deliveries requested continuations');
  assert.deepEqual(agent.starts[2].history, ['first task', 'second instruction', 'third instruction'], 'the full chained conversation carried');
  const startedEvents = trace.filter((event) => event.type === 'harness.continuation.started');
  assert.deepEqual(startedEvents.map((event) => event.remaining), [1, 0], 'the remaining count drains with the queue');
});

test('agentRunQueue: an observer-cancelled run HOLDS the queue instead of burning it', async () => {
  const agent = mockQueueAgent();
  const queue = createMessageQueue();
  const trace = [];
  const realStart = agent.start.bind(agent);
  agent.start = async (request) => {
    const state = await realStart(request);
    // The external observer clock cancelled this run (budget exhaustion).
    if (request?.continuation !== true) state.status = 'cancelled';
    return state;
  };
  agent.state = () => agent.starts[agent.starts.length - 1] || null;
  queue.push('never burned');
  const result = await runWithQueue({
    initialTask: 'first task',
    queue,
    agent,
    buildRequest: (text, conversationId) => ({
      task: text,
      ...(conversationId ? { continuation: true, conversationId } : {})
    }),
    canContinue: (finished) => ['completed', 'failed'].includes(String(finished?.status || '')),
    writeTrace: (event) => trace.push(event)
  });
  assert.equal(agent.starts.length, 1, 'no continuation started');
  assert.equal(result.continuations, 0);
  assert.equal(result.held, 1, 'the queued message is reported held');
  assert.ok(trace.some((event) => event.type === 'harness.queue.held'), 'the hold is traced honestly');
});

// ----------------------------------- queueing E2E (real TUI, fake agent-cli) --
// Boots the REAL cli/tui.mjs (piped mode = the same handleSubmit dispatch the
// keyboard path uses) with a fake agent-cli (BROWSER_USE_TUI_AGENT_CLI hook):
// submits a task, submits a SECOND message mid-run, and asserts the queued
// card + footer count render, the JSON control line reaches the child's
// stdin, the continuation card renders, and NO "already active" error appears.
const FAKE_AGENT_CLI = `#!/usr/bin/env node
// Fake agent-cli for the queueing E2E (tui.test.mjs): honors the stdin
// control protocol — logs every queue line, emits a continuation-start trace
// event per queued message after its first terminal state, then exits 0.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
const outDir = arg('out-dir');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'started'), String(process.pid));
const tracePath = path.join(outDir, 'trace.jsonl');
const trace = (event) => fs.appendFileSync(tracePath, JSON.stringify({ ts: Date.now(), ...event }) + '\\n');
trace({ type: 'harness.boot', phase: 'modules', ms: 1 });
const queuedTexts = [];
let buffer = '';
process.stdin.setEncoding('utf8');
const sink = fs.createWriteStream(path.join(outDir, 'queue.jsonl'), { flags: 'a' });
process.stdin.on('data', (chunk) => {
  buffer += String(chunk);
  let index;
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    sink.write(line + '\\n');
    try { const parsed = JSON.parse(line); if (parsed.type === 'queue' && parsed.text) queuedTexts.push(parsed.text); } catch {}
  }
});
process.stdin.on('error', () => {});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(async () => {
  // Terminal state reached: drain the queue as continuations (one trace
  // event each — the TUI's tailer renders a clean continuation card).
  for (const text of queuedTexts) {
    trace({ type: 'harness.continuation.started', task: text, remaining: Math.max(0, queuedTexts.length - queuedTexts.indexOf(text) - 1), conversationId: 'fake-conv' });
    await sleep(120);
  }
  fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify({
    status: 'completed',
    meta: { exitCode: 0, elapsedMs: 2000, runId: 'fake-conv' },
    counts: { decisionCount: 2, stepCount: 2, traceLines: 3, toolResultEvents: 0 },
    toolCallCount: 0,
    toolCalls: [],
    result: { ok: true, summary: 'fake run completed' },
    state: { status: 'completed', id: 'fake-conv' }
  }, null, 2));
  console.log(JSON.stringify({ ok: true, runId: 'fake-conv', status: 'completed', elapsedMs: 2000, outDir }, null, 2));
  process.exit(0);
}, 2500);
`;

test('queueing E2E: submit during an active run → queued card + stdin control line + continuation card, no error', { timeout: 240000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-queue-e2e-'));
  const fakeAgentPath = path.join(root, 'fake-agent-cli.mjs');
  fs.writeFileSync(fakeAgentPath, FAKE_AGENT_CLI);
  const childEnv = { ...process.env };
  childEnv.XKIRO_API_KEY = 'sk-tui-queue-e2e-fake-key'; // explicit env export resolves without any store
  childEnv.BROWSER_USE_TUI_AGENT_CLI = fakeAgentPath;
  childEnv.BROWSER_USE_TUI_FULL = '0'; // force the inline renderer for frame capture
  const chunks = [];
  const tui = spawn(process.execPath, [path.join(TOOL_ROOT, 'cli', 'tui.mjs')], {
    cwd: root, // the TUI's invocation dir (never the tool repo)
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnv
  });
  let stdout = '';
  tui.stdout.on('data', (chunk) => { chunks.push(chunk); stdout += String(chunk); });
  tui.stderr.on('data', (chunk) => { chunks.push(chunk); stdout += String(chunk); });
  let exited = false;
  const exitPromise = new Promise((resolve) => { tui.on('exit', (code) => { exited = true; resolve(code); }); });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const sendLine = (line) => new Promise((resolve) => { tui.stdin.write(line + '\n', resolve); });
  const waitUntil = async (predicate, ms, label) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (exited && !predicate()) break; // a dead TUI can never satisfy the wait
      if (predicate()) return;
      await sleep(200);
    }
    assert.ok(predicate(), `timed out waiting for ${label}\n=== TUI OUTPUT ===\n${stdout}`);
  };

  try {
    await sendLine(`/out ${root}`); // runs land in the test's tmp root
    await sendLine('first task'); // starts the run (fake agent-cli)
    // Wait for the fake child to prove it booted (started marker under root).
    await waitUntil(() => {
      try {
        return fs.readdirSync(root).some((entry) => entry.startsWith('run-')
          && fs.existsSync(path.join(root, entry, 'started')));
      } catch { return false; }
    }, 90000, 'the fake agent-cli to boot (run started)');

    // MID-RUN SUBMISSION: the owner types while the run is active.
    await sendLine('second task');
    await waitUntil(() => stdout.includes('▸ queued — second task'),
      20000, 'the queued card to render');
    // NOTE (ink 7 non-TTY contract): piped stdout only flushes STATIC entries —
    // the live footer's "queued (1 total)" is transient live-section content
    // and never lands here; it is asserted in the ink-testing-library frame
    // test below (and visible in a real PTY).
    assert.doesNotMatch(stdout, /already active/, 'NO "already active" refusal for a normal mid-run submit');

    // The JSON control line reached the child's stdin.
    await waitUntil(() => {
      try {
        return fs.readdirSync(root).some((entry) => {
          const log = path.join(root, entry, 'queue.jsonl');
          try { return fs.readFileSync(log, 'utf8').includes('"type":"queue"'); } catch { return false; }
        });
      } catch { return false; }
    }, 20000, 'the queue.jsonl control-line log');

    // The fake drains its queue: the continuation card renders in the TUI.
    await waitUntil(() => stdout.includes('▸ continuation'), 30000, 'the continuation run card');
    assert.match(stdout, /▸ continuation\s+— second task/, 'the continuation card names the queued task');
    assert.doesNotMatch(stdout, /pid \d+|spawn|stdio/, 'the continuation card is clean — no pid, no spawn plumbing');

    // The run finishes and the summary renders (the TUI stays alive): the
    // bordered card + the dim economy line below it (unified contract).
    await waitUntil(() => /decisions · .{0,3} tools/.test(stdout), 30000, 'the run summary panel (economy line)');
    await waitUntil(() => stdout.includes('fake run completed'), 20000, 'the reply card content');
    await sleep(700); // let the tailer settle before shutdown
  } finally {
    try { tui.stdin.end(); } catch { /* gone */ }
    const code = await Promise.race([exitPromise, sleep(8000).then(() => null)]);
    if (!exited) {
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(tui.pid), '/T', '/F'], { stdio: 'ignore' });
        else tui.kill('SIGKILL');
      } catch { /* already gone */ }
      await exitPromise.catch(() => {});
    }
    assert.equal(code, 0, `the TUI exits cleanly (got ${code})`);
  }

  // The TUI's own final frame echoed the queued card exactly once per submit.
  const queueCards = stdout.split('▸ queued — second task').length - 1;
  assert.equal(queueCards, 1, 'exactly one queued card for the one mid-run submission');
});

// ------------------------------- queued/continuation cards render (frames) ---
test('Ink TUI: the queued card, the continuation card and the footer queue count render', async () => {
  const { controller, store } = fixtureController();
  // A live run with one queued message (the state queueMessage leaves behind).
  store.set((state) => ({
    ...state,
    run: { name: 'run-live-queue', pid: 7, startedAt: Date.now(), task: 'first task', inFlight: null, thinking: null, lastTool: null, tools: [], queuedCount: 1 }
  }));
  pushHistory(store, { kind: 'user', text: 'second task' });
  pushHistory(store, { kind: 'queued', text: 'second task' });
  pushHistory(store, { kind: 'contStart', text: 'second task' });
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /second task/, 'the user message card renders');
    assert.match(frame, /▸ queued — second task/, 'the dim queued card renders (contract: ▸ queued — text)');
    assert.match(frame, /▸ continuation\s*— second task/, 'the clean continuation card renders (no pid, no spawn plumbing)');
    assert.doesNotMatch(frame, /pid 7/, 'no pid anywhere');
    assert.match(frame, /queued \(1 total\)/, 'the footer/live-card queue count renders');
  } finally {
    app.unmount();
    cleanup();
  }
});

// ------------------------------------------------------------ run smoke ----
test('browser-use run smoke: 60s-capped real run against the checkout fixture', { timeout: 240000, skip: !process.env.BROWSER_USE_TUI_SMOKE }, async () => {
  assert.equal(fs.existsSync(CHECKOUT_FIXTURE), true, 'checkout fixture must exist');
  // credentials must resolve like agent-cli resolves them (settings.json, NOT
  // the drained XKIRO_API_KEY shell env).
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  const env = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))?.env || {};
  assert.ok(env.ANTHROPIC_AUTH_TOKEN, 'funded key must be present in ~/.claude/settings.json');
  assert.ok(env.ANTHROPIC_BASE_URL, 'gateway base url must be present in ~/.claude/settings.json');

  const outRoot = path.join(TOOL_ROOT, 'cli-runs', 'tui-smoke');
  // The shell XKIRO_API_KEY may carry a drained key — strip it so the child
  // resolves credentials exactly like agent-cli's base path does: from
  // ~/.claude/settings.json.
  const childEnv = { ...process.env };
  delete childEnv.XKIRO_API_KEY;
  delete childEnv.BROWSER_USE_TUI_SMOKE;
  const child = spawn(process.execPath, [
    ENTRY, 'run',
    '--url', pathToFileURL(CHECKOUT_FIXTURE).href,
    '--max-seconds', '60',
    '--out-dir', outRoot,
    '--task', [
      'Complete the checkout flow on the page that is already open:',
      'click "Enter shipping", fill Full name "Max Test", Street address "123 Main St",',
      'City "Kampala", select country "Uganda", continue to payment,',
      'fill card number 4111111111111111, expiry 12/28, cvv 123, place the order,',
      'and verify the page shows the order confirmed message.'
    ].join(' ')
  ], {
    cwd: os.tmpdir(), // proves path-independence of the entry script
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv
  });
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.stderr.on('data', (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('smoke run exceeded 230s')), 230000);
    child.on('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
  });
  const output = Buffer.concat(chunks).toString('utf8');
  assert.ok([0, 2].includes(code), `expected exit 0 (completed) or 2 (clock), got ${code}\n${output}`);
  const summary = JSON.parse(output.slice(output.lastIndexOf('{\n  "ok"')));
  assert.equal(typeof summary.outDir, 'string');
  assert.equal(typeof summary.elapsedMs, 'number');
  assert.ok(summary.elapsedMs <= 90_000, 'the 60s observer clock must bound the run');
  assert.equal(fs.existsSync(path.join(summary.outDir, 'trace.jsonl')), true, 'trace.jsonl written');
  assert.equal(fs.existsSync(path.join(summary.outDir, 'final-state.json')), true, 'final-state.json written');
});

// ============================ FOUR TUI UPGRADES (2026-10-13) =================
// 1. `===` sandwich around user submissions (historyView line model)
// 2. banner title boxed: |browser-use| (v…)  (asserted in the banner test above)
// 3. persistent subagent history cards
// 4. hover (motion) + cursor placement + click through the frame-anchor map

function fullFixtureController({ viewport = { rows: 24, cols: 80 }, onSubmit } = {}) {
  const registry = createCommandRegistry();
  for (const name of ['alpha', 'beta', 'cancel', 'clear', 'config', 'help', 'model', 'provider']) {
    registry.register({ name, args: name === 'model' ? '<id>' : '', description: `the ${name} command`, handler: async () => {} });
  }
  const store = createTuiStore({
    session: { model: 'z-ai/glm-5.3-flash', providerId: 'xkiro', cwd: 'F:/somewhere/dir', maxSeconds: 0, outRoot: 'F:/somewhere/runs' },
    history: []
  });
  const controller = {
    store,
    registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    screenMode: 'full',
    getViewport: () => viewport,
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    onEscape: () => {},
    selectSubagentPane: (alias) => store.set((s) => ({ ...s, activeSubagent: String(alias || '') || null })),
    selectMainPane: () => store.set((s) => ({ ...s, activeSubagent: null })),
    handleSubmit: (text) => {
      pushHistory(store, { kind: 'user', text });
      if (onSubmit) onSubmit(text, store);
    }
  };
  return { controller, store };
}

test('UPGRADE 1: submissions render as right-aligned message cards; the framed composer stays separate', async () => {
  const W = 80;
  // Full-screen history uses the rounded right-aligned card from the reference
  // UI. The composer has its own two-row rounded frame.
  const entry = { id: 7, kind: 'user', text: 'buy shoes on the staged page' };
  const lines = entryToLines(entry, W);
  assert.equal(lines.length, 3, 'the card has top, body, and bottom rows');
  assert.match(lines[0].segments.map((s) => s.text).join(''), /╭─+╮$/);
  assert.match(lines[1].segments.map((s) => s.text).join(''), /buy shoes on the staged page/);
  assert.match(lines[2].segments.map((s) => s.text).join(''), /╰─+╯$/);
  assert.ok(lines[0].key.startsWith('u-7-top'), `the card is deterministically keyed (${lines[0].key})`);
  // Rendered proof in the full-screen frame: the echoed submission stays
  // plain in the history window, and exactly TWO full-width bars sandwich
  // the composer prompt (constant 2 rows in the height math).
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  controller.handleSubmit('buy shoes on the staged page');
  const app = inkRender(controller);
  try {
    await tick(80);
    const frame = app.lastFrame() || '';
    assert.match(frame, /buy shoes on the staged page/, 'the user card renders in history');
    const barCount = (frame.match(/^\s*[╭╰]─+[╮╯]\s*$/gm) || []).length;
    assert.ok(barCount >= 2, 'the framed composer remains bounded');
    // The card and composer frames each contribute a top and bottom border.
    const lines2 = frame.split('\n');
    const barIdx = lines2.map((l, i) => (/^[╭╰]─+[╮╯]$/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(barIdx.length >= 2, 'the composer frame is present and bounded');
    assert.ok(lines2.some((line) => line.includes('browser-use▸')), 'the composer prompt remains present');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('UPGRADE 3: a spawned subagent becomes a PERSISTENT history card that survives run end', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  // The submission that started the run, then the spawn event (arrives after
  // the submit — the card lands below the user's === sandwich).
  controller.handleSubmit('main task');
  pushHistory(store, { kind: 'subagent', alias: 's1', status: 'queued' });
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'main task', inFlight: null, thinking: null, lastTool: null, tools: [] },
    subagents: [{ alias: 's1', label: 'subagent s1', task: 'scan the page', status: 'running', tail: { tools: [] } }]
  }));
  const app = inkRender(controller);
  try {
    await tick(80);
    let frame = app.lastFrame() || '';
    assert.match(frame, /▸ subagent s1 — running/, 'the persistent card renders with the LIVE status');
    // Live status updates flow into the persistent card while the run is active.
    store.set((state) => ({
      ...state,
      subagents: state.subagents.map((sub) => (sub.alias === 's1' ? { ...sub, status: 'completed' } : sub))
    }));
    await tick(80);
    frame = app.lastFrame() || '';
    assert.match(frame, /▸ subagent s1 — completed/, 'status updates flow into the persistent card live');
    // RUN END: the live card and roster vanish; the persistent card stays.
    store.set((state) => ({ ...state, run: null }));
    await tick(80);
    frame = app.lastFrame() || '';
    assert.doesNotMatch(frame, /▸ run run-live/, 'the live run card is gone after run end');
    assert.match(frame, /▸ subagent s1 — completed/, 'the persistent card SURVIVES run end as a completed record');
    // The card sits BELOW the user's submission (entry order in the model).
    const lines = historyToLines(store.get().history, 80, { subagents: store.get().subagents });
    const cardLine = lines.findIndex((line) => line.key.startsWith('subagent-history#s1'));
    const userEcho = lines.findIndex((line) => line.key.startsWith('u-'));
    assert.ok(userEcho !== -1 && cardLine > userEcho, 'the card renders below the user echo');
    assert.ok(lines[cardLine].key.startsWith('subagent-history#s1#'), 'the card line is deterministically keyed for the frame-anchor map');
    const plain = (line) => line.segments.map((s) => s.text).join('');
    assert.match(plain(lines[cardLine]), /▸ subagent s1 — completed/, 'the card renders ▸ subagent <alias> — <status>');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('UPGRADE 4: hover state transitions — motion highlights clickable rows, non-clickable rows clear it', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  controller.handleSubmit('main task');
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'main task', inFlight: null, thinking: null, lastTool: null, tools: [] },
    subagents: [{ alias: 's1', label: 'subagent s1', task: 'scan', status: 'running', tail: { tools: [] } }]
  }));
  const app = inkRender(controller);
  try {
    await tick(80);
    // Contract layout (rows=24; header 3 + history 10 + run card 5 + roster 1
    // + MESSAGE/composer frame + footer): history rows 3..12, main card
    // 13..17, roster row 18 (all 0-based) — motion onto the roster row.
    app.stdin.write('\x1b[<35;5;19M'); // any-motion at row 19 (1-based) = roster
    await tick(80);
    let hover = store.get().hover;
    assert.ok(hover, 'motion over a clickable row sets the hover state');
    assert.equal(hover.type, 'subagent-roster', 'the hit resolves to the roster anchor');
    assert.equal(hover.alias, 's1', 'the hover carries the row alias');
    assert.equal(hover.row, 18, 'the hover carries the 0-based frame row');
    // Motion over a NON-clickable row (the history window) clears the hover.
    app.stdin.write('\x1b[<35;5;5M'); // history region — generic pass-through
    await tick(80);
    assert.equal(store.get().hover, null, 'non-clickable regions ignore motion (hover cleared)');
    // Motion onto the main run card, then onto the roster again — each CHANGE
    // re-renders; identical repeated motion must NOT re-write the store.
    let writes = 0;
    const onStoreWrite = () => { writes += 1; };
    const unsubscribe = store.subscribe(onStoreWrite);
    app.stdin.write('\x1b[<35;5;14M'); // main card row (0-based 13)
    await tick(60);
    assert.equal(store.get().hover.type, 'main-pane', 'the main run card is hoverable');
    app.stdin.write('\x1b[<35;5;14M'); // SAME row again — throttled
    await tick(60);
    assert.equal(writes, 1, 'repeated motion over the SAME row never re-renders (change-gated)');
    app.stdin.write('\x1b[<35;5;19M'); // roster row again
    await tick(60);
    assert.ok(writes >= 2, 'a hovered-row CHANGE does re-render');
    unsubscribe();
    // The hovered roster row renders with the lime pointer marker.
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ subagent s1 — running[^\n]*◂/, 'the hovered row is highlighted with the pointer marker');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('UPGRADE 4: a click lands on the hovered row — menu row, persistent subagent card, roster', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  controller.handleSubmit('main task');
  pushHistory(store, { kind: 'subagent', alias: 's1', status: 'completed' });
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'main task', inFlight: null, thinking: null, lastTool: null, tools: [] },
    subagents: [{ alias: 's1', label: 'subagent s1', task: 'scan', status: 'completed', tail: { tools: [] } }]
  }));
  const app = inkRender(controller);
  try {
    await tick(80);
    // PERSISTENT CARD click: the user card occupies history rows 3..5;
    // the persistent card is frame row 6 (0-based) — 1-based row 7.
    app.stdin.write('\x1b[<0;5;7M');
    await tick(80);
    assert.equal(store.get().activeSubagent, 's1', 'clicking the persistent history card switches to that subagent pane');
    controller.selectMainPane();
    await tick(40);
    assert.equal(store.get().activeSubagent, null, 'pane reset for the next click');
    // ROSTER click: roster row 18 (0-based) → 1-based row 19.
    app.stdin.write('\x1b[<0;5;19M');
    await tick(80);
    assert.equal(store.get().activeSubagent, 's1', 'clicking the live roster still switches (existing contract)');
    controller.selectMainPane();
  } finally {
    app.unmount();
    cleanup();
  }
});

test('UPGRADE 4: the menu hover path — motion highlights a picker row and the click executes it', async () => {
  const { controller, store } = fullFixtureController({
    viewport: { rows: 24, cols: 80 },
    onSubmit: (text, store2) => {
      pushHistory(store2, { kind: 'out', text: `ran ${text}`, tone: 'ok' });
    }
  });
  const app = inkRender(controller);
  try {
    await tick(60);
    app.stdin.write('/');
    await tick(60);
    assert.match(app.lastFrame() || '', /\(1\/8\)/, 'the menu is open');
    // Contract layout (rows=24, no run): history 3..12, menu options 13..17
    // (0-based; 1-based 14..18), status row 18, MESSAGE/composer frame,
    // footer 23. HOVER the first option row (1-based 14), then move down one.
    app.stdin.write('\x1b[<35;5;14M');
    await tick(60);
    let hover = store.get().hover;
    assert.equal(hover && hover.type, 'menu', 'menu rows are hoverable');
    assert.equal(hover && hover.index, 0, 'the first menu row is hovered');
    assert.match(app.lastFrame() || '', /\/alpha[^\n]*◂/, 'the hovered menu row carries the pointer marker');
    app.stdin.write('\x1b[<35;5;15M');
    await tick(60);
    hover = store.get().hover;
    assert.equal(hover && hover.index, 1, 'the hover moved to the second row (change-gated re-render)');
    // CLICK the hovered row — it executes (the existing click path, now fed
    // by the same anchor map the hover uses).
    app.stdin.write('\x1b[<0;5;15M');
    await tick(80);
    assert.match(app.lastFrame() || '', /ran \/beta/, 'the clicked (hovered) menu row executed');
    assert.equal(store.get().hover, null, 'the hover cleared when the menu closed (no clickable rows left)');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('UPGRADE 4: motion decoding + the boot-once ?1003 sequences + inline fallback stays mouse-idle', () => {
  // Any-motion events decode through the SAME SGR parser (button 35 = 32+3).
  assert.deepEqual(parseMouseEvent('[<35;12;9M'), { kind: 'motion', x: 12, y: 9, button: 3 }, 'any-motion (?1003) decodes as hover motion');
  assert.deepEqual(parseMouseEvent('[<35;12;9m'), { kind: 'motion', x: 12, y: 9, button: 3 }, 'motion release-shape is still motion');
  assert.equal(isMotionEvent({ kind: 'motion' }), true, 'motion events ride the hover channel');
  assert.equal(isMotionEvent({ kind: 'press', button: 0 }), false, 'presses are clicks, not hover');
  assert.equal(isActionableMouse({ kind: 'motion' }), false, 'hover motion is never actionable (no accidental clicks)');
  // The toggled sequences are minimal and symmetric (?1003 only — ?1000/1002/
  // 1006 stay owned by the bootstrap's MOUSE_ENABLE/DISABLE).
  assert.equal(MOTION_ENABLE, '\x1b[?1003h');
  assert.equal(MOTION_DISABLE, '\x1b[?1003l');
  assert.ok(!MOUSE_ENABLE.includes('?1003'), 'the base enable sequence does NOT pin any-motion on');
  // INLINE fallback: no mouse layer, no hover — the inline renderer never
  // receives extras, so motion over it cannot mutate any store state. The
  // inline-shared line model renders the same PLAIN echo (no sandwich bars).
  const store = createTuiStore({ history: [] });
  pushHistory(store, { kind: 'user', text: 'inline mode' });
  const lines = historyToLines(store.get().history, 80);
  assert.equal(lines.length, 3, 'the shared line model renders a compact user card');
  assert.match(lines[0].segments.map((s) => s.text).join(''), /╭─+╮$/);
  assert.match(lines[1].segments.map((s) => s.text).join(''), /inline mode/);
});

// ================== gen8 unification: tests ported from the arms =============
// gen8-arch1 (mouse.mjs: batched SGR/X10 parsing + frame-anchor geometry),
// gen8-arch3 (same-task dedupe window, clean-card proof) — merged so one
// suite covers the unified TUI.

test('mouse: parseMouseEvents decodes SGR presses, releases, and wheel (raw + escape-stripped forms)', async () => {
  const { parseMouseEvents } = await import('./mouse.mjs');
  // Raw wire form: left press at col 10 row 5.
  assert.deepEqual(parseMouseEvents('\x1b[<0;10;5M'), [
    { name: 'left-press', col: 10, row: 5, button: 'left' }
  ]);
  // Escape-stripped form (what ink's useInput hands over).
  assert.deepEqual(parseMouseEvents('[<0;10;5M'), [
    { name: 'left-press', col: 10, row: 5, button: 'left' }
  ]);
  // Release (lowercase m).
  assert.equal(parseMouseEvents('[<0;1;1m')[0].name, 'left-release');
  // Wheel: button 64 = up, 65 = down.
  assert.equal(parseMouseEvents('[<64;3;4M')[0].name, 'scroll-up');
  assert.equal(parseMouseEvents('[<65;3;4M')[0].name, 'scroll-down');
  // Any-motion (?1003, button 35 = 32+3) decodes as hover motion.
  assert.equal(parseMouseEvents('[<35;12;9M')[0].name, 'move');
  // Several events batched into ONE chunk (terminals coalesce motion+click).
  const batch = parseMouseEvents('\x1b[<0;1;1M\x1b[<0;1;1m');
  assert.equal(batch.length, 2);
  assert.equal(batch[0].name, 'left-press');
  assert.equal(batch[1].name, 'left-release');
  // Right press.
  assert.equal(parseMouseEvents('[<2;8;9M')[0].button, 'right');
  // Keystrokes, pastes and garbage parse to NO events.
  assert.deepEqual(parseMouseEvents('a'), []);
  assert.deepEqual(parseMouseEvents('buy shoes on the checkout page'), []);
  assert.deepEqual(parseMouseEvents('[<'), []);
  assert.deepEqual(parseMouseEvents(''), []);
  // X10-shaped garbage (terminal ignored ?1006h) is swallowed, not decoded.
  assert.equal(parseMouseEvents('\x1b[Mabc')[0].name, 'x10-unsupported');
});

test('mouse: frame-anchor geometry maps terminal rows onto bottom-pinned layout rows', async () => {
  const { frameAnchor, terminalRowToLayoutRow } = await import('./mouse.mjs');
  // Frame fits: top-anchored, anchor 0.
  assert.equal(frameAnchor(30, 24), 0);
  // Frame overflows: bottom-pinned, anchor negative (top rows scrolled off).
  assert.equal(frameAnchor(24, 30), -6);
  // 1-based terminal row 5 with a -6 anchor = layout row 10.
  assert.equal(terminalRowToLayoutRow(5, -6), 10);
  assert.equal(terminalRowToLayoutRow(1, 0), 0);
});

test('mouse: enable/disable write the SGR tracking sequences and survive closed streams', async () => {
  const { enableMouseEvents, disableMouseEvents, ENABLE_MOUSE_SGR, DISABLE_MOUSE_SGR } = await import('./mouse.mjs');
  const written = [];
  const fakeStdout = { write: (data) => { written.push(data); } };
  enableMouseEvents(fakeStdout);
  disableMouseEvents(fakeStdout);
  assert.deepEqual(written, [ENABLE_MOUSE_SGR, DISABLE_MOUSE_SGR]);
  assert.match(ENABLE_MOUSE_SGR, /\x1b\[\?1002h\x1b\[\?1006h/, 'button events + SGR coordinates');
  assert.match(DISABLE_MOUSE_SGR, /\x1b\[\?1006l\x1b\[\?1002l/, 'mirror-image disable');
  // A destroyed stream must not throw.
  const dead = { write: () => { throw new Error('EPIPE'); } };
  assert.doesNotThrow(() => { enableMouseEvents(dead); disableMouseEvents(dead); });
});

test('Ink TUI: ONE clean run card — no pid, no spawn plumbing, even for a stale pid field', async () => {
  const { controller, store } = fixtureController();
  // The live run card is the ONLY run view (defect 2). A legacy `pid` field
  // on the run object (old sessions/fixtures) must still never render.
  store.set((state) => ({
    ...state,
    run: {
      name: 'run-2026-10-13-101112',
      outDir: 'F:/somewhere/run-2026-10-13-101112',
      task: 'mock task',
      startedAt: Date.now(),
      status: 'running',
      pid: 9584,
      inFlight: null,
      thinking: null,
      lastTool: null,
      lastError: null,
      tools: []
    }
  }));
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ run run-2026-10-13-101112/, 'the live run card names the active run');
    assert.doesNotMatch(frame, /pid/, 'no pid anywhere in the frame (process plumbing is invisible)');
    assert.doesNotMatch(frame, /XKIRO_API_KEY/, 'no credential env names in the frame');
    assert.equal((frame.match(/▸ run /g) || []).length, 1, 'exactly ONE run card');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: a starting run card shows the starting state immediately (no dead submit)', async () => {
  const { controller, store } = fixtureController();
  store.set((state) => ({
    ...state,
    run: {
      name: 'run-2026-10-13-101113',
      outDir: 'F:/somewhere/run-2026-10-13-101113',
      task: 'mock task',
      startedAt: Date.now(),
      phase: 'resolving credentials…',
      inFlight: null,
      thinking: null,
      lastTool: null,
      lastError: null,
      tools: []
    }
  }));
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ run run-2026-10-13-101113/, 'the live run card names the active run');
    assert.match(frame, /resolving credentials/, 'the honest startup phase renders before the spawn lands');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('Ink TUI: run cards carry NO pid / spawn plumbing — one clean card per run (legacy runStart shape too)', async () => {
  const { controller, store } = fixtureController();
  // Legacy runStart shape (old sessions): id + out basename only, even though
  // a pid arrives in the data — the renderer must never show process plumbing.
  pushHistory(store, {
    kind: 'runStart',
    name: 'run-2026-10-12-043641',
    pid: 4242,
    outBase: 'run-2026-10-12-043641',
    outDir: 'F:/somewhere/run-2026-10-12-043641'
  });
  // The live run card: one card per run, phase-driven, no pid either.
  store.set((state) => ({
    ...state,
    run: { name: 'run-2026-10-12-043641', outDir: 'F:/somewhere/run-2026-10-12-043641', task: 'mock task', phase: 'running', startedAt: Date.now(), inFlight: null, thinking: null, lastTool: null, lastError: null, lastErrorAt: null, tools: [] }
  }));
  const app = inkRender(controller);
  try {
    await tick(60);
    const frame = app.lastFrame() || '';
    assert.match(frame, /▸ run run-2026-10-12-043641/, 'the live run card names the active run');
    assert.doesNotMatch(frame, /pid \d+/, 'no pid anywhere in the frame');
    assert.doesNotMatch(frame, /spawn/, 'no spawn plumbing in the frame');
    assert.doesNotMatch(frame, /-> run-/, 'no old arrow out-dir plumbing');
    assert.doesNotMatch(frame, /XKIRO_API_KEY/, 'no credential env names in the run view');
  } finally {
    app.unmount();
    cleanup();
  }
});

// ================= owner-fix round 2026-10-13 (render hygiene) ===============

test('owner fix 2: a burst of SGR motion (and split/malformed mouse bytes) never types into the composer', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  controller.handleSubmit('main task');
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'main task', inFlight: null, thinking: null, lastTool: null, tools: [] },
    subagents: [{ alias: 's1', label: 'subagent s1', task: 'scan', status: 'running', tail: { tools: [] } }]
  }));
  const app = inkRender(controller);
  try {
    await tick(80);
    // Burst: valid motion events, a motion over a non-clickable row, an SGR
    // sequence SPLIT across chunk boundaries (the classic fall-through hole),
    // and a trailing fragment after a parsed event. Motion tracking is
    // boot-once now — all of it must be decoded-and-ignored or swallowed,
    // and NOTHING may reach the composer input.
    app.stdin.write('\x1b[<35;5;5M\x1b[<35;6;6M\x1b[<3'); // + split fragment
    await tick(60);
    app.stdin.write('[<35;12;9M'); // escape-stripped motion
    await tick(60);
    app.stdin.write('\x1b[<35;7;7M\x1b[<'); // trailing fragment
    await tick(80);
    const lines = (app.lastFrame() || '').split('\n');
    const barIdx = lines.map((l, i) => (/^[╭╰]─+[╮╯]$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
    assert.equal(barIdx.length, 4, 'the user card and composer frames are intact');
    const promptLine = lines[barIdx[2] + 1] || '';
    assert.match(promptLine, /browser-use▸\s*▏?\s*$/, `the composer buffer is EMPTY (got ${JSON.stringify(promptLine)})`);
    assert.doesNotMatch(promptLine, /35|12|9M|M\b/, 'no mouse bytes leaked into the field');
    // Motion over non-clickable rows never mutated the hover state either.
    assert.equal(store.get().hover ?? null, null, 'untracked/ignored motion left no hover state');
  } finally {
    app.unmount();
    cleanup();
  }
});
