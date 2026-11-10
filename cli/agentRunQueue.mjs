// cli/agentRunQueue.mjs
//
// Mid-run message queue + continuation chain for cli/agent-cli.mjs — the CLI
// TUI's desktop-parity contract: typed messages that arrive while a run is
// active are QUEUED (never lost, never rejected) and delivered as the next
// conversation turn when the run reaches its terminal state, exactly like the
// desktop app's queueAgentMessage / maybeAutoSendQueued pair
// (desktop/renderer/app.js).
//
// Delivery mechanism: the TUI writes one JSON control line per queued message
// to agent-cli's stdin —
//
//   {"type":"queue","text":"..."}\n
//
// (the TUI spawns agent-cli with stdio ['pipe','pipe','pipe'] so stdin is
// readable). agent-cli parses each line with parseControlLine and pushes the
// text into a createMessageQueue. When the current run reaches a terminal
// state and the queue is non-empty, runWithQueue starts a CONTINUATION run on
// the SAME in-process DesktopChatAgent (request.continuation + request.
// conversationId — the same continuation path the desktop app uses after a
// run ends), then chains: after each continuation completes, the next queued
// message delivers.
//
// FAST-FORWARD (steer the live run immediately, the desktop's other dropdown
// option) is a deliberate FOLLOW-UP: it is NOT implemented here. Its delivery
// path IS this stdin protocol — a future {"type":"steer","text"} control line
// would feed DesktopChatAgent's pendingUserMessages (deliverSteering) at the
// next thinking turn. See the stdin reader in cli/agent-cli.mjs.

/** Parse one stdin control line. Returns { type, text } for a valid queue
 * control line, or null for anything else (blank, non-JSON, unknown type,
 * empty text) — unknown control types must never crash the run. */
export function parseControlLine(line) {
  const raw = String(line ?? '').trim();
  if (!raw) return null;
  let message;
  try { message = JSON.parse(raw); } catch { return null; }
  if (!message || typeof message !== 'object') return null;
  if (message.type !== 'queue') return null;
  const text = String(message.text ?? '').trim();
  if (!text) return null;
  return { type: 'queue', text };
}

/**
 * The in-process queue fed by agent-cli's stdin reader. FIFO; text is
 * trimmed and de-duplicated against nothing (a user may legitimately queue
 * the same instruction twice).
 */
export function createMessageQueue() {
  const items = [];
  return {
    items,
    push(text) {
      const parsed = parseControlLine(JSON.stringify({ type: 'queue', text }));
      if (!parsed) return null;
      items.push(parsed.text);
      return parsed.text;
    },
    size() { return items.length; },
    shift() { return items.shift(); }
  };
}

/**
 * Run `initialTask` on `agent`, then drain `queue` as continuation runs.
 *
 *   agent.start(request)   — the real DesktopChatAgent.start (or a mock)
 *   agent.state()          — the run snapshot (status/id/...)
 *   buildRequest(text, conversationId)
 *                          — assembles the start request; runWithQueue calls
 *                            it with (text, null) for the first run and
 *                            (queuedText, finishedRunId) for continuations.
 *                            agent-cli passes continuation:true into the
 *                            request when conversationId is non-null.
 *   beforeRun()            — called before EVERY start (agent-cli resets its
 *                            per-run observer clock here).
 *   canContinue(finishedState)
 *                          — gate: must the queue keep delivering? agent-cli
 *                            holds the queue when the external observer
 *                            cancelled the finished run (budget exhaustion) —
 *                            a held queue is traced, never silently dropped.
 *   writeTrace(event)      — harness.* events for the trace tail.
 *
 * Returns { state, startError, continuations, held } where `state` is the
 * LAST run snapshot (a continuation keeps the same conversation id — the
 * desktop's one-conversation-many-turns shape), `continuations` is the count
 * of continuation runs started, and `held` is the number of queued messages
 * NOT delivered (observer-held or a continuation start that threw).
 */
export async function runWithQueue({
  initialTask,
  queue,
  agent,
  buildRequest = (text) => ({ task: text }),
  beforeRun = () => {},
  canContinue = () => true,
  writeTrace = () => {}
} = {}) {
  let startError = null;
  let state = null;
  let continuations = 0;

  const start = async (taskText, conversationId) => {
    beforeRun();
    await agent.start(buildRequest(taskText, conversationId));
    return agent.state();
  };

  try {
    state = await start(initialTask, null);
    while (queue.size() > 0) {
      const finished = state || (() => { try { return agent.state(); } catch { return null; } })();
      if (!canContinue(finished)) {
        writeTrace({
          type: 'harness.queue.held',
          reason: 'the finished run does not allow a continuation (observer cancel / budget)',
          status: finished?.status ?? null,
          remaining: queue.size()
        });
        break;
      }
      const nextText = queue.shift();
      writeTrace({
        type: 'harness.continuation.started',
        task: nextText,
        remaining: queue.size(),
        conversationId: finished?.id ?? null
      });
      try {
        state = await start(nextText, finished?.id ?? null);
        continuations += 1;
      } catch (error) {
        startError = error;
        writeTrace({ type: 'harness.continuation.threw', task: nextText, error: String(error?.stack || error) });
        break;
      }
    }
  } catch (error) {
    startError = error;
    writeTrace({ type: 'harness.start.threw', error: String(error?.stack || error) });
  }

  if (!state) {
    try { state = agent.state(); } catch { state = null; }
  }
  return { state, startError, continuations, held: queue.size() };
}
