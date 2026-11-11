'use strict';

const POINTER_COMMAND_CHANNEL = 'browser-use:agent-pointer-command';
const POINTER_ACK_CHANNEL = 'browser-use:agent-pointer-ack';
const POINTER_ACK_TIMEOUT_MS = 450;
const POINTER_READY_TIMEOUT_MS = 1_500;

class AgentPointerOverlay {
  constructor({ BrowserWindow, ipcMain, parentWindow, htmlPath, preloadPath, resolveViewport, onPressedSurfaceInvalidated = null }) {
    this.BrowserWindow = BrowserWindow;
    this.ipcMain = ipcMain;
    this.parentWindow = parentWindow;
    this.htmlPath = htmlPath;
    this.preloadPath = preloadPath;
    this.resolveViewport = resolveViewport;
    this.onPressedSurfaceInvalidated = onPressedSurfaceInvalidated;
    this.window = null;
    this.ready = false;
    this.disposed = false;
    this.activeTabId = null;
    this.surfaceAvailable = false;
    this.sequence = 0;
    this.pending = new Map();
    // Operation ids come from the controller's per-tab input epoch. They make
    // cancellation exact: ending an older session can freeze only its own
    // trajectory and can never erase a newer action already in flight.
    this.latestOperationIds = new Map();
    this.cancelledOperationIds = new Map();
    this.activeOperationIds = new Map();
    this.pressedTabId = null;
    this.pressedOperationId = null;
    this.pressedSequence = 0;
    this.readyPromise = null;
    this.resolveReady = null;
    this.recoveryTimer = null;
    // Consecutive ack timeouts. A single timeout must NOT hide the window:
    // hiding guarantees the next command cannot paint, so the old
    // hide-on-first-timeout behaviour created a permanent failure cycle.
    this.ackTimeouts = 0;
    this.ackListener = (event, payload) => this.onAcknowledge(event, payload);
    this.ipcMain.on(POINTER_ACK_CHANNEL, this.ackListener);
  }

  create() {
    if (this.disposed) return null;
    if (this.liveWindow()) return this.window;

    this.prepareForLoad();
    const pointerWindow = new this.BrowserWindow({
      parent: this.parentWindow,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
        preload: this.preloadPath
      }
    });
    this.window = pointerWindow;
    pointerWindow.setMenuBarVisibility(false);
    pointerWindow.setIgnoreMouseEvents(true, { forward: true });

