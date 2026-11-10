'use strict';

// LORDE_WORKSPACE_PIN_GEN7 — the working-repo PIN and the per-conversation
// REPO MAP.
//
// Owner problem (issue 1): with multiple repos in play the agent FORGETS the
// working repo, mixes repos, and trial-and-error searches unreferenced
// folders. Owner directive: like Claude Code — when the user says "make this
// the working repo", it becomes THE working repo and the user never types it
// again; other referenced repos are attributed consistently.
//
// Design (focus, never a boundary — 2026-10-11 directive stands):
//   1. PIN: one repo is THE working repo for the conversation. Pinned by
//      (a) natural language ("make this the working repo", "use X as the
//      workspace", "/cd <path>"), (b) the model's workspace_retarget call on
//      a user-named directory, (c) the task text naming an absolute dir
//      (pre-existing task-derived seeding in main.cjs).
//   2. REPO MAP: every repo the conversation referenced (pinned, task-named,
//      user-mentioned, or retargeted) maps root -> name and rides EVERY
//      model decision on the wire, so searches/patches are attributed to the
//      right root without guessing.
//   3. The pin changes DEFAULTS only (search/index roots, terminal cwd
//      auto-injection). Out-of-root access stays allowed — no rejection path
//      exists here and none may be added.

const path = require('node:path');

const REPO_MAP_LIMIT = 12;
const REPO_SOURCES = ['pinned', 'task', 'mentioned', 'retarget', 'previous'];

