# Changelog

## 0.4.0, 2026-11-14

- Harness rewrite: prompt registry, fixed identity, runtime-context snapshots, turn/step inbox,
  one loop policy replacing five recovery mechanisms, fixed tool pipeline, advisory sourced guards,
  one tool DSL and structured error codes. desktopChatAgent.cjs 7,797 -> 3,207 lines.
- Prompt diet: system prompt 10,865 -> 1,990 chars (browser 6,900 -> 1,532), largest block 4,466 -> 456,
  identity ~999 -> 55, tool descriptions 29,405 -> 18,457.
- Agent-owned file dialogs: CDP chooser interception, direct DOM attach fallback, re-arm after navigation,
  Electron download routing and seven MCP tools on desktop, CLI and MCP.
- Correctness: DPR screenshot coordinate mapping, truthful click replies, disabled-control click guard,
  observation page text, selector queries that return non-interactive nodes.
- npm CLI: lorde-browser-use 0.4.0 ships the agent CLI, TUI and a headless web GUI (browser-use gui)
  with browser-use doctor and a bash installer.

## 0.3.6, 2026-11-08

- Windows installer and portable distribution built from the current private Browser-use source.
- Electron desktop browser surface with persistent managed tabs.
- MCP pairing, explicit tab binding and session-based loopback transport.
- Browser automation, diagnostics, screenshots and native computer-control tools.
- Agent progress, recovery, vision fallback and batching improvements.
- Optional Hybrid Computer Use integration remains disabled by default and requires a separately configured sidecar.

Release availability and checksums are recorded on the GitHub Release page.
