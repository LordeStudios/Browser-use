# Browser-use Chat Lifecycle and Adaptive Wait Repair

> Stop marker: `BROWSER_USE_CHAT_LIFECYCLE_ADAPTIVE_WAIT_STOP`

## Goal

- Stop the live thought counter when the user cancels an agent run.
- Keep the floating task plan owned by its conversation so delayed events from an old run cannot attach it to a new chat.
- Replace silent repeated 500ms browser waits with explicit, bounded adaptive waits.

## Files changed

- `desktop/renderer/app.js` — terminal thought settlement and visible-conversation event boundary.
- `desktop/agent/desktopChatAgent.cjs` — explicit wait validation, per-run wait escalation, reset, and abort-safe wait handling.
- `desktop/agent/openAiCompatibleProvider.cjs` and `desktop/agent/ollamaProvider.cjs` — required wait schema and condition-first guidance.
- `src/browser/input.js`, `src/tools/browserTools.js`, `src/mcp/prompts/browser-use-agent-card.md` — aligned explicit 1–10000ms public wait contract.
- `tests/desktop-ai-chat-agent.test.mjs` and `tests/desktop-interaction-e2e.mjs` — regression coverage.
- Existing agent flowcharts — lifecycle and wait invariants.

## Behavior

A cancellation now settles the active thought card and clears its interval. Renderer events are accepted only for the conversation currently displayed; New chat retires the outgoing ID before exposing an empty view. Plans remain persisted by the existing `ChatHistoryStore` conversation record.

`browser_wait` no longer supplies 500ms when the model omits `ms`. Valid consecutive waits receive minimums of 500, 1000, 2000, 4000, 8000, and 10000ms. Any different action resets this streak, and cancellation still interrupts the wait through the run `AbortSignal`.

## How to test

1. Start an agent task and wait until `Thinking… Ns` appears.
2. Press Stop and confirm the label becomes a frozen `Thought for Ns`.
3. Start a planned task, press New chat, and confirm no old task pill returns.
4. Run a scripted sequence of repeated 500ms waits and confirm actual waits escalate.
5. Run the focused Node test and real Electron Playwright acceptance test documented in the repair report.

## Commands run

- `node --check desktop/renderer/app.js ... tests/desktop-ai-chat-agent.test.mjs` — PASS.
- `git diff --check -- <scoped repair files>` — PASS (one existing LF/CRLF warning).
- `node --test --test-name-pattern="missing wait duration|escalates consecutive short waits|repeated passive waits|cancellation aborts an in-flight browser wait" tests/desktop-ai-chat-agent.test.mjs` — 4/4 PASS.
- `node --test --test-name-pattern="requires an explicit browser_wait duration" tests/desktop-openai-compatible-provider.test.mjs` — 1/1 PASS.
- `node tests/desktop-interaction-e2e.mjs` — the second run passed the new cancellation/conversation assertions, then failed at a later pre-existing terminal recovery-card assertion (`expected one recovery card; actual []`).
- `node --test tests/desktop-ai-chat-agent.test.mjs tests/desktop-chat-storage.test.mjs` — the new wait tests passed; the broad file remained red on seven unrelated semantic duplicate/redundant-observation assertions.

## Known limits

Fixed waits remain available for genuinely time-based page behavior. Observable readiness should use existing page evidence or selector waits instead. The complete pre-existing desktop suites are not green; see `studios/test_fix.md` for the exact unrelated failures.

## Next stop marker

`BROWSER_USE_CHAT_LIFECYCLE_ADAPTIVE_WAIT_STOP` in `desktop/agent/desktopChatAgent.cjs`.
