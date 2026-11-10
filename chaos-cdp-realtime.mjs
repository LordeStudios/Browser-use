import CDP from 'chrome-remote-interface';

const TAB = process.argv[2];
if (!TAB) {
  console.error('Usage: node chaos-cdp-realtime.mjs <tabId>');
  process.exit(1);
}

const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const TICK_MS = 16;
const CURSOR_ID = '__browser_use_agent_cursor__';

const client = await CDP({ target: URL });
let running = true;
let lastPhase = '';
let pointerX = 50, pointerY = 50;
let lastClickTime = 0;

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,0,0,0.7);border:2px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 8px rgba(0,0,0,0.5);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.6)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',120);` : ''}return true;})()`;
}

async function resetPointer(Input) {
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'left', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'right', buttons: 0 });
}

async function movePointer(Input, Runtime, x, y, isClick = false) {
  pointerX = x; pointerY = y;
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, isClick) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
}

async function clickAt(Input, Runtime, x, y) {
  await movePointer(Input, Runtime, x, y, true);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  lastClickTime = performance.now();
}

async function readState(Runtime) {
  const { result: { value } } = await Runtime.evaluate({
    expression: `(function(){const s=window.__chaosState||{};function center(el){const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}function visible(el){return el&&el.style.opacity!=='0'&&el.offsetParent!==null;}let button=null;const startBtn=document.querySelector('#startButton');const restartBtn=document.querySelector('#restartButton');if(startBtn&&!document.querySelector('#startOverlay').classList.contains('hidden'))button=center(startBtn);else if(restartBtn&&!document.querySelector('#gameOverOverlay').classList.contains('hidden'))button=center(restartBtn);let targets=[];let scrollInfo=null;const port=document.querySelector('.scroll-port');if(s.phase==='active'&&s.current){const mode=s.current.mode;let realNodes=[];if(mode==='scroll'&&port){realNodes=Array.from(port.querySelectorAll('.btn[data-real=\"1\"]'));if(realNodes.length){const pr=port.getBoundingClientRect();const out=[];realNodes.forEach(real=>{const r=real.getBoundingClientRect();const inView=r.left>=pr.left-2&&r.right<=pr.right+2&&r.top>=pr.top-2&&r.bottom<=pr.bottom+2;if(inView){targets.push({uid:real.dataset.uid,x:center(real).x,y:center(real).y});}else{out.push({el:real,x:center(real).x,y:center(real).y,left:r.left,right:r.right,top:r.top,bottom:r.bottom});}});if(out.length){const t=out[0];scrollInfo={portCenter:center(port),deltaX:t.left<pr.left?-350:t.right>pr.right?350:0,deltaY:t.top<pr.top?-350:t.bottom>pr.bottom?350:0};}}}else{realNodes=Array.from(document.querySelectorAll('#arena .btn[data-real=\"1\"]')).filter(visible);targets=realNodes.map(el=>({uid:el.dataset.uid,x:center(el).x,y:center(el).y}));}}return{phase:s.phase||'unknown',round:s.round||0,score:s.score||0,button,targets,scrollInfo};})()`,
    returnByValue: true
  });
  return value;
}

async function run() {
  const { Runtime, Input, Emulation, Page } = client;
  await Runtime.enable();
  await Page.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });
  await resetPointer(Input);
  console.log('[CDP] Chaos Tap real-time stream tick =', TICK_MS, 'ms');

  while (running) {
    const t0 = performance.now();
    let state;
    try { state = await readState(Runtime); }
    catch (err) { console.error('[CDP] readState error:', err.message); await new Promise(r => setTimeout(r, TICK_MS)); continue; }

    if (state.phase !== lastPhase) {
      console.log('[CDP] phase:', lastPhase, '->', state.phase, 'round:', state.round, 'score:', state.score);
      lastPhase = state.phase;
    }

    if (state.button) {
      await resetPointer(Input);
      await clickAt(Input, Runtime, state.button.x, state.button.y);
      await new Promise(r => setTimeout(r, 500));
      continue;
    }

    if (state.phase === 'active') {
      if (state.scrollInfo && (!state.targets.length)) {
        await movePointer(Input, Runtime, state.scrollInfo.portCenter.x, state.scrollInfo.portCenter.y);
        await Input.dispatchMouseEvent({
          type: 'mouseWheel', x: state.scrollInfo.portCenter.x, y: state.scrollInfo.portCenter.y,
          deltaX: state.scrollInfo.deltaX, deltaY: state.scrollInfo.deltaY
        });
        await new Promise(r => setTimeout(r, 60));
      } else if (state.targets && state.targets.length) {
        const t = state.targets[0];
        await clickAt(Input, Runtime, t.x, t.y);
        await new Promise(r => setTimeout(r, 80));
      }
    }

    if (state.phase === 'ended' && state.round >= 1 && !state.button) {
      console.log('[CDP] Run ended at round', state.round, 'score', state.score);
      running = false;
      break;
    }

    const elapsed = performance.now() - t0;
    await new Promise(r => setTimeout(r, Math.max(0, TICK_MS - elapsed)));
  }

  const { result: { value: final } } = await Runtime.evaluate({
    expression: `(function(){const s=window.__chaosState;return{phase:s.phase,round:s.round,score:s.score,best:s.best};})()`,
    returnByValue: true
  });
  console.log('\n[CDP] Final:', JSON.stringify(final, null, 2));
}

run()
  .then(() => client.close().then(() => process.exit(0)))
  .catch(err => { console.error('[CDP] Fatal:', err); client.close().then(() => process.exit(1)); });
