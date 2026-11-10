// cli/tui/webShell.mjs
//
// Browser-only enhancements injected into the GUI page by guiServer.mjs.
// The desktop app never loads this file. Responsibilities:
//   1. Live tab screenshot preview, fitted to the visible area (no over-zoom).
//   2. A REAL device menu: in the desktop app profile selection lives in the
//      Electron overlay window, which does not exist on the web — so the web
//      shell provides its own picker (profiles / rotate / zoom).
//   3. Settings & console drawer visibility: renderDrawers force-hides every
//      non-agent panel (in Electron those surfaces are main-process views);
//      on the web they are plain DOM, so the shell shows them when active.
//   4. Removal of desktop-only controls (no Electron surface to back them).

export const WEB_SHELL_JS = String.raw`
(function webShell() {
  if (window.__webShellInstalled) return;
  window.__webShellInstalled = true;

  // --- 1. remove desktop-only controls ------------------------------------
  // Buttons whose behavior is an Electron native surface (record & Learn,
  // Android ADB/scrcpy, chat window pinning, element-picker overlay, detached
  // terminal window, native history menu) are REMOVED from the web GUI per
  // the owner's rule: every visible button must work 100% or not appear.
  var REMOVE_SELECTORS = [
    '#recording-toggle', '#recording-banner', '#agent-record',
    '#agent-android-section',
    '#agent-pin',
    '#agent-dom-select', '#terminal-select',
    '#terminal-detach',
    '#address-history-toggle'
  ];
  function removeDesktopOnly() {
    for (var i = 0; i < REMOVE_SELECTORS.length; i++) {
      try {
        var nodes = document.querySelectorAll(REMOVE_SELECTORS[i]);
        for (var j = 0; j < nodes.length; j++) nodes[j].remove();
      } catch (e) { /* best effort */ }
    }
  }
  removeDesktopOnly();
  var removalWatcher = setInterval(removeDesktopOnly, 1500);
  setTimeout(function () { clearInterval(removalWatcher); }, 20000);

  // --- 2. live tab preview, fitted to the visible area ---------------------
  // An <img> with object-fit:contain letterboxes any aspect (portrait phone
  // emulation, zoomed pages) instead of cover-cropping beyond the viewport.
  var preview = document.createElement('div');
  preview.id = 'web-shell-preview';
  preview.style.cssText = [
    'position:fixed', 'left:0', 'right:0', 'bottom:0', 'top:0',
    'z-index:0', 'pointer-events:none', 'background:#060b0d',
    'display:flex', 'align-items:flex-start', 'justify-content:center',
    'overflow:hidden', 'opacity:0', 'transition:opacity .4s'
  ].join(';');
  var previewImg = document.createElement('img');
  previewImg.alt = '';
  previewImg.style.cssText = [
    'max-width:100%', 'max-height:100%', 'object-fit:contain',
    'object-position:top center', 'pointer-events:none',
    'width:auto', 'height:auto'
  ].join(';');
  preview.appendChild(previewImg);
  document.documentElement.appendChild(preview);

  function chromeTopOffset() {
    var chrome = document.querySelector('.browser-chrome');
    return chrome ? Math.round(chrome.getBoundingClientRect().bottom) : 0;
  }
  function applyBounds() {
    preview.style.top = chromeTopOffset() + 'px';
  }
  // In mobile split view the preview bounds are owned by layoutMobile().
  var desktopApplyBounds = applyBounds;
  applyBounds = function () {
    if (window.__wsMobileActive && typeof window.__wsLayoutMobile === 'function') {
      window.__wsLayoutMobile();
    } else {
      desktopApplyBounds();
    }
  };
  window.addEventListener('resize', applyBounds);
  setInterval(applyBounds, 1000);

  // --- 3. settings & console drawers: real visibility on the web ----------
  // renderDrawers() hardcodes panel.hidden for console/settings (in Electron
  // those surfaces are main-process views). On the web:
  //   • #console-panel is REAL DOM (header, filter tabs, list fed by SSE
  //     browser-use:console events) — unhide it when its toggle expands.
  //   • #settings-panel is an EMPTY placeholder (the real settings UI lives
  //     in the agent drawer's #agent-settings-screen) — the toolbar Settings
  //     button is rerouted there instead of opening an empty drawer.
  function expanded(id) {
    var el = document.querySelector(id);
    return !!(el && el.getAttribute('aria-expanded') === 'true');
  }
  function syncPanels() {
    try {
      var consolePanel = document.querySelector('#console-panel');
      var agentPanel = document.querySelector('#agent-panel');
      var settingsPanel = document.querySelector('#settings-panel');
      // The console ships with class "drawers-placeholder" = display:none
      // !important (main-process surface in Electron). Strip it or the
      // panel can never be shown on the web.
      if (consolePanel) {
        consolePanel.classList.remove('drawers-placeholder');
        consolePanel.hidden = !expanded('#console-toggle');
      }
      if (agentPanel) agentPanel.hidden = !expanded('#agent-toggle');
      if (settingsPanel) settingsPanel.hidden = true; // empty placeholder on the web
    } catch (e) { /* best effort */ }
  }
  // Watch aria-expanded flips for instant show/hide (attach lazily: the
  // toolbar exists by the time this runs, but be defensive anyway).
  var expandedObserver = null;
  function ensureObserver() {
    if (expandedObserver) return;
    try {
      expandedObserver = new MutationObserver(syncPanels);
      ['#console-toggle', '#agent-toggle'].forEach(function (sel) {
        var el = document.querySelector(sel);
        if (el) expandedObserver.observe(el, { attributes: true, attributeFilter: ['aria-expanded'] });
      });
    } catch (e) { expandedObserver = null; }
  }
  document.addEventListener('click', function () { ensureObserver(); setTimeout(syncPanels, 40); }, true);
  setInterval(function () { ensureObserver(); syncPanels(); }, 800);
  // Reroute the toolbar Settings button to the REAL settings screen
  // (agent drawer -> AI provider settings), before app.js sees the click.
  document.addEventListener('click', function (event) {
    var toggle = event.target.closest && event.target.closest('#settings-toggle');
    if (!toggle) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    try {
      toggle.setAttribute('aria-expanded', 'false');
      var agentToggle = document.querySelector('#agent-toggle');
      if (agentToggle && agentToggle.getAttribute('aria-expanded') !== 'true') agentToggle.click();
      setTimeout(function () {
        var agentSettings = document.querySelector('#agent-settings-toggle');
        if (agentSettings && agentSettings.getAttribute('aria-expanded') !== 'true') agentSettings.click();
        syncPanels();
      }, 80);
    } catch (err) {
      window.__webShellError = String((err && err.message) || err);
    }
  }, true);

  // --- 4. device menu: real profiles / rotate / zoom -----------------------
  // The desktop app's device menu is an Electron overlay window; the web GUI
  // gets its own picker anchored to the device toolbar button.
  var deviceMenuEl = null;
  function closeDeviceMenu() {
    if (deviceMenuEl) { deviceMenuEl.remove(); deviceMenuEl = null; }
  }
  function bridgeCall(method, args) {
    return fetch('/ipc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'browser-use:' + method.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), args: args || [] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.ok) return j.result;
      throw new Error((j && j.error) || 'bridge call failed');
    });
  }
  function menuRow(label, onClick, hint) {
    var row = document.createElement('button');
    row.type = 'button';
    row.style.cssText = 'display:flex;justify-content:space-between;gap:16px;width:100%;padding:8px 12px;background:none;border:0;color:#edf2f2;font:inherit;text-align:left;cursor:pointer';
    var span = document.createElement('span'); span.textContent = label;
    var small = document.createElement('small'); small.style.opacity = '0.6'; small.textContent = hint || '';
    row.append(span, small);
    row.addEventListener('mouseenter', function () { row.style.background = 'rgba(255,255,255,.08)'; });
    row.addEventListener('mouseleave', function () { row.style.background = 'none'; });
    row.addEventListener('click', function (event) { event.stopPropagation(); closeDeviceMenu(); try { onClick(); } catch (e) {} });
    return row;
  }
  function openDeviceMenu(anchor) {
    try {
    closeDeviceMenu();
    deviceMenuEl = document.createElement('div');
    deviceMenuEl.style.cssText = [
      'position:fixed', 'z-index:10000', 'min-width:230px', 'max-height:60vh',
      'overflow:auto', 'background:#0d1518', 'border:1px solid rgba(255,255,255,.14)',
      'border-radius:10px', 'box-shadow:0 12px 34px rgba(0,0,0,.5)', 'padding:6px'
    ].join(';');
    var rect = anchor.getBoundingClientRect();
    deviceMenuEl.style.top = Math.round(rect.bottom + 6) + 'px';
    deviceMenuEl.style.left = Math.max(8, Math.round(rect.right - 250)) + 'px';
    document.body.appendChild(deviceMenuEl);

    var state = { orientation: 'landscape', zoom: 1 };
    bridgeCall('deviceState', []).then(function (current) {
      if (current) state.orientation = current.orientation || 'landscape';
      if (current && current.zoom) state.zoom = current.zoom;
    }).catch(function () {});

    // Zoom controls (applies in desktop AND device modes).
    deviceMenuEl.appendChild(menuRow('Zoom out', function () {
      state.zoom = Math.max(0.25, Math.round((state.zoom - 0.25) * 100) / 100);
      bridgeCall('setDeviceZoom', [state.zoom]).catch(function () {});
    }, 'x' + String(state.zoom)));
    deviceMenuEl.appendChild(menuRow('Zoom reset', function () {
      state.zoom = 1;
      bridgeCall('setDeviceZoom', [1]).catch(function () {});
    }, 'x1'));
    deviceMenuEl.appendChild(menuRow('Rotate', function () {
      bridgeCall('rotateDevice', []).catch(function () {});
    }, state.orientation));
    deviceMenuEl.appendChild(menuRow('—', function () { }, ''));
    // Manual mobile split-view toggle (auto -> on -> off -> auto).
    deviceMenuEl.appendChild(menuRow('Mobile split view', function () {
      if (typeof window.__webShellMobile === 'function') window.__webShellMobile();
    }, wsStore(WS_PREF_KEY) || 'auto'));

    // Profiles.
    bridgeCall('deviceProfiles', []).then(function (profiles) {
      if (!deviceMenuEl) return;
      (profiles || []).forEach(function (profile) {
        var hint = profile.mode === 'desktop' ? 'default' : (profile.width ? profile.width + 'x' + profile.height : profile.mode);
        deviceMenuEl.appendChild(menuRow(profile.label || profile.id, function () {
          state.orientation = 'landscape';
          bridgeCall('setDeviceMode', [{ profile: profile.id, orientation: 'landscape' }]).catch(function () {});
        }, hint));
      });
    }).catch(function () {});
    } catch (err) {
      window.__webShellError = String(err && err.message || err);
    }
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest && event.target.closest('#device-toggle');
    if (toggle) {
      if (deviceMenuEl) { closeDeviceMenu(); return; }
      openDeviceMenu(toggle);
      return;
    }
    if (deviceMenuEl && !(event.target.closest && event.target.closest('#web-shell-device-menu'))) {
      closeDeviceMenu();
    }
  }, true);

  // --- 5. mobile split view (web-only; desktop layout untouched) -----------
  // Activates only on phones (navigator.userAgentData.mobile) or narrow
  // viewports, or via the manual toggle in the device menu (persisted in
  // localStorage). Everything is scoped under html.ws-mobile, so desktop and
  // tablet browsers keep the exact unmodified layout, and the desktop app
  // never loads this file at all.
  var WS_PREF_KEY = 'ws-mobile-pref';
  var WS_POS_KEY = 'ws-chat-pos';
  var WS_SIZE_KEY = 'ws-chat-size';
  var WS_MODE_KEY = 'ws-view-mode';

  function wsStore(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, String(value));
    } catch (e) { /* private mode */ }
    return null;
  }
  function autoMobile() {
    try { if (navigator.userAgentData && navigator.userAgentData.mobile) return true; } catch (e) { }
    try { return window.matchMedia('(max-width: 700px)').matches; } catch (e) { return false; }
  }
  function isMobile() {
    var p = wsStore(WS_PREF_KEY) || 'auto';
    return p === 'on' ? true : p === 'off' ? false : autoMobile();
  }
  function chatPos() { return wsStore(WS_POS_KEY) || 'bottom'; }
  function chatSize() {
    var v = parseFloat(wsStore(WS_SIZE_KEY));
    return isFinite(v) ? Math.min(0.8, Math.max(0.2, v)) : 0.5;
  }
  function viewMode() { return wsStore(WS_MODE_KEY) || 'split'; }
  function chromeBottom() {
    var chrome = document.querySelector('.browser-chrome');
    return chrome ? Math.round(chrome.getBoundingClientRect().bottom) : 0;
  }

  // Cosmetics only; all geometry is computed inline by layoutMobile().
  var mobileCss = document.createElement('style');
  mobileCss.id = 'web-shell-mobile-css';
  mobileCss.textContent = [
    '#web-shell-divider { position:fixed; z-index:540; touch-action:none; }',
    '#web-shell-divider.ws-h { height:18px; cursor:row-resize; }',
    '#web-shell-divider.ws-v { width:18px; cursor:col-resize; }',
    '#web-shell-divider::after { content:""; position:absolute; background:#2b3639; border-radius:2px; }',
    '#web-shell-divider.ws-h::after { left:0; right:0; top:8px; height:2px; }',
    '#web-shell-divider.ws-v::after { top:0; bottom:0; left:8px; width:2px; }',
    '#web-shell-divider.ws-drag::after { background:#c8ff00; }',
    '#web-shell-viewbar { position:fixed; z-index:560; display:none; gap:2px; padding:3px;',
    '  background:#0d1518; border:1px solid rgba(255,255,255,.16); border-radius:999px;',
    '  box-shadow:0 8px 24px rgba(0,0,0,.55); }',
    '#web-shell-viewbar button { display:grid; place-items:center; width:36px; height:30px;',
    '  border:0; border-radius:999px; background:transparent; color:#aab4b6; font-size:16px;',
    '  cursor:pointer; padding:0; }',
    '#web-shell-viewbar button.is-active { background:rgba(200,255,0,.16); color:#c8ff00; }',
    'html.ws-mobile #web-shell-preview { z-index:1; pointer-events:auto; }',
    'html.ws-mobile #web-shell-preview img { pointer-events:auto; touch-action:none;',
    '  -webkit-user-select:none; user-select:none; -webkit-user-drag:none; }',
    'html.ws-mobile #agent-panel { z-index:520; box-shadow:none; border:0; }',
    'html.ws-mobile #agent-drawer-resize { display:none !important; }',
    // The transcript ships a 190px bottom padding (11+190 = 201px minimum
    // border-box height). Flex can shrink content but never padding, so in
    // short landscape panes the composer got pushed out and cropped.
    'html.ws-mobile #agent-panel .agent-transcript { padding-bottom: 24px; }',
    // LORDE_CHAT_TIMELINE_V1 — the dash strip is tuned for the docked desktop
    // drawer; in the mobile split view it would overlap the resized panes.
    'html.ws-mobile #agent-timeline { display: none !important; }'
  ].join('\n');
  document.head.appendChild(mobileCss);

  var dividerEl = null;
  var viewbarEl = null;

  function viewbarButton(icon, label, onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    var i = document.createElement('i');
    i.className = 'ph ' + icon;
    b.appendChild(i);
    b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
    return b;
  }
  function ensureMobileUi() {
    if (!dividerEl) {
      dividerEl = document.createElement('div');
      dividerEl.id = 'web-shell-divider';
      document.body.appendChild(dividerEl);
      dividerEl.addEventListener('pointerdown', onDividerDown);
      dividerEl.addEventListener('pointermove', onDividerMove);
      dividerEl.addEventListener('pointerup', onDividerUp);
      dividerEl.addEventListener('pointercancel', onDividerUp);
    }
    if (!viewbarEl) {
      viewbarEl = document.createElement('div');
      viewbarEl.id = 'web-shell-viewbar';
      viewbarEl.style.display = 'none';
      viewbarEl.appendChild(viewbarButton('ph-monitor', 'Full tab', setModeTab));
      viewbarEl.appendChild(viewbarButton('ph-columns', 'Split view', setModeSplit));
      viewbarEl.appendChild(viewbarButton('ph-chat-centered-text', 'Full chat', setModeChat));
      var swapBtn = viewbarButton('ph-arrows-clockwise', 'Swap panes', swapPanes);
      swapBtn.id = 'web-shell-viewbar-swap';
      viewbarEl.appendChild(swapBtn);
      // Any touch on the bar keeps it alive for another 5s window.
      viewbarEl.addEventListener('pointerdown', function () { refreshViewbar(); });
      document.body.appendChild(viewbarEl);
    }
  }
  // The view bar is transient: it appears when the chat is toggled from the
  // header or a view mode changes, and auto-hides after 5s of inactivity.
  var viewbarShown = false;
  var viewbarTimer = null;
  var VIEWBAR_TTL = 5000;
  function showViewbar() {
    ensureMobileUi();
    viewbarShown = true;
    viewbarEl.style.display = 'flex';
    layoutMobile();
    if (viewbarTimer) clearTimeout(viewbarTimer);
    viewbarTimer = setTimeout(hideViewbar, VIEWBAR_TTL);
  }
  function hideViewbar() {
    viewbarShown = false;
    if (viewbarTimer) { clearTimeout(viewbarTimer); viewbarTimer = null; }
    if (viewbarEl) viewbarEl.style.display = 'none';
  }
  function refreshViewbar() {
    if (viewbarShown) showViewbar();
  }
  function agentOpen() {
    var t = document.querySelector('#agent-toggle');
    return !!(t && t.getAttribute('aria-expanded') === 'true');
  }
  function setAgent(open) {
    var t = document.querySelector('#agent-toggle');
    if (t && (t.getAttribute('aria-expanded') === 'true') !== open) t.click();
  }
  function setModeTab() { wsStore(WS_MODE_KEY, 'split'); setAgent(false); setTimeout(showViewbar, 80); }
  function setModeSplit() { wsStore(WS_MODE_KEY, 'split'); setAgent(true); setTimeout(showViewbar, 80); }
  function setModeChat() { wsStore(WS_MODE_KEY, 'chat-full'); setAgent(true); setTimeout(showViewbar, 80); }
  function swapPanes() {
    var pos = chatPos();
    wsStore(WS_POS_KEY, pos === 'bottom' ? 'top' : pos === 'top' ? 'bottom' : pos === 'left' ? 'right' : 'left');
    showViewbar();
  }

  // Divider drag-resize (pointer events -> works with touch and mouse).
  var drag = null;
  function onDividerDown(e) {
    drag = {
      pid: e.pointerId,
      start: chatPos() === 'left' || chatPos() === 'right' ? e.clientX : e.clientY,
      size: chatSize(),
    };
    dividerEl.classList.add('ws-drag');
    try { dividerEl.setPointerCapture(e.pointerId); } catch (err) { }
    e.preventDefault();
  }
  function onDividerMove(e) {
    if (!drag || e.pointerId !== drag.pid) return;
    var pos = chatPos();
    var horizontal = pos === 'bottom' || pos === 'top';
    var total = horizontal ? (window.innerHeight - chromeBottom()) : window.innerWidth;
    if (total <= 0) return;
    var cur = horizontal ? e.clientY : e.clientX;
    var deltaFrac = (cur - drag.start) / total;
    var size = drag.size;
    if (pos === 'bottom') size = drag.size - deltaFrac;
    else if (pos === 'top') size = drag.size + deltaFrac;
    else if (pos === 'left') size = drag.size + deltaFrac;
    else size = drag.size - deltaFrac;
    wsStore(WS_SIZE_KEY, Math.min(0.8, Math.max(0.2, size)));
    layoutMobile();
  }
  function onDividerUp() { drag = null; if (dividerEl) dividerEl.classList.remove('ws-drag'); }

  function setRect(el, x, y, w, h) {
    el.style.left = Math.round(x) + 'px';
    el.style.top = Math.round(y) + 'px';
    el.style.width = Math.round(w) + 'px';
    el.style.height = Math.round(h) + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
  }
  function layoutMobile() {
    if (!window.__wsMobileActive) return;
    ensureMobileUi();
    var chromeH = chromeBottom();
    var vw = window.innerWidth, vh = window.innerHeight;
    var availH = Math.max(120, vh - chromeH);
    var mode = viewMode();
    var landscape = vw > vh;
    // Migrate the stored pane position when the device rotates.
    var pos = chatPos();
    if (landscape && (pos === 'bottom' || pos === 'top')) { pos = 'right'; wsStore(WS_POS_KEY, pos); }
    if (!landscape && (pos === 'left' || pos === 'right')) { pos = 'bottom'; wsStore(WS_POS_KEY, pos); }

    var ap = document.querySelector('#agent-panel');
    var chatVisible = !!(ap && !ap.hidden);
    var size = chatSize();
    if (!chatVisible && mode === 'chat-full') { mode = 'split'; wsStore(WS_MODE_KEY, 'split'); }

    if (dividerEl) dividerEl.style.display = (mode === 'split' && chatVisible) ? 'block' : 'none';

    if (ap && chatVisible) {
      if (mode === 'chat-full') setRect(ap, 0, chromeH, vw, availH);
      else if (pos === 'bottom') setRect(ap, 0, chromeH + availH * (1 - size), vw, availH * size);
      else if (pos === 'top') setRect(ap, 0, chromeH, vw, availH * size);
      else if (pos === 'left') setRect(ap, 0, chromeH, vw * size, availH);
      else setRect(ap, vw * (1 - size), chromeH, vw * size, availH);
    }

    if (mode === 'chat-full') {
      // Chat owns the whole area below the chrome — hide the preview.
      preview.style.display = 'none';
    } else {
      // Inline pointer-events:auto is REQUIRED here: the base cssText has
      // pointer-events:none, and an inline style beats the stylesheet rule.
      preview.style.display = 'flex';
      preview.style.pointerEvents = 'auto';
      if (!chatVisible) setRect(preview, 0, chromeH, vw, availH);
      else if (pos === 'bottom') setRect(preview, 0, chromeH, vw, availH * (1 - size));
      else if (pos === 'top') setRect(preview, 0, chromeH + availH * size, vw, availH * (1 - size));
      else if (pos === 'left') setRect(preview, vw * size, chromeH, vw * (1 - size), availH);
      else setRect(preview, 0, chromeH, vw * (1 - size), availH);
    }

    if (dividerEl && mode === 'split' && chatVisible) {
      dividerEl.className = (pos === 'left' || pos === 'right') ? 'ws-v' : 'ws-h';
      if (pos === 'bottom') setRect(dividerEl, 0, chromeH + availH * (1 - size) - 9, vw, 18);
      else if (pos === 'top') setRect(dividerEl, 0, chromeH + availH * size - 9, vw, 18);
      else if (pos === 'left') setRect(dividerEl, vw * size - 9, chromeH, 18, availH);
      else setRect(dividerEl, vw * (1 - size) - 9, chromeH, 18, availH);
    }

    if (viewbarEl) {
      var splitBtn = viewbarEl.children[1], chatBtn = viewbarEl.children[2];
      if (splitBtn) splitBtn.classList.toggle('is-active', mode === 'split' && chatVisible);
      if (chatBtn) chatBtn.classList.toggle('is-active', mode === 'chat-full');
      if (viewbarShown) {
        var bw = viewbarEl.offsetWidth || 210, bh = viewbarEl.offsetHeight || 38;
        if (mode === 'split' && chatVisible) {
          if (pos === 'bottom') setRect(viewbarEl, vw - bw - 10, chromeH + availH * (1 - size) - bh - 12, bw, bh);
          else if (pos === 'top') setRect(viewbarEl, vw - bw - 10, chromeH + availH * size + 12, bw, bh);
          else if (pos === 'left') setRect(viewbarEl, vw * size + 12, vh - bh - 10, bw, bh);
          else setRect(viewbarEl, vw * (1 - size) - bw - 12, vh - bh - 10, bw, bh);
        } else {
          setRect(viewbarEl, (vw - bw) / 2, vh - bh - 10, bw, bh);
        }
      } else if (viewbarEl.style.display !== 'none') {
        viewbarEl.style.display = 'none';
      }
    }
  }
  window.__wsLayoutMobile = layoutMobile;

  // Live tab interaction: taps/drags/wheel on the preview become real CDP
  // input on the controlled tab (browser-use:gui-pointer, normalized coords).
  var ptr = { active: false, id: null, moved: false, x: 0, y: 0 };
  function pointerSend(type, e, extra) {
    var r = previewImg.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var nx = (e.clientX - r.left) / r.width;
    var ny = (e.clientY - r.top) / r.height;
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return;
    var payload = { type: type, x: nx, y: ny };
    if (extra) for (var k in extra) payload[k] = extra[k];
    fetch('/ipc', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'browser-use:gui-pointer', args: [payload] })
    }).catch(function () { });
  }
  previewImg.draggable = false;
  previewImg.addEventListener('pointerdown', function (e) {
    if (!window.__wsMobileActive) return;
    ptr = { active: true, id: e.pointerId, moved: false, x: e.clientX, y: e.clientY };
    try { previewImg.setPointerCapture(e.pointerId); } catch (err) { }
    pointerSend('down', e);
    e.preventDefault();
  });
  previewImg.addEventListener('pointermove', function (e) {
    if (!window.__wsMobileActive || !ptr.active || e.pointerId !== ptr.id) return;
    if (Math.abs(e.clientX - ptr.x) + Math.abs(e.clientY - ptr.y) > 3) ptr.moved = true;
    pointerSend('move', e, { pressed: true });
    e.preventDefault();
  });
  function ptrUp(e) {
    if (!ptr.active || e.pointerId !== ptr.id) return;
    pointerSend('up', e);
    ptr.active = false;
    e.preventDefault();
  }
  previewImg.addEventListener('pointerup', ptrUp);
  previewImg.addEventListener('pointercancel', ptrUp);
  previewImg.addEventListener('wheel', function (e) {
    if (!window.__wsMobileActive) return;
    pointerSend('wheel', e, { dx: e.deltaX / 120, dy: e.deltaY / 120 });
    e.preventDefault();
  }, { passive: false });

  function resetMobileStyles() {
    [preview, document.querySelector('#agent-panel')].forEach(function (el) {
      if (!el) return;
      ['left', 'top', 'width', 'height', 'right', 'bottom', 'display'].forEach(function (p) { el.style[p] = ''; });
    });
    preview.style.pointerEvents = 'none'; // desktop: preview stays click-through
    if (dividerEl) dividerEl.style.display = 'none';
    if (viewbarEl) viewbarEl.style.display = 'none';
  }
  var lastMobile = null;
  function applyMobile() {
    var on = isMobile();
    var changed = on !== lastMobile;
    lastMobile = on;
    document.documentElement.classList.toggle('ws-mobile', on);
    window.__wsMobileActive = on;
    if (on) { layoutMobile(); if (changed) showViewbar(); }
    else if (changed) resetMobileStyles();
  }
  window.addEventListener('resize', function () { setTimeout(applyMobile, 60); });
  // Tapping the header chat icon pops the bar up for its 5s window.
  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest && e.target.closest('#agent-toggle');
    if (t && window.__wsMobileActive) setTimeout(showViewbar, 120);
  }, true);
  // Manual toggle + test hook: 'auto' | 'on' | 'off' (no arg = cycle).
  window.__webShellMobile = function (v) {
    var next;
    if (v === 'on' || v === 'off' || v === 'auto') next = v;
    else {
      var order = ['auto', 'on', 'off'];
      next = order[(order.indexOf(wsStore(WS_PREF_KEY) || 'auto') + 1) % order.length];
    }
    wsStore(WS_PREF_KEY, next);
    lastMobile = null;
    applyMobile();
    return next;
  };
  applyMobile();

  // --- live preview data ----------------------------------------------------
  var source;
  function listen() {
    try { source = new EventSource('/events'); } catch (e) { return; }
    source.onmessage = function (message) {
      var data;
      try { data = JSON.parse(message.data); } catch (e) { return; }
      if (!data || data.channel !== 'browser-use:gui-preview' || !data.payload) return;
      if (data.payload.dataUrl) {
        previewImg.src = data.payload.dataUrl;
        preview.style.opacity = '1';
      }
    };
    source.onerror = function () { /* EventSource retries on its own */ };
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', listen);
  } else {
    listen();
  }
  applyBounds();
})();
`;
