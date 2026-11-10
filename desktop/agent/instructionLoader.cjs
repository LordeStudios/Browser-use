'use strict';

// GEN9 — Instruction files (AGENTS.md convention) — desktop/skills_mcp_plan.md
// Section 5 and STUB 3.
//
// At run start (DesktopChatAgent lifecycle, one loading point for BOTH the
// desktop app and the CLI) the agent loads the pinned repo's instruction file
// as PINNED context: the compaction-exempt region that states repo
// conventions. Precedence per root: lorde.md > AGENTS.md > CLAUDE.md (lorde.md
// is this tool's own convention and wins when present). The pinned repo root
// is tried first; the cwd is a fallback only when the repo root has none.
//
// Content cap: 8192 chars total across the selected files. When over cap the
// LARGEST file is truncated first (largest-first), every cut appends an
// in-band notice naming the file and how much was cut — nothing is silently
// dropped.
//
// The loaded files also seed the notebook's user-rules section
// (notebookUserRules) — the persistent notebook feature consumes rows, never
// raw markdown.

const fs = require('node:fs');
const path = require('node:path');

const INSTRUCTION_FILES = ['lorde.md', 'AGENTS.md', 'CLAUDE.md'];
const DEFAULT_CAP = 8192;
const NOTICE_TEMPLATE = '…[truncated: {file} capped at {kept} of {original} chars — instruction cap {cap}]';

function findInstructionFile(root, fsLike) {
  const cleanRoot = String(root || '').trim();
  if (!cleanRoot) return null;
  try { if (!fsLike.statSync(cleanRoot).isDirectory()) return null; } catch { return null; }
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(cleanRoot, name);
    try { if (fsLike.statSync(file).isFile()) return file; } catch { /* try next */ }
  }
  return null;
}

// Truncates content to `allowed` chars, reserving room for the notice, and
// appends the notice as the last line. A cut is only ever applied when it
// actually shortens the content.
function truncateWithNotice(name, content, allowed, cap) {
  if (content.length <= allowed) return { content, original: content.length, notice: null };
  const notice = NOTICE_TEMPLATE
    .replace('{file}', name)
    .replace('{kept}', String(allowed))
    .replace('{original}', String(content.length))
    .replace('{cap}', String(cap));
  const kept = Math.max(0, allowed - notice.length - 1);
  return { content: `${content.slice(0, kept)}\n${notice}`, original: content.length, notice };
}

// loadInstructionFiles({ repoRoot, cwd, cap, fs }) ->
//   null when no instruction file exists anywhere, else
//   { files: [{root, path, name, content, chars, originalChars, truncated, notice}],
//     cap, block }
// The block is the exact text injected at run start; null files -> null block.
function loadInstructionFiles({ repoRoot = '', cwd = '', cap = DEFAULT_CAP, fs: fsLike = fs } = {}) {
  const roots = [];
  for (const candidate of [repoRoot, cwd]) {
    const resolved = String(candidate || '').trim();
    if (resolved && !roots.includes(resolved)) roots.push(resolved);
  }
  const files = [];
  for (const root of roots) {
    const file = findInstructionFile(root, fsLike);
    if (!file) continue;
    // The pinned repo root wins; the cwd fallback applies ONLY when the repo
    // root produced no instruction file (never both).
    if (files.length && root !== roots[0]) break;
    let content;
    try { content = fsLike.readFileSync(file, 'utf8'); } catch { continue; }
    files.push({
      root,
      path: file,
      name: path.basename(file),
      content,
      chars: content.length,
      originalChars: content.length,
      truncated: false,
      notice: null
    });
  }
  if (!files.length) return null;

  // Largest-first truncation under the total cap: cut the biggest file until
  // the total fits; drop files entirely only when the remaining budget is
  // smaller than the notice itself.
  let total = files.reduce((sum, file) => sum + file.content.length, 0);
  const order = [...files.keys()].sort((a, b) => files[b].content.length - files[a].content.length);
  let index = 0;
  while (total > cap && index < order.length) {
    const file = files[order[index]];
    const budget = cap - (total - file.content.length);
    if (budget <= 0) {
      total -= file.content.length;
      file.content = '';
      file.chars = 0;
      file.truncated = true;
      file.notice = NOTICE_TEMPLATE
        .replace('{file}', file.name)
        .replace('{kept}', '0')
        .replace('{original}', String(file.originalChars))
        .replace('{cap}', String(cap));
    } else {
      const cut = truncateWithNotice(file.name, file.content, budget, cap);
      total += cut.content.length - file.content.length;
      file.content = cut.content;
      file.chars = cut.content.length;
      file.truncated = true;
      file.notice = cut.notice;
    }
    index += 1;
  }

  const kept = files.filter(file => file.content.length > 0 || file.notice);
  const sections = kept.map(file => file.content
    ? `### ${file.name} (${file.path}, ${file.chars} chars)\n${file.content}`
    : `### ${file.name} (${file.path}) — ${file.notice}`);
  const header = 'INSTRUCTION FILES (repo conventions — pinned context, not a user task):';
  return {
    files: kept,
    cap,
    block: `${header}\n${sections.join('\n\n')}`
  };
}

// Prepends the block to a task text (CLI composition-root integration until
// STUB 3 lands; single-injection invariant documented in the plan).
function instructionBlockForTask(task, instructions) {
  const text = String(task || '');
  if (!instructions?.block) return text;
  return `${text}\n\n${instructions.block}`;
}

// Notebook user-rules rows (persistent notebook feature): one capped row per
// kept file. The notebook stores RULES, not raw markdown, so each row names
// its file and carries a bounded excerpt.
const RULE_ROW_CAP = 1200;
function notebookUserRules(instructions) {
  if (!instructions?.files?.length) return [];
  return instructions.files.map(file => ({
    name: `instructions:${file.name}`,
    text: `Repo instructions from ${file.path}${file.notice ? ` (${file.notice})` : ''}:\n${file.content.slice(0, RULE_ROW_CAP)}`
  }));
}

module.exports = {
  INSTRUCTION_FILES,
  DEFAULT_CAP,
  RULE_ROW_CAP,
  findInstructionFile,
  loadInstructionFiles,
  instructionBlockForTask,
  notebookUserRules,
  truncateWithNotice
};
