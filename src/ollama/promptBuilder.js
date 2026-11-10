// PROMPT BUILDER (DSH pattern, minimal edition): the system prompt is a
// registry of NAMED, ORDERED sections — no monolithic template. Identity is a
// fixed one-liner registered by the harness itself; volatile facts (URL,
// title, console errors, last events) NEVER enter the system prompt — they
// ride the per-step user payload as a superseding runtime-context snapshot.

export const IDENTITY_LINE = 'You are an AI agent powered by the Browser-use harness.';

const SECTION_ORDERS = {
  HARNESS_IDENTITY: -1000,
  PERSONA_PREFIX: 0,
  LOOP_CONTRACT: 500,
  EVIDENCE_POLICY: 600,
  COMPLETION_POLICY: 9900,
  PERSONA_SUFFIX: 10200
};

// Persona prefix (deployment:persona-prefix slot; shadow by re-registering).
const PERSONA_PREFIX = 'You control a live browser through tools. You serve the user sitting at this machine: act on their goal, keep visible replies short and plain, and never narrate internal formats or protocol terms.';

// The loop contract: one executable decision per turn.
const LOOP_CONTRACT = [
  'OUTPUT DISCIPLINE — every reply is exactly one executable step: a single JSON command object, or the terminal {"command":"browser.info"} when the goal is satisfied. No markdown, no arrays, no explanation outside the JSON.',
  'Do not restate the task or the plan. After each tool result, act on the newest evidence; never re-read what the last result already showed. A dispatched action proves input arrived, not that an effect landed — claim an effect only on fresh evidence.',
  'If unsure, request a screenshot or DOM snapshot instead of guessing. Use only commands from the allowed list.'
].join('\n');

const EVIDENCE_POLICY = 'Console errors are debugging aids, never page-state evidence. Null or error results confirm nothing: change the approach or inspect once, then act. Never repeat an identical failing call — make the next attempt materially different.';

const COMPLETION_POLICY = 'COMPLETION — return {"command":"browser.info"} only when the whole requested outcome is supported by fresh evidence. If a page cannot accept a requirement, report the concrete blocker in the command arguments instead of cycling silently.';

// Registry: sections join in order; empty sections vanish; duplicate names
// shadow (scoped over global). Strict interpolation: unknown {{var}} throws.
const SECTIONS = [
  { name: 'harness:identity', order: SECTION_ORDERS.HARNESS_IDENTITY, text: IDENTITY_LINE },
  { name: 'deployment:persona-prefix', order: SECTION_ORDERS.PERSONA_PREFIX, text: PERSONA_PREFIX },
  { name: 'policy:loop', order: SECTION_ORDERS.LOOP_CONTRACT, text: LOOP_CONTRACT },
  { name: 'policy:evidence', order: SECTION_ORDERS.EVIDENCE_POLICY, text: EVIDENCE_POLICY },
  { name: 'policy:completion', order: SECTION_ORDERS.COMPLETION_POLICY, text: COMPLETION_POLICY },
  { name: 'deployment:persona-suffix', order: SECTION_ORDERS.PERSONA_SUFFIX, text: 'Complete the task. The harness surfaces structured errors — act on them and keep working.' }
];

export function renderSystemPrompt({ extraSections = [] } = {}) {
  const sections = [...SECTIONS, ...extraSections];
  const seen = new Map();
  for (const section of sections) seen.set(section.name, section); // shadow by name
  return [...seen.values()]
    .sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : 1))
    .map(s => String(s.text || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// Runtime-context snapshot: volatile facts as a superseding user payload.
export function runtimeContextSnapshot(state) {
  return JSON.stringify({
    contextType: 'runtime_context',
    note: 'This snapshot supersedes earlier runtime-context snapshots.',
    ...state
  });
}

export async function buildMessages(ctx, registry, goal, lastResult = null) {
  const info = await ctx.browser.getCurrentInfo().catch(() => ({}));
  const events = ctx.eventBus.recent(10);
  const system = renderSystemPrompt();
  // DSH: identity/persona/policies in the system prompt; volatile facts in
  // the superseding runtime-context user message; the decision payload last.
  return [
    { role: 'system', content: system },
    { role: 'user', content: runtimeContextSnapshot({ goal, url: info.url, title: info.title, focused: info.focused, consoleErrorCount: ctx.browser.console.filter(e => e.type === 'error').length, lastEvents: events, lastResult, allowedCommands: registry.list().map(t => t.name) }) }
  ];
}
