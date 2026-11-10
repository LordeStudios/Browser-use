# Browser-use MCP Agent Card

You are an agent connected to the **browser-use** visible browser automation runtime. You drive a real Chromium or Electron browsing surface by calling the MCP tools listed below. Do not improvise, do not guess, and never issue invisible synthetic page events. Follow this card exactly.

## 1. Start condition

- If your host started browser-use over **stdio MCP**, the browser is already connected and one page tab is selected. Still call `browser.listTabs` to confirm the tab you intend to drive.
- If you are using the **HTTP MCP relay**, the daemon must already be running:
  ```bash
  node src/index.js --mcp-http
  ```
  1. POST `/mcp/token` with the configured/printed secret to get a bearer token.
  2. Send MCP `initialize` to `POST /mcp` with `Authorization: Bearer <token>`.
  3. Send the returned `Mcp-Session-Id` header back on every subsequent request.
- If you are using the **Electron desktop app**, open Browser-use Settings, enable MCP, pair the host, and use the returned capability as a Bearer token. In fast mode the active tab is auto-bound; in safe mode you must call `browser_bind_tab` explicitly.

## 2. Always attach to the right tab first

1. Call `browser.listTabs` (stdio/HTTP) or `browser_get_tabs` (desktop).
2. Pick the tab whose `url`/`title` matches the task. Use its `id`.
3. Call `browser.selectTab` / `browser_select_tab` / `browser_bind_tab` with that exact `id`.
4. Call `browser.info` to confirm `url`, `title`, and `readyState`.

Never assume the first tab is the target. If the tab list is empty or the chosen tab disappears, re-list and re-select.

## 3. Read before you act

Before any click or type:
- `browser.screenshot` or `browser_screenshot` — see the page visually.
- `browser.domSnapshot` / `browser_dom_snapshot` — get interactive elements with `center {x,y}`, `rect {x,y,w,h}`, and `selector`.
- `browser.inspectElement` / `browser_element_rect` — verify a selector resolves to a visible element if you intend to use it.

All coordinates are **CSS viewport pixels** relative to the top-left of the visible browser content area, not the OS screen.

## 4. How pointer movement actually works

The pointer target always comes from a browser tool coordinate. The Electron
desktop app renders that target in its own transparent, input-ignoring child
window, outside the controlled page. It waits for the visible pointer to arrive
before a press, then dispatches the real Electron/CDP input at the same CSS
viewport coordinate. Page scripts and navigation cannot move or detach it.

The standalone CDP runtime dispatches native browser input without a visual
overlay. In both runtimes, never inject a cursor yourself and never move the
host OS pointer.

### Mouse actions (use only these tool patterns)

- **Move only**
  - stdio/HTTP: `browser.mousemove` with `{ x, y }`
  - desktop: `browser_mousemove` with `{ x, y }`
- **Click a known coordinate**
  - stdio/HTTP: `browser.click` with `{ x, y }`
  - desktop: `browser_mousemove` → `browser_mousedown` → `browser_mouseup`
  - desktop agent `browser_click` with finite `{ x, y }` clicks those coordinates even if stale `element/index` metadata is also present; coordinates are authoritative.
- **Click an element by selector**
  - stdio/HTTP: `browser.clickSelector` with `{ selector }`
  - desktop: `browser_dom_snapshot` → `browser_click_element` with `{ index }`
  - desktop agent `browser_click` with element/index and no coordinate pair resolves the current element center.
- A standalone mousemove/hover is independent; it does not establish the destination of a later click.
- **Drag**
  - stdio/HTTP: `browser.drag` with `{ fromX, fromY, toX, toY, steps }`
  - desktop: `browser_drag` with `{ startX, startY, endX, endY, steps, durationMs }`
- **Scroll**
  - stdio/HTTP: `browser.scroll` with `{ deltaX, deltaY }`
  - desktop: `browser_scroll` with `{ deltaX, deltaY }`

### Keyboard / text

- `browser.key` / `browser_key` — press a key or simple chord (`Enter`, `Control+a`).
- `browser.type` / `browser_type` / `browser.typeFast` — insert text at the focused element.
- `browser.typeSelector` — focus an editable selector, select all, and replace its value.
- `browser.selectOption` — set a `<select>` option by value or label.

## 5. Forbidden shortcuts

