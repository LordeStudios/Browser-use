# Browser-Use Bug Fixes Summary

This document summarizes the fixes applied to three critical bugs in the browser-use application.

## Bug 1: Subagent Involuntary Tab Spawn

### Problem
Subagents were spawning involuntary new tabs, which was unwanted behavior. Each subagent would create its own tab via `agentPool.allocateTab()`.

### Root Cause
In `desktop/main.cjs`, the `agentPool` configuration had an `allocateTab` function that always created a new tab:
```javascript
allocateTab: async () => {
  const summary = tabSummary(createTab('about:blank', false));
  return summary?.id ? String(summary.id) : null;
}
```

### Fix Applied
**File:** `desktop/main.cjs` (lines 2262-2284)

Modified the `allocateTab` function to return the selected tab ID instead of creating new tabs:
```javascript
allocateTab: async () => {
  // Return the selected tab ID if available, otherwise use a shared background tab
  const selected = selectedTabId;
  if (selected) {
    return String(selected);
  }
  // Fallback: create a single shared background tab for all subagents
  if (!sharedBackgroundTabId) {
    const summary = tabSummary(createTab('about:blank', false));
    sharedBackgroundTabId = summary?.id ? String(summary.id) : null;
  }
  return sharedBackgroundTabId;
}
```

Also added a global variable to track the shared background tab:
**File:** `desktop/main.cjs` (line 91)
```javascript
// BUG FIX: Shared background tab for subagents to prevent involuntary tab spawns
let sharedBackgroundTabId = null;
```

### Impact
- Subagents now share the selected tab or a single shared background tab
- No more involuntary tab creation when spawning subagents
- Reduces resource usage and tab clutter

---

## Bug 2: Closing a Tab Dismisses the Run

### Problem
When a user closed a tab, any active run attached to that tab would be automatically canceled, which was not the desired behavior. The user wanted to be able to close tabs without terminating active runs.

### Root Cause
In `desktop/main.cjs`, the `closeTab` function had code that automatically canceled runs when their attached tab was closed:
```javascript
function closeTab(id) {
  const activeChatRun = desktopChatAgent?.state();
  if (activeChatRun?.tabId === id && ['running', 'awaiting_approval', 'paused'].includes(activeChatRun.status)) 
    desktopChatAgent.cancel(activeChatRun.id);
  for (const entry of agentPool?.activeRuns || []) {
    const snapshot = entry.instance?.state?.();
    if (String(entry.tabId) === String(id) && ['running', 'awaiting_approval', 'paused'].includes(snapshot?.status)) {
      try { entry.instance.cancel(snapshot.id); } catch { /* already terminal */ }
    }
  }
  // ... rest of the function
}
```

### Fix Applied
**File:** `desktop/main.cjs` (lines 3344-3364)

Removed the automatic cancellation logic from `closeTab`:
```javascript
function closeTab(id) {
  // BUG FIX: Do NOT cancel runs when their attached tab is closed by the user.
  // Runs should only be canceled during deliberate teardown (closeIndependentChatWindow, subagent_close, etc.).
  // The user explicitly closing a tab should not terminate an active run.
  // Note: The run will fail on its next observation if it tries to use the destroyed webContents,
  // but this is better than immediately canceling the run without the user's intent.
  
  // Removed: automatic cancellation of runs when their tab is closed
  // ... (commented out the previous cancel logic)
  
  for (const entry of chatAgentWindows.values()) entry.tabIds?.delete(String(id));
  // ... rest of the function
}
```

### Impact
- Closing a tab no longer automatically cancels active runs
- Runs continue until they naturally complete or fail when trying to use the destroyed webContents
- Deliberate teardown paths (like `closeIndependentChatWindow`) still work as expected

---

## Bug 3: Run Pauses Until User Switches to Attached Tab

### Problem
Runs would stall/pause when their attached tab was not paintable (e.g., background tabs), waiting for the user to manually switch to that tab before continuing.

### Root Cause
In `desktop/mcp/browserViewController.cjs`, the CDP screenshot capture was using `fromSurface: true` for all tabs, including non-paintable background tabs. The `fromSurface: true` option requires a compositor surface, which background/detached tabs don't have, causing the capture to wait indefinitely or timeout.

### Fix Applied
**File:** `desktop/mcp/browserViewController.cjs` (lines 108-134)

Modified the `captureViaCdp` function to use `fromSurface: false` for non-paintable tabs:
```javascript
const captureViaCdp = () => {
  if (!this.debuggerLeaseManager) {
    throw new Error('The bound tab is not currently painted, so background visual capture is unavailable. Restore or reattach the browsing view, continue with DOM observation, or select the tab manually.');
  }
  // BUG FIX: For background/detached tabs, use fromSurface: false to avoid
  // waiting for a compositor frame that will never arrive. This prevents the
  // "run holds at pause until user switches to attached tab" issue.
  const tab = this.requireTab(tabId);
  const isPaintable = this.isTabPaintable?.(tabId);
  const fromSurface = isPaintable !== false; // Only use fromSurface if tab is paintable
  
  return withTimeout(
    this.debuggerLeaseManager.send(tabId, 'background screenshot', 'Page.captureScreenshot', { format: 'png', fromSurface }),
    CAPTURE_TIMEOUT_MS,
    'Timed out capturing the background tab. Continue with DOM observation or select the tab manually.'
  ).then((result) => {
    if (!result?.data) throw new Error('Background visual capture returned no image data. Continue with DOM observation or select the tab manually.');
    return { tabId, mimeType: 'image/png', data: result.data, source: 'cdp',
      url: String(tab.webContents.getURL?.() || ''), title: String(tab.webContents.getTitle?.() || '') };
  });
};
```

### Impact
- Background tabs can now be captured via CDP without stalling
- Runs no longer pause waiting for the user to switch to a non-paintable tab
- The `fromSurface: false` option allows capturing the tab's content without requiring a compositor surface

---

## Test Coverage

A comprehensive test suite was added to verify all three fixes:
**File:** `tests/browser-use-bug-fixes.test.mjs`

The test suite includes:
1. **Bug 1 Test**: Verifies subagents don't spawn involuntary new tabs
2. **Bug 2 Test**: Verifies closing a tab doesn't dismiss the run
3. **Bug 3 Test**: Verifies runs don't stall on non-paintable tabs
4. **Integration Test**: Verifies all three fixes work together

All tests pass successfully.

---

## Files Modified

1. `desktop/main.cjs`
   - Added `sharedBackgroundTabId` variable (line 91)
   - Modified `agentPool` configuration's `allocateTab` function (lines 2262-2284)
   - Modified `closeTab` function to remove automatic run cancellation (lines 3344-3364)

2. `desktop/mcp/browserViewController.cjs`
   - Modified `captureViaCdp` function to use `fromSurface: false` for non-paintable tabs (lines 108-134)

3. `tests/browser-use-bug-fixes.test.mjs` (NEW)
   - Added comprehensive regression tests for all three bugs

---

## Verification

To verify the fixes:

```bash
# Run the new regression tests
node --test tests/browser-use-bug-fixes.test.mjs

# Run existing tests to ensure no regressions
node --test tests/gen8-subagents.test.mjs
```

All tests pass successfully.

---

## Notes

- The fixes are minimal and focused on the specific issues reported
- Deliberate teardown paths (like `closeIndependentChatWindow`, `subagent_close`) still work as expected
- The fixes preserve backward compatibility with existing functionality
- The `tabFocusPolicy.cjs` still prevents agents from auto-foregrounding tabs owned by other agents, which is the correct behavior
