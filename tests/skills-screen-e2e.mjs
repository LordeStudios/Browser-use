import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

// Drives the REAL app to the Skills screen: the header, the search, the
// filters, one skill's detail view, and the editor. The screen is the part of
// this work a unit test cannot see, so it is checked against the running app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronExecutable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-use-skills-'));

const electronApp = await electron.launch({
  executablePath: electronExecutable,
  args: ['.', `--user-data-dir=${appDataDirectory}`],
  cwd: root,
  env: { ...process.env, APPDATA: appDataDirectory, LOCALAPPDATA: appDataDirectory, BROWSER_USE_DESKTOP_MCP_PORT: '0' }
});

try {
  const window = await mainRendererWindow(electronApp);
  window.setDefaultTimeout(20_000);
  await window.waitForSelector('#settings-toggle');

  // Open the Skills screen the way a person does: the Skills button in the
  // agent drawer.
  await window.locator('#agent-skills').click();
  await window.waitForFunction(() => !document.querySelector('#agent-skills-view').hidden);
  await window.waitForSelector('.skills-head', { state: 'visible' });

  // The header states what the screen is and how many skills there are.
  assert.equal(await window.locator('#skills-title').innerText(), 'Skills');
  const summary = await window.locator('#skills-summary').innerText();
  assert.match(summary, /skill/i, 'the summary must say how many skills there are');

  // The search box and the filters are present and wired.
  assert.equal(await window.locator('#skills-search').isVisible(), true);
  const filters = await window.locator('.skills-filter').allInnerTexts();
  assert.ok(filters.length >= 3, `expected filter chips, found ${filters.length}`);
  assert.ok(filters.join(' ').includes('All'), 'the filter chips must include All');

  // The list shows a card per skill, each with a verdict and a description.
  const cards = await window.locator('.skill-card').count();
  assert.ok(cards >= 1, 'the screen must list the installed skills');
  assert.equal(await window.locator('.skill-badge').count() >= 1, true, 'each skill must carry a verdict');
  const firstName = await window.locator('.skill-card-name').first().innerText();
  assert.ok(firstName.trim().length > 0, 'a skill card must name its skill');

  // Search narrows the list.
  await window.locator('#skills-search').fill('zzz-nothing-matches-this');
  await window.waitForFunction(() => document.querySelectorAll('.skill-card').length === 0);
  assert.ok((await window.locator('.skills-message').innerText()).length > 0, 'an empty search must say so');
  await window.locator('#skills-search').fill('');

  // A skill opens to a detail view carrying its full text.
  await window.locator('.skill-card-main').first().click();
  await window.waitForSelector('.skill-detail', { state: 'visible' });
  assert.ok(await window.locator('.skill-health').isVisible(), 'the detail view must state whether the agent can use the skill');
  assert.ok(await window.locator('.skill-facts').isVisible(), 'the detail view must show where the skill comes from');
  const bodyText = await window.locator('.skill-body').innerText();
  assert.ok(bodyText.length > 100, `the detail view must show the skill's own text, got ${bodyText.length} characters`);

  // The detail view can be edited: the editor opens with the skill's fields.
  await window.locator('.skill-detail-actions >> text=Edit').click();
  await window.waitForSelector('.skill-form', { state: 'visible' });
  const titleValue = await window.locator('.skill-form input').first().inputValue();
  assert.ok(titleValue.trim().length > 0, 'the editor must be filled with the skill');
  // Back from the editor returns to the skill, and back again to the list.
  await window.locator('.skills-back').click();
  await window.waitForSelector('.skill-detail', { state: 'visible' });
  await window.locator('.skills-back').click();
  await window.waitForSelector('.skills-list', { state: 'visible' });

  // Nothing above threw, and the console is clean of renderer errors.
  const errors = await window.evaluate(() => window.__skillsConsoleErrors || []);
  assert.deepEqual(errors, []);

  // The screen is read in a dark drawer, so its text has to carry. Every
  // visible string is checked against the surface behind it.
  const contrast = await window.evaluate(() => {
    const parse = (color) => {
      const parts = (String(color).match(/[\d.]+/g) || []).map(Number);
      if (parts.length < 3) return null;
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1
    });
    const luminance = ({ r, g, b }) => {
      const [lr, lg, lb] = [r, g, b].map((value) => {
        const v = value / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    // The surface behind a piece of text is every background layer between it
    // and the root, composited. A translucent tint (a lime badge over a dark
    // card) is not an opaque surface, and treating it as one makes a lime
    // label look like lime on lime.
    const surfaceOf = (element) => {
      const layers = [];
      let node = element;
      while (node) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) {
          layers.push(color);
          if (color.a === 1) break;
        }
        node = node.parentElement;
      }
      let result = { r: 6, g: 11, b: 13, a: 1 };
      for (let index = layers.length - 1; index >= 0; index -= 1) result = over(layers[index], result);
      return result;
    };
    const poor = [];
    for (const element of document.querySelectorAll('#agent-skills-view *')) {
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      if (element.children.length) continue;
      const text = (element.textContent || '').trim();
      if (!text) continue;
      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 18.66 || (size >= 14 && weight >= 700);
      const foreground = parse(style.color);
      if (!foreground) continue;
      const background = surfaceOf(element);
      const fl = luminance(foreground);
      const bl = luminance(background);
      const ratio = (Math.max(fl, bl) + 0.05) / (Math.min(fl, bl) + 0.05);
      const floor = large ? 3 : 4.5;
      if (ratio < floor) poor.push(`${element.className || element.tagName} ${ratio.toFixed(2)}:1 (needs ${floor}) "${text.slice(0, 30)}"`);
    }
    return poor;
  });
  assert.deepEqual(contrast, [], `low-contrast text on the skills screen:\n  ${contrast.join('\n  ')}`);

  await assertANewSkillIsWrittenToDisk(electronApp, window);

  console.log('SKILLS SCREEN E2E OK');
} finally {
  await electronApp.close().catch(() => {});
}


