# Browser-use tracker

## V1 production hardening — 2026-08-04

### Goal

Upgrade Browser-use into a real CDP-driven browser automation/MCP runtime that keeps tested pages unmodified, returns developer-tool diagnostics, has truthful MCP contracts, and ships as a portable local package.

### Completed

- Created architecture map: `repo-map.md`.
- Created flowchart: `browser-use_flow_chat.md`.
- Created staged plan: `implementation_plan.md`.
- Removed the injected page-SVG pointer. All pointer actions now flow through Chromium CDP input and return coordinate metadata; no target page DOM mutation or screenshot overlay.
- Replaced normal selector text entry with CDP focus + select-all + `Input.insertText`; option selection is explicit through `browser.selectOption`.
- Added `BrowserDiagnostics` with bounded console, exception, DevTools Log, request, response, transport-failure, and HTTP-error capture.
- Added action trace evidence: elapsed time, page state before/after, console delta, and network delta.
- Added `browser.networkLogs`, `browser.failedRequests`, `browser.clearNetworkLogs`, `browser.actionTrace`, `browser.inspectElement`, and `browser.selectOption`.
- Replaced lossy MCP schema inference with the actual per-tool JSON schema and added diagnostic MCP aliases/resources.
- Added real Chromium acceptance tests:
  - `tests/production-e2e.mjs` uses a local HTTP fixture to perform actual typing/clicking, capture a screenshot, capture intentional console errors, and capture an intentional HTTP 503.
  - `tests/mcp-e2e.mjs` starts the actual stdio MCP server, initializes it, checks schemas, and calls a browser tool.
- Updated distribution build to emit a non-destructive `release/` portable folder rather than overwriting the existing tracked `dist/` artifact.

### Verified

- `npm --prefix browser-use run test:mcp` — PASS: real stdio MCP initialize, tool listing, required/optional schema behavior, browser state call.
- Earlier `test:production` result used a headless fixture. This result is superseded: every acceptance path is now being converted to headed-only before revalidation.
- `node --check` passed for all newly edited runtime/test files before the acceptance runs.

### Headed-only V2 checkpoint — 2026-08-04

The runtime is now corrected to follow the visual-program requirement:

- The CLI parser no longer accepts `--headless`.
- The Chrome launcher has no headless parameter or `--headless` Chrome argument.
- Existing real-browser tests now launch visible Chromium only.
- `src/ui/controlCenter.js` provides a visual Browser-use Control Center served by the session server; normal interactive runs open it as a second visible tab beside the target site.
- The Control Center shows live URL/title/focus, diagnostic counts, event stream, and command controls. It observes the same CDP/MCP session rather than a duplicate browser.
- `src/browser/nativePointer.js` adds a Windows `SetCursorPos` bridge. On normal Windows runs, the host pointer moves to each action coordinate before CDP sends the matching Chromium input event. It can be disabled only via `--no-native-pointer` for automated validation isolation.
- Added `tests/headed-benchmark-loop.mjs`, alternating cold/reuse runs through visible browser stages: simple form → conditional UI → SPA state.

### Headed-only verification

- `node browser-use/tests/production-e2e.mjs` — PASS: visible Chromium, real form input/click, screenshot, intentional console errors, HTTP 503, action trace.
- `node browser-use/tests/mcp-e2e.mjs` — PASS: visible Chromium plus real MCP stdio initialize/list/call contract.
- `npm --prefix browser-use test` — PASS: all-headed suite. Production diagnostic fixture and MCP integration passed; alternating visible-browser cold/reuse benchmark passed (stage 1 17.00s/14.76s; stage 2 9.89s/9.05s; stage 3 12.33s/14.11s).
- `npm --prefix browser-use run build` — PASS: created `release/browser-use-0.3.0/` with the Control Center and native-pointer modules.
- `node browser-use/release/browser-use-0.3.0/src/index.js --command browser.info` — PASS: packaged headed release launches and returns real browser state.

### Known limitations

