'use strict';

// FAILURE REPORT — the one place that turns a provider/run failure into
// something a human can act on.
//
// The incident this fixes: a rate-limited or rejected provider ended the run
// with NO transcript output at all. `parkRun()` published `run.escalated`,
// which the renderer never handled, and `run.cancelled` only settled the
// thinking card. The user saw the spinner stop, assumed the agent ignored
// them, and re-sent the message — three times. A failure that the provider
// explained in its own words must never be silent, and those words must never
// be paraphrased away: the raw text is what makes a rate limit distinguishable
// from a bad key or an oversized context.
//
// Classification is message-based because the providers do not attach an HTTP
// status to the error object (they throw `new Error(bodyText)`), which is also
// why `providers/retry.cjs` classifies the same way. The two are deliberately
// consistent: whatever `isTransportError` retries, this module explains.

const KIND = Object.freeze({
  RATE_LIMIT: 'rate_limit',
  AUTH: 'auth',
  BILLING: 'billing',
  CONTEXT_OVERFLOW: 'context_overflow',
  MODEL_UNAVAILABLE: 'model_unavailable',
  NETWORK: 'network',
  TIMEOUT: 'timeout',
  SERVER: 'server',
  WATCHDOG: 'watchdog',
  CANCELLED: 'cancelled',
  INTERNAL: 'internal',
  UNKNOWN: 'unknown'
});

// Short labels. These are the heading of the card, so they name the CAUSE, not
// the symptom: "Provider rate limit", never "Something went wrong".
const TITLES = Object.freeze({
  [KIND.RATE_LIMIT]: 'Provider rate limit',
  [KIND.AUTH]: 'Provider rejected the credentials',
  [KIND.BILLING]: 'Provider account needs attention',
  [KIND.CONTEXT_OVERFLOW]: 'Request exceeded the model context',
  [KIND.MODEL_UNAVAILABLE]: 'Model unavailable',
  [KIND.NETWORK]: 'Could not reach the provider',
  [KIND.TIMEOUT]: 'Provider timed out',
  [KIND.SERVER]: 'Provider server error',
  [KIND.WATCHDOG]: 'Model stopped responding',
  [KIND.CANCELLED]: 'Run cancelled',
  [KIND.INTERNAL]: 'Agent internal error',
  [KIND.UNKNOWN]: 'Run stopped'
});

// The provider's own words, made safe to render: one line, bounded, and never
// empty. A stack trace is not a message — take the first meaningful line.
function providerText(error) {
  const seen = new Set();
  let current = error;
  let best = '';
  // Walk `.cause` chains: providers wrap ("fetch failed" -> ECONNREFUSED), and
  // the inner error is usually the specific one.
  while (current && !seen.has(current) && seen.size < 6) {
    seen.add(current);
    const raw = typeof current === 'string' ? current : current?.message;
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    // Prefer a line that carries a status or a provider phrase over a bare
    // "fetch failed"; fall back to the first non-empty text.
    if (text && (looksInformative(text) || !best)) best = text;
    if (text && looksInformative(text)) break;
    current = typeof current === 'object' ? current?.cause : null;
  }
  return best.replace(/^error:\s*/i, '').slice(0, 600);
}

// A message is informative when it names a status or a provider concept; those
// are the lines worth showing instead of a generic transport wrapper.
function looksInformative(text) {
  return /\b(?:4\d\d|5\d\d)\b|rate.?limit|quota|token|context|model|key|billing|credit|payment|unauthori|forbidden|overloaded|capacity/i.test(text);
}

function retryAfterMs(text) {
  const source = String(text || '');
  const header = source.match(/retry[- ]after\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)?/i);
  if (!header) {
    const phrase = source.match(/(?:try|retry|again)\s+(?:again\s+)?in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds|m|min|mins|minutes)/i);
    if (!phrase) return null;
    return toMs(phrase[1], phrase[2]);
  }
  return toMs(header[1], header[2]);
}

