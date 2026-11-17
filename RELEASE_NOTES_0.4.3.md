## Browser-use 0.4.3

The browser now ships inside the package and runs where it is installed, including Linux arm64 containers that have no Chromium of their own.

### A browser the package carries

`browser-use browser install` fetches a stripped Chromium build containing only what CDP and page rendering need. It is provisioned automatically on install, on the first run, when the interface starts, and when a message is sent with no browser present, so an interrupted install repairs itself.

On Linux arm64 the package also carries the runtime libraries that build needs. Containers and Android environments usually ship without NSS, NSPR, ATK, GBM and the rest, and Chromium fails to start with a missing shared library. Those libraries now travel with the package, and the loader is pointed at them when the browser launches. Verified on an Android Linux container: the browser starts and serves CDP in under three seconds.

### Terminal that works without a native PTY

The integrated terminal used to select a Windows shell on every platform and then report a PTY problem. It now picks the shell for the operating system that is running, and when the native PTY module is unavailable it runs the shell over pipes, so commands still execute and output still streams. The panel reports which backend it is using.

### No model chosen for you

The built in default model is gone. A run without a model now says so instead of quietly using one your provider may not serve. Your selection is no longer overwritten.

### A browser is no longer required to run the agent

File, shell, research and computer tools work with no browser at all. Browser tools report the reason per call instead of the run dying at startup.

### Install

Desktop app, Windows 10 and 11 x64: the installer or the portable build below.
Command line and web interface:

```bash
npm install -g lorde-browser-use
browser-use gui --open
```