1. The Windows native pointer bridge is host-native and real, but OS DPI/window-chrome geometry can vary across monitor scaling configurations. CDP remains the authoritative event dispatch and exact viewport coordinate record.
2. Browser-edit commands remain opt-in under the permission model. The acceptance test explicitly enables `browser-edit` in its local test configuration rather than using a broad CLI bypass.
3. The release is a ready-to-run portable Node package, not a single-file Windows `.exe`: it intentionally requires locally installed Node.js and Chrome/Chromium. A true SEA executable would require an audited CommonJS bundle of the ESM runtime and dependencies; the current packaging does not misrepresent this limitation.
4. Existing release folders are immutable. The current tested package is `release/browser-use-0.2.2/`; earlier generated release folders may be removed only with an explicit destructive-action approval.

### Next stop marker

`LORDE_UPGRADE_BROWSER_USE_V2_HEADED_STOP`: Headed visual Browser-use checkpoint is complete. Run the all-headed suite and package a new release before starting the Lorde Design Studio AI-tab plan.

## Session-based MCP HTTP + ChatGPT bridge — 2026-08-04

### Goal

Replace the ephemeral stdio-spawn MCP configuration (fresh process + fresh browser per MCP client, `EADDRINUSE :::8765` crashes on concurrent spawns) with the session-persistent architecture already proven in the Studio's `McpSession` Durable Object, plus ChatGPT support (native MCP connector + GPT Action bridge). Flowchart: `mcp-http_flow_chat.md`.

### Completed

- `src/mcp/sessionStore.js` — `Mcp-Session-Id` keyed session records (TTL 60 min, max 64, metadata only) over one persistent browser runtime.
- `src/mcp/mcpAuth.js` — HMAC-SHA256 bearer tokens with the same JWT shape as `signMcpJwt`/`verifyMcpJwt` in `studios/src/worker.js`; `POST /mcp/token` exchanges the connection key for a token.
- `src/mcp/mcpDispatch.js` — shared tools/list, tools/call, and resources/read semantics so stdio, HTTP, and GPT surfaces cannot drift.
- `src/mcp/httpMcpServer.js` — standard Streamable HTTP MCP daemon (`POST/GET/DELETE /mcp`, `GET /mcp/sse`) mirroring `handleStandardMcp`: initialize returns `Mcp-Session-Id`, every response echoes it, unknown sessions fail with JSON-RPC `-32001` (re-initialize contract), DELETE closes only the session record, loopback-only bind by default plus per-address rate limiting.
- `src/mcp/gptBridge.js` — ChatGPT GPT Action bridge (`GET /gpt/openapi.json`, `GET /gpt/tools`, `POST /gpt/call/<tool>` with timing-safe `X-API-Key`), OpenAPI generated from the live registry, results formatted with the Studio `formatGptToolResult` contract.
- `src/index.js` + `src/config.js` — new `--mcp-http [--mcp-port N] [--mcp-host H] [--mcp-secret S] [--gpt-key K]` daemon mode; stdio `--mcp` no longer starts the WebSocket control server, fixing the concurrent-spawn `EADDRINUSE` crash.
- `tests/mcp-http-e2e.mjs` — real-Chromium acceptance for the full contract; `mcp-config.example.json` and README updated with the HTTP-first registration flow.

### Verified

- `node tests/mcp-http-e2e.mjs` — PASS: 401 without bearer token; initialize returns `Mcp-Session-Id`; unknown session → `-32001`; tools/list schemas correct in-session; `browser_navigate` executed; a second initialized session observed the first session's live page (persistent shared browser, no relaunch); DELETE closed only session A while session B kept working; GPT bridge enforced `X-API-Key`, served 21 OpenAPI paths from the registry, and `POST /gpt/call/browser_get_state` returned the same live page state.
- `node tests/mcp-e2e.mjs` — PASS: stdio regression (initialize/list/call) unchanged.
- Concurrent stdio spawn check — PASS: two simultaneous `--mcp` processes both initialized; no `EADDRINUSE` in stderr.
- `node --check` — PASS on all eight edited/new runtime files.

### Known limitations

1. ChatGPT's cloud (native MCP connector or GPT Action) can only reach the daemon through a tunnel (e.g. `cloudflared`) since it binds loopback by default; `--mcp-host` can widen the bind but then the bearer/X-API-Key secrets are the only gate.
2. The SSE stream mirrors JSON-RPC responses for observers; it is not yet a full server-initiated notification channel.
3. Release folders under `release/` are immutable and were not rebuilt in this checkpoint.

`LORDE_UPGRADE_BROWSER_USE_MCP_SESSION_STOP`

## Submission card dedupe + tab control repair — 2026-09-29

