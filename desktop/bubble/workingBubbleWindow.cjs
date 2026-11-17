'use strict';

// WORKING BUBBLE WINDOW — the always-on-top agent status orb.
//
// When the app is minimised or behind other windows, a run becomes invisible:
// the user cannot tell a long job from a dead one, and a failure is silent
// until they come back. This window fixes that: a small transparent orb in the
// bottom-right corner of the screen, dim until hovered, showing the agent's
// latest message on hover, restoring the app on click.
//
// Design constraints, each learned from the pointer overlay:
//  • The window is LARGER than the bubble and stays transparent, so it can be
//    click-through except while the pointer is over the orb. Otherwise a
//    380x116 rectangle of dead space would sit on the user's desktop.
//  • `focusable: false` — the bubble must never steal focus from the app the
//    user is working in. Clicks still arrive.
//  • `alwaysOnTop('screen-saver')` — a normal floating level drops behind
//    full-screen apps, which is exactly when the user cannot see the app.
//  • Notifications only fire when the app is NOT focused: telling a user who is
//    looking at the transcript that the run finished is noise.

const BUBBLE_WIDTH = 380;
const BUBBLE_HEIGHT = 116;
const SCREEN_MARGIN = 16;
const TRANSIENT_MS = 2600;

class WorkingBubble {
  constructor({ BrowserWindow, ipcMain, Notification, screen, parentWindow, htmlPath, preloadPath, onActivate }) {
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.Notification = Notification;
    this.screen = screen;
    this.parentWindow = parentWindow;
    this.htmlPath = htmlPath;
    this.preloadPath = preloadPath;
    this.onActivate = onActivate;
    this.window = null;
    this.state = { active: false, mode: 'thinking', title: '', text: '' };
    this.transientTimer = null;
    // How long the outcome lingers after a run ends. Instance state so it can
    // be shortened in tests without sleeping for the real duration.
    this.transientMs = TRANSIENT_MS;
    this.registered = false;
  }

  // Is the user already looking at the app? Then the in-drawer orb and the
  // transcript are in front of them and the desktop bubble is redundant.
  appIsFocused() {
    const parent = this.parentWindow;
    if (!parent || parent.isDestroyed()) return false;
    if (parent.isMinimized()) return false;
    return parent.isFocused() === true;
  }

