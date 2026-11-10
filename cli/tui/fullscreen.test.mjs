// cli/tui/fullscreen.test.mjs
//
// node --test cli/tui/fullscreen.test.mjs
//
// The gen8 full-screen rebuild: screen-mode detection (cli/tui/screen.mjs),
// the pure history line model (cli/tui/historyView.mjs), and the
// FullScreenApp renderer (alt-screen framing, wheel scrolling, menu clicks,
// clean run card). The inline renderer's coverage stays in tui.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, cleanup } from 'ink-testing-library';
import { createCommandRegistry, makeCompleter } from './registry.mjs';
import { createTuiStore, pushHistory } from './store.mjs';
import { App } from './App.mjs';
import { detectScreenMode, parseMouseEvent, isActionableMouse, MOUSE_ENABLE, MOUSE_DISABLE } from './screen.mjs';
import { wrapText, entryToLines, historyToLines, windowLines } from './historyView.mjs';

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const h = React.createElement;

function fixtureRegistry() {
  const registry = createCommandRegistry();
  const commands = ['alpha', 'beta', 'galpha', 'cancel', 'clear', 'config', 'doctor', 'help', 'model', 'provider', 'trace'];
  for (const name of commands) {
    registry.register({ name, args: name === 'model' ? '<id>' : '', description: `the ${name} command`, handler: async () => {} });
  }
  return registry;
}

function fullFixtureController({ viewport = { rows: 24, cols: 80 }, onSubmit } = {}) {
  const registry = fixtureRegistry();
  const store = createTuiStore({
    session: {
      model: 'z-ai/glm-5.3-flash',
      providerId: 'xkiro',
      cwd: 'F:/somewhere/invocation-dir',
      maxSeconds: 0,
      outRoot: 'F:/somewhere/cli-runs'
    },
    history: []
  });
  const controller = {
    store,
    registry,
    completer: makeCompleter(registry),
    version: '0.3.6-test',
    screenMode: 'full',
    getViewport: () => viewport,
    getLineHistory: () => [],
    answerAsk: () => {},
    onCtrlC: () => {},
    onEscape: () => {},
    handleSubmit: (text) => {
      pushHistory(store, { kind: 'user', text });
      if (onSubmit) onSubmit(text, store);
    }
  };
  return { controller, store };
}

// ------------------------------------------------------------ screen.mjs ----
test('screen: detectScreenMode requires a real interactive TTY of usable size', () => {
  const tty = { isTTY: true, rows: 30, columns: 100 };
  assert.equal(detectScreenMode({ interactive: true, stdout: tty, env: {} }), 'full', 'real TTY -> full');
  assert.equal(detectScreenMode({ interactive: false, stdout: tty, env: {} }), 'inline', 'piped stdin -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: { isTTY: false, rows: 30, columns: 100 }, env: {} }), 'inline', 'piped stdout -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: tty, env: { CI: '1' } }), 'inline', 'CI -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: tty, env: { TERM: 'dumb' } }), 'inline', 'dumb term -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: tty, env: { BROWSER_USE_TUI_FULL: '0' } }), 'inline', 'explicit opt-out wins even on a TTY');
  assert.equal(detectScreenMode({ interactive: true, stdout: tty, env: { BROWSER_USE_TUI_FULL: '1' } }), 'full', 'explicit opt-in wins even off-TTY');
  assert.equal(detectScreenMode({ interactive: true, stdout: { isTTY: true, rows: 8, columns: 100 }, env: {} }), 'inline', 'too few rows -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: { isTTY: true, rows: 30, columns: 40 }, env: {} }), 'inline', 'too few columns -> inline');
  assert.equal(detectScreenMode({ interactive: true, stdout: { isTTY: true }, env: {} }), 'inline', 'unknown size -> inline');
});

