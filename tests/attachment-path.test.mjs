// Attachment path pipeline (owner directive: filesystem-sourced attachments
// ride as source paths — no content copy, folders included; in-memory
// attachments keep the legacy copy budgets). Covers the renderer's pure
// classifier, the agent's normalizeAttachments contract, the provider-side
// boundedAttachments context shape, and the directory→workspace seeding.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const attachments = require('../desktop/renderer/attachments.cjs');
const { normalizeAttachments, DesktopChatAgent } = require('../desktop/agent/desktopChatAgent.cjs');
const { boundedAttachments, boundedRequestContext } = require('../desktop/agent/ollamaProvider.cjs');

test('classifyFile: a File with a resolvable path becomes a path attachment without reading content', () => {
  const file = { name: 'big-folder', type: '', size: 0 };
  const decision = attachments.classifyFile(file, 'E:\\drop\\big-folder');
  assert.equal(decision.mode, 'path');
  assert.equal(decision.attachment.kind, 'path');
  assert.equal(decision.attachment.path, 'E:\\drop\\big-folder');
  assert.equal(decision.attachment.name, 'big-folder');
  assert.equal(decision.attachment.content, undefined, 'no content is read');
  assert.equal(decision.attachment.dataUrl, undefined, 'no bytes are copied');
});

test('classifyFile: a File without an on-disk source falls back to the legacy copy mode', () => {
  const synthetic = { name: 'clipboard.png', type: 'image/png', size: 1234 };
  const decision = attachments.classifyFile(synthetic, '');
  assert.equal(decision.mode, 'copy');
  // And via the resolver path (no preload helper available in node).
  const viaResolver = attachments.classifyFile({ name: 'x.txt' });
  assert.equal(viaResolver.mode, 'copy');
});

test('classifyFile: keeps files and folders indistinguishable on purpose — the backend stats the path', () => {
  const file = attachments.classifyFile({ name: 'notes.md', type: 'text/markdown', size: 40 }, 'C:\\a\\notes.md');
  const folder = attachments.classifyFile({ name: 'proj', type: '', size: 0 }, 'C:\\a\\proj');
  assert.equal(file.attachment.kind, 'path');
  assert.equal(folder.attachment.kind, 'path');
  assert.equal(file.attachment.isDirectory, undefined, 'the renderer never guesses; fs.stat decides');
});

test('normalizeAttachments: path attachments resolve through fs.stat with real size and directory flag', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-path-'));
  const file = path.join(root, 'note.txt');
  fs.writeFileSync(file, 'x'.repeat(2048));
  const folder = path.join(root, 'bundle');
  fs.mkdirSync(folder);
  const normalized = await normalizeAttachments([
    { kind: 'path', name: 'note.txt', path: file, mimeType: 'text/plain' },
    { kind: 'path', name: 'bundle', path: folder }
  ]);
  assert.equal(normalized.length, 2);
  assert.equal(normalized[0].kind, 'path');
  assert.equal(normalized[0].size, 2048, 'file size comes from stat, not the renderer');
  assert.equal(normalized[0].isDirectory, false);
  assert.equal(normalized[0].content, undefined, 'no content inlined');
  assert.equal(normalized[1].isDirectory, true);
  assert.equal(normalized[1].path, path.resolve(folder));
});

test('normalizeAttachments: a path attachment that no longer exists refuses the run with a clear error', async () => {
  await assert.rejects(
    () => normalizeAttachments([{ kind: 'path', name: 'gone.txt', path: 'Z:\\definitely\\missing\\gone.txt' }]),
    /no longer exists on disk/
  );
});

test('normalizeAttachments: a path attachment without a path string refuses the run', async () => {
  await assert.rejects(
    () => normalizeAttachments([{ kind: 'path', name: 'broken' }]),
    /without a source path/
  );
});

test('normalizeAttachments: path attachments are EXEMPT from the legacy text budgets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-path-'));
  const big = path.join(root, 'big.log');
  fs.writeFileSync(big, 'y'.repeat(300_000)); // exceeds the 120k inline budget on purpose
  const normalized = await normalizeAttachments([{ kind: 'path', name: 'big.log', path: big }]);
  assert.equal(normalized[0].size, 300_000);
  assert.equal(normalized[0].content, undefined);
});