  create() {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const bubble = new this.BrowserWindow({
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      // Windows 11's DWM still paints a 1px accent-coloured frame around a
      // frameless window unless WS_THICKFRAME is dropped. On a transparent
      // overlay that reads as a stray lime line along the right and bottom
      // edges — measured in the user's screenshot as a 1px vertical line 10px
      // right of the orb and a 1px horizontal line 7px below it, i.e. exactly
      // this window's own border. It cannot be seen by capturePage because it
      // is not page content.
      thickFrame: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: this.preloadPath
      }
    });
    this.window = bubble;
    bubble.setMenuBarVisibility(false);
    try { bubble.setAlwaysOnTop(true, 'screen-saver'); } catch { /* level is advisory */ }
    bubble.setIgnoreMouseEvents(true, { forward: true });
    bubble.loadFile(this.htmlPath);
    bubble.on('closed', () => { this.window = null; });
    this.registerIpc();
    return bubble;
  }

  registerIpc() {
    if (this.registered) return;
    this.registered = true;
    // Hover is the only thing that may disable click-through: it is the signal
    // that the pointer is actually over the orb.
    this.ipcMain.on('browser-use:bubble-hover', (_event, inside) => {
      const bubble = this.window;
      if (!bubble || bubble.isDestroyed()) return;
      try { bubble.setIgnoreMouseEvents(inside !== true, { forward: true }); } catch { /* best effort */ }
    });
    this.ipcMain.on('browser-use:bubble-activate', () => {
      try { this.onActivate?.(); } catch { /* activation is best effort */ }
    });
  }

  // The state the main renderer publishes: { active, mode, title, text }.
  update(state) {
    const next = state && typeof state === 'object' ? state : {};
    const mode = String(next.mode || 'thinking');
    const previousMode = this.state.mode;
    this.state = {
      active: next.active === true,
      mode,
      title: String(next.title || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      text: String(next.text || '').replace(/\s+/g, ' ').trim().slice(0, 400)
    };
    this.pushState();

    // A terminal or blocking state is worth interrupting for, exactly once per
    // transition, and only when the user is not already looking at the app.
    const interrupting = mode === 'done' || mode === 'error' || mode === 'waiting';
    if (interrupting && mode !== previousMode) this.notify(mode);

    if (mode === 'done' || mode === 'error') {
      // The run is over. If the user is looking at the app, the bubble leaves
      // at once — the transcript holds the outcome. If they are not, show it
      // for a beat so the corner change is noticed, then leave the desktop
      // alone: a permanently pinned orb after a finished run is clutter.
      if (this.appIsFocused()) { this.hide(); return; }
      this.show();
      this.scheduleTransientHide();
      return;
    }
    if (this.state.active) { this.evaluateVisibility(); return; }
    this.hide();
  }

  scheduleTransientHide() {
    if (this.transientTimer) clearTimeout(this.transientTimer);
    this.transientTimer = setTimeout(() => {
      this.transientTimer = null;
      this.state = { ...this.state, active: false };
      this.hide();
    }, this.transientMs);
    if (typeof this.transientTimer.unref === 'function') this.transientTimer.unref();
  }

  // Visible only while a run is active AND the app is not the window the user
  // is looking at. A focused app already shows the orb above its composer.
  evaluateVisibility() {
    if (!this.state.active) { this.hide(); return; }
    if (this.appIsFocused()) { this.hide(); return; }
    this.show();
  }

  show() {
    const bubble = this.create();
    if (!bubble || bubble.isDestroyed()) return;
    this.position(bubble);
    if (!bubble.isVisible()) bubble.showInactive();
    this.pushState();
  }

  hide() {
    if (this.transientTimer) { clearTimeout(this.transientTimer); this.transientTimer = null; }
    const bubble = this.window;
    if (bubble && !bubble.isDestroyed() && bubble.isVisible()) bubble.hide();
  }

  position(bubble) {
    try {
      const display = this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint());
      const area = display.workArea;
      bubble.setBounds({
        x: Math.round(area.x + area.width - BUBBLE_WIDTH - SCREEN_MARGIN),
        y: Math.round(area.y + area.height - BUBBLE_HEIGHT - SCREEN_MARGIN),
        width: BUBBLE_WIDTH,
        height: BUBBLE_HEIGHT
      });
    } catch { /* positioning is best effort; the default placement still works */ }
  }

  pushState() {
    const bubble = this.window;
    if (!bubble || bubble.isDestroyed()) return;
    const payload = { ...this.state, visible: bubble.isVisible() };
    try { bubble.webContents.send('browser-use:bubble-state', payload); } catch { /* not loaded yet */ }
  }

  notify(mode) {
    if (this.appIsFocused()) return; // already in front of the user
    if (!this.Notification || this.Notification.isSupported?.() === false) return;
    const copy = {
      done: { title: 'Browser-use finished', body: this.state.text || 'The task completed.' },
      error: { title: 'Browser-use stopped', body: this.state.text || 'The run hit an error.' },
      waiting: { title: 'Browser-use needs you', body: this.state.text || 'The agent is waiting for your answer.' }
    }[mode];
    if (!copy) return;
    try {
      const notification = new this.Notification({
        title: copy.title,
        body: String(copy.body).slice(0, 240),
        silent: false
      });
      notification.on('click', () => { try { this.onActivate?.(); } catch { /* best effort */ } });
      notification.show();
    } catch { /* a missing notification backend must never break a run */ }
  }

  destroy() {
    if (this.transientTimer) { clearTimeout(this.transientTimer); this.transientTimer = null; }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}

module.exports = { WorkingBubble, BUBBLE_WIDTH, BUBBLE_HEIGHT };
