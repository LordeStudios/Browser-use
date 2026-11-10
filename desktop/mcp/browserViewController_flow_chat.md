# Browser View Controller Flowchart

## Purpose

`browserViewController.cjs` safely resolves DOM references, dispatches native or background CDP input, and provides bounded DOM/screenshot evidence for the desktop agent.

```text
+--------------------+
| Agent action/probe |
+---------+----------+
          v
+--------------------+
| Validate live tab  |
+---------+----------+
          v
+  needs DOM target?
+    |           |
+   yes          no
+    v            v
+ snapshot --> stable rematch
+    |           |
+ found        stale
+    v           v
+ dispatch    return recoverable
+ input       stale result
+    |
+    v
+ capture controls + semantic
+ state + interaction regions
+    |
+    v
+ bounded verification
```

```mermaid
graph TD
  A[Action or verification probe] --> B[Validate bound tab]
  B --> C{Element reference required?}
  C -->|yes| D[Resolve newest snapshot]
  D -->|missing| E[One stable-identity rematch]
  E -->|ambiguous or absent| F[Fail closed as stale]
  D -->|resolved| P{Selected view attached?}
  C -->|no| P
  P -->|yes| G[Dispatch native input]
  P -->|transiently detached| Q[Ask shell to reattach and lay out once]
  Q --> R{Paintable now?}
  R -->|yes| G
  R -->|no| S
  P -->|background tab| S[Dispatch tab-scoped CDP input]
  S --> H
  G --> H[Return bounded action/probe evidence]
  H --> H2[Return controls, pressed state, and bounded interaction regions]
  H2 --> I{Visual evidence needed?}
  I -->|yes, paintable| J[Timed screenshot]
  I -->|no or unavailable| K[DOM/navigation evidence only]
```

## Click target precedence

A standalone pointer move is never stored as a required destination for a later click. Each click chooses its own target: an explicit finite coordinate pair wins over optional element/index metadata, while an index-only click resolves the latest DOM snapshot center.

```text
+-----------------------------+
| browser_click action        |
+--------------+--------------+
               v
      +--------+--------+
      | finite x and y? |
      +----+--------+---+
        yes|        |no
           v        v
 +----------------+  +----------------------+
 | click explicit |  | resolve element/index|
 | coordinate     |  | center from snapshot |
 +----------------+  +----------------------+
```

```mermaid
graph TD
  A[browser_click] --> B{Finite x and y?}
  B -->|Yes| C[Move and click explicit coordinate]
  B -->|No| D[Resolve element/index center]
  E[Prior browser_mousemove] -. independent .-> A
```

## Hidden-window pointer routing

```text
+------------------------------+
| Selected tab has a surface?  |
+---------------+--------------+
       yes      |       no
        v       |        v
  await pointer |  no visible-pointer prerequisite
  native input  |  same-tab CDP input
        +-------+--------+
                v
      keep cancellation and key/button cleanup
```

```mermaid
graph TD
  A[Input for explicitly bound tab] --> B{Selected and paintable?}
  B -->|Yes| C[Require visible pointer arrival]
  B -->|No: hidden, minimized, or detached| D[No overlay arrival required]
  C --> E[Native event]
  D --> F[Same-tab CDP event]
  E --> G[Preserve held-input tracking and cancellation]
  F --> G
```

A tray-hidden window cannot display a pointer overlay. Its absence must not
cancel an otherwise authorized new input operation. Actual cancellation or
interruption remains terminal, and visible-tab pointer synchronization is unchanged.

## Navigation completion

```text
+-------------------------+
| browser_navigate request|
+------------+------------+
             |
             v
 +-----------+-----------+
 | Full document route?  |
 +-----+-------------+---+
       |             |
     yes             no (same-page hash)
       |             |
       v             v
+----------------+  +---------------------------+
| did-navigate   |  | did-navigate-in-page      |
| main-frame     |  | exact requested hash      |
+-------+--------+  +-------------+-------------+
        |                         |
        +------------+------------+
                     v
          +-----------------------+
          | Return fresh location |
          +-----------------------+
```

