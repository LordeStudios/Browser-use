# Browser-use recovery handoff

Created: 2026-08-09 01:31 Africa/Nairobi

Backup archive: `E:\Users\maximus\Documents\GitHub\uganda-art-pulse-backups\browser-use-20260809-013114`

## Why this exists

The user reports that the Electron Browser-use chat regressed around the AI
message loading-GIF work. The live symptom is not resolved: provider thinking
and the final answer are not painted naturally; the UI can remain on a stale
`Thinking...`/recovery presentation, and detailed replies can stay buried in
agent protocol/action output instead of appearing as the normal assistant
message. Treat the user's current observation as authoritative. Do not claim
this regression is fixed merely because unit tests pass.

This checkout contains a large mixed dirty tree from several UI, provider,
agent-loop, persistence, browser-control, and test changes. It may include user
work and earlier agent work. Preserve it until the external backup below has
been verified. Do not use `git reset --hard`, `git clean`, or broad checkout
commands without the user's explicit approval.

## Source and acceptance surfaces

- Electron app under repair:
  `E:\Users\maximus\Documents\GitHub\uganda-art-pulse\tools\browser-use`
- Working Lorde AI reference implementation:
  `E:\Users\maximus\Documents\GitHub\uganda-art-pulse\studios\public\Apps\lorde-design-studio`
- Relevant reference modules:
  `src/editor/aiProviderRegistry.js`, `src/editor/nativeToolTransport.js`,
  `src/editor/aiThinkingStream.js`, and `src/editor/lordeAiPanel.js`
- Historical commits the user previously asked to inspect:
  `5664ac6b239b2f599e77ee7d897bf13c9b566dea` and
  `0703ffa06770072de4f29d3aade0a7fc2ba7fd07`
- Real acceptance surface: the visible Electron Browser-use chat. Passing unit
  tests or a mocked provider stream is supporting evidence only.

## Latest diagnosis attempt (not accepted as a completed fix)

The working Lorde AI sends native provider tool schemas and keeps reasoning and
normal text as separate stream channels. Browser-use had diverged by forcing
OpenAI-compatible/xKiro turns through `response_format: json_object`, accepting
only command-shaped content on the first pass, and then asking the model for a
second structural-repair response. The Electron coordinator could also reject
an already `verified:true` detailed `browser_done` result and keep the actual
answer inside a tool result while starting another model turn.

Changes were attempted in:

- `desktop/agent/openAiCompatibleProvider.cjs`
- `desktop/agent/ollamaProvider.cjs`
- `desktop/agent/desktopChatAgent.cjs`
- `desktop/agent/publicResponseContract.cjs`
- matching flowcharts and tests

The user subsequently reported that nothing was fixed. After restoring or
selectively replaying code, reproduce through the visible Electron chat first,
capture the raw provider events and renderer events for one message, and compare
them event-by-event with Lorde AI. Do not infer success from parser tests alone.

## Loading GIF context

- Source GIF supplied by the user:
  `C:\Users\Administrator\Desktop\Codex Image Aug 8, 2026, 11_52_33 PM.gif`
- Studio asset currently present:
  `studios/public/Apps/lorde-design-studio/assets/lorde-studio-loading.gif`
- Browser-use renderer assets are under:
  `tools/browser-use/desktop/renderer/assets/`

The requested display size is approximately one uppercase text row, not a large
loading panel. The user believes the functional regression occurred before or
after this integration, so use Git/diff evidence to identify the exact boundary
rather than assuming the GIF itself is the cause.

## Backup contents and recovery

The external backup contains:

1. A path-preserving copy of every tracked modified file and every untracked
   file reported by Git at backup time, including this handoff.
2. `working-tree.patch` and `staged.patch` for textual recovery.
3. `git-status.txt`, `head.txt`, and `changed-paths.txt` manifests.
4. A copy of `browser-use-chat-history.json` and
   `browser-use-settings.json`. Secrets are intentionally excluded.
5. A ZIP copy beside the backup directory for an additional integrity copy.

To recover one file, copy it from the backup's `repo\...` tree to the matching
repository-relative path. To inspect all text changes, open
`working-tree.patch`. Do not apply the whole patch blindly because the dirty
tree contains mixed work.

## Verification known at backup time

- Lorde AI reference stream tests: 19/19 passed.
- Browser-use focused provider/agent tests: 83/83 passed.
- Browser-use desktop unit suite: 150/150 passed.
- Electron interaction E2E passed for viewport bounds, settings, clipboard,
  console, tabs, focus, and navigation.
- These checks did not satisfy the user-visible live AI streaming acceptance
  case. The regression remains open.

