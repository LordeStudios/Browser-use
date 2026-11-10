import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createLayaRuntime, parsePythonVersion, isSupportedPython, REQUIRED_PACKAGES } = require('../desktop/agent/layaRuntime.cjs');

function fakeChild() {
  const child = {
    stdout: { setEncoding() {}, on() {} },
    stderr: { setEncoding() {}, on() {} },
    on() {},
    killed: false,
    kill() { child.killed = true; }
  };
  return child;
}

function stubRunner({ pythonVersion = 'Python 3.12.4', packages = null, gpu = null, torchCuda = false } = {}) {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'nvidia-smi') {
      if (!gpu) throw new Error('nvidia-smi not found');
      return { stdout: `${gpu.name}, ${gpu.memory}`, stderr: '' };
    }
    if (args?.includes('--version')) return { stdout: pythonVersion, stderr: '' };
    if (args?.includes('-c')) {
      const probe = args[args.indexOf('-c') + 1];
      if (probe.includes('cuda.is_available')) return { stdout: torchCuda ? '1' : '0', stderr: '' };
      const names = JSON.parse(probe.match(/\[.*\]/)[0]);
      return { stdout: JSON.stringify(Object.fromEntries(names.map((name) => [name, packages ? packages.includes(name) : true]))), stderr: '' };
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

test('python version parsing and support gate', () => {
  assert.deepEqual(parsePythonVersion('Python 3.12.4'), [3, 12, 4]);
  assert.deepEqual(parsePythonVersion('Python 3.8.10 (tags/v3.8.10)'), [3, 8, 10]);
  assert.equal(parsePythonVersion('not python'), null);
  assert.equal(isSupportedPython([3, 12, 4]), true);
  assert.equal(isSupportedPython([3, 8, 1]), true);
  assert.equal(isSupportedPython([3, 7, 9]), false);
  assert.equal(isSupportedPython([2, 7, 18]), false);
});

test('missing python is reported honestly and locks the download', async () => {
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner: async () => { throw new Error('command not found'); },
    spawnImpl: () => { throw new Error('must not spawn'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.allOk, false);
  assert.equal(deps.serverReady, false);
  assert.equal(deps.pythonCommand, null);
  assert.equal(deps.checks[0].name, 'Python 3.8+');
  assert.equal(deps.checks[0].ok, false);
  assert.match(deps.checks[0].detail, /python\.org/);
  // A locked dependency set can never start the model.
  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.match(result.reason, /Dependencies are missing/);
});

test('every required package is listed individually with the one-command install hint', async () => {
  const { runner } = stubRunner({ packages: ['fastapi', 'uvicorn', 'torch', 'transformers'] });
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('must not spawn'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.allOk, false, 'laya itself is missing');
  const byName = Object.fromEntries(deps.checks.map((check) => [check.name, check]));
  for (const name of REQUIRED_PACKAGES) {
    assert.ok(byName[name], `${name} appears in the dialogue checklist`);
    assert.equal(byName[name].ok, name !== 'laya');
    if (!byName[name].ok) assert.match(byName[name].detail, /pip install/);
  }
});

test('all dependencies detected: allOk true and the model becomes downloadable', async () => {
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('not yet — this test only checks the gate'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.allOk, true);
  assert.deepEqual(deps.pythonCommand, ['py', '-3']);
});

test('consent click downloads weights with progress, then spawns with the local path', async () => {
  const os = require('node:os');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const cacheDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'laya-dl-'));
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  let spawned = null;
  const child = fakeChild();
  const lines = [];
  const files = [
    { type: 'file', path: 'model.safetensors', size: 10 },
    { type: 'file', path: 'rl_agent_config.json', size: 4 },
    { type: 'file', path: 'README.md', size: 100 },
    { type: 'file', path: 'tokenizer/tokenizer.json', size: 3 }
  ];
  let lastProgress = null;
  const runtime = createLayaRuntime({
    hfCacheDir: cacheDir,
    // health down until spawn; the HF API tree and resolve downloads are stubbed.
    fetchImpl: async (url) => {
      if (String(url).includes('/health')) return spawned ? Response.json({ ok: true, status: 'ready' }) : Response.json({ ok: false, status: 'loading' }, { status: 503 });
      if (String(url).includes('/api/models/')) return Response.json(files);
      const size = files.find((file) => String(url).endsWith(file.path))?.size || 0;
      lastProgress = runtime.status().progress;
      return new Response(Buffer.alloc(size, 7));
    },
    runner,
    spawnImpl: (command, args, options) => {
      spawned = [command, args, options];
      return child;
    },
    log: (line) => lines.push(line)
  });
  const result = await runtime.ensure();
  assert.deepEqual(result, { ok: true, endpoint: 'http://127.0.0.1:8765' });
  assert.equal(runtime.status().status, 'ready');
  // every real file is on disk, the markdown was skipped, progress completed
  assert.ok(fsMod.existsSync(pathMod.join(cacheDir, 'models', 'laya', 'model.safetensors')));
  assert.ok(fsMod.existsSync(pathMod.join(cacheDir, 'models', 'laya', 'tokenizer', 'tokenizer.json')));
  assert.ok(!fsMod.existsSync(pathMod.join(cacheDir, 'models', 'laya', 'README.md')));
  // lastProgress was sampled before the final file's bytes landed: 14 of 17
  assert.equal(lastProgress?.percent, 82);
  assert.equal(lastProgress?.downloadedBytes, 14);
  assert.equal(spawned[2].env.LAYA_MODEL_PATH, pathMod.join(cacheDir, 'models', 'laya'));
  runtime.stop();
  assert.equal(child.killed, true);
});

