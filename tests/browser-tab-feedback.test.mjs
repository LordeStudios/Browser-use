// Tab + click FEEDBACK. Both failures this covers look identical from the
// outside — the run just sits there — because the harness used to report
// success for actions that had not happened:
//
//   * browser_select_tab returned ok:true even when the requested tab was not
//     the one that became bound, so the model kept acting on the wrong page.
//   * browser_click returned ok:true when the page received no press at all
//     (the pointer animated, hover styling appeared, nothing activated), so the
//     model waited for an effect that could never arrive.
//
// Every assertion here is about the REPLY the model reads, because that reply
// is the only thing that lets it correct itself without a human stopping it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');

const TABS = [
  { id: 'tab-1', title: 'Search', url: 'https://site.test/search', loading: false, active: true },
  { id: 'tab-2', title: 'Profile', url: 'https://site.test/profile', loading: false, active: false }
];

function controller(overrides = {}) {
  const calls = [];
  return {
    calls,
    listTabs: () => TABS.map((tab) => ({ ...tab })),
    navigationState: (tabId) => ({ tabId, url: 'https://site.test/search', loading: false }),
    domSnapshot: (tabId) => ({
      tabId,
      url: 'https://site.test/search',
      title: 'Search',
      viewport: { width: 1280, height: 720 },
      elements: [
        { index: 0, tag: 'button', name: 'Users', text: 'Users', enabled: true },
        { index: 1, tag: 'button', name: 'Top', text: 'Top', enabled: true }
      ],
      truncated: false
    }),
    consoleEntries: () => [],
    networkEntries: () => [],
    async clickElement(tabId, args) { calls.push(['clickElement', args]); return { tabId, index: args.index, input: 'mouse', element: { center: { x: 100, y: 40 }, name: 'Top' }, ...(overrides.clickResult || {}) }; },
    async clickAt(tabId, args) { calls.push(['clickAt', args]); return { tabId, ...args, input: 'mouse', ...(overrides.clickResult || {}) }; },
    releaseSessionInput: () => ({ released: true }),
    ...overrides
  };
}

function run(toolCalls, options = {}) {
  const responses = [
    { toolCalls },
    { toolCalls: [{ name: 'browser_done', input: { summary: 'I selected the tab and clicked the control, then reported what I saw.', success: true, verified: true } }] }
  ];
  const agent = new DesktopChatAgent({
    controller: options.controller,
    getSelectedTabId: () => 'tab-1',
    selectTab: options.selectTab,
    emit: () => {},
    createProvider: () => ({ async complete() { return responses.shift() || { done: { summary: 'finished', success: true, verified: true } }; } })
  });
  return agent.start({ task: 'Select the profile tab and click the control.', provider: { id: 'mock' }, settings: { approvalMode: 'unattended' } });
}

const outputFor = (result, tool) => result.history.find((entry) => entry.tool === tool)?.output;

test('a tab that really becomes the run target says so, and lists what exists', async () => {
  const tab = { ...TABS[1], active: true };
  const result = await run([{ name: 'browser_select_tab', input: { tabId: 'tab-2' } }], {
    controller: controller(),
    selectTab: async () => tab
  });
  const output = outputFor(result, 'browser_select_tab');
  assert.equal(output.ok, true);
  assert.equal(output.result.boundTabId, 'tab-2');
  assert.equal(output.result.switched, true);
  assert.deepEqual(output.result.tabs.map((entry) => entry.id), ['tab-1', 'tab-2']);
  assert.equal(output.result.tabs.find((entry) => entry.id === 'tab-2').bound, true);
});

test('a binding-only switch is reported as NOT visible instead of looking like a failed switch', async () => {
  const result = await run([{ name: 'browser_select_tab', input: { tabId: 'tab-2' } }], {
    controller: controller(),
    selectTab: async () => ({ ...TABS[1], active: false })
  });
  const output = outputFor(result, 'browser_select_tab');
  assert.equal(output.ok, true);
  assert.equal(output.result.switched, false);
  assert.match(output.result.note, /VISIBLE tab did not change/);
  assert.match(output.result.note, /browser_focus_tab/);
});

test('a switch that lands on a different tab fails loudly with the roster', async () => {
  const result = await run([{ name: 'browser_select_tab', input: { tabId: 'tab-2' } }], {
    controller: controller(),
    selectTab: async () => ({ ...TABS[0] })
  });
  const output = outputFor(result, 'browser_select_tab');
  assert.equal(output.ok, false);
  assert.equal(output.recoverable, true);
  assert.match(output.error, /did not take/);
  assert.match(output.error, /tab-2/);
  assert.match(output.error, /tab-1/);
});

test('a failed switch names what the run still targets and every open tab', async () => {
  const result = await run([{ name: 'browser_select_tab', input: { tabId: 'tab-9' } }], {
    controller: controller(),
    selectTab: async () => { throw new Error('Tab tab-9 is no longer available.'); }
  });
  const output = outputFor(result, 'browser_select_tab');
  assert.equal(output.ok, false);
  assert.match(output.error, /still targets/);
  assert.match(output.error, /tab-1 \(visible\)/);
  assert.match(output.error, /tab-2/);
  assert.match(output.error, /do not re-send tab-9/);
});

test('a click the page never received is a FAILURE, not a hovered success', async () => {
  const result = await run([{ name: 'browser_click', input: { element: 0 } }], {
    controller: controller({ clickResult: { delivered: false, delivery: 'cdp' } })
  });
  const output = outputFor(result, 'browser_click');
  assert.equal(output.ok, false, 'ok:true here is what made the run wait forever');
  assert.equal(output.recoverable, true);
  assert.equal(output.recoverySource, 'click_not_delivered');
  assert.match(output.error, /no click reached it/);
});

test('a click that navigated is delivered even though the old document kept no record', async () => {
  // The URL must flip when the CLICK happens, not on the Nth read of
  // navigationState: the run reads the URL while establishing its opening
  // observation, so a call counter would flip before the click ever fires.
  let navigated = false;
  const moved = controller({ clickResult: { delivered: false, delivery: 'cdp' } });
  const clickElement = moved.clickElement;
  moved.clickElement = async (tabId, args) => {
    const clicked = await clickElement(tabId, args);
    navigated = true;
    return clicked;
  };
  moved.navigationState = (tabId) => ({
    tabId,
    url: navigated ? 'https://site.test/profile' : 'https://site.test/search',
    loading: false
  });
  const result = await run([{ name: 'browser_click', input: { element: 0 } }], { controller: moved });
  const output = outputFor(result, 'browser_click');
  assert.equal(output.ok, true, 'a link click that navigates must not be called a swallowed click');
});

test('an unarmed probe stays a success: no verdict is not a failure verdict', async () => {
  const result = await run([{ name: 'browser_click', input: { element: 0 } }], {
    controller: controller({ clickResult: { delivered: null } })
  });
  assert.equal(outputFor(result, 'browser_click').ok, true);
});

test('the observation always carries the bound tab and the open tabs', async () => {
  const result = await run([{ name: 'browser_observe', input: {} }], { controller: controller() });
  const output = outputFor(result, 'browser_observe');
  assert.equal(output.ok, true);
  assert.equal(output.observation.navigation.boundTabId, 'tab-1');
  assert.equal(output.observation.navigation.activeTabId, 'tab-1');
  assert.deepEqual(output.observation.navigation.tabs.map((tab) => tab.id), ['tab-1', 'tab-2']);
});
