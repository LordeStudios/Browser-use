# browser-use

`browser-use` is a reusable local browser automation runtime for AI agents. It launches or connects to Chrome/Chromium through Chrome DevTools Protocol (CDP), executes proof-first browser commands, streams events over WebSocket, can drive one-action-at-a-time Ollama loops, and exposes MCP-compatible command mappings.

## What it is not

It is a headed, local visual browser-control application: it opens a visible Chromium session and a Browser-use Control Center tab for live state, actions, diagnostics, and MCP-connected agent activity. It is not a headless-only test suite or a browser extension marketplace product.

## Install

```bash
cd tools/browser-use
npm install
```

Chrome or Chromium must be installed, or set `CHROME_PATH=/path/to/chrome`.

To resume the desktop development session after a restart, run `npm run desktop:dev_resume -- --defer=5`.

## Start the headed Browser-use application

```bash
npm run start -- --url http://localhost:5173
```

Browser-use launches a dedicated desktop browser application:

1. **Your target website**: the actual website being inspected or tested inside a managed browser tab.
2. **Browser-use application chrome**: tab strip, navigation controls, MCP-ready status, and on-demand console/settings surfaces around the managed browser content.

The runtime is headed-only. There is no `--headless` mode. In the Electron desktop app, agent interactions render through a separate click-through child window owned by Browser-use, so activity remains visible without mutating the controlled page or moving the person’s host OS pointer.

## Connect to existing browser

Launch Chrome with remote debugging, then:

```bash
npm run start -- --connect http://localhost:9222
```

## Smoke test

```bash
npm run smoke
```

## One command mode

```bash
node src/index.js --command browser.screenshot
node src/index.js --command browser.domSnapshot
```

## Input fidelity and pointer behavior

Browser-use dispatches pointer, keyboard, scroll, drag, and text input through Chromium's native Electron/CDP input pipeline. The Electron desktop app keeps one non-interactive pointer in an app-owned transparent child window. It appears immediately on agent activity, moves on an interruption-safe animation timeline, plays click feedback at the native input coordinate, and rapidly fades to full transparency after inactivity without removing its mounted node. Page navigation and page scripts cannot detach or reposition it.

CDP remains the authoritative interaction path and reports the exact viewport coordinate used for every action. The action trace records pointer coordinates, method, timing, diagnostics deltas, and before/after page state.

## Real-browser acceptance tests

```bash
npm run test:production  # headed form interaction + screenshot + console error + HTTP 503 capture
npm run test:mcp         # headed stdio MCP initialize/list/call contract
npm run test:headed-loop # cold/reuse visible browser stages: form → conditional UI → SPA state
npm run test:desktop:pointer # real Electron/MCP motion, interruption, click, fade, navigation, and renderer recovery
npm test                 # all headed Browser-use acceptance checks
```

`tests/production-fixture.html` intentionally emits a console error and an HTTP 503 after a real click. This makes diagnostic coverage observable rather than assumed.

## Desktop background operation

Run `npm run desktop:dev` to launch the Electron app. Minimizing keeps its normal
taskbar entry so it can be restored without relaunching. Closing the window keeps
it running in the system tray with the same tabs and paired MCP sessions. Use the
tray's **Show Browser-use** action to restore it, and **Quit Browser-use** to
terminate the desktop process. If a tray icon cannot be created, window close
falls back to normal application exit. Running the command while the app is
already running restores that instance; the second launch then exits normally.

### Resuming a dev session

`npm run desktop:dev_resume` stops this checkout's running dev build and starts
it again **at the exact point it left**: the same tabs (with the same one
selected), the same chat open in the panel, the same model, and an unfinished
run continuing where it stopped. `npm run desktop:dev_restart` does the same with
a fresh session, and `npm run desktop:dev_kill` only stops the dev build.
`scripts/dev-resume.bat` is the one-click / agent-runnable wrapper
(`--list` shows what would be stopped, `--attach` keeps the console attached).

