import CDP from 'chrome-remote-interface';

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const client = await CDP({ target: 'ws://127.0.0.1:9222/devtools/page/E3213B843B691ADA3F864C3BA62A1CFF' });
  const { Runtime, Input, Emulation } = client;
  await Runtime.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  async function state() {
    const { result: { value } } = await Runtime.evaluate({
      expression: `({ phase: window.__v20State?.phase, stageIndex: window.__v20State?.stageIndex, cue: document.getElementById('cueText')?.textContent, viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio } })`,
      returnByValue: true
    });
    return value;
  }

  // Restart if needed
  let s = await state();
  console.log('Initial state:', s);
  if (s.phase !== 'target-visible') {
    await Runtime.evaluate({ expression: `document.getElementById('restartButton')?.click() || document.getElementById('startButton')?.click()` });
    while (s.phase !== 'target-visible') {
      await sleep(200);
      s = await state();
    }
  }

  const { result: { value: probe } } = await Runtime.evaluate({
    expression: `(() => {
      const t = document.querySelector('.arena .target');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const cx = Math.round(r.left + r.width / 2);
      const cy = Math.round(r.top + r.height / 2);
      const arena = document.getElementById('arena').getBoundingClientRect();
      const cursor = document.getElementById('__browser_use_agent_cursor__');
      const points = [];
      for (const [px, py] of [[cx, cy], [cx-5, cy], [cx+5, cy], [cx, cy-5], [cx, cy+5], [Math.round(arena.left + arena.width/2), Math.round(arena.top + arena.height/2)]]) {
        const el = document.elementFromPoint(px, py);
        points.push({ px, py, tag: el?.tagName, class: el?.className?.slice(0,80), id: el?.id, dataset: el?.dataset });
      }
      return { targetRect: { x: r.left, y: r.top, w: r.width, h: r.height, cx, cy }, arenaRect: { x: arena.left, y: arena.top, w: arena.width, h: arena.height }, cursorRect: cursor?.getBoundingClientRect(), points };
    })()`,
    returnByValue: true
  });

  console.log('Probe:', JSON.stringify(probe, null, 2));

  // Try clicking the target element directly via DOM dispatch (bypasses coordinate issues)
  const { result: { value: clicked } } = await Runtime.evaluate({
    expression: `(() => { const t = document.querySelector('.arena .target'); if (t) { t.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 0, clientY: 0, pointerType: 'mouse' })); return true; } return false; })()`,
    returnByValue: true
  });

  await sleep(500);
  s = await state();
  console.log('After pointerdown dispatch:', s, 'dispatched:', clicked);

  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
