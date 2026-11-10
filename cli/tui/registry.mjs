// cli/tui/registry.mjs
//
// PURE command registry + readline completer for the browser-use TUI.
// No I/O, no state — the TUI (cli/tui.mjs) registers real handlers into it and
// hands makeCompleter(registry) to node:readline. Unit-tested by
// cli/tui/tui.test.mjs.

/**
 * Create an empty command registry.
 * Command shape:
 *   {
 *     name: 'run',              // canonical name, no leading slash
 *     args: '[task]',           // arg signature shown by /help
 *     description: 'one line',  // /help list line
 *     detail: 'multi-line',     // /help <command> detailed help (optional)
 *     handler: async (ctx, argString) => {},   // ctx is TUI-supplied
 *     completeArg: (lastWord, wholeArgString) => ['a','b'],  // optional
 *   }
 */
export function createCommandRegistry() {
  const commands = new Map();

  function canonical(name) {
    return String(name ?? '').trim().replace(/^\//, '').toLowerCase();
  }

  function register(cmd) {
    const name = canonical(cmd.name);
    if (!name) throw new Error('registry.register: command needs a name');
    if (!name.includes(' ') && name === name.trim()) {
      commands.set(name, { ...cmd, name });
    } else {
      throw new Error(`registry.register: invalid command name '${name}'`);
    }
  }

  function get(name) {
    return commands.get(canonical(name)) || null;
  }

  function names() {
    return [...commands.keys()].sort();
  }

  function list() {
    return names().map((name) => commands.get(name));
  }

  return { register, get, names, list, has: (name) => commands.has(canonical(name)) };
}

/**
 * Build a readline-style completer over the registry.
 *
 * Behavior (the "each letter sorts them out" rule):
 *  - line === '/' (or '/'+whitespace): return the FULL command list.
 *  - '/cl': entries that START WITH 'cl' first, then entries that CONTAIN
 *    'cl' mid-word — so '/c' surfaces cancel/clear/config AND doctor, etc.
 *  - '/model glm' (space after the command): delegate to the command's
 *    completeArg(lastWord, wholeArgString) and filter by last-word prefix.
 *  - non-slash lines: no completions.
 *
 * Returns [completions, fragment] in readline's sync-completer shape.
 */
export function makeCompleter(registry) {
  return function completer(line) {
    const trimmed = String(line ?? '').replace(/^\s+/, '');
    if (!trimmed.startsWith('/')) return [[], String(line ?? '')];

    const fragment = trimmed.slice(1).toLowerCase();
    const all = registry.names();
    const spaceIndex = trimmed.indexOf(' ');
    if (spaceIndex !== -1) {
      const name = trimmed.slice(1, spaceIndex);
      // '/' followed by whitespace: same as '/' — the full command list.
      if (name === '') return [all.slice(), '/'];
      const cmd = registry.get(name);
      const argPortion = trimmed.slice(spaceIndex + 1);
      const lastWord = argPortion.replace(/^\s+/, '').split(/\s+/).pop() ?? '';
      if (cmd && typeof cmd.completeArg === 'function') {
        const head = trimmed.slice(0, spaceIndex + 1);
        let suggestions = [];
        try {
          suggestions = cmd.completeArg(lastWord, argPortion) || [];
        } catch {
          suggestions = [];
        }
        const matches = suggestions.filter(
          (value) => String(value).startsWith(lastWord) && String(value) !== lastWord
        );
        return [matches.map((value) => head + String(value)), lastWord];
      }
      return [[], String(line ?? '')];
    }

    if (fragment === '') return [all.slice(), '/'];
    const starts = all.filter((name) => name.startsWith(fragment));
    const mids = all.filter((name) => !name.startsWith(fragment) && name.includes(fragment));
    const hits = [...starts, ...mids];
    return [hits.map((name) => `/${name}`), `/${fragment}`];
  };
}

/**
 * Parse a REPL line into { name, argString } for slash commands.
 * Returns null when the line is not a command.
 */
export function parseCommand(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const spaceIndex = body.indexOf(' ');
  if (spaceIndex === -1) return { name: body.toLowerCase(), argString: '' };
  return { name: body.slice(0, spaceIndex).toLowerCase(), argString: body.slice(spaceIndex + 1).trim() };
}
