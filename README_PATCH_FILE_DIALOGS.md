# File dialogs, agent-owned Open and Save

Owner directive: the agent must be able to **open, save and attach files without the native
dialog**, and it must **know when a dialog is open**: in the desktop app, the CLI and over MCP.

## What was added

| Piece | File | Role |
|---|---|---|
| Bridge | `desktop/mcp/fileDialogBridge.cjs` | Owns the CDP interception: file chooser events, file attachment, download routing, direct saves |
| Controller methods | `desktop/mcp/browserViewController.cjs` | `fileDialogArm/State/Accept/Cancel`, `downloadsSetPath/List`, `saveFileToDisk` |
| MCP tools | `desktop/mcp/localMcpServer.cjs` | Seven tools with schemas (below) |
| Agent catalog | `desktop/agent/agentInternals.cjs` | Risk class, description, argument hints and executor branch for each tool |
| Desktop wiring | `desktop/main.cjs` | Creates the bridge; tells a running agent when a picker opens |
| CLI parity | `cli/agent-cli.mjs`, `cli/webContentsAdapter.cjs` | Same bridge; the CDP adapter gained per-method `subscribe()` |
| Tests | `tests/file-dialog-bridge.test.mjs` | 10 tests, Electron-style and CLI-style debugger |

## Tools

| Tool | What it does |
|---|---|
| `browser_file_dialog_arm` | Turns on interception for the tab (call once before an upload/download action) |
| `browser_file_dialog_state` | `{ pending: { mode, multiple, backendNodeId }, downloads, downloadPath }`, non-null `pending` means a dialog is open and waiting |
| `browser_file_dialog_accept` | `{ files: ["C:/abs/path.png"] }` → attaches them, no OS dialog |
| `browser_file_dialog_cancel` | Dismisses the picker like pressing Cancel |
| `browser_downloads_set_path` | `{ directory }` → every Save goes there instead of prompting |
| `browser_downloads_list` | Download states, bytes, destination paths |
| `browser_save_file` | `{ path, text | base64 }` → writes content with no dialog at all |

## How it works

Chromium's chooser is intercepted at the protocol level:

```
Page.enable
Page.setInterceptFileChooserDialog { enabled: true }
  → Page.fileChooserOpened { frameId, mode, backendNodeId }     (event, stored as pending)
DOM.setFileInputFiles { files, backendNodeId }                  (answer it)
Page.handleFileChooser { action: 'cancel' }                     (dismiss it)
Browser.setDownloadBehavior { behavior:'allow', downloadPath, eventsEnabled:true }
  → Browser.downloadWillBegin / downloadProgress                (saves, no dialog)
```

`Page.handleFileChooser` is the fallback when `DOM.setFileInputFiles` is rejected by an older
Chromium. Because the per-call `withDebugger` helper in the controller attaches and detaches per
command, the bridge keeps **its own persistent attachment**; every other CDP call reuses it.

## Agent awareness

1. **Pull**: the tool description tells the model to call `browser_file_dialog_state` after any
   action that may open a picker; a non-null `pending` is the signal.
2. **Push** (desktop): `main.cjs` steers a running agent the moment `fileChooser.opened` fires , 
   *"A native file chooser is open… call browser_file_dialog_accept…"*, so it does not go hunting
   for the OS window. When no run is active the steer is skipped and polling remains available.

## Typical flows

**Attach a file to an upload**
```
browser_file_dialog_arm
browser_click { element: <upload button> }
browser_file_dialog_state        → pending: { multiple: false }
browser_file_dialog_accept { files: ["C:/Users/me/photo.png"] }
```

**Download without a Save dialog**
```
browser_downloads_set_path { directory: "C:/Users/me/Downloads/lorde" }
browser_click { element: <download link> }
browser_downloads_list          → { state: "completed", path: ".../report.pdf" }
```

**Write an output file**
```
browser_save_file { path: "C:/Users/me/report.md", text: "# Report…" }
```

## Tests

`node --test tests/file-dialog-bridge.test.mjs`, 10/10:

