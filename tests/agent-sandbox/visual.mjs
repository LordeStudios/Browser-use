import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright-core';
import {random,digest} from './cases.mjs';
const require=createRequire(import.meta.url);
const {mapPointerInput,validatePointerBounds}=require('../../desktop/computer/pointerGesture.cjs');
const colors={red:'#ce3232',blue:'#2464ca',green:'#21834b'};
const inside=(p,r)=>p.x>=r.x&&p.y>=r.y&&p.x<r.x+r.width&&p.y<r.y+r.height;
function sample(points){const out=[];for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],steps=Math.max(1,Math.ceil(Math.hypot(b.x-a.x,b.y-a.y)*120));for(let s=0;s<=steps;s++)out.push({x:a.x+(b.x-a.x)*s/steps,y:a.y+(b.y-a.y)*s/steps});}return out;}
function coverage(source,target){if(!source.length||!target.length)return 0;return source.filter(p=>target.some(q=>Math.hypot(p.x-q.x,p.y-q.y)<=.045)).length/source.length;}
export async function createVisualCase({directory,level,seed,split}){
  const rng=random(seed),offset=(rng()-.5)*.12;
  const target=[{color:'red',points:[{x:.22+offset,y:.38},{x:.5+offset,y:.10},{x:.78+offset,y:.38},{x:.22+offset,y:.38}]}];
  if(level>1)target.push({color:'blue',points:[{x:.18,y:.60},{x:.35,y:.46},{x:.51,y:.61},{x:.76,y:.48}]});
  if(level>2)target.push({color:'green',points:[{x:.25,y:.72},{x:.72,y:.72},{x:.72,y:.9},{x:.25,y:.9},{x:.25,y:.72}]});
  const profile=path.join(directory,'render-profile');await fs.mkdir(profile,{recursive:true});
  const env={...process.env,APPDATA:profile,LOCALAPPDATA:profile};delete env.ELECTRON_RUN_AS_NODE;
  // Do not expose the provider credential to the image renderer subprocess.
  delete env.ANTHROPIC_AUTH_TOKEN;delete env.XKIRO_API_KEY;
  const app=await electron.launch({executablePath:path.resolve(import.meta.dirname,'../../node_modules/electron/dist/electron.exe'),args:[path.join(import.meta.dirname,'render.cjs'),`--user-data-dir=${profile}`],env,timeout:30000});
  const state={orientation:'landscape',color:'blue',dialog:false,tool:'pointer',foreground:'100',strokes:[]};
  let shot=null;
  const desktop={x:0,y:0,width:1000,height:700};
  const drawingRect=()=>({x:380,y:150,width:state.orientation==='portrait'?280:500,height:state.orientation==='portrait'?420:300});
  const controls=[{name:'Pencil',x:20,y:65,width:95,height:40,change:()=>{state.tool='pencil';}},...Object.keys(colors).map((color,i)=>({name:color,x:130+i*85,y:65,width:75,height:40,change:()=>{state.color=color;}})),{name:'Canvas',x:415,y:65,width:100,height:40,change:()=>{state.dialog=true;}}];
  const poly=(stroke,rect)=>`<polyline points="${stroke.points.map(p=>`${rect.x+p.x*rect.width},${rect.y+p.y*rect.height}`).join(' ')}" fill="none" stroke="${colors[stroke.color]}" stroke-width="5" stroke-linejoin="round" stroke-linecap="round"/>`;
  async function screenshot(){
    const rect=drawingRect(),reference={x:30,y:150,width:280,height:420};
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="700"><rect width="1000" height="700" fill="#eceff2"/><text x="20" y="30" font-size="20">Generated drawing workspace</text>${controls.map(c=>`<rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}" fill="${colors[c.name]||'#fff'}" stroke="${state.color===c.name||state.tool==='pencil'&&c.name==='Pencil'?'#111':'#999'}" stroke-width="${state.color===c.name||state.tool==='pencil'&&c.name==='Pencil'?4:1}"/><text x="${c.x+8}" y="${c.y+26}" fill="${colors[c.name]?'#fff':'#111'}" font-size="16">${c.name}</text>`).join('')}<text x="30" y="137" font-size="17">Reference — portrait</text><text x="380" y="137" font-size="17">Your canvas — ${state.orientation}</text><rect x="30" y="150" width="280" height="420" fill="white" stroke="#777"/><rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" fill="white" stroke="#777"/>${target.map(s=>poly(s,reference)).join('')}${state.strokes.map(s=>poly(s,rect)).join('')}<text x="30" y="630" font-size="16">Select Pencil and a color, then draw on the right canvas. Undo: Ctrl+Z.</text>${state.dialog?'<rect x="330" y="230" width="340" height="210" fill="white" stroke="#333"/><text x="355" y="267" font-size="22">Canvas orientation</text><rect x="355" y="300" width="120" height="50" fill="#eee" stroke="#333"/><text x="363" y="330" font-size="18">Portrait</text><rect x="505" y="300" width="140" height="50" fill="#eee" stroke="#333"/><text x="513" y="330" font-size="18">Landscape</text><text x="355" y="400" font-size="16">Choose to apply and close</text>':''}</svg>`;
    const png=await app.evaluate(async({BrowserWindow},svg)=>{const window=BrowserWindow.getAllWindows()[0];await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent('<style>html,body{margin:0;width:1000px;height:700px;overflow:hidden}</style>'+svg));await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');const image=await window.webContents.capturePage(undefined,{stayHidden:true});return image.toPNG().toString('base64');},svg);
    shot={source:'native-desktop',mimeType:'image/png',data:png,screenshotId:crypto.randomUUID(),displayId:'sandbox',width:1000,height:700,origin:{x:0,y:0},scaleX:1,scaleY:1,capturedAt:Date.now(),imageHash:digest(Buffer.from(png,'base64'))};
    return shot;
  }
  const visual={
    observe:()=>({coordinateSpace:'physical-desktop-pixels',virtualDesktop:desktop,foregroundWindowId:state.foreground,windows:[{id:'100',pid:1,title:'Generated drawing workspace',bounds:desktop,minimized:false}],displays:[{id:'sandbox',bounds:desktop}],sandbox:{capabilities:'Simulated window focus, pointer click/drag/stroke, screenshots, Escape and Ctrl+Z only. No file/shell/clipboard interaction.'}}),
    signature:()=>JSON.stringify(state),
    async execute(name,input,owner,check){check();
      if(name==='computer_screenshot')return screenshot();
      if(name==='computer_window'){if(input.action!=='focus'||input.windowId!=='100')throw Error('Unknown simulated window');state.foreground='100';return {focused:true,window:visual.observe().windows[0]};}
      if(name==='computer_keyboard'){if(input.action!=='press')throw Error('Only Escape and Ctrl+Z are implemented in this simulated app');if(/^escape$/i.test(input.key)){state.dialog=false;}else if(/^(control|ctrl)\+z$/i.test(input.key)){state.strokes.pop();}else throw Error('Unsupported simulated key; no effect');return {dispatched:true};}
      const args=mapPointerInput(name==='computer_stroke'?{...input,action:'stroke'}:input,shot,[{id:'sandbox',bounds:desktop}]);
      validatePointerBounds(args,desktop,args.windowId?desktop:undefined);
      if(args.windowId&&args.windowId!=='100')throw Error('Unknown simulated target window');
      if(args.action==='click'){
        if(state.dialog){
          if(inside(args,{x:355,y:300,width:120,height:50})){state.orientation='portrait';state.dialog=false;}
          else if(inside(args,{x:505,y:300,width:140,height:50})){state.orientation='landscape';state.dialog=false;}
          else return {dispatched:true,action:'click',effect:'none',note:'The modal canvas-orientation dialog is blocking every other control; choose Portrait or Landscape first.'};
        } else {const control=controls.find(c=>inside(args,c));if(control)control.change();}
        return {dispatched:true,action:'click'};
      }
      if(!['stroke','drag','move'].includes(args.action))throw Error('Unsupported simulated pointer action; no effect');
      if(args.action==='move')return {dispatched:true};
      if(state.dialog)throw Error('Stroke rejected: the canvas-orientation dialog is still open. Choose Portrait or Landscape to close it, then verify with a screenshot.');
      if(state.tool!=='pencil')throw Error('Stroke rejected: the Pencil tool is not active. Select Pencil in the toolbar and verify with a screenshot.');
      const rect=drawingRect(),strokes=args.action==='stroke'?args.strokes:[{points:[{x:args.x,y:args.y},{x:args.endX,y:args.endY}]}];
      if(strokes.some(s=>s.points.some(p=>!inside(p,rect))))throw Error('Stroke leaves the visible canvas; no points drawn');
      for(const stroke of strokes)state.strokes.push({color:state.color,points:stroke.points.map(p=>({x:(p.x-rect.x)/rect.width,y:(p.y-rect.y)/rect.height}))});
      return {dispatched:true,completedStrokes:strokes.length,verification:'Inspect the actual simulated pixels to verify the outcome.'};
    },
    async save(directory){const image=await screenshot();await fs.writeFile(path.join(directory,'final.png'),Buffer.from(image.data,'base64'));await fs.writeFile(path.join(directory,'scene.json'),JSON.stringify(state,null,2));},
    close:()=>app.close()
  };
  const fixture={family:'visual',level,seed,split,objective:'Using only the simulated native UI tools, change the right canvas to portrait and reproduce every colored outline shown in the reference on the left, preserving their relative positions and colors. Use the Pencil tool. Leave the result visible and report completion only after inspecting it. No scripts, files or imports.',budgets:{seconds:60+level*30,tools:5+level*3,requests:4+level*2},manifest:{family:'visual',level,seed,split,target,coverageThreshold:.85},
    async grade(){const checks={portrait:state.orientation==='portrait',noOpenDialog:!state.dialog};for(const color of Object.keys(colors)){const expected=sample(target.filter(s=>s.color===color).flatMap(s=>s.points)),actual=state.strokes.filter(s=>s.color===color).flatMap(s=>sample(s.points));checks[color]=expected.length?coverage(expected,actual)>=.85&&coverage(actual,expected)>=.85:actual.length===0;}return checks;}};
  return {fixture,visual};
}
