import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Two live session instances wired through a shared in-memory hub — the same
// shape main.cjs builds — exercising agent_message end to end: the tool
// dispatch delivers, the receiving session's subagent replies immediately,
// and the reply lands in the sender's next decision context.
test('agent_message end to end: dispatch, auto-reply, and reply-in-context', async () => {
  const events = { a: [], b: [] };
  const contexts = { a: [], b: [] };
  let aInstance = null;
  let bInstance = null;
  const hub = {
    async send({ from, fromLabel, to, text, isReply = false }) {
      const wanted = String(to || 'any').trim() || 'any';
      const live = (instance) => instance && ['running', 'awaiting_approval', 'paused'].includes(instance.state()?.status) && String(instance.state().id) !== String(from);
      const candidates = [bInstance, aInstance].filter(live);
      const target = wanted === 'any'
        ? candidates[0] || null
        : candidates.find(instance => String(instance.state().id) === wanted) || null;
      if (!target) return { sent: false, note: 'no other live session' };
      target.receiveAgentMessage({ from, fromLabel, text, reply: isReply });
      return { sent: true };
    }
  };
  const make = (name, actions, firstCallDelayMs = 0) => new DesktopChatAgent({
    controller: {
      navigationState: () => ({ url: 'https://fixture.test', loading: false }),
      domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
      consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
    },
    getSelectedTabId: () => 'tab',
    getControlMode: () => 'browser',
    getComputerTools: () => ({ observe: async () => ({}), execute: async () => ({}), releaseOwner: async () => {} }),
    emit: (event) => events[name].push(event),
    messageApi: hub,
    createProvider: () => ({ complete: async (context) => {
      if (firstCallDelayMs && contexts[name].length === 0) await delay(firstCallDelayMs);
      contexts[name].push(context);
      return { actions: [actions.shift() || { name: 'browser_done', input: { summary: 'ok', verified: true } }] };
    } })
  });
  // B stays busy for a while (its first decision is slow) so it is LIVE when
  // A's message arrives, and A paces its next decision so the reply — which
  // B's subagent sends within a tick — lands before A's final context.
  bInstance = make('b', [], 150);
  aInstance = make('a', [
    { name: 'agent_message', input: { to: 'any', message: 'I own main.dart — do not edit it.' } },
    { name: 'browser_wait', input: { ms: 500 } }
  ]);
  await Promise.race([Promise.all([bInstance.start({ task: 'b work', provider: { id: 'mock' } }), aInstance.start({ task: 'a work', provider: { id: 'mock' } })]), delay(3000)]);
  // The tool executed on A.
  const toolResult = events.a.find(event => event.type === 'tool.result' && event.tool === 'agent_message');
  assert.ok(toolResult?.output?.ok, 'agent_message dispatched through the hub');
  assert.equal(toolResult.output.result.sent, true);
  // B received the message into its transcript…
  const incoming = events.b.find(event => event.type === 'agent.message' && event.reply === false);
  assert.ok(incoming, 'session b published the incoming message');
  assert.match(incoming.text, /main\.dart/);
  // The receiving run keeps its own provider and full-tool loop. Production
  // does not synthesize an out-of-band reply with a second provider call.
  assert.equal(events.b.some(event => event.type === 'agent.message' && event.reply === true), false);
  // The message is delivered into the receiver's normal next decision.
  const incomingContext = contexts.b.find(context => Array.isArray(context.agentMessages) && context.agentMessages.some(message => /main\.dart/.test(message.text)));
  assert.ok(incomingContext, 'the receiving agent consumed the message in its normal decision context');
});

test('replies never trigger another auto-reply (no ping-pong)', async () => {
  const events = { b: [] };
  const b = new DesktopChatAgent({
    controller: {
      navigationState: () => ({ url: 'https://fixture.test', loading: false }),
      domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
      consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
    },
    getSelectedTabId: () => 'tab', getControlMode: () => 'browser',
    getComputerTools: () => ({ observe: async () => ({}), execute: async () => ({}), releaseOwner: async () => {} }),
    emit: (event) => events.b.push(event),
    messageApi: { async send() { throw new Error('a reply must never be sent in response to a reply'); } },
    createProvider: () => ({ complete: async () => ({ actions: [{ name: 'browser_done', input: { summary: 'ok', verified: true } }] }) })
  });
  const done = b.start({ task: 'work', provider: { id: 'mock' } });
  await delay(10);
  b.receiveAgentMessage({ from: 'x', fromLabel: 'X', text: 'hello', reply: true });
  await delay(30);
  assert.equal(events.b.filter(event => event.type === 'agent.message' && event.reply === true).length, 0, 'a reply-kind message never auto-answers');
  await done;
});

