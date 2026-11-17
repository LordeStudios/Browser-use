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
// capturePage() resolves an Electron NativeImage, which exposes BOTH toPNG() and
// getSize(). A fixture with only toPNG() fails at getSize() and never reaches the
// coordinate-contract code, so the happy path was untested.
const fakeImage = {
  toPNG: () => Buffer.from('fake-png-bytes'),
  getSize: () => ({ width: 1280, height: 800 })
};

// The capture and lease ceilings are unref'd on purpose — they must never keep
// Electron alive. A test that waits on one therefore has nothing holding the
// event loop, so the runner exits before the timer fires and the subtest is
// cancelled with "Promise resolution is still pending". Hold it open explicitly.
function keepEventLoopAlive() {
  const timer = setTimeout(() => {}, 10_000);
  return () => clearTimeout(timer);
}

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
  // The coordinate contract must survive the capture ceiling: physical pixel
  // size comes from the image, not from the CSS viewport.
  assert.equal(result.source, 'capturePage');
  assert.equal(result.width, 1280);
  assert.equal(result.height, 800);
  assert.equal(result.coordinateSpace, 'browser-view-physical-pixels');
});

test('a stalled capture on a supposedly painted tab still rejects', async () => {
  // Guards the case the paintable check cannot predict: the view claims to be
  // attached, yet the compositor never delivers a frame.
  const releaseLoop = keepEventLoopAlive();
  const controller = createController({ capture: neverSettles, paintable: () => true });
  const started = Date.now();

  await assert.rejects(() => controller.screenshot('tab-1'), /timed out capturing/i);
  assert.ok(Date.now() - started < 8_000, 'the capture must abort well before a host would time out');
  releaseLoop();
});

test('the tool dispatcher bounds any tool that never settles', async () => {
  // Even a tool whose own implementation forgets a ceiling must not hold the HTTP
  // request open, because that leaks a connection and burns the rate-limit budget.
  const releaseLoop = keepEventLoopAlive();
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  broker.createPairingOffer();
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  broker.bindTab(session.capability, 'tab-1');

  const controller = createController({ capture: neverSettles, paintable: () => true });
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });

  const started = Date.now();
  // A bounded tool that never settles is a TOOL failure: the exchange completes
  // and the caller is told the call timed out. Reporting it as a JSON-RPC error
  // would make an ordinary recoverable timeout look like a dead server.
  const result = await server.callTool({ name: 'browser_screenshot', arguments: {} }, session.capability);
  assert.equal(result.isError, true, `expected a bounded tool error, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.match(result.content[0].text, /timed out capturing|did not complete within/i);
  assert.ok(Date.now() - started < 12_000, 'the dispatcher must not wait indefinitely');
  releaseLoop();
});

test('argument validation errors are not masked by the deadline', async () => {
  const releaseLoop = keepEventLoopAlive();
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  broker.bindTab(session.capability, 'tab-1');

  const controller = createController({ capture: async () => fakeImage, paintable: () => true });
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });

  const result = await server.callTool({ name: 'browser_mousemove', arguments: { x: 'not-a-number', y: 10 } }, session.capability);
  assert.equal(result.isError, true, 'a validation failure is a tool error, not a protocol fault');
  assert.match(
    result.content[0].text,
    /finite numbers/i,
    'a synchronous validation throw must survive the deadline wrapper unchanged'
  );
  releaseLoop();
});
