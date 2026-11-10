'use strict';

// Builds the touch-point frame sequences behind every native gesture.
//
// Pure functions with no Electron or CDP dependency, so gesture geometry is
// unit-testable on its own: a frame is { type, touchPoints, delayMs } and maps
// one-to-one onto Input.dispatchTouchEvent.
//
// CDP treats touchPoints as the full set of points still in contact, and emits
// one event per changed point. A touchEnd therefore carries the points that
// REMAIN down, which is why lifting the last finger sends an empty array and
// lifting one of two sends the survivor.
//
// Motion is interpolated rather than jumped, because a page driven by a single
// teleporting touchmove never sees the intermediate deltas its scroll physics,
// swipe thresholds, and drag handlers actually key off.

const FRAME_INTERVAL_MS = 16;
const MAX_STEPS = 60;
const DEFAULT_RADIUS_PX = 12;
const LONG_PRESS_MS = 650;
const DOUBLE_TAP_GAP_MS = 120;

function touchPoint(x, y, id, force = 1) {
  return {
    x: round(x),
    y: round(y),
    radiusX: DEFAULT_RADIUS_PX,
    radiusY: DEFAULT_RADIUS_PX,
    rotationAngle: 0,
    force,
    id
  };
}

function round(value) {
  return Math.round(Number(value));
}

function assertFinite(...values) {
  for (const value of values) {
    if (!Number.isFinite(Number(value))) throw new Error('Gesture coordinates must be finite numbers');
  }
}

function stepCount(durationMs) {
  const duration = Math.max(0, Number(durationMs) || 0);
  return Math.max(2, Math.min(MAX_STEPS, Math.round(duration / FRAME_INTERVAL_MS)));
}

function stepDelay(durationMs, steps) {
  return Math.max(1, Math.round((Number(durationMs) || 0) / steps));
}

