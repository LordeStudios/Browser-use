'use strict';

// HARNESS ERRORS (harness pattern): every failure crossing a public boundary is a
// structured value with a stable code. Raw exceptions never reach the model —
// the pipeline normalizes them into { isError, error: { message, info } }.

const CODES = Object.freeze({
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  UNKNOWN_TOOL: 'UNKNOWN_TOOL',
  INVALID_TOOL_ARGS: 'INVALID_TOOL_ARGS',
  INVALID_TOOL_OUTPUT: 'INVALID_TOOL_OUTPUT',
  APPROVAL_DENIED: 'APPROVAL_DENIED',
  PROVIDER_UNREACHABLE: 'PROVIDER_UNREACHABLE',
  PROVIDER_BLOCKED: 'PROVIDER_BLOCKED',
  CONTEXT_OVERFLOW: 'CONTEXT_OVERFLOW',
  SCHEMA_UNDECIDABLE: 'SCHEMA_UNDECIDABLE',
  CANCELLED: 'CANCELLED',
  INTERNAL: 'INTERNAL',
  UNKNOWN: 'UNKNOWN'
});

class HarnessError extends Error {
  constructor(code, message, info = undefined) {
    super(message);
    this.name = 'HarnessError';
    this.code = CODES[code] || CODES.UNKNOWN;
    if (info !== undefined) this.info = info;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, ...(this.info !== undefined ? { info: this.info } : {}) };
  }
}

// Flatten any thrown value into { message, info: { name, code } } — the model-
// facing error envelope. Keeps failure facts (name/code) when they exist.
function errorChain(error) {
  if (error instanceof HarnessError) {
    return { message: error.message, info: { name: error.name, code: error.code, ...(error.info !== undefined ? { reason: error.info } : {}) } };
  }
  if (error instanceof Error) {
    const chain = [];
    let cur = error;
    while (cur && chain.length < 4) { chain.push(cur.message || String(cur)); cur = cur.cause; }
    return { message: chain.join(': '), info: { name: error.name || 'Error', code: error.code && typeof error.code === 'string' ? error.code : CODES.UNKNOWN } };
  }
  return { message: String(error), info: { name: 'Unknown', code: CODES.UNKNOWN } };
}

// Normalize a thrown tool failure into the canonical model-facing result.
// Snapshot/throw boundary: "throws become isError" (tool pipeline).
function toolFailure(error, code = undefined) {
  const chain = errorChain(error);
  return {
    isError: true,
    error: { message: chain.message, info: { name: chain.info.name, code: code || chain.info.code || CODES.UNKNOWN } }
  };
}

module.exports = { CODES, HarnessError, errorChain, toolFailure };
