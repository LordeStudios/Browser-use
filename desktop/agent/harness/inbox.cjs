'use strict';

// INBOX (agent-loop/src/inbox.ts):
// two queues drive what the loop works on.
//   next-turn  — queued user prompts; ONE consumed per turn (continuations)
//   next-step  — steering and injected input; claimed at every step boundary
// Every mutation is logged by the caller as a run event (durable in
// run.events / trace), and duplicate ids are rejected — a message is never
// pending twice.

function createInbox() {
  const state = { nextTurn: [], nextStep: [] };

  function assertNew(list, message) {
    const ids = new Set();
    for (const item of message) {
      const id = item?.id;
      if (id === undefined) continue;
      if (ids.has(id) || list.some(x => x?.id === id)) {
        throw new Error(`message "${id}" is already pending`);
      }
      ids.add(id);
    }
  }

  return {
    // append(target, items) — target 'next-turn' | 'next-step'
    append(target, items) {
      const list = state[target];
      if (!list) throw new Error(`unknown inbox target: ${target}`);
      const batch = Array.isArray(items) ? items : [items];
      assertNew(list, batch);
      list.push(...batch);
      return batch.length;
    },
    prepend(target, items) {
      const list = state[target];
      if (!list) throw new Error(`unknown inbox target: ${target}`);
      const batch = Array.isArray(items) ? items : [items];
      assertNew(list, batch);
      list.unshift(...batch);
      return batch.length;
    },
    // claim() → { nextStep, turn } — next-step steering first, then ONE
    // queued turn prompt (claim semantics).
    claim() {
      const nextStep = state.nextStep.splice(0);
      const turn = state.nextTurn.shift() || null;
      return { nextStep, turn };
    },
    remove(target, id) {
      const list = state[target];
      if (!list) return false;
      const index = list.findIndex(x => x?.id === id);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },
    clear(target) {
      const list = state[target];
      if (!list) return 0;
      const n = list.length;
      list.length = 0;
      return n;
    },
    size(target) { return state[target]?.length || 0; },
    peek(target) { return [...state[target]]; }
  };
}

module.exports = { createInbox };
