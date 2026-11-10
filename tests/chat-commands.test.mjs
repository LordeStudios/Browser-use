// chatCommands.cjs — the app chat composer's slash-command model (gen9).
//
// Covers the two gen9 fixes:
//   1. Clicking a dropdown option must act on the CLICKED command, not the
//      raw buffer text — a filtered picker means "/no" can have /notebook
//      selected, and the old execute path submitted the buffer ("/no"),
//      which routeSubmission passed to the model as a task.
//   2. /skills and /mcp are desktop catalog entries (local:true) so the
//      renderer answers through the skills-manage / mcp-manage IPC and the
//      harness never sees the text — the desktop surface of the SAME stores
//      the CLI manages.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import chatCommands from '../desktop/renderer/chatCommands.cjs';

const { COMMANDS, suggestionsFor, acceptAction, acceptActionFor, routeSubmission } = chatCommands;

test('catalog carries /skills and /mcp as local, conversation-agnostic commands', () => {
  for (const name of ['skills', 'mcp']) {
    const command = COMMANDS.find((entry) => entry.name === name);
    assert.ok(command, `/${name} missing from the catalog`);
    assert.equal(command.local, true, `/${name} must be renderer-local (never sent to the harness)`);
    assert.equal(command.conversation, 'both', `/${name} must work on a fresh chat and in a conversation`);
    assert.ok(command.args, `/${name} is an argument command (subcommands)`);
    assert.ok(command.description, `/${name} needs a dropdown description`);
  }
});

test('suggestionsFor filters by prefix over the catalog', () => {
  const state = suggestionsFor('/no');
  assert.equal(state.active, true);
  assert.deepEqual(state.matches.map((entry) => entry.name), ['notebook']);

  const all = suggestionsFor('/');
  assert.ok(all.active);
  const names = all.matches.map((entry) => entry.name);
  for (const expected of ['cd', 'plan', 'compact', 'goal', 'notebook', 'skills', 'mcp', 'status', 'model', 'help']) {
    assert.ok(names.includes(expected), `expected /${expected} in the open dropdown`);
  }

  assert.equal(suggestionsFor('hello').active, false);
  assert.equal(suggestionsFor('/cd something').active, false, 'typing an argument closes the picker');
});

test('THE CLICK FIX: acceptActionFor(clicked) wins over the buffer prefix', () => {
  // The user typed "/no" — the state's selection sits on /notebook, but the
  // buffer carries only the prefix. The clicked row's command must produce
  // the full "/notebook" action, never the buffer text.
  const state = suggestionsFor('/no');
  assert.equal(state.matches[state.selectedIndex].name, 'notebook');
  const action = acceptActionFor(state.matches[state.selectedIndex]);
  assert.equal(action.type, 'execute');
  assert.equal(action.command.name, 'notebook');
  assert.equal(action.text, '/notebook');

  // Argument commands insert their full name + a space for the user's own
  // argument — never the partial buffer.
  const partial = suggestionsFor('/m');
  const cdAction = acceptActionFor(partial.matches.find((entry) => entry.name === 'mcp'));
  assert.equal(cdAction.type, 'insert');
  assert.equal(cdAction.text, '/mcp ');

  // Keyboard acceptance (no explicit command) still resolves from the state's
  // selection.
  const fromState = acceptAction(state);
  assert.equal(fromState.type, 'execute');
  assert.equal(fromState.command.name, 'notebook');

  assert.equal(acceptActionFor(null), null);
});

test('routeSubmission: local commands (skills/mcp included) never reach the harness', () => {
  assert.equal(routeSubmission('/skills list', { hasConversation: false }).type, 'local');
  assert.equal(routeSubmission('/skills install https://github.com/x/y', { hasConversation: true }).type, 'local');
  assert.equal(routeSubmission('/mcp status', { hasConversation: false }).type, 'local');
  assert.equal(routeSubmission('/mcp add tools npx @x/server', { hasConversation: false }).type, 'local');
  assert.equal(routeSubmission('/status', { hasConversation: false }).type, 'local');

  // Harness commands keep their routing.
  assert.equal(routeSubmission('/notebook', { hasConversation: true }).type, 'chat');
  assert.equal(routeSubmission('/compact', { hasConversation: false }).type, 'needs-conversation');
  assert.equal(routeSubmission('/cd C:\\repo', { hasConversation: false }).type, 'chat');

  // Unknown slash text stays a task (passthrough, unchanged contract).
  assert.equal(routeSubmission('/nope', { hasConversation: false }).type, 'task');
  assert.equal(routeSubmission('plain task', { hasConversation: false }).type, 'task');
});
