# Browser-use custom Playwright browser application — flowchart

## Objective

Replace the profile-based CDP wrapper with a dedicated Windows Browser-use desktop product. The executable owns the automation runtime and launches a bundled Chromium channel controlled through Playwright. A browser-native extension handles tab lifecycle and page observation; the local native companion exposes explicitly approved Windows actions and low-latency agent IPC.

## Architecture flow

```text
+-----------------------+
| Browser-use.exe        |
| Windows application    |
+-----------+-----------+
            |
            v
+-----------------------+       +--------------------------+
| App runtime            |------| Local authenticated IPC  |
| Playwright controller  |      | MCP / named pipe / WS    |
+-----------+-----------+       +--------------------------+
            |
            v
+-----------------------+
| Bundled Chromium      |
| Browser-use channel   |
+-----+-----------+-----+
      |           |
      v           v
+----------+  +------------------------+
| Extension|  | Native companion host  |
| MV3      |  | Windows permission APIs|
+----+-----+  +------------------------+
     |
     v
+-----------------------+
| Every managed browser |
| tab, frame, download, |
| console/network event |
+-----------------------+
```

```mermaid
graph TD
  A[Browser-use.exe] --> B[Playwright application runtime]
  B --> C[Bundled Browser-use Chromium]
  B --> D[Authenticated agent IPC]
  C --> E[MV3 service worker]
  E --> F[Content scripts in managed tabs]
  E --> G[Side panel and browser controls]
  E --> H[Chrome debugger and tab APIs]
  B --> I[Native Windows companion]
  I --> J[Approved pointer keyboard clipboard file actions]
  D --> K[MCP tools]
  K --> B
  F --> L[DOM and interaction telemetry]
  H --> M[Tab and network lifecycle]
  I --> N[OS action trace]
  L --> O[Unified evidence timeline]
  M --> O
  N --> O
```

## Lifecycle

```text
Install Browser-use
  -> register native host and extension policy
  -> store signed/bounded runtime assets
  -> Browser-use.exe starts
  -> validate bundled Chromium + extension
  -> start authenticated local agent bridge
  -> launch browser window
  -> extension announces browser/tab readiness
  -> agent sends browser command
  -> app routes to Playwright, extension, or native companion
  -> record screenshot, page state, console, network, and OS evidence
```

## Security and permission decisions

1. Browser-use manages only its own bundled Chromium session by default.
2. Every localhost/MCP client authenticates with a rotating session token.
3. Native actions are allowlisted and recorded; no arbitrary shell execution comes from pages or extension messages.
4. File picker, clipboard, downloads, and browser debugging follow explicit browser/Windows permission prompts or installer-approved scopes.
5. The extension has no unrestricted authority over personal Chrome profiles; managed Browser-use Chromium is the product boundary.

## Staged validation

```mermaid
graph TD
  A[Stage 1: bundled browser shell] --> B[Headed launch and controlled tab]
  B --> C[Stage 2: Playwright actions and evidence]
  C --> D[Stage 3: extension tab authority]
  D --> E[Stage 4: native host actions]
  E --> F[Stage 5: MCP and installer]
  F --> G[Stage 6: increasing real-site benchmarks]
  G --> H{All artifacts and assertions pass?}
  H -->|No| I[Fix smallest responsible layer]
  I --> G
  H -->|Yes| J[Release candidate]
```
