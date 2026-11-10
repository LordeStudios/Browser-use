// cli/tui/errorView.mjs
//
// Pure normalization for provider and run errors crossing the CLI trace. The
// desktop renderer receives both transient connection notices and terminal
// run events; keeping the extraction in one small helper gives the TUI the
// same error visibility without treating normal assistant text as a failure.

function compact(value, limit = 320) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, limit) : '';
}

/**
 * Return the user-facing error carried by one trace event, or an empty string.
 * Recovery state wins because it contains the provider's normalized error.
 * Transient assistant messages are the same live connection notices shown by
 * the desktop app. Terminal events use their result/error payloads.
 */
export function traceErrorForEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const type = String(event.type || '');
  if (type === 'assistant.message' && event.transient) {
    return compact(event.text) || compact(event.run?.recovery?.lastError);
  }

  // Recovery snapshots are attached to many lifecycle events, not only
  // assistant.message. Read them before the event-type switch so an error on a
  // thinking/escalation/timing event cannot disappear between polls.
  const recovery = compact(event.run?.recovery?.lastError);
  if (recovery) return recovery;

  if (type === 'run.failed' || type === 'run.escalated' || type === 'agent.recovery_waiting') {
    return compact(
      event.result?.summary
      || event.error
      || event.reason
      || event.run?.result?.summary
      || event.run?.escalation?.reason
      || event.run?.stopReason
    );
  }

  // A non-recoverable tool/provider failure can be the first useful signal
  // before the terminal event is written. Recoverable browser hiccups remain
  // internal agent control flow and should not make the TUI flash red.
  if (type === 'tool.result' && event.output?.ok === false && event.output?.recoverable !== true) {
    return compact(event.output?.error || event.output?.result?.error);
  }

  return '';
}
