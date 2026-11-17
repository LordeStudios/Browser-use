# browser-use CLI (npm), install in bash, GUI included, no desktop app

One npm package that gives you the **CLI agent, the TUI, and the web GUI**: no Electron
process, no native window. The GUI is served over HTTP by the CLI itself and talks to its own
headless backend (`cli/tui/guiBackend.mjs`).

## Install

```bash
bash install.sh                 # installs lorde-browser-use@latest globally
bash install.sh ./lorde-browser-use-0.3.6.tgz   # or from a local tarball
```

`install.sh` checks Node 20+, installs globally, falls back to `~/.local` when the global prefix
is not writable, and prints the next commands.

Or without the script:

```bash
npm install -g lorde-browser-use
```

## Commands

| Command | What it does |
|---|---|
| `browser-use` | interactive TUI (slash commands inside) |
| `browser-use gui [--port 4200] [--open]` | serve the web GUI on `http://127.0.0.1:4200`; `--open` launches your browser |
| `browser-use run "task text"` | one-shot headless agent run, streams output, prints a JSON summary |
| `browser-use doctor` | node version, browser binary, CDP launch timing, GUI URL |
| `browser-use help` / `version` | usage / version |

`browser` and `lorde` are aliases of `browser-use`.

## The GUI without the desktop app

```bash
browser-use gui --open
```

- Serves `desktop/renderer` (the same UI the desktop app shows) over plain HTTP.
- `/ipc` and `/events` are answered by the **standalone backend** in the CLI process.
- If a desktop app happens to be running, its loopback bridge is used as an accelerator; when it
  isn't, nothing breaks, the headless backend serves the channel itself.

## Browser requirement

The CLI drives a real Chromium over CDP. It resolves, in order: `CHROME_PATH` → Playwright's
bundled Chromium (`%LOCALAPPDATA%\ms-playwright\chromium-*`) → Chrome → Edge → `where msedge` /
`which chromium`. `browser-use doctor` prints which binary was chosen and how long the CDP launch
took, so a "nothing works" report is one command away.

## Packaging notes (why the tarball looks the way it does)

- `electron` is a **devDependency**, so `npm i -g` never downloads the desktop runtime.
- `files` ships `cli/`, `desktop/` (renderer, agent, mcp, computer, terminal, store, pointer,
  schedule, knowledge, assets), `src/`, `scripts/`, `install.sh`, `README.md`, and excludes
  `desktop/android/bin` (29 MB of adb/scrcpy), the 22 MB splash screens, tests and scratch.
  Result: **349 files, 15.6 MB packed / 21 MB unpacked**.
- No lifecycle scripts (`prepare`/`postinstall`) run on a consumer install.
- `engines.node >= 20`.

## Publishing (needs npm auth)

`browser-use` on the public registry is **already taken (v0.9.0)**, so this package publishes as
`lorde-browser-use`. From a machine logged in to npm:

```bash
npm whoami                 # confirm the account
npm publish --dry-run      # inspect what would ship
npm publish                # unscoped → public
```

Then tag the repo so the install docs point at a released version.

## Verified

```
browser-use --version        → browser-use v0.3.6
browser-use help             → lists gui / run / doctor
browser-use doctor           → node v22, binary ms-playwright chromium, cdp launch 485 ms
browser-use gui --port 4430  → GET / http=200 (34 KB page, <title>Browser-use</title>)
                             → POST /ipc browser-use:chat-history-list → {"ok":true,"result":[...]}
```

## Published

**`lorde-browser-use@0.3.6`**: live on the public registry (2026-11-14):

```
https://www.npmjs.com/package/lorde-browser-use
npm install -g lorde-browser-use
```

First-publish note: npm holds brand-new package names behind a staged review. The package first appeared as
`0.0.0-stage` ("Temporary Holding Version") while `0.3.6` was in review; the publish then completed and
`dist-tags.latest` moved to `0.3.6`. Verified from a clean prefix:

```
npm view lorde-browser-use version --prefer-online   → 0.3.6
npm i -g lorde-browser-use                            → 59 packages
browser-use --version                                 → browser-use v0.3.6
browser-use gui --port 4460                           → GET / http=200
                                                        POST /ipc → {"ok":true,"result":[…]}
browser-use doctor                                    → playwright chromium, cdp launch ok
```

Registry tarball: `https://registry.npmjs.org/lorde-browser-use/-/lorde-browser-use-0.3.6.tgz` (22.4 MB unpacked).
If an install reports "no matching version", the local npm metadata cache is stale, use
`npm i -g lorde-browser-use@0.3.6` or `npm cache clean --force`.
