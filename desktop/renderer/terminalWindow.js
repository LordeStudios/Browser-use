// Entry point for the detached terminal window.
//
// Reuses the same TerminalController as the docked panel, so behaviour cannot
// drift between the two places a terminal can appear. Screenshot and Select
// still act on the main window's active tab, because the terminal is a tool
// pointed at the browser rather than a separate application.

const surface = document.querySelector('#terminal-surface');
const backendLabel = document.querySelector('#terminal-backend');
const screenshotButton = document.querySelector('#terminal-screenshot');
const selectButton = document.querySelector('#terminal-select');
const resetButton = document.querySelector('#terminal-reset');

const controller = new window.BrowserUseTerminal.TerminalController({
  surface,
  onStatus: (status) => {
    backendLabel.textContent = status.backend === 'pty' ? `${status.shell} · PTY` : `${status.shell} · reduced`;
  },
  onSessionChange: (session) => {
    if (session?.alive) return;
    backendLabel.textContent = session?.reason ? `shell stopped, ${session.reason}` : 'shell stopped';
  }
});

window.browserUseDesktop.onTerminalData(({ id, data }) => controller.write(id, data));
window.browserUseDesktop.onTerminalExit(({ id, exitCode }) => controller.notifyExit(id, exitCode));

screenshotButton.addEventListener('click', async () => {
  try {
    const shot = await window.browserUseDesktop.terminalScreenshot();
    controller.print(`Screenshot saved and path copied: ${shot.path}`, '32');
    controller.insert(`"${shot.path}"`);
  } catch (error) {
    controller.print(`Screenshot failed: ${error.message}`, '31');
  }
});

selectButton.addEventListener('click', async () => {
  controller.print('Pick an element in the browser window, press Escape to cancel.', '36');
  try {
    const result = await window.browserUseDesktop.pickElement();
    if (!result?.picked) {
      controller.print(`Selection ${result?.reason || 'cancelled'}.`, '33');
      return;
    }
    controller.insert(`"${result.element.selector}"`);
    controller.print(`Selected ${result.element.tag}, ${result.element.selector}`, '32');
  } catch (error) {
    controller.print(`Select failed: ${error.message}`, '31');
  }
});

resetButton.addEventListener('click', async () => {
  resetButton.disabled = true;
  try {
    await controller.restart();
  } catch (error) {
    controller.print(`Reset failed: ${error.message}`, '31');
  } finally {
    resetButton.disabled = false;
  }
});

controller.open().catch((error) => {
  surface.textContent = `Terminal failed to start: ${error.message}`;
});

window.addEventListener('beforeunload', () => {
  // Only the view is torn down. The shell keeps running in the main process so
  // re-docking the terminal returns to the same session.
  controller.releaseView();
});
