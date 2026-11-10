'use strict';

// RUNTIME CONTEXT (DSH pattern): volatile facts (current tab, URL, control
// mode, effort, deadlines) NEVER enter the cached system prompt. They ride a
// separate ordered snapshot delivered as a user-role message whose header
// states it supersedes earlier snapshots. The snapshot is only emitted when
// its text differs from the retained one.

const CONTEXT_ORDERS = Object.freeze({
  OBJECTIVE: 100,
  WORKING_CONTEXT: 110,
  OBSERVATION_STATE: 120,
  RUNTIME_POLICY: 130
});

const SNAPSHOT_HEADER = 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.';
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.';

class RuntimeContextBuilder {
  constructor() {
    this._entries = new Map(); // name -> { order, text }
  }

  // context({ name, order?, text | text(ctx) }) — re-registering shadows.
  context(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) {
      throw new Error('runtime context entry requires a non-empty name');
    }
    this._entries.set(spec.name, {
      name: spec.name,
      order: typeof spec.order === 'number' ? spec.order : CONTEXT_ORDERS.WORKING_CONTEXT,
      text: typeof spec.text === 'function' ? spec.text : (spec.text == null ? '' : String(spec.text))
    });
    return this;
  }

  // render(ctx) → snapshot text ('' when nothing registered has content).
  render(ctx = {}) {
    const parts = [];
    for (const entry of [...this._entries.values()].sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : 1))) {
      const text = (typeof entry.text === 'function' ? entry.text(ctx) : entry.text) || '';
      if (String(text).trim()) parts.push(String(text).trim());
    }
    return parts.join('\n');
  }
}

// Wrap body into the superseding snapshot message. Returns null when the body
// is empty AND there is no retained snapshot to clear (first turn with nothing
// to say does not need a message).
function snapshotMessage(body, previousBody) {
  const text = String(body || '').trim();
  if (!text) {
    return previousBody && previousBody.trim() ? { role: 'user', source: 'runtime-context', content: CLEARED, form: 'snapshot' } : null;
  }
  if (text === String(previousBody || '').trim()) return null; // unchanged → no message
  return { role: 'user', source: 'runtime-context', content: `${SNAPSHOT_HEADER}\n\n${text}`, form: 'snapshot' };
}

module.exports = { CONTEXT_ORDERS, RuntimeContextBuilder, snapshotMessage, SNAPSHOT_HEADER, CLEARED };
