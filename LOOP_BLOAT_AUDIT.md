# Loop-bloat audit — this fork vs DeepSeek Harness

Measured 2026-11-11. DSH reference: `C:/Users/london/Desktop/deepseek/deepseek-harness`
(`@deepseek-ai/dsh-system-prompt` + per-tool sections). Fork: this repo at `f0d430b`.

Tools: `_dsh_inventory.cjs` (walks the DSH repo, measures every section text, tool
description and guidance constant) and `_fork_prompt_breakdown.cjs` (renders this fork's
real system prompt and measures every block). Wire captures from the real sensenova run
(`scratch/dsh-verify/wire003`) give the per-decision numbers.

## 0. RESULT (executed 2026-11-11)

The cut in section 5 was applied. Measured after execution:

| Surface | Before | After | Reference harness |
|---|---|---|---|
| System prompt (agi) | 10,865 chars | **1,990** | 1,776 |
| System prompt (browser) | ~6,900 | **1,532** | 1,776 |
| Largest prompt block | 4,466 | **456** | 434 |
| Identity | ~999 in persona | **55** | 48 |
| Prompt blocks | 9 dense | **10 sparse** | 10 |
| Tool description total (agi catalog) | ~29,405 | **18,457** | 228k across its whole catalog |
| Largest tool description | 1,596 (model_catalog) | **831** | n/a |

Moved out of the prompt, into the surface that owns them:
- modeling/drawing playbooks -> `computer_pointer` / `computer_stroke` schemas,
  attached app-conditionally by live observation (`attachCreativePlaybooks`)
- the planning rule -> `update_plan` schema
- batching -> `browser_execute` schema already carried it; prompt copy deleted
- per-tool coding detail -> `computer_patch` / `computer_search` / `computer_git` schemas

Real-run proof (sensenova over xkiro): completed, 3 decisions / 3 tool calls / 24 s,
correct answer; wire system prompt 2,349 = 1,990 harness + 359 per-request effort
protocol. MCP bridge untouched byte-for-byte (`git diff desktop/mcp/` is empty) and
still serves its 31 browser_* tools to external agents.

Zero reference-harness identity remains in the program: 124 mentions reduced to 6,
all of which are the "DeepSeek" LLM **provider option** in the settings UI (a vendor
choice alongside OpenAI/Anthropic, not harness identity).

## 1. Headline numbers

| Instruction surface | DSH | This fork | Ratio |
|---|---|---|---|
| **System-prompt prose** (all sections) | **1,776 chars** (10 sections) | **10,865 chars** (agi/standard/unattended) | **6.1×** |
| Largest single section | 434 chars (`tool:ralph`) | 4,466 chars (COMPUTER/CODING block) | 10.3× |
| Identity line | 48 chars — "You are an AI agent powered by DeepSeek Harness." | ~250 chars + REPLY STYLE (~700) | — |
| Per-decision context (recurring) | ~120–330 chars (approval = ONE sentence; subagent delegation = 4 sentences) | 1,854–4,746 chars (`notebook` 1,196 + `taskLadder` 430 + task + evidence block) | ~6–14× |
| Tool schema (per decision) | active composition only | 49–66 tools, 29–49k chars JSON | — |
| Repair-turn directive | none (provider retries) | 266 chars (`REPAIR_POLICY`, one-shot) | n/a |

DSH's whole system prompt, quoted in full (7 real sections):

- `harness:identity` (48): *"You are an AI agent powered by DeepSeek Harness."*
- `tool:bash` (92) / `tool:pwsh` (96): *"Check the [exit code: N] marker on every bash result; investigate failures before moving on."*
- `tool:pty` (308): persistent-terminal caveat — 3 sentences.
- `tool:jobs` (383): track job ids, don't busy-poll, collect before answering — 3 sentences.
- `tool:workflow` (328) / `tool:ralph` (434): "ONLY when the user explicitly asks…" — 2 sentences.

That is the entire behavioural prose DSH ships. There is **no** evidence policy, batching
policy, failure policy, completion policy, reply-style block, or anti-restate block. DSH's
`plan:policy` is **deployment-owned and mode-conditional** — the harness ships none.

## 2. Item-by-item verdicts (fork blocks vs DSH)

