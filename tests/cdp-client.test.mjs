import assert from 'node:assert/strict';
import test from 'node:test';
import { CdpBrowser } from '../src/browser/cdpClient.js';

function createFakeRootClient() {
  return {
    Target: {
      getTargets: async () => ({ targetInfos: [{ targetId: 'page-1', type: 'page', url: 'https://fixture.test', title: 'Fixture' }] }),
      attachToTarget: async () => ({}),
      createTarget: async ({ url }) => ({ targetId: `created-${url}` }),
      closeTarget: async () => {}
    },
    close: async () => {}
  };
}

function createFakePageClient({ enableFails = false, id = 'page-1' } = {}) {
  const listeners = new Map();
  const client = {
    id,
    closed: false,
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    once(event, handler) {
      listeners.set(`once:${event}`, handler);
      return this;
    },
    off(event, handler) {
      if (listeners.get(event) === handler) listeners.delete(event);
      if (listeners.get(`once:${event}`) === handler) listeners.delete(`once:${event}`);
      return this;
    },
    close: async () => {
      client.closed = true;
    },
    emitDisconnect() {
      const handler = listeners.get('disconnect');
      if (handler) handler();
    },
    Page: {
      enable: async () => {
        if (enableFails) throw new Error('Page.enable failed');
      },
      bringToFront: async () => {},
      navigate: async () => ({}),
      reload: async () => ({}),
      setLifecycleEventsEnabled: async () => {}
    },
    Runtime: {
      enable: async () => {
        if (enableFails) throw new Error('Runtime.enable failed');
      },
      evaluate: async () => ({ result: { value: null } }),
      consoleAPICalled: () => {},
      exceptionThrown: () => {}
    },
    Network: {
      enable: async () => {
        if (enableFails) throw new Error('Network.enable failed');
      },
      requestWillBeSent: () => {},
      responseReceived: () => {},
      loadingFailed: () => {},
      loadingFinished: () => {}
    },
    DOM: {
      enable: async () => {
        if (enableFails) throw new Error('DOM.enable failed');
      }
    },
    Log: {
      enable: async () => {
        if (enableFails) throw new Error('Log.enable failed');
      },
      entryAdded: () => {}
    },
    Emulation: {
      setFocusEmulationEnabled: async () => {}
    }
  };
  return client;
}

// The CDP module is called twice per selection: once with a target-picker
// function (root session) and once with a target id (page session).
function createFakeCdpModule({ enableFails = false } = {}) {
  let clientIndex = 0;
  const module = async (options) => {
    if (typeof options?.target === 'function') return createFakeRootClient();
    clientIndex += 1;
    return createFakePageClient({ id: `page-${clientIndex}`, enableFails });
  };
  return module;
}

function cdpModuleCallable(module) {
  return module;
}

test('selectTab connects, enables domains, and marks connected', async () => {
  const cdpModule = cdpModuleCallable(createFakeCdpModule());
  const browser = new CdpBrowser('http://127.0.0.1:9222', cdpModule);
  await browser.selectTab('page-1');

  assert.equal(browser.connected, true);
  assert.ok(browser.client);
  assert.equal(browser.target.id, 'page-1');
});

test('ensure reuses the connected client without reconnecting', async () => {
  const cdpModule = cdpModuleCallable(createFakeCdpModule());
  const browser = new CdpBrowser('http://127.0.0.1:9222', cdpModule);
  await browser.selectTab('page-1');
  const firstClient = browser.client;
  const client = await browser.ensure();
  assert.equal(client, firstClient);
  assert.equal(browser.connected, true);
});

test('selectTab short-circuits when the target is unchanged and connected', async () => {
  const cdpModule = cdpModuleCallable(createFakeCdpModule());
  const browser = new CdpBrowser('http://127.0.0.1:9222', cdpModule);
  await browser.selectTab('page-1');
  const firstClient = browser.client;

  await browser.selectTab('page-1');
  assert.equal(browser.client, firstClient);
  assert.equal(browser.target.id, 'page-1');
});

test('a stale disconnect event does not clear a newer client', async () => {
  const cdpModule = cdpModuleCallable(createFakeCdpModule());
  const browser = new CdpBrowser('http://127.0.0.1:9222', cdpModule);
  await browser.selectTab('page-1');
  const oldClient = browser.client;

  // Simulate losing the connection and reconnecting to a different target.
  await browser.selectTab('page-2');
  const newClient = browser.client;
  assert.notEqual(newClient, oldClient);
  assert.equal(browser.connected, true);

  // Emit disconnect on the OLD client — it should be ignored.
  oldClient.emitDisconnect();
  assert.equal(browser.connected, true);
  assert.equal(browser.client, newClient);
});

test('failed domain enable leaves the client unconnected so ensure reconnects', async () => {
  const cdpModule = cdpModuleCallable(createFakeCdpModule({ enableFails: true }));
  const browser = new CdpBrowser('http://127.0.0.1:9222', cdpModule);

  await assert.rejects(() => browser.selectTab('page-1'), /Page\.enable failed/);
  assert.equal(browser.connected, false);
  assert.equal(browser.client, null);
});
