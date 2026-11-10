'use strict';

// Shell backend for the docked terminal.
//
// Prefers a real PTY (node-pty), which gives a genuine TTY: ANSI colour,
// in-shell history, interactive prompts, and full-screen programs. node-pty
// ships N-API prebuilds, so it loads under Electron's ABI without a rebuild —
// but a native module can still fail to load on a machine that is missing a
// runtime, and a terminal that refuses to open is worse than a reduced one.
//
// The fallback spawns the same shell with piped stdio. It cannot be a TTY, so
// the shell does not echo and no line editor exists; this module supplies both
// so typing still behaves. Interactive full-screen programs remain unavailable
// there, and the caller is told which backend it got rather than left guessing.

const os = require('node:os');
const { spawn } = require('node:child_process');

const DEFAULT_COLUMNS = 80;
const DEFAULT_ROWS = 24;
const MAX_SESSIONS = 8;

// Bumped whenever session-spawn behavior changes in a way a long-lived broker
// process cannot honor without being replaced (its in-memory code predates the
// change and it stays alive across Desktop restarts). The client compares this
// against the broker's reported version and restarts an outdated broker once.
// v3: acknowledged input revisions, lifecycle state, tombstones, Claude auth selection.
const TERMINAL_CONTRACT_VERSION = 3;

const { defaultShell } = require('./shellPreference.cjs');

// Credential variables inherited from a long-lived host process silently
// override the CURRENT on-disk configuration of CLI tools: an API key captured
// when the terminal broker first launched keeps beating the fresh key the user
// just wrote to their config or system environment (the "insufficient balance
// everywhere but my terminals" bug). Terminal sessions drop them from the
// inherited snapshot so shells resolve credentials the way a fresh system
// terminal does — from config files and the current user environment. The
// broker's pushed env (fresh on every Desktop connect) still wins, so a key
// that legitimately lives in an environment variable is not lost.
const STALE_CREDENTIAL_EXACT = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_MODEL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_API_BASE', 'CLAUDE_CODE_API_KEY',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY',
  'ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'ZHIPU_API_KEY', 'GLM_API_KEY',
  'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'GROQ_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'PERPLEXITY_API_KEY', 'COHERE_API_KEY'
]);
const STALE_CREDENTIAL_RE = /(?:API_KEY|APIKEY|AUTH_TOKEN|API_TOKEN|_BASE_URL)$/;

function isStaleCredentialKey(key) {
  return STALE_CREDENTIAL_EXACT.has(key) || STALE_CREDENTIAL_RE.test(key);
}

function stripStaleCredentials(env = {}) {
  const dropped = [];
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (isStaleCredentialKey(key)) { dropped.push(key); continue; }
    clean[key] = value;
  }
  return { env: clean, dropped };
}

