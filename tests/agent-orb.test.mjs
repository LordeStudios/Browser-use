import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// AGENT ORB — the suspended particle visualization above the composer.
//
// This runs the real `agentOrb.js` inside a VM with a fake canvas and a manual
// animation clock, so the assertions are about what the orb actually DRAWS and
// WHEN, not about whether some string appears in the source.
//
// Two things are checked as behaviour, because they are what the user sees:
//  • each state has its own geometry, and the field is MOVING (spin, a
//    travelling brightness wave, a silhouette pulse) rather than rotating
//    slowly like a spinner;
//  • a state change morphs — it neither snaps nor sits still.

const source = readFileSync(new URL('../desktop/renderer/agentOrb.js', import.meta.url), 'utf8');

function harness({ reducedMotion = false, devicePixelRatio = 2 } = {}) {
  let clock = 1000;
  const queue = [];

  // One canvas = one independent orb, each with its own recorded frame.
  function newCanvas() {
    const ops = [];
    const context = {
      setTransform() {},
      // Called once at the start of every paint, so `ops` always holds exactly
      // one frame and never needs slicing.
      clearRect() { ops.length = 0; },
      beginPath() {},
      arc(x, y, r) { ops.push({ k: 'arc', x, y, r }); },
      fill() { ops.push({ k: 'fill', alpha: alphaOf(context.fillStyle) }); },
      fillStyle: ''
    };
    const surface = {
      ops,
      context,
      canvas: { width: 0, height: 0, style: {}, getContext: () => context },
      get arcs() { return ops.filter((op) => op.k === 'arc').map((op) => ({ x: op.x, y: op.y, r: op.r })); },
      // The solid dots, in particle order. A near particle is drawn as a halo
      // followed by its dot, and the halo is EXACTLY 2.4x the dot's radius and
      // 0.14x its alpha — checking both makes the pair unambiguous, which a
      // radius test alone is not (a dot can be 2.4x smaller than the next
      // particle's halo by coincidence).
      get dots() {
        const out = [];
        for (let index = 0; index < ops.length; index += 1) {
          const arc = ops[index];
          if (arc.k !== 'arc') continue;
          const fill = ops[index + 1];
          if (!fill || fill.k !== 'fill') continue;
          const nextArc = ops[index + 2];
          const nextFill = ops[index + 3];
          const isHalo = nextArc && nextFill
            && nextArc.k === 'arc' && nextFill.k === 'fill'
            && Math.abs(arc.r - nextArc.r * 2.4) < 0.05
            && Math.abs(fill.alpha - nextFill.alpha * 0.14) < 0.002;
          if (isHalo) continue;
          out.push({ x: arc.x, y: arc.y, r: arc.r, alpha: fill.alpha });
        }
        return out;
      }
    };
    return surface;
  }

  const sandbox = {
    Math,
    console,
    devicePixelRatio,
    performance: { now: () => clock },
    requestAnimationFrame: (callback) => { queue.push(callback); return queue.length; },
    cancelAnimationFrame: (handle) => { queue[handle - 1] = null; },
    matchMedia: (query) => ({ matches: reducedMotion && /prefers-reduced-motion/.test(query) })
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);

  // Advance the clock in real display-sized frames. The renderer clamps its
  // delta to 64ms per frame (so a backgrounded tab cannot teleport the morph),
  // so jumping the clock in one go would not advance the animation at all.
  function tick(ms = 16) {
    const steps = Math.max(1, Math.round(ms / 16));
    const step = ms / steps;
    for (let index = 0; index < steps; index += 1) {
      clock += step;
      const pending = queue.splice(0, queue.length);
      for (const callback of pending) if (typeof callback === 'function') callback(clock);
    }
  }

  return { AgentOrb: sandbox.AgentOrb, newCanvas, tick, pending: queue };
}

// A frame is every arc drawn since the last clear, rounded so comparisons are
// about geometry rather than float noise.
function frame(arcs) {
  return arcs.map((arc) => ({ x: Number(arc.x.toFixed(2)), y: Number(arc.y.toFixed(2)) }));
}

function alphaOf(fillStyle) {
  const match = /rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)/.exec(String(fillStyle));
  return match ? Number(match[1]) : 1;
}

test('every state the user asked for has its own shape', () => {
  const { AgentOrb } = harness();
  assert.ok(AgentOrb, 'the module must export window.AgentOrb');
  assert.equal(AgentOrb.PARTICLE_COUNT, 150);

  const shapes = {
    thinking: 'sphere',
    deep: 'shell',
    planning: 'lattice',
    acting: 'cube',
    waiting: 'torus',
    error: 'shatter'
  };
  for (const [mode, shape] of Object.entries(shapes)) {
    assert.ok(AgentOrb.MODES[mode], `${mode} must exist`);
    assert.equal(AgentOrb.MODES[mode].shape, shape, `${mode} must be a ${shape}`);
  }
  const distinct = new Set(Object.values(AgentOrb.MODES).map((preset) => preset.shape));
  assert.ok(distinct.size >= 5, `states must be visually distinguishable (got ${[...distinct].join(', ')})`);

  const [r, g, b] = AgentOrb.MODES.error.color;
  assert.ok(r > 200 && g < 110 && b < 130, `an error must be red, got ${r},${g},${b}`);
});

