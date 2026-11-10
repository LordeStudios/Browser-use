'use strict';

// HARNESS IDENTITY (DSH pattern): the identity line is a fixed one-liner
// registered by the harness itself, always the first section of the prompt.
// The deployment persona is a prefix/suffix PAIR under reserved section names —
// scoped registrations shadow these by name instead of adding duplicate text.

const IDENTITY_LINE = 'You are an AI agent powered by the Browser-use harness.';

const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix';
const PERSONA_SUFFIX_SECTION = 'deployment:persona-suffix';
const IDENTITY_SECTION = 'harness:identity';

// Canonical order anchors (mirror of promptRegistry SECTION_ORDERS entries the
// rest of the codebase may need when registering sections).
const ORDERS = Object.freeze({
  HARNESS_IDENTITY: -1000,
  PERSONA_PREFIX: 0,
  POLICY_GOAL: 500,
  POLICY_APPROVAL: 600,
  POLICY_EFFORT: 700,
  TOOL_GUIDANCE_BASE: 1000,
  TOOLS_CATALOG_NOTE: 3000,
  TOOLS_COMPUTER: 3100,
  CONTEXT_INSTRUCTIONS_FILE: 9000,
  POLICY_COMPLETION: 9900,
  PERSONA_SUFFIX: 10200
});

module.exports = { IDENTITY_LINE, IDENTITY_SECTION, PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION, ORDERS };