- attach arms interception once, idempotent, no duplicate `setInterceptFileChooserDialog`
- `fileChooserOpened` becomes pending state; `selectMultiple` sets `multiple`
- accept sends absolute paths via `DOM.setFileInputFiles` with the chooser's `backendNodeId`
- accept rejects missing files and several paths for a single-file picker
- accept without a chooser explains itself (`NO_FILE_CHOOSER`)
- cancel uses `Page.handleFileChooser { action: 'cancel' }` and clears pending
- downloads are routed to a created directory and tracked started → completed
- `saveFile` writes text and base64, creating parent directories
- the controller exposes all of it through the MCP-facing methods
- the CLI adapter's `subscribe()` path delivers chooser and download events and releases them

## Test game, `tests/fixtures/file-dialog-game.html`

A two-level game that exercises both dialogs and prints every step into an on-page log:

1. **Attach the key**: "Choose file…" / "Choose several…" / drag-and-drop. The native picker opens;
   the agent answers with `browser_file_dialog_accept` and the file appears as a treasure with its
   name, size and type. +10 per file.
2. **Save your inventory**: "Save inventory (.json)" / "Save notes (.txt)". A download starts; the
   agent routes it with `browser_downloads_set_path`. +25 per save.
3. **Event log**: the evidence trail the agent can quote back.

Save target shown on the page: `C:/Users/london/lorde-quest/` (`~/lorde-quest/` elsewhere), set by
`browser_downloads_set_path` before the click.

### End-to-end verification (real Chromium, not a mock)

`node tests/file-dialog-game.e2e.cjs` launches Edge/Chrome headless with remote debugging, connects
to the **page target**, arms `Page.setInterceptFileChooserDialog`, and drives **real mouse events**
(a script-only `element.click()` is refused by Chromium for pickers). Measured output:

```
PASS chooser intercepted: {"mode":"selectSingle","backendNodeId":4}
PASS file attached and page logged it
PASS score after attach: 10
PASS save routed without a dialog: lorde-quest-save.json inventory items: 1
RESULT all file-dialog paths work end to end
```

Two traps this harness had to solve, worth keeping in mind for any future CDP work:
`Page` only exists on a **page** target (a browser-target client silently no-ops), and Chromium
requires **user activation** before opening a file chooser, so `Input.dispatchMouseEvent` is
mandatory.

## Live-run failure and the fixes (round 2)

The first live run against the game failed in three distinct ways. Transcript evidence and cause:

| Symptom in the run | Cause | Fix |
|---|---|---|
| `browser_file_dialog_arm` answered `attached: false` six times | `attachedHere` was only true when the bridge itself attached; the debugger lease manager already held the session, so the bridge reported "not attached" while it had in fact armed | `state()` now reports **`attached`** (live debugger session) and **`armed`** (interception on) as separate facts, and `arm` re-sends `setInterceptFileChooserDialog` on every call |
| The OS dialog still opened after arming | a lease-manager detach wipes `Page.setInterceptFileChooserDialog`; the bridge kept claiming it was armed and never noticed | `detach` event clears `armed`, so the next `arm`/`state` re-arms; listener wiring is idempotent (no stacked handlers) |
| `pending` stayed `null`, and `accept` then refused ("No file chooser is open") | attachment was gated on having observed the chooser event, if interception was wiped, nothing could ever be attached | **direct attach**: with no pending chooser, `accept` resolves `input[type=file]` via `DOM.getDocument` + `DOM.querySelector` and sets the files with `nodeId`. Attachment no longer depends on the event |
| the model clicked a **disabled** "Save inventory" button three times and waited for a download | `clickElement` dispatched on a disabled control and reported success | the controller now returns `ok:false, recoverable:true` with *"…is disabled, so the click would do nothing. Satisfy whatever enables it first"* |

### Verification (real Chromium, `node tests/file-dialog-bridge.e2e.cjs`)

```
PASS arm: {"attached":true,"armed":true}
PASS chooser intercepted: {"mode":"selectSingle","backendNodeId":4}
PASS accept via chooser: {"via":"chooser","mode":"selectSingle"}
PASS accept without a chooser event (direct DOM attach): {"via":"dom","mode":"direct"}
PASS save routed: lorde-quest-save.json inventory: 2
PASS score: 45 (2 files + 1 save)
RESULT bridge survives detach, answers without an event, and saves without a dialog
```

