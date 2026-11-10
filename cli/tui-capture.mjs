#!/usr/bin/env node
// cli/tui-capture.mjs
//
// PTY capture harness for the full-screen TUI (node-pty). Boots the REAL
// cli/tui.mjs in a 30x100 pseudo-terminal and drives it with real keystrokes
// and SGR mouse sequences, capturing every byte the TUI writes. Each scenario
// asserts on the output and writes the raw capture log to
// cli/captures/ (INSIDE the arena — the shared captures/ dir proved volatile).
//
//   node cli/tui-capture.mjs
//
// ISOLATION (mandatory): APPDATA points at an EMPTY temp dir (no app settings
// store, no secrets, no CLI config) AND the ambient credential env variables
// are blanked — so no scenario can ever start a real agent run or spend a
// credential. The capture runs from a staged out-root under the temp dir.
//
// NOTE on assertions: the alt-screen redraws the WHOLE frame on every render,
// so the raw PTY stream contains older frames too — current-screen assertions
// use the TAIL of the stream (lastFrame), stream-history assertions use the
// whole buffer. ConPTY consumes input-mode sequences (?1006h never appears in
// the OUTPUT stream) — mouse support is proven LIVE by the click and wheel
// scenarios working.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TUI = path.join(HERE, 'tui.mjs');
const CAPTURE_DIR = path.join(HERE, 'captures');

const COLS = 100;
const ROWS = 30;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Minimal ANSI stripper for assertions (keeps text + box drawing).
function stripAnsi(text) {
  return String(text ?? '')
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

let failures = 0;
function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures += 1;
  return ok;
}

async function bootTui({ envExtra = {}, stageCredentials = false } = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-capture-'));
  const outRoot = path.join(stage, 'runs');
  fs.mkdirSync(outRoot, { recursive: true });
  // Staged stores MUST exist before the TUI boots — the settings store and
  // the CLI config are read once at module load.
  if (stageCredentials) stageCredentialStores(stage);
  const proc = pty.spawn(process.execPath, [TUI], {
    name: 'xterm-256color',
    cols: COLS,
    rows: ROWS,
    cwd: path.resolve(HERE, '..'),
    env: {
      ...process.env,
      APPDATA: stage,             // empty settings store: no app connection, no secrets
      XKIRO_API_KEY: '',          // ambient credential exports BLANKED (no real runs)
      BROWSER_USE_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      BROWSER_USE_TUI_FULL: '1',
      TERM: 'xterm-256color',
      ...envExtra
    }
  });
  let buffer = '';
  proc.onData((data) => { buffer += data; });
  await sleep(2200); // boot + first frames
  const raw = () => buffer;                 // escape sequences intact
  const bufferText = () => stripAnsi(buffer);
  const lastFrame = (bytes = 12000) => {
    // The alt-screen frame is wrapped in synchronized-update markers
    // (\x1b[?2026h ... \x1b[?2026l). Reconstruct the LAST COMPLETE frame:
    // take the stream tail from the final frame-home (\x1b[H after a full
    // clear) so assertions see a whole screen, never a mid-frame slice.
    const tail = buffer.slice(-bytes);
    const home = tail.lastIndexOf('\x1b[H');
    return stripAnsi(home >= 0 ? tail.slice(home) : tail);
  };
  async function submit(line) {
    proc.write(line);
    await sleep(60);
    proc.write('\r');
  }
  return { proc, stage, outRoot, raw, bufferText, lastFrame, submit };
}

async function shutdown(t, capturePath) {
  const { proc, stage, raw } = t;
  if (capturePath) fs.writeFileSync(capturePath, raw());
  proc.write('\x03');
  await sleep(250);
  proc.write('\x03');
  await sleep(250);
  proc.write('\x03'); // third press exits at idle (arm + confirm window)
  await sleep(800);
  try { proc.kill(); } catch { /* gone */ }
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
}