// Real fingers accelerate away from rest and decelerate into a stop, so a
// settling gesture uses ease-in-out. A flick keeps its velocity at release,
// which is what the compositor integrates into momentum, so it stays linear.
function ease(t, momentum) {
  if (momentum) return t;
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function tap(x, y) {
  assertFinite(x, y);
  return [
    { type: 'touchStart', touchPoints: [touchPoint(x, y, 0)], delayMs: 0 },
    { type: 'touchEnd', touchPoints: [], delayMs: 60 }
  ];
}

function doubleTap(x, y) {
  return [...tap(x, y), ...tap(x, y).map((frame, index) => (index === 0 ? { ...frame, delayMs: DOUBLE_TAP_GAP_MS } : frame))];
}

function longPress(x, y, durationMs = LONG_PRESS_MS) {
  assertFinite(x, y);
  return [
    { type: 'touchStart', touchPoints: [touchPoint(x, y, 0)], delayMs: 0 },
    // A held contact must keep reporting, or a page watching for movement
    // treats the press as abandoned before its long-press timer fires.
    { type: 'touchMove', touchPoints: [touchPoint(x, y, 0)], delayMs: Math.max(50, Math.round(Number(durationMs) / 2)) },
    { type: 'touchEnd', touchPoints: [], delayMs: Math.max(50, Math.round(Number(durationMs) / 2)) }
  ];
}

function swipe({ startX, startY, endX, endY, durationMs = 300, momentum = false }) {
  assertFinite(startX, startY, endX, endY);
  const steps = stepCount(durationMs);
  const delay = stepDelay(durationMs, steps);
  const frames = [{ type: 'touchStart', touchPoints: [touchPoint(startX, startY, 0)], delayMs: 0 }];
  for (let step = 1; step <= steps; step += 1) {
    const progress = ease(step / steps, momentum);
    frames.push({
      type: 'touchMove',
      touchPoints: [touchPoint(startX + (endX - startX) * progress, startY + (endY - startY) * progress, 0)],
      delayMs: delay
    });
  }
  frames.push({ type: 'touchEnd', touchPoints: [], delayMs: 16 });
  return frames;
}

// Content follows the finger, so scrolling down the page means dragging up.
function scroll({ x, y, deltaX = 0, deltaY = 0, durationMs = 300, momentum = true }) {
  assertFinite(x, y, deltaX, deltaY);
  return swipe({ startX: x, startY: y, endX: x - deltaX, endY: y - deltaY, durationMs, momentum });
}

// Two fingers moving along a fixed axis through the centre. scale > 1 spreads
// them apart (zoom in); scale < 1 draws them together (zoom out).
function pinch({ centerX, centerY, scale, startSpreadPx = 120, durationMs = 400, angleDegrees = 0 }) {
  assertFinite(centerX, centerY, scale, startSpreadPx);
  const scaleFactor = Number(scale);
  if (!(scaleFactor > 0)) throw new Error('Pinch scale must be greater than 0');
  const steps = stepCount(durationMs);
  const delay = stepDelay(durationMs, steps);
  const radians = (Number(angleDegrees) * Math.PI) / 180;
  const unitX = Math.cos(radians);
  const unitY = Math.sin(radians);
  const startHalf = Number(startSpreadPx) / 2;
  const endHalf = startHalf * scaleFactor;

  const pointsAt = (half) => [
    touchPoint(centerX - unitX * half, centerY - unitY * half, 0),
    touchPoint(centerX + unitX * half, centerY + unitY * half, 1)
  ];

  const frames = [{ type: 'touchStart', touchPoints: pointsAt(startHalf), delayMs: 0 }];
  for (let step = 1; step <= steps; step += 1) {
    const progress = ease(step / steps, false);
    frames.push({ type: 'touchMove', touchPoints: pointsAt(startHalf + (endHalf - startHalf) * progress), delayMs: delay });
  }
  // Lift one finger, then the other, the way a hand actually leaves the glass.
  frames.push({ type: 'touchEnd', touchPoints: [pointsAt(endHalf)[1]], delayMs: 16 });
  frames.push({ type: 'touchEnd', touchPoints: [], delayMs: 16 });
  return frames;
}

// Two fingers sweeping around a shared centre, for rotation-aware canvases.
function rotate({ centerX, centerY, degrees, radiusPx = 90, durationMs = 400 }) {
  assertFinite(centerX, centerY, degrees, radiusPx);
  const steps = stepCount(durationMs);
  const delay = stepDelay(durationMs, steps);
  const total = (Number(degrees) * Math.PI) / 180;

  const pointsAt = (angle) => [
    touchPoint(centerX + Math.cos(angle) * radiusPx, centerY + Math.sin(angle) * radiusPx, 0),
    touchPoint(centerX + Math.cos(angle + Math.PI) * radiusPx, centerY + Math.sin(angle + Math.PI) * radiusPx, 1)
  ];

  const frames = [{ type: 'touchStart', touchPoints: pointsAt(0), delayMs: 0 }];
  for (let step = 1; step <= steps; step += 1) {
    frames.push({ type: 'touchMove', touchPoints: pointsAt(total * ease(step / steps, false)), delayMs: delay });
  }
  frames.push({ type: 'touchEnd', touchPoints: [pointsAt(total)[1]], delayMs: 16 });
  frames.push({ type: 'touchEnd', touchPoints: [], delayMs: 16 });
  return frames;
}

// N fingers travelling together — the three-finger system gestures and
// two-finger scroll surfaces that a single contact can never trigger.
function multiFingerSwipe({ fingers = 3, startX, startY, deltaX = 0, deltaY = 0, spacingPx = 60, durationMs = 350, momentum = true }) {
  assertFinite(startX, startY, deltaX, deltaY, spacingPx);
  const count = Math.max(2, Math.min(5, Math.round(Number(fingers))));
  const steps = stepCount(durationMs);
  const delay = stepDelay(durationMs, steps);
  // Fingers spread across the axis the gesture is not travelling along, so a
  // vertical swipe lands them side by side rather than stacked in a line.
  const vertical = Math.abs(deltaY) >= Math.abs(deltaX);
  const offset = (index) => (index - (count - 1) / 2) * spacingPx;

  const pointsAt = (progress) => Array.from({ length: count }, (_, index) => touchPoint(
    startX + (vertical ? offset(index) : 0) + deltaX * progress,
    startY + (vertical ? 0 : offset(index)) + deltaY * progress,
    index
  ));

  const frames = [{ type: 'touchStart', touchPoints: pointsAt(0), delayMs: 0 }];
  for (let step = 1; step <= steps; step += 1) {
    frames.push({ type: 'touchMove', touchPoints: pointsAt(ease(step / steps, momentum)), delayMs: delay });
  }
  const settled = pointsAt(1);
  for (let index = count - 1; index >= 1; index -= 1) {
    frames.push({ type: 'touchEnd', touchPoints: settled.slice(0, index), delayMs: 12 });
  }
  frames.push({ type: 'touchEnd', touchPoints: [], delayMs: 12 });
  return frames;
}

const GESTURES = { tap, doubleTap, longPress, swipe, scroll, pinch, rotate, multiFingerSwipe };

function buildGesture(name, options = {}) {
  const builder = GESTURES[name];
  if (!builder) throw new Error(`Unknown gesture: ${name}`);
  if (name === 'tap' || name === 'doubleTap') return builder(options.x, options.y);
  if (name === 'longPress') return builder(options.x, options.y, options.durationMs);
  return builder(options);
}

module.exports = {
  buildGesture,
  tap,
  doubleTap,
  longPress,
  swipe,
  scroll,
  pinch,
  rotate,
  multiFingerSwipe,
  FRAME_INTERVAL_MS,
  LONG_PRESS_MS,
  DEFAULT_RADIUS_PX
};
