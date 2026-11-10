import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateComputerInput } = require('../desktop/computer/computerCatalog.cjs');

// SELF-DESCRIBING ERRORS (run.txt 2026-10-29): the agent spent 17 retries
// guessing at "Invalid computer_read.display_text." An error must name the
// field, what was expected, what was sent, and the legal values — so the
// model can act on it in one step instead of guessing.

function capture(fn) {
  try { fn(); return null; } catch (error) { return error; }
}

test('unknown field names the field and lists the allowed fields', () => {
  const error = capture(() => validateComputerInput('computer_read', { path: 'x', bogus_field: 'y' }));
  assert.ok(error, 'must throw');
  assert.match(error.message, /bogus_field/, 'must name the offending field');
  assert.doesNotMatch(error.message, /^Unknown computer_read\.display_text\./, 'display_text is legal metadata on computer_read');
  assert.match(error.message, /Allowed fields:.*path/, 'must list allowed fields');
  assert.equal(error.code, 'INVALID_TOOL_INPUT');
  assert.equal(error.reason, 'unknown_field');
});

test('wrong type names expected type and received type', () => {
  const error = capture(() => validateComputerInput('computer_read', { path: 123 }));
  assert.ok(error, 'must throw');
  assert.match(error.message, /expected string, got number/, 'must state expected and received types');
  assert.equal(error.reason, 'invalid_type');
});

test('enum violation lists every legal value and what was sent', () => {
  const error = capture(() => validateComputerInput('computer_pointer', { action: 'fly', x: 1, y: 1 }));
  assert.ok(error, 'must throw');
  assert.match(error.message, /expected one of \[/, 'must list legal values');
  assert.match(error.message, /"fly"/, 'must quote the received value');
  assert.equal(error.reason, 'invalid_enum_value');
  assert.ok(Array.isArray(error.allowed) && error.allowed.includes('click'), 'must expose allowed values');
});

test('missing required field names the field and the allowed set', () => {
  const error = capture(() => validateComputerInput('computer_read', {}));
  assert.ok(error, 'must throw');
  assert.match(error.message, /Missing required field/, 'must say what is missing');
  assert.match(error.message, /path/, 'must name the missing field');
  assert.equal(error.reason, 'missing_required');
});

test('unknown tool suggests the closest real tool names', () => {
  const error = capture(() => validateComputerInput('computer_readx', {}));
  assert.ok(error, 'must throw');
  assert.match(error.message, /Unknown computer tool/, 'must say the tool is unknown');
  assert.match(error.message, /computer_read/, 'must suggest a real tool name');
  assert.equal(error.reason, 'unknown_tool');
});

test('non-object input states what it received', () => {
  const error = capture(() => validateComputerInput('computer_read', 'path'));
  assert.ok(error, 'must throw');
  assert.match(error.message, /expected an object/, 'must state the expectation');
  assert.match(error.message, /got string/, 'must state what arrived');
  assert.equal(error.reason, 'not_an_object');
});

test('no validation error is the bare "Invalid <label>." form', () => {
  // Regression guard: the old opaque form must never come back.
  const probes = [
    () => validateComputerInput('computer_read', { path: 'x', bogus_field: 'y' }),
    () => validateComputerInput('computer_read', { path: 123 }),
    () => validateComputerInput('computer_pointer', { action: 'fly', x: 1, y: 1 }),
    () => validateComputerInput('computer_read', {}),
    () => validateComputerInput('computer_readx', {}),
    () => validateComputerInput('computer_read', 'path')
  ];
  for (const probe of probes) {
    const error = capture(probe);
    assert.ok(error, 'each probe must throw');
    assert.doesNotMatch(error.message, /^Invalid [a-z_]+(\.[a-z_]+)?\.$/,
      `opaque error returned: ${error.message}`);
  }
});