    pointerWindow.webContents.on('did-finish-load', () => {
      if (this.window !== pointerWindow || pointerWindow.isDestroyed()) return;
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = null;
      this.ready = true;
      this.resolveReady?.(true);
      this.resolveReady = null;
      this.send({ type: 'reset', tabId: this.activeTabId });
      this.syncBounds();
    });
    pointerWindow.webContents.on('render-process-gone', () => this.handleRendererFailure(pointerWindow, 'pointer-renderer-crashed'));
    pointerWindow.on('unresponsive', () => this.handleRendererFailure(pointerWindow, 'pointer-renderer-unresponsive'));
    pointerWindow.once('closed', () => {
      if (this.window !== pointerWindow) return;
      this.clearPressedInteraction('pointer-window-closed', true);
      this.window = null;
      this.ready = false;
      this.surfaceAvailable = false;
      this.resolveReady?.(false);
      this.resolveReady = null;
      this.resolveAllPending({ interrupted: true, reason: 'pointer-window-closed' });
      if (!this.disposed && this.parentWindow && !this.parentWindow.isDestroyed()) {
        this.recoveryTimer = setTimeout(() => {
          this.recoveryTimer = null;
          if (this.disposed || this.liveWindow()) return;
          this.create();
          this.syncBounds();
        }, 50);
      }
    });
    pointerWindow.loadFile(this.htmlPath).catch(() => this.replaceFailedWindow(pointerWindow));
    return pointerWindow;
  }

  liveWindow() {
    return this.window && !this.window.isDestroyed() ? this.window : null;
  }

  liveContents() {
    const pointerWindow = this.liveWindow();
    if (!pointerWindow) return null;
    const contents = pointerWindow.webContents;
    return contents && !contents.isDestroyed() ? contents : null;
  }

  prepareForLoad() {
    this.resolveReady?.(false);
    this.ready = false;
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  scheduleRendererRecovery(pointerWindow) {
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.disposed || this.window !== pointerWindow || pointerWindow.isDestroyed()) return;
      // A crashed or unresponsive WebContents can leave loadFile pending forever.
      // Replace only this transparent child surface; the controlled page and the
      // parent app window remain untouched.
      this.replaceFailedWindow(pointerWindow);
    }, 50);
    if (typeof this.recoveryTimer.unref === 'function') this.recoveryTimer.unref();
  }

  handleRendererFailure(pointerWindow, reason) {
    if (this.disposed || this.window !== pointerWindow || pointerWindow.isDestroyed()) return;
    this.clearPressedInteraction(reason, true);
    this.resolveAllPending({ interrupted: true, reason });
    this.invalidateActiveOperations();
    this.surfaceAvailable = false;
    if (pointerWindow.isVisible()) pointerWindow.hide();
    if (this.recoveryTimer) return;
    this.prepareForLoad();
    this.scheduleRendererRecovery(pointerWindow);
  }

  replaceFailedWindow(pointerWindow) {
    if (this.disposed || this.window !== pointerWindow) return;
    this.resolveReady?.(false);
    this.resolveReady = null;
    this.window = null;
    if (!pointerWindow.isDestroyed()) pointerWindow.destroy();
    this.create();
    this.syncBounds();
  }

  async waitUntilReady() {
    this.create();
    const expectedWindow = this.liveWindow();
    if (this.ready && this.liveContents()) return true;
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), POINTER_READY_TIMEOUT_MS);
    });
    try {
      const ready = Boolean(await Promise.race([this.readyPromise, timeout]));
      if (!ready && expectedWindow && this.window === expectedWindow) {
        this.handleRendererFailure(expectedWindow, 'pointer-renderer-ready-timeout');
      }
      return ready;
    } finally {
      clearTimeout(timer);
    }
  }

  setSelectedTab(tabId) {
    const nextTabId = tabId ? String(tabId) : null;
    if (nextTabId === this.activeTabId) {
      this.syncBounds();
      return;
    }
    if (this.activeTabId) {
      this.clearPressedInteraction('selected-tab-changed', true);
      this.invalidateOperation(this.activeTabId, this.activeOperationIds.get(this.activeTabId));
    }
    this.activeTabId = nextTabId;
    this.sequence += 1;
    this.resolveAllPending({ interrupted: true, reason: 'selected-tab-changed' });
    this.send({ type: 'reset', tabId: nextTabId, sequence: this.sequence });
    this.syncBounds();
  }

  forgetTab(tabId) {
    const normalizedTabId = String(tabId);
    this.latestOperationIds.delete(normalizedTabId);
    this.cancelledOperationIds.delete(normalizedTabId);
    this.activeOperationIds.delete(normalizedTabId);
    if (normalizedTabId === this.activeTabId) this.setSelectedTab(null);
  }

  syncBounds() {
    const pointerWindow = this.liveWindow();
    if (!pointerWindow || !this.parentWindow || this.parentWindow.isDestroyed()) return false;
    const viewport = this.activeTabId ? this.resolveViewport(this.activeTabId) : null;
    const parentVisible = this.parentWindow.isVisible() && !this.parentWindow.isMinimized();
    if (!viewport || viewport.width <= 0 || viewport.height <= 0 || !parentVisible) {
      if (this.surfaceAvailable || this.pending.size > 0) {
        this.sequence += 1;
        this.resolveAllPending({ interrupted: true, reason: 'pointer-surface-hidden' });
      }
      this.clearPressedInteraction('pointer-surface-hidden', true);
      if (this.activeTabId) this.invalidateOperation(this.activeTabId, this.activeOperationIds.get(this.activeTabId));
      this.surfaceAvailable = false;
      this.send({ type: 'hide' });
      if (pointerWindow.isVisible()) pointerWindow.hide();
      return false;
    }

    const content = this.parentWindow.getContentBounds();
    const bounds = {
      x: Math.round(content.x + viewport.x),
      y: Math.round(content.y + viewport.y),
      width: Math.max(1, Math.round(viewport.width)),
      height: Math.max(1, Math.round(viewport.height))
    };
    const current = pointerWindow.getBounds();
    const sizeChanged = current.width !== bounds.width || current.height !== bounds.height;
    if (current.x !== bounds.x || current.y !== bounds.y || sizeChanged) {
      pointerWindow.setBounds(bounds);
    }
    if (sizeChanged) {
      // Geometry changes cannot preserve a completed low-level mouseDown 1:1
      // when its old coordinate leaves the new viewport. Release the native
      // edge explicitly instead of showing an unpressed pointer while the page
      // still believes a button is held.
      this.clearPressedInteraction('pointer-viewport-resized', true);
      const pendingCommands = [...this.pending.values()].map((entry) => entry.command).filter(Boolean);
      const pendingFitsViewport = pendingCommands.length > 0 && pendingCommands.every((command) => {
        if (!Number.isFinite(command.x) || !Number.isFinite(command.y)) return true;
        return command.x >= 0 && command.y >= 0 && command.x < bounds.width && command.y < bounds.height;
      });
      if (this.surfaceAvailable && this.pending.size > 0 && !pendingFitsViewport) {
        this.sequence += 1;
        this.resolveAllPending({ interrupted: true, reason: 'pointer-viewport-resized' });
      }
      this.send({
        type: 'viewport', sequence: this.sequence, width: bounds.width, height: bounds.height,
        preserveInteraction: pendingFitsViewport,
        preserveMotion: pendingFitsViewport && pendingCommands.some((command) => command.type === 'move')
      });
    }
    pointerWindow.setIgnoreMouseEvents(true, { forward: true });
    if (this.ready && !pointerWindow.isVisible()) pointerWindow.showInactive();
    this.surfaceAvailable = true;
    return true;
  }

  move(tabId, point, { waitForArrival = true, durationMs, operationId } = {}) {
    if (!this.canVisualize(tabId)) return { ignored: true, reason: 'tab-not-visible' };
    if (!this.claimOperation(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
    return this.waitUntilReady().then((ready) => {
      if (!ready || !this.canVisualize(tabId)) return { ignored: true, reason: 'pointer-unavailable' };
      if (!this.operationIsActive(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
      if (!this.syncBounds()) return { ignored: true, reason: 'pointer-surface-unavailable' };
      // syncBounds can synchronously release a held button and cancel this exact
      // operation when a resize makes the prior pointer surface invalid.
      if (!this.operationIsActive(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
      const sequence = ++this.sequence;
      this.resolveAllPending({ interrupted: true, reason: 'superseded', supersededBy: sequence });
      const command = {
        type: 'move', tabId: String(tabId), sequence, x: point.x, y: point.y,
        ...(normalizeOperationId(operationId) !== null ? { operationId: normalizeOperationId(operationId) } : {}),
        ...(Number.isFinite(durationMs) ? { durationMs } : {})
      };
      if (!waitForArrival) {
        this.send(command);
        return { sequence, queued: true };
      }
      return this.sendAcknowledged(command, sequence);
    }).catch((error) => ({ failed: true, reason: String(error?.message || error) }));
  }

  press(tabId, point, button = 'left', { operationId } = {}) {
    if (!this.canVisualize(tabId)) return { ignored: true, reason: 'tab-not-visible' };
    if (!this.claimOperation(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
    return this.waitUntilReady().then((ready) => {
      if (!ready || !this.canVisualize(tabId)) return { ignored: true, reason: 'pointer-unavailable' };
      if (!this.operationIsActive(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
      if (!this.syncBounds()) return { ignored: true, reason: 'pointer-surface-unavailable' };
      if (!this.operationIsActive(tabId, operationId)) return { interrupted: true, reason: 'input-operation-cancelled' };
      const sequence = ++this.sequence;
      this.resolveAllPending({ interrupted: true, reason: 'superseded', supersededBy: sequence });
      return this.sendAcknowledged({
        type: 'press', tabId: String(tabId), sequence, x: point.x, y: point.y, button,
        ...(normalizeOperationId(operationId) !== null ? { operationId: normalizeOperationId(operationId) } : {})
      }, sequence);
    }).catch((error) => ({ failed: true, reason: String(error?.message || error) }));
  }

  release(tabId, point, button = 'left', { operationId } = {}) {
    const normalizedOperationId = normalizeOperationId(operationId);
    if (this.pressedTabId === String(tabId) && (normalizedOperationId === null || normalizedOperationId === this.pressedOperationId)) {
      this.clearPressedInteraction('pointer-released', false);
    }
    return this.sendActivity(tabId, { type: 'release', x: point.x, y: point.y, button }, { operationId });
  }

  cancelPress(tabId, sequence) {
    if (String(tabId) !== this.activeTabId) return { ignored: true, reason: 'tab-not-visible' };
    if (!sequence || Number(sequence) === this.pressedSequence) this.clearPressedInteraction('pointer-press-cancelled', false);
    this.send({ type: 'cancel-press', tabId: String(tabId), sequence: Number(sequence) || 0 });
    return { sent: true, sequence: Number(sequence) || 0 };
  }

  cancelMotion(tabId, operationId, reason = 'input-operation-cancelled') {
    const normalizedTabId = String(tabId);
    const normalizedOperationId = normalizeOperationId(operationId);
    if (normalizedOperationId === null || this.activeOperationIds.get(normalizedTabId) !== normalizedOperationId) {
      return { ignored: true, reason: 'operation-not-active' };
    }
    if (this.pressedTabId === normalizedTabId && this.pressedOperationId === normalizedOperationId) {
      this.clearPressedInteraction(reason, false);
    }
    this.invalidateOperation(normalizedTabId, normalizedOperationId);
    const sequence = ++this.sequence;
    this.resolveOperationPending(normalizedTabId, normalizedOperationId, { interrupted: true, reason });
    const sent = this.send({ type: 'cancel-motion', tabId: normalizedTabId, sequence, operationId: normalizedOperationId, reason });
    return { sent, sequence, operationId: normalizedOperationId };
  }

  activity(tabId, point = null, { operationId } = {}) {
    return this.sendActivity(tabId, { type: 'activity', ...(point ? { x: point.x, y: point.y } : {}) }, { operationId });
  }

  sendActivity(tabId, command, { operationId } = {}) {
    if (!this.canVisualize(tabId)) return { ignored: true, reason: 'tab-not-visible' };
    if (!this.operationIsActive(tabId, operationId)) return { ignored: true, reason: 'operation-not-active' };
    if (!this.syncBounds()) return { ignored: true, reason: 'pointer-surface-unavailable' };
    if (!this.operationIsActive(tabId, operationId)) return { ignored: true, reason: 'operation-not-active' };
    const sent = this.send({
      ...command, tabId: String(tabId), sequence: this.sequence,
      ...(normalizeOperationId(operationId) !== null ? { operationId: normalizeOperationId(operationId) } : {})
    });
    return { sent, sequence: this.sequence };
  }

  canVisualize(tabId) {
    return !this.disposed && String(tabId) === this.activeTabId && Boolean(this.resolveViewport(String(tabId)));
  }

  send(command) {
    const contents = this.liveContents();
    if (!this.ready || !contents) return false;
    try {
      contents.send(POINTER_COMMAND_CHANNEL, command);
      return true;
    } catch {
      const pointerWindow = this.liveWindow();
      if (pointerWindow) this.handleRendererFailure(pointerWindow, 'pointer-command-send-failed');
      return false;
    }
  }

  sendAcknowledged(command, sequence) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(sequence)) return;
        this.pending.delete(sequence);
        resolve({ sequence, timedOut: true });
        this.ackTimeouts = (this.ackTimeouts || 0) + 1;
        if (this.ackTimeouts < 3) return;
        const pointerWindow = this.liveWindow();
        if (pointerWindow) this.handleRendererFailure(pointerWindow, 'pointer-renderer-ack-timeout');
      }, POINTER_ACK_TIMEOUT_MS);
      this.pending.set(sequence, { resolve, timer, command });
      if (!this.send(command)) {
        clearTimeout(timer);
        this.pending.delete(sequence);
        resolve({ sequence, failed: true, reason: 'pointer-command-not-sent' });
      }
    });
  }

  onAcknowledge(event, payload = {}) {
    const contents = this.liveContents();
    if (!contents || event.sender !== contents) return;
    const sequence = Number(payload.sequence);
    const pending = this.pending.get(sequence);
    if (!pending) return;
    this.ackTimeouts = 0;
    clearTimeout(pending.timer);
    this.pending.delete(sequence);
    if (pending.command?.type === 'press' && payload.status === 'painted') {
      this.pressedTabId = String(pending.command.tabId);
      this.pressedOperationId = normalizeOperationId(pending.command.operationId);
      this.pressedSequence = sequence;
    }
    pending.resolve({ sequence, completed: ['settled', 'painted'].includes(payload.status), status: payload.status });
  }

  resolveAllPending(result) {
    for (const [sequence, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ sequence, ...result });
    }
    this.pending.clear();
  }

  resolveOperationPending(tabId, operationId, result) {
    for (const [sequence, pending] of this.pending) {
      const command = pending.command || {};
      if (String(command.tabId) !== String(tabId) || normalizeOperationId(command.operationId) !== operationId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(sequence);
      pending.resolve({ sequence, ...result });
    }
  }

  claimOperation(tabId, operationId) {
    const normalizedOperationId = normalizeOperationId(operationId);
    if (normalizedOperationId === null) return true;
    const normalizedTabId = String(tabId);
    const latest = this.latestOperationIds.get(normalizedTabId) || 0;
    const cancelledThrough = this.cancelledOperationIds.get(normalizedTabId) || 0;
    if (normalizedOperationId < latest || normalizedOperationId <= cancelledThrough) return false;
    this.latestOperationIds.set(normalizedTabId, Math.max(latest, normalizedOperationId));
    this.activeOperationIds.set(normalizedTabId, normalizedOperationId);
    return true;
  }

  operationIsActive(tabId, operationId) {
    const normalizedOperationId = normalizeOperationId(operationId);
    if (normalizedOperationId === null) return true;
    return this.activeOperationIds.get(String(tabId)) === normalizedOperationId
      && normalizedOperationId > (this.cancelledOperationIds.get(String(tabId)) || 0);
  }

  invalidateOperation(tabId, operationId) {
    const normalizedOperationId = normalizeOperationId(operationId);
    if (normalizedOperationId === null) return false;
    const normalizedTabId = String(tabId);
    this.cancelledOperationIds.set(normalizedTabId, Math.max(this.cancelledOperationIds.get(normalizedTabId) || 0, normalizedOperationId));
    if (this.activeOperationIds.get(normalizedTabId) === normalizedOperationId) this.activeOperationIds.delete(normalizedTabId);
    return true;
  }

  invalidateActiveOperations() {
    for (const [tabId, operationId] of this.activeOperationIds) this.invalidateOperation(tabId, operationId);
  }

  clearPressedInteraction(reason, notifyController) {
    const tabId = this.pressedTabId;
    if (!tabId) return false;
    this.pressedTabId = null;
    this.pressedOperationId = null;
    this.pressedSequence = 0;
    if (notifyController && typeof this.onPressedSurfaceInvalidated === 'function') {
      try { this.onPressedSurfaceInvalidated(tabId, reason); } catch {}
    }
    return true;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = null;
    this.resolveAllPending({ interrupted: true, reason: 'disposed' });
    this.clearPressedInteraction('pointer-overlay-disposed', true);
    this.invalidateActiveOperations();
    this.ipcMain.removeListener(POINTER_ACK_CHANNEL, this.ackListener);
    const pointerWindow = this.liveWindow();
    this.window = null;
    this.ready = false;
    this.surfaceAvailable = false;
    if (pointerWindow) pointerWindow.destroy();
  }
}

module.exports = {
  AgentPointerOverlay,
  POINTER_COMMAND_CHANNEL,
  POINTER_ACK_CHANNEL,
  POINTER_ACK_TIMEOUT_MS,
  POINTER_READY_TIMEOUT_MS
};

function normalizeOperationId(operationId) {
  const numeric = Number(operationId);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}
