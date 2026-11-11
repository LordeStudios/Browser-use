'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { viewportPoint } = require('../desktop/agent/agentInternals.cjs');

// DPR-1.25 fixture measured live on lichess training (session 3): CSS viewport
// 878x706, screenshot image 1098x883, board bottom edge at CSS y=557. A model
// that reads image pixels and labels them "viewport" clicked below the board;
// the same square is (286,579)/1.25 = (229,463) in CSS pixels.
const run = {
  visualEvidence: { screenshotId: 'shot-t-123', scaleX: 1.25, scaleY: 1.25, width: 1098, height: 883 },
  latestObservation: { dom: { viewport: { width: 878, height: 706 } } }
};

test('a screenshotId alone maps image pixels to CSS viewport pixels at DPR 1.25', () => {
  // The lichess regression: image pixels sent with the DEFAULT coordinate
  // space. The screenshotId is the authoritative frame declaration.
  const point = viewportPoint(run, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-123' });
  assert.deepEqual(point, { x: 229, y: 463 });
});

test('coordinateSpace="screenshot" with the matching screenshotId maps identically', () => {
  const point = viewportPoint(run, 286, 579, 'browser_click', 't', { coordinateSpace: 'screenshot', screenshotId: 'shot-t-123' });
  assert.deepEqual(point, { x: 229, y: 463 });
});

test('mapped screenshot coordinates bypass the CSS-viewport bounds check before scaling', () => {
  // 579 image px exceeds nothing here, but 1098x883 pixels would: the raw
  // image-space point must never be validated against the 878x706 CSS box.
  const point = viewportPoint(run, 1080, 860, 'browser_click', 't', { screenshotId: 'shot-t-123' });
  assert.deepEqual(point, { x: 864, y: 688 });
  assert.throws(() => viewportPoint(run, 1080, 860, 'browser_click', 't', {}),
    /must stay inside the current 878 by 706 viewport/, 'unmapped image pixels stay invalid in viewport space');
});

test('a click may cite any retained capture id, not only the latest frame', () => {
  // The staleness trap: auto-observations replace run.visualEvidence with a
  // new capture id, which used to invalidate the id the model legitimately
  // received from its own browser_screenshot call — the live chess run bounced
  // the model's click for exactly that (recovery log 2026-11-11 18:11). The
  // visual ledger retains each capture's scale, so any held id stays mappable.
  const supersededRun = {
    visualEvidence: { screenshotId: 'shot-t-auto-9', scaleX: 2, scaleY: 2 },
    visualLedger: [
      { at: 1, source: 'tool', revision: 3, screenshotId: 'shot-t-123', scaleX: 1.25, scaleY: 1.25 },
      { at: 2, source: 'auto', revision: 9, screenshotId: 'shot-t-auto-9', scaleX: 2, scaleY: 2 }
    ],
    latestObservation: { dom: { viewport: { width: 878, height: 706 } } }
  };
  const point = viewportPoint(supersededRun, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-123' });
  assert.deepEqual(point, { x: 229, y: 463 }, 'the superseded capture id maps through ITS OWN scale');
  const latest = viewportPoint(supersededRun, 400, 500, 'browser_click', 't', { screenshotId: 'shot-t-auto-9' });
  assert.deepEqual(latest, { x: 200, y: 250 }, 'the latest capture keeps mapping too');
  assert.throws(
    () => viewportPoint(supersededRun, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-never-taken' }),
    /require the latest screenshotId/,
    'an id no retained capture knows is still stale'
  );
});

test('a stale screenshotId is rejected instead of being silently read 1:1', () => {
  assert.throws(() => viewportPoint(run, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-old' }),
    /require the latest screenshotId from browser_screenshot/);
  assert.throws(() => viewportPoint({ visualEvidence: null }, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-123' }),
    /require the latest screenshotId from browser_screenshot/);
});

test('coordinateSpace="screenshot" without a screenshotId still fails with the recovery message', () => {
  assert.throws(() => viewportPoint(run, 286, 579, 'browser_click', 't', { coordinateSpace: 'screenshot' }),
    /require the latest screenshotId from browser_screenshot/);
});

test('plain CSS-viewport coordinates are untouched when no screenshotId is passed', () => {
  assert.deepEqual(viewportPoint(run, 229, 463, 'browser_click', 't', {}), { x: 229, y: 463 });
  assert.deepEqual(viewportPoint(run, 229.4, 463.6, 'browser_click', 't', { coordinateSpace: 'viewport' }), { x: 229, y: 464 });
  assert.throws(() => viewportPoint(run, 900, 400, 'browser_click', 't', {}), /must stay inside the current 878 by 706 viewport/);
});

test('a capture without a CSS-viewport scale refuses to map instead of assuming 1:1', () => {
  const scaleless = { ...run, visualEvidence: { screenshotId: 'shot-t-123', scaleX: null, scaleY: null } };
  assert.throws(() => viewportPoint(scaleless, 286, 579, 'browser_click', 't', { screenshotId: 'shot-t-123' }),
    /did not include a CSS-viewport scale/);
});
