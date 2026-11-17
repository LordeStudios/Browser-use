'use strict';

// ACTION NARRATION — one human line for the action that is executing.
//
// Why this exists: a model that streams no reasoning text left the transcript
// with a bare "Still working" and nothing else, so the user could not tell a
// long render from a wedged run. The reasoning stream is a nice-to-have; a
// statement of what is happening RIGHT NOW is not. This derives that statement
// from the tool call itself, which is true for every model, reasoning or not.
//
// Rules:
//  • present participle, no "The agent is" — "Opening Blender", not
//    "The agent is going to open Blender".
//  • name the concrete target when the input has one (app, host, file, text).
//  • bookkeeping tools (plan, done, advisory) narrate nothing: they are not
//    work the user can see, and narrating them is noise.
//  • never claim an EFFECT. "Clicking Send" is honest; "Sent the message" is
//    not, because dispatch does not prove delivery.

const MAX_LABEL = 72;

function clip(value, limit = MAX_LABEL) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function quote(value, limit = 40) {
  const text = clip(value, limit);
  return text ? `“${text}”` : '';
}

// A URL reduced to its host, so the line reads "Opening github.com" instead of
// a 200-character query string.
function hostOf(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./i, '');
    if (host) return clip(host, 40);
  } catch { /* fall through to a plain clip */ }
  return clip(raw, 40);
}

function fileName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const parts = raw.split(/[\\/]/).filter(Boolean);
  return clip(parts.at(-1) || raw, 40);
}

// Windows/app labels arrive as "blender.exe" or "Blender 4.2".
function appLabel(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return clip(raw.replace(/\.exe$/i, ''), 32);
}

function describeAction(call) {
  const name = String(call?.name || '');
  const input = call?.input || {};
  if (!name) return null;

  // Bookkeeping: real work, zero information for the user watching the card.
  if (['update_plan', 'create_plan', 'browser_done', 'agent_advisory', 'agent_recovery', 'agent_message'].includes(name)) return null;

  switch (name) {
    case 'browser_navigate':
    case 'browser_open': {
      const host = hostOf(input.url || input.href);
      return host ? `Opening ${host}` : 'Opening a page';
    }
    case 'browser_click':
    case 'browser_click_element': {
      const label = clip(input.label || input.text || input.name || '');
      return label ? `Clicking ${quote(label)}` : 'Clicking the page';
    }
    case 'browser_type':
    case 'browser_fill':
    case 'browser_fill_form': {
      const text = quote(input.text || input.value || '');
      return text ? `Typing ${text}` : 'Typing into the page';
    }
    case 'browser_scroll':
      return 'Scrolling the page';
    case 'browser_dom_snapshot':
    case 'browser_query_elements':
    case 'browser_extract':
      return 'Reading the page';
    case 'browser_screenshot':
    case 'computer_screenshot':
      return 'Taking a screenshot';
    case 'browser_wait':
      return 'Waiting for the page to settle';
    case 'browser_tabs':
    case 'browser_get_tabs':
      return 'Checking open tabs';
    case 'browser_fetch':
      return 'Fetching a page directly';
    case 'computer_observe':
      return 'Looking at the desktop';
    case 'computer_window': {
      const app = appLabel(input.title || input.app || input.name);
      const action = String(input.action || '');
      if (action === 'list') return 'Listing open windows';
      if (action === 'close') return app ? `Closing ${app}` : 'Closing a window';
      return app ? `Focusing ${app}` : 'Switching windows';
    }
    case 'computer_pointer': {
      const app = appLabel(input.windowTitle || input.app);
      const verb = String(input.action || 'click') === 'move' ? 'Moving the pointer' : 'Clicking';
      return app ? `${verb} in ${app}` : verb;
    }
    case 'computer_keyboard': {
      const run = Array.isArray(input.keys) ? input.keys : null;
      if (run?.length) return `Pressing ${clip(run.join(' '), 40)}`;
      const text = quote(input.text || '');
      if (text) return `Typing ${text}`;
      const key = clip(input.key || '', 24);
      return key ? `Pressing ${key}` : 'Typing';
    }
    case 'computer_stroke':
      return 'Drawing';
    case 'computer_index':
    case 'computer_search':
    case 'computer_read': {
      const file = fileName(input.path || input.file);
      return file ? `Reading ${file}` : 'Looking through the workspace';
    }
    case 'computer_patch':
    case 'computer_write':
    case 'computer_file': {
      const file = fileName(input.path || input.file);
      return file ? `Editing ${file}` : 'Editing a file';
    }
    case 'computer_terminal': {
      const command = clip(input.command || input.cmd || '', 48);
      return command ? `Running ${command}` : 'Running a command';
    }
    case 'computer_clipboard':
      return 'Using the clipboard';
    case 'computer_gesture':
    case 'computer_scroll':
      return 'Moving around the app';
    case 'task_spawn':
      return 'Starting a helper';
    case 'research_task':
      return 'Researching';
    case 'ask_user':
      return 'Asking you a question';
    case 'write_report_file':
      return 'Writing the report';
    default:
      // Unknown-but-real tool: name it rather than stay silent. A generic line
      // is still better than an empty card.
      return `Working on ${clip(name.replace(/^computer_|^browser_/, '').replace(/_/g, ' '), 32)}`;
  }
}

// The line shown when the harness is between actions (observing, thinking, or
// waiting on the provider). Derived from the phase so it never lies.
function describePhase(phase) {
  switch (String(phase || '')) {
    case 'observing': return 'Looking at the current state';
    case 'deciding': return 'Deciding the next step';
    case 'waiting': return 'Waiting for the provider';
    case 'recovering': return 'Recovering the last step';
    default: return 'Working';
  }
}

module.exports = { describeAction, describePhase, hostOf, fileName, appLabel };
