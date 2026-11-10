// Slash command model for the app chat composer (gen7, Issue 2 — gen9 port).
//
// The chat input previously had NO command system: the harness already
// intercepted "/..." text (DesktopChatAgent.handleSlashCommand — /compact,
// /plan, /goal, /notebook) but nothing in the app surfaced it, and a fresh
// chat fed "/compact" to the model as a task. This module is the command
// CATALOG plus the pure picker logic, ported from the CLI TUI's
// SuggestionsDisplay pattern (cli/tui/App.mjs: '> ' active marker, filtered
// list, arrows + accept):
//
//   - "/" opens the dropdown with every command; typing filters by prefix.
//   - Arrow keys move the selection, Tab/Enter accept; zero-argument commands
//     execute on Enter, argument commands insert their name + a space and wait
//     for the argument (second Enter submits through the normal path).
//   - Escape closes.
//
// gen9 adaptations vs the arena source (see chatCommands_flow_chat.md):
//   - /status is local:true — the current agent has no /status handler, so the
//     renderer answers from its own run state instead of steering the model.
//   - /notebook added — the current agent implements it; the arena never
//     surfaced it in the dropdown.
//   - /cd pins the agent-level default workspace via the
//     browser-use:set-default-workspace IPC in BOTH fresh and live
//     conversations (conversation-time repo switching is the deferred
//     agent-side extension).
//
// Loaded as a plain script before app.js and also require()-able from node
// tests — no DOM access in here (same contract as attachments.cjs).
(function (root) {
  'use strict';

  // conversation: true  — needs a conversation (idle-with-history or live run)
  // conversation: 'both'— works with or without a conversation
  // local: true         — handled entirely in the renderer, never sent
  const COMMANDS = [
    { name: 'cd', args: '<path>', description: 'Pin the working repo as the default (used by your next conversation)', conversation: 'both' },
    { name: 'plan', args: '[steps; ...]', description: 'Inspect the plan — add steps to replace it', conversation: 'both' },
    { name: 'compact', args: '', description: 'Summarize closed turns and free context now', conversation: true },
    { name: 'goal', args: '<goals; ...>', description: 'Replace the goals', conversation: true },
    { name: 'notebook', args: '', description: 'Open the run notebook (/notebook <text> appends a note)', conversation: true },
    // gen9 — local:true means the RENDERER answers (via the skills/mcp IPC in
    // main.cjs); the text never reaches the harness. These are the desktop
    // surface of the SAME shared stores the CLI's /skills and /mcp manage, so
    // what is installed here the CLI sees and vice versa.
    { name: 'skills', args: '[install <path|git-url> | list | show <id> | enable|disable|remove|update <id> | search <text>] (+ --repo)', description: 'Install/manage skill packages — same stores as the CLI (~/.browser-use-cli/skills, <repo>/.browser-use/skills)', local: true, conversation: 'both' },
    { name: 'mcp', args: '[add <name> <command...>|<url> | list | status | test <name> | auth <name> <Header: value> | enable|disable|remove <name>]', description: 'Add/manage external MCP servers — their tools reach the agent as mcp__<server>__<tool>; same config files as the CLI', local: true, conversation: 'both' },
    { name: 'status', args: '', description: 'Show conversation status (state, task, plan)', local: true, conversation: 'both' },
    { name: 'model', args: '', description: 'Open the model picker', local: true, conversation: 'both' },
    { name: 'help', args: '', description: 'List every command', local: true, conversation: 'both' }
  ];

  // Suggestion state for the current composer text. Suggestions are active
  // only while the FIRST token still starts with '/' (typing the argument of
  // "/cd C:\repo" closes the picker; the argument is the user's own typing).
  function suggestionsFor(text) {
    const raw = String(text || '');
    if (!raw.startsWith('/') || /\s/.test(raw.trim())) return { active: false, matches: [], selectedIndex: 0 };
    const prefix = raw.slice(1).toLowerCase();
    const matches = COMMANDS.filter((command) => command.name.startsWith(prefix));
    return { active: matches.length > 0, matches, selectedIndex: 0 };
  }

  function moveSelection(state, delta) {
    if (!state?.active || !state.matches?.length) return state;
    const count = state.matches.length;
    const index = ((Number(state.selectedIndex) || 0) + delta + count) % count;
    return { ...state, selectedIndex: index };
  }

  function selectedCommand(state) {
    if (!state?.active) return null;
    return state.matches[Number(state.selectedIndex) || 0] || null;
  }

  // What pressing Enter/Tab on a command does. acceptActionFor(command) is the
  // per-row form: the picker passes the CLICKED row's command, not whatever
  // prefix happens to sit in the buffer (a filtered list means "/no" can have
  // /notebook selected — the buffer text must never be the action).
  //   execute       — zero-arg command: submit "/name" through the normal path
  //   insert        — argument command: put "/name " in the buffer and keep
  //                   editing (the argument comes from the user)
  //   local         — pure renderer command (model picker, status, help,
  //                   /skills, /mcp)
  function acceptActionFor(command) {
    if (!command) return null;
    // Argument commands (local or harness) always INSERT — /skills and /mcp
    // stage "/skills " so the user completes the subcommand; running them on
    // a stale buffer would drop the argument.
    if (command.args) return { type: 'insert', command, text: `/${command.name} ` };
    if (command.local) return { type: 'local', command };
    return { type: 'execute', command, text: `/${command.name}` };
  }

  function acceptAction(state) {
    return acceptActionFor(selectedCommand(state));
  }

  // A command that should be sent through the chat (needs the harness) or
  // refused inline. Used by the submit handler: slash text on a fresh chat
  // (no conversation) must never reach the model as a task.
  function routeSubmission(text, { hasConversation } = {}) {
    const raw = String(text || '').trim();
    if (!raw.startsWith('/')) return { type: 'task', text: raw };
    const name = raw.slice(1).split(/\s/)[0].toLowerCase();
    const command = COMMANDS.find((entry) => entry.name === name);
    if (!command) return { type: 'task', text: raw }; // unknown slash: passthrough
    if (command.local) return { type: 'local', command, text: raw };
    if (command.conversation === true && !hasConversation) {
      return { type: 'needs-conversation', command, text: raw };
    }
    return { type: 'chat', command, text: raw };
  }

  const api = { COMMANDS, suggestionsFor, moveSelection, selectedCommand, acceptAction, acceptActionFor, routeSubmission };
  root.BrowserUseChatCommands = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
