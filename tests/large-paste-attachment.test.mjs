import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('large paste is diverted before contenteditable insertText and rendered as a path attachment', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  // 16k was too high: everything below it still hit the contenteditable and
  // could freeze the renderer. A few KB (or 40 lines) is already unreadable
  // as a chat message — it belongs in a document the model reads.
  assert.match(app, /LARGE_PASTE_CHARS = 2_000/);
  assert.match(app, /LARGE_PASTE_LINES = 40/);
  assert.match(app, /savePastedTextAttachment\(\{ name: 'pasted-text', text \}\)/, 'the pasted text travels to main directly — no clipboard re-read race');
  assert.match(app, /addAgentPathAttachment\(attachment\)/);
  const handler = app.slice(app.indexOf("agentTask?.addEventListener('paste'"), app.indexOf("agentForm?.addEventListener('dragover'"));
  assert.ok(handler.indexOf('savePastedTextAttachment') < handler.indexOf('document.execCommand'), 'large-paste path is chosen before normal insertion');
  const preload = fs.readFileSync(path.join(process.cwd(), 'desktop/preload.cjs'), 'utf8');
  assert.match(preload, /savePastedTextAttachment/);
  const main = fs.readFileSync(path.join(process.cwd(), 'desktop/main.cjs'), 'utf8');
  assert.match(main, /browser-use:save-pasted-text-attachment/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'attachments'\)/);
  assert.match(main, /request\.text/);
  assert.match(main, /clipboard\.readText\(\)/);
});

test('large paste attachment is a filesystem path, not copied into the agent task payload', () => {
  const app = fs.readFileSync(path.join(process.cwd(), 'desktop/renderer/app.js'), 'utf8');
  assert.match(app, /kind: 'path'/);
  // Path-attachment normalization lives in agentInternals since the 2026-11-10
  // rewrite (the chat agent receives normalizedAttachments), not inline in
  // desktopChatAgent.
  const internals = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/agentInternals.cjs'), 'utf8');
  assert.match(internals, /kind: 'path'/);
  assert.match(internals, /rawPath/);
  const agent = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/desktopChatAgent.cjs'), 'utf8');
  assert.match(agent, /normalizedAttachments/, 'the agent consumes the normalized (path-preserving) attachments');
});
