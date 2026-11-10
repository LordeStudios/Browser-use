# Real provider continuity probe

Diagnostic only, not a drawing acceptance test. Uses the user's existing xKiro endpoint/credential and exact selected Astra model. No simulated provider, fake tool result, scripted artwork, GUI mutation or automatic approval. Native observations are actual read-only tool results. Secrets never enter logs.

```text
+-----------------------------+
| Existing endpoint + model   |
| No credential values logged |
+--------------+--------------+
               v
+-----------------------------+
| Probe actual API capability |
| Stateless, no mutation tools|
+--------------+--------------+
               v
+-----------------------------+
| Record protocol shape only  |
| IDs, statuses, usage, time  |
+--------------+--------------+
               v
+-----------------------------+
| If supported: real read-only|
| native observation exchange |
| preserve native tool turns  |
+--------------+--------------+
               v
+-----------------------------+
| Diagnose continuity limits  |
| NOT a portrait-quality pass |
+-----------------------------+
```

```mermaid
graph TD
  A[Existing xKiro configuration] --> B[Actual selected model request]
  B --> C{Protocol supported?}
  C -->|No| D[Record exact nonsecret API error; do not assume support]
  C -->|Yes| E[Inspect response shape and usage]
  E --> F[Actual read-only computer observation if requested]
  F --> G[Return real result with native call identity]
  G --> H[Next actual model request with retained turn data]
  H --> I[Report measured exchange, not GUI-task success]
```

All output is local. First capability probe uses no tools. Subsequent diagnostic work can expose only read-only desktop inspection, never pointer/keyboard/shell/file writes. A live visual mutation benchmark still requires separately authorized execution and protection of the user's existing documents. No permission-denial workaround is part of this probe.
