import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const main = () => read('desktop/main.cjs');
const renderer = () => read('desktop/renderer/app.js');

test('chat dock geometry has one lightweight live channel', () => {
  const source = main();
  assert.match(source, /function publishChatDockGeometry\(\)/);
  assert.match(source, /send\('browser-use:chat-dock-geometry', geometry\)/);
  assert.match(source, /function setViewBoundsIfChanged\(view, bounds\)/);
  assert.match(source, /setViewBoundsIfChanged\(entry\.dockView, \{ x, y: stage\.y, width, height: stage\.height \}\)/);
  assert.match(source, /syncChatDockViews\(\{ reorder = false \} = \{\}\)/);
  assert.match(source, /syncChatDockViews\(\{ reorder: true \}\)/);

  const resizeHandler = source.match(/ipcMain\.handle\('browser-use:set-chat-window-width',[\s\S]*?\n  \}\);/u)?.[0] || '';
  assert.match(resizeHandler, /layoutSelectedTab\(\)/);
  assert.match(resizeHandler, /publishChatDockGeometry\(\)/);
  assert.doesNotMatch(resizeHandler, /syncBrowserViewVisibility\(\)/, 'dragging must not reattach native BrowserViews');
});

test('chat resize coalesces pointer updates and commits the final revision', () => {
  const source = renderer();
  assert.match(source, /let paneResizeFrame = 0/);
  assert.match(source, /requestAnimationFrame\(\(\) => \{/);
  assert.match(source, /pendingPaneResize = \{ width: next, publish:/);
  assert.match(source, /function flushPaneWidth\(publish = true\)/);
  assert.match(source, /flushPaneWidth\(true\)/);
  assert.match(source, /setChatWindowWidth\(\{ id: standaloneChatWindowId, width: next, revision: \+\+chatPaneResizeRevision, emitState: publish \}\)/);
  assert.match(source, /setAgentDrawerWidth\(\{ width: next, emitState: publish \}\)/);
});

test('chat geometry revisions update CSS without rebuilding transcript state', () => {
  const source = renderer();
  assert.match(source, /function applyChatDockGeometry\(geometry\)/);
  assert.match(source, /geometry\.paneRevisions\?\.\[standaloneChatWindowId\]/);
  assert.match(source, /onChatDockGeometry\(applyChatDockGeometry\)/);
  assert.match(source, /applyChatDockGeometry\(nextState\.chatDock\)/);
  assert.match(source, /--agent-dock-offset/);
});

test('extra-chat close is sender-owned and cannot close the primary chat', () => {
  const source = main();
  const handler = source.match(/ipcMain\.handle\('browser-use:close-chat-window',[\s\S]*?\n  \}\);/u)?.[0] || '';
  assert.match(handler, /chatWindowEntryForContents\(event\.sender\)/);
  assert.match(handler, /if \(!owner\?\.id\) return \{ closed: false \}/);
  assert.match(handler, /closeIndependentChatWindow\(owner\.id\)/);
  assert.doesNotMatch(handler, /closeIndependentChatWindow\(requested\)/);

  const app = renderer();
  assert.match(app, /button\.dataset\.close === 'agent' && standaloneChatWindowId/);
  assert.match(app, /closeChatWindow\(standaloneChatWindowId\)/);
  assert.match(app, /requestDrawer\(null\)/);
});

test('docked extra chats can fit their effective pane without a fixed standalone minimum', () => {
  const styles = read('desktop/renderer/styles.css');
  const referenceStyles = read('desktop/renderer/chat-reference.css');
  assert.match(styles, /body\.standalone-chat-window\{min-width:0;width:100%/);
  assert.match(referenceStyles, /body\.standalone-chat-window \.agent-drawer \{ width: 100%; right: 0; min-width: 0; \}/);
  assert.match(referenceStyles, /width: min\(var\(--agent-drawer-width, 472px\), calc\(100vw - var\(--agent-dock-offset, 0px\) - 180px\)\);/);
  assert.doesNotMatch(referenceStyles, /width: clamp\(320px, var\(--agent-drawer-width/);
  const flowcharts = [
    read('desktop/main_flow_chat.md'),
    read('desktop/renderer/app_flow_chat.md'),
    read('desktop/agent/chat_instances_flow_chat.md')
  ];
  for (const flow of flowcharts) {
    assert.match(flow, /```mermaid/);
    assert.match(flow, /geometry|close/i);
  }
});
