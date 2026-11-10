// AGENT LOOP (DSH pattern, minimal edition): turn/step over a tool registry.
//   • STEP = one provider call + one parsed command; the loop continues while
//     the run is active.
//   • Requests are derived from durable state (event bus + last result); no
//     parallel mutable history.
//   • ONE recovery model: transport-class failures retry inside the open
//     step on a bounded rising ladder; any other failure ends the step with
//     a structured error envelope ({ok:false,error:{message,info:{code}}}) —
//     raw exceptions never reach the caller's model state.
//   • Repeat-call guard: identical consecutive commands at thresholds
//     [3,5,8] arm a sourced advisory notice (advisory-first, never a veto).
//   • Cancellation: pause/resume/stop with a typed state machine.

import { buildMessages } from './promptBuilder.js';
import { chatStream } from './ollamaClient.js';
import { parseModelCommand } from './commandParser.js';
import { executeTool } from '../tools/toolExecutor.js';

const RETRY_LADDER_MS = [1_000, 2_000, 4_000];
const REPEAT_THRESHOLDS = [3, 5, 8];

const GENTLE_REMINDER = 'You are repeating the exact same tool call with identical arguments. Carefully analyze the previous result before calling again: if the task is not complete, try a different approach or different arguments instead of repeating the call.';

function canonicalArgs(args) {
  const sorted = (value) => {
    if (Array.isArray(value)) return value.map(sorted);
    if (value && typeof value === 'object') {
      return Object.keys(value).sort().reduce((acc, key) => { acc[key] = sorted(value[key]); return acc; }, {});
    }
    return value;
  };
  return JSON.stringify(sorted(args ?? null));
}

function isTransportError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return /fetch failed|econn|etimedout|timeout|socket|network|reset by peer|connection (?:refused|reset|closed)|rate.?limit|overloaded|bad gateway|service unavailable|internal server error|\b5\d\d\b/.test(message);
}

export class AgentLoop {
  constructor(ctx, registry, opts = {}) {
    this.ctx = ctx; this.registry = registry; this.opts = opts;
    this.state = 'stopped'; this.steps = 0; this.startTime = null; this.lastResult = null;
    this._retryAttempts = 0; this._repeatStreak = null; this._repeatNoticeAt = 0;
  }

  async step(goal = this.opts.goal) {
    this.steps++;
    const maxSteps = Number(this.opts.maxSteps) || 50;
    const maxMinutes = Number(this.opts.maxMinutes) || 10;
    if (this.steps > maxSteps) { this.ctx.eventBus.emitEvent('agent.limit', { reason: 'maxSteps', steps: this.steps }); this.stop(); return { ok: false, error: `Stopped after ${maxSteps} steps` }; }
    if (this.startTime && (Date.now() - this.startTime) > maxMinutes * 60000) { this.ctx.eventBus.emitEvent('agent.limit', { reason: 'timeout', minutes: maxMinutes }); this.stop(); return { ok: false, error: `Stopped after ${maxMinutes} minutes` }; }
    const messages = await buildMessages(this.ctx, this.registry, goal, this.lastResult);
    // DSH REQUEST-ERROR POLICY: transport failures retry inside the open
    // step on the rising ladder; anything else is a structured step error.
    let modelText = '';
    for (;;) {
      try {
        modelText = await chatStream({ baseUrl: this.opts.ollamaBaseUrl, model: this.opts.model, messages, onToken: t => this.ctx.eventBus.emitEvent('model.token', { token: t }) });
        this._retryAttempts = 0;
        break;
      } catch (error) {
        if (!isTransportError(error) || this._retryAttempts >= RETRY_LADDER_MS.length) {
          this.ctx.eventBus.emitEvent('model.error', { error: error.message, code: 'PROVIDER_UNREACHABLE' });
          return { ok: false, error: { message: error.message, info: { code: 'PROVIDER_UNREACHABLE' } } };
        }
        const delay = RETRY_LADDER_MS[this._retryAttempts++];
        this.ctx.eventBus.emitEvent('model.retry', { attempt: this._retryAttempts, delayMs: delay });
        await new Promise(r => setTimeout(r, delay));
      }
    }
    const parsed = parseModelCommand(modelText, this.registry);
    this.ctx.eventBus.emitEvent('model.parsed', parsed);
    if (!parsed.ok) {
      // Undecidable output: one sticky sourced schema-repair notice per run.
      if (!this._schemaRepairArmed) {
        this._schemaRepairArmed = true;
        this.ctx.eventBus.emitEvent('harness.notice', { id: 'harness.schema-repair', source: 'harness:schema', text: 'Your last reply contained no executable command. Return exactly ONE JSON command object from the allowed list.' });
      }
      return parsed;
    }
    this._schemaRepairArmed = false;
    // DSH repeat-call guard (advisory): identical command + identical args.
    const fingerprint = `${parsed.command}|${canonicalArgs(parsed.args)}`;
    if (this._repeatStreak && this._repeatStreak.fp === fingerprint) this._repeatStreak.count += 1;
    else this._repeatStreak = { fp: fingerprint, count: 1 };
    const hit = REPEAT_THRESHOLDS.find(t => this._repeatStreak.count === t);
    if (hit) this.ctx.eventBus.emitEvent('harness.notice', { id: `guard.repeat.${hit}`, source: 'guard:repeat-call', text: GENTLE_REMINDER });
    this.lastResult = await executeTool(this.ctx, this.registry, parsed.command, parsed.args);
    return this.lastResult;
  }

  start(goal) {
    if (this.state === 'running') return { ok: true, state: this.state };
    this.state = 'running'; this.steps = 0; this.startTime = Date.now(); this.lastResult = null;
    this._retryAttempts = 0; this._repeatStreak = null;
    const loop = async () => { while (this.state === 'running') { await this.step(goal); await new Promise(r => setTimeout(r, 250)); } };
    this.promise = loop().catch(e => { this.ctx.eventBus.emitEvent('agent.error', { error: e.message }); this.state = 'stopped'; });
    return { ok: true, state: this.state };
  }

  pause() { this.state = 'paused'; return { ok: true, state: this.state }; }
  resume(goal) { if (this.state === 'running') return { ok: true, state: this.state }; return this.start(goal); }
  stop() { this.state = 'stopped'; this.ctx.eventBus.emitEvent('session.stop', {}); return { ok: true, state: this.state }; }
}
