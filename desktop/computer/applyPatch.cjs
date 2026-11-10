'use strict';

// apply_patch engine for the computer_patch tool (Codex/V4A-style format):
//
//   *** Begin Patch
//   *** Update File: src/main.dart
//   @@ optional anchor context
//   -old line
//   +new line
//    unchanged context
//   *** Add File: new.txt
//   +line one
//   *** Delete File: obsolete.txt
//   *** End Patch
//
// Hunks are context-anchored: the engine locates the hunk's context lines in
// the current file (sequentially, so repeated context matches the NEXT
// occurrence), removes the '-' lines and inserts the '+' lines. No line
// numbers are required from the model — wrong guesses are impossible.
//
// The result carries a structured diff with EXACT old/new line numbers per
// changed line, so the renderer can draw an IDE-style view: green added lines
// numbered in the new file, red removed lines numbered in the old file.

const MAX_FILE_BYTES = 1_000_000;
const MAX_PATCH_CHARS = 200_000;

// Patch outcome taxonomy. Every failure names WHAT kind of failure it was, so
// recovery can be targeted instead of restarting the investigation:
//   not_executed        the patch was never applied (parse/directive error) —
//                       reconcile the file state and execute it
//   context_mismatch    the source moved under the patch — reread the affected
//                       section only and regenerate against it
//   execution_failed    the write itself failed — understand the error and use
//                       a corrected approach
// The caller records the outcome; a successful apply is 'executed' and the
// caller's read-back verification makes it 'verified'.
function patchError(message, outcome) {
  const error = new Error(message);
  error.patchOutcome = outcome;
  return error;
}

function parsePatch(patchText) {
  const text = String(patchText || '');
  if (!text.trim()) throw patchError('The patch body is empty.', 'not_executed');
  if (text.length > MAX_PATCH_CHARS) throw patchError(`The patch is too large (${text.length} characters; cap ${MAX_PATCH_CHARS}).`, 'not_executed');
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const trimmedStart = lines.findIndex(line => line.trim() === '*** Begin Patch');
  if (trimmedStart === -1) throw patchError("The patch must start with the '*** Begin Patch' marker.", 'not_executed');
  const endIndex = lines.findIndex(line => line.trim() === '*** End Patch');
  if (endIndex === -1) throw patchError("The patch must end with the '*** End Patch' marker.", 'not_executed');
  const body = lines.slice(trimmedStart + 1, endIndex);
  const files = [];
  let current = null;
  let hunk = null;
  const closeHunk = () => { if (hunk && current) { current.hunks.push(hunk); hunk = null; } };
  const closeFile = () => { closeHunk(); if (current) files.push(current); current = null; };
  for (const raw of body) {
    if (raw.startsWith('*** ')) {
      const update = raw.match(/^\*\*\* Update File: (.+)$/);
      const add = raw.match(/^\*\*\* Add File: (.+)$/);
      const remove = raw.match(/^\*\*\* Delete File: (.+)$/);
      if (update || add || remove) {
        closeFile();
        current = update
          ? { action: 'update', path: update[1].trim(), hunks: [] }
          : add
            ? { action: 'add', path: add[1].trim(), hunks: [] }
            : { action: 'delete', path: remove[1].trim(), hunks: [] };
        continue;
      }
      throw patchError(`Unknown patch directive: ${raw.slice(0, 60)}`, 'not_executed');
    }
    if (!current) {
      if (!raw.trim()) continue;
      throw patchError(`Patch content before a file directive: ${raw.slice(0, 60)}`, 'not_executed');
    }
    if (raw.startsWith('@@')) {
      closeHunk();
      // The anchor LOCATES the hunk and is rendered as leading diff context;
      // the body applies immediately after it. Kept separate from `lines` so
      // matching counts it exactly once.
      hunk = { anchor: raw.slice(2).trim(), lines: [] };
      continue;
    }
    if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ') || raw === '' || raw === '\r') {
      if (!hunk) hunk = { anchor: '', lines: [] };
      hunk.lines.push({ kind: raw.startsWith('+') ? 'add' : raw.startsWith('-') ? 'del' : 'ctx', text: raw.slice(1).replace(/\r$/, '') });
    } else {
      throw patchError(`Invalid patch line (must start with ' ', '+', '-', '@@' or '***'): ${raw.slice(0, 60)}`, 'not_executed');
    }
  }
  closeFile();
  if (!files.length) throw patchError('The patch contains no file sections.', 'not_executed');
  return files;
}

function splitLines(content) {
  return String(content || '').replace(/\r\n/g, '\n').split('\n');
}

function joinLines(lines) {
  return lines.join('\n');
}

