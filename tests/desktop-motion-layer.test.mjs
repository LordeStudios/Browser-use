import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runStrokes, samplePath, sampleCircle, circlePoints, minimumJerk, junctionSpeeds, planTimeline, validateStroke } = require('../desktop/computer/pointerGesture.cjs');

const REGION = { x: 0, y: 0, width: 200, height: 200 };
const BASE = { windowId: '42', region: REGION };

function strokeArgs(strokes) {
  return { ...BASE, action: 'stroke', strokes };
}

test('minimumJerk is monotonic, anchored, and slow at the ends', () => {
  assert.equal(minimumJerk(0), 0);
  assert.equal(minimumJerk(1), 1);
  assert.ok(Math.abs(minimumJerk(0.5) - 0.5) < 0.01);
  let previous = -1;
  for (let step = 0; step <= 20; step++) {
    const value = minimumJerk(step / 20);
    assert.ok(value > previous, 'monotonically increasing');
    previous = value;
  }
  // Early progress is slower than mid progress: 0->0.1 covers less than 0.4->0.5.
  assert.ok(minimumJerk(0.1) - minimumJerk(0) < minimumJerk(0.5) - minimumJerk(0.4));
});

test('samplePath without curve returns the waypoints; catmull-rom passes through them', () => {
  const points = [{ x: 20, y: 100 }, { x: 100, y: 40 }, { x: 180, y: 100 }];
  const straight = samplePath(points, 'none', REGION);
  assert.equal(straight.length, 3);
  const curved = samplePath(points, 'catmull-rom', REGION);
  assert.ok(curved.length > 12, 'dense sampling between waypoints');
  assert.deepEqual(curved[0], points[0]);
  assert.deepEqual(curved.at(-1), points.at(-1));
  // The spline is a smooth curve, not the two-segment chord: some sampled
  // point deviates measurably from the straight path (measured 8.9px).
  let maxDeviation = 0;
  for (const point of curved) {
    const chordY = point.x <= 100 ? 100 + (point.x - 20) * (40 - 100) / 80 : 40 + (point.x - 100) * (100 - 40) / 80;
    maxDeviation = Math.max(maxDeviation, Math.abs(point.y - chordY));
  }
  assert.ok(maxDeviation > 4, `spline must deviate from the chord, got ${maxDeviation}`);
});

test('spline sampling that would leave the region is rejected before any press', async () => {
  const moved = [];
  let presses = 0, releases = 0;
  const tightRegion = { x: 0, y: 0, width: 100, height: 100 };
  // Waypoints hugging the borders make the spline overshoot past them.
  const args = {
    windowId: '7',
    region: tightRegion,
    action: 'stroke',
    strokes: [{ curve: 'catmull-rom', points: [{ x: 95, y: 95 }, { x: 5, y: 95 }, { x: 5, y: 5 }, { x: 95, y: 5 }] }]
  };
  await assert.rejects(
    () => runStrokes(args, {
      check: () => {},
      move: point => moved.push(point),
      button: down => { if (down) presses += 1; else releases += 1; },
      pause: () => Promise.resolve()
    }),
    /left the declared drawable region/
  );
  assert.equal(presses + releases, 0, 'no mouse press may happen for a rejected path');
  assert.equal(moved.length, 0);
});