test('every state carries an ACTIVE motion profile', () => {
  const { AgentOrb } = harness();
  for (const [mode, preset] of Object.entries(AgentOrb.MODES)) {
    assert.equal(typeof preset.spin, 'number', `${mode} must declare a spin`);
    assert.equal(typeof preset.pulseMs, 'number', `${mode} must declare a pulse period`);
    assert.equal(typeof preset.shimmer, 'number', `${mode} must declare a wave amplitude`);
    assert.equal(typeof preset.waveMs, 'number', `${mode} must declare a wave period`);
    assert.equal(typeof preset.wobble, 'number', `${mode} must declare per-particle churn`);
  }
  // Working states must feel busy, and busy must beat calm by a clear margin —
  // this is the regression that made everything look like it was waiting.
  const { thinking, planning, acting, waiting, error } = AgentOrb.MODES;
  assert.ok(acting.spin >= 3.0, `acting must rotate fast, got ${acting.spin}`);
  assert.ok(thinking.spin >= 2.0, `thinking must not crawl, got ${thinking.spin}`);
  assert.ok(planning.spin >= 1.8, `planning must not crawl, got ${planning.spin}`);
  assert.ok(acting.spin > waiting.spin * 4, 'working must be visibly faster than waiting');
  assert.ok(acting.pulseMs < waiting.pulseMs, 'and its silhouette must pulse more often');
  assert.ok(thinking.shimmer >= 0.5 && acting.shimmer >= 0.5, 'the travelling wave must be present while working');
  // The wave has to sweep through the field quickly enough to read as motion
  // rather than as a slow glow drifting around it.
  assert.ok(thinking.waveMs <= 500, `the wave must sweep quickly, got ${thinking.waveMs}ms`);
  assert.ok(acting.waveMs <= 400, `acting must be quicker still, got ${acting.waveMs}ms`);
  // Rotation is INVISIBLE on a sphere (it is rotationally invariant), so the
  // sphere-family states need per-particle churn or they read as a still image.
  // STRUCTURED shapes are not rotationally symmetric — their spin is already
  // visible — so they get only a trace, otherwise the grid blurs into a cloud
  // and "planning" stops looking like a plan.
  for (const mode of ['thinking', 'deep', 'error']) {
    assert.ok(AgentOrb.MODES[mode].wobble > 0.02, `${mode} must churn its particles, got ${AgentOrb.MODES[mode].wobble}`);
    assert.ok(AgentOrb.MODES[mode].pulseDepth > 0.01, `${mode} must ripple the surface, got ${AgentOrb.MODES[mode].pulseDepth}`);
  }
  for (const mode of ['planning', 'acting']) {
    const preset = AgentOrb.MODES[mode];
    assert.ok(preset.wobble > 0, `${mode} must not be perfectly rigid`);
    assert.ok(preset.wobble < AgentOrb.MODES.thinking.wobble / 2, `${mode} is structured: heavy churn would blur its geometry`);
    assert.ok(preset.spin >= 2.0, `${mode} must carry its motion in the rotation instead`);
  }
  // Waiting is the ONE state allowed to be calm, because it means idle.
  assert.ok(waiting.spin < 0.8, 'waiting should stay calm');
  assert.ok(waiting.wobble < thinking.wobble / 2, 'and its churn must be much gentler');
  assert.ok(error.shimmer >= 0.8, 'an error must be the most agitated state');
  // State changes must be quick enough to read as a reaction.
  assert.ok(AgentOrb.MORPH_MS <= 320, `the morph must be snappy, got ${AgentOrb.MORPH_MS}ms`);
});

