# Patch: Guard read-baseline refresh (+ reverted recovery ceilings)

From the DeepSeek Harness (dsh) comparison audit. Two of the four original
patches were REVERTED by owner directive — see "Reverted" below.

## Fixed

1. **Guard read-baseline refresh** — `workspaceChangeGuard.cjs`
   `afterMutation` now records the post-mutation hash in BOTH `agentChanges`
   AND the read baseline. Previously the agent's own patch tripped
   `changedAfterRead` on the next mutation of the same path, forcing a
   pointless refused → re-read → patch cycle (the main many-tool-calls-before-
   one-patch driver). dsh's one-sentence rule — "unless you just created or
   edited it in this session" — achieved without weakening anything: a
   foreign change after the mutation still mismatches both maps.
2. **Reasoning replay tunable** — `ollamaProvider.cjs` prior-decision
   reasoning tail is env-tunable via `BROWSER_USE_REASONING_REPLAY_CHARS`
   (100–8000). Default stays 300 ON PURPOSE: a fuller replay caused the
   documented over-thinking spiral (see comment in code). Knob, not a
   behavior change.

## Reverted (owner directive, 2026-10-07)

1. **Recovery loop ceiling (`LORDE_RECOVERY_CEILING`)** — REMOVED. The owner
   had deliberately made recovery cycles indefinite to keep runs going
   without inspection; the ceiling turned a repeating `observation_timeout`
   into "The run was stopped after 5 consecutive identical recoveries" —
   exactly the blocker the indefinite design was meant to prevent.
   `scheduleRecovery` is back to diagnostic-only fingerprint tracking.
2. **Stall heartbeat exhaustion** — REMOVED. Heartbeat fires only end the
   current step so recovery re-grounds; they never terminate a run.

The continuity test fixture repair STAYS: the plan-only fixture now closes
its plan (one skipped-item decision) before submitting done, so the test
passes under the indefinite-recovery design without any ceiling.

## Not changed (deliberate)

- Recovery cycling: indefinite by design — do not re-add termination.
- Reply-style masking: moving the plain-language transform to the render
  layer is a bigger refactor, deferred.
- Truncation → spill-with-locator (dsh style): deferred.
- Effort tiering opt-in / de-escalation: deferred.

## Verification

- `node --test tests/workspace-change-guard.test.mjs` — 3/3 pass (incl. new
  regression test: patch → patch needs no re-read; foreign change still
  protected).
- `node --test tests/agent-continuity-regressions.test.mjs` — 20/20 pass
  (without any ceiling).
- `node --check` clean on both edited .cjs files.
