// Hosts pair from inside the Settings drawer, and that drawer detaches the browsing
// view on purpose, so the first browser_screenshot a new host sends targets a view
// that produces no compositor frames. capturePage() never settles in that state, so
// both the controller and the tool dispatcher must bound the wait instead of leaving
// the MCP request open until the host gives up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

function createTab({ capture }) {
  return {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      capturePage: capture,
      isDestroyed: () => false,
      getURL: () => 'https://example.com/',
      isLoading: () => false,
      navigationHistory: { canGoBack: () => false, canGoForward: () => false }
    }
  };
}

function createController({ capture, paintable }) {
  const tab = createTab({ capture });
  return new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: paintable
  });
}

const neverSettles = () => new Promise(() => {});
const fakeImage = { toPNG: () => Buffer.from('fake-png-bytes') };

test('a detached tab reports why it cannot be captured instead of hanging', async () => {
  const controller = createController({ capture: neverSettles, paintable: () => false });

  await assert.rejects(
    () => controller.screenshot('tab-1'),
    (error) => {
      assert.match(error.message, /not currently painted/i);
      assert.match(error.message, /restore|reattach|overlay|minimis/i, 'the message must provide cause-neutral recovery guidance');
      return true;
    }
  );
});

test('an attached tab still captures normally', async () => {
  const controller = createController({ capture: async () => fakeImage, paintable: () => true });
  const result = await controller.screenshot('tab-1');

  assert.equal(result.tabId, 'tab-1');
  assert.equal(result.mimeType, 'image/png');
  assert.equal(result.data, Buffer.from('fake-png-bytes').toString('base64'));
});

test('a stalled capture on a supposedly painted tab still rejects', async () => {
  // Guards the case the paintable check cannot predict: the view claims to be
  // attached, yet the compositor never delivers a frame.
  const controller = createController({ capture: neverSettles, paintable: () => true });
  const started = Date.now();

  await assert.rejects(() => controller.screenshot('tab-1'), /timed out capturing/i);
  assert.ok(Date.now() - started < 8_000, 'the capture must abort well before a host would time out');
});

test('the tool dispatcher bounds any tool that never settles', async () => {
  // Even a tool whose own implementation forgets a ceiling must not hold the HTTP
  // request open, because that leaks a connection and burns the rate-limit budget.
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  broker.createPairingOffer();
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  broker.bindTab(session.capability, 'tab-1');

  const controller = createController({ capture: neverSettles, paintable: () => true });
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });

  const started = Date.now();
  await assert.rejects(
    () => server.callTool({ name: 'browser_screenshot', arguments: {} }, session.capability),
    (error) => {
      assert.match(error.message, /timed out capturing|did not complete within/i);
      return true;
    }
  );
  assert.ok(Date.now() - started < 12_000, 'the dispatcher must not wait indefinitely');
});

test('argument validation errors are not masked by the deadline', async () => {
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  broker.bindTab(session.capability, 'tab-1');

  const controller = createController({ capture: async () => fakeImage, paintable: () => true });
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });

  await assert.rejects(
    () => server.callTool({ name: 'browser_mousemove', arguments: { x: 'not-a-number', y: 10 } }, session.capability),
    /finite numbers/i,
    'a synchronous validation throw must survive the deadline wrapper unchanged'
  );
});
