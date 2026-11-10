import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright-core';
const root = path.resolve(import.meta.dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-progress-'));
const env = { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_START_URL: 'about:blank' }; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${profile}`], cwd: root, env });
  let shell;
  const deadline = Date.now() + 30_000;
  while (!shell && Date.now() < deadline) { shell = app.windows().find(w => w.url().endsWith('/desktop/renderer/index.html')); if (!shell) await new Promise(r => setTimeout(r, 50)); }
  await shell.waitForFunction(() => document.documentElement.dataset.browserUseRendererReady === 'true');
  await shell.locator('#agent-toggle').click();
  const proof = await shell.evaluate(() => {
    visibleConversationId = 'view-b'; chatRun = null;
    const plan = [{ id:'one', text:'Finished item', status:'done' }, { id:'two', text:'Active item', status:'current' }];
    renderChatState({id:'view-b',status:'running',eventRevision:5,attemptSequence:1,plan});
    agentPlanToggle.click();
    const text = agentPlanList.querySelector('.is-done > span:last-child');
    const before = { title:agentPlanTitle.textContent, decoration:getComputedStyle(text).textDecorationLine, animation:getComputedStyle(agentPlanTitle,'::before').animationName };
    renderChatState({id:'other-a',status:'completed',eventRevision:99,plan:[]});
    return {before, hiddenAfterForeignSnapshot:agentPlan.hidden, visibleId:visibleConversationId, renderedId:chatRun?.id};
  });
  console.log(JSON.stringify(proof));
  assert.equal(proof.hiddenAfterForeignSnapshot, false, 'foreign global state must not erase selected tasks');
  assert.equal(proof.renderedId, 'view-b');
  assert.match(proof.before.decoration, /line-through/);
  assert.notEqual(proof.before.animation, 'none');
  const actualState = await shell.evaluate(() => window.browserUseDesktop.state());
  await app.evaluate(({ webContents }, snapshot) => {
    const renderer = webContents.getAllWebContents().find(w => w.getURL().endsWith('/desktop/renderer/index.html'));
    renderer.send('browser-use:state', { ...snapshot, agent: { ...snapshot.agent, chat: null } });
  }, actualState);
  await shell.waitForTimeout(100);
  assert.equal(await shell.evaluate(() => agentPlan.hidden), false, 'an empty global agent snapshot must not clear selected history progress');
  const goals = await shell.evaluate(() => {
    renderChatState({ id:'view-b',status:'running',attemptSequence:1,eventRevision:6,goals:[{id:'g1',text:'Current goal',status:'current'}] });
    const before = agentPlanList.querySelector('[data-id="two"]');
    const expanded = agentPlanToggle.getAttribute('aria-expanded');
    renderChatState({ id:'view-b',status:'running',attemptSequence:1,eventRevision:7 });
    const goalBox=agentGoal.getBoundingClientRect(),tasksBox=agentPlan.getBoundingClientRect();
    return {goalVisible:!agentGoal.hidden,goalLeft:goalBox.right<=tasksBox.left,stableRow:before===agentPlanList.querySelector('[data-id="two"]'),expanded:agentPlanToggle.getAttribute('aria-expanded')===expanded};
  });
  assert.deepEqual(goals,{goalVisible:true,goalLeft:true,stableRow:true,expanded:true});
  const animation = await shell.evaluate(async () => {
    const ring=agentPlanList.querySelector('[data-id="two"] .agent-plan-state');
    const first=getComputedStyle(ring).transform;
    await new Promise(r=>setTimeout(r,180)); const second=getComputedStyle(ring).transform;
    renderChatState({id:'view-b',status:'awaiting_approval',attemptSequence:1,eventRevision:8});
    const paused=getComputedStyle(ring).animationPlayState;
    return {changed:first!==second,paused};
  });
  assert.equal(animation.changed,true,'active task ring must actually rotate'); assert.equal(animation.paused,'paused');
  await shell.evaluate(() => window.browserUseDesktop.setAgentDrawerWidth(320));
  const compact = await shell.evaluate(() => {
    const panel=agentPanel.getBoundingClientRect(),strip=agentProgressStrip.getBoundingClientRect(),goal=agentGoal.getBoundingClientRect(),tasks=agentPlan.getBoundingClientRect(),send=agentSend.getBoundingClientRect(),composer=agentForm.getBoundingClientRect();
    return {contained:strip.left>=panel.left&&strip.right<=panel.right,goalLeft:goal.right<=tasks.left,sendInside:send.right<=panel.right&&send.left>=panel.left,aboveComposer:strip.bottom<=composer.top};
  });
  assert.deepEqual(compact,{contained:true,goalLeft:true,sendInside:true,aboveComposer:true});
  console.log(JSON.stringify({goals,animation,compact}));
} finally { await app?.close().catch(()=>{}); fs.rmSync(profile,{recursive:true,force:true,maxRetries:3}); }
