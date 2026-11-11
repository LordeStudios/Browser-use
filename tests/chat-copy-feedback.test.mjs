import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Owner directive: copy buttons must acknowledge the copy (a stale button
// reads as broken), and a tool card's copy must carry its FULL body - the
// action, its input AND its output - not just the tool name.
const app = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
const css = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/chat-reference.css'), 'utf8');

test('every copy control acknowledges with a visible feedback state', () => {
  assert.match(app, /function showCopyFeedback\(button, label = 'Copied'\)/, 'a shared feedback state exists');
  assert.match(app, /button\.dataset\.copiedLabel = label/, 'the badge label rides the button');
  assert.match(app, /function copyWithFeedback\(button, text/, 'copy + feedback is one path');
  // No copy control may bypass the feedback path.
  const rawCopySites = app.match(/copyText\([^)]*\)\.then\(\(\) => flashCopyIcon/g) || [];
  assert.equal(rawCopySites.length, 0, 'no copy button may copy without the shared feedback');
  const helperSites = (app.match(/copyWithFeedback\(/g) || []).length;
  assert.ok(helperSites >= 7, `expected every copy control to use the helper (found ${helperSites})`);
});

test('the copied badge is styled so icon-only buttons show it', () => {
  assert.match(css, /content: attr\(data-copied-label\)/, 'the badge renders the label');
  assert.match(css, /\.agent-message-hover-actions button\.is-copied::after/, 'hover copy buttons show it');
  assert.match(css, /\.agent-inspection-copy\.is-copied::after/, 'inspection copy buttons show it');
});

test('a tool card copies its action WITH input and output', () => {
  assert.match(app, /const cardCopy = \[/, 'the card builds a copy payload');
  assert.ok(app.includes('Input:') && app.includes('Output:'), 'both sections exist');
  assert.ok(/diagnosticText\(cardInput\)/.test(app), 'input is serialized');
  assert.ok(/diagnosticText\(cardOutput\)/.test(app), 'output is serialized');
  assert.match(app, /appendMessageHoverActions\(item, text, \{ copyText: cardCopy \}\)/, 'the hover copy uses the full card');
  assert.match(app, /function appendMessageHoverActions\(item, text, \{ copyText = null \} = \{\}\)/, 'the hover actions accept the payload');
});