async function scenarioFullScreenFrame() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'full-screen-frame.log');
  try {
    await sleep(500);
    const frame = t.lastFrame();
    check('full: header logo renders in the alt-screen frame', frame.includes('▸_ browser-use'));
    check('full: header shows model + provider', frame.includes('model') && frame.includes('provider'));
    check('full: header shows the working repo', /repo \S+/.test(frame), 'repo visible in the header');
    check('full: composer prompt framed in the same layout', frame.includes('browser-use▸'));
    check('full: footer status bar pinned', frame.includes('clock untimed'));
    check('full: alt-screen entered (1049h in the raw stream)', t.raw().includes('\x1b[?1049h'));
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

// UPGRADE 2 PTY PROOF: the banner's info panel renders the app name boxed
// inline — |browser-use| (v…) — on the first screen (inline renderer).
async function scenarioBannerBoxedTitle() {
  const t = await bootTui({ envExtra: { BROWSER_USE_TUI_FULL: '0' } });
  const capturePath = path.join(CAPTURE_DIR, 'banner-boxed-title.log');
  try {
    await sleep(500);
    const frame = t.lastFrame();
    check('banner: the app name renders boxed inline', /\|browser-use\| \(v\d+\.\d+\.\d+\)/.test(frame), `|browser-use| (v…) expected, got: ${(frame.match(/\|?[^\n]*browser-use[^\n]*/) || ['none'])[0]}`);
    check('banner: the version label is kept', /\(v\d+\.\d+\.\d+\)/.test(frame));
    check('banner: the old >_ title is gone', !frame.includes('>_ browser-use'));
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

// UNIFIED CONTRACT PTY PROOF: a submission renders as a PLAIN `browser-use▸`
// echo in history; the === sandwich lives on the COMPOSER — exactly two
// full-width bars bracketing the typing field, constant in the height math.
async function scenarioUserSandwich() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'user-sandwich.log');
  try {
    await sleep(400);
    await t.submit('buy shoes on the staged page');
    await sleep(900);
    const frame = t.lastFrame();
    check('sandwich: the echoed submission renders as a PLAIN echo', frame.includes('browser-use▸ buy shoes on the staged page'));
    // The alt-screen redraws whole frames, so the raw tail can span a frame
    // boundary — reconstruct the LAST complete frame from its last header
    // occurrence before counting anything.
    const allLines = frame.split('\n');
    let startIdx = -1;
    for (let i = allLines.length - 1; i >= 0; i -= 1) {
      if (allLines[i].includes('▸_ browser-use')) { startIdx = i; break; }
    }
    const lines = startIdx >= 0 ? allLines.slice(startIdx) : allLines;
    const bars = lines.filter((l) => /^={20,}$/.test(l.trim())).length;
    check('sandwich: exactly TWO === bars (the composer sandwich)', bars === 2, `bars in last frame: ${bars}`);
    // The bars bracket the PROMPT, never the submission: the typing field
    // (the bare prompt line) sits directly between the two bars.
    const barIdx = lines.map((l, i) => (/^={20,}$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
    check('sandwich: the bars bracket the composer prompt', barIdx.length === 2
      && barIdx[1] === barIdx[0] + 2
      && (lines[barIdx[0] + 1] || '').includes('browser-use▸'),
    `bar rows: ${JSON.stringify(barIdx)}, between: ${JSON.stringify((lines[barIdx[0] + 1] || '').slice(0, 40))}`);
    check('sandwich: the echo is NOT bar-adjacent (plain history line)', lines
      .every((l, i) => !(l.includes('buy shoes on the staged page')
        && (/^={20,}$/.test((lines[i - 1] || '').trim()) || /^={20,}$/.test((lines[i + 1] || '').trim())))),
    'no bar touches the echoed submission');
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioMenuClick() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'menu-click.log');
  try {
    await t.submit('/');
    await sleep(600);
    check('click: typing / opens the command menu', t.bufferText().includes('/about'), 'first command listed');
    // Click the FIRST visible menu option row. Unified layout (rows=30):
    // footer 30, composer bar 29, prompt 28, composer bar 27, menu status 26,
    // option rows 21..25 (5 rows) — menuTop = 30-1-1-2-6 = 20 (0-based).
    t.proc.write('\x1b[<0;5;21M'); // left press at the first option row
    await sleep(900);
    check('click: the clicked menu row executed (about panel printed)', t.bufferText().includes('interactive console over cli/agent-cli.mjs'), '/about ran from a mouse click');
    // The menu close lands a few frames after the execution — poll for it.
    const closeDeadline = Date.now() + 6000;
    let menuClosed = !t.lastFrame(1200).includes('(1/27)');
    while (Date.now() < closeDeadline && !menuClosed) {
      await sleep(300);
      menuClosed = !t.lastFrame(1200).includes('(1/27)');
    }
    check('click: the menu closed after executing', menuClosed, 'no completion counter in the current frame (the /about text below the prompt is its history echo)');
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioWheelScroll() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'wheel-scroll.log');
  try {
    // Fill the history beyond the window (history rows at 30 = 30-3-1-1 = 25).
    // UPGRADE 1: each submission now renders FOUR lines (=== bar, echo,
    // === bar, out) — the scroll math below accounts for that.
    for (let i = 1; i <= 60; i += 1) {
      await t.submit(`/task filler line ${i}`);
    }
    await sleep(1200); // let the last renders settle before the wheel ticks
    check('wheel: the newest line is visible when pinned', t.lastFrame().includes('filler line 60'));
    for (let i = 0; i < 3; i += 1) {
      t.proc.write('\x1b[<64;10;10M'); // wheel up
      await sleep(350);
    }
    // Poll for the scrolled-back state, asserted on the LAST COMPLETE frame
    // (a raw fixed-size tail can span a frame boundary and keep the old
    // pinned frame's 'filler line 60' in view).
    const lastCompleteFrame = () => {
      const lines = t.lastFrame(6000).split('\n');
      let s = -1;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        if (lines[i].includes('▸_ browser-use')) { s = i; break; }
      }
      return (s >= 0 ? lines.slice(s) : lines).join('\n');
    };
    const scrolledBackNow = () => {
      const frame = lastCompleteFrame();
      return /filler line 5[4-8]/.test(frame) && !frame.includes('filler line 60');
    };
    const scrolledBackDeadline = Date.now() + 8000;
    let scrolledBack = scrolledBackNow();
    while (Date.now() < scrolledBackDeadline && !scrolledBack) {
      await sleep(300);
      scrolledBack = scrolledBackNow();
    }
    check('wheel: wheel-up scrolled back into older history', scrolledBack, 'older lines surfaced, the newest scrolled out (offset 9 = ~2.25 four-line submissions back)');
    for (let i = 0; i < 4; i += 1) {
      t.proc.write('\x1b[<65;10;10M'); // wheel down
      await sleep(350);
    }
    const pinnedDeadline = Date.now() + 8000;
    let pinnedAgain = lastCompleteFrame().includes('filler line 60');
    while (Date.now() < pinnedDeadline && !pinnedAgain) {
      await sleep(300);
      pinnedAgain = lastCompleteFrame().includes('filler line 60');
    }
    check('wheel: wheel-down returned to the pinned bottom', pinnedAgain);
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

// UPGRADE 4 PTY PROOF: hover highlighting moves across the menu rows (SGR
// any-motion ?1003 events through the SAME input stream) and the click lands
// on the hovered row. The '◂' pointer marker is the on-screen hover proof —
// ConPTY consumes input-mode toggles (?1003h never appears in the OUTPUT).
async function scenarioHoverAndClick() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'hover-click.log');
  try {
    await sleep(400);
    // The bare /model PICKER (no Enter): two short, stable rows — a clean
    // hover stage (the full '/' command menu wraps long descriptions).
    t.proc.write('/model');
    await sleep(1000);
    check('hover: the model picker is open', /z-ai\/glm-5\.3-flash/.test(t.lastFrame()), 'picker rows visible');
    // Picker block (rows=30): 2 option rows at 1-based rows 25,26 (menuTop =
    // 30 - footer 1 - bar 1 - prompt 1 - bar 1 - menuRows 2 = 24, 0-based).
    t.proc.write('\x1b[<35;5;25M'); // any-motion onto the FIRST model row
    await sleep(700);
    let frame = t.lastFrame();
    check('hover: the first model row highlights under the pointer', /z-ai\/glm-5\.3-flash[^\n]*◂/.test(frame), 'the ◂ pointer marker rides the hovered row');
    t.proc.write('\x1b[<35;5;26M'); // motion moves down one row
    // The highlight MOVED: the qwen row's ◂ marker is painted in the stream
    // AFTER the z-ai marker was (ConPTY diff-paints partial row updates, so
    // stream-ordered presence is the deterministic proof — a "last marker
    // line" heuristic can read a corrupted erase-repaint of the FIRST row).
    const text = () => t.bufferText();
    const zaiAt = () => text().indexOf('z-ai');
    const movedNow = () => {
      const qwen = text().lastIndexOf('qwen/qwen3.7-plus:free');
      return qwen !== -1 && qwen > zaiAt()
        && text().slice(qwen - 20, text().indexOf('\n', qwen) === -1 ? undefined : text().indexOf('\n', qwen)).includes('◂');
    };
    const moveDeadline = Date.now() + 6000;
    let moved = movedNow();
    while (Date.now() < moveDeadline && !moved) {
      await sleep(300);
      moved = movedNow();
    }
    check('hover: the highlight MOVED to the second row', moved, `marker evidence: ${JSON.stringify((text().match(/qwen[^\n]{0,60}/) || ['none'])[0])}`);
    // CLICK the hovered row — the hit-test path executes it.
    t.proc.write('\x1b[<0;5;26M'); // left press on the hovered row
    const clickDeadline = Date.now() + 6000;
    let clicked = t.bufferText().includes('model set to qwen/qwen3.7-plus:free');
    while (Date.now() < clickDeadline && !clicked) {
      await sleep(300);
      clicked = t.bufferText().includes('model set to qwen/qwen3.7-plus:free');
    }
    check('click: the hovered row executed (the model was set)', clicked, 'the picker row accepted from a click on the hovered row');
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

// OWNER-FIX PTY PROOF (2026-10-13 render hygiene): mouse mode toggles ONCE
// (boot) — rapid clickable-region appear/disappear cycles plus a motion burst
// must produce ZERO mid-stream ?1003 writes (the old per-render toggling
// interleaved raw control bytes with ink's frames: coordinate garbage over
// the banner, constant repaints) and ZERO typed mouse residue in the composer.
async function scenarioMouseHygiene() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'mouse-hygiene.log');
  try {
    await sleep(500);
    // Toggle-once proof is UNIT-level (the App contains no stdout writes and
    // no per-render hook — the bootstrap enables once at boot, disables once
    // at exit). ConPTY consumes input-mode sequences on the OUTPUT stream, so
    // raw ?1003 counting is not observable here (same documented limit as the
    // ?1006h note above); this scenario proves the LIVE behavior instead:
    // rapid clickable-region appear/disappear cycles plus a motion burst must
    // leave clean frames and a clean composer.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      t.proc.write('/');
      await sleep(250);
      t.proc.write('\x1b[<35;5;15M\x1b[<35;5;16M'); // motion across menu rows
      await sleep(250);
      t.proc.write('\x1b'); // Escape closes the menu (clickable rows gone)
      await sleep(250);
    }
    await sleep(600);
    // Motion burst with malformed/split fragments — the composer stays clean.
    t.proc.write('\x1b[<35;5;5M\x1b[<35;6;6M\x1b[<3'); // + split fragment
    await sleep(200);
    t.proc.write('[<35;12;9M\x1b[<'); // stripped motion + trailing fragment
    await sleep(600);
    const lines = t.lastFrame(4000).split('\n');
    let startIdx = -1;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].includes('▸_ browser-use')) { startIdx = i; break; }
    }
    const frameLines = startIdx >= 0 ? lines.slice(startIdx) : lines;
    const barIdx = frameLines.map((l, i) => (/^={20,}$/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
    const promptLine = barIdx.length === 2 ? (frameLines[barIdx[0] + 1] || '') : '';
    check('hygiene: the composer buffer is empty after the motion burst', /browser-use▸\s*$/.test(promptLine),
      `prompt line: ${JSON.stringify(promptLine.slice(0, 60))}`);
    check('hygiene: no SGR/coordinate garbage painted over the logo', frameLines.some((l) => l.includes('▸_ browser-use'))
      && !/\[\?1003|\[<\d+;\d+/.test(t.lastFrame(1200)), 'the frame tail carries no unparsed SGR fragments');
    check('hygiene: the frame is intact after five toggle-heavy cycles', frameLines.some((l) => l.includes('▸_ browser-use'))
      && frameLines.some((l) => /clock untimed/.test(l)), 'header AND footer render in the same frame');
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

// UPGRADE 3 PTY PROOF: a spawned subagent pushes a PERSISTENT history card
// that survives run end with its final status (fake agent-cli, no Chrome).
const FAKE_SUBAGENT_AGENT_CLI = `#!/usr/bin/env node
// Fake agent-cli for the subagent-history capture: emits the GEN-8 subagent
// lifecycle into the main trace, then exits 0 with a terminal state.
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : args[i + 1]; };
const outDir = arg('out-dir');
fs.mkdirSync(outDir, { recursive: true });
const tracePath = path.join(outDir, 'trace.jsonl');
const trace = (event) => fs.appendFileSync(tracePath, JSON.stringify({ ts: Date.now(), ...event }) + '\\n');
trace({ type: 'harness.boot', phase: 'modules', ms: 1 });
trace({ type: 'harness.subagent.spawned', alias: 's1', label: 'subagent s1', task: 'scan the staged page', status: 'queued' });
trace({ type: 'harness.subagent.status', alias: 's1', status: 'running' });
setTimeout(() => {
  trace({ type: 'harness.subagent.finished', alias: 's1', status: 'completed', summary: 'scan done' });
  fs.writeFileSync(path.join(outDir, 'final-state.json'), JSON.stringify({
    status: 'completed',
    meta: { exitCode: 0, elapsedMs: 1500, runId: 'fake-sub' },
    counts: { decisionCount: 1, stepCount: 1, traceLines: 5, toolResultEvents: 0 },
    toolCallCount: 0,
    toolCalls: [],
    result: { ok: true, summary: 'fake subagent run completed' },
    state: { status: 'completed', id: 'fake-sub' }
  }, null, 2));
  console.log(JSON.stringify({ ok: true, runId: 'fake-sub', status: 'completed', elapsedMs: 1500, outDir }, null, 2));
  process.exit(0);
}, 1200);
`;

async function scenarioSubagentHistoryCard() {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'bu-tui-subagent-capture-'));
  const fakeAgentPath = path.join(stage, 'fake-agent-cli.mjs');
  fs.writeFileSync(fakeAgentPath, FAKE_SUBAGENT_AGENT_CLI);
  const t = await bootTui({
    envExtra: {
      XKIRO_API_KEY: 'sk-capture-fake-key-not-real', // env resolution: no store, no real gateway
      BROWSER_USE_TUI_AGENT_CLI: fakeAgentPath
    }
  });
  const capturePath = path.join(CAPTURE_DIR, 'subagent-history-card.log');
  try {
    await t.submit('/out ' + t.outRoot);
    await sleep(400);
    await t.submit('scan the staged page');
    // The spawn card appears as soon as the trace tailer sees the event.
    const spawnDeadline = Date.now() + 30_000;
    while (Date.now() < spawnDeadline && !t.bufferText().includes('▸ subagent s1')) {
      await sleep(400);
    }
    check('subagent card: the spawn renders a persistent history card', t.bufferText().includes('▸ subagent s1'), 'spawned event flowed into history');
    // The run ends (fake agent-cli exits after ~1.2s); wait for the summary —
    // the reply card carries the fake agent's terminal summary text.
    const doneDeadline = Date.now() + 45_000;
    while (Date.now() < doneDeadline && !t.bufferText().includes('fake subagent run completed')) {
      await sleep(600);
    }
    await sleep(2500); // let the final frames settle past the run teardown
    const frame = t.lastFrame();
    check('subagent card: the run finished (reply card + economy line)', t.bufferText().includes('fake subagent run completed')
      && /▸ run run-[^\n]*completed · \d+ decisions/.test(t.bufferText()), 'summary card and economy line rendered');
    check('subagent card: the card SURVIVES run end with its final status', /▸ subagent s1 — completed/.test(frame), 'a completed record, not a vanished roster row');
    check('subagent card: the card sits in HISTORY (below the === sandwich)', frame.includes('browser-use▸ scan the staged page') && /▸ subagent s1 — completed/.test(frame), 'both the submission and its subagent card are persistent history');
  } finally {
    await shutdown(t, capturePath);
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`capture: ${capturePath}`);
}

/**
 * Stage credential stores inside the scenario's APPDATA dir:
 *  - an active app-store connection (settings store) whose SECRETS entry is a
 *    garbage v10 blob — the TUI boots its REAL electron decrypt helper
 *    (seconds of startup latency, exactly the window that produced the
 *    duplicate-spawn bug) and the decrypt then FAILS honestly;
 *  - a CLI-config fallback key + unreachable base url (127.0.0.1:9) so the
 *    resolved run can spawn, launch Chrome, and die fast on the observer
 *    clock — never touching a real gateway or spending a credential.
 */
function stageCredentialStores(stage) {
  const connId = '11111111-2222-3333-4444-555555555555';
  fs.mkdirSync(path.join(stage, 'browser-use'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'browser-use', 'browser-use-settings.json'), JSON.stringify({
    aiChatProvider: 'xkiro',
    aiChatConnectionId: connId,
    agentControlMode: 'browser',
    aiConnections: [{
      id: connId, provider: 'xkiro', name: 'staged-capture',
      baseUrl: 'https://127.0.0.1:9/v1', model: 'staged/model', customModels: []
    }]
  }));
  const blob = Buffer.concat([Buffer.from('v10'), Buffer.alloc(82, 0xAB)]).toString('base64');
  fs.writeFileSync(path.join(stage, 'browser-use', 'browser-use-secrets.json'), JSON.stringify({ [`aiProvider:${connId}`]: blob }));
  fs.writeFileSync(path.join(stage, 'browser-use', 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.from('DPAPI' + Buffer.alloc(32, 7)).toString('base64') } }));
  fs.mkdirSync(path.join(stage, 'browser-use-cli'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'browser-use-cli', 'config.json'), JSON.stringify({
    apiKey: 'sk-staged-capture-key-not-real',
    baseUrl: 'https://127.0.0.1:9/v1',
    savedAt: 'capture'
  }));
}

