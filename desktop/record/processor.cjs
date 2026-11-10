'use strict';

// The LOCAL event processor — the reason the model never sees raw events.
// Pure logic (no I/O, no model): normalize → deduplicate → compress repeats →
// score significance → group into episodes → render the compact SEMANTIC
// stream. Everything here runs in microseconds per event, so the user works
// in real time and nothing ever waits on inference.
//
// Episode boundaries: an application switch, or an idle gap. Navigation and
// clicks stay inside their episode (one task often spans pages). Casual
// clutter (typing bursts, repeated clicks) is compressed before it can ever
// reach a prompt.

const IDLE_BOUNDARY_MS = 8_000;
const DEDUPE_WINDOW_MS = 500;
const DOUBLE_CLICK_MS = 700;
const TYPING_BURST_IDLE_MS = 2_000;

function domainOf(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./, '') || null; }
  catch { return null; }
}

function shortApp(title, fallback) {
  const value = String(title || '').trim();
  if (!value) return fallback || 'Unknown';
  // Window titles are "<page> — <app>" or "<page> · <app>" in most apps; the
  // trailing segment is usually the application name.
  const parts = value.split(/\s+[—–|-]\s+|\s+·\s+/).map(part => part.trim()).filter(Boolean);
  return (parts.length > 1 ? parts.at(-1) : value).slice(0, 60);
}

function titleHead(title) {
  const value = String(title || '').trim();
  if (!value) return null;
  return value.split(/\s+[—–|-]\s+|\s+·\s+/)[0]?.trim().slice(0, 80) || null;
}

function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const item of setA) if (setB.has(item)) shared += 1;
  return shared / (setA.size + setB.size - shared);
}

const SIGNIFICANCE = { app_switch: 3, navigation: 3, terminal: 3, upload: 3, download: 3, tool_call: 2, click: 2, keys: 1 };