test('screen: parseMouseEvent decodes SGR sequences exactly as Ink delivers them (leading ESC stripped)', () => {
  assert.deepEqual(parseMouseEvent('[<0;34;12M'), { kind: 'press', x: 34, y: 12, button: 0 });
  assert.deepEqual(parseMouseEvent('[<0;10;5m'), { kind: 'release', x: 10, y: 5, button: 0 });
  assert.deepEqual(parseMouseEvent('[<64;3;4M'), { kind: 'wheel-up', x: 3, y: 4, button: 64 });
  assert.deepEqual(parseMouseEvent('[<65;3;4M'), { kind: 'wheel-down', x: 3, y: 4, button: 65 });
  assert.deepEqual(parseMouseEvent('[<32;7;8M'), { kind: 'motion', x: 7, y: 8, button: 0 }, 'motion flag (+32) is never a click');
  assert.equal(parseMouseEvent('[<0;34;12X'), null, 'unknown final byte is not a mouse event');
  assert.equal(parseMouseEvent('a'), null, 'plain typing is not a mouse event');
  assert.equal(parseMouseEvent(''), null, 'empty is not a mouse event');
  assert.equal(isActionableMouse({ kind: 'press', button: 0 }), true, 'left press is actionable');
  assert.equal(isActionableMouse({ kind: 'press', button: 2 }), false, 'right press is ignored');
  assert.equal(isActionableMouse({ kind: 'release', button: 0 }), false, 'release is ignored (no double-fire)');
  assert.equal(isActionableMouse({ kind: 'wheel-up' }), true, 'wheel ticks are actionable');
  assert.ok(MOUSE_ENABLE.includes('\x1b[?1000h') && MOUSE_ENABLE.includes('\x1b[?1002h') && MOUSE_ENABLE.includes('\x1b[?1006h'), 'SGR + button-event enable sequence');
  assert.ok(MOUSE_DISABLE.includes('\x1b[?1000l') && MOUSE_DISABLE.includes('\x1b[?1002l') && MOUSE_DISABLE.includes('\x1b[?1006l'), 'mouse is ALWAYS restored on unmount');
});

// -------------------------------------------------------- historyView.mjs ---
test('historyView: wrapText word-wraps at the width, hard-breaks long words, honors newlines', () => {
  assert.deepEqual(wrapText('one two three four', 7), ['one two', 'three', 'four']);
  assert.deepEqual(wrapText('supercalifragilistic', 5), ['super', 'calif', 'ragil', 'istic'], 'long words hard-break');
  assert.deepEqual(wrapText('a\n\nb', 10), ['a', '', 'b'], 'explicit blank line survives');
  assert.deepEqual(wrapText('short', 40), ['short']);
});

test('historyView: entryToLines renders the shared shapes — plain user echo, rows table, clean runStart, no pid anywhere', () => {
  const W = 80;
  // User submissions render as right-aligned rounded cards, matching the
  // compact Textual reference UI rather than a left-prefixed transcript line.
  const user = entryToLines({ id: 1, kind: 'user', text: 'open the checkout page and buy shoes' }, W);
  assert.equal(user.length, 3, 'the card has top, body, and bottom rows');
  assert.match(user[0].segments.map((s) => s.text).join(''), /╭─+╮$/);
  assert.match(user[1].segments.map((s) => s.text).join(''), /open the checkout page and buy shoes/);
  assert.match(user[2].segments.map((s) => s.text).join(''), /╰─+╯$/);
  assert.match(user[0].key, /^u-1-top$/, 'deterministic entry-keyed lines');

  const runStart = entryToLines({ id: 2, kind: 'runStart', name: 'run-x', pid: 9584, outBase: 'run-x' }, W);
  const plain = (line) => line.segments.map((s) => s.text).join('');
    assert.doesNotMatch(runStart.map((l) => l.segments.map((sg) => sg.text).join('')).join('\n'), /▸ run run-x — started/, 'OWNER: no runStart name marker in history');
  assert.ok(runStart.length > 0, 'legacy runStart keeps a stable placeholder row');
  assert.doesNotMatch(plain(runStart[0]), /9584/, 'pid never renders in the line model either');
  assert.doesNotMatch(plain(runStart[0]), /->/, 'no out-dir plumbing');

  const rows = entryToLines({ id: 3, kind: 'rows', rows: [['/run <task>', 'start a run']] }, W);
  assert.equal(rows[0].segments[0].text, ' /run <task>  ', 'the two-space separator rides in the prefix (wrapText-safe)');
  assert.equal(rows[0].segments[1].text, 'start a run');
  assert.equal(rows[0].segments.map((s) => s.text).join(''), ' /run <task>  start a run', 'the joined line matches the inline renderer');

  // Long user text wraps inside the fixed-width card.
  const longUser = entryToLines({ id: 4, kind: 'user', text: 'word '.repeat(40).trim() }, W);
  assert.ok(longUser.length > 3, 'wrapped to multiple card rows');
  assert.match(longUser.at(-1).segments.map((s) => s.text).join(''), /╰─+╯/);
});

