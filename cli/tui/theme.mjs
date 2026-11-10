// cli/tui/theme.mjs
//
// The browser-use TUI theme — the equivalent of Claude Code's orange and
// Qwen Code's blue: LIME #c8ff00 on the app's dark chrome.
//
// Palette source: the browser-use desktop app's own dark chrome, read from
// desktop/renderer/chrome-theme.css (`--bu-*` tokens) and the
// browser-use-expressive-settings skill's documented theme roles. The TUI no
// longer carries a lime-on-grey-green cast — every token maps to the app's
// teal-tinted dark chrome so the CLI and the desktop app read as one product.
//
// Token shape is ported from the qwen-code fork's theme system
// (F:/qwen-code-main/packages/cli/src/ui/themes/theme.ts ColorsTheme +
// semantic-tokens.ts SemanticColors): one flat ColorsTheme object with
// named color tokens, plus a semantic layer that maps roles (border,
// status, badges) onto them. Unlike qwen we have a single dark theme and
// no theme manager — the tokens are frozen module state, read directly by
// the Ink components in cli/tui/App.mjs.
//
// All values are truecolor hex; Ink maps them to 24-bit ANSI when the
// terminal supports it and degrades on its own. No 256-color assumptions.

export const limeTheme = {
  type: 'dark',
  // --- ColorsTheme-style base tokens (qwen shape) -------------------------
  Background: '#0D0F12',   // reference canvas / screen background
  Foreground: '#E9EDF3',   // primary text
  Dim: '#9299A6',          // footer and supporting text
  Gray: '#B8BEC9',         // card and secondary text
  Comment: '#626A78',      // quiet metadata
  Accent: '#C8FF00',       // lime prompt and active state
  AccentDim: '#A6D400',    // secondary lime
  // The reference uses pink for warnings/errors and cyan/purple for activity.
  Danger: '#FF36B8',
  Warn: '#FFB84A',
  Ok: '#C8FF00',
  Info: '#00D9FF',
  Border: '#292E37',
  BorderFocused: '#C8FF00'
};

export const theme = {
  get type() { return limeTheme.type; },
  get Background() { return limeTheme.Background; },
  get Foreground() { return limeTheme.Foreground; },
  get Dim() { return limeTheme.Dim; },
  get Gray() { return limeTheme.Gray; },
  get Comment() { return limeTheme.Comment; },
  get Accent() { return limeTheme.Accent; },
  get AccentDim() { return limeTheme.AccentDim; },
  get Danger() { return limeTheme.Danger; },
  get Warn() { return limeTheme.Warn; },
  get Ok() { return limeTheme.Ok; },
  get Info() { return limeTheme.Info; },
  get Border() { return limeTheme.Border; },
  get BorderFocused() { return limeTheme.BorderFocused; },

  // --- semantic roles (qwen semantic-tokens.ts equivalent) ----------------
  text: {
    primary: limeTheme.Foreground,
    secondary: limeTheme.Gray,
    accent: limeTheme.Accent,
    code: limeTheme.Info
  },
  border: {
    default: limeTheme.Border,
    focused: limeTheme.BorderFocused
  },
  status: {
    error: limeTheme.Danger,
    success: limeTheme.Ok,
    warning: limeTheme.Warn
  }
};

// ------------------------------------------------------------ helpers -----

/** Tone -> hex for history/notice text rendered by App.mjs. */
export function toneColor(tone) {
  switch (tone) {
    case 'dim': return theme.Gray;
    case 'faint': return theme.Comment;
    case 'ok': return theme.Ok;
    case 'warn': return theme.Warn;
    case 'err': return theme.Danger;
    case 'accent': return theme.Accent;
    case 'info': return theme.Info;
    default: return theme.text.primary;
  }
}

/** Run status -> color (completed green, cancelled amber, anything else red). */
export function statusColor(status) {
  const s = String(status || 'unknown');
  if (s === 'completed') return theme.Ok;
  if (s === 'cancelled' || s === 'awaiting_approval') return theme.Warn;
  return theme.Danger;
}

/** Exit code -> { label, color } badge (0 completed | 2 cancelled | 1 failed). */
export function successBadge(exitCode) {
  if (exitCode === 0) return { label: 'success', color: theme.Ok };
  if (exitCode === 2) return { label: 'cancelled', color: theme.Warn };
  return { label: 'failed', color: theme.Danger };
}

/** Tool name -> Claude Code-style one-glyph icon. Unknown tools get '▸'. */
const TOOL_ICONS = {
  browser_click: '✦',
  browser_scroll: '↕',
  browser_query: '?',
  browser_extract: '⇥',
  browser_screenshot: '☰',
  browser_navigate: '→',
  browser_new_tab: '+',
  browser_close_tab: '×',
  browser_type: '⌨',
  browser_key: '⌨',
  browser_gesture: '✧',
  browser_dom_snapshot: '☰',
  browser_console_entries: '≡',
  browser_network_entries: '≡',
  browser_fetch: '⇄',
  browser_search: '⌕',
  browser_wait: '…',
  computer_terminal: '❯',
  computer_read: '☰',
  computer_write: '✎',
  computer_patch: '✎',
  computer_search: '⌕',
  computer_fs: '▤',
  computer_git: '⑂',
  computer_screenshot: '☰',
  computer_observe: '◉',
  computer_pointer: '➤',
  computer_keyboard: '⌨',
  computer_stroke: '✧'
};

export function toolIcon(tool) {
  const name = String(tool || '');
  if (TOOL_ICONS[name]) return TOOL_ICONS[name];
  if (name.startsWith('browser_')) return '·';
  if (name.startsWith('computer_')) return '·';
  if (name.startsWith('harness.')) return '⚙';
  return '▸';
}

/** ok/fail/null -> badge text + color for a finished tool call. */
export function toolBadge(ok) {
  if (ok === true) return { label: 'ok', color: theme.Ok };
  if (ok === false) return { label: 'FAIL', color: theme.Danger };
  return { label: '—', color: theme.Gray };
}

/** Human elapsed: ms -> '12.3s' / '1m04s' (— for null; negative clamps to 0). */
export function formatElapsed(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 0) ms = 0; // stale clock tick between run start and the next now-poll
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}
