// cli/tui/historyView.mjs
//
// PURE line model for the full-screen history region (cli/tui/App.mjs
// FullScreenApp). The full-screen app cannot use Ink <Static> — it must frame
// the history between a fixed header and a pinned composer, so the history is
// rendered as a WINDOW of pre-computed lines. This module turns the same
// immutable store entries the inline renderer draws (cli/tui/store.mjs
// shapes) into styled lines with DETERMINISTIC wrapping, so the viewport
// math (how many rows an entry occupies) is exact and unit-testable.
//
// Line shape: { key, segments: [{ text, color, bold? }] }.
// Colors are theme tokens; wrapping is plain-text word wrap at the terminal
// width. The inline renderer (App.mjs) keeps its own JSX rendering of the
// same entries — the two share content, not code, and tui.test.mjs asserts
// the shared shapes.
//
// KEYS are deterministic and unique PER ENTRY (built from entry.id / alias —
// never a per-call counter): two entries of the same kind must never share a
// React key (static per-block keys collided ('rs-top' × 2) and crashed the
// render on every frame — owner-reported 2026-10-12 — and a per-call uid
// reset kept the collision across repeated kinds).
//
// UNIFIED CONTRACT (gen8, 2026-10-13):
//   - user submissions render as a PLAIN `browser-use▸ text` echo (the ===
//     sandwich lives on the COMPOSER, not in history);
//   - run summaries render as a bordered card containing ONLY the reply text
//     (failures show the ✗ error instead), with ONE dim economy line BELOW
//     the card (`N decisions · N tools · elapsed`) — no name/status/verified
//     clutter inside the card;
//   - subagent spawns render as persistent `▸ subagent <alias> — <status>`
//     cards whose status follows the LIVE subagent record and which survive
//     run end.

import { theme, toneColor, statusColor, successBadge, toolIcon, toolBadge, formatElapsed } from './theme.mjs';

const USER_PREFIX = 'browser-use▸ ';

/** Plain word wrap at `width` (explicit \n honored; long words hard-broken). */
export function wrapText(text, width) {
  const w = Math.max(1, width | 0);
  const out = [];
  for (const paragraph of String(text ?? '').split('\n')) {
    if (paragraph === '') { out.push(''); continue; }
    let line = '';
    for (const word of paragraph.split(/ +/)) {
      if (line === '') {
        // Hard-break a single word longer than the width.
        let rest = word;
        while (rest.length > w) {
          out.push(rest.slice(0, w));
          rest = rest.slice(w);
        }
        line = rest;
        continue;
      }
      if (line.length + 1 + word.length <= w) {
        line += ' ' + word;
        continue;
      }
      out.push(line);
      let rest = word;
      while (rest.length > w) {
        out.push(rest.slice(0, w));
        rest = rest.slice(w);
      }
      line = rest;
    }
    if (line !== '' || out.length === 0) out.push(line);
  }
  return out;
}

function seg(text, color, bold = false, background = null) {
  return { text: String(text), color, bold, background };
}

/**
 * Append a wrapped (prefixSegments + text) paragraph to `lines`.
 * Continuation lines are indented to the prefix's visible length.
 */
function pushWrapped(lines, key, prefixSegments, text, width, textColor) {
  const prefixLen = prefixSegments.reduce((n, s) => n + s.text.length, 0);
  const chunks = wrapText(text, Math.max(10, width - prefixLen));
  chunks.forEach((chunk, i) => {
    lines.push({
      key: `${key}-${i}`,
      segments: i === 0
        ? [...prefixSegments, seg(chunk, textColor)]
        : [seg(' '.repeat(prefixLen), textColor), seg(chunk, textColor)]
    });
  });
  if (chunks.length === 0) {
    lines.push({ key, segments: [...prefixSegments] });
  }
}

/** Render a compact rounded message card with stable, entry-derived keys. */
function pushCard(lines, key, text, width, color, { alignRight = false } = {}) {
  const cardInner = Math.max(12, Math.min(width - 4, Math.floor(width * 0.75)));
  // The body has two border glyphs plus one padding space on each side;
  // account for all four columns or the trailing border wraps onto a new row.
  const cardWidth = cardInner + 4;
  const gutter = alignRight ? Math.max(0, width - cardWidth) : 0;
  const lead = ' '.repeat(gutter);
  const chunks = wrapText(text, cardInner);
  const border = '─'.repeat(cardInner + 2);
  lines.push({ key: `${key}-top`, segments: [seg(`${lead}╭${border}╮`, '#292E37')] });
  for (const [index, chunk] of chunks.entries()) {
    const padded = chunk.padEnd(cardInner, ' ');
    lines.push({
      key: `${key}-body-${index}`,
      segments: [seg(`${lead}│ `, '#292E37'), seg(padded, color, false, '#171A20'), seg(' │', '#292E37')]
    });
  }
  lines.push({ key: `${key}-bottom`, segments: [seg(`${lead}╰${border}╯`, '#292E37')] });
}

