'use strict';

// cli/stubs.cjs
// Minimal headless shims for DesktopChatAgent injectables that have no
// meaning without the Electron shell. Every stub fails honest and loud in its
// result payloads (never silently pretending success) so a run that strays
// into an unsupported surface is visible in trace.jsonl.

// The AGI-mode computer backend contract (used by the agent as
// run.getComputerTools()): observe(owner, {signal}), execute(tool, input,
// owner, {signal}), releaseOwner(owner). Real native input, capture, terminal
// and screen tools cannot exist headlessly; pure-Node file tools are NOT
// re-wired here on purpose — the real implementation lives in
// desktop/computer/computerTools.cjs and is owned by the Electron main
// process. Runs that need file work should use --control-mode browser with a
// workspace or run the desktop app.
function createHeadlessComputerToolsStub() {
  const refuse = (tool) => {
    const error = new Error(`computer_${tool} is unavailable in the headless CLI runner: native desktop tools require the Browser-use desktop app. Use browser_* tools, or run this task in the desktop app for AGI mode.`);
    error.code = 'HEADLESS_COMPUTER_TOOLS_UNAVAILABLE';
    return error;
  };
  return {
    // E11 (gen3): marks this backend as the headless stub. The agent reads it
    // once per run and strips the native file tools below from the advertised
    // catalog — they failed or were hallucinated in EVERY headless campaign
    // run (preflight D20; arch1 timed-r1 tools 21-22; arch2 untimed-r2 D21;
    // arch4 untimed-r1 D17). The desktop backend carries no marker and keeps
    // the full tool surface.
    headlessUnavailable: true,
    async observe(owner, { signal } = {}) {
      if (signal?.aborted) throw new Error('aborted');
      return {
        desktop: true,
        displays: [],
        windows: [],
        pointer: { x: 0, y: 0 },
        notice: 'Headless CLI stub: no native desktop is attached. Use browser_* tools.'
      };
    },
    async execute(tool, input, owner, { signal } = {}) {
      if (signal?.aborted) throw new Error('aborted');
      throw refuse(String(tool || '').replace(/^computer_/, ''));
    },
    async releaseOwner() { return true; }
  };
}

// researchRunner injectable: research_task degrades to this instead of the
// default web-research subagent (network fan-out has no place in a bounded
// headless harness run).
const disabledResearchRunner = async () => ({
  ok: false,
  aborted: false,
  summary: 'Research is disabled in the headless CLI runner (--max-seconds-bounded harness); continue with browser evidence.',
  findings: []
});

module.exports = { createHeadlessComputerToolsStub, disabledResearchRunner };
