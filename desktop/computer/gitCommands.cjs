'use strict';

// computer_git: a closed, allow-listed bridge to the installed git binary.
// The model gets version-control ground truth (status, diff, log) and the
// ordinary stage/commit/branch flow without shelling out through the
// terminal — and without ANY way to smuggle flags: every string the model
// supplies is either passed as a single argument after `--` or rejected when
// it could start an option.

const GIT_ACTIONS = ['status', 'diff', 'log', 'add', 'commit', 'branch', 'checkout'];
const READ_ONLY_GIT_ACTIONS = ['status', 'diff', 'log'];
const MAX_GIT_ARGS = 64;

// A value that could be parsed as an option (leading '-') or is empty is
// never accepted as a path/ref/name.
function safeValue(value, label) {
  const text = String(value ?? '').trim();
  if (!text || text.startsWith('-')) throw new Error(`${label} must be a non-empty value that does not start with '-'.`);
  if (text.length > 4096) throw new Error(`${label} is too long.`);
  return text;
}

// Returns { argv, readOnly } or throws an honest error. argv[0] is the git
// subcommand; the caller prepends the binary and runs with cwd=repo.
function buildGitCommand(input = {}) {
  const action = String(input.action || '');
  if (!GIT_ACTIONS.includes(action)) throw new Error(`Unknown computer_git action: ${action || '(none)'}. Use one of: ${GIT_ACTIONS.join(', ')}.`);
  const paths = Array.isArray(input.paths) ? input.paths.map(item => safeValue(item, 'path')) : [];
  if (paths.length > MAX_GIT_ARGS) throw new Error('Too many paths in one call.');
  switch (action) {
    case 'status':
      return { argv: ['status', '--porcelain=v1', '-b'], readOnly: true };
    case 'diff': {
      const argv = ['diff', ...(input.staged === true ? ['--staged'] : []), '--', ...paths];
      return { argv, readOnly: true };
    }
    case 'log': {
      const limit = Math.min(Math.max(Math.floor(Number(input.limit) || 20), 1), 100);
      const argv = ['log', '--oneline', '-n', String(limit)];
      if (input.ref) argv.push(safeValue(input.ref, 'ref'));
      return { argv, readOnly: true };
    }
    case 'add': {
      if (!paths.length) throw new Error('computer_git add requires at least one path.');
      return { argv: ['add', '--', ...paths], readOnly: false };
    }
    case 'commit': {
      const message = String(input.message ?? '').trim();
      if (!message) throw new Error('computer_git commit requires a message.');
      if (message.length > 4000) throw new Error('The commit message is too long (cap 4000 characters).');
      return { argv: ['commit', '-m', message], readOnly: false };
    }
    case 'branch': {
      if (input.name) return { argv: ['branch', safeValue(input.name, 'branch name')], readOnly: false };
      return { argv: ['branch', '--list'], readOnly: true };
    }
    case 'checkout': {
      const ref = safeValue(input.ref, 'ref');
      return { argv: ['checkout', ...(input.create === true ? ['-b'] : []), ref], readOnly: false };
    }
    default:
      throw new Error(`Unknown computer_git action: ${action}.`);
  }
}

module.exports = { GIT_ACTIONS, READ_ONLY_GIT_ACTIONS, buildGitCommand };