// A patch must not rewrite the whole file's line endings. Matching normalizes
// CRLF to LF (see splitLines/parsePatch), so the write has to put back the
// style the file already used — otherwise every patched CRLF file silently
// flips to LF and shows its entire content as changed.
function detectEol(content) {
  return /\r\n/.test(String(content || '')) ? '\r\n' : '\n';
}

// Locate the hunk's leading context lines in `lines` at or after `from`.
function findAnchor(lines, hunk, from) {
  const context = hunk.lines.filter(line => line.kind === 'ctx').map(line => line.text);
  if (!context.length) return from; // pure insertion at the current position
  outer:
  for (let start = from; start <= lines.length; start++) {
    for (let i = 0; i < context.length; i++) {
      if (lines[start + i] !== context[i]) continue outer;
    }
    return start;
  }
  return -1;
}

// Apply hunks to `originalLines`. Contract: the optional @@ anchor LOCATES the
// hunk. Two anchor styles are accepted because real models write both:
//   1. anchor strictly BEFORE the change — the body applies after it, and the
//      anchor renders as leading diff context (e.g. `@@ line one` + `-line two`).
//   2. anchor REPEATED as the body's first non-add line (Codex's most common
//      form) — `@@ def run():` + `-def run():` edits the anchor line itself.
// Search is sequential so repeated context matches successive occurrences, and
// line numbers are tracked in BOTH files across hunks.
function applyToLines(originalLines, hunks, label) {
  const result = originalLines.slice();
  const diffChunks = [];
  let searchFrom = 0;
  let shift = 0; // net lines added by earlier hunks: result-coords = original-coords + shift
  for (let index = 0; index < hunks.length; index++) {
    const hunk = hunks[index];
    const nonAdd = hunk.lines.filter(line => line.kind !== 'add');
    const anchorRepeated = Boolean(hunk.anchor) && nonAdd.length > 0 && nonAdd[0].text === hunk.anchor;
    const pattern = hunk.anchor
      ? [hunk.anchor, ...nonAdd.slice(anchorRepeated ? 1 : 0).map(line => line.text)]
      : nonAdd.map(line => line.text);
    let anchorIndex = -1;
    if (!pattern.length) {
      anchorIndex = Math.min(searchFrom, result.length);
    } else {
      outer:
      for (let start = searchFrom; start <= result.length - pattern.length + 1; start++) {
        for (let i = 0; i < pattern.length; i++) {
          if (result[start + i] !== pattern[i]) continue outer;
        }
        anchorIndex = start;
        break;
      }
      if (anchorIndex === -1) {
        const wanted = (pattern[0] || '').slice(0, 80);
        const found = (result[searchFrom] ?? '(end of file)').slice(0, 80);
        throw patchError(`Hunk ${index + 1} of ${label}: pattern not found. Wanted ${JSON.stringify(wanted)}, file has ${JSON.stringify(found)} at line ${searchFrom + 1}. Correct the patch context — do not re-read the file.`, 'context_mismatch');
      }
    }
    const lines = [];
    let oldCursor = anchorIndex - shift + 1;
    let newCursor = anchorIndex + 1;
    let cursor = anchorIndex;
    if (hunk.anchor && !anchorRepeated) {
      // Strictly-before anchor: it is context, existing in both files here.
      if (result[cursor] !== hunk.anchor) {
        throw patchError(`Hunk ${index + 1} of ${label}: anchor mismatch. Read the file again and regenerate the patch.`, 'context_mismatch');
      }
      lines.push({ kind: 'ctx', oldLine: oldCursor, newLine: newCursor, text: hunk.anchor });
      cursor += 1; oldCursor += 1; newCursor += 1;
    }
    for (const line of hunk.lines) {
      if (line.kind === 'ctx') {
        if (result[cursor] !== line.text) {
          throw patchError(`Hunk ${index + 1} of ${label}: context mismatch at old line ${oldCursor}. Expected ${JSON.stringify(line.text)}, found ${JSON.stringify(result[cursor])}. Read the file again and regenerate the patch.`, 'context_mismatch');
        }
        lines.push({ kind: 'ctx', oldLine: oldCursor, newLine: newCursor, text: line.text });
        cursor += 1; oldCursor += 1; newCursor += 1;
      } else if (line.kind === 'del') {
        if (result[cursor] !== line.text) {
          throw patchError(`Hunk ${index + 1} of ${label}: removed-line mismatch at old line ${oldCursor}. Expected ${JSON.stringify(line.text)}, found ${JSON.stringify(result[cursor])}. Read the file again and regenerate the patch.`, 'context_mismatch');
        }
        lines.push({ kind: 'del', oldLine: oldCursor, newLine: null, text: line.text });
        result.splice(cursor, 1);
        oldCursor += 1; shift -= 1;
      } else {
        lines.push({ kind: 'add', oldLine: null, newLine: newCursor, text: line.text });
        result.splice(cursor, 0, line.text);
        cursor += 1; newCursor += 1; shift += 1;
      }
    }
    searchFrom = cursor;
    diffChunks.push({ oldStart: lines[0]?.oldLine ?? oldCursor, newStart: lines[0]?.newLine ?? newCursor, lines });
  }
  return { result, diffChunks };
}