The app writes `dev-session.json` into its user-data directory while it runs
(throttled, flushed on quit) and reads it back only when the launcher sets
`BROWSER_USE_DEV_RESUME=1`, a plain `npm run desktop:dev` never resurrects a
previous session. The kill is scoped to electron.exe processes whose executable
lives inside this repository, so other Electron apps on the machine are
untouched.

#### Restarting from inside the agent

An agent running in the app cannot kill the app and keep going: its own terminal
dies with it, and so does anything spawned from that terminal. So the timer is
handed to an **external shell**: `--defer` launches
`scripts/dev-resume-deferred.bat` through `cmd /c start`, which gives it its own
console outside the app's process tree:

```
npm run desktop:dev_resume -- --defer=5
```

then end the turn (`browser_done`). The batch file waits 5 seconds (an external
`powershell Start-Sleep`, not the console-bound `timeout`), then stops the dev
build and relaunches it; the app reopens the same conversation and continues the
run that was cut off.

`--defer=N` sets the grace window (default 5s, max 120s). The timer can also be
run directly, `scripts\dev-resume-deferred.bat 8`, and `--dry-run` prints the
plan without stopping anything. The timer's trace lands in
`scratch/dev-resume-helper.log`.

What the resume does with the chat it restores:

| Last run state | On resume |
|---|---|
| `running` / `starting agent` / `interrupted` | the conversation reopens **and the run continues** on its own, no typing "continue" |
| `completed` / `failed` / `cancelled` | the conversation reopens, nothing restarts |
| `paused` / `awaiting_approval` | the conversation reopens and waits for you, a restart never answers a question meant for a person |

Switching the bound MCP tab releases held input without disconnecting the host.
Pairing codes remain short-lived; an already-paired session does not expire while
the process is running unless explicitly revoked. Standard authenticated `ping`
requests work without a tab binding. Page timers continue while hidden, and the
app prevents automatic idle suspension while allowing display sleep. Explicit OS
sleep, process termination, or a crash can still interrupt transport; no application
can guarantee connectivity through those conditions.

`npm run test:desktop:background` launches a separate Electron test profile and
verifies rebinding, background timers/input, tray behavior, a 330-second quiet
idle period with the same MCP session, and explicit shutdown.

## AGI computer control (Windows)

Choose **AGI (Computer control)** in Desktop Settings for MCP, or **AGI** in the
chat composer's mode selector. **Browser only** preserves the original browser
scope. This is native computer automation, not a claim of general intelligence.

The existing permissions remain authoritative: MCP uses the paired client's tool
permissions; chat uses its existing **Full access** or **Ask** control. There is
no second permission panel. AGI exposes these shared tool groups:

- `computer_observe` / `computer_window`: physical display geometry, visible
  native windows and foreground focus.
- `computer_pointer` / `computer_keyboard`: native movement, clicks, drags,
  scrolling, key chords/held keys, and Unicode typing.
- `computer_stroke`: bounded multi-point stroke batches. Drawing fields are kept
  out of the ordinary pointer schema; unused optional arguments may be omitted or null.
  Legacy coordinates remain physical desktop pixels. Use `coordinateSpace: "screenshot"`
  with the latest `screenshotId` to map image pixels automatically. Stroke batches
  require a focused `windowId` and observed drawable `region`; every point is
  validated before execution, with focus/geometry/occlusion checks during input.
  These tools send actual mouse events, not generated artwork or automatic tracing.
- `computer_terminal`: unrestricted shell commands, real exit/output evidence,
  background jobs, cancellation and agent-owned interactive PTY sessions.
- `computer_file`: read existing files, create or overwrite files, append,
  exact edits, binary/base64 content, stat/list/search, mkdir, copy, move and
  delete. Paths are real absolute paths, not an artificial workspace allowlist.
- `computer_clipboard`: read/write system text clipboard.
- `computer_screenshot` / `computer_record`: desktop images with coordinate
  mapping and streamed WebM screen recordings.

