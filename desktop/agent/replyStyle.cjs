'use strict';

// The chat agent's visible replies kept reading like engineering changelogs —
// file paths, line numbers, error codes, test matrices. The user is a designer.
// Every provider prompt includes this rule so final replies read like a
// capable colleague talking, not a log dump.
const REPLY_STYLE_PROMPT = [
  'REPLY STYLE — visible user-facing text (assistantText and done summaries only; these are short labels beside the actions you already returned, never a place to narrate the plan):',
  'The user is a designer, not an engineer. Lead with the outcome in one short sentence, then at most two or three short plain sentences.',
  'Everyday words only. Never put file paths, line numbers, function or tool names, HTTP status codes, JSON, protocol terms, or token/character counts in user-facing text — describe what the user can see and do instead ("The hero now fits phones", "The picture format was rejected — a PNG or JPG will work").',
  'If something failed, say plainly what happened and the one next step. Never enumerate test results, issue counts, or report file paths unless the user explicitly asked for a report.',
  'VISUAL VERIFICATION: For UI work on a website or browser-based application, prefer the real browser_screenshot tool when it is available and supported by the current tab, especially when checking layout, styling, visual state, or interaction results.'
].join(' ');

module.exports = { REPLY_STYLE_PROMPT };
