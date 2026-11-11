# HANDOFF — browser-use desktop chat agent

> **Session 4 handoff (2026-11-11, 10:46–13:20) — READ THIS FIRST.**
> The session-3 handoff follows below as the first historical block. Everything
> in this top section is newer and describes committed work.

**HEAD:** `e101394` — two commits on top of session 3's `7a6c9b5`:
| Commit | What it did |
|---|---|
| `eef3fe3` | **P0 truthful click reply.** `clickAt` sequences on delivery truth: `pointer.deliveryFallback` means the native event crossed, so only a superseded/cancelled operation vetoes a stage (a fallback-delivered press now pairs its release instead of stranding a held button). The final reply projects the last healthy visual stage + `committed: true`; a visual failure surfaces only as informational `visualInterrupted`. Re-pinned the superseded-release test (its own title says "already committed click" — the new shape is the first one that means it). Also committed session 3's uncommitted work, now tested: `hasCoordinatePair` treats element + schema-default `(0,0)` as the index path (the lichess `{"element":6,"x":0,"y":0}` → `label.hbg` bug), and `releaseTabPointerButtons` skips cancelling during `prepareNativeInput`'s own re-layout. Tests: pointer-controller **30/30** (2 new), gen2 **15/15** (1 new). |
| `e101394` | **P0 DPR screenshot mapping.** `viewportPoint`'s screenshot branch had TWO bugs: it only fired when the model labeled `coordinateSpace:"screenshot"` (models mislabel image pixels as "viewport"), and it **multiplied** by `scaleX/scaleY` — the CSS→image direction, pushing screenshot-space clicks further off target. The capture's scale is image/CSS (1.25 at DPR 1.25), so image→CSS is a **division**: lichess `(286,579)` → `(229,463)`. The `screenshotId` alone now selects the screenshot frame regardless of the label; a stale/unmatched/scale-less id is rejected with the recovery message instead of silently assuming 1:1. Plain CSS coordinates without a screenshotId are untouched. The computer-pointer path keeps its opposite convention (physical pixels, multiply) and is unchanged. `browser_click`/`browser_drag` schema hints updated. New suite `tests/browser-screenshot-coordinates.test.mjs` **7/7**. |

**Working tree:** clean. The temporary debug probe handler was **removed** from
`desktop/main.cjs` and that removal produces a **zero-diff** (the probe was
never committed — session 3 kept it uncommitted), so there is no third commit.

## Session 4 traps & lessons

- **`desktop/main.cjs` is mixed-EOL with a BOM** (CRLF for most lines, LF
  patches inside). The Edit tool normalized it to LF and `git add` then
  produced a **whole-file 5,979/5,979 EOL-flip commit** — caught, reverted via
  `git reset --soft HEAD^`, and rebuilt byte-faithfully with a Node splice
  script (`scratch/session4-splice-main.cjs`, kept as the pattern). Verify any
  main.cjs commit with `git diff <parent> HEAD --stat -- desktop/main.cjs`;
  it must never show thousands of lines.
- The Edit tool preserved CRLF fine for `browserViewController.cjs` — the
  corruption risk is per-file, so check `git diff --stat` after every file's
  first edit, not just `node --check`.
- **`desktop-ai-chat-agent` measured honestly: 94 tests, ~35 min serial.**
  Tests 79/80/89 fail **identically on pristine HEAD** (79 burns a fixed
  ~470 s provider-retry ladder; 89 a 120 s heartbeat timeout) — three more
  pre-existing reds beyond session 3's documented 12/17/37/64. Test 91
  "passes in 5 s standalone but appears to hang" in full-suite runs — it is
  the next test after the ~10 min of serial timeout burn; run it by name.
- Backup before editing uncommitted files (there is no `git checkout` escape):
  session 4 kept `scratch/session4-backup/` of all four touched files.

## Session 4 verification state (measured)

| Suite | Result |
|---|---|
| agent-pointer-controller | **30/30** (was 28; +2 new) |
| enforcement-gen2 | **15/15** (was 14; +1 new) |
| browser-screenshot-coordinates (new) | **7/7** |
| desktop-input-release | 13/13 parity |
| input-drag | 3/3 |
| computer-patch | 34/34 parity |
| prompt-compression-safety | 6/6 |
| desktop-thinking-hygiene | 13/13 |
| desktop-package-contract | 11/13 — same 2 pre-existing reds |
| desktop-openai-compatible-provider | 17/18 — test 4 verified pre-existing at HEAD via worktree |
| desktop-ai-chat-agent | 7 pre-existing reds (12/17/37/64/79/80/89), all HEAD-identical; 91–94 pass standalone |