test('ease profile paces a mark naturally along arc length', async () => {
  const moved = [];
  const args = strokeArgs([{ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], durationMs: 320 }]);
  const result = await runStrokes(args, {
    check: () => true,
    move: point => moved.push(point),
    button: () => {},
    pause: () => Promise.resolve()
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(result.endpoint, { x: 190, y: 100 });
  const last = moved.at(-1);
  assert.equal(last.x, 190);
  const segments = moved.slice(1).map((point, i) => point.x - moved[i].x);
  const firstQuarter = segments.slice(0, 5).reduce((a, b) => a + b, 0);
  const middleQuarter = segments.slice(8, 13).reduce((a, b) => a + b, 0);
  assert.ok(firstQuarter < middleQuarter, 'ease starts slower than the fluid middle');
  const lastQuarter = segments.slice(-5).reduce((a, b) => a + b, 0);
  assert.ok(lastQuarter < middleQuarter, 'ease lands gently');
});

test('linear profile keeps constant arc-length speed', async () => {
  const moved = [];
  const args = strokeArgs([{ points: [{ x: 10, y: 100 }, { x: 190, y: 100 }], profile: 'linear', durationMs: 320 }]);
  await runStrokes(args, {
    check: () => true,
    move: point => moved.push(point),
    button: () => {},
    pause: () => Promise.resolve()
  });
  const segments = moved.slice(1).map((point, i) => point.x - moved[i].x);
  const expected = 180 / segments.length;
  for (const segment of segments) assert.ok(Math.abs(segment - expected) < expected * 0.5, 'near-uniform steps');
});

test('catmull-rom dispatch keeps every dispatched point inside the region', async () => {
  const moved = [];
  const args = strokeArgs([{
    curve: 'catmull-rom',
    points: [{ x: 10, y: 180 }, { x: 100, y: 20 }, { x: 190, y: 180 }],
    durationMs: 320
  }]);
  const result = await runStrokes(args, {
    check: point => { if (point.x < REGION.x || point.x > REGION.x + REGION.width || point.y < REGION.y || point.y > REGION.y + REGION.height) throw new Error('outside'); },
    move: point => moved.push(point),
    button: () => {},
    pause: () => Promise.resolve()
  });
  assert.equal(result.dispatched, true);
  for (const point of moved) {
    assert.ok(point.x >= REGION.x && point.x <= REGION.x + REGION.width, `x ${point.x} inside`);
    assert.ok(point.y >= REGION.y && point.y <= REGION.y + REGION.height, `y ${point.y} inside`);
  }
});

test('validateStroke accepts curve and profile and rejects unknown values', () => {
  const valid = strokeArgs([{ curve: 'catmull-rom', profile: 'ease', points: [{ x: 1, y: 1 }, { x: 50, y: 50 }, { x: 100, y: 100 }] }]);
  assert.doesNotThrow(() => validateStroke(valid));
  assert.throws(() => validateStroke(strokeArgs([{ curve: 'bezier', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }])), /curve/);
  assert.throws(() => validateStroke(strokeArgs([{ profile: 'jumpy', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] }])), /profile/);
});

// --- Parametric circle primitive ---

test('circlePoints samples exact polar arcs that close on themselves', () => {
  const circle = { cx: 400, cy: 300, radius: 100 };
  const points = circlePoints(circle);
  assert.ok(points.length >= 24, 'dense sampling');
  for (const point of points) {
    const distance = Math.hypot(point.x - 400, point.y - 300);
    assert.ok(Math.abs(distance - 100) < 0.001, `every sampled point sits on the exact radius, got ${distance}`);
  }
  assert.ok(Math.abs(points[0].x - 500) < 0.001 && Math.abs(points[0].y - 300) < 0.001);
  assert.ok(Math.abs(points.at(-1).x - 500) < 0.001, 'closed circle returns to its start');
  // Partial arc: 90 degrees spans exactly a quarter of the circumference.
  const quarter = circlePoints({ cx: 0, cy: 0, radius: 100, startDeg: 0, endDeg: 90 });
  assert.ok(Math.abs(quarter.at(-1).y - 100) < 0.001 && Math.abs(quarter.at(-1).x) < 0.001);
});