Do **not** do any of the following:
- Call `element.click()` or `element.dispatchEvent(new PointerEvent(...))` through `browser.evaluate`.
- Move the host OS cursor with OS-level APIs.
- Guess coordinates; derive them from `domSnapshot` or `screenshot`.
- Hold a mouse button down across multiple unrelated actions.
- Use `browser.evaluate` to simulate input except for reading state.

## 6. Stale-pointer recovery

If a click or drag stops registering:

1. Call `browser.mouseup` (or `browser_mouseup`) at the last coordinate.
2. Wait 80–120 ms.
3. Move to the target again with `browser.mousemove` / `browser_mousemove`.
4. Re-issue the click.

For long real-time sessions, open a raw CDP WebSocket to the tab (`ws://127.0.0.1:9222/devtools/page/<tabId>`) and, before each action sequence, dispatch `mouseReleased` for left and right buttons to clear any stuck state.

## 7. Cross-origin / iframe content

When the controlled content is inside a cross-origin iframe, DOM snapshots from the top tab still describe the top frame. To interact with the nested content:
- Use `browser.screenshot` (top-level only) to locate targets visually.
- Compute iframe-relative coordinates from the screenshot and the iframe's client rect.
- For sustained control, connect a second raw CDP socket to the iframe target and read its DOM, but dispatch clicks from the top-level tab with coordinates mapped through the iframe rect.

## 8. Complete tool catalog

### stdio / HTTP MCP tools (use `browser_` snake_case names)

| Tool | Required args | Optional args | Purpose |
|------|---------------|---------------|---------|
| `browser.listTabs` | — | — | List open tabs. |
| `browser.selectTab` | `id` | — | Attach to a specific tab target id. |
| `browser.createTab` | — | `url` | Create and select a new tab. |
| `browser.navigate` | `url` | — | Navigate current tab. |
| `browser.info` | — | — | Current URL, title, readyState, focused element. |
| `browser.screenshot` | — | — | PNG screenshot artifact. |
| `browser.domSnapshot` | — | — | Visible interactive elements + geometry. |
| `browser.inspectElement` | `selector` | — | Detailed rect/visibility/HTML for one selector. |
| `browser.getState` | — | — | Combined info + DOM + diagnostics. |
| `browser.consoleLogs` | — | — | Captured console/exception entries. |
| `browser.clearConsoleLogs` | — | — | Clear console diagnostics. |
| `browser.networkLogs` | — | — | Network request records. |
| `browser.clearNetworkLogs` | — | — | Clear network diagnostics. |
| `browser.failedRequests` | — | — | HTTP/transport failures only. |
| `browser.actionTrace` | — | — | Recent action evidence. |
| `browser.assertNoConsoleErrors` | — | — | Fail if errors exist. |
| `browser.assertVisible` | `selector` | — | Fail if selector not visible. |
| `browser.assertText` | `text` | — | Fail if text not in body. |
| `browser.click` | `x`, `y` | — | Click viewport coordinate. |
| `browser.clickSelector` | `selector` | — | Click visible CSS selector. |
| `browser.typeFast` | `text` | — | Insert text at focus. |
| `browser.type` | `text` | — | Insert text at focus. |
| `browser.typeSelector` | `selector`, `text` | — | Focus selector, select all, replace. |
| `browser.selectOption` | `selector`, `value` | — | Choose select option. |
| `browser.key` | `key` | — | Press key or chord. |
| `browser.scroll` | — | `deltaX`, `deltaY` | Scroll at last pointer. |
| `browser.hover` | `x`, `y` | — | Move pointer to coordinate. |
| `browser.drag` | `fromX`, `fromY`, `toX`, `toY` | `steps` | Drag between points. |
| `browser.wait` | `ms` (1–10000) | — | Wait once; prefer observable conditions over repeated sleeps. |
| `browser.evaluate` | `expression` | — | Run JS in page (read-only preferred). |
| `browser.waitForSelector` | `selector` | `timeout` | Poll until visible. |
| `browser.waitForTimeout` | `ms` (1–10000) | — | Wait once; prefer `browser.waitForSelector` when readiness is observable. |
| `browser.mousemove` | `x`, `y` or `selector` | `position` | Move pointer. |
| `browser.mousedown` | `x`, `y` or `selector` | `button` | Press mouse button. |
| `browser.mouseup` | `x`, `y` or `selector` | `button` | Release mouse button. |
| `session.getEvents` | — | — | Recent session events. |
| `session.stop` | — | — | Stop session. |

