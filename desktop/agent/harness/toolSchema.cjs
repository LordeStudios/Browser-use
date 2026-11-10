'use strict';

// TOOL SCHEMA (DSH pattern, adapted from deepseek-harness packages/core/tools):
// one DSL for tool definitions; the MODEL-VISIBLE projection is exactly
// { name, description, parameters } — runtime metadata (timeouts, executors,
// presenters) never leaks to the model. Output projection is structured:
// failures are { isError, error: { message, info: { code } } }, never raw
// exceptions.
//
// Compatibility: the legacy catalog shapes of this codebase are
//   browser tools: { name, description, input: { param: 'description' } }
//   computer tools: { name, description, inputSchema: {JSON Schema} }
// defineTool/fromLegacy* wrap both into ToolDefinition objects, and
// toLegacyTool() projects back so deferredToolCatalog.buildToolCatalog() and
// providers/wire openAi/anthropicToolSchemas keep working UNMODIFIED.

const { toolFailure, CODES } = require('./errors.cjs');

// Freeform legacy inputs are typed by key (same rule as providers/wire
// toolInputSchema NUMERIC_TOOL_INPUTS) so the wrapped schema matches what the
// wire used to generate byte-for-byte.
const NUMERIC_TOOL_INPUTS = new Set([
  'x', 'y', 'startX', 'startY', 'endX', 'endY', 'steps', 'durationMs',
  'deltaX', 'deltaY', 'maxElements', 'maxResults', 'maxFps', 'maxSize',
  'bitrate', 'maxInputUsd', 'minContext', 'limit', 'offset', 'ms'
]);

// defineTool({ name, description, parameters, guidance?, execute? }) → definition.
// parameters: JSON-Schema object ({type:'object', properties:{...}}). Legacy
// freeform maps are converted by fromLegacyInput().
function defineTool(spec) {
  if (!spec || typeof spec.name !== 'string' || !spec.name) throw new Error('defineTool requires a name');
  if (typeof spec.description !== 'string' || !spec.description) throw new Error(`defineTool(${spec.name}) requires a description`);
  const parameters = spec.parameters
    || (spec.input ? fromLegacyInput(spec.input, spec.name) : { type: 'object', properties: {} });
  if (!parameters || parameters.type !== 'object') {
    throw new Error(`defineTool(${spec.name}) parameters must be an object schema`);
  }
  return Object.freeze({
    name: spec.name,
    description: spec.description,
    parameters,
    ...(spec.guidance ? { guidance: String(spec.guidance) } : {}), // prompt section text owned by this tool
    ...(typeof spec.execute === 'function' ? { execute: spec.execute } : {}),
    ...(spec.output ? { output: spec.output } : {})
  });
}

// fromLegacyInput({ param: 'description', ... }, name) → object schema.
function fromLegacyInput(input = {}, toolName = '') {
  const properties = {};
  for (const [key, description] of Object.entries(input)) {
    properties[key] = { type: NUMERIC_TOOL_INPUTS.has(key) ? 'number' : 'string', description: String(description) };
  }
  const schema = { type: 'object', properties };
  if (toolName === 'browser_wait') schema.required = ['ms'];
  return schema;
}

// THE model-visible projection. Exactly three fields (+deferLoading, unused here).
function projectToolSchema(definition) {
  return { name: definition.name, description: definition.description, parameters: definition.parameters };
}

// Compatibility projection into the legacy catalog shape consumed by
// buildToolCatalog()/openAiToolSchemas()/anthropicToolSchemas(). The
// `input` desc-map is rebuilt from parameter descriptions so wire fallbacks
// never fire.
function toLegacyTool(definition) {
  const input = {};
  for (const [key, spec] of Object.entries(definition.parameters?.properties || {})) {
    input[key] = spec?.description || (spec?.type === 'number' ? 'number' : 'string');
  }
  return {
    name: definition.name,
    description: definition.description,
    input,
    inputSchema: definition.parameters
  };
}

// Canonical tool order: explicit list wins; unknown names follow in
// lexicographic order after the listed ones (DSH `<unlisted-tools>` rest
// marker concept).
function canonicalToolOrder(definitions, orderList = []) {
  const listed = orderList.filter(name => definitions.some(d => d.name === name));
  const listedSet = new Set(listed);
  const rest = definitions.map(d => d.name).filter(name => !listedSet.has(name)).sort();
  return [...listed, ...rest];
}

module.exports = { NUMERIC_TOOL_INPUTS, defineTool, fromLegacyInput, projectToolSchema, toLegacyTool, canonicalToolOrder, toolFailure, CODES };
