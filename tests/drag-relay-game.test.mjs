import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The drag-relay game is the multi-drag + multi-click test surface, and its
// idle-gap meter answers the owner's question directly: did the agent work
// continuously (like a human) or stop to think between actions?
const html = fs.readFileSync(path.join(process.cwd(), 'test-games/drag-relay.html'), 'utf8');
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
      this.clientWidth = 960;
      this.clientHeight = 300;
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
    setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
    getAttribute(name) { return (this.attributes || {})[name] ?? null; }
    querySelector(selector) {
      const match = /\[data-value="([^"]+)"\]/.exec(selector);
      if (!match) return null;
      return this.children.find((child) => child.dataset?.value === match[1]) || null;
    }
    getBoundingClientRect() { return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
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
  return { document };
}

function boot() {
  const { document } = makeDom();
  const clock = { t: 0 };
  const intervals = [];
  const performance = { now: () => clock.t };
  const setInterval = (fn) => { intervals.push({ fn }); return intervals.length; };
  const clearInterval = () => {};
  const window = {};
  const location = { search: '' };   // labeled default; '?plain=1' strips a11y
  // eslint-disable-next-line no-new-func
  new Function('document', 'performance', 'setInterval', 'clearInterval', 'window', 'location', script)(document, performance, setInterval, clearInterval, window, location);
  return { window, clock, intervals, relay: window.__relay, document };
}

test('the relay starts READY with 6 tokens and 6 slots', () => {
  const game = boot();
  const snapshot = game.relay.snapshot();
  assert.equal(snapshot.state, 'ready');
  assert.equal(snapshot.pairsDone, 0);
  assert.equal(snapshot.nextValue, 1);
  assert.equal(game.document.getElementById('field').children.length, 6, 'six draggable tokens');
  assert.equal(game.document.getElementById('slots').children.length, 6, 'six drop slots');
});

test('a continuous run passes: 6 drags + 6 arms inside 20s with no think-pause', () => {
  const game = boot();
  for (let value = 1; value <= 6; value += 1) {
    game.clock.t += 100;
    assert.equal(game.relay.place(value, value).ok, true, `drag ${value}`);
    game.clock.t += 100;
    assert.equal(game.relay.arm(value).ok, true, `arm ${value}`);
  }
  const result = game.relay.snapshot().result;
  assert.equal(result.state, 'pass');
  assert.equal(result.verdict, 'CONTINUOUS WORK');
  assert.equal(result.pairsDone, 6);
  assert.ok(result.maxGapMs <= 100, `max gap ${result.maxGapMs}`);
});

test('a think-pause between actions is reported as PAUSED TO THINK', () => {
  const game = boot();
  game.clock.t += 50;
  game.relay.place(1, 1);
  game.relay.arm(1);
  game.clock.t += 2_400;          // the agent stops to think
  game.relay.place(2, 2);
  game.relay.arm(2);
  for (let value = 3; value <= 6; value += 1) {
    game.clock.t += 100;
    game.relay.place(value, value);
    game.relay.arm(value);
  }
  const result = game.relay.snapshot().result;
  assert.equal(result.state, 'pass');
  assert.match(result.verdict, /^PAUSED TO THINK/, 'the 2.4s gap is named');
  assert.ok(result.maxGapMs >= 2_400);
});

test('dropping a token out of order fails immediately and names the order', () => {
  const game = boot();
  game.relay.place(1, 1);
  game.relay.arm(1);
  const outcome = game.relay.place(3, 3);
  assert.equal(outcome.ok, false);
  const result = game.relay.snapshot().result;
  assert.equal(result.state, 'fail');
  assert.match(result.log.at(-1).note, /expected token 2/);
});

test('dropping a token onto the wrong slot fails', () => {
  const game = boot();
  const outcome = game.relay.place(1, 4);
  assert.equal(outcome.ok, false);
  assert.equal(game.relay.snapshot().state, 'fail');
});

test('arming a slot before its token is placed fails', () => {
  const game = boot();
  const outcome = game.relay.arm(1);
  assert.equal(outcome.ok, false);
  assert.equal(game.relay.snapshot().state, 'fail');
});

test('the 20s window closes the run', () => {
  const game = boot();
  game.relay.place(1, 1);
  game.relay.arm(1);
  game.clock.t = 20_500;
  for (const { fn } of game.intervals) fn();
  const result = game.relay.snapshot().result;
  assert.equal(result.state, 'fail');
  assert.match(game.document.getElementById('result').textContent, /20s window closed/);
});

test('the harness discovers positioned visual objects on UNLABELED pages', () => {
  // Real pages are not authored for the agent: a draggable object is often a
  // plain absolutely-positioned div with no role/tabindex/label. The snapshot
  // must find it from GEOMETRY, not from vocabulary.
  const controllerSrc = fs.readFileSync(path.join(process.cwd(), 'desktop/mcp/browserViewController.cjs'), 'utf8');
  const collectorStart = controllerSrc.indexOf('function buildElementCollectorScript');
  const collector = controllerSrc.slice(collectorStart, collectorStart + 30_000);
  assert.match(collector, /style\.position !== 'absolute' && style\.position !== 'fixed'/, 'positioned boxes are visual objects');
  assert.match(collector, /box\.width < 40 \|\| box\.height < 40/, 'a real box is required');
  assert.match(collector, /positionedVisuals\.push/, 'they join the visual targets');

  const internals = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/agentInternals.cjs'), 'utf8');
  assert.match(internals, /visualTargets center\.x directly/, 'the guidance tells the model to use the CSS-px centers');
  assert.match(internals, /must match exactly ONE entry/, 'visual-target identity must be unique');

  // The game ships an unlabeled mode so the real-world path is testable.
  assert.match(html, /const PLAIN = new URLSearchParams\(location\.search\)/, 'the game can strip every label');
});

test('browser_drag is a CORE tool; the desktop pointer is scoped to native surfaces', () => {
  // The relay run never called browser_drag: it was DEFERRED out of the tool
  // list, so the model reached for the desktop pointer and dragged at screen
  // coordinates (even grabbing the app window). Dragging is a primary verb.
  const catalog = fs.readFileSync(path.join(process.cwd(), 'desktop/agent/deferredToolCatalog.cjs'), 'utf8');
  const coreStart = catalog.indexOf('const CORE_TOOLS');
  const core = catalog.slice(coreStart, catalog.indexOf(']);', coreStart));
  assert.match(core, /'browser_drag'/, 'dragging is core, never deferred');
  assert.match(core, /'browser_click'/, 'clicking stays core');

  const computer = fs.readFileSync(path.join(process.cwd(), 'desktop/computer/computerCatalog.cjs'), 'utf8');
  assert.match(computer, /NEVER for page content: inside the browsing view use browser_click \/ browser_drag/,
    'the desktop pointer must point page work back to the browser tools');
});
