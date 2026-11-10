import { buildMessages } from './promptBuilder.js'; import { chatStream } from './ollamaClient.js'; import { parseModelCommand } from './commandParser.js'; import { executeTool } from '../tools/toolExecutor.js';
export class AgentLoop{
  constructor(ctx,registry,opts={}){this.ctx=ctx;this.registry=registry;this.opts=opts;this.state='stopped';this.steps=0;this.startTime=null;this.lastResult=null;}
  async step(goal=this.opts.goal){
    this.steps++;
    const maxSteps=Number(this.opts.maxSteps)||50;
    const maxMinutes=Number(this.opts.maxMinutes)||10;
    if(this.steps>maxSteps){this.ctx.eventBus.emitEvent('agent.limit',{reason:'maxSteps',steps:this.steps}); this.stop(); return {ok:false,error:`Stopped after ${maxSteps} steps`};}
    if(this.startTime && (Date.now()-this.startTime)>maxMinutes*60000){this.ctx.eventBus.emitEvent('agent.limit',{reason:'timeout',minutes:maxMinutes}); this.stop(); return {ok:false,error:`Stopped after ${maxMinutes} minutes`};}
    const messages=await buildMessages(this.ctx,this.registry,goal,this.lastResult);
    let modelText='';
    try{modelText=await chatStream({baseUrl:this.opts.ollamaBaseUrl,model:this.opts.model,messages,onToken:t=>this.ctx.eventBus.emitEvent('model.token',{token:t})});}catch(e){this.ctx.eventBus.emitEvent('model.error',{error:e.message}); return {ok:false,error:e.message};}
    const parsed=parseModelCommand(modelText,this.registry);
    this.ctx.eventBus.emitEvent('model.parsed',parsed);
    if(!parsed.ok)return parsed;
    this.lastResult=await executeTool(this.ctx,this.registry,parsed.command,parsed.args);
    return this.lastResult;
  }
  start(goal){
    if(this.state==='running') return {ok:true,state:this.state};
    this.state='running'; this.steps=0; this.startTime=Date.now(); this.lastResult=null;
    const loop=async()=>{while(this.state==='running'){await this.step(goal); await new Promise(r=>setTimeout(r,250));}};
    this.promise=loop().catch(e=>{this.ctx.eventBus.emitEvent('agent.error',{error:e.message}); this.state='stopped';});
    return {ok:true,state:this.state};
  }
  pause(){this.state='paused';return{ok:true,state:this.state};}
  resume(goal){if(this.state==='running')return{ok:true,state:this.state};return this.start(goal);}
  stop(){this.state='stopped';this.ctx.eventBus.emitEvent('session.stop',{});return{ok:true,state:this.state};}
}
