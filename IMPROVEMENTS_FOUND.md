# Improvements found in `browser-use-dsh-fork`

Analysed 2026-11-14 against `C:/Users/london/Desktop/browser-use/browser-use` **after** syncing it to
the Git version (`uganda-art-pulse/tools/browser-use`).

- Desktop tree: 3,670 files (excl. `.git`, `node_modules`)
- Fork: 5,280 files
- 140 paths differ; the fork adds a complete `desktop/agent/harness/` module, a prompt-section
  registry, 12+ new test suites, dev-session tooling and three design documents
  (`HARNESS_REWRITE.md`, `HANDOFF.md`, `LOOP_BLOAT_AUDIT.md`).

## 0. Sync performed first

Four source files were taken from the Git version (backup at
`Desktop/browser-use/sync-backup-20261114-093156/`):

| File | Git version brings |
|---|---|
| `.gitignore` | ignores `.env*`, `daemon/daemon.env`, `.claude/settings.local.json`, `cli-runs/`, `logs/`, `output/` |
| `package.json` | `"files"` packaging whitelist (cli, desktop, extension, exe-wrapper, laya-server, scripts, src, docs, electron-builder.yml); removes UTF-8 BOM. Same version 0.3.6 |
| `desktop/agent/skillsManager.cjs` | comment clarified (header-only skills were unnamed/unmatchable) |
| `scripts/verify-desktop-fixes.mjs` | quote normalisation only |

`cli/tui/.history` is the only remaining difference — a shell history artifact, intentionally left.

---

## 1. New harness architecture — `desktop/agent/harness/` (10 modules, ~1,100 lines)

The fork replaces nine overlapping control layers in `desktopChatAgent.cjs` with **one owner per
concern**, copied from the DeepSeek Harness pattern:

| Module | Lines | Responsibility |
|---|---|---|
| `promptRegistry.cjs` | 125 | System prompt = **registry of named, ordered sections**. No monolithic template. Empty sections vanish, non-empty join with `\n\n`, `{{variable}}` interpolation is **strict** (unknown/undefined throws instead of silently rendering `undefined`) |
| `identity.cjs` | 30 | Fixed identity line (`You are an AI agent powered by the Browser-use harness.`) always first; deployment persona is a **prefix/suffix pair** under reserved section names, so scoped registrations shadow by name instead of duplicating text |
| `runtimeContext.cjs` | 60 | Volatile facts (tab, URL, control mode, effort, deadlines) **never enter the cached system prompt** — they ride an ordered snapshot delivered as a user message whose header says it supersedes earlier snapshots, emitted only when the text changed |
| `inbox.cjs` | 71 | Two queues drive the loop: `next-turn` (queued prompts, one per turn) and `next-step` (steering, claimed at step boundaries); duplicate ids rejected, every mutation logged as a durable run event |
| `loopPolicy.cjs` | 161 | **One** owner for recovery, retry, backoff, effort and undecidable output — replaces stall heartbeat + decision watchdog + park/escalate + `scheduleRecovery` fingerprints + flow-control scoring |
| `pipeline.cjs` | 82 | Fixed tool order: call logged → approval → advisory guards → timeout wrapper → tool body → normalise → post-execute advisory |
| `guards.cjs` | 102 | Guards are **advisory only** and always *sourced*; the only hard deny left is the approval gate. Canonicalised arguments (deep key-sort) make repeat-tool detection deterministic |
| `flowGuard.cjs` | 361 | Decision-level enforcement that turns the pure flow state machine into sourced harness actions (evidence epochs, novelty scoring, phases, notice cooldowns) |
| `toolSchema.cjs` | 92 | One DSL for tools; the model-visible projection is exactly `{name, description, parameters}` — runtime metadata (timeouts, executors, presenters) never leaks into the prompt |
| `errors.cjs` | 59 | Every boundary failure is a structured value with a stable code (`TOOL_TIMEOUT`, `UNKNOWN_TOOL`, …); raw exceptions never reach the model |

Supporting files: `desktop/agent/prompt/sections.cjs` (the ordered section table) and
`desktop/agent/agentInternals.cjs`.

**Effect on the agent:** `desktop/agent/desktopChatAgent.cjs` went from **7,797 → ~3,200 lines**
(`+3,207 / −7,797`): the 1,350-line `recoveryLoop` monolith, the two parallel watchdogs, the
park/escalate layer and the fingerprint machinery are gone.

