import CDP from 'chrome-remote-interface';
import sharp from 'sharp';

const TOP_TAB = 'E3213B843B691ADA3F864C3BA62A1CFF';
const IFRAME_TAB = '787309E6BEC689839ADE3DC724FEBB2F';
const CURSOR_ID = '__browser_use_agent_cursor__';
const TICK_MS = 180;
const MIN_CLUSTER_SIZE = 18;
const DIFF_THRESHOLD = 38;
const CLICK_COOLDOWN_MS = 1100;
const STALL_MS = 4000;

const topClient = await CDP({ target: `ws://127.0.0.1:9222/devtools/page/${TOP_TAB}` });
const iframeClient = await CDP({ target: `ws://127.0.0.1:9222/devtools/page/${IFRAME_TAB}` });
let running = true;
let lastClick = 0;
let lastActivity = performance.now();
let lastScore = 0;
let recentClicks = new Map();
let parkX = 1200, parkY = 800;
let aggressive = false;

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:28px;height:28px;border-radius:50%;background:rgba(255,0,0,0.75);border:3px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 12px rgba(255,0,0,0.8);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.5)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',150);` : ''}return true;})()`;
}

async function resetPointer(Input) {
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: parkX, y: parkY, button: 'left', buttons: 0 });
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x: parkX, y: parkY, button: 'right', buttons: 0 });
}

async function parkCursor(Runtime, Input) {
  const { result: { value: vp } } = await Runtime.evaluate({ expression: `({w:window.innerWidth,h:window.innerHeight})`, returnByValue: true });
  parkX = (vp?.w || 1200) - 50;
  parkY = (vp?.h || 800) - 50;
  await Runtime.evaluate({ expression: buildCursorExpression(parkX, parkY) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: parkX, y: parkY });
}

async function getMetrics() {
  const { Runtime: topR } = topClient;
  const { Runtime: iframeR } = iframeClient;
  const [dprRes, iframeRectRes, canvasRes, modalBtnRes] = await Promise.all([
    topR.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true }),
    topR.evaluate({ expression: `(function(){ const f = document.getElementById('game-iframe'); if(!f) return null; const r = f.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`, returnByValue: true }),
    iframeR.evaluate({ expression: `(function(){ const o = document.getElementById('imageOrigin'); const d = document.getElementById('imageDiff'); if(!o||!d) return null; const ro = o.getBoundingClientRect(); const rd = d.getBoundingClientRect(); return { left:{x:ro.x,y:ro.y,w:ro.width,h:ro.height}, right:{x:rd.x,y:rd.y,w:rd.width,h:rd.height} }; })()`, returnByValue: true }),
    iframeR.evaluate({ expression: `(function(){ const matches = Array.from(document.querySelectorAll('button, a, div, span')).filter(el => { const text = el.textContent.trim(); const cls = typeof el.className==='string'?el.className:''; const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4 && el.offsetWidth > 0 && el.offsetHeight > 0 && (/^(play|continue|go|start)$/i.test(text) || /UIPlayBtn|play-button|start-button|btn-play/i.test(cls)); }); if(!matches.length) return null; const b = matches.reduce((best, el) => { const r = el.getBoundingClientRect(); const a = r.width*r.height; return a > best.area ? {el, area:a} : best; }, {area:0}).el; const r = b.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2, text:b.textContent.trim()}; })()`, returnByValue: true })
  ]);
  return {
    dpr: dprRes.result.value || 1,
    iframe: iframeRectRes.result.value,
    panels: canvasRes.result.value,
    playButton: modalBtnRes.result.value
  };
}

async function captureScreenshot() {
  const { Page } = topClient;
  await Page.enable();
  const { data } = await Page.captureScreenshot({ format: 'png', fromSurface: true });
  return Buffer.from(data, 'base64');
}

function keyFor(cssX, cssY) {
  return `${Math.round(cssX / 55)},${Math.round(cssY / 55)}`;
}

function getScoreFromDOM() {
  const { Runtime } = iframeClient;
  return Runtime.evaluate({ expression: `(function(){ const b = document.body.innerText || ''; const m = b.match(/Player\s*[:\-]?\s*(\d+)/i); return m ? parseInt(m[1],10) : null; })()`, returnByValue: true })
    .then(r => r.result?.value ?? null)
    .catch(() => null);
}

