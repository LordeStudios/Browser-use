import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');

// A controller that records what a sequence actually reached, so these tests
// prove dispatch rather than just the shape of the reply.
function stubController(overrides = {}) {
  const calls = [];
  const base = {
    navigate: (tabId, url) => { calls.push(['navigate', tabId, url]); return { tabId, url, committed: true }; },
    fillForm: (tabId, args) => { calls.push(['fillForm', tabId]); return { requested: args.fields.length, filled: args.fields.length }; },
    screenshot: (tabId) => { calls.push(['screenshot', tabId]); return { data: 'A'.repeat(400), mimeType: 'image/png' }; },
    scroll: (tabId, args) => { calls.push(['scroll', tabId, args.deltaY]); return { tabId, deltaY: args.deltaY }; },
    clickElement: (tabId, args) => {
      calls.push(['clickElement', tabId, args.index]);
      if (args.index === 9) throw new Error('element 9 is stale');
      return { clicked: args.index };
    }
  };
  return { calls, controller: { ...base, ...overrides } };
}

function pairedServer(controller) {
  const broker = new SessionBroker({ installationId: 'batch-test', instanceId: 'batch-instance' });
  const offer = broker.createPairingOffer();
  const session = broker.pair({ pairingCode: offer.pairingCode, host: { name: 'batch-host' } });
  broker.bindTab(session.capability, 'tab-1');
  const server = new LocalMcpServer({ broker, controller });
  return { server, capability: session.capability };
}

async function callSequence(controller, args) {
  const { server, capability } = pairedServer(controller);
  const result = await server.callTool({ name: 'browser_sequence', arguments: args }, capability);
  return { payload: JSON.parse(result.content[0].text), isError: result.isError };
}

test('a sequence runs every ordered step in one call and reports each result', async () => {
  const { calls, controller } = stubController();

  const { payload, isError } = await callSequence(controller, {
    steps: [
      { tool: 'browser_navigate', input: { url: 'https://example.test' } },
      { tool: 'browser_fill_form', input: { fields: [{ index: 1, text: 'Ada' }, { index: 2, text: 'Lovelace' }] } },
      { tool: 'browser_scroll', input: { deltaY: 400 } }
    ]
  });

  assert.equal(isError, false);
  assert.equal(payload.requested, 3);
  assert.equal(payload.executed, 3);
  assert.equal(payload.succeeded, 3);
  assert.equal(payload.failed, 0);
  assert.equal(payload.unexecuted, undefined, 'a fully executed sequence reports no tail');
  assert.deepEqual(payload.steps.map((step) => step.ok), [true, true, true]);
  assert.deepEqual(calls.map((call) => call[0]), ['navigate', 'fillForm', 'scroll'], 'each step reaches the real handler once');
  assert.equal(payload.steps[1].result.filled, 2);
});

test('a mid-chain failure stops the chain and reports the unexecuted tail', async () => {
  const { calls, controller } = stubController();

  const { payload } = await callSequence(controller, {
    steps: [
      { tool: 'browser_click_element', input: { index: 1 } },
      { tool: 'browser_click_element', input: { index: 9 } },
      { tool: 'browser_scroll', input: { deltaY: 200 } }
    ]
  });

  assert.equal(payload.executed, 2, 'the failing step is executed, the tail is not');
  assert.equal(payload.succeeded, 1);
  assert.equal(payload.failed, 1);
  assert.match(payload.steps[1].error, /element 9 is stale/);
  assert.deepEqual(payload.unexecuted, [{ index: 2, tool: 'browser_scroll' }], 'the unexecuted tail is named, not lost');
  assert.deepEqual(calls.map((call) => call[0]), ['clickElement', 'clickElement'], 'nothing after the failure runs');
});