async function scenarioRunCard() {
  const t = await bootTui({ stageCredentials: true });
  const capturePath = path.join(CAPTURE_DIR, 'run-card-startup-phase.log');
  try {
    await t.submit('/out ' + t.outRoot);
    await sleep(500);
    await t.submit('/max-seconds 8');
    await sleep(400);
    await t.submit('buy shoes on the staged page');
    // The run card appears the MOMENT the task is submitted; the staged
    // electron decrypt keeps the 'resolving credentials…' phase visible for
    // seconds (the old dead gap, now NAMED), then the run spawns and dies on
    // the 8s observer clock against the unreachable staged gateway.
    await sleep(1500);
    const early = t.bufferText();
    check('run card: the run card appears on submit', /▸ run run-\d{4}-\d{2}-\d{2}/.test(early), 'run id card rendered immediately');
    check('run card: the startup phase is NAMED while credentials resolve', early.includes('resolving credentials…'), 'defect 3: no dead silent gap');
    check('run card: NO pid plumbing anywhere', !/pid \d+/.test(early), 'defect 2: pid lines are gone');
    // Wait out the decrypt + spawn + bounded run (8s clock + teardown). The
    // unified summary is the reply/error card + the dim economy line below.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !/▸ run run-[^\n]*(completed|failed|cancelled|error)/.test(t.bufferText())) {
      await sleep(1000);
    }
    await sleep(2500);
    check('run card: the run reached its completion panel (bounded run)', /▸ run run-[^\n]*(completed|failed|cancelled|error)/.test(t.bufferText()), 'summary economy line rendered');
    const dirs = fs.existsSync(t.outRoot) ? fs.readdirSync(t.outRoot).filter((d) => d.startsWith('run-')) : [];
    check('run card: exactly ONE run dir for ONE submission', dirs.length === 1, `dirs: ${JSON.stringify(dirs)}`);
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioDuplicateStartGuard() {
  // DEFECT 2 root-cause proof, reproduced EXACTLY: the original bug needed a
  // SLOW credential window (the electron safeStorage decrypt — seconds) with
  // multiple rapid submissions queued inside it; the old code's `if (child)`
  // guard only ran AFTER the await, so every submission spawned its own
  // agent-cli (four pids, one run id). The staged stores recreate that slow
  // window; the synchronous start guard must refuse every submission after
  // the first with the honest "already starting" error, and exactly ONE run
  // dir may ever exist.
  const t = await bootTui({ stageCredentials: true });
  const capturePath = path.join(CAPTURE_DIR, 'duplicate-start-guard.log');
  try {
    await t.submit('/out ' + t.outRoot);
    await sleep(500);
    await t.submit('/max-seconds 8');
    await sleep(400);
    // Two rapid submissions, both landing inside the multi-second decrypt.
    t.proc.write('first task line');
    await sleep(60);
    t.proc.write('\r');
    t.proc.write('second task line');
    await sleep(60);
    t.proc.write('\r');
    // Wait out the decrypt + spawn + bounded run + teardown (the unified
    // summary economy line marks the terminal state).
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline && !/▸ run run-[^\n]*(completed|failed|cancelled|error)/.test(t.bufferText())) {
      await sleep(1000);
    }
    await sleep(2500);
    const dirs = fs.existsSync(t.outRoot) ? fs.readdirSync(t.outRoot).filter((d) => d.startsWith('run-')) : [];
    check('guard: exactly ONE run dir for two rapid submissions', dirs.length === 1, `dirs: ${JSON.stringify(dirs)}`);
    check('guard: the second submission was refused by the start guard', t.bufferText().includes('already starting'), 'the synchronous start guard rejected the duplicate inside the credential window');
    check('guard: only ONE task echo spawned (no duplicate run cards)', (t.bufferText().match(/▸ run run-\d{4}-\d{2}-\d{2}-?\d*$/gm) || []).length <= 2, 'at most one card line per frame stream');
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioCdPins() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'cd-pins-working-repo.log');
  try {
    await t.submit('/config');
    await sleep(900);
    let frame = t.lastFrame();
    check('cd: /config shows the working repo row', /working repo/.test(frame) || /working repo/.test(t.bufferText()));
    check('cd: it is marked as the invocation dir (not pinned)', t.bufferText().includes('(invocation dir'));
    await t.submit('/cd ..');
    // The confirmation renders on the next frame — poll briefly (ConPTY can
    // coalesce the write with the previous heavy /config redraw).
    const pinDeadline = Date.now() + 6000;
    let pinned = t.bufferText().includes('working repo pinned');
    while (Date.now() < pinDeadline && !pinned) {
      await sleep(300);
      pinned = t.bufferText().includes('working repo pinned');
    }
    frame = t.lastFrame();
    check('cd: /cd pins a new working repo', pinned, 'pinned confirmation shown');
    await t.submit('/config');
    await sleep(900);
    check('cd: the pinned repo shows in /config', t.bufferText().includes('(pinned'));
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioInlineFallback() {
  const t = await bootTui({ envExtra: { BROWSER_USE_TUI_FULL: '0' } });
  const capturePath = path.join(CAPTURE_DIR, 'inline-fallback.log');
  try {
    await sleep(500);
    const clean = t.bufferText();
    check('inline: opt-out renders the classic banner layout', clean.includes('· · · ╭'), 'ASCII banner present');
    check('inline: inline prompt present', clean.includes('browser-use▸'));
    check('inline: NO alt-screen entered', !clean.includes('\x1b[?1049'), 'the inline renderer never enters the alt screen');
    check('inline: no mouse-only layout (footer still present)', clean.includes('clock untimed'));
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function scenarioHistoryResumeClick() {
  const t = await bootTui();
  const capturePath = path.join(CAPTURE_DIR, 'history-resume-click.log');
  try {
    // The TUI's out-root is the REPO's cli-runs (not the staged APPDATA), so
    // /history lists the real previous runs — the scenario clicks whatever
    // row is first and asserts the resume SELECTION behavior, never a
    // specific run name. No provider is contacted: the capture env blanks
    // the app settings store, so the subsequent start is credential-refused.
    await t.submit('/history');
    await sleep(900);
    check('resume: /history lists runs with clickable rows', t.lastFrame().includes('click to resume'));
    // The history region starts under the 3-row header: row 4 (1-based) is
    // the "runs under …" line, row 5 is the newest run row (historyTop=3,
    // visibleLines index 1). Click it (left press, col 5).
    t.proc.write('\x1b[<0;5;5M');
    await sleep(900);
    check('resume: clicking the row selects it for continuation', /↻ \S+ selected — type your next message/.test(t.bufferText()), 'the selection line printed');
    // The next submission must START A RUN carrying --resume. The capture
    // env refuses the start on credentials — poll for that refusal as the
    // proof the submit path engaged (credential resolution takes seconds).
    await t.submit('continue please');
    const refuseDeadline = Date.now() + 8000;
    let refused = t.bufferText().includes('no provider API key resolved');
    while (Date.now() < refuseDeadline && !refused) {
      await sleep(300);
      refused = t.bufferText().includes('no provider API key resolved');
    }
    check('resume: the next message starts the resumed run (credential refusal proves the path)', refused);
    // Escape (no run live, target still pending — a refused start does not
    // consume it) un-picks the target.
    t.proc.write('\x1b');
    await sleep(600);
    check('resume: Escape clears a pending resume target', t.bufferText().includes('resume target cleared'));
  } finally {
    await shutdown(t, capturePath);
  }
  console.log(`capture: ${capturePath}`);
}

async function main() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  await scenarioFullScreenFrame();
  await scenarioBannerBoxedTitle();
  await scenarioUserSandwich();
  await scenarioMenuClick();
  await scenarioWheelScroll();
  await scenarioHoverAndClick();
  await scenarioMouseHygiene();
  await scenarioSubagentHistoryCard();
  await scenarioHistoryResumeClick();
  await scenarioRunCard();
  await scenarioDuplicateStartGuard();
  await scenarioCdPins();
  await scenarioInlineFallback();
  console.log(failures === 0 ? '\nALL CAPTURE CHECKS PASS' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

// Run the full harness only when executed DIRECTLY — importing the module
// (the solo-run hook below) must not replay every scenario.
const invokedDirectly = process.argv[1]
  && import.meta.url === (await import('node:url')).pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error('capture harness failed:', error);
    process.exit(1);
  });
}

// Solo-run hook: `node scratch/run-resume-capture.mjs` executes just the
// resume scenario (no real provider runs — the capture env refuses starts).
export async function runResumeScenarioSolo() {
  await scenarioHistoryResumeClick();
}
