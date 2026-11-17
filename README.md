# Browser-use CLI

A browser agent you can run from a terminal. It drives a real Chromium browser over the DevTools protocol, reads pages, clicks, types, handles native file dialogs, and reports what it did. This package also serves the Browser-use interface in your browser, so you get the full workspace without installing the desktop application.

Works on Windows, macOS and Linux. Requires Node.js 20 or newer and a Chromium based browser (Chrome, Edge or Chromium). The package finds one automatically, or you can set `CHROME_PATH`.

## Install

```bash
npm install -g lorde-browser-use
```

Or with the bundled script, which also falls back to a user directory when the global prefix is not writable:

```bash
bash install.sh
```

## Commands

```bash
browser-use                 # terminal interface
browser-use gui --open      # web interface at http://127.0.0.1:4200
browser-use run "open example.com and summarise the page"
browser-use doctor          # node, browser, CDP start time, interface status
browser-use help
```

`browser` and `lorde` are aliases for `browser-use`.

### browser-use gui

Serves the Browser-use interface over HTTP with the CLI's own runtime behind it. No desktop application and no Electron window. Add `--port` to change the port (default 4200) and `--open` to launch your browser.

### browser-use doctor

Prints the Node version, the browser binary that will be driven, how long it takes to start, and where the interface will listen. Run it first when something does not work.

## File dialogs

The agent answers native Open and Save dialogs itself, so uploads and downloads complete without the operating system window:

- attach files to an upload control
- cancel a picker
- send downloads to a directory you choose
- write a file directly

The same tools are available over MCP for coding agents.

## Desktop application

The Windows desktop build, with its own window, installer and portable executable, is distributed on the releases page:

https://github.com/LordeStudios/Browser-use/releases/latest

## Licence

Proprietary. Copyright Lorde Studios. All rights reserved.