const TERMINAL_QUIET_MS = 5_000;
const READY_OUTPUT_RE = /(?:^|[\r\n])(?:PS [^\r\n]*>|[^\r\n]*[$#>] ?)$|Claude Code|Try "|❯|bypass permissions/i;

function resolveSessionEnvironment(env = {}, { profile = 'shell', credentialMode = 'auto' } = {}) {
  const clean = { ...env };
  let credentialSource = 'none';
  if (profile === 'claude-code') {
    const requested = ['api-key', 'auth-token'].includes(credentialMode) ? credentialMode : 'auto';
    const hasApiKey = Boolean(clean.ANTHROPIC_API_KEY);
    const hasAuthToken = Boolean(clean.ANTHROPIC_AUTH_TOKEN);
    credentialSource = requested === 'api-key' ? (hasApiKey ? 'api-key' : 'none')
      : requested === 'auth-token' ? (hasAuthToken ? 'auth-token' : 'none')
        : hasApiKey ? 'api-key' : hasAuthToken ? 'auth-token' : 'profile';
    if (credentialSource === 'api-key') delete clean.ANTHROPIC_AUTH_TOKEN;
    else if (credentialSource === 'auth-token') delete clean.ANTHROPIC_API_KEY;
    else { delete clean.ANTHROPIC_API_KEY; delete clean.ANTHROPIC_AUTH_TOKEN; }
  }
  return { env: clean, credentialSource };
}

function lifecyclePhase(session) {
  if (session.phase === 'running' && session.lastOutputAt && Date.now() - session.lastOutputAt >= TERMINAL_QUIET_MS) return 'quiet';
  return session.phase;
}

// defaultShell(): PowerShell 7 (pwsh) when installed, otherwise the Windows
// built-in powershell.exe (or COMSPEC when it points at PowerShell). On
// other platforms the user's login shell.

// The two backends need different invocations and conflating them hangs the
// shell. Under a PTY the shell is interactive: it owns a TTY, prints its own
// prompt, and reads keystrokes, so it takes no command flags. Under pipes there
// is no TTY, so the shell must be told explicitly to read commands from stdin —
// and `-Command -` would block forever waiting for EOF if a PTY handed it a
// terminal instead.
function shellArguments(shell, backend) {
  if (process.platform !== 'win32') return backend === 'pty' ? ['-i'] : ['-s'];
  if (!/powershell|pwsh/i.test(shell)) return [];
  return backend === 'pty' ? ['-NoLogo'] : ['-NoLogo', '-NoProfile', '-Command', '-'];
}

// Resolved once: a module that failed to load will not succeed on retry, and
// re-requiring it per session would repeat the cost for every terminal.
let ptyModule;
let ptyLoadError = null;

function loadPty() {
  if (ptyModule !== undefined) return ptyModule;
  try {
    ptyModule = require('node-pty');
  } catch (error) {
    ptyLoadError = String(error && error.message);
    ptyModule = null;
  }
  return ptyModule;
}

class TerminalSession {
  constructor({ id, cwd, cols, rows, env, onData, onExit, virtual, profile = 'shell', credentialMode = 'auto', launchName = '', recoveryCommand = '' }) {
    this.id = id;
    this.cols = clamp(cols, 20, 400, DEFAULT_COLUMNS);
    this.rows = clamp(rows, 5, 200, DEFAULT_ROWS);
    this.onData = onData;
    this.onExit = onExit;
    // A virtual session has no shell: it is a view-only transcript surface.
    // The agent's execute commands are mirrored into one so the user can watch
    // native execution in the docked panel; writes append to the view instead
    // of feeding a process, and the session never exits on its own.
    this.virtual = Boolean(virtual);
    this.shell = this.virtual ? 'agent-execute' : defaultShell();
    this.cwd = cwd || os.homedir();
    this.profile = this.virtual ? 'activity' : profile === 'claude-code' ? 'claude-code' : 'shell';
    this.credentialMode = credentialMode;
    this.launchName = String(launchName || '');
    this.recoveryCommand = String(recoveryCommand || '');
    this.phase = this.virtual ? 'ready' : 'starting';
    this.inputRevision = 0;
    this.outputRevision = 0;
    this.lastOutputAt = 0;
    this.exitCode = null;
    this.error = null;
    // Merge order matters: the long-lived host's snapshot loses every
    // credential-shaped variable (stale by definition — it predates whatever
    // config the user changed), then the explicitly supplied env — which the
    // client refreshes from the CURRENT registry (user + machine scopes) on
    // every push — wins on top. So a system-wide key keeps working with its
    // current value, while stale inherited copies never shadow on-disk config.
    const host = stripStaleCredentials(process.env);
    const droppedStale = host.dropped.filter((key) => !(env && key in env));
    const resolved = resolveSessionEnvironment({ ...host.env, ...(env || {}) }, { profile: this.profile, credentialMode });
    this.env = { ...resolved.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    this.credentialSource = resolved.credentialSource;
    this.staleEnvKeys = droppedStale;
    this.disposed = false;
    this.backend = this.virtual ? 'virtual' : 'pty';
    this.lineBuffer = '';
    this.process = null;
    if (!this.virtual) this.start();
  }

  start() {
    const pty = loadPty();
    if (pty) {
      try {
        this.process = pty.spawn(this.shell, shellArguments(this.shell, 'pty'), {
          name: 'xterm-256color',
          cols: this.cols,
          rows: this.rows,
          cwd: this.cwd,
          env: this.env,
          useConpty: process.platform === 'win32'
        });
        this.process.onData((data) => this.emit(data));
        this.process.onExit(({ exitCode }) => this.finish(exitCode));
        this.backend = 'pty';
        this.emitStaleEnvNotice();
        return;
      } catch (error) {
        ptyLoadError = String(error && error.message);
        this.process = null;
      }
    }
    // A working directory that no longer exists is a common cause of a shell
    // that dies the instant it starts. Falling back to the home directory
    // keeps the terminal usable instead of failing with a bare exit code.
    try {
      this.startPiped();
    } catch (error) {
      if (this.cwd !== os.homedir()) {
        this.emit(`\r\n\x1b[33mCould not start in ${this.cwd}: ${error.message}. Falling back to the home directory.\x1b[0m\r\n`);
        this.cwd = os.homedir();
        this.startPiped();
        return;
      }
      this.emit(`\r\n\x1b[31mTerminal failed to start: ${error.message}\x1b[0m\r\n`);
      this.finish(1);
    }
  }

  startPiped() {
    this.backend = 'piped';
    this.process = spawn(this.shell, shellArguments(this.shell, 'piped'), {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.process.stdout.on('data', (chunk) => this.emit(chunk.toString('utf8')));
    this.process.stderr.on('data', (chunk) => this.emit(chunk.toString('utf8')));
    this.process.on('exit', (code) => this.finish(code ?? 0));
    this.process.on('error', (error) => {
      this.emit(`\r\n\x1b[31mTerminal failed to start: ${error.message}\x1b[0m\r\n`);
      this.finish(1, error);
    });
    this.emit(`\x1b[33mReduced terminal: the native PTY module is unavailable${ptyLoadError ? ` (${ptyLoadError})` : ''}.\x1b[0m\r\n`);
    this.emit('\x1b[90mCommands run normally. Full-screen interactive programs are not supported in this mode.\x1b[0m\r\n');
  }

  emit(data) {
    if (this.disposed) return;
    const text = String(data ?? '');
    this.outputRevision += 1;
    this.lastOutputAt = Date.now();
    if (READY_OUTPUT_RE.test(text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ''))) this.phase = 'ready';
    else if (!['exited', 'error'].includes(this.phase)) this.phase = 'running';
    this.onData?.(text, this.status());
  }

  // Visibility for the stale-env drop: a user debugging "why does the shell
  // see a different key than my other terminals" must be able to see that the
  // inherited credential variables were deliberately removed.
  emitStaleEnvNotice() {
    if (!this.staleEnvKeys?.length) return;
    const names = this.staleEnvKeys.slice(0, 6).join(', ');
    const more = this.staleEnvKeys.length > 6 ? ` (+${this.staleEnvKeys.length - 6} more)` : '';
    this.emit(`\r\n\x1b[90m[environment] dropped stale credential variables from the host: ${names}${more}. Shells use the current on-disk configuration.\x1b[0m\r\n`);
  }

  finish(exitCode, error = null) {
    if (this.disposed || ['exited', 'error'].includes(this.phase)) return;
    // The backend process is gone, but its PTY/pipe handles are not: on
    // Windows ConPTY keeps the console server alive until kill() closes it,
    // which otherwise pins the host event loop for every naturally exited
    // session. Kill explicitly here; dispose() later is then a no-op.
    this.forceKill();
    this.exitCode = exitCode ?? null;
    this.error = error ? String(error.message || error) : exitCode ? `Process exited with code ${exitCode}.` : null;
    this.phase = this.error ? 'error' : 'exited';
    this.onExit?.(this.exitCode, this.status());
  }

  write(data) {
    if (this.disposed) return false;
    if (this.virtual) {
      this.emit(String(data ?? ''));
      return true;
    }
    if (!this.process) return false;
    const text = String(data ?? '');
    this.inputRevision += 1;
    if (!['exited', 'error'].includes(this.phase)) this.phase = 'running';
    if (this.backend === 'pty') {
      // Enter submits. The Enter key sends CR, so translate programmatic
      // newlines to CR before the PTY sees them: PSReadLine treats a bare LF
      // as "insert newline", which silently turned a submitted command into a
      // multi-line continuation buffer. \r\n collapses to one Enter.
      this.process.write(text.replace(/\r?\n/g, '\r'));
      return true;
    }
    return this.writePiped(text);
  }

  submit(text) {
    if (this.disposed || this.virtual || !this.process) return false;
    const command = String(text ?? '').replace(/[\r\n]+$/g, '');
    return this.write(`${command}\r`);
  }

  // A piped shell has no TTY, so nothing echoes what was typed and nothing
  // interprets a backspace. xterm delivers raw keystrokes, so the line editor
  // has to live here for typing to look like typing.
  writePiped(text) {
    for (const character of text) {
      if (character === '\r' || character === '\n') {
        this.emit('\r\n');
        this.process.stdin.write(`${this.lineBuffer}\n`);
        this.lineBuffer = '';
        continue;
      }
      if (character === '\x7f' || character === '\b') {
        if (this.lineBuffer.length === 0) continue;
        this.lineBuffer = this.lineBuffer.slice(0, -1);
        this.emit('\b \b');
        continue;
      }
      if (character === '\x03') {
        this.lineBuffer = '';
        this.emit('^C\r\n');
        continue;
      }
      // Skip control characters the line editor cannot represent, rather than
      // echoing bytes that would corrupt the rendered line.
      if (character < ' ') continue;
      this.lineBuffer += character;
      this.emit(character);
    }
    return true;
  }

  resize(cols, rows) {
    this.cols = clamp(cols, 20, 400, this.cols);
    this.rows = clamp(rows, 5, 200, this.rows);
    if (this.disposed || this.backend !== 'pty' || !this.process) return false;
    try {
      this.process.resize(this.cols, this.rows);
      return true;
    } catch {
      return false;
    }
  }

  // Inserts text as if typed, used by the screenshot and DOM-select actions.
  paste(text) {
    return this.write(String(text ?? ''));
  }

  dispose() {
    if (this.disposed) {
      this.forceKill();
      return;
    }
    this.disposed = true;
    this.forceKill();
  }

  forceKill() {
    if (!this.process) return;
    try {
      if (this.backend === 'pty') this.process.kill();
      else this.process.kill('SIGTERM');
    } catch {}
    this.process = null;
  }

  status() {
    return {
      id: this.id, backend: this.backend, shell: this.shell, cwd: this.cwd, cols: this.cols, rows: this.rows,
      disposed: this.disposed, virtual: this.virtual, alive: Boolean(this.process) || this.virtual,
      phase: lifecyclePhase(this), inputRevision: this.inputRevision, outputRevision: this.outputRevision,
      lastOutputAt: this.lastOutputAt, exitCode: this.exitCode, error: this.error,
      profile: this.profile, credentialMode: this.credentialMode, credentialSource: this.credentialSource,
      launchName: this.launchName, recoveryAvailable: this.profile === 'claude-code' && ['exited', 'error'].includes(this.phase)
    };
  }
}

class TerminalManager {
  constructor({ onData, onExit } = {}) {
    this.sessions = new Map();
    this.onData = onData;
    this.onExit = onExit;
    this.nextId = 1;
  }

  create({ cwd, cols, rows, env, virtual, profile, credentialMode, launchName, recoveryCommand } = {}) {
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(`At most ${MAX_SESSIONS} terminal sessions can be open at once.`);
    const id = `term-${this.nextId++}`;
    const session = new TerminalSession({
      id,
      cwd,
      cols,
      rows,
      env,
      virtual,
      profile,
      credentialMode,
      launchName,
      recoveryCommand,
      onData: (data, status) => this.onData?.(id, data, status),
      onExit: (code, status) => this.onExit?.(id, code, status)
    });
    this.sessions.set(id, session);
    return session.status();
  }

  get(id) {
    return this.sessions.get(String(id)) || null;
  }

  write(id, data) {
    return this.get(id)?.write(data) ?? false;
  }

  paste(id, text) {
    return this.get(id)?.paste(text) ?? false;
  }

  submit(id, text) {
    const session = this.get(id);
    if (!session) return null;
    const accepted = session.submit(text);
    return { accepted, submitted: accepted, status: session.status() };
  }

  recover(id) {
    const previous = this.get(id);
    if (!previous || previous.profile !== 'claude-code' || !['exited', 'error'].includes(previous.phase)) return null;
    const options = {
      cwd: previous.cwd, cols: previous.cols, rows: previous.rows, env: previous.env,
      profile: previous.profile, credentialMode: previous.credentialMode, launchName: previous.launchName,
      recoveryCommand: previous.recoveryCommand
    };
    this.dispose(id);
    const created = this.create(options);
    if (previous.recoveryCommand) this.submit(created.id, previous.recoveryCommand);
    return this.snapshot(created.id);
  }

  resize(id, cols, rows) {
    return this.get(id)?.resize(cols, rows) ?? false;
  }

  dispose(id) {
    const session = this.get(id);
    if (!session) return false;
    this.sessions.delete(String(id));
    session.dispose();
    // Session.dispose() marks the session inactive before terminating the child,
    // so its native exit callback intentionally does nothing. Emit an explicit
    // disposed state so clients remove this entry, unlike a natural exit whose
    // tombstone and history remain available for recovery.
    this.onExit?.(String(id), null, { ...session.status(), disposed: true, alive: false, phase: 'exited' });
    return true;
  }

  disposeAll() {
    const ids = [...this.sessions.keys()];
    for (const id of ids) this.dispose(id);
    return ids.length;
  }

  list() {
    return [...this.sessions.values()].map((session) => session.status());
  }

  snapshot(id) {
    const session = this.get(id);
    if (!session) return null;
    return session.status();
  }

  setDimensions(id, cols, rows) {
    const session = this.get(id);
    if (!session) return null;
    session.resize(cols, rows);
    return session.status();
  }

  // Reported in Settings so a reduced terminal is visible rather than inferred
  // from missing behaviour.
  backendInfo() {
    const available = Boolean(loadPty());
    return { ptyAvailable: available, backend: available ? 'pty' : 'piped', error: available ? null : ptyLoadError };
  }
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numeric)));
}

module.exports = { TerminalManager, TerminalSession, DEFAULT_COLUMNS, DEFAULT_ROWS, MAX_SESSIONS, TERMINAL_CONTRACT_VERSION, isStaleCredentialKey, resolveSessionEnvironment };
