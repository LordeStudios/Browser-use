// cli/tui/App.mjs
//
// The Ink app for the browser-use TUI — the Claude Code / Qwen Code graphics
// tier. No JSX (Node cannot transform it): every element is built with
// `h = React.createElement`, so the entry stays zero-build.
//
// TWO SCREEN MODES (cli/tui/screen.mjs picks; cli/tui.mjs passes the mode):
//
//   FULL ('full') — FullScreenApp: the premium alt-screen renderer. Ink 7's
//     alternateScreen hosts ONE framed layout: persistent header (logo +
//     model + working repo), a windowed scrollable history region
//     (cli/tui/historyView.mjs line model), a fixed live-run card, the
//     completion/picker menu, the composer and a pinned footer status bar —
//     no floating fragments. SGR mouse reporting is enabled: wheel scrolls
//     history, clicking a menu row selects + executes it. (Ink 7 has no
//     built-in mouse support; the SGR parsing lives in screen.mjs.)
//
//   INLINE ('inline') — the classic Static layout (banner + scrolling
//     history + live composer), used when the terminal cannot host a
//     full-screen app (piped streams, CI, dumb term, tiny windows) or the
//     owner opts out with BROWSER_USE_TUI_FULL=0. The tests cover inline.
//
// Layout ports (studied read-only from the qwen-code fork):
//   - App shell / DefaultAppLayout: header on top, main content, composer
//     controls, footer pinned at the bottom (layouts/DefaultAppLayout.tsx).
//   - Header: ASCII logo + bordered info panel with title, version and hints
//     (components/Header.tsx).
//   - Completion popup: SuggestionsDisplay — '> ' active marker, a scroll
//     window with ▲/▼ overflow markers and an (n/total) counter, label column
//     + dim description column (components/SuggestionsDisplay.tsx).
//   - Completion navigation semantics: arrows move the selection, TAB accepts
//     into the buffer, Enter accepts and (for zero-arg commands) executes —
//     mirroring qwen InputPrompt's perfect-match submit rule.
//   - Footer: one-line dim status bar (components/Footer.tsx).
//
// The theme is cli/tui/theme.mjs (qwen token shape, lime accent). All
// rendering state flows through the store (cli/tui/store.mjs); keyboard
// editing state lives in a ref so useInput always sees fresh values.

import path from 'node:path';
import React, { useRef, useState, useMemo, useEffect, useSyncExternalStore, useReducer } from 'react';
import { Box, Text, Static, useInput, useStdout } from 'ink';
import Spinner from 'ink-spinner';
import { theme, toneColor, statusColor, successBadge, toolIcon, toolBadge, formatElapsed } from './theme.mjs';
import { pricingHint } from './appConfig.mjs';
import { LIVE_TOOL_LINES } from './store.mjs';
import { historyToLines, windowLines } from './historyView.mjs';
import { parseMouseEvent, isActionableMouse, isMotionEvent } from './screen.mjs';
import { parseMouseEvents } from './mouse.mjs';

const h = React.createElement;

// Max rows visible in the completion popup before it scrolls (qwen shows 5).
const MAX_MENU_ROWS = 5;
// Full-screen fixed region heights (rows). Every region has a FIXED height so
// the layout never reflows mid-run and mouse row-mapping stays exact.
const HEADER_ROWS = 3;       // logo, session context, and one separator rule
const RUN_PANEL_ROWS = 5;    // live run card (fixed even when sparse)
const PROMPT_ROWS = 2;       // MESSAGE label + composer input row
const FOOTER_ROWS = 1;
const COMPOSER_BARS = 2;     // the composer === sandwich bars (constant rows)
const SCROLL_WHEEL_STEP = 3; // lines per wheel tick
const PAGE_STEP = 10;        // lines per PgUp/PgDn
const MAX_ROSTER_ROWS = 3;   // live subagent switcher rows (FEATURE B)

// The actual browser-use logo (C:/Users/Administrator/Desktop/browser use .svg),
// hand-crafted as monospace ASCII (directive 2026-10-13): the lime stylized B
// mark — rounded spine with the three lens dots on the left, the open counter
// (two rounded bowls), and the play/cursor triangle riding the right edge.
// Rendered in the theme's lime (#c8ff00 = theme.Accent) by <Banner>.
const BANNER_LINES = [
  '  ◈  browser-use',
  '  ├─ control deck',
  '  └─ browser automation agent'
];

function truncate(text, width) {
  const t = String(text ?? '');
  if (t.length <= width) return t;
  return width > 1 ? `${t.slice(0, Math.max(1, width - 1))}…` : t.slice(0, Math.max(0, width));
}

function baseName(value) {
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || String(value || '');
}

/**
 * Map a cli/tui/mouse.mjs parsed event onto the screen.mjs event kinds the
 * composer acts on. Returns null for everything inert (releases — no
 * double-fire — right/middle buttons, x10 garbage).
 */
function mouseEventKind(ev) {
  if (!ev) return null;
  if (ev.name === 'scroll-up') return { kind: 'wheel-up', x: ev.col, y: ev.row, button: 64 };
  if (ev.name === 'scroll-down') return { kind: 'wheel-down', x: ev.col, y: ev.row, button: 65 };
  if (ev.name === 'left-press') return { kind: 'press', x: ev.col, y: ev.row, button: 0 };
  if (ev.name === 'move') return { kind: 'motion', x: ev.col, y: ev.row, button: 0 };
  return null;
}

/** Strip bracketed-paste wrappers (\x1b[200~ … \x1b[201~) — gen8-arch1 port. */
function stripBracketedPaste(value) {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/\x1b?\[200~/g, '').replace(/\x1b?\[201~/g, '');
}

// ------------------------------------------------------------- header -----
// (inline renderer)

function Banner({ version }) {
  // The inline header is intentionally compact: one recognizable mark, one
  // product descriptor, and one useful next action. It keeps the conversation
  // visible instead of spending six rows on decorative ASCII art.
  return h(Box, { flexDirection: 'column', alignItems: 'flex-start', paddingLeft: 2, paddingTop: 0, paddingBottom: 1 },
    h(Text, { bold: true, color: theme.Accent }, BANNER_LINES[0]),
    h(Text, null,
      h(Text, { color: theme.AccentDim }, '  ├─ '),
      h(Text, { color: theme.text.secondary }, `v${version}`),
      h(Text, { color: theme.Comment }, '  ·  '),
      h(Text, { color: theme.text.secondary }, BANNER_LINES[1].slice(5))),
    h(Text, null,
      h(Text, { color: theme.AccentDim }, '  └─ '),
      h(Text, { color: theme.text.secondary }, '/help for commands'),
      h(Text, { color: theme.Comment }, '  ·  '),
      h(Text, { color: theme.text.secondary }, '/ + TAB to filter'))
  );
}

// The banner is the FIRST Static entry (defect fix): it used to live in the
// re-rendered section below <Static>, so once history grew, run output pushed
// the ASCII logo and info panel DOWN below the history — the header visibly
// migrated. As a Static entry it renders above every history line and never
// moves, exactly like the Claude Code / qwen-code headers.
function BannerEntry({ version }) {
  return h(Banner, { version });
}

// ------------------------------------------------------------ history -----
// (inline renderer — full-screen renders the same entries through
// cli/tui/historyView.mjs)

function RunSummary({ summary }) {
  // UNIFIED CONTRACT (gen8): the bordered card contains ONLY the reply text —
  // a failed run shows the ✗ error instead — and ONE dim economy line runs
  // BELOW the card (`N decisions · N tools · elapsed`). No name/status/
  // verified clutter inside the card.
  const reply = typeof summary.reply === 'string' && summary.reply.trim()
    ? String(summary.reply).slice(0, 1500)
    : (typeof summary.result === 'string' && summary.result.trim()
      ? String(summary.result).slice(0, 1500)
      : null);
  return h(Box, { flexDirection: 'column', marginTop: 0 },
    h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: theme.Border, paddingX: 1 },
      summary.error
        ? h(Box, { flexDirection: 'column' },
          h(Text, null,
            h(Text, { bold: true, color: theme.Danger }, ' ✗ '),
            h(Text, { color: theme.Danger }, String(summary.error).slice(0, 220))))
        : (reply
          ? h(Text, { color: theme.text.primary }, reply)
          : h(Text, { color: theme.Comment }, String(summary.status || 'unknown')))),
    h(Text, { color: theme.Dim }, ` ${summary.decisions ?? '—'} decisions · ${summary.tools ?? '—'} tools · ${formatElapsed(summary.elapsedMs)}`));
}

