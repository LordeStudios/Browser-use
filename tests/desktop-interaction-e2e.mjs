import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Matches APP_CHROME_HEIGHT in desktop/main.cjs.
const APP_CHROME_HEIGHT = 78;
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-desktop-'));
const gptActionPublicOrigin = 'https://gpt-browser.lordemaximus.com';
const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_GPT_ACTION_PUBLIC_ORIGIN: gptActionPublicOrigin }
});

try {
  const window = await mainRendererWindow(electronApp);
  window.setDefaultTimeout(15_000);
  await window.waitForSelector('#settings-toggle');
  await window.waitForFunction(() => window.browserUseDesktop.viewportMetrics().then((metrics) => Boolean(metrics?.attached && metrics.bounds)));
  // The agent panel is rendered in the BrowserWindow rather than a transparent
  // BrowserView, so it remains clickable while the native browser surface owns
  // its reserved strip.
  // Chat 1 starts docked by design; verify the startup state instead of
  // toggling it closed before testing its reserved browser stage.
  await assertPanelVisible(window, '#agent-panel');
  const agentViewport = await window.evaluate(async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const metrics = await window.browserUseDesktop.viewportMetrics();
      if (metrics?.attached && metrics.bounds && metrics.bounds.width < metrics.content.width) return metrics;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The native browsing surface did not reserve space for the agent drawer.');
  });
  assert.equal(agentViewport.bounds.width < agentViewport.content.width, true, 'agent panel must reserve native browser width');
  await window.locator('#agent-settings-toggle').click();
  assert.equal(await window.locator('#agent-settings-screen').isVisible(), true, 'chat settings must be a full chat-window screen');
  const chatBox = await window.locator('#agent-panel').boundingBox();
  const settingsBox = await window.locator('#agent-settings-screen').boundingBox();
  assert.ok(chatBox && settingsBox && Math.abs(chatBox.width - settingsBox.width) < 2 && Math.abs(chatBox.height - settingsBox.height) < 2, 'chat settings must fill the chat window without opening app settings');
  assert.equal(await window.locator('#agent-provider-model').count(), 0, 'provider onboarding must discover models instead of accepting a manual model ID');
  assert.equal(await window.locator('#agent-provider-baseurl-field').isVisible(), true, 'Ollama setup must show its gateway URL');
  await window.locator('#agent-provider-select-trigger').click();
  assert.equal(await window.locator('#agent-provider-select-menu').isVisible(), true, 'provider catalog must expand inside chat settings');
  assert.equal((await window.locator('#agent-provider-select-menu').innerText()).includes('OpenAI'), true, 'provider catalog must include Studio onboarding providers');
  assert.equal((await window.locator('#agent-provider-select-menu').innerText()).includes('OpenRouter'), true, 'provider catalog must include OpenRouter');
  await window.locator('#agent-provider-select-menu button[data-provider="deepseek"]').click();
  assert.match(await window.locator('#agent-provider-baseurl').inputValue(), /api\.deepseek\.com/, 'provider selection must apply its real onboarding endpoint');
  await window.locator('#agent-provider-select-trigger').click();
  await window.locator('#agent-provider-select-menu button[data-provider="cloud"]').click();
  assert.equal(await window.locator('#agent-provider-baseurl-field').isHidden(), true, 'cloud setup must not show the Ollama gateway URL');
  assert.equal(await window.locator('#agent-provider-key-field').isVisible(), true, 'cloud setup must show the secure API key controls');
  await window.locator('#agent-settings-close').click();
  assert.equal(await window.locator('#agent-settings-screen').isHidden(), true, 'back must return to the same chat window');
  await window.locator('#agent-model-toggle').click();
  assert.equal(await window.locator('.agent-model-menu-search input').isVisible(), true, 'model picker must use the Studio searchable drawer');
  const modelSearch = window.locator('.agent-model-menu-search input');
  await modelSearch.type('op');
  assert.equal(await modelSearch.inputValue(), 'op', 'model search must retain every typed character without replacing its focused input');
  assert.equal(await modelSearch.evaluate((input) => document.activeElement === input), true, 'model search must retain focus while filtering');
  const modelDrawer = await window.locator('#agent-model-menu').boundingBox();
  assert.ok(modelDrawer && Math.abs(modelDrawer.width - 280) < 2 && modelDrawer.height <= 360, 'model drawer must retain Studio dimensions');
  await window.locator('#agent-model-toggle').click();
  await window.locator('#agent-toggle').click();
  await assertPanelHidden(window, '#agent-panel');
  await window.locator('#agent-toggle').click();
  await assertPanelVisible(window, '#agent-panel');
  assert.equal(await window.locator('#agent-settings-screen').isHidden(), true, 'reopening chat must not leave its full-screen settings screen over the conversation');
  const assistantPaint = await window.evaluate(() => {
    const message = renderChatMessage('assistant', 'Visible final reply');
    const style = getComputedStyle(message.querySelector('p'));
    const paint = { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight };
    message.remove();
    return paint;
  });
  assert.equal(assistantPaint.color, 'rgb(255, 255, 255)', 'final model replies must render as full white text');
  assert.equal(assistantPaint.fontSize, '14px', 'final model replies must use a natural chat-size font');
  assert.equal(assistantPaint.fontWeight, '400', 'final model replies must not use oversized display weight');
  const thoughtLifecycle = await window.evaluate(() => {
    chatRun = null;
    visibleConversationId = 'thought-lifecycle-test';
    retiredConversationIds.delete(visibleConversationId);
    discardLiveThought();
    agentTranscript.replaceChildren();
    const baseRun = { id: 'thought-lifecycle-test', title: 'Inspect page', status: 'running', step: 1, result: null, plan: [] };
    handleAgentEvent({ type: 'assistant.thinking', revision: 1, run: baseRun, thoughtId: 'phase-1', elapsedMs: 0 });
    const immediate = {
      count: agentTranscript.querySelectorAll('.agent-message.is-thinking').length,
      summary: activeThoughtMessage.querySelector('summary').textContent,
      body: activeThoughtMessage.querySelector('.agent-thinking-content').textContent
    };
    activeThoughtMessage.dataset.startedAt = String(Date.now() - 6_200);
    handleAgentEvent({ type: 'assistant.thinking', revision: 2, run: baseRun, thoughtId: 'phase-1', elapsedMs: 100 });
    const monotonic = activeThoughtMessage.querySelector('summary').textContent;
    handleAgentEvent({ type: 'assistant.thought', revision: 3, run: baseRun, thoughtId: 'phase-1', text: 'Inspecting the visible controls.', elapsedMs: 200 });
    const realThought = activeThoughtMessage.querySelector('.agent-thinking-content').textContent;
    handleAgentEvent({ type: 'assistant.thinking.completed', revision: 4, run: baseRun, thoughtId: 'phase-1', elapsedMs: 300 });
    const firstSettled = agentTranscript.querySelector('.agent-message summary').textContent;
    handleAgentEvent({ type: 'assistant.thinking', revision: 5, run: { ...baseRun, step: 2 }, thoughtId: 'phase-2', elapsedMs: 0 });
    const nextPhase = {
      cards: agentTranscript.querySelectorAll('.agent-message details').length,
      activeId: activeThoughtMessage.dataset.thoughtId,
      summary: activeThoughtMessage.querySelector('summary').textContent
    };
    handleAgentEvent({ type: 'assistant.thinking.completed', revision: 6, run: { ...baseRun, step: 2 }, thoughtId: 'phase-2', elapsedMs: 10 });
    return { immediate, monotonic, realThought, firstSettled, nextPhase };
  });
  assert.deepEqual(thoughtLifecycle.immediate, {
    count: 1,
    summary: 'Thinking… 0s',
    body: ''
  }, 'the first provider event must paint a visible thinking card immediately');
  assert.equal(thoughtLifecycle.monotonic, 'Thinking… 6s', 'a later low elapsed event must not reset an existing thought clock');
  assert.equal(thoughtLifecycle.realThought, 'Inspecting the visible controls.', 'real provider thought must paint in place');
  const monotonicSeconds = Number(thoughtLifecycle.monotonic.match(/(\d+)s$/)?.[1]);
  const settledSeconds = Number(thoughtLifecycle.firstSettled.match(/(\d+)s$/)?.[1]);
  assert.ok(Number.isInteger(settledSeconds) && settledSeconds >= monotonicSeconds, 'the decision boundary must preserve the monotonic duration while settling');
  const thoughtPrivacy = await window.evaluate(() => {
    activeChatRun = null;
    chatRun = { id: 'thought-privacy', task: 'Inspect the visible page', status: 'running', step: 1, plan: [] };
    visibleConversationId = chatRun.id;
    retiredConversationIds.delete(visibleConversationId);
    discardLiveThought();
    agentTranscript.replaceChildren();
    updateLiveThought('Checking visible evidence.\n{"actions":[{"name":"browser_mousemove","input":{"x":20,"y":20}}]}\nConfirming JSON response format.', 0, 'privacy-phase');
    const hiddenProtocol = activeThoughtMessage.querySelector('.agent-thinking-content').textContent;
    discardLiveThought();
    agentTranscript.replaceChildren();
    return hiddenProtocol;
  });
  assert.match(thoughtPrivacy, /Checking visible evidence\./, 'normal thinking must remain visible');
  assert.doesNotMatch(thoughtPrivacy, /json|browser_mousemove|"actions"/i, 'agent protocol payloads and internal JSON wording must not leak into normal user-facing thinking');
  assert.deepEqual(thoughtLifecycle.nextPhase, { cards: 2, activeId: 'phase-2', summary: 'Thinking… 0s' }, 'a later model decision must own a new thought card and clock');
  const cancelledThought = await window.evaluate(() => {
    visibleConversationId = 'cancelled-thought-test';
    retiredConversationIds.delete(visibleConversationId);
    chatRun = null;
    activeChatRun = null;
    discardLiveThought();
    agentTranscript.replaceChildren();
    const run = { id: visibleConversationId, title: 'Cancelled thought', status: 'running', step: 1, result: null, plan: [] };
    handleAgentEvent({ type: 'assistant.thinking', revision: 1, run, thoughtId: 'cancelled-phase', elapsedMs: 1_250 });
    handleAgentEvent({ type: 'run.cancelled', revision: 2, run: { ...run, status: 'cancelled' } });
    const summary = agentTranscript.querySelector('summary')?.textContent || '';
    return {
      summary,
      timerCleared: activeThoughtTimer === null,
      activeCleared: activeThoughtMessage === null,
      stillThinking: agentTranscript.querySelector('.is-thinking') !== null
    };
  });
  assert.equal(cancelledThought.timerCleared, true, 'run.cancelled must clear the live thought interval');
  assert.equal(cancelledThought.activeCleared, true, 'run.cancelled must release the active thought owner');
  assert.equal(cancelledThought.stillThinking, false, 'run.cancelled must leave a terminal thought card rather than a live counter');
  assert.match(cancelledThought.summary, /^Thought for \d+s$/, 'run.cancelled must freeze the measured thought duration');
  const conversationScopedPlan = await window.evaluate(() => {
    discardLiveThought();
    agentTranscript.replaceChildren();
    renderPlan([]);
    retiredConversationIds.add('old-conversation');
    visibleConversationId = null;
    handleAgentEvent({ type: 'plan.updated', revision: 10, run: { id: 'old-conversation', title: 'Old', status: 'cancelled', step: 2, plan: [{ text: 'Old task', status: 'current' }] }, plan: [{ text: 'Old task', status: 'current' }] });
    const staleOnFreshChat = !agentPlan.hidden;
    handleAgentEvent({ type: 'run.started', revision: 1, run: { id: 'new-conversation', title: 'New', status: 'running', step: 0, plan: [] } });
    handleAgentEvent({ type: 'plan.updated', revision: 2, run: { id: 'new-conversation', title: 'New', status: 'running', step: 1, plan: [{ text: 'New task', status: 'current' }] }, plan: [{ text: 'New task', status: 'current' }] });
    const currentTitle = agentPlanTitle.textContent;
    handleAgentEvent({ type: 'plan.updated', revision: 11, run: { id: 'old-conversation', title: 'Old', status: 'cancelled', step: 3, plan: [{ text: 'Repainted old task', status: 'current' }] }, plan: [{ text: 'Repainted old task', status: 'current' }] });
    const titleAfterStaleEvent = agentPlanTitle.textContent;
    renderPlan([]);
    discardLiveThought();
    return { staleOnFreshChat, currentTitle, titleAfterStaleEvent };
  });
  assert.equal(conversationScopedPlan.staleOnFreshChat, false, 'a retired conversation must not attach its plan to a fresh chat');
  assert.equal(conversationScopedPlan.currentTitle, 'New task', 'the visible conversation must render its own plan');
  assert.equal(conversationScopedPlan.titleAfterStaleEvent, 'New task', 'a late old-conversation event must not replace the visible plan');
  const floatingPlan = await window.evaluate(() => {
    visibleConversationId = 'floating-plan-test';
    retiredConversationIds.delete(visibleConversationId);
    const baseRun = { id: 'floating-plan-test', title: 'Draw a hut', status: 'running', step: 1, result: null };
    const plan = [
      { id: 'walls', text: 'Draw the walls', status: 'done' },
      { id: 'roof', text: 'Draw the roof', status: 'current' },
      { id: 'verify', text: 'Verify the hut', status: 'pending' }
    ];
    handleAgentEvent({ type: 'plan.updated', revision: 30, run: { ...baseRun, plan }, plan });
    const planBox = agentPlan.getBoundingClientRect();
    const composerBox = agentForm.getBoundingClientRect();
    const collapsed = {
      visible: !agentPlan.hidden,
      count: agentPlanCount.textContent,
      title: agentPlanTitle.textContent,
      aboveComposer: planBox.bottom <= composerBox.top,
      position: getComputedStyle(document.querySelector('#agent-progress-strip')).position
    };
    agentPlanToggle.click();
    const expanded = {
      visible: !agentPlanList.hidden,
      rows: agentPlanList.querySelectorAll('.agent-plan-row').length,
      labels: [...agentPlanList.querySelectorAll('.agent-plan-row > span:last-child')].map((node) => node.textContent),
      ariaExpanded: agentPlanToggle.getAttribute('aria-expanded')
    };
    handleAgentEvent({ type: 'tool.result', revision: 31, run: { ...baseRun, plan }, tool: 'update_plan', output: { ok: true, result: { tasks: 3 } } });
    const planToolCards = [...agentTranscript.querySelectorAll('.agent-message.is-tool')].filter((item) => item.textContent.includes('update_plan')).length;
    renderPlan([]);
    return { collapsed, expanded, planToolCards, hiddenAfterClear: agentPlan.hidden };
  });
  assert.deepEqual(floatingPlan.collapsed, { visible: true, count: '1/3', title: 'Draw the roof', aboveComposer: true, position: 'absolute' }, 'the active task list must render as a floating progress pill above the composer');
  assert.deepEqual(floatingPlan.expanded, { visible: true, rows: 3, labels: ['Draw the walls', 'Draw the roof', 'Verify the hut'], ariaExpanded: 'true' }, 'the floating pill must expand into the complete model-owned task list');
  assert.equal(floatingPlan.planToolCards, 0, 'task bookkeeping must not duplicate itself as transcript action cards');
  assert.equal(floatingPlan.hiddenAfterClear, true, 'clearing all model tasks must remove the floating pill');
  const terminalReplyPaint = await window.evaluate(() => {
    chatRun = null;
    visibleConversationId = 'terminal-summary-test';
    retiredConversationIds.delete(visibleConversationId);
    lastAssistantReplyByRun.clear();
    discardLiveThought();
    agentTranscript.replaceChildren();
    const baseRun = { id: 'terminal-summary-test', title: 'Canvas inspection', status: 'running', step: 1, result: null, plan: [] };
    handleAgentEvent({ type: 'tool.result', revision: 1, run: baseRun, tool: 'browser_done', output: { ok: false, recoverable: true, summary: 'False terminal reply', error: 'More evidence is required.' } });
    const rejected = {
      replies: [...agentTranscript.querySelectorAll('.agent-message.is-assistant p')].map((node) => node.textContent),
      recovery: [...agentTranscript.querySelectorAll('.agent-message.is-stale p')].map((node) => node.textContent)
    };
    agentTranscript.replaceChildren();
    handleAgentEvent({ type: 'assistant.thought', revision: 1, run: baseRun, text: 'Checking the canvas.', elapsedMs: 500 });
    handleAgentEvent({ type: 'tool.result', revision: 2, run: baseRun, tool: 'browser_done', output: { ok: true, summary: 'The canvas contains one ellipse.', success: true, verified: true } });
    const immediate = [...agentTranscript.querySelectorAll('.agent-message.is-assistant > p')].map((node) => ({ text: node.textContent, color: getComputedStyle(node).color }));
    agentTranscript.replaceChildren();
    renderChatState({ ...baseRun, status: 'completed', result: { summary: 'The state fallback paints the final reply.' } });
    const fallback = [...agentTranscript.querySelectorAll('.agent-message.is-assistant > p')].map((node) => ({ text: node.textContent, color: getComputedStyle(node).color }));
    return { rejected, immediate, fallback };
  });
  assert.deepEqual(terminalReplyPaint.rejected.replies, [], 'a rejected browser_done must not paint a false assistant reply');
  assert.deepEqual(terminalReplyPaint.rejected.recovery, [], 'rejected completion bookkeeping must remain silent, matching the checkpoint renderer');
  assert.deepEqual(terminalReplyPaint.immediate, [{ text: 'The canvas contains one ellipse.', color: 'rgb(255, 255, 255)' }], 'browser_done must immediately paint its real final summary instead of leaving only thought text');
  assert.deepEqual(terminalReplyPaint.fallback, [{ text: 'The state fallback paints the final reply.', color: 'rgb(255, 255, 255)' }], 'terminal state must recover a final reply if its IPC event is delayed');
  // Keyboard submission must take the same route as the Send button, but this
  // browser test must not require an installed model provider. Replace only the
  // main-process test IPC handler; the context-isolated renderer bridge stays
  // identical to production.
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('browser-use:agent-start');
    ipcMain.handle('browser-use:agent-start', (_event, request) => ({ id: 'keyboard-test', status: 'completed', task: request.task, history: [] }));
  });
  const composer = window.locator('#agent-task');
  await composer.focus();
  assert.deepEqual(await composer.evaluate((input) => {
    const style = getComputedStyle(input);
    return { outline: style.outlineStyle, shadow: style.boxShadow };
  }), { outline: 'none', shadow: 'none' }, 'composer focus must not draw a highlight ring');
  await composer.fill('first line');
  await composer.press('Shift+Enter');
  await composer.type('second line');
  assert.equal(await composer.evaluate((element) => element.value), 'first line\nsecond line', 'Shift+Enter must retain a textarea newline');
  assert.equal((await window.locator('#agent-transcript').innerText()).includes('first line'), false, 'Shift+Enter must not start an agent run');
  await composer.press('Enter');
  await window.waitForFunction(() => document.querySelector('#agent-transcript')?.innerText?.includes('first line'));
  assert.equal(await composer.evaluate((element) => element.value), '', 'plain Enter must submit rather than leave a newline in the composer');
  assert.match(await window.locator('#agent-transcript').innerText(), /first line\s+second line/);
  const copyChat = window.locator('#agent-copy-chat');
  await copyChat.click();
  await window.waitForFunction(() => document.querySelector('#agent-copy-chat')?.classList.contains('is-copied'));
  assert.equal(await copyChat.innerText(), '', 'copy feedback must retain the icon rather than replacing it with text');
  await window.waitForFunction(() => !document.querySelector('#agent-copy-chat')?.classList.contains('is-copied'));
  assert.equal(await copyChat.innerText(), '', 'copy icon must return to its normal state without disappearing');
  await composer.fill('IME text');
  await composer.evaluate((element) => {
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true });
    element.dispatchEvent(event);
  });
  assert.equal(await composer.evaluate((element) => element.value), 'IME text', 'Enter while composing IME text must not submit or clear the composer');
  // An active task must not lock the rest of the chat shell. The production
  // handler returns a live run snapshot immediately; this IPC double gives the
  // renderer that same contract without requiring a configured provider.
  await electronApp.evaluate(({ ipcMain }) => {
    globalThis.__browserUseAgentControlCancels = [];
    ipcMain.removeHandler('browser-use:agent-start');
    ipcMain.removeHandler('browser-use:agent-cancel');
    ipcMain.removeHandler('browser-use:agent-state');
    ipcMain.handle('browser-use:agent-state', () => ({ id: 'handoff-controls', title: 'Handoff control test', status: 'running', step: 0, history: [], plan: [] }));
    ipcMain.handle('browser-use:agent-start', (_event, request) => ({
      id: `active-controls-${request.task}`,
      title: 'Active control test',
      status: 'running',
      step: 1,
      task: request.task,
      history: [],
      plan: []
    }));
    ipcMain.handle('browser-use:agent-cancel', (_event, request) => {
      globalThis.__browserUseAgentControlCancels.push(request.runId);
      return { id: request.runId, title: 'Active control test', status: 'cancelled', step: 1, history: [], plan: [] };
    });
  });
  await window.evaluate(() => renderChatState({ status: 'starting agent', step: 0, history: [], plan: [] }));
  assert.equal(await window.locator('#agent-cancel').isDisabled(), false, 'Stop must remain clickable while the live run ID is being handed off');
  await window.locator('#agent-cancel').click();
  await window.waitForFunction(() => document.querySelector('#agent-cancel')?.hidden);
  assert.deepEqual(await electronApp.evaluate(() => globalThis.__browserUseAgentControlCancels), ['handoff-controls'], 'Stop must resolve the just-created live run ID instead of waiting for the run to finish');
  await composer.fill('keep controls interactive');
  await composer.press('Enter');
  await window.waitForFunction(() => {
    const stop = document.querySelector('#agent-cancel');
    return !stop.hidden && !stop.disabled && document.querySelector('#agent-send')?.disabled;
  });
  assert.equal(await window.locator('#agent-new-chat').isDisabled(), false, 'New chat must stay interactive while an agent run is active');
  assert.equal(await window.locator('#agent-history').isDisabled(), false, 'History must stay interactive while an agent run is active');
  await window.locator('#agent-history').click();
  await assertPanelVisible(window, '#agent-history-view');
  assert.equal(await window.locator('#agent-cancel').isDisabled(), false, 'opening history must retain a usable Stop target for the live run');
  await window.locator('#agent-history-close').click();
  await window.locator('#agent-new-chat').click();
  await window.waitForFunction(() => !document.querySelector('#agent-send')?.disabled && document.querySelector('#agent-transcript')?.childElementCount === 0);
  assert.deepEqual(await electronApp.evaluate(() => globalThis.__browserUseAgentControlCancels), [
    'handoff-controls'
  ], 'New chat must HAND OFF the running task to the background, never cancel it');
  await composer.fill('stop this active run');
  await composer.press('Enter');
  await window.waitForFunction(() => !document.querySelector('#agent-cancel')?.hidden && !document.querySelector('#agent-cancel')?.disabled);
  await window.locator('#agent-cancel').click();
  await window.waitForFunction(() => document.querySelector('#agent-cancel')?.hidden && !document.querySelector('#agent-send')?.disabled);
  assert.deepEqual(await electronApp.evaluate(() => globalThis.__browserUseAgentControlCancels), [
    'handoff-controls',
    'active-controls-stop this active run'
  ], 'Stop must cancel the actual live run ID rather than a saved or placeholder chat state');
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('browser-use:agent-start');
    ipcMain.removeHandler('browser-use:agent-cancel');
    ipcMain.removeHandler('browser-use:agent-state');
    delete globalThis.__browserUseAgentControlCancels;
  });
  await window.locator('[data-close="agent"]').click();
  await assertPanelHidden(window, '#agent-panel');
  // The browsing surface must fill the window below the chrome from first paint,
  // not only after a drawer toggle forces the native view to be reattached.
  await assertViewportFills(window, 'initial layout');
  assert.equal(await selectedTabDevToolsOpen(electronApp), false, 'loading the initial page must not open Chromium DevTools');
  assert.equal((await window.evaluate(() => window.browserUseDesktop.state())).activeDrawer, null, 'loading the initial page must not open a drawer');
  assert.equal(await window.locator('#console-panel').isHidden(), true, 'loading the initial page must keep the Console hidden');

  await electronApp.evaluate(async ({ BrowserWindow }) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    const view = shell.getBrowserViews().find((candidate) => !candidate.webContents.getURL().endsWith('/overlay.html'));
    await view.webContents.loadURL('data:text/html,<title>Console opt-in fixture</title><script>console.log("BROWSERUSE_CONSOLE_FIXTURE")</script>');
  });
  await window.waitForFunction(() => window.browserUseDesktop.consoleEntries().then((entries) => entries.some((entry) => entry.message === 'BROWSERUSE_CONSOLE_FIXTURE')));
  assert.equal(await selectedTabDevToolsOpen(electronApp), false, 'page console output and navigation must not open DevTools');
  assert.equal((await window.evaluate(() => window.browserUseDesktop.state())).activeDrawer, null, 'page console output must not open the in-app Console');
  assert.equal(await window.locator('#console-panel').isHidden(), true, 'page console output must leave the Console hidden');

  await resizeWindow(electronApp, 1180, 840);
  await assertViewportFills(window, 'after shrinking the window');
  await resizeWindow(electronApp, 1320, 900);
  await assertViewportFills(window, 'after growing the window');

  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).maximize());
  await assertViewportFills(window, 'after maximize');
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).unmaximize());
  await assertViewportFills(window, 'after unmaximize');
  await window.waitForFunction(() => !document.querySelector('#copy-mcp').disabled);
  const mcpConfiguration = await window.evaluate(() => window.browserUseDesktop.mcpConnectionConfiguration());
  assert.match(mcpConfiguration.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  assert.match(mcpConfiguration.pairingEndpoint, /^http:\/\/127\.0\.0\.1:\d+\/pair$/);
  assert.equal(mcpConfiguration.gptEnabled, true);
  assert.equal(mcpConfiguration.gptOpenApiEndpoint, `${gptActionPublicOrigin}/gpt/openapi.json`);

  await window.locator('#settings-toggle').click();
  await assertPanelVisible(window, '#settings-panel');
  await assertOverlayPanelVisible(electronApp, '#settings-panel');
  await assertOverlayTopmost(electronApp, 'Settings');
  await window.locator('#settings-toggle').click();
  await assertPanelHidden(window, '#settings-panel');

  await window.locator('#console-toggle').click();
  await assertPanelVisible(window, '#console-panel');
  await assertOverlayPanelVisible(electronApp, '#console-panel');
  await assertOverlayTopmost(electronApp, 'Console');
  await window.locator('#console-toggle').click();
  await assertPanelHidden(window, '#console-panel');

  const deviceButtonBox = await window.locator('#device-toggle').boundingBox();
  await window.locator('#device-toggle').click();
  await window.waitForFunction(() => document.querySelector('#device-toggle').getAttribute('aria-expanded') === 'true');
  await assertOverlayPanelVisible(electronApp, '#device-menu');
  await assertOverlayTopmost(electronApp, 'Device menu');
  const deviceMenuBox = await overlayWindow(electronApp).locator('#device-menu').boundingBox();
  assert.ok(deviceButtonBox && deviceMenuBox, 'device button and overlay menu must have visible boxes');
  assert.ok(Math.abs((deviceMenuBox.x + deviceMenuBox.width) - (deviceButtonBox.x + deviceButtonBox.width)) < 3, `device menu must right-align with its toolbar button: ${deviceMenuBox.x + deviceMenuBox.width} vs ${deviceButtonBox.x + deviceButtonBox.width}`);
  // The overlay renderer's y=0 is the chrome's bottom edge, so its box must be
  // converted to window coordinates before it can be compared with the button.
  // Comparing the two renderers' raw values hid a full chrome-height gap.
  const menuWindowTop = deviceMenuBox.y + APP_CHROME_HEIGHT;
  const buttonBottom = deviceButtonBox.y + deviceButtonBox.height;
  assert.ok(menuWindowTop >= buttonBottom - 2, `device menu must start below its toolbar button: ${menuWindowTop} vs ${buttonBottom}`);
  assert.ok(menuWindowTop - buttonBottom <= 12, `device menu must sit just below its toolbar button, not a chrome-height away: gap ${menuWindowTop - buttonBottom}px`);
  await window.locator('#device-toggle').click();
  await window.waitForFunction(() => document.querySelector('#device-toggle').getAttribute('aria-expanded') === 'false');

  await window.locator('#settings-toggle').click();
  await assertPanelVisible(window, '#settings-panel');
  await assertOverlayPanelVisible(electronApp, '#settings-panel');
  await assertOverlayTopmost(electronApp, 'Settings after menu transitions');
  const settingsOverlay = overlayWindow(electronApp);
  const settingsText = await settingsOverlay.locator('#settings-panel').innerText();
  assert.match(settingsText, /short-lived pairing header/i, 'the UI must describe the recoverable header bootstrap');
  assert.doesNotMatch(settingsText, /one-time pairing/i, 'the UI must not promise a one-time credential after recovery support was added');
  await settingsOverlay.locator('#gpt-action-public-origin').scrollIntoViewIfNeeded();
  assert.equal(await settingsOverlay.locator('#gpt-action-public-origin').inputValue(), gptActionPublicOrigin);
  assert.equal(await settingsOverlay.locator('#gpt-openapi-url').textContent(), `${gptActionPublicOrigin}/gpt/openapi.json`);
  assert.notEqual(await settingsOverlay.locator('#gpt-api-key').textContent(), 'Disabled');
  const initialGptSetup = JSON.parse(await settingsOverlay.locator('#gpt-action-schema').textContent());
  assert.equal(initialGptSetup.importUrl, `${gptActionPublicOrigin}/gpt/openapi.json`);
  assert.equal(initialGptSetup.auth.name, 'X-API-Key');

  await settingsOverlay.locator('#copy-claude-code-mcp').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#copy-claude-code-mcp').textContent === 'Copied');
  const claudeCodeCommand = await electronApp.evaluate(({ clipboard }) => clipboard.readText());
  const claudeCodeMatch = /^claude mcp add-json --scope user browser-use-desktop "(.+)"$/.exec(claudeCodeCommand);
  assert.ok(claudeCodeMatch, 'the Claude Code button must copy a shell-safe add-json command without the PowerShell-only --% token');
  assert.ok(!claudeCodeCommand.includes('--%'), 'the copied command must never contain the PowerShell stop-parsing token');
  const claudeCodeConfiguration = JSON.parse(claudeCodeMatch[1].replaceAll('\\"', '"'));
  assert.equal(claudeCodeConfiguration.type, 'http');
  assert.equal(claudeCodeConfiguration.url, mcpConfiguration.endpoint);
  assert.equal(claudeCodeConfiguration.headersHelper, `curl.exe -fsS --max-time 5 ${mcpConfiguration.authenticationEndpoint}`);
  assert.match(await settingsOverlay.locator('#mcp-note').textContent(), /fresh pairing code automatically/i);

  await settingsOverlay.locator('#create-pairing').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#mcp-command').textContent.includes('X-Browser-Use-Pairing-Code'));
  const manualPairingConnection = JSON.parse(await settingsOverlay.locator('#mcp-command').textContent());
  await settingsOverlay.locator('#copy-pairing-code').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#copy-pairing-code').textContent === 'Copied');
  assert.equal(await electronApp.evaluate(({ clipboard }) => clipboard.readText()), manualPairingConnection.headers['X-Browser-Use-Pairing-Code']);
  await settingsOverlay.locator('#copy-mcp').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#copy-mcp').textContent === 'Copied');
  assert.match(await settingsOverlay.locator('#mcp-command').textContent(), /mcpEndpoint/);
  assert.match(await settingsOverlay.locator('#mcp-command').textContent(), /Mcp-Session-Id/);
  await settingsOverlay.locator('#copy-gpt-schema').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#copy-gpt-schema').textContent === 'Copied');
  const copiedGptSetup = JSON.parse(await electronApp.evaluate(({ clipboard }) => clipboard.readText()));
  assert.equal(copiedGptSetup.importUrl, `${gptActionPublicOrigin}/gpt/openapi.json`);
  assert.equal(copiedGptSetup.auth.name, 'X-API-Key');

  // Settings now uses an overlay BrowserView above the browsing view. The page
  // remains attached and correctly sized, while the overlay owns input.
  await assertViewportFills(window, 'while Settings is open');
  await assertOverlayTopmost(electronApp, 'Settings retains input ownership');
  await resizeWindow(electronApp, 1260, 880);

  await settingsOverlay.locator('#gpt-action-public-origin').fill('https://actions.example.test/');
  await settingsOverlay.locator('#settings-form .save-button').click();
  await settingsOverlay.waitForFunction(() => document.querySelector('#settings-form .save-button').textContent === 'Saved');
  await settingsOverlay.waitForFunction(() => document.querySelector('#gpt-openapi-url').textContent === 'https://actions.example.test/gpt/openapi.json');
  const savedGptSetup = JSON.parse(await settingsOverlay.locator('#gpt-action-schema').textContent());
  assert.equal(savedGptSetup.importUrl, 'https://actions.example.test/gpt/openapi.json');
  assert.equal(savedGptSetup.auth.name, 'X-API-Key');
  await settingsOverlay.locator('#close-settings').click();
  await assertPanelHidden(window, '#settings-panel');
  await assertViewportFills(window, 'after closing Settings');

  await window.locator('#console-toggle').click();
  await assertPanelVisible(window, '#console-panel');
  await window.locator('[data-filter="network"]').click();
  assert.ok(await window.locator('[data-filter="network"]').evaluate((button) => button.classList.contains('is-active')));
  await window.locator('#clear-console').click();
  await window.locator('[data-close="console"]').click();
  await assertPanelHidden(window, '#console-panel');
  await assertViewportFills(window, 'after closing Console');

  const initialTabCount = await window.locator('[data-tab-id]').count();
  await window.locator('#new-tab').click();
  await window.waitForFunction((count) => document.querySelectorAll('[data-tab-id]').length === count + 1, initialTabCount);
  await assertViewportFills(window, 'after opening a tab');
  await window.locator('[data-tab-id] .tab-close').last().click();
  await window.waitForFunction((count) => document.querySelectorAll('[data-tab-id]').length === count, initialTabCount);
  await window.waitForFunction(() => window.browserUseDesktop.viewportMetrics().then((metrics) => metrics.bounds.width === metrics.expected.width));
  await assertViewportFills(window, 'after closing a tab');

  // Browser controls can legitimately retain focus after clicking the close
  // control. Explicitly returning focus to the native tab must work before the
  // next browser interaction.
  await electronApp.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html'));
    win.getBrowserViews().find((view) => !view.webContents.getURL().endsWith('/overlay.html'))?.webContents.focus();
  });
  assert.equal(await electronApp.evaluate(({ BrowserWindow, webContents }) => {
    const hostId = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).webContents.id;
    return webContents.getFocusedWebContents()?.id !== hostId;
  }), true, 'the browsing view must accept focus after drawer and tab transitions');

  await window.locator('#reload').click();
  console.log(JSON.stringify({ ok: true, interactions: 'viewport bounds, settings, clipboard, console, tabs, focus, navigation' }));
} finally {
  await electronApp.close();
  fs.rmSync(appDataDirectory, { recursive: true, force: true });
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

function viewportMetrics(window) {
  return window.evaluate(() => window.browserUseDesktop.viewportMetrics());
}

async function resizeWindow(electronApp, width, height) {
  await electronApp.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).setContentSize(size.width, size.height);
  }, { width, height });
}

