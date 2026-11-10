import CDP from 'chrome-remote-interface';

const TAB = process.argv[2];
if (!TAB) {
  console.error('Usage: node vector20-cdp-realtime.mjs <tabId>');
  process.exit(1);
}

const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const TICK_MS = 16;
const CURSOR_ID = '__browser_use_agent_cursor__';

const client = await CDP({ target: URL });
let running = true;
let lastPhase = '';
let lastClickStage = -1;
let clicksThisPhase = 0;
let pointerX = 50;
let pointerY = 50;

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,0,0,0.7);border:2px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 8px rgba(0,0,0,0.5);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.6)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',120);` : ''}return true;})()`;
}

async function resetPointer(Input) {
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'left', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'right', buttons: 0 });
}

async function clickAt(Input, Runtime, x, y) {
  pointerX = x;
  pointerY = y;
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, false) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, true) });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function readState(Runtime) {
  const { result: { value } } = await Runtime.evaluate({
    expression: `(function(){const s=window.__v20State||{};const arena=document.querySelector('#arena');const aRect=arena?arena.getBoundingClientRect():{left:0,top:0};function center(el){const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}let target=null;let button=null;if(s.phase==='target-visible'&&s.current){const cue=document.querySelector('#cueText')?.textContent||'';const targets=Array.from(document.querySelectorAll('#arena .target'));let t=null;const m=cue.match(/the ([a-z]+) ([a-z]+)/i);if(m)t=targets.find(el=>el.dataset.color===m[1]&&el.classList.contains(m[2]));if(!t&&targets.length)t=targets[0];if(t)target=center(t);}if(s.phase==='intro'||s.phase==='final-results'){const intro=document.querySelector('#introView');const results=document.querySelector('#resultsView');if(intro&&!intro.classList.contains('hidden')){const b=document.querySelector('#startButton');if(b)button=center(b);}else if(results&&!results.classList.contains('hidden')){const b=document.querySelector('#restartButton');if(b)button=center(b);}}return{phase:s.phase||'unknown',stage:s.stageIndex??-1,results:s.results?s.results.length:0,target,button,arena:{left:aRect.left,top:aRect.top}};})()`,
    returnByValue: true
  });
  return value;
}

async function run() {
  const { Runtime, Input, Emulation, Page } = client;
  await Runtime.enable();
  await Page.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  console.log('[CDP] Resetting stale pointer state...');
  await resetPointer(Input);

  console.log('[CDP] Real-time stream tick =', TICK_MS, 'ms');
  while (running) {
    const start = performance.now();
    let state;
    try {
      state = await readState(Runtime);
    } catch (err) {
      console.error('[CDP] readState error:', err.message);
      await new Promise(r => setTimeout(r, TICK_MS));
      continue;
    }

    if (state.phase !== lastPhase) {
      console.log('[CDP] phase:', lastPhase, '->', state.phase, 'stage:', state.stage, 'results:', state.results);
      clicksThisPhase = 0;
      if (state.phase === 'target-visible') {
        lastClickStage = state.stage;
      }
      lastPhase = state.phase;
    }

    if ((state.phase === 'intro' || state.phase === 'final-results') && state.button) {
      await resetPointer(Input);
      await clickAt(Input, Runtime, state.button.x, state.button.y);
      await new Promise(r => setTimeout(r, 400));
      continue;
    }

    if (state.phase === 'target-visible' && state.target) {
      await clickAt(Input, Runtime, state.target.x, state.target.y);
      clicksThisPhase += 1;
    }

    if (state.phase === 'final-results' && state.results >= 20) {
      console.log('[CDP] Benchmark complete:', state.results, '/ 20 stages.');
      running = false;
      break;
    }

    const elapsed = performance.now() - start;
    const wait = Math.max(0, TICK_MS - elapsed);
    await new Promise(r => setTimeout(r, wait));
  }

  const { result: { value: final } } = await Runtime.evaluate({
    expression: `(function(){const s=window.__v20State;return{phase:s.phase,results:s.results.length,summary:s.results.map(r=>({stage:r.stage,outcome:r.outcome,speed:r.speed,errors:r.errors,integrity:r.integrity}))};})()`,
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
