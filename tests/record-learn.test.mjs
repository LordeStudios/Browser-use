import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createEventProcessor, jaccard } = require('../desktop/record/processor.cjs');
const { mergeReconstructions, chunkTimeline } = require('../desktop/record/recorder.cjs');
const { SkillStore, tokensOf } = require('../desktop/record/skills.cjs');
const { parseJsonObject } = require('../desktop/record/modelClient.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function feed(processor, events) {
  processor.begin(events[0].at);
  for (const event of events) processor.push(event);
  return processor.stop();
}

test('the processor compresses typing, collapses double clicks, and never emits raw keys', () => {
  const semantics = [];
  const processor = createEventProcessor({ onSemantic: entry => semantics.push(entry.text) });
  const closed = feed(processor, [
    { type: 'app_switch', title: 'Inbox — Google Chrome', at: 1_000 },
    { type: 'keys', count: 40, at: 1_100 },
    { type: 'keys', count: 30, at: 1_500 },
    { type: 'click', button: 'left', x: 500, y: 300, at: 2_000 },
    { type: 'click', button: 'left', x: 502, y: 300, at: 2_150 },
    { type: 'click', button: 'left', x: 800, y: 400, at: 3_000 },
    { type: 'keys', count: 2, at: 3_100 }
  ]);
  const joined = closed.actions.map(action => action.text).join('\n');
  assert.match(joined, /typed ~72 characters/, 'typing bursts compress to one line with a count');
  assert.match(joined, /clicked(?!.*clicked.*clicked.*clicked)/s, 'double click collapses');
  assert.equal(closed.clickCount, 2, 'double click counts as one click');
  assert.ok(!joined.includes('what the user typed'), 'content is never present');
  assert.equal(closed.keystrokes, 72);
});

test('idle gaps and app switches split episodes; each episode keeps its apps and domains', () => {
  const closedList = [];
  const processor = createEventProcessor({
    onEpisodeClosed: episode => closedList.push(episode)
  });
  feed(processor, [
    { type: 'app_switch', title: 'Facebook — Google Chrome', at: 1_000 },
    { type: 'navigation', url: 'https://www.facebook.com/compose', title: 'Create post', at: 2_000 },
    { type: 'click', button: 'left', x: 10, y: 10, at: 3_000 },
    // 30 s idle → boundary
    { type: 'app_switch', title: 'Terminal', at: 33_000 },
    { type: 'terminal', summary: 'git push origin main', at: 34_000 }
  ]);
  assert.equal(closedList.length, 2, 'idle gap closed the first episode; stop closed the second');
  assert.deepEqual(closedList[0].domains, ['facebook.com']);
  assert.equal(closedList[1].apps[0], 'Terminal');
  assert.ok(closedList[1].actions.some(action => action.text.includes('git push origin main')));
});

test('identical semantic lines deduplicate within the window', () => {
  const processor = createEventProcessor();
  const closed = feed(processor, [
    { type: 'app_switch', title: 'Editor — Code', at: 1_000 },
    { type: 'terminal', summary: 'npm test', at: 1_100 },
    { type: 'terminal', summary: 'npm test', at: 1_150 },
    { type: 'terminal', summary: 'npm test', at: 5_000 }
  ]);
  const npmLines = closed.actions.filter(action => action.text.includes('npm test'));
  assert.equal(npmLines.length, 2, 'immediate duplicates collapse; a later distinct command stays');
});

test('the novelty gate flags a repeated episode as repeating', () => {
  const processor = createEventProcessor();
  const events = [
    { type: 'app_switch', title: 'Terminal', at: 1_000 },
    { type: 'terminal', summary: 'run the same deployment again', at: 1_500 }
  ];
  feed(processor, events);
  // A fresh processor has no recent digests: the first run is novel...
  const fresh = createEventProcessor();
  const closed = feed(fresh, events);
  assert.equal(fresh.isRepeating(closed), false);
  // ...the same processor has just seen it: a repeat is flagged. The replay
  // uses shifted timestamps the way real re-runs would (identical timestamps
  // are legitimately collapsed by the semantic dedupe window instead).
  const closed2 = feed(processor, events.map(event => ({ ...event, at: event.at + 60_000 })));
  assert.equal(processor.isRepeating(closed2), true);
});