async function mainRendererWindow(electronApp) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith('/desktop/renderer/index.html')) return candidate;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser-use main renderer did not load within 30 seconds.');
}

// A skill added through the screen must actually be written to disk. The
// learned store lives in the app's own userData, so this writes into the
// throwaway profile the test launched with — never into the user's store.
async function assertANewSkillIsWrittenToDisk(electronApp, window) {
  await window.locator('#agent-skills-close').click();
  await window.locator('#agent-skills').click();
  await window.waitForSelector('.skills-head', { state: 'visible' });
  const before = await window.locator('.skill-card').count();

  await window.locator('#agent-skill-add').click();
  await window.waitForSelector('.skill-form', { state: 'visible' });
  // Selected by label, not by position: the order of the fields is not the
  // contract, and filling by index put the steps into the trigger field.
  const field = (label) => window.locator('.skill-field').filter({
    has: window.locator('.skill-field-label', { hasText: new RegExp('^' + label + '$') })
  });
  await field('Title').locator('input').fill('E2E probe skill');
  await field('Use it when').locator('input').fill('When the end-to-end test asks for it');
  await field('Steps').locator('textarea').fill('Look at the thing.\nThen report what you saw.');
  await window.locator('.skill-form-bar button[type="submit"]').click();

  await window.waitForFunction((count) => document.querySelectorAll('.skill-card').length === count + 1, before, { timeout: 10_000 });
  const names = await window.locator('.skill-card-name').allInnerTexts();
  assert.ok(names.some((name) => name.includes('E2E probe skill')), `the new skill must appear in the list: ${names.join(', ')}`);

  // And it must be on disk, in the profile the test launched with.
  const written = await electronApp.evaluate(async ({ app }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const file = path.join(app.getPath('userData'), 'record-skills', 'skills.json');
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8');
  });
  assert.ok(written, 'the learned skill store must exist after a skill is saved');
  assert.ok(written.includes('E2E probe skill'), 'the new skill must be written to the store');
}
