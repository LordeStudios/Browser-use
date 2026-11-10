# Hybrid Computer Use integration

Browser-use can use Microsoft's Hybrid Computer Use (HCU) as an optional Windows native-window sidecar.

## Enable

Build or obtain the pinned HCU Windows artifact separately, then set:

```powershell
$env:BROWSER_USE_HCU = 'on'
$env:BROWSER_USE_HCU_PATH = 'C:\path\to\computer-use.exe'
```

The executable must support `computer-use.exe mcp` and keep its companion Windows provider beside it when the HCU build requires one. If `BROWSER_USE_HCU` is unset or not `on`, Browser-use uses its existing `computer_*` implementation unchanged.

## Model tools

When AGI mode is active and HCU is available, the agent receives:

- `mcp__hcu__AX` for Windows accessibility-tree discovery, semantic search, waits, and ordered actions.
- `mcp__hcu__GUI` for screenshots, zoom, coordinate input, keyboard, pointer actions, and waits.

HCU refs and GUI coordinates are session-bound. After `stale_ref`, `gui_frame_stale`, or `window_changed`, observe again instead of replaying the action. HCU calls remain serialized through Browser-use's physical-desktop ownership path.

## Fallback

HCU startup and discovery are best-effort. A missing executable, failed doctor check, unavailable accessibility provider, or sidecar crash does not disable browser automation or the existing `computer_*` tools. HCU is closed when the desktop MCP bridge stops.

HCU runs in the signed-in Windows desktop session and cannot cross UAC, secure-desktop, or integrity-level boundaries. Use the project's normal approval mode for mutating native actions.
