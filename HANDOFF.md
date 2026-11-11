# HANDOFF — DSH harness rewrite of the browser-use desktop chat agent

**Status date:** 2026-11-11 (session 2 — the dropped-machinery restoration)
**HEAD:** `cf21743` "Effort protocol has ONE owner: the provider, not the registry"
**Working tree:** clean (all changes committed).

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
