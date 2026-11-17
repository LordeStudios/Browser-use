import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');

test('an occupied MCP port becomes a handled typed startup error and leaves the server retryable', async (t) => {
  const occupied = http.createServer((_request, response) => response.end('occupied'));
  await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  const port = occupied.address().port;
  const server = new LocalMcpServer({
    broker: new SessionBroker({ installationId: 'port-collision-test', instanceId: 'port-collision-instance' }),
    controller: {},
    port
  });
  t.after(() => occupied.close());

  await assert.rejects(server.start(), (error) => {
    assert.equal(error.code, 'MCP_PORT_IN_USE');
    assert.equal(error.port, port);
    assert.match(error.message, new RegExp(String(port)));
    return true;
  });
  assert.equal(server.status().listening, false);
  assert.equal(server.server, null, 'failed startup must not retain a half-open listener');
});

test('the public Desktop GPT Action schema has the complete GPT importer component shape', async (t) => {
  const server = new LocalMcpServer({
    broker: new SessionBroker({ installationId: 'gpt-schema-test', instanceId: 'gpt-schema-instance' }),
    controller: {},
    gptKey: 'gpt-schema-key'
  });
  await server.start();
  t.after(async () => server.stop());

  const response = await fetch(server.status().gptOpenApiEndpoint, {
    headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'gpt-browser.example.test' }
  });
  assert.equal(response.status, 200, 'schema discovery must remain public');
  const schema = await response.json();
  assert.equal(schema.openapi, '3.1.0');
  assert.equal(schema.servers[0].url, 'https://gpt-browser.example.test');
  assert.deepEqual(schema.components.schemas, {}, 'strict GPT importers require the schemas component even when no named schema is needed');
  assert.equal(schema.components.securitySchemes.ApiKeyAuth.name, 'X-API-Key');
});

test('the Claude headers helper endpoint issues the durable pairing header for every connection', async (t) => {
  const broker = new SessionBroker({ installationId: 'claude-helper-test', instanceId: 'claude-helper-instance' });
  const server = new LocalMcpServer({ broker, controller: {} });
  await server.start();
  t.after(async () => server.stop());

  const { endpoint, authenticationEndpoint } = server.status();
  assert.equal(authenticationEndpoint, `${endpoint}/authenticate`);

  const firstResponse = await fetch(authenticationEndpoint);
  assert.equal(firstResponse.status, 200);
  assert.equal(firstResponse.headers.get('cache-control'), 'no-store');
  const firstHeaders = await firstResponse.json();
  assert.deepEqual(Object.keys(firstHeaders), ['X-Browser-Use-Pairing-Code']);
  assert.match(firstHeaders['X-Browser-Use-Pairing-Code'], /^[A-Za-z0-9_-]{20,}$/);
  assert.equal(JSON.stringify(firstHeaders).includes('capability'), false);

  const firstInitialize = await rpc(endpoint, firstHeaders, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.225' } }
  });
  assert.equal(firstInitialize.status, 200);
  assert.match(firstInitialize.sessionId, /^mcp-/);

  // V293: the pairing code is DURABLE — every connection gets the same
  // statically configurable code, and re-initializing with it recovers the
  // same opaque session instead of failing after an app restart.
  const secondHeaders = await fetch(authenticationEndpoint).then((response) => response.json());
  assert.equal(secondHeaders['X-Browser-Use-Pairing-Code'], firstHeaders['X-Browser-Use-Pairing-Code'], 'the durable code is the statically configurable credential');
  const secondInitialize = await rpc(endpoint, secondHeaders, {
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'claude-code', version: '2.1.225' } }
  });
  assert.equal(secondInitialize.status, 200);
  assert.equal(secondInitialize.sessionId, firstInitialize.sessionId, 'the durable code recovers the same transport session');
  assert.equal(broker.status().sessions.length, 1);

  const wrongMethod = await fetch(authenticationEndpoint, { method: 'POST' });
  assert.equal(wrongMethod.status, 405);
});