function applyPatch({ patch, read, write }) {
  const files = parsePatch(patch);
  // Two phases: compute EVERY file's result first, then write. A multi-file
  // patch that fails on file 2 must not leave file 1 already mutated — a
  // half-applied patch is indistinguishable from a corrupted one.
  const results = [];
  const overlay = new Map();
  // Later sections of the SAME path in one patch see this patch's own earlier
  // result (the sequential contract) without any byte hitting disk yet.
  const readCurrent = (target) => (overlay.has(target) ? overlay.get(target) : read(target));
  for (const file of files) {
    if (file.action === 'delete') {
      const existing = readCurrent(file.path);
      if (existing === null) throw patchError(`*** Delete File: ${file.path} — the file does not exist.`, 'not_executed');
      overlay.set(file.path, null);
      results.push({ path: file.path, action: 'delete', removedLines: splitLines(existing).length, diff: [] });
      continue;
    }
    if (file.action === 'add') {
      if (readCurrent(file.path) !== null) throw patchError(`*** Add File: ${file.path} — the file already exists. Use Update File instead.`, 'not_executed');
      const additions = file.hunks.flatMap(hunk => hunk.lines).filter(line => line.kind === 'add').map(line => line.text);
      if (!additions.length) throw patchError(`*** Add File: ${file.path} contains no '+ ' lines.`, 'not_executed');
      overlay.set(file.path, joinLines(additions));
      const lines = additions.map((text, i) => ({ kind: 'add', oldLine: null, newLine: i + 1, text }));
      results.push({ path: file.path, action: 'add', addedLines: additions.length, diff: [{ oldStart: 1, newStart: 1, lines }] });
      continue;
    }
    // update
    const existing = readCurrent(file.path);
    if (existing === null) throw patchError(`*** Update File: ${file.path} — the file does not exist. Use Add File for new files.`, 'not_executed');
    const originalLines = splitLines(existing);
    const { result, diffChunks } = applyToLines(originalLines, file.hunks, file.path);
    const removed = diffChunks.reduce((sum, chunk) => sum + chunk.lines.filter(line => line.kind === 'del').length, 0);
    const added = diffChunks.reduce((sum, chunk) => sum + chunk.lines.filter(line => line.kind === 'add').length, 0);
    if (!removed && !added) continue;
    // Re-emit with the file's own line-ending style so a CRLF source stays
    // CRLF (matching above normalized both sides to LF).
    overlay.set(file.path, result.join(detectEol(existing)));
    results.push({ path: file.path, action: 'update', addedLines: added, removedLines: removed, diff: diffChunks });
  }
  for (const [path, content] of overlay) write(path, content);
  return { applied: true, files: results };
}

// Line diff for whole-file mutations (computer_file write/append/edit/delete
// and similar). Same chunk/line shape as the patch engine so one renderer draws
// both: dels numbered in the OLD file, adds numbered in the NEW file, a deleted
// line frees its slot. Exact LCS is unnecessary here — the common prefix and
// suffix are trimmed and the changed middle is shown whole, which is honest,
// stable, and cheap for the sizes this tool accepts (1 MB cap).
function computeLineDiff(oldText, newText, { maxLines = 400, context = 3 } = {}) {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
  const removed = oldEnd - start, added = newEnd - start;
  // Identical content: a diff of nothing is no diff at all.
  if (!removed && !added) return { addedLines: 0, removedLines: 0, truncated: false, chunks: [] };
  const lines = [];
  let truncated = false;
  const push = (line) => {
    if (lines.length >= maxLines) { truncated = true; return; }
    lines.push(line);
  };
  const ctxFrom = (source, from, to, oldBase, newBase) => {
    for (let i = from; i < to; i++) push({ kind: 'ctx', oldLine: oldBase + i, newLine: newBase + i, text: source[i] });
  };
  // Leading context (before the change window). The prefix is common, so old
  // and new line numbers are identical here.
  const ctxStart = Math.max(0, start - context);
  ctxFrom(oldLines, ctxStart, start, 1, 1);
  for (let i = start; i < oldEnd; i++) push({ kind: 'del', oldLine: i + 1, newLine: null, text: oldLines[i] });
  for (let i = start; i < newEnd; i++) push({ kind: 'add', oldLine: null, newLine: i + 1, text: newLines[i] });
  // Trailing context: the suffix is common but sits at DIFFERENT line numbers
  // in each file once the middle has shifted them apart.
  const ctxEnd = Math.min(newLines.length, newEnd + context);
  for (let i = newEnd; i < ctxEnd; i++) {
    const oldIndex = oldEnd + (i - newEnd);
    if (oldIndex < oldLines.length) push({ kind: 'ctx', oldLine: oldIndex + 1, newLine: i + 1, text: newLines[i] });
  }
  // When leading context exists the first emitted line sits at old line
  // ctxStart+1; otherwise the first del/add sits at start+1.
  const firstLine = ctxStart < start ? ctxStart + 1 : start + 1;
  return {
    addedLines: added,
    removedLines: removed,
    truncated: truncated || removed + added > maxLines,
    chunks: lines.length ? [{ oldStart: firstLine, newStart: firstLine, lines }] : []
  };
}

