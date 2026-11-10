import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = fs.mkdtempSync(path.join('D:/', `browser-use-chat-dock-${Date.now()}-`));
const app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), args: ['.', `--user-data-dir=${profile}`], cwd: root, env: { ...process.env, APPDATA: profile, LOCALAPPDATA: profile, BROWSER_USE_DESKTOP_MCP_PORT: '0', BROWSER_USE_START_URL: 'about:blank' }, timeout: 45_000 });
try {
  const shell = await app.windows().find(async window => (await window.url()).endsWith('/desktop/renderer/index.html'));
  assert.ok(shell, 'main renderer must load');
  await shell.waitForFunction(() => document.documentElement.dataset.browserUseRendererReady === 'true');
  await shell.locator('#agent-panel').waitFor({ state: 'visible' });
  const before = await shell.locator('#agent-panel').boundingBox();
  assert.ok(before?.height > 200, `Chat 1 must have a usable initial height: ${JSON.stringify(before)}`);
  await shell.locator('#terminal-toggle').click();
  await shell.locator('#terminal-panel').waitFor({ state: 'visible' });
  await shell.waitForFunction(() => Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--terminal-dock-height')) > 0);
  const after = await shell.locator('#agent-panel').boundingBox();
  const layout = await shell.evaluate(() => window.browserUseDesktop.terminalLayout());
  assert.ok(after?.height < before.height, `Chat 1 must shrink with docked terminal: ${before.height} -> ${after?.height}`);
  assert.ok(after.height <= before.height - layout.height + 8, `Chat 1 must end above the terminal dock: ${JSON.stringify({ before: before.height, after: after.height, terminal: layout.height })}`);
  await shell.locator('#terminal-close').click();
  await shell.locator('#terminal-panel').waitFor({ state: 'hidden' });
  const restored = await shell.locator('#agent-panel').boundingBox();
  assert.ok(restored?.height >= before.height - 2, `Chat 1 must restore after terminal close: ${before.height} -> ${restored?.height}`);
  console.log(JSON.stringify({ ok: true, before: before.height, docked: after.height, restored: restored.height, terminal: layout.height }));
} finally {
  await app.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