function ToolsDigest({ calls }) {
  if (!Array.isArray(calls) || calls.length === 0) return null;
  const rows = calls.slice(0, 12);
  return h(Box, { flexDirection: 'column', marginTop: 0 },
    ...rows.map((call) => {
      const badge = toolBadge(call.ok);
      return h(Text, { key: `${call.tool}-${call.ts ?? ''}` },
        h(Text, { color: theme.AccentDim }, `  ${toolIcon(call.tool)} `),
        h(Text, { color: theme.text.primary }, String(call.tool || '—')),
        h(Text, { color: theme.text.secondary },
          `  ${call.durationMs != null ? `${call.durationMs}ms` : '—'}`),
        h(Text, { color: badge.color }, `  [${badge.label}]`));
    }),
    calls.length > rows.length
      ? h(Text, { color: theme.text.secondary }, `  … and ${calls.length - rows.length} more`)
      : null
  );
}

function HistoryItem({ entry, subagents }) {
  switch (entry.kind) {
    case 'user':
      return h(Box, { flexDirection: 'row', justifyContent: 'flex-end', width: '100%', marginTop: 1, marginBottom: 1 },
        h(Box, {
          borderStyle: 'round',
          borderColor: '#292E37',
          backgroundColor: '#171A20',
          paddingX: 1,
          width: '75%'
        }, h(Text, { color: '#B8BEC9' }, entry.text)));
    case 'subagent': {
      // UPGRADE 3: persistent card — status follows the LIVE subagent record
      // while the run is active, and the card survives run end.
      const live = (Array.isArray(subagents) ? subagents : []).find((sub) => sub.alias === entry.alias);
      const status = String((live && live.status) || entry.status || 'queued');
      return h(Text, null,
        h(Text, { bold: true, color: theme.Accent }, ` ▸ subagent ${entry.alias} `),
        h(Text, { color: theme.text.secondary }, `— ${status}`));
    }
    case 'out':
      return h(Text, { color: toneColor(entry.tone) }, entry.text);
    case 'rows':
      // Two-column table (used by /help and /config): accent left column,
      // dim right column — the qwen help-list look. A two-space separator
      // keeps unpadded left columns (/config) from running into the right.
      return h(Box, { flexDirection: 'column' },
        ...entry.rows.map(([left, right], i) => h(Text, { key: `${entry.id}-${i}` },
          h(Text, { color: theme.Accent }, ` ${left}`),
          h(Text, { color: theme.text.secondary }, `  ${right}`))),
        entry.tips
          ? h(Text, { color: theme.Comment }, ` ${entry.tips}`)
          : null);
    case 'runStart':
      // The live panel is the single source of truth for an active run. Ignore
      // legacy history markers so a replayed/stale runStart cannot duplicate it.
      return null;
    case 'runSummary':
      return h(Box, { flexDirection: 'column' }, h(RunSummary, { summary: entry.summary }),
        entry.calls ? h(ToolsDigest, { calls: entry.calls }) : null);
    case 'queued':
      // Mid-run submissions queue (desktop parity) — dim card, delivers when
      // the current run finishes.
      return h(Text, null,
        h(Text, { color: theme.Comment, bold: true }, ' ▸ queued'),
        h(Text, { color: theme.Comment }, ` — ${entry.text || ''}`));
    case 'contStart':
      return h(Text, null,
        h(Text, { bold: true, color: theme.Accent }, ' ▸ continuation'),
        h(Text, { color: theme.text.secondary }, ` — ${entry.text || ''}`));
    case 'tools':
      return h(ToolsDigest, { calls: entry.calls });
    default:
      return h(Text, null, entry.text || '');
  }
}

// ------------------------------------------------------ completion menu ---
// Shared by both modes. `variant="inline"` renders qwen's ▲/▼ markers and the
// (n/total) counter inside the flow; `variant="full"` renders an exact
// `visibleRows` window (fixed-height layout) plus a one-row status line.

function CompletionMenu({ items, activeIndex, scrollOffset, fragment, variant = 'inline', visibleRows = MAX_MENU_ROWS, hoverIndex = null }) {
  const start = scrollOffset;
  const visibleCount = variant === 'full' ? Math.min(visibleRows, items.length) : Math.min(MAX_MENU_ROWS, items.length);
  const end = Math.min(start + visibleCount, items.length);
  const visible = items.slice(start, end);
  return h(Box, { flexDirection: 'column', paddingLeft: 2 },
    variant === 'inline' && start > 0 ? h(Text, { color: theme.text.primary }, '▲') : null,
    visible.map((item, index) => {
      const originalIndex = start + index;
      const isActive = originalIndex === activeIndex;
      const isHovered = hoverIndex !== null && originalIndex === hoverIndex;
      const textColor = isActive ? theme.Accent : theme.text.secondary;
      return h(Box, { key: item.value, flexDirection: 'row' },
        h(Box, { width: 2, flexShrink: 0 },
          h(Text, { color: textColor }, isActive ? '> ' : '  ')),
        h(Box, { flexShrink: 0 },
          h(Text, { color: textColor, bold: isActive }, item.label)),
        item.hint
          ? h(Text, { color: theme.Comment }, ` ${item.hint}`)
          : null,
        item.description
          ? h(Box, { paddingLeft: 2, flexGrow: 1 },
            h(Text, { color: textColor }, item.description))
          : null,
        isHovered ? h(Text, { color: theme.Accent, bold: true }, ' ◂') : null);
    }),
    variant === 'inline' && end < items.length ? h(Text, { color: theme.text.secondary }, '▼') : null,
    items.length > (variant === 'full' ? visibleCount : MAX_MENU_ROWS)
      ? h(Text, { color: theme.Comment }, `(${activeIndex + 1}/${items.length})`)
      : null
  );
}