test('a static pairing header bootstraps and recovers one opaque MCP session without a bearer handoff', async (t) => {
  const broker = new SessionBroker({ installationId: 'bootstrap-test', instanceId: 'instance-test' });
  const keyCalls = [];
  const server = new LocalMcpServer({
    broker,
    controller: {
      getTab: (id) => ({ id }),
      key: async (tabId, args, sessionId) => {
        keyCalls.push({ tabId, args, sessionId });
        return { ok: true };
      }
    }
  });
  await server.start();
  t.after(async () => server.stop());

  const { endpoint } = server.status();
  const missingBootstrap = await rpc(endpoint, {}, {
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'weak-mcp-host', version: '0.1' } }
  });
  assert.equal(missingBootstrap.status, 401, 'a weak host must learn about missing bootstrap credentials immediately');
  assert.equal(missingBootstrap.body.error.code, -32001);
  assert.match(missingBootstrap.body.error.message, /pairing header/i);

  const offer = broker.createPairingOffer();
  const bootstrapHeaders = { 'X-Browser-Use-Pairing-Code': offer.pairingCode };
  const initialize = await rpc(endpoint, bootstrapHeaders, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'weak-mcp-host', version: '0.1' } }
  });

  assert.equal(initialize.status, 200);
  assert.equal(initialize.body.result.serverInfo.name, 'browser-use-desktop');
  assert.match(initialize.sessionId, /^mcp-/);
  assert.equal(JSON.stringify(initialize.body).includes(offer.pairingCode), false);
  assert.equal(JSON.stringify(initialize.body).includes('capability'), false);
  const sessionId = initialize.sessionId;

  // A client that retries setup instead of retaining an in-process bearer gets
  // the exact same opaque transport session and never creates a second broker
  // session. This is the weak-agent recovery path.
  const retriedInitialize = await rpc(endpoint, bootstrapHeaders, {
    jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'weak-mcp-host', version: '0.1' } }
  });
  assert.equal(retriedInitialize.sessionId, sessionId);
  assert.equal(broker.status().sessions.length, 1);

  const initialized = await rpc(endpoint, { 'Mcp-Session-Id': sessionId }, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {}
  });
  assert.equal(initialized.status, 202);
  assert.equal(initialized.sessionId, sessionId);

  // The session is ready for every MCP action without a second local grant.
  const bound = await rpc(endpoint, { 'Mcp-Session-Id': sessionId }, {
    jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'browser_bind_tab', arguments: { tabId: 'tab-1' } }
  });
  assert.equal(bound.status, 200);
  assert.equal(bound.sessionId, sessionId);
  assert.equal(bound.body.error, undefined);
  const immediateKey = await rpc(endpoint, { 'Mcp-Session-Id': sessionId }, {
    jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'browser_key', arguments: { key: 'a' } }
  });
  assert.equal(immediateKey.status, 200);
  assert.equal(immediateKey.sessionId, sessionId);
  assert.equal(immediateKey.body.error, undefined);
  assert.deepEqual(keyCalls, [{ tabId: 'tab-1', args: { key: 'a' }, sessionId: broker.status().sessions[0].id }]);

  const listed = await rpc(endpoint, { 'Mcp-Session-Id': sessionId }, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  assert.equal(listed.status, 200);
  assert.equal(listed.sessionId, sessionId);
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'browser_get_tabs'));
  assert.ok(listed.body.result.tools.some((tool) => tool.name === 'browser_agent_start'), 'the full-access agent route must be discoverable by normal MCP clients');

  // A host that cannot retain headers between individual calls can still use
  // the same static bootstrap header within the offer lifetime.
  const listedWithBootstrapRetry = await rpc(endpoint, bootstrapHeaders, { jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  assert.equal(listedWithBootstrapRetry.status, 200);
  assert.equal(listedWithBootstrapRetry.sessionId, sessionId);
  assert.equal(broker.status().sessions.length, 1);

  const legacyReplay = await postResponse(server.status().pairingEndpoint, {
    pairingCode: offer.pairingCode,
    host: { name: 'legacy-retry-host', version: '1.0.0' }
  });
  assert.equal(legacyReplay.status, 409, 'a header-bootstraped session must not re-issue a raw legacy bearer');
  assert.match(legacyReplay.body.error, /already exists/i);
  assert.equal(JSON.stringify(legacyReplay.body).includes('capability'), false);

  const closed = await fetch(endpoint, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessionId } });
  assert.deepEqual(await closed.json(), { ok: true, closed: true });
  const closedCall = await rpc(endpoint, { 'Mcp-Session-Id': sessionId }, { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} });
  assert.equal(closedCall.status, 200);
  assert.equal(closedCall.body.error.code, -32001);

  // Some weak hosts keep a stale transport id alongside their configured
  // static pairing header. That exact ordinary retry must recover instead of
  // forcing the host to clear state or ask the person for another code.
  const recoveredWithStaleHeader = await rpc(endpoint, { 'Mcp-Session-Id': sessionId, ...bootstrapHeaders }, { jsonrpc: '2.0', id: 6, method: 'tools/list', params: {} });
  assert.equal(recoveredWithStaleHeader.status, 200);
  assert.notEqual(recoveredWithStaleHeader.sessionId, sessionId, 'a stale transport can be rebuilt without a new pairing offer');

  const recoveredAfterClose = await rpc(endpoint, bootstrapHeaders, { jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  assert.equal(recoveredAfterClose.status, 200);
  assert.equal(recoveredAfterClose.sessionId, recoveredWithStaleHeader.sessionId, 'the recovered pairing header must reuse its new opaque transport');
  assert.equal(broker.status().sessions.length, 1, 'transport recovery must retain the same broker session');
});

