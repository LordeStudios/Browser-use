# Plan: Fix CDP Persistence and Pointer Overlay Backend Issues

## Context

The Local/Global connection-mode UI revert is complete and verified. The remaining user-reported problems are:

1. **Pointer actions that do not mutate the visible overlay** — `browser_scroll` dispatches a wheel event without first placing the agent cursor, so the user sees an invisible scroll.
2. **CDP connection churn** — the CDP runtime client reconnects on every tab switch and does not detect dead WebSockets, which breaks long-running agent sessions.
3. **Realtime server reselects the target for every input event** — `RealtimeServer.dispatchInput` calls `selectTarget` before each dispatch, forcing `CdpBrowser.selectTab` to close/reopen even when the target has not changed.

## Goals

- Every pointer-bearing action (move, down, up, drag, scroll) must update the in-page agent cursor before the underlying input event is sent.
- The CDP client must keep a stable connection to the current target and transparently reconnect only when the socket is dead or the target actually changes.
- The realtime server must avoid redundant target selection.

## Files to Change

| File | Change |
|------|--------|
| `src/browser/input.js` | Add `showAgentCursor` before `Input.dispatchMouseEvent` in `scroll()`. |
| `desktop/mcp/browserViewController.cjs` | Inject agent cursor in `scroll()`; optionally track last pointer position so wheel events can reuse it. |
| `src/browser/cdpClient.js` | Detect dead sockets in `ensure()`; listen for the `disconnect` event; skip reconnect in `selectTab()` when the target is unchanged and the client is alive. |
| `src/realtime/realtimeServer.js` | Only call `selectTarget()` when `browser.target?.id` differs from the session target. |
| `tests/desktop-input-release.test.mjs` | Add coverage that `scroll()` injects the cursor. |

## Implementation Details

### 1. Pointer overlay on scroll

- `BrowserViewController.scroll()` currently sends `mouseWheel` at `(0, 0)` and skips `injectAgentCursor`. Change it to:
  - Use the last injected cursor coordinate if available (store it as an instance property updated by `mouseMove`, `mouseDown`, `mouseUp`, and `drag`).
  - Fall back to the viewport center when no coordinate is known.
  - Call `injectAgentCursor(tab, x, y)` before `webContents.sendInputEvent({ type: 'mouseWheel' ... })`.
- `input.js scroll()` currently sends CDP `mouseWheel` at `(0, 0)` without `showAgentCursor`. Change it to call `showAgentCursor(ctx.browser, x, y)` first, using last known cursor position or viewport center.

### 2. CDP client persistence

- In `CdpBrowser`:
  - Add a private `#connected` or `connected` flag.
  - On successful connect, attach a one-time `client.on('disconnect', ...)` handler that clears `this.client` and `this.target`.
  - In `ensure()`, check `this.client` and the flag; if missing, call `selectTab()`.
  - In `selectTab(id)`:
    - If `this.target?.id === id` and `this.connected` is true, return `this.getCurrentInfo()` without reconnecting.
    - Otherwise close the old client, connect to the new target, set the flag, and attach the disconnect listener.
  - Wrap close logic in `try/catch` so a dead socket during close does not propagate.

### 3. Realtime server target selection

- In `RealtimeServer.dispatchInput()`, replace unconditional `await this.selectTarget(connection.session.target)` with:
  ```js
  if (this.browser.target?.id !== connection.session.target.cdpTargetId) {
    await this.selectTarget(connection.session.target);
  }
  ```
- Apply the same guard in `closeConnection` where it calls `selectTarget` to release held input.

## Testing

- Update `tests/desktop-input-release.test.mjs` to assert `scroll()` calls `executeJavaScript` with the cursor expression.
- Run existing tests:
  - `node --test tests/desktop-input-release.test.mjs`
  - `node --test tests/realtime-server.test.mjs`
  - `node --test tests/realtime-session.test.mjs`
  - `node --check src/browser/cdpClient.js` (Node cannot ESM-check the whole tree easily; use project test entry if available).
- After changes, run `git diff --stat -- tools/browser-use` and confirm no 9223/hardcoded fake endpoint references remain.

## Out of Scope

- Refactoring the entire `CdpBrowser` into a pool or adding a heartbeat ping. Only minimal dead-socket detection and same-target short-circuit are in scope.
- Changing the agent runtime launch behavior; the fix is to the client connection management, not Chrome launching.
- Splitting `app.js` / `overlay.js`; those files are within the 800-line guideline for now.
