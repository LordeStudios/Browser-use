import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

// RENDERER OUTCOME E2E — runs the real renderer and checks what actually paints.
//
// History: this file used to assert a `.agent-message.is-error` card for a
// failed run. That card was never appended (`renderChatMessage('error', …)`
// returned a detached `hidden` element), so the assertion could only ever pass
// against a renderer that did not contain that branch — and the real app showed
// a stopped spinner with no reason. It is rewritten to assert what the user
// needs: a failure is visible, carries the provider's own words, a parked run is
// not presented as finished, and the live visualization is a suspended particle
// orb above the composer rather than a card saying "Still working".

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-agent-outcome-'));
// ELECTRON_RUN_AS_NODE turns electron.exe into plain Node, where
// `require('electron')` returns the binary PATH instead of the API — the app
// then dies on `ipcMain.handle` before any window exists. It leaks in from the
// environment that started this test, so it must be removed explicitly rather
// than inherited.
const launchEnv = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0' };
delete launchEnv.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath,
  args: ['.', `--user-data-dir=${profile}`],
  cwd: root,
  env: launchEnv
});

try {
  const deadline = Date.now() + 25_000;
  let window;
  while (!window && Date.now() < deadline) {
    window = app.windows().find((candidate) => candidate.url().endsWith('/desktop/renderer/index.html'));
    if (!window) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(window, 'Desktop main renderer did not load.');
  await window.waitForSelector('#agent-toggle');
  await window.click('#agent-toggle');
  await window.waitForSelector('#agent-panel:not([hidden])');

  const result = await window.evaluate(async () => {
    const reset = (id) => {
      visibleConversationId = id;
      retiredConversationIds.delete(id);
      chatRun = null;
      activeChatRun = null;
      lastAssistantReplyByRun.clear();
      discardLiveThought();
      agentTranscript.replaceChildren();
      // The orb lives outside the transcript, so it must be cleared explicitly
      // or a fixture inherits the previous one's state.
      hideOrb();
    };
    const runningRun = (id) => ({ id, title: 'Outcome fixture', status: 'running', step: 1, plan: [], startedAt: Date.now() });

    // ── 1. A plain failure (no classified report) still paints a row ──────
    reset('outcome-plain');
    const plainRun = {
      id: 'outcome-plain', title: 'Outcome fixture', status: 'failed', step: 1, plan: [],
      result: { summary: 'The provider rejected this connection.', success: false, verified: false, reason: 'provider_external_block' }
    };
    handleAgentEvent({ type: 'run.failed', revision: 1, run: plainRun, result: plainRun.result });
    const plain = [...agentTranscript.querySelectorAll('.agent-message.is-failure')].map((node) => node.textContent);

    // ── 2. A classified failure shows cause + provider text + next step ───
    reset('outcome-classified');
    const classified = {
      kind: 'rate_limit',
      title: 'Provider rate limit',
      body: 'The provider is rate-limiting this account (ernie-5.5-flash-preview). This is a throughput limit, not a fault in the task.',
      providerText: '429 Too Many Requests: rate limit reached for requests per min',
      nextStep: 'Wait a moment and resume, or switch model/provider to keep working now.',
      retryable: true,
      retryAfterMs: 30_000
    };
    const classifiedRun = {
      id: 'outcome-classified', title: 'Outcome fixture', status: 'failed', step: 1, plan: [],
      result: { summary: 'placeholder', success: false, verified: false, reason: 'provider_unreachable', failure: classified }
    };
    handleAgentEvent({ type: 'run.failed', revision: 1, run: classifiedRun, result: classifiedRun.result });
    const card = agentTranscript.querySelector('.agent-message.is-failure');
    const classifiedPaint = {
      title: card?.querySelector('header strong')?.textContent || '',
      provider: card?.querySelector('.agent-failure-provider code')?.textContent || '',
      next: card?.querySelector('.agent-failure-next')?.textContent || '',
      // A failure must never masquerade as a success reply.
      replies: [...agentTranscript.querySelectorAll('.agent-message.is-assistant')].length
    };

    // ── 3. A park is presented as parked, not finished ───────────────────
    reset('outcome-parked');
    handleAgentEvent({
      type: 'run.parked', revision: 1,
      run: { ...runningRun('outcome-parked'), status: 'awaiting_recovery' },
      failure: { ...classified, parked: true, resumeNote: 'The run is parked, not finished — recovery resumes it automatically.' },
      resumeInMs: 15_000, fires: 1
    });
    const parkedCard = agentTranscript.querySelector('.agent-message.is-failure');
    const parked = {
      isParked: parkedCard?.classList.contains('is-parked') || false,
      resume: parkedCard?.querySelector('.agent-failure-resume')?.textContent || ''
    };

    // ── 4. Narration drives a suspended orb, not a transcript card ───────
    reset('outcome-narration');
    const narrationRun = runningRun('outcome-narration');
    const dock = document.getElementById('agent-orb-dock');
    const canvas = document.getElementById('agent-orb-canvas');
    const caption = () => document.getElementById('agent-orb-label')?.textContent || '';
    const dockHiddenAtStart = dock?.hidden !== false;

    handleAgentEvent({ type: 'assistant.narration', revision: 1, run: narrationRun, text: 'Opening Blender' });
    const firstNarration = caption();
    const firstMode = dock?.dataset.mode || '';
    const firstHidden = dock?.hidden !== false;
    // It must be suspended over the composer, not sitting in the transcript.
    const inTranscript = Boolean(agentTranscript.querySelector('#agent-orb-dock'));
    const inComposer = Boolean(document.getElementById('agent-form')?.contains(dock));

    handleAgentEvent({ type: 'assistant.narration', revision: 2, run: narrationRun, text: 'Clicking in Blender' });
    const secondNarration = caption();
    const workingCards = agentTranscript.querySelectorAll('.agent-message.is-working').length;

    // The first frame is painted from requestAnimationFrame, so the pixels do
    // not exist until the compositor has ticked. Two frames: mount, then draw.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const canvasPainted = (() => {
      if (!canvas) return 0;
      const context = canvas.getContext('2d');
      if (!context) return 0;
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      let lit = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit += 1;
      return lit;
    })();
    const narration = {
      dockHiddenAtStart, firstNarration, secondNarration, firstMode, firstHidden,
      inTranscript, inComposer, workingCards,
      canvasWidth: canvas?.width || 0,
      canvasPainted,
      stillWorkingSaid: (agentTranscript.textContent || '').includes('not streaming reasoning text')
    };

    // ── 5. An error turns the orb red before it leaves ───────────────────
    reset('outcome-orb-error');
    const errorRun = { ...runningRun('outcome-orb-error'), status: 'failed', result: { summary: 'Provider rate limit', success: false, verified: false, failure: classified } };
    handleAgentEvent({ type: 'run.failed', revision: 3, run: errorRun, result: errorRun.result });
    const errorMode = document.getElementById('agent-orb-dock')?.dataset.mode || '';
    const errorHidden = document.getElementById('agent-orb-dock')?.hidden !== false;

    // ── 6. The orb is removed when the run settles ───────────────────────
    reset('outcome-settle');
    const settleRun = runningRun('outcome-settle');
    handleAgentEvent({ type: 'assistant.narration', revision: 4, run: settleRun, text: 'Opening Blender' });
    const visibleBeforeSettle = document.getElementById('agent-orb-dock')?.hidden === false;
    handleAgentEvent({
      type: 'run.completed', revision: 5,
      run: { ...settleRun, status: 'completed', completedAt: Date.now(), result: { summary: 'Blender is open.', success: true, verified: true } },
      result: { summary: 'Blender is open.', success: true, verified: true }
    });
    const hiddenAfterSettle = document.getElementById('agent-orb-dock')?.hidden !== false;

    return { plain, classifiedPaint, parked, narration, errorMode, errorHidden, visibleBeforeSettle, hiddenAfterSettle };
  });

  // 1. The failure is visible at all — this is the regression.
  assert.equal(result.plain.length, 1, 'a failed run must paint exactly one failure row');
  assert.match(result.plain[0], /The provider rejected this connection\./, 'and it must carry the reason');

  // 2. The classified card names the cause and quotes the provider.
  assert.equal(result.classifiedPaint.title, 'Provider rate limit');
  assert.equal(result.classifiedPaint.provider, '429 Too Many Requests: rate limit reached for requests per min');
  assert.match(result.classifiedPaint.next, /Wait a moment and resume/);
  assert.equal(result.classifiedPaint.replies, 0, 'a failed run must not paint a success reply');

  // 3. A park says it is parked.
  assert.equal(result.parked.isParked, true, 'a parked run must use the parked style');
  assert.match(result.parked.resume, /Not finished/);
  assert.match(result.parked.resume, /Resuming automatically in about 15s/);

  // 4. Narration drives one suspended orb above the composer — no card.
  assert.equal(result.narration.dockHiddenAtStart, true, 'the orb must start hidden');
  assert.equal(result.narration.firstHidden, false, 'an action must reveal the orb');
  assert.equal(result.narration.firstNarration, 'Opening Blender');
  assert.equal(result.narration.firstMode, 'acting', 'a running action is the acting shape');
  assert.equal(result.narration.secondNarration, 'Clicking in Blender', 'a new action updates the orb in place');
  assert.equal(result.narration.inComposer, true, 'the orb must float over the composer');
  assert.equal(result.narration.inTranscript, false, 'it must never occupy a transcript slot');
  assert.equal(result.narration.workingCards, 0, 'no working card may be created for an action');
  assert.ok(result.narration.canvasWidth > 0, 'the canvas must be sized');
  assert.ok(result.narration.canvasPainted > 20, `the particle field must actually paint (lit pixels: ${result.narration.canvasPainted})`);
  assert.equal(result.narration.stillWorkingSaid, false, 'the old sentence must be gone');

  // 5. A failure is red before it leaves.
  assert.equal(result.errorHidden, false, 'the orb must be visible when the failure lands');
  assert.equal(result.errorMode, 'error', 'a failure must turn the orb red');

  // 6. Settling removes it.
  assert.equal(result.visibleBeforeSettle, true, 'the orb must be up while the run is live');
  assert.equal(result.hiddenAfterSettle, true, 'and gone the moment the run completes');

  const screenshot = path.join(os.tmpdir(), 'browser-use-agent-outcome.png');
  await window.screenshot({ path: screenshot });
  console.log(JSON.stringify({ ok: true, ...result, screenshot }, null, 2));
} finally {
  void app.evaluate(({ app: electronApp }) => { electronApp.quit(); return true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
