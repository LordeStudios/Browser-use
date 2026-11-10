# Browser-use desktop Playwright browser application plan

## Product boundary

Browser-use becomes a dedicated Windows browser application, not a wrapper over user-installed Chrome. The application executable ships and starts its own browser engine, runs all automation through Playwright, and provides agent integration through authenticated local IPC/MCP.

## Technical choice

### Stage 1 implementation target

Use **Electron + Playwright-core**:

- Electron is the executable browser shell and provides a real Windows application lifecycle, browser window, tabs, menus, side panel, preload security boundary, and OS integration.
- Playwright-core controls the same bundled Chromium/Electron browser runtime through an application-owned CDP endpoint, while avoiding a dependency on globally installed Chrome.
- Browser-use owns the installed app directory, app-data profile, extension assets, local bridge, and browser version.
- Electron-builder packages an NSIS installer and portable executable.

### Why not modify Playwright itself

Playwright is an automation library, not a browser UI. Forking its internals does not create a browser application. The appropriate architecture is a custom browser application that embeds a Chromium runtime and uses Playwright as its control layer. A full Chromium-source fork remains an optional later stage for browser-engine patches; it is not a prerequisite to producing a genuine installable Browser-use application.

## Planned application layout

```text
apps/browser-use-desktop/
  package.json
  electron-builder.yml
  src/
    main/
      main.js               # Electron window/tab/runtime lifecycle
      playwrightRuntime.js  # owns Playwright connections and action API
      agentBridge.js        # authenticated local MCP/WS/named-pipe bridge
      nativeActions.js      # allowlisted Windows actions
      diagnosticsStore.js   # console/network/download/action evidence
    preload/
      bridge.cjs            # typed renderer-to-main IPC surface
    renderer/
      index.html
      app.js
      styles.css
    extension/
      manifest.json
      service-worker.js
      content.js
      sidepanel.html
      sidepanel.js
  tests/
    headed-app-launch.mjs
    tab-control.mjs
    diagnostics.mjs
    agent-bridge.mjs
```

## Stages

### Stage 1 — Desktop shell

- Add the Electron application package.
- Create a real browser window with tab model and Browser-use control dock.
- Launch a bundled Chromium runtime through Electron.
- Add a stable application-data directory and crash/error logs.
- Build a Windows NSIS installer and portable executable.
- Checkpoint: double-click executable opens Browser-use window with a real tab; no global Chrome dependency.

### Stage 2 — Playwright-owned interactions

- Connect Playwright-core to the application browser runtime.
- Implement target-based navigation, clicks, text input, screenshots, console, network, and download evidence.
- Keep interaction state and diagnostics in main process, streamed to the control dock.
- Checkpoint: real local bug fixture reproduced in the visible app with action trace/evidence.

### Stage 3 — Extension authority

- Load Browser-use MV3 extension into the application’s managed browser context.
- Use service worker + content scripts to observe every tab, navigation, frame, page lifecycle, selections, clipboard/drop events, and extension UI.
- Use `chrome.debugger` selectively for browser-level protocol APIs that page code cannot access.
- Checkpoint: new tabs and cross-origin navigations remain observable and controllable without page-overlay instrumentation.

### Stage 4 — Native companion

- Use Electron’s native APIs for clipboard, file dialogs, downloads, notifications, and controlled window focus.
- Add a restricted Windows input companion only when Electron APIs cannot satisfy an explicitly user-approved action.
- Checkpoint: native pointer/keyboard bridge and download/file evidence are visible in the control dock.

### Stage 5 — Agent integration

- Replace prototype direct CDP MCP routing with an authenticated agent bridge to the desktop main process.
- Add rotating session credentials and a named-pipe/local WebSocket transport.
- Register a native-messaging manifest for the extension during installer setup.
- Checkpoint: Claude Code MCP controls the active Browser-use tab with app-owned evidence and no browser-profile configuration.

### Stage 6 — Validation and benchmarks

Alternate cold/reuse, desktop/tablet/mobile, and increasing UI complexity:

1. form validation and keyboard input;
2. async fetch failures, retries, console exceptions;
3. menus, modals, drag/drop, clipboard, file selection;
4. SPA routing, history, scrolling, dynamic state;
5. multi-tab, downloads, permission prompts, cross-origin navigation;
6. Lorde Studio checkpoint journeys.

Every stage records screenshots, action trace, network failures, console errors, browser state, and timing. A failure blocks the next stage.

## Installer requirements

- Electron-builder or equivalent package download/install is required.
- Windows code signing certificate is required for trusted SmartScreen distribution but not local testing.
- First extension/native-host installation requires explicit local install/permission consent.
- No external browser profile or Chrome installation is required after installing the app.

<!-- BROWSER_USE_DESKTOP_PLAYWRIGHT_STOP: Stage 1 must create the dedicated Electron browser app skeleton before migration of prototype features. -->