test('new-tab MCP creates an isolated background tab and preserves existing tabs', async () => {
  const tabs = new Map([
    ['tab-existing', { id: 'tab-existing', title: 'Existing', url: 'https://example.test/' }]
  ]);
  let selectedTabId = 'tab-existing';
  let next = 1;
  const controller = {
    listTabs: () => [...tabs.values()],
    getTab: (id) => {
      assert.ok(tabs.has(id), `tab ${id} must exist`);
      return tabs.get(id);
    },
    createTab: (url) => {
      const tab = { id: `tab-new-${next++}`, title: 'New tab', url };
      tabs.set(tab.id, tab);
      return tab;
    },
    closeTab: (id) => tabs.delete(id)
  };
  const broker = new SessionBroker({ installationId: 'new-tab-test', instanceId: 'new-tab-instance' });
  const server = new LocalMcpServer({ broker, controller });
  const offer = broker.createPairingOffer();
  const initialized = await memoryRpc(server, { 'x-browser-use-pairing-code': offer.pairingCode }, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'new-tab-host' } }
  });
  const headers = { 'mcp-session-id': initialized.sessionId };
  const tool = (name, args = {}) => memoryRpc(server, headers, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args }
  });

  const created = await tool('browser_new_tab', { url: 'https://gemini.google.com/app' });
  assert.equal(created.body.error, undefined);
  const createdTab = JSON.parse(created.body.result.content[0].text);
  assert.equal(createdTab.url, 'https://gemini.google.com/app');
  assert.equal(selectedTabId, 'tab-existing', 'creating a background tab must not change the selected existing tab');
  assert.equal(tabs.get('tab-existing').url, 'https://example.test/', 'existing tab navigation must remain untouched');

  assert.equal((await tool('browser_bind_tab', { tabId: createdTab.id })).body.error, undefined);
  const bound = await tool('browser_get_tab');
  assert.equal(JSON.parse(bound.body.result.content[0].text).id, createdTab.id);
  assert.equal((await tool('browser_close_tab', { tabId: createdTab.id })).body.error, undefined);
  assert.equal(tabs.has(createdTab.id), false);
  assert.equal(tabs.has('tab-existing'), true);
});

