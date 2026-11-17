## Browser-use 0.4.0

A leaner agent, native file dialogs it can answer itself, and a CLI that runs the interface in your browser.

### A rebuilt agent core

The agent now runs on a single control loop with one owner per concern: prompt, memory, recovery, tool execution and error reporting. The practical result is a shorter instruction set, faster decisions, fewer stalls, and far less repeated work on long tasks. Long sessions hold their shape better because volatile context is refreshed outside the cached prompt instead of rebuilding it.

### File dialogs, handled by the agent

Open and Save dialogs no longer require the OS window. The agent can attach files to an upload control, cancel a picker, and route downloads to a directory you choose, in the desktop app, the CLI and over MCP. Seven tools cover the flow: arm, status, accept, cancel, set the download directory, list downloads, and write a file directly. When a click opens a picker, the reply says so and tells the agent what to do next.

### CLI and web interface without the desktop app

```bash
npm install -g lorde-browser-use
browser-use gui --open
```

- `browser-use` opens the terminal interface.
- `browser-use gui` serves the same interface over HTTP at `http://127.0.0.1:4200`, backed by the CLI's own runtime. No desktop app, no Electron window.
- `browser-use doctor` reports the Node version, the browser it will drive, and how fast that browser starts.
- `browser-use run "task"` performs a single headless run and prints a summary.

The package is self-contained and cross-platform. Electron is not installed with it.

### Accuracy and reliability

- Screenshot coordinates are correct at any display scaling, including 125% and 150% Windows setups.
- Click results always report what actually happened, including when input is delivered by a fallback path.
- Clicking a disabled control returns a clear reason instead of silently doing nothing.
- The agent can read the page's text directly, so it stops dumping raw HTML to find instructions.
- Queries that target a specific element now return it even when it is not an interactive control.

### Install

Desktop app: use the Windows installer assets on this release.
Command line and web interface: `npm install -g lorde-browser-use`, or the npm package attached below.