/**
 * Convert one store history entry into styled lines at terminal `width`.
 * Mirrors the inline HistoryItem content exactly (minus process plumbing —
 * runStart lines carry no pid and no out-dir path anywhere).
 * `ctx.subagents` (the live store records) lets subagent history cards show
 * their CURRENT status while the run is active.
 */
// Every line key is derived from the immutable history entry id. Keys must not
// change when the live run clock, spinner, or subagent roster updates: changing
// a history key makes Ink tear down and rebuild the whole row on every frame,
// which is visible as full-screen shimmer on some terminals.

export function entryToLines(entry, width, ctx = {}) {
  const lines = [];
  const liveSubagents = Array.isArray(ctx.subagents) ? ctx.subagents : [];
  switch (entry.kind) {
    case 'user':
      // User turns are compact cards in the full-screen feed; the composer is
      // the only place that shows the editable browser-use▸ prompt.
      pushCard(lines, `u-${entry.id}`, entry.text, width, theme.text.primary, { alignRight: true });
      break;
    case 'queued':
      // Mid-run submissions queue (desktop parity) — dim card, delivers when
      // the current run finishes.
      pushWrapped(lines, `q-${entry.id}`, [seg(' ▸ queued', theme.Comment, true)], `— ${entry.text || ''}`, width, theme.Comment);
      break;
    case 'contStart':
      pushWrapped(lines, `c-${entry.id}`, [seg(' ▸ continuation', theme.Accent, true)], `— ${entry.text || ''}`, width, theme.text.secondary);
      break;
    case 'subagent': {
      // UPGRADE 3: a PERSISTENT card — renders from the LIVE subagent record
      // (status updates flow in while the run is active) and survives run end.
      const live = liveSubagents.find((sub) => sub.alias === entry.alias);
      const status = String((live && live.status) || entry.status || 'queued');
      pushWrapped(lines, `subagent-history#${entry.alias}#`, [seg(` ▸ subagent ${entry.alias} `, theme.Accent, true)], `— ${status}`, width, theme.text.secondary);
      break;
    }
    case 'out':
      pushWrapped(lines, `o-${entry.id}`, [], entry.text, width, toneColor(entry.tone));
      break;
    case 'rows':
      entry.rows.forEach(([left, right], rowIndex) => {
        // The two-space separator rides in the prefix (wrapText-safe). Include
        // the row index: one /help or /config entry produces many lines, and
        // reusing the entry id alone makes React reuse the wrong row.
        pushWrapped(lines, `r-${entry.id}-${rowIndex}`, [seg(` ${left}  `, theme.Accent)], right ?? '', width, theme.text.secondary);
      });
      if (entry.tips) {
        pushWrapped(lines, `t-${entry.id}`, [seg(' ', theme.Comment)], entry.tips, width, theme.Comment);
      }
      break;
    case 'runHistory':
      // /history's clickable run list — each row's key carries the run name so
      // the App's frame-anchor map makes the WHOLE row a click target
      // (resume), exactly like the subagent cards.
      for (const run of entry.runs) {
        const right = `${run.status} · ${run.elapsed || '—'}${run.model ? ` · ${run.model}` : ''} — click to resume`;
        pushWrapped(lines, `run-history#${run.name}#`, [seg(` ${run.name}  `, theme.Accent, true)], right, width, theme.text.secondary);
      }
      if (entry.tips) {
        pushWrapped(lines, `t-${entry.id}`, [seg(' ', theme.Comment)], entry.tips, width, theme.Comment);
      }
      break;
    case 'runStart':
      // The live panel is the only active-run card. Retain one blank stable
      // row for legacy persisted markers so removing the duplicate text does
      // not shift an already-windowed history frame.
      lines.push({ key: `run-start-${entry.id}`, segments: [seg('', theme.Comment)] });
      break;
    case 'runSummary':
      lines.push(...runSummaryLines(entry, width));
      break;
    case 'tools':
      lines.push(...toolsDigestLines(entry.calls, width, entry.id));
      break;
    default:
      pushWrapped(lines, `x-${entry.id}`, [], entry.text || '', width, theme.text.primary);
  }
  return lines;
}

/**
 * Run summary (unified contract): a bordered card whose ONLY content is the
 * model's reply — a failed run shows the ✗ error instead — followed by ONE
 * dim economy line below the card: run name, status, decisions, tools,
 * elapsed. No name/status/verified clutter INSIDE the card.
 */
