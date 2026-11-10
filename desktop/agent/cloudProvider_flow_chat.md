# Browser Use Cloud provider flowchart

## Purpose

Map the remote Browser Use run lifecycle, long polling, cancellation, progress, and terminal results used by Desktop agent chat.

## Current flow before repair

```text
+----------------------+
| Desktop agent turn   |
+----------+-----------+
           |
           v
+----------------------+
| Create remote run    |
+----------+-----------+
           |
           v
+----------------------+
| Poll every 2 seconds |
+----+------------+----+
     |            |
     | 120s       | terminal
     v            v
+----------+   +------------------+
| Cancel   |   | Fetch full result|
+----------+   +------------------+
```

```mermaid
graph TD
  A[Desktop agent turn] --> B[Create remote run]
  B --> C[Poll status]
  C -->|completed failed cancelled| D[Fetch full result]
  C -->|local 120 second deadline| E[Cancel remote run]
  C -->|Stop signal| E
```

## Repair contract

```text
+---------------------------+
| Create remote run         |
+-------------+-------------+
              |
              v
+---------------------------+
| SDK-compatible long wait  |
| - configurable deadline   |
| - progress heartbeat      |
| - abort-aware polling     |
+------+------+-------------+
       |      |
       |      +----------------------+
       v                             v
+--------------------+       +------------------+
| Terminal run state |       | Explicit Stop    |
| fetch once         |       | cancel remotely  |
+--------------------+       +------------------+
```

```mermaid
graph TD
  A[Create remote run] --> B[Long-running poll loop]
  B --> C[Emit progress heartbeat]
  C --> D{Abort requested?}
  D -->|Yes| E[Cancel remote run]
  D -->|No| F{Terminal status?}
  F -->|No| B
  F -->|Yes| G[Fetch full run once]
  G --> H{Status completed?}
  H -->|Yes| I[Return remote result]
  H -->|No| J[Return honest failure]
```

The remote poll limit defaults to the installed SDK long-run contract, and every successful status poll resets the local agent's dead-air deadline. The local absolute deadline exceeds the cloud deadline. Explicit Stop cancels the remote run; a real deadline reports a failed result without pretending it completed.
