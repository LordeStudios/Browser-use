'use strict';

const MAX_POINTS = 512;
const MAX_STROKES = 32;
const MAX_DURATION = 10_000;
const CURVE_MODES = new Set(['none', 'catmull-rom']);
const PROFILES = new Set(['linear', 'ease']);
function rectangle(rect, label) {
  if (!rect || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) || rect.width <= 0 || rect.height <= 0) throw new Error(`${label} requires finite x/y and positive width/height.`);
  return rect;
}
function inside(point, rect) {
  return Number.isFinite(point?.x) && Number.isFinite(point?.y) && point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}
function contains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

// Motion layer (plotter heritage, humanized pacing):
// - Catmull-Rom sampling turns sparse model-declared waypoints into a smooth
//   curve, the way plotters render arcs from control points. The model spends
//   fewer tokens on coordinates while the engine produces natural marks.
// - The minimum-jerk time warp replaces constant-speed traversal with the
//   velocity envelope of natural hand motion (slow start, fluid middle, gentle
//   landing). Painting apps that modulate brush size/flow by speed receive
//   realistic dynamics instead of a machine-gun constant rate.
function minimumJerk(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // Classic five-degree minimum-jerk trajectory: 10t³ - 15t⁴ + 6t⁵.
  const t2 = t * t, t3 = t2 * t, t4 = t2 * t2, t5 = t4 * t;
  return 10 * t3 - 15 * t4 + 6 * t5;
}

function catmullRomPoint(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return {
    x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
  };
}

// Sample the declared waypoints into the dispatch path. A spline may leave the
// convex hull of its waypoints, so every sampled point is bounds-checked
// against the declared region BEFORE the pointer ever presses down.
function samplePath(points, curve, region) {
  const mode = curve ?? 'none';
  if (!CURVE_MODES.has(mode)) throw new Error(`Invalid stroke curve '${mode}'.`);
  if (mode !== 'catmull-rom' || points.length < 3) return points.map(point => ({ ...point }));
  const sampled = [{ ...points[0] }];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const steps = Math.max(2, Math.min(48, Math.ceil(chord / 3)));
    for (let s = 1; s <= steps; s++) {
      const point = catmullRomPoint(p0, p1, p2, p3, s / steps);
      if (region && !inside(point, region)) {
        throw new Error('Curve sampling left the declared drawable region; move waypoints inside the region or reduce curvature.');
      }
      sampled.push(point);
    }
  }
  return sampled;
}

// Parametric arc sampling: the model declares a circle (cx, cy, radius,
// optional startDeg/endDeg); the engine generates exact polar points — the way
// plotters render arcs — instead of the model spending reasoning tokens on
// trigonometry tables or the executor approximating a circle with a spline
// through sparse waypoints (which is geometrically a rounded polygon).
function circlePoints(circle) {
  const start = circle.startDeg ?? 0;
  const sweep = (circle.endDeg ?? (circle.startDeg === undefined ? 360 : start + 360)) - start;
  const degrees = Number.isFinite(sweep) && sweep !== 0 ? sweep : 360;
  const arcLength = 2 * Math.PI * circle.radius * Math.abs(degrees) / 360;
  const count = Math.max(24, Math.min(512, Math.ceil(arcLength / 2)));
  const points = [];
  for (let step = 0; step <= count; step++) {
    const angle = (start + degrees * step / count) * Math.PI / 180;
    points.push({ x: circle.cx + circle.radius * Math.cos(angle), y: circle.cy + circle.radius * Math.sin(angle) });
  }
  return points;
}

function insideCircleBox(circle, region) {
  return circle.cx - circle.radius >= region.x && circle.cx + circle.radius <= region.x + region.width
    && circle.cy - circle.radius >= region.y && circle.cy + circle.radius <= region.y + region.height;
}

