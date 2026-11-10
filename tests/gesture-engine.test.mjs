import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildGesture, tap, swipe, pinch, rotate, multiFingerSwipe, longPress, scroll } = require('../src/browser/gestureEngine.cjs');
const { getDeviceProfile, resolveViewport, listDeviceProfiles } = require('../src/browser/deviceProfiles.cjs');

// CDP treats touchPoints as the set still in contact and derives the changed
// point itself, so a malformed sequence is dispatched without error and simply
// does nothing to the page. These assertions pin the shape that actually works.
function assertWellFormed(frames, label) {
  assert.equal(frames[0].type, 'touchStart', `${label}: must open with touchStart`);
  assert.equal(frames.at(-1).type, 'touchEnd', `${label}: must close with touchEnd`);
  assert.equal(frames.at(-1).touchPoints.length, 0, `${label}: the final frame must leave no contacts`);
  for (const frame of frames) {
    assert.ok(['touchStart', 'touchMove', 'touchEnd', 'touchCancel'].includes(frame.type), `${label}: valid frame type`);
    for (const point of frame.touchPoints) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), `${label}: finite coordinates`);
      assert.equal(point.x, Math.round(point.x), `${label}: integer coordinates`);
      assert.ok(Number.isInteger(point.id), `${label}: integer contact id`);
    }
  }
}

test('tap opens and closes a single contact', () => {
  const frames = tap(100, 200);
  assertWellFormed(frames, 'tap');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].touchPoints.length, 1);
  assert.deepEqual([frames[0].touchPoints[0].x, frames[0].touchPoints[0].y], [100, 200]);
});

test('swipe interpolates rather than teleporting', () => {
  const frames = swipe({ startX: 10, startY: 500, endX: 10, endY: 100, durationMs: 300 });
  assertWellFormed(frames, 'swipe');
  const moves = frames.filter((frame) => frame.type === 'touchMove');
  // A single jump gives a page no intermediate deltas to react to, which is
  // what makes scroll physics and swipe thresholds fail to trigger.
  assert.ok(moves.length >= 8, `expected many interpolated moves, got ${moves.length}`);
  assert.equal(moves.at(-1).touchPoints[0].y, 100, 'the final move must reach the target');
  const ys = moves.map((frame) => frame.touchPoints[0].y);
  assert.ok(ys.every((value, index) => index === 0 || value <= ys[index - 1]), 'movement must be monotonic toward the target');
});

test('scroll drags opposite the requested content delta', () => {
  // Content follows the finger: scrolling the page down means dragging up.
  const frames = scroll({ x: 200, y: 400, deltaY: 300, durationMs: 200 });
  const start = frames[0].touchPoints[0];
  const end = frames.filter((frame) => frame.type === 'touchMove').at(-1).touchPoints[0];
  assert.ok(end.y < start.y, 'a positive deltaY must drag the contact upward');
  assert.equal(start.y - end.y, 300);
});

test('pinch uses two simultaneous contacts and lifts them one at a time', () => {
  const frames = pinch({ centerX: 200, centerY: 400, scale: 2, startSpreadPx: 100 });
  assertWellFormed(frames, 'pinch');
  assert.equal(frames[0].touchPoints.length, 2, 'a pinch needs two contacts down together');
  const ids = frames[0].touchPoints.map((point) => point.id);
  assert.deepEqual([...new Set(ids)].sort(), [0, 1], 'contacts need distinct ids');

  const startGap = Math.abs(frames[0].touchPoints[1].x - frames[0].touchPoints[0].x);
  const lastMove = frames.filter((frame) => frame.type === 'touchMove').at(-1);
  const endGap = Math.abs(lastMove.touchPoints[1].x - lastMove.touchPoints[0].x);
  assert.ok(endGap > startGap, 'scale > 1 must spread the contacts apart');
  assert.equal(Math.round(endGap / startGap), 2, 'the spread must match the requested scale');

  const ends = frames.filter((frame) => frame.type === 'touchEnd');
  assert.equal(ends[0].touchPoints.length, 1, 'lifting one finger must leave the other reported as down');
});

test('pinch inward draws contacts together', () => {
  const frames = pinch({ centerX: 200, centerY: 400, scale: 0.5, startSpreadPx: 200 });
  const startGap = Math.abs(frames[0].touchPoints[1].x - frames[0].touchPoints[0].x);
  const endGap = Math.abs(frames.filter((f) => f.type === 'touchMove').at(-1).touchPoints[1].x - frames.filter((f) => f.type === 'touchMove').at(-1).touchPoints[0].x);
  assert.ok(endGap < startGap, 'scale < 1 must draw the contacts together');
});

