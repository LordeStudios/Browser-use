import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || 'E3213B843B691ADA3F864C3BA62A1CFF';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;

const client = await CDP({ target: URL });
try {
  const { Runtime } = client;
  await Runtime.enable();
  const res = await Runtime.evaluate({
    expression: `(function(){
      function rect(el) { const r = el.getBoundingClientRect(); return {x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}; }
      const btns = Array.from(document.querySelectorAll('button, a, [role=button], input[type=submit]')).map(b => ({
        tag: b.tagName, text: b.textContent.trim().slice(0,40), id: b.id, class: (typeof b.className === 'string' ? b.className : '').slice(0,60), rect: rect(b)
      }));
      const targets = Array.from(document.querySelectorAll('[class*="target" i], [class*="game" i], [class*="circle" i], [class*="ball" i], [class*="object" i], canvas, svg')).slice(0,15).map(t => ({
        tag: t.tagName, class: (typeof t.className === 'string' ? t.className : '').slice(0,60), id: t.id, rect: rect(t)
      }));
      return { title: document.title, url: location.href, buttons: btns.slice(0,25), candidates: targets };
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(res, null, 2));
} finally {
  await client.close();
}