The terminal provides general-purpose access to installed programs, scripts,
package managers and network/CLI tools. Existing browser tools and `update_plan`
remain available. Jobs expose real status/exit codes; dispatch alone is not proof
that their work finished. Completed chat turns retain explicitly started jobs
and recordings for follow-up. Stop, scope downgrade, session revocation and app
Quit release the affected native resources. Successful turn completion releases
held keys/buttons without stopping an intentionally launched server or recording.

Fresh local AGI chats receive native desktop metadata before their first model
turn. Auto vision does not capture a startup screenshot unless requested or
needed after native GUI input; Always vision does. Continuations retain their
browser/native evidence domain, subject to the currently selected scope.
Performance diagnostics distinguish outer model decisions (`providerCalls`)
from actual HTTP attempts (`providerRequests`), including retries and repairs.
Request durations include response-body reading; they are not pure thinking time.

The native pointer shares the Windows system cursor. The browser's independent
pointer stays unchanged. OS elevation and secure-desktop protections still apply.
The public GPT Action bridge stays browser-only. Native modules/capture load
lazily; Browser-only does not start a computer helper or change its system prompt.

```bash
npm run test:computer       # real files/commands, scope and existing approvals
npm run test:computer:e2e   # Windows GUI, MCP/chat selectors, image/video evidence
```

## Process lifecycle

When launching its own Chrome, the runtime picks the configured CDP port (default 9222) and automatically falls back to the next free port if it is already in use. On shutdown it kills the entire Chrome process tree on Windows (`taskkill /T /F /PID`) and closes the CDP client, leaving no orphaned `browser-use-profile` Chrome processes.

## Realtime paired control (foundation)

Browser-use now has a separate **loopback-only** pairing and realtime foundation. It deliberately separates MCP supervision from sustained input and frame traffic:

1. `POST /pairing/offer` creates a short-lived, one-time pairing code.
2. `POST /pairing/pair` binds the supplied client and exact browser target (`browserInstanceId`, `tabId`, `cdpTargetId`) to a capability-scoped session.
3. `ws://127.0.0.1:<port>/realtime/v1` authenticates the session as a controller or observer.
4. Controllers send ordered `input.pointer`, `input.wheel`, `input.key`, and `input.text` messages; observers receive transient binary screencast frames.

The realtime input scheduler coalesces stale pointer movement while preserving mouse/key edge events. On disconnect it releases every tracked pressed key and button. Frames use CDP screencast delivery and acknowledgements; they are not written to the screenshot or event-log directories.

The browser-use extension in `extension/` is the first-release explicit-tab approval surface. It lets a person select the active Chrome tab and produces a one-time local pairing offer. **The extension-to-runtime CDP target bridge is not complete yet:** it must not be used to claim control of an arbitrary Chrome tab until the extension returns an authoritative, verified target mapping. For now, standalone realtime use requires an explicit `--connect` CDP endpoint and a real CDP target ID; the runtime fails closed instead of guessing a tab.

## Legacy WebSocket commands

Start the legacy automation server and send JSON to `ws://localhost:8765/commands`:

```json
{"id":"cmd-1","command":"browser.screenshot","args":{}}
```

Events are streamed from `ws://localhost:8765/events`. These command/event endpoints are retained for diagnostic and automation compatibility; they are not the realtime game-control data plane.

## Desktop paired input

The Electron desktop pairing endpoint exposes the complete MCP tool catalog for the explicitly bound Browser-use tab as soon as pairing succeeds, including browser-level mouse move/down/up, wheel, key down/up/press, and text insertion. This runs through Electron `webContents.sendInputEvent` / `insertText`, not a Lorde Studio DOM fallback.

The desktop path is currently a user-visible browser container. It does not yet expose a binary frame stream; use the standalone realtime endpoint for screencast-stream work.

> CDP and Electron input control browser tab contents. They do not move the host OS cursor or operate arbitrary native desktop games.

## Ollama Gemma 4

Defaults are `OLLAMA_BASE_URL=http://localhost:11434` and `OLLAMA_MODEL=gemma4`.

```bash
npm run start -- --agent --goal "Open the page and take a screenshot"
npm run start -- --agent --model gemma4
npm run start -- --no-agent
```

