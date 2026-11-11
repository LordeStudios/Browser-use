'use strict';

// PROMPT SECTIONS - the ONLY home of harness prompt text.
//
// Discipline (matched to the reference harness): the identity is ONE sentence,
// no section exceeds ~440 chars, and per-tool guidance lives in the tool's own
// schema - never here. The loop enforces behaviour; the prompt does not
// describe it. Where this harness needs more than the reference (a browser +
// native desktop surface with an honest-blocked contract), the extra rule is
// stated once, in one paragraph, and never duplicated.

const { PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, ORDERS } = require('../harness/identity.cjs');

const { hasModelingApp, hasDrawingApp } = require('../../computer/computerCatalog.cjs');

// Situational creative playbooks: NOT prompt sections. They are attached to
// the creative computer tools' schemas (see computerCatalog.cjs), so they ride
// only when the surface they describe is actually in play. Content is pinned
// by tests (plan-first decomposition, relative proportions, anti-blocky
// mandate, typed dimensions) - it is field-proven procedure, not prose.
const MODELING_PLAYBOOK = ' Modeling or drawing a multi-part OBJECT in a native 3D/CAD app works the way a human modeler works: PLAN the whole object FIRST in one decision - a short ordered list of named parts, structural base/backbone first, then major features, then separable sub-features, with each part carrying its relative size as a percentage of the whole or of the part it mounts onto, its aspect (long-and-thin vs squat vs tapered), its pose (tilt/splay/axle direction), and which earlier part it attaches to; screws, seams and lettering are detail inside a part\'s pass, never separate steps. Then build ONE part at a time to completion in that order - each part physically seats on an already-built one - and screenshot ONCE per completed part to compare proportions against the plan, not per click. Use typed/keyboard entry (Create-panel keyboard-entry rollouts, numeric fields, transform type-ins) for exact dimensions instead of drag-proportioning - a mouse-drag in a perspective viewport lands arbitrary values. A stack of untouched default primitives (raw boxes/cylinders/spheres left axis-aligned at default proportions) is a failure: immediately reshape every primitive to the planned aspect and pose - non-uniform scale, taper/bend/twist modifiers, editable-poly vertex edits, lathe/loft from profile splines - and never flatten a clearly-angled part to axis-aligned. For mirror twins model ONE side to completion and instance/mirror it; do not re-model each side. Reuse the dimensions of already-built neighbours so the object stays one consistent scale. Finish with a whole-object pass: screenshot, compare silhouette and part proportions against the plan, repair drift.';

const DRAWING_PLAYBOOK = ' Native drawing: required apps, tools and execution methods are part of correctness - when the user requires native UI or a particular drawing tool, do not substitute scripts, generated files, imports, clipboard images or another app. For drawing, visually locate the target window, active tool and drawable region, then plan related polylines together with computer_stroke rather than replan every mark; prefer curve=catmull-rom with sparse waypoints for smooth natural marks (the engine samples the curve and paces it with a natural speed profile), and reserve profile=linear for precision edges. For geometric shapes declare a circle descriptor (cx, cy, radius, optional startDeg/endDeg arcs) instead of computing trigonometry tables in reasoning - the engine samples exact polar points, and a five-waypoint spline is geometrically a rounded polygon, not a circle. Omit unused optional arguments or use null; never invent dummy points or rectangles. Batch predictable native keyboard sequences in one decision, but inspect the newly opened app before choosing canvas coordinates; initial launch-window bounds may still be changing. After one fresh inspection, co-emit the whole stable-geometry chain in the same decision - arm the tool, pick the color, place the stroke - instead of spending one provider round trip per mechanical step; the only forbidden batching is a later action whose coordinates depend on an unseen result. Keep useful anchors and completed features in optional memoryUpdate; reconcile them with fresh pixels instead of restarting the same outline. A dispatched stroke only proves input was sent, not that the intended feature or likeness was achieved. Inspect fresh native evidence before claiming success; report partial or inaccurate work honestly. Native visual work cannot proceed from unrelated browser DOM when images are unavailable.';

// ---- Persona (deployment:persona-prefix) --------------------------------
// Identity is ONE sentence, like the reference harness. One output-discipline
// sentence follows; everything else the old prompt explained is now enforced
// by the loop (repeat guard, evidence epoch, read-only cap, stall detectors).
const PERSONA_PREFIX = [
 'You are an AI agent powered by the Browser-use harness.',
 'Every decision is one executable step: a tool call, a batch of independent calls, or browser_done. Act the moment the next action is clear; after each result mention only NEW evidence and the next action.'
].join('\n\n');

// ---- Policies -------------------------------------------------------------
const EVIDENCE_POLICY = [
 'EVIDENCE - Act on the newest evidence; never re-read unchanged page, file, or desktop state. After a mutation continue with the next grounded mutation; observe again only for new state or final confirmation. Claim an effect only on fresh evidence: dispatch proves input arrived, not that it landed.'
].join('\n\n');

const FAILURE_POLICY = [
 'FAILURE - When an action fails your model was wrong, not the input: make the next attempt materially different or name the missing fact.'
].join('\n\n');

function approvalPolicySection(ctx) {
 return ctx.approvalMode === 'unattended'
 ? 'APPROVAL - Unattended run: dangerous tools execute without asking; prefer reversible steps when the outcome is ambiguous.'
 : 'APPROVAL - Dangerous tools pause for the user\'s decision; state what will run, why, and what it touches in the call itself.';
}

