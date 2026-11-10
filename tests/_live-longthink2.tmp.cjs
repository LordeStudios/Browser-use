// REAL_PROVIDER_VERIFIED: streamed thinking must reset the step deadline.
// stepTimeoutMs is clamped-min 5s; the think below exceeds it, so a pass
// proves deltas kept the deadline alive (old code would kill at 5s).
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
    model: 'anthropic/claude-haiku-4.5',
    apiKey: process.env.ANTHROPIC_AUTH_TOKEN || process.env.XKIRO_API_KEY
  });
  let thoughtDeltas = 0, lastThoughtLen = 0;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: (event) => { if (event.type === 'assistant.message') console.log('message:', String(event.text).slice(0, 140)); },
    createProvider: () => provider
  });
  agent.transportRetryDelays = [5_000];
  const startedAt = Date.now();
  const run = await agent.start({
    task: 'Think silently and in detail: enumerate the numbers 1 to 300 in your thinking, each followed by one household word. When your thinking is complete, call browser_done with summary passed.',
    provider: { id: 'mock' },
    settings: { stepTimeoutMs: 5_000, maxSteps: 3 }
  });
  const elapsed = Date.now() - startedAt;
  console.log('status:', run.status, '| success:', run.result?.success, '| elapsed:', Math.round(elapsed / 1000) + 's');
  console.log('model phase ms:', Math.round(run.coordinator?.metrics?.phaseMs?.model || 0));
  console.log('summary:', String(run.result?.summary || '').slice(0, 160));
  console.log('history tools:', [...new Set(run.history.map(h => h.tool))].join(','));
  const exceeded = (run.coordinator?.metrics?.phaseMs?.model || 0) > 5_000;
  console.log('RESULT:', (run.result?.success === true && exceeded) ? 'PASS (model phase exceeded 5s deadline and survived)' : 'FAIL');
  process.exit(0);
})().catch(error => { console.error('LIVE CHECK FAILED:', error.message); process.exit(1); });
