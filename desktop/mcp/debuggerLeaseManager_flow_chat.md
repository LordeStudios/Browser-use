# Debugger lease manager flowchart

## Purpose

Serialize Chrome DevTools Protocol work per managed tab while preventing rejected operations from leaking as unhandled promises.

## Current flow before repair

```text
+------------------+
| Operation arrives|
+--------+---------+
         |
         v
+------------------+
| Chain after prior|
+--------+---------+
         |
         v
+------------------+
| Store next.finally|
+--------+---------+
         |
         +---- rejection can remain unhandled
```

```mermaid
graph TD
  A[Operation arrives] --> B[Read prior queue promise]
  B --> C[Run with debugger lease]
  C --> D[Store next.finally cleanup]
  D --> E{Operation rejects?}
  E -->|Yes| F[Unhandled stored-chain rejection]
  E -->|No| G[Queue cleaned]
```

## Repair contract

```text
+---------------------------+
| Return operation promise  |
| to requesting caller      |
+-------------+-------------+
              |
              v
+---------------------------+
| Store handled queue tail  |
| rejection becomes settled |
+-------------+-------------+
              |
              v
+---------------------------+
| Delete matching queue tail|
+---------------------------+
```

```mermaid
graph TD
  A[Operation arrives] --> B[Prior handled queue tail]
  B --> C[Operation promise]
  C --> D[Caller receives original result or error]
  C --> E[Create handled serialization tail]
  E --> F[Cleanup matching queue entry]
  F --> G[Later operation may proceed]
```

The serialized queue stores a handled promise tail. The caller still receives the original rejecting promise, while a later request can proceed after queue cleanup without a second unhandled rejection.
