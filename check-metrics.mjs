import CDP from 'chrome-remote-interface';

const TOP_TAB = 'E3213B843B691ADA3F864C3BA62A1CFF';
const IFRAME_TAB = '787309E6BEC689839ADE3DC724FEBB2F';

const topClient = await CDP({ target: `ws://127.0.0.1:9222/devtools/page/${TOP_TAB}` });
const iframeClient = await CDP({ target: `ws://127.0.0.1:9222/devtools/page/${IFRAME_TAB}` });
try {
  const { Runtime: topR } = topClient;
  const { Runtime: iframeR } = iframeClient;
  await Promise.all([topR.enable(), iframeR.enable()]);
  const [dprRes, iframeRectRes, canvasRes, modalRes] = await Promise.all([
    topR.evaluate({ expression: 'window.devicePixelRatio', returnByValue: true }),
    topR.evaluate({ expression: `(function(){ const f = document.getElementById('game-iframe'); if(!f) return null; const r = f.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; })()`, returnByValue: true }),
    iframeR.evaluate({ expression: `(function(){ const o = document.getElementById('imageOrigin'); const d = document.getElementById('imageDiff'); const m = document.querySelector('button, .play-button, [class*="play" i], [class*="start" i]'); return { origin: o ? (r=> ({x:r.x,y:r.y,w:r.width,h:r.height}))(o.getBoundingClientRect()) : null, diff: d ? (r=> ({x:r.x,y:r.y,w:r.width,h:r.height}))(d.getBoundingClientRect()) : null, modalText: document.body.innerText.slice(0,120) }; })()`, returnByValue: true }),
    iframeR.evaluate({ expression: `(function(){ const b = Array.from(document.querySelectorAll('button, a, div')).find(el => /^(play|start|continue|go)$/i.test(el.textContent.trim())); return b ? {text:b.textContent.trim(), class:(typeof b.className==='string'?b.className:'').slice(0,60)} : null; })()`, returnByValue: true })
  ]);
  console.log(JSON.stringify({ dpr: dprRes.result.value, iframe: iframeRectRes.result.value, canvases: canvasRes.result.value, modalButton: modalRes.result.value }, null, 2));
} finally {
  await topClient.close();
  await iframeClient.close();
}