The model must return exactly one JSON object, for example:

```json
{"command":"browser.screenshot","args":{}}
```

Arrays, markdown, explanations, and unknown tools are rejected.

## Session-based MCP over HTTP (preferred)

The HTTP daemon mirrors the LordeDesign Studio `McpSession` architecture: one long-lived process owns one persistent visible browser, and MCP clients attach to it with `Mcp-Session-Id` sessions instead of spawning a fresh browser per connection.

```bash
node src/index.js --mcp-http                 # default: http://127.0.0.1:8790
node src/index.js --mcp-http --mcp-port 9000 --gpt-key <key-for-chatgpt>
```

Environment variables: `BROWSER_USE_MCP_PORT`, `BROWSER_USE_MCP_HOST`, `BROWSER_USE_MCP_SECRET`, `BROWSER_USE_GPT_KEY`. If no secret is configured, a per-daemon secret is generated and printed once at startup.

Connection flow (identical contract to the Studio relay):

1. `POST /mcp/token` with `{ "key": "<your connection key>" }` → `{ token }` (HMAC-signed, short-lived).
2. Send standard Streamable HTTP MCP JSON-RPC to `POST /mcp` with `Authorization: Bearer <token>`. `initialize` returns an `Mcp-Session-Id` response header; send it back on every request.
3. Requests with an unknown/expired session id fail with JSON-RPC `-32001`, re-initialize and retry (sessions are metadata; the browser and all page state survive).
4. `DELETE /mcp` closes just your session record. `GET /mcp/sse` streams response mirrors.

See `mcp-config.example.json` for Claude Code registration and `mcp-http_flow_chat.md` for the full architecture flowchart.

## ChatGPT support

Two surfaces, matching the Studio worker:

- **Native MCP connector**: point ChatGPT's MCP integration at `http://127.0.0.1:8790/mcp` with the bearer token (requires a tunnel such as `cloudflared` if ChatGPT must reach your machine from outside).
- **GPT Action bridge**: start the daemon with `--gpt-key <secret>`; then a custom GPT imports `GET /gpt/openapi.json` (auth: `X-API-Key: <secret>`) and calls `POST /gpt/call/<toolName>`. The OpenAPI schema is generated from the live tool registry, so the Action and MCP surfaces never drift. Results follow the Studio contract (`{ ok, result: { text, imageUrl } }`).

## Official upstream Browser Use agent

The official Python Browser Use source is kept in `.upstream-browser-use` and is invoked through a separate runtime boundary so this Electron/CDP application keeps ownership of its visible browser sessions. The upstream agent includes its native multi-provider LLM adapters, browser/session watchdogs, structured task history, filesystem/document workflows, cloud integrations, and official MCP implementations.

```bash
# Official Browser Use MCP server with built-in autonomous Agent capabilities.
npm run upstream:mcp

# Official Browser Use CLI 3.0 MCP server with persistent Browser Harness helpers.
npm run upstream:cli-mcp

# Advance the nested upstream checkout to the latest fetched origin/main revision.
npm run upstream:sync
```

`upstream:mcp` and `upstream:cli-mcp` run `uv` from `.upstream-browser-use`; override the runtime only when necessary with `BROWSER_USE_UPSTREAM_DIR` and `BROWSER_USE_UPSTREAM_UV`. The upstream `Agent` needs a configured LLM provider credential (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `BROWSER_USE_API_KEY`) to run autonomous tasks. No credential is required merely to install or start the MCP server.

## MCP-compatible stdio mode (legacy)

```bash
node src/index.js --mcp
```

Supported JSON-line methods include `tools/list`, `tools/call`, `resources/list`, `resources/read`, and `prompts/list`. MCP names map to internal tools, e.g. `browser_screenshot` -> `browser.screenshot`. Each stdio host spawns its own process and browser; stdio mode binds no local ports, so concurrent spawns are safe, but prefer `--mcp-http` for shared, persistent sessions.

## Logs and replay

