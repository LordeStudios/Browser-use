import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parse, nextDue, describe, SHORTCUTS } = require('../desktop/schedule/cron.cjs');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
const now = ms => new Date(ms);

test('cron parses lists, ranges, steps and rejects malformed fields', () => {
  const parsed = parse('*/15 9-17,20 1,15 * 1-5');
  assert.equal(parsed.minute.has(0), true); assert.equal(parsed.minute.has(15), true); assert.equal(parsed.minute.has(7), false);
  assert.equal(parsed.hour.has(9), true); assert.equal(parsed.hour.has(20), true); assert.equal(parsed.hour.has(8), false);
  assert.deepEqual([...parsed.dom].sort(), [1, 15]);
  assert.equal(parsed.dow.has(1), true); assert.equal(parsed.dow.has(6), false);
  assert.throws(() => parse('* * * *'), /5 fields/);
  assert.throws(() => parse('61 * * * *'), /out of range/);
  assert.throws(() => parse('* * * * */0'), /step/);
});

test('nextDue honors the step ladder and skips to the next matching minute', () => {
  // From 10:15, "0 */3 * * *" fires next at 12:00 the same day.
  assert.equal(nextDue('0 */3 * * *', at(2026, 9, 11, 10, 15), now), at(2026, 9, 11, 12, 0));
  // Exact match time moves to the NEXT occurrence, never returns the same minute.
  assert.equal(nextDue('0 */3 * * *', at(2026, 9, 11, 12, 0), now), at(2026, 9, 11, 15, 0));
});

test('nextDue applies the vixie dom/dow OR rule', () => {
  // Sep 11 2026 is a Friday; the 13th is a Sunday. Both fields restricted:
  // either the 13th of the month OR any Friday matches.
  assert.equal(nextDue('0 0 13 * 5', at(2026, 9, 11, 12, 0), now), at(2026, 9, 13, 0, 0));
});

test('named shortcuts map to standard expressions', () => {
  assert.equal(SHORTCUTS['@daily'], '0 0 * * *');
  assert.equal(nextDue('@daily', at(2026, 9, 11, 5, 0), now), at(2026, 9, 12, 0, 0));
});

test('describe renders a human-readable summary only for restricted fields', () => {
  assert.equal(describe('*/15 9-17 * * 1-5'), 'minute */15, hour 9-17, day of week 1-5');
  assert.equal(describe('* * * * *'), '');
});
