# HANDOFF — DSH harness rewrite of the browser-use desktop chat agent

**Status date:** 2026-11-10 22:5x (Europe/Moscow)
**Last commit in fork:** `0f17051` — "Completion review: structural markers (multipart/ledger/park) + verification-never-blocks flip; decision watchdog; park reason names open requirements; rebuild/decision-watchdog counters initialized"
**Working tree at handoff:** clean (all changes committed).

### Quick start for the next agent

```bash
cd "C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork"
node --test --test-force-exit tests/enforcement-gen5.test.mjs        # must stay 13/13
node --test --test-force-exit tests/enforcement-gen4.test.mjs        # must stay 19/19
node --test --test-force-exit tests/desktop-ai-chat-agent.test.mjs  # must stay 72/78
node _sweep.cjs . && node _sweep_diff.cjs . "C:/Users/london/Desktop/browser-use/browser-use"
```

**New files added this session** (not yet committed as a group — they are in the tree):
`_sweep.cjs` (affected-suite sweep), `_sweep_diff.cjs` (fork-vs-baseline diff),
`_sweep_result.json`, `_sweep_diff.json`.

---

## 1. Mission

Rewrite the internal loop / prompt / recovery machinery of the `browser-use` desktop chat agent
following the **deepseek-harness (DSH) pattern spec**, while preserving the public API contract so
every consumer keeps working unmodified.

Blueprint (read this first): `HARNESS_REWRITE.md` in the fork root — it holds the 43-point pattern
checklist, the functionality checklist, and the disposition map (what is kept / rewritten / removed).

## 2. Where things live

| Path | What it is |
|---|---|
| `C:\Users\london\WorkBuddy AI\2026-11-10-10-23-19\browser-use-dsh-fork` | **the fork** (all work happens here) |
| `C:\Users\london\Desktop\browser-use\browser-use` | the **original** repo — read-only reference, used for baseline test comparison |
| `browser-use-dsh-fork/HARNESS_REWRITE.md` | the blueprint / acceptance checklist |
| `browser-use-dsh-fork/_sweep.cjs` | test sweep helper (runs every suite that touches the rewritten modules, one line per suite) |

**Fork mechanics:** the source repo's `.git` tracks only 3 files — the real code is an untracked
working tree. `git clone` therefore does NOT copy the code. The fork was created with `robocopy /E`
(excluding `node_modules`, `cli-runs`, `logs`, `output`, `scratch`), then `node_modules` was copied
back in separately. A baseline commit (`Fork baseline: snapshot full untracked working tree`) was made
so all later diffs are meaningful.

**Git trap that already bit once:** a `git checkout -- <file>` mid-session silently reverted
uncommitted fixes and the "hang" that came back afterwards was the *same* missing fix, not a new
bug. Commit before any exploratory checkout.

## 3. Architecture — what was built

### 3.1 New harness modules (`desktop/agent/harness/`)

| File | Lines | Role |
|---|---|---|
| `errors.cjs` | 59 | typed failure classes for the DSH error policy |
| `identity.cjs` | 30 | `IDENTITY_LINE` — the one fixed identity sentence |
| `promptRegistry.cjs` | 125 | named, ordered, shadowable prompt sections; strict `{{var}}` interpolation (unknown var throws) |
| `runtimeContext.cjs` | 60 | volatile-fact snapshot that rides the **user** payload, never the system prompt |
| `toolSchema.cjs` | 92 | tool-catalog → provider schema conversion |
| `inbox.cjs` | 71 | the single inbox for steering / agent messages / harness notices |
| `guards.cjs` | 102 | advisory-first guards (repeat-call, stall) |
| `pipeline.cjs` | 82 | the per-decision stage pipeline |
| `loopPolicy.cjs` | 128 | **failure classification, retry ladder, escalation backoff, recovery notices, thinking budget** — one policy table instead of scattered constants |

