'use strict';

// GUARDS (packages/guard):
// ADVISORY FIRST. Guards observe tool activity and inject SOURCED context
// messages that nudge the model; they never veto or rewrite calls. The only
// hard deny in this harness is the approval gate (unchanged policy).

const crypto = require('node:crypto');

// Canonicalize arguments: deep key-sort + stringify (repeat-tool-reminder).
function canonicalArgs(args) {
  if (args === null || typeof args !== 'object') return JSON.stringify(args ?? null);
  const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => { acc[key] = sorted(value[key]); return acc; }, {});
    }
    return value;
  };
  return JSON.stringify(sorted(args));
}

// Repeat-call detector: identical consecutive calls to the same tool escalate
// through thresholds [3, 5, 8] with a gentle → detailed sourced reminder.
// Sourcing is load-bearing: an unlabeled injection would render as a plain
// user turn in derived history.
const REMINDER_THRESHOLDS = [3, 5, 8];

const GENTLE_REMINDER = 'You are repeating the exact same tool call with identical arguments. '
  + 'Carefully analyze the previous result before calling again: if the task is not complete, '
  + 'try a different approach or different arguments instead of repeating the call.';

function detailedReminder(tool, count, argsPreview) {
  return `You have now issued the identical ${tool} call ${count} times in a row with arguments ${argsPreview}. `
    + 'The harness will keep executing it, but repeating an action that returns the same evidence is not progress. '
    + 'Re-derive the target from a fresh observation, change the approach, or report the concrete blocker.';
}

function argsPreviewOf(args, cap = 500) {
  let text;
  try { text = JSON.stringify(args ?? {}); } catch { text = String(args); }
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

class RepeatCallGuard {
  constructor({ thresholds = REMINDER_THRESHOLDS, previewChars = 500 } = {}) {
    this.thresholds = thresholds;
    this.previewChars = previewChars;
    this.streak = null; // { tool, hash, count }
  }

  // observe(toolName, args) → advisory notice string | null
  observe(toolName, args) {
    const hash = crypto.createHash('sha256').update(`${toolName}\u0000${canonicalArgs(args)}`).digest('hex').slice(0, 16);
    if (this.streak && this.streak.tool === toolName && this.streak.hash === hash) {
      this.streak.count += 1;
    } else {
      this.streak = { tool: toolName, hash, count: 1 };
      return null;
    }
    const reached = this.thresholds.filter(t => this.streak.count === t);
    if (!reached.length) return null;
    const count = this.streak.count;
    if (count === this.thresholds[0]) return { id: `guard.repeat.${count}`, source: 'guard:repeat-call', text: GENTLE_REMINDER };
    return {
      id: `guard.repeat.${count}`,
      source: 'guard:repeat-call',
      text: detailedReminder(toolName, count, argsPreviewOf(args, this.previewChars))
    };
  }

  // A DIFFERENT call resets the streak.
  reset() { this.streak = null; }
}

// Timeout policy: cooperative deadline around a tool body. On expiry the
// result is replaced with a structured TOOL_TIMEOUT error the model can route
// on — the promise is never abandoned silently.
function withToolTimeout(promiseFactory, { timeoutMs, label, onTimedOut = null } = {}) {
  const budget = Number(timeoutMs) > 0 ? Number(timeoutMs) : 0;
  if (!budget) return Promise.resolve().then(promiseFactory);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (typeof onTimedOut === 'function') { try { onTimedOut(); } catch { /* advisory only */ } }
      resolve({
        isError: true,
        error: { message: `Tool call timed out after ${budget}ms${label ? `: ${label}` : ''}.`, info: { name: 'ToolTimeout', code: 'TOOL_TIMEOUT' } }
      });
    }, budget);
    Promise.resolve()
      .then(promiseFactory)
      .then(
        value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
        error => { if (!settled) { settled = true; clearTimeout(timer); resolve({ isError: true, error: { message: error?.message || String(error), info: { name: error?.name || 'Error', code: error?.code || 'UNKNOWN' } } }); } }
      );
  });
}

module.exports = { canonicalArgs, REMINDER_THRESHOLDS, GENTLE_REMINDER, RepeatCallGuard, withToolTimeout };
