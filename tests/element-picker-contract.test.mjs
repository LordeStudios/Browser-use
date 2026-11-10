import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildElementPickerExpression, PICKER_ID } = require('../src/browser/elementPicker.cjs');

test('picker resolves the element at pick time, not at the last mousemove', () => {
  const script = buildElementPickerExpression();
  // Content moves under a stationary cursor on real sites (wheel, SPA
  // re-renders, animations). The pick must re-track the hit test at the
  // exact click moment or the highlight and the attachment disagree.
  assert.match(script, /const onPick = \(event\) => \{[^}]*track\(event\.clientX, event\.clientY\)/s);
  assert.match(script, /onTouchEnd[\s\S]*?track\(touch\.clientX, touch\.clientY\)/);
});

test('picker re-tracks on scroll and resize so the highlight follows content', () => {
  const script = buildElementPickerExpression();
  assert.match(script, /const retrack = \(\) => \{ if \(lastPointer\) track\(lastPointer\.x, lastPointer\.y\); \};/);
  assert.match(script, /\['scroll', retrack\]/);
  assert.match(script, /\['resize', retrack\]/);
  // lastPointer must be recorded by track() itself.
  assert.match(script, /const track = \(x, y\) => \{\s*lastPointer = \{ x, y \};/);
});
