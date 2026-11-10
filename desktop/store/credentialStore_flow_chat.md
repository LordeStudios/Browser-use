# Credential Store Flowchart

```text
+------------------+
| Settings request |
+--------+---------+
         v
+-----------------------+
| safeStorage available?|
+---+---------------+---+
    | yes           | no
    v               v
+--------+    +----------------+
| Encrypt |    | Report unavailable |
+---+----+    +----------------+
    v
+----------------------+
| Atomic encrypted file|
+----------------------+
```

```mermaid
graph TD
 A[Credential update] --> B{safeStorage available?}
 B -->|yes| C[Encrypt secret]
 C --> D[Atomically persist encrypted blob]
 D --> E[Return masked credential status]
 B -->|no| F[Reject persistent storage]
 F --> G[Keep no plaintext fallback]
```

Secrets never enter public settings or renderer state.