test('weightsCached distinguishes a first download from a cached start', async () => {
  const os = require('node:os');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const cached = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'laya-cache-'));
  // App-owned checkpoint: config + safetensors under cacheDir/models/laya.
  const modelDir = pathMod.join(cached, 'models', 'laya');
  fsMod.mkdirSync(modelDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(modelDir, 'model.safetensors'), 'x');
  fsMod.writeFileSync(pathMod.join(modelDir, 'rl_agent_config.json'), '{}');
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  const runtime = createLayaRuntime({
    hfCacheDir: cached,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('not spawned'); }
  });
  assert.equal((await runtime.checkDependencies()).weightsCached, true, 'config + safetensors on disk');
  fsMod.unlinkSync(pathMod.join(modelDir, 'model.safetensors'));
  assert.equal((await runtime.checkDependencies()).weightsCached, false, 'safetensors missing');
});

test('status() stays IPC-serializable while the sidecar child is live', async () => {
  const os = require('node:os');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const cacheDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'laya-ipc-'));
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  const child = fakeChild();
  const runtime = createLayaRuntime({
    hfCacheDir: cacheDir,
    fetchImpl: async (url) => {
      if (String(url).includes('/health')) return child ? Response.json({ ok: true, status: 'ready' }) : Response.json({ ok: false }, { status: 503 });
      if (String(url).includes('/api/models/')) return Response.json([{ type: 'file', path: 'model.safetensors', size: 10 }, { type: 'file', path: 'rl_agent_config.json', size: 4 }]);
      return new Response(Buffer.alloc(10, 7));
    },
    runner,
    spawnImpl: () => child
  });
  await runtime.ensure();
  // Electron structuredClone must survive a live child process in the state.
  assert.doesNotThrow(() => structuredClone(runtime.status()));
  assert.equal('child' in runtime.status(), false, 'the process handle never crosses IPC');
  runtime.stop();
});

test('a GPU machine with CPU-only torch is advised, never blocked', async () => {
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES, gpu: { name: 'NVIDIA GeForce RTX 5070', memory: '8192 MiB' }, torchCuda: false });
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('not spawned'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.gpu.name, 'NVIDIA GeForce RTX 5070');
  const byName = Object.fromEntries(deps.checks.map((check) => [check.name, check]));
  assert.equal(byName['NVIDIA GPU'].ok, true);
  assert.equal(byName['CUDA torch'].ok, false, 'CPU-only build is honestly reported');
  assert.equal(byName['CUDA torch'].advisory, true, 'the model runs on CPU — a warning, not a gate');
  assert.match(byName['CUDA torch'].detail, /download\.pytorch\.org/);
  assert.equal(deps.allOk, true, 'the CPU fallback is a legitimate start on a GPU machine');
  assert.match(deps.installCommand, /download\.pytorch\.org/, 'the shown command still prefers the CUDA build');
});

test('auto-start is refused when laya is not wanted', async () => {
  const runtime = createLayaRuntime({
    autoStartAllowed: () => false,
    fetchImpl: async () => { throw new Error('must not fetch'); },
    runner: async () => { throw new Error('must not run'); },
    spawnImpl: () => { throw new Error('must not spawn'); }
  });
  const result = await runtime.maybeAutoStart();
  assert.equal(result.ok, false);
  assert.match(result.reason, /not enabled/);
});

test('a machine without an NVIDIA GPU stays on the CPU path with no CUDA gate', async () => {
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES, gpu: null });
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('not spawned'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.gpu, null);
  assert.equal(deps.allOk, true, 'CPU torch is a legitimate install on a CPU machine');
  assert.ok(!deps.checks.some((check) => check.name === 'CUDA torch'));
  assert.equal(deps.installCommand, 'pip install laya fastapi "uvicorn[standard]"');
});

