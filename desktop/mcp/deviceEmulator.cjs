'use strict';

// Owns CDP device emulation for managed tabs: viewport metrics, touch input,
// user-agent identity, and native gesture dispatch.
//
// Everything runs through webContents.debugger rather than sendInputEvent,
// because Electron's synthetic input API can only express mouse and keyboard.
// A page under a device profile must never receive a mouse event, and only
// Input.dispatchTouchEvent produces contacts a page cannot distinguish from a
// real finger — including simultaneous ones, which sendInputEvent cannot
// express at all.
//
// Two behaviours are load-time, not call-time, and drive the design:
//   * Emulation.setEmitTouchEventsForMouse makes Chromium convert the human's
//     physical mouse into touch before the page sees it. That is what removes
//     the pointer as an input device rather than merely hiding it.
//   * "ontouchstart" in window is resolved when a document is created, so a
//     page already loaded when emulation is enabled keeps reporting no touch
//     support and takes its desktop branch. Applying a mode therefore reloads
//     the tab, which is also what DevTools device mode does.

const { getDeviceProfile, resolveViewport, DESKTOP_ID } = require('../../src/browser/deviceProfiles.cjs');
const { buildTouchOverlayExpression, buildDeviceZoomWatcherExpression } = require('../../src/browser/touchOverlay.cjs');
const { buildGesture } = require('../../src/browser/gestureEngine.cjs');

const RELOAD_TIMEOUT_MS = 10_000;
const GESTURE_POINT_LIMIT = 5;

// Device-canvas zoom bounds. The zoom factor multiplies the fit-to-stage scale
// and NEVER the emulated layout viewport: 0.5 shows the device half size,
// 3.0 three times, while window.innerWidth and every agent coordinate stay in
// the device's own CSS pixels (see deviceZoom_flow_chat.md).
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.1;

class DeviceEmulator {
  constructor({ getTabs, initialZooms = null, onZoomPersist = null } = {}) {
    this.getTabs = getTabs;
    // tabId -> { profileId, orientation, showTouches }
    this.modes = new Map();
    this.fittedViewports = new Map();
    this.fitPromises = new Map();
    // tabId -> true once this class attached the debugger itself.
    this.attached = new Map();
    // tabId -> the display scale (fit-to-stage x zoom) last sent to CDP. CDP
    // touch coordinates are read in the VISUAL pixel space of the emulated
    // surface and divided by this scale to reach device CSS pixels, so this is
    // the exact factor the gesture dispatch path must convert with.
    this.displayScales = new Map();
    // tabId -> clamped zoom factor for the active profile. A tab without an
    // entry reports 1.0.
    this.zooms = new Map();
    // profileId -> persisted zoom (settings.deviceZoomByProfile), so the same
    // device comes back at the size its owner left it.
    this.profileZooms = new Map();
    for (const [profileId, factor] of Object.entries(initialZooms && typeof initialZooms === 'object' ? initialZooms : {})) {
      const clamped = clampZoom(Number(factor));
      if (Number.isFinite(clamped)) this.profileZooms.set(String(profileId), clamped);
    }
    this.onZoomPersist = typeof onZoomPersist === 'function' ? onZoomPersist : null;
  }

  // A tab out of device mode has no zoomed surface to speak of; every caller
  // (state reporting, display sizing) reads 1.0 there.
  zoomFor(tabId) {
    return this.zooms.get(tabId) ?? 1;
  }

  setZoomFactor(tabId, factor) {
    const clamped = clampZoom(Number(factor));
    if (!Number.isFinite(clamped)) throw new Error('Zoom must be a number between 0.5 and 3.');
    return this.applyZoom(tabId, clamped);
  }

  // One Ctrl+wheel notch: deltaY < 0 (wheel up) zooms in.
  zoomBy(tabId, direction) {
    const step = Number(direction) >= 0 ? ZOOM_STEP : -ZOOM_STEP;
    return this.applyZoom(tabId, clampZoom(this.zoomFor(tabId) + step));
  }

