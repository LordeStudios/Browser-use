// Agent lanes: the history window is tabbed per agent, and every rule that
// decides which tab a task belongs to lives in one pure module. These tests
// pin the rules the UI depends on, including the two that are easy to get
// wrong and impossible to see: a subagent row must wear its own NAME and must
// nest under the task that spawned it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
require('../desktop/renderer/agentLanes.js');
const Lanes = globalThis.AgentLanes;

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test('lanes are exactly the three agent slots, and unknown values fall back to the first', () => {
  assert.deepEqual(Lanes.LANES, ['agent1', 'agent2', 'agent3']);
  assert.equal(Lanes.normalizeLane('AGENT2'), 'agent2');
  assert.equal(Lanes.normalizeLane(' agent3 '), 'agent3');
  assert.equal(Lanes.normalizeLane('mary'), null, 'a subagent alias is not a lane');
  assert.equal(Lanes.normalizeLane(undefined), null);
  assert.equal(Lanes.laneLabel('agent2'), 'Chat 2');
  assert.equal(Lanes.laneLabel('nonsense'), 'Chat 1');
});

test('finished tasks read as a compact age: 20min, 1h, 10h, 2d, 1m', () => {
  assert.equal(Lanes.formatElapsed(20 * MIN), '20min');
  assert.equal(Lanes.formatElapsed(HOUR), '1h');
  assert.equal(Lanes.formatElapsed(10 * HOUR), '10h');
  assert.equal(Lanes.formatElapsed(2 * DAY), '2d');
  assert.equal(Lanes.formatElapsed(35 * DAY), '1m');
  assert.equal(Lanes.formatElapsed(5_000), 'now');
  assert.equal(Lanes.formatElapsed(-1), '', 'a clock that went backwards says nothing');
});

test('a live task reports what it is doing; a finished one reports when it stopped', () => {
  assert.equal(Lanes.rowMeta({ active: true, status: 'running', step: 4 }, NOW), 'running · step 4');
  assert.equal(Lanes.rowMeta({ active: true, status: 'awaiting_approval' }, NOW), 'waiting for approval');
  assert.equal(Lanes.rowMeta({ active: false, status: 'completed', finishedAt: NOW - 20 * MIN }, NOW), '20min');
  assert.equal(Lanes.rowMeta({ active: false, status: 'failed', finishedAt: NOW - HOUR }, NOW), 'failed · 1h');
});

test('every task lands in the tab of the agent that owns it', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [
      { id: 'a', title: 'Agent one task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - MIN },
      { id: 'b', title: 'Agent two task', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - 2 * MIN },
      { id: 'c', title: 'Agent three task', status: 'completed', agentIdentity: 'agent3', updatedAt: NOW - 3 * MIN }
    ]
  });
  assert.deepEqual(model.lanes.map((lane) => lane.rows.map((row) => row.id)), [['a'], ['b'], ['c']]);
  // A record written before lanes existed belongs to the first agent.
  const legacy = Lanes.buildHistoryModel({ now: NOW, conversations: [{ id: 'old', title: 'Legacy', status: 'completed', updatedAt: NOW }] });
  assert.deepEqual(legacy.lanes[0].rows.map((row) => row.id), ['old']);
});

test('a subagent row carries its own name and nests under its parent task', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [
      { id: 'parent', title: 'Research the market', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - 5 * MIN },
      { id: 'child', title: 'Collected pricing pages', status: 'completed', agentIdentity: 'agent2', subagentAlias: 'Mary', parentRunId: 'parent', updatedAt: NOW - 3 * MIN }
    ]
  });
  const rows = model.laneFor('agent2').rows;
  assert.deepEqual(rows.map((row) => row.id), ['parent', 'child'], 'the child follows its parent');
  assert.equal(rows[1].kind, 'subagent');
  assert.equal(rows[1].alias, 'Mary', 'the row must be labelled with the subagent name');
  assert.equal(rows[1].depth, 1, 'and indented under the parent');
  assert.equal(rows[0].alias, '', 'a normal task has no subagent chip');
});

test('an orphaned subagent still appears, labelled, instead of vanishing', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'child', title: 'Orphan work', status: 'completed', agentIdentity: 'agent1', subagentAlias: 'Kai', parentRunId: 'gone', updatedAt: NOW }]
  });
  const rows = model.laneFor('agent1').rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].alias, 'Kai');
});

test('a live session is the same run as its saved record: it appears once, as live', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'r1', title: 'Book a table', status: 'running', agentIdentity: 'agent1', updatedAt: NOW - MIN }],
    liveSessions: [{ id: 'r1', title: 'Book a table', status: 'running', step: 3, agentIdentity: 'agent1' }]
  });
  const rows = model.laneFor('agent1').rows;
  assert.equal(rows.length, 1, 'one row per run, never two');
  assert.equal(rows[0].source, 'live');
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].step, 3);
});

