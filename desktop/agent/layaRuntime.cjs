'use strict';

// Laya full-model runtime — user-consent gated, never automatic.
//
// The real Laya checkpoint (Apache-2.0, convaiinnovations/laya on HuggingFace)
// needs the Python ML stack (torch alone is ~500MB installed), so NOTHING is
// provisioned silently. The flow:
//
//   1. checkDependencies(): detect Python >= 3.8 and the required packages
//      (laya, fastapi, uvicorn, torch, transformers) via metadata lookups that
//      never execute the modules. Results feed the settings-panel dialogue.
//   2. The "download full Laya model" affordance only becomes clickable when
//      every dependency is detected — that click IS the consent.
//   3. ensure() (called from the dialogue): health-check, then spawn
//      laya-server/server.py with the detected Python; the ~850MB weights
//      download from the HuggingFace hub on first start. Progress is logged.
//   4. Until the sidecar is healthy — and forever after any failure — the
//      bundled JS engine (layaEngine.cjs) answers. Runs never wait on or fail
//      because of this optional path.
//
// There is no venv, no pip install, and no network call made by this module
// beyond the sidecar's own checkpoint download after explicit consent.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765';
const HEALTH_TIMEOUT_MS = 800;
const READY_POLL_MS = 1_500;
const DEFAULT_READY_TIMEOUT_MS = 20 * 60_000; // first start downloads the ~850MB weights
const HF_REPO = 'convaiinnovations/laya';
const HF_API_TREE = `https://huggingface.co/api/models/${HF_REPO}/tree/main?recursive=true`;
const HF_RESOLVE = `https://huggingface.co/${HF_REPO}/resolve/main/`;
const HF_SKIP = [/\.gitattributes$/, /\.md$/i];

// What the dialogue shows as required. One pip command covers every package.
const REQUIRED_PACKAGES = ['laya', 'fastapi', 'uvicorn', 'torch', 'transformers'];
const INSTALL_COMMAND = 'pip install laya fastapi "uvicorn[standard]"';
// CUDA torch ships from PyTorch's own index, not PyPI — and it is much larger
// (~2.5GB download, ~5GB installed). Preferred whenever an NVIDIA GPU exists;
// the laya runtime itself falls back to CPU automatically when it does not.
const CUDA_TORCH_COMMAND = 'pip install torch --index-url https://download.pytorch.org/whl/cu124';
const CUDA_TORCH_FULL_COMMAND = `${CUDA_TORCH_COMMAND} && ${INSTALL_COMMAND}`;

function serverScriptPath() {
  // desktop/agent/layaRuntime.cjs -> tools/browser-use/laya-server/server.py
  return path.join(__dirname, '..', '..', 'laya-server', 'server.py');
}

function parsePythonVersion(output) {
  const match = String(output || '').match(/Python\s+(\d+)\.(\d+)(?:\.(\d+))?/i);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] || 0)];
}

function isSupportedPython(version) {
  if (!version) return false;
  return version[0] > 3 || (version[0] === 3 && version[1] >= 8);
}