// ---------------------------------------------------------- live run ------

function ActivityMark({ category = 'browser' }) {
  const marks = {
    browser: ['◉', theme.Info],
    click: ['↳', '#A66BFF'],
    success: ['✓', theme.Accent],
    warning: ['!', theme.Danger],
    info: ['·', theme.Dim]
  };
  const [mark, color] = marks[category] || marks.info;
  return h(Text, { color, bold: true }, `${mark} `);
}

const LiveElapsed = React.memo(function LiveElapsed({ startedAt, color = theme.text.secondary }) {
  // Start at the run's timestamp so the first stable frame is deterministic;
  // the one-second tick immediately takes over without a parent repaint.
  const [now, setNow] = useState(() => startedAt);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return h(Text, { color }, ` ${formatElapsed(now - startedAt)}`);
});

function LiveRun({ run }) {
  const tools = Array.isArray(run.tools) ? run.tools.slice(-LIVE_TOOL_LINES) : [];
  return h(Box, {
    flexDirection: 'column',
    borderStyle: 'single',
    borderColor: theme.border.default,
    paddingX: 1,
    alignSelf: 'flex-start'
  },
    h(Text, null,
      h(Text, { bold: true, color: theme.Accent }, `▸ run ${run.name}`),
      h(LiveElapsed, { startedAt: run.startedAt }),
      h(Text, { color: theme.Comment }, `  ${String(run.task || '').slice(0, 60)}`)),
    // Startup phase (defect 3): the card appears the MOMENT the task is
    // submitted and names the honest startup phase — no dead 5s gap.
    run.phase
      ? h(Text, null,
        h(Spinner, { type: 'dots' }),
        h(Text, { color: theme.Accent }, ` ${run.phase}`))
      : h(Text, null,
        h(Spinner, { type: 'dots' }),
        h(Text, { color: theme.Comment }, ' working')),
    // Mid-run queue (desktop parity): submissions typed while the run is
    // active show as queued (k total) — they deliver as continuations.
    Number(run.queuedCount) > 0
      ? h(Text, { color: theme.Comment }, ` queued (${Number(run.queuedCount)} total)`)
      : null,
    ...tools.map((call, i) => {
      const badge = toolBadge(call.ok);
      const done = call.ok === true || call.ok === false;
      return h(Text, { key: `${call.tool}-${i}-${call.ts ?? ''}` },
        h(Text, { color: done ? theme.AccentDim : theme.Comment }, `${toolIcon(call.tool)} `),
        h(Text, { color: done ? theme.text.primary : theme.Comment }, String(call.tool || '—')),
        h(Text, { color: theme.text.secondary },
          `${call.durationMs != null ? ` ${call.durationMs}ms` : ''}`),
        done ? h(Text, { color: badge.color }, `  [${badge.label}]`) : null);
    }),
    // DEFECT 3b: connection errors surface the moment they occur (the trace's
    // assistant.message run.recovery.lastError) — instead of only spinning
    // "deciding in flight…" while every model call 402/429s.
    run.lastError
      ? h(Text, null,
        h(Text, { bold: true, color: theme.Danger }, ' ✗ '),
        h(Text, { color: theme.Danger }, String(run.lastError).slice(0, 110)))
      : null,
    run.inFlight
      ? h(Text, null,
        h(Spinner, { type: 'dots' }),
        h(Text, { color: theme.Accent }, ` ${run.inFlight}`),
        h(Text, { color: theme.Comment }, ' in flight…'))
      : h(Text, null,
        h(Spinner, { type: 'dots' }),
        h(Text, { color: theme.Comment }, ' working')),
    run.thinking
      ? h(Text, { color: theme.Comment }, `  ${String(run.thinking).slice(0, 90)}`)
      : null);
}

// ------------------------------------------------------------ footer ------

function sessionStatusBits(session) {
  const outLabel = baseName(session.outRoot);
  return [
    `model ${session.model}`,
    `provider ${session.providerId}`,
    `repo ${session.cwd ? baseName(session.cwd) : '(unset)'}`, // full path lives in the header
    session.headed ? 'headed' : 'headless',
    `clock ${session.maxSeconds > 0 ? `${session.maxSeconds}s` : 'untimed'}`,
    `out ${outLabel}`
  ];
}

function Footer({ state }) {
  const run = state.run;
  return h(Box, { flexDirection: 'row', paddingLeft: 2, paddingTop: 0 },
    run
      ? h(Text, null,
        h(Spinner, { type: 'dots' }),
        h(LiveElapsed, { startedAt: run.startedAt, color: theme.Accent }),
        h(Text, { color: theme.text.secondary },
          ` ${run.lastTool ? `last tool ${run.lastTool}` : (run.phase || 'starting')} · `))
      : null,
    h(Text, { color: theme.Dim }, ` ${sessionStatusBits(state.session).join(' · ')}`)
  );
}

// ------------------------------------------------------------- input ------

function BlinkingCaret() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setVisible((value) => !value), 520);
    return () => clearInterval(timer);
  }, []);
  return h(Text, { color: visible ? theme.Accent : theme.Comment, bold: true }, visible ? '▏' : ' ');
}

function renderPromptLine({ text, cursor, question, width = 80 }) {
  const before = text.slice(0, cursor);
  const at = text[cursor] ?? '';
  const after = text.slice(cursor + 1);
  const prefixLength = question ? String(question).length : 'browser-use▸ '.length;
  const available = Math.max(3, Number(width) - prefixLength - 1);
  const clippedBefore = before.slice(Math.max(0, before.length - Math.floor(available * 0.65)));
  const clippedAfter = after.slice(0, Math.max(0, available - clippedBefore.length));
  const segments = [];
  if (question) {
    segments.push(h(Text, { key: 'q', bold: true, color: theme.Warn }, question));
  } else {
    segments.push(h(Text, { key: 'p', bold: true, color: theme.Accent }, 'browser-use▸ '));
  }
  segments.push(h(Text, { key: 'b', color: theme.text.primary }, clippedBefore));
  // The composer intentionally has no painted cursor/highlight; its outline
  // is the focus treatment and the text field remains visually quiet.
  if (at) segments.push(h(Text, { key: 'c-text', color: theme.text.primary }, at));
  segments.push(h(BlinkingCaret, { key: 'caret' }));
  segments.push(h(Text, { key: 'a', color: theme.text.primary }, clippedAfter));
  return segments;
}

// ----------------------------------------------------- composer hook ------
// The keyboard/editing engine shared by BOTH screen modes: buffer + cursor in
// a ref (useInput handlers must always read fresh values), the command
// completer menu, the bare-/model picker menu, history recall, paste
// splitting, and the escape/ctrl+c contracts. `extras` (full-screen mode)
// adds mouse + paging: { onWheel(deltaLines), onPage(dir), onMouseClick(y) }.

