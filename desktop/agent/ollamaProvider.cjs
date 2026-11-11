'use strict';

const { isComputerTool } = require('../computer/computerCatalog.cjs');
const { measureProviderRequest } = require('./desktopAgentCoordinator.cjs');

const { isLongReportRequest } = require('./reportFilePolicy.cjs');

const { createThinkingStreamSplitter } = require('./thinkingStream.cjs');
const { ProviderTurnLedger } = require('./providerTurnLedger.cjs');
const { summarizeConversation } = require('./providerCompaction.cjs');
const { context: interactionMemoryContext } = require('./interactionMemory.cjs');
// Shared wire seam: stream/JSON transport, inline-reasoning extraction, and
// the native-vision error all live in providers/wire.cjs now.
const { extractInlineReasoning, requestJson, requestStreamingChat } = require('./providers/wire.cjs');

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
// Sized for reasoning models: thinking + plan + actions share this budget.
// 768 truncated reasoning models mid-think and fed the DECISION_OUTPUT_BUDGET
// recovery loop (the observed re-derive-truncate-retry spirals).
const DECISION_MAX_TOKENS = 4_096;
const LONG_REPORT_MAX_TOKENS = 6_144;
const REPAIR_MAX_TOKENS = 1_024;
// Continuity tail of the prior decision's reasoning replayed into the
// decision context. The default stays 300 on purpose: a fuller replay made
// every model re-derive the whole plan each turn (the over-thinking spiral).
// Tunable per model via BROWSER_USE_REASONING_REPLAY_CHARS without code
// edits; the harness-owned plan/doneList/state remain the real memory.
const REASONING_REPLAY_CHARS = Math.min(8_000, Math.max(100, Number(process.env.BROWSER_USE_REASONING_REPLAY_CHARS) || 300));
const PREFLIGHT_SCHEMA_PROMPT = 'Return exactly one JSON object and nothing else with one safe browser_tabs action: {"toolCalls":[{"name":"browser_tabs","input":{}}]}';

function normalizeBaseUrl(value = DEFAULT_BASE_URL) {
  const url = new URL(String(value || DEFAULT_BASE_URL));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Ollama base URL must use http or https.');
  return url.toString().replace(/\/$/, '');
}

