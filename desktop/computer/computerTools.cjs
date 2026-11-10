'use strict';

const { fileOperation } = require('./fileOperations.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { fork, spawn } = require('node:child_process');
const { validateComputerInput, normalizeComputerInput } = require('./computerCatalog.cjs');
const { mapPointerInput } = require('./pointerGesture.cjs');
const { defaultShell } = require('../terminal/shellPreference.cjs');
const { WorkspaceChangeGuard } = require('./workspaceChangeGuard.cjs');
const fs = require('node:fs');
const OUTPUT_LIMIT = 256_000;
const pageLimit = (value, fallback, max) => Math.min(max, Math.max(1, Math.floor(value ?? fallback)));
// Honest git failures: ENOENT means the binary is missing, a kill means the
// ceiling hit, anything else surfaces git's own stderr.
function gitError(argv, error, stderr) {
  if (error.code === 'ENOENT') return new Error('Git is not installed or not on PATH; install git to use computer_git.');
  if (error.killed) return new Error('The git command timed out after 30 seconds.');
  const detail = String(stderr || error.message).trim().slice(0, 2000);
  return new Error(`git ${argv[0]} failed: ${detail || 'unknown error'}`);
}
async function waitForJob(job, waitMs) {
  if (job.state !== 'running' || waitMs <= 0) return;
  let timer;
  try { await Promise.race([job.completion, new Promise(resolve => { timer = setTimeout(resolve, Math.min(20000, waitMs)); })]); }
  finally { clearTimeout(timer); }
}

class ComputerTools {
  constructor({ executablePath = process.execPath, terminal = null, capture = null, clipboard = null, nativeRequest = null, workspaceGuard = new WorkspaceChangeGuard(), androidManager = null, androidSurface = null } = {}) {
    this.executablePath = executablePath;
    this.terminal = terminal;
    this.capture = capture;
    this.clipboard = clipboard;
    this.closed = false;
    this.nativeOverride = nativeRequest;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.owners = new Map();
    this.jobs = new Map();
    this.terminals = new Map();
    // owner -> virtual transcript session id. Every execute command and its
    // streamed output are mirrored into it so the user watches native work in
    // the docked panel; the model never has to manage a session for visibility.
    this.activitySessions = new Map();
    this.workspaceGuard = workspaceGuard;
    this.androidManager = androidManager;
    this.androidSurface = typeof androidSurface === 'function' ? androidSurface : () => null;
  }

  // One visible activity transcript per owner. Reused across executes; created
  // lazily and silently skipped when the broker is unavailable — mirroring is
  // a visibility affordance and must never break or delay execution itself.
  async activitySession(ownerId, cwd) {
    const existing = this.activitySessions.get(ownerId);
    if (existing && this.terminal?.snapshot(existing)) return existing;
    if (existing) { this.terminals.delete(existing); this.activitySessions.delete(ownerId); }
    if (!this.terminal) return null;
    const created = await this.terminal.create({ cwd, virtual: true });
    this.terminals.set(created.id, ownerId);
    this.activitySessions.set(ownerId, created.id);
    return created.id;
  }

  // Agent-owned interactive sessions surface in the docked terminal panel
  // (badged, watchable) while the owning run is alive. Ownership blocks user
  // keystrokes into the agent's session while its run is active. The stable
  // conversation mapping survives between turns; agentOwnerActive unlocks the
  // panel between runs, and explicit retirement disposes the process.
  isAgentOwned(sessionId) { return this.terminals.has(String(sessionId || '')); }

  agentSessionOwner(sessionId) { return this.terminals.get(String(sessionId || '')) || null; }

  agentOwnedSessions() { return [...this.terminals.entries()].map(([sessionId, owner]) => ({ sessionId, owner })); }

  retainedAgentSessions(owner) {
    // agentOwnerActive() controls the panel's per-run write lock. The stable
    // conversation capability persists until explicit close, cancellation,
    // retirement, process exit, or releaseOwner cleanup.
    return [...this.terminals.values()].filter((entryOwner) => entryOwner === owner).length;
  }

  forgetTerminalSession(sessionId) { return this.terminals.delete(String(sessionId || '')); }


  replaceTerminalSession(previousId, nextId) {
    const owner = this.terminals.get(String(previousId || ''));
    if (!owner) return false;
    this.terminals.delete(String(previousId));
    this.terminals.set(String(nextId), owner);
    for (const [entryOwner, sessionId] of this.activitySessions) if (sessionId === String(previousId)) this.activitySessions.set(entryOwner, String(nextId));
    return true;
  }

  owner(id) {
    if (!id) throw new Error('Computer tools require an authenticated owner.');
    if (!this.owners.has(id)) this.owners.set(id, { generation: 0 });
    return this.owners.get(id);
  }

  async execute(name, input = {}, ownerId, options = {}) {
    const { signal, nativeScan = false, onProgress = null } = options || {};
    if (this.closed) throw new Error('Computer backend is shutting down.');
    input = normalizeComputerInput(name, input);
    validateComputerInput(name, input);
    // LORDE_TELEMETRY_PROBE_V1 — a harness-internal telemetry probe is NOT a
    // model action. It must never be counted as an executed tool call, so it
    // runs on the telemetry path: no model owner registration, no per-owner
    // accounting, no evidence entry. The window list it needs is identical to
    // the model-facing computer_window list, so the probe still sees the
    // dialog it is looking for.
    if (nativeScan && name === 'computer_window' && input.action === 'list') {
      return this.scanWindows(ownerId, { signal });
    }
    const owner = nativeScan ? { generation: 0 } : this.owner(ownerId), epoch = owner.generation;
    if (owner.cleanup) throw new Error('Computer-session cleanup is still in progress.');
    const check = () => { if (owner.generation !== epoch || signal?.aborted) throw new Error('Computer operation cancelled.'); };
    check();
    const abort = () => { void this.releaseOwner(ownerId).catch(() => {}); };
    // A telemetry probe must never release the MODEL's computer session when
    // its own signal aborts — that would kill the run's live native input.
    if (!nativeScan) signal?.addEventListener('abort', abort, { once: true });
    try {
      let result;
      if (name === 'computer_read') result = await this.readTool(input, check, ownerId);
      else if (name === 'computer_write') result = await this.writeTool(input, check, ownerId);
      else if (name === 'computer_search') result = await this.searchTool(input, check, ownerId);
      else if (name === 'computer_index') result = await this.indexTool(input, check, ownerId);
      else if (name === 'computer_fs') result = await this.fsTool(input, check, ownerId);
      else if (name === 'computer_fs_batch') result = await this.fsBatch(input, check, ownerId);
      // Hidden compat: computer_file is retired from the model-facing catalog
      // (tests and sandbox lanes still call the backend directly).
      else if (name === 'computer_file') result = { deprecated: 'computer_file is retired for the model. Use computer_read, computer_write, computer_search, computer_fs, or computer_patch.', ...(await this.fileCompat(input, check, ownerId)) };
      else if (name === 'computer_patch') result = await this.patch(input, check, ownerId, onProgress);
      else if (name === 'computer_patch_live') result = await this.patch({ ...input, patch: undefined }, check, ownerId, onProgress);
      else if (name === 'computer_patch_chunk') result = await this.patchChunk(input, check, ownerId);
      else if (name === 'computer_git') result = await this.git(input, check, ownerId);
      else if (name === 'computer_terminal') result = await this.shell(input, ownerId, check);
      else if (name === 'computer_clipboard') {
        if (!this.clipboard) throw new Error('System clipboard is unavailable.');
        if (input.action === 'write') {
          if (typeof input.text !== 'string') throw new Error('Clipboard write requires text.');
          check(); this.clipboard.writeText(input.text); result = { writtenCharacters: input.text.length };
        } else { const text = this.clipboard.readText(); result = { text: text.slice(0, 64_000), truncated: text.length > 64_000 }; }
      } else if (name === 'computer_screenshot') {
        if (!this.capture) throw new Error('Desktop capture is unavailable.');
        result = { ...await this.capture.screenshot(input), screenshotId: crypto.randomUUID() }; check();
        const { data, ...mapping } = result;
        owner.screenshot = mapping;
      } else if (name === 'computer_record') {
        if (!this.capture) throw new Error('Desktop recording is unavailable.');
        if (input.action === 'frames') {
          // VIDEO-TO-FRAMES on ANY recording: a vision model cannot watch
          // video, so decode N evenly-spaced frames it CAN view as images.
          result = await this.capture.extractFrames(input);
        } else {
          result = await this.capture.record(input, ownerId, check);
          // Model-chosen frames on stop: the recording becomes viewable
          // evidence in the SAME call instead of requiring a separate decode.
          if (input.action === 'stop' && Number(input.frames) > 0 && result?.path && result.state === 'completed') {
            try {
              const extraction = await this.capture.extractFrames({ path: result.path, count: Number(input.frames), width: Number(input.frameWidth) || 1024 });
              result.frames = extraction.frames;
              result.frameNote = extraction.note;
            } catch (error) { result.frameError = String(error?.message || error).slice(0, 200); }
          }
        }
      } else if (name === 'computer_pointer' && this.androidManager) {
        const surface = this.androidSurface();
        if (surface?.serial && (input.action === 'click' || input.action === 'drag')) {
          result = await this.androidManager.handlePointer({
            serial: surface.serial,
            action: input.action,
            x: input.x, y: input.y, endX: input.endX, endY: input.endY,
            displayWidth: surface.width, displayHeight: surface.height,
            deviceWidth: surface.deviceWidth, deviceHeight: surface.deviceHeight
          });
        } else {
          const nativeName = name === 'computer_stroke' ? 'computer_pointer' : name;
          result = await this.native(nativeName, input, ownerId);
        }
      } else {
        const nativeName = name === 'computer_stroke' ? 'computer_pointer' : name;
        const pointerInput = name === 'computer_stroke' ? { ...input, action: 'stroke' } : input;
        const nativeInput = nativeName === 'computer_pointer' ? mapPointerInput(pointerInput, owner.screenshot, input.coordinateSpace === 'screenshot' ? this.capture?.displays() : undefined) : input;
        result = await this.native(nativeName, nativeInput, ownerId);
        if (name === 'computer_observe' && this.capture) result.displays = this.capture.displays();
        if (name === 'computer_window' && input.action === 'list' && Number(input.waitMs) > 0) {
          result = await this.waitForNewWindow(result, input, ownerId, check);
          if (this.capture) result.displays = this.capture.displays();
        }
      }
      check(); return result;
    } finally { signal?.removeEventListener('abort', abort); }
  }

  // HARNESS TELEMETRY, deliberately NOT execute(): a probe that rides the
  // model tool-call entry point is counted as an executed model action by
  // every backend and every evidence ledger watching that surface — exactly
  // what a telemetry probe must never be. This path reads the native window
  // list directly: no owner registration, no per-owner accounting, no tool
  // result, nothing the model can mistake for its own action. The payload is
  // the same window list the model-facing computer_window list returns, so a
  // dialog detector still sees the dialog it is looking for.
  async scanWindows(ownerId, options = {}) {
    const { signal } = options || {};
    if (this.closed) throw new Error('Computer backend is shutting down.');
    const check = () => { if (signal?.aborted) throw new Error('Computer operation cancelled.'); };
    check();
    const result = await this.native('computer_window', { action: 'list' }, ownerId);
    check();
    return result;
  }

  native(name, input, owner) {
    if (this.nativeOverride) return this.nativeOverride(name, input, owner);
    if (process.platform !== 'win32') return Promise.reject(new Error('Native desktop input requires Windows.'));
    this.ensureNativeWorker();
    const child = this.child;
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Invalidate queued input before returning a timeout. The helper checks
        // cancellation between drag/text segments and releases this owner only.
        if (name !== 'release' && child.connected) child.send({ name: 'release', owner }, () => {});
        reject(new Error(`Native ${name} timed out.`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      child.send({ id, name, input, owner }, error => {
        if (!error) return;
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  // The native helper is a forked Electron-as-Node process: forking it on the
  // FIRST pointer action adds a cold 100-300ms stall exactly when the agent is
  // mid-task. warmup() starts it (and probes ripgrep) at bridge startup —
  // pure latency win, no behavior change.
  ensureNativeWorker() {
    if (this.child) return this.child;
    const child = fork(path.join(__dirname, 'nativeWorker.cjs'), [], {
      execPath: this.executablePath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
    });
    this.child = child;
    let errorTail = '';
    child.stderr?.on('data', data => { errorTail = (errorTail + data).slice(-2000); });
    child.on('message', message => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error)); else pending.resolve(message.result);
    });
    const fail = error => {
      if (this.child !== child) return;
      this.child = null;
      for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
      this.pending.clear();
    };
    child.on('error', fail);
    child.on('exit', (code, signal) => fail(new Error(`Native helper exited (${code ?? signal}). ${errorTail}`)));
    return child;
  }

  warmup() {
    try { if (process.platform === 'win32' && !this.nativeOverride) this.ensureNativeWorker(); } catch { /* warmup is best effort */ }
    try { this.ripgrepAvailable(); } catch { /* warmup is best effort */ }
  }

  async observe(ownerId, options = {}) {
    const desktop = await this.execute('computer_observe', {}, ownerId, options);
    desktop.jobs = [...this.jobs.values()].filter(job => job.owner === ownerId).slice(-12).map(job => ({ id: job.id, state: job.state, exitCode: job.exitCode }));
    return desktop;
  }

  // Launch-detection settle: an application window usually appears seconds
  // AFTER its launcher process exits, so an instant list right after a launch
  // races startup and reads as a failed launch (driving launch-retry flail).
  // With waitMs, poll native observations until a window id absent from the
  // first snapshot appears, or the bound expires. Cancellable, bounded, and
  // honest: the result always reports whether a new window was seen.
  async waitForNewWindow(first, input, ownerId, check) {
    const known = new Set(first.windows.map(window => window.id));
    const bound = Math.min(30_000, Math.max(0, Number(input.waitMs) || 0));
    if (!bound) return first;
    const startedAt = Date.now();
    const deadline = startedAt + bound;
    let latest = first;
    while (Date.now() < deadline) {
      check();
      await new Promise(resolve => setTimeout(resolve, 300));
      check();
      latest = await this.observe(ownerId);
      const added = latest.windows.filter(window => !known.has(window.id)).map(window => window.id);
      if (added.length) {
        return { ...latest, newWindowIds: added, waitedMs: Date.now() - startedAt, settled: true };
      }
    }
    return { ...latest, newWindowIds: [], waitedMs: Date.now() - startedAt, settled: false };
  }

  // Diff capture for computer_file mutations: read the text before and after
  // (1 MB utf8 cap; binary/base64 payloads are skipped), then attach the same
  // structured diff shape computer_patch returns so ONE renderer draws both.
  async fileDiff(input, check, before) {
    const { computeLineDiff, MAX_FILE_BYTES } = require('./applyPatch.cjs');
    const readText = async () => {
      try {
        const stat = await fs.promises.stat(input.path);
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
        const buffer = await fs.promises.readFile(input.path);
        if (buffer.includes(0)) return null;
        return buffer.toString('utf8').replace(/\r\n/g, '\n');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        return null;
      }
    };
    const after = await readText();
    if (before === null && after === null) return null;
    const diff = computeLineDiff(before ?? '', after ?? '');
    if (!diff.addedLines && !diff.removedLines) return null;
    const action = before === null ? 'add' : after === null ? 'delete' : 'update';
    return { files: [{ path: input.path, action, addedLines: diff.addedLines, removedLines: diff.removedLines, truncated: diff.truncated, diff: diff.chunks }] };
  }

  // Retired computer_file behavior, kept for direct backend callers (tests,
  // sandbox lanes, older MCP sessions). The model no longer sees this tool.
  async fileCompat(input, check, owner = 'computer') {
    if (input.action === 'search' && input.pattern) {
      const search = await this.searchTool({ pattern: input.pattern, path: input.path, output: 'content', maxResults: Math.min(Number(input.limit) || 40, 100) }, check, owner);
      return { ok: true, action: 'search', root: search.root, matches: search.matches, results: (search.lines || []).map(line => ({ path: line.file, line: line.line, snippet: String(line.text || '').trim().slice(0, 200) })) };
    }
    if (['read', 'stat'].includes(input.action)) {
      const result = await fileOperation(input, check);
      const ownership = input.action === 'read' ? await this.workspaceGuard.noteRead(owner, input.path) : null;
      return { ...result, ...(ownership ? { workspace: { root: ownership.root, path: ownership.relative, hash: ownership.hash } } : {}) };
    }
    const mutateText = ['write', 'append', 'edit', 'delete'].includes(input.action) && input.encoding !== 'base64';
    let before = null;
    if (mutateText) {
      try {
        const stat = await fs.promises.stat(input.path);
        if (stat.isFile() && stat.size <= 1_000_000) {
          const buffer = await fs.promises.readFile(input.path);
          if (!buffer.includes(0)) before = buffer.toString('utf8');
        }
      } catch { before = null; }
    }
    const guard = await this.workspaceGuard.beforeMutation(owner, input);
    const result = await fileOperation(input, check);
    const diff = mutateText ? await this.fileDiff(input, check, before) : null;
    const workspace = await this.workspaceGuard.afterMutation(guard, input);
    return { ...result, ...(diff ? { files: diff.files } : {}), ...(workspace ? { workspace } : {}) };
  }

  // computer_read: ONE call reads a whole text file with 1-based line numbers
  // (cat -n format, the Claude Code Read contract). Continuations carry
  // nextOffset instead of the model guessing offsets — this is what replaces
  // the old fragmented read loops (up to 20 read calls for one file).
  async readTool(input, check, owner = 'computer') {
    const target = String(input.path || '');
    check();
    let stat;
    try { stat = await fs.promises.stat(target); } catch {
      throw new Error(`computer_read: file not found: ${target}`);
    }
    if (stat.isDirectory()) throw new Error(`computer_read: ${target} is a directory. Use computer_fs (action=list) or computer_search.`);
    // base64 mode: ANY file (images, binaries) paged by BYTES — the retired
    // computer_file's binary-read capability, kept for asset work.
    if (input.encoding === 'base64') {
      // IMAGE READS DO NOT BELONG IN THE CONTEXT (run-forensics 2026-10-15,
      // corroborated by 2 audits): the model cannot decode base64 bytes into
      // vision — one run spent 4 reads × 1.47MB (~3.3MB of context) on a PNG
      // it could not see, then described the page from imagination. Images
      // route to a tab + browser_screenshot (or computer_screenshot for native
      // surfaces); genuine asset work opts back in with bytesOnly:true.
      const imageExt = /^png|jpe?g|gif|webp|bmp|svg|ico|avif$/i.test(path.extname(target).replace('.', ''));
      if (imageExt && input.bytesOnly !== true) {
        const ownership = await this.workspaceGuard.noteRead(owner, target);
        return {
          ok: true, tool: 'computer_read', path: target, kind: 'image',
          totalBytes: stat.size,
          note: 'Image bytes are NOT visually decodable from base64 text — returning them would only burn context without letting you see anything. To EDIT this image with AI: computer_model kind=image imagePath=<this file> (+ saveTo for the output file) — the harness attaches the bytes, never your context. To SEE it: browser_navigate a file:/// URL to it and browser_screenshot the tab (or computer_screenshot if a native app renders it). bytesOnly:true is only for copying/uploading raw bytes — never for viewing or editing.',
          ...(ownership ? { workspace: { root: ownership.root, path: ownership.relative, hash: ownership.hash } } : {})
        };
      }
      const raw = await fs.promises.readFile(target);
      const byteOffset = Math.max(0, Math.min(Number(input.offset) || 0, raw.length));
      const byteLimit = Math.min(Math.max(1, Number(input.limit) || 524_288), 1_048_576);
      const slice = raw.subarray(byteOffset, byteOffset + byteLimit);
      const lastByte = byteOffset + slice.length;
      const ownership = await this.workspaceGuard.noteRead(owner, target);
      return {
        ok: true, tool: 'computer_read', path: target, encoding: 'base64',
        totalBytes: raw.length, fromByte: byteOffset, toByte: lastByte, bytes: slice.length,
        content: slice.toString('base64'),
        truncated: lastByte < raw.length,
        ...(lastByte < raw.length ? { nextOffset: lastByte, note: `File continues at byte ${lastByte}. Re-call with offset ${lastByte} to continue.` } : {}),
        ...(ownership ? { workspace: { root: ownership.root, path: ownership.relative, hash: ownership.hash } } : {})
      };
    }
    if (stat.size > 2_000_000) throw new Error(`computer_read: file too large (${stat.size} bytes; cap 2,000,000). Read ranges with offset/limit.`);
    const raw = await fs.promises.readFile(target);
    if (raw.includes(0)) throw new Error('computer_read: file is binary; re-call with encoding=base64 to read it.');
    const lines = raw.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const totalLines = lines.length;
    const offset = Math.max(1, Math.min(Number(input.offset) || 1, Math.max(1, totalLines)));
    const limit = Math.min(Math.max(1, Number(input.limit) || 2_000), 2_000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const content = slice.map((line, index) => `${String(offset + index).padStart(6, ' ')}\t${line}`).join('\n');
    const lastLine = offset - 1 + slice.length;
    const ownership = await this.workspaceGuard.noteRead(owner, target);
    // Session read ledger ("never forgets"): a re-read of unchanged content
    // is flagged, so the model quotes held evidence instead of paying another
    // read — and the harness sees the repeat as a loop signal.
    this._readLedger ||= new Map();
    const readLedger = this._readLedger.get(owner) || new Map();
    this._readLedger.set(owner, readLedger);
    const contentHash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
    const priorRead = readLedger.get(target);
    let unchangedNotice;
    if (priorRead && priorRead.hash === contentHash && priorRead.toLine >= lastLine) {
      unchangedNotice = `Unchanged since your earlier read covering lines ${priorRead.fromLine}-${priorRead.toLine} this session (hash ${contentHash}). If compaction dropped the content, use this result now; otherwise quote the held evidence instead of re-reading.`;
    }
    readLedger.set(target, priorRead && priorRead.hash === contentHash
      ? { hash: contentHash, fromLine: Math.min(priorRead.fromLine, offset), toLine: Math.max(priorRead.toLine, lastLine) }
      : { hash: contentHash, fromLine: offset, toLine: lastLine });
    return {
      ok: true, tool: 'computer_read', path: target,
      totalLines, fromLine: offset, toLine: lastLine, lines: slice.length,
      content,
      truncated: lastLine < totalLines,
      ...(lastLine < totalLines ? { nextOffset: lastLine + 1, note: `File continues at line ${lastLine + 1}. Re-call with offset ${lastLine + 1} to continue — do NOT restart from line 1.` } : {}),
      ...(unchangedNotice ? { notice: unchangedNotice } : {}),
      ...(ownership ? { workspace: { root: ownership.root, path: ownership.relative, hash: ownership.hash } } : {})
    };
  }

  // computer_write: create/overwrite/append ONE text file. Same ownership
  // guard and line-diff attachment the old computer_file mutations had.
  async writeTool(input, check, owner = 'computer') {
    const mode = input.mode === 'append' ? 'append' : 'write';
    const isBinary = input.encoding === 'base64';
    check();
    let before = null;
    if (!isBinary) {
      try {
        const stat = await fs.promises.stat(input.path);
        if (stat.isFile() && stat.size <= 1_000_000) {
          const buffer = await fs.promises.readFile(input.path);
          if (!buffer.includes(0)) before = buffer.toString('utf8');
        }
      } catch { before = null; }
    }
    const guard = await this.workspaceGuard.beforeMutation(owner, { ...input, action: mode });
    // Binary payloads (base64) write raw bytes — the retired computer_file's
    // binary-write capability, kept for asset work.
    if (isBinary) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(String(input.content || ''))) {
        throw new Error('computer_write: invalid base64 file content.');
      }
      const data = Buffer.from(String(input.content || ''), 'base64');
      check();
      if (input.createParents === true) fs.mkdirSync(path.dirname(input.path), { recursive: true });
      if (mode === 'append') fs.appendFileSync(input.path, data);
      else fs.writeFileSync(input.path, data);
      const written = fs.statSync(input.path).size;
      const workspace = await this.workspaceGuard.afterMutation(guard, input);
      return { ok: true, tool: 'computer_write', mode, path: input.path, encoding: 'base64', bytes: data.length, written, changed: true, ...(workspace ? { workspace } : {}) };
    }
    const result = await fileOperation({ action: mode, path: input.path, content: input.content, createParents: input.createParents === true, acknowledgeExistingChanges: input.acknowledgeExistingChanges, expectedHash: input.expectedHash }, check);
    const diff = await this.fileDiff({ path: input.path }, check, mode === 'append' ? (before ?? '') : before);
    const workspace = await this.workspaceGuard.afterMutation(guard, input);
    return { ok: true, tool: 'computer_write', mode, ...(result || {}), ...(diff ? { files: diff.files } : {}), ...(workspace ? { workspace } : {}) };
  }

  // computer_search: the Grep-equivalent. Ripgrep-backed (async — the old
  // search ran execSync and froze the whole app) with a bounded JS-walker
  // fallback. output=content returns file:line:text ± context; output=files
  // returns matching paths. ONE call replaces terminal grep/findstr sessions
  // and file-by-file reads. mode=definition expands the pattern into a
  // function/method definition regex (handles `function foo(`, `foo(`,
  // `foo: function`, `foo: async function`, `async foo(`, `foo: async (`, etc.)
  // so the caller finds the DEFINITION + all callers in one call.
  async searchTool(input, check, owner = 'computer') {
    const root = path.resolve(String(input.path || process.cwd()));
    const pattern = String(input.pattern || '');
    if (!pattern) throw new Error('computer_search requires a regex pattern.');
    // LORDE_FIND_DEF_V1 — definition mode: wrap the symbol name in a regex that
    // matches every common definition form (function, method, arrow, property).
    const isDefMode = String(input.mode || '').toLowerCase() === 'definition';
    const effectivePattern = isDefMode
      ? `(?:function\\s+|async\\s+function\\s+|const\\s+|let\\s+|var\\s+|(?:^|[.\\s]))${pattern}\\s*[=(:]|${pattern}\\s*:\\s*(?:async\\s+)?(?:function|\\()`
      : pattern;
    // LORDE_REGEX_FLAGS_V1 — JavaScript RegExp does not support inline (?i)
    // (?s) (?m) flags that models pick up from Rust/Python/Go regex syntax.
    // Strip them and map to the RegExp flags argument. Invalid groups like
    // (?i) cause "Invalid group" errors.
    let cleanedPattern = effectivePattern;
    let inlineIgnoreCase = false;
    cleanedPattern = cleanedPattern.replace(/\(\?([imsx]+)\)/g, (_match, flags) => {
      if (flags.includes('i')) inlineIgnoreCase = true;
      return '';
    });
    let regex;
    try { regex = new RegExp(cleanedPattern, (input.caseSensitive ? '' : 'i') || (inlineIgnoreCase ? 'i' : '')); } catch (error) {
      throw new Error(`computer_search pattern is not a valid regex: ${error.message}`);
    }
    const outputMode = input.output === 'files' ? 'files' : 'content';
    const maxResults = Math.min(Math.max(1, Number(input.maxResults) || 120), 500);
    const contextLines = Math.min(Math.max(0, Number(input.context) || 0), 10);
    const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : null;
    check();
    const rootStat = await fs.promises.stat(root).catch(() => null);
    if (!rootStat) throw new Error(`computer_search: path not found: ${root}`);
    if (rootStat.isFile()) {
      const single = await this.searchSingleFile(root, regex, contextLines);
      return { ok: true, tool: 'computer_search', root, pattern: effectivePattern, outputMode, matches: single.filter(line => line.match).length, lines: single, truncated: false, ...(this.searchRepeatNotice(owner, { root, pattern: effectivePattern, outputMode, glob, contextLines }, single.filter(line => line.match).length) || {}) };
    }
    if (await this.ripgrepAvailable()) {
      const searched = await this.searchWithRipgrep({ root, pattern: effectivePattern, glob, outputMode, maxResults, contextLines, caseSensitive: input.caseSensitive === true });
      check();
      return { ok: true, tool: 'computer_search', engine: 'ripgrep', root, pattern: effectivePattern, outputMode, ...searched, ...(this.searchRepeatNotice(owner, { root, pattern: effectivePattern, outputMode, glob, contextLines }, searched.matches) || {}) };
    }
    const searched = await this.searchWithWalker({ root, regex, glob, outputMode, maxResults, contextLines }, check);
    check();
    return { ok: true, tool: 'computer_search', engine: 'walker', root, pattern: effectivePattern, outputMode, ...searched, ...(this.searchRepeatNotice(owner, { root, pattern: effectivePattern, outputMode, glob, contextLines }, searched.matches) || {}) };
  }

  // Repeat-search memory ("never forgets"): an identical search against the
  // same unchanged scope already returned its answer this session. Also
  // catches REWORDED near-duplicates — a marathon conversation can burn
  // hundreds of searches re-phrasing the same question (341 searches in one
  // 250-minute run) without ever matching the exact-key flag.
  searchRepeatNotice(owner, { root, pattern, outputMode, glob, contextLines }, matches) {
    this._searchLedger ||= new Map();
    const ledger = this._searchLedger.get(owner) || [];
    this._searchLedger.set(owner, ledger);
    const key = JSON.stringify([root, pattern, outputMode, glob, contextLines]);
    const tokensOf = (text) => new Set(String(text || '').toLowerCase().match(/[a-z0-9_#.-]{3,}/g) || []);
    const tokens = tokensOf(pattern);
    let prior = ledger.find(entry => entry.key === key);
    if (!prior && outputMode === 'content' && tokens.size >= 2) {
      // Fuzzy near-duplicate: >=70% of this query's tokens appeared in a
      // recent search on the same root. Distinct new symbols still pass.
      for (let i = ledger.length - 1; i >= 0 && !prior; i--) {
        const entry = ledger[i];
        if (entry.root !== root || entry.outputMode !== outputMode) continue;
        const priorTokens = entry.tokens || [];
        if (!priorTokens.length) continue;
        let overlap = 0;
        for (const token of tokens) if (priorTokens.includes(token)) overlap += 1;
        if (overlap / tokens.size >= 0.7) prior = { key: entry.key, matches: entry.matches, nearPattern: entry.pattern };
      }
    }
    if (!ledger.some(entry => entry.key === key)) ledger.push({
      key, matches, root, outputMode, pattern,
      tokens: [...tokens].slice(0, 24),
      glob, contextLines
    });
    if (ledger.length > 30) ledger.splice(0, ledger.length - 30);
    if (prior && prior.nearPattern) {
      return { notice: `Near-duplicate of your earlier search "${String(prior.nearPattern).slice(0, 80)}" (${prior.matches} matches, held evidence). Quote or build on those results instead of re-phrasing the same question.` };
    }
    return prior
      ? { notice: `Identical search already returned ${prior.matches} matches this session. Those results are held evidence — decide from them; do not repeat this query.` }
      : null;
  }

  async ripgrepAvailable() {
    if (this._rgChecked === undefined) {
      this._rgChecked = await new Promise((resolve) => {
        const probe = require('node:child_process').spawn('rg', ['--version'], { windowsHide: true, stdio: 'ignore' });
        probe.once('error', () => resolve(false));
        probe.once('close', code => resolve(code === 0));
      });
    }
    return this._rgChecked;
  }

  async searchWithRipgrep({ root, pattern, glob, outputMode, maxResults, contextLines, caseSensitive }) {
    const { execFile } = require('node:child_process');
    const args = ['--json', '--max-count', '5000', '--no-ignore-vcs', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/build/**', '--glob', '!**/.git/**'];
    if (glob) args.push('--glob', glob);
    if (!caseSensitive) args.push('--ignore-case');
    if (contextLines > 0 && outputMode === 'content') args.push('--context', String(contextLines));
    args.push('--regexp', pattern, root);
    const stdout = await new Promise((resolve, reject) => {
      const child = execFile('rg', args, { windowsHide: true, maxBuffer: 32_000_000, timeout: 30_000 }, (error, out) => {
        // rg exits 1 when there are NO matches — that is success here.
        if (error && error.code !== 1) reject(new Error(`ripgrep failed: ${String(error.message || error).slice(0, 300)}`));
        else resolve(String(out || ''));
      });
      this._rgChild?.kill();
      this._rgChild = child;
    }).finally(() => { this._rgChild = null; });
    const lines = [];
    const files = new Map();
    for (const row of stdout.split('\n')) {
      if (!row.trim()) continue;
      let event = null;
      try { event = JSON.parse(row); } catch { continue; }
      if (event?.type !== 'match' && event?.type !== 'context') continue;
      const data = event.data || {};
      const file = String(data.path?.text ?? '');
      if (!file) continue;
      if (outputMode === 'files') { files.set(file, (files.get(file) || 0) + 1); continue; }
      lines.push({
        file,
        line: Number(data.line_number) || 0,
        text: String(data.lines?.text ?? '').replace(/\r?\n$/, ''),
        match: event.type === 'match'
      });
    }
    if (outputMode === 'files') return rankFileMatches(files, maxResults, root);
    const capped = lines.slice(0, maxResults);
    const truncated = lines.length > capped.length;
    return { lines: capped, matches: capped.filter(line => line.match).length, truncated, ...(truncated ? { allLines: lines } : {}) };
  }

  // computer_index: a real per-line inverted index (Listary/Everything model,
  // in-process). EVERY text file — docs, code, CSS, JSON — is tokenized line
  // by line ONCE per session and kept in postings (token -> [file:line]),
  // cached per file by mtime+size so rebuilds re-tokenize only changed files.
  // Two modes:
  //   query=<terms>  -> ranked file:line hits with snippets, milliseconds,
  //                     across the whole corpus INCLUDING docs — one call
  //                     replaces chains of sequential searches.
  //   map mode       -> the structural overview (symbols/headers/selectors),
  //                     ranked by task-goal overlap; docs compete equally
  //                     (they carry this repo's persistent-bug history).
  async indexTool(input, check, owner = 'computer') {
    const startedAt = Date.now();
    const root = path.resolve(String(input.path || process.cwd()));
    const singleFile = typeof input.file === 'string' && input.file.trim() ? path.resolve(input.file.trim()) : null;
    const maxChars = Math.min(Math.max(1, Number(input.maxChars) || 12_000), 40_000);
    const norm = token => String(token).replace(/(?:ies|es|s)$/, '');
    const tokenizeLine = (line) => {
      const raw = String(line).match(/[A-Za-z0-9_#.-]{3,}/g) || [];
      const out = new Set();
      for (const orig of raw) {
        const token = orig.toLowerCase().replace(/^[.#-]+/, '').replace(/[.-]+$/, '');
        if (token.length < 3) continue;
        out.add(norm(token));
        // Compound tokens index their parts: "aspect-ratio" must answer the
        // query "aspect ratio" (CSS class/selector names are kebab-cased
        // while prose is spaced), and camelCase splits too.
        for (const part of token.split(/[._-]+/)) if (part.length >= 3) out.add(norm(part));
        for (const part of orig.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/\s+/)) {
          const low = part.toLowerCase();
          if (low.length >= 3) out.add(norm(low));
        }
      }
      return [...out];
    };
    const INDEX_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|vue|svelte|scss|sass|less|css|md|markdown|txt|rst|json|yml|yaml|toml|ini|cfg|log)$/i;
    check();
    const rootStat = await fs.promises.stat(root).catch(() => null);
    const targetStat = singleFile ? await fs.promises.stat(singleFile).catch(() => null) : null;
    if (singleFile && (!targetStat || !targetStat.isFile())) throw new Error(`computer_index: file not found: ${singleFile}`);
    if (!rootStat) throw new Error(`computer_index: path not found: ${root}`);
    // Single-file outline: answer from the one file — NEVER build the corpus
    // index for it (a wrong/wider root once indexed an entire monorepo for a
    // single outline and cost 67 seconds).
    const SYMBOL_RES = [
      /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
      /^\s*(?:export\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:export\s+)?(?:async\s+)?def\s+([A-Za-z_]\w*)/,
      /^\s*class\s+([A-Za-z_]\w*)\s*[(:]/,
      /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
      /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
      /^#{1,3}\s+(\S.*)$/
    ];
    const cssExt = ext => /^\.(?:css|scss|sass|less)$/i.test(ext);
    const extractSymbols = (lines, ext = '') => {
      // Stylesheets: a line ending in '{' IS the selector — the artifact a
      // styling bug hunt needs (e.g. ".lds-canvas-frame@46").
      if (cssExt(ext)) {
        const selectors = [];
        const seen = new Set();
        for (let i = 0; i < lines.length && selectors.length < 80; i++) {
          const line = lines[i];
          if (line.trim().startsWith('/*') || line.trim().startsWith('*')) continue;
          const match = /^\s*(@?[^\{\}]+)\{\s*$/.exec(line);
          const name = match?.[1]?.trim();
          if (name && !seen.has(name)) { seen.add(name); selectors.push(`${name.slice(0, 48)}@${i + 1}`); }
        }
        return selectors;
      }
      const symbols = [];
      const seen = new Set();
      for (let i = 0; i < lines.length && symbols.length < 80; i++) {
        for (const re of SYMBOL_RES) {
          const match = re.exec(lines[i]);
          const name = match?.[1]?.trim();
          if (name && !seen.has(name)) { seen.add(name); symbols.push(`${name}@${i + 1}`); break; }
        }
      }
      return symbols;
    };
    if (singleFile) {
      const buffer = await fs.promises.readFile(singleFile).catch(() => null);
      const text = buffer && !buffer.includes(0) ? buffer.toString('utf8') : '';
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      const symbols = extractSymbols(lines, path.extname(singleFile));
      return { ok: true, tool: 'computer_index', root, file: singleFile, symbols: symbols.length, map: symbols.join(', ').slice(0, 8_000), elapsedMs: Date.now() - startedAt };
    }

    // ---- Corpus + inverted index (built once, updated incrementally) ------
    this._docIndex ||= new Map();
    const state = this._docIndex.get(root) || { ids: new Map(), paths: [], files: new Map(), postings: new Map() };
    this._docIndex.set(root, state);
    const idOf = (file) => {
      let id = state.ids.get(file);
      if (id === undefined) { id = state.paths.length; state.ids.set(file, id); state.paths.push(file); }
      return id;
    };
    const walkList = [];
    // LORDE_SEARCH_DEPTH_V1 — raised depth 12→16 and file cap 5000→10000 so
    // nested src/ subdirectories are indexed.
    const walk = async (dir, depth) => {
      if (depth > 16 || walkList.length > 10000) return;
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (['node_modules', 'dist', 'build', 'out', '.git', '.wrangler'].includes(entry.name) || entry.name.startsWith('.')) continue;
        const full = `${dir}${path.sep}${entry.name}`;
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && INDEX_EXT.test(entry.name)) walkList.push(full);
      }
    };
    await walk(rootStat.isDirectory() ? root : path.dirname(root), 0);
    // Index/update changed files; unchanged files keep their cached lines.
    let tokenizedFiles = 0;
    for (const file of walkList) {
      const stat = await fs.promises.stat(file).catch(() => null);
      if (!stat || !stat.isFile() || stat.size > 400_000) continue;
      const id = idOf(file);
      const cached = state.files.get(id);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) continue;
      check();
      const buffer = await fs.promises.readFile(file).catch(() => null);
      if (!buffer || buffer.includes(0)) continue;
      // Drop the changed file's old postings before re-tokenizing.
      if (cached) for (const token of cached.tokenList) {
        const arr = state.postings.get(token);
        if (arr) {
          const next = arr.filter(packed => Math.floor(packed / 100000) !== id);
          if (next.length) state.postings.set(token, next); else state.postings.delete(token);
        }
      }
      const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n').slice(0, 99999);
      const tokenList = [];
      const tokenLines = new Map();
      lines.forEach((line, index) => {
        // Minified/bundled data lines (whole-app JSON on one line) would match
        // every query token and flood the ranking; skip tokenizing them.
        if (line.length > 2000) return;
        for (const token of tokenizeLine(line)) {
          if (!tokenLines.has(token)) { tokenLines.set(token, []); tokenList.push(token); }
          tokenLines.get(token).push(index + 1);
          let postings = state.postings.get(token);
          if (!postings) { postings = []; state.postings.set(token, postings); }
          postings.push(id * 100000 + index + 1);
        }
      });
      state.files.set(id, { path: file, mtimeMs: stat.mtimeMs, size: stat.size, lines, lineCount: lines.length, tokenList, tokenLines });
      tokenizedFiles += 1;
    }
    const shorten = (file) => file.startsWith(root) ? path.relative(root, file).split(path.sep).join('/') : file;

    // ---- Query mode: ranked line-level hits across the whole corpus -------
    const query = String(input.query || '').trim();
    if (query) {
      const queryTokens = [...new Set((query.toLowerCase().match(/[a-z0-9_#.-]{2,}/g) || [])
        .map(token => norm(token.replace(/^[.#-]+/, '').replace(/[.-]+$/, ''))).filter(token => token.length >= 3))];
      if (!queryTokens.length) throw new Error('computer_index query produced no searchable tokens.');
      // Rarity-weighted scoring: a token that appears in 3 lines localizes a
      // bug; a token that appears in 40000 lines is boilerplate. A line is
      // kept when it matches the RAREST query token (the discriminative
      // anchor — this lets ONE broad query traverse a layered pipeline whose
      // layers use different identifier vocabularies) OR at least half the
      // tokens (AND-semantics for short queries). Ranked by coverage then
      // weight, so noise sinks below the anchor hits.
      const dfs = queryTokens.map(token => (state.postings.get(token) || []).length);
      const rarestIdx = dfs.indexOf(Math.min(...dfs));
      const rarestBit = 1 << rarestIdx;
      const lineScores = new Map();
      queryTokens.forEach((token, tokenIndex) => {
        const postings = state.postings.get(token) || [];
        const weight = 1 + 4 / Math.sqrt(Math.max(1, postings.length));
        const bit = 1 << tokenIndex;
        for (const packed of postings) {
          const id = Math.floor(packed / 100000), lineNo = packed % 100000;
          const key = id * 100000 + lineNo;
          const current = lineScores.get(key) || { id, lineNo, score: 0, tokens: 0, mask: 0 };
          current.score += weight;
          current.tokens += 1;
          current.mask |= bit;
          lineScores.set(key, current);
        }
      });
      const need = queryTokens.length === 1 ? 1 : Math.max(1, Math.ceil(queryTokens.length / 2));
      const ranked = [...lineScores.values()]
        .filter(hit => hit.tokens >= need || (hit.mask & rarestBit))
        .sort((a, b) => b.tokens - a.tokens || b.score - a.score)
        .slice(0, 60);
      // Context lines: each hit carries the surrounding code (default 2
      // lines each side) so ONE query reads like a targeted read — the agent
      // sees the full rule/function around the hit without a follow-up
      // computer_read per file.
      const contextLines = Math.min(Math.max(0, Number(input.context ?? 2)), 6);
      const groups = new Map();
      for (const hit of ranked) {
        const entry = state.files.get(hit.id);
        if (!groups.has(hit.id)) groups.set(hit.id, { file: shorten(entry?.path || ''), hits: [] });
        const lines = entry?.lines || [];
        const from = Math.max(0, hit.lineNo - 1 - contextLines);
        const to = Math.min(lines.length, hit.lineNo + contextLines);
        const ctx = [];
        for (let i = from; i < to; i++) {
          if (i === hit.lineNo - 1) continue;
          const text = String(lines[i] || '').trim();
          if (text) ctx.push(`${i + 1}: ${text.slice(0, 160)}`);
        }
        groups.get(hit.id).hits.push({
          line: hit.lineNo,
          score: Math.round(hit.score * 10) / 10,
          text: String(lines[hit.lineNo - 1] || '').trim().slice(0, 200),
          ...(ctx.length ? { context: ctx } : {})
        });
      }
      return {
        ok: true, tool: 'computer_index', root, mode: 'query', query, tokens: queryTokens,
        indexedFiles: state.files.size, filesMatched: groups.size, results: [...groups.values()],
        elapsedMs: Date.now() - startedAt,
        ...(ranked.length === 0 ? { notice: 'No line matched enough query terms. Widen the query or use computer_search (regex) for exact patterns.' } : {}),
        note: `Index cached per session (${state.files.size} files; re-tokenized ${tokenizedFiles} changed this call). Results are ranked line-level hits across docs AND code — quote the file:line evidence directly; no re-search needed.`
      };
    }

    // ---- Map mode: structural overview, goal-ranked, docs compete equally --
    const goal = String(input.goal || '');
    const GOAL_STOP = new Set(['the', 'a', 'an', 'and', 'or', 'at', 'to', 'for', 'of', 'this', 'that', 'it', 'its', 'is', 'are', 'was', 'be', 'on', 'in', 'with', 'why', 'find', 'out', 'fix', 'fixed', 'take', 'screen', 'shot', 'screenshot', 'make', 'but', 'ones', 'them', 'they', 'appear', 'appears', 'like', 'just', 'very', 'when', 'what', 'where', 'which', 'how', 'not', 'into', 'from', 'attached', 'project']);
    const goalTokenSet = new Set((goal.toLowerCase().match(/[a-z0-9_#.-]{2,}/g) || [])
      .filter(token => !GOAL_STOP.has(token)).map(norm));
    const goalScore = (text) => {
      if (!goalTokenSet.size) return 0;
      const hay = new Set((String(text).toLowerCase().match(/[a-z0-9_#.-]{2,}/g) || []).map(norm));
      let matched = 0;
      for (const token of goalTokenSet) if (hay.has(token)) matched += 1;
      return matched;
    };
    const outlines = [];
    for (const entry of state.files.values()) {
      const symbols = extractSymbols(entry.lines, path.extname(entry.path));
      if (symbols.length) outlines.push({ file: shorten(entry.path), symbols });
    }
    // Cap each file's symbol list so the budget SPREADS across files instead
    // of being eaten by a few giants. Docs compete EQUALLY with code — they
    // carry this repo's persistent-bug history and resume rules; demoting
    // them hides knowledge the user already wrote down.
    for (const outline of outlines) outline.symbols = outline.symbols.slice(0, 24);
    for (const outline of outlines) outline.goalScore = goalScore(`${outline.file} ${outline.symbols.join(' ')}`);
    outlines.sort((a, b) => b.goalScore - a.goalScore
      || b.symbols.length - a.symbols.length
      || a.file.localeCompare(b.file));
    const goalMatched = outlines.filter(o => o.goalScore > 0).length;
    let map = '';
    let included = 0, truncated = false;
    for (const outline of outlines) {
      const line = `${outline.file} (${outline.symbols.length}): ${outline.symbols.slice(0, 8).join(', ')}\n`;
      if (map.length + line.length > maxChars) { truncated = true; break; }
      map += line;
      included += 1;
    }
    // Identical index rebuilds are held evidence, not new information.
    const repeat = this.searchRepeatNotice(owner, { root, pattern: `computer_index:${maxChars}`, outputMode: 'index', glob: '', contextLines: 0 }, outlines.length);
    // Tell the model WHICH areas the budget omitted, so an unseen directory
    // is a known unknown — one indexed query away, not a surprise.
    const omittedDirs = new Map();
    for (const outline of outlines.slice(included)) {
      const top = outline.file.split('/')[0];
      omittedDirs.set(top, (omittedDirs.get(top) || 0) + 1);
    }
    const omittedSummary = [...omittedDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([dir, count]) => `${dir}/x${count}`).join(', ');
    return {
      ok: true, tool: 'computer_index', root, mode: 'map', files: outlines.length, included, truncated, map: map || '(no symbols found)',
      indexedFiles: state.files.size, elapsedMs: Date.now() - startedAt,
      ...(goalTokenSet.size ? { goal: { tokens: [...goalTokenSet].slice(0, 12), matchedFiles: goalMatched } } : {}),
      ...(truncated ? { note: `Map bounded at ${maxChars} characters. Omitted: ${omittedSummary || 'lower-symbol files'}. For an omitted file use file=<path>, or — much faster — pass query=<terms> for ranked line-level hits across the WHOLE corpus (docs included) in milliseconds.` } : {}),
      ...(repeat ? { repeat } : {})
    };
  }

  async searchSingleFile(target, regex, contextLines) {
    const buffer = await fs.promises.readFile(target);
    if (buffer.includes(0)) throw new Error('computer_search: file is binary.');
    const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n');
    const hits = [];
    lines.forEach((line, index) => { if (regex.test(line)) hits.push(index); });
    const out = [];
    const emitted = new Set();
    for (const hit of hits) {
      const from = Math.max(0, hit - contextLines), to = Math.min(lines.length - 1, hit + contextLines);
      for (let i = from; i <= to; i++) {
        if (emitted.has(i)) continue;
        emitted.add(i);
        out.push({ file: target, line: i + 1, text: lines[i], match: i === hit });
      }
    }
    return out;
  }

  async searchWithWalker({ root, regex, glob, outputMode, maxResults, contextLines }, check) {
    const files = [];
    const globRe = compileGlob(glob);
    // LORDE_SEARCH_DEPTH_V1 — raised depth 10→14 and file cap 4000→8000 so
    // code in nested src/editor/ui/… subdirectories is not silently missed.
    // The prior limits were hit on real projects (the lorde-design-studio app
    // has code at src/editor/aiEditorPanel.js that the old walker missed when
    // searching from the app root).
    const walk = async (dir, depth) => {
      if (depth > 14 || files.length > 8000) return;
      let entries = [];
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (['node_modules', 'dist', 'build', '.git'].includes(entry.name) || entry.name.startsWith('.')) continue;
        const full = `${dir}${path.sep}${entry.name}`;
        if (entry.isDirectory()) await walk(full, depth + 1);
        else if (entry.isFile() && (!globRe || globRe.test(entry.name) || globRe.test(full.slice(root.length + 1).split(path.sep).join('/')))) files.push(full);
      }
    };
    await walk(root, 0);
    const lines = [];
    const matchedFiles = new Map();
    for (const file of files) {
      if (outputMode === 'content' && lines.length >= maxResults) break;
      check();
      let text = null;
      try {
        const stat = await fs.promises.stat(file);
        if (!stat.isFile() || stat.size > 400_000) continue;
        const buffer = await fs.promises.readFile(file);
        if (buffer.includes(0)) continue;
        text = buffer.toString('utf8').replace(/\r\n/g, '\n');
      } catch { continue; }
      const fileLines = text.split('\n');
      const hits = [];
      fileLines.forEach((line, index) => { if (regex.test(line)) hits.push(index); });
      if (!hits.length) continue;
      matchedFiles.set(file, hits.length);
      if (outputMode === 'content') {
        const emitted = new Set();
        for (const hit of hits) {
          if (lines.length >= maxResults) break;
          const from = Math.max(0, hit - contextLines), to = Math.min(fileLines.length - 1, hit + contextLines);
          for (let i = from; i <= to; i++) {
            if (emitted.has(i) || lines.length >= maxResults) continue;
            emitted.add(i);
            lines.push({ file, line: i + 1, text: fileLines[i], match: i === hit });
          }
        }
      }
    }
    if (outputMode === 'files') return rankFileMatches(matchedFiles, maxResults, root);
    return { lines, matches: lines.filter(line => line.match).length, truncated: false };
  }

  // Ordered mutation batch: all operations share one owner/check context, so
  // a user steer/cancel stops the tail and each completed op remains auditable.
  // Preflight is intentionally conservative: validate all shapes/absolute
  // paths/destinations before the first mutation, then ownership checks happen
  // immediately before each op to catch concurrent changes.
  async fsBatch(input, check, owner = 'computer') {
    const operations = Array.isArray(input.operations) ? input.operations : [];
    if (!operations.length) throw new Error('computer_fs_batch requires operations[].');
    if (operations.length > 32) throw new Error('computer_fs_batch accepts at most 32 operations; split the plan explicitly.');
    const allowed = new Set(['mkdir', 'copy', 'move', 'delete']);
    const preflight = operations.map((operation, index) => {
      const item = { ...(operation || {}) };
      if (!allowed.has(item.action)) throw new Error(`computer_fs_batch operation ${index + 1} has invalid action.`);
      if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) throw new Error(`computer_fs_batch operation ${index + 1} needs an absolute path.`);
      if (['copy', 'move'].includes(item.action) && (typeof item.destination !== 'string' || !path.isAbsolute(item.destination))) throw new Error(`computer_fs_batch operation ${index + 1} needs an absolute destination.`);
      return item;
    });
    const results = [];
    const stopOnError = input.stopOnError !== false;
    for (let index = 0; index < preflight.length; index += 1) {
      const operation = preflight[index];
      try {
        check();
        const guard = await this.workspaceGuard.beforeMutation(owner, operation);
        check();
        const result = await fileOperation(operation, check);
        const workspace = await this.workspaceGuard.afterMutation(guard, operation);
        results.push({ ok: true, index, action: operation.action, path: path.resolve(operation.path), ...(operation.destination ? { destination: path.resolve(operation.destination) } : {}), ...(result || {}), ...(workspace ? { workspace } : {}) });
      } catch (error) {
        results.push({ ok: false, index, action: operation.action, path: path.resolve(operation.path), ...(operation.destination ? { destination: path.resolve(operation.destination) } : {}), error: String(error?.message || error) });
        if (stopOnError) {
          return { ok: false, tool: 'computer_fs_batch', count: results.length, requested: preflight.length, results, unexecuted: preflight.slice(index + 1).map((item, tailIndex) => ({ index: index + 1 + tailIndex, action: item.action, path: path.resolve(item.path), ...(item.destination ? { destination: path.resolve(item.destination) } : {}) })) };
        }
      }
    }
    return { ok: results.every((result) => result.ok), tool: 'computer_fs_batch', count: results.length, requested: preflight.length, results, unexecuted: [] };
  }

  // computer_fs: filesystem operations WITHOUT content (stat/list/find/
  // mkdir/copy/move/delete). Content work belongs to computer_read/
  // computer_write/computer_patch; locating code by content belongs to
  // computer_search. `find` is the filename counterpart of search: locate
  // files BY NAME across a tree in one call.
  async fsTool(input, check, owner = 'computer') {
    if (input.action === 'find') return this.fsFind(input, check);
    const mutating = ['mkdir', 'copy', 'move', 'delete'].includes(input.action);
    let guard = null;
    if (mutating) guard = await this.workspaceGuard.beforeMutation(owner, input);
    let result;
    try { result = await fileOperation(input, check); } catch (error) { throw error; }
    const workspace = mutating ? await this.workspaceGuard.afterMutation(guard, input) : null;
    return { ok: true, tool: 'computer_fs', ...(result || {}), ...(workspace ? { workspace } : {}) };
  }

  async fsFind(input, check) {
    const root = path.resolve(String(input.path || process.cwd()));
    const query = String(input.query || '').trim().toLowerCase();
    const glob = typeof input.glob === 'string' && input.glob.trim() ? input.glob.trim() : null;
    if (!query && !glob) throw new Error('computer_fs find requires query (name substring) or glob (name pattern).');
    const maxResults = Math.min(Math.max(1, Number(input.limit) || 200), 1000);
    const offset = Math.max(0, Number(input.offset) || 0);
    check();
    const rootStat = await fs.promises.stat(root).catch(() => null);
    if (!rootStat) throw new Error(`computer_fs find: path not found: ${root}`);
    let candidates = null;
    if (await this.ripgrepAvailable()) {
      const { execFile } = require('node:child_process');
      const args = ['--files', '--hidden', '--glob', '!**/node_modules/**', '--glob', '!**/dist/**', '--glob', '!**/build/**', '--glob', '!**/.git/**'];
      if (glob) args.push('--glob', glob);
      args.push(root);
      candidates = await new Promise((resolve) => {
        execFile('rg', args, { windowsHide: true, maxBuffer: 16_000_000, timeout: 30_000 }, (error, stdout) => {
          if (error && !stdout) resolve(null); else resolve(String(stdout || '').split('\n').filter(Boolean));
        });
      });
    }
    if (!candidates) {
      candidates = [];
      const globRe = compileGlob(glob);
      const walk = async (dir, depth) => {
        if (depth > 10 || candidates.length > 4000) return;
        let entries = [];
        try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (['node_modules', 'dist', 'build', '.git'].includes(entry.name) || entry.name.startsWith('.')) continue;
          const full = `${dir}${path.sep}${entry.name}`;
          if (entry.isDirectory()) await walk(full, depth + 1);
          else if (entry.isFile() && (!globRe || globRe.test(entry.name) || globRe.test(full.slice(root.length + 1).split(path.sep).join('/')))) candidates.push(full);
        }
      };
      await walk(root, 0);
    }
    check();
    const matched = candidates.filter(file => !query || file.toLowerCase().includes(query));
    const page = matched.slice(offset, offset + maxResults).map(file => ({
      file,
      name: path.basename(file),
      relative: path.relative(root, file).replaceAll(path.sep, '/')
    }));
    return {
      ok: true, tool: 'computer_fs', action: 'find', root, query: query || null, glob: glob || null,
      matches: matched.length, files: page, offset,
      truncated: offset + page.length < matched.length,
      ...(offset + page.length < matched.length ? { nextOffset: offset + page.length } : {})
    };
  }

  // computer_git: the installed git binary, allow-listed subcommands only
  // (gitCommands.cjs builds and sanitizes argv). Read-only actions skip the
  // mutation guard; stage/commit/branch/checkout go through the same
  // ownership flow as file edits, anchored on the repository root.
  async git(input, check, owner = 'computer') {
    const { buildGitCommand } = require('./gitCommands.cjs');
    const childProcess = require('node:child_process');
    const repo = path.resolve(input.repo);
    let repoStat;
    try { repoStat = await fs.promises.stat(repo); } catch {
      throw new Error(`computer_git repo does not exist: ${repo}`);
    }
    if (!repoStat.isDirectory()) throw new Error('computer_git repo must be a directory (the repository working tree).');
    const { argv, readOnly } = buildGitCommand(input);
    check();
    const run = () => new Promise((resolve) => {
      childProcess.execFile('git', argv, { cwd: repo, windowsHide: true, timeout: 30_000, maxBuffer: 4_000_000, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
    const finish = (output, truncated) => ({ action: input.action, repo, argv: ['git', ...argv], output, truncated });
    // `git status` in a long-lived repo returns THOUSANDS of lines of stale
    // state (build artifacts, local databases). The model needs the SHAPE of
    // the working tree, not a wall of paths: bound the status output and
    // summarize what was elided, so one status call cannot flood the decision
    // context and crowd out the actual task.
    const summarizeStatus = (raw) => {
      const MAX_STATUS_CHARS = 4_000;
      const MAX_STATUS_LINES = 60;
      if (raw.length <= MAX_STATUS_CHARS && raw.split('\n').length <= MAX_STATUS_LINES) return { output: raw, truncated: false };
      const lines = raw.split('\n').filter(Boolean);
      const shown = lines.slice(0, MAX_STATUS_LINES);
      const byKind = {};
      for (const entry of lines) {
        const kind = entry.slice(0, 2).trim() || '??';
        byKind[kind] = (byKind[kind] || 0) + 1;
      }
      const summary = Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${count}× ${kind}`).join(', ');
      return {
        output: `${shown.join('\n')}\n… (${lines.length} total entries: ${summary}. Showing the first ${shown.length}. Use computer_git diff with paths for anything specific — do not re-run status.)`,
        // Keep the complete status available for the central result archive;
        // the live view stays compact, but omitted paths are not destroyed.
        fullOutput: raw,
        truncated: true
      };
    };
    if (readOnly) {
      const { error, stdout, stderr } = await run();
      check();
      if (error) throw gitError(argv, error, stderr);
      if (input.action === 'status') {
        const { output, truncated } = summarizeStatus(stdout);
        return finish(output, truncated);
      }
      // Keep the complete stdout here. desktopChatAgent archives large
      // results with a resultId before publishing them; truncating at this
      // layer destroyed the omitted diff and forced the model to rerun Git.
      return finish(stdout, false);
    }
    // Mutating git actions take the same ownership path as file edits,
    // anchored on the repository root, BEFORE the command runs.
    const guard = await this.workspaceGuard.beforeMutation(owner, { ...input, path: repo, action: 'edit' });
    const { error, stdout, stderr } = await run();
    check();
    if (error) throw gitError(argv, error, stderr);
    if (input.action === 'status') {
      const { output, truncated } = summarizeStatus(stdout);
      return finish(output, truncated);
    }
    const output = stdout.length > 64_000 ? `${stdout.slice(0, 64_000)}\n… (output truncated at 64,000 characters)` : stdout;
    const workspace = await this.workspaceGuard.afterMutation(guard, { path: repo });
    return { ...finish(output, stdout.length > 64_000), ...(workspace ? { workspace } : {}) };
  }

  // computer_patch: per-line append ops (real-time diff) or a legacy whole-patch
  // body — one text file, atomic, guarded by the same workspace ownership rules.
  async patch(input, check, owner = 'computer', onProgress = null) {
    const { applyPatch, applyLineOps, MAX_FILE_BYTES } = require('./applyPatch.cjs');
    if (Array.isArray(input.ops) && input.ops.length && !input.patch) {
      const guardOps = await this.workspaceGuard.beforeMutation(owner, { ...input, action: 'edit' });
      check();
      let existing = '';
      try {
        const stat = fs.statSync(input.path);
        if (stat.isFile()) {
          if (stat.size > MAX_FILE_BYTES) throw new Error(`The file is too large for a patch (${stat.size} bytes; cap ${MAX_FILE_BYTES}).`);
          existing = fs.readFileSync(input.path, 'utf8').replace(/\r\n/g, '\n');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          if (/too large/.test(String(error.message))) throw error;
          throw new Error(`computer_patch could not read ${input.path}: ${error.message}`);
        }
        existing = '';
      }
      const applied = applyLineOps(existing, input.ops, input.path, (progress) => {
        try { onProgress?.({ type: 'patch.progress', path: input.path, live: true, ...progress }); } catch { /* UI progress is additive */ }
      });
      check();
      fs.mkdirSync(path.dirname(input.path), { recursive: true });
      fs.writeFileSync(input.path, applied.content, 'utf8');
      const workspace = await this.workspaceGuard.afterMutation(guardOps, input);
      return {
        applied: applied.errors.length === 0,
        live: true,
        files: [{ path: input.path, action: existing === '' && applied.addedLines > 0 ? 'add' : 'update', addedLines: applied.addedLines, removedLines: applied.removedLines, diff: applied.diff }],
        opErrors: applied.errors,
        outcome: applied.errors.length ? 'execution_failed' : 'executed',
        ...(workspace ? { workspace } : {})
      };
    }
    // The ownership guard keys on action: 'edit' is the exact-change sibling.
    // Normalize every patch header to the authoritative `path` argument. Models
    // often emit a relative/stale Update File header after a read; requiring
    // byte-identical headers created avoidable context failures even though the
    // caller already supplied the target path.
    const normalizedPatch = String(input.patch || '').replace(/^\*\*\* (Update|Add|Delete) File:.*$/gm, `*** $1 File: ${input.path}`);
    const guard = await this.workspaceGuard.beforeMutation(owner, { ...input, action: 'edit' });
    check();
    let existing = null;
    try {
      const stat = fs.statSync(input.path);
      if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error(`The file is too large for a patch (${stat.size} bytes; cap ${MAX_FILE_BYTES}).`);
        existing = fs.readFileSync(input.path, 'utf8').replace(/\r\n/g, '\n');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        if (/too large/.test(String(error.message))) throw error;
        throw new Error(`computer_patch could not read ${input.path}: ${error.message}`);
      }
      existing = null;
    }
    let result = null;
    try {
      result = applyPatch({
        patch: normalizedPatch,
        read: (target) => {
          if (target !== input.path) throw new Error('computer_patch targets exactly the file named in path.');
          return existing;
        },
        write: (target, content) => {
          if (target !== input.path) throw new Error('computer_patch targets exactly the file named in path.');
          check();
          if (content === null) fs.rmSync(target);
          else {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, content, 'utf8');
          }
        }
      });
    } catch (error) {
      // Outcome-labelled failure: the caller's recovery procedure depends on
      // WHICH kind of failure this is (stale context vs never executed vs the
      // write itself failing) — never restart the investigation for all three.
      return { state: 'failed', applied: false, outcome: error.patchOutcome || 'execution_failed', error: error.message };
    }
    const workspace = await this.workspaceGuard.afterMutation(guard, input);
    return { ...result, outcome: 'executed', ...(workspace ? { workspace } : {}) };
  }

  // ---------------------------------------------------------------------------
  // computer_patch_chunk: the oversimplified fail-proof fallback. No line
  // numbers, no anchors, no context matching — pure chunk semantics:
  //   { path, mode: 'overwrite' | 'append' | 'insert', content, offset? }
  // overwrite writes content verbatim; append adds content at EOF; insert
  // splices content at byte offset (default 0). It cannot fail on stale line
  // numbers because it never uses them. The harness auto-surfaces this tool
  // after PATCH_FALLBACK_AFTER consecutive computer_patch failures.
  // ---------------------------------------------------------------------------
  async patchChunk(input, check, owner = 'computer') {
    const guard = await this.workspaceGuard.beforeMutation(owner, { ...input, action: 'edit' });
    check();
    const mode = String(input.mode || 'overwrite');
    const content = String(input.content ?? '');
    let existing = '';
    let existed = false;
    try {
      const stat = fs.statSync(input.path);
      if (stat.isFile()) {
        existing = fs.readFileSync(input.path, 'utf8');
        existed = true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`computer_patch_chunk could not read ${input.path}: ${error.message}`);
    }
    let next;
    if (mode === 'append') next = existing + content;
    else if (mode === 'insert') {
      const offset = Math.max(0, Math.min(Number(input.offset) || 0, existing.length));
      next = existing.slice(0, offset) + content + existing.slice(offset);
    } else next = content; // overwrite
    check();
    fs.mkdirSync(path.dirname(input.path), { recursive: true });
    fs.writeFileSync(input.path, next, 'utf8');
    const { computeLineDiff } = require('./applyPatch.cjs');
    const diff = computeLineDiff(existing.replace(/\r\n/g, '\n'), next.replace(/\r\n/g, '\n'));
    const workspace = await this.workspaceGuard.afterMutation(guard, input);
    return {
      applied: true,
      live: false,
      fallback: true,
      mode,
      files: [{ path: input.path, action: existed ? 'update' : 'add', addedLines: diff.addedLines, removedLines: diff.removedLines, diff: diff.chunks }],
      outcome: 'executed',
      ...(workspace ? { workspace } : {})
    };
  }

  claudeLaunch(owner) {    const safeName = `browser-use-${String(owner || 'session').replace(/[^a-z0-9-]+/gi, '-').slice(-48)}`;
    const protect = 'Work in the current tree. Before editing, inspect git status and preserve every pre-existing or concurrent change. Never reset, stash, checkout, clean, delete, or overwrite unrelated work. Prefer exact edits after reading. Report conflicts and the exact files you changed.';
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    return {
      command: `claude --name ${quote(safeName)} --append-system-prompt ${quote(protect)}`,
      recoveryCommand: 'claude --continue',
      launchName: safeName
    };
  }

  async terminalSend(sessionId, text, input = {}) {
    const timeoutMs = Math.min(60_000, Math.max(0, Number(input.waitMs ?? 5_000) || 0));
    if (typeof this.terminal.sendInput === 'function') {
      return this.terminal.sendInput(sessionId, text, { expected: String(input.expected || ''), timeoutMs });
    }
    const before = this.terminal.snapshot(sessionId) || {};
    const accepted = await this.terminal.writeInput(sessionId, `${String(text ?? '').replace(/[\r\n]+$/g, '')}\r`);
    if (timeoutMs) await new Promise(resolve => setTimeout(resolve, Math.min(timeoutMs, 500)));
    const after = this.terminal.snapshot(sessionId) || {};
    return {
      accepted: accepted !== false,
      submitted: accepted !== false,
      inputRevision: after.inputRevision,
      outputRevision: after.outputRevision,
      outputObserved: Number(after.outputRevision || 0) > Number(before.outputRevision || 0),
      matched: false,
      historyDelta: '',
      timedOut: false,
      phase: after.phase || (after.alive === false ? 'exited' : 'ready'),
      exitCode: after.exitCode ?? null,
      error: after.error || null,
      status: after
    };
  }

  async shell(input, owner, check) {
    if (input.action === 'list') return {
      jobs: [...this.jobs.values()].filter(job => job.owner === owner).map(job => ({ jobId: job.id, state: job.state, exitCode: job.exitCode })),
      sessions: [...this.terminals].filter(([, id]) => id === owner).map(([id]) => {
        const snapshot = this.terminal?.snapshot(id);
        return {
          sessionId: id,
          running: Boolean(snapshot?.alive ?? snapshot),
          cwd: snapshot?.cwd || '', shell: snapshot?.shell || '', backend: snapshot?.backend || null,
          virtual: snapshot?.virtual === true, profile: snapshot?.profile || 'shell',
          phase: snapshot?.phase || (snapshot ? 'ready' : 'exited'), credentialSource: snapshot?.credentialSource || 'none',
          inputRevision: snapshot?.inputRevision || 0, outputRevision: snapshot?.outputRevision || 0,
          exitCode: snapshot?.exitCode ?? null, error: snapshot?.error || null
        };
      }).filter(session => session.running || session.phase === 'exited' || session.phase === 'error')
    };
    if (['open', 'input', 'send', 'recover', 'close'].includes(input.action) || input.action === 'read' && input.sessionId) {
      if (!this.terminal) throw new Error('The interactive terminal broker is unavailable.');
      if (input.action === 'open') {
        const requestedProfile = input.profile === 'claude-code' || /^\s*claude(?:\.exe)?(?:\s|$)/i.test(String(input.command || '')) ? 'claude-code' : 'shell';
        const existing = input.newSession === true ? null : [...this.terminals].find(([id, entryOwner]) => {
          const snapshot = entryOwner === owner ? this.terminal?.snapshot(id) : null;
          return snapshot && snapshot.virtual !== true && (snapshot.profile || 'shell') === requestedProfile && snapshot.phase !== 'exited' && snapshot.phase !== 'error';
        });
        if (existing) {
          const snapshot = typeof this.terminal.refresh === 'function' ? await this.terminal.refresh(existing[0]) : this.terminal.snapshot(existing[0]);
          return { sessionId: existing[0], running: Boolean(snapshot?.alive ?? snapshot), reused: true, phase: snapshot?.phase || 'ready', status: snapshot, backend: this.terminal.backendInfo(), history: String(snapshot?.history || '').slice(-16_000), note: 'Reused the existing conversation-owned interactive PTY.' };
        }
        const launch = requestedProfile === 'claude-code' ? this.claudeLaunch(owner) : { command: String(input.command ?? '').trim(), recoveryCommand: '', launchName: '' };
        const created = await this.terminal.create({ cwd: input.cwd, profile: requestedProfile, credentialMode: input.credentialMode || 'auto', launchName: launch.launchName, recoveryCommand: launch.recoveryCommand });
        this.terminals.set(created.id, owner);
        try { check(); } catch (error) { await this.terminal.dispose(created.id); this.terminals.delete(created.id); throw error; }
        let acknowledgement = null;
        if (launch.command) {
          check();
          acknowledgement = await this.terminalSend(created.id, launch.command, { ...input, waitMs: input.waitMs ?? (requestedProfile === 'claude-code' ? 12_000 : 5_000) });
          check();
        }
        const snapshot = typeof this.terminal.refresh === 'function' ? await this.terminal.refresh(created.id) : this.terminal.snapshot(created.id);
        return { sessionId: created.id, backend: this.terminal.backendInfo(), profile: requestedProfile, credentialSource: snapshot?.credentialSource || created.credentialSource || 'none', phase: snapshot?.phase || acknowledgement?.phase || 'starting', status: snapshot, history: String(snapshot?.history || created.history || '').slice(-16_000), ...(launch.command ? { launched: launch.command, acknowledgement } : {}) };
      }
      if (this.terminals.get(input.sessionId) !== owner) throw new Error('Unknown owned terminal session.');
      if (input.action === 'close') { await this.terminal.dispose(input.sessionId); this.terminals.delete(input.sessionId); return { closed: true }; }
      if (input.action === 'recover') {
        if (typeof this.terminal.recover !== 'function') throw new Error('Terminal recovery is unavailable.');
        const recovered = await this.terminal.recover(input.sessionId);
        if (!recovered) throw new Error('Only an exited Claude Code session can be recovered.');
        this.terminals.delete(input.sessionId); this.terminals.set(recovered.id, owner);
        return { sessionId: recovered.id, recovered: true, phase: recovered.phase, status: recovered, history: String(recovered.history || '').slice(-16_000) };
      }
      if (input.action === 'send') {
        if (typeof input.text !== 'string') throw new Error('PTY send requires text.');
        check();
        const acknowledgement = await this.terminalSend(input.sessionId, input.text, input);
        const snapshot = acknowledgement.status || this.terminal.snapshot(input.sessionId);
        return { sessionId: input.sessionId, running: Boolean(snapshot?.alive ?? snapshot), phase: snapshot?.phase || acknowledgement.phase, acknowledgement, status: snapshot, history: String(snapshot?.history || '').slice(-16_000) };
      }
      if (input.action === 'input') {
        if (typeof input.text !== 'string') throw new Error('PTY input requires text.');
        check(); await this.terminal.writeInput(input.sessionId, input.text);
      }
      const snapshot = typeof this.terminal.refresh === 'function' ? await this.terminal.refresh(input.sessionId) : this.terminal.snapshot(input.sessionId);
      return { sessionId: input.sessionId, running: Boolean(snapshot?.alive ?? snapshot), phase: snapshot?.phase || (snapshot ? 'ready' : 'exited'), status: snapshot, history: String(snapshot?.history || '').slice(-16_000) };
    }
    if (input.action === 'execute') {
      if (!input.command?.trim()) throw new Error('Execute requires a command.');
      // Source-file writes remain available here for compatibility and for
      // commands whose requested operation is inherently terminal-based. The
      // catalog strongly steers ordinary edits through the visible patch/write
      // tools, but this PTY is intentionally not a hard policy gate.
      // TTL sweep: cancel running jobs older than the max lifetime so a
      // hung child never occupies a slot forever. Only running jobs are
      // swept; completed/failed jobs are left for read/cancel.
      const jobMaxAgeMs = Math.max(30_000, Number(process.env.BROWSER_USE_TERMINAL_JOB_MAX_MS) || 600_000);
      for (const [id, job] of this.jobs) {
        if (job.state === 'running' && Date.now() - job.startedAt > jobMaxAgeMs) {
          this.cancelJob(job).catch(() => {});
          job.state = 'timed-out';
          job.error = `Command exceeded the maximum lifetime of ${Math.round(jobMaxAgeMs / 1000)}s and was terminated.`;
          job.resolveCompletion?.();
        }
        if (this.jobs.size >= 64 && job.state !== 'running') this.jobs.delete(id);
      }
      if (this.jobs.size >= 64) throw new Error('There are 64 active command jobs; finish or cancel some first.');
      const mirror = await this.activitySession(owner, input.cwd).catch(() => null);
      let mirrorPending = '';
      let mirrorTimer = null;
      const flushMirror = () => {
        if (mirrorTimer) { clearTimeout(mirrorTimer); mirrorTimer = null; }
        if (mirror && mirrorPending) {
          const text = mirrorPending; mirrorPending = '';
          this.terminal.writeInput(mirror, text).catch(() => {});
        }
      };
      const mirrorWrite = (text) => {
        if (!mirror) return;
        mirrorPending += text;
        if (!mirrorTimer) mirrorTimer = setTimeout(flushMirror, 100);
      };
      if (mirror) this.terminal.writeInput(mirror, `\r\n\x1b[36m▶ ${input.command}\x1b[0m\r\n`).catch(() => {});
      const job = { id: crypto.randomUUID(), owner, state: 'running', exitCode: null, signal: null, output: '', startOffset: 0, total: 0, startedAt: Date.now() };
      job.completion = new Promise(resolve => { job.resolveCompletion = resolve; });
      const executable = process.platform === 'win32' ? defaultShell() : process.env.SHELL || '/bin/bash';
      const args = process.platform === 'win32'
        ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$global:LASTEXITCODE=0; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ${input.command}\n$commandOk=$?; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $commandOk) { exit 1 }`]
        : ['-c', input.command];
      check();
      const child = spawn(executable, args, { cwd: input.cwd || process.cwd(), env: process.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      job.child = child; this.jobs.set(job.id, job);
      const append = data => {
        job.output += data; job.total += data.length;
        if (job.output.length > OUTPUT_LIMIT) job.output = job.output.slice(-OUTPUT_LIMIT);
        job.startOffset = job.total - job.output.length;
        mirrorWrite(data);
      };
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', append); child.stderr.on('data', append);
      child.on('error', error => { job.state = 'failed'; job.error = error.message; append(error.message); job.resolveCompletion(); });
      child.on('close', (code, signal) => {
        job.exitCode = code; job.signal = signal; if (job.state === 'running') job.state = code === 0 ? 'completed' : 'failed'; job.endedAt = Date.now(); job.resolveCompletion();
        flushMirror();
        if (mirror) this.terminal.writeInput(mirror, `\r\n\x1b[90m⏺ exit ${code ?? '?'}${signal ? ` (${signal})` : ''}\x1b[0m\r\n`).catch(() => {});
      });
      await waitForJob(job, Math.max(0, input.waitMs ?? 10000)); check();
      return this.jobPage(job, input);
    }
    const job = this.jobs.get(input.jobId);
    if (!job || job.owner !== owner) throw new Error('Unknown owned command job.');
    if (input.action === 'cancel') await this.cancelJob(job);
    else if (input.action !== 'read') throw new Error('Unknown terminal operation.');
    if (input.action === 'read') await waitForJob(job, Math.max(0, input.waitMs ?? 10000));
    check();
    return this.jobPage(job, input);
  }

  jobPage(job, input) {
    const requested = Math.max(0, Math.floor(input.offset || 0)), offset = Math.max(requested, job.startOffset);
    const output = job.output.slice(offset - job.startOffset, offset - job.startOffset + pageLimit(input.limit, 16_000, 64_000));
    return { jobId: job.id, state: job.state, pid: job.child.pid, exitCode: job.exitCode, signal: job.signal, output, offset, nextOffset: offset + output.length, truncated: requested < job.startOffset, totalCharacters: job.total, ...(job.state === 'running' ? { pending: true, readNext: { action: 'read', jobId: job.id, offset: offset + output.length } } : {}), ...(job.error ? { error: job.error } : {}) };
  }

  async cancelJob(job) {
    if (job.state !== 'running') return;
    if (process.platform === 'win32') {
      await new Promise((resolve, reject) => {
        const killer = spawn('taskkill.exe', ['/PID', String(job.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.once('error', reject); killer.once('close', code => code === 0 || job.state !== 'running' ? resolve() : reject(new Error('Could not terminate the owned command process tree.')));
      });
    } else { try { process.kill(-job.child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    job.state = 'cancelled';
  }

  async releaseInput(id) {
    if (this.child || this.nativeOverride) await this.native('release', {}, id);
  }

  async releaseOwner(id) {
    const owner = this.owner(id);
    owner.generation++;
    delete owner.screenshot;
    if (owner.cleanup) return owner.cleanup;
    owner.cleanup = this.cleanupOwner(id).finally(() => { owner.cleanup = null; });
    return owner.cleanup;
  }

  async cleanupOwner(id) {
    const cleanup = [];
    this.workspaceGuard.releaseOwner(id);
    if (this.child || this.nativeOverride) cleanup.push(this.native('release', {}, id));
    for (const job of this.jobs.values()) if (job.owner === id) cleanup.push(this.cancelJob(job));
    for (const [sessionId, owner] of this.terminals) if (owner === id) {
      cleanup.push(this.terminal.dispose(sessionId)); this.terminals.delete(sessionId);
    }
    if (this.capture) cleanup.push(this.capture.releaseOwner(id));
    const results = await Promise.allSettled(cleanup);
    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length) throw new Error(failures.map(r => r.reason?.message || String(r.reason)).join('; '));
  }

  async releasePrefix(prefix) {
    await Promise.all([...this.owners.keys()].filter(id => id.startsWith(prefix)).map(id => this.releaseOwner(id)));
  }

  async close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.closeResources();
    return this.closing;
  }

  async closeResources() {
    await Promise.allSettled([...this.owners.keys()].map(id => this.releaseOwner(id)));
    this.child?.disconnect(); this.child = null;
    await this.capture?.close();
  }
}
// Files-mode result: rank by MATCH COUNT (a file hitting the pattern ten
// times is almost always the relevant one), and tell the model to narrow when
// the pattern matched broadly instead of letting it read 200 files.
// Glob -> RegExp for the no-ripgrep walkers. ripgrep understands {a,b} brace
// alternation; the old builder escaped the braces, so `*.{rs,mjs,js}` matched
// nothing and a zero-hit search read as "the code is absent" (run.txt, 2026-10-30).
// Matched against forward-slash relative paths; `**/` also matches zero dirs.
function compileGlob(glob) {
  if (!glob) return null;
  let source = '';
  let braceDepth = 0;
  const text = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '*') {
      if (text[i + 1] === '*') {
        i += 1;
        if (text[i + 1] === '/') { i += 1; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else if (ch === '{') { braceDepth += 1; source += '(?:'; }
    else if (ch === '}' && braceDepth > 0) { braceDepth -= 1; source += ')'; }
    else if (ch === ',' && braceDepth > 0) source += '|';
    else source += ch.replace(/[.+^$()|[\]\\{}]/g, '\\$&');
  }
  while (braceDepth-- > 0) source += ')';
  return new RegExp(`^${source}$`, 'i');
}

function rankFileMatches(fileCounts, maxResults, root) {
  const ranked = [...fileCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([file, matches]) => ({ file, matches, relative: path.relative(root, file).replaceAll(path.sep, '/') }));
  const list = ranked.slice(0, maxResults);
  const truncated = ranked.length > list.length;
  return {
    files: list,
    totalFiles: ranked.length,
    truncated,
    ...(truncated ? { allFiles: ranked } : {}),
    ...(ranked.length > 40 ? { notice: `${ranked.length} files matched — the pattern is broad. Work down this list by match count (the top file usually owns the feature), or narrow with a more specific pattern, glob, or deeper path.` } : {})
  };
}

module.exports = { ComputerTools, compileGlob };