  applyZoom(tabId, clamped) {
    const mode = this.modes.get(tabId);
    if (!mode) throw new Error('Zoom applies only while a mobile or tablet profile is active. Call browser_set_device_mode first.');
    const previous = this.zooms.get(tabId) ?? 1;
    this.zooms.set(tabId, clamped);
    this.profileZooms.set(mode.profileId, clamped);
    if (this.onZoomPersist && clamped !== previous) this.onZoomPersist(mode.profileId, clamped);
    return { changed: clamped !== previous, zoom: clamped };
  }

  state(tabId) {
    const mode = this.modes.get(tabId);
    if (!mode) return { tabId, profileId: DESKTOP_ID, mode: 'desktop', touch: false, orientation: 'landscape', showTouches: true, zoom: 1, viewport: null };
    const profile = getDeviceProfile(mode.profileId);
    const viewport = resolveViewport(profile, mode.orientation);
    return {
      tabId,
      profileId: profile.id,
      label: profile.label,
      mode: profile.mode,
      touch: Boolean(profile.touch),
      orientation: mode.orientation,
      showTouches: mode.showTouches !== false,
      zoom: this.zoomFor(tabId),
      viewport: viewport ? { width: viewport.width, height: viewport.height, deviceScaleFactor: viewport.deviceScaleFactor } : null
    };
  }

  isTouchMode(tabId) {
    return Boolean(this.modes.get(tabId));
  }

  // The renderer needs the CSS size to letterbox the native view, so layout and
  // emulation cannot disagree about how large the device is.
  viewportFor(tabId) {
    const mode = this.modes.get(tabId);
    if (!mode) return null;
    return resolveViewport(getDeviceProfile(mode.profileId), mode.orientation);
  }

  displayViewportFor(tabId, stageWidth, stageHeight) {
    const viewport = this.viewportFor(tabId);
    if (!viewport) return null;
    const availableWidth = Math.max(1, Number(stageWidth) || 1);
    const availableHeight = Math.max(1, Number(stageHeight) || 1);
    // Fit-to-stage first, then the owner's zoom on top. The layout viewport is
    // untouched — only how large the device renders on screen changes, so the
    // page's own layout (and every agent coordinate in it) is identical at
    // every zoom level.
    const fit = Math.min(1, availableWidth / viewport.width, availableHeight / viewport.height);
    const zoom = this.zoomFor(tabId);
    const scale = fit * zoom;
    return {
      ...viewport,
      scale,
      zoom,
      width: Math.max(1, Math.floor(viewport.width * scale)),
      height: Math.max(1, Math.floor(viewport.height * scale))
    };
  }

  // The display scale the emulated surface is CURRENTLY laid out with. Falls
  // back to the zoom factor alone when no fit has run yet (the surface is then
  // 1:1 with the viewport, which the first layout corrects within a tick).
  displayScaleFor(tabId) {
    return this.displayScales.get(tabId) ?? this.zoomFor(tabId);
  }

