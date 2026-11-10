'use strict';

// PROMPT REGISTRY (DSH pattern, adapted from deepseek-harness
// packages/core/system-prompt): the system prompt is a registry of NAMED,
// ORDERED sections. There is no monolithic template. Sections may be static
// text or a provider function evaluated per assembly. Rendering rules:
//   • empty sections vanish; non-empty join with '\n\n'
//   • {{variable}} interpolation is STRICT — unknown/undefined throws
//   • scoped registrations SHADOW global ones by section name (persona slots)
//   • a `complete: true` section replaces the whole prompt (exactly one allowed)

const { IDENTITY_LINE, IDENTITY_SECTION, ORDERS } = require('./identity.cjs');

// The one table that owns prompt layout. Numbers are spaced so insertions
// rarely collide; ties break by section name for determinism.
const SECTION_ORDERS = Object.freeze({
  HARNESS_IDENTITY: ORDERS.HARNESS_IDENTITY,
  DEPLOYMENT_PERSONA_PREFIX: ORDERS.PERSONA_PREFIX,
  PLAN_POLICY: ORDERS.POLICY_GOAL,
  APPROVAL_POLICY: ORDERS.POLICY_APPROVAL,
  EFFORT_POLICY: ORDERS.POLICY_EFFORT,
  TOOL_GUIDANCE_BASE: ORDERS.TOOL_GUIDANCE_BASE,
  TOOLS_SDK: ORDERS.TOOLS_CATALOG_NOTE,
  TOOLS_COMPUTER: ORDERS.TOOLS_COMPUTER,
  INSTRUCTION_FILE: ORDERS.CONTEXT_INSTRUCTIONS_FILE,
  COMPLETION_POLICY: ORDERS.POLICY_COMPLETION,
  DEPLOYMENT_PERSONA_SUFFIX: ORDERS.PERSONA_SUFFIX
});

// Strict {{variable}} interpolation. Unknown or undefined variables throw at
// assembly time — a malformed prompt never reaches the provider silently.
function interpolate(text, variables, owner) {
  return String(text).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    const path = name.split('.');
    let value = variables;
    for (const key of path) {
      if (value === undefined || value === null) break;
      value = value[key];
    }
    if (value === undefined) {
      throw new Error(`unknown prompt variable "{{${name}}}" in section "${owner}" — register it before assembling`);
    }
    return String(value);
  });
}

function orderFor(name) {
  if (Object.prototype.hasOwnProperty.call(SECTION_ORDERS, name)) return SECTION_ORDERS[name];
  // Unknown order keys register at the tool-guidance band by default; the
  // explicit table stays authoritative for the sections it names.
  return SECTION_ORDERS.TOOL_GUIDANCE_BASE;
}

class PromptRegistry {
  constructor() {
    this._sections = new Map(); // name -> { name, order, text, interpolate, complete }
    this._variables = new Map();
  }

  // section({ name, order?, text | text(ctx), interpolate?, complete? })
  // Re-registering an existing name REPLACES it (shadow semantics).
  section(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name) {
      throw new Error('prompt section requires a non-empty name');
    }
    const entry = {
      name: spec.name,
      order: typeof spec.order === 'number' ? spec.order : orderFor(spec.orderKey || spec.name),
      text: typeof spec.text === 'function' ? spec.text : (spec.text == null ? '' : String(spec.text)),
      interpolate: spec.interpolate !== false,
      complete: spec.complete === true
    };
    this._sections.set(spec.name, entry);
    return this;
  }

  // variable(name, value) — {{name}} references resolve against these.
  variable(name, value) {
    this._variables.set(name, value);
    return this;
  }
  variables(map) {
    for (const [k, v] of Object.entries(map || {})) this._variables.set(k, v);
    return this;
  }

  get(name) { return this._sections.get(name); }
  has(name) { return this._sections.has(name); }
  delete(name) { this._sections.delete(name); }

  // render() → final prompt string. Deterministic: sort by (order, name),
  // drop empties, join with blank lines.
  render() {
    const resolved = [];
    for (const section of this._sections.values()) {
      const raw = typeof section.text === 'function' ? section.text({ variables: Object.fromEntries(this._variables) }) : section.text;
      const text = section.interpolate ? interpolate(raw, Object.fromEntries(this._variables), section.name) : String(raw || '');
      resolved.push({ name: section.name, order: section.order, text: text.trim(), complete: section.complete });
    }
    resolved.sort((a, b) => (a.order - b.order) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const completeSections = resolved.filter(s => s.complete);
    if (completeSections.length > 1) {
      throw new Error(`multiple complete:true prompt sections active: ${completeSections.map(s => s.name).join(', ')}`);
    }
    if (completeSections.length === 1) return completeSections[0].text;
    return resolved.filter(s => s.text.length > 0).map(s => s.text).join('\n\n');
  }
}

// Build the harness-owned registry: identity first, persona slots reserved.
// Deployment code (prompt/sections.cjs) fills the persona pair and policies.
function createPromptRegistry({ includeHarnessIdentity = true } = {}) {
  const registry = new PromptRegistry();
  if (includeHarnessIdentity) {
    registry.section({
      name: IDENTITY_SECTION,
      order: SECTION_ORDERS.HARNESS_IDENTITY,
      text: IDENTITY_LINE,
      interpolate: false
    });
  }
  return registry;
}

module.exports = { SECTION_ORDERS, PromptRegistry, createPromptRegistry, interpolate };
