import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || '7BB194FDC763A8695B9BEF0E011AC698';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;

const client = await CDP({ target: URL });
try {
  const { Runtime } = client;
  await Runtime.enable();
  const { result: { value } } = await Runtime.evaluate({
    expression: `(function(){
      function center(el){const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};}
      const playWords = /play|start|begin|launch|go|play now|start game|click to play|continue/i;
      const buttons = Array.from(document.querySelectorAll('button, a, div, span, canvas, svg')).filter(el => {
        const t = el.textContent.trim();
        const c = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        return playWords.test(t) || playWords.test(c) || /play-button|start-button|game-start|btn-play|btn-start|start-screen|startscreen/i.test(c);
      }).map(el =>({tag:el.tagName, text:el.textContent.trim().slice(0,60), class:(typeof el.className==='string'?el.className:'').slice(0,60), id:el.id, rect:center(el)}));
      const canvas = Array.from(document.querySelectorAll('canvas')).map(c =>({id:c.id, class:c.className, rect:center(c)}));
      return {url:location.href, title:document.title, buttons:buttons.slice(0,25), canvas};
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(value, null, 2));
} finally {
  await client.close();
}
