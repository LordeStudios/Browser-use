import CDP from 'chrome-remote-interface';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TAB = process.argv[2];
if (!TAB) {
  console.error('Usage: node vector20-inpage-controller.mjs <tabId>');
  process.exit(1);
}

const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const POLL_MS = 16;

const controllerScript = readFileSync(resolve(__dirname, 'vector20-controller.injected.js'), 'utf8');

const client = await CDP({ target: URL });
let running = true;

async function resetPointer(Input) {
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: 0, y: 0, button: 'left', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: 0, y: 0, button: 'right', buttons: 0 });
}

async function injectController(Runtime) {
  const { result } = await Runtime.evaluate({ expression: controllerScript });
  return result;
}

async function pollStatus(Runtime) {
  const { result: { value } } = await Runtime.evaluate({
    expression: 'window.__v20ControllerStatus || {}',
    returnByValue: true
  });
  return value;
}

async function moveSystemPointer(Input, x, y) {
  if (x == null || y == null) return;
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
}

async function run() {
  const { Runtime, Input, Emulation, Page } = client;
  await Runtime.enable();
  await Page.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  console.log('[CDP] Resetting stale pointer state...');
  await resetPointer(Input);

  console.log('[CDP] Injecting in-page real-time controller...');
  await injectController(Runtime);

  console.log('[CDP] Streaming system-pointer follow at', POLL_MS, 'ms...');
  while (running) {
    try {
      const status = await pollStatus(Runtime);
      if (status && status.cursor) {
        await moveSystemPointer(Input, status.cursor.x, status.cursor.y);
      }
      if (status && status.phase === 'final-results' && status.results >= 20) {
        console.log('[CDP] Benchmark complete. Stopping stream.');
        running = false;
        break;
      }
    } catch (err) {
      console.error('[CDP] poll/move error:', err.message);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  const { result: { value: final } } = await Runtime.evaluate({
    expression: `(function() { const s = window.__v20State; return { phase: s.phase, results: s.results.length, summary: s.results.map(r => ({ stage: r.stage, outcome: r.outcome, speed: r.speed, errors: r.errors, integrity: r.integrity })) }; })()`,
    returnByValue: true
  });
  console.log('\n[CDP] Final state:');
  console.log(JSON.stringify(final, null, 2));
}

run()
  .then(() => client.close().then(() => process.exit(0)))
  .catch(err => {
    console.error('[CDP] Fatal:', err);
    client.close().then(() => process.exit(1));
  });
