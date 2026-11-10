import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {fileOperation}=require('../../desktop/computer/fileOperations.cjs');
const {normalizeComputerInput,validateComputerInput}=require('../../desktop/computer/computerCatalog.cjs');
export async function scopedPath(root,value){
  if(typeof value!=='string'||!path.isAbsolute(value))throw Error('Sandbox file paths must be absolute.');
  const absolute=path.resolve(value),relative=path.relative(root,absolute);
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Sandbox boundary: path is outside the generated workspace.');
  let cursor=root;
  for(const segment of ['',...relative.split(path.sep).filter(Boolean)]){cursor=path.join(cursor,segment);try{const stat=await fs.lstat(cursor);if(stat.isSymbolicLink())throw Error('Sandbox boundary: symlink/reparse traversal is not allowed.');}catch(error){if(error.code!=='ENOENT')throw error;}}
  return absolute;
}
export class SandboxEnvironment{
  constructor(root,{visual=null}={}){this.root=path.resolve(root);this.visual=visual;this.calls=[];this.boundaryViolations=0;}
  async observe(){return this.visual?this.visual.observe():{coordinateSpace:'physical-desktop-pixels',virtualDesktop:{x:0,y:0,width:1000,height:700},foregroundWindowId:'1',windows:[{id:'1',pid:1,title:'Generated file workspace',bounds:{x:0,y:0,width:1000,height:700},minimized:false}],sandbox:{workspace:this.root,capabilities:'Real scoped computer_file operations only. No host shell, network, clipboard, application launch or desktop input.'}};}
  async execute(name,input,owner,{signal}={}){
    input=normalizeComputerInput(name,input);validateComputerInput(name,input);
    const check=()=>{if(signal?.aborted)throw Error('Sandbox operation cancelled.');};check();
    const started=performance.now(),entry={tool:name,input:structuredClone(input),owner,startedAt:Date.now()};this.calls.push(entry);
    try{
      let result;
      if(name==='computer_observe'||name==='computer_window'&&input.action==='list')result=await this.observe();
      else if(name==='computer_file'){
        const checked={...input,path:await scopedPath(this.root,input.path)};
        if(input.destination!==undefined)checked.destination=await scopedPath(this.root,input.destination);
        if(checked.path===this.root&&['delete','move'].includes(input.action))throw Error('Sandbox boundary: cannot remove the workspace root.');
        const before=await this.fileSignature();result=await fileOperation(checked,check);entry.changed=before!==await this.fileSignature();
      }else if(this.visual&&['computer_pointer','computer_stroke','computer_keyboard','computer_window','computer_screenshot'].includes(name)){
        const before=this.visual.signature();result=await this.visual.execute(name,input,owner,check);entry.changed=before!==this.visual.signature();
      }else throw Error(`Sandbox capability unavailable: ${name}. No command or effect was executed.`);
      entry.ok=true;entry.result=result?.data?{...result,data:'[image stored separately]'}:structuredClone(result);return result;
    }catch(error){entry.ok=false;entry.error=error.message;if(/Sandbox boundary/.test(error.message))this.boundaryViolations++;throw error;}
    finally{entry.durationMs=performance.now()-started;}
  }
  async fileSignature(){const parts=[];const visit=async folder=>{for(const item of await fs.readdir(folder,{withFileTypes:true})){const full=path.join(folder,item.name);if(item.isSymbolicLink())throw Error('Sandbox boundary: unexpected symlink');if(item.isDirectory())await visit(full);else{const content=await fs.readFile(full);parts.push([path.relative(this.root,full),content.toString('base64')]);}}};await visit(this.root);return JSON.stringify(parts.sort());}
  async releaseOwner(){} async releaseInput(){} async close(){await this.visual?.close();}
}
export function sandboxController(){return {navigationState:()=>({url:'sandbox://workspace',loading:false}),domSnapshot:()=>({title:'Sandbox tools only',elements:[],regions:[]}),consoleEntries:()=>[],networkEntries:()=>[],listTabs:()=>[{id:'sandbox'}],releaseSessionInput:()=>{},wait:async(ms,signal)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(finish,ms);function abort(){finish(Error('Cancelled'));}function finish(error){clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();}if(signal?.aborted)return abort();signal?.addEventListener('abort',abort,{once:true});});}};}