### Goal

Fix two live-agent frictions: (1) the terminal submission message rendered THREE times after serious tasks (bare summary, then a "Worked for …" variant missing tokens, then the bare summary again), and (2) the agent could not switch tabs or reliably control background tabs — `browser_select_tab` advertised an EMPTY argument schema, so the model sent `{}` and gave up (observed live against Figma tab-2 while testing the design studio).

### Root causes

1. `stripRunMetadata` matched an EXACT three-segment `·` tail; when the provider reports no token usage the tail has two segments, the strip failed, and both the `run.completed` card and the durable `renderChatState` fallback rendered as duplicates.
2. `toolDefinitions` `inputs` map had no entries for `browser_select_tab`, `browser_new_tab`, `browser_scroll`, `browser_query`, `browser_extract` — `toolInputSchema` then emitted `{type:'object', properties:{}}`. No browser action schema exposed the optional `tabId` the executors already honor, so multi-tab control was undiscoverable. Coordinates were validated against the run's last observation regardless of the target tab, and `browser_mousemove` hard-refused cross-tab coordinates.

### Focused repair

- Renderer: robust metadata strip (cut at the LAST ` Worked for ` marker), per-run terminal card tracked and UPGRADED IN PLACE to the fullest variant instead of appending duplicates; honest `N requests` fallback when usage is absent.
- Tool catalog: full schemas for the five missing tools; optional `tabId` hint on every tab-scoped action; `browser_tabs` now flags the active tab; descriptions describe target-tab semantics.
- Per-tab grounding: `run.observationsByTab` (bounded, 8 most recent, excluded from serialization) stores the newest observation per tab; `viewportPoint`/visual-target resolution validate against the TARGET tab; cross-tab `browser_mousemove` allowed after observing that tab; index resolution uses the call's tab snapshot.
- New `browser_focus_tab` tool: the gated agent route to `showTab()` — refused while any other live agent owns tabs (`desktop/agent/tabFocusPolicy.cjs`, pure + unit-tested); background control by `tabId` stays available regardless.
- `browser_focus_tab` added to the mutation catalog (progress + duplicate hashing).

### Deterministic checks

- `node --check` PASS on all six edited/new runtime files.
- `tests/tab-focus-policy.test.mjs` 4/4 PASS (new).
- `tests/desktop-ai-chat-agent.test.mjs` new regressions PASS: non-empty schema for every tab-scoped action; coordinate click on background tab grounded by that tab's viewport; focus tool foregrounds without rebinding the run; missing focus callback yields an actionable recorded failure.
- Controller suites (`browser-wait`, `desktop-dom-snapshot`, `desktop-capture-timeout`) 27/27 PASS.

`LORDE_UPGRADE_TAB_CONTROL_REPAIR`

## Debugger-lease stall repair — 2026-09-29

### Root cause (live-observed)

An agent working a background tab stalled on every turn — no errors, no tool
results, frozen thought counter — and resumed only when the user switched the
app's visible tab. `DebuggerLeaseManager.run` serialized per-tab DevTools work
on a promise chain with NO timeout. One command that never settles (a
`Page.captureScreenshot fromSurface:true` awaiting a compositor frame a
detached/throttled view never produces) held the tab's queue slot forever; all
later `Runtime.evaluate` observes and `Input.dispatch*` actions queued silently
behind it. Compositor state flips from switching the visible tab are exactly
what started/stopped the hangs, which is why tab switching "resumed" the agent.

### Focused repair

- `debuggerLeaseManager.cjs`: every lease operation is bounded (15s default,
  configurable); on timeout the slot force-releases, the debugger channel is
  reset, `debugger_lease_timeout` is thrown, and `onOperationTimeout` logs a
  visible console entry. Attach-epoch guard prevents a late-settling hung
  command from detaching a newer lease's fresh channel. `metrics.timeouts`
  added.
- `main.cjs`: wires `onOperationTimeout` to a console-panel entry.

### Verification

- `node --check` PASS on both edited files.
- `tests/debugger-lease-manager.test.mjs` 7/7 PASS — new regressions: hung
  command times out + queue advances; late settle never detaches a newer
  channel; timeout hook fires.
- Controller suites through the real view controller (`browser-wait`,
  `desktop-dom-snapshot`, `desktop-capture-timeout`, `desktop-input-release`,
  `agent-pointer-controller`) 67/67 PASS.

