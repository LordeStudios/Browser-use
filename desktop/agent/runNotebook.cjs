'use strict';

// LORDE_RUN_NOTEBOOK_GEN9 — the per-run PERSISTENT NOTEBOOK.
//
// Owner problem (gen9 defect catalog, F:\harness-lab\gen9\defect-catalog.md):
// long chats lose load-bearing session state — the working repo (D1: ~10 min
// searching the wrong repo), the build/serve pipeline (D2: re-derived 4x),
// what was already patched (D4), whole requirements (D5) — because every one
// of those facts lived in compactable turns, and the ledger raw-evicts turns
// past maxTurns WITHOUT summarizing (providerTurnLedger.cjs evictToFit).
//
// Design:
//   1. DURABLE FILE — one plain markdown file per run (CLI: out-dir/notebook.md;
//      desktop: userData/notebooks/<conversationId>.md). The FILE is the
//      source of truth; every write is disk-read-merge-atomic-write so user
//      edits made between agent writes always win.
//   2. PINNED WIRE — the notebook rides the pinned wire head (rebuilt EVERY
//      decision from live disk state, never stored in turns), so neither the
//      compaction path nor the raw-evict path can touch it. Full text rides
//      while <= FULL_WIRE_BYTES; past that a <= 20-line index rides and the
//      model reads sections on demand through the `notebook` tool.
//   3. SECTION OWNERSHIP — known user sections (USER RULES, CREDENTIALS &
//      KEYS, COMMANDS, NOTES) are owned by the user: an edit replaces them
//      verbatim. Known agent sections keep their on-disk content on user
//      edits (agent entries never clobbered) while user-added lines are
//      preserved. Unknown (user-created) sections are preserved verbatim.
//   4. ONE SOURCE OF TRUTH FOR REPOS — the run's repoMap
//      (workspacePin.cjs, ported from gen7-arch1) owns repo attribution; the
//      notebook's WORKING REPOS section is a mirror written from it, and can
//      rehydrate the map after a restore from an older snapshot.

const fs = require('node:fs');
const { quoteRequest } = require('./requestQuote.cjs');
const path = require('node:path');
const { parseRepoSection } = require('./workspacePin.cjs');

// Wire budget: below this the FULL notebook rides the pinned wire (removes a
// read round-trip per decision — the seed is ~0.5-1 KB); above it only the
// index rides and sections are read on demand. Worst case pinned cost stays
// ~2k tokens (~1.5% of a 131k window).
const FULL_WIRE_BYTES = 4_096;
const INDEX_LINE_LIMIT = 20;
// Agent appends are bounded so a long run cannot bloat the file or the wire.
const SECTION_LINE_CAPS = { 'WRITE TRAIL': 40, DECISIONS: 40, 'TASK REQUIREMENTS': 60, 'PROJECT FACTS': 40, 'TOOL CONTRACTS': 40, 'WORKING REPOS': 16 };

const USER_SECTIONS = ['USER RULES', 'CREDENTIALS & KEYS', 'COMMANDS', 'NOTES'];
const AGENT_SECTIONS = ['WORKING REPOS', 'TASK REQUIREMENTS', 'PROJECT FACTS', 'TOOL CONTRACTS', 'WRITE TRAIL', 'DECISIONS'];
const SECTION_ORDER = [...AGENT_SECTIONS, ...USER_SECTIONS];

