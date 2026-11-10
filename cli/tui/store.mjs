// cli/tui/store.mjs
//
// A tiny dependency-free observable store for the Ink TUI (the equivalent
// of qwen-code's UIStateContext: one state object the App subscribes to via
// useSyncExternalStore). Everything the old readline TUI printed to stdout
// now lands here as immutable history entries; the live-run section reads
// state.run.

let nextId = 1;

export function createTuiStore(initial = {}) {
  let state = { history: [], ...initial };
  const subscribers = new Set();
  // Coalesce bursts of trace updates into one Ink notification. The trace
  // tailer can publish tool/recovery/queue events in the same poll, and
  // notifying once per field made Ink compute several full-screen frames back
  // to back. A microtask preserves responsiveness while giving the renderer a
  // stable snapshot to paint.
  let emitQueued = false;

  function emit() {
    if (emitQueued) return;
    emitQueued = true;
    queueMicrotask(() => {
      emitQueued = false;
      for (const fn of subscribers) fn();
    });
  }

  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      if (!next || next === state) return;
      state = next;
      emit();
    },
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    }
  };
}

/**
 * Append an immutable entry to the history list. Shapes (rendered by
 * App.mjs HistoryItem):
 *   { kind: 'user',    text }                       — the echoed input line
 *   { kind: 'out',     text, tone }                 — plain output (tone: toneColor)
 *   { kind: 'runStart', name, pid, outDir }         — run header line
 *   { kind: 'runSummary', summary }                 — completion badge block
 *   { kind: 'tools',   calls }                      — tool-call digest rows
 *   { kind: 'banner',  lines }                      — (reserved; header is a live component)
 */
export function pushHistory(store, entry) {
  store.set((state) => ({
    ...state,
    history: [...state.history, { id: nextId++, ...entry }]
  }));
}

/** Static tail window used by /history-style digests and the live pane. */
export const LIVE_TOOL_LINES = 9;
