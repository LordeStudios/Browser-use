'use strict';

// The Program Control skill (pre-added): when a run takes control of a native
// program the brain knows nothing about, ONE non-blocking research pass hunts
// the official documentation, user manual, reputable tutorials and forum
// answers for controlling it — and writes what it learns back into the
// knowledge store as a recipe. Learnt once, then every later run starts from
// the brain cache instead of searching again.
//
// Invariants: never blocks the run (fire-and-forget via the research runner);
// at most one program-research attempt per run; a program the brain already
// knows is never re-researched; a window title that does not identify a
// program (untitled/new documents) is honestly skipped.

const NOISE_TITLES = /^(?:browser-use.*|browser-use agent pointer|program manager|start|settings|windows(?: defender.*)?|task view|search|microsoft text input application|windows input experience|nvidia geforce overlay.*)$/i;
// A title like "Untitled-1" or "Document1" does not identify a program —
// researching it would produce junk knowledge.
const IMPLAUSIBLE_PROGRAMS = /^(?:untitled|new|document|blank|readme|log|noname)\b/i;

function programFromWindowTitle(title) {
  const clean = String(title || '')
    .replace(/[*]/g, '')
    .replace(/@\s*\d+%\s*(?:\(RGB\/8?\)\s*)?/i, '')
    .replace(/^[^\w(]+/, '')
    .replace(/\s+$/, '');
  if (!clean) return null;
  const segments = clean.split(/\s*[|\-–—:]\s+/).map(segment => segment.trim()).filter(Boolean);
  for (const segment of segments.reverse()) {
    if (segment.length < 2 || /^\d+$/.test(segment)) continue;
    if (NOISE_TITLES.test(segment) || IMPLAUSIBLE_PROGRAMS.test(segment)) continue;
    // A path segment yields its executable basename ('cmd' from the elevated
    // cmd.exe window title); any other path identifies no program.
    if (/[\\/]/.test(segment)) {
      const base = segment.split(/[\\/]/).pop().replace(/\.(?:exe|msc|cpl)$/i, '');
      if (/\.(?:exe|msc|cpl)$/i.test(segment) && base.length >= 2) return base;
      continue;
    }
    if (/\.(?:aspx?|html?|php)$/i.test(segment)) continue;
    return segment;
  }
  return null;
}

// Pick the program a run is controlling: the foreground window when it
// identifies an app, otherwise the first plausible window in the inventory.
function programFromObservation(desktop) {
  if (!desktop || !Array.isArray(desktop.windows)) return null;
  const windows = desktop.windows.filter(window => window && !window.minimized);
  const foreground = windows.find(window => String(window.id) === String(desktop.foregroundWindowId));
  const ordered = foreground ? [foreground, ...windows.filter(window => window !== foreground)] : windows;
  for (const window of ordered) {
    const program = programFromWindowTitle(window.title);
    if (program) return program;
  }
  return null;
}

function composeObjective(program, task) {
  return `Program control research for ${program}. Find the OFFICIAL documentation, user manual, or reputable tutorial and forum answers covering how to ${String(task || 'operate the program')} in ${program}: the exact menu paths, keyboard shortcuts, dialog and tool names, and any registered URI scheme or command line. Prefer the vendor's own docs and the user manual over blogs.`;
}

// The brain cache gate: a program with any recalled knowledge is considered
// learnt — researching it again would duplicate what one pass already taught.
function brainKnowsProgram(store, program) {
  if (!store || !program) return false;
  try {
    return (store.recall(program, { limit: 1 }) || []).length > 0;
  } catch {
    return false;
  }
}

module.exports = { programFromWindowTitle, programFromObservation, composeObjective, brainKnowsProgram, NOISE_TITLES, IMPLAUSIBLE_PROGRAMS };
