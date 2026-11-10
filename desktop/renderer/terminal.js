// Terminal front end, shared by the docked panel and the detached window.
//
// Exposes a single global rather than a module so the sandboxed renderer can
// load it with a plain <script> tag alongside the vendored xterm UMD bundles.
//
// Owns only presentation and keystroke forwarding: the shell itself lives in
// the main process, which is what lets the same session be rendered by either
// window without being restarted when it moves.

(() => {
  const FIT_DEBOUNCE_MS = 60;

  class TerminalController {
    constructor({ surface, onStatus, onSessionChange, onReadOnlyChange }) {
      this.surface = surface;
      this.onStatus = onStatus;
      // Lets the host reflect a dead shell in its chrome (enabling Reset,
      // showing the exit in the backend label) without reaching inside.
      this.onSessionChange = onSessionChange;
      // Read-only mode is reported to the HOST chrome (terminal header), never
      // printed into the xterm view: injected text corrupts full-screen TUI
      // apps (claude code redraws from cursor state) and clears selections.
      this.onReadOnlyChange = onReadOnlyChange;
      this.terminal = null;
      this.fitAddon = null;
      this.sessionId = null;
      this.resizeObserver = null;
      this.fitTimer = null;
      this.pendingWrites = [];
      this.exited = false;
      this.status = null;
      this.starting = null;
      this.hydrated = false;
      // True while the attached session is owned by a running agent task:
      // keystrokes are refused so they cannot interleave with the agent's
      // commands. Ownership release on run end flips this back.
      this.readOnly = false;
      // A detached/re-docked terminal releases only this xterm presentation.
      // The main process keeps the shell alive and a later view adopts it.
      this.presentationReleased = false;
    }

    get isOpen() {
      return Boolean(this.sessionId);
    }

    // True once the shell has exited and before a new one is started. The view
    // is intentionally kept so the scrollback survives, which means the
    // presence of a terminal cannot be used to infer a live session.
    get isDead() {
      return Boolean(this.terminal) && !this.sessionId;
    }

    // Builds the xterm surface without attaching any session. open() uses it
    // for a fresh shell; adopt() uses it to render an existing (agent-owned)
    // session without spawning one.
    ensureView() {
      if (this.terminal) return;
      const css = getComputedStyle(document.documentElement);
      const token = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
      this.terminal = new window.Terminal({
        fontFamily: 'ui-monospace, Consolas, "Cascadia Mono", monospace',
        fontSize: 13,
        cursorBlink: true,
        allowProposedApi: true,
        scrollback: 5000,
        theme: {
          background: token('--bu-canvas', '#060b0d'), foreground: token('--bu-text', '#edf2f2'),
          cursor: token('--bu-accent', '#c8ff00'), cursorAccent: token('--bu-accent-ink', '#071012'),
          selectionBackground: '#c8ff0030',
          black: '#0a1012', brightBlack: '#5f7278',
          red: '#ef4f64', brightRed: '#ff8b9b', green: '#c8ff00', brightGreen: '#deff69',
          yellow: '#e0af68', brightYellow: '#ffda90', blue: '#6fa8df', brightBlue: '#a4cdff',
          magenta: '#c6a0dc', brightMagenta: '#e3bafa', cyan: '#70c8ce', brightCyan: '#9be7eb',
          white: '#c1cbce', brightWhite: '#edf2f2'
        }
      });
      this.fitAddon = new window.FitAddon.FitAddon();
      this.terminal.loadAddon(this.fitAddon);
      // GPU rendering: the DOM renderer is blurry and artifact-prone under
      // full-screen TUI apps that repaint constantly (claude code). The WebGL
      // renderer fixes both; if the context is lost or unavailable, dispose
      // and fall back to the DOM renderer rather than showing garbage.
      try {
        if (window.WebglAddon) {
          const webgl = new window.WebglAddon();
          // Context loss (GPU reset, headless capture): dispose and let xterm
          // fall back to the DOM renderer instead of showing garbage.
          webgl.onContextLoss?.(() => { try { webgl.dispose(); } catch {} this.webglAddon = null; });
          this.terminal.loadAddon(webgl);
          this.webglAddon = webgl;
        }
      } catch { this.webglAddon = null; }
      this.terminal.open(this.surface);
      this.presentationReleased = false;
      this.fit();
    }

    async open() {
      // A shell that has exited leaves the view in place, so reopening the
      // panel must start a new session rather than treat the dead one as live.
      if (this.terminal && this.isDead) return this.restart();
      if (this.terminal) {
        // Reopening a visible panel should only re-measure; tearing the
        // session down would discard the user's shell history.
        if (!this.resizeObserver) {
          this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
          this.resizeObserver.observe(this.surface);
        }
        this.presentationReleased = false;
        this.fit();
        return this.sessionId;
      }
      this.ensureView();

      // A shell that cannot be spawned must leave a usable view behind: the
      // failure is reported in place and Reset can retry, rather than throwing
      // out of open() and leaving an empty panel with no way forward.
      let created;
      try {
        created = await window.browserUseDesktop.terminalActiveSession({
          cols: this.terminal.cols,
          rows: this.terminal.rows
        });
        if (!created) {
          created = await window.browserUseDesktop.terminalCreate({
            cols: this.terminal.cols,
            rows: this.terminal.rows
          });
        }
      } catch (error) {
        this.markExited(error?.message ? `could not start the shell: ${error.message}` : 'could not start the shell');
        this.attachViewListeners();
        return null;
      }
      this.sessionId = created.id;
      this.exited = false;
      this.status = created;
      this.onStatus?.(created);
      this.onSessionChange?.({ alive: true, status: created });

      // A broker-owned session can predate this Electron renderer. Restore its
      // bounded scrollback before subscribing to live chunks, so reopening the
      // app shows the shell state that continued while the UI was closed.
      if (created.history) this.terminal.write(created.history);

      this.attachViewListeners();

      // Output can arrive between session creation and the listener attaching,
      // so anything buffered by the host is flushed once here.
      for (const chunk of this.pendingWrites) this.terminal.write(chunk);
      this.pendingWrites = [];
      this.terminal.focus();
      return this.sessionId;
    }

    // Bound to the view, not to a session, so they keep working across a
    // restart. Each guards on the current session id, which is null while the
    // shell is dead , keystrokes are dropped instead of being written into a
    // shell that no longer exists.
    attachViewListeners() {
      if (this.viewListenersAttached) return;
      this.viewListenersAttached = true;
      this.terminal.onData((data) => {
        if (this.sessionId) {
          // An agent-owned session is watch-only: user keystrokes would
          // interleave with the agent's commands and corrupt both.
          if (this.readOnly) {
            // Report to the host chrome only , never write into the view.
            this.onReadOnlyChange?.(true);
            return;
          }
          window.browserUseDesktop.terminalWrite(this.sessionId, data);
          return;
        }
        // With no shell attached, Enter is the shortcut for Reset: it matches
        // what a dead prompt invites the user to try first.
        if (this.exited && (data === '\r' || data === '\n')) this.restart();
      });
      // xterm reflows on element resize, and the shell must be told the new
      // size or its line wrapping disagrees with what is drawn.
      this.terminal.onResize(({ cols, rows }) => {
        if (this.sessionId) window.browserUseDesktop.terminalResize(this.sessionId, cols, rows);
      });
      this.surface.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        window.browserUseDesktop.showContextMenu({
          kind: 'terminal',
          terminalId: this.sessionId,
          selection: this.terminal?.getSelection?.() || ''
        }).catch(() => {});
      });
      window.browserUseDesktop.onTerminalSelectAll(() => this.terminal?.selectAll());
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.surface);
    }

    // Starts a fresh shell in the existing view, keeping the scrollback so the
    // output that led to the failure stays readable. Safe to call whether the
    // current session is dead, alive, or never started. Never while the view
    // is attached to an agent-owned session: Reset would dispose the agent's
    // shell mid-task.
    async restart() {
      if (this.readOnly) {
        this.onReadOnlyChange?.(true);
        return this.sessionId;
      }
      if (this.starting) return this.starting;
      this.starting = (async () => {
        if (this.sessionId) {
          const previous = this.sessionId;
          this.sessionId = null;
          try { await window.browserUseDesktop.terminalDispose(previous); } catch {}
        }
        if (!this.terminal) return this.open();
        this.fit();
        let created;
        try {
          created = await window.browserUseDesktop.terminalCreate({
            cols: this.terminal.cols,
            rows: this.terminal.rows
          });
        } catch (error) {
          this.markExited(error?.message ? `could not start the shell: ${error.message}` : 'could not start the shell');
          return null;
        }
        this.sessionId = created.id;
        this.exited = false;
        this.status = created;
        // Not a viewport clear: the previous shell was disposed and a new one
        // spawned with the broker's freshest environment, so a fixed API key
        // or system config applies from this prompt onward.
        this.print('Terminal restarted , new shell, current environment.', '32');
        this.onStatus?.(created);
        this.onSessionChange?.({ alive: true, status: created });
        this.attachViewListeners();
        this.terminal.focus();
        return this.sessionId;
      })().finally(() => { this.starting = null; });
      return this.starting;
    }

    // Attaches this view to an existing broker session , typically an
    // agent-owned one the user wants to watch. Restores the session's
    // scrollback from the broker snapshot; the previous view's scrollback is
    // intentionally cleared (switching sessions, not appending streams).
    async adopt(sessionId, { history = '', readOnly = false, status = null } = {}) {
      this.ensureView();
      if (!this.resizeObserver) {
        this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
        this.resizeObserver.observe(this.surface);
      }
      this.terminal.reset();
      this.sessionId = sessionId;
      this.status = status || { id: sessionId, alive: true, phase: 'ready' };
      this.exited = ['exited', 'error'].includes(this.status.phase);
      this.readOnly = Boolean(readOnly);
      this.presentationReleased = false;
      if (history) this.terminal.write(history);
      this.attachViewListeners();
      this.fit();
      // The watch-only notice lives in the host header, never in the TUI.
      this.onReadOnlyChange?.(this.readOnly);
      if (!readOnly) this.terminal.focus();
      return this.sessionId;
    }

    // One place to record that no shell is attached, so the notice and the
    // host's chrome cannot disagree about whether the terminal is usable.
    markExited(reason) {
      this.sessionId = null;
      this.exited = true;
      this.readOnly = false;
      if (reason) this.print(reason, '31');
      this.onReadOnlyChange?.(false);
      this.onSessionChange?.({ alive: false, reason: reason || null });
    }

    write(id, data) {
      if (id !== this.sessionId) return;
      if (!this.terminal) {
        this.pendingWrites.push(data);
        return;
      }
      // Preserve the user's scroll position: xterm may snap to the bottom as
      // streamed data lands, which makes reading a working TUI impossible.
      // Capture the viewport line before the write and restore it after the
      // write settles (xterm writes are buffered, hence the callback).
      const buffer = this.terminal.buffer.active;
      const viewportLine = buffer.viewportY;
      const scrolledUp = viewportLine < buffer.length - this.terminal.rows;
      this.terminal.write(data, () => {
        if (scrolledUp && this.terminal) this.terminal.scrollToLine(Math.min(viewportLine, this.terminal.buffer.active.length - 1));
      });
    }

    notifyExit(id, exitCode, status = null) {
      if (id !== this.sessionId) return;
      // A null code means the session was torn down by the host rather than
      // ended by the shell, so reporting it as an exit code reads as a fault
      // when it is usually a normal close.
      const cause = exitCode === null || exitCode === undefined
        ? 'session closed'
        : `process exited with code ${exitCode}`;
      const colour = exitCode ? '31' : '90';
      this.terminal?.write(`\r\n\x1b[${colour}m[${cause}]\x1b[0m\r\n`);
      this.terminal?.write('\x1b[90mPress Enter or use Reset to start a new shell.\x1b[0m\r\n');
      this.exited = true;
      this.status = status || { id, alive: false, phase: exitCode ? 'error' : 'exited', exitCode: exitCode ?? null, error: exitCode ? cause : null };
      this.onReadOnlyChange?.(false);
      this.onSessionChange?.({ ...this.status, alive: false, reason: this.status.error || cause, exitCode: exitCode ?? null });
    }

    // Used by the Screenshot and Select actions: the text lands at the prompt
    // as though it had been typed, so it can be edited before running.
    insert(text) {
      if (!this.sessionId || this.readOnly) return false;
      window.browserUseDesktop.terminalWrite(this.sessionId, String(text));
      this.terminal?.focus();
      return true;
    }

    // Status lines are written directly to the view rather than to the shell,
    // so they cannot be mistaken for command input.
    print(text, colour = '90') {
      this.terminal?.write(`\r\n\x1b[${colour}m${text}\x1b[0m\r\n`);
    }

    scheduleFit() {
      clearTimeout(this.fitTimer);
      this.fitTimer = setTimeout(() => this.fit(), FIT_DEBOUNCE_MS);
    }

    fit() {
      // A hidden or zero-height panel makes fit() compute a nonsense geometry,
      // so measuring is skipped until the surface actually has a box.
      if (!this.fitAddon || this.surface.clientHeight <= 0 || this.surface.clientWidth <= 0) return;
      try {
        this.fitAddon.fit();
      } catch {}
    }

    focus() {
      this.terminal?.focus();
    }

    // Detach/re-dock is a presentation change, not a request to stop the shell.
    // Disconnect this surface so a hidden dock cannot resize the session after a
    // detached window adopts it. The local id is retained for later re-docking.
    releaseView() {
      this.presentationReleased = true;
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      clearTimeout(this.fitTimer);
    }

    dispose() {
      this.resizeObserver?.disconnect();
      this.resizeObserver = null;
      clearTimeout(this.fitTimer);
      // Never tear down an agent-owned session from the view: closing the
      // panel must not kill the agent's long-running task.
      if (this.sessionId && !this.readOnly) window.browserUseDesktop.terminalDispose(this.sessionId);
      this.sessionId = null;
      this.exited = false;
      this.readOnly = false;
      this.viewListenersAttached = false;
      this.terminal?.dispose();
      this.terminal = null;
      this.onReadOnlyChange?.(false);
      this.onSessionChange?.({ alive: false, reason: 'disposed' });
    }
  }

  window.BrowserUseTerminal = { TerminalController };
})();
