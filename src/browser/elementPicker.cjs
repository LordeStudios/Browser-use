'use strict';

// In-page element picker behind the terminal's Select action.
//
// Highlights whatever is under the pointer or finger and resolves with a
// description of the element that was chosen, so a selector can be piped into
// the terminal without hand-writing one.
//
// The picker listens in the capture phase and swallows the selecting event, so
// activating it cannot also trigger the page's own click handler — otherwise
// picking a "Delete" button would delete something.
//
// It handles touch as well as mouse: while a device profile is active the human
// pointer arrives as touch, so a mouse-only picker would be inert exactly where
// it is most useful.

const PICKER_ID = '__browser_use_element_picker__';

function buildElementPickerExpression() {
  return `(() => {
    const id = ${JSON.stringify(PICKER_ID)};
    if (window.__browserUsePickerActive) return { started: false, reason: 'already-active' };
    window.__browserUsePickerActive = true;
    window.__browserUsePickerResult = null;

    const highlight = document.createElement('div');
    highlight.id = id;
    highlight.setAttribute('aria-hidden', 'true');
    Object.assign(highlight.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
      border: '2px solid #c8ff00', background: 'rgba(200, 255, 0, 0.14)',
      borderRadius: '2px', left: '0px', top: '0px', width: '0px', height: '0px',
      transition: 'all 60ms ease-out', boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.55)'
    });

    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
      background: '#202124', color: '#fff', padding: '3px 6px', borderRadius: '4px',
      font: '11px/1.3 ui-monospace, Consolas, monospace', maxWidth: '60vw',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
    });

    document.documentElement.append(highlight, label);

    const cssPath = (element) => {
      if (element.id) return '#' + CSS.escape(element.id);
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && parts.length < 8) {
        let part = current.localName;
        if (!part) break;
        const testId = current.getAttribute('data-testid') || current.getAttribute('data-test-id');
        if (testId) { parts.unshift(part + '[data-testid="' + testId.replace(/"/g, '\\\\"') + '"]'); break; }
        let index = 1;
        let sibling = current;
        while ((sibling = sibling.previousElementSibling)) if (sibling.localName === current.localName) index += 1;
        parts.unshift(part + ':nth-of-type(' + index + ')');
        current = current.parentElement;
      }
      return parts.join(' > ');
    };

    const describe = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        selector: cssPath(element),
        tag: element.tagName.toLowerCase(),
        id: element.id || '',
        classes: typeof element.className === 'string' ? element.className.trim().slice(0, 120) : '',
        testId: element.getAttribute('data-testid') || element.getAttribute('data-test-id') || '',
        role: element.getAttribute('role') || '',
        name: element.getAttribute('aria-label') || element.getAttribute('title') || '',
        // innerText reflects what is actually PAINTED (respects visibility/display), so the
// attachment card shows the element's real first words, not hidden subtree text.
text: String((element.innerText !== undefined ? element.innerText : element.textContent) || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
        href: element.getAttribute('href') || '',
        outerHTML: element.outerHTML ? element.outerHTML.slice(0, 40000) : ''
      };
    };

    let current = null;
    let lastPointer = null;

    const track = (x, y) => {
      lastPointer = { x, y };
      // The overlay is pointer-events:none, so it never occludes the hit test.
      const element = document.elementFromPoint(x, y);
      if (!element || element === highlight || element === label) return;
      current = element;
      const rect = element.getBoundingClientRect();
      Object.assign(highlight.style, {
        left: rect.left + 'px', top: rect.top + 'px',
        width: rect.width + 'px', height: rect.height + 'px'
      });
      label.textContent = cssPath(element);
      const labelTop = rect.top > 22 ? rect.top - 22 : rect.bottom + 4;
      label.style.left = Math.max(2, rect.left) + 'px';
      label.style.top = labelTop + 'px';
    };

    // Content moves under a stationary cursor all the time on real sites:
    // wheel scrolling, SPA re-renders, CSS animations, lazy-loaded shifts.
    // The highlight and the pending pick must re-derive the element at those
    // moments too, or the user clicks a highlighted layer and the picker
    // attaches a stale element (or nothing). Scroll does not fire mousemove,
    // so listen for it explicitly.
    const retrack = () => { if (lastPointer) track(lastPointer.x, lastPointer.y); };

    const teardown = () => {
      for (const [type, handler] of listeners) window.removeEventListener(type, handler, true);
      highlight.remove();
      label.remove();
      window.__browserUsePickerActive = false;
    };
    // Exposed only for the bounded timeout path in the main process.
    highlight.__browserUseTeardown = teardown;

    // Do not return an unresolved Promise from executeJavaScript. Electron holds
    // the renderer-side IPC invocation open for that promise, and a second
    // renderer evaluation used to await it while trying to read the result — a
    // circular wait that made Select hang. Publish the terminal result into the
    // page, return immediately, and let the main process poll it.
    const finish = (value) => {
      teardown();
      window.__browserUsePickerResult = value;
    };
    {
      const onMove = (event) => track(event.clientX, event.clientY);
      const onTouchMove = (event) => {
        const touch = event.touches[0];
        if (touch) track(touch.clientX, touch.clientY);
      };
      const onTouchStart = (event) => {
        const touch = event.touches[0];
        if (touch) track(touch.clientX, touch.clientY);
      };
      // Selecting must not also activate what was selected.
      const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
      const onPick = (event) => {
        swallow(event);
        // Resolve at the exact click moment: content may have moved since the
        // last mousemove (wheel scroll, SPA re-render, animation), and the
        // stale 'current' attached the wrong element or nothing at all.
        if (typeof event.clientX === 'number') track(event.clientX, event.clientY);
        if (!current) { finish({ picked: false, reason: 'no-element' }); return; }
        finish({ picked: true, element: describe(current) });
      };
      const onTouchEnd = (event) => {
        swallow(event);
        const touch = event.changedTouches && event.changedTouches[0];
        if (touch) track(touch.clientX, touch.clientY);
        if (!current) { finish({ picked: false, reason: 'no-element' }); return; }
        finish({ picked: true, element: describe(current) });
      };
      const onKey = (event) => {
        if (event.key !== 'Escape') return;
        swallow(event);
        finish({ picked: false, reason: 'cancelled' });
      };

      var listeners = [
        ['mousemove', onMove], ['pointermove', onMove],
        ['touchstart', onTouchStart], ['touchmove', onTouchMove],
        ['touchend', onTouchEnd],
        // Commit a desktop selection on press rather than release. A BrowserView
        // can route the matching mouseup through a page that synchronously
        // changes focus or navigates on mousedown, which leaves a release-only
        // picker hung. The down event still identifies the exact element under
        // the pointer and is swallowed before the page can activate it.
        ['mousedown', onPick], ['mouseup', swallow], ['click', swallow],
        ['keydown', onKey]
      ];
      listeners.push(['scroll', retrack], ['resize', retrack]);
      for (const [type, handler] of listeners) {
        window.addEventListener(type, handler, { capture: true, passive: type === 'scroll' });
      }
    }
    return { started: true };
  })()`;
}

module.exports = { PICKER_ID, buildElementPickerExpression };
