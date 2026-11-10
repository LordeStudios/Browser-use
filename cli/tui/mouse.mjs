// cli/tui/mouse.mjs
//
// SGR mouse support for the browser-use alt-screen TUI (gen8 unification:
// ported from gen8-arch1, where it was hand-built and PTY-proven).
//
// Ink 7 (7.0.3) has NO mouse support at all — useInput never sees parsed
// mouse events — so this module implements the layer the TUI needs, ported
// read-only from the qwen-code fork (packages/cli/src/ui/utils/mouse.ts +
// list-mouse.ts + measure-element-position.ts, Apache-2.0) and trimmed to the
// subset the full-screen layout uses:
//
//   - enable/disable of SGR button-event tracking (?1002h) + SGR coordinates
//     (?1006h) on stdout (button events: press/release/wheel, no hover —
//     hover/any-motion ?1003h is opt-in at bootstrap through
//     BROWSER_USE_TUI_HOVER=1, see cli/tui/screen.mjs);
//   - parsing of SGR sequences (`\x1b[<btn;col;rowM|m`), including several
//     events batched into one stdin chunk (terminals coalesce motion+click);
//   - pure geometry to map a 1-based terminal mouse row onto the 0-based
//     layout row of the bottom-pinned alt-screen frame (frameAnchor), so a
//     click can be hit-tested against the App's frame-anchor map.
//
// What is deliberately NOT implemented (documented, not hidden): X10 encoding
// (`\x1b[M` + 3 raw bytes — SGR terminals only; the TUI filters X10-shaped
// garbage out of the composer either way, below). Ink cannot deliver per-cell
// hit targets anywhere it does not render, so the App hit-tests against its
// own deterministic fixed-height layout (the frame-anchor map).

// X10-encoded mouse events (terminal ignored ?1006h): \x1b[M + 3 raw bytes.
// eslint-disable-next-line no-control-regex
const X10_MOUSE_REGEX = /\x1b\[M[\s\S]{3}/g;

const ESC = '\x1b';

export const ENABLE_MOUSE_SGR = `${ESC}[?1002h${ESC}[?1006h`;
export const DISABLE_MOUSE_SGR = `${ESC}[?1006l${ESC}[?1002l`;

/** Turn on SGR button-event + coordinate tracking (no-op writes on failures). */
export function enableMouseEvents(stdout) {
  try { stdout.write(ENABLE_MOUSE_SGR); } catch { /* stream gone */ }
}

/** Turn SGR mouse tracking back off (must pair with enableMouseEvents). */
export function disableMouseEvents(stdout) {
  try { stdout.write(DISABLE_MOUSE_SGR); } catch { /* stream gone */ }
}

function eventName(buttonCode, isRelease) {
  if (buttonCode === 66) return 'scroll-left';
  if (buttonCode === 67) return 'scroll-right';
  if ((buttonCode & 64) === 64) return (buttonCode & 1) === 0 ? 'scroll-up' : 'scroll-down';
  if ((buttonCode & 32) !== 0) return 'move';
  const button = buttonCode & 3;
  const type = isRelease ? 'release' : 'press';
  if (button === 0) return `left-${type}`;
  if (button === 1) return `middle-${type}`;
  if (button === 2) return `right-${type}`;
  return null;
}

/**
 * Parse every SGR mouse event in a chunk. Accepts the raw wire form
 * (`\x1b[<0;10;5M`) AND the escape-stripped form ink's useInput hands over
 * (`[<0;10;5M` — ink strips the leading ESC from unrecognized sequences
 * before calling the handler), so one parser serves both paths.
 * Returns [] for non-mouse input (keystrokes, pastes, garbage).
 */
export function parseMouseEvents(chunk) {
  const text = String(chunk ?? '');
  if (!text.includes('[<') && !text.includes('[M')) return [];
  const events = [];
  // One pattern serves both wire forms: `\x1b[<0;10;5M` (raw chunk) and
  // `[<0;10;5M` (ink's escape-stripped useInput value).
  const pattern = /\[?<(\d+);(\d+);(\d+)([mM])/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const buttonCode = parseInt(match[1], 10);
    const name = eventName(buttonCode, match[4] === 'm');
    if (!name) continue;
    events.push({
      name,
      col: parseInt(match[2], 10),
      row: parseInt(match[3], 10),
      button: (buttonCode & 3) === 0 ? 'left' : (buttonCode & 3) === 1 ? 'middle' : (buttonCode & 3) === 2 ? 'right' : 'none'
    });
  }
  if (events.length === 0 && X10_MOUSE_REGEX.test(text)) {
    // X10-shaped garbage: recognized and swallowed (never typed into the
    // composer), but not decoded — SGR coordinates only.
    events.push({ name: 'x10-unsupported', col: 0, row: 0, button: 'none' });
  }
  return events;
}

/**
 * Absolute layout metrics of a mounted <Box>: position (x, y) by walking up
 * the yoga parent chain, plus width/height. In alternate-screen mode (x, y)
 * are viewport coordinates directly. Must be called from post-render code
 * (input handlers, effects) — returns zeroes during render.
 */
export function measureElementPosition(node) {
  if (!node || !node.yogaNode) return { x: 0, y: 0, width: 0, height: 0 };
  let x = node.yogaNode.getComputedLeft();
  let y = node.yogaNode.getComputedTop();
  let current = node.parentNode;
  while (current) {
    if (current.yogaNode) {
      x += current.yogaNode.getComputedLeft();
      y += current.yogaNode.getComputedTop();
    }
    current = current.parentNode;
  }
  return {
    x,
    y,
    width: node.yogaNode.getComputedWidth(),
    height: node.yogaNode.getComputedHeight()
  };
}

/** Height of the whole Ink live frame (the yoga root above `node`). */
export function measureFrameHeight(node) {
  let root = node;
  let current = node;
  while (current) {
    root = current;
    current = current.parentNode;
  }
  return root?.yogaNode?.getComputedHeight() ?? 0;
}

/**
 * The 0-based terminal row of the layout's top edge. Alt-screen frames are
 * bottom-pinned when they overflow: anchor = min(0, terminalHeight -
 * frameHeight) — negative values stay negative (top rows scrolled off).
 */
export function frameAnchor(terminalHeight, frameHeight) {
  return Math.min(0, terminalHeight - frameHeight);
}

/** 1-based terminal mouse row -> 0-based layout row via the frame anchor. */
export function terminalRowToLayoutRow(terminalRow1Based, anchor) {
  return terminalRow1Based - 1 - anchor;
}

/**
 * Hit-test a click against a list of row <Box> nodes (children of
 * `container`): returns the array index of the row containing the click, or
 * -1 when the click lands outside every row (scroll arrows, gaps, other
 * regions). Column is bounded by the container's x span.
 */
export function findRowHit(container, rowNodes, col, row, terminalHeight) {
  if (!container) return -1;
  const containerMetrics = measureElementPosition(container);
  if (col < containerMetrics.x || col >= containerMetrics.x + containerMetrics.width) return -1;
  const anchor = frameAnchor(terminalHeight, measureFrameHeight(container));
  const layoutRow = terminalRowToLayoutRow(row, anchor);
  for (let index = 0; index < rowNodes.length; index += 1) {
    const node = rowNodes[index];
    if (!node) continue;
    const metrics = measureElementPosition(node);
    if (layoutRow >= metrics.y && layoutRow < metrics.y + metrics.height) return index;
  }
  return -1;
}