test('the legacy pairing endpoint can issue one bearer without re-issuing it on retry', async (t) => {
  const broker = new SessionBroker({ installationId: 'legacy-bootstrap-test', instanceId: 'legacy-instance-test' });
  const server = new LocalMcpServer({ broker, controller: {} });
  await server.start();
  t.after(async () => server.stop());

  const offer = broker.createPairingOffer();
  const first = await postResponse(server.status().pairingEndpoint, {
    pairingCode: offer.pairingCode,
    host: { name: 'legacy-host', version: '1.0.0' }
  });
  assert.equal(first.status, 200);
  assert.ok(first.body.session.capability, 'a first legacy exchange keeps old hosts working');
  assert.match(first.body.mcpSessionId, /^mcp-/);

  const legacyConnection = { authorization: `Bearer ${first.body.session.capability}` };
  const initialized = await rpc(server.status().endpoint, legacyConnection, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', clientInfo: { name: 'legacy-host', version: '1.0.0' } }
  });
  assert.equal(initialized.status, 200);
  assert.equal(initialized.sessionId, first.body.mcpSessionId, 'legacy bootstrap keeps one transport session too');
  const notification = await rpc(server.status().endpoint, { 'Mcp-Session-Id': initialized.sessionId }, {
    jsonrpc: '2.0', method: 'notifications/initialized', params: {}
  });
  assert.equal(notification.status, 202);
  const tools = await rpc(server.status().endpoint, { 'Mcp-Session-Id': initialized.sessionId }, {
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {}
  });
  assert.equal(tools.status, 200);
  assert.ok(tools.body.result.tools.some((tool) => tool.name === 'browser_get_tabs'));

  const replay = await postResponse(server.status().pairingEndpoint, {
    pairingCode: offer.pairingCode,
    host: { name: 'legacy-retry-host', version: '1.0.0' }
  });
  assert.equal(replay.status, 409);
  assert.equal(JSON.stringify(replay.body).includes('capability'), false);
});

