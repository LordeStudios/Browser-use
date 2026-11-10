import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDirectory = path.join(root, 'output', 'playwright');
fs.mkdirSync(evidenceDirectory, { recursive: true });
const prompt = 'Open https://example.com and inspect the visible page. Visibly move the mouse pointer to the Learn more link, click that link, wait for the IANA destination to load, verify its title and URL, navigate back, then visibly move the pointer to the middle of the page and stop interacting. Finish with a concise explanation of what you verified.';

const app = await electron.launch({
  executablePath: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe'),
  args: ['.'],
  cwd: root
});

try {
  const shell = await appWindow(app, '/desktop/renderer/index.html');
  let pointer = await appWindow(app, '/desktop/renderer/agent-pointer.html');
  await shell.waitForSelector('#agent-toggle');
  await pointer.waitForSelector('#browser-use-agent-pointer');

  await shell.locator('#agent-toggle').click();
  await shell.waitForFunction(() => !document.querySelector('#agent-panel').hidden);
  await shell.locator('#agent-new-chat').click();
  await shell.locator('#agent-permission').selectOption('unattended');

  const configuration = await shell.evaluate(async () => {
    const settings = await window.browserUseDesktop.settings();
    return {
      modelLabel: document.querySelector('#agent-model-label')?.textContent?.trim() || '',
      status: document.querySelector('#agent-run-status')?.textContent?.trim() || '',
      connections: (settings.aiConnections || []).map((entry) => ({
        id: entry.id,
        name: entry.name,
        provider: entry.provider,
        model: entry.model,
        baseUrl: entry.baseUrl
      }))
    };
  });
  console.log(`supervised-live: configuration ${JSON.stringify(configuration)}`);

  await installPointerSampler(pointer);

  await shell.locator('#agent-task').fill(prompt);
  await focusMainWindow(app);
  const sentAt = Date.now();
  await shell.locator('#agent-send').click();
  console.log(`supervised-live: prompt sent ${new Date(sentAt).toISOString()}`);

  let started = false;
  let finished = false;
  let lastLogAt = 0;
  let clickEvidenceSaved = false;
  let latest = null;
  let pointerReplacements = 0;
  let lastFocusAt = sentAt;
  let liveControls = null;
  const pointerSamples = [];
  const deadline = Date.now() + 420_000;
  while (Date.now() < deadline) {
    if (Date.now() - lastFocusAt >= 2_000) {
      await focusMainWindow(app);
      lastFocusAt = Date.now();
    }
    latest = await shell.evaluate(() => ({
      active: !document.querySelector('#agent-cancel').hidden,
      status: document.querySelector('#agent-run-status')?.textContent?.trim() || '',
      model: document.querySelector('#agent-model-label')?.textContent?.trim() || '',
      thinking: [...document.querySelectorAll('.agent-thinking-content')].map((node) => node.textContent.trim()).filter(Boolean),
      tools: [...document.querySelectorAll('.agent-message.is-tool')].map((node) => node.textContent.trim()),
      assistants: [...document.querySelectorAll('.agent-message.is-assistant > p')].map((node) => node.textContent.trim()),
      errors: [...document.querySelectorAll('.agent-message.is-error')].map((node) => node.textContent.trim()),
      transcript: document.querySelector('#agent-transcript')?.innerText?.trim() || ''
    }));
    let pointerState = null;
    try {
      const observed = await drainPointerSamples(pointer);
      pointerSamples.push(...observed.samples);
      pointerState = observed.state;
    } catch {
      pointer = await appWindow(app, '/desktop/renderer/agent-pointer.html');
      await pointer.waitForSelector('#browser-use-agent-pointer');
      await installPointerSampler(pointer);
      pointerReplacements += 1;
      console.log(`supervised-live: pointer renderer replacement ${pointerReplacements}`);
      continue;
    }
    if (latest.active) started = true;
    if (latest.active && !liveControls) {
      liveControls = {
        newChatDisabled: await shell.locator('#agent-new-chat').isDisabled(),
        historyDisabled: await shell.locator('#agent-history').isDisabled(),
        stopDisabled: await shell.locator('#agent-cancel').isDisabled()
      };
      await shell.locator('#agent-history').click();
      await shell.waitForFunction(() => !document.querySelector('#agent-history-view').hidden);
      liveControls.stopAvailableWhileHistoryOpen = !(await shell.locator('#agent-cancel').isDisabled());
      await shell.locator('#agent-history-close').click();
    }
    if (!clickEvidenceSaved && pointerState?.clickCount > 0) {
      await pointer.screenshot({ path: path.join(evidenceDirectory, 'supervised-live-pointer-click.png'), omitBackground: true });
      clickEvidenceSaved = true;
    }
    if (Date.now() - lastLogAt >= 2_000) {
      console.log(`supervised-live: ${JSON.stringify({ elapsedMs: Date.now() - sentAt, status: latest.status, active: latest.active, thoughts: latest.thinking.length, thoughtChars: latest.thinking.at(-1)?.length || 0, tools: latest.tools.length, assistants: latest.assistants.length, errors: latest.errors.length, pointer: pointerState })}`);
      lastLogAt = Date.now();
    }
    if (started && !latest.active && /^(completed|failed|cancelled)\b/i.test(latest.status)) {
      finished = true;
      break;
    }
    await delay(250);
  }

  await delay(900);
  const finalPointerObservation = await drainPointerSamples(pointer);
  pointerSamples.push(...finalPointerObservation.samples);
  await pointer.evaluate(() => clearInterval(globalThis.__supervisedPointerTimer));
  const pageState = await app.evaluate(({ BrowserWindow }) => {
    const shellWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    const view = shellWindow?.getBrowserViews().find((candidate) => !candidate.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/overlay.html'));
    return view ? { url: view.webContents.getURL(), title: view.webContents.getTitle(), bounds: view.getBounds() } : null;
  });
  const activeSamples = pointerSamples.filter((sample) => sample.at >= sentAt && (sample.visible || sample.opacity >= 0.999));
  const uniqueFrames = [];
  for (const sample of activeSamples) {
    const key = `${Math.round(sample.x)},${Math.round(sample.y)},${sample.sequence}`;
    if (uniqueFrames.at(-1)?.key !== key) uniqueFrames.push({ key, ...sample });
  }
  const firstActive = activeSamples[0] || null;
  const lastActive = activeSamples.at(-1) || null;
  const summary = {
    ok: finished && /^completed\b/i.test(latest?.status || ''),
    prompt,
    model: latest?.model || configuration.modelLabel,
    status: latest?.status,
    firstPointerActivityMs: firstActive ? firstActive.at - sentAt : null,
    firstPointerOpacity: firstActive?.opacity,
    pointerSequences: Math.max(0, ...pointerSamples.map((sample) => sample.sequence)),
    pointerUniqueFrames: uniqueFrames.length,
    pointerClickCount: Math.max(0, ...pointerSamples.map((sample) => sample.clickCount)),
    pointerRendererReplacements: pointerReplacements,
    pointerFinished: lastActive && { x: lastActive.x, y: lastActive.y, opacity: lastActive.opacity, sequence: lastActive.sequence },
    page: pageState,
    tools: latest?.tools,
    thoughts: latest?.thinking,
    assistants: latest?.assistants,
    errors: latest?.errors,
    liveControls,
    evidence: clickEvidenceSaved ? path.join(evidenceDirectory, 'supervised-live-pointer-click.png') : null
  };
  console.log(JSON.stringify(summary, null, 2));

  assert.equal(finished, true, 'the real AI run did not reach a terminal state in seven minutes');
  assert.match(latest.status, /^completed\b/i, `the real AI run did not complete: ${latest.status}`);
  assert.ok(firstActive, 'the real AI run never activated the pointer');
  assert.equal(firstActive.opacity, 1, 'the pointer was not fully opaque on its first sampled activation frame');
  assert.ok(uniqueFrames.length >= 5, `expected smooth multi-frame pointer movement, saw ${uniqueFrames.length} frames`);
  assert.ok(summary.pointerClickCount >= 1, 'the real AI run never painted a click');
  assert.ok(latest.tools.length >= 4, `the real AI run did not perform the requested navigation flow: ${latest.tools.join(' | ')}`);
  assert.ok(latest.assistants.length >= 1, 'the real AI run produced no final assistant reply');
  assert.deepEqual(liveControls, {
    newChatDisabled: false,
    historyDisabled: false,
    stopDisabled: false,
    stopAvailableWhileHistoryOpen: true
  }, 'the live task locked a chat control instead of retaining interactive Stop, New chat, and History controls');
  const pointerErrors = latest.errors.filter((error) => /pointer|renderer|click was interrupted/i.test(error));
  assert.deepEqual(pointerErrors, [], `the real AI run reported pointer errors: ${pointerErrors.join(' | ')}`);
} finally {
  await app.close();
}

async function appWindow(app, suffix) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const window of app.windows()) {
      if ((await window.url()).replace(/\\/g, '/').endsWith(suffix)) return window;
    }
    await delay(100);
  }
  throw new Error(`Window did not load: ${suffix}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function focusMainWindow(app) {
  return app.evaluate(({ BrowserWindow }) => {
    const shell = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().replace(/\\/g, '/').endsWith('/desktop/renderer/index.html'));
    if (!shell) return false;
    if (shell.isMinimized()) shell.restore();
    shell.show();
    shell.focus();
    return shell.isFocused();
  });
}

function installPointerSampler(pointer) {
  return pointer.evaluate(() => {
    clearInterval(globalThis.__supervisedPointerTimer);
    globalThis.__supervisedPointerSamples = [];
    globalThis.__supervisedPointerTimer = setInterval(() => {
      const node = document.getElementById('browser-use-agent-pointer');
      if (!node) return;
      globalThis.__supervisedPointerSamples.push({
        at: Date.now(),
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
        visible: node.dataset.visible === 'true',
        x: Number(node.dataset.currentX),
        y: Number(node.dataset.currentY),
        targetX: Number(node.dataset.targetX),
        targetY: Number(node.dataset.targetY),
        sequence: Number(node.dataset.sequence || 0),
        clickCount: Number(node.dataset.clickCount || 0),
        pressed: node.dataset.pressed === 'true'
      });
    }, 16);
  });
}

function drainPointerSamples(pointer) {
  return pointer.evaluate(() => {
    const node = document.getElementById('browser-use-agent-pointer');
    const samples = globalThis.__supervisedPointerSamples?.splice(0) || [];
    return {
      samples,
      state: node ? {
        opacity: Number.parseFloat(getComputedStyle(node).opacity),
        x: Number(node.dataset.currentX),
        y: Number(node.dataset.currentY),
        sequence: Number(node.dataset.sequence || 0),
        clickCount: Number(node.dataset.clickCount || 0),
        pressed: node.dataset.pressed === 'true'
      } : null
    };
  });
}
