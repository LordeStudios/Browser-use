# Token compression and deferred tool loading

Two techniques that reduce what every decision costs on the wire, without ever
making the input harder for a weak model to act on.

Both were built against measurements of the real request, captured with
`scripts/wire-capture.mjs` (the real `DesktopChatAgent` and provider against a
fake gateway) and reported per source by `desktop/agent/wireTokenizer.cjs`.

## The measurement that drove the design

On the real wire, one request carries:

| Part | Share of the request |
|---|---|
| Tool schemas | 57–77% |
| System prompt | 9–25% |
| Prior wire messages (history) | 7–15% |

The tool schemas dominate, and they are re-sent on **every** decision. So that
is where the work goes.

## Technique 1 — Intel's Adaptive Token Compressor (ported to Node)

`desktop/agent/adaptiveTokenCompressor.cjs`

Intel ships *Adaptive Token Compressor* (Open Edge Platform, version 2026.2,
2026-09-09) as a Python library for LLM agent pipelines. It is Python-only and
needs two services: a Lingua server for lossy text compression and an LLM
predictor for tool selection. This port keeps the **architecture and the API
shape** and runs the parts that need no service in-process:

- `createCompressor(type, config)`, `availableCompressorTypes()`,
  `configSchema(type)` — the factory construction, as in Intel's library.
- `HarnessCompressor` — section-aware compression of the prompt-assembly
  stage. Intel: "section-aware message compression using hybrid rule-based and
  LLMLingua-2 model-based compression". The rule layer runs always; the Lingua
  layer runs only when `BROWSER_USE_LINGUA_URL` points at a Lingua server.
- `ToolCompressor` — Intel's LLM-guided tool selection, with the same
  `placement` and `accumulate` options.
- `CompressionManager` — cross-compressor metrics, using Intel's metric names:
  `tokens_before`, `tokens_after`, `saved_tokens`, `compression_ratio`,
  `duration_ms`.

**What it does in this harness:** compresses the wire projection of the run
notebook (the empty sections and the template line are dropped; the file on
disk is untouched) and the system prompt.

**What it deliberately does not do:** the system prompt turned out to have no
duplicate directives at all — measured, not assumed. A sentence-level dedupe
at threshold 0.6 removed a *distinct* reply-style rule, so the threshold and a
term-safety guard were tightened. The rule layer is therefore a no-op on the
current prompt, which is the honest outcome.

## Technique 2 — Deferred tool loading

`desktop/agent/deferredToolCatalog.cjs`

Every tool stays in the catalog. Nothing is hidden, nothing is gated by the
task text, and a tool call can never fail because its schema was compacted.
The tiers are:

- **core** — full schema. The tools that carry almost every real task
  (measured over 1,273 recorded calls).
- **always-full** — full schema. The tools whose arguments are easy to get
  wrong from a name alone.
- **compact** — the tool's name, its one-line description, and **every
  argument name and type**. The long prose (per-field explanations, examples,
  enums) is dropped; the structure is not.
- **promoted** — a compacted tool whose full schema the model asked for with
  `tool_schema`. Promotion is monotonic (Intel's `accumulate=True` rule), so
  the tool keeps its full schema for the rest of the run and the cached prompt
  prefix stays stable.

The compact schema is derived from the **same** `toolInputSchema()` function
the full schema uses, so a field's type can never differ between the two
forms. `additionalProperties` is left out of the compact form: in JSON Schema
an absent flag means `true`, which is what we want — an unknown argument must
reach the harness, which rejects it with a precise, actionable error, rather
than being refused by the provider with no explanation.

### `tool_schema`

A model-chosen tool that returns one tool's full schema:

```
tool_schema(name="computer_stroke")
```

It also promotes the tool. When a compacted tool is called with wrong
arguments, the harness's invalid-input error now names `tool_schema` as the
way to get the full contract, instead of leaving the model to guess again.

## Measured effect

Tool schemas on the wire (real tool catalog, measured with
`wireTokenizer.cjs`):

| Mode | Before | After | Saved |
|---|---|---|---|
| browser (47 tools) | 5,655 | 4,734 | 16% |
| agi (64 tools) | 9,621 | 7,925 | 18% |

Whole request, all four parts (the system prompt, the history, the tools and
the current context):

| Capture | Before | After | Saved |
|---|---|---|---|
| `hello` | 7,308 | 6,269 | 14% |
| `complex-agi` | 11,791 | 10,413 | 12% |
| `followup-after-focus-message` | 13,887 | 12,285 | 12% |

The run notebook projection shrank from 1,597 to 1,279 characters (the seven
empty sections and the template line are gone), and it is re-sent on every
decision.

The `tool_schema` tool itself costs about 50 tokens on every request. That is
the price of the mechanism that makes the rest safe, and it is worth it
against ~900 tokens saved.

## Tests

`tests/token-compression.test.mjs` — 18 tests. The ones that matter most:

- no tool is ever hidden (the catalog carries every tool the run offers);
- the catalog adds no task-dependent gating of its own;
- a compacted schema is **structurally identical** to the full schema;
- a compacted tool still declares every argument with its real type;
- the full schema is available on request for every tool;
- promotion is monotonic and changes no tool's membership;
- the harness never drops a rule that names its own terms;
- a notebook section that gains content comes back in full.

`tests/wire-input-hygiene.test.mjs` — the earlier wire fixes (playbook gating,
agent messages, lease notices, per-turn usage).

## Configuration

- `BROWSER_USE_LINGUA_URL` — a Lingua server for the optional lossy
  compression pass. Unset by default: the rule layer is lossless.