test('a circle stroke dispatches as one continuous mark and reports the arc endpoint', async () => {
  const moved = [];
  let presses = 0;
  const args = strokeArgs([{ circle: { cx: 100, cy: 100, radius: 60 }, durationMs: 400 }]);
  const result = await runStrokes(args, {
    check: () => true,
    move: point => moved.push(point),
    button: down => { if (down) presses += 1; },
    pause: () => Promise.resolve()
  });
  assert.equal(result.dispatched, true);
  assert.equal(presses, 1, 'one continuous stroke, no per-point re-press');
  assert.deepEqual(result.endpoint, moved.at(-1));
  assert.ok(Math.abs(moved.at(-1).x - 160) < 0.01 && Math.abs(moved.at(-1).y - 100) < 0.01);
  assert.ok(moved.length >= 25, 'arc is dense, not a rounded polygon');
  for (const point of moved) {
    const distance = Math.hypot(point.x - 100, point.y - 100);
    // Interpolation between polar samples sags by ~r·dtheta²/8 (< 0.01px here):
    // sub-pixel, i.e. zero visible corners.
    assert.ok(Math.abs(distance - 60) < 0.05, `zero corners: dispatched point within 0.05px of the exact radius, got ${distance}`);
  }
});

test('an oversized circle is rejected before any press', async () => {
  let presses = 0;
  const args = strokeArgs([{ circle: { cx: 100, cy: 100, radius: 150 }, durationMs: 300 }]);
  await assert.rejects(
    () => runStrokes(args, { check: () => true, move: () => {}, button: down => { if (down) presses += 1; }, pause: () => Promise.resolve() }),
    /does not fit inside the chosen region/
  );
  assert.equal(presses, 0);
});

test('a partial arc leaving the region is rejected at sample time before any press', async () => {
  let presses = 0;
  // Region ends at x=150; an arc starting at (140,50) sweeping down will exit.
  const args = strokeArgs([{ circle: { cx: 140, cy: 100, radius: 80, startDeg: 0, endDeg: 180 }, durationMs: 300 }]);
  await assert.rejects(
    () => runStrokes(args, { check: () => true, move: () => {}, button: down => { if (down) presses += 1; }, pause: () => Promise.resolve() }),
    /leaves the declared drawable region/
  );
  assert.equal(presses, 0);
});

// --- Plotter-grade motion (saxi junction velocity + accel timeline) ---

test('junction speeds: straight uncapped, 90-degree corner capped, full reversal stopped', () => {
  assert.equal(junctionSpeeds([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }])[1], Infinity);
  const c90 = junctionSpeeds([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }])[1];
  assert.ok(c90 > 0.5 && c90 < 1.5, `90-degree junction speed ~0.88 px/ms, got ${c90}`);
  assert.equal(junctionSpeeds([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 0 }])[1], 0);
});

test('an L-mark slows at the corner and lands exactly on its endpoint', async () => {
  const moved = [];
  const bigRegion = { x: 0, y: 0, width: 400, height: 400 };
  const args = { windowId: '42', region: bigRegion, action: 'stroke', strokes: [{ points: [{ x: 20, y: 20 }, { x: 320, y: 20 }, { x: 320, y: 320 }], durationMs: 600 }] };
  const result = await runStrokes(args, {
    check: () => true,
    move: point => moved.push(point),
    button: () => {},
    pause: () => Promise.resolve()
  });
  assert.equal(result.dispatched, true);
  assert.deepEqual(moved.at(-1), { x: 320, y: 320 });
  const speeds = moved.slice(1).map((point, i) => Math.hypot(point.x - moved[i].x, point.y - moved[i].y));
  const straightMax = Math.max(...speeds.slice(5, 15));
  const cornerMin = Math.min(...speeds.slice(14, 30));
  assert.ok(cornerMin < straightMax * 0.95, `corner must be slower than cruise (corner ${cornerMin.toFixed(2)} vs straight ${straightMax.toFixed(2)})`);
  assert.ok(straightMax > 0, 'cruise speed reached on the straight');
});

test('planTimeline lands exactly on total and is monotonic', () => {
  const lengths = [300, 300];
  const caps = junctionSpeeds([{ x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 }]);
  const timeline = planTimeline(lengths, 600, 600, caps);
  assert.equal(timeline.at(-1), 600);
  for (let i = 1; i < timeline.length; i++) {
    assert.ok(timeline[i] >= timeline[i - 1], 'monotonic progress');
    assert.ok(timeline[i] <= 600.000001, 'never overshoots the path');
  }
  assert.ok(Math.max(...timeline) >= 599, 'reaches the end');
});
