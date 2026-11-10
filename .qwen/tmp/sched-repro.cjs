// Real Scheduler + real SchedulerStore + real AgentPool + real DesktopChatAgent.
// createProvider mirrors main.cjs createAgentProvider for the user's ACTUAL
// settings (aiChatProvider=xkiro, aiChatModel="", connection d5edca26 has a model).
const fs = require('fs'), os = require('os'), path = require('path');
const { Scheduler } = require('../../desktop/schedule/scheduler.cjs');
const { SchedulerStore } = require('../../desktop/schedule/schedulerStore.cjs');
const { AgentPool } = require('../../desktop/agent/agentPool.cjs');
const { DesktopChatAgent } = require('../../desktop/agent/desktopChatAgent.cjs');
const { createOllamaProvider } = require('../../desktop/agent/ollamaProvider.cjs');

const settings = { aiChatModel: '', aiChatBaseUrl: 'http://127.0.0.1:11434' };
const seen = [];
const controller = { navigationState: () => ({ url: 'about:blank', loading: false }), domSnapshot: async () => ({ url: 'about:blank', title: '', viewport: { width: 800, height: 600 }, elements: [] }), consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 't' }], releaseSessionInput() {} };
const factory = () => new DesktopChatAgent({
  controller, getSelectedTabId: () => 't', emit() {}, getControlMode: () => 'browser',
  createProvider: (cfg) => {
    seen.push(JSON.stringify(cfg));
    if (cfg?.id === 'mock') return { async complete(ctx) { seen.push('MODEL RECEIVED PROMPT: ' + ctx.task); return { done: { summary: 'ok', success: true, verified: true } }; } };
    return createOllamaProvider({ baseUrl: cfg?.baseUrl || settings.aiChatBaseUrl, model: cfg?.model || settings.aiChatModel });   // == main.cjs fallthrough
  }
});
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-repro-'));
  const store = new SchedulerStore(path.join(dir, 's.json'));
  let t = Date.now();
  const pool = new AgentPool({ factory, cap: 2, allocateTab: async () => 't', releaseTab: async () => {} });
  const scheduler = new Scheduler({ store, pool, now: () => t, publish() {}, retryDelaysMs: [5, 5, 5] });
  const job = scheduler.createJob({ name: 'repro', prompt: 'open lordemaximus.com', schedule: { type: 'once', startAt: t + 1000 } });
  t += 2000;
  await scheduler.tick();
  await new Promise(r => setTimeout(r, 400));
  const occ = store.occurrences[0];
  console.log('providerId on job :', JSON.stringify(job.providerId));
  console.log('provider configs the agent was asked to build:', seen);
  console.log('occurrence status :', occ.status, '| attempts:', occ.attempts);
  console.log('final lastError   :', occ.lastError);
  console.log('conversationId    :', occ.conversationId, '(null = no chat was ever created)');
  process.exit(0);
})();