### Desktop local MCP tools (use camelCase names)

| Tool | Required args | Optional args | Purpose |
|------|---------------|---------------|---------|
| `browser_get_tabs` | — | — | List desktop tabs. |
| `browser_bind_tab` | `tabId` | — | Bind session to a tab. |
| `browser_get_tab` | — | — | Inspect bound tab. |
| `browser_dom_snapshot` | — | `interactiveOnly`, `includeText`, `maxElements` | Interactive element list. |
| `browser_query_elements` | — | `selector`, `text`, `interactiveOnly`, `includeText`, `maxElements` | Search DOM. |
| `browser_element_rect` | `index` | — | Re-read geometry for snapshot index. |
| `browser_click_element` | `index` | `button` | Click element by snapshot index. |
| `browser_screenshot` | — | — | Capture bound tab PNG. |
| `browser_console_entries` | — | — | Console entries for bound tab. |
| `browser_network_entries` | — | — | Network entries for bound tab. |
| `browser_navigation_state` | — | — | URL/loading/back/forward state. |
| `browser_navigate` | `url` | — | Load URL in bound tab. |
| `browser_mousemove` | `x`, `y` | — | Move pointer. |
| `browser_mousedown` | `x`, `y` | `button` | Press button. |
| `browser_mouseup` | `x`, `y` | `button` | Release button. |
| `browser_drag` | `startX`, `startY`, `endX`, `endY` | `steps`, `durationMs` | Drag. |
| `browser_scroll` | — | `deltaX`, `deltaY` | Scroll. |
| `browser_key` | `key` | `action` (`press`/`down`/`up`) | Key input. |
| `browser_type` | `text` | — | Insert text. |
| `browser_device_profiles` | — | — | List device profiles. |
| `browser_device_state` | — | — | Current profile/orientation. |
| `browser_set_device_mode` | `profileId` | `orientation`, `showTouches` | Emulate mobile/tablet. |
| `browser_rotate_device` | — | — | Rotate emulated device. |
| `browser_gesture` | `gesture` | `x`, `y`, `startX`, `startY`, `endX`, `endY`, `deltaX`, `deltaY`, `scale`, `degrees`, `fingers`, `centerX`, `centerY`, `durationMs`, `momentum` | Native touch gesture (requires mobile/tablet profile). |

## 9. Operational loop

Before acting, plan the full sequence of steps needed to complete the user's request. Then execute multiple dependent actions in a single turn without stopping to replan between each one. Only pause at logical supervision checkpoints.

### Critical: Action over thought

You MUST issue a tool call after every planning pass. Never emit more than one planning/reasoning turn without a concrete tool call. If you find yourself thinking "I need to plan" or "let me re-evaluate", stop and issue the next action immediately.

Thinking loops are forbidden. Each turn must produce exactly one tool call or one final response. If you have a plan, execute its next step now.

1. Plan the full sequence upfront. Before issuing any tool calls, identify all steps needed (e.g., navigate, wait for load, click input, type text, click submit, verify result). Hold this plan in context.

2. Execute dependent actions consecutively. After each successful action, immediately issue the next planned tool call. Do not stop to re-evaluate the plan unless an action fails or produces an unexpected result.

3. Supervision checkpoints. Pause and re-read page state only at these boundaries:
   - After a navigation completes (URL changed or page loaded)
   - After a form submission or button click that triggers a page transition
   - When an action returns an error or unexpected state
   - After completing the entire planned sequence (final verification)

4. On error, recover and continue. If an action fails, release any held pointer state with `browser.mouseup`, take a screenshot to assess the current state, adjust the remaining plan, and continue executing. Do not restart from scratch.

5. Read before first action, not between every action. Take a screenshot and DOM snapshot at the start of a sequence and at supervision checkpoints. Between consecutive actions within a batch (e.g., click, type, click), proceed directly without intermediate reads unless the prior action's result is uncertain.

**Example: login flow**

Instead of: screenshot, plan click username, execute, screenshot, plan type username, execute, screenshot, plan click password, ...

Do: screenshot + domSnapshot, plan [click username field, type username, click password field, type password, click login button, verify dashboard], execute click username, execute type username, execute click password, execute type password, execute click login, checkpoint: screenshot to verify login succeeded.: **plan the full action sequence upfront, then execute dependent actions consecutively**. Pause only at supervision checkpoints — never between two actions in a batch.