function runSummaryLines(entry, width) {
  const summary = entry.summary || {};
  const id = entry.id;
  const inner = Math.max(20, Math.min(width - 4, 100)); // 2 border + 2 padding per side
  const error = summary.error ? String(summary.error) : null;
  const reply = typeof summary.reply === 'string' && summary.reply.trim()
    ? String(summary.reply)
    : (typeof summary.result === 'string' && summary.result.trim() ? String(summary.result) : null);

  const content = [];
  if (error) {
    // Failure (defect 3b): the card states WHY — the last connection error,
    // the observer stopReason, or the honest no-terminal-state line.
    pushWrapped(content, `rs-err-${id}`, [seg(' ✗ ', theme.Danger, true)], error.slice(0, 500), inner, theme.Danger);
  } else if (reply) {
    // The model's ANSWER is the card's primary (and only) content.
    pushWrapped(content, `rs-reply-${id}`, [], reply.slice(0, 1500), inner, theme.text.primary);
  } else {
    content.push({ key: `rs-empty-${id}`, segments: [seg(String(summary.status || 'unknown'), theme.Comment)] });
  }

  const lines = [];
  // Grow the panel to fit unwrappable rows — never slice content off.
  const widest = content.reduce((n, row) => Math.max(n, row.segments.map((s) => s.text).join('').length), inner);
  const panelInner = Math.min(widest, Math.max(inner, width - 4));
  const border = '─'.repeat(panelInner + 2);
  lines.push({ key: `rs-top-${id}`, segments: [seg(`╭${border}╮`, theme.Border)] });
  for (const row of content) {
    const plain = row.segments.map((s) => s.text).join('');
    const padded = plain.length < panelInner ? plain + ' '.repeat(panelInner - plain.length) : plain.slice(0, panelInner);
    // Re-split the padded row back onto the original segment colors by
    // slicing each segment's visible span in order.
    const segments = [];
    let offset = 0;
    for (const s of row.segments) {
      if (offset >= panelInner) break;
      const piece = padded.slice(offset, offset + s.text.length);
      offset += s.text.length;
      if (piece) segments.push({ text: piece, color: s.color, bold: s.bold });
    }
    if (offset < panelInner) segments.push({ text: padded.slice(offset), color: theme.text.primary, bold: false });
    lines.push({ key: row.key, segments: [seg('│ ', theme.Border), ...segments, seg(' │', theme.Border)] });
  }
  lines.push({ key: `rs-bottom-${id}`, segments: [seg(`╰${border}╯`, theme.Border)] });
  // ONE dim economy line BELOW the card (the only meta the summary carries).
    const economy = `${summary.decisions ?? '—'} decisions · ${summary.tools ?? '—'} tools · ${formatElapsed(summary.elapsedMs)}`;
  pushWrapped(lines, `rs-econ-${id}`, [seg(' ', theme.Comment)], economy, width, theme.Comment);
  return lines;
}

function toolsDigestLines(calls, width, id = 'tools') {
  if (!Array.isArray(calls) || calls.length === 0) return [];
  const rows = calls.slice(0, 12);
  const lines = [];
  for (const call of rows) {
    const badge = toolBadge(call.ok);
    lines.push({
      key: `tool-${id}-${call.tool}-${call.ts ?? ''}`,
      segments: [
        seg(`  ${toolIcon(call.tool)} `, theme.AccentDim),
        seg(String(call.tool || '—'), theme.text.primary),
        seg(`  ${call.durationMs != null ? `${call.durationMs}ms` : '—'}`, theme.text.secondary),
        seg(`  [${badge.label}]`, badge.color)
      ]
    });
  }
  if (calls.length > rows.length) {
    lines.push({ key: `tool-more-${id}`, segments: [seg(`  … and ${calls.length - rows.length} more`, theme.text.secondary)] });
  }
  return lines;
}

/**
 * Flatten history entries (oldest first) into the full line list.
 * `opts.subagents` (live store records) drives the persistent subagent
 * cards' status.
 */
export function historyToLines(history, width, opts = {}) {
  const ctx = { subagents: Array.isArray(opts.subagents) ? opts.subagents : [] };
  const lines = [];
  for (const entry of history) lines.push(...entryToLines(entry, width, ctx));
  return lines;
}

/**
 * The visible window of `lines` for `visibleRows`, honoring a scroll offset
 * measured FROM THE BOTTOM (0 = pinned to the newest line — the default
 * sticky behavior; > 0 = the owner scrolled back).
 */
export function windowLines(lines, visibleRows, scrollFromBottom = 0) {
  const rows = Math.max(1, visibleRows | 0);
  const offset = Math.max(0, scrollFromBottom | 0);
  const end = Math.max(0, lines.length - offset);
  const start = Math.max(0, end - rows);
  return { slice: lines.slice(start, end), start, end, maxOffset: Math.max(0, lines.length - rows) };
}
