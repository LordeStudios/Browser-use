'use strict';

const fs = require('fs');
const path = require('path');

// DEV SESSION — "npm run desktop:dev_resume" resumes the last dev run at the
// exact point it left: the same tabs, the same chat, the same model, the chat
// open and its unfinished run continuing. The app writes this small record
// while it runs; the launcher sets BROWSER_USE_DEV_RESUME=1 and the next start
// reads it back. It is a DEVELOPMENT aid: a packaged build never reads it.

const SCHEMA_VERSION = 1;
const MAX_TABS = 16;
const MAX_TITLE = 200;
const MAX_URL = 4096;

// The run statuses that mean "the process died mid-work" — exactly the ones a
// resume continues instead of merely re-opening. Deliberately EXCLUDES
// 'paused' (a person paused it) and 'awaiting_approval' (a person owes an
// answer): continuing those would skip the decision they are waiting on.
const RESUMABLE_STATUSES = new Set(['running', 'starting agent', 'interrupted']);

function cleanString(value, max) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function isHttpish(url) {
  const value = String(url || '');
  return /^(?:https?:|file:|about:|chrome:)/i.test(value) || value === 'about:blank';
}

function normalizeTab(tab) {
  const url = cleanString(tab?.url, MAX_URL);
  if (!url || !isHttpish(url)) return null;
  return { url, title: cleanString(tab?.title, MAX_TITLE), active: Boolean(tab?.active) };
}

function normalizeChat(chat) {
  if (!chat || typeof chat !== 'object') return null;
  const conversationId = cleanString(chat.conversationId, 200);
  if (!conversationId) return null;
  const status = cleanString(chat.status, 40);
  return {
    conversationId,
    title: cleanString(chat.title, MAX_TITLE),
    task: cleanString(chat.task, 4000),
    status,
    // The chat panel must come back open: the point of the resume is to keep
    // working in the conversation, not to find it behind a closed drawer.
    drawerOpen: chat.drawerOpen !== false,
    draft: cleanString(chat.draft, 4000),
    resumeRun: RESUMABLE_STATUSES.has(status)
  };
}

function normalizeDevSession(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tabs = (Array.isArray(raw.tabs) ? raw.tabs : [])
    .map(normalizeTab)
    .filter(Boolean)
    .slice(0, MAX_TABS);
  const chat = normalizeChat(raw.chat);
  if (!tabs.length && !chat) return null;
  // Exactly one active tab: the first one flagged, else the first tab.
  let activeSeen = false;
  for (const tab of tabs) {
    if (tab.active && !activeSeen) { activeSeen = true; continue; }
    tab.active = false;
  }
  if (tabs.length && !activeSeen) tabs[0].active = true;
  const provider = raw.provider && typeof raw.provider === 'object'
    ? {
      id: cleanString(raw.provider.id, 80),
      connectionId: cleanString(raw.provider.connectionId, 200),
      model: cleanString(raw.provider.model, 200)
    }
    : null;
  return {
    schemaVersion: SCHEMA_VERSION,
    savedAt: Number.isFinite(Number(raw.savedAt)) ? Number(raw.savedAt) : 0,
    tabs,
    chat,
    provider
  };
}

// The launcher owns the switch: an ordinary `npm run desktop:dev` must never
// resurrect a previous session.
function devResumeRequested(env = process.env) {
  return String(env?.BROWSER_USE_DEV_RESUME || '') === '1';
}

class DevSessionStore {
  constructor({ filePath, now = Date.now, onError = null }) {
    this.filePath = filePath;
    this.now = now;
    this.onError = onError;
  }

  // Snapshot the live app into a resume record. Pure: the caller supplies the
  // state, so the capture rules are testable without Electron.
  capture({ tabs = [], chat = null, drawer = null, provider = null, draft = '' } = {}) {
    const normalizedTabs = (Array.isArray(tabs) ? tabs : [])
      .map(normalizeTab)
      .filter(Boolean)
      .slice(0, MAX_TABS);
    return normalizeDevSession({
      savedAt: this.now(),
      tabs: normalizedTabs,
      chat: chat ? { ...chat, drawerOpen: drawer === 'agent', draft } : null,
      provider
    });
  }

  // A cheap identity for the record: identical captures must not rewrite the
  // file (publishState runs many times per second during a run).
  signature(record) {
    if (!record) return '';
    return JSON.stringify({
      tabs: (record.tabs || []).map((tab) => `${tab.url}|${tab.active ? 1 : 0}`),
      chat: record.chat ? `${record.chat.conversationId}|${record.chat.status}|${record.chat.drawerOpen ? 1 : 0}|${record.chat.draft}` : '',
      provider: record.provider ? `${record.provider.id}|${record.provider.connectionId}|${record.provider.model}` : ''
    });
  }

  save(record) {
    if (!record) return false;
    const body = JSON.stringify(record, null, 2);
    try {
      const directory = path.dirname(this.filePath);
      fs.mkdirSync(directory, { recursive: true });
      const temporary = `${this.filePath}.tmp`;
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, this.filePath);
      return true;
    } catch (error) {
      try { this.onError?.(error); } catch { /* reporting must never throw */ }
      return false;
    }
  }

  load() {
    try {
      return normalizeDevSession(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code !== 'ENOENT') { try { this.onError?.(error); } catch { /* ignore */ } }
      return null;
    }
  }

  clear() {
    try { fs.unlinkSync(this.filePath); return true; } catch { return false; }
  }
}

module.exports = {
  DevSessionStore,
  normalizeDevSession,
  devResumeRequested,
  RESUMABLE_STATUSES,
  SCHEMA_VERSION
};
