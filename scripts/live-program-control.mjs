/**
 * LIVE program-control run: the browser-use desktop agent (xkiro glm-5.3-flash
 * + laya) drives Claude Code, Codex CLI, and ChatGPT desktop to build a
 * website home. The harness only sends ONE ordinary chat prompt — no scripted
 * steps — and watches the model's own decisions for the owner's failure
 * signatures.
 *
 * Failure rubric (any hit = stop, fix, retest):
 *   - lapping: the current decision repeating identically across polls
 *   - half calls: a send reported as not landing
 *   - self-coding: browser-use editing code itself (computer_patch, "I'll write
 *     the code") instead of delegating to the worker programs
 *   - vision blindness
 *
 * Watchers scan ONLY model decisions (visible text + emitted calls) — never
 * the raw state JSON, whose embedded tool schemas produced false positives.
 *
 * Usage: node scripts/live-program-control.mjs
 */
import { _electron as electron } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RUN_TIMEOUT_MS = Number(process.env.LIVE_TIMEOUT_MS || 60 * 60_000);
const MODEL = process.env.LIVE_MODEL || "z-ai/glm-5.3-flash";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "live-artifacts");
mkdirSync(OUT, { recursive: true });

const ccEnv = JSON.parse(readFileSync(join(homedir(), ".claude", "settings.json"), "utf8")).env || {};
const KEY = ccEnv.ANTHROPIC_AUTH_TOKEN || "";
if (!KEY) { console.error("NO-KEY"); process.exit(2); }

const PROMPT = process.env.LIVE_PROMPT ||
  "Create a beautiful website homepage with a stylized unique look and a special carousel in the header. " +
  "Use Claude Code in a Git Bash window, Codex CLI, and the ChatGPT desktop app to design and build it — " +
  "you coordinate them; they write the code. Do not write or edit any code files yourself.";

const verdict = { name: "program-control", startedAt: new Date().toISOString(), events: [], failures: [] };
const t0 = Date.now();

const SIG = {
  selfCode: /(?:I(?:'ll| will|'m going to)|let me) (?:write|edit|create|patch) (?:the )?(?:code|file|html|css)|computer_patch/i,
  guessCmd: /\b(?:try|maybe|guess(?:ing)?|not sure (?:which|what)) (?:the )?command\b|command (?:might|may) (?:be|work)/i,
  sendFail: /(?:send|enter|typing|keystroke)s? (?:didn't|did not|does not|isn't|is not|failed to) (?:work|go|register|land|arrive)/i,
  blind: /image wasn't rendered|can't (?:actually )?see (?:the|it)|no access to (?:the )?(?:tools|screen)/i
};
let lastDecisionFingerprint = "";
let repeatStrikes = 0;

// Extract the model's recent decisions from the run history: visible text and
// emitted calls only.
function modelDecisions(stateText) {
  const out = [];
  try {
    const history = JSON.parse(stateText)?.history;
    if (!Array.isArray(history)) return out;
    for (const entry of history.slice(-6)) {
      const text = String(entry?.text || entry?.output?.summary || "").trim();
      const calls = (entry?.calls || []).map((c) => `${c?.name}:${JSON.stringify(c?.input || {}).slice(0, 200)}`);
      // Action-result entries (tool/input/output, no text or calls) carry no
      // decision — fingerprinting their emptiness produced false lapping.
      if (!text && !calls.length) continue;
      out.push({ text: text.slice(0, 600), calls: calls.join(" | ").slice(0, 400) });
    }
  } catch { /* state shape drift: watchers see nothing this poll */ }
  return out;
}

const appData = join(OUT, `.user-data-progctl-${Date.now()}`);
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
  const conn = await api.saveAiConnection({ provider: "xkiro", name: "Program control run", baseUrl: "https://api.xkiro.com/v1", model });
  await api.setProviderCredential({ provider: "xkiro", connectionId: conn.id, secret: key });
  const settings = await api.saveSettings({ agentControlMode: "agi", layaEnabled: true });
  return { connectionId: conn.id, controlMode: settings.agentControlMode, layaEnabled: settings.layaEnabled };
}, { key: KEY, model: MODEL });
verdict.configured = configured;

const start = await window.evaluate(async ({ prompt, model }) => {
  const api = window.browserUseDesktop;
  const settings = await api.settings();
  return api.agentStart({ task: prompt, provider: { id: "xkiro", connectionId: settings.aiChatConnectionId, baseUrl: "https://api.xkiro.com/v1", model } });
}, { prompt: PROMPT, model: MODEL }).catch((e) => ({ error: String(e?.message || e) }));
verdict.start = String(start?.error || (start ? "started" : "no-result")).slice(0, 200);

let done = false;
while (!done) {
  await window.waitForTimeout(20_000);
  const agentState = await window.evaluate(async () => {
    try { return await window.browserUseDesktop.agentState(); } catch { return null; }
  }).catch(() => null);
  const status = agentState?.status || agentState?.state || null;
  const text = JSON.stringify(agentState || {});
  const decisions = modelDecisions(text);
  const latest = decisions.at(-1);
  // Lapping detector: the CURRENT decision identical across polls (a real
  // repeat spiral, not history-JSON stability).
  const fingerprint = latest ? `${latest.text.slice(0, 120)}|${latest.calls}` : "";
  if (fingerprint && fingerprint === lastDecisionFingerprint) {
    repeatStrikes += 1;
    if (repeatStrikes >= 4 && !verdict.failures.some((f) => f.type === "lapping")) {
      verdict.failures.push({ type: "lapping", detail: fingerprint.slice(0, 200), at: Math.round((Date.now() - t0) / 1000) });
    }
  } else { repeatStrikes = 0; lastDecisionFingerprint = fingerprint; }
  const decisionText = decisions.map((d) => `${d.text} ${d.calls}`).join(" ");
  for (const [type, re] of Object.entries(SIG)) {
    if (re.test(decisionText) && !verdict.failures.some((f) => f.type === type)) {
      verdict.failures.push({ type, at: Math.round((Date.now() - t0) / 1000) });
    }
  }
  verdict.events.push({ at: Math.round((Date.now() - t0) / 1000), status, decisions });
  if (status && ["completed", "failed", "stopped", "done"].includes(String(status).toLowerCase())) { done = true; break; }
  if (Date.now() - t0 > RUN_TIMEOUT_MS) { verdict.failures.push({ type: "timeout" }); done = true; break; }
}

try {
  const shot = join(OUT, "program-control-desktop.png");
  await window.screenshot({ path: shot, timeout: 15_000 });
  verdict.screenshot = shot;
} catch (e) { verdict.screenshot = `failed: ${String(e?.message || e).slice(0, 120)}`; }
verdict.finalStateTail = await window.evaluate(async () => {
  try { return JSON.stringify(await window.browserUseDesktop.agentState()); } catch { return ""; }
}).then((t) => String(t || "").slice(-3000)).catch(() => "");

writeFileSync(join(OUT, "program-control.json"), JSON.stringify(verdict, null, 2));
console.log(JSON.stringify({
  ok: verdict.failures.length === 0,
  failures: verdict.failures,
  lastStatus: verdict.events.at(-1)?.status ?? null,
  totalSec: Math.round((Date.now() - t0) / 1000),
  screenshot: verdict.screenshot
}, null, 2));
await electronApp.close();
