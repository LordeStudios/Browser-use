import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || '787309E6BEC689839ADE3DC724FEBB2F';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;
const CURSOR_ID = '__browser_use_agent_cursor__';

function buildCursorExpression(x, y, isClick) {
  return `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:28px;height:28px;border-radius:50%;background:rgba(255,0,0,0.75);border:3px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 12px rgba(255,0,0,0.8);';document.body.appendChild(c);}c.style.left=${x}+'px';c.style.top=${y}+'px';c.style.display='block';c.style.opacity='1';${isClick ? `c.style.transform='translate(-50%,-50%) scale(0.5)';setTimeout(()=>c.style.transform='translate(-50%,-50%) scale(1)',150);` : ''}return true;})()`;
}

const x = Number(process.argv[3]);
const y = Number(process.argv[4]);
if (!x || !y) {
  console.error('Usage: node click-visible-spot.mjs <tabId> <x> <y>');
  process.exit(1);
}

const client = await CDP({ target: URL });
try {
  const { Runtime, Input, Emulation } = client;
  await Runtime.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });
  console.log('visible click at', x, y);
  await Runtime.evaluate({ expression: buildCursorExpression(x, y) });
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 250));
  await Runtime.evaluate({ expression: buildCursorExpression(x, y, true) });
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 40));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  console.log('clicked once');
} finally {
  await client.close();
}