Unit suite is now **12/12** (`node --test tests/file-dialog-bridge.test.mjs`), adding: direct attach with a fake DOM,
the "no file input matched" explanation, and an already-attached debugger still reporting `attached`/`armed`.

## Live-run friction, round 3 (desktop / Electron)

The second run **completed the game** (score 60, both saves) but exposed two real defects and one detour:

| Evidence in the run | Cause | Fix |
|---|---|---|
| `browser_downloads_set_path` returned ok, yet `computer_fs list C:/Users/london/lorde-quest` showed **total: 0**, and `downloads: []` | Electron answers downloads through `session.on('will-download')` + `item.setSavePath()`; the CDP `Browser.setDownloadBehavior` call is a no-op there, and the CDP download events never fire. `reserveDownloadPath()` always used `app.getPath('downloads')` | `reserveDownloadPath()` now prefers **`fileDialogBridge.downloadPath`** (the agent-directed directory); `trackDownload()` mirrors each entry into the bridge via `noteDownload()`, so `browser_downloads_list` reports real files; `setDownloadPath` no longer fails when CDP rejects the method |
| The agent ran `computer_observe`, focused **File Explorer**, took a screenshot and pressed **Alt+F4** while a chooser was already pending on the tab | the click reply said nothing about the picker it had just opened; the model only learned about it if it happened to call `browser_file_dialog_state` | every click reply now carries `fileChooser: { pending, mode, multiple, backendNodeId }` plus a `nextAction`: *"A native file chooser just opened (selectSingle). Answer it with browser_file_dialog_accept { files: [absolute paths] }, do not use computer_* or look for an OS window."* |

Known, not fixed here: `browser_query` with `#log` returns `count: 0` because the query path only returns
interactive elements, the log div is readable through `browser_observe`/`browser_execute`, but a text query
that silently matches nothing is worth a follow-up.

Unit suite: **14/14**: added Electron download mirroring (`noteDownload`) and `setDownloadPath` surviving a
CDP rejection while still recording the directory.

## Live-run friction, round 4 (observation and query)

Third run: the `fileChooser` hint landed, the agent went click → `file_dialog_state` → `accept` with **19 calls
instead of 29**, and never touched the desktop. Two remaining friction points were visible in the trace:

| Evidence | Cause | Fix |
|---|---|---|
| `browser_execute { script: "return document.documentElement.outerHTML" }` → 26 KB → `read_agent_result` twice, just to learn the rules | the observation carried only **interactive elements**; page prose (the game's instructions) was invisible, so the only way to read the page was dumping HTML | `domSnapshot` now appends **`text`**: a bounded 2 000-char `innerText` excerpt with whitespace collapsed. Verified: 1 711 chars including *"Attach the key"* and *"Save these to"* |
| `browser_query { selector: '#log' }` → `count: 0` on a page where that node exists | `queryElements` defaulted to `interactiveOnly: true`, so a plain `div` matched nothing and the reply said nothing about it | an explicit `selector` now forces `interactiveOnly: false`, so the query returns what it matched (verified: the log node comes back with its text) |

### Verification (`node tests/file-dialog-bridge.e2e.cjs`, real Chromium)

```
PASS arm: {"attached":true,"armed":true}
PASS chooser intercepted: {"mode":"selectSingle","backendNodeId":4}
PASS accept via chooser / PASS accept without a chooser event (direct DOM attach)
PASS save routed: lorde-quest-save.json inventory: 2
PASS observation carries page text: "🗝️\nLorde File Quest\n\nA two-level game…" (1711 chars)
PASS explicit selector returns the log node: "10:19:17 ready, level 1: attach a file…"
RESULT bridge survives detach, answers without an event, and saves without a dialog
```

**Operational note:** `desktop/main.cjs` changes only take effect after the Electron app restarts. A run
against an app started before the download-path fix will still report `downloads: []` and still send saves to
the OS Downloads folder, restart the desktop app before re-testing the save path.

## End-to-end over Streamable HTTP MCP (live desktop app)

Played the game entirely through the running app's MCP endpoint (`http://127.0.0.1:8790/mcp`,
pairing header, `Mcp-Session-Id` retained, `notifications/initialized` sent). Client:
`scratch/mcp-client.cjs`.

