'use strict';
// f12 discriminating probe: mirrors the LIVE dispatch call shape at desktopChatAgent.cjs:2915.
// Variant C: mutates as isMutation classifies computer_terminal (hypothesis: falsy -> effectObserved:false friction).
// Variant D: the PATCHED call-site expression mutation || (output.ok===true && name startsWith 'computer_').
const fs = require('fs');
// READ-BACK FIRST: locate isMutation definition.
for (const f of ['desktop/agent/desktopChatAgent.cjs', 'desktop/agent/desktopAgentCoordinator.cjs']) {
  try {
    const t = fs.readFileSync('C:/Users/london/Desktop/browser-use/browser-use/' + f, 'utf8');
    t.split(/\r?\n/).forEach((l, i) => {
      if (/function isMutation|const isMutation|isMutation\s*=\s*\(/.test(l)) console.log('DEF ' + f + ':' + (i + 1) + ': ' + l.trim());
    });
  } catch (e) { console.log('DEF ' + f + ': unreadable'); }
}
const { createCoordinatorState, recordAction, recordObservation } = require('./desktop/agent/desktopAgentCoordinator.cjs');

const observation = {
  navigation: { url: 'file:///C:/Users/london/Desktop/browser-use/browser-use/desktop/renderer/pages/homepage.html', loading: false },
  dom: { viewport: { width: 958, height: 706 }, elements: [] }
};

function runVariant(label, name, output, mutates) {
  const state = createCoordinatorState();
  const call = { name, input: { action: 'execute', command: 'node probe.cjs' } };
  let errA = null;
  try {
    recordAction(state, { hash: 'probehash1', mutates, output, expectation: '', call, observation: null });
  } catch (e) { errA = String((e && e.message) || e); }
  let errO = null;
  try { recordObservation(state, observation); } catch (e) { errO = String((e && e.message) || e); }
  console.log('[' + label + '] err:', errA, '|', errO);
  console.log('[' + label + '] PENDING:', JSON.stringify((state.pendingMutations || []).map((p) => ({ workId: p.workId, reportedProgress: p.reportedProgress }))));
  console.log('[' + label + '] WORK:', JSON.stringify((state.completedWork || []).map((w) => ({ action: w.action, effectObserved: w.effectObserved, observedRevision: w.observedRevision }))));
}

const out = { ok: true, result: { output: 'PROBE_OK', exitCode: 0 } };
runVariant('C-mutatesFalsy', 'computer_terminal', out, false);
runVariant('D-patchedExpr', 'computer_terminal', out, false || (out?.ok === true && 'computer_terminal'.startsWith('computer_')));
console.log('PROBE_DONE');
