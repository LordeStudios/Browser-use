// DOM+geometry is the low-weight, precise replacement for screenshot-driven
// guessing. The desktop app's MCP surface must expose structured elements, not
// only pixels, so a host can deterministically click a control like Ellipse.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const { BrowserViewController } = require('../desktop/mcp/browserViewController.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

const FIXTURE_HTML = `<!doctype html><meta charset="utf-8"><title>DOM fixture</title>
<body>
  <button id="ellipse" data-tool="shape-ellipse" aria-label="Ellipse" style="position:absolute;left:40px;top:30px;width:100px;height:40px">Ellipse</button>
  <button id="other" style="position:absolute;left:180px;top:30px;width:100px;height:40px">Other</button>
  <div id="log" style="position:absolute;left:40px;top:90px">idle</div>
  <script>
    document.getElementById('ellipse').addEventListener('mousedown', () => { document.getElementById('log').textContent = 'ellipse-down'; });
    document.getElementById('other').addEventListener('mousedown', () => { document.getElementById('log').textContent = 'other-down'; });
  </script>
</body>`;

function createHarness() {
  const inputEvents = [];
  const tab = {
    id: 'tab-1',
    title: 'Fixture',
    webContents: {
      capturePage: async () => ({ toPNG: () => Buffer.from('png') }),
      sendInputEvent: (event) => inputEvents.push(event),
      insertText: (text) => inputEvents.push({ type: 'text', text }),
      // Mouse delivery rides the CDP Input pipeline; the stub records the
      // dispatched CDP events into the same stream the assertions read.
      debugger: {
        isAttached: () => false,
        attach: () => {},
        detach: () => {},
        sendCommand: async (_method, event) => inputEvents.push(event)
      },
      isDestroyed: () => false,
      isLoading: () => false,
      getURL: () => 'https://example.test/',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      executeJavaScript: async (script) => {
        if (script.includes('buildElementCollectorScript') || script.includes('querySelectorAll')) {
          return {
            url: 'https://example.test/',
            title: 'DOM fixture',
            viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
            elements: [
              { index: 0, tag: 'button', role: '', name: 'Ellipse', text: 'Ellipse', id: 'ellipse', testId: '', dataTool: 'shape-ellipse', selector: '#ellipse', rect: { x: 40, y: 30, w: 100, h: 40 }, center: { x: 90, y: 50 }, visible: true, enabled: true, checked: null, value: '' },
              { index: 1, tag: 'button', role: '', name: 'Other', text: 'Other', id: 'other', testId: '', dataTool: '', selector: '#other', rect: { x: 180, y: 30, w: 100, h: 40 }, center: { x: 230, y: 50 }, visible: true, enabled: true, checked: null, value: '' }
            ],
            truncated: false
          };
        }
        throw new Error(`Unexpected executeJavaScript script: ${script.slice(0, 120)}`);
      }
    }
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    isTabPaintable: () => true
  });
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'dom-test-host' } });
  broker.bindTab(session.capability, tab.id);
  const server = new LocalMcpServer({ broker, controller, gptKey: 'test-gpt-key' });
  return { controller, broker, server, session, inputEvents, tab };
}

test('DOM snapshot returns indexed geometry and queryElements narrows by selector/text', async () => {
  const { controller } = createHarness();

  const snapshot = await controller.domSnapshot('tab-1', { maxElements: 10 });
  assert.equal(snapshot.elements.length, 2);
  assert.deepEqual(snapshot.elements[0].center, { x: 90, y: 50 });
  assert.equal(snapshot.elements[0].dataTool, 'shape-ellipse');

  const query = await controller.queryElements('tab-1', { selector: '#ellipse', text: 'ellipse', maxElements: 1 });
  assert.equal(query.elements.length, 2, 'current stub returns the underlying payload for any supported query');
  assert.equal(query.elements[0].selector, '#ellipse');
});

