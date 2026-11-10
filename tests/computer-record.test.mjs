import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { COMPUTER_TOOLS } = require('../desktop/computer/computerCatalog.cjs');
const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');

test('computer_record is offered for coding tasks too (it was filtered out entirely)', () => {
  const defs = toolDefinitions('fix the animation bug in the repo', 'agi', { workspace: 'E:/repo' });
  const record = defs.find((def) => def.name === 'computer_record');
  assert.ok(record, 'coding tasks get the record tool');
  assert.match(record.description, /frames ARE how you review a recording/);
  assert.match(record.description, /5-60/);
  const schema = record.inputSchema?.properties || {};
  assert.deepEqual(schema.action?.enum, ['start', 'status', 'stop', 'frames']);
  assert.match(schema.frames?.description, /1-30/, 'frame count is bounded for context safety');
  assert.match(schema.fps?.description, /5\.\.60/, 'fps 5..60 per the model-choice contract');
  assert.match(schema.fps?.description, /YOUR choice/, 'the model picks fps by task, not a fixed default');
  // catalog COMPUTER_TOOLS themselves carry the schema
  const catalogRecord = COMPUTER_TOOLS.find((tool) => tool.name === 'computer_record');
  assert.ok(catalogRecord);
  assert.match(catalogRecord.description, /action=frames/);
});

test('frames action is classified read-only (batchable with other lookups)', () => {
  // The classifier is embedded in the catalog module; exercise it via its export if present.
  const catalog = require('../desktop/computer/computerCatalog.cjs');
  const classifier = catalog.isReadOnlyComputerAction || catalog.isReadonly || null;
  if (typeof classifier === 'function') {
    assert.equal(classifier('computer_record', { action: 'frames' }), true);
    assert.equal(classifier('computer_record', { action: 'start' }), false);
  } else {
    const src = require('fs').readFileSync(require('path').join(process.cwd(), 'desktop/computer/computerCatalog.cjs'), 'utf8');
    assert.match(src, /\['status', 'frames'\]\.includes\(input\.action\)/, 'frames is batch-eligible like status');
  }
});


test('/notebook opens IMMEDIATELY on an idle app — never queued as a model task', async () => {
  const src = require('fs').readFileSync(require('path').join(process.cwd(), 'desktop/agent/desktopChatAgent.cjs'), 'utf8');
  assert.match(src, /SLASH-FIRST: \/notebook is a UI command/, 'the idle interception exists in start()');
  assert.match(src, /idleRun = \{ id: null/, 'the idle publish uses a stub run, not a live one');
  // The CLI /notebook opens Notepad, not a path dump.
  const tui = require('fs').readFileSync(require('path').join(process.cwd(), 'cli/tui.mjs'), 'utf8');
  assert.match(tui, /spawn\('notepad\.exe', \[file\]/, 'the CLI opens the notebook in Notepad');
});
