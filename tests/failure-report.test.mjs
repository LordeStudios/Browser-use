import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyProviderFailure, describeParkedRun, formatFailureReport, retryAfterMs, KIND } =
  await import('../desktop/agent/failureReport.cjs');

// ── The incident ────────────────────────────────────────────────────────────
// A rate-limited provider ended the run with NO transcript output: parkRun
// published run.escalated, which no renderer handled. The user assumed the
// agent ignored them and re-sent the task. Every classification below must
// therefore (a) name the cause and (b) carry the provider's own words.

test('a 429 is classified as a rate limit and keeps the provider text', () => {
  const error = new Error('429 Too Many Requests: rate limit reached for gpt-x on requests per min');
  const report = classifyProviderFailure(error, { model: 'gpt-x' });
  assert.equal(report.kind, KIND.RATE_LIMIT);
  assert.equal(report.title, 'Provider rate limit');
  assert.match(report.providerText, /429 Too Many Requests/);
  assert.match(report.body, /rate-limiting/);
  assert.equal(report.retryable, true);
  // The model name must appear so the user knows which connection to switch.
  assert.match(report.body, /gpt-x/);
});

test('a rate limit with Retry-After states how long to wait', () => {
  const report = classifyProviderFailure(new Error('429 rate limit exceeded; retry after 45s'));
  assert.equal(report.kind, KIND.RATE_LIMIT);
  assert.equal(report.retryAfterMs, 45_000);
  assert.match(report.nextStep, /45s/);
});

test('a bare "try again in 30 seconds" is also understood', () => {
  assert.equal(retryAfterMs('rate limited, please try again in 30 seconds'), 30_000);
  assert.equal(retryAfterMs('Retry-After: 2'), 2_000);
  assert.equal(retryAfterMs('nothing here'), null);
});

test('auth, billing and model blocks are not described as retryable', () => {
  const auth = classifyProviderFailure(new Error('401 Unauthorized: invalid api key'));
  assert.equal(auth.kind, KIND.AUTH);
  assert.equal(auth.retryable, false);

  const billing = classifyProviderFailure(new Error('402 payment required: insufficient credits'));
  assert.equal(billing.kind, KIND.BILLING);
  assert.equal(billing.retryable, false);

  const model = classifyProviderFailure(new Error('The model `foo-9000` does not exist'));
  assert.equal(model.kind, KIND.MODEL_UNAVAILABLE);
  assert.equal(model.retryable, false);
});

test('an oversized request names the context, not a generic failure', () => {
  const report = classifyProviderFailure(new Error('400 Bad Request: maximum context length is 128000 tokens'));
  assert.equal(report.kind, KIND.CONTEXT_OVERFLOW);
  assert.match(report.nextStep, /new chat|compact/i);
});

test('a transport fault is a connection problem, not a rejected request', () => {
  const report = classifyProviderFailure(new Error('fetch failed'));
  assert.equal(report.kind, KIND.NETWORK);
  assert.match(report.body, /never reached the provider/);
  assert.equal(report.retryable, true);
});

test('a wrapped error reports the inner, specific line', () => {
  const inner = new Error('503 Service Unavailable: upstream capacity');
  const outer = new Error('provider request failed');
  outer.cause = inner;
  const report = classifyProviderFailure(outer);
  assert.equal(report.kind, KIND.SERVER);
  assert.match(report.providerText, /503/);
});

test('an unclassified failure still shows the raw text rather than inventing a cause', () => {
  const report = classifyProviderFailure(new Error('kaboom in the flux capacitor'));
  assert.equal(report.kind, KIND.UNKNOWN);
  assert.equal(report.providerText, 'kaboom in the flux capacitor');
  assert.match(report.body, /unclassified/i);
});

test('an empty error never produces an empty card', () => {
  for (const value of [null, undefined, new Error('')]) {
    const report = classifyProviderFailure(value);
    assert.ok(report.title, 'a title is always present');
    assert.ok(report.body, 'a body is always present');
    assert.ok(report.nextStep, 'a next step is always present');
  }
});

test('the formatted report always contains the provider sentence', () => {
  const text = formatFailureReport(classifyProviderFailure(new Error('429 slow down')));
  assert.match(text, /Provider said/);
  assert.match(text, /429 slow down/);
  assert.match(text, /\n\n/, 'paragraphs are separated so the card can breathe');
});

// ── Parked runs are NOT failures ────────────────────────────────────────────

test('a parked run says it is not finished and will resume', () => {
  const run = { provider: { model: 'gpt-x' } };
  const report = describeParkedRun(run, 'provider failed 3 consecutive decisions', { error: new Error('429 rate limit') });
  assert.equal(report.parked, true);
  assert.equal(report.kind, KIND.RATE_LIMIT);
  assert.match(report.resumeNote, /parked, not finished/);
});

test('a park with only a string reason still explains itself', () => {
  const report = describeParkedRun({}, 'watchdog fires: repeated over-budget deliberation');
  assert.equal(report.parked, true);
  assert.match(report.body, /watchdog fires/);
  assert.match(report.nextStep, /Resume|resumes/i);
});
