import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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

// The relay positions its tokens INSIDE a field that sits well down the page,
// and its slots in a grid below that field. A DOM shim whose rects are all
// 0x0 cannot see a coordinate-space bug, so this one models the real
// geometry: pointer coordinates are viewport-relative while a token's
// left/top are field-relative.
const LAYOUT = {
  contentLeft: 18,
  contentWidth: 1000,
  fieldTop: 165,
  fieldHeight: 300,
  slotTop: 479,
  slotWidth: 158,
  slotHeight: 108,
  slotGap: 10,
  tokenSize: 74
};

function makeLayoutDom() {
  const registry = new Map();
  let field = null;
  let slotsHost = null;
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
      this.parent = null;
      this.clientWidth = LAYOUT.contentWidth;
      this.clientHeight = LAYOUT.fieldHeight;
      this.classList = {
        set: new Set(),
        add: (c) => this.classList.set.add(c),
        remove: (c) => this.classList.set.delete(c),
        toggle: (c, force) => (force ? this.classList.set.add(c) : this.classList.set.delete(c)),
        contains: (c) => this.classList.set.has(c)
      };
    }
    append(...nodes) {
      for (const node of nodes) { node.parent = this; this.children.push(node); }
    }
    replaceChildren(...nodes) {
      this.children = nodes;
      for (const node of nodes) node.parent = this;
    }
    insertAdjacentHTML(_pos, markup) { this.innerHTML += markup; }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
    }
    dispatch(type, event) {
      for (const listener of [...(this.listeners[type] || [])]) listener(event);
    }
    setAttribute(name, value) { (this.attributes ||= {})[name] = String(value); }
    getAttribute(name) { return (this.attributes || {})[name] ?? null; }
    querySelector(selector) {
      const match = /\[data-value="([^"]+)"\]/.exec(selector);
      if (!match) return null;
      return this.children.find((child) => child.dataset?.value === match[1]) || null;
    }
    getBoundingClientRect() {
      if (this.parent === field) {
        const left = LAYOUT.contentLeft + (Number.parseFloat(this.style.left) || 0);
        const top = LAYOUT.fieldTop + (Number.parseFloat(this.style.top) || 0);
        return { left, top, right: left + LAYOUT.tokenSize, bottom: top + LAYOUT.tokenSize, width: LAYOUT.tokenSize, height: LAYOUT.tokenSize };
      }
      if (this.parent === slotsHost) {
        const index = slotsHost.children.indexOf(this);
        const left = LAYOUT.contentLeft + index * (LAYOUT.slotWidth + LAYOUT.slotGap);
        const top = LAYOUT.slotTop;
        return { left, top, right: left + LAYOUT.slotWidth, bottom: top + LAYOUT.slotHeight, width: LAYOUT.slotWidth, height: LAYOUT.slotHeight };
      }
      return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    }
    get scrollHeight() { return 0; }
    set scrollTop(_v) {}
    get scrollTop() { return 0; }
  }
  const document = {
    title: '',
    listeners: {},
    getElementById(id) {
      if (!registry.has(id)) registry.set(id, new El());
      return registry.get(id);
    },
    createElement: (tag) => new El(tag),
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener !== fn);
    },
    dispatch(type, event) {
      for (const listener of [...(this.listeners[type] || [])]) listener(event);
    }
  };
  field = document.getElementById('field');
  slotsHost = document.getElementById('slots');
  return { document, field, slotsHost };
}

function bootLayout() {
  const { document, field, slotsHost } = makeLayoutDom();
  const clock = { t: 0 };
  const intervals = [];
  const performance = { now: () => clock.t };
  const setInterval = (fn) => { intervals.push({ fn }); return intervals.length; };
  const clearInterval = () => {};
  const window = {};
  const location = { search: '' };
  // eslint-disable-next-line no-new-func
  new Function('document', 'performance', 'setInterval', 'clearInterval', 'window', 'location', script)(document, performance, setInterval, clearInterval, window, location);
  const token = (value) => field.children.find((child) => child.dataset?.value === String(value));
  const slot = (value) => slotsHost.children.find((child) => child.dataset?.value === String(value));
  return { window, clock, intervals, relay: window.__relay, document, field, slotsHost, token, slot };
}

