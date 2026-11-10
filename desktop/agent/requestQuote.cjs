'use strict';

// Restating the user's request to the model.
//
// The harness repeats the user's request in several places the model reads on
// EVERY decision (the task ladder, the notebook's TASK REQUIREMENTS, the
// evidence-phase and progress nudges, the completion review, the stale-summary
// bounce). Each of those used its own `.slice(0, N)` with N between 120 and 300.
// For a short request that is invisible. For a long one it is destructive: the
// 1,081-character request in run.txt (2026-10-30) was restated as 11% of itself
// in the ladder, 22% in the notebook, and 28% in every nudge, and those nudges
// are the LAST thing the model reads before choosing its next action. Every
// instruction past the first sentence or two was gone from the text that steers
// each decision, so the agent worked the opening and drifted.
//
// A request must be restated whole or not at all. quoteRequest() returns the
// whole request up to a generous bound; past the bound it keeps the head AND
// the tail (instructions are often last: "...also fix the icon. start with a
// plan") and marks the cut in the middle so the model knows to re-read the full
// text in `task` rather than trust the excerpt.

const DEFAULT_QUOTE_LIMIT = 4000;

function squash(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function quoteRequest(value, limit = DEFAULT_QUOTE_LIMIT) {
  const text = squash(value);
  const max = Math.max(200, Number(limit) || DEFAULT_QUOTE_LIMIT);
  if (text.length <= max) return text;
  const marker = ' [... middle omitted; the full request is in `task` ...] ';
  const room = max - marker.length;
  const head = Math.ceil(room * 0.6);
  const tail = room - head;
  return `${text.slice(0, head).trimEnd()}${marker}${text.slice(text.length - tail).trimStart()}`;
}

module.exports = { quoteRequest, DEFAULT_QUOTE_LIMIT };