## Session 4 remaining work

- **P1 — live lichess verification still open.** The running dev instance is
  now stale (started in session 3, without these fixes). Kill only the fork's
  electron.exe (see §2d command below), relaunch with
  `env -u ELECTRON_RUN_AS_NODE npm run desktop:dev`, navigate to
  `https://lichess.org/training`, and drive a real click; chessground must
  select a piece. The debug probe is gone — drive clicks through a real agent
  task (`browser-use:agent-start` over the loopback bridge) or temporarily
  re-add a probe (do not commit it).
- **P2 — unchanged from session 3:** completion waterfall, decision/action
  waterfalls, notebook wire trim (§4 of the session-3 block below).
- The three `desktop-ai-chat-agent` HEAD-identical reds (79/80/89) are worth a
  triage pass someday — they are behaviour differences from the reference
  harness, not click-tool issues.

---

## SESSION 3 (historical) — root-cause findings and the fix queue

> **Session 3 handoff (2026-11-11, 08:46–10:36).**

**HEAD:** `4033085` "Input delivery must never depend on the pointer animation"
**Working tree:** **3 modified files, uncommitted** — see §3.
**App state:** dev instance running (11 `electron.exe`) on lichess training page, with a
**temporary debug probe handler** (§5) that must be removed before shipping.

## 0. The user's standing mandate (do not re-litigate)

1. **Zero external identity** in the program: no DSH/DeepSeek *harness* names anywhere in
   code, comments, titles, or prompts. The six remaining "DeepSeek" strings are the LLM
   **provider option** in the settings UI — a vendor choice, keep them.
2. **Match the reference harness's discipline, not just its numbers**: prompt ≤ 2,000 chars,
   identity one sentence, largest block ~434, tools own their guidance (plugins), no wall
   of prose anywhere. "Not just renaming while keeping all the bloated comments and
   red-taped policies."
3. **Never break the MCP bridge**: external agents using browser-use over MCP must keep
   seeing its tools (`desktop/mcp/localMcpServer.cjs` has its OWN 31-tool list; untouched).
4. **Find root causes, do not patch symptoms.** The user's exact words: "not patching the
   errors without resolving the root cause", "the agent is still making the models stupid",
   "find the remaining issues (mainly remaining differences in loop between deepseek
   harness)". Same model over MCP through the reference harness gives "premium drive"; the
   gap is our loop, not the model.

## 1. Commits since session 2 (oldest → newest)

| Commit | What it did |
|---|---|
| `f0d430b` | Added a "· DSH" window-title marker to distinguish the fork from the stale installed build — **later removed** (`1f7a6eb`, `68a6698`). Do not re-add. |
| `f134c9f` | `LOOP_BLOAT_AUDIT.md` + three measurement scripts (`_dsh_inventory.cjs`, `_fork_prompt_breakdown.cjs`, `_wire_breakdown.cjs`). Measured: DSH 1,776 chars of system prose / 10 sections; fork 10,865 / largest 4,466 / identity ~999. |
| `1f7a6eb` | Cut the prompt to **1,990 chars agi / 1,532 browser** (largest block 456, identity 55 chars, 10 blocks). Moved modeling/drawing playbooks to `computer_pointer`/`computer_stroke` schemas via `attachCreativePlaybooks()` (exported from `desktopChatAgent.cjs`), planning rule into `update_plan`'s schema, condensed the four monster tool descriptions. **Also ran a blind identity-strip pass that corrupted the splash art and mangled `HANDSHAKE_TIMEOUT_MS`** — see §2. Re-pinned 4 suites. |
| `68a6698` | Restored `desktop/assets/splash-screen.html` byte-identical; fixed `HANAKE_TIMEOUT_MS` → `HANDSHAKE_TIMEOUT_MS`, dangling `"· "` titles, `// : ` comment starts (5 files). |
| `4033085` | Input-delivery fallback in `browserViewController.cjs` (4 sites) + `browser_click` batch-chain schema guidance + re-pinned one pointer test. See §2. |

## 2. Root causes found (all evidence-backed)

