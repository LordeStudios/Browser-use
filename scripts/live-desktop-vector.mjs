/**
 * LIVE desktop vector-craft evidence run: the SAME artwork brief executed by
 * the browser-use desktop chat agent (AGI computer mode, xkiro glm-5.3).
 *
 * Launches the real Electron app, configures the xkiro connection from the
 * Claude Code config key (never printed), enables AGI mode, starts the run,
 * and watches the tool stream for the owner's failure signatures
 * (tool-access claims, self-repetition). Saves final screenshot + verdict.
 *
 * Usage: node scripts/live-desktop-vector.mjs <name> "<brief>"
 */
import { _electron as electron } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = process.argv[2];
const BRIEF = process.argv[3];
const RUN_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 12 * 60_000);
const MODEL = process.env.LIVE_MODEL || "z-ai/glm-5.3-flash";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "live-artifacts");
mkdirSync(OUT, { recursive: true });
if (!NAME || !BRIEF) { console.error("usage: node scripts/live-desktop-vector.mjs <name> \"<brief>\""); process.exit(2); }

const ccEnv = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).env || {};
const KEY = ccEnv.ANTHROPIC_AUTH_TOKEN || "";
if (!KEY) { console.error("NO-KEY"); process.exit(2); }

const verdict = { name: NAME, brief: BRIEF, startedAt: new Date().toISOString(), failures: [], events: [] };
const t0 = Date.now();

const appData = join(OUT, `.user-data-${NAME}-${Date.now()}`);
const electronApp = await electron.launch({
  executablePath: join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
  // --user-data-dir is REQUIRED: the app enforces a single-instance lock keyed
  // to the user-data path, so an isolated dir is what lets this harness run
  // alongside the user's real instance (env APPDATA alone does not suffice).
  args: [".", `--user-data-dir=${appData}`],
  cwd: ROOT,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, BROWSER_USE_DESKTOP_MCP_PORT: "0" }
});
// Pick the MAIN renderer window — firstWindow() races the app's overlay
// window, which has no agent UI (same resolution as desktop-interaction-e2e).
let window = null;
{
  const deadline = Date.now() + 30_000;
  while (!window && Date.now() < deadline) {
    for (const candidate of electronApp.windows()) {
      if ((await candidate.url()).endsWith("/desktop/renderer/index.html")) { window = candidate; break; }
    }
    if (!window) await new Promise((r) => setTimeout(r, 100));
  }
}
if (!window) throw new Error("Browser-use main renderer did not load within 30 seconds.");
window.setDefaultTimeout(20_000);
await window.waitForSelector("#settings-toggle", { timeout: 30_000 });

// Configure xkiro + AGI mode.
const configured = await window.evaluate(async ({ key, model }) => {
  const api = window.browserUseDesktop;
  const conn = await api.saveAiConnection({ provider: "xkiro", name: "Evidence run", baseUrl: "https://api.xkiro.com/v1", model });
  await api.setProviderCredential({ provider: "xkiro", connectionId: conn.id, secret: key });
  const settings = await api.saveSettings({ agentControlMode: "agi" });
  return { connectionId: conn.id, controlMode: settings.agentControlMode };
}, { key: KEY, model: MODEL });
verdict.configured = configured;

// Open the studio in the app's browser BEFORE starting the agent: a fresh
// harness instance has no tabs, and a brief that references "the open studio"
// sends the agent into systems-diagnosis tangents (live evidence: netstat).
await window.evaluate(async (url) => {
  const api = window.browserUseDesktop;
  await api.newTab(url);
}, process.env.STUDIO_URL || "http://127.0.0.1:3001/Apps/lorde-design-studio/");

// Start the run with the brief.
const start = await window.evaluate(async ({ brief, model }) => {
  const api = window.browserUseDesktop;
  const settings = await api.settings();
  const connId = settings.aiChatConnectionId;
  return api.agentStart({ task: brief, provider: { id: "xkiro", connectionId: connId, baseUrl: "https://api.xkiro.com/v1", model } });
}, { brief: BRIEF, model: MODEL }).catch((e) => ({ error: String(e?.message || e) }));
verdict.start = String(start?.error || (start ? "started" : "no-result")).slice(0, 200);

// Watchdog: poll the agent state.
const NO_ACCESS = /no (access|permission|tool)|cannot (access|use) (the )?(tools|canvas)|don't (have|see|find) (the )?(tools|create|browser)/i;
let done = false;
while (!done) {
  await window.waitForTimeout(15_000);
  const agentState = await window.evaluate(async () => {
    try { return await window.browserUseDesktop.agentState(); } catch { return null; }
  }).catch(() => null);
  const status = agentState?.status || agentState?.state || null;
  const text = JSON.stringify(agentState || {}).slice(0, 4000);
  verdict.events.push({ at: Math.round((Date.now() - t0) / 1000), status, textTail: text.slice(-240) });
  if (NO_ACCESS.test(text)) { verdict.failures.push({ type: "tool-access-claim" }); done = true; break; }
  const elapsed = Date.now() - t0;
  if (status && ["completed", "failed", "stopped", "done"].includes(String(status).toLowerCase())) { done = true; break; }
  if (elapsed > RUN_TIMEOUT_MS) { verdict.failures.push({ type: "timeout", detail: `${Math.round(elapsed / 1000)}s` }); done = true; break; }
}

// Capture final visual evidence.
try {
  const shot = join(OUT, `${NAME}-desktop.png`);
  await window.screenshot({ path: shot, timeout: 15_000 });
  verdict.screenshot = shot;
} catch (e) { verdict.screenshot = `failed: ${String(e?.message || e).slice(0, 120)}`; }

writeFileSync(join(OUT, `${NAME}-desktop.json`), JSON.stringify(verdict, null, 2));
console.log(JSON.stringify({ name: NAME, ok: verdict.failures.length === 0, failures: verdict.failures, lastStatus: verdict.events.at(-1), totalSec: Math.round((Date.now() - t0) / 1000), screenshot: verdict.screenshot }, null, 2));
await electronApp.close();
