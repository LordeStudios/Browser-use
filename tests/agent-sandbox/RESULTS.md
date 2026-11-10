# Real-provider sandbox campaign results (2026-09-11)

Model: `z-ai/glm-5.3-flash` via existing xKiro endpoint. Protocol: Responses (opt-in continuity adapter). All decisions model-generated; no scripted provider. Evidence dirs: `I:/bu-sandbox-*`; local-only Braintrust summary: `I:/browser-use-braintrust-local-summary.json` (13 retained runs: 92.31% objective pass, 73.57% mean efficiency, 100% compliance).

## Dev frontier (level 3, maximum defined)

| Family | Seed | Result | Efficiency | Elapsed | Calls / Requests |
|---|---|---|---|---|---|
| reconcile | 41 | PASS | 85.0 | 63.9s | 11 / 6 |
| repair | 43 | PASS | 80.0 | 115.1s | 18 / 10 (5 batched changes) |
| visual | 47 | PASS | 75.7 | 221.4s | 20 / 11 (7 batched changes) |

## Holdout validation (level 3, untouched seeds)

| Family | Seed | Result | Efficiency | Elapsed | Calls / Requests |
|---|---|---|---|---|---|
| reconcile | 59 | PASS | 83.0 | 72.5s | 15 / 7 |
| repair | 61 | PASS | 93.3 | 81.4s | 16 / 8 (4 batched changes) |
| visual | 67 | PASS | 87.2 | 219.4s | 12 / 8 (7 batched changes) |

Baseline (before fixes), same harness: reconcile L1 56.0 → 80.8; repair L1 37.2 → 60.5; visual L1 failed deadline → passes.

## Changes that produced the gains (one at a time, measured)

1. **Responses conversation-continuity adapter** (`desktop/agent/responsesProvider.cjs`, opt-in via `protocol:'responses'`): retains native assistant output items and call IDs; results matched by call ID; clipped calls replayed as explicitly not-executed. Verified against the real endpoint and by unit tests.
2. **Plan-batching instruction**: no plan-only decisions; `update_plan` rides with grounded actions. Repair L1 130s → 73s.
3. **Sandbox modal fidelity**: clicks blocked by the orientation dialog now report their true no-op effect instead of pretending success; stroke rejections name the exact blocking condition.
4. **Evidence-gated completion review**: a `browser_done` with `verified:true` settles immediately only when every recorded mutation's effect was observed and no plan item is open; anything less still bounces.
5. **Batched-mutation settlement fix** (real coordinator bug found by the campaign): previously only the last mutation of a batch was ever settled, leaving earlier batch members permanently unverified in the completed-work ledger. All pending mutations now settle against the next observation (changed → confirmed; unchanged → removed as unproven).

## Real-app verification after the sandbox goal

- `tests/computer-tools-e2e.mjs`: all 8 PASS lines (native strokes/mapping, lifecycle screenshot→changed window→wait→current evidence, recording playback, chat integration, scope downgrade). Evidence `I:/bu-computer-e2e-GX0EjY`.
- `tests/progress-ui-e2e.mjs`: PASS (goal/task strip, animation, 320px).
- `tests/desktop-interaction-e2e.mjs`: PASS.
- `tests/desktop-ai-chat-agent.test.mjs`: 100/107; the 7 failures are the documented pre-existing hard-duplicate-block expectation set (intended advisory-duplicate behavior), unchanged by this campaign.

## Limits

Efficiency scores are benchmark-relative (frozen budgets); a 100 score is not claimed. Visual passing required a 330s harness deadline for this flash model (its ~20-28s per decision is inherent); the 90-150s scoring budgets still penalize that honestly. Scores do not transfer to other models without re-running the campaign. Croner heartbeat: session-only.
