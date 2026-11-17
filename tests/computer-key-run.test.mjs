// Driving a real app means dozens of tiny key presses: one Blender transform is
// S, X, 0.35, Enter. Paying a transport hop per key was the dominant cost of
// modelling through MCP (19 round trips for a single wheel), so computer_keyboard
// now accepts a keys[] run. The only part of that run that can be verified
// without sending real input is the key-vs-text decision — and getting it wrong
// is silent: "0.35" typed as a chord throws, "Enter" typed as text inserts the
// word "Enter" into whatever field has focus.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeKeyStep } = require('../desktop/computer/nativeWorker.cjs');

test('single characters and named keys become presses', () => {
  for (const key of ['S', 'X', '2', 'Enter', 'Escape', 'Tab', 'F3']) {
    assert.deepEqual(normalizeKeyStep(key), { action: 'press', key }, `${key} must press`);
  }
});

test('chords become presses with every segment validated', () => {
  assert.deepEqual(normalizeKeyStep('Shift+D'), { action: 'press', key: 'Shift+D' });
  assert.deepEqual(normalizeKeyStep('Control+Shift+S'), { action: 'press', key: 'Control+Shift+S' });
});

test('numeric values that no chord can express become text', () => {
  for (const value of ['0.35', '-0.2', '90', '1.02', '0.6']) {
    assert.deepEqual(normalizeKeyStep(value), { action: 'text', text: value }, `${value} must type`);
  }
});

test('words that are not key names are typed, not pressed', () => {
  assert.deepEqual(normalizeKeyStep('hello'), { action: 'text', text: 'hello' });
  // "numpad" alone is not a key; only numpad0..numpad9 are.
  assert.deepEqual(normalizeKeyStep('numpad'), { action: 'text', text: 'numpad' });
});

test('an explicit step object is honoured over inference', () => {
  assert.deepEqual(normalizeKeyStep({ action: 'text', text: 'Enter' }), { action: 'text', text: 'Enter' });
  assert.deepEqual(normalizeKeyStep({ key: 'Enter' }), { action: 'press', key: 'Enter' });
});

test('empty entries are dropped instead of pressing nothing', () => {
  assert.equal(normalizeKeyStep(''), null);
  assert.equal(normalizeKeyStep(null), null);
  assert.equal(normalizeKeyStep(undefined), null);
  assert.equal(normalizeKeyStep({}), null);
});

test('a real Blender transform classifies the way the app expects', () => {
  const steps = ['S', 'X', '0.35', 'Enter'].map(normalizeKeyStep);
  assert.deepEqual(steps, [
    { action: 'press', key: 'S' },
    { action: 'press', key: 'X' },
    { action: 'text', text: '0.35' },
    { action: 'press', key: 'Enter' }
  ]);
});

// The batched run is only cheap if the CALL is cheap. Requiring `action` on a
// keys[] call forced the caller to invent a field that contradicts the run
// (action=press on 200 mixed steps), and the rejection arrived before the keys
// ever left the app — the exact round trip the run exists to remove.
test('a keys-only call is accepted without a redundant action field', () => {
  const { validateComputerInput } = require('../desktop/computer/computerCatalog.cjs');
  assert.doesNotThrow(() => validateComputerInput('computer_keyboard', { keys: ['S', 'X', '0.35', 'Enter'] }));
  assert.doesNotThrow(() => validateComputerInput('computer_keyboard', { key: 'Enter' }));
  assert.doesNotThrow(() => validateComputerInput('computer_keyboard', { text: 'hello' }));
  assert.doesNotThrow(() => validateComputerInput('computer_keyboard', { action: 'press', key: 'Enter' }));
});

test('a keyboard call that names no keys is rejected with a sentence, not a key error', () => {
  const { validateComputerInput } = require('../desktop/computer/computerCatalog.cjs');
  assert.throws(() => validateComputerInput('computer_keyboard', {}), /name one of keys|requires action/i);
});

test('the advertised schema makes action optional and keys a real array', () => {
  const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
  const tool = COMPUTER_TOOLS.find(entry => entry.name === 'computer_keyboard');
  const input = tool.inputSchema;
  assert.equal(input.required?.includes('action') ?? false, false, 'action must not be mandatory');
  assert.equal(input.properties.keys.type, 'array');
  assert.equal(input.properties.keys.maxItems, 200);
  assert.match(tool.description, /ONE call, never one call per key/, 'the description must steer callers to the batch');
});
