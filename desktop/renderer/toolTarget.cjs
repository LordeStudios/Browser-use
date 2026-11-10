(function (root) {
  'use strict';

  // Which file or folder a computer_* tool touched, for the action row: the
  // visible label is the short name ("run.txt"), the full directory rides the
  // hover tooltip ("C:\Users\london\Desktop\tests\run.txt").

  const PATH_TOOLS = new Set(['computer_read', 'computer_write', 'computer_patch', 'computer_search', 'computer_index', 'computer_fs']);
  const FILE_ACTIONS = new Set(['read', 'write', 'edit', 'append']);
  const FOLDER_ACTIONS = new Set(['list', 'find', 'mkdir']);
  const MAX_LABEL = 48;

  function clean(value) {
    return typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
  }

  function isAbsolute(p) {
    return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/');
  }

  function stripLongPrefix(p) {
    return p.replace(/^\\\\\?\\/, '');
  }

  function baseName(p) {
    const trimmed = p.replace(/[\\/]+$/, '');
    if (!trimmed) return p;
    const parts = trimmed.split(/[\\/]/);
    const last = parts[parts.length - 1];
    // "C:" has no separator-free name; show the drive root as-is.
    return /^[A-Za-z]:$/.test(last) ? `${last}\\` : last;
  }

  function shorten(name) {
    return name.length > MAX_LABEL ? `${name.slice(0, MAX_LABEL - 1)}…` : name;
  }

  function unwrap(output) {
    if (!output || typeof output !== 'object') return {};
    return output.result && typeof output.result === 'object' ? output.result : output;
  }

  // 'file' | 'folder' | 'unknown'. computer_read only ever reads one file;
  // computer_search / computer_index / list / find / mkdir work on a tree; a
  // stat, copy, move or delete reports directory:true in its result.
  function kindOf(tool, input, output) {
    const action = clean(input?.action);
    const result = unwrap(output);
    if (tool === 'computer_read' || tool === 'computer_write' || tool === 'computer_patch') return 'file';
    if (tool === 'computer_index') return clean(input?.file) ? 'file' : 'folder';
    // A search over one file is the only branch that returns a root without an
    // engine (ripgrep / walker); every tree search names its engine.
    if (tool === 'computer_search') return result.root && !result.engine ? 'file' : 'folder';
    if (tool === 'computer_fs') {
      if (FOLDER_ACTIONS.has(action)) return 'folder';
      if (FILE_ACTIONS.has(action)) return 'file';
      if (typeof result.directory === 'boolean') return result.directory ? 'folder' : 'file';
    }
    return 'unknown';
  }

  // The path the agent aimed at wins over the result's echo: a failed call still
  // names its target, and a result path is normalized (long-path prefix, case).
  function rawPath(tool, input) {
    if (tool === 'computer_index') return clean(input?.file) || clean(input?.path);
    return clean(input?.path);
  }

  function describeToolTarget(tool, input, output) {
    if (!PATH_TOOLS.has(String(tool || ''))) return null;
    const requested = rawPath(tool, input);
    const echoed = clean(unwrap(output).path) || clean(unwrap(output).root);
    const full = stripLongPrefix(requested || echoed);
    if (!full || !isAbsolute(full)) return null;
    const kind = kindOf(tool, input, output);
    return { full, name: shorten(baseName(full)), kind };
  }

  const api = { describeToolTarget, baseName, PATH_TOOLS };
  root.BrowserUseToolTarget = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