// Sample a declared circle/arc into dispatch points, bounds-checked per point
// before any press so a mis-placed arc can never leave a partial mark.
function sampleCircle(circle, region) {
  const points = circlePoints(circle);
  if (region) {
    for (const point of points) {
      if (!inside(point, region)) throw new Error('The sampled arc leaves the declared drawable region; adjust the center, radius, or angles.');
    }
  }
  return points;
}

function pointerPoints(args) {
  if (args.action === 'stroke') return args.strokes.flatMap(stroke => stroke.points ?? []);
  const points = args.x !== undefined || args.y !== undefined ? [{ x: args.x, y: args.y }] : [];
  if (args.action === 'drag') points.push({ x: args.endX, y: args.endY });
  return points;
}
function validateStroke(args) {
  if (!/^\d+$/.test(args.windowId || '')) throw new Error('Stroke requires a windowId from computer_observe.');
  rectangle(args.region, 'Stroke region');
  if (!Array.isArray(args.strokes) || !args.strokes.length || args.strokes.length > MAX_STROKES) throw new Error(`Supply 1..${MAX_STROKES} strokes.`);
  if (args.durationMs !== undefined || ['x', 'y', 'endX', 'endY', 'deltaX', 'deltaY'].some(key => args[key] !== undefined)) throw new Error('For stroke, put points and durationMs inside each strokes entry, not at the top level.');
  let points = 0, duration = 0;
  for (const stroke of args.strokes) {
    if (stroke.circle !== undefined) {
      const circle = stroke.circle;
      if (!Number.isFinite(circle.cx) || !Number.isFinite(circle.cy)) throw new Error('Stroke circle requires finite cx and cy.');
      if (!Number.isFinite(circle.radius) || circle.radius <= 0) throw new Error('Stroke circle requires a positive radius.');
      for (const key of ['startDeg', 'endDeg']) if (circle[key] !== undefined && !Number.isFinite(circle[key])) throw new Error(`Stroke circle ${key} must be finite.`);
      points += 2; // Engine-sampled arcs are declared with one descriptor.
      // A closed circle is rejected early from its bounding box; partial arcs
      // are bounds-checked per sampled point before any press (sampleCircle).
      if (stroke.circle.startDeg === undefined && stroke.circle.endDeg === undefined && !insideCircleBox(stroke.circle, args.region)) {
        throw new Error('The declared circle does not fit inside the chosen region; center it or shrink the radius.');
      }
    } else {
      if (!Array.isArray(stroke?.points) || stroke.points.length < 2 || stroke.points.length > MAX_POINTS) throw new Error(`Each stroke requires 2..${MAX_POINTS} points or a circle descriptor.`);
      for (const point of stroke.points) if (!inside(point, args.region)) throw new Error('A stroke point is outside the chosen region; inspect coordinates before drawing.');
      points += stroke.points.length;
    }
    if (stroke.curve !== undefined && !CURVE_MODES.has(stroke.curve)) throw new Error('Stroke curve must be none or catmull-rom.');
    if (stroke.profile !== undefined && !PROFILES.has(stroke.profile)) throw new Error('Stroke profile must be linear or ease.');
    const ms = stroke.durationMs ?? 300;
    if (!Number.isFinite(ms) || ms < 0 || ms > MAX_DURATION) throw new Error('Invalid stroke durationMs.');
    duration += ms;
  }
  if (points > MAX_POINTS || duration > MAX_DURATION) throw new Error(`One batch permits at most ${MAX_POINTS} points and ${MAX_DURATION}ms total movement.`);
}

