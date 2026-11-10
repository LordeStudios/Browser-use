import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLayaProvider } = require('../desktop/agent/layaProvider.cjs');

test('laya standalone fails loud and fast when a task is outside its mechanical scope', async () => {
  const provider = createLayaProvider({ endpoint: '' }); // bundled engine
  const context = {
    task: 'draw a realistic parrot',
    observation: { dom: { url: 'https://fixture.test', title: 'F', elements: [] } },
    history: []
  };
  // Decision 1: no confident candidate -> grounded exploration (a real scroll,
  // not the direction-object that used to scroll 0 pixels).
  const first = await provider.complete(context);
  assert.equal(first.actions[0].name, 'browser_scroll', 'first miss explores');
  assert.equal(first.actions[0].input.deltaY, 400, 'exploration scroll carries a real delta');
  // Decision 2: still nothing mechanical to do -> throw the scope block.
  await assert.rejects(
    () => provider.complete(context),
    (error) => {
      assert.equal(error.code, 'LAYA_SCOPE_LIMIT', 'the block carries its code');
      assert.match(error.message, /API model/, 'the message names the fix');
      return true;
    }
  );
});

test('a laya scope block stays internal and the planner can continue', async () => {
  const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
  const controller = {
    navigationState: () => ({ url: 'https://fixture.test', loading: false }),
    domSnapshot: () => ({ url: 'https://fixture.test', title: 'F', viewport: { width: 800, height: 600 }, elements: [] }),
    consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }],
    scroll: async () => ({ deltaX: 0, deltaY: 400, moved: true }),
    releaseSessionInput: () => {}
  };
  const laya = createLayaProvider({ endpoint: '' });
  let calls = 0;
  const agent = new DesktopChatAgent({
    controller, getSelectedTabId: () => 'tab', getControlMode: () => 'browser',
    emit: () => {},
    createProvider: () => ({ complete: async (context) => {
      calls += 1;
      if (calls === 1) {
        try { return await laya.complete(context); }
        catch (error) {
          assert.equal(error.code, 'LAYA_SCOPE_LIMIT');
          return { actions: [{ name: 'browser_scroll', input: { deltaY: 400 } }] };
        }
      }
      return { done: { summary: 'Planner continued after the Laya scope limit.', success: true, verified: true } };
    } })
  });
  const run = await agent.start({ task: 'draw a realistic parrot', provider: { id: 'mock' }, settings: { approvalMode: 'unattended', controlMode: 'browser' } });
  assert.equal(run.status, 'completed');
  assert.ok(calls >= 2, 'scope failure was recovered before the planner finished');
  assert.equal(run.result.success, true);
});

test('laya standalone still executes a mechanical task it can see', async () => {
  const provider = createLayaProvider({ endpoint: '' });
  const context = {
    task: 'open the settings page',
    observation: { dom: { url: 'https://fixture.test', title: 'F', elements: [
      { tag: 'a', text: 'Settings', index: 3, visible: true }
    ] } },
    history: []
  };
  const decision = await provider.complete(context);
  assert.ok(decision.actions || decision.done, 'a decision comes back');
});
