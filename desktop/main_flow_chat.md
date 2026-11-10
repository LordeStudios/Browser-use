# Desktop Main Agent IPC Flowchart

## Purpose

`main.cjs` resolves a user-selected browser target, provider configuration, and
optional persisted conversation once, then starts the desktop agent without
silently changing any of them.

At Electron startup it also creates the first managed BrowserView before the
renderer becomes interactive. That keeps the native browsing surface and the
agent drawer in the same ready-state rather than accepting an action against an
empty tab registry.

The native BrowserView reservation and renderer drawer share the same 320px
minimum. A resize request is clamped once to that contract, then the native page
ends exactly where the renderer drawer begins; neither surface may cover the
other.

```text
+-----------------------+----------------------+
| Native page stage     | AI drawer            |
| width = W - drawer    | width = drawer       |
+-----------------------+----------------------+
                        ^
                        +-- visible inner-edge resize grip
```

```mermaid
graph TD
  A[Pointer or keyboard resize] --> B[Clamp requested width to 320px minimum]
  B --> C[Set renderer drawer CSS width]
  B --> D[Reserve identical native BrowserView width]
  C --> E[Drawer left edge]
  D --> F[BrowserView right edge]
  E --> G{Edges equal?}
  F --> G
  G -->|Yes| H[No cropped chat or page overlap]
  G -->|No| I[Geometry contract failure]
```

```text
+-------------------+
| Renderer request  |
+---------+---------+
          v
+-------------------+
| Resolve tab/model |
+---------+---------+
          v
+    active local tab?
+      |        |
+     yes       no
+      v        v
+  validate   create neutral
+  config only  task tab
+      |
+      v
+  start agent
+      |
+      v
+ compact events --> renderer patches
```

```mermaid
graph TD
  S[Native BrowserWindow created] --> T[Create and attach first managed BrowserView]
  T --> U[Load renderer shell]
  U --> A[Renderer agent-start]
  A --> V{Conversation ID supplied?}
  V -->|Yes| W[Load bounded persisted conversation]
  V -->|No| B[Start a new conversation]
  W --> B[Resolve explicit tab or selected tab]
  B --> C{Local provider and tab available?}
  C -->|no local tab| D[DesktopChatAgent creates neutral task tab]
  C -->|yes or remote provider| E[Resolve requested provider model]
  D --> E
  E --> F[Validate only required provider credentials/configuration]
  F --> G[Start DesktopChatAgent with exact tab/model]
  G --> H[Route recoverable decision errors into the next bounded turn]
  H --> I[Forward bounded revisioned events]
  I --> J[Renderer merges state patch]
  J --> P[Persist title messages optional plan working memory completed work and tool transcript]
  K[Selected native input target is detached] --> L[Reattach selected BrowserView and restore bounds]
  L --> M{View is paintable?}
  M -->|yes| N[Resume the same grounded input]
  M -->|no| O[Use same-tab background CDP delivery]
  P[Chat filename or screenshot clicked] --> Q[Validate managed file or bounded image]
  Q --> R[Attach overlay BrowserView last at full window bounds]
  R --> S2[Render blurred modal with Close and Download]
  S2 --> T2{Close or download?}
  T2 -->|Close| U2[Clear bytes and detach overlay]
  T2 -->|Download| V2[Write unique copy in Downloads]
```

## Process lifetime, background execution, and tray

The desktop main process owns the HTTP server and paired sessions. Focus, window
visibility, and the active tab are presentation state, not session lifetime.

```text
+----------------------------+
| Electron process starts    |
| Start MCP once; create tray|
+-------------+--------------+
              v
+----------------------------+     +---------------------------+
| Window visible / unfocused |<--->| Minimized in taskbar     |
| Same broker and tab views  |     | Timers remain unthrottled |
+-------------+--------------+     +-------------+-------------+
              |                                  |
              +---------------+------------------+
                              v
                 +---------------------------+
                 | Explicit Quit / OS exit? |
                 +------------+--------------+
                     no |          | yes
                        |          v
                  keep serving  release input, revoke sessions,
                                stop server, destroy tray, exit
```