```mermaid
graph TD
  A[browser_navigate] --> B{Requested URL changes only the hash?}
  B -->|No| C[Wait for matching main-frame did-navigate commit]
  B -->|Yes| D[Wait for matching did-navigate-in-page event]
  C --> E[Return current committed or redirected location]
  D --> F[Return exact hash location immediately]
  E --> G[Agent obtains fresh DOM evidence]
  F --> G
```

## Invariants

1. Numeric indexes only reference the newest snapshot and are rematched once by stable identity before failing closed.
2. Selected-tab native input and background CDP input never silently shift the human-visible tab.
3. Screenshot timeouts return bounded errors; late Electron/CDP work must not alter newer agent observation revisions.
4. Mouse/key state is released on cancellation, tab close, and shutdown.
5. A same-document navigation that changes a fragment (for example
   `#details`) completes from Electron's matching `did-navigate-in-page`
   event instead of waiting for a full-document commit timeout. A fragment
   request is not reported as complete from the pre-fragment URL.
6. If the selected BrowserView is transiently absent from the window during a
   native input action, the controller asks the main shell to reattach and lay
   it out exactly once, then rechecks paintability. If Windows still provides no
   compositor surface, the same requested tab receives the input through its
   tab-scoped CDP channel. The controller never switches targets or falls
   through to an unrelated provider decision.
7. A normal observation exposes both actionable controls and a small set of
   large visible interaction regions (for example `main`, canvas, SVG, or an
   explicitly labelled/tested surface). Regions carry only a public label and
   viewport rectangle; they are coordinate grounding, not executable selectors.
8. Button state such as `aria-pressed`, `aria-selected`, and `aria-expanded` is
   retained. Dispatching a click proves only that the control received input;
   an armed drawing/placement tool is not the same evidence as a created layer.


## HTTP commit validity

A matching main-frame commit is necessary but not sufficient evidence. The
controller rejects committed HTTP status codes `>= 400` as navigation failures.
This keeps a server-side `404 Not found` from becoming a successful observation
that sends the agent into filesystem guesswork.

## Form fill (`browser_fill`) route

```text
+-----------------------+
| browser_fill request  |
+-----------+-----------+
            v
+-----------------------+
| Resolve snapshot index|
| to stable selector    |
+-----------+-----------+
            v
+-------------------------------+
| Runtime.evaluate: focus the   |
| control and select its own    |
| value in the same page turn  |
+---------------+---------------+
                v
        +-------+-------+
        | Focus held?   |
        +---+-------+---+
          no|       |yes
            v       v
     +----------+  +----------------+
     | Fail      |  | Native input?  |
     | closed    |  +---+--------+---+
     +----------+    no|        |yes
                       v        v
              +-------------+  +--------------------+
              | DOM setter  |  | One Input.insertText|
              | fallback    |  | event (native or   |
              +------+------+  | tab-scoped CDP)    |
                     |         +---------+----------+
                     +-------------------v
                              +----------------------+
                              | Settle and verify    |
                              +----------------------+
```

```mermaid
graph TD
  A[browser_fill request] --> B[Resolve snapshot index to stable selector]
  B --> C[One Runtime.evaluate focuses and selects control content]
  C --> D{Focus held?}
  D -->|No| E[Fail closed with reason]
  D -->|Yes| F{Native input or textarea?}
  F -->|No| G[DOM setter fallback for non-native target]
  F -->|Yes| H[Dispatch one Input.insertText event]
  H --> I{Foreground or background?}
  I -->|Foreground| J[Electron webContents.insertText]
  I -->|Background| K[Tab-scoped CDP Input.insertText]
  J --> L[Settle and verify requested value]
  K --> L
  G --> L
```

The route never dispatches a document-wide select-all key chord. Replacement
semantics come from selecting the target control's own content in the same
page-side evaluation that focuses it. If native focus cannot be retained, the
operation fails closed rather than risking a page-wide selection.
