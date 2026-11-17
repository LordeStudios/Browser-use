import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageInfo = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8').replace(/^﻿/, ''));
const builderConfig = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

test('desktop packaging builds and verifies both Windows executable artifacts', () => {
  assert.ok(fs.existsSync(path.join(root, 'desktop', 'main.cjs')));
  assert.match(packageInfo.scripts['desktop:package'], /electron-builder/);
  assert.match(packageInfo.scripts['desktop:package'], /verify-desktop-artifacts\.mjs/);
  assert.match(builderConfig, /target: nsis/);
  assert.match(builderConfig, /target: portable/);
  assert.match(builderConfig, /output: desktop-release/);
  assert.match(builderConfig, /Browser-use-\$\{version\}-setup\.\$\{ext\}/);
  assert.match(builderConfig, /Browser-use-\$\{version\}-portable\.\$\{ext\}/);
});

test('Electron is a development dependency required for packaging', () => {
  assert.equal(packageInfo.dependencies?.electron, undefined);
  assert.match(packageInfo.devDependencies.electron, /^\^43\./);
});

test('desktop package contains the repository-independent MCP runtime', () => {
  assert.match(builderConfig, /- src\/\*\*\/\*/);
  assert.match(builderConfig, /node_modules\/chrome-remote-interface\/\*\*\/\*/);
  assert.match(builderConfig, /node_modules\/playwright-core\/\*\*\/\*/);
  assert.match(builderConfig, /node_modules\/ws\/\*\*\/\*/);
});

test('Node builds package the checked-in upstream Browser Use source separately', () => {
  const buildSource = fs.readFileSync(path.join(root, 'scripts', 'build.js'), 'utf8');

  assert.match(buildSource, /\.upstream-browser-use/);
  assert.match(buildSource, /upstreamBundled/);
  assert.match(buildSource, /src\/upstream\/runtime\.js/);
  assert.match(buildSource, /scripts\/run-upstream-browser-use\.mjs/);
});