Note: the fix is main-process code — the running Desktop app must be restarted
to pick it up.

`LORDE_UPGRADE_DEBUGGER_LEASE_STALL_FIX`

## Thinking persistence in saved conversations — 2026-09-29

### Why history lost the AI thinking

By omission, not by a bug in the stream: the live "Thought for Ns" cards are
display-only by design (reasoning deliberately never re-enters the model's
context — the V295 history-hygiene rule), and the persisted conversation
schema (messages + transcript) simply had no channel for reasoning. The
rebuild on open renders only messages + tool records, so every thinking card
existed solely in the closing DOM.

### Focused repair

- The decision loop now archives each thinking card at its boundaries (decision
  complete, action start, run end) into a bounded `run.thinkingArchive`
  (60 records, 2,000-char tail each, identical consecutive tails collapsed).
- `checkpointSnapshot` passes the archive to the chat-history store; the store
  whitelist persists it; `serializeRun` deliberately omits it from live
  per-event IPC payloads.
- The renderer's `openConversation` merges the records chronologically and
  renders them collapsed ("Thought for Ns", expandable), matching the settled
  live card. Continuations restore the archive via the conversation snapshot.

### Verification

- `node --check` PASS on all four edited files.
- New agent tests 2/2: checkpoint carries the bounded archive and the reasoning
  never enters `messages`; live events never embed the archive.
- `history-store` + `tab-focus-policy` 9/9; focused agent subset 13/13.
- Also fixed here: the agent-message coordination directive now names the
  `agent_message` reply tool (the stale test pair asserted this and could
  never pass against the old text). agent-sessions + chat-dock 9/9.

Note: conversations saved BEFORE this change have no archive (nothing was
recorded); only new runs persist thinking. The Desktop app must be restarted.

`LORDE_UPGRADE_THINKING_HISTORY_PERSISTENCE`

## Run stall heartbeat — 2026-09-29 (owner-revised: 100% internal)

### Gap

No activity watchdog existed for a RUNNING run: the 90s step timer allows a
7.5-minute silent pre-stream provider window (up to 30m absolute), its firings
are recoverable and therefore never rendered, and a poisoned tab queue simply
re-hung every recovery. Live symptom: frozen "Thought for 39s", goal pill
loading, Stop button shown — indefinitely, with zero errors.

### Repair (revised per owner directive)

- `run.lastRealActivityAt` touched by every published event EXCEPT the
  synthetic thinking-clock ticks.
- 10s internal heartbeat: idle >= 7m force-ends the current step
  (`agent_stall_abort`, recoverable) so recovery re-grounds; `stallRecoveries`
  counts internally. NOTHING reaches the user's surface — the first draft's
  transient chat notice, console entries, and `run.stalled` event were
  removed on the owner's instruction.
- WAIT CONTRACT (owner clarification): the observed "stalls" were often
  deliberate long waits. Deliberate wait polls can NEVER trip the heartbeat:
  wait idles are chunked at <= 2s with a heartbeat touch per chunk (and the
  wait also wakes promptly for Stop/steer), so the hard ceiling only fires on
  a genuinely silent run — a provider that never streams or a command that
  never settles. Approval/pause states skip the check by status.
- `heartbeatTimer` excluded from serialization (IPC clone safety); previous
  run's timer cleared on continuation and at run end.

### Verification

- `node --check` PASS on all edited files; focused agent suites 13/13;
  browser-wait suite 9/9; new heartbeat regressions 2/2: (1) a deliberate
  multi-second wait with a 3s stall ceiling completes with zero heartbeat
  interruptions, (2) a signal-honoring silent provider is force-recovered
  internally with stall evidence in run history and nothing user-facing.
  Restart the Desktop app to load (together with the lease fix).

`LORDE_UPGRADE_STALL_HEARTBEAT`
## Turn clock + steering re-scope — 2026-09-29

### Defects (live)

1. "Worked for" measured from the conversation's FIRST message, not the turn
   being completed: `formatRunDuration` used `createdAt`, and continuations
   inherit the original `createdAt` forever.
2. New commands sent mid-run confused the agent: the steering message was
   appended to the context but nothing marked it as the new objective, so the
   model kept executing the old plan; the old action-loop state (duplicate
   suppression, no-progress counters) also carried over.

### Repair

