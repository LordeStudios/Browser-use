'use strict';

// Legacy standalone in-page cursor experiment.
//
// This module is not used by the Electron desktop app or the production CDP
// input path. Desktop visualization lives in an app-owned transparent child
// window under desktop/pointer so navigation and page scripts cannot affect it.
// The file remains only for tracked standalone visual experiments that import
// buildCursorExpression directly.
//
// HARDENING: the driver is the single authority for pointer position. There is
// no page event listener and no coordinate "claim" any more — that listener was
// the second writer that made the pointer chase page events ("mouse follows
// taps") or freeze when a page swallowed the press without emitting a matching
// event ("taps invisible, mouse stale"). The driver places the pointer on every
// input call, so the pointer leads and taps happen at the pointer. Movement
// between taps eases automatically via a FLIP transform; a click plays a
// one-shot tip rotation plus a forcefield pulse. See cursor_overlay_flow_chat.md
// for the full flow and the invariants the test contract relies on.

const CURSOR_ID = '__browser_use_agent_cursor__';
const STYLE_ID = '__browser_use_agent_cursor_style__';

// The arrow tip is at (2,2) inside the 20x26 viewBox, so the node is positioned
// back by that much so the drawn point lands on the tapped coordinate.
const TIP_OFFSET_X = 2;
const TIP_OFFSET_Y = 2;

// Auto-eased tap-to-tap glide, the one-shot click tilt, and the forcefield pulse.
const MOVE_MS = 260;
const CLICK_ANIM_MS = 380;
const FORCEFIELD_MS = 460;