| # | Fork block | Chars | DSH counterpart | Verdict |
|---|---|---|---|---|
| 1 | `PERSONA_PREFIX` — identity + output discipline + anti-restate | ~900 | identity = 1 sentence; repeat behaviour enforced by `packages/guard/repeat-tool-reminder` (1 sentence) | **TRIM to ~2 sentences.** The restored RepeatCallGuard + keyed stall now enforce this structurally. |
| 2 | REPLY STYLE (inside persona) | ~700 | none — DSH leaves voice to the deployment persona | **BLOAT (product choice).** Move to the deployment persona slot; out of the harness. |
| 3 | `PLAN_POLICY` | 513 | `plan:policy` — deployment-owned, rendered **only while plan mode is active** | **MAKE CONDITIONAL.** Ours rides every decision, DSH's exists only in plan mode. |
| 4 | `EVIDENCE_POLICY` | 1,389 | **none** | **TRIM to ~2 sentences.** The no-re-read rule is now enforced by the evidence epoch + RepeatCallGuard + read-only cap (restored this session). The rest re-explains what the loop already does. |
| 5 | `BATCHING_POLICY` | 390 | none — batching is taught in argument descriptions | **CUT.** Redundant with tool schemas. |
| 6 | `FAILURE_POLICY` | 476 | 92 chars — "Check the [exit code: N] marker… investigate failures" | **TRIM to the DSH sentence.** |
| 7 | `COMPLETION_POLICY` | 1,151 | none — deliverable file references is the nearest thing | **TRIM to ~2 sentences.** The completion review + requirement ledger now enforce reconciliation; the browser_done schema already states the contract. |
| 8 | `TOOLS_CATALOG_NOTE` (deferred catalog) | 455 | none — DSH registers full schemas, no deferral | **KEEP (mechanism), shorten.** Or serve full schemas like DSH and drop the section. |
| 9 | COMPUTER/CODING WORKFLOW block | **4,466** | computer-use package: minimal; DSH puts guidance in the tool's own section | **BIGGEST BLOCK.** Test-pinned (agent-coding-gating, wire-input-hygiene). Move the per-tool parts into tool descriptions (schema-related) and keep only the coding workflow as one paragraph. |
| 10 | `REPAIR_POLICY` | 266 | none | **KEEP** — one-shot, only on the repair turn. |
| 11 | MODELING / DRAWING playbooks | 1,664 / 1,866 | n/a (no native-desktop modeling in DSH) | **KEEP** — app-conditional, only ride when the app is actually open. |
| 12 | `notebook` wire block, **every decision** | 1,196 | none — DSH uses workspace files | **TRIM to a pointer** (path + "call notebook op=read"); the tool already describes the rest. |
| 13 | `taskLadder`, every decision | 430 | `tool:goal` section (2 sentences) | **KEEP** — it is state, not prose. |
| 14 | Recovery demands / harness notices | 200–500 each, one-shot | `repeat-tool-reminder` = 1 sentence | **TRIM the wordiest**; one-shot so low priority. |

## 3. Where the money is

System prompt, agi mode, 10,865 chars:

- 4,466 COMPUTER/CODING block → ~1,200 if per-tool parts move into tool descriptions (**−3,266**)
- 1,389 EVIDENCE_POLICY → ~300 (**−1,089**)
- 1,614 PERSONA_PREFIX (incl. REPLY STYLE) → ~500 (**−1,114**)
- 1,151 COMPLETION_POLICY → ~300 (**−851**)
- 476 FAILURE_POLICY → ~100 (**−376**)
- 513 PLAN_POLICY → conditional or ~200 (**−313**)
- 390 BATCHING_POLICY → 0 (**−390**)
- 455 TOOLS_CATALOG_NOTE → ~200 (**−255**)

**Realistic result: ~10,865 → ~4,300 chars (−60%), which is still 2.4× DSH** — the residue
being the coding workflow and the honest-blocked contract that a browser/desktop agent
needs and DSH (a coding harness) does not.

Recurring per-decision: `notebook` 1,196 → ~150 as a pointer (**−1,046 per decision**),
which across a 30-decision run is **~31k chars** — more than the entire system prompt.

## 4. Why cutting is safe now (and was not before)

The original loop needed the prose because nothing enforced the behaviour. This session
restored the enforcement stages that make the prose redundant:

- no-re-read → evidence epoch + `FlowGuard` novelty scoring + RepeatCallGuard
- stop-researching-start-acting → evidence-phase checkpoints + read-only cap (hard floor)
- don't-restate → keyed actionless stall + streaming-stall detector
- over-deliberation → thinking-budget gate + shared stall ladder
- completion reconciliation → completion review + requirement ledger (E4/F1/F2)

**Trade-off to accept:** four suites pin this prose (`prompt-compression-safety`,
`agent-coding-gating`, `desktop-openai-compatible-provider`, `wire-input-hygiene` — the
latter uses its own synthetic text). Cutting means re-pinning those assertions to the
reduced surface, the same legitimate re-pin this repo already did for the badge and
prompt-source moves.

## 5. Also check: why the loop *feels* unchanged

Prose is not the only lever. If the run you watched still re-read and re-narrated, check
that the decision you watched actually carried the restored machinery — `final-state.json`
→ `state.flowControl` (epoch advancing), `evidenceOnlyStreak`, `readOnlyDecisionStreak`,
and `harness.notice.delivered` events in `trace.jsonl`. In the verified sensenova run those
were live; an *installed Nov 7 build* shows the old loop by definition.

## 6. Reproduce

```bash
node _dsh_inventory.cjs                      # DSH surface (reads the DSH repo)
node _fork_prompt_breakdown.cjs              # fork surface, per block
node _wire_breakdown.cjs scratch/dsh-verify/wire003   # real wire payload
```