- `run.turnStartedAt`: set at run start; a continuation with a DIFFERENT task
  text restarts it (a new user turn), an identical task carries it (recovery/
  resume); `deliverSteering` resets it and resets `loopState` for the new
  scope. Persisted through the store whitelist and conversation restore.
- Renderer `formatRunDuration` prefers `turnStartedAt` over `createdAt`.
- `deliverSteering` now appends a bounded runtime scope directive (never
  rendered, model-context only): the last user message is the authoritative
  objective — update the plan, wrap up or hand off the previous task's
  remaining steps, keep completed work when the message is a refinement.

### Verification

- `node --check` PASS; new tests 2/2 (steer restarts clock + directive reaches
  model context; follow-up turn starts its own clock); history-store +
  agent-sessions + chat-dock 14/14.

`LORDE_UPGRADE_TURN_CLOCK`

## Dedicated file tools overhaul (computer_file retired) — 2026-09-29

### Owner report (live coding runs)

The agent fragmented file reading (up to 20 read calls for one file), reached
for `computer_terminal` (slow patches, grep sessions) instead of dedicated
tools, and `computer_file` was an everything-tool with weak search.

### Overhaul (modeled on Claude Code Read/Grep/Write + ripgrep semantics)

- `computer_read`: whole-file numbered read in ONE call (cat -n, default 2000
  lines, 2MB cap), honest `nextOffset` continuation, directory/binary/large
  refusals, workspace noteRead.
- `computer_search`: ripgrep-backed (`--json`, async — the old search ran
  execSync and froze the app) with bounded JS-walker fallback; output modes
  content (file:line ± context) and files; glob filter; skips
  node_modules/dist/build/.git and binaries; 120-match default cap.
- `computer_write`: create/overwrite/append with parent-dir creation,
  ownership guard, line diff.
- `computer_fs`: stat/list/mkdir/copy/move/delete (no content).
- `computer_file` RETIRED from the model catalog (toolDefinitions filter +
  catalog removal); backend keeps a hidden compat path (deprecated marker)
  for tests, sandbox lanes, and older MCP sessions; agent-level execution,
  isMutation, redaction, and `workspaceViolation` scope enforcement cover the
  compat name AND the new computer_fs paths/destinations (a real gap: fs
  mutations were outside the workspace contract).
- Prompts (coding + AGI): terminal is a FALLBACK for interactive processes,
  installs, running tests — never reads, searches, or edits; ONE search/read
  per target; the full AGI craft playbook (modeling, launch verification,
  batching) is preserved verbatim with only the file-tool sentences updated.

### Verification

- `node --check` PASS on all edited files.
- New tool tests: read continuation 2000/500, write/append + diff, search
  context + files modes + skip rules, fs operations, catalog contract — all
  PASS; agent-focused subsets 17/17; computer-patch 15/15; lease/policy
  suites green.
- Remaining reds verified PRE-EXISTING (lost-session drift): computer-tools
  record/MCP-mode/AGI-suffix trio, continuity `recoveryResets`/
  `environment_blocked` trio, laya-race deleted module, native-evidence
  reducer shape. Restart the Desktop app to load.

### Parity audit + gap closers (same day, owner audit)

Old computer_file action -> replacement:
- read -> computer_read (numbered, continuation) + NEW encoding=base64
  (byte-paged binary reads, images included)
- write/append -> computer_write + NEW encoding=base64 (binary writes)
- edit -> computer_patch (strictly more powerful: multi-hunk atomic)
- mkdir/copy/move/delete/stat/list -> computer_fs
- search (content regex) -> computer_search (rg-backed, context, files mode)
- search (query filename mode) -> NEW computer_fs action=find (name substring
  or glob across a tree, paginated, skip rules) — the filename counterpart
  of content search

Terminal policy (owner question): the terminal is a SCOPED fallback, not
blindly forbidden. Prompts forbid it only for file reads, searches, and text
edits; interactive processes, package installs, running tests, and arbitrary
commands remain legitimate terminal work, and nothing hard-blocks terminal
commands that happen to touch files (npm test, git) — enforcement is at the
prompt level with the dedicated tools being faster and strictly better at
their jobs.

New tests: binary read/write round-trip + pagination + invalid-base64
rejection; fs find by substring/glob + pagination + query/glob requirement.
Suite: 21/24 (3 pre-existing drift failures unchanged).

