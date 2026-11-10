import CDP from 'chrome-remote-interface';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildCursorExpression } = require('./src/browser/cursorOverlay.cjs');

const WS_URL = 'ws://127.0.0.1:9222/devtools/page/E3213B843B691ADA3F864C3BA62A1CFF';
const POLL_MS = 16;

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const client = await CDP({ target: WS_URL });
  const { Runtime, Input, Emulation } = client;
  await Runtime.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  async function click(x, y) {
    await Runtime.evaluate({ expression: buildCursorExpression(x, y, true), returnByValue: false });
    await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
    await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    await Runtime.evaluate({ expression: buildCursorExpression(x, y), returnByValue: false });
  }

  async function findTarget() {
    const { result: { value } } = await Runtime.evaluate({
      expression: `(() => {
        const cue = document.getElementById('cueText')?.textContent || '';
        const match = cue.match(/Activate the ([a-z]+) ([a-z]+)/i);
        const targets = Array.from(document.querySelectorAll('.arena .target')).map((el) => {
          const r = el.getBoundingClientRect();
          return { color: el.dataset.color, shape: [...el.classList].filter((c) => ['circle','square','diamond','ring'].includes(c))[0] || 'target', x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), moving: !!el.closest('.arena[data-state="active"]') };
        });
        if (!match) return { cue, target: targets[0] || null, all: targets };
        const [_, color, shape] = match;
        return { cue, target: targets.find((t) => t.color === color && t.shape === shape) || null, all: targets };
      })()`,
      returnByValue: true
    });
    return value;
  }

  async function getPhase() {
    const { result: { value } } = await Runtime.evaluate({
      expression: `window.__v20State ? { phase: window.__v20State.phase, stageIndex: window.__v20State.stageIndex, results: window.__v20State.results.length } : null`,
      returnByValue: true
    });
    return value;
  }

  // Start the benchmark if not running.
  let phase = await getPhase();
  if (!phase || phase.phase === 'intro') {
    const start = await Runtime.evaluate({
      expression: `(() => { const b = document.getElementById('startButton'); if (b) { b.click(); return true; } return false; })()`,
      returnByValue: true
    });
    console.log('start clicked:', start.result.value);
    await sleep(1300);
  }

  console.log('Running 20-stage benchmark in real-time...');
  let lastTarget = null;

  while (true) {
    const state = await getPhase();
    if (!state) { await sleep(POLL_MS); continue; }
    if (state.phase === 'final-results') break;
    if (state.phase !== 'target-visible') { await sleep(POLL_MS); continue; }

    const { target, cue } = await findTarget();
    if (!target) { await sleep(POLL_MS); continue; }

    // Re-click if target moved or we haven't clicked yet this stage.
    if (!lastTarget || lastTarget.x !== target.x || lastTarget.y !== target.y || cue !== lastTarget.cue) {
      await click(target.x, target.y);
      lastTarget = { ...target, cue };
      await sleep(80); // brief pause before re-tracking moving targets
    }

    await sleep(POLL_MS);
  }

  const report = await Runtime.evaluate({
    expression: `(() => {
      const s = window.__v20State;
      const correct = s.results.filter((r) => r.outcome === 'correct').length;
      return { stages: s.results.length, correct, totalErrors: s.results.reduce((a, r) => a + r.errors, 0), results: s.results };
    })()`,
    returnByValue: true
  });

  console.log('Benchmark complete:');
  console.log(JSON.stringify(report.result.value, null, 2));

  await client.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
