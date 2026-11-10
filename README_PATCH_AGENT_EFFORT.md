# Patch: Agent Reasoning Effort Ladder (Auto / Minimal / Standard / Advanced)

## Goal
The chat agent reasoned at max depth on every decision, which is wrong for a
tool built for fast back-and-forth tasks. The mode/permissions pill now has an
**Effort** section. Default **Auto**: the run starts at minimal reasoning and
only escalates when the task proves it needs more. **Advanced** is byte-for-byte
the previous behavior.

## Tiers
| Tier | Behavior |
|---|---|
| Auto (default) | Starts every run at minimal. Model may request one tier more with `effortNeeded`+`effortReason` (reason REQUIRED; `advanced` additionally requires a prior objective need signal). Harness safety net: 2 consecutive recoveries at minimal → standard, 4 at standard → advanced. One rung per step, never downward mid-run, never a random pick. |
| Minimal | Direct and very quick. Ollama: `think:false` + 1,536-token decision budget. OpenAI-compatible: `reasoning_effort:"low"`. Responses: `reasoning.effort:"low"`. Anthropic: extended thinking omitted. |
| Standard | Brief reasoning, ~2x faster than Advanced. Budgets 2,048 / `reasoning_effort:"medium"` / `effort:"medium"`. |
| Advanced | Unchanged requests (4,096 budget, no effort fields) — previous default. |

## Files changed
- `desktop/agent/desktopChatAgent.cjs` — EFFORT_TIERS + pure policy helpers (`normalizeEffortSetting`, `applyEffortEscalation`, `nextEffortTier`), `settings.effort` normalization, per-run `effortTier`/`effortTierRecoveries`/`effortNeedSignals` (auto restarts at minimal), model-request clamp after each decision, harness escalation in `scheduleRecovery`, tier threaded into every `provider.complete`.
- `desktop/agent/ollamaProvider.cjs` — tier-mapped `think`/`num_predict`/system-prompt lines; auto escalation-channel instructions (`effortNeeded`).
- `desktop/agent/openAiCompatibleProvider.cjs` — `reasoning_effort` (OpenAI-style), Anthropic thinking omission at minimal, prompt lines.
- `desktop/agent/responsesProvider.cjs` — `reasoning.effort` mapping.
- `desktop/main.cjs` — `agentEffort` setting (default `auto`, normalized on save) + per-run `settings.effort`.
- `desktop/renderer/index.html` — Effort section in the pill menu + hidden `#agent-effort` select + pill label.
- `desktop/renderer/app.js` — effort select wiring, pill sync, persistence via `saveSettings({agentEffort})`, per-run start payload.
- `desktop/renderer/chat-reference.css` — dim effort label in the pill.
- `desktop/agent/efficiency_flow_chat.md` — effort ladder flowchart + invariants.
- `tests/desktop-openai-compatible-provider.test.mjs` — stale wait-wording assertion updated (pre-existing red from the adaptive-wait patch).

## How to test
- `node --test tests/agent-effort.test.mjs` — policy matrix + all three provider protocol mappings (8 tests).
- Full affected set: `node --test tests/agent-effort.test.mjs tests/desktop-ollama-provider.test.mjs tests/desktop-openai-compatible-provider.test.mjs tests/responses-continuity.test.mjs tests/agent-efficiency.test.mjs tests/desktop-ai-chat-agent.test.mjs tests/output-budget.test.mjs tests/progress-state.test.mjs` — 157/157 PASS.
- UI: open the agent drawer → mode/permissions pill → new Effort section (Auto checked by default, pill shows "Browser · Auto · badge").

## Known limits
- Auto escalation to Advanced requires recovery evidence; a task that is
  genuinely hard on the first pass relies on the model's justified
  standard-request (which is always available).
- OpenAI-compatible relays that reject unknown params would 400 on
  `reasoning_effort` at minimal/standard (most ignore extras); pick Advanced
  there if seen.

## Next
- Live acceptance: run one back-and-forth task on Auto (Kimi K2.7 via Ollama)
  and confirm minimal-tier latency; watch `effortNeeded` escalations in the
  thinking card on a genuinely complex task.