  async fitViewport(tabId, stageWidth, stageHeight) {
    const tab = this.requireTab(tabId);
    const viewport = this.viewportFor(tabId);
    if (!viewport) return null;
    const display = this.displayViewportFor(tabId, stageWidth, stageHeight);
    this.displayScales.set(tabId, display.scale);
    if (this.fittedViewports.get(tabId) === display.scale) return display;
    this.fittedViewports.set(tabId, display.scale);
    await this.send(tab, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
      scale: display.scale,
      screenOrientation: viewport.screenOrientation
    });
    return display;
  }

  requireTab(tabId) {
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab) {
      const error = new Error('The bound tab is no longer available. Rebind or open a tab, then retry.');
      error.code = 'BOUND_TAB_MISSING';
      error.recoverable = true;
      throw error;
    }
    if (tab.webContents.isDestroyed()) {
      const error = new Error('The bound tab has been closed. Reopen it, then retry.');
      error.code = 'BOUND_TAB_CLOSED';
      error.recoverable = true;
      throw error;
    }
    return tab;
  }

  // Electron throws when the debugger is already attached, and DevTools claims
  // the same channel. Treat an existing attachment as usable and only record
  // ownership when this call created it, so detach never steals a session that
  // something else opened.
  ensureDebugger(tab) {
    const { webContents } = tab;
    if (webContents.debugger.isAttached()) return webContents.debugger;
    try {
      webContents.debugger.attach('1.3');
      this.attached.set(tab.id, true);
    } catch (error) {
      throw new Error(`Could not attach the emulation debugger to this tab: ${error.message}. Close DevTools for this tab and retry.`);
    }
    return webContents.debugger;
  }

  async send(tab, method, params = {}) {
    const target = this.ensureDebugger(tab);
    return target.sendCommand(method, params);
  }

  async setDeviceMode(tabId, { profileId, orientation = 'portrait', showTouches = true, reload = true } = {}) {
    const tab = this.requireTab(tabId);
    const profile = getDeviceProfile(profileId);
    if (!profile) throw new Error(`Unknown device profile: ${profileId}`);
    const nextOrientation = orientation === 'landscape' ? 'landscape' : 'portrait';

    if (profile.mode === 'desktop') return this.clearDeviceMode(tabId, { reload });

    const viewport = resolveViewport(profile, nextOrientation);
    await this.send(tab, 'Emulation.setDeviceMetricsOverride', {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: viewport.deviceScaleFactor,
      mobile: viewport.mobile,
      screenOrientation: viewport.screenOrientation
    });
    await this.send(tab, 'Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: profile.maxTouchPoints || 5 });
    // This is the switch that retires the mouse: Chromium rewrites the human's
    // physical pointer into touch upstream of the page.
    await this.send(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: profile.mode === 'mobile' ? 'mobile' : 'desktop' });
    if (profile.userAgent) {
      await this.send(tab, 'Emulation.setUserAgentOverride', {
        userAgent: profile.userAgent,
        acceptLanguage: 'en-US',
        platform: profile.platform,
        userAgentMetadata: profile.userAgentMetadata
      });
    }

    this.modes.set(tabId, { profileId: profile.id, orientation: nextOrientation, showTouches: showTouches !== false });
    // Device-mode change RESETS the zoom to the target profile's own persisted
    // value (1.0 first time): a zoom left on one device never leaks onto
    // another, while re-entering a device restores the size its owner chose.
    this.zooms.set(tabId, this.profileZooms.get(profile.id) ?? 1);
    // Feature detection ran under the previous identity, so the page must be
    // rebuilt before it can take its touch branch.
    if (reload) await this.reloadTab(tab);
    await this.applyTouchOverlay(tabId);
    await this.applyZoomWatcher(tabId);
    return this.state(tabId);
  }

  async clearDeviceMode(tabId, { reload = true } = {}) {
    const tab = this.requireTab(tabId);
    const hadMode = this.modes.delete(tabId);
    this.fittedViewports.delete(tabId);
    this.displayScales.delete(tabId);
    this.zooms.delete(tabId);
    if (tab.webContents.debugger.isAttached()) {
      // Each override is cleared independently: a target that never had one
      // set should not abort the rest of the teardown.
      await this.trySend(tab, 'Emulation.clearDeviceMetricsOverride');
      await this.trySend(tab, 'Emulation.setEmitTouchEventsForMouse', { enabled: false });
      await this.trySend(tab, 'Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
      await this.trySend(tab, 'Emulation.setUserAgentOverride', { userAgent: '' });
    }
    await this.removeTouchOverlay(tab);
    if (hadMode && reload) await this.reloadTab(tab);
    this.detach(tabId);
    return this.state(tabId);
  }

  async trySend(tab, method, params = {}) {
    try {
      await this.send(tab, method, params);
      return true;
    } catch {
      return false;
    }
  }

  // Only detach a session this class opened, so DevTools keeps its own.
  detach(tabId) {
    if (!this.attached.get(tabId)) return false;
    this.attached.delete(tabId);
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.webContents.isDestroyed()) return false;
    try {
      if (tab.webContents.debugger.isAttached()) tab.webContents.debugger.detach();
      return true;
    } catch {
      return false;
    }
  }

  forgetTab(tabId) {
    this.modes.delete(tabId);
    this.fittedViewports.delete(tabId);
    this.displayScales.delete(tabId);
    this.zooms.delete(tabId);
    this.attached.delete(tabId);
  }

  reloadTab(tab) {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, RELOAD_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      function finish() {
        clearTimeout(timer);
        tab.webContents.off('did-finish-load', finish);
        tab.webContents.off('did-fail-load', finish);
        resolve();
      }
      tab.webContents.once('did-finish-load', finish);
      tab.webContents.once('did-fail-load', finish);
      try {
        tab.webContents.reload();
      } catch {
        finish();
      }
    });
  }

  // Re-injected on every navigation by the tab wiring, because a document swap
  // discards the layer along with the rest of the previous DOM.
  async applyTouchOverlay(tabId) {
    const mode = this.modes.get(tabId);
    if (!mode) return false;
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.webContents.isDestroyed()) return false;
    try {
      await tab.webContents.executeJavaScript(buildTouchOverlayExpression(mode.showTouches !== false), true);
      return true;
    } catch {
      return false;
    }
  }

  async removeTouchOverlay(tab) {
    if (!tab || tab.webContents.isDestroyed()) return false;
    try {
      await tab.webContents.executeJavaScript(buildTouchOverlayExpression(false), true);
      return true;
    } catch {
      return false;
    }
  }

  // The Ctrl+Scroll watcher (deviceZoom_flow_chat.md) is page-injected because
  // Electron's input-event never emits wheel. Re-injected on every document
  // swap together with the touch overlay; leaving device mode reloads the tab.
  async applyZoomWatcher(tabId) {
    if (!this.modes.get(tabId)) return false;
    const tab = this.getTabs().find((candidate) => candidate.id === tabId);
    if (!tab || tab.webContents.isDestroyed()) return false;
    try {
      await tab.webContents.executeJavaScript(buildDeviceZoomWatcherExpression(), true);
      return true;
    } catch {
      return false;
    }
  }

  async setShowTouches(tabId, showTouches) {
    const mode = this.modes.get(tabId);
    if (!mode) throw new Error('Touch indicators apply only while a mobile or tablet profile is active.');
    mode.showTouches = showTouches !== false;
    await this.applyTouchOverlay(tabId);
    return this.state(tabId);
  }

  async rotate(tabId) {
    const mode = this.modes.get(tabId);
    if (!mode) throw new Error('Rotation applies only while a mobile or tablet profile is active.');
    // Re-applying metrics is enough to rotate; the document keeps its state
    // because orientation is a viewport change, not an identity change.
    return this.setDeviceMode(tabId, {
      profileId: mode.profileId,
      orientation: mode.orientation === 'landscape' ? 'portrait' : 'landscape',
      showTouches: mode.showTouches,
      reload: false
    });
  }

  // A finger cannot travel further than the screen, so a scroll larger than the
  // viewport is delivered as repeated swipes rather than one impossible drag
  // that would land outside the device and be dropped by the compositor.
  async scrollBy(tabId, { deltaX = 0, deltaY = 0, durationMs = 260 } = {}) {
    const viewport = this.viewportFor(tabId);
    if (!viewport) throw new Error('Touch scrolling requires an active mobile or tablet profile.');
    // Keep the contact clear of the edges: a swipe starting on the very edge is
    // interpreted as a system back or notification gesture, not page scroll.
    const usableX = Math.max(40, Math.round(viewport.width * 0.6));
    const usableY = Math.max(40, Math.round(viewport.height * 0.6));
    const centerX = Math.round(viewport.width / 2);
    const centerY = Math.round(viewport.height / 2);

    let remainingX = Number(deltaX) || 0;
    let remainingY = Number(deltaY) || 0;
    let swipes = 0;
    while ((Math.abs(remainingX) >= 1 || Math.abs(remainingY) >= 1) && swipes < 20) {
      const stepX = clampMagnitude(remainingX, usableX);
      const stepY = clampMagnitude(remainingY, usableY);
      await this.performGesture(tabId, 'swipe', {
        startX: centerX + Math.round(stepX / 2),
        startY: centerY + Math.round(stepY / 2),
        endX: centerX - Math.round(stepX / 2),
        endY: centerY - Math.round(stepY / 2),
        durationMs,
        momentum: true
      });
      remainingX -= stepX;
      remainingY -= stepY;
      swipes += 1;
    }
    return { tabId, deltaX, deltaY, swipes };
  }

  // Dispatches one gesture as a sequence of real touch frames.
  //
  // COORDINATE CONTRACT: gesture options are DEVICE CSS pixels (the emulated
  // viewport's own coordinates, identical to what the agent reads from the
  // DOM). CDP reads Input.dispatchTouchEvent coordinates in the VISUAL pixel
  // space of the emulated surface — empirically the page receives
  // dispatched / (fitScale * zoom) — so every contact is converted with the
  // display scale the surface is currently laid out with. Without this the
  // agent's taps drift by 1/scale (the owner-reported "wrong coordinates"),
  // and the drift GROWS with the canvas zoom.
  async performGesture(tabId, name, options = {}) {
    const tab = this.requireTab(tabId);
    if (!this.isTouchMode(tabId)) {
      throw new Error('Native gestures require an active mobile or tablet profile. Call browser_set_device_mode first.');
    }
    const frames = buildGesture(name, options);
    const viewport = this.viewportFor(tabId);
    for (const frame of frames) {
      if (frame.touchPoints.length > GESTURE_POINT_LIMIT) {
        throw new Error(`A gesture cannot use more than ${GESTURE_POINT_LIMIT} simultaneous contacts.`);
      }
      for (const point of frame.touchPoints) assertWithinViewport(point, viewport);
    }

    const displayScale = this.displayScaleFor(tabId);
    let dispatched = 0;
    for (const frame of frames) {
      if (frame.delayMs > 0) await sleep(frame.delayMs);
      await this.send(tab, 'Input.dispatchTouchEvent', {
        type: frame.type,
        touchPoints: scaleTouchFrame(frame, displayScale).touchPoints,
        modifiers: 0
      });
      dispatched += 1;
    }
    return { tabId, gesture: name, frames: dispatched, contacts: maxContacts(frames), displayScale, options: sanitizeOptions(options) };
  }
}