test('a GPU machine with the CUDA build installed unlocks the download', async () => {
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES, gpu: { name: 'NVIDIA GeForce RTX 5070', memory: '8192 MiB' }, torchCuda: true });
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { throw new Error('not spawned'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.allOk, true);
  const cuda = deps.checks.find((check) => check.name === 'CUDA torch');
  assert.equal(cuda.ok, true);
  assert.match(cuda.detail, /GPU acceleration active/);
});

test('auto-start runs only when deps and weights are already on disk — consent holds', async () => {
  const os = require('node:os');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const cacheDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'laya-auto-'));
  const files = [
    { type: 'file', path: 'model.safetensors', size: 10 },
    { type: 'file', path: 'rl_agent_config.json', size: 4 }
  ];
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  let spawns = 0;
  const child = fakeChild();
  const runtime = createLayaRuntime({
    hfCacheDir: cacheDir,
    fetchImpl: async (url) => {
      if (String(url).includes('/health')) return spawns ? Response.json({ ok: true, status: 'ready' }) : Response.json({ ok: false }, { status: 503 });
      if (String(url).includes('/api/models/')) return Response.json(files);
      return new Response(Buffer.alloc(10, 7));
    },
    runner,
    spawnImpl: () => { spawns += 1; return child; }
  });
  // No weights on disk: auto-start refuses — the download needs explicit consent.
  const blocked = await runtime.maybeAutoStart();
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /consent/);
  assert.equal(spawns, 0, 'no silent download');
  // Weights land on disk (as if the consented download finished): auto-start
  // runs the whole flow — spawn and readiness — in one call.
  const modelDir = pathMod.join(cacheDir, 'models', 'laya');
  fsMod.mkdirSync(modelDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(modelDir, 'model.safetensors'), 'x');
  fsMod.writeFileSync(pathMod.join(modelDir, 'rl_agent_config.json'), '{}');
  const started = await runtime.maybeAutoStart();
  assert.equal(started.ok, true);
  assert.equal(spawns, 1, 'spawned exactly once');
  // A healthy sidecar: auto-start is a no-op, never a second spawn.
  const again = await runtime.maybeAutoStart();
  assert.equal(again.ok, true);
  assert.equal(spawns, 1);
});

test('a crashed sidecar restarts itself while laya is wanted, bounded to two attempts', async () => {
  const os = require('node:os');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const cacheDir = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'laya-restart-'));
  const modelDir = pathMod.join(cacheDir, 'models', 'laya');
  fsMod.mkdirSync(modelDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(modelDir, 'model.safetensors'), 'x');
  fsMod.writeFileSync(pathMod.join(modelDir, 'rl_agent_config.json'), '{}');
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  let spawned = 0;
  let crashes = 0;
  const exits = [];
  const runtime = createLayaRuntime({
    hfCacheDir: cacheDir,
    restartDelayMs: 5,
    // Healthy only while the latest spawned child has not exited yet.
    fetchImpl: async () => (spawned > crashes ? Response.json({ ok: true, status: 'ready' }) : Response.json({ ok: false }, { status: 503 })),
    runner,
    spawnImpl: () => {
      spawned += 1;
      const child = fakeChild();
      child.on = (event, handler) => { if (event === 'exit') exits.push(() => { crashes += 1; handler(1); }); };
      return child;
    }
  });
  assert.equal((await runtime.ensure()).ok, true);
  assert.equal(spawned, 1);
  // Crash #1 -> automatic restart.
  exits[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawned, 2, 'restarted automatically');
  // Crash #2 and #3 -> one more restart, then it gives up (bounded).
  exits[1]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  exits[2]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(spawned, 3, 'no infinite restart loop');
});

test('an already-healthy sidecar is detected and never spawned twice', async () => {
  const runtime = createLayaRuntime({
    fetchImpl: async () => Response.json({ ok: true }),
    runner: async () => { throw new Error('must not run'); },
    spawnImpl: () => { throw new Error('must not spawn'); }
  });
  const deps = await runtime.checkDependencies();
  assert.equal(deps.serverReady, true);
  assert.equal(deps.allOk, true);
  const result = await runtime.ensure();
  assert.deepEqual(result, { ok: true, endpoint: 'http://127.0.0.1:8765' });
});

test('a failing start degrades to the bundled engine with a clear reason', async () => {
  const { runner } = stubRunner({ packages: REQUIRED_PACKAGES });
  const lines = [];
  const runtime = createLayaRuntime({
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    runner,
    spawnImpl: () => { const child = fakeChild(); child.on = (event, handler) => { if (event === 'exit') setImmediate(() => handler(1)); }; return child; },
    readyTimeoutMs: 3000,
    log: (line) => lines.push(line)
  });
  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.equal(runtime.status().status, 'failed');
  assert.ok(lines.some((line) => line.includes('bundled engine answers instead')));
});
