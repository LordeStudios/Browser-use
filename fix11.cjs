'use strict';
// f9 corrected probe: recordAction takes (state, optionsObject); mutates must be true.
// Variant A: computer_terminal call. Variant B: computer_write call (live shows effectObserved:true).
const { createCoordinatorState, recordAction, recordObservation } = require('./desktop/agent/desktopAgentCoordinator.cjs');

const observation = {
  navigation: { url: 'file:///C:/Users/london/Desktop/browser-use/browser-use/desktop/renderer/pages/homepage.html', loading: false },
  dom: { viewport: { width: 958, height: 706 }, elements: [] }
};

function runVariant(name, output, mutates) {
  const state = createCoordinatorState();
  const call = { name, input: { action: 'execute', command: 'node probe.cjs' } };
  let errA = null;
  try {
    recordAction(state, { hash: 'probehash1', mutates, output, expectation: '', call, observation: null });
  } catch (e) { errA = String((e && e.message) || e); }
  console.log('[' + name + '] recordAction err:', errA);
  console.log('[' + name + '] PENDING:', JSON.stringify((state.pendingMutations || []).map((p) => ({ workId: p.workId, reportedProgress: p.reportedProgress, effect: p.effect }))));
  let errO = null;
  try { recordObservation(state, observation); } catch (e) { errO = String((e && e.message) || e); }
  console.log('[' + name + '] recordObservation err:', errO);
  console.log('[' + name + '] WORK:', JSON.stringify((state.completedWork || []).map((w) => ({ action: w.action, effectObserved: w.effectObserved, observedRevision: w.observedRevision }))));
  console.log('[' + name + '] LASTMUT:', JSON.stringify({ ok: state.lastMutation && state.lastMutation.ok, reportedProgress: state.lastMutation && state.lastMutation.reportedProgress, effectObserved: state.lastMutation && state.lastMutation.effectObserved }));
}

runVariant('computer_terminal', { ok: true, result: { output: 'PROBE_OK', exitCode: 0 } }, true);
runVariant('computer_write', { ok: true, result: { path: 'probe.txt', bytesWritten: 5 } }, true);
console.log('PROBE_DONE');
