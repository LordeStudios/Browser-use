// REAL_PROVIDER_VERIFIED smoke: a think longer than the (clamped-min) step
// timeout must survive because streamed deltas reset the dead-air deadline.
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');

function createController() {
  return {
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    async domSnapshot() { return { url: 'https://example.test/', title: 'Example', viewport: { width: 800, height: 600 }, elements: [], truncated: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; },
    listTabs() { return [{ id: 'tab-1' }]; }
  };
}

(async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro',
    baseUrl: (process.env.ANTHROPIC_BASE_URL || 'https://api.xkiro.com').replace(/\/$/, '') + (/\/v1$/.test(process.env.ANTHROPIC_BASE_URL || '') ? '' : '/v1'),
    model: 'qwen/qwen3.5-flash:free',
    apiKey: process.env.XKIRO_API_KEY
  });
  let thoughtMs = 0, thoughtCount = 0;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5_000];
  const run = await agent.start({
    task: 'Think silently for at least 15 seconds (do not use any tools while thinking), then call browser_done with summary "passed" if you produced extended reasoning, or "false" if not.',
    provider: { id: 'mock' },
    settings: { stepTimeoutMs: 5_000, maxSteps: 3 }
  });
  console.log('status:', run.status, '| success:', run.result?.success);
  console.log('summary:', String(run.result?.summary || '').slice(0, 200));
  console.log('history tools:', run.history.map(h => h.tool).join(',') || '(none)');
  console.log('RESULT:', (run.result?.success === true && /passed/i.test(String(run.result?.summary || ''))) ? 'PASS' : 'FAIL');
  process.exit(0);
})().catch(error => { console.error('LIVE CHECK FAILED:', error.message); process.exit(1); });