| Step | Call | Result |
|---|---|---|
| bind | `browser_get_tabs` → `browser_bind_tab` | tab-1 bound, `fullAccess: true`, grants `["*"]` |
| arm | `browser_file_dialog_arm` | `attached: true, armed: true`, `downloadPath` already `C:/Users/london/lorde-quest` |
| open | `browser_click_element {index: 0}` | reply carried `fileChooser: {pending: true, backendNodeId: 25}` + `nextAction` |
| attach | `browser_file_dialog_accept {files:[key-one.txt]}` | `via: "chooser"`; HUD → score 10, level 2/2, files 1 |
| save | `browser_click_element {index: 3}` then `{index: 4}` | both saves started |
| verify | `browser_downloads_list` | three completed entries with real `path`s |
| verify | filesystem | `lorde-quest-save.json` (248 B), `lorde-quest-notes.txt` (93 B) present in `C:/Users/london/lorde-quest` |

Final HUD: **score 60, level complete, files 1, saves 2**. The observation's new `text` field carried the
whole page including the live log (`both saves done, quest complete 🏆`), so no HTML dump was needed.

### Tool-name note (worth knowing before scripting MCP)

The MCP surface uses different names than the agent's internal catalog for two tools:

| Agent tool | MCP tool |
|---|---|
| `browser_observe` | `browser_dom_snapshot` |
| `browser_query` | `browser_query_elements` |

Calling `browser_query` over MCP answers `-32000 Unknown MCP tool`. The file-dialog tools use identical
names on both surfaces.

### Observation

Repeated runs of the game produce `lorde-quest-save (2).json`, `(3)`… because the page uses fixed
filenames. A timestamp in the download name would keep a test folder clean.

## Round 5, interception survived a detach but not a navigation

Probing the live app over MCP surfaced the last mechanical gap: after `browser_navigate`, the bridge still
reported `armed: true`, no `Page.fileChooserOpened` arrived, and the click opened a **real OS dialog that then
blocked the page** (subsequent clicks hit the button but the page never ran its handler).

Cause: Chromium drops `Page.setInterceptFileChooserDialog` on navigation. Only a debugger detach was handled.

Fix: the bridge subscribes to `Page.frameNavigated` and re-sends the flag (`rearm()`), gated on having been
armed at least once so a page a human drives manually keeps its normal dialogs.

```
PASS arm: {"attached":true,"armed":true}
PASS chooser intercepted → accept via chooser / accept without a chooser event (direct DOM attach)
PASS chooser still intercepted after a navigation      ← new
PASS direct attach after navigation: {"via":"dom"}
PASS save routed / observation text / selector query
RESULT bridge survives detach, answers without an event, and saves without a dialog
```

Unit suite: **16/16** (added navigation re-arm and the "never armed → leave navigation alone" guard).

## Round 6, remaining friction closed

| Item | Fix | Verified |
|---|---|---|
| MCP rejected the agent-catalog names (`-32000 Unknown MCP tool`) | `browser_observe` and `browser_query` are now registered as **aliases** of `browser_dom_snapshot` / `browser_query_elements`, in both the handler map and `tools/list` | syntax + handler/definition presence checked; live check after app restart |
| Repeated runs left `lorde-quest-save (2).json`, `(3)`… in the target folder | the fixture stamps downloads with a run time: `lorde-quest-save-103257.json` | e2e: `PASS save routed: lorde-quest-save-103257.json` |
| Interception lost after navigation while `armed` said true | re-arm on `Page.frameNavigated` (round 5) | e2e: `PASS chooser still intercepted after a navigation` |

**Restart required:** `desktop/main.cjs`, `desktop/mcp/localMcpServer.cjs` and `desktop/mcp/fileDialogBridge.cjs`
are loaded once by the Electron main process. Aliases, re-arm and the download-path fix are live only after the
desktop app restarts.
