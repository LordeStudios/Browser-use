import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createCliModelTaskApi, createCliCatalogApi } = require('../cli/cliAgentApis.cjs');

test('cli modelTaskApi: imagePath reads the file harness-side; result carries savedPath, no base64 echo', async () => {
  const captured = [];
  const fsLikeWrites = [];
  const api = createCliModelTaskApi({
    baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'img-model',
    fetchImpl: async (url, options) => {
      captured.push({ url, options });
      const payload = JSON.stringify({ data: [{ url: 'https://cdn.example/out.png' }] });
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://cdn.example/out.png' }] }), text: async () => payload, arrayBuffer: async () => Buffer.from('PNGDATA') };
    }
  });
  // imagePath with a real tiny file in temp
  const os = require('os');
  const src = path.join(os.tmpdir(), `bu-cli-probe-${Date.now()}.png`);
  require('fs').writeFileSync(src, Buffer.from('89504e47', 'hex'));
  const out = await api({ kind: 'image', imagePath: src, prompt: 'upscale', saveTo: path.join(os.tmpdir(), `bu-cli-out-${Date.now()}.png`) });
  assert.equal(out.ok, true);
  assert.equal(captured[0].options.body instanceof FormData, true, 'the image part rides multipart, not JSON');
  assert.match(captured[0].url, /images\/edits$/, 'image edit rides the multipart-capable route');
  assert.equal(out.savedPath ? require('fs').existsSync(out.savedPath) : false, true, 'saveTo landed a real file');
  assert.equal(JSON.stringify(out).includes('89504e47'), false, 'no raw bytes in the outcome');
  require('fs').rmSync(src, { force: true });
  if (out.savedPath) require('fs').rmSync(out.savedPath, { force: true });
});

test('cli catalogApi: live discovery, two modes, probe:true merges conclusive results', async () => {
  const rich = { data: [
    { id: 'a-model', display_name: 'A Model', pricing: { input: 1, output: 2 }, capabilities: { vision: true }, context_length: 100000 },
    { id: 'b-model', display_name: 'B Model', pricing: { input: 0, output: 0 }, capabilities: {}, context_length: 50000 }
  ] };
  const probeCalls = [];
  const api = createCliCatalogApi({
    baseUrl: 'https://gw.example/v1', apiKey: 'k', model: 'a-model', providerId: 'xkiro-like', fetchImpl: async (url, options) => {
      if (url.endsWith('/models')) return { ok: true, status: 200, json: async () => rich };
      probeCalls.push(JSON.parse(options.body).model);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'y' } }] }) };
    }
  });
  const summary = await api({});
  assert.equal(summary.mode, 'summary');
  assert.equal(summary.connections[0].modelsCount, 2);
  assert.deepEqual(summary.connections[0].byCap, { vision: 1 });
  const probed = await api({ cap: 'video-input', probe: true });
  assert.equal(probed.mode, 'filtered');
  assert.ok(probeCalls.length >= 1, 'probe:true live-probes through the CLI connection');
  assert.ok(probed.probe && probed.probe.probed >= 1);
  assert.ok(probed.models.some((m) => m.capsSource === 'live-probe'), 'conclusive probes merge with a source tag');
  // No probe without probe:true — the ladder's rung 3 is deliberate.
  probeCalls.length = 0;
  await api({ cap: 'video-input' });
  assert.equal(probeCalls.length, 0);
});

const path = require('node:path');

test('mediaRouter async budgets: image/video poll up to 15 minutes, language unchanged', async () => {
  const { effectiveBudgets } = require('../desktop/agent/mediaRouter.cjs');
  assert.deepEqual(effectiveBudgets('image', { timeoutMs: 180_000, pollTimeoutMs: 240_000 }), { timeoutMs: 300_000, pollTimeoutMs: 900_000 }, 'gpt-image-2.5 renders for minutes — the old 240s ceiling failed healthy jobs');
  assert.deepEqual(effectiveBudgets('video', {}), { timeoutMs: 300_000, pollTimeoutMs: 900_000 });
  assert.deepEqual(effectiveBudgets('language', { timeoutMs: 60_000, pollTimeoutMs: 5_000 }), { timeoutMs: 60_000, pollTimeoutMs: 5_000 }, 'language budgets stay caller-controlled');
});

test('tool.progress heartbeat exists at the decision-loop tool site', () => {
  const src = require('fs').readFileSync(require('path').join(process.cwd(), 'desktop/agent/desktopChatAgent.cjs'), 'utf8');
  assert.match(src, /publish\('tool\.progress', run, \{ tool: call\.name, elapsedMs/);
  assert.match(src, /clearInterval\(heartbeat\)/, 'the heartbeat never leaks past the tool call');
});