function createLayaRuntime({
  endpoint = DEFAULT_ENDPOINT,
  log = () => {},
  fetchImpl = null,
  now = Date.now,
  readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  runner = null,
  spawnImpl = null,
  hfCacheDir = null,
  autoStartAllowed = () => true,
  restartDelayMs = 5_000
} = {}) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  const doSpawn = spawnImpl || spawn; // tests inject a fake long-lived child spawner
  const cacheDir = hfCacheDir || path.join(require('os').homedir(), '.laya-cache');
  const run = runner || ((command, args, options = {}) => new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(command, args, { windowsHide: true, timeout: options.timeoutMs || 30_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolve({ stdout, stderr });
    });
  }));
  const base = String(endpoint || DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const state = { status: 'idle', reason: '', child: null, progress: null };
  let inflight = null;
  let restartAttempts = 0;
  let restartTimer = null;

  function emit(line) {
    try { log(`[Laya] ${line}`); } catch { }
  }

  function modelDir() {
    return path.join(cacheDir, 'models', 'laya');
  }

  // LORDE_LAYA_CHECKPOINT_RESOLVE_V369 — the HF repo is a checkpoint FAMILY:
  // the root carries shared assets but the loadable checkpoints (with
  // rl_agent_config.json) live in subfolders (e.g. multilingual/). Pointing
  // the sidecar at the root produced "Incompatible model … does not contain
  // rl_agent_config.json". Resolve to the deepest folder that actually holds
  // a loadable checkpoint, falling back to the root for the download flow.
  function resolveModelSource() {
    const root = modelDir();
    if (fs.existsSync(path.join(root, 'rl_agent_config.json'))) return root;
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(root, entry.name);
        if (fs.existsSync(path.join(candidate, 'rl_agent_config.json'))
          && fs.existsSync(path.join(candidate, 'model.safetensors'))) return candidate;
      }
    } catch { /* root may not exist yet — download flow handles it */ }
    return root;
  }

  // The app downloads the checkpoint itself (real byte progress for the
  // dialogue) into cacheDir/models/laya and hands that path to server.py via
  // LAYA_MODEL_PATH. Once both the config and the safetensors exist, later
  // starts load from disk with no network at all.
  function weightsCached() {
    const dir = modelDir();
    return fs.existsSync(path.join(dir, 'model.safetensors')) && fs.existsSync(path.join(dir, 'rl_agent_config.json'));
  }

  async function downloadWeights() {
    const dir = modelDir();
    fs.mkdirSync(dir, { recursive: true });
    const listResponse = await doFetch(HF_API_TREE, {});
    if (!listResponse.ok) throw new Error(`HuggingFace file listing failed (HTTP ${listResponse.status})`);
    const entries = await listResponse.json();
    const files = (Array.isArray(entries) ? entries : []).filter((entry) => entry?.type === 'file' && !HF_SKIP.some((pattern) => pattern.test(entry.path)));
    if (!files.length) throw new Error('HuggingFace file listing returned no files for the checkpoint.');
    const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
    let downloadedBytes = 0;
    state.progress = { phase: 'download', percent: 0, downloadedBytes: 0, totalBytes, file: '' };
    for (const file of files) {
      const size = Number(file.size || 0);
      state.progress.file = file.path;
      const dest = path.join(dir, ...String(file.path).split('/'));
      if (fs.existsSync(dest) && fs.statSync(dest).size === size) {
        downloadedBytes += size;
        state.progress.downloadedBytes = downloadedBytes;
        state.progress.percent = totalBytes ? Math.floor((downloadedBytes / totalBytes) * 100) : 100;
        continue;
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const response = await doFetch(`${HF_RESOLVE}${file.path}`, {});
      if (!response.ok) throw new Error(`Download failed for ${file.path} (HTTP ${response.status})`);
      const chunks = [];
      let fileBytes = 0;
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        chunks.push(buffer);
        fileBytes += buffer.length;
        downloadedBytes += buffer.length;
        state.progress.downloadedBytes = downloadedBytes;
        state.progress.percent = totalBytes ? Math.min(100, Math.floor((downloadedBytes / totalBytes) * 100)) : 100;
      }
      if (size && fileBytes !== size) throw new Error(`Downloaded ${file.path} but got ${fileBytes} of ${size} bytes.`);
      fs.writeFileSync(dest, Buffer.concat(chunks));
    }
    state.progress = { phase: 'download', percent: 100, downloadedBytes, totalBytes, file: '' };
  }

  async function healthy() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const response = await doFetch(`${base}/health`, { signal: controller.signal });
      clearTimeout(timer);
      if (!response.ok) return false;
      const payload = await response.json();
      return payload?.ok === true;
    } catch {
      return false;
    }
  }

  // Metadata-level import probe: find_spec never executes the module, so this
  // stays fast even though `import torch` would take seconds.
  async function detectPackages(pythonCommand) {
    const probe = `import importlib.util as u, json; print(json.dumps({m: u.find_spec(m) is not None for m in ${JSON.stringify(REQUIRED_PACKAGES)}}))`;
    try {
      const { stdout } = await run(pythonCommand[0], [...pythonCommand.slice(1), '-c', probe], { timeoutMs: 30_000 });
      return JSON.parse(String(stdout).trim().split(/\r?\n/).pop());
    } catch {
      return null;
    }
  }

  // Legacy hub-cache detection removed: the app-owned download (above) is the
  // single source of truth for whether the checkpoint is on disk.

  // GPU detection and the CUDA-torch probe are memoized: checkDependencies
  // runs on every dialogue poll, and importing torch to ask about CUDA costs
  // seconds. Hardware detection via nvidia-smi is fast but also stable.
  let gpuCache;
  async function detectGpu() {
    if (gpuCache !== undefined) return gpuCache;
    try {
      const { stdout } = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeoutMs: 10_000 });
      const [name, memory] = String(stdout).split(/\r?\n/)[0].split(',').map((part) => part.trim());
      gpuCache = name ? { name, memory } : null;
    } catch {
      gpuCache = null;
    }
    return gpuCache;
  }

  let torchCudaCache;
  async function torchCudaAvailable(pythonCommand) {
    if (torchCudaCache !== undefined) return torchCudaCache;
    try {
      const { stdout } = await run(pythonCommand[0], [...pythonCommand.slice(1), '-c', 'import torch; print(int(torch.cuda.is_available()))'], { timeoutMs: 120_000 });
      torchCudaCache = String(stdout).trim().endsWith('1');
    } catch {
      torchCudaCache = false;
    }
    return torchCudaCache;
  }

  async function checkDependencies() {
    const checks = [];
    const serverReady = await healthy();
    const gpu = await detectGpu();
    const installCommand = gpu ? CUDA_TORCH_FULL_COMMAND : INSTALL_COMMAND;
    if (serverReady) {
      checks.push({ name: 'Sidecar', ok: true, detail: `running at ${base}` });
      return { checks, allOk: true, serverReady, weightsCached: weightsCached(), pythonCommand: null, installCommand, gpu };
    }
    let pythonCommand = null;
    let version = null;
    for (const candidate of [['py', '-3'], ['python'], ['python3']]) {
      try {
        const { stdout, stderr } = await run(candidate[0], [...candidate.slice(1), '--version'], { timeoutMs: 15_000 });
        version = parsePythonVersion(`${stdout} ${stderr}`);
        if (isSupportedPython(version)) { pythonCommand = candidate; break; }
      } catch { /* try next */ }
    }
    if (!pythonCommand) {
      checks.push({ name: 'Python 3.8+', ok: false, detail: 'not found — install from python.org (check "Add to PATH")' });
      return { checks, allOk: false, serverReady: false, weightsCached: weightsCached(), pythonCommand: null, installCommand, gpu };
    }
    checks.push({ name: 'Python 3.8+', ok: true, detail: `${version.join('.')}` });
    if (gpu) checks.push({ name: 'NVIDIA GPU', ok: true, detail: `${gpu.name}, ${gpu.memory} — the CUDA torch build will be used` });
    const packages = await detectPackages(pythonCommand);
    for (const name of REQUIRED_PACKAGES) {
      const ok = Boolean(packages?.[name]);
      checks.push({ name, ok, detail: ok ? 'installed' : `missing — run: ${installCommand}` });
    }
    // GPU advisory, NOT a gate: a CPU-only torch still runs the checkpoint
    // (laya falls back automatically) — the dialogue recommends the CUDA
    // build but must not block a GPU user who is fine with CPU speed.
    if (gpu && packages?.torch) {
      const cuda = await torchCudaAvailable(pythonCommand);
      checks.push({
        name: 'CUDA torch',
        ok: cuda,
        advisory: true,
        detail: cuda ? 'GPU acceleration active' : `CPU-only build — the model runs, just slower. Recommended: ${CUDA_TORCH_COMMAND}`
      });
    }
    const allOk = checks.filter((check) => !check.advisory).every((check) => check.ok);
    return { checks, allOk, serverReady: false, weightsCached: weightsCached(), pythonCommand, installCommand, gpu };
  }

  function spawnServer(pythonCommand) {
    const script = serverScriptPath();
    if (!fs.existsSync(script)) throw new Error(`laya-server/server.py is missing at ${script}`);
    state.lastSpawnAt = now();
    const child = doSpawn(pythonCommand[0], [...pythonCommand.slice(1), script], {
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', TOKENIZERS_PARALLELISM: 'false', LAYA_MODEL_PATH: resolveModelSource() }
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { if (String(chunk).trim()) emit(String(chunk).trim().slice(0, 300)); });
    child.stderr?.on('data', (chunk) => { if (String(chunk).trim()) emit(String(chunk).trim().slice(0, 300)); });
    child.on('exit', (code) => {
      if (state.status === 'ready') { state.status = 'failed'; state.reason = `sidecar exited (${code}); the bundled engine takes over`; emit(state.reason); }
      state.child = null;
      // Laya stays on until app restart: if it should be running (toggle on or
      // standalone mode) and the weights are on disk, bring it back up. Bounded
      // to two consecutive restarts so a crashing server cannot loop forever.
      if (state.status === 'failed' && restartAttempts < 2 && autoStartAllowed() && weightsCached()) {
        restartAttempts += 1;
        emit(`Restarting the sidecar automatically (attempt ${restartAttempts}/2)…`);
        restartTimer = setTimeout(() => { restartTimer = null; void ensure(); }, restartDelayMs);
      }
    });
    return child;
  }

  async function waitReady(deadline) {
    while (now() < deadline) {
      if (await healthy()) return true;
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
    }
    return false;
  }

  // Consent-gated start: only invoked from the settings dialogue after the
  // dependency checks passed. Downloads the weights on first start.
  async function ensure() {
    if (state.status === 'ready' || await healthy()) {
      state.status = 'ready';
      state.reason = '';
      return { ok: true, endpoint: base };
    }
    if (inflight) return inflight;
    state.status = 'checking';
    inflight = (async () => {
      // The user may have installed packages since the last check; re-probe.
      torchCudaCache = undefined;
      const deps = await checkDependencies();
      if (deps.serverReady) {
        state.status = 'ready';
        state.reason = '';
        return { ok: true, endpoint: base };
      }
      if (!deps.allOk) throw new Error('Dependencies are missing — the full-model download stays locked until Python and the packages are detected.');
      if (!weightsCached()) {
        // The app owns the download so the dialogue gets real byte progress.
        state.status = 'downloading';
        emit('Downloading the Laya checkpoint (~850MB, one time)…');
        await downloadWeights();
        emit('Checkpoint downloaded; starting the sidecar…');
      }
      state.status = 'starting';
      state.child = spawnServer(deps.pythonCommand);
      if (await waitReady(now() + readyTimeoutMs)) {
        state.status = 'ready';
        state.reason = '';
        state.progress = null;
        // Only a STABLE run earns fresh restart budget: a sidecar that becomes
        // healthy and then crashloops quickly must stay bounded.
        if (now() - (state.lastSpawnAt || 0) >= 60_000) restartAttempts = 0;
        emit(`Laya full model ready (${base}).`);
        return { ok: true, endpoint: base };
      }
      throw new Error(`Sidecar did not become healthy within ${Math.round(readyTimeoutMs / 60_000)} minutes (model load may be slow). The bundled engine answers meanwhile; retry from settings.`);
    })()
      .then((result) => { inflight = null; return result; })
      .catch((error) => {
        inflight = null;
        state.status = 'failed';
        state.reason = String(error?.message || error).slice(0, 400);
        emit(`Full model not started — the bundled engine answers instead. ${state.reason}`);
        return { ok: false, reason: state.reason };
      });
    return inflight;
  }

  // Auto-start for the dropdown toggle and app startup: runs WITHOUT the
  // explicit download click, but only when laya is actually wanted AND
  // everything needed is already on disk — a fresh weights download still
  // requires the settings-dialogue consent. Fire and forget: the run proceeds
  // on the bundled engine until the model is ready.
  async function maybeAutoStart() {
    if (!autoStartAllowed()) return { ok: false, reason: 'laya is not enabled' };
    if (state.status === 'ready' || state.child || restartTimer) return { ok: state.status === 'ready', endpoint: base };
    const deps = await checkDependencies();
    if (!deps.allOk || !deps.weightsCached) return { ok: false, reason: deps.allOk ? 'weights not downloaded yet — consent required in settings' : 'dependencies missing' };
    return ensure();
  }

  function stop() {
    if (state.child) {
      try { state.child.kill(); } catch { }
      state.child = null;
    }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    restartAttempts = 0;
    state.status = 'idle';
    state.progress = null;
  }

  // IPC-safe: only plain JSON. Never spread `state` — it holds the live child
  // process, which structuredClone (Electron IPC) cannot serialize.
  function status() {
    return {
      status: state.status,
      reason: state.reason,
      progress: state.progress ? { ...state.progress } : null,
      endpoint: base
    };
  }

  return { ensure, maybeAutoStart, stop, healthy, checkDependencies, status };
}

module.exports = { createLayaRuntime, parsePythonVersion, isSupportedPython, serverScriptPath, REQUIRED_PACKAGES, INSTALL_COMMAND, CUDA_TORCH_COMMAND, DEFAULT_ENDPOINT };
