import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { WorkingBubble, BUBBLE_WIDTH, BUBBLE_HEIGHT } = require('../desktop/bubble/workingBubbleWindow.cjs');

// WORKING BUBBLE — the always-on-top orb in the bottom-right corner.
//
// The rule the user asked for is behavioural, so it is tested behaviourally:
// the bubble appears only while a run is active AND the app is not in front of
// the user; it shows the outcome for a beat when the run ends; it disappears at
// once when the user is already looking at the app; it never steals focus, and
// never blocks the desktop behind it.

function makeHarness({ supported = true } = {}) {
  const windows = [];
  const notifications = [];

  class FakeBrowserWindow {
    constructor(options) {
      this.options = options;
      this.destroyed = false;
      this.visible = false;
      this.bounds = null;
      this.ignoreMouse = null;
      this.alwaysOnTop = null;
      this.loadedFile = null;
      this.handlers = {};
      this.webContents = {
        sent: [],
        send(channel, payload) { this.sent.push({ channel, payload }); }
      };
      windows.push(this);
    }
    setMenuBarVisibility() {}
    setAlwaysOnTop(flag, level) { this.alwaysOnTop = { flag, level }; }
    setIgnoreMouseEvents(flag, options) { this.ignoreMouse = { flag, options }; }
    loadFile(file) { this.loadedFile = file; }
    on(event, handler) { this.handlers[event] = handler; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    setBounds(bounds) { this.bounds = bounds; }
    destroy() { this.destroyed = true; }
  }

  class FakeNotification {
    static isSupported() { return supported; }
    constructor(options) { this.options = options; this.handlers = {}; this.shown = false; notifications.push(this); }
    on(event, handler) { this.handlers[event] = handler; }
    show() { this.shown = true; }
  }

  const ipcHandlers = {};
  const ipcMain = { on(channel, handler) { ipcHandlers[channel] = handler; } };

  const screen = {
    getCursorScreenPoint: () => ({ x: 1200, y: 700 }),
    getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } })
  };

  const parentWindow = {
    destroyed: false,
    minimized: false,
    focused: true,
    isDestroyed() { return this.destroyed; },
    isMinimized() { return this.minimized; },
    isFocused() { return this.focused; }
  };

  let activations = 0;
  const bubble = new WorkingBubble({
    BrowserWindow: FakeBrowserWindow,
    ipcMain,
    Notification: FakeNotification,
    screen,
    parentWindow,
    htmlPath: '/tmp/bubble.html',
    preloadPath: '/tmp/bubble-preload.cjs',
    onActivate: () => { activations += 1; }
  });

  return {
    bubble, windows, notifications, ipcHandlers, parentWindow,
    get activations() { return activations; },
    get win() { return windows[0]; },
    get visible() { return Boolean(windows[0]?.visible); }
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the window never steals focus and never blocks the desktop', () => {
  const h = makeHarness();
  h.parentWindow.focused = false; // the window only exists once there is a run to mirror
  h.bubble.update({ active: true, mode: 'thinking', title: 'Working', text: 'Opening Blender' });

  const win = h.win;
  assert.ok(win, 'the bubble window must be created');
  assert.equal(win.options.frame, false, 'a frame would defeat the floating orb');
  assert.equal(win.options.transparent, true);
  assert.equal(win.options.focusable, false, 'the bubble must never steal focus');
  assert.equal(win.options.skipTaskbar, true);
  assert.equal(win.options.alwaysOnTop, true);
  assert.deepEqual(win.alwaysOnTop, { flag: true, level: 'screen-saver' }, 'a normal floating level drops behind full-screen apps');
  // Click-through by default, with forwarding so hover is still detectable.
  assert.deepEqual(win.ignoreMouse, { flag: true, options: { forward: true } });
  assert.equal(win.loadedFile, '/tmp/bubble.html');
  assert.equal(win.options.webPreferences.preload, '/tmp/bubble-preload.cjs');
  assert.equal(win.options.webPreferences.backgroundThrottling, false, 'a throttled bubble stops animating');
});

test('it sits in the bottom-right corner of the work area', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'thinking' });
  const bounds = h.win.bounds;
  assert.equal(bounds.width, BUBBLE_WIDTH);
  assert.equal(bounds.height, BUBBLE_HEIGHT);
  assert.equal(bounds.x, 1920 - BUBBLE_WIDTH - 16, 'right edge, 16px margin');
  assert.equal(bounds.y, 1040 - BUBBLE_HEIGHT - 16, 'bottom edge, above the taskbar');
});

test('it stays hidden while the user is looking at the app', () => {
  const h = makeHarness();
  h.parentWindow.focused = true;
  h.bubble.update({ active: true, mode: 'acting', text: 'Clicking Save' });
  assert.equal(h.visible, false, 'a focused app already shows the orb above its composer');
});

test('it appears when the app is minimised or in the background', () => {
  const h = makeHarness();
  h.bubble.update({ active: true, mode: 'acting', text: 'Clicking Save' });
  assert.equal(h.visible, false);

  h.parentWindow.focused = false;
  h.bubble.evaluateVisibility();
  assert.equal(h.visible, true, 'a backgrounded run must be visible');

  h.parentWindow.focused = true;
  h.parentWindow.minimized = true;
  h.bubble.evaluateVisibility();
  assert.equal(h.visible, true, 'and so must a minimised one');
});