test('historyView: runSummary renders a bordered card with ONLY the reply, plus one dim economy line below', () => {
  const W = 90;
  const lines = entryToLines({ id: 9, kind: 'runSummary', summary: {
    name: 'run-x', outDir: 'F:/somewhere/run-x', status: 'completed', exitCode: 0,
    verified: true, decisions: 4, tools: 7, elapsedMs: 64000,
    reply: 'The order was placed and the confirmation page showed.'
  } }, W);
  const plain = (line) => line.segments.map((s) => s.text).join('');
  const all = lines.map(plain).join('\n');
  assert.match(all, /╭─+╮/, 'top border');
  assert.match(all, /╰─+╯/, 'bottom border');
  assert.match(all, /The order was placed and the confirmation page showed\./, 'the reply is the card content');
  // The card carries ONLY the reply — no name/status/verified/counts clutter.
  const bottomIdx = lines.findIndex((l) => /╰─+╯/.test(plain(l)));
  assert.ok(bottomIdx !== -1, 'bottom border present');
  const card = lines.slice(0, bottomIdx + 1).map(plain).join('\n');
  assert.doesNotMatch(card, /run-x|completed|verified|decisions|tools/, 'no name/status/verified/counts inside the card');
  // ONE dim economy line BELOW the card.
  assert.equal(lines.length, bottomIdx + 2, 'exactly one line below the card');
  assert.match(plain(lines[lines.length - 1]), /4 decisions · 7 tools · 1m04s/, 'the economy line carries counts + elapsed (no name/status)');

  const failed = entryToLines({ id: 10, kind: 'runSummary', summary: {
    name: 'run-y', outDir: 'F:/s/run-y', status: 'cancelled', exitCode: 2, verified: null,
    decisions: 0, tools: 0, elapsedMs: 74000, error: 'xKiro request failed (429): Rate limit exceeded'
  } }, W);
  const failedAll = failed.map(plain).join('\n');
  assert.match(failedAll, /✗ xKiro request failed \(429\): Rate limit exceeded/, 'failure reason renders in the card');
  assert.doesNotMatch(failedAll, /The order/, 'a failed run shows the error INSTEAD of a reply');
  assert.match(failedAll, /0 decisions · 0 tools · 1m14s/, 'the failed run economy line carries counts only');
});

test('historyView: windowLines windows from the bottom with a scroll offset', () => {
  const lines = historyToLines([
    { id: 1, kind: 'out', text: 'line-1' },
    { id: 2, kind: 'out', text: 'line-2' },
    { id: 3, kind: 'out', text: 'line-3' },
    { id: 4, kind: 'out', text: 'line-4' },
    { id: 5, kind: 'out', text: 'line-5' }
  ], 80);
  const textOf = (slice) => slice.map((l) => l.segments.map((s) => s.text).join(''));
  assert.deepEqual(textOf(windowLines(lines, 3, 0).slice), ['line-3', 'line-4', 'line-5'], 'offset 0 pins the newest');
  assert.deepEqual(textOf(windowLines(lines, 3, 2).slice), ['line-1', 'line-2', 'line-3'], 'scrolled back two lines');
  assert.equal(windowLines(lines, 3, 99).maxOffset, 2, 'maxOffset clamps the scroll range');
  assert.deepEqual(textOf(windowLines(lines, 10, 0).slice), textOf(lines), 'a taller viewport shows everything');
});

