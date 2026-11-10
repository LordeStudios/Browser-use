'use strict';
// Stack probe: same :212 scenario as probe15, but every model invocation prints
// its repo call-site stack so the site that re-calls after an accepted done is named.
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
  const frames = String(new Error().stack || '').split('\n')
    .filter((l) => l.includes('desktopChatAgent') || l.includes('desktopAgentCoordinator') || l.includes('providerTurnLedger'))
    .slice(0, 8);
  console.log('TURN' + turn + ' STACK: ' + JSON.stringify(frames));
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
  console.log('TURN:', turn);
  console.log('HISTORY:', JSON.stringify((run.history || []).map((e) => e.tool)));
  console.log('RESULT:', JSON.stringify(run.result));
})().catch((e) => { console.error('PROBE_ERR', e); process.exit(1); });
