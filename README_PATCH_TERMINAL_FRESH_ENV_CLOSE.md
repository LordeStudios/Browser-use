# Patch: Terminal fresh environment, real Reset, closable sessions

## Problems fixed
1. **No way to close active terminals** — sessions accumulated until the app quit.
2. **New terminals kept a stale API key** — a system-wide config fixed on disk kept losing to an environment snapshot inherited from the long-lived terminal broker (env vars override on-disk config for Claude and friends), so "insufficient balance" persisted everywhere in the tool while the same key worked in normal terminals.
3. **Reset only cleared the viewport** — a fresh shell still spawned with the same stale broker environment, so "reset" never picked up new config.

## Fixes
- `desktop/terminal/terminalSession.cjs`: credential-shaped variables (`ANTHROPIC_API_KEY`, `*_AUTH_TOKEN`, `*_BASE_URL`, `*_API_KEY` families, exact provider names) are stripped from the FINAL merged environment whatever their source — the broker snapshot AND the Desktop push both inherit the shell that launched the app, and `setx` never updates running shells, so any inherited provider key can be stale and silently shadow current on-disk config. Non-credential variables survive. Dropped keys are announced as a dim `[environment]` notice; a session that genuinely needs a key sets it explicitly at the prompt.
- `desktop/terminal/terminalBroker.cjs` + `terminalBrokerClient.cjs`: the broker is a detached process that outlives the app, so every Desktop connect now pushes the CURRENT environment (`setEnv`); NEW sessions merge it over the broker snapshot. A broker too old to know `setEnv` is restarted once (its shells could never honor fresh config anyway). End-to-end test: pushed env reaches a spawned PowerShell.
- `desktop/main.cjs`: the dispose handler refuses to close an agent-owned session while its run is alive (the owner-release path still disposes deliberately).
- `desktop/renderer/index.html` + `app.js` + `styles.css`: an X button next to the session picker closes any listed session (blocked with a toast for live agent-owned ones); attached view reports "session closed" if it was the closed one.
- `desktop/renderer/terminal.js`: Reset prints "Terminal restarted — new shell, current environment." (it already disposed + respawned; the missing piece was the fresh environment).

## How to test
- `node --test tests/terminal-session.test.mjs` (11/11) — incl. new credential-strip contract (stale inherited keys dropped, explicit fresh key wins).
- `node --test tests/terminal-broker.test.mjs` (2/2) — incl. new end-to-end `setEnv` → new session sees the pushed value.
- Manual: fix the API config → restart the desktop app → open a terminal → the key works; Reset drops old env; X closes a session.

## Known limits
- The pushed environment is as fresh as the last Desktop launch — Windows env vars changed via `setx` after the app started need an app restart (PowerShell profiles and on-disk configs are read live by the shell itself).
- Closing a session kills its shell; scrollback is gone by design (Reset likewise starts empty shell state).

## Update (same day) — why the first cut did not fix the dev workflow
`npm run desktop:dev` inherits the environment of the shell that launches it.
If that shell (VS Code terminal / long-lived PowerShell) still carries the OLD
key — `setx` never updates running shells — the freshly pushed environment
carried the stale key right back in, because only the broker's own snapshot
was stripped. Fixes:

- **Final-merge strip** (`terminalSession.cjs`): credential variables are now
  removed from the FINAL merged environment whatever their source. Shells
  always resolve credentials like a fresh system terminal: from on-disk config,
  never from an inherited snapshot. Non-credential variables survive; a
  session needing a key sets it explicitly at the prompt.
- **Contract version handshake** (`TERMINAL_CONTRACT_VERSION = 2`): brokers
  survive app restarts, so a broker spawned by an earlier build keeps its OLD
  in-memory session code forever. Every connect now compares versions; an
  outdated broker is shut down and replaced once (existing shells are lost —
  they were stale by definition).

## Update 2 — "not logged in": the key lives in the registry
The blanket credential strip also removed the user's CURRENT system-wide key
(it is an env var), so the CLI fell back to on-disk config where nothing
exists → "not logged in". Final model:

- `terminalBrokerClient.cjs` reads the CURRENT user + machine environment from
  the registry via PowerShell (`[Environment]::GetEnvironmentVariables`,
  60s cache, 5s timeout, non-Windows → empty). `buildPushEnvironment` (pure,
  exported) merges: registry values win; credentials known only to an
  inherited shell are DROPPED; everything else passes through.
- Result: a system-wide key keeps working with its CURRENT value; a stale
  copy from any long-lived process can never shadow config; a key fixed via
  `setx` reaches terminals even when npm/Electron/broker still hold the old
  value (push refreshes on every connect and ≤30s before each create).
- `main.cjs` terminal-create refreshes the push (maxAgeMs 30s) before spawn.

## Update 3 — verified end-to-end; the remaining warning is not a terminal issue
Live probes through the real broker on the target machine:

- Fresh browser-use terminal sees `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`
  (registry-current), `ANTHROPIC_BASE_URL=https://api.xkiro.com`, and resolves
  `claude` — identical to a normal terminal.
- `SetEnvironmentVariable(..., "User")` writes the registry but does NOT
  change the current shell's env: launching claude in that same shell (any
  terminal) shows "not logged in". Open a NEW terminal / press Reset first.
- `claude -p` then prints `[claude-code:unrecognized_model]
  {"model":"z-ai/glm-5.3-flash[1M]","query_source":"generate_session_title"}`
  followed by a successful reply — verified IDENTICAL in a normal terminal.
  This is the `[1M]` suffix in `~/.claude/settings.json`'s env block failing
  claude's background title-generation query; cosmetic, pre-existing, not a
  login/key/terminal fault.
- Additional hardening this round: registry PATH now concatenates
  machine+user scopes (System32 was silently dropped by last-wins merging),
  and runtime session markers (CLAUDECODE, CLAUDE_CODE_*, CLAUDE_PID) no
  longer leak into terminals, so CLIs never behave as nested sessions.
