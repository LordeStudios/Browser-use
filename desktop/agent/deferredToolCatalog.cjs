'use strict';

// Deferred tool loading.
//
// Problem measured on the real wire (scripts/wire-capture.mjs): the tool
// schemas are 57-77% of every provider request — 5,584 tokens for 46 browser
// tools and 9,550 for 63 AGI tools, re-sent on EVERY decision.
//
// Design constraints that override any pure-token optimization:
//
//  1. NO TOOL IS EVER HIDDEN. A weak model must be able to see that every
//     tool exists and call it by name. Hiding tools (the usual "only ship the
//     top 6" shortcut) turns a missing tool into a silent dead end, and the
//     model then burns decisions describing what it wanted to do.
//  2. NO TOOL IS EVER GATED. Nothing here depends on the task text, the
//     environment, or a heuristic about what is "relevant". The catalog is
//     the same for every run.
//  3. A TOOL CALL MUST NEVER FAIL BECAUSE ITS SCHEMA WAS COMPACTED. Every
//     tool keeps a callable native entry with a permissive schema, so a call
//     always reaches the harness. The full schema is what the harness needs
//     to VALIDATE the call, and it is delivered the moment the model asks for
//     it (or the moment a call needs validating).
//
// So the catalog has three tiers, and a tool moves between them by being
// USED, never by being guessed at:
//
//   core     — full schema. The handful of tools that carry almost every
//              real task. Their schemas are the ones a model must get right
//              on the first try.
//   compact  — a native entry with the tool's name, its one-line description
//              and its argument NAMES and TYPES. The model can call it
//              correctly because every argument is listed; only the long
//              prose (per-field explanations, examples, enums) is dropped.
//   full     — a compact entry that has been promoted after the model asked
//              for its schema. Promotion is monotonic (Intel's accumulate
//              rule): a promoted tool keeps its full schema for the rest of
//              the run, which also keeps the cached prefix stable.
//
// The compact tier is not a lossy guess: the argument names and types are
// exactly the ones the full schema declares, so a compact-schema call that
// passes the harness's own validation is a valid call.

// The wire schema builder. The compact schema is derived from the SAME
// function the full schema uses, so a field's type can never differ between
// the two forms.
const { toolInputSchema } = require('./providers/wire.cjs');

// The tools that carry almost every real task, by measured usage over the
// saved conversation history (1,273 recorded calls). These keep their full
// schema in every request.
const CORE_TOOLS = new Set([
  'browser_done',
  'browser_execute',
  'browser_click',
  // Dragging is a primary browser verb, as fundamental as clicking: deferring
  // it left the model reaching for the DESKTOP pointer on page content (the
  // drag-relay run dragged the app window at screen coordinates).
  'browser_drag',
  'browser_navigate',
  'browser_fetch',
  'computer_read',
  'computer_terminal',
  'computer_patch',
  'update_plan'
]);

// The tools whose full schema is worth having up front even though they are
// less common, because their arguments are easy to get wrong from a name
// alone.
const ALWAYS_FULL_TOOLS = new Set([
  'browser_type',
  'browser_fill',
  'computer_write',
  'computer_search',
  'computer_index',
  'browser_observe',
  'computer_observe',
  'computer_screenshot'
]);

// Strips the prose from a schema, keeping every structural fact: types,
// nesting, array item shapes, enums and required lists. A nested object (the
// items of update_plan.steps) keeps its field names and types — only the
// descriptions go.
//
// The type ALWAYS comes from the tool's own full schema. Guessing a type from
// the field name is how a compact schema ends up saying "steps: string" where
// the real schema says "steps: array" — and a wrong type is exactly what makes
// a weak model call a tool wrongly.
function stripDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description' || key === 'examples' || key === 'example' || key === 'default') continue;
    if (key === 'properties' && value && typeof value === 'object') {
      out.properties = {};
      for (const [name, spec] of Object.entries(value)) out.properties[name] = stripDescriptions(spec);
      continue;
    }
    if (key === 'items' && value && typeof value === 'object') { out.items = stripDescriptions(value); continue; }
    if (key === 'anyOf' || key === 'oneOf') { out[key] = value.map((entry) => stripDescriptions(entry)); continue; }
    if (key === 'enum' && Array.isArray(value)) { out.enum = value.slice(); continue; }
    // An array of names (required) must stay an array of strings; recursing
    // into it would turn it into an object and drop the requirement.
    if (key === 'required' && Array.isArray(value)) { out.required = value.slice(); continue; }
    if (Array.isArray(value)) { out[key] = value.slice(); continue; }
    if (value && typeof value === 'object') { out[key] = stripDescriptions(value); continue; }
    out[key] = value;
  }
  return out;
}

