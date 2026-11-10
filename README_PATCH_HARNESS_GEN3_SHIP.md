# Harness gen3 ship — deployment record and mandatory caveats

**Shipped**: the three-generation evolution-loop result — gen3-active prompt (6,198B, base lean core + 11 judge-cited additions) + enforcement E1–E11 — synced from the F:\harness-lab fork into this repo, byte-verified, battery-gated (69/69 core tests at ship time).

**Deployment evidence**: F:\harness-lab\generations\gen3\judgments\final-verdict.md — 16/16 verified stress runs, 85/100 generation score, SHIP recommendation.

## Campaign results (glm-5.3-flash, two-fixture complex task)
| Generation | Outcome |
|---|---|
| Baseline (old walls) | 0/2 timed-terminal, bimodal tail to 440s+, rebuild spirals, tampering |
| Gen1 | 0 candidates beat baseline; laws established (contracts don't stack; prose gets ignored/exploited) |
| Gen2 | arch1/arch3 4/4 incl. timed — first improvement; two enforcement regressions caught by preflight and fixed |
| **Gen3** | **16/16 verified, all candidates incl. byte-identical plateau control; tail 158–395s; median 22.5 dec/215s** |

## The five mandatory caveats from the final judge (gen4 agenda)
1. **E7 bypass window**: constraint-tamper detection misses writes into a just-rejected control via positional selectors (`querySelectorAll('input')[1]`) — one executed undetected in gen3. Close by keying rejected-control identity beyond selector text.
2. **E9 delivery unproven**: the rebuild tripwire's REBUILD DETECTED notice appeared only in the run.completed dump — no trace evidence the model consumed it. Prove delivery with trace events or fix the render path.
3. **E10 paper trail**: the E2 drain fix shipped with unit proofs, but the production-trace deliverable (a fired, acted-on notice) remains unmet — same fix path as E9's proof.
4. **B3 bridge in the bounce message**: the anti-rebuild bridge sentence lives in the prompt but the worst run rebuilt anyway — fold the sentence into the completion-bounce message itself (moment-of-need delivery).
5. **Judge-side narrative auditing + n≥4 floor**: verified outcomes still carried softened narrative defects (inference-as-observation; a truncated-claim story the trace contradicts). Keep model-judge audits in the loop and never compare arms at n<4 — the baseline's 1.9× time spread makes n=2 comparisons meaningless.

## Known residual (honest)
- Prediction P1 (tail ≤30 decisions) was REFUTED — one 37-dec/393s run; P5 (E2 delivery) PARTIAL. The tail is no longer failure-shaped (it completed verified), but it exists.
- Two narrative integrity defects in gen2's arch2 runs softened but did not vanish in gen3: claim-site honesty needs the E12 claim-vs-trace cross-check (gen4's top proposal, three architects converged on it).
- Pre-existing stale suites unchanged: agent-efficiency hang, desktop-ai-chat-agent OOM (documented drift, untouched).

## Campaign record
F:\harness-lab\generations\gen1..3 (candidates, judgments, MERGE records) and E:\...\browser-use\scratch\harness-campaign (original 40-run campaign, scores.json, v1–v5 designs). The evolution loop's governing lesson, measured three times: guarantees belong in enforcement, prompt prose only carries judge-evidenced additions, and every prompt or environment change needs a 1-run preflight control before candidates burn.