function forgetOld(now) {
  for (const [k, t] of recentClicks) {
    if (now - t > CLICK_COOLDOWN_MS) recentClicks.delete(k);
  }
}

async function findDiffPoint(buffer, metrics, thresholdOverride, minClusterOverride) {
  const threshold = thresholdOverride ?? DIFF_THRESHOLD;
  const minCluster = minClusterOverride ?? MIN_CLUSTER_SIZE;
  const { dpr, iframe, panels } = metrics;
  if (!iframe || !panels || !panels.left || !panels.right) return null;
  const meta = await sharp(buffer).metadata();
  const imgW = meta.width;
  const imgH = meta.height;

  const leftPx = {
    left: Math.max(0, Math.round((iframe.x + panels.left.x) * dpr)),
    top: Math.max(0, Math.round((iframe.y + panels.left.y) * dpr)),
    width: Math.round(panels.left.w * dpr),
    height: Math.round(panels.left.h * dpr)
  };
  const rightPx = {
    left: Math.max(0, Math.round((iframe.x + panels.right.x) * dpr)),
    top: Math.max(0, Math.round((iframe.y + panels.right.y) * dpr)),
    width: Math.round(panels.right.w * dpr),
    height: Math.round(panels.right.h * dpr)
  };

  // Clamp to image bounds
  leftPx.width = Math.min(leftPx.width, imgW - leftPx.left);
  leftPx.height = Math.min(leftPx.height, imgH - leftPx.top);
  rightPx.width = Math.min(rightPx.width, imgW - rightPx.left);
  rightPx.height = Math.min(rightPx.height, imgH - rightPx.top);

  if (leftPx.width < 20 || leftPx.height < 20 || rightPx.width < 20 || rightPx.height < 20) {
    return null;
  }

  const useW = Math.min(leftPx.width, rightPx.width);
  const useH = Math.min(leftPx.height, rightPx.height);

  const [lRaw, rRaw] = await Promise.all([
    sharp(buffer).extract({ left: leftPx.left, top: leftPx.top, width: useW, height: useH }).raw().toBuffer({ resolveWithObject: true }),
    sharp(buffer).extract({ left: rightPx.left, top: rightPx.top, width: useW, height: useH }).raw().toBuffer({ resolveWithObject: true })
  ]);

  const l = lRaw.data;
  const r = rRaw.data;
  const total = useW * useH;
  const visited = new Uint8Array(total);
  const diffs = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const pi = i * 4;
    const d = Math.abs(l[pi] - r[pi]) + Math.abs(l[pi + 1] - r[pi + 1]) + Math.abs(l[pi + 2] - r[pi + 2]);
    diffs[i] = d > threshold ? 1 : 0;
  }

  let bestCluster = null;
  let bestSize = 0;
  for (let y = 0; y < useH; y++) {
    for (let x = 0; x < useW; x++) {
      const idx = y * useW + x;
      if (!diffs[idx] || visited[idx]) continue;
      // BFS
      const stack = [idx];
      let size = 0;
      let sx = 0, sy = 0;
      visited[idx] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % useW;
        const cy = Math.floor(cur / useW);
        size++;
        sx += cx;
        sy += cy;
        const neighbors = [cur - 1, cur + 1, cur - useW, cur + useW];
        for (const n of neighbors) {
          if (n < 0 || n >= total) continue;
          if (visited[n] || !diffs[n]) continue;
          const nx = n % useW;
          const ny = Math.floor(n / useW);
          if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
          visited[n] = 1;
          stack.push(n);
        }
      }
      if (size > bestSize) {
        bestSize = size;
        bestCluster = { x: sx / size, y: sy / size, size };
      }
    }
  }

  if (!bestCluster || bestCluster.size < minCluster) return null;

  // Convert cluster centroid back to CSS coords relative to top-level viewport.
  // The cluster may be in the right panel even though we diffed against left coords,
  // so use whichever panel its center is closest to.
  const clusterRelX = bestCluster.x / dpr;
  const clusterRelY = bestCluster.y / dpr;
  const leftCx = panels.left.w / 2;
  const rightCx = panels.right.x + panels.right.w / 2 - panels.left.x;
  const onRight = Math.abs(clusterRelX - rightCx) < Math.abs(clusterRelX - leftCx);
  const panel = onRight ? panels.right : panels.left;
  const cssX = iframe.x + panel.x + (onRight ? clusterRelX - (panels.right.x - panels.left.x) : clusterRelX);
  const cssY = iframe.y + panel.y + clusterRelY;
  return { x: cssX, y: cssY, size: bestCluster.size, panel: onRight ? 'right' : 'left' };
}