function compactSchemaFor(tool) {
  // The SAME function that builds the full schema, so the types are identical
  // by construction rather than by a parallel list that can drift.
  const full = tool?.inputSchema || toolInputSchema(tool?.input || {}, tool?.name || '');
  const stripped = stripDescriptions(full);
  const required = Array.isArray(stripped.required) && stripped.required.length ? stripped.required : undefined;
  return {
    type: 'object',
    properties: stripped.properties || {},
    ...(required?.length ? { required } : {})
    // Permissive on purpose: an unknown argument must reach the harness and
    // produce the harness's own precise error, not a provider-side rejection
    // that never explains what was wrong. `additionalProperties` is left out
    // on purpose: in JSON Schema an absent flag MEANS true, so the behaviour
    // is the permissive one and the key itself costs ~8 tokens per tool.
  };
}

// The compact form of a tool definition, as the agent hands it to the
// provider. `inputSchema` is replaced by the compact schema and the original
// full schema is kept aside so the harness can serve it on request.
function toCompactTool(tool) {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: compactSchemaFor(tool),
    // Marked so the provider can tell a compacted tool from a full one.
    deferred: true,
    // The full schema travels with the definition (in-process only; it never
    // reaches the wire) so a promotion needs no second lookup.
    fullInputSchema: tool.inputSchema || toolInputSchema(tool.input || {}, tool.name)
  };
}

// The tool catalog for a request.
//
// `promoted` holds the tools whose full schema the model has already asked
// for; they are served in full. Every other non-core tool is served
// compacted. No tool is ever absent.
function buildToolCatalog(tools, { promoted = new Set(), core = CORE_TOOLS } = {}) {
  const catalog = [];
  for (const tool of tools || []) {
    if (!tool?.name) continue;
    const wantsFull = core.has(tool.name) || ALWAYS_FULL_TOOLS.has(tool.name) || promoted.has(tool.name);
    if (wantsFull) {
      catalog.push(tool);
      continue;
    }
    catalog.push(toCompactTool(tool));
  }
  return catalog;
}

// The full schema for a tool, served on request. Returns null when the tool
// is not in the catalog.
function fullSchemaFor(tools, toolName) {
  const tool = (tools || []).find((item) => item?.name === String(toolName));
  if (!tool) return null;
  // The browser tools carry no stored inputSchema — theirs is built by the
  // wire builder — so the same function that builds the full schema builds
  // the served one. Returning null here would leave the model with no schema
  // at all for exactly the tools that need it most.
  if (tool.fullInputSchema) return tool.fullInputSchema;
  if (tool.inputSchema) return tool.inputSchema;
  return toolInputSchema(tool.input || {}, tool.name);
}

// The argument names and types of a tool, as a short line the model can act
// on without the full schema.
function compactSignature(tool) {
  const schema = tool?.inputSchema?.properties ? tool.inputSchema : compactSchemaFor(tool);
  const entries = Object.entries(schema.properties || {});
  if (!entries.length) return '';
  return entries.map(([key, value]) => `${key}:${value.type || 'string'}`).join(', ');
}

// Whether a tool is currently served COMPACTED (its prose was dropped, only
// the argument names and types reached the model). A core tool, an
// always-full tool and a promoted tool are all served in full.
function isDeferredTool(tools, toolName, promoted = new Set()) {
  const name = String(toolName || '');
  if (CORE_TOOLS.has(name) || ALWAYS_FULL_TOOLS.has(name)) return false;
  if (promoted && typeof promoted.has === 'function' && promoted.has(name)) return false;
  return (tools || []).some((item) => item?.name === name);
}

module.exports = {
  CORE_TOOLS,
  ALWAYS_FULL_TOOLS,
  buildToolCatalog,
  compactSchemaFor,
  compactSignature,
  fullSchemaFor,
  isDeferredTool,
  toCompactTool
};