// --------------------------------------------------- FullScreenApp render ---
test('FullScreenApp: ONE framed layout — header with model + working repo, windowed history, prompt, footer', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  // 40 output lines: far more than the history window — proves the windowing.
  for (let i = 1; i <= 40; i += 1) pushHistory(store, { kind: 'out', text: `history line ${i}`, tone: 'dim' });
  const app = render(h(App, { controller }), { patchConsole: false });
  try {
    await tick(80);
    const frame = app.lastFrame() || '';
    assert.match(frame, /◈ BROWSER USE/, 'the header logo renders (ONE heading, no floating banner)');
    assert.match(frame, /model z-ai\/glm-5\.3-flash/, 'header shows the model');
    assert.match(frame, /repo /, 'header shows the working repo (defect 4: always visible)');
    assert.match(frame, /history line 40/, 'the NEWEST history line is visible');
    assert.doesNotMatch(frame, /history line 1(\D|$)/, 'old lines outside the window are NOT rendered (windowed)');
    assert.match(frame, /browser-use▸/, 'the composer prompt is framed in the same layout');
    const lineCount = frame.split('\n').length;
    assert.ok(lineCount <= 24, `the frame never exceeds the viewport (${lineCount} <= 24)`);
  } finally {
    app.unmount();
    cleanup();
  }
});

test('FullScreenApp: scroll wheel events page the history back and forward', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  for (let i = 1; i <= 60; i += 1) pushHistory(store, { kind: 'out', text: `scroll line ${i}`, tone: 'dim' });
  const app = render(h(App, { controller }), { patchConsole: false });
  try {
    await tick(80);
    let frame = app.lastFrame() || '';
    assert.match(frame, /scroll line 60/, 'pinned to the newest at offset 0');

    // Three wheel-up ticks: 3 lines per tick -> the newest visible is 60-9.
    for (let i = 0; i < 3; i += 1) { app.stdin.write('\x1b[<64;10;10M'); await tick(40); }
    frame = app.lastFrame() || '';
    assert.match(frame, /scroll line 51/, 'wheel-up scrolled back 9 lines');
    assert.doesNotMatch(frame, /scroll line 60/, 'the newest line scrolled out of the window');

    // Wheel back down to the bottom.
    for (let i = 0; i < 5; i += 1) { app.stdin.write('\x1b[<65;10;10M'); await tick(40); }
    frame = app.lastFrame() || '';
    assert.match(frame, /scroll line 60/, 'wheel-down returned to the pinned bottom');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('FullScreenApp: clicking a completion menu row selects AND executes it', async () => {
  const submitted = [];
  const { controller } = fullFixtureController({
    viewport: { rows: 24, cols: 80 },
    onSubmit: (text, store2) => {
      submitted.push(text);
      pushHistory(store2, { kind: 'out', text: `ran ${text}`, tone: 'ok' });
    }
  });
  const app = render(h(App, { controller }), { patchConsole: false });
  try {
    await tick(60);
    app.stdin.write('/');
    await tick(60);
    assert.match(app.lastFrame() || '', /\(1\/11\)/, 'the menu is open with all 11 commands');
    // Menu block: 5 visible option rows + 1 status row, directly above the
    // prompt (row 23) and footer (row 24) — options occupy rows 17..21
    // (1-based; the status row is 22). Click the FIRST option row.
    app.stdin.write('\x1b[<0;5;17M'); // left press, column 5, row 17
    await tick(80);
    assert.equal(submitted.length, 1, `a menu click executed the option (got: ${JSON.stringify(submitted)})`);
    assert.match(submitted[0], /^\/(cancel|clear|config|doctor|trace|help|model|provider|alpha|beta|galpha)$/, 'the clicked option dispatched');
    assert.doesNotMatch(app.lastFrame() || '', /\(1\/11\)/, 'the menu closed after the click executed');
  } finally {
    app.unmount();
    cleanup();
  }
});

test('FullScreenApp: an active run renders the fixed live card with the startup phase and NO pid', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 1234, startedAt: Date.now(), task: 'buy shoes', phase: 'resolving credentials…', inFlight: null, thinking: null, lastTool: null, lastError: null, tools: [] }
  }));
  const app = render(h(App, { controller }), { patchConsole: false });
  try {
    await tick(80);
    const frame = app.lastFrame() || '';
    assert.match(frame, /0\.0s/, 'the live card renders (economy-only meta)');
    assert.match(frame, /resolving credentials…/, 'DEFECT 3: the startup phase is visible immediately (no dead gap)');
    assert.doesNotMatch(frame, /pid 1234/, 'DEFECT 2: no pid plumbing in the live card');
    assert.match(frame, /esc cancels/, 'the cancel hint renders');
  } finally {
    app.unmount();
    cleanup();
  }
});