test('tab changes and tab closure release input without ending the opaque MCP session', async () => {
  const tabs = new Map([['tab-a', { id: 'tab-a' }], ['tab-b', { id: 'tab-b' }]]);
  const heldInput = new Set();
  const released = [];
  const ended = [];
  const releaseInput = (sessionId) => {
    released.push(sessionId);
    heldInput.delete(sessionId);
  };
  let server;
  const broker = new SessionBroker({
    installationId: 'binding-lifecycle-test',
    instanceId: 'binding-lifecycle-instance',
    onSessionEnded: (sessionId) => {
      ended.push(sessionId);
      server.forgetBrokerSession(sessionId);
      releaseInput(sessionId);
    },
    onTabBindingChanged: releaseInput
  });
  server = new LocalMcpServer({
    broker,
    controller: {
      listTabs: () => [...tabs.values()],
      getTab: (id) => {
        assert.ok(tabs.has(id), 'the explicitly requested tab must still exist');
        return tabs.get(id);
      },
      key: (_tabId, _args, sessionId) => {
        heldInput.add(sessionId);
        return { ok: true };
      }
    }
  });
  const offer = broker.createPairingOffer();
  const initialize = await memoryRpc(server, { 'x-browser-use-pairing-code': offer.pairingCode }, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'binding-host' } }
  });
  assert.ok(initialize.body.result);
  const headers = { 'mcp-session-id': initialize.sessionId };
  const sessionId = broker.status().sessions[0].id;
  const tool = (name, args = {}) => memoryRpc(server, headers, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args }
  });
  const expectLiveTab = async (tabId) => {
    const response = await tool('browser_get_tab');
    assert.equal(response.body.error, undefined, 'the next request must retain its opaque session after a target change');
    assert.equal(JSON.parse(response.body.result.content[0].text).id, tabId);
    assert.ok(response.sessionId === initialize.sessionId, 'target changes must preserve the opaque session');
    assert.equal(server.mcpSessions.size, 1);
    assert.equal(broker.status().sessions.length, 1);
  };

  assert.equal((await tool('browser_bind_tab', { tabId: 'tab-a' })).body.error, undefined);
  await expectLiveTab('tab-a');
  await tool('browser_key', { key: 'Control', action: 'down' });
  assert.ok(heldInput.has(sessionId));
  await tool('browser_bind_tab', { tabId: 'tab-a' });
  assert.ok(heldInput.has(sessionId), 'the same binding must not release an in-progress input sequence');
  assert.equal(released.length, 0);

  for (const tabId of ['tab-b', 'tab-a']) {
    assert.equal((await tool('browser_bind_tab', { tabId })).body.error, undefined);
    assert.equal(heldInput.has(sessionId), false, 'leaving a target must release its held input');
    await expectLiveTab(tabId);
    await tool('browser_key', { key: 'Control', action: 'down' });
  }
  assert.equal(released.length, 2);
  assert.equal(ended.length, 0, 'rebinding is not session termination');

  tabs.delete('tab-a');
  assert.equal(broker.unbindTab('tab-a'), true);
  assert.equal(heldInput.has(sessionId), false, 'closing the bound tab must release input too');
  assert.equal(released.length, 3);
  assert.equal(broker.unbindTab('tab-a'), false);
  assert.equal(released.length, 3, 'repeated unbind must not duplicate cleanup');
  assert.equal((await tool('browser_get_tabs')).body.error, undefined, 'unbound sessions retain non-tab tools');
  // A missing binding is a usage state the caller resolves with another tool,
  // so it is a tool failure at HTTP 200 (isError + text), not a JSON-RPC fault.
  // The transport still succeeded; treating it as an error made clients retry
  // the connection instead of binding a tab.
  const unboundTab = await tool('browser_get_tab');
  assert.equal(unboundTab.body.error, undefined, 'a missing binding must not look like a broken transport');
  assert.equal(unboundTab.body.result.isError, true);
  assert.match(unboundTab.body.result.content[0].text, /Bind a desktop tab/i);
  assert.equal(ended.length, 0, 'tab closure must not revoke authentication');
  assert.equal((await tool('browser_bind_tab', { tabId: 'tab-b' })).body.error, undefined);
  await expectLiveTab('tab-b');
  assert.equal(released.length, 3, 'first binding after unbind has no old input to release');

  await tool('browser_key', { key: 'Control', action: 'down' });
  assert.equal(broker.revoke(sessionId), true);
  assert.deepEqual(ended, [sessionId]);
  assert.equal(heldInput.has(sessionId), false);
  assert.equal(server.mcpSessions.size, 0);
  assert.equal((await tool('browser_get_tabs')).body.error.code, -32001);
  // V293: revocation never resurrects the revoked session, but the durable
  // code re-pairs a fresh one — the statically configured host survives.
  const rePaired = broker.pair({ pairingCode: offer.pairingCode });
  assert.notEqual(rePaired.id, sessionId);
});

