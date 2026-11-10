import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dom = require('../desktop/renderer/domAttachments.cjs');
const { ChatHistoryStore, normalize } = require('../desktop/store/chatHistoryStore.cjs');

function element(overrides = {}) {
  return {
    id: 'exit_btn', tag: 'button', selector: '#exit_btn',
    text: 'Exit', outerHTML: '<button id="exit_btn">Exit</button>',
    ...overrides
  };
}

test('DOM names come from the selected element, never an ordinal placeholder', () => {
  const first = dom.normalizeDomAttachment(element(), []);
  const second = dom.normalizeDomAttachment(element({ id: '', selector: 'main > button:nth-of-type(2)', text: 'Save' }), [first]);
  assert.equal(first.name, 'exit_btn');
  assert.equal(second.name, 'save');
  assert.doesNotMatch(first.name, /^DOM \d+$/i);
  assert.doesNotMatch(second.name, /^DOM \d+$/i);
});

test('legacy DOM ordinal text is upgraded only at the frontend boundary', () => {
  const attachments = [dom.normalizeDomAttachment(element(), [])];
  assert.equal(dom.replaceDomReferences('click DOM 1 now', attachments), 'click exit_btn now');
  const refs = dom.findDomReferences('click exit_btn now', attachments);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].attachment.name, 'exit_btn');
});

test('history keeps stable link metadata but omits captured outerHTML', () => {
  const record = normalize({
    id: 'run-1', status: 'completed',
    messages: [{
      role: 'user', content: 'click exit_btn',
      domAttachments: [{ name: 'exit_btn', selector: '#exit_btn', text: '<button>secret</button>', previewText: 'Exit', pageUrl: 'https://example.test' }]
    }]
  });
  const attachment = record.messages[0].domAttachments[0];
  assert.equal(attachment.name, 'exit_btn');
  assert.equal(attachment.selector, '#exit_btn');
  assert.equal(attachment.text, undefined);
});

test('chat history round-trip preserves a clickable stable DOM target', async () => {
  const root = await import('node:os').then(({ default: os }) => os.tmpdir());
  const path = await import('node:path').then(({ default: path }) => path.join(root, `browser-use-dom-${Date.now()}-${Math.random()}.json`));
  const store = new ChatHistoryStore({ filePath: path });
  store.save([{
    id: 'run-2', status: 'completed',
    messages: [{ role: 'user', content: 'click exit_btn', domAttachments: [{ name: 'exit_btn', selector: '#exit_btn', previewText: 'Exit' }] }]
  }]);
  const restored = store.get('run-2');
  assert.equal(restored.messages[0].domAttachments[0].name, 'exit_btn');
  assert.equal(restored.messages[0].domAttachments[0].selector, '#exit_btn');
});