Each run writes NDJSON under `tools/browser-use/logs/<session-id>/events.ndjson` and screenshots under `screenshots/`.

```bash
npm run replay -- --session <session-id>
```

## Security notes

Default permissions allow `read` and `browser-control`. Browser edit actions and dangerous actions require explicit configuration. Do not use this against accounts or websites where automated actions may publish, delete, purchase, upload, or change private data unless you intentionally allow and monitor those risks.

## Package the Electron desktop application (Windows)

Build the desktop browser application from a Windows x64 machine:

```bash
cd tools/browser-use
npm ci
npm run desktop:package
```

A successful command verifies and prints both native Electron executables:

- `desktop-release/Browser-use-<version>-setup.exe`, NSIS installer.
- `desktop-release/Browser-use-<version>-portable.exe`, portable application executable.

The package command exits non-zero if Electron Builder fails or either required executable is missing or empty. The executables include Electron, so a separate system Node.js installation is not required to launch them. Windows may show a SmartScreen warning for an unsigned release; signing is required for trusted production distribution.

Open the desktop application's **Settings** drawer and copy its generated MCP JSON into an MCP host such as Claude Code. The host starts the installed Browser-use executable in Electron Node mode when it connects, so the desktop MCP integration requires neither this repository nor a system Node.js installation. Runtime logs and browser profiles are stored under the current user's Browser-use application-data folder, outside the installation directory.

Run the focused release checks before distributing a build:

```bash
npm run test:desktop:units
npm run test:mcp:electron
npm run test:desktop
npm run desktop:package
npm run test:desktop:packaged
```

`test:desktop:packaged` launches the built `desktop-release/win-unpacked/Browser-use.exe` as an ordinary desktop application, not through `ELECTRON_RUN_AS_NODE`, and not as a Playwright-driven Chrome page, then asserts the local MCP endpoint answers and the browsing surface fills the window below the app chrome across resize, maximize, and drawer transitions.

The browsing surface is an Electron `BrowserView` whose bounds are set from the main process on every window geometry change. `setAutoResize()` is deliberately not used: it left the native surface holding stale width and height after a window transition, cropping pages at the left and bottom edges until opening and closing Settings detached and reattached the view. Bump the package version before packaging so a new build never reuses a distributed artifact filename.

## Build the Node/MCP runtime bundle

The separate Node bundle is for MCP and command-line automation, not the Electron desktop application. When `.upstream-browser-use` is present, the build bundles that pinned upstream source (without its Git metadata) alongside the Node runtime; Python/uv still must be available on the machine when launching the official upstream agent:

```bash
cd tools/browser-use
npm run build
```

It creates `release/browser-use-<version>/` with launch scripts and runtime sources. This bundle requires a compatible Node.js installation and Chrome/Chromium on the target machine.

## Use as an MCP server from any agent

The runtime auto-detects stdio mode: when stdin is piped and no explicit mode flags (`--smoke`, `--command`, `--agent`, `--connect`, `--mcp`, `--url`) are given, it starts the MCP stdio server.

```bash
# Called by an agent over stdio
./release/browser-use.bat
```

Or explicitly:

```bash
node src/index.js --mcp
```

Supported MCP methods include `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, and `prompts/get`. The prompt `browser_use_agent_card` contains the exact connection, tab-selection, pointer, and tool-use instructions an agent should follow, plus the complete tool catalog. See [FAST_MCP_CONNECTION.md](FAST_MCP_CONNECTION.md) for the reverse-engineered connection/pointer guide.

## Troubleshooting

- `No Chrome/Chromium binary found`: install Chromium or set `CHROME_PATH`.
- CDP timeout: the runtime auto-fallbacks to the next free port; if it still fails, ensure no stale Chrome profile lock is blocking `.browser-use-profile`.
- Ollama errors: verify `ollama serve` is running and `ollama pull gemma4` has completed.
- Permission denied: pass only safe commands or enable broader permissions intentionally.

## Resume

Read `/browser-use-tracker.md` for current phase, commits, push status, tested commands, and blockers before continuing work.