test('the travelling wave changes the image, not just the rotation', () => {
  const view = harness();
  // Two orbs created on the SAME clock, same shape, same rotation. The only
  // difference is the per-instance wave amplitude, so any brightness difference
  // is the wave's doing and nothing else.
  const waved = view.newCanvas();
  const flat = view.newCanvas();
  view.AgentOrb.create(waved.canvas, { size: 56, mode: 'thinking' });
  view.AgentOrb.create(flat.canvas, { size: 56, mode: 'thinking', shimmer: 0 });
  view.tick(120);

  const wavedDots = waved.dots;
  const flatDots = flat.dots;
  assert.equal(wavedDots.length, 150, 'the dot filter must find one dot per particle');
  assert.equal(flatDots.length, 150);

  // Same rotation, same geometry — the positions must agree, or the
  // brightness comparison would be meaningless.
  const worst = wavedDots.reduce((max, dot, index) => Math.max(max, Math.hypot(dot.x - flatDots[index].x, dot.y - flatDots[index].y)), 0);
  assert.ok(worst < 0.5, `both orbs must be in the same position (drift ${worst.toFixed(2)}px)`);

  // …but the brightness must not be flat: that band of light is the motion.
  const mean = wavedDots.reduce((total, dot, index) => total + Math.abs(dot.alpha - flatDots[index].alpha), 0) / wavedDots.length;
  assert.ok(mean > 0.05, `the wave must modulate the field (mean brightness difference ${mean.toFixed(3)})`);
  const distinct = new Set(wavedDots.map((dot) => dot.alpha.toFixed(2))).size;
  assert.ok(distinct > 20, `the field must not collapse to a few brightness levels (${distinct} levels)`);
});

test('the pointer physically parts the field', () => {
  const view = harness();
  // Two orbs on the same clock: same rotation, same shape. One has the cursor
  // inside it, so every difference is the collision response.
  const touched = view.newCanvas();
  const untouched = view.newCanvas();
  const orb = view.AgentOrb.create(touched.canvas, { size: 56, mode: 'thinking' });
  view.AgentOrb.create(untouched.canvas, { size: 56, mode: 'thinking' });
  view.tick(80);

  // The cursor sits at the centre of a 56px canvas.
  orb.setPointer(28, 28);
  view.tick(160); // let the interaction ease in

  const near = touched.dots;
  const far = untouched.dots;
  assert.equal(near.length, 150);
  assert.equal(far.length, 150);

  const dist = (dot) => Math.hypot(dot.x - 28, dot.y - 28);
  let pushedOut = 0;
  let pushedIn = 0;
  let untouchedDrift = 0;
  let untouchedCount = 0;
  for (let index = 0; index < near.length; index += 1) {
    const before = dist(far[index]);
    const after = dist(near[index]);
    if (before < 20) {
      // Inside the cursor's reach: the particle must move AWAY from it.
      if (after > before + 0.5) pushedOut += 1;
      if (after < before - 0.5) pushedIn += 1;
    } else if (before > 40) {
      untouchedDrift += Math.abs(after - before);
      untouchedCount += 1;
    }
  }
  assert.ok(pushedOut > 5, `particles near the cursor must be shoved outward (${pushedOut} moved out, ${pushedIn} moved in)`);
  assert.ok(pushedOut > pushedIn * 3, 'and the shove must dominate any incidental movement');
  // Far from the cursor nothing should change at all.
  const drift = untouchedDrift / Math.max(1, untouchedCount);
  assert.ok(drift < 0.5, `particles outside the reach must not move (mean drift ${drift.toFixed(2)}px)`);

  // A real collision is NOT a symmetric ring. Neighbours must scatter by
  // different amounts and in different directions — some curling PAST the
  // cursor rather than straight away from it — because each dot gets its own
  // swirl and share of the cursor's drag. A purely radial formula answers
  // identically at equal distance, and that perfect ring is exactly what read
  // as fake.
  let tangential = 0;
  const magnitudes = [];
  for (let index = 0; index < near.length; index += 1) {
    const bx = far[index].x;
    const by = far[index].y;
    const dx = near[index].x - bx;
    const dy = near[index].y - by;
    const len = Math.hypot(dx, dy);
    if (len < 0.6) continue;
    magnitudes.push(len);
    const rx = bx - 28;
    const ry = by - 28;
    const rlen = Math.hypot(rx, ry) || 1;
    const radial = (dx * rx + dy * ry) / rlen;
    const tan = Math.abs((-dx * ry + dy * rx) / rlen);
    if (tan > Math.abs(radial) * 0.3) tangential += 1;
  }
  assert.ok(tangential >= 5, `scatter must not be purely radial (${tangential} dots moved tangentially)`);
  const spread = Math.max(...magnitudes) - Math.min(...magnitudes);
  assert.ok(spread > 1.5, `neighbouring dots must scatter by different amounts, not as one shell (spread ${spread.toFixed(2)}px)`);

  // Pulling the pointer away lets the field settle back. The release is
  // deliberately not instant — a struck dot keeps its momentum and drifts home
  // under the spring — so the window has to be long enough for that to play out
  // rather than long enough for a snap-back.
  orb.clearPointer();
  view.tick(900);
  const settled = touched.dots;
  // Read the untouched orb at the SAME instant: 900ms of rotation has passed,
  // so its earlier snapshot is no longer a valid reference.
  const reference = untouched.dots;
  const settledDrift = settled.reduce((total, dot, index) => total + Math.abs(dist(dot) - dist(reference[index])), 0) / settled.length;
  assert.ok(settledDrift < 0.6, `the field must spring back once the pointer leaves (drift ${settledDrift.toFixed(2)}px)`);
});

