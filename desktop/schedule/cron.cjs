'use strict';

// Pure 5-field cron evaluation in local time. No timers, no state.
const SHORTCUTS = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *'
};
const FIELD_BOUNDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const DAY_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function parseField(raw, bounds) {
  const values = new Set();
  for (const part of String(raw).split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Cron step must be a positive integer: ${part}`);
    let start, end;
    const text = rangePart.trim().toLowerCase();
    if (text === '*' || text === '') { [start, end] = bounds; }
    else if (text.includes('-')) {
      const [a, b] = text.split('-').map(bound => parseValue(bound, bounds));
      start = a; end = b;
    } else {
      start = parseValue(text, bounds);
      end = stepPart === undefined ? start : bounds[1];
    }
    if (start < bounds[0] || end > bounds[1] || start > end) throw new Error(`Cron value out of range: ${part}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

function parseValue(text, bounds) {
  if (/^\d+$/.test(text)) return Number(text);
  if (bounds[1] === 6 && text in DAY_NAMES) return DAY_NAMES[text];
  throw new Error(`Invalid cron value: ${text}`);
}

function parse(expression) {
  const normalized = SHORTCUTS[String(expression || '').trim().toLowerCase()] || String(expression || '').trim();
  const fields = normalized.split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression needs exactly 5 fields: ${expression}`);
  const sets = fields.map((field, index) => parseField(field, FIELD_BOUNDS[index]));
  if (sets[3].size === 12) sets[3] = null; // unrestricted month
  const domRestricted = fields[2].trim() !== '*', dowRestricted = fields[4].trim() !== '*';
  return { expression: normalized, minute: sets[0], hour: sets[1], dom: domRestricted ? sets[2] : null, month: sets[3], dow: dowRestricted ? sets[4] : null };
}

function nextDue(expression, afterMs = Date.now(), now = ms => new Date(ms)) {
  const parsed = typeof expression === 'string' ? parse(expression) : expression;
  // Scan minute candidates from the next whole minute after afterMs.
  const start = now(afterMs);
  const candidate = new Date(start.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60 * 1000;
  for (let t = candidate.getTime(); t < limit; t += 60_000) {
    const d = now(t);
    if (parsed.month && !parsed.month.has(d.getMonth() + 1)) continue;
    // Vixie rule: when both dom and dow are restricted, either may match.
    if (parsed.dom || parsed.dow) {
      const domHit = parsed.dom && parsed.dom.has(d.getDate());
      const dowHit = parsed.dow && parsed.dow.has(d.getDay());
      if (!domHit && !dowHit) continue;
    }
    if (!parsed.hour.has(d.getHours()) || !parsed.minute.has(d.getMinutes())) continue;
    return d.getTime();
  }
  throw new Error(`Cron expression never matches within one year: ${parsed.expression}`);
}

function describe(expression) {
  const parsed = parse(expression);
  const names = ['minute', 'hour', 'day of month', 'month', 'day of week'];
  return parsed.expression.split(/\s+/).map((field, index) => field === '*' ? null : `${names[index]} ${field}`).filter(Boolean).join(', ');
}

module.exports = { parse, nextDue, describe, SHORTCUTS };
