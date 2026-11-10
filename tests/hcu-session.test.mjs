import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  HcuSession,
  hcuEnabled,
  hcuToolName,
  parseHcuToolName,
  normalizeHcuTools,
  normalizeHcuResult
} = require('../desktop/agent/hcuSession.cjs');

test('HCU is opt-in and exposes only AX and GUI', () => {
  assert.equal(hcuEnabled({ BROWSER_USE_HCU: 'off' }), false);
  assert.equal(hcuEnabled({ BROWSER_USE_HCU: 'on' }), true);
  const tools = normalizeHcuTools([
    { name: 'AX', description: 'accessibility', inputSchema: { type: 'object' } },
    { name: 'GUI', description: 'visual', inputSchema: { type: 'object' } },
    { name: 'other', description: 'must not be exposed' }
  ]);
  assert.deepEqual(tools.map(tool => tool.name), ['mcp__hcu__AX', 'mcp__hcu__GUI']);
  assert.equal(hcuToolName('AX'), 'mcp__hcu__AX');
  assert.equal(parseHcuToolName('mcp__hcu__GUI'), 'GUI');
  assert.equal(parseHcuToolName('mcp__hcu__other'), null);
});

test('disabled HCU does not touch the filesystem or spawn a process', async () => {
  const session = new HcuSession({ env: { BROWSER_USE_HCU: 'off', BROWSER_USE_HCU_PATH: 'C:/does-not-exist.exe' } });
  assert.deepEqual(await session.ensure(), []);
  assert.equal(session.status().enabled, false);
});

test('HCU MCP results preserve text, structured content, and images', () => {
  const result = normalizeHcuResult({
    isError: false,
    content: [
      { type: 'text', text: '{"ok":true}' },
      { type: 'image', mimeType: 'image/png', data: 'cG5n' }
    ],
    structuredContent: { ok: true }
  }, 'AX');
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'AX');
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.structuredContent, { ok: true });
  assert.equal(result.images[0].mimeType, 'image/png');
});
