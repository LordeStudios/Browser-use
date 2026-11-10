# S-ESCAPE FIX V309 — root cause of the "missing letter s" defect

## Symptom
Every element name/text observed through the browser-use desktop agent lost
lowercase `s` characters: `Insert` → `In ert`, `History` → `Hi tory`,
`Page Setup` → `Page etup`, `studio-canvas-viewport` → `tudio-canva -viewport`.
The Document/PDF/Presentation workspace audits recorded these as corrupted
application labels.

## Root cause
`desktop/mcp/browserViewController.cjs` → `buildElementCollectorScript()`
builds the page-side DOM collector inside a JS **template literal**. In a
template literal, `\s` is an unrecognized escape and evaluates to a literal
`s` — so the generated page script ran `.replace(/s+/g, ' ')`, replacing every
letter `s` (and `ss` runs) with a space in `element.textContent`, accessible
names derived from text, aria-labelledby chains, form labels, and interaction
region names. One occurrence (landmarks) was already correctly doubled
(`/\\s+/g`); five were not.

The Studio application itself was never corrupting text: direct DOM reads
returned `History`, `Insert`, `Transitions` intact, and `browser_execute`
probes returned `s`-heavy strings intact. The corruption existed only in the
agent observation pipeline.

## Fix
Doubled the escapes in the collector template (label textContent,
labelledBy split/map, form labels, region labelledBy, region publicName):
`/\s+/g` → `/\\s+/g`, `.split(/\s+/)` → `.split(/\\s+/)`.

## Verification
`node verify-collector-escapes.cjs` — asserts no single-backslash regex class
escape remains anywhere in the collector template (PASS).

## Activation
The running Electron desktop app caches the old module. **Restart the
browser-use desktop app** to load the fix; afterwards all agent-observed
labels will contain their `s` characters.

## Consequence for the workspace audits
The "confirmed character-loss defect" in the Document and PDF workspace specs
(`In ert`, `De ign`, `Hi tory`, `Page etup`, ` uper cript`, ` ub cript`,
`li t ample`, `Fir t li`) is this observation-layer bug, not application
corruption. Those acceptance items pass once the desktop app is restarted and
the observation layer re-verified.
