// console-evidence-hierarchy.test.mjs — node --test tests/console-evidence-hierarchy.test.mjs
//
// Owner directive: console/network output is DIAGNOSTICS, never page-state
// evidence. The wire used to carry info-level console chatter and EVERY
// completed request unframed on every decision, and the model read that
// traffic as page state ("the page is still loading" for minutes while
// navigation.loading was false). The contract now:
//   - successful requests and info logs NEVER ride the wire,
//   - console/network errors ride ONLY under `diagnostics` with a binding
//     framing note, capped and trimmed,
//   - the tool descriptions and the AGI prompt carry the same contract
//     (prompt + enforcement, per the campaign law that prose alone gets
//     ignored).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');
const { agiPromptForTask } = require('../desktop/computer/computerCatalog.cjs');

function contextObservation({ consoleEntries = [], networkEntries = [], loading = false } = {}) {
  return {
    navigation: { url: 'https://example.test/app', loading },
    dom: { url: 'https://example.test/app', title: 'App', elements: [{ index: 1, tag: 'button', label: 'Save' }] },
    consoleEntries,
    networkEntries
  };
}

test('info console chatter and successful requests NEVER reach the wire', () => {
  const context = boundedRequestContext({
    task: 'check the page',
    observation: contextObservation({
      consoleEntries: [
        { kind: 'console', level: 'info', message: 'Loading chunk 4...', url: 'https://cdn.test/x.js' },
        { kind: 'console', level: 'warning', message: 'React DevTools suggestion', url: 'https://example.test/app' }
      ],
      networkEntries: [
        { kind: 'network', level: 'info', message: 'GET 200', url: 'https://api.test/items', statusCode: 200 },
        { kind: 'network', level: 'info', message: 'GET 200', url: 'https://api.test/config', statusCode: 200 }
      ]
    })
  });
  const observation = context.observation;
  assert.equal(observation.consoleEntries, undefined, 'raw consoleEntries key is gone from the wire');
  assert.equal(observation.networkEntries, undefined, 'raw networkEntries key is gone from the wire');
  assert.equal(observation.diagnostics, undefined, 'no diagnostics block when nothing is actionable — silence IS the signal');
  assert.equal(observation.dom.elements.length, 1, 'dom passthrough untouched');
  assert.equal(observation.navigation.loading, false);
});

test('console/network errors ride only under diagnostics, framed and bounded', () => {
  const errors = Array.from({ length: 9 }, (_, i) => ({
    kind: 'error', level: 'error', message: `boom ${i} — ${'x'.repeat(500)}`, url: `https://cdn.test/lib-${i}.js`
  }));
  const context = boundedRequestContext({
    task: 'check the page',
    observation: contextObservation({
      consoleEntries: errors,
      networkEntries: [
        { kind: 'network', level: 'error', message: 'net::ERR_CONNECTION_REFUSED (-101)', url: 'https://api.test/items' },
        { kind: 'network', level: 'info', message: 'GET 500', url: 'https://api.test/broken', statusCode: 500 }
      ]
    })
  });
  const diagnostics = context.observation.diagnostics;
  assert.ok(diagnostics, 'actionable errors surface as diagnostics');
  assert.match(diagnostics.note, /DEBUGGING aids only/);
  assert.match(diagnostics.note, /NEVER evidence of what the page shows/);
  assert.match(diagnostics.note, /navigation\.loading/);
  assert.equal(diagnostics.consoleErrors.length, 5, 'console errors capped at 5');
  for (const entry of diagnostics.consoleErrors) assert.ok(entry.message.length <= 300, 'messages trimmed');
  assert.equal(diagnostics.networkErrors.length, 2, 'failed + 5xx requests kept, 2xx dropped');
  assert.equal(context.observation.consoleEntries, undefined);
});

test('the tool catalog carries the diagnostics-only contract', () => {
  const { toolDefinitions } = require('../desktop/agent/desktopChatAgent.cjs');
  const byName = new Map(toolDefinitions().map((tool) => [tool.name, tool]));
  const consoleDesc = String(byName.get('browser_console_entries')?.description || '');
  const networkDesc = String(byName.get('browser_network_entries')?.description || '');
  assert.match(consoleDesc, /DIAGNOSTICS ONLY/);
  assert.match(consoleDesc, /Never evidence of what the page shows/);
  assert.match(networkDesc, /DIAGNOSTICS ONLY/);
  assert.match(networkDesc, /never proves page state/);
});

test('the AGI prompt carries the console clause WITHOUT breaking the lean-core cap', () => {
  const prompt = agiPromptForTask('do the thing', { root: 'E:/repo', target: 'E:/repo', url: null }, null);
  // One compact sentence — the campaign-banked lean core stays under its
  // 6400 cap (the full contract lives in the tool descriptions + the wire
  // diagnostics filter, never as another prompt wall).
  assert.match(prompt, /never\s*\n?page-state evidence|Console\/network output is for debugging/);
  assert.ok(prompt.length < 6400, `lean core cap holds (got ${prompt.length})`);
});
