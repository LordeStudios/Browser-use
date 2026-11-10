# Browser-use paired MCP connection guide

## Security boundary

The desktop executable exposes one external-agent bridge: a loopback HTTP MCP service. It does **not** expose a Chrome DevTools debugging port, auto-bind an active tab, or insert visual overlays into page HTML.

Every controller request is constrained by all of these independent checks:

1. The caller is on loopback.
2. The caller presents a short-lived pairing header while opening an MCP session, then retains the opaque MCP session header. The same displayed header may safely retry setup for the remainder of its pairing-code lifetime and always resolves to the original full-access session.
3. The session is explicitly bound to an existing Browser-use desktop tab.
4. Every Desktop MCP tool is available immediately after pairing; there is no separate per-tool permission step.
5. Session expiry, revocation, tab closure, and shutdown release held keys and mouse buttons before control ends.

## Connect an external AI agent

1. Open **Settings** in Browser-use.
2. Select **Secure paired MCP**.
3. Click **Create pairing code**.
4. Configure the external MCP host with the displayed loopback MCP endpoint and `X-Browser-Use-Pairing-Code` header.
5. Send that header when the host initializes MCP. The response provides an opaque `Mcp-Session-Id` header.
6. Retain `Mcp-Session-Id` for later MCP requests. The same pairing header safely retries interrupted setup until the displayed pairing code expires; it never re-issues a legacy bearer credential after that bootstrap.
7. Call `browser_get_tabs`, inspect titles and URLs, then call `browser_bind_tab` with the exact tab ID.
8. Use any listed MCP tool immediately. `browser_bind_tab` remains the required target-selection step for tab-scoped tools.

### Claude Code one-click command

In Desktop **Settings**, click **Claude Code MCP**. Browser-use copies a
user-scoped HTTP installation command that uses Claude Code's supported
`headersHelper` reconnect hook:

```
claude mcp add-json --scope user browser-use-desktop "{\"type\":\"http\",\"url\":\"http://127.0.0.1:8792/mcp\",\"headersHelper\":\"curl.exe -fsS --max-time 5 http://127.0.0.1:8792/mcp/authenticate\"}"
```

Run the copied command once, then open `/mcp` inside Claude Code and confirm
`browser-use-desktop` is connected. At every later Claude session start or
reconnect, `headersHelper` asks the loopback Desktop app for a fresh short-lived
pairing code. The button does not edit Claude configuration files or run a
shell itself. **Copy pairing code** remains available for manual MCP hosts.
The escaped double quotes (`\"`) let cmd.exe, Git Bash, and PowerShell 7 hand
the JSON to the Claude CLI intact. The earlier `--%` stop-parsing token only
ever helped Windows PowerShell 5 and arrived as a literal, invalid argument in
every other shell, so it is no longer copied. On Windows PowerShell 5, wrap
the JSON in single quotes instead.

## Stable desktop endpoint

The Desktop app listens on `http://127.0.0.1:8792` by default. This is its own
stable loopback origin for a configured external tunnel and is intentionally
separate from the standalone CLI daemon, which uses `8790` by default.

Set `BROWSER_USE_DESKTOP_MCP_PORT` only when the Desktop app itself needs a
different port. `BROWSER_USE_DESKTOP_MCP_PORT=0` requests an operating-system
assigned ephemeral port and is reserved for isolated Electron test launches;
it is not suitable for a durable tunnel. `BROWSER_USE_MCP_PORT` affects the
standalone CLI daemon only and never changes the Desktop app endpoint.

## Custom GPT Action through the Lorde Studios tunnel

The configured Cloudflare Tunnel is named `lorde-studios-gpt-action`. Its
published hostname is `https://gpt-browser.lordemaximus.com`, routed only to
the Desktop bridge's `/gpt/*` endpoints at `127.0.0.1:8792`.

Import this schema URL into a Custom GPT Action:

`https://gpt-browser.lordemaximus.com/gpt/openapi.json`

Use the Desktop Settings `X-API-Key` value as the Action authentication key.
The exact `gpt-browser.lordemaximus.com/*` Worker-route exclusion is required:
it prevents the `lorde-studios` wildcard Worker from intercepting the tunnel.
The public hostname rejects raw `/mcp` and all non-`/gpt/*` paths.

## Native input guarantees

- Desktop mouse and keyboard tools use Electron `webContents.sendInputEvent` and `insertText`.
- Desktop mobile/tablet gestures use `Input.dispatchTouchEvent` through the BrowserView debugger.
- The Node runtime uses CDP `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, and `Input.insertText`.
- Input tools do not use `Runtime.evaluate`, DOM event synthesis, value rewriting, a cursor SVG, or a touch overlay.
- `browser_dom_snapshot` provides bounded element metadata and CSS viewport coordinates. Use `browser_click_element` or the returned geometry instead of guessing targets.

## Recovery

If a controller disconnects, expires, is revoked, or loses its bound tab, Browser-use releases all held pointer buttons and keys for that session. A host should re-read tabs and bind again rather than retrying an old target ID.