### Claude-Code gap closures (same day, zero-regression directive)

1. Prompt caching: Anthropic-route system block sent as a cache_control
   ephemeral block (append-only wire = stable prefix); gateways rejecting the
   extension are latched off with a clean retry; env off-switch. 2 provider
   tests. 2. Pixel economics: fill/type mutations under vision auto skip the
   post-mutation screenshot (structured fill proof + DOM snapshot ground the
   decision); clicks/drags/keys/navigation re-arm; always/never policies
   unchanged. 2 agent tests. 3. Relevance anchor: over-cap DOM pages keep the
   elements nearest the agent's last pointer position with stable original
   indices; under-cap pages byte-identical. selectElementsByAnchor exported +
   inlined into the page collector so tests run the shipped code; 1 test +
   plumbing. 4. Tool descriptions left untouched deliberately: caching puts
   them inside the cached prefix, and they are live-validated contracts.
- Suites: controller/policy/lease 94/94; agent-focused 19/19; provider
  cache tests 2/2. Remaining reds are the documented pre-existing drift set.

### Zero-degradation speed wins (same day)

1. Parallel pixel capture: observe() starts the CDP screenshot concurrently
   with the DOM snapshot (the capture decision is fully known once navigation
   settles) — saves the full 0.5-4s capture from serializing after the DOM
   read on every pixel-bearing decision. Identical bytes, identical policy
   (vision always throw semantics preserved; browser-fixture paths unchanged).
2. Cold-start warmup: the native helper worker (Electron-as-Node fork) and the
   ripgrep probe now start at bridge startup instead of stalling the agent's
   first pointer action / first search (~100-300ms each, previously paid
   mid-task).

Remaining known speed levers, deliberately NOT taken (regression risk):
- Incremental tool-call execution while the decision streams (biggest
  architectural win; needs batch/approval redesign).
- Background ledger compaction between decisions (concurrency with the wire
  builder needs design).
- Raising read-only batch ceilings (prompt/behavior change; needs live runs).

### Time-to-first-edit fixes (live-run evidence, same day)

Live run 'fix transformation borders' showed: screenshot turn -> git status
turn returning ~20k chars of stale .wrangler deletions -> more evidence
rounds. Fixes: (1) computer_git status now summarizes long working trees
(60-line window + kind counts + 'do not re-run status' note; live check on
the real repo: 253 entries -> 8k chars with summary); (2) coding prompt now
requires the FIRST decision to co-emit the whole evidence batch (visual
screenshot + ONE computer_search), with git status once right before the
first patch. This cuts time-to-first-edit from ~6-10 GLM round trips to ~3-4;
the remaining gap vs Claude Code is round-trip latency (GLM relay 8-40s vs
sub-second), which is model-bound.

### Effort ladder inversion + GLM-dampener removal (owner directive, 2026-09-30)

Owner: "the browser-use should be perfect with the strongest or the weakest
models" — live evidence showed the strongest model (Opus 5.5) searching with
broad generic patterns because the harness started EVERY auto run at minimal
effort (a GLM runaway dampener) with reasoning_effort low and an
"act immediately, skip deliberation" instruction.

- Auto effort now STARTS at advanced (strongest reasoning). The model moves
  ONE rung per decision in either direction with a reason: down when the task
  clearly needs less thinking, back up when a phase needs more. No
  need-signal gates, no model-family dampeners (the claudeFamily block was
  removed with the inversion — the harness is family-blind).
- Provider prompts (openai-compatible + ollama) advertise the bidirectional
  channel; responses route maps advanced -> effort high.
- computer_search schema teaches query discipline (distinctive identifier,
  not broad OR-lists of generic words); files mode is RANKED BY MATCH COUNT
  with a narrowing notice over 40 files; compact inspection renderings for
  computer_search/computer_read/computer_fs replace the truncated raw-JSON
  transcript blob.
- Tests: agent-effort rewritten for the inverted contract 8/8; continuity
  17/20 (3 pre-existing); provider/tool suites unchanged except the new
  green tests.

### Evidence-phase forcing function (2026-09-30)