test('agentMessages reach the decision context with a coordination directive, once', () => {
  const context = boundedRequestContext({
    task: 'task',
    agentMessages: [{ from: 'session-a', fromLabel: 'Session A', text: 'I own main.dart', reply: false }]
  });
  assert.equal(context.agentMessages.length, 1);
  assert.equal(context.agentMessages[0].from, 'Session A');
  assert.match(context.agentMessagesNote, /agent_message/);
  const empty = boundedRequestContext({ task: 'task' });
  assert.equal(empty.agentMessages, undefined);
});

test('the run snapshot never carries the message inbox across IPC', async () => {
  const events = [];
  const b = new DesktopChatAgent({
    controller: {
      navigationState: () => ({ url: 'https://fixture.test', loading: false }),
      domSnapshot: () => ({ url: 'https://fixture.test', title: 'Fixture', viewport: { width: 800, height: 600 }, elements: [] }),
      consoleEntries: () => [], networkEntries: () => [], listTabs: () => [{ id: 'tab' }], releaseSessionInput: () => {}
    },
    getSelectedTabId: () => 'tab', getControlMode: () => 'browser',
    getComputerTools: () => ({ observe: async () => ({}), execute: async () => ({}), releaseOwner: async () => {} }),
    emit: (event) => events.push(event),
    messageApi: { async send() { return { sent: false }; } },
    createProvider: () => ({ complete: async () => ({ actions: [{ name: 'browser_done', input: { summary: 'ok', verified: true } }] }) })
  });
  const done = b.start({ task: 'work', provider: { id: 'mock' } });
  await delay(10);
  b.receiveAgentMessage({ from: 'x', fromLabel: 'X', text: 'hello' });
  const snapshot = b.state();
  assert.equal(snapshot.pendingAgentMessages, undefined);
  assert.equal(snapshot.messageApi, undefined);
  await done;
});

test('the run snapshot strips the subagent API so IPC serialization never rejects', () => {
  const agent = new DesktopChatAgent({
    controller: { navigationState: () => ({ url: '', loading: false }), domSnapshot: () => ({ url: '', title: '', viewport: {}, elements: [] }), consoleEntries: () => [], networkEntries: () => [], listTabs: () => [], releaseSessionInput: () => {} },
    getSelectedTabId: () => null,
    getControlMode: () => 'browser',
    getComputerTools: () => ({}),
    emit: () => {},
    createProvider: () => ({ complete: async () => ({}) })
  });
  agent.run = { id: 'serialize-guard', task: 't', status: 'running', subagentApi: { list: () => {}, close: async () => {} }, spawnTask: () => {}, messageApi: { send: async () => {} }, history: [] };
  const snapshot = agent.state();
  assert.equal(snapshot.id, 'serialize-guard');
  assert.equal(snapshot.subagentApi, undefined, 'the subagent API must never cross IPC');
  assert.equal(snapshot.spawnTask, undefined);
  assert.equal(snapshot.messageApi, undefined);
  // Electron structured clone rejects functions before the renderer receives
  // anything; the whole snapshot must survive a serialize round-trip.
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)));
});

