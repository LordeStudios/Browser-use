export function parseModelCommand(text,registry){
  let s=String(text).trim();
  if(s.startsWith('[')) return {ok:false,error:'Arrays are rejected; return exactly one command object'};
  const fenceMatch=s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if(fenceMatch) s=fenceMatch[1].trim();
  const start=s.indexOf('{'), end=s.lastIndexOf('}');
  if(start<0||end<start)return {ok:false,error:'No JSON object found'};
  let obj;
  try{obj=JSON.parse(s.slice(start,end+1));}catch(e){return {ok:false,error:`Invalid JSON: ${e.message}`};}
  if(Array.isArray(obj))return {ok:false,error:'Arrays are rejected; return exactly one command object'};
  if(!obj.command||typeof obj.command!=='string')return {ok:false,error:'Missing string command'};
  if(!registry.has(obj.command))return {ok:false,error:`Unknown command: ${obj.command}`};
  return {ok:true,command:obj.command,args:obj.args||{}};
}
