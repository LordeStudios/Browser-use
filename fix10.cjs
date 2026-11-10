'use strict';
// f9 discriminating probe: drive the REAL producer functions with a
// computer_terminal call and print the settled effectObserved flag.
const { createCoordinatorState, recordAction, recordObservation } = require('./desktop/agent/desktopAgentCoordinator.cjs');

function paramsOf(fn) {
  const src = String(fn);
  let m = src.match(/function[^()]*\(([^)]*)\)/);
  if (!m) m = src.match(/\(([^)]*)\)\s*=>/);
  return m ? m[1].split(',').map((s) => s.trim().replace(/=.*$/, '').replace(/[{}\[\]]/g, '')).filter(Boolean) : [];
}

const state = createCoordinatorState();
const call = { name: 'computer_terminal', input: { action: 'execute', command: 'node probe.cjs' } };
const output = { ok: true, result: { output: 'PROBE_OK', exitCode: 0 } };
const observation = { navigation: { url: 'file:///C:/Users/london/Desktop/browser-use/browser-use/desktop/renderer/pages/homepage.html', loading: false }, dom: { viewport: { width: 958, height: 706 }, elements: [] } };

const byName = {
  state, call, output, observation,
  hash: 'probehash1', fingerprint: 'fp0', beforeFingerprint: 'fp0',
  expectation: '', progress: false, native: false, evidence: null,
  changed: false, observationChanged: false, planStatusChanged: false,
  lastProgressRevision: 0
};

const pA = paramsOf(recordAction);
console.log('SIG recordAction:', String(recordAction).slice(0, 240));
console.log('PARAMS recordAction:', JSON.stringify(pA));
const argsA = pA.map((p) => (byName[p] !== undefined ? byName[p] : undefined));
let errA = null;
try { recordAction(...argsA); } catch (e) { errA = String((e && e.message) || e); }
console.log('recordAction err:', errA);
console.log('PENDING:', JSON.stringify((state.pendingMutations || []).map((p) => ({ workId: p.workId, reportedProgress: p.reportedProgress, native: !!p.native }))));

const pO = paramsOf(recordObservation);
console.log('PARAMS recordObservation:', JSON.stringify(pO));
const argsO = pO.map((p) => (byName[p] !== undefined ? byName[p] : undefined));
let errO = null;
try { recordObservation(...argsO); } catch (e) { errO = String((e && e.message) || e); }
console.log('recordObservation err:', errO);

console.log('WORK:', JSON.stringify((state.completedWork || []).map((w) => ({ action: w.action, effectObserved: w.effectObserved, observedRevision: w.observedRevision }))));
console.log('LASTMUT:', JSON.stringify({ ok: state.lastMutation && state.lastMutation.ok, reportedProgress: state.lastMutation && state.lastMutation.reportedProgress, effectObserved: state.lastMutation && state.lastMutation.effectObserved }));
console.log('PROBE_DONE');