test('a state change MORPHS: it neither snaps nor stays put', () => {
  const view = harness();
  // Two orbs on ONE clock. Comparing screen positions over time would be
  // confounded by the rotation, so the settled target is a second orb that was
  // already in the destination shape, at the same rotation phase.
  const moving = view.newCanvas();
  const reference = view.newCanvas();
  const orb = view.AgentOrb.create(moving.canvas, { size: 56, mode: 'thinking' });
  view.AgentOrb.create(reference.canvas, { size: 56, mode: 'acting' });
  view.tick();

  const sphere = frame(moving.arcs);
  assert.notDeepEqual(frame(reference.arcs), sphere, 'the two shapes must start different');

  orb.setMode('acting');
  view.tick(16);
  const early = frame(moving.arcs);
  assert.notDeepEqual(early, sphere, 'the first frame after the change must already move');
  assert.notDeepEqual(early, frame(reference.arcs), 'but it must not have arrived yet — a snap is not a morph');

  view.tick(view.AgentOrb.MORPH_MS + 120);
  const settled = frame(moving.arcs);
  const target = frame(reference.arcs);
  assert.equal(settled.length, target.length, 'both frames must contain the same number of arcs');
  const worst = settled.reduce((max, point, index) => Math.max(max, Math.hypot(point.x - target[index].x, point.y - target[index].y)), 0);
  assert.ok(worst < 0.5, `the morph must converge exactly on the target shape (worst drift ${worst.toFixed(2)}px)`);
});

test('an error state turns the field red', () => {
  const view = harness();
  const surface = view.newCanvas();
  const orb = view.AgentOrb.create(surface.canvas, { size: 56, mode: 'thinking' });
  view.tick();
  orb.setMode('error');
  view.tick(16);
  view.tick(600); // finish the colour ease
  const painted = String(surface.context.fillStyle);
  assert.match(painted, /rgba\(239, 79, 100,/, `the error field must be red, got ${painted}`);
});

test('reduced motion produces a still frame, not a stopped orb', () => {
  const view = harness({ reducedMotion: true });
  const surface = view.newCanvas();
  view.AgentOrb.create(surface.canvas, { size: 56, mode: 'thinking' });
  view.tick();
  const first = frame(surface.arcs);
  view.tick(500);
  const second = frame(surface.arcs);
  assert.deepEqual(second, first, 'with reduced motion the field must not move');
  assert.ok(first.some((point) => point.x !== 0 || point.y !== 0), 'but it must still be drawn');
});

test('dispose stops the animation loop', () => {
  const view = harness();
  const surface = view.newCanvas();
  const orb = view.AgentOrb.create(surface.canvas, { size: 56, mode: 'thinking' });
  view.tick();
  const painted = frame(surface.arcs);
  orb.dispose();
  view.tick(16);
  view.tick(16);
  assert.deepEqual(frame(surface.arcs), painted, 'no frame may paint after dispose');
});

test('pause holds the field and resume continues it', () => {
  const view = harness();
  const surface = view.newCanvas();
  const orb = view.AgentOrb.create(surface.canvas, { size: 56, mode: 'thinking' });
  view.tick();
  const painted = frame(surface.arcs);
  orb.pause();
  view.tick(200);
  assert.deepEqual(frame(surface.arcs), painted, 'a paused orb must not repaint');
  orb.resume();
  view.tick(120);
  assert.notDeepEqual(frame(surface.arcs), painted, 'and it must come back');
});

test('the canvas is sized for the display density', () => {
  const view = harness({ devicePixelRatio: 2 });
  const surface = view.newCanvas();
  const orb = view.AgentOrb.create(surface.canvas, { size: 56 });
  assert.equal(surface.canvas.width, 112, 'a 56px orb on a 2x display needs 112 device pixels');
  assert.equal(surface.canvas.style.width, '56px', 'but must occupy 56 CSS pixels');
  orb.setSize(96);
  assert.equal(surface.canvas.width, 192);
  orb.setSize(9999);
  assert.equal(surface.canvas.width, 480, 'the size must be clamped rather than accepted blindly');
});

test('an unknown mode falls back instead of throwing', () => {
  const view = harness();
  const surface = view.newCanvas();
  const orb = view.AgentOrb.create(surface.canvas, { mode: 'nonsense' });
  assert.equal(orb.getMode(), 'thinking');
  orb.setMode('also-nonsense');
  assert.equal(orb.getMode(), 'thinking');
  view.tick();
  assert.ok(surface.arcs.length >= 150, 'and it must still paint');
});
