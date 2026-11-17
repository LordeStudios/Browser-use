// Two boundary contracts that cost a caller a wasted round trip when they are
// wrong: an argument error must be reported BEFORE the "bind a tab" gate, and a
// sequence step must accept the ordinary MCP spelling of its payload.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

function createServer({ bind = false, controller = {} } = {}) {
  const broker = new SessionBroker({ installationId: 'install-1', instanceId: 'instance-1' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'Test host' } });
  if (bind) broker.bindTab(session.capability, 'tab-1');
  const server = new LocalMcpServer({ broker, controller, gptKey: '' });
  return { server, capability: session.capability };
}

async function call(server, capability, name, args) {
  return server.callTool({ name, arguments: args }, capability);
}

test('malformed pointer arguments are reported before the tab gate', async () => {
  const { server, capability } = createServer();

  const result = await call(server, capability, 'browser_mousemove', { x: 'not-a-number', y: 10 });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /finite numbers/i);
  assert.doesNotMatch(
    result.content[0].text,
    /Bind a desktop tab/i,
    'a caller with bad arguments must not be sent off to bind a tab first'
  );
});

test('malformed scroll deltas are reported before the tab gate', async () => {
  const { server, capability } = createServer();
  const result = await call(server, capability, 'browser_scroll', { deltaY: 'lots' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Scroll deltas must be finite numbers/i);
});

test('a missing key is reported before the tab gate', async () => {
  const { server, capability } = createServer();
  const result = await call(server, capability, 'browser_key', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Key is required/i);
});

test('an incomplete drag pair is reported before the tab gate', async () => {
  const { server, capability } = createServer();
  const result = await call(server, capability, 'browser_drag', { fromElement: 2 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BOTH fromElement and toElement/i);
});

test('a VALID pointer call with no bound tab still asks for a tab', async () => {
  const { server, capability } = createServer();
  const result = await call(server, capability, 'browser_mousemove', { x: 10, y: 20 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Bind a desktop tab/i);
});

test('a sequence step accepts `arguments` as well as `input`', async () => {
  const seen = [];
  const { server, capability } = createServer({
    bind: true,
    controller: {
      queryElements: (tabId, args) => { seen.push(args); return { tabId, selector: args?.selector ?? null }; }
    }
  });

  const result = await call(server, capability, 'browser_sequence', {
    steps: [{ tool: 'browser_query_elements', arguments: { selector: 'a' } }]
  });

  assert.equal(result.isError, false);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.failed, 0, `the step must run, got ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(body.steps[0].ok, true);
  assert.deepEqual(seen, [{ selector: 'a' }], 'the payload must reach the handler, not be dropped as an empty object');
  assert.equal(body.steps[0].result.selector, 'a');
});

test('`input` still wins when both spellings are present', async () => {
  const seen = [];
  const { server, capability } = createServer({
    bind: true,
    controller: {
      queryElements: (tabId, args) => { seen.push(args); return { tabId, selector: args?.selector ?? null }; }
    }
  });

  await call(server, capability, 'browser_sequence', {
    steps: [{ tool: 'browser_query_elements', input: { selector: 'a' }, arguments: { selector: 'b' } }]
  });

  assert.deepEqual(seen, [{ selector: 'a' }]);
});

// The desktop agent's most-used tool is a ONE-call click that takes an element
// index or coordinates. MCP originally exposed only browser_click_element plus
// separate mousedown/mouseup, so a coordinate click cost two round trips and
// carried no shared hit evidence — the one place the MCP surface was slower
// than the native one.
test('browser_click is advertised with both an element index and coordinates', async () => {
  const { server, capability } = createServer();
  const listed = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, capability);
  const click = listed.tools.find((tool) => tool.name === 'browser_click');
  assert.ok(click, 'the one-call click must be discoverable');
  assert.ok(click.inputSchema.properties.element, 'element index must be advertised');
  assert.ok(click.inputSchema.properties.x && click.inputSchema.properties.y, 'coordinates must be advertised');
});

test('browser_click rejects a call with neither an index nor coordinates', async () => {
  const { server, capability } = createServer();
  const result = await call(server, capability, 'browser_click', {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /element index or finite viewport x\/y/i);
});

test('browser_click prefers the element index over coordinates', async () => {
  const calls = [];
  const controller = {
    getTab: () => ({ id: 'tab-1' }),
    clickElement: (tabId, args) => { calls.push(['element', tabId, args]); return { tabId, input: 'element' }; },
    clickAt: (tabId, args) => { calls.push(['point', tabId, args]); return { tabId, input: 'point' }; }
  };
  const { server, capability } = createServer({ bind: true, controller });

  const result = await call(server, capability, 'browser_click', { element: 4, x: 10, y: 20 });

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [['element', 'tab-1', { index: 4, button: undefined }]]);
});

test('browser_click falls back to coordinates for pixel targets', async () => {
  const calls = [];
  const controller = {
    getTab: () => ({ id: 'tab-1' }),
    clickElement: (tabId, args) => { calls.push(['element', tabId, args]); return { tabId, input: 'element' }; },
    clickAt: (tabId, args) => { calls.push(['point', tabId, args]); return { tabId, input: 'point', hit: { tag: 'CANVAS' } }; }
  };
  const { server, capability } = createServer({ bind: true, controller });

  const result = await call(server, capability, 'browser_click', { x: 640, y: 360 });

  assert.equal(result.isError, false);
  assert.deepEqual(calls, [['point', 'tab-1', { x: 640, y: 360, button: undefined }]]);
  assert.match(result.content[0].text, /CANVAS/, 'the post-click hit test must reach the caller');
});