function useComposerState(controller, state, interactive, extras = null) {
  const { registry, completer } = controller;
  const inputRef = useRef({ text: '', cursor: 0, selected: 0, scroll: 0, histIdx: null });
  const [, rerender] = useReducer((c) => c + 1, 0);
  function edit(next) {
    inputRef.current = { ...inputRef.current, ...next };
    rerender();
  }
  function resetInput() {
    edit({ text: '', cursor: 0, selected: 0, scroll: 0, histIdx: null });
  }

  const input = inputRef.current;
  const ask = state.pendingAsk || null;

  // The bare-/model PICKER (defect fix): typing '/model' with no argument
  // opens the SAME completion-menu UI used for slash commands, but its
  // options are the full session model catalog (app customModels + cached
  // gateway /v1/models + built-ins) with the pricing hint per option.
  const pickerItems = useMemo(() => {
    if (input.text.trim() !== '/model') return null;
    const models = typeof controller.getModelCatalog === 'function' ? controller.getModelCatalog() : [];
    if (!Array.isArray(models) || !models.length) return null;
    return models.map((entry) => ({
      value: `/model ${entry.id}`,
      label: entry.id,
      hint: pricingHint(entry.pricing),
      description: entry.source || '',
      executeOnEnter: true
    }));
  }, [input.text, controller]);

  // Completion menu is derived from the buffer with the SHARED registry
  // completer (cli/tui/registry.mjs — same semantics as the old readline
  // completer: full list on '/', prefix-first then mid-word, completeArg for
  // arguments).
  const commandMenu = useMemo(() => {
    const text = input.text;
    if (!text.startsWith('/')) return null;
    let hits;
    try {
      const [values] = completer(text);
      hits = values || [];
    } catch {
      hits = [];
    }
    if (!hits.length) return null;
    const items = hits.map((raw) => {
      // The readline-shaped completer returns BARE command names for the
      // bare '/' case (its fragment-replacement contract) and '/name' values
      // otherwise — normalize so the menu always works with full '/name'
      // values. Registry semantics are untouched.
      const value = raw.startsWith('/') ? raw : `/${raw}`;
      const isArg = value.includes(' ');
      const name = value.slice(1).split(' ')[0];
      const cmd = registry.get(name);
      return {
        value,
        label: isArg ? value.slice(value.indexOf(' ') + 1) : value,
        hint: !isArg && cmd ? cmd.args || '' : '',
        description: !isArg ? (cmd ? cmd.description : '') : ''
      };
    });
    return { items };
  }, [input.text, completer, registry]);

  const menu = pickerItems && pickerItems.length ? { items: pickerItems } : commandMenu;

  useEffect(() => {
    if (menu && (input.selected >= menu.items.length || input.selected < 0)) {
      edit({ selected: 0, scroll: 0 });
    }
  }); // eslint-disable-line react-hooks/exhaustive-deps

  function acceptSuggestion(item, { execute }) {
    const value = item.value;
    if (!execute) {
      edit({ text: value, cursor: value.length, selected: 0, scroll: 0, histIdx: null });
      return;
    }
    // Picker options (and zero-arg commands — qwen's perfect-match rule)
    // EXECUTE on Enter: the menu closes and the command runs immediately.
    if (item.executeOnEnter) {
      resetInput();
      extras?.onDispatch?.();
      controller.handleSubmit(value);
      return;
    }
    if (!value.includes(' ')) {
      const cmd = registry.get(value);
      if (cmd && cmd.args === '') {
        resetInput();
        extras?.onDispatch?.();
        controller.handleSubmit(value);
        return;
      }
    }
    edit({ text: value, cursor: value.length, selected: 0, scroll: 0, histIdx: null });
  }

  function submit() {
    const text = input.text.trim();
    resetInput();
    extras?.onDispatch?.();
    if (ask) controller.answerAsk(text);
    else if (text) controller.handleSubmit(text);
  }

  useInput((value, key) => {
    if (state.exiting) return;

    // ---- SGR mouse events (full-screen mode) ----------------------------
    // gen8-arch1 port: parseMouseEvents decodes EVERY event in the chunk
    // (terminals batch motion+click into one read) and swallows X10-shaped
    // garbage. Hover motion rides the extras.onMouseMove channel; presses,
    // wheels stay actionable. Mouse tracking is ALWAYS ON for the alt-screen
    // session (enabled once at boot, disabled once at exit — never toggled
    // per render), so untracked motion can arrive at any time: it is decoded
    // and simply ignored when no clickable row is under the pointer.
    const mouseShaped = /\x1b?\[<|\x1b\[M|\[M[\s\S]/.test(value);
    const batched = parseMouseEvents(value);
    if (batched.length || mouseShaped) {
      for (const ev of batched) {
        const mouse = mouseEventKind(ev);
        if (!mouse) continue; // releases, right/middle buttons, x10 garbage
        if (mouse.kind === 'motion') {
          if (extras) extras.onMouseMove?.(mouse.y);
          continue;
        }
        if (isActionableMouse(mouse) && extras) {
          // Wheel-up scrolls BACK (older content = larger bottom-anchored
          // offset); wheel-down returns toward the newest.
          if (mouse.kind === 'wheel-up') extras.onWheel(+SCROLL_WHEEL_STEP);
          else if (mouse.kind === 'wheel-down') extras.onWheel(-SCROLL_WHEEL_STEP);
          else if (mouse.kind === 'press') extras.onMouseClick(mouse.y);
        }
      }
      // MOUSE RESIDUE GUARD: mouse-shaped bytes that did not decode into a
      // complete event — SGR sequences split across chunk boundaries, trailing
      // fragments after a parsed event, unrecognized motion bytes — are
      // SWALLOWED here. They must never fall through to the keyboard path and
      // type themselves into the composer (owner-reported input corruption).
      return;
    }
    const mouse = parseMouseEvent(value);
    if (mouse) {
      if (isMotionEvent(mouse) && extras) { extras.onMouseMove?.(mouse.y); return; }
      if (isActionableMouse(mouse) && extras) {
        if (mouse.kind === 'wheel-up') extras.onWheel(+SCROLL_WHEEL_STEP);
        else if (mouse.kind === 'wheel-down') extras.onWheel(-SCROLL_WHEEL_STEP);
        else if (mouse.kind === 'press') extras.onMouseClick(mouse.y);
      }
      return;
    }

    if (key.ctrl && value === 'c') {
      controller.onCtrlC();
      return;
    }
    if (key.escape) {
      // Defect fix: Escape during an active run = /cancel (confirm-free, the
      // same code path through controller.onEscape -> cancelRun). At idle it
      // keeps clearing the input buffer — unless a /history row was clicked
      // (resume pending): then Escape un-picks it.
      if ((state.run
        || (typeof controller.hasResumeTarget === 'function' && controller.hasResumeTarget()))
        && typeof controller.onEscape === 'function') {
        controller.onEscape();
        return;
      }
      resetInput();
      return;
    }
    if (key.ctrl && (value === 'u')) {
      resetInput();
      return;
    }
    if (key.pageUp && extras) { extras.onPage(-PAGE_STEP); return; }
    if (key.pageDown && extras) { extras.onPage(+PAGE_STEP); return; }

    const menuOpen = Boolean(menu && menu.items.length);

    if (key.upArrow) {
      if (menuOpen) {
        const next = input.selected <= 0 ? menu.items.length - 1 : input.selected - 1;
        const scroll = Math.min(
          Math.max(0, next - (MAX_MENU_ROWS - 1)),
          Math.min(input.scroll, next)
        );
        edit({ selected: next, scroll });
      } else {
        const history = controller.getLineHistory();
        if (history.length) {
          const idx = input.histIdx === null ? history.length - 1 : Math.max(0, input.histIdx - 1);
          const text = history[idx];
          edit({ text, cursor: text.length, histIdx: idx });
        }
      }
      return;
    }
    if (key.downArrow) {
      if (menuOpen) {
        const next = input.selected >= menu.items.length - 1 ? 0 : input.selected + 1;
        const scroll = Math.max(
          Math.min(next, menu.items.length - MAX_MENU_ROWS),
          Math.min(input.scroll, next)
        );
        edit({ selected: next, scroll: Math.max(0, scroll) });
      } else if (input.histIdx !== null) {
        const history = controller.getLineHistory();
        const idx = input.histIdx + 1;
        if (idx >= history.length) {
          edit({ text: '', cursor: 0, histIdx: null });
        } else {
          const text = history[idx];
          edit({ text, cursor: text.length, histIdx: idx });
        }
      }
      return;
    }
    if (key.leftArrow) {
      edit({ cursor: Math.max(0, input.cursor - 1), histIdx: null });
      return;
    }
    if (key.rightArrow) {
      edit({ cursor: Math.min(input.text.length, input.cursor + 1), histIdx: null });
      return;
    }
    if (key.tab) {
      if (menuOpen) {
        const index = input.selected >= 0 && input.selected < menu.items.length ? input.selected : 0;
        acceptSuggestion(menu.items[index], { execute: false });
      }
      return;
    }
    if (key.return) {
      if (menuOpen) {
        // qwen's perfect-match rule: an exact match submits, otherwise the
        // active suggestion is accepted (and zero-arg commands execute).
        const index = input.selected >= 0 && input.selected < menu.items.length ? input.selected : 0;
        const item = menu.items[index];
        if (item.value.toLowerCase() !== input.text.toLowerCase().trim()) {
          acceptSuggestion(item, { execute: true });
          return;
        }
      }
      submit();
      return;
    }
    if (/[\r\n]/.test(value) && value.replace(/[\r\n]/g, '').length > 0) {
      // PASTED input (defect fix): terminals deliver a paste as ONE multi-char
      // chunk, and ink does NOT treat the embedded \r\n as Enter — the old
      // code appended the raw chunk (control characters included) into the
      // buffer and the paste never submitted. Split the chunk into lines and
      // submit each through the normal dispatch (agent-first: a pasted task
      // starts a run). Bracketed-paste markers are stripped (gen8-arch1 port).
      const parts = stripBracketedPaste(value).split(/\r\n|\r|\n/);
      const lines = parts
        .map((part, index) => (index === 0 ? input.text + part : part).trim())
        .filter(Boolean);
      resetInput();
      for (const line of lines) controller.handleSubmit(line);
      return;
    }
    if (key.backspace || key.delete) {
      if (input.cursor > 0) {
        const text = input.text.slice(0, input.cursor - 1) + input.text.slice(input.cursor);
        edit({ text, cursor: input.cursor - 1, selected: 0, scroll: 0, histIdx: null });
      }
      return;
    }
    if (value && !key.ctrl && !key.meta) {
      const cleaned = stripBracketedPaste(value);
      if (!cleaned) return; // a bare paste wrapper carries no text
      const text = input.text.slice(0, input.cursor) + cleaned + input.text.slice(input.cursor);
      value = cleaned; // keep cursor math on the cleaned chunk
      edit({
        text,
        cursor: input.cursor + value.length,
        selected: 0,
        scroll: 0,
        histIdx: null
      });
    }
  }, { isActive: interactive });

  const menuOpen = Boolean(menu && menu.items.length);
  const activeMenuIndex = menuOpen && input.selected >= 0 && input.selected < menu.items.length
    ? input.selected
    : (menuOpen ? 0 : -1);

  return { input, edit, resetInput, ask, menu, menuOpen, activeMenuIndex, acceptSuggestion, submit };
}

// ============================================================ FULL SCREEN ==
// The premium alt-screen renderer: ONE framed layout — persistent header,
// windowed scrollable history, fixed live-run card, menu, composer, pinned
// footer. Every region has a FIXED height so the frame exactly fills the
// terminal (alternate screen) and mouse row-mapping is exact.

function FullScreenApp({ controller }) {
  const { store, version } = controller;
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  const { stdout } = useStdout();
  const interactive = controller.interactive !== false;

  // Viewport size: the real terminal, or a controller-supplied fixture
  // (tests) that must not track stdout.
  const [viewport, setViewport] = useState(() => {
    const fixed = typeof controller.getViewport === 'function' ? controller.getViewport() : null;
    if (fixed && Number.isFinite(fixed.rows)) return fixed;
    return { rows: stdout?.rows || 24, cols: stdout?.columns || 100 };
  });
  useEffect(() => {
    if (typeof controller.getViewport === 'function') return undefined;
    const onResize = () => {
      // Minimize/maximize can leave the terminal's previous full-screen frame
      // outside Ink's known cursor range. Clear once at the resize boundary so
      // the next frame starts from a clean canvas instead of stacking headers.
      try { process.stdout.write('\x1b[2J\x1b[H'); } catch { /* terminal gone */ }
      setViewport({ rows: stdout?.rows || 24, cols: stdout?.columns || 100 });
    };
    if (stdout && typeof stdout.on === 'function') {
      stdout.on('resize', onResize);
      return () => { try { stdout.off('resize', onResize); } catch { /* gone */ } };
    }
    return undefined;
  }, [stdout, controller]);

  // NOTE: SGR mouse reporting is enabled/disabled by the BOOTSTRAP
  // (cli/tui.mjs) around the render, not here — writing escape codes to
  // stdout from inside the component would pollute the rendered frame and
  // any frame capture (ink-testing-library records stdout writes).

  // History scroll offset (from the bottom; 0 = pinned to newest). Kept in a
  // ref + manual rerender so wheel ticks never fight the composer rerenders.
  const scrollRef = useRef(0);
  const [, rerenderScroll] = useReducer((c) => c + 1, 0);
  // The frame-anchor map (see below) — rebuilt on every render, read by the
  // mouse handlers via this ref.
  const anchorsRef = useRef([]);
  function scrollTo(offset) {
    scrollRef.current = Math.max(0, offset);
    rerenderScroll();
  }

  const composer = useComposerState(controller, state, interactive, {
    onDispatch: () => scrollTo(0),
    onWheel: (delta) => scrollTo(scrollRef.current + delta),
    onPage: (dir) => scrollTo(scrollRef.current + dir),
    onMouseClick: (y) => {
      // FRAME-ANCHOR HIT-TESTING (gen8 unification): the render pass built
      // the anchor map for the EXACT current frame (anchorsRef below — the
      // fixed-height layout makes the row math deterministic), so a 1-based
      // terminal row maps onto at most one anchor, and the anchor acts.
      const row = y - 1;
      // A resize can deliver a click in the same input burst as the frame that
      // moved the menu. Prefer the exact current anchor, but fall back to the
      // already change-gated hover target so clicking the highlighted row never
      // becomes a no-op during that transition.
      const anchor = (anchorsRef.current || []).find((a) => a.row === row)
        || ((store.get().hover?.row === row) ? (store.get().hover && {
          type: store.get().hover.type,
          alias: store.get().hover.alias,
          index: store.get().hover.index,
          row
        }) : null);
      if (!anchor) return;
      if (anchor.type === 'menu') {
        const item = composer.menu?.items?.[anchor.index];
        if (item) composer.acceptSuggestion(item, { execute: true });
        return;
      }
      if (anchor.type === 'subagent-card' || anchor.type === 'subagent-roster') {
        // FEATURE B: click a persistent card or a roster row -> that pane.
        if (typeof controller.selectSubagentPane === 'function') controller.selectSubagentPane(anchor.alias);
        return;
      }
      if (anchor.type === 'run-history') {
        // /history's clickable rows: click a previous run to resume its
        // conversation — the next submitted message becomes its next turn.
        if (typeof controller.resumeRun === 'function') controller.resumeRun(anchor.alias);
        return;
      }
      if (anchor.type === 'main-pane') {
        // Clicking the main run card returns from a subagent pane.
        if (typeof controller.selectMainPane === 'function') controller.selectMainPane();
      }
    },
    onMouseMove: (y) => {
      // UPGRADE 4: change-gated hover — motion over a clickable row writes
      // the hover state ONCE per change; motion over a non-clickable region
      // clears it; identical repeated motion never re-writes the store.
      const row = y - 1;
      const anchor = (anchorsRef.current || []).find((a) => a.row === row);
      const next = anchor
        ? { type: anchor.type, alias: anchor.alias ?? null, index: anchor.index ?? null, row }
        : null;
      const prev = store.get().hover || null;
      const same = (prev === null && next === null)
        || (prev !== null && next !== null
          && prev.type === next.type
          && prev.alias === next.alias
          && prev.index === next.index
          && prev.row === next.row);
      if (same) return;
      store.set((s) => ({ ...s, hover: next }));
    }
  });
  const { input, ask, menu, menuOpen, activeMenuIndex } = composer;

  // ---- layout math (all fixed heights) ------------------------------------
  const rows = Math.max(12, viewport.rows);
  const cols = Math.max(40, viewport.cols);
  const menuVisible = menuOpen ? Math.min(MAX_MENU_ROWS, menu.items.length) : 0;
  const menuRows = menuOpen ? menuVisible + (menu.items.length > menuVisible ? 1 : 0) : 0;
  const noticeRows = state.notice ? 1 : 0;
  const runRows = state.run ? RUN_PANEL_ROWS : 0;
  // Live subagent roster (FEATURE B): one switcher row per live subagent,
  // rendered ONLY while a run is active — the persistent history cards
  // outlive the run; the roster does not. (Older stores may not carry the
  // subagents field at all — default to an empty roster.)
  const subagents = Array.isArray(state.subagents) ? state.subagents : [];
  const rosterRows = state.run ? Math.min(MAX_ROSTER_ROWS, subagents.length) : 0;
  const historyRows = Math.max(1, rows - HEADER_ROWS - runRows - rosterRows - menuRows - noticeRows
    - PROMPT_ROWS - FOOTER_ROWS - COMPOSER_BARS);

  const allLines = useMemo(
    () => historyToLines(state.history, cols, { subagents }),
    [state.history, cols, subagents]
  );
  // NOT memoized on the scroll offset (a ref): every render must re-window.
  const { slice: visibleLines, maxOffset } = windowLines(allLines, historyRows, scrollRef.current);
  // Clamp the scroll offset when the buffer shrank (/clear) or grew.
  if (scrollRef.current > maxOffset) scrollRef.current = maxOffset;

  // ---- frame-anchor map (click + hover hit-testing) ------------------------
  // Built from the SAME fixed-height math the JSX below renders: row indexes
  // are exact 0-based frame rows (menu rows measured from the BOTTOM edge —
  // bar/prompt/bar/footer — so a notice above can never shift them).
  const historyTop = HEADER_ROWS;
  const runTop = historyTop + historyRows;
  const rosterTop = runTop + runRows;
  const menuTop = rows - FOOTER_ROWS - PROMPT_ROWS - COMPOSER_BARS - menuRows;
  const anchors = [];
  visibleLines.forEach((line, i) => {
    const match = /^subagent-history#([^#]+)#/.exec(String(line.key || ''));
    if (match) anchors.push({ row: historyTop + i, type: 'subagent-card', alias: match[1] });
    const runMatch = /^run-history#([^#]+)#/.exec(String(line.key || ''));
    if (runMatch) anchors.push({ row: historyTop + i, type: 'run-history', alias: runMatch[1] });
  });
  if (state.run) {
    for (let i = 0; i < RUN_PANEL_ROWS; i += 1) anchors.push({ row: runTop + i, type: 'main-pane' });
  }
  for (let i = 0; i < rosterRows; i += 1) {
    const sub = subagents[i];
    if (sub) anchors.push({ row: rosterTop + i, type: 'subagent-roster', alias: sub.alias });
  }
  for (let i = 0; i < menuVisible; i += 1) {
    anchors.push({ row: menuTop + i, type: 'menu', index: input.scroll + i });
  }
  anchorsRef.current = anchors;

  // NOTE (mouse-mode stability, owner fix 2026-10-13): the App NEVER writes
  // control sequences and NEVER toggles ?1003h/?1003l per render. Any-motion
  // tracking is enabled ONCE at alt-screen boot and disabled ONCE at exit by
  // the bootstrap (cli/tui.mjs) — the per-render toggling interleaved raw
  // control bytes with ink's frame stream, corrupting the banner region and
  // repainting constantly. The always-on motion stream is handled purely in
  // the store: motion with no clickable anchor is ignored (change-gated).

  // A hover that outlives its row (a click closed the menu, the run card
  // vanished, the roster shrank) is cleared on the next render — the hover
  // never points at a row that is no longer clickable.
  useEffect(() => {
    const hover = state.hover;
    if (!hover) return;
    const still = (anchorsRef.current || []).some((a) => a.row === hover.row
      && a.type === hover.type
      && (a.alias ?? null) === (hover.alias ?? null)
      && (a.index ?? null) === (hover.index ?? null));
    if (!still) store.set((s) => ({ ...s, hover: null }));
  });

  // ---- header --------------------------------------------------------------
  const headerInfo = `repo ${state.session.cwd || '(unset)'}${state.session.cwdPinned ? ' (pinned)' : ''}`;
  const statusLabel = state.run ? (state.run.lastError ? 'ERROR' : 'WORKING') : 'READY';
  const statusTone = state.run?.lastError ? theme.Danger : state.run ? theme.Info : theme.Accent;
  const header = h(Box, {
    flexDirection: 'column',
    height: HEADER_ROWS,
    flexShrink: 0,
    borderTop: false,
    borderLeft: false,
    borderRight: false,
    borderBottom: true,
    borderColor: theme.border.default,
    paddingLeft: 1,
    paddingRight: 1
  },
    h(Box, { flexDirection: 'row' },
      h(Text, { bold: true, color: theme.Accent }, '◈ BROWSER USE'),
      h(Text, { color: theme.text.secondary }, `  v${version}`),
      h(Text, { color: statusTone }, `    ● ${statusLabel}`),
      h(Text, { color: theme.text.secondary }, `    ${state.session.headed ? 'headed' : 'headless'}`)),
    h(Text, { color: theme.text.secondary }, headerInfo))

  // ---- live run card / active pane (fixed 5 rows) ---------------------------
  const runCard = useMemo(() => {
    if (!state.run) return null;
    // FEATURE B pane switch: the card region renders the ACTIVE pane — the
    // main run, or one subagent's stream (its own trace tail).
    const activeSub = state.activeSubagent
      ? (Array.isArray(state.subagents) ? state.subagents : []).find((sub) => sub.alias === state.activeSubagent)
      : null;
    if (activeSub) {
      const tail = activeSub.tail || {};
      const last = Array.isArray(tail.tools) && tail.tools.length ? tail.tools[tail.tools.length - 1] : null;
      const badge = last ? toolBadge(last.ok) : null;
      const pane2 = tail.inFlight
        ? { spinner: true, text: `${tail.inFlight} in flight…`, color: theme.Accent }
        : { spinner: true, text: 'working', color: theme.Comment };
      const pane3 = tail.lastError
        ? { text: `✗ ${truncate(String(tail.lastError), cols - 6)}`, color: theme.Danger }
        : tail.thinking
          ? { text: truncate(String(tail.thinking), cols - 6), color: theme.Comment }
          : last
            ? {
              segments: [
                { text: `${toolIcon(last.tool)} `, color: theme.AccentDim },
                { text: String(last.tool || '—'), color: theme.text.primary },
                { text: ` ${last.durationMs != null ? `${last.durationMs}ms` : ''}`, color: theme.text.secondary },
                { text: ` [${badge.label}]`, color: badge.color }
              ]
            }
            : { text: 'no tools yet', color: theme.Comment };
      return h(Box, { flexDirection: 'column', paddingLeft: 1 },
        h(Text, null,
          h(Text, { bold: true, color: theme.Accent }, ` ▸ subagent ${activeSub.alias} `),
          h(Text, { color: theme.text.secondary }, `— ${activeSub.status || 'running'}`),
          h(Text, { color: theme.Comment }, `  ${truncate(String(activeSub.task || ''), Math.max(8, cols - 34))}`)),
        h(Box, { flexDirection: 'row', paddingLeft: 1 },
          pane2.spinner ? h(Spinner, { type: 'dots' }) : h(Text, { color: theme.Comment }, ' '),
          h(Text, { color: pane2.color }, ` ${pane2.text}`)),
        pane3.segments
          ? h(Box, { flexDirection: 'row', paddingLeft: 1 },
            ...pane3.segments.map((s, i) => h(Text, { key: `ps-${i}`, color: s.color }, s.text)))
          : h(Text, { color: pane3.color, paddingLeft: 1 }, ` ${pane3.text}`),
        h(Text, { color: theme.Comment }, ` esc returns to the main run · ${truncate(String(state.run.name || ''), Math.max(8, cols - 30))}`),
        h(Text, { color: theme.Comment }, '')
      );
    }
    const run = state.run;
    const last = Array.isArray(run.tools) && run.tools.length ? run.tools[run.tools.length - 1] : null;
    const badge = last ? toolBadge(last.ok) : null;
    const line2 = run.phase
      ? { spinner: true, text: run.phase, color: theme.Accent }
      : run.inFlight
        ? { spinner: true, text: `${run.inFlight} in flight…`, color: theme.Accent }
        : { spinner: true, text: 'working', color: theme.Comment };
    const line3 = run.lastError
      ? { text: `✗ ${truncate(String(run.lastError), cols - 6)}`, color: theme.Danger }
      : run.thinking
        ? { text: truncate(String(run.thinking), cols - 6), color: theme.Comment }
        : last
          ? {
            segments: [
              { text: `${toolIcon(last.tool)} `, color: theme.AccentDim },
              { text: String(last.tool || '—'), color: theme.text.primary },
              { text: ` ${last.durationMs != null ? `${last.durationMs}ms` : ''}`, color: theme.text.secondary },
              { text: ` [${badge.label}]`, color: badge.color }
            ]
          }
          : { text: 'no tools yet', color: theme.Comment };
    return h(Box, { flexDirection: 'column', paddingLeft: 1 },
      h(Text, null,
        h(Text, { bold: true, color: theme.Accent }, ` ▸ run ${run.name}`),
        h(LiveElapsed, { startedAt: run.startedAt }),
        h(Text, { color: theme.Comment }, `  ${truncate(String(run.task || ''), Math.max(8, cols - 30))}`)),
      h(Box, { flexDirection: 'row', paddingLeft: 1 },
        line2.spinner ? h(Spinner, { type: 'dots' }) : h(Text, { color: theme.Comment }, ' '),
        h(Text, { color: line2.color }, ` ${line2.text}`)),
      line3.segments
        ? h(Box, { flexDirection: 'row', paddingLeft: 1 },
          h(ActivityMark, { category: run.lastError ? 'warning' : last ? 'success' : 'browser' }),
          ...line3.segments.map((s, i) => h(Text, { key: `ls-${i}`, color: s.color }, s.text)))
        : h(Box, { flexDirection: 'row', paddingLeft: 1 },
          h(ActivityMark, { category: run.lastError ? 'warning' : 'browser' }),
          h(Text, { color: line3.color }, ` ${line3.text}`)),
      h(Text, { color: theme.Comment }, ` esc cancels · ${truncate(state.session.cwd || '', Math.max(8, cols - 20))}`),
      // The live-region bottom row carries the mid-run queue count (dynamic
      // content stays ABOVE the composer sandwich — owner directive): the
      // row is blank when nothing is queued, keeping the card 5 rows.
      Number(run.queuedCount) > 0
        ? h(Text, { color: theme.Comment }, ` queued (${Number(run.queuedCount)} total) — delivers when the run finishes`)
        : h(Text, { color: theme.Comment }, '')
    );
  }, [state.run, state.activeSubagent, state.subagents, cols, state.session.cwd]);

  // Hovered menu row (UPGRADE 4): the picker cursor parks on the hovered row.
  const effectiveMenuIndex = state.hover && state.hover.type === 'menu' && Number.isInteger(state.hover.index)
    ? state.hover.index
    : activeMenuIndex;

  // ---- footer ---------------------------------------------------------------
  // STATIC by directive (owner fix 2026-10-13): the footer never carries live
  // content — no spinner, no elapsed, no queue count. ALL dynamic content
  // (run card, roster, queue count) lives in the live region ABOVE the
  // composer sandwich; below the sandwich only the static session bits move.
  const footer = h(Box, { flexDirection: 'row', justifyContent: 'space-between', paddingLeft: 2, paddingRight: 2, marginTop: 0 },
    h(Text, { color: theme.Dim }, truncate(sessionStatusBits(state.session).join(' \u00b7 '), Math.max(20, cols - 30))),
    h(Text, { color: theme.Comment }, 'esc cancel \u00b7 /help')
  );

  // ---- frame ----------------------------------------------------------------
  // Use a light framed composer rather than the old full-width `====` bars.
  // The rounded corners visually separate input from the live workspace while
  // keeping the composer at the same fixed three-row height.
  const composerWidth = Math.max(20, cols - 6);
  const composerTop = `╭${'─'.repeat(composerWidth)}╮`;
  const composerBottom = `╰${'─'.repeat(composerWidth)}╯`;
  // Explicitly occupy the entire terminal. Without a root height, Ink treats
  // this as a short inline frame, so the header/composer stay at the top and
  // maximize can replay the old frame below it.
  return h(Box, { flexDirection: 'column', width: cols, height: rows, flexGrow: 1 },
    header,
    // History window: exactly `historyRows` rows, padded on top when the
    // buffer is shorter (keeps the frame height constant). The hovered row
    // (UPGRADE 4) carries the lime pointer marker.
    h(Box, { flexDirection: 'column', height: historyRows, flexShrink: 0 },
      ...Array.from({ length: historyRows }, (_, i) => {
        const line = visibleLines[i];
        if (!line) return h(Text, { key: `pad-${i}`, color: theme.Comment }, '');
        const hovered = state.hover && state.hover.row === historyTop + i;
        return h(Text, { key: line.key },
          ...line.segments.map((s, j) => h(Text, {
            key: `s-${j}`,
            color: s.color,
            backgroundColor: s.background || undefined,
            bold: Boolean(s.bold)
          }, s.text)),
          hovered ? h(Text, { key: 'hov', color: theme.Accent, bold: true }, ' ◂') : null);
      })),
    state.run
      ? h(Box, { height: runRows, width: cols, flexShrink: 0 }, runCard)
      : null,
    // Live subagent roster (FEATURE B): one click-to-switch row per subagent,
    // only while a run is active. The active pane's row says so; the hovered
    // row carries the pointer marker.
    rosterRows > 0
      ? h(Box, { flexDirection: 'column', height: rosterRows, flexShrink: 0 },
        ...subagents.slice(0, MAX_ROSTER_ROWS).map((sub, i) => {
          const frameRow = rosterTop + i;
          const hovered = state.hover && state.hover.type === 'subagent-roster' && state.hover.row === frameRow;
          const active = state.activeSubagent === sub.alias;
          return h(Text, { key: `roster-${sub.alias}` },
            h(Text, { bold: true, color: active || hovered ? theme.Accent : theme.AccentDim }, ` ▸ subagent ${sub.alias} `),
            h(Text, { color: theme.text.secondary }, `— ${sub.status || 'running'}`),
            h(Text, { color: active ? theme.Accent : theme.Comment },
              active ? ' — viewing (esc for main run)' : ' — click to view'),
            hovered ? h(Text, { color: theme.Accent, bold: true }, ' ◂') : null);
        }))
      : null,
    state.notice
      ? h(Box, { height: noticeRows, flexShrink: 0, paddingLeft: 2 },
        h(Text, { color: state.notice.tone === 'err' ? theme.Danger : theme.Warn },
          truncate(` ⚠ ${state.notice.text}`, cols - 4)))
      : null,
    menuOpen
      ? h(Box, { height: menuRows, flexShrink: 0 }, h(CompletionMenu, {
        items: menu.items,
        activeIndex: effectiveMenuIndex,
        hoverIndex: state.hover && state.hover.type === 'menu' ? state.hover.index : null,
        scrollOffset: input.scroll,
        fragment: input.text,
        variant: 'full'
      }))
      : null,
    h(Text, { color: theme.Comment, paddingLeft: 2 }, 'MESSAGE'),
    h(Text, { color: theme.border.default }, composerTop),
    h(Box, {
      // Keep the prompt row's visible width exact: the four gutter columns are
      // explicit children, not padding added on top of the border width.
      width: composerWidth + 2,
      flexDirection: 'row',
      overflow: 'hidden'
    },
      h(Text, { color: '#171A20' }, '  '),
      ...renderPromptLine({
        text: input.text,
        cursor: input.cursor,
        question: ask ? `${ask} ` : null,
        width: composerWidth - 2
      }),
      h(Text, { color: '#171A20' }, '  ')),
    h(Text, { color: theme.border.default }, composerBottom),
    footer
  );
}

// ============================================================= INLINE ======

function InlineApp({ controller }) {
  const { store, registry, completer, version } = controller;
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  // useInput toggles raw mode on mount, which throws on a non-TTY stdin.
  // Piped/EOF usage is driven by the bootstrap's line reader instead
  // (interactive=false), while ink-testing-library's fake stdin is a TTY.
  const interactive = controller.interactive !== false;

  const composer = useComposerState(controller, state, interactive);
  const { input, ask, menu, menuOpen, activeMenuIndex } = composer;

  return h(Box, { flexDirection: 'column', paddingLeft: 0 },
    h(Static,
      // The banner is pinned as the FIRST static entry so it always renders
      // above every history line and can never be pushed below run output.
      { items: [{ id: 'banner', kind: 'banner', version }, ...state.history] },
      (entry) => entry.kind === 'banner'
        ? h(BannerEntry, { key: entry.id, version: entry.version })
        : h(HistoryItem, { key: entry.id, entry, subagents: state.subagents })),
    h(Box, { flexDirection: 'column', paddingLeft: 0 },
      state.notice
        ? h(Box, { paddingLeft: 2 },
          h(Text, { color: state.notice.tone === 'err' ? theme.Danger : theme.Warn },
            ` ⚠ ${state.notice.text}`))
        : null,
      state.run ? h(LiveRun, { run: state.run }) : null,
      // FEATURE B (inline tier): subagents list under the live card while a
      // run is active, display-only (no mouse on the inline tier).
      state.run && Array.isArray(state.subagents) && state.subagents.length
        ? h(Box, { flexDirection: 'column' },
          ...state.subagents.slice(0, MAX_ROSTER_ROWS).map((sub) => h(Text, { key: `roster-i-${sub.alias}` },
            h(Text, { bold: true, color: state.activeSubagent === sub.alias ? theme.Accent : theme.AccentDim }, ` ▸ subagent ${sub.alias} `),
            h(Text, { color: theme.text.secondary }, `— ${sub.status || 'running'}`))))
        : null,
      menuOpen
        ? h(CompletionMenu, {
          items: menu.items,
          activeIndex: activeMenuIndex,
          scrollOffset: input.scroll,
          fragment: input.text
        })
        : null,
      h(Box, { paddingLeft: 2, paddingRight: 2, flexDirection: 'row' },
        ...renderPromptLine({
          text: input.text,
          cursor: input.cursor,
          question: ask ? `${ask} ` : null
        })),
      h(Footer, { state })
    )
  );
}

// ---------------------------------------------------------------- app -----

export function App({ controller }) {
  const mode = controller.screenMode === 'full' ? 'full' : 'inline';
  return mode === 'full' ? h(FullScreenApp, { controller }) : h(InlineApp, { controller });
}

export default App;
