import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || 'E3213B843B691ADA3F864C3BA62A1CFF';
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

  // Find the start button live
  const { result: { value } } = await Runtime.evaluate({
    expression: `(function(){
      function center(el){const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2};}
      let start = null;
      const candidates = Array.from(document.querySelectorAll('a, button')).filter(el => /start|begin|play/i.test(el.textContent) || /startbutton|start-button|btn-start/i.test(el.className));
      for (const el of candidates) {
        const r = el.getBoundingClientRect();
        if (r.width > 30 && r.height > 20) { start = center(el); break; }
      }
      return { found: !!start, start, url: location.href, title: document.title };
    })()`,
    returnByValue: true
  });

  if (!value.found) {
    console.log('No START button found. Current page:', value.url);
    process.exit(0);
  }

  const { x, y } = value.start;
  console.log('Clicking START at', { x, y });

  await Runtime.evaluate({ expression: buildCursorExpression(x, y) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 300));
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 60));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  console.log('START clicked.');
} finally {
  await client.close();
}
