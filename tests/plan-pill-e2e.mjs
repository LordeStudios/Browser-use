import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

// The plan and goal pills, driven through the real app. The 2026-10-30 run
// asked for a plan and the user saw none — so "the agent stored a plan" and
// "the user can see a plan" have to be checked separately. The pill is painted
// by the renderer from the run state the main process sends over IPC, so the
// event is sent from the main process here.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-plan-'));

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const window = await mainRendererWindow(electronApp);
  window.setDefaultTimeout(20_000);
  await window.waitForSelector('#settings-toggle');

  await electronApp.evaluate(({ BrowserWindow }, payload) => {
    for (const target of BrowserWindow.getAllWindows()) target.webContents.send('browser-use:agent-event', payload);
  }, {
    type: 'run.started',
    revision: 1,
    run: {
      id: 'plan-pill-check', status: 'running', title: 'Plan check',
      // The shape the agent publishes: every item is {id, text, status}.
      plan: [
        { id: 'p1', text: 'Replace the weather icon with the standard set', status: 'current' },
        { id: 'p2', text: 'Rebuild the card with the official logos', status: 'pending' },
        { id: 'p3', text: 'Use the light theme', status: 'pending' }
      ],
      goals: [{ id: 'g1', text: 'Ship the homepage redesign', status: 'current' }]
    }
  });

  await window.waitForFunction(() => {
    const plan = document.querySelector('#agent-plan');
    return plan && !plan.hidden && (plan.textContent || '').includes('Replace the weather icon');
  }, undefined, { timeout: 10_000 });

  const planText = await window.locator('#agent-plan').textContent();
  assert.ok(/0\/3|1\/3/.test(planText), `the pill must count the plan items, got: ${planText.replace(/\s+/g, ' ')}`);
  assert.ok(planText.includes('Replace the weather icon'), 'the pill must name the current step');
  assert.ok(planText.includes('Rebuild the card'), 'the pill must list the pending steps');

  const goalText = await window.locator('#agent-goal').textContent();
  assert.ok(goalText.includes('Ship the homepage redesign'), `the goal pill must show the goal, got: ${goalText.replace(/\s+/g, ' ')}`);

  console.log('PLAN PILL E2E OK');
} finally {
  await electronApp.close().catch(() => {});
}

async function mainRendererWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main renderer did not load within 30 seconds.');
}
