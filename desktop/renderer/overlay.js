(() => {
  const backdrop = document.querySelector('#overlay-backdrop');
  const deviceMenu = document.querySelector('#device-menu');
  const historyMenu = document.querySelector('#history-menu');
  const downloadsPanel = document.querySelector('#downloads-panel');
  let downloadsRenderKey = '';
  const consolePanel = document.querySelector('#console-panel');
  const settingsPanel = document.querySelector('#settings-panel');
  const recordingPanel = document.querySelector('#recording-panel');
  const recordingToggle = document.querySelector('#recording-toggle');
  const recordingForm = document.querySelector('#recording-form');
  const recordingClose = document.querySelector('#recording-close');
  const recordingStatus = document.querySelector('#recording-status');
  const recordingPath = document.querySelector('#recording-path');
  const recordingTabField = document.querySelector('#recording-tab-field');
  const recordingTab = document.querySelector('#recording-tab');
  const recordingAudio = document.querySelector('#recording-audio');
  const recordingSpeed = document.querySelector('#recording-speed');
  const recordingModeRadios = [...document.querySelectorAll('input[name="recording-mode"]')];
  // Tab dropdown rendering is guarded like the downloads panel: state events
  // arrive for every unrelated change, and rebuilding a <select> the user has
  // open would drop the hover/selection.
  let recordingTabsRenderKey = '';
  const activeRecordingMode = () => recordingModeRadios.find(radio => radio.checked)?.value || 'window';
  const syncRecordingTabField = () => { if (recordingTabField) recordingTabField.hidden = activeRecordingMode() !== 'tab'; };
  const syncRecordingAudio = () => {
    if (!recordingAudio || !recordingSpeed) return;
    if (recordingAudio.checked) {
      // Audio plays at real time while the speed feature compresses video
      // timestamps; anything above 1x would desync the track.
      recordingSpeed.value = '1';
      recordingSpeed.disabled = true;
      recordingSpeed.title = 'Audio requires 1x speed.';
    } else {
      recordingSpeed.disabled = false;
      recordingSpeed.title = '';
    }
  };
  recordingModeRadios.forEach(radio => radio.addEventListener('change', syncRecordingTabField));
  recordingAudio?.addEventListener('change', syncRecordingAudio);
  function renderRecordingTabs(tabs) {
    if (!recordingTab) return;
    const entries = Array.isArray(tabs) ? tabs : [];
    const key = JSON.stringify(entries.map(tab => [tab.id, tab.title, tab.url]));
    if (key === recordingTabsRenderKey) return;
    recordingTabsRenderKey = key;
    const previous = recordingTab.value;
    recordingTab.replaceChildren(...entries.map(tab => {
      const option = document.createElement('option');
      option.value = String(tab.id);
      let host = '';
      try { host = new URL(tab.url || '').hostname.replace(/^www\./, ''); } catch { /* about:blank and friends have no host */ }
      option.textContent = `${tab.title || host || 'Tab'}${host && tab.title ? ` — ${host}` : ''}`;
      return option;
    }));
    const stillThere = entries.some(tab => String(tab.id) === previous);
    if (stillThere) recordingTab.value = previous;
    else {
      const activeTab = entries.find(tab => tab.active);
      if (activeTab) recordingTab.value = String(activeTab.id);
    }
  }
  recordingToggle?.addEventListener('click', async () => { await window.browserUseDesktop.setActiveDrawer('recorder'); const status = await window.browserUseDesktop.recordingStatus().catch(() => null); if (status?.path && recordingPath) recordingPath.value = status.path; });
  recordingClose?.addEventListener('click', () => window.browserUseDesktop.closeOverlay());
  const recordingStartButton = document.querySelector('#recording-start');
  const recordingStartLabel = document.querySelector('#recording-start-label');
  const setRecordingStartLabel = (text) => { if (recordingStartLabel) recordingStartLabel.textContent = text; else if (recordingStartButton) recordingStartButton.textContent = text; };
  document.querySelector('#recording-browse')?.addEventListener('click', async () => { const chosen = await window.browserUseDesktop.recordingPickPath(); if (chosen) recordingPath.value = chosen; });
  recordingForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (recordingStartButton?.dataset.recording === 'true') { try { await window.browserUseDesktop.recordingStop(); recordingStatus.textContent = 'Saved'; } catch (error) { recordingStatus.textContent = error.message; } setRecordingStartLabel('Start recording'); recordingStartButton.dataset.recording = 'false'; return; }
    const quality = Number(document.querySelector('#recording-quality').value);
    const custom = document.querySelector('input[name="recording-duration"]:checked')?.value === 'custom';
    const mode = activeRecordingMode();
    const audio = recordingAudio?.checked === true;
    const input = { mode, tabId: mode === 'tab' ? recordingTab.value : undefined, audio, path: recordingPath.value || undefined, speed: audio ? 1 : Number(document.querySelector('#recording-speed').value), fps: Number(document.querySelector('#recording-fps').value), width: quality >= 2160 ? 3840 : quality >= 1440 ? 2560 : quality >= 1080 ? 1920 : quality >= 720 ? 1280 : quality >= 480 ? 854 : 640, maxDuration: custom ? Number(document.querySelector('#recording-minutes').value) : 'auto' };
    try { const started = await window.browserUseDesktop.recordingStart(input); if (started?.path) recordingPath.value = started.path; recordingStatus.textContent = 'Recording'; setRecordingStartLabel('Stop recording'); recordingStartButton.dataset.recording = 'true'; } catch (error) { recordingStatus.textContent = error.message; setRecordingStartLabel('Start recording'); recordingStartButton.dataset.recording = 'false'; }
  });
  const aboutPopup = document.querySelector('#about-popup');
  const aboutClose = document.querySelector('#about-close');
  let showingAbout = false;
  const closeAbout = () => window.browserUseDesktop.closeAbout();
  aboutClose.addEventListener('click', closeAbout);
  document.querySelector('#about-done').addEventListener('click', closeAbout);
  const settingsHeading = document.querySelector('#settings-heading');
  const closeConsole = document.querySelector('#close-console');
  const closeSettings = document.querySelector('#close-settings');
  const consoleList = document.querySelector('#console-list');
  const consoleEmpty = document.querySelector('#console-empty');
  const clearConsole = document.querySelector('#clear-console');
  const previewOverlay = document.querySelector('#preview-overlay');
  const previewTitle = document.querySelector('#preview-title');
  const previewMeta = document.querySelector('#preview-meta');
  const previewImageWrap = document.querySelector('#preview-image-wrap');
  const previewImage = document.querySelector('#preview-image');
  const previewVideo = document.querySelector('#preview-video');
  const previewText = document.querySelector('#preview-text');
  const previewHtml = document.querySelector('#preview-html');
  const previewDownload = document.querySelector('#preview-download');
  const previewClose = document.querySelector('#preview-close');

  const settingsForm = document.querySelector('#settings-form');
  const mcpControlMode = document.querySelector('#mcp-control-mode');
  const saveSettingsButton = document.querySelector('[form="settings-form"]');
  const settingsActionbar = document.querySelector('.settings-actionbar');
  const copyMcp = document.querySelector('#copy-mcp');
  const copyClaudeCodeMcp = document.querySelector('#copy-claude-code-mcp');
  const createPairing = document.querySelector('#create-pairing');
  const mcpCommand = document.querySelector('#mcp-command');
  const mcpNote = document.querySelector('#mcp-note');
  const mcpSessions = document.querySelector('#mcp-sessions');
  const openDevTools = document.querySelector('#open-devtools');
  const gptActionEnabled = document.querySelector('#gpt-action-enabled');
  const gptActionPublicOrigin = document.querySelector('#gpt-action-public-origin');
  const gptOpenApiUrl = document.querySelector('#gpt-openapi-url');
  const gptApiKey = document.querySelector('#gpt-api-key');
  const gptActionSchema = document.querySelector('#gpt-action-schema');
  const copyGptOpenApi = document.querySelector('#copy-gpt-openapi');
  const copyGptKey = document.querySelector('#copy-gpt-key');
  const copyGptSchema = document.querySelector('#copy-gpt-schema');
  const modeTabGlobal = document.querySelector('#mode-tab-global');
  const globalMcpPanel = document.querySelector('#global-mcp-panel');
  const settingsSaveState = document.querySelector('#settings-save-state');
  const settingsActionHint = document.querySelector('#settings-action-hint');
  const mcpListeningChip = document.querySelector('#mcp-listening-chip');
  const mcpPairingState = document.querySelector('#mcp-pairing-state');
  const settingsNavItems = [...document.querySelectorAll('[data-settings-section]')];
  const settingsSections = [...document.querySelectorAll('[data-settings-panel]')];

  let state = null;
  let consoleEntries = [];
  let consoleFilter = 'all';
  let mcpStatus = { listening: false, endpoint: null, pairingEndpoint: null, pairing: { active: false }, sessions: [] };
  let pairingCode = '';
  let pairingCodeExpiresAt = 0;
  let preview = null;
  let activeSettingsSection = 'mcp';
  let settingsDirty = false;
  const COPY_FEEDBACK_MS = 1500;

  function setSettingsSaveState(state, message) {
    if (settingsSaveState) {
      settingsSaveState.dataset.state = state;
      settingsSaveState.textContent = message;
    }
    if (settingsActionHint) settingsActionHint.textContent = state === 'error' ? message : state === 'saving' ? 'Saving changes...' : 'Unsaved changes';
    if (settingsActionbar) settingsActionbar.hidden = state === 'saved';
  }

  function markSettingsDirty() {
    settingsDirty = true;
    setSettingsSaveState('dirty', 'Unsaved');
  }

  function setSettingsSection(section, { focus = false } = {}) {
    const next = settingsSections.some((panel) => panel.dataset.settingsPanel === section) ? section : 'mcp';
    activeSettingsSection = next;
    settingsNavItems.forEach((item) => {
      const selected = item.dataset.settingsSection === next;
      item.classList.toggle('is-active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      if (focus && selected) item.focus();
    });
    settingsSections.forEach((panel) => {
      const selected = panel.dataset.settingsPanel === next;
      panel.hidden = !selected;
      panel.classList.toggle('is-active', selected);
    });
  }

  settingsNavItems.forEach(item => item.addEventListener('click', () => setSettingsSection(item.dataset.settingsSection)));
  settingsNavItems.forEach((item, index) => item.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const forward = ['ArrowRight', 'ArrowDown'].includes(event.key);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? settingsNavItems.length - 1 : (index + (forward ? 1 : -1) + settingsNavItems.length) % settingsNavItems.length;
    setSettingsSection(settingsNavItems[nextIndex]?.dataset.settingsSection || 'mcp', { focus: true });
  }));

  function closeOverlay() {
    setSettingsSection('mcp');
    window.browserUseDesktop.closeOverlay();
  }

  function closePreview() {
    window.browserUseDesktop.closePreview();
  }

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) showingAbout ? closeAbout() : preview ? closePreview() : closeOverlay();
  });

  closeConsole?.addEventListener('click', closeOverlay);
  closeSettings?.addEventListener('click', closeOverlay);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') showingAbout ? closeAbout() : preview ? closePreview() : closeOverlay();
  });

  document.addEventListener('contextmenu', (event) => {
    if (event.defaultPrevented) return;
  event.preventDefault();
  const target = event.target instanceof Element ? event.target : null;
  const editableTarget = target?.closest('input:not([readonly]):not([disabled]), textarea:not([readonly]):not([disabled]), [contenteditable="true"]');
  const inputSelection = editableTarget instanceof HTMLInputElement || editableTarget instanceof HTMLTextAreaElement
    ? editableTarget.value.slice(editableTarget.selectionStart ?? 0, editableTarget.selectionEnd ?? 0)
    : '';
  void window.browserUseDesktop.showContextMenu({
    kind: 'shell',
    editable: Boolean(editableTarget),
    selection: inputSelection || window.getSelection?.().toString() || ''
  }).catch((error) => console.error('Could not open context menu', error));
});

  previewClose?.addEventListener('click', closePreview);
  previewDownload?.addEventListener('click', async () => {
    try {
      previewDownload.disabled = true;
      const saved = await window.browserUseDesktop.downloadPreview();
      previewMeta.textContent = `Downloaded to ${saved.path}`;
      previewMeta.classList.add('preview-download-status');
    } catch (error) {
      previewMeta.textContent = error?.message || 'Could not download this file.';
    } finally {
      previewDownload.disabled = false;
    }
  });

  function renderPreview(nextPreview) {
    preview = nextPreview || null;
    previewOverlay.hidden = !preview;
    backdrop.classList.toggle('has-preview', Boolean(preview));
    previewImageWrap.hidden = true;
    previewText.hidden = true;
    previewHtml.hidden = true;
    previewImage.removeAttribute('src');
    previewVideo.pause();
    previewVideo.removeAttribute('src');
    previewText.textContent = '';
    previewHtml.srcdoc = '';
    previewMeta.classList.remove('preview-download-status');
    if (!preview) return;
    previewTitle.textContent = preview.filename || (preview.kind === 'screenshot' ? 'Screenshot preview' : preview.kind === 'media' ? 'Media preview' : 'Report preview');
    previewMeta.textContent = preview.meta || (preview.kind === 'media' ? 'Generated media' : preview.format === 'html' ? 'Formatted HTML report' : preview.format === 'txt' ? 'Formatted text report' : 'Captured browser screenshot');
    if (preview.kind === 'media') {
      const source = preview.url || `data:${preview.mimeType};base64,${preview.data}`;
      if ((preview.mediaKind || '') === 'video' || /^video\//.test(preview.mimeType || '')) {
        previewVideo.src = source;
        previewVideo.hidden = false;
      } else {
        previewImage.src = preview.url || `data:${preview.mimeType};base64,${preview.data}`;
      }
      previewImageWrap.hidden = false;
    } else if (preview.kind === 'screenshot') {
      previewImage.src = `data:${preview.mimeType};base64,${preview.data}`;
      previewImageWrap.hidden = false;
    } else if (preview.format === 'html') {
      previewHtml.srcdoc = preview.content || '';
      previewHtml.hidden = false;
    } else {
      previewText.textContent = preview.content || '';
      previewText.hidden = false;
    }
    previewClose.focus();
  }

  function renderDeviceMenu(profiles, deviceState) {
    const activeId = deviceState?.profileId || 'desktop';
    deviceMenu.replaceChildren(...profiles.map((profile) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.role = 'menuitemradio';
      item.className = `device-item${profile.id === activeId ? ' is-active' : ''}`;
      item.setAttribute('aria-checked', String(profile.id === activeId));
      const label = document.createElement('span');
      label.textContent = profile.label;
      item.append(label);
      if (profile.width) {
        const size = document.createElement('small');
        size.textContent = `${profile.width}x${profile.height} @${profile.deviceScaleFactor}x`;
        item.append(size);
      }
      item.addEventListener('click', async () => {
        const orientation = profile.id === 'desktop'
          ? (deviceState?.profileId === 'desktop' ? deviceState.orientation : 'landscape')
          : (deviceState?.profileId === profile.id ? deviceState.orientation : 'portrait');
        try {
          await window.browserUseDesktop.setDeviceMode({
            profileId: profile.id,
            orientation
          });
        } catch (err) { console.error(err); }
        finally { closeOverlay(); }
      });
      return item;
    }));
  }

  function formatHistoryTime(visitedAt) {
    const diff = Date.now() - Number(visitedAt || 0);
    if (diff < 60_000) return 'just now';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
    return new Date(Number(visitedAt)).toLocaleDateString();
  }

  let historyClearOpen = false;
  // State events arrive for every unrelated change; rebuilding the menu each
  // time would drop hover state and flicker. Re-render only when the data or
  // anchor actually changes.
  let historyMenuRenderKey = '';

  function renderHistoryMenu(entries, anchor) {
    historyMenu.replaceChildren();

    // Head row + Clear… submenu (same affordances the chrome dropdown had).
    const head = document.createElement('div');
    head.className = 'address-menu-head';
    const title = document.createElement('strong');
    title.textContent = 'Recent history';
    const clearButton = document.createElement('button');
    clearButton.type = 'button';
    clearButton.className = 'plain-button address-menu-clear';
    clearButton.textContent = 'Clear…';
    head.append(title, clearButton);
    historyMenu.append(head);
    clearButton.addEventListener('click', (event) => { event.stopPropagation(); historyClearOpen = !historyClearOpen; void renderHistoryMenu(entries, anchor); });

    if (historyClearOpen) {
      const clearMenu = document.createElement('div');
      clearMenu.className = 'address-clear-menu';
      const option = (label, options) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', async () => {
          try { await window.browserUseDesktop.historyClear(options); } catch (error) { console.error('Could not clear history.', error); }
          // Re-open (true) refetches the entry list in the main process.
          await window.browserUseDesktop.setHistoryMenuOpen(true);
        });
        return button;
      };
      const customRow = (defaultHours) => {
        const customHours = document.createElement('div');
        customHours.className = 'clear-custom';
        const input = document.createElement('input');
        input.type = 'number';
        if (defaultHours) { input.min = '1'; input.max = '720'; input.value = '12'; }
        else { input.min = '1'; input.max = '365'; input.value = '7'; }
        const label = document.createElement('label');
        label.textContent = defaultHours ? 'custom hours' : 'custom days';
        const go = document.createElement('button');
        go.type = 'button';
        go.textContent = 'Clear';
        go.addEventListener('click', () => option('clear', defaultHours
          ? { hours: Math.max(1, Number(input.value) || 12) }
          : { days: Math.max(1, Number(input.value) || 7) }).click());
        customHours.append(input, label, go);
        return customHours;
      };
      clearMenu.append(
        option('Last hour', { hours: 1 }),
        option('Last 12 hours', { hours: 12 }),
        option('Last day', { days: 1 }),
        customRow(true),
        customRow(false)
      );
      historyMenu.append(clearMenu);
    }

    if (!Array.isArray(entries) || !entries.length) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = 'No history yet.';
      historyMenu.append(empty);
    }
    for (const entry of entries || []) {
      const row = document.createElement('div');
      row.className = 'history-row';
      row.setAttribute('role', 'menuitem');
      row.tabIndex = 0;
      const marker = document.createElement('span');
      marker.className = 'history-favicon';
      // The overlay does not load the Phosphor icon font, so the clock is an
      // inline SVG rather than a `ph` class glyph.
      marker.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
      const text = document.createElement('span');
      text.className = 'history-text';
      const name = document.createElement('strong');
      name.textContent = entry.title || entry.url;
      const url = document.createElement('small');
      url.textContent = `${entry.url} · ${formatHistoryTime(entry.visitedAt)}`;
      text.append(name, url);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'history-delete';
      remove.setAttribute('aria-label', `Delete this history entry: ${entry.title || entry.url}`);
      remove.textContent = '×';
      remove.addEventListener('click', async (event) => {
        event.stopPropagation();
        try {
          await window.browserUseDesktop.historyDelete(entry.id);
          // Re-open (true) refetches the entry list in the main process.
          await window.browserUseDesktop.setHistoryMenuOpen(true);
        } catch (error) { console.error('Could not delete the history entry.', error); }
      });
      const open = async () => {
        try { await window.browserUseDesktop.navigate(entry.url); }
        catch (error) { console.error('Could not open the history entry.', error); }
        finally { window.browserUseDesktop.closeOverlay(); }
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter') open(); });
      row.append(marker, text, remove);
      historyMenu.append(row);
    }
    // Anchor (computed by the chrome from the address input's rect) is given
    // in overlay coordinates; the overlay BrowserView starts right below the
    // 76px chrome, so a dropdown under the address bar lands near the top.
    const width = Math.max(240, Math.min(560, Number(anchor?.width) || 420));
    historyMenu.style.width = `${Math.min(width, window.innerWidth - 16)}px`;
    historyMenu.style.left = `${Math.max(8, Math.min(Number(anchor?.left) || 10, window.innerWidth - width - 8))}px`;
    historyMenu.style.top = `${Math.max(0, Math.round(Number(anchor?.top) || 0))}px`;
  }

  function renderState(nextState) {
    const previouslyOpen = state?.activeDrawer === 'settings';
    state = nextState;
    const activeDrawer = state?.activeDrawer || null;
    const deviceMenuOpen = Boolean(state?.deviceMenuOpen);
    const historyMenuOpen = Boolean(state?.historyMenuOpen);
    const previewOpen = Boolean(state?.previewOpen);
    const aboutWasOpen = showingAbout;
    showingAbout = Boolean(state?.about);
    aboutPopup.hidden = !showingAbout;
    backdrop.classList.toggle('has-about', showingAbout);
    if (showingAbout) {
      document.querySelector('#about-name').textContent = state.about.name;
      document.querySelector('#about-version').textContent = state.about.version;
      document.querySelector('#about-copyright').textContent = state.about.copyright;
      if (!aboutWasOpen) aboutClose.focus();
    }
    const hasOverlay = ['settings', 'console', 'recorder'].includes(activeDrawer) || deviceMenuOpen || historyMenuOpen || state?.downloadsOpen || showingAbout || previewOpen;

    // The backdrop itself is the input-capturing surface. Its children must be
    // visible at the same time as it; keeping them as `hidden` descendants
    // would leave a perfectly-sized transparent BrowserView above the page.
    backdrop.hidden = !hasOverlay;
    deviceMenu.hidden = showingAbout || !deviceMenuOpen;
    historyMenu.hidden = showingAbout || !historyMenuOpen;
    consolePanel.hidden = showingAbout || activeDrawer !== 'console';
    settingsPanel.hidden = showingAbout || activeDrawer !== 'settings';
    recordingPanel.hidden = showingAbout || activeDrawer !== 'recorder';
    const recordingActive = ['starting', 'recording', 'stopping'].includes(state?.recording?.state);
    renderRecordingTabs(state?.tabs);
    syncRecordingTabField();
    if (recordingStartButton) { setRecordingStartLabel(recordingActive ? 'Stop recording' : 'Start recording'); recordingStartButton.dataset.recording = String(recordingActive); }
    if (recordingStatus) {
      const recordingState = state?.recording?.state;
      if (recordingState === 'failed') recordingStatus.textContent = state.recording.error || 'Recording failed.';
      else if (recordingState === 'completed') recordingStatus.textContent = `Saved to ${state.recording.path}`;
      else if (recordingState === 'recording') recordingStatus.textContent = state.recording.audio === 'unavailable' ? 'Recording (no audio: the source did not provide an audio track)' : 'Recording';
      else if (recordingState === 'stopping') recordingStatus.textContent = 'Finalizing';
    }
    recordingToggle?.classList.toggle('is-active', activeDrawer === 'recorder');
    downloadsPanel.hidden = !state?.downloadsOpen;
    if (state?.downloadsOpen) {
      const key = JSON.stringify(state.downloads || []);
      if (key !== downloadsRenderKey) {
        window.BrowserUseSurfaces.renderDownloads(downloadsPanel, state.downloads, window.browserUseDesktop, reportError);
        downloadsRenderKey = key;
      }
      downloadsPanel.style.left = `${Math.max(8, Math.min(Number(state.downloadsAnchor?.left) || 8, window.innerWidth - Math.min(340, window.innerWidth - 16) - 8))}px`;
      downloadsPanel.style.top = `${Math.max(0, Number(state.downloadsAnchor?.top) || 0)}px`;
    } else { downloadsRenderKey = ''; }
    if (!showingAbout && activeDrawer === 'settings' && (!previouslyOpen || aboutWasOpen)) {
      setSettingsSection('mcp');
      closeSettings?.focus();
    }
    if (!previewOpen && preview) renderPreview(null);
    if (settingsHeading) settingsHeading.textContent = 'Settings';

    if (historyMenuOpen) {
      const key = JSON.stringify([state?.historyMenuEntries, state?.historyMenuAnchor]);
      if (key !== historyMenuRenderKey) {
        historyMenuRenderKey = key;
        renderHistoryMenu(state?.historyMenuEntries, state?.historyMenuAnchor);
      }
    } else {
      historyMenuRenderKey = '';
      historyClearOpen = false;
    }

    if (deviceMenuOpen && state?.deviceProfiles) {
      renderDeviceMenu(state.deviceProfiles, state.device);
      const anchor = state.deviceMenuAnchor || { left: 10, top: 0, width: 28 };
      const menuWidth = 220;
      const left = Math.max(8, Math.min(window.innerWidth - menuWidth - 8, Number(anchor.left) || 10));
      deviceMenu.style.left = `${Math.round(left)}px`;
      deviceMenu.style.top = `${Math.max(0, Math.round(Number(anchor.top) || 0))}px`;
    }
  }

  function renderConsole(entries) {
    consoleEntries = entries || [];
    window.BrowserUseSurfaces.renderConsole(consoleList, consoleEmpty, consoleEntries, consoleFilter, state?.tabs || []);
  }

  document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    consoleFilter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('is-active', item === button));
    renderConsole(consoleEntries);
  }));

  clearConsole?.addEventListener('click', async () => {
    renderConsole(await window.browserUseDesktop.clearConsole());
  });

  const copyFeedbackTimers = new WeakMap();
  function flashLabel(button, label) {
    if (!button) return;
    const target = button.querySelector('span') || button;
    if (!target.dataset.originalLabel) target.dataset.originalLabel = target.textContent;
    clearTimeout(copyFeedbackTimers.get(button));
    target.textContent = label;
    copyFeedbackTimers.set(button, setTimeout(() => { target.textContent = target.dataset.originalLabel; }, COPY_FEEDBACK_MS));
  }

  function reportError(error, fallback) {
    const entry = { time: new Date().toISOString(), kind: 'error', level: 'error', message: error?.message || fallback };
    renderConsole([entry, ...consoleEntries]);
    const toast = document.createElement('div');
    toast.className = 'toast is-visible'; toast.textContent = entry.message;
    document.querySelector('#toast-container').append(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function connectionPrompt() {
    return [
      'Connect to my running Browser-use Desktop app through Streamable HTTP MCP.',
      `MCP endpoint: ${mcpStatus.endpoint}`,
      `Bootstrap header: X-Browser-Use-Pairing-Code: ${pairingCode}`,
      `This pairing offer ${expiryLabel(pairingCodeExpiresAt)}.`,
      'Initialize MCP with that header. Retain the returned Mcp-Session-Id header for subsequent requests, and send notifications/initialized.',
      'Call browser_get_tabs, then browser_bind_tab with the tab I select before calling tab-scoped tools.',
      'All Desktop MCP tools are available after pairing. Follow the current control mode and use the existing run and tab instead of creating duplicates.',
      'If initialization is interrupted, retry with this bootstrap header during its remaining lifetime. Recover the same session, do not invent a bearer credential or expose a debugging port.'
    ].join('\n');
  }

  function connectionSnippet() {
    if (!mcpStatus.endpoint) return 'Starting local MCP service...';
    return pairingCode ? connectionPrompt() : `MCP endpoint: ${mcpStatus.endpoint}\nCopy connection generates the complete agent prompt.`;
  }

  function expiryLabel(expiresAt) {
    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) return 'expired';
    const minutes = Math.max(1, Math.round(remainingMs / 60_000));
    if (minutes >= 1440) return `expires on ${new Date(expiresAt).toLocaleDateString()}`;
    if (minutes >= 60) return `expires in ${Math.round(minutes / 60)} hours`;
    return `expires in ${minutes} min`;
  }

  function sessionCard(session) {
    const card = document.createElement('article');
    card.className = 'mcp-session';
    const heading = document.createElement('div');
    const host = document.createElement('strong');
    host.textContent = session.host?.version ? `${session.host.name} ${session.host.version}` : session.host?.name || 'Paired host';
    const revoke = document.createElement('button');
    revoke.className = 'plain-button is-danger';
    revoke.type = 'button';
    revoke.dataset.revoke = session.id;
    revoke.textContent = 'Revoke';
    heading.append(host, revoke);

    const detail = document.createElement('small');
    detail.textContent = `${session.tabId ? `Bound tab: ${session.tabId}` : 'No tab bound yet'} · ${expiryLabel(session.expiresAt)}`;

    const access = document.createElement('small');
    access.textContent = 'Full MCP access';

    card.append(heading, detail, access);
    return card;
  }

  function renderMcp(status) {
    if (status?.mcpControlMode && mcpControlMode && document.activeElement !== mcpControlMode) mcpControlMode.value = status.mcpControlMode;
    mcpStatus = { ...mcpStatus, ...status };
    const isPairing = Boolean(mcpStatus.pairing?.active);
    const activeExpiry = Number(mcpStatus.pairing?.expiresAt) || 0;
    if (mcpListeningChip) {
      mcpListeningChip.textContent = mcpStatus.listening ? 'Listening' : 'Offline';
      mcpListeningChip.classList.toggle('settings-status-chip-muted', !mcpStatus.listening);
    }
    if (mcpPairingState) {
      const sessionCount = Array.isArray(mcpStatus.sessions) ? mcpStatus.sessions.length : 0;
      mcpPairingState.textContent = isPairing ? 'Offer active' : sessionCount ? `${sessionCount} host${sessionCount === 1 ? '' : 's'}` : 'Not paired';
      mcpPairingState.classList.toggle('settings-status-chip-muted', !isPairing && !sessionCount);
    }
    if (!isPairing || (pairingCode && pairingCodeExpiresAt !== activeExpiry)) {
      pairingCode = '';
      pairingCodeExpiresAt = 0;
    }
    if (mcpCommand) mcpCommand.textContent = connectionSnippet();
    if (copyMcp) copyMcp.disabled = !mcpStatus.listening;
    if (copyClaudeCodeMcp) copyClaudeCodeMcp.disabled = !mcpStatus.listening;
    if (createPairing) {
      createPairing.disabled = !mcpStatus.listening;
      createPairing.querySelector('span').textContent = isPairing ? 'Replace pairing' : 'New pairing';
    }

    if (mcpNote) {
      if (!mcpStatus.listening) mcpNote.textContent = 'The local MCP service is not listening yet.';
      else if (isPairing && pairingCode) mcpNote.textContent = `Connection ready, ${expiryLabel(mcpStatus.pairing.expiresAt)}.`;
      else if (isPairing) mcpNote.textContent = 'Copy connection creates a fresh agent prompt.';
      else mcpNote.textContent = 'Copy the connection prompt into your agent.';
    }

    if (gptOpenApiUrl) gptOpenApiUrl.textContent = mcpStatus.gptOpenApiEndpoint || 'Disabled, enable and save settings.';
    if (gptApiKey) gptApiKey.textContent = mcpStatus.gptApiKey || 'Disabled';
    if (gptActionSchema) gptActionSchema.textContent = mcpStatus.gptActionSchema ? JSON.stringify(mcpStatus.gptActionSchema, null, 2) : 'Disabled';
    if (copyGptOpenApi) copyGptOpenApi.disabled = !mcpStatus.gptOpenApiEndpoint;
    if (copyGptKey) copyGptKey.disabled = !mcpStatus.gptApiKey;
    if (copyGptSchema) copyGptSchema.disabled = !mcpStatus.gptActionSchema;

    const sessions = mcpStatus.sessions || [];
    if (mcpSessions) mcpSessions.replaceChildren(...(sessions.length ? sessions.map(sessionCard) : [emptySessions()]));
  }

  function emptySessions() {
    const empty = document.createElement('p');
    empty.className = 'drawer-empty';
    empty.textContent = 'No MCP host is paired with this Browser-use instance.';
    return empty;
  }

  createPairing?.addEventListener('click', async () => {
    try {
      const offer = await window.browserUseDesktop.createPairingOffer();
      pairingCode = offer.pairingCode;
      pairingCodeExpiresAt = offer.expiresAt;
      renderMcp({ endpoint: offer.endpoint, pairingEndpoint: offer.pairingEndpoint, pairing: { active: true, expiresAt: offer.expiresAt } });
    } catch (e) { console.error(e); }
  });

  mcpSessions?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-revoke]');
    if (!button) return;
    try {
      await window.browserUseDesktop.revokeMcpSession(button.dataset.revoke);
      renderMcp(await window.browserUseDesktop.desktopMcpStatus());
    } catch (error) { reportError(error, 'Could not revoke the MCP session.'); }
  });

  function setConnectionModeTab() {
    modeTabGlobal?.classList.add('is-active');
    if (globalMcpPanel) globalMcpPanel.hidden = false;
  }

  modeTabGlobal?.addEventListener('click', async () => {
    setConnectionModeTab('secure');
    try { await window.browserUseDesktop.saveSettings({ connectionMode: 'secure' }); }
    catch (error) { reportError(error, 'Could not save Global / Remote mode.'); }
  });

  copyClaudeCodeMcp?.addEventListener('click', async () => {
    try {
      const offer = await window.browserUseDesktop.createPairingOffer();
      pairingCode = offer.pairingCode;
      pairingCodeExpiresAt = offer.expiresAt;
      renderMcp({ endpoint: offer.endpoint, pairingEndpoint: offer.pairingEndpoint, pairing: { active: true, expiresAt: offer.expiresAt } });
      await window.browserUseDesktop.copyText(offer.claudeCodeCommand);
      flashLabel(copyClaudeCodeMcp, 'Copied', 'Claude Code MCP');
      if (mcpNote) mcpNote.textContent = 'Claude Code command copied. Run it once, then use /mcp to confirm it is connected. New Claude sessions request a fresh pairing code automatically.';
    } catch (error) {
      reportError(error, 'Could not copy the Claude Code MCP command.');
    }
  });

  copyMcp?.addEventListener('click', async () => {
    try {
      copyMcp.disabled = true;
      if (!pairingCode || pairingCodeExpiresAt <= Date.now()) {
        const offer = await window.browserUseDesktop.createPairingOffer();
        pairingCode = offer.pairingCode;
        pairingCodeExpiresAt = offer.expiresAt;
        renderMcp({ ...offer, pairing: { active: true, expiresAt: offer.expiresAt } });
      }
      await window.browserUseDesktop.copyText(connectionPrompt());
      flashLabel(copyMcp, 'Copied');
      mcpNote.textContent = 'Agent prompt copied. Paste it into your MCP-capable agent.';
    } catch (error) { reportError(error, 'Could not copy the connection prompt.'); }
    finally { copyMcp.disabled = !mcpStatus.listening; }
  });

  copyGptOpenApi?.addEventListener('click', async () => {
    try {
      await window.browserUseDesktop.copyText(gptOpenApiUrl.textContent);
      flashLabel(copyGptOpenApi, 'Copied');
    } catch (error) { reportError(error, 'Could not copy the OpenAPI URL.'); }
  });

  copyGptKey?.addEventListener('click', async () => {
    try {
      await window.browserUseDesktop.copyText(gptApiKey.textContent);
      flashLabel(copyGptKey, 'Copied');
    } catch (error) { reportError(error, 'Could not copy the API key.'); }
  });

  copyGptSchema?.addEventListener('click', async () => {
    try {
      await window.browserUseDesktop.copyText(gptActionSchema.textContent);
      flashLabel(copyGptSchema, 'Copied');
    } catch (error) { reportError(error, 'Could not copy the Action setup.'); }
  });

  gptActionPublicOrigin?.addEventListener('input', markSettingsDirty);
  gptActionEnabled?.addEventListener('change', markSettingsDirty);
  mcpControlMode?.addEventListener('change', async () => {
    try {
      const saved = await window.browserUseDesktop.saveSettings({ mcpControlMode: mcpControlMode.value });
      if (!settingsDirty) setSettingsSaveState('saved', 'Saved');
      if (saved?.mcpControlMode && mcpControlMode) mcpControlMode.value = saved.mcpControlMode;
    } catch (error) {
      setSettingsSaveState('error', 'Error');
      reportError(error, 'Could not change control mode.');
      renderMcp(await window.browserUseDesktop.desktopMcpStatus());
    }
  });
  openDevTools?.addEventListener('click', () => window.browserUseDesktop.toggleDevTools());
  settingsForm?.addEventListener('invalid', event => {
    const section = event.target.closest('[data-settings-panel]');
    if (section) setSettingsSection(section.dataset.settingsPanel);
  }, true);
  settingsForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = saveSettingsButton;
    if (saveButton.disabled) return;
    saveButton.disabled = true;
    setSettingsSaveState('saving', 'Saving');
    try {
      const connectionMode = 'secure';
      const saved = await window.browserUseDesktop.saveSettings({
        mcpControlMode: mcpControlMode.value,
        gptActionEnabled: gptActionEnabled.checked,
        gptActionPublicOrigin: gptActionPublicOrigin?.value,
        connectionMode
      });
      if (gptActionPublicOrigin) gptActionPublicOrigin.value = saved.gptActionPublicOrigin || gptActionPublicOrigin.value;
      settingsDirty = false;
      setSettingsSaveState('saved', 'Saved');
      renderMcp(await window.browserUseDesktop.desktopMcpStatus());
      flashLabel(saveButton, 'Saved', '<i class="ph ph-check" aria-hidden="true"></i><span>Save settings</span>');
    } catch (e) {
      setSettingsSaveState('error', e?.message || 'Could not save changes.');
      reportError(e, 'Could not save settings.');
    } finally { saveButton.disabled = false; }
  });

  // The overlay is a separate BrowserView, so the main renderer's state event
  // is not broadcast here. It receives an explicit overlay snapshot from the
  // main process whenever a drawer or device menu changes.
  window.browserUseDesktop.onOverlayState(renderState);
  window.browserUseDesktop.onState(renderState);
  window.browserUseDesktop.onConsole(renderConsole);
  window.browserUseDesktop.onMcpState(renderMcp);
  window.browserUseDesktop.onPreview(renderPreview);

  Promise.all([
    window.browserUseDesktop.state(),
    window.browserUseDesktop.settings(),
    window.browserUseDesktop.consoleEntries(),
    window.browserUseDesktop.desktopMcpStatus()
  ]).then(([initialState, currentSettings, entries, status]) => {
    if (mcpControlMode) mcpControlMode.value = currentSettings.mcpControlMode || 'browser';
    if (gptActionEnabled) gptActionEnabled.checked = currentSettings.gptActionEnabled;
    if (gptActionPublicOrigin) gptActionPublicOrigin.value = currentSettings.gptActionPublicOrigin || '';
    setSettingsSaveState('saved', 'Saved');
    setSettingsSection('mcp');
    setConnectionModeTab(currentSettings.connectionMode || 'secure');
    renderState(initialState);
    renderConsole(entries);
    renderMcp(status);
  }).catch((err) => console.error(err));
})();
