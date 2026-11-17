import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const agentSource = readFileSync(new URL('../desktop/agent/desktopChatAgent.cjs', import.meta.url), 'utf8');
const internals = require('../desktop/agent/agentInternals.cjs');
const sections = require('../desktop/agent/prompt/sections.cjs');

// ── 1. The reply contract ───────────────────────────────────────────────────
// The persona says "mention only NEW evidence and the next action" — right
// during work, wrong at the end, where it produced "Done"/"Finished"/"Replied".
// The prompt must state that the terminal summary is the user's ANSWER.

test('the reply contract is part of the assembled system prompt', () => {
  assert.ok(sections.REPLY_POLICY, 'REPLY_POLICY must be exported');
  const prompt = sections.defaultSystemPrompt({});
  assert.match(prompt, /IS your answer to the user/);
  assert.match(prompt, /Never end a turn with only "Done"/);
  assert.match(prompt, /A greeting or a question gets a plain reply/);
});

test('the reply contract sits next to the completion contract it governs', () => {
  const prompt = sections.defaultSystemPrompt({});
  const completionAt = prompt.indexOf('COMPLETION -');
  const replyAt = prompt.indexOf('REPLY -');
  assert.ok(completionAt >= 0 && replyAt > completionAt, 'REPLY must follow COMPLETION');
  // It must not be buried before the tool catalog.
  const toolsAt = prompt.indexOf('TOOLS -');
  assert.ok(toolsAt < replyAt, 'REPLY belongs in the policy block, not the tool block');
});

// ── 2. A silent failure is now impossible ───────────────────────────────────

test('a failed run with no summary still produces a terminal message', () => {
  const run = { status: 'failed', messages: [], result: {} };
  internals.ensureTerminalAssistantMessage(run);
  const messages = internals.normalizeConversationMessages(run.messages);
  assert.equal(messages.length, 1, 'the transcript must not end empty');
  assert.match(messages[0].content, /stopped before returning a result/);
});

test('a cancelled run still appends nothing to the transcript', () => {
  // Cancellation is an intentional end state; the renderer paints its own line.
  const run = { status: 'cancelled', messages: [], result: {} };
  internals.ensureTerminalAssistantMessage(run);
  assert.equal(internals.normalizeConversationMessages(run.messages).length, 0);
});

// ── 3. Park publishes a visible, classified report ──────────────────────────

test('parkRun publishes a classified report, not just an internal escalation', () => {
  assert.match(agentSource, /this\.publish\('run\.parked', run, \{ reason: run\.escalation\.reason, failure, resumeInMs: resumeMs, fires: run\.escalation\.fires \}\);/);
  assert.match(agentSource, /this\.publish\('run\.escalated', run, \{ reason: run\.escalation\.reason, failure, resumeInMs: resumeMs, fires: run\.escalation\.fires \}\);/);
  assert.match(agentSource, /describeParkedRun\(run, reason, \{/);
});

test('parkRun accepts the raw provider error so the cause can be classified', () => {
  assert.match(agentSource, /parkRun\(run, reason, \{ error = null \} = \{\}\)/);
  assert.match(agentSource, /error \|\| run\.lastProviderError \|\| null/);
  // The loop records it before any classification site can run.
  assert.match(agentSource, /run\.lastProviderError = error;/);
});

test('a provider block carries the provider text into the terminal summary', () => {
  const at = agentSource.indexOf('if (providerBlock) {');
  assert.ok(at > 0);
  const body = agentSource.slice(at, at + 1200);
  assert.match(body, /classifyProviderFailure\(error/);
  assert.match(body, /formatFailureReport\(failure\)/);
  assert.match(body, /failure \};/, 'the report must ride the result for the renderer');
});

test('transport exhaustion says how many times it retried and for how long', () => {
  const at = agentSource.indexOf('if (attempt > this.transportRetryDelays.length)');
  assert.ok(at > 0);
  const body = agentSource.slice(at, at + 1100);
  assert.match(body, /classifyProviderFailure\(error/);
  assert.match(body, /retried \$\{attempt - 1\} times/);
  assert.match(body, /failure,/);
});

test('a stop publishes a line the renderer can paint', () => {
  assert.match(agentSource, /this\.publish\('run\.cancelled', run, \{ reason: 'stopped', detail: 'Run stopped\./);
});

// ── 4. Narration is published for every executing action ────────────────────

test('every executing action publishes one narration line', () => {
  const at = agentSource.indexOf("this.publish('tool.started', run, { tool: call.name, args: redactArgs(call.name, call.input)");
  assert.ok(at > 0, 'the tool.started publish must exist');
  const after = agentSource.slice(at, at + 900);
  assert.match(after, /const narration = describeAction\(call\);/);
  assert.match(after, /this\.publish\('assistant\.narration', run, \{ text: narration, tool: call\.name, phase: 'acting' \}\);/);
  // Bookkeeping tools must not narrate, or the strip flickers on plan updates.
  assert.match(after, /if \(narration\)/, 'a null narration must publish nothing');
});
