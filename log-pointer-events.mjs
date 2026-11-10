import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || 'E3213B843B691ADA3F864C3BA62A1CFF';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;

const CURSOR_ID = '__browser_use_agent_cursor__';
const x = 300;
const y = 348;

const client = await CDP({ target: URL });
try {
  const { Runtime, Input, Emulation } = client;
  await Runtime.enable();
  await Emulation.setFocusEmulationEnabled({ enabled: true });

  await Runtime.evaluate({
    expression: `(function(){let c=document.getElementById('${CURSOR_ID}');if(!c){c=document.createElement('div');c.id='${CURSOR_ID}';c.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;width:20px;height:20px;border-radius:50%;background:rgba(255,0,0,0.7);border:2px solid white;transform:translate(-50%,-50%);transition:none;box-shadow:0 0 8px rgba(0,0,0,0.5);';document.body.appendChild(c);}c.style.left='${x}px';c.style.top='${y}px';c.style.display='block';c.style.opacity='1';})()`
  });

  await Runtime.evaluate({
    expression: `window.__v20PointerLog = []; ['pointermove','pointerdown','pointerup','mousedown','mouseup','click'].forEach(t=>{window.addEventListener(t,e=>{window.__v20PointerLog.push({type:t,clientX:e.clientX,clientY:e.clientY,target:e.target?.className||e.target?.tagName,time:performance.now(),isTrusted:e.isTrusted,buttons:e.buttons});},true);});`
  });

  await new Promise(r => setTimeout(r, 50));
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x: 50, y: 50, button: 'none', buttons: 0 });
  await new Promise(r => setTimeout(r, 50));
  await Input.dispatchMouseEvent({ type: 'mouseMoved', x, y });
  await new Promise(r => setTimeout(r, 100));
  await Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await new Promise(r => setTimeout(r, 100));
  await Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await new Promise(r => setTimeout(r, 500));

  const { result: { value } } = await Runtime.evaluate({
    expression: `(function() { const s = window.__v20State; return { phase: s.phase, results: s.results.length, last: s.results[s.results.length-1], log: window.__v20PointerLog }; })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(value, null, 2));
} finally {
  await client.close();
}
