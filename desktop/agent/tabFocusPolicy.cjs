'use strict';

// Foreground tab policy: the visible/active tab is user presentation state.
// An agent may switch it only while no OTHER live agent run owns tabs —
// otherwise the human's view and another agent's workspace would fight.
// Pure policy: no Electron imports, fully unit-testable.

const LIVE_STATUSES = new Set(['running', 'awaiting_approval', 'paused']);

function ownedTabsOf(instance) {
  const state = instance?.state?.();
  if (!state || !LIVE_STATUSES.has(state.status)) return [];
  return (Array.isArray(state.ownedTabIds) ? state.ownedTabIds : [])
    .map(tabId => String(tabId))
    .filter(Boolean);
}

/**
 * Decide whether `runId` may bring a tab to the foreground.
 * @param {Array} instances every live agent instance (including this run's).
 * @param {string} runId the requesting run's id.
 * @returns {{ allowed: true } | { allowed: false, owners: string[] }}
 */
function foregroundTabPermission(instances, runId) {
  const self = String(runId || '');
  const owners = [];
  for (const instance of Array.isArray(instances) ? instances : []) {
    const state = instance?.state?.();
    if (!state || String(state.id || '') === self) continue;
    const owned = ownedTabsOf(instance);
    if (owned.length) {
      owners.push(String(state.agentIdentity || state.title || 'another agent').slice(0, 80));
    }
  }
  return owners.length ? { allowed: false, owners: [...new Set(owners)] } : { allowed: true };
}

function foregroundTabBlockReason(permission) {
  if (!permission || permission.allowed !== false) return null;
  const owners = (permission.owners || []).join(', ');
  return `Foreground tab switching is disabled while another agent owns tabs (${owners}). Coordinate via agent_message, or keep controlling tabs in the background with tabId.`;
}

module.exports = { foregroundTabPermission, foregroundTabBlockReason, ownedTabsOf };
