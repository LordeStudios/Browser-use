'use strict';

// In-page touch visualisation, equivalent to Android's "Show taps" developer
// option: a translucent circle appears at every contact point, follows it while
// it moves, and fades on release.
//
// It listens for real touch events rather than being driven by the injector, so
// one implementation covers both input sources. When a device profile is
// active, Chromium converts the human's physical mouse into genuine touch
// events, and the agent's gestures arrive as CDP Input.dispatchTouchEvent, so
// both surface here identically. Nothing keys off isTrusted, which is why the
// agent cursor overlay needs a coordinate claim but this one does not.
//
// CommonJS to match cursorOverlay.cjs so the .cjs main process can require it.

const TOUCH_OVERLAY_ID = '__browser_use_touch_overlay__';
const TOUCH_POINT_SIZE_PX = 44;

function buildTouchOverlayExpression(enabled = true) {
  return `(() => {
    const id = ${JSON.stringify(TOUCH_OVERLAY_ID)};
    const SIZE = ${TOUCH_POINT_SIZE_PX};
    const existing = document.getElementById(id);

    if (!${Boolean(enabled)}) {
      if (existing) {
        if (existing.__browserUseTeardown) existing.__browserUseTeardown();
        existing.remove();
      }
      return { id, enabled: false };
    }

    if (existing) {
      // A framework that re-renders <html> can detach the layer; re-attach the
      // same node rather than stacking a second set of listeners on the window.
      if (!existing.isConnected) document.documentElement.append(existing);
      return { id, enabled: true, reused: true };
    }

    const layer = document.createElement('div');
    layer.id = id;
    layer.setAttribute('aria-hidden', 'true');
    Object.assign(layer.style, {
      position: 'fixed', inset: '0', zIndex: '2147483646',
      pointerEvents: 'none', overflow: 'hidden', contain: 'strict'
    });

    // identifier -> node. Touch identifiers are stable for the life of a
    // contact, so a multi-finger gesture keeps one circle per finger.
    const points = new Map();

    const makePoint = () => {
      const node = document.createElement('div');
      Object.assign(node.style, {
        position: 'absolute', width: SIZE + 'px', height: SIZE + 'px',
        marginLeft: (-SIZE / 2) + 'px', marginTop: (-SIZE / 2) + 'px',
        borderRadius: '50%',
        background: 'rgba(255,255,255,0.28)',
        border: '2px solid rgba(255,255,255,0.85)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.35), 0 2px 10px rgba(0,0,0,0.35)',
        left: '0px', top: '0px',
        transform: 'scale(0.7)', opacity: '0',
        transition: 'transform 90ms ease-out, opacity 90ms ease-out',
        willChange: 'transform, opacity'
      });
      layer.append(node);
      return node;
    };

    const place = (node, x, y) => {
      node.style.left = x + 'px';
      node.style.top = y + 'px';
    };

    const press = (touch) => {
      let node = points.get(touch.identifier);
      if (!node) {
        node = makePoint();
        points.set(touch.identifier, node);
      }
      place(node, touch.clientX, touch.clientY);
      requestAnimationFrame(() => {
        node.style.opacity = '1';
        node.style.transform = 'scale(1)';
      });
    };

    const move = (touch) => {
      const node = points.get(touch.identifier);
      if (node) place(node, touch.clientX, touch.clientY);
    };

    const release = (touch) => {
      const node = points.get(touch.identifier);
      if (!node) return;
      points.delete(touch.identifier);
      node.style.transition = 'transform 200ms ease-out, opacity 200ms ease-out';
      node.style.transform = 'scale(1.45)';
      node.style.opacity = '0';
      setTimeout(() => node.remove(), 230);
    };

    // changedTouches carries exactly the contacts this event is about, so a
    // second finger landing does not restart the first finger's circle.
    const onStart = (event) => { for (const touch of event.changedTouches) press(touch); };
    const onMove = (event) => { for (const touch of event.changedTouches) move(touch); };
    const onEnd = (event) => { for (const touch of event.changedTouches) release(touch); };

    const listeners = [
      ['touchstart', onStart], ['touchmove', onMove],
      ['touchend', onEnd], ['touchcancel', onEnd]
    ];
    for (const [type, handler] of listeners) {
      window.addEventListener(type, handler, { capture: true, passive: true });
    }

    layer.__browserUseTeardown = () => {
      for (const [type, handler] of listeners) {
        window.removeEventListener(type, handler, { capture: true });
      }
      points.clear();
    };

    document.documentElement.append(layer);
    return { id, enabled: true, reused: false };
  })()`;
}

// DEVICE CANVAS ZOOM watcher. Electron's webContents 'input-event' does not
// emit wheel events (verified live on Electron 43: the page receives a real
// Ctrl+wheel — ctrlKey true — but main never sees an input-event), so the
// Ctrl+Scroll gesture is observed in the page: a capture-phase wheel listener
// swallows Ctrl+wheel (preventDefault — the page must neither scroll nor
// page-zoom while the owner zooms the device canvas) and signals main through
// a console token that the tab's console-message handler filters out of the
// console UI before it is recorded. Injected only while a device profile is
// active; leaving device mode reloads the tab, which drops the watcher.
const DEVICE_ZOOM_TOKEN = '__browser_use_device_zoom__';

function buildDeviceZoomWatcherExpression() {
  return `(() => {
    if (window.__browserUseDeviceZoomWatcher__) return { installed: true, reused: true };
    const token = ${JSON.stringify(DEVICE_ZOOM_TOKEN)};
    const onWheel = (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      console.info(token + ' ' + (event.deltaY < 0 ? 1 : -1));
    };
    window.addEventListener('wheel', onWheel, { capture: true, passive: false });
    window.__browserUseDeviceZoomWatcher__ = onWheel;
    return { installed: true, reused: false };
  })()`;
}

module.exports = { TOUCH_OVERLAY_ID, TOUCH_POINT_SIZE_PX, buildTouchOverlayExpression, DEVICE_ZOOM_TOKEN, buildDeviceZoomWatcherExpression };
