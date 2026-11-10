# Browser-use repository map

## Product and runtime

`browser-use` is a Node.js ESM local browser-automation/MCP runtime. It uses `chrome-remote-interface` to control a locally launched or externally connected Chrome/Chromium instance over the Chrome DevTools Protocol (CDP), with `ws` for an optional local command/event server.

- **Package manager:** npm (`package.json`; lockfile should be preserved if present)
- **Runtime:** Node.js ESM
- **Browser protocol:** Chrome DevTools Protocol over a localhost endpoint
- **Agent integration:** MCP JSON-RPC over stdio; optional WebSocket command server
- **Packaging today:** copied `dist/` folder plus `.bat`/`.ps1` Node launchers, not a standalone native executable

## Entry points

| Purpose | File |
| --- | --- |
| CLI/runtime lifecycle | `src/index.js` |
| CLI argument/config parsing | `src/config.js` |
| CDP connection, tab selection, console/network event capture | `src/browser/cdpClient.js` |
| Controlled Chrome launch and shutdown | `src/browser/chromeLauncher.js` |
| Browser input | `src/browser/input.js` |
| Screenshot output | `src/browser/screenshot.js` |
| DOM state extraction | `src/browser/domSnapshot.js` |
| Agent tool definitions | `src/tools/browserTools.js` |
| Permission enforcement | `src/tools/permissions.js` |
| Tool execution/proof envelope | `src/tools/toolExecutor.js` |
| MCP server | `src/mcp/mcpServer.js` |
| MCP tool aliases/resources | `src/mcp/mcpAdapter.js` |
| Local event WebSocket server | `src/server/websocketServer.js` |
| Build/distribution script | `scripts/build.js` |

## Important folders

- `src/browser/` — CDP, launch, input, screenshot, DOM snapshot, pool.
- `src/tools/` — agent-facing command surface, permissions, command verification.
- `src/mcp/` — stdio MCP protocol adapter.
- `src/server/` — local WebSocket command/event server.
- `src/ollama/` — optional single-action local-model loop.
- `tests/` — real HTML fixtures and CDP-driven regression scripts.
- `logs/` — per-session NDJSON artifacts (generated).
- `dist/` — generated portable Node folder (generated).

## Existing capabilities

- Launches Chrome with a disposable profile and connects via CDP.
- Navigation, tabs, screenshots, DOM snapshots, input, keyboard, scroll, drag, basic waits.
- Captures console API calls/exceptions and response metadata.
- Provides MCP tools and command aliases.
- Saves NDJSON events and screenshot artifacts.
- Supports visible, headed Chromium fixture scripts only; headless launch is prohibited by the runtime contract.

## Observed gaps against the requested production tool

1. The visible cursor is injected page DOM/SVG (`src/browser/cursor.js`), so it is not an OS-native pointer and can alter page DOM/screenshots.
2. Input functions manipulate form values directly in page JavaScript (`typeSelector`), bypassing real input paths and reducing bug-reproduction fidelity.
3. Network telemetry contains only `responseReceived` metadata; it lacks request/response failure details, lifecycle timing, headers, and a safe request body policy.
4. Console capture lacks `Log.entryAdded`, timestamps normalized from CDP, clear filtering, and bounded retention.
5. Tools lack high-value diagnostics such as `networkLogs`, `failedRequests`, `performanceEntries`, `accessibilitySnapshot`, file upload policy controls, download tracking, and structured action trace export.
6. MCP schemas are inferred from a lossy string map; optional fields are incorrectly marked required and descriptions/enums are unavailable to agents.
7. Tests are standalone ad-hoc scripts rather than a structured real-browser coverage suite; no tested artifact contract covers MCP plus diagnostics.
8. `scripts/build.js` copies a portable Node directory but does not produce a self-contained executable and omits some runtime modules (for example `browserPool.js`).

## Edit Target List

1. `src/browser/cdpClient.js` — robust CDP lifecycle plus console/network diagnostics.
2. `src/browser/input.js` and `src/browser/cursor.js` — remove DOM pointer injection; route actions through CDP-native browser input only.
3. `src/browser/diagnostics.js` *(new)* — bounded, normalized console/network/performance diagnostics.
4. `src/tools/browserTools.js` — agent-oriented inspection, diagnostics, artifact, and assertion tools.
5. `src/mcp/mcpAdapter.js` and `src/mcp/mcpServer.js` — truthful MCP schemas and complete tool mappings.
6. `src/tools/toolExecutor.js` and `src/tools/verification.js` — action timing, error evidence, and machine-readable proof.
7. `src/config.js`, `src/index.js`, `src/browser/chromeLauncher.js` — explicit runtime modes, safe defaults, and reusable local sessions.
8. `scripts/build.js` — reproducible portable bundle and optional Windows executable path when a compatible Node SEA binary is available.
9. `tests/` — real local fault fixtures plus end-to-end CDP/MCP tests for form behavior, UI bugs, screenshot capture, console errors, network failures, and artifact output.
10. `README.md` and `browser-use-tracker.md` *(new)* — install/use/MCP configuration, verification results, limitations, and continuation marker.

## Scope boundary

This work does not modify the Lorde Design Studio application until the browser runtime has passed its own real-browser acceptance suite. Lorde AI-tab work will use this tool only at explicit plan checkpoints.