test('stopOnError false keeps going and reports every failure', async () => {
  const { calls, controller } = stubController();

  const { payload } = await callSequence(controller, {
    stopOnError: false,
    steps: [
      { tool: 'browser_click_element', input: { index: 9 } },
      { tool: 'browser_scroll', input: { deltaY: 100 } },
      { tool: 'browser_click_element', input: { index: 9 } }
    ]
  });

  assert.equal(payload.executed, 3);
  assert.equal(payload.failed, 2);
  assert.equal(payload.succeeded, 1);
  assert.deepEqual(calls.map((call) => call[0]), ['clickElement', 'scroll', 'clickElement'], 'a failure never cancels its siblings');
});

test('a screenshot inside a sequence is reported by size, never as inline base64', async () => {
  const { controller } = stubController();

  const { payload } = await callSequence(controller, {
    steps: [
      { tool: 'browser_screenshot' },
      { tool: 'browser_scroll', input: { deltaY: 10 } }
    ]
  });

  const shot = payload.steps[0].result;
  assert.equal(shot.imageOmitted, true);
  assert.equal(shot.mimeType, 'image/png');
  assert.equal(shot.data, undefined, 'the base64 payload must not ride the sequence reply');
  assert.ok(shot.imageBytes > 0);
});

test('a sequence refuses recursion, session mutation and unknown tools with an explanation', async () => {
  const { calls, controller } = stubController();

  const nested = await callSequence(controller, {
    steps: [{ tool: 'browser_sequence', input: { steps: [] } }]
  });
  assert.equal(nested.payload.failed, 1);
  assert.match(nested.payload.steps[0].error, /cannot contain another sequence/);

  const binding = await callSequence(controller, {
    steps: [{ tool: 'browser_bind_tab', input: { tabId: 'tab-2' } }]
  });
  assert.match(binding.payload.steps[0].error, /session operation/);

  const unknown = await callSequence(controller, {
    steps: [{ tool: 'browser_made_up' }]
  });
  assert.match(unknown.payload.steps[0].error, /unknown step tool/);
  assert.deepEqual(calls, [], 'a refused step never reaches the controller');
});

test('an empty or oversized sequence is rejected before any step runs', async () => {
  const { controller } = stubController();

  // A bad argument is a TOOL failure, not a broken exchange: the call is
  // answered with isError so the model can correct it, instead of a JSON-RPC
  // error that reads to a client like the server itself is faulty.
  const empty = await callSequence(controller, { steps: [] });
  assert.equal(empty.isError, true, 'an empty sequence must be a tool error');
  assert.match(empty.payload.error, /non-empty steps array/);

  const oversized = await callSequence(controller, { steps: Array.from({ length: 33 }, () => ({ tool: 'browser_scroll' })) });
  assert.equal(oversized.isError, true, 'an oversized sequence must be a tool error');
  assert.match(oversized.payload.error, /at most 32 steps/);
});

// ---- JSON-RPC batching (transport level) -----------------------------------

function fakeResponse() {
  const state = { statusCode: null, headers: {}, body: '', ended: false };
  return {
    state,
    setHeader(name, value) { state.headers[name] = value; },
    set statusCode(value) { state.statusCode = value; },
    get statusCode() { return state.statusCode; },
    // A notification stream writes instead of ending, so the harness needs both.
    write(chunk) { state.body += chunk; return true; },
    on() { /* stream lifecycle hooks */ },
    end(chunk) { if (chunk !== undefined) state.body += chunk; state.ended = true; }
  };
}

function batchServer(controller) {
  const { server, capability } = pairedServer(controller);
  server.resolveMcpConnection = () => ({ id: 'mcp-batch', capability, tabId: 'tab-1' });
  return server;
}

test('one HTTP request can carry several tool calls and returns every reply', async () => {
  const { calls, controller } = stubController();
  const server = batchServer(controller);
  const response = fakeResponse();

  await server.handleMcpBatch([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://a.test' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://b.test' } } }
  ], {}, response);

  assert.equal(response.state.statusCode, 200);
  const replies = JSON.parse(response.state.body);
  assert.equal(replies.length, 2, 'one request, two replies');
  assert.deepEqual(replies.map((reply) => reply.id), [1, 2], 'replies keep request order');
  assert.deepEqual(calls.map((call) => call[2]), ['https://a.test', 'https://b.test']);
});

