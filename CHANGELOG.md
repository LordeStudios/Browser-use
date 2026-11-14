# Changelog

## 0.4.0, 2026-11-14

- Agent core rebuilt on a single control loop: one owner for prompt, memory, recovery, tool execution and errors. Shorter instructions, faster decisions, fewer stalls and less repeated work on long tasks.
- File dialogs handled by the agent: attach files, cancel a picker and route downloads to a chosen directory, in the desktop app, the CLI and over MCP.
- New npm package `lorde-browser-use` with the terminal interface and a web interface that runs without the desktop app (`browser-use gui`), plus `browser-use doctor` and a bash installer.
- Accuracy fixes: screenshot coordinates at non-100% display scaling, click results that always report what happened, disabled controls refused with a reason, page text readable without dumping HTML, and selector queries that return non-interactive nodes.

## 0.3.6, 2026-11-08

- Windows installer and portable distribution built from the current private Browser-use source.
- Electron desktop browser surface with persistent managed tabs.
- MCP pairing, explicit tab binding and session-based loopback transport.
- Browser automation, diagnostics, screenshots and native computer-control tools.
- Agent progress, recovery, vision fallback and batching improvements.
- Optional Hybrid Computer Use integration remains disabled by default and requires a separately configured sidecar.

Release availability and checksums are recorded on the GitHub Release page.
