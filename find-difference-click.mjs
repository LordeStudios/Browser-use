import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || '787309E6BEC689839ADE3DC724FEBB2F';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const CURSOR_ID = '__browser_use_agent_cursor__';

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:28px;height:28px;border-radius:50%;background:rgba(255,0,0,0.75);border:3px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 12px rgba(255,0,0,0.8);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.5)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',150);` : ''}return true;})()`;
}

const client = await CDP({ target: URL });
try {
  const { Runtime, Input, Emulation } = client;
  await Runtime.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  const res = await Runtime.evaluate({
    expression: `(function(){
      const c = document.getElementById('imageOrigin');
      if (!c) return { error: 'no origin canvas' };
      const r = c.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) return { error: 'canvas too small', r: {x:r.x,y:r.y,w:r.width,h:r.height} };
      const pts = [];
      for (let gy = 0.25; gy <= 0.75; gy += 0.12) {
        for (let gx = 0.25; gx <= 0.75; gx += 0.12) {
          pts.push({ x: r.left + gx * r.width, y: r.top + gy * r.height });
        }
      }
      const scored = pts.map(p => {
        const el = document.elementFromPoint(p.x, p.y);
        if (!el || el.id === '${CURSOR_ID}') return { ...p, score: -1 };
        const rr = el.getBoundingClientRect();
        const small = rr.width < 80 && rr.height < 80;
        const nearCenter = Math.abs(p.x - (r.left + r.width/2)) < 80;
        // Prefer points where elementFromPoint returns a small element (likely a difference marker/overlay)
        return { ...p, score: small ? (80 - Math.min(rr.width, rr.height)) : 0, tag: el.tagName, cls: (typeof el.className === 'string' ? el.className : '').slice(0,40) };
      }).filter(p => p.score > 0).sort((a, b) => b.score - a.score);

      if (scored.length === 0) return { error: 'no hotspots', r: {x:r.x,y:r.y,w:r.width,h:r.height} };
      return { chosen: scored[0], top5: scored.slice(0,5), r: {x:r.x,y:r.y,w:r.width,h:r.height} };
    })()`,
    returnByValue: true
  });

  const data = res.result?.value;
  console.log('scan:', JSON.stringify(data, null, 2));
  if (!data || data.error || !data.chosen) {
    console.log('cannot find a hotspot');
    process.exit(0);
  }

  const { x, y } = data.chosen;
  console.log('clicking hotspot at', Math.round(x), Math.round(y));

  await Runtime.evaluate({ expression: buildCursorExpression(x, y) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 250));
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, true) });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 40));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  console.log('done: one deliberate visible click');
} finally {
  await client.close();
}
