// The desktop agent could always answer OS file pickers, redirect downloads,
// write files and wait out a long job. The MCP surface could do none of the
// four, so an MCP client that reached a picker stalled at the one step only the
// native agent could finish. These tests pin the contract of the tools that
// closed that gap: they must be discoverable, they must reject a destructive or
// meaningless call BEFORE the tab gate, and they must route to the controller
// method that already implements the behaviour.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LocalMcpServer } = require('../desktop/mcp/localMcpServer.cjs');
const { SessionBroker } = require('../desktop/mcp/sessionBroker.cjs');

function createServer({ bind = true, controller = {} } = {}) {
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

function text(result) {
  return String(result?.content?.[0]?.text || '');
}

const NEW_TOOLS = [
  'browser_file_dialog_arm',
  'browser_file_dialog_state',
  'browser_file_dialog_accept',
  'browser_file_dialog_cancel',
  'browser_downloads_set_path',
  'browser_downloads_list',
  'browser_save_file',
  'browser_extract',
  'browser_wait'
];

test('every gap tool is advertised exactly once with a usable schema', async () => {
  const { server, capability } = createServer();
  const listed = await server.dispatch({ method: 'tools/list' }, capability);
  const tools = listed.tools;
  const names = tools.map((tool) => tool.name);
  for (const name of NEW_TOOLS) {
    assert.equal(names.filter((entry) => entry === name).length, 1, `${name} must be advertised exactly once`);
  }
  for (const name of NEW_TOOLS) {
    const tool = tools.find((entry) => entry.name === name);
    assert.ok(tool.description && tool.description.length > 40, `${name} needs a description a model can act on`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('an empty file selection is refused before the tab gate', async () => {
  const { server, capability } = createServer({ bind: false, controller: {} });
  for (const files of [undefined, [], [''], [42]]) {
    const result = await call(server, capability, 'browser_file_dialog_accept', { files });
    assert.equal(result.isError, true, `${JSON.stringify(files)} must be refused`);
    assert.match(text(result), /non-empty array of absolute paths|non-empty absolute path/i);
    assert.doesNotMatch(text(result), /Bind a desktop tab/i, 'argument errors must not be blamed on a missing tab');
  }
});

test('file dialog accept routes the real paths to the controller', async () => {
  const seen = [];
  const { server, capability } = createServer({
    controller: {
      fileDialogArm: async (tabId) => ({ tabId, armed: true }),
      fileDialogState: async (tabId) => ({ tabId, open: true, mode: 'open', multiple: false }),
      fileDialogAccept: async (tabId, args) => { seen.push([tabId, args]); return { tabId, accepted: args.files.length }; },
      fileDialogCancel: async (tabId) => ({ tabId, cancelled: true })
    }
  });

  const armed = await call(server, capability, 'browser_file_dialog_arm', {});
  assert.equal(JSON.parse(text(armed)).armed, true);

  const state = await call(server, capability, 'browser_file_dialog_state', {});
  assert.equal(JSON.parse(text(state)).mode, 'open');

  const accepted = await call(server, capability, 'browser_file_dialog_accept', {
    files: ['C:/tmp/report.pdf'], selector: '#upload'
  });
  assert.equal(JSON.parse(text(accepted)).accepted, 1);
  assert.deepEqual(seen[0], ['tab-1', { files: ['C:/tmp/report.pdf'], selector: '#upload' }]);

  const cancelled = await call(server, capability, 'browser_file_dialog_cancel', {});
  assert.equal(JSON.parse(text(cancelled)).cancelled, true);
});

test('a download destination and the download list are both reachable', async () => {
  const calls = [];
  const { server, capability } = createServer({
    controller: {
      downloadsSetPath: async (tabId, args) => { calls.push(['set', tabId, args]); return { tabId, directory: args.directory }; },
      downloadsList: () => { calls.push(['list']); return { downloads: [{ filename: 'a.pdf', state: 'completed', bytes: 10 }] }; }
    }
  });

  const set = await call(server, capability, 'browser_downloads_set_path', { directory: 'C:/tmp/downloads' });
  assert.equal(JSON.parse(text(set)).directory, 'C:/tmp/downloads');
  assert.deepEqual(calls[0], ['set', 'tab-1', { directory: 'C:/tmp/downloads' }]);

  const list = await call(server, capability, 'browser_downloads_list', {});
  assert.equal(JSON.parse(text(list)).downloads[0].state, 'completed');
});

test('browser_save_file refuses to truncate a file to nothing', async () => {
  const { server, capability } = createServer({ bind: false, controller: { saveFileToDisk: () => ({ ok: true }) } });
  for (const args of [{}, { path: 'C:/tmp/x.txt' }, { text: 'hello' }, { path: 'C:/tmp/x.txt', text: 'a', base64: 'YQ==' }]) {
    const result = await call(server, capability, 'browser_save_file', args);
    assert.equal(result.isError, true, `${JSON.stringify(args)} must be refused`);
  }
});

test('browser_save_file writes text or base64 through the controller', async () => {
  const seen = [];
  const { server, capability } = createServer({
    bind: false,
    controller: { saveFileToDisk: (args) => { seen.push(args); return { path: args.path, bytes: 5 }; } }
  });

  const written = await call(server, capability, 'browser_save_file', { path: 'C:/tmp/notes.txt', text: 'hello' });
  assert.equal(JSON.parse(text(written)).bytes, 5);
  assert.deepEqual(seen[0], { path: 'C:/tmp/notes.txt', text: 'hello' });

  await call(server, capability, 'browser_save_file', { path: 'C:/tmp/bytes.bin', base64: 'AAEC' });
  assert.equal(seen[1].base64, 'AAEC');
});

test('browser_extract reads content, not just controls', async () => {
  let received = null;
  const { server, capability } = createServer({
    controller: {
      queryElements: async (tabId, args) => { received = [tabId, args]; return { elements: [{ text: 'Hello' }] }; }
    }
  });

  const result = await call(server, capability, 'browser_extract', { text: 'hello', maxElements: 900 });
  assert.equal(JSON.parse(text(result)).elements[0].text, 'Hello');
  assert.equal(received[0], 'tab-1');
  assert.equal(received[1].interactiveOnly, false, 'extract must not filter to interactive controls');
  assert.equal(received[1].includeText, true);
  assert.equal(received[1].maxElements, 250, 'the ceiling is enforced, not trusted');
  assert.equal(received[1].text, 'hello');
});

test('browser_wait rejects a non-positive or over-long wait before the tab gate', async () => {
  const { server, capability } = createServer({ bind: false, controller: {} });
  for (const ms of [undefined, 0, -5, 'soon', 900_001]) {
    const result = await call(server, capability, 'browser_wait', { ms });
    assert.equal(result.isError, true, `${JSON.stringify(ms)} must be refused`);
    assert.match(text(result), /positive ms|at most/i);
    assert.doesNotMatch(text(result), /Bind a desktop tab/i);
  }
});

test('browser_wait returns as soon as the page stops loading', async () => {
  let reads = 0;
  const { server, capability } = createServer({
    controller: {
      navigationState: async (tabId) => ({ tabId, loading: ++reads === 1 })
    }
  });

  const startedAt = Date.now();
  const result = await call(server, capability, 'browser_wait', { ms: 5_000 });
  const parsed = JSON.parse(text(result));
  assert.equal(parsed.settled, true);
  assert.equal(parsed.requestedMs, 5_000);
  assert.ok(Date.now() - startedAt < 1_500, 'a settled page must not hold the call for the full wait');
});

test('browser_wait reports an unsettled page honestly instead of claiming success', async () => {
  const { server, capability } = createServer({
    controller: { navigationState: async (tabId) => ({ tabId, loading: true }) }
  });

  const result = await call(server, capability, 'browser_wait', { ms: 120 });
  const parsed = JSON.parse(text(result));
  assert.equal(parsed.settled, false);
  assert.equal(parsed.stillLoading, true);
  assert.ok(parsed.waitedMs >= 100, 'it must actually wait the requested time');
  assert.ok(parsed.waitedMs < 1_000, 'and not overshoot it');
});

test('a wait on an idle page still sleeps for the requested time', async () => {
  const { server, capability } = createServer({
    controller: { navigationState: async (tabId) => ({ tabId, loading: false }) }
  });

  const startedAt = Date.now();
  const result = await call(server, capability, 'browser_wait', { ms: 150 });
  const parsed = JSON.parse(text(result));
  assert.equal(parsed.settled, true);
  assert.ok(Date.now() - startedAt >= 140, 'an idle page must still honour the wait');
});