test('normalizeAttachments: in-memory attachments keep the legacy budgets and content copy', async () => {
  const normalized = await normalizeAttachments([{ kind: 'file', name: 'a.txt', text: 'hello' }]);
  assert.equal(normalized[0].kind, 'text');
  assert.equal(normalized[0].content, 'hello');
  await assert.rejects(
    () => normalizeAttachments([{ kind: 'file', name: 'big.txt', text: 'z'.repeat(120_001) }]),
    /under 120,000 characters/
  );
});

test('boundedAttachments: path attachments reach the model context as path metadata with file-tool guidance', () => {
  const context = boundedRequestContext({
    task: 'inspect the bundle',
    attachments: [
      { name: 'bundle', kind: 'path', mimeType: '', size: 0, path: 'E:\\drop\\bundle', isDirectory: true },
      { name: 'notes.md', kind: 'path', mimeType: 'text/markdown', size: 40, path: 'E:\\drop\\notes.md', isDirectory: false },
      { name: 'inline.txt', kind: 'text', mimeType: 'text/plain', size: 5, content: 'hello' }
    ]
  });
  const [folder, file, inline] = context.attachments;
  assert.equal(folder.kind, 'path');
  assert.equal(folder.path, 'E:\\drop\\bundle');
  assert.equal(folder.isDirectory, true);
  assert.equal(folder.content, undefined);
  assert.match(folder.note, /file tools/);
  assert.match(folder.note, /FOLDER/);
  assert.equal(file.isDirectory, false);
  assert.equal(inline.content, 'hello', 'in-memory attachments still arrive inline');
  assert.match(context.attachmentsNote, /SOURCE PATH/);
  assert.match(context.attachmentsNote, /file tools/);
});

// ---- Run-level integration: the provider receives the path + the folder
// seeds the default workspace when the caller declared none.
function createController() {
  return {
    async domSnapshot() { return { tabId: 'tab-1', url: 'https://example.test/', title: 'Example', viewport: { width: 1280, height: 720 }, elements: [], truncated: false }; },
    navigationState() { return { tabId: 'tab-1', url: 'https://example.test/', loading: false }; },
    consoleEntries() { return []; },
    networkEntries() { return []; },
    async screenshot() { return { tabId: 'tab-1', mimeType: 'image/png', data: 'x' }; },
    releaseSessionInput() { return { released: true }; }
  };
}

test('a directory attachment reaches the run and seeds the default workspace scope', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-workspace-'));
  const folder = path.join(root, 'big-bundle');
  fs.mkdirSync(folder);
  let seen = null;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(args) {
        seen = args;
        return { done: { summary: 'ok', success: true } };
      }
    })
  });
  const run = await agent.start({
    task: 'summarize the bundle',
    provider: { id: 'mock', model: 'mock' },
    attachments: [{ kind: 'path', name: 'big-bundle', path: folder }]
  });
  assert.equal(run.status, 'completed');
  assert.ok(seen, 'the provider decision must have run');
  const folderAttachment = (seen.attachments || []).find((item) => item.kind === 'path');
  assert.ok(folderAttachment, 'the run context must carry the folder attachment');
  assert.equal(folderAttachment.path, path.resolve(folder));
  assert.equal(folderAttachment.isDirectory, true);
  assert.ok(seen.workspace?.root, 'the folder must seed the workspace scope');
  assert.equal(path.resolve(seen.workspace.root), path.resolve(folder));
});

test('an explicit caller workspace is never overridden by a directory attachment', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attachment-workspace-'));
  const folder = path.join(root, 'bundle');
  fs.mkdirSync(folder);
  let seen = null;
  const agent = new DesktopChatAgent({
    controller: createController(),
    getSelectedTabId: () => 'tab-1',
    emit: () => {},
    createProvider: () => ({
      async complete(args) { seen = args; return { done: { summary: 'ok', success: true } }; }
    })
  });
  await agent.start({
    task: 'summarize the bundle',
    provider: { id: 'mock', model: 'mock' },
    workspace: { root: 'C:\\caller-declared-root' },
    attachments: [{ kind: 'path', name: 'bundle', path: folder }]
  });
  assert.equal(seen.workspace.root, path.resolve('C:\\caller-declared-root'));
  assert.ok((seen.attachments || []).some((item) => item.kind === 'path' && item.path === path.resolve(folder)));
});