async function selectedTabDevToolsOpen(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => {
    const view = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).getBrowserViews()
      .find((candidate) => !candidate.webContents.getURL().endsWith('/overlay.html'));
    return view?.webContents.isDevToolsOpened() || false;
  });
}

// Fails when the native surface keeps stale bounds, which is what cropped pages
// at the left and bottom edges until a drawer toggle reattached the view.
async function assertViewportFills(window, context) {
  const deadline = Date.now() + 5000;
  let metrics = await viewportMetrics(window);
  while (Date.now() < deadline && !boundsMatch(metrics)) {
    metrics = await viewportMetrics(window);
  }
  assert.ok(metrics?.attached, `${context}: the browsing view must be attached`);
  assert.deepEqual(metrics.bounds, metrics.expected, `${context}: browsing view bounds must fill the window below the chrome`);
  assert.equal(metrics.bounds.x, 0, `${context}: the page must not be cropped on the left`);
  assert.equal(metrics.bounds.y, metrics.chromeHeight, `${context}: the page must start directly below the chrome`);
  assert.equal(metrics.bounds.width, metrics.content.width, `${context}: the page must span the full window width`);
  assert.equal(metrics.bounds.height, metrics.content.height - metrics.chromeHeight, `${context}: the page must not be cropped at the bottom`);
}

