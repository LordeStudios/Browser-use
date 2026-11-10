/**
 * LIVE moles-game vision run: the browser-use desktop chat agent (xkiro
 * glm-5.3-flash) plays the sequenced moles game in a real app tab.
 *
 * Validates the visual-evidence fixes (visualEvidence_flow_chat.md):
 *   1. browser-domain auto vision — the agent must receive pixels after
 *      mutations (previously it played permanently blind),
 *   2. no permanent vision latch from one prose complaint,
 *   3. laya fast-path click cycles coexist with the planner.
 *
 * Usage: node scripts/live-moles-vision.mjs
 */
import { _electron as electron } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 10 * 60_000);
const MODEL = process.env.LIVE_MODEL || "z-ai/glm-5.3-flash";
const GAME_URL = process.env.GAME_URL || "http://127.0.0.1:3001/laya-moles.html";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "live-artifacts");
mkdirSync(OUT, { recursive: true });

const ccEnv = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).env || {};
const KEY = ccEnv.ANTHROPIC_AUTH_TOKEN || "";
if (!KEY) { console.error("NO-KEY"); process.exit(2); }

const verdict = { name: "moles-vision", gameUrl: GAME_URL, startedAt: new Date().toISOString(), events: [], failures: [] };
const t0 = Date.now();

const appData = join(OUT, `.user-data-moles-${Date.now()}`);
const electronApp = await electron.launch({
  executablePath: join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
  args: [".", `--user-data-dir=${appData}`],
  cwd: ROOT,
  env: { ...process.env, APPDATA: appData, LOCALAPPDATA: appData, BROWSER_USE_DESKTOP_MCP_PORT: "0" }
});
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

const configured = await window.evaluate(async ({ key, model }) => {
  const api = window.browserUseDesktop;
  const conn = await api.saveAiConnection({ provider: "xkiro", name: "Moles vision run", baseUrl: "https://api.xkiro.com/v1", model });
  await api.setProviderCredential({ provider: "xkiro", connectionId: conn.id, secret: key });
  const settings = await api.saveSettings({ agentControlMode: "agi", layaEnabled: true });
  return { connectionId: conn.id, controlMode: settings.agentControlMode, layaEnabled: settings.layaEnabled };
}, { key: KEY, model: MODEL });
verdict.configured = configured;

await window.evaluate((url) => window.browserUseDesktop.newTab(url), GAME_URL);

const BRIEF = "Play the moles game in the current tab by clicking the moles on screen (synthetic JS events don't count — use real clicks at the mole's screen position). Click START first, then whack moles as they appear. The page says the moles rotate left, middle, right: once you have confirmed the rotation with a few clicks, keep whacking in that order — you can queue several whacks in one decision, and the rotation stays in sync because every whack makes the next mole pop. Reach 18 whacks before the 150-second clock runs out. When the game shows its result, report the final score from the game HUD and finish immediately — do not keep waiting after the verdict is visible.";
const start = await window.evaluate(async ({ brief, model }) => {
  const api = window.browserUseDesktop;
  const settings = await api.settings();
  return api.agentStart({ task: brief, provider: { id: "xkiro", connectionId: settings.aiChatConnectionId, baseUrl: "https://api.xkiro.com/v1", model } });
}, { brief: BRIEF, model: MODEL }).catch((e) => ({ error: String(e?.message || e) }));
verdict.start = String(start?.error || (start ? "started" : "no-result")).slice(0, 200);

let done = false;
const BLIND = /can't (actually )?see|cannot see|image wasn't rendered|no access to (the )?(tools|screen)/i;
while (!done) {
  await window.waitForTimeout(15_000);
  const agentState = await window.evaluate(async () => {
    try { return await window.browserUseDesktop.agentState(); } catch { return null; }
  }).catch(() => null);
  const status = agentState?.status || agentState?.state || null;
  const text = JSON.stringify(agentState || {});
  const screenshotCalls = (text.match(/"(browser_screenshot|computer_screenshot)"/g) || []).length;
  verdict.events.push({
    at: Math.round((Date.now() - t0) / 1000), status,
    screenshotToolMentions: screenshotCalls,
    textTail: text.slice(-240)
  });
  if (BLIND.test(text)) verdict.failures.push({ type: "blindness-claim", at: Math.round((Date.now() - t0) / 1000) });
  if (status && ["completed", "failed", "stopped", "done"].includes(String(status).toLowerCase())) { done = true; break; }
  if (Date.now() - t0 > RUN_TIMEOUT_MS) { verdict.failures.push({ type: "timeout" }); done = true; break; }
}

// Final evidence: full app screenshot (game HUD + verdict visible) and state tail.
try {
  const shot = join(OUT, "moles-vision-desktop.png");
  await window.screenshot({ path: shot, timeout: 15_000 });
  verdict.screenshot = shot;
} catch (e) { verdict.screenshot = `failed: ${String(e?.message || e).slice(0, 120)}`; }
verdict.finalStateTail = await window.evaluate(async () => {
  try { return JSON.stringify(await window.browserUseDesktop.agentState()); } catch { return ""; }
}).then((t) => String(t || "").slice(-3000)).catch(() => "");

writeFileSync(join(OUT, "moles-vision.json"), JSON.stringify(verdict, null, 2));
const screenshotEvidence = verdict.events.some((e) => e.screenshotToolMentions > 0);
console.log(JSON.stringify({
  ok: verdict.failures.length === 0,
  failures: verdict.failures,
  lastStatus: verdict.events.at(-1)?.status ?? null,
  screenshotEvidence,
  totalSec: Math.round((Date.now() - t0) / 1000),
  screenshot: verdict.screenshot
}, null, 2));
await electronApp.close();