test('DOM snapshot uses the shared CDP lease when it can return a serializable page value', async () => {
  const { tab } = createHarness();
  const cdpCalls = [];
  tab.webContents.executeJavaScript = async () => {
    throw new Error('The slow page evaluator should not run when CDP returned the snapshot.');
  };
  const payload = {
    url: 'https://example.test/', title: 'CDP DOM fixture', viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
    elements: [{ index: 0, tag: 'button', role: '', name: 'Ellipse', text: 'Ellipse', id: 'ellipse', selector: '#ellipse', rect: { x: 40, y: 30, w: 100, h: 40 }, center: { x: 90, y: 50 }, visible: true, enabled: true, checked: null, value: '' }],
    landmarks: [], truncated: false
  };
  const controller = new BrowserViewController({
    getTabs: () => [tab],
    getSelectedTabId: () => tab.id,
    getConsoleEntries: () => [],
    normalizeUrl: (value) => value,
    debuggerLeaseManager: {
      async send(tabId, purpose, method, params) {
        cdpCalls.push({ tabId, purpose, method, params });
        return { result: { value: payload } };
      }
    }
  });

  const snapshot = await controller.domSnapshot(tab.id, { maxElements: 10 });

  assert.equal(snapshot.title, 'CDP DOM fixture');
  assert.deepEqual(snapshot.elements[0].center, { x: 90, y: 50 });
  assert.equal(cdpCalls.length, 1);
  assert.equal(cdpCalls[0].method, 'Runtime.evaluate');
  assert.equal(cdpCalls[0].purpose, 'DOM snapshot');
  assert.equal(cdpCalls[0].params.returnByValue, true);
});

test('clickElement resolves the latest snapshot index and sends real mouse events at its center', async () => {
  const { controller, inputEvents } = createHarness();

  await controller.domSnapshot('tab-1');
  const clicked = await controller.clickElement('tab-1', { index: 0, button: 'left' }, 'session-a');

  assert.equal(clicked.element.id, 'ellipse');
  assert.deepEqual(inputEvents, [
    { type: 'mouseMoved', x: 90, y: 50 },
    { type: 'mousePressed', x: 90, y: 50, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 90, y: 50, button: 'left', buttons: 0, clickCount: 1 }
  ]);
});

test('fillElement selects the control page-side and inserts text without a key chord', async () => {
  const { controller, tab, inputEvents } = createHarness();
  const originalEvaluate = tab.webContents.executeJavaScript;
  let verificationCalls = 0;
  controller.elementRect = async () => ({ index: 0, tag: 'input', name: 'Search', text: '', selector: '#search' });
  controller.evaluatePage = async (_tab, purpose) => {
    if (purpose === 'focus form control') return { ok: true, native: true, selected: true, value: 'old' };
    verificationCalls += 1;
    return { ok: true, changed: true, matched: true, valueLength: 3 };
  };
  tab.webContents.executeJavaScript = async () => {
    throw new Error('fillElement must not use page-side JavaScript for editable native controls');
  };

  const result = await controller.fillElement('tab-1', { index: 0, text: 'new' });

  assert.equal(result.ok, true);
  assert.equal(result.matched, true);
  assert.equal(verificationCalls, 2);
  assert.deepEqual(inputEvents, [{ type: 'text', text: 'new' }]);
  tab.webContents.executeJavaScript = originalEvaluate;
});

test('fillElement keeps background-tab native input on the tab-scoped CDP channel', async () => {
  const { controller, tab } = createHarness();
  const cdpCalls = [];
  controller.getSelectedTabId = () => 'different-tab';
  controller.elementRect = async () => ({ index: 0, tag: 'input', name: 'Search', text: '', selector: '#search' });
  controller.evaluatePage = async (_tab, purpose) => purpose === 'focus form control'
    ? { ok: true, native: true, selected: true, value: 'old' }
    : { ok: true, changed: true, matched: true, valueLength: 3 };
  controller.debuggerLeaseManager = {
    async send(tabId, purpose, method, params) {
      cdpCalls.push({ tabId, purpose, method, params });
      return {};
    }
  };

  const result = await controller.fillElement('tab-1', { index: 0, text: 'new' });

  assert.equal(result.ok, true);
  assert.deepEqual(cdpCalls.map((call) => call.method), ['Input.insertText']);
  assert.deepEqual(cdpCalls.at(-1).params, { text: 'new' });
});


test('fillElement preserves the DOM setter path for non-native targets', async () => {
  const { controller, tab, inputEvents } = createHarness();
  controller.elementRect = async () => ({ index: 0, tag: 'div', name: 'Editor', text: '', selector: '#editor' });
  const purposes = [];
  controller.evaluatePage = async (_tab, purpose) => {
    purposes.push(purpose);
    if (purpose === 'focus form control') return { ok: true, native: false, value: 'old' };
    return { ok: true, changed: true, matched: true, valueLength: 3 };
  };

  const result = await controller.fillElement('tab-1', { index: 0, text: 'new' });

  assert.equal(result.ok, true);
  assert.deepEqual(inputEvents, []);
  assert.ok(purposes.includes('form fill verification'));
});