function boundsMatch(metrics) {
  return Boolean(metrics?.bounds) && ['x', 'y', 'width', 'height'].every((key) => metrics.bounds[key] === metrics.expected[key]);
}

async function assertPanelVisible(window, selector) {
  await window.waitForFunction((panelSelector) => !document.querySelector(panelSelector).hidden, selector);
}

async function assertPanelHidden(window, selector) {
  await window.waitForFunction((panelSelector) => document.querySelector(panelSelector).hidden, selector);
}

function overlayWindow(electronApp) {
  const overlay = electronApp.windows().find((window) => window.url().endsWith('/overlay.html'));
  assert.ok(overlay, 'the overlay BrowserView renderer must exist');
  return overlay;
}

async function assertOverlayPanelVisible(electronApp, selector) {
  const overlay = overlayWindow(electronApp);
  await overlay.waitForFunction((panelSelector) => !document.querySelector(panelSelector).hidden, selector);
}

// BrowserViews are composited natively, beyond ordinary DOM z-index. The last
// BrowserView is the native top surface, so asserting it here prevents a
// regression where the overlay panel state is correct but the page paints over
// it and steals all clicks.
async function assertOverlayTopmost(electronApp, label) {
  const topUrl = await electronApp.evaluate(({ BrowserWindow }) => {
    const views = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().endsWith('/desktop/renderer/index.html')).getBrowserViews();
    return views.at(-1)?.webContents.getURL() || '';
  });
  assert.match(topUrl, /\/overlay\.html$/, `${label}: overlay must be the top native BrowserView, got ${topUrl}`);
}