Live run: git status -> broad search -> more evidence rounds with no edit.
Every evidence call returns different content, so unchanged-page guards never
fire; the model could orient forever. Fix: a read-only decision streak —
after 3 (then 5, 7) consecutive decisions with NO mutation, a runtime context
nudge (never user-visible) demands convergence: co-emit read+patch on the
most likely cause, or state the one missing fact and the one command that
obtains it. Reset by any mutation or a new user command. Test: 3/3 stable.

### Test-baseline reconciliation complete (2026-09-30) — 199/199 green

Every documented pre-existing drift failure resolved:
- AGI suffix condition fixed for real: the playbook now rides with the AGI
  tool CATALOG (any run advertising computer_* tools), not only desktop
  observations.
- Screenshot self-heal: a paintable tab whose capturePage times out
  (occluded/minimised) falls through to the CDP background capture instead
  of failing the caller.
- Identical-recovery tracking restored: scheduleRecovery counts same-source/
  same-error repeats into recoveryFingerprintCount (evidence the strategy is
  stuck); distinct failures reset it.
- Provider repair tests reconciled: the redundant-observe/screenshot and
  duplicate-recovery repairs live in the agent loop now; the provider passes
  decisions through (tests assert the pass-through + recovery-context carry).
- Effort ladder tests rewritten for the inverted contract (advanced start,
  bidirectional one-rung adjustment); responses route advanced->high asserts.
- native-evidence reducer: file-tool result keys whitelisted + undefined-key
  pruning (smaller context, clean diagnostics); scan-limited fixture updated
  to the computer_search shape.
- computer-tools: harness task de-classified from coding (full AGI catalog =
  48 tools incl. focus_tab + record); MCP delegated controlMode test updated
  to the caller-explicit-choice contract; laya-race orphan test deleted
  (module was removed pre-session).
- Suites: effort 8/8, continuity 20/20, native-evidence 11/11,
  openai-compatible 18/18, computer-tools 24/24, computer-patch 15/15,
  agent-focused 19/19, controller/policy/lease/history/dock/sessions
  138/138. TOTAL 199/199 green — zero known failures remain.

### Turn-boundary fix for old-task resurrection (2026-09-30, owner live report)

Owner: "keeps returning already closed old tasks and forgetting what I told
it to do" — a 'remove that label' task executed as an OLD device-chip task.

Root cause: follow-up tasks in the same conversation inherited the CLOSED
task's plan, goals, and full message history with no turn boundary — the
model read the prior task's objectives as still-active. (Knowledge recall was
checked and ruled out: the store holds no device-chip entry.)

Fix: a follow-up task whose text differs from the conversation's previous
task is a TURN BOUNDARY — plan and goals start empty, and a runtime message
(never rendered) declares every earlier task CLOSED and names the new
objective exclusively. Same-task continuations (recovery/resume) keep plan,
goals, and clock. Test: 1/1 (a first hang was the test's own mock — unverified
done looping the completion review; the fixture now verifies).

### DOM picker staleness fix — site-universal (2026-09-30)

Owner report: some layers show the DOM-select highlight but clicking never
attaches them. Root cause (site-universal, in src/browser/elementPicker.cjs):
the picker resolved the target from a `current` variable that only updated on
mousemove/touchstart — never at pick time, never on scroll. Any site where
content moves under a stationary cursor (wheel scrolling, SPA re-renders,
CSS animations, lazy shifts) left the highlight and `current` stale: clicking
attached the wrong element or nothing (picked:false/no-element silently ends
the mode).

Fixes (site-universal, no per-site patching):
- Pick-time tracking: onPick/onTouchEnd re-run the hit test at the exact
  click coordinates before resolving — the highlight and the attachment can
  no longer disagree.
- Scroll/resize re-track: capture-phase scroll + resize listeners re-run the
  hit test with the last pointer position, so the highlight follows content
  when the user scrolls with a stationary cursor.
- Touch end uses changedTouches for the same at-pick resolution.

Known limits (by design, documented): elements with pointer-events:none are
invisible to the hit test (the picker highlights the hit-testable ancestor —
same as DevTools); content inside iframes resolves to the iframe element.

Verification: contract tests 2/2 (pick-time tracking asserted in the
generated page script; scroll/resize retrack asserted); generated script
parse-verified. Probe file removed; live page untouched.

### Enter-always-delivers + attachment-aware queue (2026-09-30, owner report)

Owner: pressing Enter while the chat runs surfaced the 'already active'
error modal instead of queueing — the queue branch required NO attachments,
so a message carrying a DOM card fell through to agentStart. Also removed
the explainer text under the queue/fast-forward menu options.

