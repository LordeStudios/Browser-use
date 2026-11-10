# Patch: Terminal frictions + plain-language agent replies

From the tool's own Lorde AI test report (terminal frictions + unreadable replies).

## Fixed
1. **Trust-gate re-prompt on every launch** — terminal sessions start in
   `C:\Users\Administrator`, whose claude project trust flag was `false`, so
   every `claude` launch re-showed the folder-trust dialog defaulting to
   "No, exit". `~/.claude.json` now marks that directory trusted
   (`hasTrustDialogAccepted` + `hasCompletedProjectOnboarding`).
2. **Unreadable agent replies** — new shared `desktop/agent/replyStyle.cjs`
   (REPLY_STYLE_PROMPT) wired into all three provider system prompts (ollama,
   openai-compatible, responses): lead with the outcome in one short sentence;
   everyday words only; never file paths, line numbers, error codes, protocol
   terms, or token counts in user-facing text; failures say plainly what
   happened and the next step; no test matrices or report paths unless asked.
3. **`\n` vs `\r` Enter mismatch** — already fixed in `TerminalSession.write`
   (translate `\r?\n` → `\r`); the report predates that fix.
4. **"claude.bat broken on disk"** — no such file exists anywhere on disk now;
   it was the test agent's own scratch wrapper. Nothing to fix.

## Not fixable in code (external)
- **402 "Insufficient wallet balance"** — the xKiro wallet is empty. It blocks
  live `claude` replies and live Lorde AI re-tests, not the code fixes (Lorde
  AI Attach rasterization + runaway guards landed in the studio repo with
  deterministic + Playwright coverage).
- **"hello round-trip spinning 2+ min"** — same wallet blocker: claude was
  authenticated and streaming, the provider returned 402.

## Verification
- Provider suites (agent-effort, ollama, openai-compatible, responses
  continuity): 57/57 PASS — prompts still satisfy every existing contract.
- Trust state: `projects["C:/Users/Administrator"].hasTrustDialogAccepted = true`.

## Addendum — scroll-to-bottom button redesign
The "Latest" pill was absolutely positioned over the plan/tasks pill zone
(`.agent-progress-strip`, bottom:154px) — users never saw it. Redesign:

- The button now lives INSIDE `#agent-progress-strip`, anchored to its top
  edge (`bottom: 100%`). Empty strip (zero height) = same default spot above
  the composer; pills present = the button rides above their top edge — never
  overlaid, even when the plan list expands.
- Round 30px circle with a down arrow; hover reveals a "Scroll to bottom"
  label (pill tooltip to the left).
- A badge on the circle counts messages that arrived while the user was
  scrolled away (MutationObserver on the transcript, reset on return to
  bottom or on click, 99+ cap).

Files: renderer/index.html (button moved + new markup),
renderer/chat-reference.css (positioning + circle/label/badge styles),
renderer/app.js (unseen-count tracking + badge updates).
