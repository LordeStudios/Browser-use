'use strict';

// FLOATING WORKING BUBBLE — bottom-right, always on top, low opacity until the
// pointer is over it. It shows the agent's latest message on hover and restores
// the app on click. The window itself stays transparent and click-through
// except while the pointer is inside the bubble, so it never blocks the desktop.

(function () {
  const bubble = document.getElementById('bubble');
  const title = document.getElementById('bubble-title');
  const text = document.getElementById('bubble-text');
  const canvas = document.getElementById('bubble-canvas');
  const bridge = window.workingBubble;

  const orb = window.AgentOrb ? window.AgentOrb.create(canvas, { size: 62, mode: 'thinking' }) : null;
  let mode = 'thinking';
  let hovering = false;

  const TITLES = {
    thinking: 'Working',
    deep: 'Thinking deeply',
    planning: 'Planning',
    acting: 'Working',
    waiting: 'Needs you',
    error: 'Error',
    done: 'Finished'
  };

  function render(state) {
    if (!state) return;
    if (state.mode && state.mode !== mode) {
      mode = state.mode;
      bubble.dataset.mode = mode;
      if (orb) orb.setMode(mode);
    }
    title.textContent = String(state.title || TITLES[mode] || 'Working');
    const line = String(state.text || '').replace(/\s+/g, ' ').trim();
    text.textContent = line || 'Working — hover for the latest update.';
  }

  // Hover drives both the visual expansion and the click-through toggle. The
  // window receives mousemove even while click-through (`forward: true`), which
  // is what makes it possible to notice the pointer before it can click.
  function setHover(inside) {
    if (inside === hovering) return;
    hovering = inside;
    bubble.classList.toggle('is-open', inside);
    bridge?.hover(inside);
  }

  bubble.addEventListener('mouseenter', () => setHover(true));
  bubble.addEventListener('mouseleave', () => setHover(false));
  bubble.addEventListener('click', () => bridge?.activate());
  bubble.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); bridge?.activate(); }
  });

  bridge?.onState((state) => {
    render(state);
    if (state && state.visible === false) setHover(false);
  });

  if (orb) orb.setMode('thinking');
})();