test('a failing call in a batch does not cancel its siblings', async () => {
  const { controller } = stubController();
  const server = batchServer(controller);
  const response = fakeResponse();

  await server.handleMcpBatch([
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://ok.test' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_not_a_tool', arguments: {} } },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_scroll', arguments: { deltaY: 5 } } }
  ], {}, response);

  const replies = JSON.parse(response.state.body);
  assert.equal(replies.length, 3);
  assert.ok(replies[0].result, 'the first call still succeeded');
  assert.ok(replies[1].error, 'the bad call reports its own error');
  assert.ok(replies[2].result, 'a later call still ran after the failure');
});

test('initialize must travel alone and an empty batch is refused', async () => {
  const { controller } = stubController();
  const server = batchServer(controller);

  const withInitialize = fakeResponse();
  await server.handleMcpBatch([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }
  ], {}, withInitialize);
  assert.equal(withInitialize.state.statusCode, 400);
  assert.match(JSON.parse(withInitialize.state.body).error.message, /initialize must be sent on its own/);

  const empty = fakeResponse();
  await server.handleMcpBatch([], {}, empty);
  assert.equal(empty.state.statusCode, 400);
});

test('the MCP handshake advertises batching to connected agents', async () => {
  const { server } = pairedServer(stubController().controller);
  // Read it the way a client does: off the initialize result, not off a constant.
  const value = await server.dispatch(
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    null
  );
  assert.match(value.instructions, /BATCHING IS SUPPORTED/);
  assert.match(value.instructions, /browser_sequence/);
  assert.match(value.instructions, /JSON-RPC batch array/);
});

// ---- Tool-list freshness ---------------------------------------------------
// The server advertised listChanged:false, so a connected client never refreshed
// its tool index and a tool added by an upgrade (browser_sequence) stayed
// invisible to every already-configured client until an unrelated reconnect.

test('the handshake tells the client the tool list can change', async () => {
  const { server } = pairedServer(stubController().controller);
  const value = await server.dispatch({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, null);
  assert.equal(value.capabilities.tools.listChanged, true, 'listChanged:false promises a client it never needs to refresh');
});

test('GET /mcp opens a notification stream that announces the current catalog', async () => {
  const { server, capability } = pairedServer(stubController().controller);
  const session = server.createMcpSession({ ...server.broker.authenticate(capability), capability });

  const response = fakeResponse();
  server.handleMcpStream({ headers: { 'mcp-session-id': session.id }, on() {} }, response);

  assert.equal(response.state.statusCode, 200);
  assert.match(String(response.state.headers['Content-Type']), /text\/event-stream/);
  assert.equal(response.state.ended, false, 'the stream must stay open');
  // Announced immediately: a client that reconnects after an upgrade is holding
  // a stale index, and this is the one moment it is guaranteed to be listening.
  assert.match(response.state.body, /notifications\/tools\/list_changed/);
  assert.equal(server.toolStreams.size, 1);
});

test('a notification stream requires a live session', async () => {
  const { server } = pairedServer(stubController().controller);
  const anonymous = fakeResponse();
  server.handleMcpStream({ headers: {} }, anonymous);
  assert.equal(anonymous.state.statusCode, 401);
  assert.equal(server.toolStreams.size, 0);
});

test('a changed catalog notifies every open stream', async () => {
  const { server, capability } = pairedServer(stubController().controller);
  const session = server.createMcpSession({ ...server.broker.authenticate(capability), capability });
  const response = fakeResponse();
  server.handleMcpStream({ headers: { 'mcp-session-id': session.id }, on() {} }, response);

  // First observation only records the fingerprint; a change after that is what
  // a client actually needs to hear about.
  server.syncToolCatalogFingerprint();
  const before = response.state.body.length;
  server.toolCatalogFingerprint = 'stale-fingerprint';
  server.syncToolCatalogFingerprint();

  assert.ok(response.state.body.length > before, 'a moved catalog must be announced');
});
