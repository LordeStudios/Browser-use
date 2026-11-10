'use strict';
// Discriminating probe: reproduce tests/agent-continuity-regressions :212 exactly
// (file mutation ends a model batch) and print WHICH done-gate bounced, plus the
// coordinator's completedWork effectObserved values. No source changes.
const { DesktopChatAgent } = require('./desktop/agent/desktopChatAgent.cjs');

const observation = { navigation: { url: 'https://fixture.invalid', loading: false }, dom: { elements: [{ index: 81, tag: 'button', name: 'Unique current control' }] } };

let turn = 0;
const controller = {
  navigationState: () => observation.navigation, domSnapshot: () => observation.dom,
  consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {}
};
const backend = {
  observe: async () => ({ windows: [], foregroundWindowId: null }),
  execute: async () => ({ content: 'same evidence' }),
  releaseOwner: async () => {}, releaseInput: async () => {}
};
const complete = () => {
  turn += 1;
  if (turn === 1) return { actions: [
    { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } },
    { name: 'computer_patch', input: { path: 'C:/fixture.txt', patch: '*** Begin Patch\n*** End Patch' } },
    { name: 'computer_file', input: { action: 'read', path: 'C:/fixture.txt' } }
  ] };
  return { actions: [{ name: 'browser_done', input: { summary: 'Patched and verified.', success: true, verified: true } }] };
};
const agent = new DesktopChatAgent({
  controller, getSelectedTabId: () => 't', getControlMode: () => 'agi', getComputerTools: () => backend,
  emit() {}, createProvider: () => ({ complete })
});
agent.transportRetryDelays = [1];

(async () => {
  const run = await agent.start({ task: 'Inspect fixture', settings: { controlMode: 'agi', vision: 'off' } });
  const c = run.coordinator || {};
  console.log('TURN:', turn);
  console.log('COUNTERS:', JSON.stringify({
    accountingBounces: run.accountingBounces, incompleteWorkBounces: run.incompleteWorkBounces,
    criterionAuditBounces: run.criterionAuditBounces, codingGateBounces: run.codingGateBounces,
    completionReviewBounces: run.completionReviewBounces, completionReviewForced: run.completionReviewForced
  }));
  console.log('WORK:', JSON.stringify((c.completedWork || []).map((w) => ({ action: w.action, tool: w.tool, name: w.name, effectObserved: w.effectObserved, observedRevision: w.observedRevision }))));
  console.log('LASTMUT:', JSON.stringify(c.lastMutation ? { ok: c.lastMutation.ok, reportedProgress: c.lastMutation.reportedProgress, effectObserved: c.lastMutation.effectObserved } : null));
  console.log('HISTORY:', JSON.stringify((run.history || []).map((e) => e.tool)));
  console.log('RESULT:', JSON.stringify(run.result));
})().catch((e) => { console.error('PROBE_ERR', e); process.exit(1); });
