import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The click-order game is the harness's multi-click/drag test surface: pure
// DOM fields, a 6s deadline from the FIRST click, strict ascending order.
// These tests PLAY the game against a minimal DOM stub so a broken rule can
// never waste a live agent run.
const html = fs.readFileSync(path.join(process.cwd(), 'test-games/click-order.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function makeDom() {
  class El {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.style = {};
      this.textContent = '';
      this.innerHTML = '';
      this.disabled = false;
      this.classList = {
        set: new Set(),
        add: (c) => this.classList.set.add(c),
        remove: (c) => this.classList.set.delete(c),
        toggle: (c, force) => (force ? this.classList.set.add(c) : this.classList.set.delete(c)),
        contains: (c) => this.classList.set.has(c)
      };
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    insertAdjacentHTML(_pos, markup) { this.innerHTML += markup; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    click() { for (const fn of this.listeners.click || []) fn(); }
    get scrollHeight() { return 0; }
    set scrollTop(_v) {}
    get scrollTop() { return 0; }
  }
  const registry = new Map();
  const document = {
    title: '',
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, new El());
      return registry.get(id);
    },
    createElement: (tag) => new El(tag)
  };
  return { document, El };
}

function boot() {
  const { document } = makeDom();
  const clock = { t: 0 };
  const intervals = [];
  const performance = { now: () => clock.t };
  const setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const clearInterval = () => {};
  const window = {};
  // eslint-disable-next-line no-new-func
  new Function('document', 'performance', 'setInterval', 'clearInterval', 'window', script)(document, performance, setInterval, clearInterval, window);
  const grid = document.getElementById('grid');
  const state = () => document.getElementById('state').textContent;
  const buttons = () => [...grid.children];
  const ordered = () => [...buttons()].sort((a, b) => Number(a.dataset.value) - Number(b.dataset.value));
  return { document, window, clock, intervals, grid, state, buttons, ordered };
}

test('the game starts READY with 40 unique fields drawn from 1..200', () => {
  const game = boot();
  assert.equal(game.state(), 'READY');
  const values = game.buttons().map((b) => Number(b.dataset.value));
  assert.equal(values.length, 40);
  assert.equal(new Set(values).size, 40, 'field values are unique');
  assert.ok(values.every((v) => v >= 1 && v <= 200), 'every value is within 1..200');
  assert.match(game.document.title, /READY/);
});

test('clicking every field in ascending order PASSES inside the window', () => {
  const game = boot();
  for (const button of game.ordered()) {
    game.clock.t += 100; // 4.0s total: inside the 6s window
    button.click();
  }
  assert.equal(game.state(), 'PASS');
  assert.equal(game.window.__clickOrderResult.state, 'pass');
  assert.equal(game.window.__clickLog.length, 40);
  assert.ok(game.window.__clickLog.every((entry) => entry.ok));
  assert.match(game.document.getElementById('result').textContent, /PASSED/);
});

test('one out-of-order field FAILS immediately and names what was expected', () => {
  const game = boot();
  const ordered = game.ordered();
  ordered[0].click();                 // smallest: correct
  ordered[2].click();                 // third smallest: WRONG (second was due)
  assert.equal(game.state(), 'FAIL');
  assert.equal(game.window.__clickOrderResult.state, 'fail');
  assert.match(game.window.__clickOrderResult.reason, new RegExp(`expected ${ordered[1].dataset.value}, got ${ordered[2].dataset.value}`));
  assert.match(game.document.getElementById('result').textContent, /FAILED/);
});

test('the 6s deadline from the first click fails a slow run', () => {
  const game = boot();
  const ordered = game.ordered();
  ordered[0].click();                 // timer starts here
  game.clock.t = 6_500;               // past the window
  for (const { fn } of game.intervals) fn();  // the page's tick
  assert.equal(game.state(), 'FAIL');
  assert.match(game.window.__clickOrderResult.reason, /6s window closed/);
});

test('the log records per-click timestamps, so batched vs per-decision clicks are visible', () => {
  const game = boot();
  const ordered = game.ordered();
  ordered[0].click();                 // t=0 starts the timer
  game.clock.t = 12; ordered[1].click();
  game.clock.t = 20; ordered[2].click();
  const log = game.window.__clickLog;
  assert.deepEqual(log.map((entry) => entry.at), [0, 12, 20], 'each click carries ms-since-first-click');
});