test('live subagents belong to their parent agent and are deduped against their own record', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    liveSessions: [{ id: 'r1', title: 'Main work', status: 'running', agentIdentity: 'agent3' }],
    conversations: [{ id: 'r9', title: 'Sub run', status: 'completed', agentIdentity: 'agent3', subagentAlias: 'Mary', parentRunId: 'r1', updatedAt: NOW }],
    subagents: [{ alias: 'Mary', status: 'running', task: 'Sub run', runId: 'r9', parentRunId: 'r1', lane: 'agent3' }]
  });
  const rows = model.laneFor('agent3').rows;
  assert.deepEqual(rows.map((row) => row.id), ['r1', 'r9']);
  assert.equal(rows[1].active, true, 'the live roster is fresher than the saved record');
});

test('activity flags drive the tab dot and the active-tab spinner', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    liveSessions: [
      { id: 'one', title: 'Running one', status: 'running', agentIdentity: 'agent1' },
      { id: 'two', title: 'Running two', status: 'paused', agentIdentity: 'agent2' }
    ],
    conversations: [{ id: 'three', title: 'Finished', status: 'completed', agentIdentity: 'agent3', updatedAt: NOW - 2 * DAY }]
  });
  assert.equal(model.laneFor('agent1').hasActive, true);
  assert.equal(model.laneFor('agent2').hasActive, true, 'a paused run is still an active task');
  assert.equal(model.laneFor('agent3').hasActive, false);
  assert.equal(model.laneFor('agent1').activeCount, 1);
});

test('active work sorts above finished work, then newest first', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [
      { id: 'older', title: 'Older', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - 2 * DAY },
      { id: 'newer', title: 'Newer', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - MIN }
    ],
    liveSessions: [{ id: 'live', title: 'Live', status: 'running', agentIdentity: 'agent1' }]
  });
  assert.deepEqual(model.laneFor('agent1').rows.map((row) => row.id), ['live', 'newer', 'older']);
});

// OPEN vs ACTIVE. The list used to answer only "is work happening", so the task
// you were already reading looked exactly like every other row, and reopening
// history could land on a tab that did not even contain it.
test('the task open in the transcript is marked, and its lane is reported', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'b',
    conversations: [
      { id: 'a', title: 'Agent one task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - MIN },
      { id: 'b', title: 'Agent two task', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - 2 * MIN },
      { id: 'c', title: 'Agent two older', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - 3 * MIN }
    ]
  });
  const marked = model.lanes.flatMap((lane) => lane.rows).filter((row) => row.open);
  assert.deepEqual(marked.map((row) => row.id), ['b'], 'exactly one row is open');
  assert.equal(model.openId, 'b');
  assert.equal(model.openLane, 'agent2', 'the window needs the lane to land on it');
});

test('a finished task can be open while a different task is the live one', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'saved',
    liveSessions: [{ id: 'running', title: 'Running now', status: 'running', agentIdentity: 'agent1' }],
    conversations: [{ id: 'saved', title: 'Finished yesterday', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - DAY }]
  });
  const rows = model.laneFor('agent1').rows;
  assert.deepEqual(rows.map((row) => [row.id, row.active, row.open]), [
    ['running', true, false],
    ['saved', false, true]
  ], 'open and active are independent facts');
});

test('nothing is marked open when no task is loaded', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'a', title: 'Task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  assert.equal(model.openId, '');
  assert.equal(model.openLane, null);
  assert.equal(model.laneFor('agent1').rows.some((row) => row.open), false);
});

test('an open id that is not in the list marks nothing instead of inventing a lane', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'gone',
    conversations: [{ id: 'a', title: 'Task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  assert.equal(model.openLane, null);
  assert.equal(model.laneFor('agent1').rows[0].open, false);
});

test('the tab holding the open task says so, even when that tab has no live work', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'saved',
    conversations: [
      { id: 'live', title: 'Agent one work', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - MIN },
      { id: 'saved', title: 'Finished yesterday', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - DAY }
    ]
  });
  assert.deepEqual(model.lanes.map((lane) => [lane.lane, lane.hasActive, lane.hasOpen]), [
    ['agent1', false, false],
    ['agent2', false, true],
    ['agent3', false, false]
  ], 'a quiet lane still advertises that it holds the open task');
});

test('a subagent tab in front is the open row, not the parent that spawned it', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'parent',
    openAlias: 'Mary',
    conversations: [
      { id: 'parent', title: 'Research the market', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - 5 * MIN },
      { id: 'child', title: 'Collected pricing pages', status: 'completed', agentIdentity: 'agent1', subagentAlias: 'Mary', parentRunId: 'parent', updatedAt: NOW - 3 * MIN }
    ]
  });
  const rows = model.laneFor('agent1').rows;
  assert.equal(rows.find((row) => row.id === 'parent').open, false, 'the parent is not what is on screen');
  assert.equal(rows.find((row) => row.alias === 'Mary').open, true);
  assert.equal(rows.filter((row) => row.open).length, 1, 'exactly one row is open');
});

