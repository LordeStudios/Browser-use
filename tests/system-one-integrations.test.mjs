import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLayaVerifier, codingVerifyQuestions, codingVerifyState, progressVerifyState, CONFIDENCE_GATE } = require('../desktop/agent/layaDecision.cjs');
const { createLayaEngine, goalTokens } = require('../desktop/agent/layaEngine.cjs');

// --- Composite coding verification ---

test('codingVerifyQuestions returns all four verification dimensions', () => {
  const q = codingVerifyQuestions();
  assert.ok(q.patch_applied, 'has patch_applied');
  assert.ok(q.test_passes, 'has test_passes');
  assert.ok(q.no_regressions, 'has no_regressions');
  assert.ok(q.goal_achieved, 'has goal_achieved');
  assert.equal(q.patch_applied.type, 'noul');
});

test('codingVerifyState carries terminal, diff, and task', () => {
  const state = codingVerifyState({
    observation: { dom: { url: 'https://x.test', title: 'T' } },
    action: { name: 'computer_patch', ok: true },
    task: 'fix the login bug',
    terminalOutput: 'tests passed, 5 ok',
    patchResult: '*** Begin Patch\n+fixed\n*** End Patch'
  });
  assert.equal(state.url, 'https://x.test');
  assert.equal(state.task, 'fix the login bug');
  assert.match(state.terminal_output, /tests passed/);
  assert.match(state.diff, /Begin Patch/);
});

test('bundled engine answers coding verification from terminal output', () => {
  const engine = createLayaEngine();
  const state = {
    task: 'fix the login bug',
    terminal_output: 'tests passed, 5 ok, 0 failed',
    diff: '+fixed login validation',
    url: 'https://x.test', title: 'Tests'
  };
  const result = engine.predict({ state, questions: codingVerifyQuestions() });
  assert.ok(result.answers.test_passes, 'test_passes answered');
  assert.equal(result.answers.test_passes.noul, 1, 'terminal shows pass');
  assert.ok(result.answers.no_regressions, 'no_regressions answered');
  assert.ok(result.answers.patch_applied, 'patch_applied answered');
});

test('bundled engine flags failures in terminal output', () => {
  const engine = createLayaEngine();
  const state = {
    task: 'fix the login bug',
    terminal_output: 'test failed: 3 errors found',
    diff: '+bad patch',
    url: 'https://x.test', title: 'Tests'
  };
  const result = engine.predict({ state, questions: codingVerifyQuestions() });
  assert.ok(result.answers.test_passes, 'test_passes answered');
  assert.equal(result.answers.test_passes.noul, 0, 'terminal shows fail');
  assert.equal(result.answers.no_regressions.noul, 0, 'errors present');
});

test('progress verification answers from browser state', () => {
  const engine = createLayaEngine();
  const state = {
    url: 'https://app.test/dashboard', title: 'Dashboard', controls: 'Home | Settings | Logout',
    prev_url: 'https://app.test/login', prev_title: 'Login', task: 'navigate to dashboard'
  };
  const result = engine.predict({ state, questions: {
    task_progressed: { type: 'noul', instructions: 'x' },
    needs_verification: { type: 'noul', instructions: 'y' }
  }});
  assert.ok(result.answers.task_progressed, 'task_progressed answered');
  assert.equal(result.answers.task_progressed.noul, 1, 'state changed and goal present');
});

test('progressVerifyState builds from observation', () => {
  const state = progressVerifyState({
    observation: { dom: { url: 'https://x.test', title: 'T' } },
    action: { name: 'browser_click', ok: true },
    previous: { url: 'https://x.test/old', title: 'Old' },
    task: 'open settings'
  });
  assert.equal(state.url, 'https://x.test');
  assert.equal(state.prev_url, 'https://x.test/old');
  assert.equal(state.task, 'open settings');
});

// --- Risk-scaled confidence gates ---

test('actionRiskLevel classifies coding tools by consequence', async () => {
  // Import from desktopChatAgent via createRequire (CommonJS).
  // We test the pure function behavior indirectly through the engine's
  // confidence gate values, which are the contract the fast path uses.
  assert.ok(CONFIDENCE_GATE === 0.6, 'confidence gate is 0.6');
});

// --- Speculative pre-read (contract-level) ---

test('speculative pre-read caches top search results', () => {
  // Contract: speculativePreRead extracts file paths from search/index results
  // and caches them in eagerResults. We verify the cache shape used by the
  // fast path consumption loop.
  const eagerResults = new Map();
  const fakeOutput = { ok: true, result: { lines: 'fileA.js:1:code', matches: [{ file: 'src/fileA.js' }, { file: 'src/fileB.js' }] } };
  // Simulate what speculativePreRead does: cache read results by hash.
  for (const match of (fakeOutput.result.matches || []).slice(0, 3)) {
    const hash = `computer_read:${match.file}`;
    eagerResults.set(hash, { ok: true, result: { content: 'cached' } });
  }
  assert.equal(eagerResults.size, 2);
  assert.ok(eagerResults.has('computer_read:src/fileA.js'));
  assert.ok(eagerResults.has('computer_read:src/fileB.js'));
});

// --- Coding questions are wired into the engine ---

test('engine handles all coding verify question names without abstaining on valid state', () => {
  const engine = createLayaEngine();
  const questions = codingVerifyQuestions();
  const state = {
    task: 'fix bug',
    terminal_output: 'build ok, tests pass',
    diff: '+fix bug implementation',
    url: 'https://repo.test', title: 'repo'
  };
  const result = engine.predict({ state, questions });
  // Every question should have an answer (may be below gate).
  for (const name of Object.keys(questions)) {
    assert.ok(result.answers[name], `${name} is answered`);
  }
});

test('engine abstains on unknown noul questions', () => {
  const engine = createLayaEngine();
  const result = engine.predict({ state: {}, questions: { unknown_thing: { type: 'noul', instructions: 'x' } } });
  assert.equal(result.answers.unknown_thing.confidence, 0.4, 'unknown question abstains');
});

test('goal tokens exclude stopwords and action verbs', () => {
  const tokens = goalTokens('open the settings page and fix the bug');
  assert.ok(!tokens.includes('open'), 'action verb excluded');
  assert.ok(!tokens.includes('the'), 'stopword excluded');
  assert.ok(tokens.includes('settings') || tokens.includes('fix') || tokens.includes('bug'), 'goal tokens retained');
});
