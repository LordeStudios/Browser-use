import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const dataRoot = path.resolve(process.env.BROWSER_USE_DATA_DIR || toolRoot);
// In the standalone dist/ layout, toolRoot is .../browser-use/dist, so go one level higher.
let _repoRoot = path.resolve(toolRoot, '../..');
if (path.basename(toolRoot) === 'dist') {
  _repoRoot = path.resolve(_repoRoot, '..');
}
export const repoRoot = _repoRoot;
export function parseArgs(argv = process.argv.slice(2)) {
  const out={mode:'controlled',port:Number(process.env.BROWSER_USE_CDP_PORT||9222),serverPort:Number(process.env.BROWSER_USE_PORT||8765),url:'about:blank',smoke:false,agent:false,noAgent:false,model:process.env.OLLAMA_MODEL||'gemma4',ollamaBaseUrl:process.env.OLLAMA_BASE_URL||'http://localhost:11434',command:null,args:{},connect:null,mcp:false,mcpHttp:false,mcpPort:Number(process.env.BROWSER_USE_MCP_PORT||8790),mcpHost:process.env.BROWSER_USE_MCP_HOST||'127.0.0.1',mcpSecret:process.env.BROWSER_USE_MCP_SECRET||null,gptKey:process.env.BROWSER_USE_GPT_KEY||null,replay:false,session:null,allowDangerous:false,nativePointer:process.platform==='win32',maxSteps:Number(process.env.BROWSER_USE_MAX_STEPS||50),maxMinutes:Number(process.env.BROWSER_USE_MAX_MINUTES||10),maxSeconds:Number(process.env.BROWSER_USE_MAX_SECONDS||60),script:null};
  for(let i=0;i<argv.length;i++){
    const a=argv[i]; const n=()=>argv[++i];
    if(a==='--smoke') out.smoke=true;
    else if(a==='--url') out.url=n();
    else if(a==='--port') out.port=Number(n());
    else if(a==='--server-port') out.serverPort=Number(n());
    else if(a==='--agent') out.agent=true;
    else if(a==='--no-agent') out.noAgent=true;
    else if(a==='--no-native-pointer') out.nativePointer=false; // Kept as a compatibility no-op; agent cursor never moves the host pointer.
    else if(a==='--goal') out.goal=n();
    else if(a==='--model') out.model=n();
    else if(a==='--command') out.command=n();
    else if(a==='--args') out.args=JSON.parse(n());
    else if(a==='--connect'){out.connect=n(); out.mode='connect-existing';}
    else if(a==='--mcp') out.mcp=true;
    else if(a==='--mcp-http') out.mcpHttp=true;
    else if(a==='--mcp-port') out.mcpPort=Number(n());
    else if(a==='--mcp-host') out.mcpHost=n();
    else if(a==='--mcp-secret') out.mcpSecret=n();
    else if(a==='--gpt-key') out.gptKey=n();
    else if(a==='--allow-dangerous') out.allowDangerous=true;
    else if(a==='--max-steps') out.maxSteps=Number(n());
    else if(a==='--max-minutes') out.maxMinutes=Number(n());
    else if(a==='--max-seconds') out.maxSeconds=Number(n());
    else if(a==='--session') out.session=n();
    else if(a==='--script') out.script=n();
  }
  return out;
}
export function makeSessionId(){return `session-${new Date().toISOString().replace(/[:.]/g,'-')}`;}