### 2a. IPC "An object could not be cloned" (select-tab / agent-start)
The codebase sanitizes the **send** path (`safeIpcSend` always projects; its own comment says
probing was insufficient and "was the source of the remaining cancel errors") but the
**handle-reply** path returned raw state blobs from 148 handlers; only 7 used
`safeIpcValue`. Fix installed at the **top of `desktop/main.cjs` (lines ~2–45)**: a
registry-level `ipcMain.handle` wrapper that clone-probes every reply, logs the exact
offending field path via `findCloneOffenderPath` (once per path), and falls back to
`ipcJsonProjection`. It must stay **above all registrations**, including
`webBridge.installIpcCapture({ ipcMain })` (which adds its own nested wrapper — fine).
`desktop-package-contract` 11/13 (same 2 pre-existing reds) after this change.

### 2b. Misaligned splash image
`desktop/assets/splash-screen.html` is one giant base64-embedded PNG inside an SVG. The
identity-strip pass deleted the letters `DSH` occurring **naturally inside base64**
(`...8cDSH4JN1q...` → `...8c4JN1q...`), shifting every following byte and breaking base64
group alignment. Restored byte-identical from
`C:/Users/london/Desktop/browser-use/browser-use/desktop/assets/splash-screen.html`.
**Rule: never run a text substitution over opaque data (base64, generated assets).**

### 2c. "The AI clicks once then replans forever" — a stack of causes, none of them the model
Evidence from the user's logs: every click returned
`"pointer": {"interrupted": true, "reason": "input-operation-cancelled"}` and (later)
`"hit": {"hit": null, "reason": "hit-test-unavailable"}`.

1. **The visual pointer overlay gated delivery** (fixed in `4033085`). `mouseDown` skipped
   `mousePressed` whenever the animated cursor move/press could not proceed (cancelled,
   timed out, ACK lost) while the paired release still dispatched → page got a stray
   `mouseup` with no `mousedown`; chessground/canvas drop it. Fix at 4 sites (`mouseDown`
   move + press, `mouseMove`, wheel scroll): a **superseded** operation still vetoes, but a
   visual failure with a current op delivers through `prepared.forceBackground` and reports
   `pointer.deliveryFallback: true`. Re-pinned the test that encoded the old "fail closed"
   contract; the superseded case keeps its own test and still fails closed.
2. **Our own layout sync cancelled our own operation** (UNCOMMITTED, see §3). Chain:
   `prepareNativeInput()` → `ensureTabPaintable()` → `syncBrowserViewVisibility()` →
   overlay `syncBounds()` size change → `clearPressedInteraction(..., true)` →
   `onPressedSurfaceInvalidated` → `releaseTabPointerButtons()` →
   `cancelActivePointerOperations()` → the operation minted moments earlier is dead.
   Root fix installed: `suppressPointerInvalidation` flag around `ensureTabPaintable`;
   `releaseTabPointerButtons` skips cancelling during our own preparation. **Not yet
   verified live.**
3. **`(0,0)` placeholder clicks** (UNCOMMITTED, §3). Latest user log:
   `{"element": 6, "x": 0, "y": 0}` → `hasCoordinatePair()` returned true, so the
   coordinate path won and clicked the **page's top-left corner** (hit: `label.hbg`,
   rect `{0,0,60,60}`) instead of element 6. That is the "randomly clicking random
   buttons". Fix: when an element index is present and both coords are 0, treat them as
   the schema placeholder and use the index.
4. **The reply lies about committed clicks** (NOT FIXED — P0). `clickAt`'s last return
   (`browserViewController.cjs:444`) is
   `pointer: safePointerProjection(released.pointer || pressed.pointer || moved.pointer)`.
   `mouseUp` always dispatches the release and returns the *visual* move result, which can
   be `interrupted` even though the click fully landed. The model reads `interrupted: true`,
   concludes the click failed, takes another screenshot and replans. **This is the
   re-screenshot/rethink loop the user keeps complaining about.** Fix: when press+release
   both committed, return a truthful pointer (`committed: true`, at most
   `visualInterrupted: true` as informational) and never a top-level `interrupted` flag.