// ================= owner-fix round 2026-10-13 (render hygiene) ===============

test('FullScreenApp: ALL dynamic content renders ABOVE the composer sandwich; the footer stays static', async () => {
  const { controller, store } = fullFixtureController({ viewport: { rows: 24, cols: 80 } });
  // A live run with a queued message: the run card AND the queue count are
  // dynamic content — both must sit in the live region ABOVE the === bars.
  store.set((state) => ({
    ...state,
    run: { name: 'run-live', pid: 7, startedAt: Date.now(), task: 'first task', inFlight: 'deciding', thinking: null, lastTool: null, tools: [], queuedCount: 1 },
    subagents: [{ alias: 's1', label: 'subagent s1', task: 'scan', status: 'running', tail: { tools: [] } }]
  }));
  const app = render(h(App, { controller }), { patchConsole: false });
  try {
    await tick(120);
    const frame = app.lastFrame() || '';
    const lines = frame.split('\n');
    const barIdx = lines.map((l, i) => (/^[╭╰]─+[╮╯]$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
    assert.equal(barIdx.length, 2, 'exactly two composer bars');
    const firstBar = barIdx[0];
    const runCardAt = lines.findIndex((l) => l.includes('▸ run run-live'));
    const queuedAt = lines.findIndex((l) => l.includes('queued (1 total)'));
    const rosterAt = lines.findIndex((l) => l.includes('▸ subagent s1'));
    assert.ok(runCardAt !== -1 && runCardAt < firstBar, 'the live run card renders ABOVE the sandwich');
    assert.ok(queuedAt !== -1 && queuedAt < firstBar, 'the queue count renders ABOVE the sandwich');
    assert.ok(rosterAt !== -1 && rosterAt < firstBar, 'the subagent roster renders ABOVE the sandwich');
    // The footer (below the bars) is STATIC: session bits only — no spinner,
    // no elapsed, no queue count, no run line.
    const footer = lines[barIdx[1] + 1] || '';
    assert.match(footer, /model z-ai\/glm-5\.3-flash/, 'the footer carries the static session bits');
    assert.doesNotMatch(footer, /queued|▸ run|run-live/, 'no dynamic content below the sandwich');
    const belowBars = lines.slice(barIdx[1] + 1).join('\n');
    assert.doesNotMatch(belowBars, /queued \(1 total\)|▸ run run-live/, 'nothing dynamic leaked below the bars');
  } finally {
    app.unmount();
    cleanup();
  }
});