// Absolute-path candidates in free text. Mirrors main.cjs's scan family.
const PATH_SCAN = /[A-Za-z]:[\\/][^\s"',;)\]]+|\/(?:home|Users|mnt|var|opt|tmp)\/[^\s"',;)\]]+/g;

const PIN_PATTERNS = [
  // "make this/that/it/<path> the working repo|workspace|..."
  /(?:^|[.!?;]\s)make\s+(?:(?:this|that|it|the\s+current\s+(?:folder|directory))|(?<path>[A-Za-z]:[\\/][^\s"',;)\]]+|\/(?:home|Users|mnt|var|opt|tmp)\/[^\s"',;)\]]+))\s+(?:the\s+|my\s+|our\s+)?(?:working\s+repo|working\s+folder|working\s+dir(?:ectory)?|workspace|repo)\b/i,
  // "set|switch the working repo|workspace|... to|as <path>"
  /(?:^|[.!?;]\s)(?:set|switch)\s+(?:the\s+|my\s+|our\s+)?(?:working\s+repo|working\s+folder|working\s+dir(?:ectory)?|workspace|repo)\s+(?:to|as)\s+(?<path>[A-Za-z]:[\\/][^\s"',;)\]]+|\/(?:home|Users|mnt|var|opt|tmp)\/[^\s"',;)\]]+)/i,
  // "use <path> as the working repo|workspace|..."
  /(?:^|[.!?;]\s)use\s+(?<path>[A-Za-z]:[\\/][^\s"',;)\]]+|\/(?:home|Users|mnt|var|opt|tmp)\/[^\s"',;)\]]+)\s+as\s+(?:the\s+|my\s+|our\s+)?(?:working\s+repo|working\s+folder|working\s+dir(?:ectory)?|workspace|repo)\b/i,
  // "work in|from|out of <path> from now on|instead|going forward"
  /(?:^|[.!?;]\s)work\s+(?:in|from|out\s+of)\s+(?<path>[A-Za-z]:[\\/][^\s"',;)\]]+|\/(?:home|Users|mnt|var|opt|tmp)\/[^\s"',;)\]]+)\s+(?:from\s+now\s+on|instead|going\s+forward|now\s+on)\b/i
];

const QUERY_PATTERNS = [
  /what(?:'s|\s+is)\s+(?:the\s+)?(?:current\s+)?working\s+(?:repo|folder|director(?:y|ie)s?)\b/i,
  /which\s+(?:repo|folder|director(?:y))\s+(?:are\s+we|am\s+i)\s+(?:in|working)/i,
  /what\s+workspace\s+(?:is\s+(?:this|the)\s+run\s+|are\s+we\s+)(?:using|scoped\s+to|pinned\s+to)/i
];

function stripTrailingPunctuation(value) {
  return String(value || '').replace(/[.,;:)\]]+$/, '').trim();
}

function scanPaths(text) {
  const matches = String(text || '').match(PATH_SCAN) || [];
  return [...new Set(matches.map(stripTrailingPunctuation).filter(Boolean))];
}

// Detects the user's pin intent in natural language (and /cd). Never
// fabricates a path: "make this the working repo" carries path=null and the
// caller resolves "this" from context (directory attachment, current root).
function parseRepoPinIntent(text) {
  const content = String(text || '').trim();
  if (!content) return { kind: 'none' };
  // /cd is an explicit command form of the same intent.
  const cdMatch = content.match(/^\/cd(?:\s+(\S.*))?\s*$/i);
  if (cdMatch) {
    const rest = String(cdMatch[1] || '').trim();
    return { kind: 'pin', path: rest ? stripTrailingPunctuation(rest) : null, via: 'cd' };
  }
  for (const pattern of QUERY_PATTERNS) {
    if (pattern.test(content)) return { kind: 'query' };
  }
  for (const pattern of PIN_PATTERNS) {
    const match = content.match(pattern);
    if (!match) continue;
    const named = match.groups?.path ? stripTrailingPunctuation(match.groups.path) : null;
    if (named) return { kind: 'pin', path: named, via: 'sentence' };
    // A path may still ride elsewhere in the sentence ("make the repo at
    // F:\x the working repo").
    const candidates = scanPaths(content);
    return { kind: 'pin', path: candidates.length ? candidates[candidates.length - 1] : null, via: 'sentence' };
  }
  return { kind: 'none' };
}

function repoName(root) {
  const clean = String(root || '').replace(/[\\/]+$/, '');
  return path.basename(clean) || clean;
}

function normalizeRepoMap(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const entries = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const root = String(raw.root || '').trim();
    if (!root || seen.has(root)) continue;
    seen.add(root);
    entries.push({
      root,
      name: String(raw.name || repoName(root)).slice(0, 80),
      pinned: raw.pinned === true,
      source: REPO_SOURCES.includes(raw.source) ? raw.source : 'mentioned',
      lastUsedAt: Number(raw.lastUsedAt) || 0
    });
  }
  return entries.slice(-REPO_MAP_LIMIT);
}

// Registers a referenced repo (idempotent) and optionally pins it. Exactly
// one entry may be pinned at a time. Returns the same array (mutated) so
// callers keep one canonical map on the run.
function registerRepo(repoMap, root, { pinned = false, source = 'mentioned', at = Date.now() } = {}) {
  const cleanRoot = String(root || '').trim();
  if (!cleanRoot) return normalizeRepoMap(repoMap);
  const map = Array.isArray(repoMap) ? repoMap : [];
  let entry = map.find(item => item.root === cleanRoot);
  if (!entry) {
    entry = { root: cleanRoot, name: repoName(cleanRoot), pinned: false, source: 'mentioned', lastUsedAt: 0 };
    map.push(entry);
  }
  entry.lastUsedAt = Number(at) || Date.now();
  if (source && REPO_SOURCES.includes(source) && (source !== 'mentioned' || entry.source === 'mentioned')) entry.source = source;
  if (pinned) {
    for (const item of map) item.pinned = false;
    entry.pinned = true;
    entry.source = 'pinned';
  }
  // Bounded: pinned survives, then most-recently-used.
  if (map.length > REPO_MAP_LIMIT) {
    const keep = map.filter(item => item.pinned).concat(map.filter(item => !item.pinned).sort((a, b) => b.lastUsedAt - a.lastUsedAt));
    map.length = 0;
    map.push(...keep.slice(0, REPO_MAP_LIMIT));
  }
  return map;
}

function pinnedRepo(repoMap) {
  return (Array.isArray(repoMap) ? repoMap : []).find(item => item.pinned) || null;
}

// Scans user text for absolute directory mentions and records them on the
// map. fsLike is injectable for tests; missing/inaccessible paths are
// silently skipped (a mention of a non-directory is context, not an error).
function recordRepoMentions(repoMap, text, fsLike, at = Date.now()) {
  const candidates = scanPaths(text);
  if (!candidates.length) return repoMap;
  const map = Array.isArray(repoMap) ? repoMap : [];
  for (const candidate of candidates) {
    let isDir = false;
    try {
      if (fsLike && typeof fsLike.existsSync === 'function' && typeof fsLike.statSync === 'function') {
        isDir = fsLike.existsSync(candidate) && fsLike.statSync(candidate).isDirectory();
      } else {
        isDir = true; // uncheckable context still earns a map row
      }
    } catch { isDir = false; }
    if (!isDir) continue;
    registerRepo(map, candidate, { source: 'mentioned', at });
  }
  return map;
}

// Resolves a pin intent's target: an explicit path, else "this" from a
// directory attachment, else the already-pinned repo (re-affirm), else null.
function resolvePinTarget({ intent, attachments = [], repoMap = [], currentRoot = '' } = {}) {
  if (!intent || intent.kind !== 'pin') return null;
  if (intent.path) {
    const cleaned = stripTrailingPunctuation(intent.path);
    try { return path.resolve(cleaned); } catch { return cleaned; }
  }
  const directoryAttachment = (Array.isArray(attachments) ? attachments : [])
    .find(item => item?.kind === 'path' && item?.isDirectory);
  if (directoryAttachment?.path) {
    try { return path.resolve(String(directoryAttachment.path)); } catch { return String(directoryAttachment.path); }
  }
  const pinned = pinnedRepo(repoMap);
  if (pinned) return pinned.root;
  if (currentRoot) return currentRoot;
  return null;
}

const ATTRIBUTION_RULE = 'PIN RULE: the pinned repo is the DEFAULT for every relative path, search, index, patch, and terminal command — you never have to rediscover it. Other mapped repos are addressed by their absolute root; do not search unmapped folders for referenced-repo work, and never attribute an edit to a repo without checking this map.';

// The wire block. Compact (a few lines), carried on EVERY decision in the
// leading pinned context, and fed to the compaction summarizer so repo
// attribution survives summarization.
function renderRepoMapWire({ workspace, repoMap, fileTrail = [] } = {}) {
  const root = String(workspace?.root || pinnedRepo(repoMap)?.root || '').trim();
  const map = normalizeRepoMap(repoMap);
  const trail = (Array.isArray(fileTrail) ? fileTrail : []).filter(Boolean);
  if (!root && !map.length && !trail.length) return null;
  const lines = [];
  if (root) lines.push(`WORKING REPO (pinned): ${root}`);
  const mapped = map.filter(item => item.root !== root);
  if (mapped.length) lines.push(`REPO MAP: ${mapped.map(item => `${item.name}=${item.root}${item.pinned ? ' [pinned]' : ''}`).join(' · ')}`);
  const trailLines = trail.slice(-12);
  if (trailLines.length) lines.push(`FILES TOUCHED: ${trailLines.join(', ')}`);
  if (root) lines.push(ATTRIBUTION_RULE);
  return lines.join('\n');
}

// GEN9 NOTEBOOK HYDRATION: parse the notebook file's WORKING REPOS section
// back into repo-map rows. Used when a conversation is restored from a
// snapshot that predates repoMap persistence — the notebook file on disk is
// the durable mirror of the map, so it can rebuild it. Lines follow the
// notebook's own format: `- %name/description% %absolute path% [pinned]`.
function parseRepoSection(sectionText) {
  const rows = [];
  for (const line of String(sectionText || '').split('\n')) {
    const match = line.match(/^\s*-\s*%(.+?)%\s*%(.+?)%\s*(.*)$/);
    if (!match) continue;
    const root = match[2].trim();
    if (!/^[A-Za-z]:[\\/]/.test(root) && !root.startsWith('/')) continue;
    rows.push({ root, name: match[1].trim().slice(0, 80), pinned: /\bpinned\b/i.test(match[3]), source: 'previous', lastUsedAt: 0 });
  }
  return normalizeRepoMap(rows);
}

module.exports = {
  REPO_MAP_LIMIT,
  ATTRIBUTION_RULE,
  parseRepoPinIntent,
  normalizeRepoMap,
  registerRepo,
  pinnedRepo,
  recordRepoMentions,
  resolvePinTarget,
  renderRepoMapWire,
  parseRepoSection,
  repoName,
  scanPaths
};