test('desktop package includes the native AI chat agent implementation', () => {
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const agentSource = fs.readFileSync(path.join(root, 'desktop', 'agent', 'desktopChatAgent.cjs'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8');

  assert.match(desktopSource, /DesktopChatAgent/);
  assert.match(desktopSource, /browser-use:agent-start/);
  assert.match(desktopSource, /syncBrowserViewVisibility\(\);/);
  assert.match(desktopSource, /let targetTabId = request\?\.tabId/);
  assert.match(desktopSource, /const providerId/);
  assert.doesNotMatch(desktopSource, /directGreetingReply|derivePublicSignInRoutine/);
  assert.doesNotMatch(agentSource, /directGreetingReply|deriveInitialPlan|runPublicSignInRoutine/);
  assert.match(desktopSource, /const conversationId = continuation/);
  assert.match(desktopSource, /conversationId,\s*conversation,/);
  assert.match(agentSource, /restoreConversationSnapshot/);
  assert.match(agentSource, /appendConversationMessage\(run, 'user', task[,)]/);
  assert.match(agentSource, /scheduleRecovery\(run/);
  assert.match(agentSource, /recovery: run\.recovery/);
  const agentStartSource = desktopSource.slice(desktopSource.indexOf("ipcMain.handle('browser-use:agent-start'"), desktopSource.indexOf("ipcMain.handle('browser-use:agent-cancel'"));
  assert.doesNotMatch(agentStartSource, /preflightOllama\(/);
  assert.match(agentStartSource, /hostAgent\.start\(|desktopChatAgent\.start\(/, 'agent-start calls the host agent start');
  assert.match(agentStartSource, /\.state\(\)/, 'agent-start checks current agent state');
  assert.match(agentStartSource, /return started/);
  assert.match(preloadSource, /agentStart/);
  assert.match(preloadSource, /agentRetire/);
  assert.match(desktopSource, /browser-use:agent-retire/);
  const rendererSource = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
  const rendererHtml = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8');
  assert.match(rendererSource, /window\.browserUseDesktop\.agentRetire\(visibleConversationId\)/);
  assert.match(rendererSource, /function copyWholeChat/);
  assert.match(rendererSource, /function currentActiveChatRun/);
  assert.match(rendererSource, /async function resolveActiveChatRun/);
  assert.match(rendererSource, /window\.browserUseDesktop\.agentCancel\(activeRun\.id\)/);
  assert.doesNotMatch(rendererSource, /renderChatMessage\('user', conversation\.title\)/);
  assert.match(rendererSource, /conversationId,\s*tabId/);
  assert.match(rendererSource, /renderPlan\(\[\]\)/);
  assert.match(rendererHtml, /id="agent-copy-chat"/);
  assert.match(preloadSource, /agentPreflight/);
  assert.match(desktopSource, /provider\?\.baseUrl \|\| request\?\.baseUrl \|\| settings\.aiChatBaseUrl/);
  assert.match(desktopSource, /provider\?\.model \|\| request\?\.model \|\| settings\.aiChatModel/);
  assert.match(builderConfig, /- desktop\/\*\*\/\*/);
});

test('opening Agent chat reserves a visible strip outside the native BrowserView without attaching an input shield', () => {
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');

  assert.match(desktopSource, /AGENT_DRAWER_WIDTH/);
  assert.match(desktopSource, /activeDrawer === 'agent'/);
  assert.match(desktopSource, /reservedAgentDrawerWidth/);
  assert.doesNotMatch(desktopSource, /\['settings', 'console', 'agent'\]\.includes\(activeDrawer\)/);
});

test('desktop defaults the local agent to the requested Minimax M3 model', () => {
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');

  assert.match(desktopSource, /aiChatModel: process\.env\.OLLAMA_MODEL \|\| 'minimax-m3:cloud'/);
  assert.doesNotMatch(desktopSource, /kimi-k2\.7|grok-4\.5/);
});

test('desktop MCP reserves a stable, desktop-only port and preserves an explicit ephemeral test override', () => {
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');

  // V293: the desktop app OWNS 8790 — the endpoint MCP hosts configure. The
  // Chrome CLI daemon no longer binds it (the watchdog launches the desktop).
  assert.match(desktopSource, /const DEFAULT_DESKTOP_MCP_PORT = 8790;/);
  assert.match(desktopSource, /no longer binds[\s\S]*?desktop app/i);
  assert.match(desktopSource, /function resolveDesktopMcpPort\(value = process\.env\.BROWSER_USE_DESKTOP_MCP_PORT\)/);
  assert.match(desktopSource, /if \(!raw\) return DEFAULT_DESKTOP_MCP_PORT;/);
  assert.match(desktopSource, /port < 0 \|\| port > 65_535/);
  assert.match(desktopSource, /port: resolveDesktopMcpPort\(\)/);
  assert.doesNotMatch(desktopSource, /process\.env\.BROWSER_USE_MCP_PORT/);
});

test('reload IPC handler returns a clone-safe result envelope', () => {
  const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const reloadHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('browser-use:reload'"), mainSource.indexOf("createDesktopTray();"));
  assert.match(reloadHandler, /safeIpcValue\(\{ ok: true, state: currentState\(\) \}/, 'reload state uses the clone-safe projection');
  assert.match(reloadHandler, /catch \(error\)/, 'reload catches WebContents errors');
});

test('tab IPC handlers return clone-safe payloads and never leak thrown Error objects', () => {
  const mainSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const selectHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('browser-use:select-tab'"), mainSource.indexOf("ipcMain.handle('browser-use:navigate'"));
  const closeHandler = mainSource.slice(mainSource.indexOf("ipcMain.handle('browser-use:close-tab'"), mainSource.indexOf("ipcMain.handle('browser-use:navigate'"));
  assert.match(selectHandler, /catch \(error\)/, 'select-tab wraps errors');
  assert.match(selectHandler, /String\(error\?\.message \|\| error/, 'select-tab returns a string error, not an Error object');
  assert.match(closeHandler, /catch \(error\)/, 'close-tab wraps errors');
  assert.match(closeHandler, /String\(error\?\.message \|\| error/, 'close-tab returns a string error, not an Error object');
});

test('missing bound tab is a bounded recoverable advisory, not an infinite throw loop', () => {
  // The run loop and the tool catalogs were split into two files, and the
  // advisory moved with the execution path. Read both so the assertion tracks
  // the BEHAVIOUR rather than the file it happens to live in today.
  const agentSource = ['desktop/agent/desktopChatAgent.cjs', 'desktop/agent/agentInternals.cjs']
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  assert.match(agentSource, /missing_bound_tab/, 'missing bound tab uses a named recovery source');
  assert.match(agentSource, /missingTabNotices/, 'the first missing-tab notice is bounded and not repeated forever');
  const controllerSource = fs.readFileSync(path.join(root, 'desktop/mcp/browserViewController.cjs'), 'utf8');
  assert.match(controllerSource, /BOUND_TAB_MISSING/, 'controller marks a missing tab as recoverable');
});

test('desktop sends clone-safe agent state and uses the current Electron console event shape', () => {
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const agentSource = fs.readFileSync(path.join(root, 'desktop', 'agent', 'desktopChatAgent.cjs'), 'utf8');

  assert.match(agentSource, /latestObservation[\s\S]*visualEvidence[\s\S]*attachments/);
  assert.match(desktopSource, /console-message', \(details\) =>/);
  assert.doesNotMatch(desktopSource, /console-message', \(_event, level, message, line, sourceId\)/);
});

test('desktop agent shell keeps the compact dark reference controls wired to live state', () => {
  const rendererSource = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'app.js'), 'utf8');
  const rendererHtml = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'index.html'), 'utf8');
  const referenceCss = fs.readFileSync(path.join(root, 'desktop', 'renderer', 'chat-reference.css'), 'utf8');
  const desktopSource = fs.readFileSync(path.join(root, 'desktop', 'main.cjs'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'desktop', 'preload.cjs'), 'utf8');

  assert.doesNotMatch(rendererHtml, /id="agent-header-model-label"/);
  assert.doesNotMatch(rendererHtml, /id="agent-header-model-toggle"/);
  assert.match(rendererHtml, /id="agent-settings-toggle"/);
  assert.match(rendererHtml, /vendor\/phosphor\.css/);
  assert.match(rendererHtml, /id="settings-toggle"[^>]*><i class="ph ph-list"/);
  assert.match(rendererHtml, /id="agent-copy-chat"[^>]*><i class="ph ph-copy"/);
  assert.match(rendererHtml, /id="agent-settings-screen"/);
  assert.match(rendererHtml, /id="agent-connection-list"/);
  assert.match(rendererHtml, /id="agent-provider-select-menu"/);
  assert.match(rendererHtml, /class="agent-settings-tabs"/);
  assert.match(rendererHtml, /data-agent-settings-tab=/);
  assert.doesNotMatch(rendererHtml, /agent-onboarding/);
  assert.doesNotMatch(rendererHtml, /data-agent-prompt/);
  assert.match(rendererHtml, /id="agent-plan"[^>]*aria-label="Agent tasks"/);
  assert.match(rendererHtml, /id="agent-plan-toggle"/);
  assert.ok(rendererHtml.indexOf('id="agent-plan"') < rendererHtml.indexOf('id="agent-form"'), 'the plan pill must float independently before the composer');
  assert.match(rendererHtml, /placeholder="Reply to continue this session"/);
  assert.match(rendererHtml, /id="agent-send"[^>]*><i class="ph ph-arrow-up"/);
  assert.match(rendererHtml, /id="agent-cancel"[^>]*><i class="ph ph-stop"/);
  assert.doesNotMatch(rendererHtml, /<svg/);
  assert.match(rendererSource, /tabs\.append\(newTab\)/, 'new tab button is kept beside the rendered tab list');
  assert.match(rendererSource, /plusWidth/, 'tab layout reserves the inline plus button width');
  assert.match(rendererSource, /function refreshAgentProviderModels/);
  assert.match(rendererSource, /PROVIDER_CATALOG/);
  assert.match(rendererSource, /saveAiConnection/);
  assert.match(rendererSource, /setAiConnectionModel/);
  assert.match(rendererSource, /listProviderModels/);
  assert.match(preloadSource, /setAiConnectionModel/);
  assert.match(desktopSource, /browser-use:set-ai-connection-model/);
  assert.doesNotMatch(rendererHtml, /id="agent-provider-model"/);
  assert.doesNotMatch(rendererHtml, /AI chat provider/);
  assert.doesNotMatch(rendererSource, /gemma4|minimax-m3|kimi-k2\.7|grok-4\.5/);
  assert.match(rendererSource, /function flashCopyIcon\(button\)/);
  assert.match(rendererSource, /function truncateHistoryTitle\(value, limit = 58\)/);
  assert.match(rendererSource, /renderAgentModelOptions\(\);/);
  assert.match(rendererSource, /if \(event\.tool === 'browser_done'\) \{/);
  assert.match(rendererSource, /renderAssistantReply\(event\.output\?\.summary/);
  assert.match(rendererSource, /event\.tool === 'agent_advisory'/, 'internal advisory tool results stay out of the chat transcript');
  assert.match(rendererSource, /If the renderer missed run\.started during a drawer\/window remount/, 'live tool events survive a missed run.started event');
  // The file-mutation gate moved with the tool layer: the agent no longer owns
  // it, computer_write/computer_patch do, through WorkspaceChangeGuard. Assert
  // the enforcement that exists instead of a comment marker that does not.
  const toolSource = fs.readFileSync(path.join(root, 'desktop', 'computer', 'computerTools.cjs'), 'utf8');
  assert.match(toolSource, /workspaceGuard\.beforeMutation/, 'mutations are gated before they happen');
  assert.match(toolSource, /workspaceGuard\.afterMutation/, 'mutations are verified after they happen');
  assert.match(rendererSource, /if \(event\.result\?\.summary\) renderAssistantReply\(event\.result\?\.summary/);
  assert.match(rendererSource, /first real card owns the reply|existingCard/);
  assert.match(rendererSource, /agentPlanToggle\?\.addEventListener\('click'/);
  assert.match(referenceCss, /--agent-bg: #060b0d/);
  assert.match(referenceCss, /\.agent-message-hover-actions/);
  assert.match(referenceCss, /\.agent-progress-strip\s*\{[^}]*position:\s*absolute/);
  assert.ok(rendererHtml.indexOf('id="agent-goal"') < rendererHtml.indexOf('id="agent-plan"'), 'model-authored goals must appear left of tasks');
  assert.match(referenceCss, /\.agent-plan-toggle/);
  assert.match(referenceCss, /\.agent-cancel-button/);
  assert.match(referenceCss, /\.agent-settings-screen/);
  assert.match(referenceCss, /\.agent-provider-select-menu/);
  assert.match(referenceCss, /\.agent-model-menu\s*\{[^}]*width: min\(280px, calc\(100vw - 28px\)\)/);
  assert.match(referenceCss, /\.agent-model-menu\s*\{[^}]*max-height: min\(360px, calc\(100vh - 112px\)\)/);
  assert.match(referenceCss, /\.agent-copy-chat\.is-copied/);
  assert.match(referenceCss, /\.agent-message\.is-assistant p \{ color: #fff/);
  assert.match(referenceCss, /\.agent-message\.is-assistant p \{ color: #fff; font-size: 14px; font-weight: 400; line-height: 1\.6; \}/);
  assert.match(referenceCss, /\.agent-composer textarea:focus-visible \{ outline: 0; box-shadow: none; \}/);
  assert.doesNotMatch(referenceCss, /\.agent-head-actions\s*\{\s*display:\s*none/);
});