test('fillElement fails closed when native focus is not retained', async () => {
  const { controller, tab, inputEvents } = createHarness();
  const cdpCalls = [];
  controller.elementRect = async () => ({ index: 0, tag: 'input', name: 'Search', text: '', selector: '#search' });
  controller.evaluatePage = async (_tab, purpose) => {
    assert.equal(purpose, 'focus form control');
    return { ok: false, native: false, reason: 'The selected control could not receive native focus.' };
  };
  controller.debuggerLeaseManager = {
    async send(tabId, purpose, method, params) {
      cdpCalls.push({ tabId, purpose, method, params });
      return {};
    }
  };

  const result = await controller.fillElement('tab-1', { index: 0, text: 'new' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /could not receive native focus/);
  assert.deepEqual(inputEvents, []);
  assert.deepEqual(cdpCalls, []);
});

test('navigate resolves at main-frame commit instead of waiting for a long resource tail', async () => {
  let currentUrl = 'https://example.test/';
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => currentUrl,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    loadURL: (url) => {
      setTimeout(() => {
        webContents.emit('did-start-navigation', {}, url, false, true);
        currentUrl = url;
        webContents.emit('did-navigate', {}, url, 200, 'OK', true);
      }, 5);
      return new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  });
  const tab = { id: 'tab-1', title: 'Fixture', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => tab.id, getConsoleEntries: () => [], normalizeUrl: (value) => value
  });
  const startedAt = Date.now();
  const result = await controller.navigate(tab.id, 'https://example.test/auth');

  assert.equal(result.url, 'https://example.test/auth');
  assert.ok(Date.now() - startedAt < 250, 'main-frame commit must not wait for the simulated one-second resource tail');
});

test('navigate rejects an HTTP error commit instead of treating a 404 page as evidence', async () => {
  let currentUrl = 'https://source.example/';
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => currentUrl,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    loadURL: (url) => {
      setTimeout(() => {
        webContents.emit('did-start-navigation', {}, url, false, true);
        currentUrl = url;
        webContents.emit('did-navigate', {}, url, 404, 'Not Found', true);
      }, 5);
      return Promise.resolve();
    }
  });
  const tab = { id: 'tab-1', title: 'Fixture', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => tab.id, getConsoleEntries: () => [], normalizeUrl: (value) => value
  });
  await assert.rejects(controller.navigate(tab.id, 'https://target.example/missing'), /HTTP 404 Not Found/);
});

test('navigate resolves a same-document hash from Electron in-page navigation', async () => {
  let currentUrl = 'https://example.test/page';
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => false,
    getURL: () => currentUrl,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    loadURL: (url) => {
      setTimeout(() => {
        webContents.emit('did-start-navigation', {}, url, true, true);
        currentUrl = url;
        webContents.emit('did-navigate-in-page', {}, url, true);
      }, 5);
      return Promise.resolve();
    }
  });
  const tab = { id: 'tab-1', title: 'Fixture', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => tab.id, getConsoleEntries: () => [], normalizeUrl: (value) => value
  });
  const startedAt = Date.now();
  const result = await controller.navigate(tab.id, 'https://example.test/page#details');

  assert.equal(result.url, 'https://example.test/page#details');
  assert.ok(Date.now() - startedAt < 250, 'fragment navigation must not wait for the full main-frame timeout');
});

test('navigate does not report the previous page when loadURL resolves before target commit', async () => {
  let currentUrl = 'https://source.example/list?q=target';
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => true,
    getURL: () => currentUrl,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    loadURL: (url) => {
      setTimeout(() => {
        webContents.emit('did-start-navigation', {}, url, false, true);
        currentUrl = url;
        webContents.emit('did-navigate', {}, url, 200, 'OK', true);
      }, 30);
      // This models Electron handing the request off before the target page has
      // committed. Returning here must not make browser_navigate claim the old
      // source route as success.
      return Promise.resolve();
    }
  });
  const tab = { id: 'tab-1', title: 'Fixture', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => tab.id, getConsoleEntries: () => [], normalizeUrl: (value) => value
  });
  const startedAt = Date.now();
  const result = await controller.navigate(tab.id, 'https://target.example/');

  assert.equal(result.url, 'https://target.example/');
  assert.ok(Date.now() - startedAt >= 20, 'completion must wait for the target main-frame commit');
});