// ---------------------------------------------------------------------------
// Real-time per-line append engine (computer_patch ops[]). One op = one line
// change with exact 1-based line numbers; ops apply in order and every changed
// line is emitted into the diff so the UI can count (+added)/(−removed)
// incrementally as lines land, like Claude/Code streaming edits.
// ---------------------------------------------------------------------------

function applyLineOps(originalText, ops, label = 'file', onOp = null) {
  const lines = splitLines(originalText);
  const eol = detectEol(originalText);
  const diffLines = [];
  let added = 0;
  let removed = 0;
  const errors = [];
  const resolveLine = (value, { allowEnd = false } = {}) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return null;
    if (n > lines.length && !(allowEnd && n === lines.length + 1)) return null;
    return n - 1;
  };
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i] || {};
    const kind = String(op.op || '');
    try {
      if (kind === 'append' || kind === 'insert') {
        const incoming = Array.isArray(op.lines) ? op.lines.map(String) : (op.text != null ? [String(op.text)] : []);
        if (!incoming.length) throw patchError(`op ${i + 1}: ${kind} needs lines[] or text.`, 'not_executed');
        let at;
        if (kind === 'append') {
          const after = op.afterLine === undefined || op.afterLine === null ? lines.length : resolveLine(op.afterLine, { allowEnd: true });
          if (after === null) throw patchError(`op ${i + 1}: afterLine ${op.afterLine} is out of range (file has ${lines.length} lines).`, 'context_mismatch');
          at = after; // afterLine N => insert after line N
        } else {
          const atLine = resolveLine(op.line, { allowEnd: true });
          if (atLine === null) throw patchError(`op ${i + 1}: insert line ${op.line} is out of range (file has ${lines.length} lines).`, 'context_mismatch');
          at = atLine; // insert before line N
        }
        lines.splice(at, 0, ...incoming);
        incoming.forEach((text, offset) => {
          diffLines.push({ kind: 'add', oldLine: null, newLine: at + 1 + offset, text });
        });
        added += incoming.length;
        onOp?.({ op: i + 1, type: kind, path: label, addedLines: added, removedLines: removed, line: at + incoming.length, totalOps: ops.length });
      } else if (kind === 'replace') {
        const at = resolveLine(op.line);
        if (at === null || op.text === undefined || op.text === null) {
          throw patchError(`op ${i + 1}: replace needs a valid 1-based line (1..${lines.length}) and text.`, 'context_mismatch');
        }
        diffLines.push({ kind: 'del', oldLine: at + 1, newLine: null, text: lines[at] });
        diffLines.push({ kind: 'add', oldLine: null, newLine: at + 1, text: String(op.text) });
        lines[at] = String(op.text);
        added += 1; removed += 1;
        onOp?.({ op: i + 1, type: kind, path: label, addedLines: added, removedLines: removed, line: at + 1, totalOps: ops.length });
      } else if (kind === 'delete') {
        const at = resolveLine(op.line);
        if (at === null) throw patchError(`op ${i + 1}: delete line ${op.line} is out of range (file has ${lines.length} lines).`, 'context_mismatch');
        diffLines.push({ kind: 'del', oldLine: at + 1, newLine: null, text: lines[at] });
        lines.splice(at, 1);
        removed += 1;
        onOp?.({ op: i + 1, type: kind, path: label, addedLines: added, removedLines: removed, line: at + 1, totalOps: ops.length });
      } else {
        throw patchError(`op ${i + 1}: unknown op ${JSON.stringify(kind)} (append|insert|replace|delete).`, 'not_executed');
      }
    } catch (error) {
      errors.push({ op: i + 1, message: error.message, outcome: error.patchOutcome || 'execution_failed' });
      // keep going: later ops still apply, and the caller sees exactly which op failed
    }
  }
  return {
    content: lines.join(eol),
    diff: diffLines.length ? [{ oldStart: 1, newStart: 1, lines: diffLines }] : [],
    addedLines: added,
    removedLines: removed,
    errors
  };
}

module.exports = { parsePatch, applyPatch, applyLineOps, computeLineDiff, splitLines, MAX_FILE_BYTES };