- Submit handler: while a run is active, Enter ALWAYS queues — text,
  attachments, or both (queue state now carries attachments; auto-send
  restores them into the composer before submitting the next turn).
- 'Already active' race fallback: if the renderer briefly misses an active
  run, the main-process error queues the message (and removes the
  prematurely rendered user card) instead of surfacing the modal.
- Enter in the composer always submits; the handler routes queue vs start.
- Menu options are now just 'Queue the message' / 'Fast-forward'.

### Run routing + unstoppable-Stop fix (2026-09-30, live dev log)

Live dev log: Stop failed with 'Unknown AI chat run' while a task kept
running, and new starts hit 'already active' on the primary. Root cause:
steer/cancel/approve routed only to the sender's chat-window instance or the
primary — runs owned by handed-off drawer conversations (chatSessions) or
pool runs were unreachable, and a stale renderer run id made Stop fail while
the run lived on.

- findAgentForRunId: run-targeted IPC routes to whichever agent instance
  actually owns the run id (scans liveAgentInstances: primary, chatSessions,
  chat windows, pool runs) — steer, cancel, approve all wired.
- Stop fallback: on 'Unknown AI chat run', cancel whichever run is actually
  live. A stale renderer id can never leave a run un-stoppable.
- Note: the main-process 'already active' log line when the renderer queues
  is expected noise — the renderer's fallback catches the rejection and
  queues the message (shipped earlier today).

### Multimodal model support + DOM card polish (2026-09-30)

- Custom models: connections carry user-added model ids merged into
  discovery; `openai/gpt-image-2.5` seeded into the xkiro connection (the
  relay's /models does not list it — verified live, 138 models, 0 image).
- Image-generation models via chat: non-JSON replies containing markdown/data
  images now complete as terminal media answers (both providers) instead of
  parse-failing into repair loops; the transcript renders markdown images as
  real <img> elements (data:image + https only).
- TTS models route to /audio/speech and return a playable audio answer.
- DOM cards show the element's PAINTABLE first words (innerText, {empty} when
  blank), gradient-truncated to the window width; transcript DOM chips render
  from the token alone so they survive chat close/reopen; copying a message
  expands each DOM N to its full captured path.
- Known next: STT transcription IPC + video rendering.

### Add-custom-model row in the model dropdown (2026-09-30)

The model list ends with an 'Add model id…' input + Add button: users add
ids that gateways omit from /models (image-gen, preview). Persisted as
connection.customModels via browser-use:add-provider-model (new IPC +
preload), merged into every future discovery by list-provider-models (along
with an explicitly saved model). Adding selects the model immediately.
openai/gpt-image-2.5 pre-seeded on the xkiro connection.

### Media models bypass the agent loop (2026-09-30, live hang report)

Live: selecting openai/gpt-image-2.5 and sending a prompt hung the run at
'Thinking… 698s' with zero requests reaching the gateway — image gateways
never stream chat decisions, so routing them through the decision loop hangs
forever. Correct design: media models BYPASS the agent loop entirely.

- browser-use:generate-media IPC: image models -> /images/generations with a
  chat-completions fallback (markdown/data extraction); TTS -> /audio/speech;
  both bounded, direct, no agent run.
- Renderer: a non-chat model (image/audio per nonChatModelReason) routes the
  submit to generate-media and renders the result as an <img> / <audio>
  element in the transcript. No agent run, no decision loop, no hang.

`LORDE_UPGRADE_BASELINE_RECONCILIATION`

## Browser fill page-wide selection repair — 2026-10-08

### Root cause

`browser_fill` focused the native control in a page-side evaluation, then sent a
Ctrl+A key chord through a separate Electron/CDP input channel. If a page script
or controlled-component rerender moved focus between those operations, Ctrl+A
selected the document body and the following `Input.insertText` acted on the
page-wide selection. The selector-based `typeSelector` path had the same
unconditional Ctrl+A hazard after its coordinate click.

### Repair plan

Select native control contents page-side in the same evaluation that focuses the
control, then dispatch only `Input.insertText`. Apply the same focus-and-select
contract to `typeSelector`, failing closed when focus is not retained. The
controller flowchart documents the route and the regression suite asserts that
fill emits no select-all key events.