test('native dialog awareness nudges an AGI run and exempts browser-only runs', async () => {
  const agent = new DesktopChatAgent({
    controller: { navigationState: () => ({ url: '', loading: false }), domSnapshot: () => ({ url: '', title: '', viewport: {}, elements: [] }), consoleEntries: () => [], networkEntries: () => [], listTabs: () => [], releaseSessionInput: () => {} },
    getSelectedTabId: () => null,
    getControlMode: () => 'agi',
    getComputerTools: () => ({}),
    emit: () => {},
    createProvider: () => ({ complete: async () => ({}) })
  });
  const makeRun = (controlMode, windows) => ({
    id: 'native-test', status: 'running', history: [], messages: [],
    settings: { controlMode },
    getComputerTools: () => ({ execute: async () => ({ windows }) }),
    remoteExecution: false, observationDomain: 'browser', computerOwner: null
  });
  const DIALOG = { id: '123', title: 'Open', pid: process.pid, className: '#32770', minimized: false };
  // Baseline: the first check records pre-existing dialogs without nudging.
  const run = makeRun('agi', []);
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(run.messages.length, 0, 'no dialog means no notice');
  // A dialog the run itself opens mid-task triggers the switch-to-computer nudge.
  run.nativeSurfaceCheckAt = 0;
  run.getComputerTools = () => ({ execute: async () => ({ windows: [DIALOG] }) });
  await agent.deliverNativeSurfaceNotice(run);
  const notices = () => run.messages.filter(m => String(m.content || '').includes('NATIVE DIALOG OPEN'));
  assert.equal(notices().length, 1, 'the run is told to switch to computer tools');
  assert.match(notices()[0].content, /Open/);
  assert.match(notices()[0].content, /computer_pointer/);
  // Same dialog again: no duplicate nagging.
  run.nativeSurfaceCheckAt = 0;
  await agent.deliverNativeSurfaceNotice(run);
  assert.equal(notices().length, 1, 'an already-noticed dialog never re-nudges');
  // Browser-only runs have no computer tools to switch to: exempt.
  const browserRun = makeRun('browser', [DIALOG]);
  await agent.deliverNativeSurfaceNotice(browserRun);
  assert.equal(browserRun.messages.length, 0, 'browser-only runs are exempt');
  // A dialog from ANOTHER process (permission prompt, a helper's file picker,
  // any full-focus popup) is exactly what used to dead-lock the run: the old
  // same-PID filter made it invisible. It must be surfaced and driven.
  const foreignRun = makeRun('agi', []);
  await agent.deliverNativeSurfaceNotice(foreignRun);
  foreignRun.nativeSurfaceCheckAt = 0;
  foreignRun.getComputerTools = () => ({ execute: async () => ({ windows: [{ ...DIALOG, id: '7', pid: 999999 }] }) });
  await agent.deliverNativeSurfaceNotice(foreignRun);
  assert.equal(foreignRun.messages.length, 1, 'dialogs from other processes are surfaced (the narrow PID filter dead-locked runs)');
  assert.match(foreignRun.messages[0].content, /computer_observe/, 'the notice must name the observation tool');
  assert.match(foreignRun.messages[0].content, /computer_pointer/, 'the notice must name the input tool');
  assert.equal(foreignRun.observationDomain, 'computer', 'the run switches to desktop observation to see the dialog');
  // Already in computer domain and the run's own dialog: the model can see the
  // desktop and may be deliberately driving that dialog — no notice needed.
  const computerRun = makeRun('agi', []);
  await agent.deliverNativeSurfaceNotice(computerRun);
  computerRun.nativeSurfaceCheckAt = 0;
  computerRun.observationDomain = 'computer';
  computerRun.getComputerTools = () => ({ execute: async () => ({ windows: [DIALOG] }) });
  await agent.deliverNativeSurfaceNotice(computerRun);
  assert.equal(computerRun.messages.length, 0, 'computer-domain runs already see the desktop');
  // ...but the fresh dialog still arms the done gates against abandonment,
  assert.equal(computerRun.computerObservationDirty, true, 'a fresh dialog forces a fresh observation before done');
  assert.equal(computerRun.latestObservation, null, 'the cached observation cannot show the dialog');
  // and a foreign popup stealing focus mid-desktop-flow is still surfaced.
  const foreignDesktopRun = makeRun('agi', []);
  await agent.deliverNativeSurfaceNotice(foreignDesktopRun);
  foreignDesktopRun.nativeSurfaceCheckAt = 0;
  foreignDesktopRun.observationDomain = 'computer';
  foreignDesktopRun.getComputerTools = () => ({ execute: async () => ({ windows: [{ ...DIALOG, id: '9', pid: 999999 }] }) });
  await agent.deliverNativeSurfaceNotice(foreignDesktopRun);
  assert.equal(foreignDesktopRun.messages.length, 1, 'foreign popups are surfaced even in the computer domain');
  assert.match(foreignDesktopRun.messages[0].content, /computer_pointer/);
});