test('default opaque sessions survive pairing expiry and a year of idle fake-clock time', async () => {
  let now = 1_700_000_000_000;
  const ended = [];
  const broker = new SessionBroker({
    installationId: 'idle-test', instanceId: 'idle-instance', now: () => now,
    onSessionEnded: (sessionId) => ended.push(sessionId)
  });
  const server = new LocalMcpServer({ broker, controller: { getTab: (id) => ({ id }) } });
  const offer = broker.createPairingOffer();
  const initialize = await memoryRpc(server, { 'x-browser-use-pairing-code': offer.pairingCode }, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'idle-host' } }
  });
  assert.ok(initialize.body.result);
  const headers = { 'mcp-session-id': initialize.sessionId };
  await memoryRpc(server, headers, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_bind_tab', arguments: { tabId: 'tab-idle' } }
  });

  for (const elapsed of [5 * 60_000 + 1, 365 * 24 * 60 * 60_000]) {
    now += elapsed;
    broker.pruneExpired();
    // V293: the durable pairing offer stays active across any idle time.
    assert.equal(broker.status().pairing.active, true);
    assert.equal(broker.status().sessions[0].expiresAt, Infinity);
    const response = await memoryRpc(server, headers, {
      jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'browser_get_tab' }
    });
    assert.equal(response.body.error, undefined, 'idle time must not invalidate a retained transport');
    assert.equal(JSON.parse(response.body.result.content[0].text).id, 'tab-idle');
    assert.ok(response.sessionId === initialize.sessionId);
    assert.equal(server.mcpSessions.size, 1);
    assert.equal(ended.length, 0);
    const heartbeat = await memoryRpc(server, headers, { jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.equal(heartbeat.status, 200);
    assert.deepEqual(heartbeat.body, { jsonrpc: '2.0', id: 7, result: {} });
    assert.ok(heartbeat.sessionId === initialize.sessionId, 'idle heartbeat must retain the opaque session');
  }
  // V293: the pairing code is durable — after pairing expiry and a year of
  // idle time, a fresh initialize with the same code still bootstraps (this
  // is exactly the restart-survival contract).
  const expiredBootstrap = await memoryRpc(server, { 'x-browser-use-pairing-code': offer.pairingCode }, {
    jsonrpc: '2.0', id: 4, method: 'initialize'
  });
  assert.equal(expiredBootstrap.status, 200, 'the durable code re-bootstraps after any idle time');
  assert.ok(expiredBootstrap.sessionId);
  const unauthenticated = await memoryRpc(server, {}, { jsonrpc: '2.0', id: 5, method: 'tools/list' });
  assert.equal(unauthenticated.status, 401, 'missing credentials must remain rejected');
  const brokerIdOnly = await memoryRpc(server, { 'mcp-session-id': broker.status().sessions[0].id }, {
    jsonrpc: '2.0', id: 6, method: 'tools/list'
  });
  assert.equal(brokerIdOnly.body.error.code, -32001, 'visible broker metadata must never authorize requests');
});

test('MCP ping returns an empty result only for an authenticated live session', async () => {
  const broker = new SessionBroker({ installationId: 'ping-test', instanceId: 'ping-instance' });
  const server = new LocalMcpServer({ broker, controller: {} });
  const ping = { jsonrpc: '2.0', id: 2, method: 'ping' };
  const offer = broker.createPairingOffer();
  const initialize = await memoryRpc(server, { 'x-browser-use-pairing-code': offer.pairingCode }, {
    jsonrpc: '2.0', id: 1, method: 'initialize'
  });
  assert.ok(initialize.body.result);
  const headers = { 'mcp-session-id': initialize.sessionId };
  const response = await memoryRpc(server, headers, ping);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { jsonrpc: '2.0', id: 2, result: {} });
  assert.ok(response.sessionId === initialize.sessionId, 'ping must retain the same opaque transport');
  assert.equal(broker.status().sessions.length, 1);
  assert.equal(broker.status().sessions[0].tabId, null, 'ping must not select a tab');
  assert.equal(server.mcpSessions.size, 1);

  assert.equal((await memoryRpc(server, {}, ping)).status, 401);
  assert.equal((await memoryRpc(server, { 'mcp-session-id': 'unknown-id' }, ping)).body.error.code, -32001);
  broker.revoke(broker.status().sessions[0].id);
  assert.equal((await memoryRpc(server, headers, ping)).body.error.code, -32001, 'ping must not resurrect a revoked session');
  assert.equal(server.mcpSessions.size, 0);
});

async function memoryRpc(server, headers, body) {
  const response = {
    statusCode: 0,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(text = '') { this.body = text ? JSON.parse(text) : null; }
  };
  await server.handleMcp(body, { headers }, response);
  return { status: response.statusCode, sessionId: response.headers['mcp-session-id'], body: response.body };
}

async function rpc(endpoint, headers, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get('mcp-session-id'),
    body: text ? JSON.parse(text) : null
  };
}

async function postResponse(endpoint, body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
