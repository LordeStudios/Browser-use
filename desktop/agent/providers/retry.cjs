'use strict';

// Provider/API retry policy. Retry only transport failures that produced no
// decision or action. Hard provider errors remain terminal. Deterministic
// browser results never enter this retry ladder.
//
// A RISING ladder (5s -> 15s -> 30s -> 1m -> 2m -> 4m): a transport hiccup
// ("fetch failed") must not burn the whole retry budget in three seconds and
// end the chat. The 1s/2s/4s ladder gave up before the network could recover;
// attempts past the ladder keep waiting at the top of the ramp rather than
// failing faster.

const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000, 30_000, 60_000, 120_000, 240_000]);
const PROVIDER_MAX_RETRIES = RETRY_DELAYS_MS.length;
const PROVIDER_RETRY_BUDGET_MS = RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0);
const MAX_RETRY_DELAY_MS = 240_000;

function retryDelayMs(attempt) {
  const index = Math.max(0, Number(attempt) - 1);
  if (!Number.isFinite(index) || index >= RETRY_DELAYS_MS.length) return MAX_RETRY_DELAY_MS;
  return Math.min(RETRY_DELAYS_MS[index], MAX_RETRY_DELAY_MS);
}

// A failed MODEL DECISION that is the network's fault, not the model's:
// transport faults, timeouts, rate limits and transient server errors.
// Auth/billing/model-unavailable blocks are classified as hard errors and
// never reach this check (permanent failures must fail fast, not back off).
function isTransportError(error) {
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').toLowerCase();
  if (!message) return false;
  // Auth and billing are permanent — never back off on them. A model that
  // "does not exist" is NOT: a flaky gateway reports exactly that during
  // capacity blips while the model is in its own roster, so it rides the
  // bounded retry ladder like any other transient.
  if (/\b(?:401|403|402|billing|credit|api key|invalid api key|unauthorized|forbidden)\b/.test(message)) return false;
  return /fetch failed|econn|epipe|ehostunreach|enetunreach|etimedout|eai_again|dns|socket|network|reset by peer|connection (?:refused|reset|closed|error|interrupted)|timed? ?out|timeout|temporarily|unreachable|aborted connection|429|rate.?limit|overloaded|bad gateway|service unavailable|internal server error|gateway time|\b5\d\d\b|request failed \((?:404|408|409|425|429|5\d\d)\)|at capacity|capacity right now|retry shortly|unknown model|model not found|does not exist|no such model|model.{0,20}unavailable/.test(message);
}

// The permanent provider blocks. These must surface as an honest run failure
// with user guidance, never as a retry or a recovery cycle.
function isHardProviderError(error) {
  // NATIVE_VISION_UNAVAILABLE kept as hard (no retry) for backward compat
  // with persisted checkpoints, but the provider no longer throws it —
  // vision degradation is handled internally with a text-only fallback.
  if (['NATIVE_VISION_UNAVAILABLE', 'PROVIDER_PROTOCOL_UNSUPPORTED', 'CONTEXT_BUDGET_BLOCKED'].includes(error?.code)) return true;
  const message = String(error?.message || error || '').replace(/\s+/g, ' ').toLowerCase();
  if (!message) return false;
  return /\b(?:401|402|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|authentication|payment|past due|billing|insufficient (?:quota|credits)|account (?:disabled|suspended)/.test(message);
}

function pauseForRetry(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new Error('Retry cancelled.')); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', abort);
      resolve();
    }, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('Retry cancelled.')); };
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

// Run one provider decision request under the Cline discipline. `request`
// receives the 1-based attempt number. Retries happen only while the failure
// is transport-class (nothing was emitted and executed); hard provider errors
// and model errors rethrow immediately for the caller's own handling.
async function retryProviderTurn(request, { signal, onRetry, maxRetries = PROVIDER_MAX_RETRIES } = {}) {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await request(attempt);
    } catch (error) {
      const retriesLeft = maxRetries - (attempt - 1);
      const retryable = !signal?.aborted && retriesLeft > 0 && isTransportError(error) && !isHardProviderError(error);
      if (!retryable) throw error;
      const delayMs = retryDelayMs(attempt);
      onRetry?.({ attempt, maxRetries, retriesLeft, delayMs, error });
      await pauseForRetry(delayMs, signal);
    }
  }
}

// Scheduled-job dispatch retries are a different contract from in-run turn
// retries: an occurrence that could not run (provider down at 03:00) retries
// later on a bounded ladder and then reports honest exhaustion. Bounded, so a
// permanently broken configuration can never spin forever.
const SCHEDULE_RETRY_DELAYS_MS = Object.freeze([60_000, 300_000, 900_000]);

module.exports = {
  PROVIDER_MAX_RETRIES,
  RETRY_DELAYS_MS,
  MAX_RETRY_DELAY_MS,
  SCHEDULE_RETRY_DELAYS_MS,
  PROVIDER_RETRY_BUDGET_MS,
  retryDelayMs,
  isTransportError,
  isHardProviderError,
  pauseForRetry,
  retryProviderTurn
};