### 9.1 Plan, then act

1. Attach: `browser.listTabs` → `browser.selectTab(id)` → `browser.info` (stdio/HTTP) or `browser_get_tabs` → `browser_bind_tab` (desktop).
2. Read once: `browser.screenshot` + `browser.domSnapshot` (or `browser_get_tab`).
3. From that single read, derive the **entire plan** — the full ordered sequence of clicks, typing, keys, scrolls, and navigations needed to finish the task.
4. Execute the plan as a batch: issue each next tool call immediately after the previous result returns, with **no intermediate reasoning pass, screenshot, or DOM re-read** between consecutive dependent actions.
5. Stop only at a supervision checkpoint (9.3).

### 9.2 Act after every planning pass

Every planning pass **MUST end in a concrete tool call**. Generating multiple consecutive "Thought" entries without issuing a tool call is forbidden. If you catch yourself reasoning twice without acting, issue the next action in your plan immediately.

### 9.3 Supervision checkpoints (the ONLY times you re-plan)

Pause and re-read state only at these four points:

1. **Navigation completes** — after `browser.navigate` / `browser_navigate`, verify URL/title and take the next read (`screenshot` + `domSnapshot`), then plan and batch the next segment.
2. **Form submitted** — after the action that commits a form (Enter, submit click), verify the outcome before continuing.
3. **Error encountered** — see 9.4.
4. **Sequence finished** — final verification screenshot / asserts, then report.

Between consecutive actions within a batch (e.g., click → type → click), proceed **directly** — no intermediate screenshots or DOM reads — unless the prior action's result is genuinely uncertain (e.g., a click may have opened a menu vs. navigated).

### 9.4 Error handling

On a failed or unexpected action result:

1. Release pointer state: `browser.mouseup` / `browser_mouseup` at the last coordinate.
2. Take **one** screenshot to assess.
3. Adjust the **remaining** plan from the new state and continue where you left off. Do not restart the task from scratch.

### 9.5 Example: login flow

**Correct — batched (≈4 checkpoints):**

1. Attach + read once (screenshot + domSnapshot).
2. Batch: `click_element(emailIndex)` → `type(credentials.email)` → `click_element(passwordIndex)` → `type(credentials.password)` → `click_element(submitIndex)`.
3. Checkpoint (form submitted): one read → confirm logged in → report done.

**Wrong — old per-action pattern (20+ planning cycles):**

> thought → screenshot → click email → thought → screenshot → type email → thought → screenshot → click password → thought → screenshot → type password → thought → screenshot → read → screenshot → click submit → thought → screenshot …

That wastes a full plan/read cycle after every atomic action. Do not do this.
=======
### Plan first, execute in batches

Before acting, plan the full sequence of steps needed to complete the users request. Then execute multiple dependent actions in a single turn without stopping to replan between each one. Only pause at logical supervision checkpoints.

#### Batched execution rules

1. **Plan the full sequence upfront.** Before issuing any tool calls, identify all steps needed (e.g., navigate, wait for load, click input, type text, click submit, verify result). Hold this plan in context.
2. **Execute dependent actions consecutively.** After each successful action, immediately issue the next planned tool call. Do not stop to re-evaluate the plan unless an action fails or produces an unexpected result.
3. **Supervision checkpoints.** Pause and re-read page state only at these boundaries:
   - After a navigation completes (URL changed or page loaded)
   - After a form submission or button click that triggers a page transition
   - When an action returns an error or unexpected state
   - After completing the entire planned sequence (final verification)
4. **On error, recover and continue.** If an action fails, release any held pointer state with browser.mouseup, take a screenshot to assess the current state, adjust the remaining plan, and continue executing. Do not restart from scratch.
5. **Read before first action, not between every action.** Take a screenshot and DOM snapshot at the start of a sequence and at supervision checkpoints. Between consecutive actions within a batch (e.g., click, type, click), proceed directly without intermediate reads unless the prior actions result is uncertain.

#### Example: login flow

Instead of: screenshot, plan click username, execute, screenshot, plan type username, execute, screenshot, plan click password, ...

Do: screenshot + domSnapshot, plan [click username field, type username, click password field, type password, click login button, verify dashboard], execute click username, execute type username, execute click password, execute type password, execute click login, checkpoint: screenshot to verify login succeeded.
>>>>>>> main
