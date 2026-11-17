// A hover must not cost a second. Chromium can defer the Input.dispatchMouseEvent
// acknowledgement indefinitely, and the acknowledgement is NOT the delivery:
// CDP processes commands in order on one session, so waiting for a late reply
// buys no ordering guarantee — only dead time. The tool therefore observes a
// short window and reports the truth (`acknowledged:false`) instead of blocking.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');

function createTab() {
  return {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
}

function createController({ send }) {
  const tab = createTab();
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => true
  });
  controller.debuggerLeaseManager = { send };
  return controller;
}

// The ack budget timer is unref'd on purpose; hold the loop open.
function keepEventLoopAlive() {
  const timer = setTimeout(() => {}, 10_000);
  return () => clearTimeout(timer);
}

test('a hover whose acknowledgement never arrives returns promptly and says so', async () => {
  const release = keepEventLoopAlive();
  const controller = createController({ send: () => new Promise(() => {}) });

  const started = Date.now();
  const result = await controller.mouseMove('tab-1', { x: 120, y: 80 });
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 900, `a hover must not block for a late acknowledgement, took ${elapsed}ms`);
  assert.equal(result.tabId, 'tab-1');
  assert.equal(result.input, 'cdp');
  assert.equal(result.acknowledged, false, 'an unobserved acknowledgement must be reported, not hidden');
  assert.equal(result.ackDeferred, true);
  release();
});

test('an acknowledged hover keeps the plain success shape', async () => {
  const controller = createController({ send: async () => ({ ok: true }) });
  const result = await controller.mouseMove('tab-1', { x: 120, y: 80 });
  assert.deepEqual(result, { tabId: 'tab-1', input: 'cdp' }, 'a healthy move must not gain extra fields');
});

test('a rejected acknowledgement is reported without failing the hover', async () => {
  const controller = createController({ send: async () => { throw new Error('debugger detached'); } });
  const result = await controller.mouseMove('tab-1', { x: 120, y: 80 });

  assert.equal(result.input, 'cdp');
  assert.equal(result.acknowledged, false);
  assert.match(String(result.ackError), /debugger detached/);
});
