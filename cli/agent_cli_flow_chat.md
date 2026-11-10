# agent-cli — Headless DesktopChatAgent Runner (flow chart)

Module: `cli/agent-cli.mjs` (+ `cli/webContentsAdapter.cjs`, `cli/stubs.cjs`).
Purpose: run the REAL `desktop/agent/desktopChatAgent.cjs` loop against a real
OpenAI-compatible provider (xkiro), headlessly (no Electron), with a JSONL
trace and a final-state artifact, bounded by an external observer clock.

## ASCII flow

```
+---------------------------+
| node cli/agent-cli.mjs    |
| parse args                |
| --task/--task-file ...    |
+-------------+-------------+
              v
+---------------------------+     read %USERPROFILE%\.claude\settings.json
| resolve credentials       |---- env.ANTHROPIC_BASE_URL / AUTH_TOKEN
| --api-key / XKIRO_API_KEY |    (never embedded in source)
+-------------+-------------+
              v
+----------------------------------------------+
| LOAD ORDER (critical)                        |
| 1. require computerCatalog.cjs               |
| 2. REPLACE exports.agiPromptForTask when     |
|    --system-file given (returns file text)   |
| 3. ONLY THEN require openAiCompatibleProvider|
|    + desktopChatAgent (they capture the      |
|    destructure at load time)                 |
+-------------+--------------------------------+
              v
+-------------------------------------+
| launch headless Chrome              |
| (--headless=new, own profile dir,   |
|  remote-debugging-port)             |
| --url pre-loads the task's page in  |
| the selected tab (desktop-app       |
| "user already has it open" parity)  |
+-------------+-----------------------+
              v
+-------------------------------------+
| connect CDP client per tab          |
| WebContentsAdapter tab =            |
|   { id: targetId, webContents }     |
| executeJavaScript -> Runtime.eva    |
| sendInputEvent -> Input.dispatch*   |
| insertText       -> Input.insertText|
| capturePage      -> Page.captureS.. |
| debugger         -> raw CDP passthru|
| did-* events     -> Page lifecycle  |
+-------------+-----------------------+
              v
+------------------------------------------+
| new BrowserViewController({              |
|   getTabs, getSelectedTabId,             |
|   getConsoleEntries, normalizeUrl,       |
|   createTab, closeTab,                   |
|   isTabPaintable: () => true,            |
|   deviceEmulator: null,                  |
|   debuggerLeaseManager: null,            |
|   pointerVisualizer: null })             |
+-------------+----------------------------+
              v
+------------------------------------------+
| new DesktopChatAgent({ controller, ...,  |
|   emit: traceWriter, createProvider,     |
|   injectables: null, researchRunner:     |
|   disabled stub })                       |
+-------------+----------------------------+
              v
+---------------------------+
| agent.start({ task,       |
|   provider: {id,model,    |
|   baseUrl,apiKey},        |
|   settings: {controlMode}}|
+-------------+-------------+
              |   (runs until terminal status)
              |  +-------------------------------------+
              |  | EXTERNAL OBSERVER (500ms interval)  |
              |  | elapsed >= maxSeconds -> cancel     |
              |  | step >= maxSteps      -> cancel     |
              |  | recovery.attempts > maxRecoveries   |
              |  |                       -> cancel     |
              |  +-------------------------------------+
              v
+-------------------------------------+
| terminal state?                     |
| completed -> exit 0                 |
| cancelled/timed_out -> exit 2       |
| failed / threw -> exit 1            |
+-------------+-----------------------+
              v
+-------------------------------------+
| write out-dir/trace.jsonl           |
|   (every emit event, ms offsets,    |
|    base64 sanitized)                |
| write out-dir/final-state.json      |
|   meta + agent.state()              |
| kill browser tree, exit             |
+-------------------------------------+
```

## Mermaid

```mermaid
graph TD
    A[node cli/agent-cli.mjs parse args] --> B[resolve credentials<br/>settings.json env / --api-key / XKIRO_API_KEY]
    B --> C[require computerCatalog.cjs]
    C --> D{--system-file?}
    D -- yes --> E[replace exports.agiPromptForTask<br/>with file-text wrapper]
    D -- no --> F[keep original prompt]
    E --> G[require openAiCompatibleProvider + desktopChatAgent]
    F --> G
    G --> H[launch headless Chrome<br/>remote-debugging-port]
    H --> I[connect CDP + WebContentsAdapter<br/>tab = {id, webContents}]
    I --> J[BrowserViewController deps wired]
    J --> K[DesktopChatAgent wired<br/>emit = JSONL trace writer]
    K --> L[agent.start task + provider + settings]
    M[external observer 500ms<br/>max-seconds / max-steps / max-recoveries] -- cancel --> L
    L --> N{terminal state?}
    N -- completed --> O1[exit 0]
    N -- cancelled/timed_out --> O2[exit 2]
    N -- failed/error --> O3[exit 1]
    O1 --> P[write trace.jsonl + final-state.json<br/>kill browser]
    O2 --> P
    O3 --> P
```

## Key invariants

- The prompt override must be installed BEFORE `openAiCompatibleProvider.cjs`
  is first required (it destructures `agiPromptForTask` at load time).
- No `require('electron')` anywhere; only `main.cjs`/preloads in desktop/
  needed Electron and none are in this require graph.
- Recovery is unbounded by design (owner directive); `--max-recoveries` is an
  EXTERNAL observer bound, not an agent watchdog.
- The observer clock calls `agent.cancel(runId)` (the run's own abort path)
  and records `timed_out: true`; it never kills the process mid-write.
