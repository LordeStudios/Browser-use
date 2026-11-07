# Browser-use

Browser-use is the official Lorde Studios desktop browser automation and MCP client for visible, proof-first browser control.

> The public repository is a distribution page. Proprietary implementation source is not included here.

## Download

The latest Windows release will be published under [GitHub Releases](https://github.com/LordeStudios/Browser-use/releases/latest).

Available Windows artifacts:

- `Browser-use-<version>-setup.exe`: NSIS installer
- `Browser-use-<version>-portable.exe`: portable application

Release assets include SHA-256 checksums. Windows may show a SmartScreen warning for an unsigned release.

## Features

- Visible Electron browser application with managed tabs and browser controls
- Chromium DevTools Protocol browser automation
- DOM snapshots, navigation, screenshots, console and network diagnostics
- Native browser pointer, keyboard, scroll, drag and text input dispatch
- MCP server support for agent clients
- Persistent session-based MCP over loopback HTTP
- Explicit tab binding and secure pairing for MCP input tools
- Claude Code compatible MCP connection setup through the desktop Settings drawer
- Browser-only and AGI computer-control modes
- Native Windows display observation, pointer, keyboard, terminal, clipboard, screenshots and recordings
- Optional vision-aware model routing and text-only fallback behavior
- Ollama, cloud and OpenAI-compatible provider connections
- Agent plans, approvals, recovery, evidence tracking and progress visibility
- Android device and ADB integration where configured
- Portable Windows distribution and standard installer

## Claude Code and MCP

Open Browser-use Settings and copy the generated MCP configuration. The desktop MCP endpoint uses the local loopback address and a short-lived pairing flow.

The MCP surface supports browser observation and control, screenshots, diagnostics, tab binding, native computer tools in AGI mode, plans, approvals and session management.

Use the generated connection details rather than hard-coding credentials. Pairing codes and runtime secrets are generated locally and are never part of this repository or release assets.

## Installation

1. Download the installer from the latest release.
2. Run the installer and choose an installation directory.
3. Start Browser-use from the Start Menu or desktop shortcut.
4. Open Settings to configure a provider and copy the MCP setup for Claude Code or another MCP host.

The portable executable can run without installation. It includes Electron and does not require a separate Node.js installation.

## System requirements

- Windows 10 or Windows 11, x64
- A signed-in interactive Windows desktop session
- Internet access for remote websites and provider connections
- A configured model provider for AI agent features

Native computer controls remain subject to Windows permissions, UAC boundaries, secure desktop boundaries and the selected approval mode.

## Security

Browser-use uses loopback MCP pairing and explicit tab binding. Do not use automated control against accounts or websites where actions could publish, delete, purchase, upload or change private data unless you intentionally authorize and monitor those actions.

Report security issues privately through the security contact or GitHub security workflow provided by the organization. Do not publish credentials, pairing codes or exploit details in public issues.

## Support

- Organization: [Lorde Studios](https://github.com/LordeStudios)
- Releases: [Browser-use Releases](https://github.com/LordeStudios/Browser-use/releases)
- Official site: [studios.lordemaximus.com](https://studios.lordemaximus.com)

## Release history

See [CHANGELOG.md](CHANGELOG.md) and the GitHub Releases page.

## Publisher

Lorde Studios.
