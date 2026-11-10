export function controlCenterHtml(sessionId) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Browser-use Control Center</title>
<style>
:root { color-scheme: dark; --bg:#0b0d12; --surface:#141820; --line:#283142; --ink:#eef3ff; --muted:#9eabc0; --accent:#75f1c2; --bad:#ff7c86; }
* { box-sizing:border-box } body { margin:0; min-width:680px; background:radial-gradient(circle at 12% 0,#182638,var(--bg) 42%); color:var(--ink); font:13px/1.4 Inter,Segoe UI,sans-serif }
header { display:flex; justify-content:space-between; align-items:center; padding:16px 18px; border-bottom:1px solid var(--line); background:#10151eaa; backdrop-filter:blur(16px) } h1 { margin:0; font-size:15px; letter-spacing:.05em; text-transform:uppercase } .badge { color:var(--accent); border:1px solid #2d6b58; border-radius:999px; padding:3px 8px; font-size:11px }
main { display:grid; grid-template-columns:1.1fr .9fr; gap:12px; padding:12px } section { min-height:180px; overflow:hidden; border:1px solid var(--line); border-radius:12px; background:var(--surface) } h2 { margin:0; padding:10px 12px; color:var(--muted); font-size:11px; letter-spacing:.08em; text-transform:uppercase; border-bottom:1px solid var(--line) } .content { padding:10px 12px } #state { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px } .metric { min-height:62px; padding:9px; border-radius:8px; background:#0f141d; border:1px solid #202a39 } .metric b { display:block; margin-top:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px } .metric small { color:var(--muted); text-transform:uppercase; font-size:9px; letter-spacing:.07em }
#events { max-height:460px; overflow:auto; font:11px/1.45 ui-monospace,Consolas,monospace; white-space:pre-wrap } .event { padding:7px 0; border-bottom:1px solid #202a39 } .event.error { color:var(--bad) } .event b { color:var(--accent) } button { border:1px solid #35506a; border-radius:7px; padding:7px 9px; color:var(--ink); background:#182435; cursor:pointer } button:hover { border-color:var(--accent); color:var(--accent) } .controls { display:flex; flex-wrap:wrap; gap:7px } .wide { grid-column:1/-1 } #url { width:100%; padding:8px; border:1px solid #344259; border-radius:7px; color:var(--ink); background:#0d121a } .status { color:var(--muted); margin-top:8px; font-size:11px }
</style>
</head>
<body><header><h1>Browser-use <span class="badge">HEADED · ${sessionId}</span></h1><span id="connection" class="badge">connecting</span></header>
<main>
<section><h2>Live browser</h2><div class="content"><div id="state"></div><div class="status" id="status">Waiting for runtime state…</div></div></section>
<section><h2>Visible controls</h2><div class="content"><input id="url" placeholder="https://example.com"><div class="controls" style="margin-top:8px"><button data-command="browser.navigate">Navigate</button><button data-command="browser.screenshot">Screenshot</button><button data-command="browser.domSnapshot">Inspect DOM</button><button data-command="browser.consoleLogs">Console</button><button data-command="browser.networkLogs">Network</button><button data-command="browser.failedRequests">Failures</button></div><p class="status">This dashboard observes and controls the same visible Chromium session used by MCP agents. Pointer actions use Chromium input and, on Windows, move the native desktop pointer.</p></div></section>
<section class="wide"><h2>Action and diagnostic stream</h2><div class="content" id="events"></div></section>
</main>
<script>
const state=document.querySelector('#state'), events=document.querySelector('#events'), status=document.querySelector('#status'), connection=document.querySelector('#connection'), url=document.querySelector('#url');
const socket=new WebSocket('ws://'+location.host+'/ui');
const push=(value,kind='')=>{const item=document.createElement('div');item.className='event '+kind;item.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);events.prepend(item)};
const render=(info, diagnostics={})=>{if(!info)return;state.innerHTML=[['URL',info.url],['Title',info.title||'(untitled)'],['Ready',info.readyState],['Console',diagnostics.console??0],['Network',diagnostics.network??0],['Focus',info.focused?.tag||'none']].map(([k,v])=>'<div class="metric"><small>'+k+'</small><b title="'+String(v).replaceAll('&','&amp;').replaceAll('"','&quot;')+'">'+String(v)+'</b></div>').join('');url.value=info.url||url.value};
socket.addEventListener('open',()=>{connection.textContent='connected';socket.send(JSON.stringify({type:'ui.state'}))});socket.addEventListener('close',()=>connection.textContent='disconnected');socket.addEventListener('message',(event)=>{const message=JSON.parse(event.data);if(message.type==='ui.state'){render(message.info,message.diagnostics);return}if(message.type==='event'){push(message.event, message.event.type.includes('error')?'error':'');socket.send(JSON.stringify({type:'ui.state'}));return}if(message.id){push(message);status.textContent=message.ok?'Action completed':'Action failed: '+message.error;socket.send(JSON.stringify({type:'ui.state'}))}});
document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{const command=button.dataset.command;const args=command==='browser.navigate'?{url:url.value.trim()}:{};socket.send(JSON.stringify({id:'ui-'+Date.now(),command,args})}));
</script></body></html>`;
}

