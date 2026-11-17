import test from 'node:test';
import assert from 'node:assert/strict';

const { describeAction, describePhase } = await import('../desktop/agent/narration.cjs');

// ── Why this exists ─────────────────────────────────────────────────────────
// A model that streams no reasoning text left the transcript with "Still
// working" and nothing else, so a long render was indistinguishable from a
// wedged run. The narration is derived from the action itself, so it is true
// for every model. It must name a concrete target when the call has one, and
// it must never claim an effect that dispatch cannot prove.

test('a navigation names the host, not the whole URL', () => {
  const line = describeAction({ name: 'browser_navigate', input: { url: 'https://www.tiktok.com/business-suite/messages?lang=en&scene=business' } });
  assert.equal(line, 'Opening tiktok.com');
});

test('a click names its label when the input carries one', () => {
  assert.equal(describeAction({ name: 'browser_click_element', input: { label: 'Send' } }), 'Clicking “Send”');
  assert.equal(describeAction({ name: 'browser_click', input: {} }), 'Clicking the page');
});

test('typing shows the text, quoted and bounded', () => {
  const line = describeAction({ name: 'browser_type', input: { text: 'Thanks' } });
  assert.equal(line, 'Typing “Thanks”');
  const long = describeAction({ name: 'browser_type', input: { text: 'x'.repeat(200) } });
  assert.ok(long.length < 60, `line must stay short: ${long}`);
  assert.match(long, /…/, 'a clipped value must be marked as clipped');
});

test('a key run is described as one action, not four', () => {
  const line = describeAction({ name: 'computer_keyboard', input: { keys: ['S', 'X', '0.35', 'Enter'] } });
  assert.equal(line, 'Pressing S X 0.35 Enter');
});

test('a native window call names the app', () => {
  assert.equal(describeAction({ name: 'computer_window', input: { action: 'focus', title: 'Blender 4.2' } }), 'Focusing Blender 4.2');
  assert.equal(describeAction({ name: 'computer_window', input: { action: 'focus', title: 'blender.exe' } }), 'Focusing blender');
});

test('a file edit names the file, not the full path', () => {
  assert.equal(
    describeAction({ name: 'computer_patch', input: { path: 'C:/Users/london/repo/desktop/main.cjs' } }),
    'Editing main.cjs'
  );
});

test('a terminal call shows the command', () => {
  assert.equal(describeAction({ name: 'computer_terminal', input: { command: 'npm test' } }), 'Running npm test');
});

test('bookkeeping tools narrate nothing', () => {
  for (const name of ['update_plan', 'create_plan', 'browser_done', 'agent_advisory', 'agent_recovery', 'agent_message']) {
    assert.equal(describeAction({ name, input: {} }), null, `${name} must not narrate`);
  }
});

test('an unknown tool still gets a readable line instead of silence', () => {
  const line = describeAction({ name: 'computer_widget_frobnicate', input: {} });
  assert.ok(line && line.length > 0, 'a generic line beats an empty card');
  assert.doesNotMatch(line, /computer_|_/, 'the raw tool id must not leak');
});

test('no narration claims an effect', () => {
  // "Clicking Send" is honest; "Sent the message" would not be — dispatch does
  // not prove delivery. Check the whole table for past-tense claims.
  const samples = [
    { name: 'browser_click_element', input: { label: 'Send' } },
    { name: 'browser_navigate', input: { url: 'https://a.test' } },
    { name: 'computer_keyboard', input: { text: 'hi' } },
    { name: 'computer_pointer', input: { action: 'click' } }
  ];
  for (const call of samples) {
    const line = describeAction(call);
    assert.doesNotMatch(line, /\b(?:sent|submitted|saved|created|deleted|finished|completed|done)\b/i, `${line} claims an effect`);
  }
});

test('phase narration is honest about what is happening', () => {
  assert.equal(describePhase('deciding'), 'Deciding the next step');
  assert.equal(describePhase('observing'), 'Looking at the current state');
  assert.equal(describePhase('waiting'), 'Waiting for the provider');
  assert.equal(describePhase(''), 'Working');
});