test('an inactive run hides it, and it comes back for the next one', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'thinking' });
  assert.equal(h.visible, true);
  h.bubble.update({ active: false, mode: 'thinking' });
  assert.equal(h.visible, false, 'no run, no bubble');
  h.bubble.update({ active: true, mode: 'thinking' });
  assert.equal(h.visible, true);
});

test('hover is the only thing that disables click-through', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'thinking' });
  assert.equal(h.win.ignoreMouse.flag, true);

  h.ipcHandlers['browser-use:bubble-hover']({}, true);
  assert.equal(h.win.ignoreMouse.flag, false, 'the orb must be clickable while hovered');
  assert.deepEqual(h.win.ignoreMouse.options, { forward: true });

  h.ipcHandlers['browser-use:bubble-hover']({}, false);
  assert.equal(h.win.ignoreMouse.flag, true, 'and click-through again once the pointer leaves');
});

test('clicking the orb restores the app', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'waiting', text: 'Which file should I open?' });
  h.ipcHandlers['browser-use:bubble-activate']({});
  assert.equal(h.activations, 1);
});

test('a finished run disappears at once when the user is already watching', () => {
  const h = makeHarness();
  h.parentWindow.focused = true;
  h.bubble.update({ active: true, mode: 'acting' });
  h.bubble.update({ active: false, mode: 'done', title: 'Finished', text: 'Blender is open.' });
  assert.equal(h.visible, false, 'the transcript already holds the outcome; the bubble is clutter');
});

test('a finished run lingers briefly when the app is in the background', async () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.transientMs = 30;
  h.bubble.update({ active: true, mode: 'acting' });
  assert.equal(h.visible, true);

  h.bubble.update({ active: false, mode: 'done', title: 'Finished', text: 'Blender is open.' });
  assert.equal(h.visible, true, 'the corner change must be noticeable');
  assert.equal(h.win.webContents.sent.at(-1).payload.mode, 'done', 'and it must say what happened');

  await sleep(90);
  assert.equal(h.visible, false, 'then it must leave the desktop alone');
  assert.equal(h.bubble.state.active, false);
});

test('notifications fire only when the user is not looking, and once per change', () => {
  const h = makeHarness();

  // Focused: telling the user what is on screen in front of them is noise.
  h.parentWindow.focused = true;
  h.bubble.update({ active: false, mode: 'done', text: 'Done.' });
  assert.equal(h.notifications.length, 0, 'no notification while the app is focused');

  // Unfocused: one notification per transition, not one per state update.
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'acting' });
  h.bubble.update({ active: false, mode: 'done', text: 'Blender is open.' });
  h.bubble.update({ active: false, mode: 'done', text: 'Blender is open.' });
  assert.equal(h.notifications.length, 1, 'a repeated state must not re-notify');
  assert.equal(h.notifications[0].options.title, 'Browser-use finished');
  assert.equal(h.notifications[0].options.body, 'Blender is open.');
  assert.equal(h.notifications[0].shown, true);
});

test('an error and a question are both worth interrupting for', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'thinking' });
  h.bubble.update({ active: false, mode: 'error', text: 'The provider rate-limited this account.' });
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].options.title, 'Browser-use stopped');
  assert.match(h.notifications[0].options.body, /rate-limited/);

  h.bubble.update({ active: true, mode: 'thinking' });
  h.bubble.update({ active: true, mode: 'waiting', text: 'Which account?' });
  assert.equal(h.notifications.length, 2);
  assert.equal(h.notifications[1].options.title, 'Browser-use needs you');
});

test('clicking a notification also restores the app', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: false, mode: 'done', text: 'Done.' });
  h.notifications[0].handlers.click();
  assert.equal(h.activations, 1);
});

test('a missing notification backend cannot break a run', () => {
  const h = makeHarness({ supported: false });
  h.parentWindow.focused = false;
  assert.doesNotThrow(() => h.bubble.update({ active: false, mode: 'done', text: 'Done.' }));
  assert.equal(h.notifications.length, 0);
});

test('the text shown on hover is the agent message, collapsed and bounded', () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.update({ active: true, mode: 'acting', text: `  Opening\n\n  Blender   now  ` });
  const state = h.win.webContents.sent.at(-1).payload;
  assert.equal(state.text, 'Opening Blender now', 'newlines and runs of spaces must collapse');
  assert.equal(state.visible, true);

  h.bubble.update({ active: true, mode: 'acting', text: 'x'.repeat(900) });
  assert.equal(h.win.webContents.sent.at(-1).payload.text.length, 400, 'a long page title must not blow out the bubble');
  h.bubble.update({ active: true, mode: 'acting', title: 'y'.repeat(200), text: '' });
  assert.equal(h.win.webContents.sent.at(-1).payload.title.length, 60);
});

test('destroy releases the window and the pending timer', async () => {
  const h = makeHarness();
  h.parentWindow.focused = false;
  h.bubble.transientMs = 20;
  h.bubble.update({ active: false, mode: 'done', text: 'Done.' });
  const win = h.win;
  h.bubble.destroy();
  assert.equal(win.destroyed, true);
  assert.equal(h.bubble.window, null);
  assert.equal(h.bubble.transientTimer, null);
  await sleep(50);
  assert.doesNotThrow(() => h.bubble.update({ active: true, mode: 'thinking' }), 'it must survive a late event');
});

test('a destroyed parent window does not keep the bubble hidden', () => {
  const h = makeHarness();
  h.parentWindow.destroyed = true;
  h.bubble.update({ active: true, mode: 'thinking' });
  assert.equal(h.visible, true, 'with no parent there is nothing on screen to show the run');
});