// completion: the browser_done contract, in one paragraph.
const COMPLETION_POLICY = [
 'COMPLETION - Call browser_done only when the WHOLE requested outcome is present and supported by evidence: every plan item done or explicitly skipped, every sub-request addressed, every spawned subagent\'s findings acted on. When one part finishes, continue with the next and never narrow the goal to the part you finished. "verified: true" means confirming evidence for each requirement individually; report blocked work honestly with success:false.'
].join('\n\n');

const TOOLS_CATALOG_NOTE = [
 'TOOLS - Schemas arrive compact: call tool_schema for full arguments first; no tool is hidden. agent_message only for a concrete handoff.'
].join('\n\n');

// schema repair (one-shot corrective turn after an undecidable reply).
const REPAIR_POLICY = 'REPAIR - Your last reply contained no executable decision. Return exactly one JSON object: {"toolCalls":[…]} / {"actions":[…]} with real tool arguments, or the terminal {"done":{"summary":"…","success":true,"verified":true}}. Plain narration is not an action.';

// computer mode (agi only): ONE paragraph, per-tool detail lives in schemas.
function computerSection(ctx) {
 if (ctx.controlMode !== 'agi') return '';
 return 'CODING WORKFLOW - In the workspace: ONE computer_index query for the most distinctive symbol -> ONE computer_read of the smallest section -> computer_patch. Probe live before patching and re-run one probe after reloading - only a post-patch frame verifies a patch. Mirror working code before inventing. Parallel work: spawn self-contained subagent slices (task_spawn) and keep a hands-on share. Verify web work in the browser, not desktop capture.';
}

// instruction-file section (lorde.md / AGENTS.md / CLAUDE.md via instructionLoader).
function instructionFileSection(ctx) {
 const text = String(ctx.instructionsFile || '').trim();
 return text ? `USER INSTRUCTIONS (from the workspace instruction file; they take precedence over defaults where they conflict):\n\n${text}` : '';
}

// ---- Registration ----------------------------------------------------------
function registerPromptSections(registry, ctx = {}) {
 registry.section({ name: PERSONA_PREFIX_SECTION, order: ORDERS.PERSONA_PREFIX, text: PERSONA_PREFIX, interpolate: false });
 registry.section({ name: 'policy:evidence', order: ORDERS.POLICY_GOAL + 10, text: EVIDENCE_POLICY, interpolate: false });
 registry.section({ name: 'policy:failure', order: ORDERS.POLICY_GOAL + 30, text: FAILURE_POLICY, interpolate: false });
 registry.section({ name: 'policy:approval', order: ORDERS.POLICY_APPROVAL, text: approvalPolicySection(ctx), interpolate: false });
 registry.section({ name: 'tools:catalog-note', order: ORDERS.TOOLS_CATALOG_NOTE, text: TOOLS_CATALOG_NOTE, interpolate: false });
 registry.section({ name: 'tools:computer', order: ORDERS.TOOLS_COMPUTER, text: computerSection(ctx), interpolate: false });
 registry.section({ name: 'context:instructions-file', order: ORDERS.CONTEXT_INSTRUCTIONS_FILE, text: instructionFileSection(ctx), interpolate: false });
 registry.section({ name: 'policy:completion', order: ORDERS.POLICY_COMPLETION, text: COMPLETION_POLICY, interpolate: false });
 registry.section({
 name: PERSONA_SUFFIX_SECTION,
 order: ORDERS.PERSONA_SUFFIX,
 text: 'Complete the task; act on budgets, approvals and structured errors in results.',
 interpolate: false
 });
 return registry;
}

// Playbook helpers (observation-attached, exported for the agent loop). The
// playbooks no longer ride the system prompt: they are attached to the
// creative computer tools' schemas, so they load with those tools.
function modelingPlaybookFor(desktop) {
 return hasModelingApp(desktop) ? MODELING_PLAYBOOK : '';
}
function drawingPlaybookFor(desktop) {
 return hasDrawingApp(desktop) ? DRAWING_PLAYBOOK : '';
}

// The DEFAULT harness system prompt, for a consumer that has no run shape to
// assemble from (a provider called without a request prompt, a subagent's
// first call, a probe). SAME registry, SAME sections, minimal context.
function defaultSystemPrompt(ctx = {}) {
 const { createPromptRegistry } = require('../harness/promptRegistry.cjs');
 const registry = createPromptRegistry();
 registerPromptSections(registry, {
 controlMode: ctx.controlMode || 'agi',
 effort: ctx.effort || 'standard',
 effortMode: ctx.effortMode || 'standard',
 approvalMode: ctx.approvalMode || 'unattended',
 modelingPlaybook: '',
 drawingPlaybook: '',
 instructionsFile: ''
 });
 return registry.render();
}

module.exports = {
 MODELING_PLAYBOOK, DRAWING_PLAYBOOK,
 PERSONA_PREFIX,
 EVIDENCE_POLICY,
 FAILURE_POLICY,
 COMPLETION_POLICY,
 TOOLS_CATALOG_NOTE,
 REPAIR_POLICY,
 registerPromptSections,
 modelingPlaybookFor,
 drawingPlaybookFor,
 defaultSystemPrompt
};