```mermaid
graph TD
  A[Process starts] --> B[Start main-process MCP server and tray]
  B --> C[Create persistent tab views with backgroundThrottling false]
  C --> D{Window event}
  D -->|Blur| E[Keep same process and sessions]
  D -->|Minimize| M[Keep normal taskbar minimization; never call hide]
  M -->|Taskbar restore| H
  D -->|Close| F[Hide to tray; do not destroy views]
  F --> G{User chooses Show?}
  G -->|Yes| H[Restore existing window and tabs]
  G -->|No| E
  H --> D
  E --> D
  D -->|Explicit Quit or OS shutdown| I[Release inputs and stop MCP]
  I --> J[Destroy tray and release app-suspension blocker]
  J --> K[Process exits]
```

Page timers stay enabled in the background. A `prevent-app-suspension` blocker
keeps normal automatic idle suspension from interrupting the service, while
allowing the display to sleep; it cannot override a crash, forced termination,
or an explicit operating-system suspend. Explicit session revocation remains
available and is never bypassed for connection stability. Window close hides to
the tray only when a tray icon was created successfully; otherwise normal close
remains available. Tray **Quit** is the explicit dismissal action.

## Desktop MCP endpoint selection

The desktop application owns a stable loopback MCP origin so a configured
external tunnel does not break after every desktop relaunch. It deliberately
does not reuse the standalone CLI daemon port. Isolated Electron tests opt into
an operating-system-selected port with an explicit environment variable.

```text
+-------------------------------------------+
| BROWSER_USE_DESKTOP_MCP_PORT is provided? |
+--------------------+----------------------+
                     |
          +----------+----------+
          |                     |
         no                    yes
          |                     |
          v                     v
+------------------+   +------------------------+
| use 127.0.0.1:8792|  | validate integer 0..65535|
+---------+---------+   +-----------+------------+
          |                         |
          |              +----------+----------+
          |              |                     |
          |             0                  valid nonzero
          |              |                     |
          |              v                     v
          |     +----------------+    +------------------+
          |     | test OS port   |    | requested port   |
          |     +--------+-------+    +--------+---------+
          +--------------+---------------------+
                         v
            +------------------------------+
            | LocalMcpServer listens only  |
            | on 127.0.0.1 at that port    |
            +------------------------------+
```

```mermaid
graph TD
  A[Start desktop MCP] --> B{BROWSER_USE_DESKTOP_MCP_PORT set?}
  B -->|No| C[Use fixed 8792]
  B -->|Yes| D{Integer 0 through 65535?}
  D -->|No| E[Fail startup with clear port error]
  D -->|Yes| F{Port is 0?}
  F -->|Yes| G[OS assigns isolated ephemeral test port]
  F -->|No| H[Use requested desktop port]
  C --> I[LocalMcpServer binds 127.0.0.1]
  G --> I
  H --> I
  I --> J[Stable external tunnel may target 8792]
```

## Custom GPT Action tunnel path

The Lorde Studios Cloudflare Tunnel terminates HTTPS before forwarding only the
Action surface to the local desktop bridge. A more-specific no-Worker route
keeps the existing `lorde-studios` wildcard Worker from capturing this hostname.

```text
+---------------------------------------------+
| Custom GPT Action: gpt-browser.lordemaximus |
+--------------------------+------------------+
                           |
                    /gpt/* only
                           v
+------------------------------------------------+
| lorde-studios-gpt-action Cloudflare Tunnel     |
+--------------------------+---------------------+
                           v
+------------------------------------------------+
| 127.0.0.1:8792 LocalMcpServer /gpt/*           |
+------------------------------------------------+

other public paths --> 404
```