function buildCursorExpression(x, y, isClick = false) {
  return `(() => {
    const id = ${JSON.stringify(CURSOR_ID)};
    const styleId = ${JSON.stringify(STYLE_ID)};
    const TIP_X = ${TIP_OFFSET_X};
    const TIP_Y = ${TIP_OFFSET_Y};
    const MOVE_MS = ${MOVE_MS};
    const CLICK_MS = ${CLICK_ANIM_MS};
    const FF_MS = ${FORCEFIELD_MS};

    // Inject the keyframes once. A framework that re-renders <html> can drop the
    // style node, so re-inject it if missing rather than letting the effect vanish.
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = \`@keyframes __buClick{0%{transform:rotate(0deg) scale(1)}28%{transform:rotate(-12deg) scale(0.82)}62%{transform:rotate(3deg) scale(1.08)}100%{transform:rotate(0deg) scale(1)}}@keyframes __buForcefield{0%{transform:scale(0.3);opacity:1}60%{opacity:0.5}100%{transform:scale(2.6);opacity:0}}\`;
      document.documentElement.append(style);
    }

    const existing = document.getElementById(id);
    const cursor = existing || document.createElement('div');
    if (!existing) {
      cursor.id = id;
      cursor.setAttribute('aria-hidden', 'true');
      cursor.dataset.browserUseAgentCursor = 'true';
      // The arrow sits in its own wrapper so the click tilt (rotate/scale about
      // the tip) animates independently of the cursor's translate glide. Both
      // transform chains compose without fighting each other.
      cursor.innerHTML = \`<div class="__bu_arrow" style="width:20px;height:26px;transform-origin:2px 2px;display:block"><svg width="20" height="26" viewBox="0 0 20 26" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;filter:drop-shadow(0px 2px 4px rgba(0,0,0,0.35))"><path d="M2 2L18 14.5L10.5 16.5L6 24L2 2Z" fill="#000000" stroke="#ffffff" stroke-width="1.5" stroke-linejoin="round"/></svg></div>\`;
      Object.assign(cursor.style, {
        position: 'fixed', zIndex: '2147483647', width: '20px', height: '26px',
        margin: '0', padding: '0', pointerEvents: 'none',
        left: '0px', top: '0px', transform: 'translate(0px,0px)',
        // Origin at the tip so any future scale/rotate pivots on the contact
        // point. translate is origin-independent, so the FLIP glide is unaffected.
        transformOrigin: TIP_X + 'px ' + TIP_Y + 'px',
        // Movement is eased on transform only (compositor-friendly). left/top
        // never transition, so the test contract (tip = left/top + 2) is
        // timing-independent: getComputedStyle.left always returns the final
        // coordinate the instant the driver writes it.
        transition: 'transform ' + MOVE_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1)',
        opacity: '1'
      });

      // One-shot forcefield pulse at the tap point: a glowing cyan ring that
      // expands and fades. Spawned on <html> (not a child of the cursor) so it
      // stays anchored to the tap coordinate even while the pointer is still
      // gliding in from the previous tap.
      cursor.__spawnForcefield = (cx, cy) => {
        const ff = document.createElement('div');
        Object.assign(ff.style, {
          position: 'fixed', zIndex: '2147483646',
          width: '28px', height: '28px', left: (cx - 14) + 'px', top: (cy - 14) + 'px',
          borderRadius: '50%', border: '3px solid rgba(120, 220, 255, 0.9)',
          boxShadow: '0 0 14px 2px rgba(0, 220, 255, 0.55), inset 0 0 8px rgba(255,255,255,0.35)',
          background: 'rgba(0, 220, 255, 0.12)',
          pointerEvents: 'none', opacity: '1', transform: 'scale(0.3)',
          animation: '__buForcefield ' + FF_MS + 'ms cubic-bezier(0.16, 1, 0.3, 1) forwards'
        });
        document.documentElement.append(ff);
        setTimeout(() => ff.remove(), FF_MS + 60);
      };

      document.documentElement.append(cursor);
    }

    // A framework that re-renders <html> can detach the overlay, so re-attach it
    // instead of leaving a node the page will never show again.
    if (!cursor.isConnected) document.documentElement.append(cursor);

    const arrow = cursor.querySelector('.__bu_arrow');

    const numX = Number(${JSON.stringify(x)});
    const numY = Number(${JSON.stringify(y)});
    if (Number.isFinite(numX) && Number.isFinite(numY)) {
      const px = Math.round(numX);
      const py = Math.round(numY);
      // left/top hold the authoritative final tip coordinate, set instantly. The
      // tests read tipX = round(left) + 2, so this stays exact regardless of the
      // eased transform below. This is what makes the pointer the owner of the
      // tap: the driver writes the coordinate, the pointer is there.
      cursor.style.left = (px - TIP_X) + 'px';
      cursor.style.top = (py - TIP_Y) + 'px';
      cursor.style.opacity = '1';

      // FLIP glide between taps: start the transform at the inverted delta so the
      // visual tip begins at the previous tap, force a reflow to commit that
      // start frame, then ease the transform to zero so the tip glides to (px,py)
      // with an ease-out curve. The transform is invisible to
      // getComputedStyle.left, so the test contract is preserved. Animation uses
      // only the tap as start and end; the in-between glide is automatic + eased.
      const lastX = Number.isFinite(cursor.__lastX) ? cursor.__lastX : px;
      const lastY = Number.isFinite(cursor.__lastY) ? cursor.__lastY : py;
      if (lastX !== px || lastY !== py) {
        cursor.style.transition = 'none';
        cursor.style.transform = 'translate(' + (lastX - px) + 'px,' + (lastY - py) + 'px)';
        void cursor.offsetWidth; // commit the inverted start frame before easing
        cursor.style.transition = 'transform ' + MOVE_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
        cursor.style.transform = 'translate(0px,0px)';
      }
      cursor.__lastX = px;
      cursor.__lastY = py;

      if (${Boolean(isClick)}) {
        // One-shot click tilt about the tip. Restarting the animation on every
        // press keeps the effect visible even when mouseUp fires in the same
        // tick (which is exactly what clickElement does), because the keyframe
        // carries both the press and the release inside it.
        if (arrow) {
          arrow.style.animation = 'none';
          void arrow.offsetWidth;
          arrow.style.animation = '__buClick ' + CLICK_MS + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
        }
        if (cursor.__spawnForcefield) cursor.__spawnForcefield(px, py);
      }
    }
    return { id, visible: true };
  })()`;
}

module.exports = { CURSOR_ID, buildCursorExpression, TIP_OFFSET_X, TIP_OFFSET_Y };