`desktop/agent/prompt/sections.cjs` (172 lines) is now the **single home for every prompt word**:
`policy:plan`, `policy:evidence`, `policy:batching`, `policy:failure`, `policy:approval`,
`policy:effort`, `tools:catalog-note`, `tools:computer`, `context:instructions-file`,
`policy:completion`.

### 3.2 The agent file split

`desktop/agent/desktopChatAgent.cjs` was **7,797 lines**. It is now:

* `desktop/agent/agentInternals.cjs` — **3,842 lines**, every module-level helper / catalog /
  serializer / validator moved **verbatim** out of the old file (tool catalog, `executeAction`,
  serializers, ledger helpers, redaction, snapshot helpers, …). This is the safety net: behaviour
  that was not explicitly redesigned was moved, not rewritten.
* `desktop/agent/desktopChatAgent.cjs` — **2,595 lines**, the new class: loop, recovery, completion
  review, prompt assembly.

### 3.3 Providers no longer author prompts

`openAiCompatibleProvider.cjs`, `ollamaProvider.cjs`, `responsesProvider.cjs` now **render the
harness system prompt verbatim** (`request.systemPrompt`) and add nothing of their own.

Deleted: `desktop/agent/replyStyle.cjs`, `PUBLIC_FEEDBACK_INSTRUCTION`, `REPAIR_SCHEMA_PROMPT`,
`providerSystemPrompt()`, `AGI_PROMPT`, `V4_AGENT_PROMPT`, `agiPromptForTask()`.

`desktop/computer/computerCatalog.cjs` keeps only the app-detection regexes; the modeling/drawing
playbook text moved into `prompt/sections.cjs` (and is attached by **observation**, never by task-text
regex).

`cli/agent-cli.mjs --system-file` no longer monkey-patches a prompt function — the text rides on the
request as a `complete: true` prompt override.

`src/ollama/{promptBuilder.js,agentLoop.js}` were rewritten as a minimal edition of the same
patterns (section registry + turn/step loop + retry ladder + repeat-call guard).

### 3.4 The preserved contract

`desktopChatAgent.cjs` still exports the same **34 names** as before (verified by an explicit
contract check in this session): `DesktopChatAgent`, `isMultipartTask`, `isMultiAskTask`,
`multiAskChecklist`, `ACTIONS`, `externalProviderBlock`, `MAX_BROWSER_WAIT_MS`, `EFFORT_TIERS`,
`normalizeEffortSetting`, `normalizeEffortTier`, `nextEffortTier`, `applyEffortEscalation`,
`defaultResearchAgent`, `inspectionValue`, `archiveToolResult`, `toolDefinitions`, `isTaskAddition`,
`turnBoundaryNotice`, `steeringAdditionNotice`, `steeringReplacementNotice`, `normalizeToolCalls`,
`isAnswerOnlyTask`, `isAnswerOnlyRequest`, `isAnalysisOnlyRequest`, `claimsCompletion`,
`turnHasMutations`, `remainingRunMs`, `executeAction`, `normalizeAttachments`,
`advanceObjectiveLedger`, `closeActiveObjective`, `retireAnswerOnlyObjective`,
`settleObjectiveLedgerOnTerminal`, `activeObjectiveEntry`.

Additive exports (new, safe): `assembleSystemPrompt`, `runtimeContextText`.

Consumers verified unchanged: `desktop/main.cjs`, `cli/agent-cli.mjs`, `cli/cliSubagents.cjs`,
`cli/tui/guiBackend.mjs`.

## 4. Test status — fork vs baseline

The three hardest suites (all measured with the same commands in both trees):