```mermaid
graph TD
  A[Custom GPT Action HTTPS request] --> B{Host gpt-browser.lordemaximus.com?}
  B -->|No| X[Normal Cloudflare routing]
  B -->|Yes| C{Path begins /gpt/?}
  C -->|No| D[Return 404]
  C -->|Yes| E[No-Worker exact route bypasses lorde-studios wildcard]
  E --> F[lorde-studios-gpt-action tunnel]
  F --> G[127.0.0.1:8792 LocalMcpServer]
  G --> H{OpenAPI schema?}
  H -->|Yes| I[Public schema discovery]
  H -->|No| J[Require X-API-Key for tools and calls]
```

## Visible GPT Actions setup

Settings is a native topmost overlay BrowserView. Its visible form, not the
underlying chrome renderer's duplicate form, owns the GPT Action controls and
must receive every refreshed MCP status payload.

```text
+-------------------+      +------------------+      +---------------------+
| Settings toolbar  | ---> | activeDrawer     | ---> | overlay.html form   |
+-------------------+      | = settings       |      +----------+----------+
                           +------------------+                 |
                                                               GPT Actions
                                                                  |
                   +----------------------------------------------+---------------------+
                   | OpenAPI URL | X-API-Key | copy schema | enabled switch | Save       |
                   +----------------------------------------------+---------------------+
                                                                  ^
                                                                  |
                                           browser-use:mcp-state / initial status snapshot
```

```mermaid
graph TD
  A[Person opens Settings] --> B[Main attaches topmost overlay BrowserView]
  B --> C[overlay.html shows Settings form]
  C --> D[Render GPT Actions controls]
  E[Desktop MCP status changes] --> F[Send mcp-state to main renderer and overlay]
  F --> D
  D --> G{Action bridge enabled?}
  G -->|Yes| H[Show public OpenAPI URL and X-API-Key]
  G -->|No| I[Show disabled state and allow enable-save]
```

## Claude Code MCP installation and reconnect authentication

The visible Settings overlay exposes a Claude Code-specific copy action. The
copied user-scoped configuration uses Claude Code's supported `headersHelper`
field. At every Claude session start or reconnect, the helper calls the local
Desktop authentication endpoint and receives a fresh short-lived pairing
header. A separate Settings action copies the currently displayed raw pairing
code for hosts that need manual setup.

```text
+-------------------------+
| Claude Code MCP button  |
+------------+------------+
             |
             v
+-------------------------+
| Validate MCP and        |
| authentication endpoint|
+------------+------------+
             |
             v
+-----------------------------------------------+
| claude mcp add-json --scope user              |
| browser-use-desktop                           |
| { url, headersHelper: curl authenticate }     |
+-----------------------+-----------------------+
                        |
                        v
+-------------------------+
| Copy command and show   |
| run-now feedback        |
+-------------------------+
```

```mermaid
graph TD
  A[Person clicks Claude Code MCP] --> B{Desktop MCP listening?}
  B -->|No| C[Keep button disabled]
  B -->|Yes| D[Validate loopback MCP and authenticate endpoints]
  D --> E[Build user-scoped add-json configuration]
  E --> E2[Escape JSON for Windows PowerShell stop parsing]
  E2 --> F[Configure headersHelper curl command]
  F --> G[Copy install command to clipboard]
  G --> H[Person runs command once and verifies with /mcp]
  I[New Claude session or reconnect] --> J[Run headersHelper]
  J --> K[GET mcp authenticate]
  K --> L[Return fresh pairing header JSON]
  L --> M[Initialize MCP]
  N[Person clicks Copy pairing code] --> O[Copy current raw code only]
```

## AGI computer-tool attachment

The user-selected `mcpControlMode` and `agentControlMode` default to Browser only.
The shared backend is created lazily; main passes getters into the existing MCP
and chat executors. Settings are accepted only from trusted app renderers. Scope
downgrade invalidates affected native work without restarting MCP. Existing
Full access / Ask remains the chat permission authority. Explicit app Quit awaits
native input/job and recording cleanup before disconnecting the terminal broker.
See `computer/computerTools_flow_chat.md` for ASCII/Mermaid routing and coordinates.

