import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createOpenAiCompatibleProvider } = require('../desktop/agent/openAiCompatibleProvider.cjs');
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const SCREENSHOT = { mimeType: 'image/png', data: Buffer.from('fake-png-bytes').toString('base64') };
const DONE = '{"done":{"summary":"ok","success":true,"verified":true}}';
const ok200 = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const error400style = (status, message) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
const lastContent = (body) => {
  const content = body.messages.at(-1).content;
  return Array.isArray(content) ? content.find((part) => part.type === 'text')?.text || '' : content;
};
const hasImage = (body) => {
  const content = body.messages.at(-1).content;
  return Array.isArray(content) && content.some((part) => part.type === 'image_url');
};

test('vision payload survives one prose complaint but latches after repeated failures', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'glm-5.3-flash', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push({ hasImage: hasImage(body) });
      if (hasImage(body)) return ok200('I cannot see the image.');
      return ok200(DONE);
    }
  });
  const observation = { navigation: {}, dom: { elements: [] }, screenshot: SCREENSHOT };

  await provider.complete({ task: 'look', observation, history: [], messages: [], coordinator: {}, plan: [], tools: [] });
  assert.deepEqual(bodies, [{ hasImage: true }, { hasImage: false }],
    'first prose complaint costs one strike and a text-only retry inside the same decision');
  assert.equal(provider.visualUnsupported, false, 'one strike must not disable vision for the session');
  assert.equal(provider.visualProseStrikes, 1);

  bodies.length = 0;
  await provider.complete({ task: 'look again', observation, history: [], messages: [], coordinator: {}, plan: [], tools: [] });
  assert.equal(bodies[0]?.hasImage, true, 'the image capability is retried on the next decision');
  assert.equal(provider.visualUnsupported, true, 'a second prose failure latches vision off');
  assert.deepEqual(bodies, [{ hasImage: true }, { hasImage: false }]);

  bodies.length = 0;
  await provider.complete({ task: 'look once more', observation, history: [], messages: [], coordinator: {}, plan: [], tools: [] });
  assert.deepEqual(bodies, [{ hasImage: false }], 'once latched, images are never sent again');
});

test('a size-gated 403 with an image attached drops the image instead of failing the decision', async () => {
  const bodies = [];
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'glm-5.3-flash', apiKey: 'secret-key',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push({ hasImage: hasImage(body) });
      if (hasImage(body)) return error400style(403, 'request too large for current credits');
      return ok200(DONE);
    }
  });
  const result = await provider.complete({
    task: 'look', observation: { navigation: {}, dom: { elements: [] }, screenshot: SCREENSHOT },
    history: [], messages: [], coordinator: {}, plan: [], tools: []
  });
  assert.equal(result.done.summary, 'ok', 'the decision completes text-only');
  assert.deepEqual(bodies, [{ hasImage: true }, { hasImage: false }]);
  assert.equal(provider.visualUnsupported, false, 'a size/policy rejection must not permanently classify the model as text-only');
});

test('a 403 without visuals stays a loud failure (auth problems must not be masked)', async () => {
  const provider = createOpenAiCompatibleProvider({
    providerId: 'xkiro', baseUrl: 'https://api.example.test/v1', model: 'glm-5.3-flash', apiKey: 'secret-key',
    fetchImpl: async () => error400style(403, 'forbidden')
  });
  await assert.rejects(
    () => provider.complete({ task: 'look', observation: { navigation: {}, dom: { elements: [] } }, history: [], messages: [], coordinator: {}, plan: [], tools: [] }),
    /403/
  );
});

test('a browser mutation schedules fresh pixels for the next observation', async () => {
  const screenshots = [];
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }],
    scroll: async () => ({ ok: true, moved: true }),
    screenshot: async (tabId) => { screenshots.push(tabId); return { tabId, mimeType: 'image/png', data: 'cG5n', source: 'capturePage' }; },
    releaseSessionInput: () => {}
  };
  let call = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'browser',
    emit: () => {},
    createProvider: () => ({
      complete: async () => {
        call += 1;
        if (call === 1) return { actions: [{ name: 'browser_scroll', input: { dy: 300 } }] };
        return { done: { summary: 'Done', success: true, verified: true } };
      }
    })
  });
  await agent.start({ task: 'Scroll then finish', settings: { approvalMode: 'unattended', controlMode: 'browser' } });
  assert.ok(screenshots.length >= 1, `auto vision captured after the mutation (got ${screenshots.length} captures)`);
});

test('a browser run that never mutates captures no pixels under vision auto', async () => {
  const screenshots = [];
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }],
    screenshot: async (tabId) => { screenshots.push(tabId); return { tabId, mimeType: 'image/png', data: 'cG5n', source: 'capturePage' }; },
    releaseSessionInput: () => {}
  };
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'browser',
    emit: () => {},
    createProvider: () => ({
      complete: async () => ({ done: { summary: 'Done', success: true, verified: true } })
    })
  });
  await agent.start({ task: 'Just finish', settings: { approvalMode: 'unattended', controlMode: 'browser' } });
  assert.equal(screenshots.length, 0, 'DOM-only runs stay compositor-free under vision auto');
});
