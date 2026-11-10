import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-agent-outcome-'));
const app = await electron.launch({
  executablePath,
  args: ['.', `--user-data-dir=${profile}`],
  cwd: root,
  env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const deadline = Date.now() + 20_000;
  let window;
  while (!window && Date.now() < deadline) {
    window = app.windows().find((candidate) => candidate.url().endsWith('/desktop/renderer/index.html'));
    if (!window) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(window, 'Desktop main renderer did not load.');
  await window.waitForSelector('#agent-toggle');
  await window.click('#agent-toggle');
  await window.waitForSelector('#agent-panel:not([hidden])');
  const outcome = await window.evaluate(() => {
    visibleConversationId = 'outcome-e2e';
    retiredConversationIds.delete(visibleConversationId);
    chatRun = null;
    activeChatRun = null;
    lastAssistantReplyByRun.clear();
    discardLiveThought();
    agentTranscript.replaceChildren();
    const run = { id: visibleConversationId, title: 'Outcome fixture', status: 'failed', step: 1, plan: [], result: { summary: 'The provider rejected this connection.', success: false, verified: false, reason: 'provider_external_block' } };
    handleAgentEvent({ type: 'run.failed', revision: 1, run, result: run.result });
    return {
      errors: [...agentTranscript.querySelectorAll('.agent-message.is-error')].map((node) => ({ body: node.querySelector('p')?.textContent || '', detail: node.querySelector('code')?.textContent || '' })),
      replies: [...agentTranscript.querySelectorAll('.agent-message.is-assistant')].map((node) => node.textContent)
    };
  });
  assert.deepEqual(outcome.replies, [], 'a failed run must not paint a success reply');
  assert.deepEqual(outcome.errors, [{ body: 'Agent run failed', detail: 'The provider rejected this connection.' }]);
  const screenshot = path.join(os.tmpdir(), 'browser-use-agent-outcome.png');
  await window.screenshot({ path: screenshot });
  console.log(JSON.stringify({ ok: true, failedRunRenderedAsError: true, screenshot }, null, 2));
} finally {
  // The broker is a detached child by design, so Playwright app.close() may
  // wait after the visible Desktop process has already exited. Quit the real
  // app directly, matching the terminal-persistence acceptance path.
  void app.evaluate(({ app }) => { app.quit(); return true; }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
