# Browser-use compact settings and chrome flowchart

## Purpose

The desktop shell keeps settings, downloads, console, terminal, and device controls
compact and visible above the managed BrowserView. MCP pairing remains secure and
agent copy produces ordinary prompt text with short-lived bootstrap guidance.

```text
+--------------------+
| Open settings      |
+---------+----------+
          v
+---------------------------+
| Compact section run       |
| MCP | GPT Actions | Dev   |
+----+----------+-----------+
     |          |
     v          v
+---------+  +----------------+
| MCP row |  | GPT row        |
| mode    |  | enabled/origin |
+----+----+  +-------+--------+
     |               |
     v               v
+----------------+  +----------------+
| Copy connection|  | Save settings |
| creates offer  |  | validate       |
| copies prompt  |  | refresh status |
+----------------+  +----------------+

+--------------------+       +----------------------+
| Toolbar action     | ----> | Overlay BrowserView |
| downloads/console  |       | topmost and themed  |
| device/terminal    |       +----------+-----------+
+--------------------+                  |
                                        v
                         +----------------------------+
                         | Render real state fields   |
                         | level, source, time, tab,  |
                         | URL, line, message        |
                         +----------------------------+

The single title row keeps File, Edit, View, Window first and the app icon/name
centered without overlap. A dedicated bordered tab row remains below it, followed
by the navigation toolbar. Tab and native view geometry use the same chrome height.
Rotate remains available for Desktop and swaps the stage orientation without
turning on mobile touch emulation.
```

```mermaid
graph TD
  A[Single title row] --> A2[Dedicated bordered tab row]
  A2 --> B[Navigation toolbar action]
  B --> C{Surface}
  C -->|Settings| D[Open compact settings overlay]
  C -->|Downloads| E[Open overlay downloads panel]
  C -->|Console| F[Open overlay console fields]
  C -->|Terminal| G[Open themed terminal dock]
  C -->|Device| H[Open overlay device menu]
  D --> I{Section}
  I -->|MCP| J[Read secure MCP state]
  I -->|GPT Actions| K[Edit bridge toggle or origin]
  I -->|Developer| L[Toggle active tab DevTools]
  J --> M[Copy connection]
  M --> N{Active pairing offer?}
  N -->|No| O[Create short-lived pairing offer]
  N -->|Yes| P[Reuse current offer]
  O --> Q[Copy normal agent prompt]
  P --> Q
  Q --> R[Agent retains MCP session and binds one tab]
  K --> S[Save validated settings]
  S --> T[Refresh bridge status]
  F --> U[Filter real console and network entries]
  E --> V[Open, reveal, or inspect downloads]
  H --> W{Desktop or emulated device?}
  W -->|Desktop| X[Swap stage orientation only]
  W -->|Mobile/tablet| Y[Rotate CDP emulation and reload tab]
  X --> Z[Publish device state]
  Y --> Z
  G --> AA[Render themed xterm session]
```
