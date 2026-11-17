import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../desktop/renderer/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../desktop/renderer/chat-reference.css', import.meta.url), 'utf8');

// ── The incident ────────────────────────────────────────────────────────────
// `renderChatMessage('error', …)` built an `article` with `hidden = true` and
// returned it WITHOUT appending, for every error kind. Both the run-failure
// card and the non-recoverable tool-failure rows were therefore constructed and
// discarded. The transcript showed a spinner that stopped and no reason — which
// is why a rate-limited provider looked like the agent ignoring the user.

test('an error card is appended, not built and discarded', () => {
  assert.doesNotMatch(
    app,
    /if \(kind === 'error'\) \{ const ghost = document\.createElement\('article'\); ghost\.hidden = true;/,
    'the hidden-ghost branch silently swallows every failure card'
  );
  assert.match(app, /if \(kind === 'error'\) return appendFailureRow\(text, detail, options\);/);
  // And the row really is attached.
  const start = app.indexOf('function appendFailureRow');
  const body = app.slice(start, start + 1400);
  assert.match(body, /chatFeed\(\)\.append\(item\)/, 'the failure row must reach the feed');
});

test('a run failure renders the provider text verbatim in a code element', () => {
  const start = app.indexOf('function renderRunFailure');
  assert.ok(start > 0, 'renderRunFailure must exist');
  const body = app.slice(start, start + 4200);
  assert.match(body, /report\.providerText/, 'the provider sentence must be used');
  assert.match(body, /createElement\('code'\)/, 'it must be a code element so it reads as a quote');
  assert.match(body, /agent-failure-provider/, 'and it must be visually distinguished');
  assert.match(body, /dataset\.failureCardKind/, 'repeated parks of the same kind must collapse into one card');
});

test('a parked run is described as parked, never as finished', () => {
  const start = app.indexOf('function renderRunFailure');
  const body = app.slice(start, start + 4200);
  assert.match(body, /is-parked/, 'the parked variant must be styled differently');
  assert.match(body, /Not finished/, 'the copy must say the run is not finished');
  assert.match(body, /Resuming automatically in about/, 'and when it comes back');
});

test('both park events reach a renderer', () => {
  assert.match(app, /paintRunPark\(event\)/, 'run.escalated / run.parked must be painted');
  assert.match(app, /if \(event\.type === 'run\.escalated' \|\| event\.type === 'run\.parked'\)/);
  assert.match(app, /case 'run\.escalated':/);
  assert.match(app, /case 'run\.parked':/);
});

test('a stopped run leaves a line instead of a hanging thought card', () => {
  assert.match(app, /if \(event\.type === 'run\.cancelled'\) \{[\s\S]{0,400}renderChatMessage\('assistant', detail\)/);
});

// ── Narration + the orb visualization ───────────────────────────────────────
//
// The visualization used to be a transcript CARD ("Still working…") and then a
// working strip. Both were wrong: the user asked for something suspended above
// the composer with no card, the way a voice assistant floats. So the orb now
// lives in `#agent-orb-dock` — a child of the composer form, absolutely
// positioned above it — and the narration line drives it instead of the feed.

const orb = readFileSync(new URL('../desktop/renderer/agentOrb.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../desktop/renderer/index.html', import.meta.url), 'utf8');

test('the still-working sentence is gone', () => {
  assert.doesNotMatch(app, /this model is not streaming reasoning text/);
});

test('narration drives the orb, not a transcript card', () => {
  assert.match(app, /if \(event\.type === 'assistant\.narration'\) \{ hideConnectionNotice\(\); setOrbNarration\(event\.text\); return; \}/);
  const start = app.indexOf('function setOrbNarration');
  assert.ok(start > 0, 'setOrbNarration must exist');
  assert.match(app.slice(start, start + 260), /showOrb\('acting', line\)/, 'an action switches the orb to the acting shape');
  // The removed strip must not come back: a card per action is exactly the
  // thing the user rejected.
  assert.doesNotMatch(app, /function setWorkingNarration/);
  assert.doesNotMatch(app, /agent-message is-working/);
});

test('the orb is dismissed when the run settles', () => {
  for (const type of ['run.completed', 'run.cancelled']) {
    const at = app.indexOf(`if (event.type === '${type}')`);
    assert.ok(at > 0, `${type} must be handled`);
    assert.match(app.slice(at, at + 400), /hideOrb\(\)/, `${type} must clear the orb`);
  }
  // A failure flashes red first — the colour IS the signal — then leaves.
  const failed = app.indexOf("if (event.type === 'run.failed')");
  assert.ok(failed > 0, 'run.failed must be handled');
  assert.match(app.slice(failed, failed + 400), /flashOrbError\(/);
  // A real answer ends the work too.
  const reply = app.indexOf('function renderAssistantReply');
  assert.match(app.slice(reply, reply + 900), /hideOrb\(\)/);
});

test('the orb is suspended above the composer with no card', () => {
  // It is inside the composer form, so it floats over the transcript rather
  // than occupying a slot in it.
  const form = html.slice(html.indexOf('<form class="agent-composer" id="agent-form">'));
  const dock = form.slice(0, form.indexOf('</form>'));
  assert.match(dock, /id="agent-orb-dock"/, 'the dock must sit inside the composer');
  assert.match(dock, /id="agent-orb-canvas"/, 'and own the canvas');
  assert.match(dock, /id="agent-orb-label"/, 'and the caption line');
  assert.doesNotMatch(dock, /class="agent-message/, 'the dock is not a transcript card');
  // Centred, above the bar, and transparent to the pointer.
  const rule = css.slice(css.indexOf('.agent-orb-dock {'), css.indexOf('.agent-orb-dock {') + 400);
  assert.match(rule, /position: absolute/);
  assert.match(rule, /left: 50%/);
  assert.match(rule, /bottom: calc\(100% \+ 4px \+ var\(--orb-lift, 0px\)\)/, 'it hangs just above the message bar, and can be lifted clear of the plan');
  assert.match(rule, /transform: translateX\(-50%\)/, 'and is horizontally centred');
  assert.match(rule, /pointer-events: none/, 'a floating orb must never eat a click');
  // No card chrome: no border, no background box.
  assert.doesNotMatch(rule, /border-radius: 1[0-9]px/, 'the orb dock must not be a rounded card');
  // The halo must be anchored to the CANVAS, not the dock. The caption is laid
  // out below the canvas, so centring the glow on the dock pushed it 8.47px
  // below the particle sphere — measured live — and the orb read as off-centre
  // from its own glow.
  assert.match(dock, /class="agent-orb-stage"/, 'the halo and canvas need a stage that is exactly the canvas box');
  const stage = dock.slice(dock.indexOf('agent-orb-stage'), dock.indexOf('agent-orb-caption'));
  assert.match(stage, /class="agent-orb-halo"/, 'the halo belongs to the stage');
  assert.match(stage, /id="agent-orb-canvas"/, 'and so does the canvas');
  assert.match(css, /\.agent-orb-stage \{[^}]*position: relative/, 'the stage is the halo\'s positioning context');
});

test('the orb is lifted clear of the plan and goal panels', () => {
  // Source-level wiring. The live geometry is verified by
  // scratch/orb-lift-check.mjs (7.6px clearance in every combination); this
  // guards the path that schedules the recompute, because a headless window
  // throttles rAF and would hide a missing call.
  assert.match(app, /function applyOrbLift/, 'the lift must be computed');
  assert.match(app, /--orb-lift/, 'and published as a custom property');
  // Both pill renderers funnel through positionAgentPlan, so scheduling there
  // covers a plan appearing, a goal appearing, and both.
  const position = app.slice(app.indexOf('function positionAgentPlan'), app.indexOf('function positionAgentPlan') + 700);
  assert.match(position, /scheduleOrbLift\(\)/, 'rendering a plan or goal must schedule the lift');
  const show = app.slice(app.indexOf('function showOrb'), app.indexOf('function showOrb') + 900);
  assert.match(show, /scheduleOrbLift\(\)/, 'showing the orb must schedule the lift too');
  // The measured edge is the STRIP, not the pills: the pills animate into place
  // with a translate, so their rects are mid-flight and a transform fires no
  // ResizeObserver. The strip is bottom-anchored, so its top is already final.
  const lift = app.slice(app.indexOf('function applyOrbLift'), app.indexOf('function scheduleOrbLift'));
  assert.match(lift, /agent-progress-strip/, 'the ceiling must come from the stable strip');
  assert.match(lift, /naturalBottom - \(ceiling - GAP\)/, 'and the lift is measured from the dock\'s resting position');
  assert.match(lift, /ceiling === Infinity \? 0/, 'nothing visible must mean no lift at all');
});

test('the visualization is a real particle field with a shape per state', () => {
  for (const shape of ['spherePoint', 'cubePoint', 'latticePoint', 'torusPoint', 'shatterPoint']) {
    assert.match(orb, new RegExp(`function ${shape}`), `${shape} must exist`);
  }
  // Each state the user asked for has its own geometry and colour, so the
  // state is readable without a sentence.
  const modes = orb.slice(orb.indexOf('var MODES ='), orb.indexOf('};', orb.indexOf('var MODES =')) + 2);
  assert.match(modes, /thinking: \{ shape: 'sphere'/);
  assert.match(modes, /planning: \{ shape: 'lattice'/);
  assert.match(modes, /acting: \{ shape: 'cube'/);
  assert.match(modes, /waiting: \{ shape: 'torus'/);
  assert.match(modes, /error: \{ shape: 'shatter'[^}]*color: \[239, 79, 100\]/, 'an error is red');
  assert.match(orb, /function easeOutCubic/, 'transitions morph rather than snap');
  assert.match(orb, /requestAnimationFrame\(paint\)/, 'it must actually animate');
  assert.match(orb, /cancelAnimationFrame/, 'and be disposable');
  // The motion model must be energetic: a fast morph, a spin dial per state and
  // a travelling brightness wave (the thing that stops it reading as frozen).
  assert.match(orb, /var MORPH_MS = 300/);
  assert.match(orb, /shimmer:/, 'each state declares its wave amplitude');
  assert.match(orb, /pulseMs:/, 'and its silhouette pulse period');
  // A sphere of evenly spread dots is rotationally INVARIANT, so spin alone can
  // never make it look alive — every state needs per-particle churn and a wave
  // period short enough to read as motion.
  assert.match(modes, /waveMs:/, 'each state declares a wave period');
  assert.match(modes, /wobble:/, 'and per-particle churn');
  assert.match(modes, /pulseDepth:/, 'and a surface ripple');
  assert.match(orb, /Math\.sin\(elapsed \/ waveMs/, 'the wave must use that period, not a hard-coded one');
  // And the cursor must be able to push through the field — with momentum, not
  // a radial shove that makes a perfect ring.
  assert.match(orb, /setPointer: function/);
  assert.match(orb, /pointer\.strength/);
  assert.match(orb, /pointer\.vx/, 'the cursor\'s own velocity must reach the particles');
  assert.match(orb, /dispX\[index\]/, 'displacement must persist across frames');
  assert.match(orb, /springK/, 'and be pulled home by a spring, not a timer');
  assert.match(orb, /bias = \(\(\(index \* 37\) % 100\) \/ 50\) - 1/, 'each dot swirls differently, so no ring');
});

test('the visualization respects reduced motion', () => {
  assert.match(orb, /prefers-reduced-motion/);
  assert.match(orb, /reducedMotion \? 0\.7 :/, 'a still frame must be possible');
});

test('failure cards and the orb have real styling', () => {
  assert.match(css, /\.agent-message\.is-failure \{/);
  assert.match(css, /\.agent-message\.is-failure\.is-parked \{/);
  assert.match(css, /\.agent-message\.is-failure \.agent-failure-provider code \{/);
  assert.match(css, /\.agent-orb-dock \{/);
  assert.match(css, /\.agent-orb-dock\[data-mode="error"\]/, 'the error state must be visibly red');
  assert.match(css, /\.agent-orb-dock\[data-mode="waiting"\]/, 'and waiting must be visually distinct');
});