## Invariants

1. A validated `request.tabId` is not replaced with the selected tab. A local
   task with no available tab creates one neutral task tab inside the agent;
   remote providers do not require a local BrowserView.
2. `request.provider.model` is preferred over legacy model fields for every provider.
3. Intermediate agent events are bounded patches, not full ever-growing run histories.
4. Full state remains available through an explicit state request and terminal lifecycle events.
5. Connection preflight is an explicit Settings/test action, not a hidden gate on
   every task. Runtime model-response errors enter the agent recovery loop with
   their bounded error context.
6. A connection persists its selected provider-discovered model by connection
   ID. Runtime starts use that exact selected model rather than a generic
   hardcoded fallback or an ephemeral renderer-only selection.
7. The first BrowserView is created and selected before `did-finish-load` for
   the renderer. A visible agent drawer must never accept a task while the tab
   registry is temporarily empty solely because the renderer finished first.
8. Provider-model discovery is a bounded read-only probe. Transient endpoint
   failures receive one short retry; authentication and other non-transient
   responses remain visible instead of being retried indefinitely.
9. The main shell exposes one synchronous selected-view recovery callback to
   the BrowserView controller. It may only reattach and lay out the already
   selected tab; it cannot select another tab, close an overlay, or broaden the
   requested action. If the compositor remains unavailable, controller-level
   CDP delivery still addresses only that exact requested WebContents.
10. `continuation`, `conversationId`, and the persisted conversation snapshot
    are forwarded through every provider branch. Provider routing cannot drop
    follow-up context.
11. History persistence stores title, ordered messages, optional plan, and tool
    transcript as separate fields. Loading a title never fabricates a user turn.
12. Terminal persistence also stores a redacted bounded prior-reasoning tail and
    semantic completed-work ledger. Reopening a conversation restores strategy
    continuity without converting internal reasoning into a visible plan or
    replacing any user prompt.
13. Report and screenshot previews are owned by the native overlay BrowserView,
    not a renderer dialog beneath the active page. While a preview is open the
    overlay covers the full content window, is attached last, blurs everything
    below it, and releases its file/image payload when closed.
14. The renderer and main process both clamp the AI drawer to the same 320px
    minimum. The native page right edge must equal the drawer left edge after
    every pointer, keyboard, restored, or programmatic resize.
15. Desktop MCP bootstrap codes are short-lived recovery credentials, not
    long-lived bearer tokens. The local server maps them to one opaque
    `Mcp-Session-Id`; broker session ids remain visible only for local session
    status and cannot authorize an external request. Pairing enables the full
    MCP tool catalog without separate approval controls.
16. The desktop app defaults to `127.0.0.1:8792`, which is distinct from the
    CLI daemon's `8790` and its `8791` integration fixture. Only an explicit
    `BROWSER_USE_DESKTOP_MCP_PORT=0` may request an ephemeral desktop port for
    an isolated Electron test; a busy fixed port must fail instead of silently
    switching the external tunnel to an unknown origin.
17. `gpt-browser.lordemaximus.com/*` explicitly disables Workers so the more
    general `*.lordemaximus.com/*` `lorde-studios` route cannot intercept the
    tunnel. Only `/gpt/*` reaches the local desktop bridge; schema discovery is
    public while every Action tool request continues to require `X-API-Key`.
18. The visible Settings overlay must contain the complete GPT Actions setup;
    copies in the underlying chrome renderer are never sufficient. Both
    renderers receive `browser-use:mcp-state` so a save or bridge restart
    cannot leave the topmost Action URL, key, or schema stale.