function extractSingleJsonObject(content) {
  const text = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start < 0) throw new Error('The local model did not return a structured agent response.');
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        const suffix = text.slice(index + 1).replace(/```/g, '').trim();
        if (suffix.includes('{')) throw new Error('The local model returned more than one structured agent response.');
        return JSON.parse(text.slice(start, index + 1));
      }
    }
  }
  throw new Error('The local model returned incomplete structured agent output.');
}

function parseAgentResponse(content, nativeToolCalls = null) {
  let parsed = null;
  const extracted = extractInlineReasoning(content);
  if (extracted.content) {
    try { parsed = extractSingleJsonObject(extracted.content); } catch (error) {
      if (!Array.isArray(nativeToolCalls) || nativeToolCalls.length === 0) {
        throw new Error(`The local model response could not be understood. ${String(error.message || '').slice(0, 180)}`);
      }
    }
  }
  const toolCalls = normalizeNativeToolCalls(nativeToolCalls);
  if (!parsed && toolCalls.length) parsed = { assistantText: extracted.content, toolCalls };
  const declaredActionsInvalid = parsed?.actions !== undefined && !Array.isArray(parsed.actions);
  const declaredToolCallsInvalid = parsed?.toolCalls !== undefined && !Array.isArray(parsed.toolCalls);
  const actions = Array.isArray(parsed?.actions) ? parsed.actions : Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : toolCalls;
  const hasDone = parsed?.done && typeof parsed.done === 'object';
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || declaredActionsInvalid || declaredToolCallsInvalid || !Array.isArray(actions) && !hasDone) {
    throw new Error('The local model returned an invalid agent JSON shape.');
  }
  if (toolCalls.length && !actions.length) parsed.toolCalls = toolCalls;
  const onlyCall = actions.length === 1 ? actions[0] : null;
  if (String(parsed.assistantText || '').trim().toLowerCase() === 'ready' && onlyCall?.name === 'browser_done' && /^structured response check$/i.test(String(onlyCall.input?.summary || '').trim())) {
    throw new Error('The provider repeated an internal response template instead of answering the task.');
  }
  return parsed;
}

function hasExecutableDecision(response) {
  return Boolean(response?.done && typeof response.done === 'object') ||
    Array.isArray(response?.actions) && response.actions.length > 0 ||
    Array.isArray(response?.toolCalls) && response.toolCalls.length > 0;
}

function extractEmbeddedDecision(text) {
  const source = String(text || '');
  if (!source) return null;
  const marker = /"(?:actions|toolCalls|done)"\s*:/.exec(source);
  if (!marker) return null;
  const start = source.lastIndexOf('{', marker.index);
  if (start < 0) return null;
  try {
    const parsed = parseAgentResponse(source.slice(start));
    return hasExecutableDecision(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Replace the leaked decision JSON with a short placeholder so the visible
// thinking transcript stays human-readable; the decision itself is harvested
// and executed elsewhere.
function redactEmbeddedDecision(text) {
  let source = String(text || '');
  for (let guard = 0; guard < 5; guard += 1) {
    const marker = /"(?:actions|toolCalls|done)"\s*:/.exec(source);
    if (!marker) break;
    const start = source.lastIndexOf('{', marker.index);
    if (start < 0) break;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    let end = -1;
    for (let index = start; index < source.length; index += 1) {
      const character = source[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === '{') depth += 1;
      else if (character === '}') {
        depth -= 1;
        if (depth === 0) { end = index; break; }
      }
    }
    if (end < 0) break;
    source = `${source.slice(0, start)}[structured decision — executed]${source.slice(end + 1)}`;
  }
  return source;
}

function hasOnlyRedundantObservation(response, observation, coordinator = null) {
  // A standalone provider caller may deliberately request an observation. It
  // becomes redundant only when the Desktop agent has supplied an identified,
  // fresh outer-loop observation for this exact decision.
  if (!observation || Number(coordinator?.observationRevision || 0) < 1 || !hasExecutableDecision(response) || response?.done) return false;
  const actions = Array.isArray(response?.actions) ? response.actions : Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  return actions.length > 0 && actions.every((action) => {
    if (action?.name === 'browser_observe') return true;
    return action?.name === 'browser_screenshot' && observation?.screenshot?.captured === true;
  });
}

function repeatsBlockedRecoveryAction(response, recovery) {
  // Whether to repeat a SUCCESSFUL action is model-owned and never rejected
  // here. This guard fires only when the exact call cannot advance the task:
  // the page itself refused it (constraint tamper — a real dead end), or it
  // already succeeded once (duplicate — repeating is a wasted turn). A stale
  // anchor or a malfunction is NOT on this list: the identical call with
  // corrected arguments is the right recovery and must be allowed through.
  const blockingSources = new Set(['constraint_tamper', 'duplicate_action']);
  const source = String(recovery?.source || '');
  const failed = String(recovery?.action || '').trim();
  if (!failed || !blockingSources.has(source) || response?.done) return false;
  const calls = Array.isArray(response?.actions) ? response.actions
    : Array.isArray(response?.toolCalls) ? response.toolCalls : [];
  return calls.length > 0 && calls.every((call) => String(call?.name || '') === failed);
}

function recoverInformationalFinal(_task, content) {
  const publicText = extractInlineReasoning(content).content
    .replace(/^```(?:text|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const protocolCandidate = publicText.replace(/^(?:json|javascript|js)\s*(?=[{[])/i, '').trim();
  // Structured data must still travel through the action parser. This fallback
  // is for a normal human-readable answer only, never a hidden command.
  if (!publicText || /^[{[]/.test(protocolCandidate) || /"(?:browser_[a-z_]+|toolCalls|actions|done)"\s*:/i.test(protocolCandidate)) return null;
  // An intention is not a completed browser result. This is content-shape
  // validation, not task or site recognition: any model that says it still
  // plans to act must return an executable action through the repair path.
  if (/^(?:i\s+(?:will|shall|need to|am going to|would|should)|let me|next\s+i)\b/i.test(publicText)) return null;
  const summary = publicText.slice(0, 4_000);
  return { assistantText: summary, done: { summary, success: true, verified: false } };
}

const REPAIR_STOP_WORDS = new Set(['about', 'after', 'again', 'also', 'been', 'before', 'being', 'build', 'create', 'current', 'from', 'have', 'into', 'only', 'page', 'site', 'that', 'then', 'there', 'these', 'this', 'through', 'using', 'visible', 'with']);

function repairTokens(value) {
  return [...new Set(String(value || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 3 && !REPAIR_STOP_WORDS.has(token)))];
}

function completedRepairControls(history, completedWork = []) {
  const names = [];
  for (const entry of Array.isArray(history) ? history : []) {
    if (entry?.output?.ok !== true) continue;
    const name = String(entry?.output?.result?.element?.name || '').replace(/\s+/g, ' ').trim();
    if (name && !names.some((item) => item.toLowerCase() === name.toLowerCase())) names.push(name.slice(0, 140));
  }
  for (const entry of Array.isArray(completedWork) ? completedWork : []) {
    const target = String(entry?.target || '').replace(/\s+/g, ' ').trim();
    if (target && !/^viewport (?:point|drag)\b/i.test(target) && !names.some((item) => item.toLowerCase() === target.toLowerCase())) names.push(target.slice(0, 140));
  }
  return names.slice(-12);
}

function compactRepairObservation(context) {
  const observation = context?.observation;
  const dom = observation?.dom && typeof observation.dom === 'object' ? observation.dom : {};
  const taskTokens = repairTokens(context?.task);
  const completedControls = completedRepairControls(context?.history, context?.state?.completedWork);
  const completedKeys = new Set(completedControls.map((name) => name.toLowerCase()));
  const rankedElements = (Array.isArray(dom.elements) ? dom.elements : []).map((element, order) => {
    const name = String(element?.name || '').replace(/\s+/g, ' ').trim();
    const searchable = `${name} ${element?.text || ''} ${element?.role || ''} ${element?.tag || ''}`.toLowerCase();
    const overlap = taskTokens.reduce((score, token) => score + (searchable.includes(token) ? 4 : 0), 0);
    const interactive = ['button', 'input', 'textarea', 'select', 'a'].includes(String(element?.tag || '').toLowerCase()) || /button|textbox|link|menuitem|tab/i.test(String(element?.role || ''));
    const completed = completedKeys.has(name.toLowerCase());
    return { element, order, completed, score: overlap + (interactive ? 2 : 0) + (element?.enabled === false ? -20 : 0) + (completed ? -8 : 0) };
  }).sort((left, right) => right.score - left.score || left.order - right.order).slice(0, 40);
  return {
    navigation: observation?.navigation ? {
      url: observation.navigation.url,
      title: observation.navigation.title,
      loading: Boolean(observation.navigation.loading)
    } : null,
    dom: {
      url: dom.url,
      title: dom.title,
      viewport: dom.viewport,
      landmarks: Array.isArray(dom.landmarks) ? dom.landmarks.slice(0, 12) : [],
      elements: rankedElements.map(({ element, completed }) => ({
        index: element?.index,
        tag: element?.tag,
        role: element?.role,
        name: String(element?.name || '').slice(0, 140),
        text: String(element?.text || '').slice(0, 140),
        enabled: element?.enabled,
        pressed: element?.pressed,
        selected: element?.selected,
        expanded: element?.expanded,
        rect: element?.rect,
        completed
      })),
      regions: Array.isArray(dom.regions) ? dom.regions.slice(0, 16) : []
    },
    ...(observation?.desktop ? { desktop: observation.desktop } : {}),
    ...(observation?.screenshot?.captured ? { screenshot: observation.desktop ? observation.screenshot : { captured: true } } : {}),
    completedControls
  };
}

function actionOnlyRepairPrompt(context, invalidResponse, tools) {
  // A failed call is banned ONLY after a real dead end — the page itself
  // refused it (constraint tamper). Everything else is a malfunction: stale
  // coordinates, bad arguments, a cancelled drag — the right recovery is the
  // IDENTICAL call with corrected arguments, not a different approach. The
  // previous contract grouped stale_element and duplicate_action in with the
  // dead ends, so a correct move with old coordinates was abandoned instead of
  // re-issued.
  const failedAction = String(context.recovery?.action || '').trim();
  const recoverySource = String(context.recovery?.source || '');
  const confirmedDeadEnd = recoverySource === 'constraint_tamper';
  const alreadyDone = recoverySource === 'duplicate_action';
  // Both cases mean the exact call cannot advance (the page refused it, or it
  // already succeeded once). Everything else is a malfunction: stale
  // coordinates, bad arguments, a cancelled drag — the right recovery is the
  // IDENTICAL call with corrected arguments, not a different approach.
  const disallowedActions = new Set(failedAction && (confirmedDeadEnd || alreadyDone) ? [failedAction] : []);
  const disallowedAction = (confirmedDeadEnd || alreadyDone) ? (failedAction || null) : null;
  const disallowedList = [...disallowedActions];
  const retryAllowed = Boolean(failedAction) && !confirmedDeadEnd && !alreadyDone;
  const completionReview = recoverySource === 'completion_review';
  return {
    instruction: `Return exactly one advancing browser action or done JSON now. observation.dom.elements is a goal-ranked list of enabled numbered controls; observation.dom.regions holds viewport rectangles for large visible interaction surfaces. Pick the highest relevant unfinished control (completed means that exact action succeeded, not the goal). If a tool button is visibly selected or placement guidance is shown, supply the missing coordinate click or browser_drag inside a region. Completed actions, prior errors, and unchanged results are evidence for the NEXT action — act on what you see; re-inspect only if state genuinely changed or was never observed. No explanations, task restatement, re-inspection requests, or intentions.${disallowedList.length ? (alreadyDone ? ` Do not repeat ${disallowedList.join(', ')} — that call already succeeded once; advance to the next untested part of the goal.` : ` Disallowed this decision: ${disallowedList.join(', ')} — the page itself refused this call (${recoverySource}), a confirmed dead end; pick a different approach.`) : retryAllowed ? ` Your last ${failedAction} call malfunctioned: correct the arguments and RE-ISSUE the same call — a malfunction is not a dead end; change approach only if the corrected retry also fails.` : ''} Act the moment a correct decision is known — never reopen a settled choice with "but wait", "hmm", theories, or speculation; think while working (batch independent calls in one response), not before. Treat the recovery error as the description of your last failed step.${completionReview ? ' Completion review: audit the whole goal; choose a missing action or set done.verified=true.' : ''} Final non-activating pointer placement → browser_mousemove then done in one response. Use exact underscore-separated tool names. Observation answers an informational question or the goal is complete → {"done":{"summary":"...","success":true,"verified":true}}. Only {"done":{"summary":"...","success":false,"final":true}} when evidence proves an external block requiring the user.`,
    disallowedAction,
    disallowedActions: disallowedList,
    task: String(context.task || ''),
    observation: compactRepairObservation(context),
    history: context.history.slice(-4),
    recovery: context.recovery,
    tools: Array.isArray(tools) ? tools : (Array.isArray(context.tools) ? context.tools : []),
    invalidResponse: String(invalidResponse || '').slice(0, 600)
  };
}

function normalizeNativeToolCalls(calls) {
  if (!Array.isArray(calls)) return [];
  return calls.map((call) => {
    let input = call?.function?.arguments ?? call?.arguments ?? call?.input ?? {};
    // OpenAI-compatible streaming delivers tool arguments as a JSON string.
    if (typeof input === 'string') {
      try { input = JSON.parse(input || '{}'); } catch { input = {}; }
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
    // Responses/continuity consumers match results by call ID; preserve it when present.
    const callId = call?.callId || call?.id || call?.call_id;
    return { name: String(call?.function?.name || call?.name || ''), input,
      ...(typeof callId === 'string' && callId ? { callId } : {}) };
  }).filter((call) => call.name);
}

function boundedProof(proof) {
  if (proof === undefined || proof === null) return undefined;
  try {
    const serialized = JSON.stringify(proof);
    if (serialized.length <= 6_000) return proof;
    return { truncated: true, preview: serialized.slice(0, 6_000), notice: `Proof was ${serialized.length} chars; only the first 6000 are retained in history. Re-run the tool if you need content beyond this preview.` };
  } catch {
    return { notice: 'The page command proof could not be serialized.' };
  }
}

function compactComputerOutput(output, tool) {
  const contextTruncation = [];
  // computer_read returns whole-file content and computer_index returns the
  // repo map — both are payloads the model must quote or navigate by. The
  // shared 16k bound cut a 1,200-line file to roughly a third while the
  // executor metadata still said truncated:false, and cut the index map so
  // hard the model re-ran it. Both get a dedicated budget; every other
  // computer_* output keeps the tight bound.
  let remainingText = (tool === 'computer_read' || tool === 'computer_index') ? 64_000 : 16_000;
  let remainingNodes = 2_000;
  const payloadFields = new Set(['output', 'content', 'history', 'text']);
  function bound(value, field = '', depth = 0) {
    if (typeof value === 'string') {
      const kept = Math.min(value.length, remainingText);
      remainingText -= kept;
      if (kept < value.length) {
        contextTruncation.push({
          field, originalCharacters: value.length, retainedCharacters: kept,
          ...(field === 'result.content' && tool === 'computer_read'
            ? { note: 'The context bound trimmed this content. Re-read the file with computer_read and an offset just past the last retained line for the omitted part.' }
            : {})
        });
      }
      return value.slice(0, kept);
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > 8 || --remainingNodes < 0) {
      contextTruncation.push({ field, reason: 'context structure limit' });
      return { contextOmitted: true };
    }
    if (Array.isArray(value)) {
      const kept = Math.min(value.length, 64);
      if (kept < value.length) contextTruncation.push({ field, originalItems: value.length, retainedItems: kept });
      return value.slice(0, kept).map((item, index) => bound(item, `${field}[${index}]`, depth + 1));
    }
    // Keep identities, status and paging fields before large payload text.
    const entries = Object.entries(value).sort(([left], [right]) => Number(payloadFields.has(left)) - Number(payloadFields.has(right)));
    return Object.fromEntries(entries.filter(([key]) => !(tool === 'computer_screenshot' && field === 'result' && key === 'data'))
      .map(([key, item]) => [key, bound(item, field ? `${field}.${key}` : key, depth + 1)]));
  }
  const compact = bound(output);
  return contextTruncation.length ? { ...compact, contextTruncation } : compact;
}

function compactHistoryOutput(output, tool) {
  if (!output || typeof output !== 'object') return output;
  if (isComputerTool(tool)) return compactComputerOutput(output, tool);
  if (output.observation) return { ok: output.ok, observation: { navigation: output.observation.navigation, dom: compactObservation(output.observation).dom, screenshot: screenshotMetadata(output.observation.screenshot) } };
  const result = output.result;
  if (Array.isArray(result)) {
    // browser_tabs is a complete, bounded answer in itself. Preserve it in the
    // model's next-turn context instead of reducing it to an empty object.
    return { ok: output.ok, error: output.error, result: result.slice(0, 20).map((tab) => ({ id: tab.id, title: tab.title, url: tab.url, loading: tab.loading })), ...(result.length > 20 ? { shownTabs: 20, totalTabs: result.length, notice: `${result.length - 20} older tabs omitted from history; re-run browser_tabs for the live list.` } : {}) };
  }
  if (!result || typeof result !== 'object') return output;
  // browser_execute returns its proof under result.result. Dropping it erased
  // the model's own computed data from the next-turn history, which read as
  // "the sweep returned nothing" and triggered identical re-runs.
  // LORDE_PROOF_FIRST_V367 reconciliation — the live tool result now carries
  // the script proof FLATTENED at result top level (desktopChatAgent), so
  // read it from either shape; boundedProof caps serialization at 6k and
  // preserves every custom proof key the whitelist doesn't know.
  const proof = boundedProof(result.result !== undefined ? result.result : result);
  const compact = {
    ok: output.ok,
    error: output.error,
    result: {
      tabId: result.tabId,
      url: result.url,
      title: result.title,
      index: result.index,
      input: result.input,
      length: result.length,
      changed: result.changed,
      matched: result.matched,
      valueLength: result.valueLength,
      waitedMs: result.waitedMs,
      moved: result.moved,
      before: result.before,
      after: result.after,
      query: result.query,
      // Dedicated file tools (computer_read/write/search/fs): keep the
      // structured evidence the model needs to continue file work — dropping
      // it made every file decision read as "nothing was found".
      tool: result.tool,
      path: result.path,
      action: result.action,
      encoding: result.encoding,
      content: typeof result.content === 'string' ? result.content.slice(0, 12_000) : result.content,
      bytesRead: result.bytesRead,
      bytes: result.bytes,
      written: result.written,
      size: result.size,
      totalLines: result.totalLines,
      fromLine: result.fromLine,
      toLine: result.toLine,
      lines: Number.isFinite(Number(result.lines)) ? result.lines : undefined,
      nextOffset: result.nextOffset,
      offset: result.offset,
      truncated: result.truncated,
      matches: result.matches,
      totalFiles: result.totalFiles,
      engine: result.engine,
      outputMode: result.outputMode,
      root: result.root,
      pattern: typeof result.pattern === 'string' ? result.pattern.slice(0, 300) : undefined,
      notice: result.notice,
      files: Array.isArray(result.files) ? result.files.slice(0, 40) : undefined,
      elements: Array.isArray(result.elements) ? result.elements.slice(0, 20) : undefined,
      element: result.element ? { tag: result.element.tag, name: result.element.name, text: result.element.text, href: result.element.href, dataTool: result.element.dataTool, pressed: result.element.pressed, selected: result.element.selected, expanded: result.element.expanded } : undefined,
      ...(proof !== undefined ? { proof } : {})
    }
  };
  // LORDE_NO_SILENT_TRUNCATION_V368 — whitelist keys the whitelist doesn't
  // know are preserved via a bounded catch-all instead of vanishing.
  const known = new Set(Object.keys(compact.result));
  const unlisted = Object.fromEntries(Object.entries(result).filter(([k]) => !known.has(k)));
  if (Object.keys(unlisted).length) {
    const carried = boundedProof(unlisted);
    if (carried !== undefined) compact.result.unlisted = carried;
  }
  // Undefined-valued whitelist keys are dropped: they bloat every subsequent
  // request and read as noise against clean evidence in diagnostics.
  compact.result = Object.fromEntries(Object.entries(compact.result).filter(([, v]) => v !== undefined));
  return compact;
}

function compactDesktop(desktop) {
  if (!desktop || !Array.isArray(desktop.windows)) return desktop;
  const windows = [...desktop.windows].sort((a, b) => Number(b.id === desktop.foregroundWindowId) - Number(a.id === desktop.foregroundWindowId));
  return { ...desktop, windows: windows.map((window, index) => ({
    id: window.id, title: String(window.title || '').slice(0, 160), pid: window.pid, minimized: window.minimized,
    ...(String(window.title || '').length > 160 ? { titleTruncated: true } : {}),
    ...(index < 8 ? { bounds: window.bounds } : { geometryOmitted: true })
  })), ...(windows.length > 8 ? { windowDetailNotice: 'Background window geometry is omitted from this context only. computer_window list returns full current details; never invent bounds for a summarized window.' } : {}) };
}

function compactObservation(observation) {
  if (!observation || typeof observation !== 'object') return observation;
  const dom = observation.dom && typeof observation.dom === 'object' ? observation.dom : {};
  return {
    navigation: observation.navigation,
    ...(observation.desktop ? { desktop: compactDesktop(observation.desktop) } : {}),
    dom: {
      url: dom.url,
      title: dom.title,
      viewport: dom.viewport,
      truncated: Boolean(dom.truncated),
      landmarks: Array.isArray(dom.landmarks) ? dom.landmarks.slice(0, 20).map((landmark) => ({
        tag: landmark?.tag,
        role: landmark?.role,
        label: landmark?.label,
        text: String(landmark?.text || '').slice(0, 240)
      })) : [],
      visualTargets: Array.isArray(dom.visualTargets) ? dom.visualTargets.slice(0, 96) : [],
      regions: Array.isArray(dom.regions) ? dom.regions.slice(0, 16).map((region) => ({
        kind: region?.kind,
        name: String(region?.name || '').slice(0, 120),
        rect: region?.rect,
        center: region?.center,
        childCount: region?.childCount,
        descendantCount: region?.descendantCount
      })) : [],
      elements: Array.isArray(dom.elements) ? dom.elements.slice(0, 120) : []
    },
    // NAMING INTEGRITY (owner directive 2026-10-15): the model must describe
    // its evidence by what it actually is — a DOM capture (structured text)
    // is NEVER a screenshot, to the user or in its own reasoning. The kind
    // rides the wire every decision; citation honesty is separately enforced
    // by unbackedActionClaims (only real captures back "screenshot" claims).
    evidenceKind: observation.screenshot
      ? 'screenshot — real rendered pixels'
      : 'dom-capture — structured text, NOT a screenshot',
    evidenceKindNote: 'Name your evidence honestly: say "DOM capture" for text evidence; never say you took a screenshot unless evidenceKind says real rendered pixels.',
    // Owner directive: console/network ride ONLY as filtered, framed
    // diagnostics (see buildDiagnostics) — never raw, never as page state.
    ...buildDiagnostics(observation),
    ...(observation.screenshot ? { screenshot: screenshotMetadata(observation.screenshot) } : {})
  };
}

function screenshotMetadata(screenshot) {
  if (!screenshot || typeof screenshot !== 'object') return undefined;
  return { captured: true, tabId: screenshot.tabId, mimeType: screenshot.mimeType, source: screenshot.source,
    ...(screenshot.source === 'native-desktop' ? { screenshotId: screenshot.screenshotId, displayId: screenshot.displayId, width: screenshot.width, height: screenshot.height, origin: screenshot.origin, scaleX: screenshot.scaleX, scaleY: screenshot.scaleY, capturedAt: screenshot.capturedAt, coordinateSpace: 'screenshot-pixels', pointerMapping: 'Use coordinateSpace=screenshot with this screenshotId to send image pixels directly; omit both only for physical desktop pixels.' } : {}) };
}

// CONSOLE/NETWORK ARE DIAGNOSTICS, NEVER PAGE-STATE EVIDENCE (owner directive).
// The wire used to carry info-level console chatter and EVERY completed
// request (`GET 200` lines from onCompleted) unframed on every decision, and
// the model read that traffic as page state — claiming "the page is still
// loading" for minutes while the page had long settled (navigation.loading
// was false the whole time). Two hard fixes:
//   1. FILTER — only actionable severity survives: console errors and
//      failed/4xx-5xx requests. Info logs and successful requests never ride
//      the wire again, so the loading-chatter fuel is gone entirely.
//   2. FRAME — what survives sits under `diagnostics` with a binding note:
//      dom + screenshot are the page's truth; console is for debugging a
//      failure you can already see, or OCR-class text the DOM lacks.
function buildDiagnostics(observation) {
  const consoleErrors = (Array.isArray(observation?.consoleEntries) ? observation.consoleEntries : [])
    .filter((entry) => String(entry?.level) === 'error' || String(entry?.kind) === 'error')
    .slice(0, 5)
    .map((entry) => ({ level: entry.level, message: String(entry?.message || '').slice(0, 300), url: String(entry?.url || '').slice(0, 200) }));
  const networkErrors = (Array.isArray(observation?.networkEntries) ? observation.networkEntries : [])
    .filter((entry) => String(entry?.level) === 'error' || Number(entry?.statusCode) >= 400)
    .slice(0, 5)
    .map((entry) => ({ level: entry.level, message: String(entry?.message || '').slice(0, 300), url: String(entry?.url || '').slice(0, 200), statusCode: entry.statusCode }));
  if (!consoleErrors.length && !networkErrors.length) return {};
  return {
    diagnostics: {
      note: 'Console and network errors are DEBUGGING aids only — NEVER evidence of what the page shows or whether it finished loading; console errors are often stale, third-party, or cosmetic. Page-state claims (loading/settled/empty/broken) come ONLY from dom and the screenshot; navigation.loading is the harness ground truth for load state. Read browser_console_entries only to diagnose a failure you can already see, or for OCR-class text the DOM does not carry.',
      consoleErrors,
      networkErrors
    }
  };
}

function redactHistoryInput(tool, input) {
  if (tool !== 'browser_type' && tool !== 'browser_fill') return input;
  return { ...input, text: `[${String(input?.text || '').length} characters]` };
}

function normalizedBoundedMessage(message) {
  return typeof message === 'string'
    ? { role: 'user', content: message }
    : { role: message?.role === 'assistant' ? 'assistant' : 'user', content: String(message?.content || ''), ...(message?.id ? { id: message.id } : {}), ...(message?.at ? { at: message.at } : {}) };
}

function boundedMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Runtime notices are control-plane events, not user conversation. Claude
  // Code/Codex keep them in structured turn state; feeding them back as user
  // turns made Browser-use re-read recovery notices and guess from its own noise.
  const conversation = messages.filter((message) => message?.source !== 'runtime');
  const selected = conversation.length <= 12 ? conversation : [conversation[0], ...conversation.slice(-11)];
  return selected.map(normalizedBoundedMessage).filter((message) => message.content);
}

function boundedRuntimeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Keep only the NEWEST notice of each kind (same leading label), so stale
  // nudges, skill hints and old turn notices are not replayed every turn.
  const kindOf = (text) => {
    const head = String(text || '').split('\n')[0];
    const label = head.split(/[:—]/)[0].trim().toLowerCase();
    return /^(user addition|new user message)/.test(label) ? 'turn-notice' : label.slice(0, 60);
  };
  const seen = new Set();
  const newestFirst = [];
  const runtime = messages.filter((message) => message?.source === 'runtime');
  for (let i = runtime.length - 1; i >= 0 && newestFirst.length < 8; i -= 1) {
    const content = String(runtime[i]?.content || '').slice(0, 2_000);
    if (!content) continue;
    const kind = kindOf(content);
    if (seen.has(kind)) continue;
    seen.add(kind);
    newestFirst.push({ content, source: 'runtime' });
  }
  return newestFirst.reverse();
}

function compactProgressItems(items) {
  return Array.isArray(items) ? items.slice(0, 100).map(item => ({
    ...(item?.id ? { id: item.id } : {}), text: String(item?.text || '').slice(0, 500), status: item?.status,
    verification: String(item?.verification || '').slice(0, 500), ...(item?.goalId ? { goalId: item.goalId } : {})
  })) : [];
}

function boundedCoordinator(coordinator, plan, goals) {
  return {
    facts: Array.isArray(coordinator?.facts) ? coordinator.facts.slice(-12) : [],
    observationRevision: coordinator?.observationRevision || 0,
    duplicateBlocks: coordinator?.duplicateBlocks || 0,
    replansWithoutProgress: coordinator?.replansWithoutProgress || 0,
    lastMutation: coordinator?.lastMutation ? {
      action: String(coordinator.lastMutation.hash || '').slice(0, 500),
      succeeded: coordinator.lastMutation.ok === true,
      visibleEffectObserved: coordinator.lastMutation.effectObserved === true,
      awaitingObservation: coordinator.lastMutation.awaitingObservation === true,
      expectedOutcome: String(coordinator.lastMutation.expectedOutcome || '').slice(0, 500)
    } : null,
    completedWork: Array.isArray(coordinator?.completedWork) ? coordinator.completedWork.slice(-32).map((entry) => ({
      action: String(entry?.action || '').slice(0, 80),
      target: String(entry?.target || '').slice(0, 160),
      expectedOutcome: String(entry?.expectedOutcome || '').slice(0, 500),
      effectObserved: entry?.effectObserved === true,
      observedRevision: Number(entry?.observedRevision || 0)
    })) : [],
    plan: compactProgressItems(plan),
    ...(Array.isArray(goals) && goals.length ? { goals: compactProgressItems(goals) } : {})
  };
}

function boundedAttachments(attachments) {
  // No count cap: every attached file flows; the per-text budget below adapts to the count.
  const selected = Array.isArray(attachments) ? attachments : [];
  const textCount = selected.filter(item => item?.kind === 'text').length;
  const perTextLimit = Math.floor(120_000 / Math.max(1, textCount));
  return selected.map(attachment => {
    // Filesystem-sourced attachments ride as SOURCE PATHS (owner directive):
    // no content is inlined — the model reads the path with its own file
    // tools, which have no size or count limits. Folders carry isDirectory.
    if (attachment?.kind === 'path') {
      return {
        name: String(attachment?.name || 'attachment').slice(0, 160),
        kind: 'path',
        mimeType: String(attachment?.mimeType || '').slice(0, 100),
        size: Number(attachment?.size) || 0,
        path: String(attachment?.path || '').slice(0, 500),
        isDirectory: attachment?.isDirectory === true,
        note: attachment?.isDirectory === true
          ? 'Attached FOLDER delivered as its source path only — nothing was copied. List and read its contents directly with your file tools (computer_read / computer_search / computer_index / terminal); there are no size or count limits. Never claim the folder is missing or unreadable without actually trying.'
          : 'Attached file delivered as its source path only — nothing was copied. Read it directly with your file tools (computer_read / computer_search / terminal); there are no size limits. Never claim the file is missing without actually trying.'
      };
    }
    if (attachment?.kind !== 'text') return { name: String(attachment?.name || 'attachment').slice(0, 160), kind: 'image', mimeType: String(attachment?.mimeType || '').slice(0, 100), size: Number(attachment?.size) || 0, note: 'Image content is supplied through the provider image input.' };
    const original = String(attachment.content || '');
    const content = original.slice(0, perTextLimit);
    return { name: String(attachment.name || 'attachment').slice(0, 160), kind: 'text', mimeType: String(attachment.mimeType || 'text/plain').slice(0, 100), size: Number(attachment.size) || 0, content,
      ...(content.length < original.length ? { truncated: true, originalCharacters: original.length, note: 'Only the beginning is included. Do not claim to have read the omitted content.' } : {}) };
  });
}

function boundedRequestContext({ task, agentIdentity, attachments, observation, observationUnchanged, history, tools, messages, coordinator, plan, goals, recovery, workingMemory, interactionMemory, researchHint, agentMessages, harnessNotices, workspace, layaVerification, delegatedVision }) {
  const completedWork = Array.isArray(coordinator?.completedWork) ? coordinator.completedWork : [];
  // The done-list is the anti-repeat spine: an explicit, model-facing ledger
  // of every successful (action, target) pair, phrased as a directive rather
  // than passive data the model can skim past.
  const doneTargets = completedWork
    .slice(-24)
    .map((entry) => {
      // '✓' means the mutation's effect was confirmed by a later observation;
      // '…' means it ran but no fresh evidence has confirmed the change yet.
      const verified = entry?.effectObserved === true ? '✓' : '…';
      return `${verified} ${String(entry?.action || '').replace(/^browser_/, '')} ${String(entry?.target || '').slice(0, 60)}`.trim();
    })
    .filter(Boolean);
  const planSteps = Array.isArray(plan) ? plan : [];
  const currentStep = planSteps.find((step) => step?.status === 'current')?.text
    || planSteps.find((step) => step?.status === 'pending')?.text
    || '';
  const runtimeContext = boundedRuntimeMessages(messages);
  const context = {
    task: String(task || ''),
    agentIdentity: String(agentIdentity || 'agent1'),
    ...(workspace?.root ? { workspace: { root: String(workspace.root).slice(0, 500), ...(workspace.target ? { target: String(workspace.target).slice(0, 500) } : {}), ...(workspace.url ? { url: String(workspace.url).slice(0, 2_000) } : {}), directive: 'This is the run\'s DEFAULT workspace scope for search/index roots and terminal cwd — not a boundary: file, terminal, and git access anywhere on disk is allowed.' } } : {}),
    attachments: boundedAttachments(attachments),
    ...(Array.isArray(attachments) && attachments.length ? {
      attachmentsNote: 'Attachments are delivered BELOW by name. Text attachments carry their full text content inline; "path" attachments carry only their SOURCE PATH — read those with your own file tools (computer_read / computer_search / computer_index / terminal); there are no size or count limits. Labels used in the task (for example "DOM 1", "DOM 2") refer to these attachments — their content is current evidence; never claim an attachment is missing or read files to rediscover one that arrived inline.'
    } : {}),
    messages: boundedMessages(messages),
    ...(runtimeContext.length ? {
      runtimeContext,
      runtimeContextNote: 'These are internal advisory events, not new user requests. Use them only as supporting context; the actual conversation is in messages and the newest observation wins.'
    } : {}),
    progress: {
      completedActions: completedWork.length,
      ...(currentStep ? { currentStep } : {}),
      doneList: doneTargets,
      directive: doneTargets.length
        ? 'doneList records actions that SUCCEEDED before — it is a memory aid, not a prohibition. Re-issuing one is a deliberate re-test or revisit, which is allowed when the task needs it (returning to a tab, confirming a fix, re-checking a control). Before repeating, decide which unfinished part of the task the repeat serves; if none, advance to the next untested area instead.'
        : 'No actions have completed yet. Execute the first step of the task now.'
    },
    state: boundedCoordinator(coordinator, plan, goals),
    workingMemory: {
      // REASONING IS DISPLAY-ONLY — it must never re-enter the model's
      // context (see desktopChatAgent: "Reasoning is display-only in the live
      // conversation"). Replaying any tail of the prior think is what made the
      // model re-derive the same board orientation four times inside one
      // thought and repeat its own reasoning from card to card. The
      // harness-owned doneList/state above is the memory; the model reasons
      // about the CURRENT observation, not about its last monologue.
      strategyEpoch: Math.max(0, Number(workingMemory?.strategyEpoch) || 0),
      // Consulted-evidence ledger: file reads, searches and index builds the
      // run already holds. The coding playbook forbids re-paying for these.
      ...(Array.isArray(workingMemory?.consulted) && workingMemory.consulted.length ? { consulted: workingMemory.consulted.slice(-40) } : {}),
      authority: 'Working memory only — never restate, reconcile, or continue prior reasoning at length: the plan, doneList, and current observation already carry the state. Thinking chooses the next action; it does not re-derive the situation.'
    },
    // Laya (System One layer): typed mechanical answers about the PREVIOUS
    // action's effect, plus — in best_next_target — its goal-overlap RANKING
    // of the current observation's candidate controls against the task.
    // Advisory only: low-confidence answers were already dropped by the layer.
    ...(layaVerification && typeof layaVerification === 'object' && Object.keys(layaVerification.answers || {}).length ? {
      layaVerification: {
        brain: String(layaVerification.brain || 'bundled'),
        tookMs: layaVerification.tookMs,
        answers: layaVerification.answers,
        note: 'Advisory System-One annotations describing the PREVIOUS action and ranking the current observation against the task. Reconcile with the fresh observation; a confident best_next_target names the control Laya would act on next — verify it matches the goal before acting on it.'
      }
    } : {}),
    // Model-controlled research: the harness only HINTS that a native program
    // is unknown to the brain; the model decides whether research_task is
    // worth spending on it.
    ...(researchHint?.program ? {
      researchHint: {
        program: String(researchHint.program).slice(0, 120),
        objective: String(researchHint.objective || '').slice(0, 600),
        note: 'This program is not yet in the knowledge brain. If its controls are proving hard to drive, you may call research_task with this objective; deciding whether to research is yours.'
      }
    } : {}),
    // VISION DELEGATE: the active model cannot see images (rejected twice /
    // text-only), so a vision-capable model on the SAME connection described
    // the current screenshot. This TEXT is the visual evidence — act on it
    // like you saw the image; the run's model never changed.
    ...(delegatedVision && typeof delegatedVision === 'object' ? {
      delegatedVision: {
        via: String(delegatedVision.via || '').slice(0, 120),
        description: String(delegatedVision.description || '').slice(0, 8000),
        note: 'A vision-capable model on this connection described the screenshot because THIS model is text-only. Treat the description as the image evidence; do not request screenshots again expecting to see pixels yourself.'
      }
    } : {}),
    // Cross-session coordination: messages delivered by other live sessions,
    // routed into THIS one decision. Reply with agent_message when a reply
    // helps the other session coordinate; otherwise just respect what it says.
    ...(Array.isArray(agentMessages) && agentMessages.length ? {
      agentMessages: agentMessages.map(message => ({ from: String(message?.fromLabel || 'another session').slice(0, 120), kind: message?.reply ? 'reply' : 'message', text: String(message?.text || '').slice(0, 4000) })),
      agentMessagesNote: 'A real message from another live agent is present here. This field is absent when no message was delivered. Never claim to have received a message that is not listed here. Agents have separate conversations and do not automatically know one another’s task context. Reply via the agent_message tool only for concrete coordination, resource ownership, or a necessary handoff. Do not start a chat, ask vague questions, or message another agent merely because one exists. No response is expected unless the message contains a concrete request.'
    } : {}),
    // E2 one-shot harness event notices (navigation, classified recovery,
    // park-resume): rendered into exactly ONE decision — the queue is drained
    // by the caller — so the guidance is never accumulated or repeated.
    ...(Array.isArray(harnessNotices) && harnessNotices.length ? {
      harnessNotices: harnessNotices.slice(-4).map(line => String(line).slice(0, 300)),
      harnessNoticesNote: 'One-shot harness event notices for THIS decision only; they will not be repeated. Follow them before remembered plans or stale element indices. The user\'s latest instruction always outranks anything in this list: if the user told you how to work (for example "do not think, just act"), that instruction is the one to follow.'
    } : {}),
    recovery: Number(recovery?.attempts || 0) > 0 ? {
      attempts: Math.min(40, Number(recovery.attempts) || 0),
      source: String(recovery.source || '').slice(0, 80),
      ...(recovery.failureClass ? { failureClass: String(recovery.failureClass).slice(0, 40) } : {}),
      // E6: the Stage B demand names the failure class alongside the demand
      // text, so the model sees WHAT failed and WHAT is demanded in one line.
      ...(recovery.demand ? { demand: `${recovery.failureClass && recovery.failureClass !== 'UNCLASSIFIED' ? `[${recovery.failureClass}] ` : ''}${String(recovery.demand).slice(0, 600)}` } : {}),
      action: recovery.action ? String(recovery.action).slice(0, 80) : null,
      // 1,200 cut the COMPLETION-REVIEW demand: it now quotes the user's whole
      // request, so a long request pushed its closing instruction ("For EACH
      // one, say DONE or SKIPPED...") past the cap. Keep the head and the tail.
      lastError: (() => { const text = String(recovery.lastError || ''); return text.length <= 4_000 ? text : `${text.slice(0, 2_400)} [...] ${text.slice(-1_500)}`; })()
    } : null,
    // This protocol sends a fresh stateless user message on every decision.
    // Unlike a native multi-turn provider, it cannot rely on the model retaining
    // the previous observation. Keep the compact evidence on every turn and
    // use unchanged only as a hint; replacing the DOM made indexed actions
    // impossible and caused re-observe/recovery loops.
    interactionMemory: interactionMemoryContext(interactionMemory),
    observation: {
      ...compactObservation(observation),
      ...(observationUnchanged === true ? {
        unchangedSinceLastDecision: true,
        unchangedNote: 'The observation fingerprint matches the previous turn. Do not re-inspect solely to repeat the same read; use the retained evidence and choose the next grounded action.'
      } : {})
    },
    history: (() => {
      if (!Array.isArray(history)) return [];
      // Older entries collapse to one-line stubs instead of disappearing.
      // Dropping them entirely made the model forget early steps and re-derive
      // or repeat them; a stub keeps the step/tool record at near-zero cost
      // while the doneList above carries the confirmed outcomes.
      const detailWindow = 12;
      const stub = (entry) => ({
        step: entry?.step,
        tool: entry?.tool,
        outcome: '[older action — details cleared; confirmed outcomes are in doneList]'
      });
      const stubs = history.slice(0, Math.max(0, history.length - detailWindow)).map(stub);
      const detailed = history.slice(-detailWindow).map((entry) => ({
        step: entry?.step,
        tool: entry?.tool,
        ...(entry?.callId ? { callId: entry.callId } : {}),
        input: redactHistoryInput(entry?.tool, entry?.input),
        expect: entry?.expect || null,
        repeat: entry?.repeat === true,
        ...(entry?.note ? { note: String(entry.note).slice(0, 400) } : {}),
        output: compactHistoryOutput(entry?.output, entry?.tool)
      }));
      return [...stubs, ...detailed];
    })(),
    // The schemas ride here as well as in the system message because the
    // JSON-fallback request has no native `tools` field to carry them (see
    // "native-tool fallback retains textual schemas"): a text-only retry must
    // still see the catalog. Native requests strip this field at the provider.
    tools: Array.isArray(tools) ? tools : []
  };
  // Avoid hidden large payload growth from future tool extensions.
  const serialized = JSON.stringify(context);
  const compactMessages = context.messages.length <= 4 ? context.messages : [context.messages[0], ...context.messages.slice(-3)];
  return serialized.length <= 300_000 ? context : { ...context, history: context.history.slice(-6), messages: compactMessages, runtimeContext: context.runtimeContext?.slice(-4) || [] };
}

function listModelNames(payload) {
  return Array.isArray(payload?.models)
    ? payload.models.map((model) => String(model?.name || model?.model || '').trim()).filter(Boolean)
    : [];
}

function modelIsInstalled(model, installedModels) {
  const requested = String(model || '').trim();
  const requestedBase = requested.split(':')[0];
  return installedModels.some((installed) => installed === requested || installed.split(':')[0] === requestedBase);
}

async function preflightOllama({ baseUrl = DEFAULT_BASE_URL, model, fetchImpl = globalThis.fetch, signal, timeoutMs = 20_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('Ollama is unavailable because fetch is not supported in this runtime.');
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const selectedModel = String(model || '').trim();
  if (!selectedModel) throw new Error('Choose an Ollama model before starting the browser agent.');

  const deadline = createDeadlineSignal(signal, timeoutMs, 'Ollama preflight timed out');
  try {
    const tags = await requestJson(fetchImpl, `${normalizedBaseUrl}/api/tags`, { signal: deadline.signal }, 'Ollama model discovery');
    const installedModels = listModelNames(tags);
    if (!modelIsInstalled(selectedModel, installedModels)) {
      throw new Error(`The selected Ollama model "${selectedModel}" is not installed. Run: ollama pull ${selectedModel}`);
    }

    const completion = await requestJson(fetchImpl, `${normalizedBaseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: deadline.signal,
      body: JSON.stringify({
        model: selectedModel,
        stream: false,
        format: 'json',
        messages: [{ role: 'user', content: PREFLIGHT_SCHEMA_PROMPT }]
      })
    }, 'Ollama structured-output check');
    const parsed = parseAgentResponse(completion?.message?.content);
    const structuredAction = parsed.toolCalls?.[0]?.name || '';
    if (!structuredAction) throw new Error(`The selected Ollama model "${selectedModel}" did not return a structured browser action.`);

    return { ok: true, baseUrl: normalizedBaseUrl, model: selectedModel, installedModels, structuredAction };
  } finally {
    deadline.dispose();
  }
}

function createDeadlineSignal(parentSignal, timeoutMs, label) {
  const controller = new AbortController();
  const timeout = Math.max(1, Number(timeoutMs) || 1);
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const onParentAbort = () => abort(parentSignal.reason || new Error('Ollama preflight was cancelled.'));
  if (parentSignal) {
    if (parentSignal.aborted) onParentAbort();
    else parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => abort(new Error(`${label} after ${timeout}ms.`)), timeout);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onParentAbort);
    }
  };
}

function ollamaVisualEvidence(observation) {
  let data = String(observation?.screenshot?.data || '').trim();
  if (!data) return null;
  const dataUrl = data.match(/^data:[^;,]+;base64,([a-z0-9+/=\s]+)$/i);
  if (dataUrl) data = dataUrl[1].replace(/\s+/g, '');
  // file://, content://, and blob: references are client-local and cannot be
  // read by the server; they must never become Ollama image payloads.
  if (!/^[a-z0-9+/]+={0,2}$/i.test(data)) return null;
  return data.length <= 20_000_000 ? data : null;
}

function ollamaRejectedVisual(error) {
  const text = String(error?.message || error || '');
  if (/(?:temporarily|unavailable|timeout|overloaded|rate.?limit|try again)/i.test(text)) return false;
  return /(?:image input|images? (?:are|is) not supported|(?:does not|cannot|can't)\s+(?:accept|process|see|view)\s+(?:an?\s+)?image|vision input (?:is )?not supported)/i.test(text);
}

function ollamaDeclaresVisualUnsupported(payload) {
  const text = String(payload?.message?.content || '');
  if (/\b(?:i\s+can\s+see|shows?|depicts?|visible|displayed)\b/i.test(text)
      && /\b(?:image|screenshot|screen|window|button|dialog)\b/i.test(text)) return false;
  return /\b(?:(?:cannot|can't|unable to)\s+(?:process|view|see|inspect)\s+(?:the\s+)?(?:image|images|screenshot|screenshots)|(?:image|vision)\s+(?:input\s+)?(?:is\s+)?(?:not supported|unavailable))\b/i.test(text);
}

function createOllamaProvider({ baseUrl = DEFAULT_BASE_URL, model, fetchImpl = globalThis.fetch } = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const selectedModel = String(model || '').trim();
  if (!selectedModel) throw new Error('Choose an Ollama model before starting the agent.');
  let visualUnsupported = false;
  let visionDegraded = false;
  const defaultTurnLedger = new ProviderTurnLedger();
  return {
    get visionDegraded() { return visionDegraded; },
    // Harness-invoked compaction (chat_compact tool, /compact command): the
    // provider owns its own summarizer transport, so compaction triggered
    // OUTSIDE a decision reuses the exact same channel.
    summarizeFor(system, input, signal, coordinator) {
      return summarizeConversation({ protocol: 'ollama', model: selectedModel, endpoint: `${normalizedBaseUrl}/api/chat`, headers: { 'content-type': 'application/json' }, fetchImpl, coordinator, system, input, signal });
    },
    async complete({ task, agentIdentity, systemPrompt, attachments, observation, observationUnchanged, history, messages, coordinator, plan, goals, recovery, workspace, tools, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint, turnLedger, effort, effortMode, thinkingBudgetMs, signal, onThought, onStream }) {
      // Effort tier (resolved by DesktopChatAgent): minimal acts immediately,
      // standard keeps reasoning brief, advanced is the previous behavior.
      const tier = ['minimal', 'standard', 'advanced'].includes(effort) ? effort : 'advanced';
      const effortDecisionTokens = tier === 'minimal' ? 1_536 : tier === 'standard' ? 2_048 : DECISION_MAX_TOKENS;
      // The model-named reasoning budget (ms) rides as wire config: a budget
      // under 5s — including a named 0, "act immediately" — turns thinking
      // off, because a thinking model's floor latency exceeds such a budget
      // anyway. Unnamed budgets keep the tier's shape: the tier ladder owns
      // the default, the named knob only tightens.
      const namedBudgetMs = Number.isFinite(Number(thinkingBudgetMs)) && Number(thinkingBudgetMs) >= 0 ? Number(thinkingBudgetMs) : null;
      const budgetThinkOff = namedBudgetMs !== null && namedBudgetMs < 5_000;
      const effortPrompt = tier === 'minimal'
        ? 'Reasoning effort: minimal. Decide and act immediately on the freshest observation; skip deliberation entirely, never emit a thinking block, and issue the fewest actions that make progress.'
        : tier === 'standard'
          ? 'Reasoning effort: standard. Keep any private reasoning to one or two short sentences, then act.'
          : '';
      // Auto effort: the model may request one tier more depth, but only with
      // a concrete reason; the harness clamps abuse (see applyEffortEscalation).
      // Name the MECHANISM, never "the harness" — a model told about a
      // harness will narrate what the harness wants instead of acting.
      const effortEscalationPrompt = effortMode === 'auto'
        ? ` Reasoning effort starts at ${tier}. This starts you at ${tier} reasoning effort and adjusts to the task: set "effortNeeded" one step toward "standard" or "minimal" + a one-sentence "effortReason" when the task clearly needs less thinking, or one step toward "advanced" when a phase genuinely needs deeper reasoning. One step per decision; never adjust by habit. You may instead put "thinkingBudgetMs" (a NUMBER of milliseconds) as a TOP-LEVEL field of your decision JSON, next to actions/assistantText — it is read directly and sets the reasoning budget of your next decision: 0 = act immediately with no reasoning, 3000 = minimal, 20000 = brief, 60000 = deliberate. State it in the JSON every decision you want it to hold; a summary line does not set it. Stop reasoning the moment the next action is clear — never spend the budget because it remains.`
        : '';
      const ledger = turnLedger || defaultTurnLedger;
      const context = boundedRequestContext({ task, agentIdentity, attachments, observation, observationUnchanged, history, messages, coordinator, plan, goals, recovery, workspace, tools, workingMemory, interactionMemory, layaVerification, harnessNotices, agentMessages, researchHint });
      const currentContext = ledger.begin(context);
      try {
        const contextBytes = Buffer.byteLength(JSON.stringify(context));
        coordinator.metrics.providerContextBytes += contextBytes;
        // ~4 chars/token estimate (see boundedRequestContext): makes context
        // growth visible in the same units the provider window speaks.
        coordinator.metrics.providerContextTokens += Math.ceil(contextBytes / 4);
      } catch {}
      const visual = visualUnsupported ? null : ollamaVisualEvidence(observation);
      const nativeImage = Boolean(observation?.desktop && observation?.screenshot);
      if (nativeImage && !visual) {
        // Degrade instead of killing: latch vision off, continue text-only.
        visualUnsupported = true;
        visionDegraded = true;
      }
      const attachmentImages = visualUnsupported ? [] : (Array.isArray(attachments) ? attachments
        .filter((item) => item?.kind === 'image')
        .map((item) => String(item?.data || '').trim())
        .map((value) => {
          const dataUrl = value.match(/^data:[^;,]+;base64,([a-z0-9+/=\s]+)$/i);
          const payload = dataUrl ? dataUrl[1].replace(/\s+/g, '') : value;
          return /^[a-z0-9+/]+={0,2}$/i.test(payload) ? payload : null;
        })
        .filter(Boolean) : []);
      // Goals stay an AGI-mode surface; browser mode keeps the baseline plan tool.
      const agiTools = Array.isArray(tools) && tools.some(tool => isComputerTool(tool.name));
      const needsNativePrompt = Boolean(observation?.desktop);
      const planToolEntry = agiTools
        ? { name: 'update_plan', input: { goals: 'optional model-authored array of {id,text,status}; omit to keep unchanged, [] clears', goalOperations: 'optional goal add/update/remove/clear operations; no goal is required', steps: 'optional full replacement array of strings or {id, text, status, verification}', operations: 'optional edits: add, update, remove, or clear; target existing tasks by id; choose the task count yourself' } }
        : { name: 'update_plan', input: { steps: 'optional full replacement array of strings or {id, text, status, verification}', operations: 'optional edits: add, update, remove, or clear; target existing tasks by id; choose the task count yourself' } };
      // the harness owns the system prompt (identity, persona,
      // policies, tool guidance) and the provider renders it verbatim. The
      // per-request EFFORT PROTOCOL is the one provider-owned block: it
      // states the tier this request runs at and the escalation channel the
      // model may use — wire config (the tier maps onto think/num_predict on
      // this very request), not persona. It names the MECHANISM, never a
      // "harness" the model can then narrate.
      const harnessSystem = `${effortPrompt}${effortEscalationPrompt ? `${effortPrompt ? ' ' : ''}${effortEscalationPrompt}` : ''}${effortPrompt || effortEscalationPrompt ? '\n\n' : ''}${String(systemPrompt || '').trim() || require('./prompt/sections.cjs').defaultSystemPrompt({ effort: tier, effortMode })}`;
      let requestAttempt = 0;
      const telemetry = kind => ({ coordinator, kind, phase: kind === 'repair' ? 'repair' : 'decision', attempt: ++requestAttempt });
      const requestBody = (images) => ({
          model: selectedModel,
          stream: true,
          format: 'json',
          // Minimal effort — or a model-named "act immediately" budget —
          // explicitly turns thinking off. Ollama >= 0.9 honors `think`;
          // older servers silently ignore unknown fields, so this is safe
          // without a capability probe.
          ...((tier === 'minimal' || budgetThinkOff) ? { think: false } : {}),
          options: { temperature: 0, num_predict: isLongReportRequest(task) ? LONG_REPORT_MAX_TOKENS : effortDecisionTokens },
          messages: [
            {
              role: 'system',
              // the harness owns the system prompt (identity, persona,
              // policies, tool guidance). The provider appends only the tool
              // catalog JSON — ollama JSON-mode advertises tools in-prompt.
              content: `${harnessSystem}\n\nAvailable tools:\n${JSON.stringify(Array.isArray(tools) ? tools : [])}`            },
            ...ledger.wireMessages({ format: 'json' }),
            { role: 'user', content: JSON.stringify(currentContext), ...(images?.length ? { images } : {}) }
          ]
        });
      await ledger.compact({ current: currentContext, system: requestBody([]).messages[0].content, outputTokens: isLongReportRequest(task) ? LONG_REPORT_MAX_TOKENS : DECISION_MAX_TOKENS,
        extraTokens: [visual, ...attachmentImages].filter(Boolean).length * 4096, signal, metrics: coordinator?.metrics,
        summarize: (system, input, signal) => summarizeConversation({ protocol: 'ollama', model: selectedModel, endpoint: `${normalizedBaseUrl}/api/chat`, headers: { 'content-type': 'application/json' }, fetchImpl, coordinator, system, input, signal }) });
      let payload;
      try {
        payload = await requestStreamingChat(fetchImpl, `${normalizedBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify(requestBody([visual, ...attachmentImages].filter(Boolean)))
        }, 'Ollama agent request', onThought, onStream, telemetry('decision'));
      } catch (error) {
        if ((!visual && !attachmentImages.length) || !ollamaRejectedVisual(error)) throw error;
        // A conclusive modality rejection degrades this decision. Transient
        // outages and payload-size errors remain retryable and do not claim
        // that the model lacks vision.
        if (ollamaRejectedVisual(error)) visualUnsupported = true;
        if (nativeImage && visualUnsupported) visionDegraded = true;
        payload = await requestStreamingChat(fetchImpl, `${normalizedBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify(requestBody([]))
        }, 'Ollama agent request without image', onThought, onStream, telemetry('capability-fallback'));
      }
      if ((visual || attachmentImages.length) && ollamaDeclaresVisualUnsupported(payload)) {
        // Degrade: the model says it cannot see. Latch and retry text-only.
        visualUnsupported = true;
        if (nativeImage) visionDegraded = true;
        payload = await requestStreamingChat(fetchImpl, `${normalizedBaseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal,
          body: JSON.stringify(requestBody([]))
        }, 'Ollama agent request without image', onThought, onStream, telemetry('capability-fallback'));
      }
      ledger.observeUsage(payload, Buffer.byteLength(JSON.stringify(requestBody([]))));
      try {
        const parsed = parseAgentResponse(payload?.message?.content, payload?.message?.tool_calls);
        // Reasoning has already been sent through onThought. The final parsed
        // response must stand on its own and must not touch stream-local state.
        if (hasExecutableDecision(parsed) && !repeatsBlockedRecoveryAction(parsed, context?.recovery)) return ledger.accept(parsed, payload, 'json');
        throw new Error('The local model returned commentary without a browser action or done result.');
      } catch (firstError) {
        // A decision written as raw JSON inside the visible stream is still an
        // executable decision; harvest it before a repair round trip.
        const embedded = extractEmbeddedDecision([payload?.message?.content, payload?.message?.thinking].filter(Boolean).join('\n'));
        if (embedded && hasExecutableDecision(embedded) && !repeatsBlockedRecoveryAction(embedded, context?.recovery)) return ledger.accept(embedded, payload, 'json');
        // Local models occasionally emit prose despite format=json. One bounded
        // structural repair is cheaper than failing the whole task or allowing a
        // visible conclusion without a valid terminal action.
        try {
          const repaired = await requestJson(fetchImpl, `${normalizedBaseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            signal,
            body: JSON.stringify({
              model: selectedModel,
              stream: false,
              format: 'json',
              options: { temperature: 0, num_predict: isLongReportRequest(task) ? LONG_REPORT_MAX_TOKENS : REPAIR_MAX_TOKENS },
              messages: [
                { role: 'system', content: harnessSystem },
                { role: 'user', content: JSON.stringify(actionOnlyRepairPrompt(context, payload?.message?.content || firstError.message, tools)), ...(nativeImage ? { images: [visual, ...attachmentImages].filter(Boolean) } : {}) }
              ]
            })
          }, 'Ollama structured-response repair', telemetry('repair'));
          const parsed = parseAgentResponse(repaired?.message?.content, repaired?.message?.tool_calls);
          if (hasExecutableDecision(parsed) && !repeatsBlockedRecoveryAction(parsed, context?.recovery)) return ledger.accept(parsed, repaired, 'json');
          const informationalFinal = recoverInformationalFinal(task, parsed.assistantText);
          if (informationalFinal) return informationalFinal;
          throw new Error('The structured-response repair did not return an executable decision.');
        } catch (repairError) {
          const informationalFinal = recoverInformationalFinal(task, payload?.message?.content);
          if (informationalFinal) return informationalFinal;
          throw repairError;
        }
      }
    }
  };
}

module.exports = {
  createOllamaProvider,
  parseAgentResponse,
  extractInlineReasoning,
  preflightOllama,
  boundedRequestContext,
  compactComputerOutput,
  recoverInformationalFinal,
  hasExecutableDecision,
  hasOnlyRedundantObservation,
  repeatsBlockedRecoveryAction,
  actionOnlyRepairPrompt,
  extractEmbeddedDecision,
  redactEmbeddedDecision,
};
