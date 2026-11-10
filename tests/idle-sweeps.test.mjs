import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeIdleSubagentCloses, computeIdleEmptyTabCloses } = require('../desktop/agent/idleSweeps.cjs');

const NOW = 1_000_000_000_000;

test('idle subagent sweep closes only residents idle beyond 20 minutes', () => {
  const registry = new Map([
    ['s1', { alias: 'john', status: 'resident', lastActivityAt: NOW - 21 * 60 * 1000 }],
    ['s2', { alias: 'mary', status: 'resident', lastActivityAt: NOW - 19 * 60 * 1000 }],
    ['s3', { alias: 'david', status: 'running', lastActivityAt: NOW - 60 * 60 * 1000 }],
    ['s4', { alias: 'sara', status: 'queued', lastActivityAt: NOW - 60 * 60 * 1000 }],
    ['s5', { alias: 'peter', status: 'terminal', lastActivityAt: NOW - 60 * 60 * 1000 }],
    ['s6', { alias: 'emma', status: 'closed', lastActivityAt: NOW - 60 * 60 * 1000 }]
  ]);
  const due = computeIdleSubagentCloses(registry, { now: NOW });
  assert.deepEqual(due, ['john'], 'exactly the over-idle resident is due, nothing else');
});

test('a record without lastActivityAt is conservatively never swept (every spawn touches the clock)', () => {
  const registry = new Map([['s1', { alias: 'paul', status: 'resident' }]]);
  assert.deepEqual(computeIdleSubagentCloses(registry, { now: NOW }), []);
  assert.deepEqual(computeIdleSubagentCloses(registry, { now: NOW + 30 * 60 * 1000 }), []);
});

test('empty-tab sweep closes only blank, unowned, unselected, stale tabs', () => {
  const tabs = new Map([
    ['t1', { id: 't1', lastTouched: NOW - 5 * 60 * 1000 }],                      // blank, idle 5m -> due
    ['t2', { id: 't2', lastTouched: NOW - 1 * 60 * 1000 }],                      // blank, recently touched
    ['t3', { id: 't3', lastTouched: NOW - 5 * 60 * 1000 }],                      // owned by an agent
    ['t4', { id: 't4', lastTouched: NOW - 5 * 60 * 1000 }],                      // selected tab
    ['t5', { id: 't5', lastTouched: NOW - 5 * 60 * 1000 }],                      // real page loaded
    ['t6', { id: 't6', lastTouched: NOW - 5 * 60 * 1000 }]                       // destroyed webContents
  ]);
  const due = computeIdleEmptyTabCloses(tabs, {
    selectedTabId: 't4',
    owned: new Set(['t3']),
    now: NOW,
    getTabId: (tab) => tab.id,
    isTabAlive: (tab) => tab.id !== 't6',
    isTabEmpty: (tab) => tab.id !== 't5'
  });
  assert.deepEqual(due, ['t1']);
});

test('empty-tab sweep without lastTouched conservatively never closes the tab', () => {
  const tabs = new Map([['t1', { id: 't1' }]]);
  assert.deepEqual(computeIdleEmptyTabCloses(tabs, { now: NOW }), []);
  assert.deepEqual(computeIdleEmptyTabCloses(tabs, { now: NOW + 5 * 60 * 1000 }), []);
});

test('empty-tab ownership set covers active pool runs, retained residents, and chat window tabs', () => {
  // Ownership itself is assembled in main.cjs (agentOwnedTabIds); here we pin
  // that any id in the owned set protects its tab from the sweep.
  const tabs = new Map([
    ['t1', { id: 't1', lastTouched: NOW - 30 * 60 * 1000 }],
    ['t2', { id: 't2', lastTouched: NOW - 30 * 60 * 1000 }]
  ]);
  const due = computeIdleEmptyTabCloses(tabs, { owned: new Set(['t2']), now: NOW });
  assert.deepEqual(due, ['t1']);
});