function clampMagnitude(value, limit) {
  if (value > limit) return limit;
  if (value < -limit) return -limit;
  return Math.round(value);
}

function maxContacts(frames) {
  return frames.reduce((highest, frame) => Math.max(highest, frame.touchPoints.length), 0);
}

// A contact dispatched outside the emulated screen is silently dropped by the
// compositor, which reads as "the gesture ran but nothing happened".
function assertWithinViewport(point, viewport) {
  if (!viewport) return;
  const withinX = point.x >= 0 && point.x <= viewport.width;
  const withinY = point.y >= 0 && point.y <= viewport.height;
  if (!withinX || !withinY) {
    throw new Error(`Touch point (${point.x}, ${point.y}) falls outside the ${viewport.width}x${viewport.height} device viewport.`);
  }
}

function sanitizeOptions(options) {
  const allowed = ['x', 'y', 'startX', 'startY', 'endX', 'endY', 'deltaX', 'deltaY', 'scale', 'degrees', 'fingers', 'durationMs'];
  const result = {};
  for (const key of allowed) {
    if (options[key] !== undefined) result[key] = options[key];
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function clampZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return NaN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(numeric * 100) / 100));
}

// Device px -> visual (widget) px for one touch frame. The radius scales with
// the same factor so a contact keeps its physical finger size on screen.
function scaleTouchFrame(frame, displayScale) {
  const scalePoint = (point) => ({
    ...point,
    x: Math.round(point.x * displayScale * 100) / 100,
    y: Math.round(point.y * displayScale * 100) / 100,
    radiusX: Math.round((point.radiusX || 0) * displayScale * 100) / 100,
    radiusY: Math.round((point.radiusY || 0) * displayScale * 100) / 100
  });
  return { ...frame, touchPoints: frame.touchPoints.map(scalePoint) };
}

module.exports = { DeviceEmulator, GESTURE_POINT_LIMIT, ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, clampZoom };