test('a subagent alias that is no longer listed marks nothing', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'parent',
    openAlias: 'Gone',
    conversations: [{ id: 'parent', title: 'Task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  assert.equal(model.laneFor('agent1').rows[0].open, false);
  assert.equal(model.openLane, null);
});

// NAMING. A tab that only says "Agent 2" answers the wrong question: the AI
// names each conversation as the chat evolves, and the tab has to follow that
// name or the renaming is invisible in the one place it matters.
test('a tab is named after the task its agent is doing, not its slot number', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [
      { id: 'a', title: 'Compare Pricing Plans', status: 'running', agentIdentity: 'agent1', updatedAt: NOW - MIN },
      { id: 'b', title: 'Research Creators', status: 'completed', agentIdentity: 'agent2', updatedAt: NOW - 2 * MIN }
    ]
  });
  assert.equal(model.laneFor('agent1').name, 'Compare Pricing Plans', 'the full AI name is kept for the tooltip');
  assert.equal(model.laneFor('agent1').tabLabel, 'Compare Pricing…', 'the tab prints the part that fits');
  assert.equal(model.laneFor('agent2').name, 'Research Creators');
  assert.equal(model.laneFor('agent2').tabLabel, 'Research…');
  assert.equal(model.laneFor('agent3').tabLabel, 'Chat 3', 'an empty lane keeps its slot name');
  assert.equal(model.laneFor('agent3').name, '');
});

test('live work names the tab over an older open task', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'saved',
    liveSessions: [{ id: 'live', title: 'Book The Flight', status: 'running', agentIdentity: 'agent1' }],
    conversations: [{ id: 'saved', title: 'Old Invoice Hunt', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - DAY }]
  });
  const lane = model.laneFor('agent1');
  assert.equal(lane.name, 'Book The Flight', 'what the agent is doing NOW is the name');
  assert.equal(lane.hasOpen, true, 'the open task is still advertised by the ring');
});

test('a quiet lane takes its name from the task you have open', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    openId: 'b',
    conversations: [
      { id: 'a', title: 'Newer Finished Task', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - MIN },
      { id: 'b', title: 'Older Task I Reopened', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW - DAY }
    ]
  });
  assert.equal(model.laneFor('agent1').name, 'Older Task I Reopened');
});

test('a subagent never names the agent tab that spawned it', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    subagents: [{ alias: 'Mary', runId: 's1', lane: 'agent1', status: 'running', title: 'Read Follower Counts' }]
  });
  const lane = model.laneFor('agent1');
  assert.equal(lane.name, '', 'a fragment must not become the agent name');
  assert.equal(lane.tabLabel, 'Chat 1');
  assert.equal(lane.rows.length, 1, 'the subagent row is still listed');
});

test('a rename changes the tab label, so gradual renaming reaches the UI', () => {
  const before = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'a', title: 'TikTok Research', status: 'running', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  const after = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'a', title: 'Creator Follower Audit', status: 'running', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  assert.equal(before.laneFor('agent1').name, 'TikTok Research');
  assert.equal(after.laneFor('agent1').name, 'Creator Follower Audit');
  assert.notEqual(before.laneFor('agent1').tabLabel, after.laneFor('agent1').tabLabel);
  assert.equal(after.laneFor('agent1').tabLabel, 'Creator…', 'the renamed tab shows the new name, not a cached one');
});

test('long names are shortened at a word boundary and fit a real tab', () => {
  assert.equal(Lanes.shortName('Short Name'), 'Short Name');
  assert.equal(Lanes.shortName('  spaced   out  '), 'spaced out');
  const long = Lanes.shortName('Compare The Three Pricing Plans On The Website');
  // 13 characters + the ellipsis is what a 111px tab actually fits; a longer
  // label would be sliced mid-word by CSS, which reads as a bug.
  assert.ok(long.length <= 16, `shortened name must fit a narrow tab, got "${long}"`);
  assert.ok(long.endsWith('…'), 'a shortened name says it was shortened');
  assert.ok(!/\s…$/.test(long), 'no dangling space before the ellipsis');
  assert.ok(long.startsWith('Compare'), `expected a word-aligned stem, got "${long}"`);
  assert.equal(Lanes.shortName('Internationalization Workflows'), 'Internationaliz…', 'a single over-long word is cut, not dropped');
});

// The three tabs are CHATS, and each one owns its own name. A tab that prints
// another lane's number, or the word "Agent", makes the strip lie about where
// work will land.
test('every tab is a chat slot and never borrows another tab label', () => {
  const model = Lanes.buildHistoryModel({
    now: NOW,
    conversations: [{ id: 'a', title: 'Creator Outreach', status: 'completed', agentIdentity: 'agent1', updatedAt: NOW }]
  });
  const labels = model.lanes.map((lane) => lane.tabLabel);
  assert.deepEqual(labels, ['Creator Outreach', 'Chat 2', 'Chat 3']);
  for (const lane of model.lanes) {
    assert.ok(!/agent/i.test(lane.tabLabel), `a tab must not print "Agent": ${lane.tabLabel}`);
    assert.ok(!/agent/i.test(lane.label), `a slot must not be called an agent: ${lane.label}`);
  }
  assert.equal(model.laneFor('agent1').label, 'Chat 1');
  assert.equal(model.laneFor('agent3').label, 'Chat 3');
});
