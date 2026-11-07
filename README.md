# Browser-use

Official Lorde Studios desktop browser automation and MCP client for visible, proof-first browser control.

> This public repository is a distribution page. Proprietary implementation source is maintained privately and is not included here.

## Download

Download the latest stable Windows release from [GitHub Releases](https://github.com/LordeStudios/Browser-use/releases/latest).

- `Browser-use-0.3.6-setup.exe` for installation
- `Browser-use-0.3.6-portable.exe` for portable use

Release assets include SHA-256 checksums. Windows may show a SmartScreen warning for an unsigned release.

## Features

- Visible Electron browser application with managed tabs
- Chromium DevTools Protocol automation
- DOM snapshots, navigation, screenshots, console and network diagnostics
- Native browser pointer, keyboard, scrolling, dragging and text input
- MCP server support for agent clients
- Persistent session-based MCP over loopback HTTP
- Explicit tab binding and secure pairing for MCP input tools
- Claude Code compatible MCP setup through the desktop Settings drawer
- Browser-only and AGI computer-control modes
- Windows display observation, pointer, keyboard, terminal, clipboard, screenshots and recordings
- Ollama, cloud and OpenAI-compatible provider connections
- Agent plans, approvals, recovery, evidence tracking and progress visibility
- Optional Hybrid Computer Use integration, disabled by default
- Android device and ADB integration where configured

## Claude Code and MCP

Open Browser-use Settings and copy the generated MCP configuration. The desktop MCP endpoint uses loopback transport, secure pairing and explicit tab binding.

The MCP surface supports browser observation and control, screenshots, diagnostics, tab binding, native computer tools in AGI mode, plans, approvals and session management.

Use generated connection details rather than hard-coding credentials. Pairing codes and runtime secrets are generated locally and are not part of this repository or its release assets.

## Installation

1. Download the installer from the latest release.
2. Run it and choose an installation directory.
3. Start Browser-use from the Start Menu or desktop shortcut.
4. Open Settings to configure a model provider and copy the MCP setup for Claude Code or another MCP host.

The portable executable runs without installation and includes Electron.

## System requirements

- Windows 10 or Windows 11, x64
- Signed-in interactive Windows desktop session
- Internet access for remote websites and provider connections
- Configured model provider for AI agent features

Native computer controls remain subject to Windows permissions, UAC boundaries, secure desktop boundaries and the selected approval mode.

## Security

Browser-use uses loopback MCP pairing and explicit tab binding. Do not automate sensitive accounts or irreversible actions without supervision.

Report suspected vulnerabilities privately through GitHub security reporting. Never publish credentials, pairing codes or private page content in public issues.

## Support

- [Lorde Studios](https://github.com/LordeStudios)
- [Browser-use Releases](https://github.com/LordeStudios/Browser-use/releases)
- [Official site](https://studios.lordemaximus.com)

## Release history

See [CHANGELOG.md](CHANGELOG.md) and GitHub Releases.

## Publisher

Lorde Studios.
