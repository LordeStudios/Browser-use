// Confirms the shipped archive actually contains the desktop fixes, so a stale
// app.asar cannot masquerade as a fixed build. A packaged app that predates a
// source change is indistinguishable from a regression at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const asar = require('@electron/asar');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The output directory is configurable so a verification build can be checked
// without disturbing an existing desktop-release that a running app has locked.
const outputDirectory = process.argv[2] || 'desktop-release';
const archive = path.join(root, outputDirectory, 'win-unpacked', 'resources', 'app.asar');

if (!fs.existsSync(archive)) {
  console.error(`missing packaged archive: ${archive}`);
  process.exit(2);
}

const expectations = [
  ['desktop/main.cjs', 'reconcileWindowContentSize', 'crop: reconciles a stale reported content size'],
  ['desktop/main.cjs', 'LAYOUT_SETTLE_DELAYS_MS', 'crop: re-applies bounds until the window settles'],
  ['desktop/main.cjs', 'isTabPaintable', 'capture: paintable gate wired into the controller'],
  ['desktop/mcp/browserViewController.cjs', 'withTimeout', 'capture: capturePage cannot hang forever'],
  ['desktop/mcp/localMcpServer.cjs', 'callWithDeadline', 'capture: every tool call is bounded'],
  ['desktop/mcp/browserViewController.cjs', 'sendInputEvent', 'native input: desktop dispatches trusted browser events'],
  ['desktop/main.cjs', 'AgentPointerOverlay', 'pointer: app-owned transparent pointer surface is created'],
  ['desktop/pointer/agentPointerOverlay.cjs', 'setIgnoreMouseEvents', 'pointer: child window passes input through to the page'],
  ['desktop/renderer/agent-pointer.js', 'IDLE_DELAY_MS', 'pointer: mounted renderer has a bounded inactivity lifecycle'],
  ['desktop/renderer/agent-pointer.js', 'easeOutQuint', 'pointer: renderer owns interruption-safe frame animation'],
  ['desktop/mcp/browserViewController.cjs', 'pointerVisualizer', 'pointer: native input and app visualization share one controller boundary'],
  ['desktop/mcp/browserViewController.cjs', "this.evaluatePage(tab, 'DOM snapshot', buildElementCollectorScript", 'grounding: page evaluation is limited to bounded element inspection'],
  ['desktop/mcp/sessionBroker.cjs', "this.connectionMode = 'secure'", 'security: legacy fast mode is forced to secure pairing'],
  ['desktop/mcp/localMcpServer.cjs', 'Bind a desktop tab before calling this tool', 'security: input tools fail closed without explicit tab binding'],
  ['desktop/mcp/deviceEmulator.cjs', 'Input.dispatchTouchEvent', 'native input: touch gestures use CDP input dispatch']
];

const forbiddenMarkers = [
  ['desktop/mcp/browserViewController.cjs', 'cursorOverlay.cjs', 'page injection: desktop pointer path has no cursor overlay'],
  ['desktop/mcp/deviceEmulator.cjs', 'buildTouchOverlayExpression', 'page injection: touch path has no document overlay'],
  ['desktop/main.cjs', "appendSwitch('remote-debugging-port'", 'security: desktop process exposes no direct debugging port']
];

// asar indexes nested entries with the platform separator, so a forward-slash path
// raises "not found" on Windows even when the file is present. Read once per file
// and keep any lookup failure distinct from a genuinely absent marker, because
// silently treating an unreadable path as MISSING reports a false regression.
function readEntry(file) {
  const attempts = [file.split('/').join(path.sep), file];
  const errors = [];
  for (const candidate of attempts) {
    try {
      return { source: asar.extractFile(archive, candidate).toString() };
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  return { error: errors.join(' | ') };
}

const sources = new Map();
let failed = 0;
let unreadable = 0;
for (const [file, marker, label] of expectations) {
  if (!sources.has(file)) sources.set(file, readEntry(file));
  const entry = sources.get(file);
  if (entry.error) {
    unreadable += 1;
    console.log(`UNREADABLE  ${label} — ${entry.error}`);
    continue;
  }
  const present = entry.source.includes(marker);
  if (!present) failed += 1;
  console.log(`${present ? 'PRESENT' : 'MISSING'}  ${label}`);
}

for (const [file, marker, label] of forbiddenMarkers) {
  if (!sources.has(file)) sources.set(file, readEntry(file));
  const entry = sources.get(file);
  if (entry.error) {
    unreadable += 1;
    console.log(`UNREADABLE  ${label} — ${entry.error}`);
    continue;
  }
  const absent = !entry.source.includes(marker);
  if (!absent) failed += 1;
  console.log(`${absent ? 'ABSENT' : 'PRESENT'}  ${label}`);
}

const stats = fs.statSync(archive);
console.log(JSON.stringify({ archive: path.relative(root, archive), builtAt: stats.mtime.toISOString(), checks: expectations.length + forbiddenMarkers.length, missing: failed, unreadable }));
if (failed > 0 || unreadable > 0) process.exit(1);
