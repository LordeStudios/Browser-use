import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

function controllerFactory({ failObservations = 0, tabs = ['tab-1'] } = {}) {
  const liveTabs = new Set(tabs);
  const calls = [];
  let observationFailures = failObservations;
  return {
    calls,
    listTabs: () => [...liveTabs].map((id) => ({ id, title: id, url: 'https://example.test/' })),
    navigationState: (tabId) => ({ tabId, url: 'https://example.test/', loading: false }),
    async domSnapshot(tabId) {
      calls.push(['observe', tabId]);
      if (observationFailures > 0) {
        observationFailures -= 1;
        throw new Error('synthetic observation timeout');
      }
      return { tabId, url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [] };
    },
    consoleEntries: () => [],
    networkEntries: () => [],
    async screenshot(tabId) { return { tabId, mimeType: 'image/png', data: 'fixture' }; },
    registerTab(id) { liveTabs.add(String(id)); },
    removeTab(id) { liveTabs.delete(String(id)); },
    releaseSessionInput() {}
  };
}

function agentFor({ controller, provider, selectedTab = 'tab-1', createTab, closeTab, emit }) {
  return new DesktopChatAgent({
    controller,
    getSelectedTabId: () => selectedTab,
    createTab,
    closeTab,
    emit: emit || (() => {}),
    createProvider: () => ({ complete: provider })
  });
}

test('observation recovery continues the same run without the generic recovery failure', async () => {
  const controller = controllerFactory({ failObservations: 1 });
  const events = [];
  const agent = agentFor({
    controller,
    emit: (event) => events.push(event),
    provider: async () => ({ done: { summary: 'Recovered and completed.', success: true } })
  });

  const run = await agent.start({ task: 'Inspect the page', provider: { id: 'mock' }, settings: { maxRecoveries: 1 } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.notEqual(run.result.reason, 'recovery_exhausted');
  assert.equal(run.recoveryEpisodes, 1);
  assert.equal(events.some((event) => event.type === 'agent.recovery'), true);
  assert.equal(JSON.stringify(run).includes('stopped after repeated recovery'), false);
});

test('repeated malformed provider decisions reset internally and preserve conversation state', async () => {
  const controller = controllerFactory();
  let calls = 0;
  const events = [];
  const agent = agentFor({
    controller,
    emit: (event) => events.push(event),
    provider: async () => {
      calls += 1;
      if (calls <= 3) throw new Error('synthetic malformed decision');
      return { done: { summary: 'Recovered after malformed decisions.', success: true } };
    }
  });

  const run = await agent.start({ task: 'Keep working', provider: { id: 'mock' }, settings: { maxRecoveries: 1 } });

  assert.equal(run.status, 'completed');
  assert.equal(run.result.success, true);
  assert.equal(run.recoveryEpisodes, 3);
  assert.equal(run.messages.filter((message) => message.role === 'user').length, 1);
  assert.equal(events.some((event) => event.type === 'run.failed'), false);
});

test('browser_new_tab closes only the previous run-owned tab', async () => {
  const controller = controllerFactory({ tabs: [] });
  let nextTab = 0;
  const created = [];
  const closed = [];
  const createTab = async (url) => {
    const id = `tab-${++nextTab}`;
    controller.registerTab(id);
    created.push({ id, url });
    return { id, url };
  };
  const closeTab = (id) => {
    closed.push(String(id));
    controller.removeTab(id);
    return true;
  };
  let decision = 0;
  const agent = agentFor({
    controller,
    selectedTab: null,
    createTab,
    closeTab,
    provider: async () => {
      decision += 1;
      if (decision === 1) return { actions: [{ name: 'browser_new_tab', input: { url: 'https://second.test/' } }] };
      return { done: { summary: 'Compared the tabs.', success: true } };
    }
  });

  const run = await agent.start({ task: 'Open the second page', provider: { id: 'mock' } });

  assert.equal(run.status, 'completed');
  assert.deepEqual(created.map((entry) => entry.id), ['tab-1', 'tab-2']);
  assert.deepEqual(closed, ['tab-1']);
  assert.equal(controller.listTabs().some((tab) => tab.id === 'tab-1'), false);
  assert.equal(controller.listTabs().some((tab) => tab.id === 'tab-2'), true);
  assert.deepEqual(run.ownedTabIds, ['tab-2']);
});