function createEventProcessor({
  now = () => Date.now(),
  idleBoundaryMs = IDLE_BOUNDARY_MS,
  onSemantic = null,
  onEpisodeClosed = null
} = {}) {
  let episode = null;
  let lastEventAt = 0;
  let lastClick = null;          // dedupe/double-click state
  let lastTyping = null;         // open typing burst
  let recentSemantics = [];      // bounded dedupe history [{text, at}]
  const recentDigests = [];      // last closed-episode token sets (novelty gate)
  const closedEpisodes = [];     // full session episode list (digests, capped)

  function emitSemantic(entry) {
    if (!entry) return;
    // Cross-source dedupe: identical semantic lines within the window collapse
    // (e.g. terminal tap + window title race).
    if (recentSemantics.some(item => item.text === entry.text && entry.at - item.at < DEDUPE_WINDOW_MS * 2)) return;
    recentSemantics.push({ text: entry.text, at: entry.at });
    if (recentSemantics.length > 64) recentSemantics = recentSemantics.slice(-32);
    episode.actions.push(entry);
    onSemantic?.(entry);
  }

  function newEpisode(startedAt) {
    episode = {
      id: `ep-${startedAt}`,
      startedAt,
      endedAt: null,
      apps: new Set(),
      domains: new Set(),
      actions: [],
      clickCount: 0,
      keystrokes: 0,
      navigations: 0,
      significant: 0,
      screenshots: []
    };
  }

  function closeEpisode(endedAt) {
    if (!episode || !episode.actions.length) { episode = null; return null; }
    episode.endedAt = endedAt;
    const tokens = new Set();
    for (const action of episode.actions) {
      for (const token of String(action.text || '').toLowerCase().split(/[^a-z0-9]+/)) {
        if (token.length > 2) tokens.add(token);
      }
    }
    for (const app of episode.apps) tokens.add(`app:${app.toLowerCase()}`);
    for (const domain of episode.domains) tokens.add(`dom:${domain}`);
    const closed = {
      id: episode.id,
      startedAt: episode.startedAt,
      endedAt,
      spanMs: endedAt - episode.startedAt,
      apps: [...episode.apps],
      domains: [...episode.domains],
      actions: episode.actions.slice(0, 40),
      clickCount: episode.clickCount,
      keystrokes: episode.keystrokes,
      navigations: episode.navigations,
      significant: episode.significant,
      screenshots: episode.screenshots.slice(-4),
      tokens
    };
    recentDigests.push(tokens);
    if (recentDigests.length > 6) recentDigests.shift();
    closedEpisodes.push(closed);
    if (closedEpisodes.length > 200) closedEpisodes.shift();
    onEpisodeClosed?.(closed);
    episode = null;
    return closed;
  }

  function begin(startedAt) {
    lastEventAt = 0;
    newEpisode(startedAt);
  }

  function closeCurrent(at) {
    // Any boundary must first compress the open typing burst so it lands in
    // the episode it belonged to.
    flushTypingBurst(at);
    return closeEpisode(at);
  }

  function push(raw) {
    const at = Number(raw?.at) || now();
    // Idle boundary: the gap itself separates two unrelated tasks.
    if (episode && lastEventAt && at - lastEventAt >= idleBoundaryMs) closeCurrent(lastEventAt);
    if (!episode) newEpisode(at);
    lastEventAt = at;

    switch (raw.type) {
      case 'app_switch': {
        const app = shortApp(raw.title, 'Unknown');
        if (episode.apps.has(app) && episode.actions.length === 0) break; // no-op flip
        closeCurrent(at); newEpisode(at);
        episode.apps.add(app);
        episode.significant += SIGNIFICANCE.app_switch;
        emitSemantic({ at, kind: 'app_switch', text: `Switched to ${app}`, app, significant: true });
        break;
      }
      case 'window_title': {
        const app = shortApp(raw.title, [...episode.apps].at(-1));
        if (app) episode.apps.add(app);
        const head = titleHead(raw.title);
        // A title change inside the same app often means a dialog, a finished
        // load, or a step forward. Only mark it when it clearly changed.
        if (head && episode.actions.length && !episode.actions.at(-1)?.text?.includes(head)) {
          emitSemantic({ at, kind: 'window_title', text: `${app}: “${head}”`, app, significant: false });
        }
        break;
      }
      case 'click': {
        if (lastClick && lastClick.button === raw.button && at - lastClick.at < DOUBLE_CLICK_MS &&
            Math.abs((raw.x || 0) - lastClick.x) < 6 && Math.abs((raw.y || 0) - lastClick.y) < 6) {
          lastClick = { at, x: raw.x, y: raw.y, button: raw.button };
          break; // double-click is one action
        }
        const app = [...episode.apps].at(-1) || shortApp(raw.title || '', 'Unknown');
        if (app) episode.apps.add(app);
        episode.clickCount += 1;
        episode.significant += SIGNIFICANCE.click;
        lastClick = { at, x: raw.x, y: raw.y, button: raw.button };
        const target = raw.target ? ` “${String(raw.target).slice(0, 60)}”` : '';
        emitSemantic({ at, kind: 'click', text: `${app}${raw.domain ? ` (${raw.domain})` : ''}: clicked${target}`, app, domain: raw.domain || null, significant: true });
        break;
      }
      case 'keys': {
        episode.keystrokes += Number(raw.count) || 0;
        const structural = Array.isArray(raw.keys) ? raw.keys : [];
        // Typing bursts compress: one semantic line per burst, not per key.
        if (lastTyping && at - lastTyping.at < TYPING_BURST_IDLE_MS) {
          lastTyping.count += Number(raw.count) || 0;
          lastTyping.at = at;
          for (const key of structural) lastTyping.keys.add(key);
          break;
        }
        lastTyping = { at, count: Number(raw.count) || 0, keys: new Set(structural), app: [...episode.apps].at(-1) || null };
        break;
      }
      case 'navigation': {
        const domain = raw.domain || domainOf(raw.url);
        const app = [...episode.apps].at(-1) || 'Browser';
        episode.apps.add(app);
        if (domain) episode.domains.add(domain);
        episode.navigations += 1;
        episode.significant += SIGNIFICANCE.navigation;
        if (raw.title) episode.apps.add(shortApp(`${raw.title} — ${app}`));
        emitSemantic({ at, kind: 'navigation', text: `${app}: opened ${raw.url || domain || 'page'}`, app, domain: domain || null, significant: true });
        break;
      }
      case 'tab_switch': {
        if (raw.domain || raw.url) {
          const domain = raw.domain || domainOf(raw.url);
          if (domain) episode.domains.add(domain);
          emitSemantic({ at, kind: 'tab_switch', text: `Viewed tab ${raw.title || raw.url || raw.domain}`, app: 'Browser', domain: domain || null, significant: false });
        }
        break;
      }
      case 'terminal': {
        episode.significant += SIGNIFICANCE.terminal;
        emitSemantic({ at, kind: 'terminal', text: `Terminal: ${String(raw.summary || '').slice(0, 120)}`, app: 'Terminal', significant: true });
        break;
      }
      case 'tool_call': {
        episode.significant += SIGNIFICANCE.tool_call;
        emitSemantic({ at, kind: 'tool_call', text: `Agent tool ${String(raw.tool || '').slice(0, 40)}: ${String(raw.summary || '').slice(0, 100)}`, app: 'Browser-use', significant: true });
        break;
      }
      case 'upload':
      case 'download': {
        episode.significant += SIGNIFICANCE.upload;
        emitSemantic({ at, kind: raw.type, text: `${raw.type === 'upload' ? 'Uploaded' : 'Downloaded'} ${String(raw.name || 'file').slice(0, 80)}`, app: [...episode.apps].at(-1) || null, significant: true });
        break;
      }
      case 'screenshot': {
        episode.screenshots.push({ at, evidenceId: raw.evidenceId, reason: raw.reason });
        break;
      }
      default: break;
    }
  }

  // Flush an open typing burst into a single compressed semantic line.
  function flushTypingBurst(endedAt) {
    if (!lastTyping) return;
    if (lastTyping.count >= 3) {
      const structural = [...lastTyping.keys];
      emitSemantic({
        at: lastTyping.at,
        kind: 'keys',
        text: `${lastTyping.app || 'Active app'}: typed ~${lastTyping.count} characters${structural.length ? ` (pressed ${structural.join(', ')})` : ''}`,
        app: lastTyping.app,
        significant: false
      });
    }
    lastTyping = null;
  }

  function stop() {
    return closeCurrent(lastEventAt || now());
  }

  function snapshot() {
    return episode ? {
      startedAt: episode.startedAt,
      apps: [...episode.apps],
      domains: [...episode.domains],
      actions: episode.actions.length,
      clickCount: episode.clickCount,
      keystrokes: episode.keystrokes,
      significant: episode.significant
    } : null;
  }

  function isRepeating(closedEpisode) {
    // Novelty gate for selective inference: an episode whose tokens strongly
    // overlap a recent one adds nothing new — skip the model, keep the digest.
    return recentDigests.slice(0, -1).some(tokens => jaccard(tokens, closedEpisode.tokens) >= 0.7);
  }

  return { begin, push, stop, flushTypingBurst, snapshot, isRepeating, closeEpisode, closedEpisodes };
}

module.exports = { createEventProcessor, domainOf, shortApp, titleHead, jaccard, IDLE_BOUNDARY_MS };
