# Browser-use production hardening plan

## Goal

Upgrade `tools/browser-use` from a prototype CDP wrapper into a dependable local browser automation/MCP runtime for AI agents. It must drive a genuine Chromium input pipeline, inspect real developer-tool evidence, save replayable artifacts, provide accurate MCP contracts, bundle cleanly, and prove capability against intentionally faulty local websites.

## Constraints and decisions

- **No in-page fake cursor.** The current injected SVG mutates the target document and is unsuitable for testing. CDP supplies real Chromium input dispatch; it does not expose an OS-level physical pointer. The tool will report exact input coordinates and action timing, and will not claim an unavailable native desktop cursor.
- **No direct form-value writes for normal typing.** Regular typing will use CDP keyboard/input events. Direct `browser.evaluate` remains an explicit advanced tool with a clear diagnostic label.
- **Grounded tool results.** Each command receives action timing and bounded console/network deltas. Diagnostics are captured from CDP event streams, not page-side monkey patches.
- **Safe agent boundary.** Only loopback CDP endpoints and a disposable browser profile are allowed by default. Browser editing remains opt-in under current permission controls.
- **Real-browser tests.** New acceptance tests start a local HTTP fixture server and drive a real controlled Chromium through this runtime. No mocked CDP transport or simulated browser validation is accepted.
- **Executable packaging.** Build a complete portable Node bundle first. Then build a Windows single executable only when the local Node runtime supports SEA injection; otherwise return a clearly labelled portable launch package without pretending it is native.

## Phases and checkpoints

### Phase 1 — Foundation and telemetry

1. Add a normalized bounded diagnostics store for console, exceptions, network lifecycle/failures, and performance timing.
2. Update CDP initialization to enable Page/Runtime/Network/Log and correlate request lifecycle records.
3. Remove target-page cursor injection and change all input paths to CDP input dispatch.
4. Add action-trace evidence (before/after URL and diagnostic deltas).
5. **Checkpoint:** real fixture shows an application console error and failed network request, both recovered through MCP diagnostic tools.

### Phase 2 — Agent-grade tools and MCP contracts

1. Add structured tools for network logs/failures, console clearing/filtering, page timing, accessibility tree, element inspection, viewport control, screenshots, and explicit condition waits.
2. Replace lossy MCP input-schema inference with complete JSON schemas, preserving optional inputs and descriptions.
3. Export tool/resource metadata suitable for Claude Code MCP registration.
4. **Checkpoint:** initialize → tools/list → tools/call through stdio MCP passes against the local fixture.

### Phase 3 — Robust interaction and artifacts

1. Make selector actions scroll targets into view, verify usable geometry, and record deterministic coordinates.
2. Preserve actual keyboard behavior for inputs and contenteditable areas; add select-option handling as a dedicated action instead of disguising it as typing.
3. Write a session summary plus screenshot and diagnostics artifacts.
4. **Checkpoint:** reproduce validation, async loading, console exception, and network failure defects with evidence and screenshots.

### Phase 4 — Portable bundle and documentation

1. Make build copying declarative and complete; copy all actual runtime imports.
2. Add optional SEA executable support guarded by local capability detection.
3. Add install, configuration, agent registration, trust boundaries, and diagnostics/replay instructions.
4. **Checkpoint:** build output runs the same real-browser acceptance suite from `dist/`.

### Phase 5 — Lorde AI-tab plan execution

1. Re-read the AI-tab plan and its referenced legacy/Odysseus implementation at the start of this phase.
2. Divide the work into its existing plan checkpoints only; do not bundle unrelated fixes.
3. At every checkpoint, use Browser-use against the live Studio application to inspect targeted DOM/UI behavior, console exceptions, failed requests, and screenshots.
4. Maintain per-checkpoint patch notes, flowcharts, and actual Playwright/CDP evidence under the Studio rules.

## Initial edit targets

- `src/browser/cdpClient.js`
- `src/browser/cursor.js`
- `src/browser/input.js`
- `src/browser/diagnostics.js` *(new)*
- `src/tools/browserTools.js`
- `src/tools/toolExecutor.js`
- `src/tools/verification.js`
- `src/mcp/mcpAdapter.js`
- `src/mcp/mcpServer.js`
- `src/config.js`
- `src/index.js`
- `scripts/build.js`
- `tests/production-fixture.*`, `tests/production-e2e.mjs`, `tests/mcp-e2e.mjs` *(new)*
- `README.md`, `browser-use-tracker.md` *(new)*

## Risks

- The user request for “0 latency” cannot be guaranteed; the tool will minimize redundant CDP round trips and expose timing evidence rather than making a false performance claim.
- A host OS-native pointer cannot be rendered solely by Node/CDP without a desktop automation bridge. The correct production behavior is to avoid an injected fake pointer and use native Chromium input events.
- Real testing requires an installed Chrome/Chromium binary. If absent, the final state must be documented as `NOT_VERIFIED`, not claimed as passed.

## LORDE_UPGRADE_BROWSER_USE_V1_STOP

Start implementation at Phase 1. Do not begin Studio AI-tab changes until Phases 1–4 pass their real-browser checks.

## Phase 6 — Session-based MCP HTTP + ChatGPT bridge (LORDE_UPGRADE_BROWSER_USE_MCP_SESSION)

Goal: replace ephemeral stdio-spawn MCP configuration with the session-persistent
architecture already proven in the Studio's `McpSession` Durable Object, and add
ChatGPT support (native MCP connector + GPT Action bridge). See
`mcp-http_flow_chat.md` for the full flowchart.

1. `src/mcp/sessionStore.js` *(new)* — `Mcp-Session-Id` keyed session records with
   TTL expiry over one shared browser runtime (metadata only; browser is owned by
   the daemon).
2. `src/mcp/mcpAuth.js` *(new)* — HMAC-SHA256 bearer tokens mirroring
   `signMcpJwt`/`verifyMcpJwt` in `studios/src/worker.js`; `POST /mcp/token`
   exchanges the connection key for a token.
3. `src/mcp/httpMcpServer.js` *(new)* — standard Streamable HTTP MCP endpoint
   (`POST/GET/DELETE /mcp`, `GET /mcp/sse`) mirroring `handleStandardMcp`:
   initialize / notifications/initialized / ping / tools/list / tools/call /
   resources, `Mcp-Session-Id` on every response, JSON-RPC `-32001` for unknown
   sessions.
4. `src/mcp/gptBridge.js` *(new)* — ChatGPT GPT Action surface
   (`GET /gpt/openapi.json`, `GET /gpt/tools`, `POST /gpt/call/<tool>` with
   `X-API-Key`), generating OpenAPI from the live tool registry and formatting
   results with the Studio's `formatGptToolResult` contract.
5. `src/index.js` + `src/config.js` — new `--mcp-http [--mcp-port N] [--mcp-host]`
   daemon mode; stdio `--mcp` corrected to never start the WS control server
   (root cause of `EADDRINUSE :::8765`).
6. `tests/mcp-http-e2e.mjs` *(new)* — real-browser acceptance: token issue,
   initialize returns session id, session survives a second client connection
   without a browser relaunch, tools/call executes, DELETE closes only the
   session, GPT bridge OpenAPI + call path works, stdio regression still passes.
7. Docs: README MCP section, `mcp-config.example.json` HTTP variant, tracker
   checkpoint.

Checkpoint: `npm run test:mcp` (stdio regression) and `node tests/mcp-http-e2e.mjs`
both pass against a genuine Chromium. `LORDE_UPGRADE_BROWSER_USE_MCP_SESSION_STOP`.
