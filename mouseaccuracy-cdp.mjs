import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || 'E3213B843B691ADA3F864C3BA62A1CFF';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const TICK_MS = 16;
const CURSOR_ID = '__browser_use_agent_cursor__';
const MIN_CLICK_INTERVAL_MS = 180;
const TARGET_MEMORY_MS = 600;
const NEARBY_PX = 35;

const client = await CDP({ target: URL });
let running = true;
let pointerX = 50, pointerY = 50;
let gameStarted = false;
let lastClickTime = 0;
let lastMoveTime = 0;
let recentlyClicked = new Map(); // key -> timestamp

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:28px;height:28px;border-radius:50%;background:rgba(255,0,0,0.75);border:3px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 12px rgba(255,0,0,0.8);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.5)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',150);` : ''}return true;})()`;
}

function keyFor(x, y) {
  const gx = Math.round(x / NEARBY_PX);
  const gy = Math.round(y / NEARBY_PX);
  return `${gx},${gy}`;
}

function forgetOldClicks(now) {
  for (const [k, t] of recentlyClicked) {
    if (now - t > TARGET_MEMORY_MS) recentlyClicked.delete(k);
  }
}

async function resetPointer(Input) {
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'left', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: pointerX, y: pointerY, button: 'right', buttons: 0 });
}

async function movePointer(Input, Runtime, x, y, isClick = false) {
  pointerX = x; pointerY = y;
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, isClick) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  lastMoveTime = performance.now();
}

async function clickAt(Input, Runtime, x, y) {
  await movePointer(Input, Runtime, x, y, true);
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 50));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  const now = performance.now();
  lastClickTime = now;
  recentlyClicked.set(keyFor(x, y), now);
}

async function readGameState(Runtime) {
  const res = await Runtime.evaluate({
    expression: `(function(){
      function center(el){const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}
      function area(el){const r=el.getBoundingClientRect();return r.width*r.height;}
      function isHit(el){const c=(typeof el.className==='string'?el.className:'');return /hitmark|\\bhit\\b|explosion|ripple|marker/i.test(c);}
      function isCursor(el){return el.id==='__browser_use_agent_cursor__';}

      let start = null;
      const startCandidates = Array.from(document.querySelectorAll('a, button')).filter(el => /start|begin|play/i.test(el.textContent) || /startbutton|start-button|btn-start/i.test(el.className));
      for (const el of startCandidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 20) { start = { x: center(el).x, y: center(el).y }; break; }
      }

      const gameArea = document.querySelector('#game-page, #game-wrapper, .game-wrapper, [class*="game-area" i]');
      const roots = gameArea ? [gameArea] : [document.body];
      let targets = [];
      const seen = new Set();
      for (const root of roots) {
        const els = Array.from(root.querySelectorAll('*')).filter(el => {
          if (isCursor(el) || isHit(el)) return false;
          const r = el.getBoundingClientRect();
          if (r.width < 8 || r.height < 8) return false;
          if (r.width > 130 || r.height > 130) return false;
          if (r.top < 70 || r.left < 10 || r.bottom > window.innerHeight - 10 || r.right > window.innerWidth - 10) return false;
          const style = getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          const isRound = Math.abs(r.width - r.height) < Math.max(r.width, r.height) * 0.55;
          const cls = (typeof el.className === 'string' ? el.className : '').toLowerCase();
          const looksLikeTarget = /target|circle|ball|object|spawn|enemy|dot|orb/i.test(cls);
          return isRound || looksLikeTarget;
        }).slice(0, 30);
        for (const el of els) {
          const r = el.getBoundingClientRect();
          const key = Math.round(r.x/4) + ',' + Math.round(r.y/4) + ',' + Math.round(r.width) + ',' + Math.round(r.height);
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({ tag: el.tagName, class: (typeof el.className === 'string' ? el.className : '').slice(0, 60), x: center(el).x, y: center(el).y, area: area(el) });
        }
      }
      return { title: document.title, url: location.href, hasStart: !!start, start, targetCount: targets.length, targets };
    })()`,
    returnByValue: true
  });
  return res.result?.value;
}

async function run() {
  const { Runtime, Input, Emulation, Page } = client;
  await Runtime.enable();
  await Page.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });
  await resetPointer(Input);
  console.log('[CDP] mouseaccuracy.com smart visible-pointer stream tick =', TICK_MS, 'ms');

  while (running) {
    const t0 = performance.now();
    const now = t0;
    forgetOldClicks(now);

    let state;
    try { state = await readGameState(Runtime); }
    catch (err) { console.error('[CDP] read error:', err.message); await new Promise(r => setTimeout(r, TICK_MS)); continue; }

    if (!state) { await new Promise(r => setTimeout(r, TICK_MS)); continue; }

    if (!gameStarted && state.hasStart) {
      console.log('[CDP] Moving to START and clicking at', state.start);
      await movePointer(Input, Runtime, state.start.x, state.start.y);
      await new Promise(r => setTimeout(r, 400));
      await clickAt(Input, Runtime, state.start.x, state.start.y);
      gameStarted = true;
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }

    if (state.targets && state.targets.length > 0) {
      // Filter out recently clicked locations
      const freshTargets = state.targets.filter(t => !recentlyClicked.has(keyFor(t.x, t.y)));
      const pool = freshTargets.length > 0 ? freshTargets : state.targets;

      // Pick nearest fresh target to current pointer for fast reaction
      pool.sort((a, b) => {
        const da = Math.hypot(a.x - pointerX, a.y - pointerY);
        const db = Math.hypot(b.x - pointerX, b.y - pointerY);
        return da - db;
      });
      const t = pool[0];
      const dist = Math.hypot(t.x - pointerX, t.y - pointerY);

      // Only click if we have actually arrived there and enough time has passed
      const canClick = now - lastClickTime >= MIN_CLICK_INTERVAL_MS && dist < 12;

      if (canClick) {
        console.log('[CDP] click target', t.class, 'at', {x: Math.round(t.x), y: Math.round(t.y)}, 'area', Math.round(t.area));
        await clickAt(Input, Runtime, t.x, t.y);
      } else if (now - lastMoveTime >= 32) {
        // Move toward target visibly; don't spam move either
        await movePointer(Input, Runtime, t.x, t.y);
      }
    }

    const elapsed = performance.now() - t0;
    await new Promise(r => setTimeout(r, Math.max(0, TICK_MS - elapsed)));
  }
}

run()
  .then(() => client.close().then(() => process.exit(0)))
  .catch(err => { console.error('[CDP] Fatal:', err); client.close().then(() => process.exit(1)); });
