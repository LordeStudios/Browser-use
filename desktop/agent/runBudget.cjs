'use strict';

// LORDE_DEADLINE_EXT_V1 — extended pattern catches "finish in 10s", "complete
// it in 30s", "within 5 secs", "under 2 minutes", "in 1 hour", "all changes
// have been applied so complete it in ledger", "answer within 30secs", etc.
const DEADLINE_PATTERN = /\b(?:within|under|in|finish(?:\s+it)?(?:\s+in)?|complete(?:\s+it)?(?:\s+in)?|done(?:\s+in)?|answer(?:\s+it)?(?:\s+in)?)\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b|hours?|hrs?|h\b)/i;
const UNIT_MS = Object.freeze({
  second: 1_000,
  seconds: 1_000,
  sec: 1_000,
  secs: 1_000,
  s: 1_000,
  minute: 60_000,
  minutes: 60_000,
  min: 60_000,
  mins: 60_000,
  m: 60_000,
  hour: 3_600_000,
  hours: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  h: 3_600_000
});
const MIN_DEADLINE_MS = 1_000;
const MAX_DEADLINE_MS = 24 * 60 * 60_000;

function parseTaskDeadlineMs(task) {
  const match = String(task || '').match(DEADLINE_PATTERN);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = UNIT_MS[String(match[2]).toLowerCase()];
  if (!Number.isFinite(value) || !unit) return null;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.round(value * unit)));
}

function normalizeRunBudgetMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_DEADLINE_MS, Math.max(MIN_DEADLINE_MS, Math.round(parsed)));
}

function deadlineAtForTurn({ task, explicitMs, turnStartedAt, previousDeadlineAt = null, sameTurn = false, now = Date.now() } = {}) {
  if (sameTurn && Number.isFinite(Number(previousDeadlineAt)) && Number(previousDeadlineAt) > 0) return Number(previousDeadlineAt);
  const budgetMs = normalizeRunBudgetMs(explicitMs) ?? parseTaskDeadlineMs(task);
  return budgetMs ? Number(turnStartedAt || now) + budgetMs : null;
}

function remainingRunMs(run, now = Date.now()) {
  const deadlineAt = Number(run?.deadlineAt);
  if (!Number.isFinite(deadlineAt) || deadlineAt <= 0) return null;
  return Math.max(0, deadlineAt - now);
}

module.exports = { parseTaskDeadlineMs, normalizeRunBudgetMs, deadlineAtForTurn, remainingRunMs, MIN_DEADLINE_MS, MAX_DEADLINE_MS };