function mapPointerInput(args, shot, displays) {
  if ((args.coordinateSpace || 'desktop') === 'desktop') {
    if (args.screenshotId !== undefined) throw new Error('screenshotId requires coordinateSpace=screenshot; do not mix coordinate frames.');
    return args;
  }
  if (!shot || !args.screenshotId || args.screenshotId !== shot.screenshotId) throw new Error('Use the latest screenshotId from this computer session for screenshot coordinates.');
  const bounds = rectangle({ x: shot.origin?.x, y: shot.origin?.y, width: shot.width * shot.scaleX, height: shot.height * shot.scaleY }, 'Screenshot mapping');
  const display = displays?.find(item => String(item.id) === String(shot.displayId));
  if (!display || !['x', 'y', 'width', 'height'].every(key => Math.abs(display.bounds[key] - bounds[key]) < 0.000001)) throw new Error('Display geometry changed; capture another screenshot before using its coordinates.');
  const image = rectangle({ x: 0, y: 0, width: shot.width, height: shot.height }, 'Screenshot bounds');
  if (shot.scaleX <= 0 || shot.scaleY <= 0) throw new Error('Invalid screenshot scale.');
  for (const point of pointerPoints(args)) if (!inside(point, image)) throw new Error('Pointer coordinates are outside the screenshot bounds.');
  const map = point => ({ x: Math.round(bounds.x + point.x * shot.scaleX), y: Math.round(bounds.y + point.y * shot.scaleY) });
  const mapped = { ...args, coordinateSpace: 'desktop' };
  delete mapped.screenshotId;
  if (args.x !== undefined || args.y !== undefined) Object.assign(mapped, map(args));
  if (args.action === 'drag') { const end = map({ x: args.endX, y: args.endY }); mapped.endX = end.x; mapped.endY = end.y; }
  if (args.strokes) mapped.strokes = args.strokes.map(stroke => ({
    ...stroke,
    points: (stroke.points ?? []).map(map),
    ...(stroke.circle ? { circle: { ...stroke.circle, cx: bounds.x + stroke.circle.cx * shot.scaleX, cy: bounds.y + stroke.circle.cy * shot.scaleY, radius: stroke.circle.radius * Math.sqrt(shot.scaleX * shot.scaleY) } } : {})
  }));
  if (args.region) {
    rectangle(args.region, 'Pointer region');
    if (!contains(image, args.region)) throw new Error('Pointer region is outside the screenshot bounds.');
    mapped.region = { x: bounds.x + args.region.x * shot.scaleX, y: bounds.y + args.region.y * shot.scaleY, width: args.region.width * shot.scaleX, height: args.region.height * shot.scaleY };
  }
  return mapped;
}

function validatePointerBounds(args, desktop, windowBounds) {
  rectangle(desktop, 'Desktop');
  if (args.action === 'stroke') validateStroke(args);
  if (args.region) {
    rectangle(args.region, 'Pointer region');
    if (!args.windowId) throw new Error('Pointer region requires a target windowId.');
    if (!contains(desktop, args.region) || !windowBounds || !contains(windowBounds, args.region)) throw new Error('Pointer region must be entirely inside the target window and desktop.');
  }
  for (const point of pointerPoints(args)) {
    if (!inside(point, desktop)) throw new Error('Pointer coordinates must be inside the physical virtual desktop.');
    if (windowBounds && !inside(point, windowBounds)) throw new Error('Pointer point is outside the target window.');
    if (args.region && !inside(point, args.region)) throw new Error('Pointer point is outside the chosen region.');
  }
}

function pointerGuard(args, desktop, { windowInfo, foregroundWindowId, windowAt, ownsActiveMenu = () => false }) {
  if (args.windowId && !/^\d+$/.test(args.windowId)) throw new Error('Use a windowId from computer_observe.');
  const target = args.windowId ? windowInfo(args.windowId) : null;
  if (args.windowId && (!target || target.minimized)) throw new Error('Target window is unavailable; inspect computer_observe.');
  validatePointerBounds(args, desktop, target?.bounds);
  return point => {
    if (!target) return;
    const live = windowInfo(args.windowId);
    if (!live || live.minimized || live.pid !== target.pid || !['x', 'y', 'width', 'height'].every(key => live.bounds[key] === target.bounds[key])) throw new Error('Target window changed; inspect fresh evidence before continuing.');
    if (foregroundWindowId() !== args.windowId) throw new Error('Target window is not foreground; focus it and inspect before continuing.');
    if (point && (!inside(point, desktop) || !inside(point, target.bounds) || args.region && !inside(point, args.region))) throw new Error('Pointer point is outside the target window or chosen region.');
    if (point) {
      const hit = windowAt(point);
    if (hit !== args.windowId && !(args.action === 'click' && ownsActiveMenu(args.windowId, hit))) throw new Error('Another window covers this pointer point; inspect fresh evidence before continuing.');
    }
  };
}