function clockLabel(ms = Date.now()) {
  const date = new Date(Number(ms) || Date.now());
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Parse notebook text into ordered sections. Everything before the first
// `## ` header is the preamble (the `# ` intro comment block) and is kept
// verbatim across merges. Unknown headers are first-class sections.
function parseNotebook(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const header = line.match(/^##\s+(.+?)\s*$/);
    if (header) {
      if (current) current.lines = trimTrailingBlanks(current.lines);
      current = { title: header[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (current) current.lines = trimTrailingBlanks(current.lines);
  return { preamble: preamble.join('\n'), sections };
}

function trimSectionLines(title, lines) {
  const cap = SECTION_LINE_CAPS[title];
  if (!cap || lines.length <= cap) return lines;
  // Bounded sections keep the NEWEST lines (trail/decisions); requirement and
  // fact sections rarely hit the cap, and if they do the newest facts still win.
  return lines.slice(-cap);
}

function renderNotebook({ preamble, sections }) {
  const parts = [preamble.replace(/\n+$/, '')];
  for (const section of sections) {
    const body = trimSectionLines(section.title, section.lines).join('\n').replace(/\n+$/, '');
    parts.push(`## ${section.title}\n${body}`.replace(/\n+$/, ''));
  }
  return `${parts.filter(part => part.length).join('\n\n')}\n`;
}

function findSection(sections, title) {
  return sections.find(section => section.title.toLowerCase() === String(title || '').trim().toLowerCase()) || null;
}

// Sections are canonical: trailing blank lines are padding, never content.
function trimTrailingBlanks(lines) {
  const copy = [...lines];
  while (copy.length && !copy[copy.length - 1].trim()) copy.pop();
  return copy;
}

// THE MERGE. current = on-disk truth (agent entries), edited = what the user
// saved from the popup/TUI. User sections take the edited content verbatim
// (user wins, including deletions); agent sections keep their on-disk content
// and absorb any lines the editor ADDED (a user appending to TASK
// REQUIREMENTS must not lose the agent's entries); unknown sections are the
// user's own and pass through verbatim. Agent-owned sections missing from
// the edited text are restored from disk (a stray delete cannot destroy the
// run's state).
function mergeNotebookText(currentText, editedText) {
  const current = parseNotebook(currentText);
  const edited = parseNotebook(editedText);
  const merged = [];
  for (const section of edited.sections) {
    if (USER_SECTIONS.some(title => title.toLowerCase() === section.title.toLowerCase())) {
      merged.push({ title: section.title, lines: [...section.lines] });
      continue;
    }
    const knownAgent = AGENT_SECTIONS.some(title => title.toLowerCase() === section.title.toLowerCase());
    if (!knownAgent) {
      merged.push({ title: section.title, lines: [...section.lines] });
      continue;
    }
    const onDisk = findSection(current.sections, section.title);
    const base = onDisk ? onDisk.lines.filter(line => line.trim()) : [];
    const editedLines = section.lines.filter(line => line.trim());
    const additions = editedLines.filter(line => !base.includes(line));
    merged.push({ title: section.title, lines: [...base, ...additions] });
  }
  for (const section of current.sections) {
    if (!findSection(merged, section.title) && AGENT_SECTIONS.some(title => title.toLowerCase() === section.title.toLowerCase())) {
      merged.push({ title: section.title, lines: [...section.lines] });
    }
  }
  // Keep the notebook's canonical section order stable so diffs and the wire
  // stay predictable; unknown sections keep their edited position at the end.
  merged.sort((a, b) => {
    const ai = SECTION_ORDER.findIndex(title => title.toLowerCase() === a.title.toLowerCase());
    const bi = SECTION_ORDER.findIndex(title => title.toLowerCase() === b.title.toLowerCase());
    return (ai === -1 ? SECTION_ORDER.length : ai) - (bi === -1 ? SECTION_ORDER.length : bi);
  });
  const preamble = edited.preamble.trim() ? edited.preamble : current.preamble;
  return { text: renderNotebook({ preamble, sections: merged }), changed: renderNotebook({ preamble: current.preamble, sections: current.sections }) !== renderNotebook({ preamble, sections: merged }) };
}

// The <= 20-line index: section headers + line counts. This is what rides the
// wire when the notebook outgrows the full-ride budget.
function notebookIndex(text, filePath = '') {
  const { sections } = parseNotebook(text);
  const present = sections.filter(section => section.lines.some(line => line.trim()));
  if (!present.length) return null;
  const label = filePath ? ` (${filePath})` : '';
  const lines = present.map(section => `## ${section.title} — ${section.lines.filter(line => line.trim()).length} line(s)`);
  return `NOTEBOOK INDEX${label}:\n${lines.slice(0, INDEX_LINE_LIMIT - 1).join('\n')}${lines.length > INDEX_LINE_LIMIT - 1 ? `\n(+${lines.length - (INDEX_LINE_LIMIT - 1)} more sections)` : ''}`;
}

// The pinned-wire form: full text while small, index past the budget.
function notebookWireContext(text, filePath = '') {
  const clean = String(text || '');
  if (!clean.trim()) return null;
  if (Buffer.byteLength(clean, 'utf8') <= FULL_WIRE_BYTES) {
    return `RUN NOTEBOOK (persisted at ${filePath || 'disk'} — survives compaction; user rules, working repos, credentials, commands, and settled facts live here. Treat it as standing ground truth):\n${clean.trim()}`;
  }
  const index = notebookIndex(clean, filePath);
  return index ? `${index}\nThe notebook body persists at ${filePath || 'disk'} — read sections on demand with the notebook tool (op=read).` : null;
}

// Seed content. Requirements come from the SAME parser the coordinator's
// requirementLedger uses — one extraction, one source of truth.
function seedNotebookText({ task = '', workspace = null, repoMap = [], requirements = [] } = {}) {
  const sections = [];
  const repos = [];
  for (const entry of Array.isArray(repoMap) ? repoMap : []) {
    if (!entry?.root) continue;
    repos.push(`- %${String(entry.name || '').slice(0, 60) || 'repo'}% %${entry.root}% ${entry.pinned ? 'pinned' : 'referenced'}`);
  }
  if (workspace?.root && !repos.some(line => line.includes(workspace.root))) {
    const name = String(workspace.root).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'workspace';
    repos.unshift(`- %${name}% %${workspace.root}% pinned`);
  }
  sections.push({ title: 'WORKING REPOS', lines: repos.length ? repos : ['- (none yet — the pinned working repo appears here automatically)'] });
  const reqLines = (Array.isArray(requirements) ? requirements : [])
    .map(req => `- [OPEN] ${quoteRequest(req?.text || req || '', 1200)}`)
    .filter(line => line.length > 10);
  sections.push({ title: 'TASK REQUIREMENTS', lines: reqLines.length ? reqLines : ['- [OPEN] ' + quoteRequest(task)] });
  sections.push({ title: 'PROJECT FACTS', lines: [
    '- (record build/serve pipeline facts here once discovered — notebook update section="PROJECT FACTS" text="..." e.g. "build: node build.mjs -> dist/; the dev server serves dist/, NOT src/; edit src then BUILD")'
  ] });
  sections.push({ title: 'TOOL CONTRACTS', lines: [
    '- computer_patch: the `Update File:` header must equal the `path` argument byte-for-byte (use the absolute Windows path); one file per patch.',
    '- On a patch failure the file is NOT partially applied unless the diff says so — check the ownership notice.',
    '- After an ownership-guard conflict, re-read the exact hunk once and compare against the intended change — the conflict may be your own already-landed write.'
  ] });
  sections.push({ title: 'WRITE TRAIL', lines: [] });
  sections.push({ title: 'DECISIONS', lines: [] });
  for (const title of USER_SECTIONS) sections.push({ title, lines: [] });
  return renderNotebook({
    preamble: [
      '# RUN NOTEBOOK',
      '# Durable session state — survives compaction, eviction, restart, and continuation.',
      '# USER sections (USER RULES, CREDENTIALS & KEYS, COMMANDS, NOTES) are yours to edit;',
      '# agent sections are appended by the run and never clobber your edits.'
    ].join('\n'),
    sections
  });
}

function atomicWrite(filePath, text, fsLike = fs) {
  const tmp = `${filePath}.tmp`;
  fsLike.writeFileSync(tmp, text, 'utf8');
  fsLike.renameSync(tmp, filePath);
}

// Standalone append for the CLI (`/notebook <text>`) and any caller without a
// run handle: creates the file when missing, appends one line to NOTES.
function appendUserLine(filePath, text, fsLike = fs) {
  const clean = String(text || '').trim();
  if (!clean) return { ok: false, error: 'nothing to append' };
  let current = '';
  try { current = fsLike.readFileSync(filePath, 'utf8'); } catch { current = seedNotebookText({}); }
  const parsed = parseNotebook(current);
  const section = findSection(parsed.sections, 'NOTES') || parsed.sections.find(item => item.title === 'NOTES');
  if (section) section.lines.push(`- [${clockLabel()}] ${clean.slice(0, 500)}`);
  else parsed.sections.push({ title: 'NOTES', lines: [`- [${clockLabel()}] ${clean.slice(0, 500)}`] });
  const next = renderNotebook(parsed);
  fsLike.mkdirSync(path.dirname(filePath), { recursive: true });
  atomicWrite(filePath, next, fsLike);
  return { ok: true, filePath };
}

function createRunNotebook({ filePath, task = '', workspace = null, repoMap = null, requirements = null, fsLike = fs } = {}) {
  const file = path.resolve(String(filePath || ''));
  if (!file) throw new Error('createRunNotebook requires a filePath.');

  const read = () => {
    try { return fsLike.readFileSync(file, 'utf8'); } catch { return ''; }
  };
  const write = (text) => {
    fsLike.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, text, fsLike);
  };

  const api = {
    filePath: file,
    exists: () => { try { return fsLike.statSync(file).isFile(); } catch { return false; } },
    read,
    // Seed once: a missing file is created from the task + workspace + repo
    // map. An existing file is NEVER rewritten by seeding (user edits win).
    ensureSeeded() {
      if (api.exists()) return { seeded: false, text: read() };
      const text = seedNotebookText({
        task,
        workspace,
        repoMap: typeof repoMap === 'function' ? repoMap() : repoMap,
        requirements: requirements !== null ? requirements : defaultRequirements(task)
      });
      write(text);
      return { seeded: true, text };
    },
    // Agent append: disk-read-merge-write, so a user edit that landed between
    // two agent writes is preserved.
    append(section, line) {
      const clean = String(line || '').trim();
      if (!clean) return { ok: false };
      const parsed = parseNotebook(read());
      let target = findSection(parsed.sections, section);
      if (!target) { target = { title: String(section), lines: [] }; parsed.sections.push(target); }
      target.lines.push(`- [${clockLabel()}] ${clean.slice(0, 500)}`);
      write(renderNotebook(parsed));
      return { ok: true };
    },
    // Mirror the run's repoMap into WORKING REPOS. Idempotent — writes only
    // when the rendered rows actually changed (called at turn boundaries).
    syncRepoSection(map) {
      const rows = (Array.isArray(map) ? map : []).filter(entry => entry?.root)
        .map(entry => `- %${String(entry.name || '').slice(0, 60) || 'repo'}% %${entry.root}% ${entry.pinned ? 'pinned' : 'referenced'}`);
      if (!rows.length) return { changed: false };
      const parsed = parseNotebook(read());
      const section = findSection(parsed.sections, 'WORKING REPOS');
      const next = rows.join('\n');
      if (section && section.lines.filter(line => line.trim()).join('\n') === next) return { changed: false };
      if (section) section.lines = rows;
      else parsed.sections.push({ title: 'WORKING REPOS', lines: rows });
      write(renderNotebook(parsed));
      return { changed: true };
    },
    // User save (desktop popup / any editor): merge, never clobber.
    applyUserEdit(editedText) {
      const { text } = mergeNotebookText(read(), String(editedText || ''));
      write(text);
      return { ok: true };
    },
    readSection(section) {
      const found = findSection(parseNotebook(read()).sections, section);
      return found ? found.lines.join('\n').trim() : null;
    },
    // Rehydrate a repo map from the file (restore-from-old-snapshot path).
    repoMapFromDisk() {
      const section = findSection(parseNotebook(read()).sections, 'WORKING REPOS');
      return section ? parseRepoSection(section.lines.join('\n')) : [];
    },
    wireContext() {
      return notebookWireContext(read(), file);
    }
  };
  return api;
}

// Requirement extraction for seeding. The coordinator's
// parseNumberedRequirements is required lazily so this module stays usable in
// isolation (and in tests) even if the coordinator graph changes.
function defaultRequirements(task) {
  try {
    const { parseNumberedRequirements } = require('./desktopAgentCoordinator.cjs');
    const parsed = parseNumberedRequirements(task);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch { /* fall through to the plain-text requirement */ }
  return [];
}

module.exports = {
  FULL_WIRE_BYTES,
  INDEX_LINE_LIMIT,
  USER_SECTIONS,
  AGENT_SECTIONS,
  parseNotebook,
  renderNotebook,
  mergeNotebookText,
  notebookIndex,
  notebookWireContext,
  seedNotebookText,
  createRunNotebook,
  appendUserLine
};
