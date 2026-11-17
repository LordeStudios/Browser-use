// A scroll that reached nothing must never be reported as a completed scroll.
// The wheel acknowledgement is the only proof the event left the browser
// process; when it never arrives AND the document did not move, the delivery is
// unknown, and a success envelope makes the model advance a viewport that never
// moved. This is the same failure class as `dispatched: true` for a click the
// page never received.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

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

// The two viewport reads scroll() makes: before the wheel and after it.
function createController({ scrollYs, wheel }) {
  const tab = createTab();
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => true
  });
  let read = 0;
  controller.readElements = async () => ({ viewport: { width: 800, height: 600, scrollX: 0, scrollY: scrollYs[Math.min(read++, scrollYs.length - 1)] } });
  controller.dispatchMouseBounded = async () => wheel;
  return controller;
}

// The wheel budget and the settle timer are unref'd on purpose; hold the loop.
function keepEventLoopAlive() {
  const timer = setTimeout(() => {}, 10_000);
  return () => clearTimeout(timer);
}

test('an unacknowledged wheel that moved nothing is an error, not a success', async () => {
  const release = keepEventLoopAlive();
  const controller = createController({ scrollYs: [120, 120], wheel: { acknowledged: false, ackDeferred: true } });

  await assert.rejects(
    () => controller.scroll('tab-1', { deltaY: 400 }),
    (error) => {
      assert.match(error.message, /never acknowledged/i);
      assert.match(error.message, /did not scroll/i);
      // The message must carry the evidence and a recovery path, not just fail.
      assert.match(error.message, /scrollY=120/);
      assert.match(error.message, /minimis|hidden|visible/i);
      assert.match(error.message, /window\.scrollTo/);
      return true;
    }
  );
  release();
});

test('an acknowledged wheel that moved nothing stays a success (already at the boundary)', async () => {
  const controller = createController({ scrollYs: [0, 0], wheel: { acknowledged: true } });
  const result = await controller.scroll('tab-1', { deltaY: 400 });

  assert.equal(result.input, 'mouse');
  assert.equal(result.moved, false, 'a legitimate no-op still reports the truth');
  assert.deepEqual(result.before, { scrollX: 0, scrollY: 0 });
  assert.deepEqual(result.after, { scrollX: 0, scrollY: 0 });
});

test('a wheel that moved the document reports the movement', async () => {
  const controller = createController({ scrollYs: [0, 400], wheel: { acknowledged: true } });
  const result = await controller.scroll('tab-1', { deltaY: 400 });

  assert.equal(result.moved, true);
  assert.deepEqual(result.after, { scrollX: 0, scrollY: 400 });
});

test('a zero-delta scroll is a no-op even when the wheel is unacknowledged', async () => {
  const controller = createController({ scrollYs: [120, 120], wheel: { acknowledged: false, ackDeferred: true } });
  const result = await controller.scroll('tab-1', { deltaY: 0 });
  assert.equal(result.moved, false, 'nothing was asked for, so nothing is unknown');
});

test('the MCP layer surfaces an undelivered scroll as isError at HTTP 200', async () => {
  const release = keepEventLoopAlive();
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  broker.bindTab(session.capability, 'tab-1');

  const controller = createController({ scrollYs: [120, 120], wheel: { acknowledged: false, ackDeferred: true } });
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });

  const result = await server.callTool({ name: 'browser_scroll', arguments: { deltaY: 400 } }, session.capability);
  assert.equal(result.isError, true, `expected a tool error, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.match(result.content[0].text, /never acknowledged|did not scroll/i);
  release();
});