// Plotter-grade motion planning (adapted from nornagon/saxi's GRBL junction
// velocity — https://github.com/nornagon/saxi, planning.ts): a mark slows for
// corners in proportion to the turn angle, accelerates and brakes with a
// bounded linear acceleration, and lands exactly on its endpoint. Straight
// segments run at cruise speed; a full reversal forces a stop.
const ACCEL_PXMS2 = 0.04;      // linear acceleration budget (px per ms^2)
const CORNER_FACTOR_PX = 8;    // junction deviation analogue (px)
const TICK_MS = 16;

function junctionSpeeds(path) {
  const caps = new Array(path.length).fill(Infinity);
  for (let i = 1; i < path.length - 1; i++) {
    const d1x = path[i].x - path[i - 1].x, d1y = path[i].y - path[i - 1].y;
    const d2x = path[i + 1].x - path[i].x, d2y = path[i + 1].y - path[i].y;
    const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cosine = -(d1x * d2x + d1y * d2y) / (l1 * l2);
    const sine = Math.sqrt(Math.max(0, (1 - cosine) / 2));
    if (Math.abs(sine - 1) < 1e-6) continue; // straight through: uncapped
    caps[i] = Math.sqrt((ACCEL_PXMS2 * CORNER_FACTOR_PX * sine) / (1 - sine));
  }
  return caps;
}

function smoothstep01(x) {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
}

// Time -> arc-position plan (plotter trapezoid, saxi-style): smooth spool-up
// from rest, cruise at the requested speed, deceleration into each junction
// (brake parabola v = sqrt(vJunction^2 + 2a·d) — full speed on straights, a
// slow crossing exactly at corners), and a natural brake curve into the
// endpoint (v = sqrt(2a·R)). Corners honestly COST TIME: the mark takes as
// long as the physics needs (bounded headroom) instead of teleporting.
function planTimeline(lengths, total, duration, caps) {
  const vCruise = total / Math.max(TICK_MS, duration);
  const ramp = Math.max(1, Math.round((duration / TICK_MS) * 0.2));
  const positions = [0];
  let v = 0, s = 0, i = 0, x = 0;
  const maxTicks = Math.max(2, Math.min(1200, Math.ceil((duration / TICK_MS) * 2) + 32));
  for (let tick = 1; tick <= maxTicks && s < total - 1e-9; tick++) {
    while (i < lengths.length - 1 && x >= lengths[i]) { x -= lengths[i]; i += 1; }
    const segLeft = lengths[i] - x;
    const vJunction = caps[Math.min(i + 1, caps.length - 1)] ?? Infinity;
    const cornerBrake = vJunction === Infinity ? Infinity : Math.sqrt((vJunction * vJunction) + 2 * ACCEL_PXMS2 * segLeft);
    const endBrake = Math.sqrt(2 * ACCEL_PXMS2 * (total - s));
    const target = Math.min(vCruise * smoothstep01(tick / ramp), cornerBrake, endBrake);
    v += Math.max(-ACCEL_PXMS2 * TICK_MS, Math.min(ACCEL_PXMS2 * TICK_MS, target - v));
    v = Math.max(0, v);
    if (total - s <= v * TICK_MS) { positions.push(total); break; }
    s = Math.min(total, s + v * TICK_MS);
    x += v * TICK_MS;
    positions.push(s);
  }
  positions[positions.length - 1] = total;
  return positions;
}

