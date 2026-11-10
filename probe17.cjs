'use strict';
// Counter probe: same :212 scenario as probe16, but prints EVERY done-gate
// counter first so the gate that bounces the verified done names itself.
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
  // CRITICAL OUTPUT FIRST (terminal truncates tails).
  console.log('COUNTERS:', JSON.stringify({
    accountingBounces: run.accountingBounces || 0,
    incompleteWorkBounces: run.incompleteWorkBounces || 0,
    criterionAuditBounces: run.criterionAuditBounces || 0,
    codingGateBounces: run.codingGateBounces || 0,
    completionReviewBounces: run.completionReviewBounces || 0,
    completionReviewForced: !!run.completionReviewForced
  }));
  console.log('PLAN:', JSON.stringify((run.plan || []).map((i) => ({ id: i && i.id, status: i && i.status, verification: String((i && i.verification) || '').slice(0, 40) }))));
  console.log('LEDGER:', JSON.stringify((run.requirementLedger || []).map((r) => ({ open: r && r.open, text: String((r && (r.text || r.requirement)) || '').slice(0, 40) }))));
  console.log('WORK:', JSON.stringify((run.coordinator && run.coordinator.completedWork || []).map((w) => ({ eo: String((w && w.expectedOutcome) || '').slice(0, 30), obs: w && w.effectObserved }))));
  console.log('TURN:', turn);
  console.log('HISTORY:', JSON.stringify((run.history || []).map((e) => e.tool)));
  console.log('RESULT:', JSON.stringify(run.result));
})().catch((e) => { console.error('PROBE_ERR', e); process.exit(1); });