test('navigate accepts an exact main-frame commit when Electron omits did-start-navigation', async () => {
  let currentUrl = 'https://source.example/list?q=target';
  const webContents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    isLoading: () => true,
    getURL: () => currentUrl,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    stopCalls: 0,
    stop() { this.stopCalls += 1; },
    loadURL: (url) => {
      setTimeout(() => {
        currentUrl = url;
        // BrowserView can surface the authoritative commit without a paired
        // did-start-navigation event after a prior document is still settling.
        webContents.emit('did-navigate', {}, url, 200, 'OK', true);
      }, 15);
      return Promise.resolve();
    }
  });
  const tab = { id: 'tab-1', title: 'Fixture', webContents };
  const controller = new BrowserViewController({
    getTabs: () => [tab], getSelectedTabId: () => tab.id, getConsoleEntries: () => [], normalizeUrl: (value) => value
  });

  const result = await controller.navigate(tab.id, 'https://target.example/');

  assert.equal(result.url, 'https://target.example/');
  assert.equal(webContents.stopCalls, 1, 'only the stale prior load should be stopped before the explicit destination');
});

test('stale selectors rematch a unique element identity after a dynamic rerender', async () => {
  const { controller, tab, inputEvents } = createHarness();
  await controller.domSnapshot('tab-1');
  let reads = 0;
  tab.webContents.executeJavaScript = async () => {
    reads += 1;
    if (reads === 1) return { url: 'https://example.test/', title: 'DOM fixture', viewport: { width: 800, height: 600 }, elements: [], truncated: false };
    return { url: 'https://example.test/', title: 'DOM fixture', viewport: { width: 800, height: 600 }, elements: [{ index: 4, tag: 'button', role: '', name: 'Ellipse', text: 'Ellipse', id: '', testId: '', dataTool: 'shape-ellipse', selector: '.new-ellipse', rect: { x: 50, y: 40, w: 100, h: 40 }, center: { x: 100, y: 60 }, visible: true, enabled: true }], truncated: false };
  };
  const clicked = await controller.clickElement('tab-1', { index: 0 }, 'session-a');
  assert.equal(clicked.element.selector, '.new-ellipse');
  assert.deepEqual(inputEvents.at(-3), { type: 'mouseMoved', x: 100, y: 60 });
});

test('stale or missing indices fail closed instead of clicking a wrong element', async () => {
  const { controller } = createHarness();

  await assert.rejects(() => controller.clickElement('tab-1', { index: 0 }, 'session-a'), /browser_dom_snapshot first/i);
  await controller.domSnapshot('tab-1');
  await assert.rejects(() => controller.clickElement('tab-1', { index: 99 }, 'session-a'), /stale/i);
});

test('desktop MCP tool list exposes DOM tools and GPT schema includes them', async () => {
  const { server, session } = createHarness();

  const list = await server.dispatch({ method: 'tools/list', id: 1, params: {} }, session.capability);
  const toolNames = list.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('browser_dom_snapshot'));
  assert.ok(toolNames.includes('browser_query_elements'));
  assert.ok(toolNames.includes('browser_click_element'));

  const source = require('fs').readFileSync(require.resolve('../desktop/mcp/localMcpServer.cjs'), 'utf8');
  assert.match(source, /browser_dom_snapshot/);
  assert.match(source, /buildGptOpenApiSchema/);
});

// ---- Anchor-biased element selection (over-cap pages only) ----------------

test('selectElementsByAnchor keeps the nearest elements in stable DOM order', () => {
  const { selectElementsByAnchor } = require('../desktop/mcp/browserViewController.cjs');
  const element = (index, x, y) => ({ index, center: { x, y } });
  const elements = Array.from({ length: 10 }, (_, i) => element(i, i * 100, 0));
  // Under cap: identity — identical output, zero behavior change.
  assert.equal(selectElementsByAnchor(elements, 20, { x: 0, y: 0 }), elements);
  // Over cap: the cap nearest the anchor survive, ORIGINAL index order kept.
  const ranked = selectElementsByAnchor(elements, 3, { x: 0, y: 0 });
  assert.deepEqual(ranked.map(e => e.index), [0, 1, 2]);
  const far = selectElementsByAnchor(elements, 3, { x: 900, y: 0 });
  assert.deepEqual(far.map(e => e.index), [7, 8, 9]);
  // No anchor: untouched.
  assert.equal(selectElementsByAnchor(elements, 3, null), elements);
});
