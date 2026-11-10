import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { KnowledgeStore } = require('../desktop/knowledge/knowledgeStore.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bu-knowledge-')), 'knowledge.json');
}

test('records, ranks, and bounds recall output', () => {
  const store = new KnowledgeStore({});
  store.record('photoshop retouch', 'recipe', 'Use the healing brush tool (J) with a soft round tip for face blemishes.');
  store.record('gardening', 'fact', 'Tomatoes need six hours of direct sunlight every day.');
  store.record('photoshop retouch', 'pitfall', 'Photoshop brush flow below 20 percent builds color slowly on the face.');
  const recalled = store.recall('clean up a face in photoshop', { limit: 3 });
  assert.equal(recalled.length, 2);
  assert.match(recalled[0].text, /healing brush/);
  assert.equal(store.recall('completely unrelated weather query').length, 0);
});

test('near-duplicate records bump confidence instead of duplicating', () => {
  const store = new KnowledgeStore({});
  const first = store.record('k', 'fact', 'The healing brush removes blemishes from portrait photos cleanly.');
  const hitsBefore = first.hits;
  const second = store.record('k', 'fact', 'The healing brush removes blemishes from portrait photos cleanly!');
  assert.equal(second.id, first.id);
  assert.equal(second.hits, hitsBefore + 1);
  assert.equal(store.recall('healing brush blemishes').length, 1);
});

test('entries survive a reload from disk', () => {
  const file = tmpFile();
  const first = new KnowledgeStore({ file });
  first.record('drawing', 'recipe', 'Draw the outline first, then fill with a soft brush.');
  const second = new KnowledgeStore({ file });
  const recalled = second.recall('how to draw and fill');
  assert.equal(recalled.length, 1);
  assert.match(recalled[0].text, /outline first/);
});

test('a corrupt store file is replaced, never fatal', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json at all');
  const store = new KnowledgeStore({ file });
  assert.deepEqual(store.recall('anything'), []);
  assert.doesNotThrow(() => store.record('k', 'fact', 'Recovered after corruption.'));
  assert.equal(new KnowledgeStore({ file }).recall('corruption').length, 1);
});

test('caps evict the weakest entries', () => {
  const store = new KnowledgeStore({ maxTotal: 3 });
  store.record('a', 'fact', 'Alpha entry about painting walls with rollers.');
  store.record('b', 'fact', 'Beta entry about painting fences with spray.');
  store.record('c', 'fact', 'Gamma entry about painting ceilings with pads.');
  store.record('d', 'fact', 'Delta entry about painting floors with cloths.');
  assert.equal(store.entries.length, 3);
  assert.equal(store.entries.some(entry => entry.text.startsWith('Alpha')), false, 'oldest weakest dropped first');
});

test('verified entries outrank unverified ones', () => {
  const store = new KnowledgeStore({});
  const weak = store.record('k', 'fact', 'Shortcut idea for the eraser tool panel.');
  const strong = store.record('k', 'recipe', 'Eraser panel opens with the E key and options live in the top bar.');
  store.confirm(strong.id);
  const recalled = store.recall('eraser tool panel shortcut');
  assert.equal(recalled[0].id, strong.id);
  assert.equal(weak.verified, false);
});

test('the agent injects prior knowledge once before the first decision', async () => {
  const controller = {
    calls: [],
    async domSnapshot() {
      return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; }
  };
  const received = [];
  const storeCalls = [];
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    knowledgeStore: {
      recall: (query) => { storeCalls.push(query); return [{ kind: 'recipe', verified: true, text: 'Photoshop healing brush lives on the J key.' }]; },
      record: () => {}
    },
    createProvider: () => ({
      async complete(context) {
        received.push(context.messages);
        return { done: { summary: 'Used memory.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Clean up the face', provider: { id: 'mock' } });
  assert.equal(storeCalls.length, 1);
  assert.match(storeCalls[0], /Clean up the face/);
  assert.equal(received.length, 1);
  const injected = received[0].filter(message => /Prior knowledge for this task/.test(message.content));
  assert.equal(injected.length, 1);
  assert.match(injected[0].content, /healing brush lives on the J key/);
  assert.equal(run.messages.filter(message => /Prior knowledge for this task/.test(message.content)).length, 1);
});

test('research findings are written back into the store as unverified facts', async () => {
  const controller = {
    calls: [],
    async domSnapshot() {
      return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; }
  };
  const recorded = [];
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    researchRunner: async () => ({ ok: true, tookMs: 3, sources: [{ title: 'a' }, { title: 'b' }], findings: 'Web research (advisory):\nSources:\n [1] Guide — https://docs.test/x' }),
    knowledgeStore: { record: (key, kind, text, meta) => recorded.push({ key, kind, text, meta }), recall: () => [] },
    createProvider: () => ({ async complete() {
      calls += 1;
      // The model decides to research on the first decision, then completes.
      if (calls === 1) return { actions: [{ name: 'research_task', input: { objective: 'retouch this photo with the editor tools' } }] };
      return { done: { summary: 'Done.', success: true, verified: true } };
    } })
  });
  await agent.start({ task: 'Retouch this photo with the editor tools', provider: { id: 'mock' } });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].kind, 'fact');
  assert.equal(recorded[0].meta.source, 'research');
  assert.match(recorded[0].text, /docs\.test/);
});

test('a throwing knowledge store never breaks or delays a run', async () => {
  const controller = {
    calls: [],
    async domSnapshot() {
      return { url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false };
    },
    navigationState() { return { url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    releaseSessionInput() { return { released: true }; }
  };
  let decisions = 0;
  const agent = new DesktopChatAgent({
    controller,
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    knowledgeStore: { recall: () => { throw new Error('store exploded'); }, record: () => { throw new Error('store exploded'); } },
    createProvider: () => ({
      async complete() {
        decisions += 1;
        return { done: { summary: 'Unaffected.', success: true, verified: true } };
      }
    })
  });
  const run = await agent.start({ task: 'Complete despite broken memory', provider: { id: 'mock' } });
  assert.equal(run.status, 'completed');
  assert.equal(decisions, 1);
  assert.equal(run.result.summary, 'Unaffected.');
});

test('generic-verb overlap cannot recall another task\'s notes', () => {
  const store = new KnowledgeStore({});
  store.record('open the calculator windows app and compute 20*40', 'fact', 'Calculator research summary about unrelated homepages.');
  // A Paint task shares only generic verbs with the Calculator task — this
  // exact cross-talk surfaced calculator research during a Paint run (live).
  assert.equal(store.recall('open windows paint and draw circles using pencil').length, 0);
  // The same task still recalls its own note strongly.
  const same = store.recall('open the calculator windows app and compute 20*40');
  assert.equal(same.length, 1);
});

test('prune removes poisoned entries by source or key', () => {
  const store = new KnowledgeStore({});
  store.record('topic alpha', 'fact', 'Alpha entry about widgets and gizmos.', { source: 'research' });
  store.record('topic beta', 'recipe', 'Beta recipe about painting walls evenly.', { source: 'execution' });
  assert.equal(store.prune({ source: 'research' }), 1);
  assert.equal(store.entries.length, 1);
  assert.equal(store.prune({ key: store.entries[0].key }), 1);
  assert.equal(store.entries.length, 0);
});