5. **DPR / coordinate-space mismatch** (NOT FIXED — P0). Live probe on lichess:
   viewport `878×706`, **devicePixelRatio 1.25**, board `cg-board` rect
   `{x:14, y:64, w:493, h:493}` (ends at y=557). The model read screenshot **image
   pixels** and sent them as `coordinateSpace: "viewport"`: y≈579/580 clicks land *below*
   the board; the same square in CSS px is `(229,463) ≈ (286,579)/1.25`. Model tried both
   variants. Fix in `viewportPoint` (`agentInternals.cjs`): when a `screenshotId` is
   present (or the screenshot's dimensions differ from the CSS viewport), map image
   pixels → CSS px using the captured DPR/size instead of trusting the label; reject a
   stale/empty screenshotId rather than silently assuming 1:1.
6. **`hit-test-unavailable`** (NOT root-caused). `hitTest` → `evaluatePage` (debugger
   `Runtime.evaluate`, fallback `executeJavaScript`), 3 s timeout, catch-all → the sentinel.
   A live probe proved eval WORKS on a fresh tab (`document.title`). So it is situational:
   the 3 s timeout under load, a debugger lease handoff, or `requireTab` throwing mid-run.
   Make `hitTest` surface the real error (like §2a's wrapper) before deciding.

### 2d. Single-instance / launch traps
`main.cjs:4579` uses `requestSingleInstanceLock()`; the app has a **tray**, and
`window-all-closed` deliberately does NOT quit while the tray exists. Closing the window
leaves it hidden holding the lock → a relaunch exits in ~1 s with no error. Quit via the
tray or kill only the fork's processes:
`Get-CimInstance Win32_Process -Filter "name='electron.exe'" | ? { $_.ExecutablePath -like '*browser-use-dsh-fork*' } | % { Stop-Process -Id $_.ProcessId -Force }`
(My WorkBuddy host is also `electron.exe` — never blanket-kill.) The agent shell exports
`ELECTRON_RUN_AS_NODE=1`, which makes `electron.exe` run as plain Node and crash at
`ipcMain` — always launch with `env -u ELECTRON_RUN_AS_NODE npm run desktop:dev`.

## 3. Uncommitted working tree (3 files — commit or finish first)

> **RESOLVED in session 4:** all three changes are committed (`eef3fe3`) and
> tested; the probe (row 3) was removed outright. The tree is clean.

| File | Change | Status |
|---|---|---|
| `desktop/agent/desktopAgentCoordinator.cjs` | `hasCoordinatePair`: element + `(0,0)` → index path (§2c.3) | syntax OK, **no test written** |
| `desktop/mcp/browserViewController.cjs` | `suppressPointerInvalidation` in ctor/`prepareNativeInput`/`releaseTabPointerButtons` (§2c.2) | syntax OK, **not verified live**, no test |
| `desktop/main.cjs` | **TEMPORARY** `browser-use:debug-page-probe` handler at line 5561 (§5) | must be **removed** before shipping |

`git diff --stat`: 44 insertions, 3 deletions across those files. `4033085` is the last
commit; `LOOP_BLOAT_AUDIT.md` has a "RESULT" section with the measured before/after.

## 4. Loop differences vs the reference harness that are STILL open

The user's "mainly remaining differences in loop" — none of these are done:

- **Completion waterfall**: `reviewCompletion` is one ~300-line function with **13 done-gates**
  and **8 separate `run.*Bounces` counters**; the reference harness uses an ordered
  middleware waterfall where the first bail wins and bounds live in one table. Convert to
  one ordered pass. This is where the "congested broken loop" lives.
- **Decision/action waterfalls**: **12 inline pre-execute guard stages**
  (`fillGate` → `constraintTamper` → `presentationTamper` → `repeatGuard` → read-only cap →
  `riskGate` → `layaVerifier` → `canAttempt` → `prepareAction` → `assertProgress` …) plus
  inline post-decision blocks (flow assessment, evidence streak, evidence-phase
  checkpoints). ~8,000 lines across `desktopChatAgent.cjs` / `agentInternals.cjs` /
  `desktopAgentCoordinator.cjs` vs the reference's ~3,900-line decision runtime.
- **Per-decision notebook block**: 1,196 chars rides EVERY decision in
  `providerTurnLedger.cjs` (§4 of the audit). Trim to a pointer.
- Prompt parity is done (§1); tool-guidance ownership is done for playbooks/planning; the
  remaining `model_catalog` (831), `browser_done` (711), `browser_click` (~1,031 after the
  batch-chain clause) descriptions are schema surface but still 2× the reference's largest
  section — condense if the user insists on the 434 ceiling everywhere.

## 5. Temporary debug probe (REMOVE)

> **REMOVED in session 4.** The probe was never committed, so its removal is a
> zero-diff against HEAD; the byte-faithful splice is `scratch/session4-splice-main.cjs`.
> The probe-based live-verification recipe below still describes how to drive
> a probe click IF one is temporarily re-added (uncommitted) for a live check.

`desktop/main.cjs:5561` `ipcMain.handle('browser-use:debug-page-probe', ...)` accepts
`{expression}` (runs `browserViewController.evaluatePage`) or `{click:{x,y}}` (runs
`browserViewController.clickAt`). Call over the loopback bridge:

```bash
curl -s -X POST http://127.0.0.1:4210/ipc -H 'content-type: application/json' \
  -d '{"channel":"browser-use:debug-page-probe","args":[{"expression":"document.title"}]}'
curl -s -X POST http://127.0.0.1:4210/ipc -H 'content-type: application/json' \
  -d '{"channel":"browser-use:state","args":[]}'
```

Useful before removing: navigate to `https://lichess.org/training`, read the `cg-board`
rect, `clickAt` a pawn square, then eval `document.querySelectorAll('piece.selected').length`
to prove the click actually selects a piece. **The currently running dev instance has this
handler; any fresh instance will not.**

## 6. Priority list for the next agent

> Session 4 status: P0 truthful reply ✅ (`eef3fe3`), P0 DPR mapping ✅
> (`e101394`, plus the direction-inversion fix the queue missed), P0 probe
> removal ✅, P1 tests for the two session-3 fixes ✅. Remaining below.

- **P0 — truthful click reply** (`clickAt:444`): committed clicks must never say
  `interrupted`. Add a test that a delivered press+release reports `committed: true`.
- **P0 — DPR screenshot mapping** in `viewportPoint`: add a DPR-1.25 test proving a
  screenshot pixel `(286,579)` maps to CSS `(229,463)` on the board.
- **P0 — remove the probe handler** from `desktop/main.cjs`.
- **P1 — verify the suppression fix live** (relaunch, real lichess click, check chessground
  selection) and add a unit test for `prepareNativeInput` not cancelling a minted op.
- **P1 — commit the 3 files** with the two fixes + their tests; keep the identity and
  no-opaque-data rules.
- **P2 — completion waterfall**, then decision/action waterfalls, then the notebook wire
  trim. Each re-pins the suites that pin the old structure — re-pin only when the contract
  intentionally changes, and say why in the commit.

## 7. Verification state (measured, do not claim more)

- `agent-pointer-controller` 28/28 · `desktop-input-release` 13/13 · `computer-patch`
  34/34 · `prompt-compression-safety` 6/6 · `desktop-thinking-hygiene` 13/13 ·
  enforcement/flow suites all green (gen2 14, gen3 12, gen4 19, gen5 13, flow 9,
  streaks 6, verification 6, contradiction 3, stalls 7).
- Core suite **72/78 — the same 4 pre-existing reds** (tests 12, 17, 37, 64), unchanged
  through every change in session 3.
- `desktop-package-contract` 11/13 and `desktop-openai-compatible-provider` 17/18 and
  `agent-coding-gating` 11/12 — each only its pre-existing red(s).
- `tests/agent-pointer-overlay-e2e.mjs` fails **identically on the untouched baseline**
  (display-size bounds assertion) — environmental; use `env -u ELECTRON_RUN_AS_NODE`.
- Real CLI run (sensenova over xkiro, before the input fix): completed, 3 decisions / 3
  tool calls / 24 s, correct answer. Wire system prompt 2,349 = 1,990 harness + 359
  per-request effort protocol.
- MCP bridge: 31 `browser_*` tools, `git diff desktop/mcp/` empty for the agent-side work.
- The installed app at `AppData\Local\Programs\browser-use\Browser-use.exe` is a **Nov 7
  stale packaged build** and shows the old loop by definition. Don't debug against it.

## 8. Traps & lessons

- `desktop/mcp/browserViewController.cjs` is **CRLF** (2,092 lines). Multi-line `\n`
  anchors silently fail; convert to LF for edits and back, or use EOL-aware scripts. A
  previous attempt at these same four edits produced cascading syntax errors — verify with
  `node --check` after EVERY site and revert with `git checkout -- <file>` on any doubt.
- Never re-pin a test to hide a behaviour regression. Re-pin only when the contract
  intentionally changed (the "timed-out visual arrival" test was re-pinned because
  "fail closed" WAS the bug) and keep the superseded-case test intact.
- The reference harness repo is at `C:/Users/london/Desktop/deepseek/deepseek-harness`;
  its whole system prose is 1,776 chars across 10 sections, its agent loop uses
  `dispatch.waterfall` middleware, and per-tool guidance is 1–3 sentences.
- Rebuild the installed app with `npm run desktop:package` if the user wants the packaged
  build to show the new loop; the dev instance is `npm run desktop:dev`.

---

## SESSION 2 (historical) — dropped-machinery restoration

**Status date:** 2026-11-11 (session 2 — the dropped-machinery restoration)
**HEAD at that time:** `cf21743` "Effort protocol has ONE owner: the provider, not the registry"
**Working tree at that time:** clean (all changes committed).

### What session 2 found and fixed

Session 1's handoff claimed parity, but a systematic **lost-functionality audit**
(`node _lostcheck.cjs` + `node _orphans.cjs`) proved otherwise: the rewrite had moved
the flow-control helpers verbatim into `agentInternals.cjs` and then **never wired their
call sites back in**. 11 helpers were declared and exported but referenced nowhere, and
the consuming gates for counters that WERE still initialized (`run.constraintRejection`,
`run.failedClaimBounces`) had been dropped. It had also **weakened two core tests** to
match the degraded behaviour instead of restoring the behaviour.

Everything below is restored as DSH enforcement stages, not as prompt walls.

| Restored | Where it lives now | Suite it un-breaks |
|---|---|---|
| verified:true contradiction gate (own counter, bound 2, independent of `claimsSuccess`) | `reviewCompletion` | verification-contradiction 3/3 |
| failed-claim gate + blocked-done provenance gate (E8) | `reviewCompletion` | enforcement-gen3 12/12 |
| **flip scope made explicit** — `FLIPPABLE_RECOVERY_SOURCES` in `loopPolicy.cjs` | one policy table | gen4 19/19, gen5 13/13, real-verification 6/6 |
| flow assessment at BOTH decision boundaries | `harness/flowGuard.cjs` (`FlowGuard`) | flow-control-agent 9/9 |
| EVIDENCE SUFFICIENT streak accounting | `flowGuard.cjs` (`observeEvidenceStreak`) | evidence-streak-accounting 6/6 |
| read-only cap (the one hard floor) | `flowGuard.cjs` (`readOnlyCapApplies`) | agent-orchestration 10/10 |
| keyed actionless stall (identical restatement only) + blunt backstop | `flowGuard.cjs` (`observeActionlessStall`) | core actionless tests restored |
| near-duplicate reasoning stall | `desktopChatAgent.cjs` (`noteStreamingThought`) | core streaming-stall test restored |
| escalating thinking budget + shared stall ladder | agent loop + `I.ESCALATION_PARK_FIRES` | enforcement-gen2 14/14 |
| effort protocol (per-request tier + escalation channel) | providers render it as wire config | agent-effort 8/10 = baseline |
| speculation demotion ladder (auto mode) | agent loop | agent-effort parity |
| evidence-phase checkpoints (diagnosis/coding/general) | `flowGuard.cjs` (`observeEvidencePhase`) | agent-efficiency 17/20 = baseline |
| coding-gate export (`codingCheckSatisfied`) | `desktopChatAgent.cjs` re-exports it | stall-regressions 7/7 |
| lost prompt directives + `defaultSystemPrompt()` + `REPAIR_POLICY` | `prompt/sections.cjs` | desktop-openai-compatible-provider 17/18 = baseline |

### Test weakening reverted

`tests/desktop-ai-chat-agent.test.mjs` was **restored to the baseline file**. Session 1 had
renamed "repeated actionless narration …" → "repeated undecidable narration …" and changed
the expectations from `ACTIONLESS STALL` / `STREAMING STALL` to "no executable decision" /
"zero stall notices" — i.e. it pinned the absence of restored behaviour. The original file
passes now. Two badge assertions in `desktop-thinking-hygiene` were re-pinned (legitimately)
to `agentInternals.cjs`, which owns that plumbing after the file split.

### Test status — fork vs baseline (measured, not claimed)

| Suite | Baseline | Fork now | Delta |
|---|---|---|---|
| `desktop-ai-chat-agent` | 72/78 (4 red) | **72/78 (same 4 reds)** | parity |
| `enforcement-gen2` | 14/14 | **14/14** | parity |
| `enforcement-gen3` | 12/12 | **12/12** | fixed (+2) |
| `enforcement-gen4` | 17/19 | **19/19** | fixed (+2) |
| `enforcement-gen5` | 11/13 | **13/13** | fixed (+2) |
| `verification-contradiction` | red | **3/3** | fixed |
| `real-verification` | 6/6 | **6/6** | fixed |
| `flow-control-agent` | 9/9 | **9/9** | fixed |
| `evidence-streak-accounting` | 6/6 | **6/6** | fixed |
| `stall-regressions` | 7/7 | **7/7** | fixed (+4) |
| `agent-orchestration-regressions` | 10/10 | **10/10** | fixed (+1) |
| `agent-effort` | 8/10 | **8/10** | parity |
| `agent-efficiency` | 17/20 | **17/20** | parity |
| `desktop-thinking-hygiene` | 13/13 | **13/13** | fixed (+4) |
| `desktop-openai-compatible-provider` | 17/18 | **17/18** | parity |

**Affected-suite sweep** (`node _sweep.cjs .`, 77 suites, measured at HEAD `cf21743`):

| | suites green | suites red | tests pass |
|---|---|---|---|
| **Baseline** (original repo) | 52 | 25 | 669/720 |
| **Fork** at session 1 handoff | 38 | 39 | — |
| **Fork** now | **49** | **28** | **662/720** |

Session 2 started at 38 green / 39 red. The remaining gap is 9 regressed suites carrying 15
tests, listed below. Four suites are now BETTER than the baseline (gen4, gen5,
mid-run-steering-and-patch-cadence, prompt-compression-safety), and every loop/prompt/
recovery/effort suite is at parity or better.

**Always compare against the baseline, not against zero** — the checkout has 25 pre-existing
red suites (native-evidence-lifecycle 0/8, native-visual-actions 16/26, skill-delivery-to-model
0/2, …).

### Remaining known gaps (fork worse than baseline — 9 suites, 15 tests)

Each is a *behavioural* difference, not a lost helper.

1. **Park/resume integration (2 tests).** `agent-continuity-regressions` #6 and
   `agent-coding-gating` #11 expect a parked run to resume **in-process** before `start()`
   resolves, as the baseline's `escalateRun` did. The fork's `parkRun` schedules the same
   one-shot auto-resume, but `start()` resolves as soon as the run parks, so the caller sees
   `result: null` / `awaiting_recovery`. Fixing this means reworking how park integrates with
   `start()`'s resolution — it touches the suites that are currently FIXED, so it needs care.
2. `plan-and-skill-delivery` 14/17 — "one bounce carries one demand" (the multi-ask
   accounting gate lost its independent counter when folded into the named-gap audit), plus
   the skill-body delivery path and the partial-accounting rejection.
3. `responses-continuity` 5/8 — the Responses-protocol route selection and partial-action
   rejection.
4. `desktop-package-contract` 11/13 — missing-bound-tab advisory shape + the desktop shell's
   dark reference controls (renderer wiring).
5. `gen9-notebook` 7/9, `browser-use-bug-fixes` 2/4, `evidence-survives-compaction` 5/6,
   `large-paste-attachment` 1/2 — one to two tests each; triage with
   `node --test --test-force-exit --test-name-pattern="<name>" tests/<suite>.test.mjs`
   against the baseline copy side by side.

### Real-provider verification (the requirement session 1 skipped)

Session 1 tested with scripts only. Session 2 ran the **real CLI loop** against the real
provider (xkiro + `sensenova/sensenova-6.8-flash-lite`):

```bash
cd "C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork"
ANTHROPIC_AUTH_TOKEN="sk-xt-…" node cli/agent-cli.mjs \
  --task "Open https://example.com, then use browser_execute to read document.title and the number of links on the page, and report both values in your final summary." \
  --model "sensenova/sensenova-6.8-flash-lite" \
  --max-seconds 210 --max-steps 16 --out-dir scratch/dsh-verify/run004
```

Result (final commit, run005): **completed**, 3 decisions / 3 tool calls, 22 s, correct
answer
("The page at https://example.com has the title \"Example Domain\" and contains
exactly 1 link, which points to https://iana.org/help/example-domains."),
`success: true, verified: true`. Wire log: `HTTP 200 https://api.xkiro.com/v1/chat/completions`.
`final-state.json` → `state` carries the live harness state: `flowControl`
(`phase:"accept"`, `decisionNumber:5`, `evidenceEpoch:5`, `lowYieldStreak:0`),
`evidenceOnlyStreak:0`, `readOnlyDecisionStreak:1`, `watchdogFires:0`, no stall state.

**Trap:** an explicit `--base-url` is used **verbatim**. `--base-url https://api.xkiro.com`
produces `…/chat/completions` → HTTP 404 on every decision. Omit `--base-url` (the default
appends `/v1`) or pass `https://api.xkiro.com/v1`.

### Tools added this session

| File | What it does |
|---|---|
| `_lostcheck.cjs` | diffs the SET of recovery sources each tree can emit; anything baseline-only is a dropped gate |
| `_orphans.cjs` | finds helpers declared in `agentInternals.cjs` but referenced nowhere — the smoking gun of a dropped call site |

Both are the audit that caught what session 1's test sweep alone did not. Keep them.

### Traps & lessons (carried from session 1, plus new)

* **A test sweep can pass while behaviour is gone.** Session 1's fork had 11 dead helpers
  and weakened tests, and still showed 38 green. The orphan/coverage audit is what found it.
  Re-run `node _orphans.cjs` after any refactor that moves code between files.
* **Python `open(...,'w')` on Windows converts `\n` to `\r\n`** — it silently rewrote two
  3,800-line files and inflated the diff to 7,600 lines. Always pass `newline=''` or convert
  back to LF before committing.
* **`harness/` is one level deeper than `agent/`.** From `harness/x.cjs`, `flowControlState`
  is `../flowControlState.cjs` but `computerCatalog` is `../../computer/computerCatalog.cjs`.
* Bash heredoc/escaping corrupts generated JS — write transforms to a file with the Write
  tool and run them; never inline multi-line JS with `${}` into `node -e`.
* Do not treat the original repo as green — measure the baseline first.

### How to run and verify

```bash
cd "C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork"

node --test --test-force-exit tests/enforcement-gen4.test.mjs        # 19/19
node --test --test-force-exit tests/enforcement-gen5.test.mjs        # 13/13
node --test --test-force-exit tests/desktop-ai-chat-agent.test.mjs   # 72/78 (4 pre-existing)

node _sweep.cjs .                                                     # all 77 suites
node _sweep_diff.cjs . "C:/Users/london/Desktop/browser-use/browser-use"
node _orphans.cjs                                                     # must stay near-empty
node _lostcheck.cjs                                                   # dropped-gate audit
```

`desktop-ai-chat-agent` exceeds the sweep's 120 s timeout in **both** trees — measure it
directly with the command above.

Env knobs: `BROWSER_USE_ESCALATION_RESUME_MS` (park → auto-resume delay; the gen5 suite sets
it to `100`), `BROWSER_USE_ESCALATION_PARK_FIRES` (stall-ladder park budget, default 4).

### The completion-review model (unchanged contract, scoped flip)

`reviewCompletion()` is one pass that collects named gaps and applies a bounded bounce. The
three structural markers (`multipartReview`, `ledgerDemand`, `parkedReview`) still exempt
their bounces from the flip. What changed: the flip's scope is no longer "only
`completion_review`" — it is the explicit allow-list `FLIPPABLE_RECOVERY_SOURCES`
(`completion_review`, `unproven_failure`, `unverified_external_block`,
`unverified_verification_claim`). Gates that catch FABRICATION (`unbacked_claim`,
`screenshot_claim_unverified`) or POLICY (`choice_in_summary`) are deliberately NOT on it —
the harness never waives those, which is exactly why E12 stayed green while E8 came back.

The verified:true contradiction gate is a dedicated pre-audit gate with its own counter
(bound 2). Its counter counts CONTRADICTIONS, not verified dones, so a clean done never
spends a later contradiction's budget.

### Regression history (do not repeat)

* Broadening the flip to *every* recoverable done-bounce eats the E12 unbacked-claim bounce.
  Keep the allow-list explicit.
* The blunt `emptyDecisionStreak >= 3` park replaced the keyed stall and lost the
  `ACTIONLESS STALL` notice. Both detectors now run: keyed first (precise), blunt as the
  backstop, both parking — never terminating.
* `run.failedClaimBounces` and `run.constraintRejection` were initialized but never consumed.
  When you keep a counter, keep its gate.
* Session 1's blueprint said `flowControlState.cjs` was "retained on disk but no longer
  loaded by the agent — then delete". That was wrong: it is the pure state machine the
  flow guard drives. It is loaded again (via `harness/flowGuard.cjs`) and must stay.
