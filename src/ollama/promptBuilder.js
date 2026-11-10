export async function buildMessages(ctx,registry,goal,lastResult=null){
  const info=await ctx.browser.getCurrentInfo().catch(()=>({}));
  const events=ctx.eventBus.recent(10);
  return [
    {role:'system',content:'You control a live browser through tools. Return exactly one JSON command. No markdown. No explanation. Do not assume success. If unsure, request a screenshot or DOM snapshot. Use browser tools only from the allowed command list. Stop by returning {\"command\":\"browser.info\"} if the goal appears satisfied.'},
    {role:'user',content:JSON.stringify({goal,url:info.url,title:info.title,focused:info.focused,consoleErrorCount:ctx.browser.console.filter(e=>e.type==='error').length,lastEvents:events,lastResult,allowedCommands:registry.list().map(t=>t.name)})}
  ];
}