function centerOf(element) {
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
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

test('the drag tool teaches the element form and types its indices as numbers', () => {  // The relay runs never called browser_drag. Even with the tool listed, its
  // headline said "Drag from start x/y to end x/y" and fromElement/toElement
  // were typed STRING (the schema infers types from a name list), so a model
  // reading the contract had no reason to believe it could drag between
  // elements. Both are contract bugs, not model bugs.
  const { toolDefinitions } = require('../desktop/agent/agentInternals.cjs');
  const { openAiToolSchemas } = require('../desktop/agent/providers/wire.cjs');
  const definitions = toolDefinitions('drag the tokens', 'agi', { workspace: true });
  const drag = definitions.find((tool) => tool.name === 'browser_drag');
  assert.ok(drag, 'browser_drag must be defined');
  const schema = openAiToolSchemas([drag])[0].function;
  assert.match(schema.description, /fromElement\/toElement/, 'the headline names the preferred form');
  assert.match(schema.description, /PREFERRED/, 'and says it is preferred');
  assert.equal(schema.parameters.properties.fromElement.type, 'number', 'a DOM index is a number');
  assert.equal(schema.parameters.properties.toElement.type, 'number', 'a DOM index is a number');

  // The click contract must agree with the element-first executor.
  const click = definitions.find((tool) => tool.name === 'browser_click');
  const clickSchema = openAiToolSchemas([click])[0].function;
  assert.match(clickSchema.description, /index wins/, 'the click description must not claim coordinates win');
  assert.ok(!/authoritative when both/.test(clickSchema.description), 'the stale precedence claim is gone');
});

test('the dragged circle follows the pointer instead of the field origin', () => {
  // The token is positioned INSIDE the field, but pointer coordinates are
  // viewport-relative. Writing them straight into a field-relative box
  // offset the circle by the field's own origin (165px down the page here),
  // so the circle never went where the pointer went.
  const game = bootLayout();
  const token = game.token(1);
  const slot = game.slot(1);
  const grab = centerOf(token);
  const target = centerOf(slot);

  token.dispatch('mousedown', { clientX: grab.x, clientY: grab.y });
  game.document.dispatch('mousemove', { clientX: target.x, clientY: target.y });

  const moved = centerOf(token);
  assert.ok(Math.abs(moved.x - target.x) <= 1 && Math.abs(moved.y - target.y) <= 1,
    `the circle must end up under the pointer (moved to ${moved.x},${moved.y}; pointer at ${target.x},${target.y})`);
});

test('a real pointer drag into the matching slot registers the drop', () => {
  const game = bootLayout();
  const token = game.token(1);
  const slot = game.slot(1);
  const grab = centerOf(token);
  const target = centerOf(slot);

  token.dispatch('mousedown', { clientX: grab.x, clientY: grab.y });
  game.document.dispatch('mousemove', { clientX: target.x, clientY: target.y });
  game.document.dispatch('mouseup', { clientX: target.x, clientY: target.y });

  const snapshot = game.relay.snapshot();
  assert.equal(snapshot.state, 'running', 'the run continues after a correct drop');
  const drop = snapshot.log.find((entry) => entry.kind === 'drop');
  assert.equal(drop.ok, true, 'the drop is accepted');
  assert.equal(game.slot(1).classList.contains('filled'), true, 'the slot is filled');

  // The pair completes when the slot is armed.
  game.slot(1).children.at(-1).dispatch('click', {});
  const armed = game.relay.snapshot();
  assert.equal(armed.pairsDone, 1, 'the pair is done');
  assert.equal(armed.nextValue, 2, 'the relay moves on to the next token');
});

test('a drop where the CIRCLE lands in a slot is accepted even off-centre', () => {
  // The circle is the thing being dropped, so its own center decides where
  // it landed. Judging the raw pointer instead failed a correct drop: grab
  // the circle by its edge, land its CENTER in the slot, and the pointer
  // sits outside the slot - so the pointer-only rule reported "missed the
  // slots" and the run failed although the circle was dropped correctly.
  const game = bootLayout();
  const token = game.token(1);
  const slot = game.slot(1);
  const grab = { x: centerOf(token).x + 30, y: centerOf(token).y };
  // The circle's center ends up 60px right of the slot center - still inside
  // the slot - while the pointer is 90px right of it, outside the slot.
  const target = { x: centerOf(slot).x + 60, y: centerOf(slot).y };

  token.dispatch('mousedown', { clientX: grab.x, clientY: grab.y });
  game.document.dispatch('mousemove', { clientX: grab.x + (target.x - centerOf(token).x), clientY: target.y });
  game.document.dispatch('mouseup', { clientX: grab.x + (target.x - centerOf(token).x), clientY: target.y });

  const slotRect = slot.getBoundingClientRect();
  assert.ok(target.x + 30 > slotRect.right, 'the pointer really is outside the slot');

  const snapshot = game.relay.snapshot();
  const drop = snapshot.log.find((entry) => entry.kind === 'drop');
  assert.equal(drop.ok, true, 'the drop is accepted');
  assert.equal(game.slot(1).classList.contains('filled'), true, 'the slot is filled');

  game.slot(1).children.at(-1).dispatch('click', {});
  const armed = game.relay.snapshot();
  assert.equal(armed.pairsDone, 1, 'the pair is done');
  assert.equal(armed.nextValue, 2, 'the relay moves on to the next token');
});

test('a drop onto the wrong slot still fails', () => {
  const game = bootLayout();
  const token = game.token(1);
  const wrongSlot = game.slot(4);
  const grab = centerOf(token);
  const target = centerOf(wrongSlot);

  token.dispatch('mousedown', { clientX: grab.x, clientY: grab.y });
  game.document.dispatch('mousemove', { clientX: target.x, clientY: target.y });
  game.document.dispatch('mouseup', { clientX: target.x, clientY: target.y });

  const snapshot = game.relay.snapshot();
  assert.equal(snapshot.state, 'fail', 'the wrong slot fails the run');
  assert.match(snapshot.log.at(-1).note, /onto slot 4/);
});

test('a drop that misses every slot returns the circle to its origin', () => {
  const game = bootLayout();
  const token = game.token(1);
  const origin = { x: Number.parseFloat(token.style.left), y: Number.parseFloat(token.style.top) };
  const grab = centerOf(token);

  token.dispatch('mousedown', { clientX: grab.x, clientY: grab.y });
  game.document.dispatch('mousemove', { clientX: 400, clientY: 60 });
  game.document.dispatch('mouseup', { clientX: 400, clientY: 60 });

  assert.equal(Number.parseFloat(token.style.left), origin.x, 'the circle returns to its origin');
  assert.equal(Number.parseFloat(token.style.top), origin.y, 'the circle returns to its origin');
  assert.equal(game.relay.snapshot().state, 'running', 'a miss costs time, not the run');
});
