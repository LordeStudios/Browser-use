import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DesktopChatAgent,
  isNativeDialogWindow,
  nativeDialogExpected,
  expectNativeDialog
} = require('../desktop/agent/desktopChatAgent.cjs');
const { ComputerTools } = require('../desktop/computer/computerTools.cjs');

// Owner directive: a native dialog is detected ONLY after the agent asked
// for one (open as admin, open file, save file, a file picker). Never
// otherwise: an unrelated window on the desktop is not a blocker, and
// announcing it sent the agent out of the task to "resolve" a window that
// blocked nothing - it even focused an unrelated browser and pressed Escape
// in it twice.
const DESKTOP = { x: 0, y: 0, width: 1920, height: 1080 };

// The window list from the live run that produced the detour.
const LIVE_WINDOWS = [
  { id: '658542', title: 'Browser-use agent pointer', className: 'Chrome_WidgetWin_1', pid: 10280, bounds: { x: 59, y: 138, width: 1098, height: 883 }, minimized: false, own: true },
  { id: '12912812', title: 'Browser-use', className: 'Chrome_WidgetWin_1', pid: 10280, bounds: { x: 50, y: 0, width: 1819, height: 1029 }, minimized: false, own: true },
  { id: '132520', title: 'MSN', className: 'Chrome_WidgetWin_1', pid: 18212, bounds: { x: -2228, y: 16, width: 1214, height: 988 }, minimized: false, own: false },
  { id: '132730', title: 'new1.txt - Notepad++', className: 'Notepad++', pid: 17280, bounds: { x: -32000, y: -32000, width: 199, height: 34 }, minimized: true, own: false },
  { id: '133406', title: 'browser-use-dsh-fork - File Explorer', className: 'CabinetWClass', pid: 9836, bounds: { x: -32000, y: -32000, width: 199, height: 34 }, minimized: true, own: false },
  { id: '66174', title: 'Program Manager', className: 'Progman', pid: 9836, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, minimized: false, own: false }
];

test('an ordinary application window is never a native dialog', () => {
  for (const window of LIVE_WINDOWS) {
    assert.equal(isNativeDialogWindow(window, DESKTOP), false, `"${window.title}" must not be read as a blocking dialog`);
  }
});

test('a real system dialog is still detected', () => {
  const openDialog = { id: '77', title: 'Open', className: '#32770', pid: 4242, bounds: { x: 600, y: 300, width: 500, height: 400 }, minimized: false, own: false };
  const saveDialog = { id: '78', title: 'Save As', className: '#32770', pid: 4242, bounds: { x: 600, y: 300, width: 500, height: 400 }, minimized: false, own: false };
  assert.equal(isNativeDialogWindow(openDialog, DESKTOP), true, 'a file-open dialog blocks the work');
  assert.equal(isNativeDialogWindow(saveDialog, DESKTOP), true, 'a save-as dialog blocks the work');
  assert.equal(isNativeDialogWindow({ ...openDialog, minimized: true }, DESKTOP), false, 'a minimized dialog is not in the way');
  assert.equal(isNativeDialogWindow({ ...openDialog, own: true }, DESKTOP), false, 'our own window is never a dialog');
});

test('a dialog detector without a demand never even scans', async () => {
  let scanned = 0;
  const run = {
    settings: { controlMode: 'agi' },
    observationDomain: 'browser',
    messages: [],
    nativeSurfaceSeen: new Set(),
    getComputerTools: () => ({
      scanWindows: async () => { scanned += 1; return { virtualDesktop: DESKTOP, windows: LIVE_WINDOWS }; }
    })
  };
  await DesktopChatAgent.prototype.deliverNativeSurfaceNotice.call({}, run);
  assert.equal(scanned, 0, 'the window list must not even be read without a demand');
  assert.equal(run.observationDomain, 'browser', 'the domain must not switch');
  assert.equal(run.messages.length, 0, 'no dialog notice may be produced');
});