test('pinch rejects a non-positive scale', () => {
  assert.throws(() => pinch({ centerX: 10, centerY: 10, scale: 0 }), /scale must be greater than 0/);
});

test('rotate sweeps two opposed contacts around the centre', () => {
  const frames = rotate({ centerX: 200, centerY: 200, degrees: 90, radiusPx: 100 });
  assertWellFormed(frames, 'rotate');
  const first = frames[0].touchPoints;
  // Opposed contacts stay diametrically opposite, so their midpoint is the centre.
  assert.equal(Math.round((first[0].x + first[1].x) / 2), 200);
  assert.equal(Math.round((first[0].y + first[1].y) / 2), 200);
  const last = frames.filter((frame) => frame.type === 'touchMove').at(-1).touchPoints;
  const startAngle = Math.atan2(first[0].y - 200, first[0].x - 200);
  const endAngle = Math.atan2(last[0].y - 200, last[0].x - 200);
  assert.ok(Math.abs((endAngle - startAngle) * (180 / Math.PI) - 90) < 2, 'must sweep the requested angle');
});

test('multiFingerSwipe places the requested contact count', () => {
  const frames = multiFingerSwipe({ fingers: 3, startX: 200, startY: 600, deltaY: -300 });
  assertWellFormed(frames, 'multiFingerSwipe');
  assert.equal(frames[0].touchPoints.length, 3);
  // Fingers spread across the axis they are not travelling along.
  const xs = frames[0].touchPoints.map((point) => point.x);
  assert.equal(new Set(xs).size, 3, 'a vertical swipe must place fingers side by side');
  const ends = frames.filter((frame) => frame.type === 'touchEnd');
  assert.deepEqual(ends.map((frame) => frame.touchPoints.length), [2, 1, 0], 'fingers must lift one at a time');
});

test('multiFingerSwipe clamps the contact count to what a touchscreen reports', () => {
  assert.equal(multiFingerSwipe({ fingers: 99, startX: 10, startY: 10, deltaY: -10 })[0].touchPoints.length, 5);
  assert.equal(multiFingerSwipe({ fingers: 0, startX: 10, startY: 10, deltaY: -10 })[0].touchPoints.length, 2);
});

test('longPress keeps reporting the contact while it is held', () => {
  const frames = longPress(50, 60, 800);
  assertWellFormed(frames, 'longPress');
  // A press with no intermediate report can be treated as abandoned before the
  // page's long-press timer fires.
  assert.ok(frames.some((frame) => frame.type === 'touchMove'), 'a held contact must keep reporting');
  const total = frames.reduce((sum, frame) => sum + frame.delayMs, 0);
  assert.ok(total >= 700, `a long press must actually take time, got ${total}ms`);
});

test('gestures reject non-finite coordinates', () => {
  assert.throws(() => tap(Number.NaN, 10), /finite numbers/);
  assert.throws(() => swipe({ startX: 0, startY: 0, endX: undefined, endY: 10 }), /finite numbers/);
});

test('buildGesture rejects an unknown gesture by name', () => {
  assert.throws(() => buildGesture('teleport', {}), /Unknown gesture: teleport/);
});

test('device profiles carry the client-hint metadata Chromium requires', () => {
  // Emulation.setUserAgentOverride rejects the whole call when metadata is
  // partial, which silently leaves the page identifying as desktop.
  for (const profile of listDeviceProfiles().filter((item) => item.mode !== 'desktop')) {
    const full = getDeviceProfile(profile.id);
    assert.ok(full.userAgent, `${profile.id}: needs a user agent`);
    const metadata = full.userAgentMetadata;
    for (const key of ['brands', 'fullVersion', 'platform', 'platformVersion', 'architecture', 'model', 'mobile']) {
      assert.ok(key in metadata, `${profile.id}: userAgentMetadata.${key} must be present`);
    }
    assert.ok(full.width > 0 && full.height > 0, `${profile.id}: needs a viewport`);
    assert.ok(full.deviceScaleFactor > 0, `${profile.id}: needs a pixel ratio`);
  }
});

test('landscape swaps the viewport and reports the matching orientation', () => {
  const profile = getDeviceProfile('pixel-8');
  const portrait = resolveViewport(profile, 'portrait');
  const landscape = resolveViewport(profile, 'landscape');
  assert.equal(portrait.width, landscape.height);
  assert.equal(portrait.height, landscape.width);
  assert.equal(portrait.screenOrientation.angle, 0);
  assert.equal(landscape.screenOrientation.angle, 90);
  // A page reading screen.orientation must agree with its own layout.
  assert.equal(landscape.screenOrientation.type, 'landscapePrimary');
});

test('the desktop profile disables emulation entirely', () => {
  assert.equal(resolveViewport(getDeviceProfile('desktop'), 'portrait'), null);
});
