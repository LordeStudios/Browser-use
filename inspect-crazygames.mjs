import CDP from 'chrome-remote-interface';

const TAB = process.argv[2] || 'E3213B843B691ADA3F864C3BA62A1CFF';
const URL = `ws://127.0.0.1:9222/devtools/page/${TAB}`;

const client = await CDP({ target: URL });
try {
  const { Runtime } = client;
  await Runtime.enable();
  const { result: { value } } = await Runtime.evaluate({
    expression: `(function(){
      function center(el){const r=el.getBoundingClientRect();return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),w:Math.round(r.width),h:Math.round(r.height)};}
      const playWords = /play|start|begin|launch|go|play now|start game|click to play/i;
      const buttons = Array.from(document.querySelectorAll('button, a, div, span')).filter(el => {
        const t = el.textContent.trim();
        const c = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        return playWords.test(t) || playWords.test(c) || /play-button|start-button|game-start|btn-play|btn-start/i.test(c);
      }).map(el =>({tag:el.tagName, text:el.textContent.trim().slice(0,50), class:(typeof el.className==='string'?el.className:'').slice(0,60), rect:center(el)}));
      const iframes = Array.from(document.querySelectorAll('iframe')).map(f =>({src:f.src, id:f.id, class:f.className, rect:center(f)}));
      const gameContainers = Array.from(document.querySelectorAll('[class*="game" i], [id*="game" i], [class*="player" i], [id*="player" i], canvas')).map(el =>({tag:el.tagName, class:(typeof el.className==='string'?el.className:'').slice(0,60), id:el.id, rect:center(el)}));
      return {url:location.href, title:document.title, buttons:buttons.slice(0,20), iframes, gameContainers:gameContainers.slice(0,15)};
    })()`,
    returnByValue: true
  });
  console.log(JSON.stringify(value, null, 2));
} finally {
  await client.close();
}
