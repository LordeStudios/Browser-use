/* Shared, data-driven console and downloads UI for the native overlay. */
(() => {
  const levelOf = entry => typeof entry.level === 'string' ? entry.level : ['debug', 'info', 'warning', 'error'][Number(entry.level)] || (entry.kind === 'error' ? 'error' : 'info');
  const matchesFilter = (entry, filter) => filter === 'all' || entry.kind === filter || levelOf(entry) === filter;
  function field(tag, className, value) {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = String(value ?? '');
    return node;
  }
  function renderConsole(list, empty, entries, filter, tabs = []) {
    const visible = (entries || []).filter(entry => matchesFilter(entry, filter));
    empty.hidden = visible.length > 0;
    empty.textContent = filter === 'all' ? 'No console events yet.' : `No ${filter} events.`;
    list.replaceChildren(...visible.map(entry => {
      const level = levelOf(entry);
      const row = field('article', `console-entry is-${level} is-${entry.kind || 'console'}`, '');
      const meta = field('div', 'console-entry-meta', '');
      const time = field('time', 'console-time', new Date(entry.time).toLocaleTimeString());
      time.dateTime = entry.time || '';
      const tab = tabs.find(item => item.id === entry.tabId);
      meta.append(time, field('strong', 'console-level', level), field('span', 'console-source', entry.kind || 'console'), field('span', 'console-tab', tab?.title || entry.tabId || 'Application'));
      row.append(meta, field('p', 'console-message', entry.message));
      const source = entry.sourceId || entry.url;
      if (source) row.append(field('small', 'console-location', `${source}${entry.line ? `:${entry.line}` : ''}`));
      const request = [entry.method, entry.statusCode, entry.resourceType].filter(value => value != null && value !== '').join(' · ');
      if (request) row.append(field('small', 'console-request', request));
      return row;
    }));
  }
  function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MB`;
    return value >= 1024 ? `${Math.round(value / 1024)} KB` : `${value} B`;
  }
  function renderDownloads(panel, entries, api, reportError) {
    const heading = field('div', 'downloads-heading', '');
    heading.append(field('strong', '', 'Downloads'));
    const close = field('button', 'plain-button', 'Close');
    close.type = 'button';
    close.addEventListener('click', () => api.setDownloadsOpen(false).catch(error => reportError(error, 'Could not close downloads.')));
    heading.append(close);
    panel.replaceChildren(heading);
    if (!entries?.length) { panel.append(field('p', 'downloads-empty', 'No downloads yet.')); return; }
    for (const entry of entries) {
      const row = field('article', `download-row${entry.state === 'interrupted' ? ' is-interrupted' : ''}`, '');
      row.dataset.downloadId = entry.id;
      const name = field('strong', '', entry.filename);
      name.title = entry.filename;
      row.append(name);
      const label = entry.state === 'progressing' ? `${formatBytes(entry.receivedBytes)}${entry.totalBytes ? ` of ${formatBytes(entry.totalBytes)}` : ''}` : entry.state === 'completed' ? `Completed · ${formatBytes(entry.receivedBytes)}` : 'Interrupted';
      row.append(field('small', '', label));
      if (entry.state === 'progressing') {
        const progress = field('div', 'download-progress', '');
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-label', `Downloading ${entry.filename}`);
        if (entry.totalBytes > 0) {
          const percentage = Math.min(100, Math.round(entry.receivedBytes / entry.totalBytes * 100));
          progress.setAttribute('aria-valuenow', String(percentage));
          const fill = document.createElement('i'); fill.style.width = `${percentage}%`; progress.append(fill);
        } else { progress.classList.add('is-indeterminate'); progress.append(document.createElement('i')); }
        row.append(progress);
      }
      if (entry.state === 'completed') {
        const actions = field('div', 'download-actions', '');
        for (const [label, method] of [['Open', 'downloadsOpen'], ['Show in folder', 'downloadsShow']]) {
          const button = field('button', '', label); button.type = 'button';
          button.addEventListener('click', () => api[method](entry.id).catch(error => reportError(error, 'Could not open the download.')));
          actions.append(button);
        }
        row.append(actions);
      }
      panel.append(row);
    }
  }
  window.BrowserUseSurfaces = { renderConsole, renderDownloads, matchesFilter, levelOf };
})();
