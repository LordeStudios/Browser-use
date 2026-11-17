import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The objective questionnaire is the parallel-thinking test surface: 40
// questions drawn fresh from a 200-question pool on every start, each with up
// to 4 objectives, each on its own 30s wall-clock window. The agent must
// derive or research the answer WITHOUT stalling the program: the clock keeps
// running while it thinks, the page does not rebuild itself under it, and a
// window that closes before Next is pressed fails the whole run.
const html = fs.readFileSync(path.join(process.cwd(), 'test-games/objective-questionnaire.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// Deterministic RNG (mulberry32): the shuffle must be genuinely random per
// attempt, but the tests pin its behaviour by seeding it.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeDom() {
  class El {
    constructor(tag = 'div') {
      this.tagName = tag;
      this.children = [];
      this.listeners = {};
      this.dataset = {};
      this.style = {};
      this.attributes = {};
      this.textContent = '';
      this.innerHTML = '';
      this.disabled = false;
      this.hidden = false;
      this.type = '';
      this.className = '';
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
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    set title(v) { this.attributes.title = v; }
    get title() { return this.attributes.title ?? ''; }
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

function boot({ seed = 1234 } = {}) {
  const { document } = makeDom();
  const clock = { t: 0 };
  const intervals = [];
  const performance = { now: () => clock.t };
  const setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; };
  const clearInterval = (id) => { const i = intervals.findIndex((entry, index) => index === id - 1); if (i >= 0) intervals.splice(i, 1); };
  const window = {};
  const location = { search: '' };
  const realRandom = Math.random;
  Math.random = mulberry32(seed);
  try {
    // eslint-disable-next-line no-new-func
    new Function('document', 'performance', 'setInterval', 'clearInterval', 'window', 'location', script)(
      document, performance, setInterval, clearInterval, window, location
    );
  } finally {
    Math.random = realRandom;
  }
  const ticker = () => { for (const entry of [...intervals]) entry.fn(); };
  return { window, clock, intervals, ticker, quiz: window.__quiz, document };
}

// Drives a full run, selecting `pick` (a function over the drawn question) on
// every question. Returns the final snapshot.
function drive(quiz, clock, pick) {
  for (let k = 0; k < 40; k += 1) {
    const snap = quiz.snapshot();
    const item = quiz.pool[snap.run[k]];
    const choice = pick(item, k);
    assert.equal(quiz.select(choice).ok, true, `select on question ${k + 1}`);
    clock.t += 500; // the agent takes 0.5s of thought per question
    if (k < 39) assert.equal(quiz.next().ok, true, `next from question ${k + 1}`);
    else assert.equal(quiz.finish().ok, true, 'finish on the last question');
  }
  return quiz.snapshot();
}

test('the pool is exactly 200 real questions, each with 4 objectives and a balanced key', () => {
  const { quiz } = boot();
  assert.equal(quiz.pool.length, 200, 'the pool holds 200 questions');
  const distribution = [0, 0, 0, 0];
  const texts = new Set();
  for (const item of quiz.pool) {
    assert.equal(typeof item.q, 'string');
    assert.ok(item.q.length > 5, 'every question has a body');
    assert.equal(item.c.length, 4, 'up to 4 objectives: exactly 4 here');
    assert.equal(new Set(item.c).size, 4, 'the objectives are distinct');
    assert.ok(Number.isInteger(item.a) && item.a >= 0 && item.a < 4, 'exactly one correct objective');
    distribution[item.a] += 1;
    texts.add(item.q);
  }
  assert.equal(texts.size, 200, 'no duplicate questions');
  for (const count of distribution) {
    assert.ok(count >= 30 && count <= 70, `the answer key is balanced across objectives (got ${JSON.stringify(distribution)})`);
  }
});

test('start draws 40 shuffled questions and arms the first 30s window', () => {
  const { quiz, clock } = boot();
  assert.equal(quiz.snapshot().state, 'ready');
  const outcome = quiz.start();
  assert.equal(outcome.ok, true);
  const snap = quiz.snapshot();
  assert.equal(snap.state, 'running');
  assert.equal(snap.run.length, 40);
  assert.equal(new Set(snap.run).size, 40, 'no question repeats within a run');
  for (const index of snap.run) {
    assert.ok(Number.isInteger(index) && index >= 0 && index < quiz.pool.length, 'every drawn question comes from the pool');
  }
  assert.equal(snap.cursor, 0);
  assert.equal(snap.remainingMs, 30000, 'question 1 owns a full 30s window the moment it is displayed');
  assert.equal(clock.t, 0);
});

test('each attempt draws a DIFFERENT shuffled questionnaire', () => {
  const { quiz } = boot();
  quiz.start();
  const first = [...quiz.snapshot().run];
  quiz.reset();
  quiz.start();
  const second = [...quiz.snapshot().run];
  assert.deepEqual(new Set(first).size, 40);
  assert.deepEqual(new Set(second).size, 40);
  assert.notDeepEqual(first, second, 'a retry must not serve the same questionnaire in the same order');
});

test('select records the choice, and a later choice replaces it', () => {
  const { quiz } = boot();
  quiz.start();
  assert.equal(quiz.select(0).ok, true);
  assert.equal(quiz.snapshot().answers[0], 0);
  assert.equal(quiz.select(2).ok, true, 'changing your mind is allowed before Next');
  assert.equal(quiz.snapshot().answers[0], 2);
  assert.equal(quiz.select(4).ok, false, 'there is no objective 5');
  assert.equal(quiz.select(-1).ok, false);
});

test('Next is refused until an objective is selected, then advances and re-arms 30s', () => {
  const { quiz, clock } = boot();
  quiz.start();
  const refused = quiz.next();
  assert.equal(refused.ok, false, 'Next without a selection is refused');
  assert.equal(refused.reason, 'nothing selected');
  assert.equal(quiz.snapshot().cursor, 0, 'no movement happened');
  assert.equal(quiz.select(1).ok, true);
  clock.t += 1_000; // one second of thought
  const moved = quiz.next();
  assert.equal(moved.ok, true);
  const snap = quiz.snapshot();
  assert.equal(snap.cursor, 1);
  assert.equal(snap.remainingMs, 30000, 'the new question owns a fresh 30s window (it re-arms on every navigation)');
});

test('Previous moves back and re-arms 30s; it is a no-op on the first question', () => {
  const { quiz, clock } = boot();
  quiz.start();
  assert.equal(quiz.previous().ok, false, 'there is nothing before question 1');
  assert.equal(quiz.snapshot().cursor, 0);
  quiz.select(0); clock.t += 100; quiz.next();
  clock.t += 20_000; // a long think on question 2
  const back = quiz.previous();
  assert.equal(back.ok, true);
  assert.equal(quiz.snapshot().cursor, 0);
  assert.equal(quiz.snapshot().remainingMs, 30000, 'returning to a question opens a fresh 30s window');
});

test('Finish works only on the last question; a perfect run scores 40 / 40', () => {
  const { quiz, clock } = boot();
  quiz.start();
  assert.equal(quiz.finish().ok, false, 'Finish is refused on question 1');
  quiz.select(0); quiz.next();
  assert.equal(quiz.finish().ok, false, 'Finish is refused on question 2');
  quiz.reset(); quiz.start();
  const snap = drive(quiz, clock, (item) => item.a);
  assert.equal(snap.state, 'pass');
  assert.equal(snap.correct, 40, 'every correct objective counts');
});

test('a run with wrong answers finishes but scores honestly', () => {
  const { quiz, clock } = boot();
  quiz.start();
  const snap = drive(quiz, clock, () => 0); // always objective 1
  assert.equal(snap.state, 'pass', 'protocol completion is what passes');
  const expected = quiz.snapshot().run.reduce((sum, index) => sum + (quiz.pool[index].a === 0 ? 1 : 0), 0);
  assert.equal(snap.correct, expected, 'the score counts exactly the correct selections');
  assert.ok(snap.correct < 40, 'always picking objective 1 must NOT score 40 — the key is balanced');
});

test('an exhausted 30s window FAILS the run, and retry reshuffles from scratch', () => {
  const { quiz, clock, ticker } = boot();
  quiz.start();
  assert.equal(quiz.select(0).ok, true);
  clock.t += 30_001; // the window closed with Next still unpressed
  ticker();
  const snap = quiz.snapshot();
  assert.equal(snap.state, 'fail');
  assert.match(snap.result.reason, /30s window for question 1 closed/);
  // Retry uses freshly shuffled questions: a new draw, a fresh 30s window.
  const failedRun = [...snap.run];
  const retried = quiz.retry();
  assert.equal(retried.ok, true);
  const after = quiz.snapshot();
  assert.equal(after.state, 'running');
  assert.equal(after.cursor, 0);
  assert.equal(after.remainingMs, 30000);
  assert.notDeepEqual(after.run, failedRun, 'the retry reshuffles the pool');
  assert.equal(new Set(after.run).size, 40);
});

test('expiry is decided from WALL-CLOCK time, not from ticks: a backgrounded tab cannot extend a window', () => {
  const { quiz, clock } = boot();
  quiz.start();
  clock.t += 30_500; // the agent went away; NO ticker ran while it was gone
  const interacted = quiz.select(0);
  assert.equal(interacted.ok, false, 'the interaction lands in a failed run');
  assert.equal(quiz.snapshot().state, 'fail');
  assert.match(quiz.snapshot().result.reason, /30s window/);
});

test('the ticker is the only thing that changes while a question is open — the page does not rebuild itself under the agent', () => {
  const boot1 = boot();
  boot1.quiz.start();
  const options = boot1.document.getElementById('options');
  const textBefore = boot1.document.getElementById('qtext').textContent;
  const before = [...options.children];
  assert.equal(before.length, 4);
  boot1.clock.t += 7_000;
  boot1.ticker();
  boot1.clock.t += 7_000;
  boot1.ticker();
  const after = [...boot1.document.getElementById('options').children];
  assert.deepEqual(before, after, 'the objective buttons are the SAME objects across ticks');
  assert.equal(boot1.document.getElementById('qtext').textContent, textBefore, 'the question text does not churn');
});

test('the longest pause between actions is reported, without failing the run for thinking', () => {
  const { quiz, clock } = boot();
  quiz.start();
  quiz.select(0);
  clock.t += 22_000; // the agent went off to research in parallel
  quiz.next();
  assert.equal(quiz.snapshot().maxGapMs, 22_000, 'the pause is visible as evidence');
  assert.equal(quiz.snapshot().state, 'running', 'thinking is not a fail — only the 30s window is');
});

test('Next is refused on the last question, which is where Finish lives', () => {
  const { quiz, clock } = boot();
  quiz.start();
  // Drive to question 40 WITHOUT finishing: select + next through 39 moves.
  for (let k = 0; k < 39; k += 1) {
    const item = quiz.pool[quiz.snapshot().run[k]];
    assert.equal(quiz.select(item.a).ok, true);
    clock.t += 500;
    assert.equal(quiz.next().ok, true);
  }
  assert.equal(quiz.snapshot().cursor, 39);
  // The last question still needs its own objective selected.
  const finalItem = quiz.pool[quiz.snapshot().run[39]];
  assert.equal(quiz.select(finalItem.a).ok, true);
  const last = quiz.next();
  assert.equal(last.ok, false, 'Next past the last question is refused');
  assert.equal(last.reason, 'last question');
  // And it is Finish — not Next — that completes the run from here.
  assert.equal(quiz.finish().ok, true);
});

test('reset returns to READY and clears everything', () => {
  const { quiz } = boot();
  quiz.start(); quiz.select(0); quiz.next();
  quiz.reset();
  const snap = quiz.snapshot();
  assert.equal(snap.state, 'ready');
  assert.equal(snap.run.length, 0);
  assert.equal(snap.cursor, 0);
  assert.equal(snap.answers.length, 0);
  assert.equal(snap.remainingMs, null);
});

test('a run is driveable through the DOM buttons as well as the test surface', () => {
  const { quiz, document, clock } = boot();
  quiz.start();
  const click = (id) => {
    const button = document.getElementById(id);
    for (const fn of button.listeners.click || []) fn();
  };
  // Select objective 1 by clicking its button, then Next via the nav button.
  click('options') || (function () {
    const first = document.getElementById('options').children[0];
    for (const fn of first.listeners.click || []) fn();
  }());
  clock.t += 100;
  click('next');
  assert.equal(quiz.snapshot().cursor, 1);
});
