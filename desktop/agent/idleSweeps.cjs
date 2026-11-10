'use strict';

// LORDE_IDLE_SWEEPS_V366 — pure decision rules for the two automatic hygiene
// sweeps, extracted so they are unit-testable without an Electron runtime.
// main.cjs wires the real dependencies (spawnRegistry, tabs, subagentApi.close,
// closeTab) and owns the 60s interval that calls these helpers.

/**
 * Aliases of resident subagents whose last activity is older than `idleMs`.
 * A record without a usable lastActivityAt counts as "active at `now`" so a
 * freshly spawned or legacy record is never swept on its first pass.
 */
function computeIdleSubagentCloses(registry, { now = Date.now(), idleMs = 20 * 60 * 1000 } = {}) {
  const due = [];
  for (const record of [...registry.values()]) {
    if (!record || record.status !== 'resident') continue;
    const last = Number(record.lastActivityAt) || now;
    if (now - last > idleMs) due.push(record.alias);
  }
  return due;
}

/**
 * Ids of empty (about:blank) tabs that may be closed: not the user's selected
 * tab, not owned by any live/resident agent run or chat window, alive, and
 * untouched for longer than `idleMs`. Tab shape is supplied through getters so
 * the rules stay decoupled from Electron's BrowserView objects.
 */
function computeIdleEmptyTabCloses(tabs, {
  owned = new Set(),
  selectedTabId = '',
  now = Date.now(),
  idleMs = 3 * 60 * 1000,
  getTabId = (tab) => tab?.id,
  isTabAlive = () => true,
  isTabEmpty = () => true
} = {}) {
  const due = [];
  for (const tab of [...tabs.values()]) {
    const id = String(getTabId(tab) ?? '');
    if (!tab || !id) continue;
    if (id === String(selectedTabId)) continue;
    if (owned.has(id)) continue;
    if (!isTabAlive(tab)) continue;
    if (!isTabEmpty(tab)) continue;
    const last = Number(tab.lastTouched) || now;
    if (now - last > idleMs) due.push(id);
  }
  return due;
}

module.exports = { computeIdleSubagentCloses, computeIdleEmptyTabCloses };