function arcCursor(lengths, distance) {
  let acc = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (acc + lengths[i] >= distance) return i;
    acc += lengths[i];
  }
  return lengths.length;
}

async function runStrokes(args, { check, move, button, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  validateStroke(args);
  // Sample every stroke up front: curve expansion and bounds checking happen
  // before any pointer press, so a malformed path never leaves a partial mark.
  const plans = args.strokes.map(stroke => {
    const path = stroke.circle !== undefined
      ? sampleCircle(stroke.circle, args.region)
      : samplePath(stroke.points, stroke.curve, args.region);
    const lengths = path.slice(1).map((point, i) => Math.hypot(point.x - path[i].x, point.y - path[i].y));
    const total = lengths.reduce((sum, length) => sum + length, 0);
    const duration = stroke.durationMs ?? 300;
    const profile = stroke.profile ?? 'ease';
    // 'ease' = plotter-grade: corner caps + accel-limited timeline. 'linear' =
    // constant arc-length speed (precision edges, unchanged behavior).
    const timeline = profile === 'linear'
      ? null
      : planTimeline(lengths, total, duration, junctionSpeeds(path));
    return { stroke, path, lengths, total, duration, profile, timeline };
  });
  let completedStrokes = 0, dispatchedPoints = 0;
  try {
    for (const plan of plans) {
      const { stroke, path, lengths, total, duration, profile, timeline } = plan;
      check(path[0]);
      move(path[0]);
      dispatchedPoints++;
      button(true);
      try {
        const steps = timeline ? timeline.length - 1 : Math.max(1, Math.ceil(duration / TICK_MS));
        let cursor = 0;
        let covered = 0;
        for (let step = 1; step <= steps; step++) {
          await pause(timeline ? TICK_MS : duration / steps);
          const fraction = step / steps;
          const targetDistance = timeline ? timeline[step]
            : (profile === 'linear' ? fraction : minimumJerk(fraction)) * total;
          // Plotter contract: declared vertices are exact via-points. Emit
          // every vertex this step crossed at its exact coordinates (the
          // endpoint included) before interpolating inside the current
          // segment, so corners and pen lifts land precisely where planned.
          while (cursor < lengths.length && covered + lengths[cursor] <= targetDistance + 1e-9) {
            covered += lengths[cursor];
            cursor += 1;
            check(path[cursor]);
            move(path[cursor]);
            dispatchedPoints++;
          }
          if (cursor >= lengths.length || Math.abs(targetDistance - covered) < 1e-9) continue;
          // Walk the sampled path by arc length so pacing controls speed along
          // the mark, not step count per segment.
          const from = path[cursor];
          const to = path[Math.min(cursor + 1, path.length - 1)];
          const segment = lengths[Math.min(cursor, lengths.length - 1)] || 1;
          const local = Math.min(1, Math.max(0, (targetDistance - covered) / segment));
          const point = { x: from.x + (to.x - from.x) * local, y: from.y + (to.y - from.y) * local };
          check(point);
          move(point);
          dispatchedPoints++;
        }
      } finally { button(false); }
      completedStrokes++;
    }
  } catch (error) {
    throw new Error(`Stroke batch stopped after ${completedStrokes}/${args.strokes.length} completed strokes; the current stroke may be partial. Do not replay completed strokes blindly. ${error.message}`);
  }
  return { dispatched: true, action: 'stroke', completedStrokes, dispatchedPoints, endpoint: plans.at(-1).path.at(-1), verification: 'Input dispatched only; inspect the visible result before claiming task success.' };
}
module.exports = { mapPointerInput, validateStroke, validatePointerBounds, pointerGuard, runStrokes, samplePath, sampleCircle, circlePoints, minimumJerk, junctionSpeeds, planTimeline, CURVE_MODES, PROFILES };