async function clickAt(Input, Runtime, x, y) {
  await Runtime.evaluate({ expression: buildCursorExpression(x, y) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 80));
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, true) });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 40));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function isGameOver() {
  const { Runtime } = iframeClient;
  const res = await Runtime.evaluate({
    expression: `(function(){ const t = document.body.innerText || ''; return /game over|try again|you lost|level complete|out of lives|no lives/i.test(t); })()`,
    returnByValue: true
  });
  return !!res.result?.value;
}

async function run() {
  const { Runtime: topR, Input: topI, Emulation: topE, Page: topP } = topClient;
  const { Runtime: iframeR, Input: iframeI, Emulation: iframeE } = iframeClient;
  await topR.enable();
  await topP.enable();
  await topE.setFocusEmulationEnabled({ enabled: true });
  await iframeR.enable();
  await iframeE.setFocusEmulationEnabled({ enabled: true });
  await resetPointer(iframeI);

  console.log('[CDP] What\'s the Difference — vision-driven controller tick =', TICK_MS, 'ms');

  while (running) {
    const t0 = performance.now();
    const now = t0;
    forgetOld(now);

    // Stall watchdog: if nothing has progressed for a while, reset state and retry hard
    if (now - lastActivity > STALL_MS) {
      console.log('[CDP] STALL detected — resetting pointer, clearing cooldowns, going aggressive');
      await resetPointer(topI);
      recentClicks.clear();
      lastClick = 0;
      aggressive = true;
      lastActivity = now;
    }

    try {
      await parkCursor(topR, topI);
      const metrics = await getMetrics();
      if (!metrics.iframe) {
        await new Promise(r => setTimeout(r, TICK_MS));
        continue;
      }

      // If a PLAY/CONTINUE modal is showing, click it once and wait for gameplay
      if (metrics.playButton) {
        if (now - lastClick >= 600) {
          const bx = metrics.iframe.x + metrics.playButton.x;
          const by = metrics.iframe.y + metrics.playButton.y;
          console.log('[CDP] modal button found:', metrics.playButton.text, 'clicking', { x: Math.round(bx), y: Math.round(by) });
          await clickAt(topI, topR, bx, by);
          lastClick = performance.now();
          lastActivity = performance.now();
        }
        await new Promise(r => setTimeout(r, TICK_MS));
        continue;
      }

      if (!metrics.panels) {
        await new Promise(r => setTimeout(r, TICK_MS));
        continue;
      }

      const buffer = await captureScreenshot();
      const threshold = aggressive ? Math.max(20, DIFF_THRESHOLD - 20) : DIFF_THRESHOLD;
      const minCluster = aggressive ? Math.max(8, MIN_CLUSTER_SIZE - 12) : MIN_CLUSTER_SIZE;
      const diff = await findDiffPoint(buffer, metrics, threshold, minCluster);

      if (diff) {
        const k = keyFor(diff.x, diff.y);
        if (!recentClicks.has(k) && now - lastClick >= 200) {
          console.log('[CDP] diff size', diff.size, 'click at', { x: Math.round(diff.x), y: Math.round(diff.y) }, aggressive ? '(aggressive)' : '');
          await clickAt(topI, topR, diff.x, diff.y);
          lastClick = performance.now();
          lastActivity = performance.now();
          recentClicks.set(k, lastClick);
          aggressive = false;
        } else {
          console.log('[CDP] diff found but cooling down', { x: Math.round(diff.x), y: Math.round(diff.y) });
        }
      }

      if (await isGameOver()) {
        console.log('[CDP] game-over text detected — pausing');
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      console.error('[CDP] loop error:', err.message);
    }

    const elapsed = performance.now() - t0;
    await new Promise(r => setTimeout(r, Math.max(0, TICK_MS - elapsed)));
  }
}

run()
  .then(() => Promise.all([topClient.close(), iframeClient.close()]).then(() => process.exit(0)))
  .catch(err => {
    console.error('[CDP] Fatal:', err);
    Promise.all([topClient.close(), iframeClient.close()]).then(() => process.exit(1));
  });
