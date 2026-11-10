(function() {
  'use strict';
  if (window.__v20Controller) return 'already-running';
  window.__v20Controller = true;

  const CURSOR_ID = '__browser_use_agent_cursor__';
  const ARENA_SELECTOR = '#arena';
  const CUE_SELECTOR = '#cueText';
  const STATUS_KEY = '__v20ControllerStatus';
  const LAST_CURSOR_KEY = '__v20LastCursor';

  function moveCursor(x, y, isClick) {
    let c = document.getElementById(CURSOR_ID);
    if (!c) {
      c = document.createElement('div');
      c.id = CURSOR_ID;
      c.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,0,0,0.7);border:2px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 8px rgba(0,0,0,0.5);';
      document.body.appendChild(c);
    }
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    c.style.display = 'block';
    c.style.opacity = '1';
    if (isClick) {
      c.style.transform = 'translate(-50%,-50%) scale(0.6)';
      setTimeout(() => { c.style.transform = 'translate(-50%,-50%) scale(1)'; }, 120);
    }
    window[LAST_CURSOR_KEY] = { x, y, time: performance.now() };
    return true;
  }

  function getCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  function dispatchPointerDown(el, x, y) {
    const event = new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y
    });
    el.dispatchEvent(event);
  }

  function findTarget() {
    const cue = document.querySelector(CUE_SELECTOR)?.textContent || '';
    const targets = Array.from(document.querySelectorAll(`${ARENA_SELECTOR} .target`));
    if (!targets.length) return null;
    const match = cue.match(/the ([a-z]+) ([a-z]+)/i);
    if (match) {
      const [, color, shape] = match;
      const exact = targets.find(el => el.dataset.color === color && el.classList.contains(shape));
      if (exact) return exact;
    }
    return targets[0];
  }

  function findStartOrRestartButton() {
    const intro = document.querySelector('#introView');
    const results = document.querySelector('#resultsView');
    if (intro && !intro.classList.contains('hidden')) {
      return document.querySelector('#startButton');
    }
    if (results && !results.classList.contains('hidden')) {
      return document.querySelector('#restartButton');
    }
    return null;
  }

  let lastResolvedStage = -1;

  function tick() {
    const state = window.__v20State;
    if (!state) {
      window[STATUS_KEY] = { phase: 'no-state' };
      requestAnimationFrame(tick);
      return;
    }

    const phase = state.phase;
    let targetEl = null;
    let cursorPos = window[LAST_CURSOR_KEY] || { x: 50, y: 50 };
    let clicked = false;

    if (phase === 'intro' || phase === 'final-results') {
      const btn = findStartOrRestartButton();
      if (btn) {
        const c = getCenter(btn);
        moveCursor(c.x, c.y, true);
        btn.click();
        cursorPos = c;
        clicked = true;
      }
    } else if (phase === 'target-visible' && state.current) {
      targetEl = findTarget();
      if (targetEl) {
        const c = getCenter(targetEl);
        moveCursor(c.x, c.y, true);
        dispatchPointerDown(targetEl, c.x, c.y);
        cursorPos = c;
        clicked = true;
        if (state.current && state.stageIndex > lastResolvedStage) {
          lastResolvedStage = state.stageIndex;
        }
      }
    }

    window[STATUS_KEY] = {
      phase,
      stage: state.stageIndex,
      results: state.results.length,
      cursor: cursorPos,
      clicked,
      targetFound: !!targetEl,
      time: performance.now()
    };

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
  return 'injected';
})();