function toMs(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  const normalized = String(unit || 's').toLowerCase();
  if (normalized === 'ms') return Math.round(amount);
  if (normalized.startsWith('m')) return Math.round(amount * 60_000);
  return Math.round(amount * 1000);
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  const minutes = Math.round(value / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

// Classify one failure. `context` may carry { model, phase, attempts, budgetMs }.
function classifyProviderFailure(error, context = {}) {
  const text = providerText(error);
  const normalized = text.toLowerCase();
  const code = String(error?.code || '');
  const model = String(context.model || '').trim();
  const where = model ? ` (${model})` : '';

  // Explicit codes win: they are set by the harness itself, not sniffed.
  if (code === 'DECISION_WATCHDOG' || /decision watchdog/i.test(text)) {
    return report(KIND.WATCHDOG, {
      text,
      body: `The model${where} produced no activity for the whole watchdog window, twice in a row. The run is parked with its state and objective intact — nothing was lost.`,
      nextStep: 'Resume to continue from the same step, or switch to a faster model if this repeats.',
      retryable: true
    });
  }
  if (code === 'REASONING_BUDGET_EXPIRED') {
    return report(KIND.TIMEOUT, {
      text,
      body: `The reasoning budget for this decision expired before the model returned an action${where ? ` ${where}` : ''}.`,
      nextStep: 'Lower the effort tier, or resume — the run continues from preserved state.',
      retryable: true
    });
  }
  if (code === 'CONTEXT_BUDGET_BLOCKED' || /context (?:length|window|budget)|maximum context|prompt is too long|request too large|too many tokens|413|token limit/i.test(normalized)) {
    return report(KIND.CONTEXT_OVERFLOW, {
      text,
      body: 'The request was larger than the model will accept, so the provider rejected it before answering.',
      nextStep: 'Start a new chat for this task, or compact the conversation — the run cannot shrink enough on its own.',
      retryable: false
    });
  }
  if (/\b429\b|rate.?limit|too many requests|quota exceeded|capacity right now|overloaded|at capacity/i.test(normalized)) {
    const after = retryAfterMs(text);
    return report(KIND.RATE_LIMIT, {
      text,
      body: `The provider is rate-limiting this account${where}. This is a throughput limit, not a fault in the task — the work already done is preserved.`,
      nextStep: after
        ? `Wait about ${formatDuration(after)} and resume, or switch model/provider.`
        : 'Wait a moment and resume, or switch model/provider to keep working now.',
      retryable: true,
      retryAfterMs: after
    });
  }
  if (/\b402\b|payment|past due|billing|insufficient (?:quota|credits|balance|wallet)|credit balance/i.test(normalized)) {
    return report(KIND.BILLING, {
      text,
      body: 'The provider account cannot serve this request until billing is settled.',
      nextStep: 'Top up or update billing for that provider, or choose another configured connection, then resume.',
      retryable: false
    });
  }
  if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|api key|credential/i.test(normalized)) {
    return report(KIND.AUTH, {
      text,
      body: 'The provider rejected the credential for this connection.',
      nextStep: 'Update the API key in chat settings, or switch to another configured connection, then resume.',
      retryable: false
    });
  }
  if (/(?:unknown|unsupported|invalid|no such)\s+model|model\s*[`'"]?[\w.:/-]{0,48}[`'"]?\s+(?:does not exist|not found|is unavailable|unavailable|is not supported)/i.test(normalized)) {
    return report(KIND.MODEL_UNAVAILABLE, {
      text,
      body: `The selected model${where} is not available from this provider right now.`,
      nextStep: 'Refresh the provider model list, pick an available model, then resume.',
      retryable: false
    });
  }
  if (/fetch failed|econn|epipe|ehostunreach|enetunreach|eai_again|dns|socket|network|reset by peer|connection (?:refused|reset|closed|error|interrupted)|unreachable|certificate|tls|ssl/i.test(normalized)) {
    return report(KIND.NETWORK, {
      text,
      body: `The request never reached the provider${where} — this is a connection problem, not a rejected request.`,
      nextStep: 'Check the connection or proxy, then resume; the run continues from the same step.',
      retryable: true
    });
  }
  if (/timed? ?out|timeout|etimedout|deadline exceeded|took too long/i.test(normalized)) {
    return report(KIND.TIMEOUT, {
      text,
      body: `The provider${where} did not answer within the deadline.`,
      nextStep: 'Resume to retry this step; if it keeps timing out, switch to a faster model.',
      retryable: true
    });
  }
  if (/\b5\d\d\b|internal server error|bad gateway|gateway time|service unavailable|server error/i.test(normalized)) {
    return report(KIND.SERVER, {
      text,
      body: `The provider${where} returned a server error. Nothing about the task caused it.`,
      nextStep: 'Resume in a moment — this usually clears on its own.',
      retryable: true
    });
  }
  return report(KIND.UNKNOWN, {
    text,
    body: `The run stopped on an unclassified failure${where}. The text below is exactly what the provider or runtime returned.`,
    nextStep: 'Resume to retry the step. If it repeats, the text below is what to report.',
    retryable: true
  });
}

function report(kind, { text = '', body = '', nextStep = '', retryable = false, retryAfterMs: after = null, title = null } = {}) {
  return {
    kind,
    title: title || TITLES[kind] || TITLES[KIND.UNKNOWN],
    body: String(body || '').replace(/\s+/g, ' ').trim(),
    providerText: String(text || '').slice(0, 600),
    nextStep: String(nextStep || '').replace(/\s+/g, ' ').trim(),
    retryable: retryable === true,
    retryAfterMs: Number.isFinite(after) ? after : null
  };
}

// The single string a transcript card renders. Kept here (not in the renderer)
// so the CLI, the console and the chat all say the same thing.
function formatFailureReport(entry) {
  if (!entry) return '';
  const lines = [];
  if (entry.body) lines.push(entry.body);
  if (entry.providerText) lines.push(`Provider said: “${entry.providerText}”`);
  if (entry.nextStep) lines.push(entry.nextStep);
  return lines.join('\n\n');
}

// A parked run is not a failure the user caused, and it is NOT over — recovery
// reschedules it. The wording must say so, or the user will re-send the task.
function describeParkedRun(run, reason, context = {}) {
  const error = context.error || (reason ? new Error(String(reason)) : null);
  const classified = error ? classifyProviderFailure(error, { model: run?.provider?.model, ...context }) : null;
  if (classified && classified.kind !== KIND.UNKNOWN) {
    return { ...classified, parked: true, resumeNote: 'The run is parked, not finished — recovery resumes it automatically.' };
  }
  const text = String(reason || '').replace(/\s+/g, ' ').trim();
  return {
    ...report(KIND.UNKNOWN, {
      text,
      body: text || 'The run was parked to protect its state.',
      nextStep: 'Recovery resumes automatically; a message from you retargets the run immediately.',
      retryable: true
    }),
    parked: true,
    resumeNote: 'The run is parked, not finished — recovery resumes it automatically.'
  };
}

module.exports = {
  KIND,
  TITLES,
  providerText,
  retryAfterMs,
  formatDuration,
  classifyProviderFailure,
  describeParkedRun,
  formatFailureReport
};
