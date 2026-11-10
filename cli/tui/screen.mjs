// cli/tui/screen.mjs
//
// Pure screen-mode detection + SGR mouse-event parsing for the browser-use
// TUI (Claude Code-tier full-screen renderer support). No I/O — unit-tested
// by cli/tui/tui.test.mjs.
//
// SCREEN MODES
//   'full'   — Ink 7 alternateScreen full-viewport app: persistent header,
//              windowed scrollable history, fixed live-run panel, composer,
//              pinned footer status bar; SGR mouse reporting (wheel scroll,
//              click-to-select on the completion/picker menu).
//   'inline' — the classic Ink Static layout (banner + scrolling history +
//              live composer), used when the terminal cannot host a
//              full-screen app or the owner opts out. The tests cover inline.
//
// MOUSE (Ink 7 has no built-in mouse support — documented honestly):
//   Ink's input parser tokenizes a complete CSI sequence and hands it to
//   useInput with the leading ESC stripped. An SGR mouse event therefore
//   arrives as e.g. '[<0;34;12M' (left press at col 34, row 12) —
//   parseMouseEvent decodes that shape. We enable ?1000h ?1002h ?1006h
//   (SGR + button-event tracking) ourselves on mount and disable on unmount.
//   HOVER (?1003h any-motion tracking) is opt-in at alt-screen boot via
//   BROWSER_USE_TUI_HOVER=1 and disabled ONCE at exit — NEVER toggled per
//   render (per-render control writes interleaved with ink's frame stream
//   and corrupted the banner). Button/wheel tracking stays enabled by default;
//   optional hover motion is change-gated into a no-op outside anchors.
//   Legacy X10 encoding ([M + 3 raw bytes) is NOT parsed — SGR is universal
//   in Windows Terminal, iTerm2, kitty, gnome-terminal, tmux.

/** Terminal escape sequences to enable / disable mouse reporting. */
export const MOUSE_ENABLE = '\x1b[?1000h\x1b[?1002h\x1b[?1006h';
export const MOUSE_DISABLE = '\x1b[?1000l\x1b[?1002l\x1b[?1006l';

/** Any-motion tracking (?1003): opt-in hover highlighting. */
export const MOTION_ENABLE = '\x1b[?1003h';
export const MOTION_DISABLE = '\x1b[?1003l';

/**
 * Decide the screen mode. Full-screen requires a REAL interactive TTY of
 * usable size; anything else (piped stdin/stdout, CI, dumb terminals, tiny
 * windows, BROWSER_USE_TUI_FULL=0) degrades to the inline renderer.
 */
export function detectScreenMode({ interactive, stdout, env = process.env } = {}) {
  if (interactive === false) return 'inline';
  if (String(env.BROWSER_USE_TUI_FULL || '').trim() === '0') return 'inline';
  if (String(env.BROWSER_USE_TUI_FULL || '').trim() === '1') return 'full';
  if (!stdout || !stdout.isTTY) return 'inline';
  if (env.CI) return 'inline';
  if (String(env.TERM || '').toLowerCase() === 'dumb') return 'inline';
  const rows = Number(stdout.rows);
  const cols = Number(stdout.columns);
  if (!Number.isFinite(rows) || !Number.isFinite(cols)) return 'inline';
  if (rows < 12 || cols < 60) return 'inline';
  return 'full';
}

/**
 * Decode one SGR mouse sequence as delivered by Ink's useInput (leading ESC
 * already stripped). Returns null for anything that is not a mouse event.
 *
 * Shapes: '[<b;x;yM' press · '[<b;x;ym' release — b: 0 left, 1 middle,
 * 2 right; +32 motion flag (button-event tracking); 64 wheel-up, 65 wheel-down.
 * x/y are 1-based terminal columns/rows.
 */
export function parseMouseEvent(value) {
  const match = /^\[<(\d+);(\d+);(\d+)([Mm])$/.exec(String(value ?? ''));
  if (!match) return null;
  const button = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const kind = match[4] === 'm' ? 'release' : 'press';
  if (button === 64) return { kind: 'wheel-up', x, y, button };
  if (button === 65) return { kind: 'wheel-down', x, y, button };
  // Motion flag (+32): button-event tracking (?1002) sends motion only while
  // a button is down (35 = 32+3 no-button motion arrives only under ?1003
  // any-motion tracking — the HOVER channel). Both decode as kind 'motion'.
  if (button & 32) return { kind: 'motion', x, y, button: button - 32 };
  return { kind, x, y, button };
}

/** True when the event is actionable: a left press or a wheel tick. */
export function isActionableMouse(event) {
  if (!event) return false;
  if (event.kind === 'wheel-up' || event.kind === 'wheel-down') return true;
  return event.kind === 'press' && event.button === 0;
}

/** True when the event is a hover motion (any-motion / button-event travel). */
export function isMotionEvent(event) {
  return Boolean(event) && event.kind === 'motion';
}