| Suite | Baseline (original repo) | Fork now | Delta |
|---|---|---|---|
| `tests/desktop-ai-chat-agent.test.mjs` | 72/78 (4 red) | **72/78 (4 red)** | parity — same 4 pre-existing reds (#12, #17, #37, #64) |
| `tests/enforcement-gen4.test.mjs` | 17/19 (E12, E4 red) | **19/19** | **+2 fixed** |
| `tests/enforcement-gen5.test.mjs` | 11/13 (F1, F2 red) | **13/13** | **+2 fixed** |

The 4 remaining core reds are **pre-existing in the original repo** and were not introduced here:
`restores a saved conversation…`, `carries prior reasoning and semantic completed work…`,
`resets strategy after repeated malformed provider output…`, `turns repeated passive waits into
replanning…`.

**Full affected-suite sweep** (77 suites that import the rewritten modules — `_sweep.cjs`):

| Tree | Green | Red |
|---|---|---|
| Baseline (original repo) | **52** | 25 |
| Fork (current) | **38** | 39 |

`node _sweep_diff.cjs <forkRoot> <baselineRoot>` prints the per-suite diff
(`_sweep_diff.json` holds it). Summary: **4 suites FIXED, 24 suites REGRESSED, 49 unchanged.**

FIXED (fork better than baseline):

* `enforcement-gen4` 19/19 (baseline 17/19 — E12 + E4)
* `enforcement-gen5` 13/13 (baseline 11/13 — F1 + F2)
* `mid-run-steering-and-patch-cadence` 6/6 (baseline 5/6)
* `prompt-compression-safety` 6/6 (baseline 5/6)

`desktop-ai-chat-agent` exceeds the 120 s sweep timeout in **both** trees — measure it directly:
fork **72/78**, baseline **72/78** → parity (same 4 pre-existing reds #12/#17/#37/#64).

The baseline's 25 red suites are pre-existing breakage in this checkout (native-evidence-lifecycle
0/8, native-visual-actions 16/26, skill-delivery-to-model 0/2, …). **Always compare against the
baseline, not against zero** — many of these are environment/repo issues, not harness issues.

Baseline red list (for diffing): agent-efficiency, agent-effort, agent-recovery-tabs,
ask-user-live-question, cli-computer-backend, desktop-laya, desktop-openai-compatible-provider,
desktop-research-pipeline, enforcement-gen4, enforcement-gen5, gen8-subagents,
mid-run-steering-and-patch-cadence, native-dialog-handling, native-evidence-context,
native-evidence-lifecycle, native-visual-actions, output-budget, plan-and-skill-delivery,
prompt-compression-safety, request-visibility, responses-continuity, skill-delivery-to-model,
transport-retry, turn-addition-semantics, wire-input-hygiene.

## 5. The completion-review model (the hard part — read this before touching it)

The old code had a **twelve-gate maze**. The rewrite collapsed it into one pass
(`reviewCompletion()` in `desktopChatAgent.cjs`) that collects **named gaps**, then applies a
**bounded** bounce. The subtle part is *which* bounces may be converted into an acceptance.

### 5.1 Current model

1. **Named-gap audit** (`claimsSuccess`): open plan items, live subagents, multi-ask accounting
   shortfall, screenshot-citation fabrication, requirement-ledger gaps, verified-contradiction,
   unbacked claims, verification debt, missing file mutation, failed coding check.
   * Bounce bound: `unbacked_claim` → 1, every other gap class → 2. After the bound: `unbacked_claim`
     is accepted as-is; any other class **parks** the run (`awaiting_recovery` + auto-resume).
2. **Failure-stop ladder**: a `success:false` done must prove exhausted options (2+ approaches tried,
   research done, 1 combined attempt) unless the blocker is external. Sources: `unproven_failure`,
   `unverified_external_block`.
3. **One audit round**: a done claiming success without observed-effect evidence — after a mutating
   turn, on a new turn, or on a **multipart** objective — is a proposal until reconciled once.
   * The **multipart force** fires even when every effect was observed (legacy A-rule).
   * Latched by `run.completionReviewForced` → once per work chunk; a fresh turn/resume earns a
     fresh review.

### 5.2 The verification-never-blocks flip

Restored from the old code (owner policy 2026-11-02) at the **call site**, after `reviewCompletion`
returns and before the result is recorded:

* A bounced done whose turn did real work (`workedThisTurn`) is **accepted** with the gate's concern
  preserved as `verificationNote` (+ `verificationSource`), and a `verified:true` claim is
  downgraded to `verified:false` — instead of another round of proof.
* The flip applies **only** to the plain audit-round concern
  (`recoverySource === 'completion_review'`).

### 5.3 The three structural markers (critical — they keep the rituals alive)

| Marker | Set on | Why the flip must skip it |
|---|---|---|
| `multipartReview` | the multipart forced review | it must be **answered** (re-done with `verified:true`) or park at its bound — F1 |
| `ledgerDemand` | the requirement-ledger demand | the ledger must be **settled** (evidence or explicit skip) or park — F2 |
| `parkedReview` | the exhausted-review **park** branch | a park must stay a park; converting it completes the run instead of holding it — F2 |

**Regression history (do not repeat):**

* Marking the whole audit-round as `multipartReview` broke core tests 14/18/38/65 (the plain
  audit-round is friction, not structure) → fixed by `multipartReview: multipartForce`.
* Leaving the park branch unmarked made the flip convert the **park** into an acceptance → F2
  completed instead of parking → fixed with `parkedReview: true`.
* The `completionReviewForced` latch must NOT reset on a rebuild/re-execution of an already-settled
  action — only ledger-covering new work resets the counter (`!reProduced && ledgerReqs.length &&
  coversOpen`).

## 6. Decision watchdog (added this session)

`withDecisionWatchdog(run, attemptFn)` in `desktopChatAgent.cjs` wraps the provider call inside the
open step:

* dead-air window = `settings.decisionWatchdogMs` (default 120 s, clamped 50 s … 10 min),
* first fire → abort + **one** bounded retry inside the step (+ `agent.decisionWatchdog` event,
  sourced harness notice),
* second fire → **park** via `parkRun` (never terminates), reason
  `Decision watchdog: the model call hung twice …`.

Supporting change: `withinStepTimeout()` (in `agentInternals.cjs`) now exposes `run.activeStepRetire`;
`parkRun()` calls it, so an abandoned step whose provider never settles cannot hold the event loop
open for the whole connect window.

## 7. Known open items — the 24 regressed suites, grouped by root cause

Ordered by how many suites each cause explains. Each line gives the failing test names so you can
jump straight to the assertion.

### 7.1 The named-gap audit is gated on `claimsSuccess` — it misses the contradiction case

**Confirmed root cause (one-line fix).** The whole named-gap audit sits inside
`if (claimsSuccess)`, where `claimsSuccess = output.success !== false`. The old code gated the
contradiction check on `call.input?.verified === true` instead:

```js
// OLD (desktopChatAgent.cjs:4913 in the original repo)
if (call.name === 'browser_done' && call.input?.verified === true && output.ok && !honestlyBlocked) {
  const contradictsVerified = /.../.test(summaryText) || /.../.test(summaryText);
  if ((output.success === false || contradictsVerified) && run.verificationContradictionBounces <= 2) {
    output = { ...output, ok: false, recoverable: true, recoverySource: 'unbacked_claim', error: 'verified:true contradicts your own report…' };
  }
}
```

So a done with **`success:false` + `verified:true`** — exactly the contradiction — never reaches the
new audit. Symptom: `tests/verification-contradiction.test.mjs` →
`expected at least one bounce for contradictory verified:true, got history length 2`.
**Fix:** hoist the contradiction check out of the `claimsSuccess` block and gate it on
`claimsVerified` only (own counter, bound 2, source `unbacked_claim`).

### 7.2 Prompt-text expectations still pin the deleted prose

The old provider-side prompt text (`PUBLIC_FEEDBACK_INSTRUCTION`, `REPLY_STYLE_PROMPT`,
`providerSystemPrompt()`, the `effortEscalationPrompt`, the effort-tier sentences) was deleted.
Tests that assert on those strings now fail and need **re-pinning to the harness assembly**
(`assembleSystemPrompt()` / `runtimeContextText()` are exported for exactly this):

* `desktop-thinking-hygiene` 9/13 (baseline 13/13) — "the provider prompt never names a 'harness'
  the model can narrate", near-duplicate-reasoning stall detection
* `desktop-openai-compatible-provider` 14/18 (baseline 17/18) — system-block shape, schema repair
* `plan-and-skill-delivery` 14/17 (baseline 16/17) — "one bounce carries one demand" (the multi-ask
  accounting gate lost its independent counter when folded into the named-gap audit)
* `wire-input-hygiene` 6/7 (baseline 6/7) — "real desktop tools still attach the playbook, as its
  own block"

Five test files were already re-pinned this way: `computer-tools`, `computer-patch`,
`agent-coding-gating`, `console-evidence-hierarchy`, `prompt-compression-safety`.

### 7.3 The removed flow-state / evidence-streak machinery

`flow-control-agent` 3/9 (baseline 9/9) is the biggest single regression: flow-state
checkpointing, the "enough evidence" notice, the thinking-as-plan guidance, the post-edit evidence
epoch, and the thinking-size escalation all lived in the deleted block. `evidence-streak-accounting`
3/6, `stall-regressions` 3/7, `real-verification` 4/6, `agent-efficiency` 16/20 belong to the same
family: **guards that were removed together with the old stall machinery and have not been rebuilt
in `harness/guards.cjs` yet**. The DSH equivalents (progress streak, evidence epoch, evidence
sufficiency) must be re-implemented as *enforcement stages*, not as prompt prose.

### 7.4 Effort tiers / the escalation channel

`agent-effort` 5/10 (baseline 8/10): the provider-side effort prose is gone, so
"ollama provider maps tiers onto the think flag, decision budget and provider",
"ollama auto mode advertises the escalation channel and effortNeeded support",
"openai-compatible protocol maps effort onto reasoning_effort and thinking" no longer hold. Effort is
now **model-selection config** (`request.effort`, `thinkingBudgetMs`) — the provider mapping and the
`effortNeeded`/`effortReason` channel must be re-established as config, with the *behaviour* prose
living in `prompt/sections.cjs` (`policy:effort`).

### 7.5 Compaction / notebook / prompt-shape contracts

* `gen9-notebook` 7/9 (baseline 9/9) — notebook + workspace pin across forced compaction
* `evidence-survives-compaction` 5/6 (baseline 6/6) — a restored ledger must expose its evidence
* `desktop-package-contract` 11/13 (baseline 13/13) — "missing bound tab is a bounded recoverable
  advisory, not an infinite retry"; desktop agent shell wiring
* `large-paste-attachment` 1/2, `telemetry-scan-not-a-tool-call` 4/5, `browser-wait` 8/9,
  `browser-use-bug-fixes` 2/4, `conversation-lifecycle` 8/9 (flaky), `responses-continuity` 5/8,
  `agent-coding-gating` 11/12, `agent-continuity-regressions` 20/21, `agent-orchestration-regressions`
  9/10, `enforcement-gen2` 13/14, `enforcement-gen3` 10/12 — mostly prompt/notice shape or the
  removal of a specific gate; triage one at a time with the baseline copy side by side.

### 7.6 Lower priority / already-broken upstream

`native-evidence-*`, `native-visual-actions`, `skill-delivery-to-model`, `request-visibility`,
`output-budget`, `transport-retry`, `cli-computer-backend`, `desktop-laya`, `desktop-research-pipeline`,
`agent-recovery-tabs`, `ask-user-live-question`, `gen8-subagents`, `desktop-knowledge-store` are red
in **both** trees — pre-existing, not caused by the rewrite.

For each open item, the intended DSH behaviour is written down in `HARNESS_REWRITE.md`; do not
"fix" by restoring old prompt walls — the point of the rewrite is that the harness enforces
structure, not prose.

## 8. How to run and verify

```bash
cd "C:/Users/london/WorkBuddy AI/2026-11-10-10-23-19/browser-use-dsh-fork"

# single suite
node --test --test-force-exit tests/enforcement-gen5.test.mjs

# one test by name
node --test --test-force-exit --test-name-pattern="F2 dispatch" tests/enforcement-gen5.test.mjs

# affected-suite sweep (77 suites, ~8 min) -> _sweep_result.json
node _sweep.cjs .

# baseline comparison (run in the ORIGINAL repo)
node _sweep.cjs "C:/Users/london/Desktop/browser-use/browser-use"
```

Useful env knobs: `BROWSER_USE_ESCALATION_RESUME_MS` (park → auto-resume delay; the gen5 suite sets
it to `100`), `BU_TRACE` (used for temporary tracing during this session — remove before commit).

## 9. Traps & lessons from this session

* **Infinite microtask bounce loops** starve every timer (no test timeout fires, the process just
  hangs). Root cause found this session: a review branch that bounced **without incrementing its
  counter**. Always increment a bounce counter *before* deciding to bounce, and bound it.
* **Per-test timeouts do not fire** when the event loop is synchronously blocked — use
  `--test-force-exit` plus a wall-clock `timeout` wrapper, and dump the stack via
  `node --inspect` + CDP `Debugger.paused` when a suite hangs.
* **A `setInterval` that is never cleared keeps the process alive** — the park/resume timers are
  one-shot re-armed `setTimeout`s for exactly this reason.
* **Bash heredoc/escaping corrupts generated JS** — write transform scripts to a file with the
  Write tool and run them; never inline multi-line JS with `${}` into `node -e`.
* **Do not treat the original repo as green** — measure the baseline first (25 of 77 affected suites
  are already red there).

## 10. Suggested next steps, in order

1. **Apply the one-line contradiction-gate fix (§7.1)** and re-run
   `verification-contradiction` + `enforcement-gen3` — it is a confirmed root cause and unblocks a
   whole cluster.
2. Re-run the fork sweep and diff against the baseline:
   `node _sweep.cjs .` then `node _sweep_diff.cjs <forkRoot> <baselineRoot>`; update §4 of this doc
   with the new numbers.
3. Rebuild the removed **flow/evidence-streak guards** (§7.3) in `harness/guards.cjs` and wire them
   into the loop as enforcement stages — this is the biggest behavioural hole
   (`flow-control-agent`, `evidence-streak-accounting`, `stall-regressions`, `real-verification`,
   `agent-efficiency`).
4. Re-establish the **effort tier mapping + escalation channel** as provider config (§7.4), with the
   behaviour prose in `prompt/sections.cjs` (`policy:effort`).
5. Re-pin the remaining prompt-text assertions (§7.2) to `assembleSystemPrompt()` — five test files
   already show the pattern.
6. After every change, re-verify the behavioural contract suites:
   `enforcement-gen4` (19/19), `enforcement-gen5` (13/13), `desktop-ai-chat-agent` (72/78) — they
   encode the completion-review model and must stay green.
7. Only then: finish the `desktop-thinking-hygiene` "never name the harness" pass, prune the dead
   exports in `desktop/agent/agentInternals.cjs`, and update `HARNESS_REWRITE.md` with the final
   disposition map.

### 10.1 Triage method that worked

For any regressed suite, run the **same suite in the original repo** and diff the failing test
names. The original repo is the ground truth for "what this checkout looked like before the
rewrite" — it has 25 pre-existing red suites, so a bare failure list is misleading. For a single
test:

```bash
node --test --test-force-exit --test-name-pattern="<test name>" tests/<suite>.test.mjs
```

To see what a bounce actually was, add a temporary trace at the flip site (the pattern used this
session):

```js
if (process.env.BU_TRACE) console.error('[TRACE]', JSON.stringify({ src: output?.recoverySource, mp: !!output?.multipartReview, ld: !!output?.ledgerDemand, ok: output?.ok }));
```

— then remove it before committing.
