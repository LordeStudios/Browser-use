'use strict';
const crypto = require('node:crypto');
const PLAN_STATUSES = new Set(['pending', 'current', 'done', 'skipped']);
const MAX_PLAN_ITEMS = 100;
function planItemText(item) {
  if (typeof item === 'string') return item.replace(/\0/g, '').trim().slice(0, 500);
  return String(item?.text ?? item?.title ?? item?.step ?? item?.description ?? item?.name ?? '').replace(/\0/g, '').trim().slice(0, 500);
}
function planItemId(item, text, occurrence) {
  const supplied = String(item && typeof item === 'object' ? item.id ?? item.taskId ?? '' : '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 100);
  return supplied || `task-${crypto.createHash('sha256').update(`${text}\0${occurrence}`).digest('hex').slice(0, 12)}`;
}
function normalizeConversationPlan(value, previous = []) {
  if (!Array.isArray(value)) return [];
  const priorByText = new Map();
  for (const item of Array.isArray(previous) ? previous : []) {
    const text = planItemText(item); if (!text || !item?.id) continue;
    const matches = priorByText.get(text) || []; matches.push(String(item.id)); priorByText.set(text, matches);
  }
  const occurrences = new Map(), usedIds = new Set();
  return value.slice(0, MAX_PLAN_ITEMS).map(item => {
    const text = planItemText(item); if (!text) return null;
    const occurrence = occurrences.get(text) || 0; occurrences.set(text, occurrence + 1);
    const reusableId = (priorByText.get(text) || []).find(id => !usedIds.has(id));
    let id = String(item && typeof item === 'object' ? item.id ?? item.taskId ?? '' : '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 100) || reusableId || planItemId(item, text, occurrence);
    let duplicate = occurrence + usedIds.size;
    while (usedIds.has(id)) id = planItemId(null, text, duplicate++);
    usedIds.add(id);
    return { id, text, status: PLAN_STATUSES.has(item?.status) ? item.status : 'pending', verification: String(item && typeof item === 'object' ? item.verification ?? '' : '').replace(/\0/g, '').trim().slice(0, 500),
      ...(item?.goalId ? { goalId: String(item.goalId).slice(0, 100) } : {}) };
  }).filter(Boolean);
}
function planTargetIndex(plan, operation) {
  const id = String(operation?.id ?? operation?.taskId ?? '').trim();
  if (id) return plan.findIndex(item => item.id === id);
  if (Number.isInteger(Number(operation?.index))) { const index = Number(operation.index); return index >= 0 && index < plan.length ? index : -1; }
  const text = planItemText(operation); return text ? plan.findIndex(item => item.text === text) : -1;
}
function applyPlanUpdate(currentPlan, input) {
  const current = normalizeConversationPlan(currentPlan);
  const fullPlan = Array.isArray(input) ? input : Array.isArray(input?.steps) ? input.steps : Array.isArray(input?.plan) ? input.plan : null;
  if (fullPlan) {
    const plan = normalizeConversationPlan(fullPlan, current);
    if (fullPlan.length && !plan.length) return { ok: false, error: 'No usable tasks were found. Each task needs text, title, step, description, or name.' };
    return { ok: true, plan, added: plan.filter(item => !current.some(old => old.id === item.id)).length, updated: plan.filter(item => current.some(old => old.id === item.id && JSON.stringify(old) !== JSON.stringify(item))).length, removed: current.filter(old => !plan.some(item => item.id === old.id)).length };
  }
  const operations = Array.isArray(input?.operations) ? input.operations : Array.isArray(input?.ops) ? input.ops : null;
  if (!operations) return { ok: false, error: 'update_plan requires a steps array or an operations array; a numeric task count is not a plan.' };
  let plan = [...current], added = 0, updated = 0, removed = 0;
  for (const operation of operations.slice(0, MAX_PLAN_ITEMS)) {
    const op = String(operation?.op ?? operation?.action ?? '').toLowerCase().replace(/[-\s]/g, '_');
    if (op === 'clear') { removed += plan.length; plan = []; continue; }
    if (op === 'add') {
      if (plan.length >= MAX_PLAN_ITEMS) return { ok:false, error:`A plan can contain up to ${MAX_PLAN_ITEMS} tasks.` };
      const source = operation?.task && typeof operation.task === 'object' ? operation.task : operation;
      const normalized = normalizeConversationPlan([source], plan);
      if (!normalized.length) return { ok:false, error:'An add operation requires task text.' };
      let index = Number.isInteger(Number(operation?.index)) ? Number(operation.index) : plan.length;
      const afterIndex = operation?.afterId ? plan.findIndex(item => item.id === String(operation.afterId)) : -1;
      const beforeIndex = operation?.beforeId ? plan.findIndex(item => item.id === String(operation.beforeId)) : -1;
      if (afterIndex >= 0) index = afterIndex + 1; if (beforeIndex >= 0) index = beforeIndex;
      plan.splice(Math.max(0, Math.min(plan.length, index)), 0, normalized[0]);
      plan = normalizeConversationPlan(plan); added++; continue;
    }
    const index = planTargetIndex(plan, operation);
    if (index < 0) return { ok:false, error:`The ${op || 'update'} operation did not match an existing task.` };
    if (op === 'remove' || op === 'delete') { plan.splice(index, 1); removed++; continue; }
    if (['update','set_status','status'].includes(op)) {
      const existing = plan[index];
      plan[index] = { ...existing, text:planItemText(operation) || existing.text, status:PLAN_STATUSES.has(operation?.status) ? operation.status : existing.status,
        verification:operation?.verification === undefined ? existing.verification : String(operation.verification || '').replace(/\0/g,'').trim().slice(0,500),
        ...(operation?.goalId !== undefined ? {goalId:String(operation.goalId || '').slice(0,100)} : {}) };
      updated += JSON.stringify(existing) === JSON.stringify(plan[index]) ? 0 : 1; continue;
    }
    return { ok:false, error:`Unsupported plan operation: ${op || 'missing op'}.` };
  }
  return { ok:true, plan, added, updated, removed };
}
// Models send the same plan in several shapes: a real array, a JSON-encoded
// array inside a string, or a numbered/bulleted block of text. Accept the
// shapes that are unambiguous so a correct plan is not thrown away over its
// wrapping, and leave everything else (a bare number, prose) to be rejected.
function coerceTaskList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text) return value;
  if (text.startsWith('[')) { try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed; } catch { /* not JSON */ } }
  const lines = text.split(/\r?\n/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  return lines.length > 1 ? lines : value;
}
function normalizePlanInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const out = { ...input };
  for (const key of ['steps', 'plan', 'operations', 'ops', 'goalOperations']) if (key in out) out[key] = coerceTaskList(out[key]);
  // `goals` is documented as "Model-authored goals". One goal written as a
  // plain sentence is a goal list of one, not a malformed array.
  if (typeof out.goals === 'string' && out.goals.trim()) { const list = coerceTaskList(out.goals); out.goals = Array.isArray(list) ? list : [out.goals.trim()]; }
  // A bare number is a task COUNT, never a plan. Drop it so a valid
  // `operations` array alongside it is used instead of the whole call failing.
  if (typeof out.steps === 'number' && Array.isArray(out.operations)) delete out.steps;
  return out;
}
function applyProgressUpdate(plan, goals, rawInput) {
  const input = normalizePlanInput(rawInput);
  const hasGoals = input && ('goals' in input || 'goalOperations' in input);
  const hasPlan = Array.isArray(input) || input && ['steps','plan','operations','ops'].some(key => key in input);
  const tasks = hasPlan || !hasGoals ? applyPlanUpdate(plan, input) : {ok:true, plan:normalizeConversationPlan(plan),added:0,updated:0,removed:0};
  if (!tasks.ok) return tasks;
  const goalUpdate = hasGoals ? applyPlanUpdate(goals, { ...(input.goals !== undefined ? {steps:input.goals} : {}), ...(input.goalOperations !== undefined ? {operations:input.goalOperations} : {}) }) : {ok:true,plan:normalizeConversationPlan(goals)};
  if (!goalUpdate.ok) return goalUpdate;
  return {...tasks,goals:goalUpdate.plan};
}
module.exports = { normalizeConversationPlan, applyPlanUpdate, applyProgressUpdate };