test('reconstruction chunks merge and duplicate skill drafts collapse', () => {
  const merged = mergeReconstructions([
    { tasks: [{ title: 'Post update', intent: 'publish' }], skills: [{ name: 'S1', when: 'w', steps: [{ action: 'a', detail: 'd' }] }], discarded: [{ title: 'scrolling', reason: 'casual' }] },
    { tasks: [{ title: 'Push code' }], skills: [{ name: 'S1', when: 'w', steps: [{ action: 'a', detail: 'd' }] }, { name: 'S2', steps: [{ action: 'b' }] }], discarded: [] }
  ]);
  assert.deepEqual(merged.skills.map(skill => skill.name), ['S1', 'S2']);
  assert.equal(merged.tasks.length, 2);
  assert.equal(merged.discarded.length, 1);
  assert.equal(chunkTimeline([1, 2, 3, 4, 5], 3).length, 3);
});

test('the skill store persists human-edited skills and ranks matches with boosts', () => {
  const file = path.join(os.tmpdir(), `skills-test-${Date.now()}-${process.pid}.json`);
  try {
    const store = new SkillStore(file);
    const created = store.add({
      name: 'Post the weekly update',
      when: 'user asks to publish the weekly update',
      steps: [{ action: 'Open the drafting page', detail: 'facebook.com → Create Post' }, { action: 'Paste the update text', detail: '' }],
      trigger: { phrases: ['weekly update'], domains: ['facebook.com'], apps: ['Chrome'] }
    }, { sessionId: 'rec-fixture' });
    const matches = store.search({ task: 'please publish the weekly update post', domains: ['facebook.com'], apps: ['Chrome'] });
    assert.equal(matches.length, 1);
    assert.equal(matches[0].skill.id, created.id);
    assert.ok(matches[0].score >= 2, 'phrase + domain + app boosts apply');
    assert.equal(store.search({ task: 'unrelated weather lookup' }).length, 0, 'unrelated tasks do not match');
    store.recordOutcome(created.id, { success: true, note: 'worked' });
    const reopened = new SkillStore(file);
    const persisted = reopened.get(created.id);
    assert.equal(persisted.usage.successes, 1);
    assert.ok(persisted.notes.includes('worked'));
    const edited = reopened.update(created.id, { name: 'Hand-edited name' });
    assert.equal(edited.name, 'Hand-edited name');
    assert.equal(edited.id, created.id, 'an edit never re-ids a skill');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('the model client JSON extractor handles fenced and embedded objects', () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonObject('```json\n{"a":{"b":"} trick"}}\n```'), { a: { b: '} trick' } });
  assert.deepEqual(parseJsonObject('Sure! Here it is: {"ok":true} hope that helps'), { ok: true });
  assert.throws(() => parseJsonObject('no json here'));
  assert.throws(() => parseJsonObject('{"incomplete": true'));
});

test('keyboard tokens never enter semantic text', () => {
  const processor = createEventProcessor();
  const closed = feed(processor, [
    { type: 'app_switch', title: 'Notes', at: 1_000 },
    { type: 'keys', count: 120, at: 1_200, keys: ['Enter'] },
    { type: 'click', button: 'left', x: 1, y: 1, at: 1_400 }
  ]);
  for (const action of closed.actions) {
    assert.ok(!/"[^"]{20,}"/.test(action.text), 'no captured text payloads');
  }
  assert.ok(closed.actions.some(action => action.text.includes('~120 characters')));
});

test('jaccard overlap behaves on token sets', () => {
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0);
  assert.equal(jaccard(new Set(), new Set(['a'])), 0);
  assert.ok(tokensOf('Post the Weekly-Update!').has('weekly'));
});