test('after the agent asks for a dialog, a real dialog is announced', async () => {
  let scanned = 0;
  const run = {
    settings: { controlMode: 'agi' },
    observationDomain: 'browser',
    messages: [],
    nativeSurfaceSeen: new Set(),
    getComputerTools: () => ({
      scanWindows: async () => {
        scanned += 1;
        return {
          virtualDesktop: DESKTOP,
          windows: [...LIVE_WINDOWS, { id: '99', title: 'Open', className: '#32770', pid: 4242, bounds: { x: 600, y: 300, width: 500, height: 400 }, minimized: false, own: false }]
        };
      }
    })
  };
  expectNativeDialog(run, 'the agent asked for a file picker');
  assert.equal(nativeDialogExpected(run), true, 'the demand is armed');
  await DesktopChatAgent.prototype.deliverNativeSurfaceNotice.call({}, run);
  assert.equal(scanned, 1, 'the window list is read once a dialog is expected');
  assert.equal(run.observationDomain, 'computer', 'the domain switches to the desktop');
  const notice = run.messages.map((message) => String(message.content || '')).join('\n');
  assert.match(notice, /NATIVE DIALOG OPEN/, 'the dialog is announced');
  assert.match(notice, /windowId 99/, 'the dialog handle is named');
});

test('the demand is what arms the detector, and it is not free-floating', () => {
  const run = { nativeDialogExpectedUntil: 0 };
  assert.equal(nativeDialogExpected(run), false, 'no demand, no detection');
  expectNativeDialog(run, 'the task asks for a native dialog');
  assert.equal(nativeDialogExpected(run), true, 'an explicit demand arms it');
  assert.match(run.nativeDialogExpectedReason, /native dialog/);
  const expired = { nativeDialogExpectedUntil: Date.now() - 1 };
  assert.equal(nativeDialogExpected(expired), false, 'an expired demand closes the detector');
});

test('the native pointer refuses the harness window itself', () => {
  // A desktop click aimed at the Browser-use window raised the app in front
  // of the user and clicked in its own UI on tasks that had nothing to do
  // with the desktop.
  const worker = fs.readFileSync(path.join(process.cwd(), 'desktop/computer/nativeWorker.cjs'), 'utf8');
  assert.match(worker, /name === 'computer_pointer'[\s\S]{0,600}ownWindow\(/,
    'the pointer path must refuse the harness window');
  assert.match(worker, /The desktop pointer never drives the harness/,
    'the refusal must say why');
  const focus = worker.slice(worker.indexOf("if (name === 'computer_window') {"));
  assert.match(focus.slice(0, 4000), /parked outside the desktop/,
    'a window parked off the desktop must not be focused');
});

test('the model sees the windows it can drive, not the whole desktop', () => {
  // The live run's observe listed fifteen windows, most of them minimized
  // or parked off-screen. The agent read one of them as the dialog that
  // blocked its work. The visible ones stay; the hidden ones stay
  // addressable, compactly.
  const present = ComputerTools.prototype.presentWindows.call({}, {
    virtualDesktop: DESKTOP,
    windows: LIVE_WINDOWS
  });
  const titles = present.windows.map((window) => window.title);
  assert.ok(titles.includes('Browser-use'), 'our own window is listed');
  assert.ok(titles.includes('Program Manager'), 'a visible desktop window is listed');
  assert.ok(!titles.includes('MSN'), 'a window parked off the desktop is not listed');
  assert.ok(!titles.includes('new1.txt - Notepad++'), 'a minimized window is not listed');
  assert.equal(present.hiddenWindowCount, 3, 'the omitted windows are counted');
  const hidden = present.hiddenWindows.map((window) => window.title);
  assert.ok(hidden.includes('MSN'), 'the omitted window stays addressable by id');
  assert.ok(!present.hiddenWindows.some((window) => 'className' in window), 'the omitted list stays compact');
});

test('the index corpus is bounded and says so', () => {
  const tools = fs.readFileSync(path.join(process.cwd(), 'desktop/computer/computerTools.cjs'), 'utf8');
  assert.match(tools, /const INDEX_MAX_FILES = \d+/, 'the index has a file budget');
  assert.match(tools, /indexCapped \? \{ notice:/, 'a capped index reports the cap');
  assert.match(tools, /only the first \$\{INDEX_MAX_FILES\} were indexed/,
    'the notice names the budget and says the index is partial');
});
