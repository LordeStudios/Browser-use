'use strict';

// TOOL EXECUTION PIPELINE (DSH pattern, adapted from deepseek-harness
// docs/tool-execution-pipeline.md). Fixed order, one owner:
//
//   tool/call logged  →  pre-execute (approval ask)  →  guards (ADVISORY ONLY,
//   never veto)  →  timeout wrapper (structured TOOL_TIMEOUT)  →  tool body
//   →  normalize (throws → isError envelopes)  →  post-execute advisory  →
//   frozen result returned to the loop and recorded.
//
// Approval is the ONLY hard deny in this harness. Guards observe and produce
// sourced context that rides into the next request after the tool result
// (additionalContext). A guard has no "allow" result, so no ordering of
// listeners can turn a denial back into permission.

const { withToolTimeout } = require('./guards.cjs');
const { toolFailure } = require('./errors.cjs');

const PIPELINE_STAGES = Object.freeze([
  'call:log',
  'pre:approval',
  'pre:guards',
  'around:timeout',
  'body',
  'normalize',
  'post:advisory',
  'result'
]);

// executeCallPipeline({ call, hooks }) → { result, advisories, denied, call }
//   call               { name, input, callId?, expect?, repeat? }
//   hooks.onCallStart  async (call) => void                 log tool/call (publish tool.started)
//   hooks.approval     async (call) => { approved, reason? } the ONLY deny
//   hooks.guards       (call) => [{id, source, text}]        advisory notices, never veto
//   hooks.body         async (call) => output                the tool body (executeAction)
//   hooks.onCallEnd    async (call, result, meta) => void    record + publish tool.result
//   hooks.timeoutMs    number                                per-call deadline
//   hooks.postGuards   (call, result) => [{id, source, text}] post-execution advisory
async function executeCallPipeline({ call, hooks = {} }) {
  const { onCallStart, approval, guards, body, onCallEnd, timeoutMs, postGuards } = hooks;

  if (typeof onCallStart === 'function') await onCallStart(call);

  // Pre-execute: approval is a hard, monotonic deny (no allow-listener race).
  if (typeof approval === 'function') {
    const decision = await approval(call);
    if (decision && decision.approved === false) {
      const result = {
        isError: true,
        error: {
          message: `Approval denied for ${call.name}${decision.reason ? `: ${decision.reason}` : '.'}`,
          info: { name: 'ApprovalDenied', code: 'APPROVAL_DENIED' }
        }
      };
      const advisories = [];
      if (typeof onCallEnd === 'function') await onCallEnd(call, result, { denied: true, advisories });
      return { call, result, advisories, denied: true };
    }
  }

  // Guards: advisory-only context. They NEVER block execution.
  const advisories = typeof guards === 'function' ? ((guards(call) || []).filter(Boolean)) : [];

  // Around: cooperative timeout with a structured, routable timeout result.
  let result;
  try {
    result = await withToolTimeout(() => body(call), { timeoutMs, label: call.name });
  } catch (error) {
    // Normalize: snapshot throws become isError results (DSH pipeline rule).
    result = toolFailure(error);
  }

  const denied = false;
  if (typeof postGuards === 'function') {
    for (const advisory of (postGuards(call, result) || []).filter(Boolean)) advisories.push(advisory);
  }

  if (typeof onCallEnd === 'function') await onCallEnd(call, result, { denied, advisories });
  return { call, result, advisories, denied };
}

module.exports = { PIPELINE_STAGES, executeCallPipeline };
