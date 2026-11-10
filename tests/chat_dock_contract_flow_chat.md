# Chat dock contract test flow

```text
+----------------------------+
| Read renderer/main sources |
+-------------+--------------+
              v
+----------------------------+
| Assert one live geometry   |
| channel and rAF coalescing |
+-------------+--------------+
              v
+----------------------------+
| Assert sender-bound close  |
| cannot target another chat |
+-------------+--------------+
              v
+----------------------------+
| Assert no resize reattach  |
| churn and final publish    |
+----------------------------+
              v
+----------------------------+
| Pass or report contract    |
| regression                 |
+----------------------------+
```

```mermaid
graph TD
  A[Read chat source files] --> B[Check geometry notification contract]
  B --> C[Check requestAnimationFrame resize coalescing]
  C --> D[Check sender-owned close routing]
  D --> E[Check in-place bounds and no drag reattach]
  E --> F[Node assertions pass]
```
