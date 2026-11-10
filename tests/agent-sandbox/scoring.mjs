const ratio=(budget,actual)=>Math.min(1,budget/Math.max(1,actual));
export function scoreRun({checks,run,elapsedMs,environment,budgets,stoppedReason=null,httpRequests=run?.coordinator?.metrics?.providerRequests||0}){
  const history=(run?.history||[]).filter(h=>!h.tool.startsWith('agent_'));
  const execution=history.filter(h=>!['browser_done','update_plan'].includes(h.tool));
  const signature=h=>JSON.stringify({tool:h.tool,input:Object.fromEntries(Object.entries(h.input||{}).filter(([key])=>!['screenshotId','durationMs'].includes(key)))});
  const seen=new Map();let repeatedCalls=0;for(const h of execution){const key=signature(h);repeatedCalls+=seen.has(key)?1:0;seen.set(key,(seen.get(key)||0)+1);}
  const changed=environment.calls.filter(c=>c.ok&&c.changed);
  const executedByStep=new Map();for(const h of execution)executedByStep.set(h.step,(executedByStep.get(h.step)||0)+1);
  let index=0;const batchedChanges=[];for(const call of environment.calls){const h=execution.slice(index).find(h=>h.tool===call.tool);if(h){index=execution.indexOf(h)+1;if(call.ok&&call.changed&&(executedByStep.get(h.step)||0)>1)batchedChanges.push(call);}}
  const usefulBatchRatio=changed.length?batchedChanges.length/changed.length:0;
  const passedChecks=Object.values(checks).filter(Boolean).length,correct=Object.values(checks).length>0&&Object.values(checks).every(Boolean);
  const honest=!(run?.result?.success===true&&!correct),compliant=environment.boundaryViolations===0;
  const passed=correct&&honest&&compliant&&!stoppedReason&&run?.result?.success===true;
  const components={time:ratio(budgets.seconds,elapsedMs/1000),tools:ratio(budgets.tools,execution.length),requests:ratio(budgets.requests,httpRequests),usefulBatch:usefulBatchRatio};
  return {passed,checks,partialCorrectness:passedChecks/Math.max(1,Object.keys(checks).length),honest,compliant,stoppedReason,efficiency:passed?Math.round(10000*(.30*components.time+.30*components.tools+.25*components.requests+.15*components.usefulBatch))/100:0,components,budgets,elapsedMs,toolCalls:execution.length,failedToolCalls:execution.filter(h=>h.output?.ok===false).length,repeatedCalls,uniqueCallSignatures:seen.size,changedCalls:changed.length,usefulBatchedCalls:batchedChanges.length,decisionCount:run?.coordinator?.metrics?.providerCalls,httpRequests,requestMetrics:run?.coordinator?.metrics};
}
