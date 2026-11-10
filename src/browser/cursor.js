import { createRequire } from 'node:module';

// Legacy standalone visual helper. The Electron desktop pointer does not import
// this page-injection path; it owns a separate transparent child window.
const require = createRequire(import.meta.url);
const { CURSOR_ID, buildCursorExpression } = require('./cursorOverlay.cjs');

export const CURSOR_MODE = 'in-page-agent-overlay';

export function cursorExpression(x, y, isClick = false) {
  return buildCursorExpression(x, y, isClick);
}

export async function showAgentCursor(browser, x, y, isClick = false) {
  try {
    const result = await browser.evaluate(cursorExpression(x, y, isClick));
    return { ...cursorMetadata(x, y), visible: Boolean(result?.visible), overlayId: CURSOR_ID };
  } catch (error) {
    return { ...cursorMetadata(x, y), visible: false, reason: error.message };
  }
}

export function cursorMetadata(x = null, y = null) {
  return {
    mode: CURSOR_MODE,
    x,
    y,
    visualOverlayInjected: true,
    affectsHostPointer: false
  };
}
