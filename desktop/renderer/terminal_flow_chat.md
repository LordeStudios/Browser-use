# Terminal presentation and theme flow

The shell belongs to the existing terminal broker. Theme changes affect only
xterm presentation, never session creation, attachment, input, or shutdown.

```text
+-----------------------+
| Dock or detached view |
+-----------+-----------+
            v
+-----------------------+
| Load chrome-theme.css |
| Read computed tokens  |
+-----------+-----------+
            v
+-----------------------+
| Create themed xterm   |
| Preserve ANSI colours |
+-----------+-----------+
            v
+-----------------------+
| Adopt broker session  |
| Stream output/input   |
+-----------------------+
```

```mermaid
graph TD
 A[Dock or detached terminal opens] --> B[Read shared computed CSS theme roles]
 B --> C[Create xterm with canvas text cursor selection and ANSI colours]
 C --> D[Adopt or create main-owned broker session]
 D --> E[Stream terminal data and input]
 E --> F{Presentation moves?}
 F -->|Yes| G[Release presentation only and adopt same session]
 G --> B
 F -->|No| E
```