19. The Claude Code installer copies the official user-scoped `add-json` form
    with a `headersHelper` that obtains a new short-lived pairing code from the
    loopback-only authentication endpoint on every connection. It never edits
    Claude configuration files itself or launches a shell on the person's
    behalf. Its copied command escapes the JSON quotes (`\"`) so cmd.exe,
    Git Bash, and PowerShell 7 pass the definition to the Claude CLI intact;
    the PowerShell-only `--%` stop-parsing token was removed because every
    other shell delivered it to the CLI as a literal, invalid argument.
    Settings separately exposes the current raw code for manual copy.

## Shared multi-chat dock geometry and ownership

```text
+------------------------------+
| Chat 1 / Chat 2 / Chat 3     |
| desired pane widths          |
+---------------+--------------+
                v
+------------------------------+
| One native dock metric pass  |
| clamps effective widths     |
+---------------+--------------+
                v
+------------------------------+
| Page bounds + pane bounds    |
| are applied without reattach |
+---------------+--------------+
                v
+------------------------------+
| Lightweight geometry event   |
| updates renderer CSS offsets |
+---------------+--------------+
                v
+------------------------------+
| pointerup publishes settled  |
| state and final revision     |
+------------------------------+

Chat 2/3 X -> sender-owned chat id -> close only that entry
Chat 1 X   -> primary drawer close -> activeDrawer = null
```

```mermaid
graph TD
  A[Chat pane drag] --> B[Store latest desired width]
  B --> C[One shared chatDockMetrics pass]
  C --> D[Clamp effective pane widths]
  D --> E[Set page and dock BrowserView bounds in place]
  E --> F[Send lightweight geometry event]
  F --> G[Renderer updates CSS offset immediately]
  G --> H{Pointer released?}
  H -->|No| A
  H -->|Yes| I[Publish settled state and revision]
  J[Extra chat X] --> K[Resolve sender or explicit chat id]
  K --> L[Close only resolved extra entry]
  M[Chat 1 X] --> N[Close primary drawer]
```

## Agent recovery and tab ownership

```text
+---------------------------+
| Agent run owns tab set    |
+-------------+-------------+
              v
+---------------------------+
| New tab requested         |
+-------------+-------------+
              v
+---------------------------+
| Switch target first       |
+-------------+-------------+
              v
+---------------------------+
| Close previous owned tab  |
| never close user tab      |
+---------------------------+

Transient failure -> same run id -> fresh observation -> continue.
Hard provider/cancel -> terminal reason, never fake recovery exhaustion.
```

```mermaid
graph TD
  A[Run starts] --> B[Track owned tab ids]
  B --> C[browser_new_tab]
  C --> D[Switch to new tab]
  D --> E[Close old owned tab]
  E --> F[Continue run]
  F --> G{Transient failure?}
  G -->|Yes| H[Fresh same-run recovery episode]
  H --> F
  G -->|No| I{Hard provider or cancel?}
  I -->|Yes| J[Publish actionable terminal outcome]
  I -->|No| K[Complete and close stale owned tabs]
```

## Splash-gated Electron startup

```text
+-----------------------------+
| app.whenReady + lock        |
+--------------+--------------+
               v
+-----------------------------+
| Show splash immediately     |
| main BrowserWindow hidden   |
+--------------+--------------+
               v
+-----------------------------+
| Initialize MCP, settings,  |
| BrowserView, and renderer  |
+--------------+--------------+
               v
+-----------------------------+
| did-finish-load + renderer |
| ready IPC both received    |
+--------------+--------------+
               v
+-----------------------------+
| Layout BrowserViews, show  |
| main window, close splash  |
+-----------------------------+
```

```mermaid
graph TD
  A[app.whenReady] --> B[Acquire single-instance lock]
  B --> C[Show splash window immediately]
  C --> D[Create hidden main BrowserWindow]
  D --> E[Initialize BrowserViews and renderer]
  E --> F{Renderer load and ready IPC?}
  F -->|No| G[Keep splash visible]
  G --> F
  F -->|20s fallback| H[Reveal with startup warning]
  F -->|Yes| I[Reconcile layout]
  I --> J[Show main window]
  J --> K[Close splash]
```
