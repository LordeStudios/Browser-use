/* AGENT ORB — the live "what is happening" visualization.
 *
 * One particle field, several SHAPES, so the state of the run is legible at a
 * glance without a sentence:
 *
 *   thinking  sphere          steady, slow — the model is deliberating
 *   deep      double shell    two counter-rotating shells — long deliberation
 *   planning  3-D lattice     points snap into a matrix — a plan is being set
 *   acting    cube            fast rotation, sphere<->cube — work is executing
 *   waiting   torus           a slow ring pulse — the agent needs the user
 *   error     shatter         red, jittering outward — provider/network fault
 *
 * Transitions MORPH: every particle eases from its current position to the new
 * shape, so a state change reads as the same object changing form rather than
 * one spinner being swapped for another. Colour eases on the same clock.
 *
 * The module is a classic script (no bundler) and exports window.AgentOrb.
 */
(function (global) {
  'use strict';

  var PARTICLE_COUNT = 150;
  var MORPH_MS = 300;

  // MOTION MODEL
  // ------------
  // Rotation alone reads as slow, and for a SPHERE it is not even visible: an
  // evenly spread sphere of dots is rotationally invariant, so spinning it
  // changes nothing the eye can catch. That is why the old model still felt
  // frozen no matter how much spin was added. The motion has to come from the
  // PARTICLES themselves:
  //
  //   spin       rotation speed, rad/s (a silhouette cue for cubes and lattices)
  //   breathe    depth of the whole-field silhouette pulse
  //   pulseMs    period of that pulse
  //   waveMs     period of the travelling brightness wave (shorter = faster)
  //   shimmer    amplitude of that wave
  //   wobble     per-particle organic drift, in shape units — every dot churns,
  //              which is what makes a sphere read as alive. STRUCTURED shapes
  //              (lattice, cube) deliberately get very little: they are not
  //              rotationally symmetric, so their rotation is already visible,
  //              and churning them just blurs the grid into a cloud.
  //   pulseDepth per-particle radial in/out, so the surface itself ripples
  //
  // `waiting` is the one state that SHOULD feel calm — it means the agent is
  // idle until the user answers — so it is the only slow one.
  var MODES = {
    thinking: { shape: 'sphere', color: [200, 255, 0], spin: 2.4, breathe: 0.06, pulseMs: 620, waveMs: 420, shimmer: 0.55, wobble: 0.062, pulseDepth: 0.055, jitter: 0, label: 'Thinking' },
    deep: { shape: 'shell', color: [150, 240, 255], spin: 1.7, breathe: 0.07, pulseMs: 860, waveMs: 640, shimmer: 0.46, wobble: 0.05, pulseDepth: 0.045, jitter: 0, label: 'Thinking deeply' },
    planning: { shape: 'lattice', color: [200, 255, 0], spin: 2.1, breathe: 0.03, pulseMs: 500, waveMs: 380, shimmer: 0.75, wobble: 0.01, pulseDepth: 0.012, jitter: 0, label: 'Planning' },
    acting: { shape: 'cube', color: [200, 255, 0], spin: 3.6, breathe: 0.035, pulseMs: 420, waveMs: 300, shimmer: 0.9, wobble: 0.012, pulseDepth: 0.014, jitter: 0, label: 'Working' },
    waiting: { shape: 'torus', color: [255, 196, 80], spin: 0.72, breathe: 0.1, pulseMs: 1500, waveMs: 1500, shimmer: 0.26, wobble: 0.022, pulseDepth: 0.02, jitter: 0, label: 'Waiting for you' },
    error: { shape: 'shatter', color: [239, 79, 100], spin: 2.6, breathe: 0.04, pulseMs: 300, waveMs: 240, shimmer: 1, wobble: 0.03, pulseDepth: 0.05, jitter: 0.09, label: 'Error' },
    idle: { shape: 'sphere', color: [140, 160, 165], spin: 0.5, breathe: 0.02, pulseMs: 1200, waveMs: 1800, shimmer: 0.14, wobble: 0.02, pulseDepth: 0.015, jitter: 0, label: 'Idle' }
  };

  function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
  }

  // Fibonacci sphere: even coverage, no polar clustering.
  function spherePoint(index, count, radius) {
    var r = radius == null ? 1 : radius;
    var offset = 2 / count;
    var y = index * offset - 1 + offset / 2;
    var ring = Math.sqrt(Math.max(0, 1 - y * y));
    var theta = index * Math.PI * (3 - Math.sqrt(5));
    return { x: Math.cos(theta) * ring * r, y: y * r, z: Math.sin(theta) * ring * r };
  }

  // Cube SURFACE points, so the shape reads as an edge-lit wireframe of dots
  // rather than a solid blob.
  function cubePoint(index, count, radius) {
    var h = radius == null ? 0.86 : radius;
    var face = index % 6;
    var u = (((index * 37) % 100) / 50 - 1) * h;
    var v = (((index * 61) % 100) / 50 - 1) * h;
    if (face === 0) return { x: h, y: u, z: v };
    if (face === 1) return { x: -h, y: u, z: v };
    if (face === 2) return { x: u, y: h, z: v };
    if (face === 3) return { x: u, y: -h, z: v };
    if (face === 4) return { x: u, y: v, z: h };
    return { x: u, y: v, z: -h };
  }

  // 5 x 5 x 6 = 150: a matrix that reads as "a plan being laid out".
  function latticePoint(index) {
    var cols = 5;
    var rows = 5;
    var layers = 6;
    var x = index % cols;
    var y = Math.floor(index / cols) % rows;
    var z = Math.floor(index / (cols * rows)) % layers;
    return {
      x: (x / (cols - 1) - 0.5) * 1.62,
      y: (y / (rows - 1) - 0.5) * 1.62,
      z: (z / (layers - 1) - 0.5) * 1.62
    };
  }

  function torusPoint(index, count) {
    var u = (index / count) * Math.PI * 2;
    // Golden angle around the tube keeps the ring evenly speckled.
    var v = index * 2.399963229728653;
    // The hole has to survive a 56px canvas: a fat tube reads as a blob, and
    // "waiting" then looks like "thinking" in a different colour.
    var big = 1.06;
    var small = 0.24;
    return {
      x: (big + small * Math.cos(v)) * Math.cos(u),
      y: small * Math.sin(v),
      z: (big + small * Math.cos(v)) * Math.sin(u)
    };
  }

  function shatterPoint(index, count) {
    var base = spherePoint(index, count, 1);
    var push = 1.16 + ((index * 97) % 100) / 100 * 0.6;
    return { x: base.x * push, y: base.y * push, z: base.z * push };
  }

  function shapePoint(shape, index, count) {
    switch (shape) {
      case 'cube': return cubePoint(index, count);
      case 'lattice': return latticePoint(index);
      case 'torus': return torusPoint(index, count);
      case 'shatter': return shatterPoint(index, count);
      case 'shell': {
        // Two shells: the even indices ride the outer shell, the odd ones the
        // inner. Rendered as one field, it reads as a dense, thinking core.
        var outer = spherePoint(index, count, 1);
        if (index % 2 === 0) return outer;
        var inner = spherePoint(index, count, 0.56);
        return { x: inner.x, y: inner.y, z: inner.z };
      }
      default: return spherePoint(index, count, 1);
    }
  }

  function easeOutCubic(t) {
    var p = 1 - t;
    return 1 - p * p * p;
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Mount an orb on a canvas.
   * @returns {{setMode:Function,setSize:Function,pause:Function,resume:Function,dispose:Function,getMode:Function}}
   */
  function createAgentOrb(canvas, options) {
    var settings = options || {};
    var context = canvas.getContext('2d');
    var dpr = 1;
    var cssSize = 56;
    var modeName = settings.mode && MODES[settings.mode] ? settings.mode : 'thinking';
    // A caller may want a calmer (or livelier) wave than the state's default —
    // the floating desktop bubble is smaller and sits behind other windows, so
    // it takes a gentler shimmer than the orb above the composer.
    var shimmerOverride = typeof settings.shimmer === 'number' ? settings.shimmer : null;
    var reducedMotion = false;
    try {
      reducedMotion = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches === true;
    } catch (error) { /* matchMedia is optional in a bare harness */ }

    var current = [];
    var from = [];
    var target = [];
    var morphT = 1;
    var color = MODES[modeName].color.slice();
    var colorFrom = color.slice();
    var colorTo = color.slice();
    var colorT = 1;
    var frame = 0;
    var disposed = false;
    var paused = false;
    var startedAt = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    var lastTick = startedAt;
    // Pointer interaction: the field is a physical thing the cursor can push
    // through, so it reacts instead of ignoring the user. `vx`/`vy` carry the
    // cursor's own motion, which is what makes a fast swipe fling the dots
    // further than a slow one.
    var pointer = { x: 0, y: 0, vx: 0, vy: 0, active: false, strength: 0 };
    // Per-particle collision state. Keeping BOTH the offset from the natural
    // position and the velocity that carries it means a dot is knocked, keeps
    // momentum, rubs against friction and is pulled home by a spring — instead
    // of being teleported outward on a radial formula and snapped back when the
    // pointer leaves.
    var dispX = new Float32Array(PARTICLE_COUNT);
    var dispY = new Float32Array(PARTICLE_COUNT);
    var velX = new Float32Array(PARTICLE_COUNT);
    var velY = new Float32Array(PARTICLE_COUNT);

    function now() {
      return (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    }

    function rebuild() {
      var preset = MODES[modeName] || MODES.thinking;
      from = current.length === PARTICLE_COUNT ? current.map(function (p) { return { x: p.x, y: p.y, z: p.z }; }) : [];
      target = [];
      for (var index = 0; index < PARTICLE_COUNT; index += 1) {
        target.push(shapePoint(preset.shape, index, PARTICLE_COUNT));
      }
      if (!from.length) from = target.map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
      current = from.map(function (p) { return { x: p.x, y: p.y, z: p.z }; });
      morphT = 0;
      colorFrom = color.slice();
      colorTo = preset.color.slice();
      colorT = 0;
    }

    function setMode(name) {
      var next = MODES[name] ? name : 'thinking';
      if (next === modeName) return;
      modeName = next;
      rebuild();
    }

    function setSize(px) {
      var size = clamp(Number(px) || 56, 16, 240);
      cssSize = size;
      dpr = clamp((global.devicePixelRatio || 1), 1, 3);
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
    }

    function paint(timestamp) {
      if (disposed) return;
      if (paused) { frame = 0; return; }
      var preset = MODES[modeName] || MODES.thinking;
      var delta = Math.max(0, Math.min(64, timestamp - lastTick));
      lastTick = timestamp;

      if (morphT < 1) {
        morphT = clamp(morphT + delta / MORPH_MS, 0, 1);
        var eased = easeOutCubic(morphT);
        for (var i = 0; i < PARTICLE_COUNT; i += 1) {
          current[i].x = lerp(from[i].x, target[i].x, eased);
          current[i].y = lerp(from[i].y, target[i].y, eased);
          current[i].z = lerp(from[i].z, target[i].z, eased);
        }
      }
      if (colorT < 1) {
        colorT = clamp(colorT + delta / MORPH_MS, 0, 1);
        var mix = easeOutCubic(colorT);
        color = [
          Math.round(lerp(colorFrom[0], colorTo[0], mix)),
          Math.round(lerp(colorFrom[1], colorTo[1], mix)),
          Math.round(lerp(colorFrom[2], colorTo[2], mix))
        ];
      }

      var elapsed = timestamp - startedAt;
      var pulseMs = preset.pulseMs || 700;
      // Period of the travelling brightness wave. Shorter = the light sweeps
      // through the field faster, which is most of what reads as "busy".
      var waveMs = reducedMotion ? 3000 : (preset.waveMs || 420);
      var spin = reducedMotion ? 0.7 : elapsed / 1000 * preset.spin;
      var tilt = reducedMotion ? 0.3 : 0.3 + Math.sin(elapsed / 2200) * 0.2;
      var breathe = reducedMotion ? 1 : 1 + Math.sin(elapsed / pulseMs) * preset.breathe;
      var shimmer = reducedMotion ? 0 : (shimmerOverride !== null ? shimmerOverride : (preset.shimmer || 0));
      var cosY = Math.cos(spin);
      var sinY = Math.sin(spin);
      var cosX = Math.cos(tilt);
      var sinX = Math.sin(tilt);
      var radius = (cssSize / 2) * 0.72 * breathe;
      var fov = 2.7;
      var center = cssSize / 2;
      var rgb = color[0] + ', ' + color[1] + ', ' + color[2];
      // The cursor's reach and impulse, scaled with the orb so the same feel
      // holds in the 56px dock and the 62px desktop bubble.
      var reachRadius = cssSize * 0.5;
      var pushPeak = cssSize * 0.016;
      var brownian = reducedMotion ? 0 : cssSize * 0.0035;
      // Spring home + friction: these two decide how long a scatter lasts.
      // The spring is what makes the displacement TEMPORARY without a timer.
      var springK = 0.075;
      var friction = 0.9;
      // Ease the interaction in and out — but NOT symmetrically. A cursor
      // arriving is a collision: it has to register within a frame or two, or a
      // quick sweep through the orb passes before the field has noticed. A
      // cursor leaving is a release: that one decays gently so the scatter is
      // allowed to play out instead of being cut off.
      var pointerTarget = pointer.active ? 1 : 0;
      var easeRate = pointer.active ? delta / 26 : delta / 55;
      pointer.strength += (pointerTarget - pointer.strength) * Math.min(1, easeRate);
      if (pointer.strength < 0.005) pointer.strength = 0;
      // The cursor's velocity is per-event, so it has to decay on the frame
      // clock or a single fast swipe would keep pushing forever.
      pointer.vx *= 0.78;
      pointer.vy *= 0.78;

      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, cssSize, cssSize);

      for (var index = 0; index < PARTICLE_COUNT; index += 1) {
        var point = current[index];
        var jitter = preset.jitter;
        var jx = point.x;
        var jy = point.y;
        var jz = point.z;
        // ORGANIC CHURN. Each dot drifts on its own slow orbit, so the field is
        // never the same picture twice. This is the dial that fixes "it feels
        // slow" for the sphere states, where rotation is invisible by symmetry.
        var wobble = reducedMotion ? 0 : (preset.wobble || 0);
        if (wobble > 0) {
          var wp = index * 2.399963;
          jx += Math.sin(elapsed / 430 + wp) * wobble;
          jy += Math.cos(elapsed / 520 + wp * 1.31) * wobble;
          jz += Math.sin(elapsed / 370 + wp * 0.77) * wobble;
        }
        if (jitter > 0) {
          // Deterministic per-particle phase so the shatter looks like one
          // field shaking, not 150 independent random walks.
          var phase = index * 0.37;
          jx += Math.sin(elapsed / 90 + phase) * jitter;
          jy += Math.cos(elapsed / 74 + phase) * jitter;
          jz += Math.sin(elapsed / 110 + phase * 1.7) * jitter;
        }
        // Per-particle radial ripple: the surface breathes dot by dot rather
        // than the whole silhouette scaling at once.
        var pulseDepth = reducedMotion ? 0 : (preset.pulseDepth || 0);
        if (pulseDepth > 0) {
          var ripple = 1 + Math.sin(elapsed / (pulseMs * 1.4) * 6.283185 + index * 0.9) * pulseDepth;
          jx *= ripple;
          jy *= ripple;
          jz *= ripple;
        }
        var rx = jx * cosY - jz * sinY;
        var rz = jx * sinY + jz * cosY;
        var ry = jy * cosX - rz * sinX;
        var rz2 = jy * sinX + rz * cosX;
        var depth = (rz2 + fov) / (2 * fov);
        var scale = radius * (fov / (fov + rz2));
        var px = center + rx * scale;
        var py = center + ry * scale;
        // A band of light travelling around the field. This is what makes the
        // orb read as busy rather than as a rotating object: the image changes
        // every frame even when the shape is standing still. One sine per
        // particle per frame, so it costs almost nothing.
        //
        // It is ADDED to the depth-based brightness, not multiplied by it: a
        // multiplier drove the near particles past full alpha, which clipped
        // the crests flat and made the field look like a solid blob instead of
        // a wave moving through it.
        var wave = shimmer ? Math.sin(elapsed / waveMs * 6.283185 - index * 0.55) * shimmer : 0;
        var alpha = clamp(0.16 + depth * 0.8 + wave * 0.3, 0.04, 1);
        var size = (0.8 + depth * 1.35) * (1 + wave * 0.25);
        // ── COLLISION ────────────────────────────────────────────────────────
        // The cursor is an object moving THROUGH the field, not a magnetic
        // pole. A dot inside the reach takes an impulse along the line from the
        // cursor, plus a share of the cursor's own velocity (it gets dragged),
        // plus a swirl whose sign and magnitude differ per dot. That asymmetry
        // is the point: a purely radial formula produces the perfect ring of
        // repelling that looks fake, because every neighbour answers the same
        // way at the same distance.
        var dspx = dispX[index];
        var dspy = dispY[index];
        var vx = velX[index];
        var vy = velY[index];
        if (pointer.strength > 0) {
          var pdx = px - pointer.x;
          var pdy = py - pointer.y;
          var pd2 = pdx * pdx + pdy * pdy;
          if (pd2 < reachRadius * reachRadius) {
            var pd = Math.sqrt(pd2) || 0.0001;
            var falloff = 1 - pd / reachRadius;
            var hit = falloff * falloff * pointer.strength;
            var nx = pdx / pd;
            var ny = pdy / pd;
            vx += nx * pushPeak * hit;
            vy += ny * pushPeak * hit;
            // Dragged along by the cursor's motion: a quick swipe flings the
            // dots, a slow hover nudges them.
            vx += clamp(pointer.vx, -40, 40) * hit * 0.1;
            vy += clamp(pointer.vy, -40, 40) * hit * 0.1;
            // Per-dot swirl, sign alternating by index: neighbours curl past
            // each other instead of marching outward in lockstep.
            var bias = (((index * 37) % 100) / 50) - 1;
            vx += -ny * pushPeak * hit * 0.8 * bias;
            vy += nx * pushPeak * hit * 0.8 * bias;
          }
        }
        // Brownian motion, but ONLY where the field was actually disturbed.
        // This is the "temporarily" in "temporarily scatter": an untouched dot
        // stays exactly on its orbit, while a struck one wanders as it settles.
        var heat = Math.min(1, (Math.abs(dspx) + Math.abs(dspy)) / (cssSize * 0.1));
        if (brownian > 0 && heat > 0.002) {
          vx += (Math.random() - 0.5) * brownian * (0.3 + heat * 3);
          vy += (Math.random() - 0.5) * brownian * (0.3 + heat * 3);
        }
        // Friction bleeds the momentum, the spring pulls the dot home. Nothing
        // is reset on a timer; the scatter simply dies out.
        vx = (vx - dspx * springK) * friction;
        vy = (vy - dspy * springK) * friction;
        dspx += vx;
        dspy += vy;
        dispX[index] = dspx;
        dispY[index] = dspy;
        velX[index] = vx;
        velY[index] = vy;
        px += dspx;
        py += dspy;
        // A struck dot flares and swells a little, then settles — the visible
        // trace of the hit.
        var flare = Math.min(1, (Math.abs(dspx) + Math.abs(dspy)) / (cssSize * 0.14));
        if (flare > 0) {
          alpha = clamp(alpha + flare * 0.32, 0.04, 1);
          size *= 1 + flare * 0.2;
        }
        // A soft halo on the near particles gives the field depth without a
        // blur filter (which is expensive per-frame). Crests of the wave
        // sparkle too, so the sweep is visible on the silhouette.
        if (depth > 0.62 || wave > 0.55) {
          context.beginPath();
          context.arc(px, py, size * 2.4, 0, Math.PI * 2);
          context.fillStyle = 'rgba(' + rgb + ', ' + (alpha * 0.14).toFixed(3) + ')';
          context.fill();
        }
        context.beginPath();
        context.arc(px, py, size, 0, Math.PI * 2);
        context.fillStyle = 'rgba(' + rgb + ', ' + alpha.toFixed(3) + ')';
        context.fill();
      }

      frame = global.requestAnimationFrame(paint);
    }

    function start() {
      if (disposed || paused || frame) return;
      lastTick = now();
      frame = global.requestAnimationFrame(paint);
    }

    setSize(settings.size || 56);
    rebuild();
    morphT = 1;
    colorT = 1;
    start();

    return {
      setMode: function (name) { setMode(name); start(); },
      getMode: function () { return modeName; },
      setSize: function (px) { setSize(px); start(); },
      // Canvas-local CSS pixels. Passing the pointer through the orb parts the
      // field; clearPointer() lets it spring back. The delta between two calls
      // is the cursor's velocity, which is what lets a swipe fling the dots.
      setPointer: function (x, y) {
        var nx = Number(x) || 0;
        var ny = Number(y) || 0;
        if (pointer.active) {
          pointer.vx = nx - pointer.x;
          pointer.vy = ny - pointer.y;
        } else {
          pointer.vx = 0;
          pointer.vy = 0;
        }
        pointer.x = nx;
        pointer.y = ny;
        pointer.active = true;
        start();
      },
      clearPointer: function () { pointer.active = false; start(); },
      pause: function () { paused = true; if (frame) { global.cancelAnimationFrame(frame); frame = 0; } },
      resume: function () { if (!paused) return; paused = false; lastTick = now(); start(); },
      dispose: function () {
        disposed = true;
        if (frame) { global.cancelAnimationFrame(frame); frame = 0; }
      }
    };
  }

  global.AgentOrb = {
    create: createAgentOrb,
    MODES: MODES,
    PARTICLE_COUNT: PARTICLE_COUNT,
    MORPH_MS: MORPH_MS
  };
})(typeof window !== 'undefined' ? window : globalThis);
