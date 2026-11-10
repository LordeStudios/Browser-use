import assert from 'node:assert/strict';
import test from 'node:test';

import thinkingStream from '../desktop/agent/thinkingStream.cjs';

const { createThinkingStreamSplitter } = thinkingStream;

test('desktop uses the Studio splitter contract for separate thought and reply fields', () => {
  const splitter = createThinkingStreamSplitter();
  splitter.push('<think>The user said hello. I should greet them');
  const state = splitter.push('<think>The user said hello. I should greet them.</think>Hello! How can I help?');

  assert.equal(state.thinkingText, 'The user said hello. I should greet them.');
  assert.equal(state.replyText, 'Hello! How can I help?');
  assert.doesNotMatch(state.replyText, /think|user said hello/i);
});

test('desktop splitter withholds markers split at every network boundary', () => {
  const source = '<think>Assessing the page.</think>The final reply remains visible.';
  for (let index = 0; index <= source.length; index += 1) {
    const splitter = createThinkingStreamSplitter();
    splitter.push(source.slice(0, index));
    const state = splitter.push(source);
    assert.equal(state.thinkingText, 'Assessing the page.', `boundary ${index}`);
    assert.equal(state.replyText, 'The final reply remains visible.', `boundary ${index}`);
  }
});

test('desktop splitter recognizes encoded markers streamed one character at a time', () => {
  const source = '&lt;think&gt;Checking options.&lt;/think&gt;Final response.';
  const splitter = createThinkingStreamSplitter();
  for (let index = 1; index <= source.length; index += 1) splitter.push(source.slice(0, index));
  const state = splitter.finish();

  assert.equal(state.thinkingText, 'Checking options.');
  assert.equal(state.replyText, 'Final response.');
});

test('desktop splitter retains alternating thinking and reply chronology', () => {
  const splitter = createThinkingStreamSplitter();
  splitter.push('<think>Plan.</think>Reply one.<think>Check output.</think>Reply two.');
  const state = splitter.finish();

  assert.deepEqual(state.segments.map((segment) => [segment.kind, segment.text]), [
    ['thinking', 'Plan.'],
    ['reply', 'Reply one.'],
    ['thinking', 'Check output.'],
    ['reply', 'Reply two.']
  ]);
});