## 2. Prompt diet — measured, not claimed (`LOOP_BLOAT_AUDIT.md`)

| Surface | Before | After | Reference harness |
|---|---|---|---|
| System prompt (agi) | 10,865 chars | **1,990** | 1,776 |
| System prompt (browser) | ~6,900 | **1,532** | 1,776 |
| Largest single prompt block | 4,466 | **456** | 434 |
| Identity text | ~999 (inside persona) | **55** | 48 |
| Prompt blocks | 9 dense | **10 sparse** | 10 |
| Tool descriptions total | ~29,405 | **18,457** | — |
| Largest tool description | 1,596 | **831** | — |

## 3. Click / pointer correctness (session-4 fixes, `HANDOFF.md`)

- **Truthful click reply.** `clickAt` sequences on *delivery truth*: `pointer.deliveryFallback`
  means the native event crossed, so only a superseded/cancelled operation vetoes a stage — a
  fallback-delivered press now pairs its release instead of stranding a held button. The final reply
  projects the last healthy visual stage with `committed: true`; a visual failure surfaces only as
  informational `visualInterrupted`.
- **DPR screenshot mapping fixed (two bugs).** The screenshot branch fired only when the model
  labelled `coordinateSpace:"screenshot"` (models mislabel image pixels as "viewport"), and it
  **multiplied** by `scaleX/scaleY` — the CSS→image direction — pushing clicks further off target.
  The capture scale is image/CSS, so image→CSS must **divide**: lichess `(286,579)` → `(229,463)`.
  A `screenshotId` now selects the screenshot frame regardless of the label, and a stale/unmatched/
  scale-less id is rejected with a recovery message instead of silently assuming 1:1.
- **Coordinate-pair detection.** `hasCoordinatePair` treats `element` plus a schema-default `(0,0)`
  as the index path (fixes the lichess `{"element":6,"x":0,"y":0}` → wrong-label bug).
- **Release safety.** `releaseTabPointerButtons` skips cancelling during `prepareNativeInput`'s own
  re-layout.

## 4. Browser view controller rework

`desktop/mcp/browserViewController.cjs` **+2,635 / −2,092**: native input dispatch
(`sendInputEvent`), the app-owned pointer visualiser boundary (native input and visualisation share
one controller), and bounded DOM-snapshot evaluation for grounding.

## 5. New tests (12+ suites)

`browser-screenshot-coordinates` (new, 7/7), `chat-copy-feedback`, `chat-timeline-hover`,
`click-order-game`, `computer-resume`, `desktop-drag-element`, `dev-resume-card`, `dev-resume-e2e`,
`dev-resume-session`, `drag-relay-game`, `native-dialog-demand`, `objective-questionnaire`.

Existing suites were re-pinned and extended: agent-pointer-controller **30/30** (was 28),
enforcement-gen2 **15/15** (was 14), desktop-input-release 13/13, input-drag 3/3,
computer-patch 34/34, prompt-compression-safety 6/6, desktop-thinking-hygiene 13/13.

## 6. Developer tooling and UX

- `desktop/devSession.cjs`, `desktop/devRestart.cjs`, `desktop/devResumeCard.cjs` — durable dev
  sessions with a resume card, plus unit and end-to-end tests.
- Renderer work: chat copy feedback, timeline hover states, objective questionnaire, native dialog
  demand (`desktop/renderer/app.js`, `chat-reference.css`, `index.html`).
- Audit/measurement scripts kept in the fork: `_dsh_inventory.cjs`, `_fork_prompt_breakdown.cjs`,
  `_wire_breakdown.cjs`, `_sweep*.cjs`, `_orphans.cjs`, `_lostcheck.cjs`.

## 7. Accuracy notes and caveats

- `desktop/main.cjs` shows **+6,180 / −5,979** in a naive diff, but that is the mixed-EOL/BOM
  whole-file flip documented in `HANDOFF.md`. Ignoring CR/BOM the real change is **219 lines**.
- 7 test failures are **pre-existing and HEAD-identical** (desktop-ai-chat-agent 12/17/37/64/79/80/89);
  they are not regressions introduced by the fork.
- The fork's working tree still carries uncommitted edits (`README.md`, `desktop/agent/agentInternals.cjs`,
  `desktopChatAgent.cjs`, `ollamaProvider.cjs`, `openAiCompatibleProvider.cjs`).
- The fork is a working snapshot, not a clean branch: it also carries run logs and scratch output
  that should not be published as-is.
