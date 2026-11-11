import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The strip and the expanded message window were two unconnected boxes with a
// dead seam between them inside a pointer-events:none parent: moving from the
// strip to a message row crossed empty space and the window collapsed before
// the click landed. They are now ONE joined hover region.
test('the timeline strip and its window are one joined hover region', () => {
  const css = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/chat-reference.css'), 'utf8');
  const windowRule = css.slice(css.indexOf('.agent-timeline-window {'), css.indexOf('.agent-timeline-row {'));
  assert.match(windowRule, /right: 16px/, 'the card overlaps the strip instead of leaving a dead seam');
  assert.match(css, /\.agent-timeline\.is-open \.agent-timeline-window/, 'the JS-owned open state drives the window');
  assert.match(css, /\.agent-timeline:focus-within \.agent-timeline-window/, 'keyboard focus keeps it open');

  const app = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  const init = app.slice(app.indexOf('function initChatTimeline()'), app.indexOf('setTimeout(initChatTimeline, 400)'));
  assert.match(init, /chatTimeline\.classList\.add\('is-open'\)/, 'entering either part opens the region');
  assert.match(init, /for \(const node of \[chatTimelineTrack, chatTimelineWindow\]\)/, 'both the strip and the window own the open state');
  assert.match(init, /setTimeout\(/, 'a close delay lets the pointer cross the seam without collapsing the window');
  assert.match(init, /260/, 'the close delay is short but real');
});
