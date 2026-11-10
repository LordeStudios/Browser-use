// Live-provider verification: real xKiro model decisions drive the real
// browser_fetch implementation (BrowserViewController.prototype.fetchPage has
// no `this` dependencies, so it runs against the real network). browser_search
// composition is verified with a fixture extractor (labeled below).
'use strict';
(async () => {
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { createCoordinatorState } = require('../desktop/agent/desktopAgentCoordinator.cjs');

const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').replace(/\/$/, '').replace(/(?:\/v1)?$/, '/v1');
const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
if (!baseUrl.startsWith('https://') || !apiKey) { console.error('xKiro environment required'); process.exit(1); }

const fetches = [];
const searches = [];
const controller = {
  navigationState: () => ({ url: 'https://example.com/', loading: false }),
  async domSnapshot() { return { url: 'https://example.com/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false }; },
  consoleEntries: () => [], networkEntries: () => [],
  async navigate(tabId, url) { searches.push(url); return { tabId, url, loading: false }; },
  async queryElements(tabId, options) {
    // Fixture extractor: the real value verified here is the model's tool use
    // and the composed search URL, not Google's live DOM shape.
    return { tabId, url: searches.at(-1), title: 'search', viewport: { width: 1280, height: 720 },
      elements: [
        { index: 0, tag: 'a', name: 'Example Domain', href: 'https://example.com/', enabled: true },
        { index: 1, tag: 'a', name: 'IANA — Examples', href: 'https://www.iana.org/examples', enabled: true }
      ], truncated: false };
  },
  fetchPage: (input) => BrowserViewController.prototype.fetchPage.call(null, input),
  releaseSessionInput: () => {}, listTabs: () => [{ id: 't' }]
};

const thoughts = [];
const provider = createOpenAiCompatibleProvider({ providerId: 'xkiro', baseUrl, model: 'z-ai/glm-5.3-flash', apiKey, fetchImpl: (...a) => fetch(...a) });
const agent = new DesktopChatAgent({ controller, getSelectedTabId: () => 't', getControlMode: () => 'browser', getComputerTools: () => null, emit: (e) => { if (e.type === 'tool.result') console.log('  tool:', e.tool, e.output?.ok); }, createProvider: () => provider });
const run = await agent.start({
  task: 'Fetch https://example.com with browser_fetch and report its page heading in one short sentence with browser_done.',
  settings: { controlMode: 'browser', approvalMode: 'unattended' }
});
console.log('status:', run.status, '| success:', run.result?.success);
console.log('tools used:', [...new Set(run.history.map(e => e.tool))].join(', '));
console.log('search navigations:', JSON.stringify(searches));
const fetchRecord = run.history.find(e => e.tool === 'browser_fetch');
console.log('fetch result head:', JSON.stringify(String(fetchRecord?.output?.result?.body || '').slice(0, 80)));
console.log('thinking streamed:', thoughts.length > 0);
const searchRecord = run.history.find(e => e.tool === 'browser_search');
console.log('search ok:', searchRecord?.output?.ok, '| results:', searchRecord?.output?.result?.resultCount);

})().catch(e=>{console.error(e.stack||e.message);process.exit(1);});
