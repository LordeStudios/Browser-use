import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');
const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
const { openAiToolSchemas } = require('../desktop/agent/providers/wire.cjs');

async function tempWorkspace() { return fs.mkdtemp(path.join(os.tmpdir(), 'browser-use-fs-batch-')); }

test('computer_fs_batch moves multiple files in one ordered operation with per-op results', async () => {
  const root = await tempWorkspace();
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    await fs.writeFile(path.join(root, 'b.txt'), 'b');
    const tools = new ComputerTools();
    const result = await tools.execute('computer_fs_batch', {
      operations: [
        { action: 'move', path: path.join(root, 'a.txt'), destination: path.join(root, 'a-renamed.txt') },
        { action: 'move', path: path.join(root, 'b.txt'), destination: path.join(root, 'b-renamed.txt') }
      ]
    }, 'test-owner');
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);
    assert.equal(result.results.every((item) => item.ok && item.changed), true);
    assert.equal(result.unexecuted.length, 0);
    assert.equal(await fs.readFile(path.join(root, 'a-renamed.txt'), 'utf8'), 'a');
    assert.equal(await fs.readFile(path.join(root, 'b-renamed.txt'), 'utf8'), 'b');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('computer_fs_batch stops on error and reports the unexecuted tail', async () => {
  const root = await tempWorkspace();
  try {
    await fs.writeFile(path.join(root, 'a.txt'), 'a');
    const tools = new ComputerTools();
    const result = await tools.execute('computer_fs_batch', { operations: [
      { action: 'move', path: path.join(root, 'missing.txt'), destination: path.join(root, 'x.txt') },
      { action: 'move', path: path.join(root, 'a.txt'), destination: path.join(root, 'a-renamed.txt') }
    ] }, 'test-owner');
    assert.equal(result.ok, false);
    assert.equal(result.results.length, 1);
    assert.equal(result.unexecuted.length, 1);
    assert.equal(result.unexecuted[0].path, path.join(root, 'a.txt'));
    assert.equal(await fs.readFile(path.join(root, 'a.txt'), 'utf8'), 'a');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('computer_fs_batch schema is visible to the model as ordered operations', () => {
  const defs = toolDefinitions('move and rename these files', 'agi', {});
  assert.ok(defs.some((tool) => tool.name === 'computer_fs_batch'));
  const schema = openAiToolSchemas(defs).find((tool) => tool.function.name === 'computer_fs_batch').function.parameters;
  assert.equal(schema.properties.operations.type, 'array');
  assert.equal(schema.properties.operations.maxItems, 32);
  assert.deepEqual(schema.properties.operations.items.properties.action.enum, ['mkdir', 'copy', 'move', 'delete']);
});
